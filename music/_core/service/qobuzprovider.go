package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
)

// qobuzProvider streams full-quality (FLAC) from the user's Qobuz account, reusing
// the qobuzDL auth + getFileUrl. Qobuz stream URLs are plain (DRM-free), so they go
// straight to the shared stream player. Registered only when a qobuz-auth cred file
// is present (self-disables otherwise).
type qobuzProvider struct{ dl *qobuzDL }

func (p *qobuzProvider) ID() string   { return "qobuz" }
func (p *qobuzProvider) Name() string { return "Qobuz" }

func (p *qobuzProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	if err := p.dl.ensureAuth(ctx); err != nil {
		return nil, err
	}
	var res struct {
		Tracks struct {
			Items []struct {
				ID        json.Number `json:"id"`
				Title     string      `json:"title"`
				Duration  int         `json:"duration"`
				Performer struct {
					Name string `json:"name"`
				} `json:"performer"`
				Album struct {
					Title string `json:"title"`
					Image struct {
						Small string `json:"small"`
					} `json:"image"`
				} `json:"album"`
			} `json:"items"`
		} `json:"tracks"`
	}
	v := url.Values{}
	v.Set("query", query)
	v.Set("limit", strconv.Itoa(limit))
	if err := p.dl.get(ctx, "track/search", v, &res); err != nil {
		return nil, err
	}
	out := []providerTrack{}
	for _, it := range res.Tracks.Items {
		id := it.ID.String()
		out = append(out, providerTrack{
			ID: id, Provider: "qobuz", Title: it.Title, Artist: it.Performer.Name,
			Album: it.Album.Title, Thumbnail: it.Album.Image.Small,
			DurationMs: it.Duration * 1000, Path: "qobuz:" + id,
		})
	}
	return out, nil
}

func (p *qobuzProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	f, err := p.dl.FileURL(ctx, trackID)
	if err != nil {
		return "", err
	}
	return f.URL, nil // plain FLAC URL, directly streamable
}
