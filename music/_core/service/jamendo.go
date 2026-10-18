package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// jamendoProvider: 100% free & legal Creative-Commons music via Jamendo's official
// v3.0 API. No login/DRM/cipher — the API hands back a direct MP3 URL. Needs a
// client_id (a public demo id ships as the default; override with a real one in
// /media/cryptofs/spotify-webos/jamendo-clientid to avoid the demo's rate limits).
type jamendoProvider struct{ clientID string }

func newJamendoProvider() *jamendoProvider {
	id := "b6747d04" // public demo client_id
	if b, err := os.ReadFile(spotifyDataDir + "/jamendo-clientid"); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			id = s
		}
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
	var r struct {
		Results []jamendoTrack `json:"results"`
	}
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return nil, fmt.Errorf("jamendo parse: %w", err)
	}
	out := []providerTrack{}
	for _, t := range r.Results {
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
	var r struct {
		Results []jamendoTrack `json:"results"`
	}
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return "", err
	}
	if len(r.Results) == 0 || r.Results[0].Audio == "" {
		return "", fmt.Errorf("jamendo: no audio for %s", trackID)
	}
	return r.Results[0].Audio, nil
}
