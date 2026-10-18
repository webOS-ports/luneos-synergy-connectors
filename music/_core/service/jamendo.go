package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// jamendoProvider: 100% free & legal Creative-Commons music via Jamendo's official
// v3.0 API. No login/DRM/cipher — the API hands back a direct MP3 URL. Needs a
// client_id (a public demo id ships as the default; a real one in jamendo-clientid,
// see configPaths, avoids the demo's rate limits).
type jamendoProvider struct{ clientID string }

func newJamendoProvider() *jamendoProvider {
	id := "b6747d04" // public demo client_id
	if s, _ := readFirstNonEmpty(configPaths("jamendo-clientid")...); s != "" {
		id = s
	}
	return &jamendoProvider{clientID: id}
}

func (j *jamendoProvider) ID() string   { return "jamendo" }
func (j *jamendoProvider) Name() string { return "Jamendo" }

type jamendoTrack struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ArtistName string `json:"artist_name"`
	AlbumImage string `json:"album_image"`
	Duration   int    `json:"duration"` // seconds
	Audio      string `json:"audio"`    // direct MP3 stream URL
}

func (j *jamendoProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	u := fmt.Sprintf("https://api.jamendo.com/v3.0/tracks/?client_id=%s&format=json&limit=%d&search=%s&audioformat=mp32&include=musicinfo",
		j.clientID, limit, url.QueryEscape(query))
	body, err := httpGetString(ctx, u)
	if err != nil {
		return nil, err
	}
	results, err := parseJamendoTracks([]byte(body))
	if err != nil {
		return nil, err
	}
	out := []providerTrack{}
	for _, t := range results {
		out = append(out, providerTrack{
			ID: t.ID, Provider: "jamendo", Title: t.Name, Artist: t.ArtistName,
			Thumbnail: t.AlbumImage, DurationMs: t.Duration * 1000, Path: "jamendo:" + t.ID,
		})
	}
	return out, nil
}

func (j *jamendoProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	u := fmt.Sprintf("https://api.jamendo.com/v3.0/tracks/?client_id=%s&format=json&id=%s&audioformat=mp32",
		j.clientID, url.QueryEscape(trackID))
	body, err := httpGetString(ctx, u)
	if err != nil {
		return "", err
	}
	results, err := parseJamendoTracks([]byte(body))
	if err != nil {
		return "", err
	}
	if len(results) == 0 || results[0].Audio == "" {
		return "", fmt.Errorf("jamendo: no audio for %s", trackID)
	}
	return results[0].Audio, nil
}

// jamendoHeaders is the "headers" object of every v3.0 API answer. A refused request
// does not fail at the HTTP level: it comes back 200 with an empty "results" and the
// reason in here -- either status "failed" with error_message, or status "success" with
// a warning, which is how the shared demo client_id is told it is over its usage limit:
//
//	{"headers":{"status":"success","code":0,"error_message":"","warnings":"Usage limits
//	 are exceeded for this request, please contact Jamendo before we block your access to
//	 this request","results_count":0},"results":[]}
//
// Ignoring it made search silently return nothing.
type jamendoHeaders struct {
	Status       string          `json:"status"`
	Code         int             `json:"code"`
	ErrorMessage string          `json:"error_message"`
	Warnings     json.RawMessage `json:"warnings"`
	ResultsCount int             `json:"results_count"`
}

// warnings is documented as a string; render anything else (an array, say) as its JSON.
func (h *jamendoHeaders) warningText() string {
	w := strings.TrimSpace(string(h.Warnings))
	if w == "" || w == "null" || w == `""` || w == "[]" {
		return ""
	}
	var s string
	if json.Unmarshal(h.Warnings, &s) == nil {
		return strings.TrimSpace(s)
	}
	return w
}

// parseJamendoTracks decodes a /tracks answer and turns a refusal reported in its
// headers into an error, so /provider/jamendo/search answers 502 with the reason as the
// other providers do for upstream errors, instead of an empty list.
func parseJamendoTracks(body []byte) ([]jamendoTrack, error) {
	var r struct {
		Headers *jamendoHeaders `json:"headers"`
		Results []jamendoTrack  `json:"results"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("jamendo parse: %w", err)
	}
	if h := r.Headers; h != nil {
		warn := h.warningText()
		if h.Status != "success" {
			msg := strings.TrimSpace(h.ErrorMessage)
			if msg == "" {
				msg = warn
			}
			if msg == "" {
				msg = "no error message"
			}
			st := h.Status
			if st == "" {
				st = "has no status"
			}
			return nil, fmt.Errorf("jamendo: request %s (code %d): %s", st, h.Code, msg)
		}
		if len(r.Results) == 0 && warn != "" {
			return nil, fmt.Errorf("jamendo: %s", warn)
		}
	}
	return r.Results, nil
}
