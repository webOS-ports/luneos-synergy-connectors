package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// soundcloudProvider: a free, no-login, no-DRM source. SoundCloud's public web API
// (api-v2) needs a client_id, which we scrape from the site's JS bundles (they
// rotate, so we cache + refetch on failure). Search returns tracks; each track's
// media.transcodings give a progressive (MP3) or HLS stream URL that the shared gst
// stream player decodes directly — no bot-check, no signature cipher.
type soundcloudProvider struct {
	mu       sync.Mutex
	clientID string
}

func (s *soundcloudProvider) ID() string   { return "soundcloud" }
func (s *soundcloudProvider) Name() string { return "SoundCloud" }

var scScriptRe = regexp.MustCompile(`<script[^>]+src="(https://[^"]*sndcdn\.com/assets/[^"]+\.js)"`)
var scClientIDRe = regexp.MustCompile(`[,{]client_id:"([0-9a-zA-Z]{20,})"`)

func (s *soundcloudProvider) getClientID(ctx context.Context, force bool) (string, error) {
	s.mu.Lock()
	if s.clientID != "" && !force {
		id := s.clientID
		s.mu.Unlock()
		return id, nil
	}
	s.mu.Unlock()

	home, err := httpGetString(ctx, "https://soundcloud.com/")
	if err != nil {
		return "", err
	}
	scripts := scScriptRe.FindAllStringSubmatch(home, -1)
	// the client_id usually lives in one of the later bundles
	for i := len(scripts) - 1; i >= 0; i-- {
		js, err := httpGetString(ctx, scripts[i][1])
		if err != nil {
			continue
		}
		if m := scClientIDRe.FindStringSubmatch(js); m != nil {
			s.mu.Lock()
			s.clientID = m[1]
			s.mu.Unlock()
			return m[1], nil
		}
	}
	return "", fmt.Errorf("soundcloud client_id not found (%d bundles scanned)", len(scripts))
}

type scTrack struct {
	ID         int64  `json:"id"` // int64: SoundCloud IDs exceed 2^31 (GOARCH=arm int is 32-bit)
	Title      string `json:"title"`
	Duration   int    `json:"duration"` // ms
	ArtworkURL string `json:"artwork_url"`
	User       struct {
		Username string `json:"username"`
	} `json:"user"`
	Media struct {
		Transcodings []struct {
			URL    string `json:"url"`
			Format struct {
				Protocol string `json:"protocol"`
				MimeType string `json:"mime_type"`
			} `json:"format"`
		} `json:"transcodings"`
	} `json:"media"`
}

// streamTranscoding is the URL of the transcoding to play: progressive (plain MP3)
// first, then HLS (gst hlsdemux). "" when there is none - label tracks often come
// only as cbc-/ctr-encrypted-hls, which is DRM the stream player cannot decode.
func (t *scTrack) streamTranscoding() string {
	for _, proto := range []string{"progressive", "hls"} {
		for _, tr := range t.Media.Transcodings {
			if tr.Format.Protocol == proto {
				return tr.URL
			}
		}
	}
	return ""
}

// parseSoundcloudTracks turns a search reply into the tracks that can be played;
// ones with only encrypted streams are left out instead of failing when picked.
func parseSoundcloudTracks(body string) ([]providerTrack, error) {
	var r struct {
		Collection []scTrack `json:"collection"`
	}
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return nil, fmt.Errorf("soundcloud search parse: %w", err)
	}
	out := []providerTrack{}
	for i := range r.Collection {
		t := &r.Collection[i]
		if t.ID == 0 || t.streamTranscoding() == "" {
			continue
		}
		out = append(out, providerTrack{
			ID: strconv.FormatInt(t.ID, 10), Provider: "soundcloud", Title: t.Title,
			Artist: t.User.Username, Thumbnail: t.ArtworkURL, DurationMs: t.Duration,
			Path: "soundcloud:" + strconv.FormatInt(t.ID, 10),
		})
	}
	return out, nil
}

func (s *soundcloudProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	cid, err := s.getClientID(ctx, false)
	if err != nil {
		return nil, err
	}
	fetch := func(id string) (string, error) {
		u := fmt.Sprintf("https://api-v2.soundcloud.com/search/tracks?q=%s&client_id=%s&limit=%d",
			url.QueryEscape(query), id, limit)
		return httpGetString(ctx, u)
	}
	body, err := fetch(cid)
	if err != nil || strings.Contains(body, "401 Unauthorized") {
		if cid, err = s.getClientID(ctx, true); err == nil { // client_id rotated; refetch once
			body, err = fetch(cid)
		}
		if err != nil {
			return nil, err
		}
	}
	return parseSoundcloudTracks(body)
}

func (s *soundcloudProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	cid, err := s.getClientID(ctx, false)
	if err != nil {
		return "", err
	}
	body, err := httpGetString(ctx, "https://api-v2.soundcloud.com/tracks/"+trackID+"?client_id="+cid)
	if err != nil {
		return "", err
	}
	var t scTrack
	if err := json.Unmarshal([]byte(body), &t); err != nil {
		return "", fmt.Errorf("soundcloud track parse: %w", err)
	}
	if t.ID == 0 {
		// Not a track: api-v2's error replies (401, 404, 429) come with a body too.
		return "", fmt.Errorf("soundcloud: no track %s", trackID)
	}
	tcURL := t.streamTranscoding()
	if tcURL == "" {
		if len(t.Media.Transcodings) > 0 {
			return "", fmt.Errorf("soundcloud: %q is only available encrypted (DRM)", t.Title)
		}
		return "", fmt.Errorf("soundcloud: %q has no stream", t.Title)
	}
	sep := "?"
	if strings.Contains(tcURL, "?") {
		sep = "&"
	}
	r2, err := httpGetString(ctx, tcURL+sep+"client_id="+cid)
	if err != nil {
		return "", err
	}
	var u struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(r2), &u); err != nil || u.URL == "" {
		return "", fmt.Errorf("soundcloud stream resolve failed")
	}
	return u.URL, nil
}
