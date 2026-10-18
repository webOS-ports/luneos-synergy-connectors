package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// archiveProvider: the Internet Archive (archive.org) — free, no login, huge audio
// collection (live concerts/etree, netlabels, 78s, …). advancedsearch finds items;
// the metadata API lists an item's files, from which we pick the first playable
// audio file and hand its direct download URL to the shared stream player.
type archiveProvider struct{}

func (a *archiveProvider) ID() string   { return "archive" }
func (a *archiveProvider) Name() string { return "Internet Archive" }

// asString flattens Archive fields that may be a string OR a []string.
func archiveStr(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case []interface{}:
		parts := []string{}
		for _, e := range t {
			if s, ok := e.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, ", ")
	}
	return ""
}

func (a *archiveProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	// Search the title/creator fields (full-text matched loosely on reviews/metadata,
	// returning unrelated items) and sort by downloads so popular real music floats up
	// (default sort surfaces audio-fingerprint/derived junk items).
	q := fmt.Sprintf("(title:(%s) OR creator:(%s)) AND mediatype:(audio)", query, query)
	u := fmt.Sprintf("https://archive.org/advancedsearch.php?q=%s&fl[]=identifier&fl[]=title&fl[]=creator&sort[]=downloads+desc&rows=%d&page=1&output=json",
		url.QueryEscape(q), limit)
	body, err := httpGetString(ctx, u)
	if err != nil {
		return nil, err
	}
	var r struct {
		Response struct {
			Docs []struct {
				Identifier string      `json:"identifier"`
				Title      interface{} `json:"title"`
				Creator    interface{} `json:"creator"`
			} `json:"docs"`
		} `json:"response"`
	}
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return nil, fmt.Errorf("archive parse: %w", err)
	}
	out := []providerTrack{}
	for _, d := range r.Response.Docs {
		if d.Identifier == "" {
			continue
		}
		out = append(out, providerTrack{
			ID: d.Identifier, Provider: "archive", Title: archiveStr(d.Title),
			Artist: archiveStr(d.Creator), Path: "archive:" + d.Identifier,
			Thumbnail: "https://archive.org/services/img/" + d.Identifier,
		})
	}
	return out, nil
}

func (a *archiveProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	body, err := httpGetString(ctx, "https://archive.org/metadata/"+url.PathEscape(trackID))
	if err != nil {
		return "", err
	}
	var m struct {
		Files []struct {
			Name   string `json:"name"`
			Format string `json:"format"`
		} `json:"files"`
	}
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		return "", err
	}
	// Prefer common streamable formats in order.
	prefer := []string{"VBR MP3", "128Kbps MP3", "64Kbps MP3", "MP3", "Ogg Vorbis", "Flac"}
	name := ""
	for _, want := range prefer {
		for _, f := range m.Files {
			if f.Format == want {
				name = f.Name
				break
			}
		}
		if name != "" {
			break
		}
	}
	if name == "" { // any audio-ish extension
		for _, f := range m.Files {
			ln := strings.ToLower(f.Name)
			if strings.HasSuffix(ln, ".mp3") || strings.HasSuffix(ln, ".ogg") || strings.HasSuffix(ln, ".flac") || strings.HasSuffix(ln, ".m4a") {
				name = f.Name
				break
			}
		}
	}
	if name == "" {
		return "", fmt.Errorf("archive: no audio file in %s", trackID)
	}
	return "https://archive.org/download/" + url.PathEscape(trackID) + "/" + url.PathEscape(name), nil
}
