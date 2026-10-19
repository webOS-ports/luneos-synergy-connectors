package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
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
		Transcodings []scTranscoding `json:"transcodings"`
	} `json:"media"`
}

type scTranscoding struct {
	URL    string `json:"url"`
	Preset string `json:"preset"` // e.g. aac_160k, aac_96k, mp3_1_0, opus_0_0, abr_sq
	Format struct {
		Protocol string `json:"protocol"`
		MimeType string `json:"mime_type"`
	} `json:"format"`
}

// scFormatLabel is the format label of a transcoding the stream player can play, ""
// for the others: cbc-/ctr-encrypted-hls is DRM, and an abr_* preset is an adaptive
// playlist over the same streams the track lists one by one.
func scFormatLabel(tr *scTranscoding) string {
	if tr.Format.Protocol != "progressive" && tr.Format.Protocol != "hls" {
		return ""
	}
	p, mime := tr.Preset, tr.Format.MimeType
	switch {
	case strings.HasPrefix(p, "abr"):
		return ""
	case strings.HasPrefix(p, "aac_"):
		if kbps := strings.TrimSuffix(strings.TrimPrefix(p, "aac_"), "k"); scKbps(kbps) > 0 {
			return "AAC " + kbps
		}
		return "AAC"
	case strings.HasPrefix(p, "mp3"):
		return "MP3 128"
	case strings.HasPrefix(p, "opus"):
		return "OPUS 64"
	case mime == "audio/mpeg" || strings.HasPrefix(mime, "audio/mpeg;"):
		return "MP3"
	case strings.Contains(mime, "mp4a") || strings.Contains(mime, "aac"):
		return "AAC"
	case strings.Contains(mime, "opus") || strings.Contains(mime, "ogg"):
		return "OPUS"
	}
	return ""
}

// scKbps is the bitrate in a label's or preset's number, 0 if it has none.
func scKbps(s string) int {
	if i := strings.LastIndexByte(s, ' '); i >= 0 {
		s = s[i+1:]
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

type scStream struct {
	label, url  string
	progressive bool
}

// streams are the transcodings the stream player can play, best first: the higher
// bitrate, and at the same one a progressive (plain) file before HLS (gst hlsdemux).
// None for a track that comes only encrypted, as label tracks often do.
func (t *scTrack) streams() []scStream {
	var out []scStream
	for i := range t.Media.Transcodings {
		tr := &t.Media.Transcodings[i]
		if l := scFormatLabel(tr); l != "" && tr.URL != "" {
			out = append(out, scStream{label: l, url: tr.URL, progressive: tr.Format.Protocol == "progressive"})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if a, b := scKbps(out[i].label), scKbps(out[j].label); a != b {
			return a > b
		}
		return out[i].progressive && !out[j].progressive
	})
	return out
}

// pickStream is the stream with label format, or the best one when format is "" or
// not among them; labels are the distinct ones, best first. ok is false when there is
// nothing to play.
func pickStream(streams []scStream, format string) (picked scStream, labels []string, ok bool) {
	if len(streams) == 0 {
		return scStream{}, nil, false
	}
	picked = streams[0]
	found := false
	seen := map[string]bool{}
	for _, s := range streams {
		if format != "" && !found && s.label == format {
			picked, found = s, true
		}
		if !seen[s.label] {
			seen[s.label] = true
			labels = append(labels, s.label)
		}
	}
	return picked, labels, true
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
		if t.ID == 0 || len(t.streams()) == 0 {
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
	return s.StreamURLFormat(ctx, trackID, "")
}

// StreamURLFormat resolves the track in the format labelled format, or in the best
// one when it has no such format (formatSelector).
func (s *soundcloudProvider) StreamURLFormat(ctx context.Context, trackID, format string) (string, error) {
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
	picked, labels, ok := pickStream(t.streams(), format)
	tcURL := picked.url
	if !ok {
		for _, tr := range t.Media.Transcodings {
			if strings.Contains(tr.Format.Protocol, "encrypted") {
				return "", fmt.Errorf("soundcloud: %q is only available encrypted (DRM)", t.Title)
			}
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
	reportFormats(ctx, picked.label, labels)
	return u.URL, nil
}
