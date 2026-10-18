package main

import (
	"context"
	"fmt"

	"github.com/zmb3/spotify/v2"
)

// spotifyProvider adapts the existing Spotify integration to the MusicProvider
// interface so it appears in /providers alongside the others. Playback stays on
// librespot/Connect (StreamURL returns "" — the app keeps using /player/* for
// spotify: paths), so this is purely for the unified search/registry surface.
type spotifyProvider struct{}

func (s *spotifyProvider) ID() string   { return "spotify" }
func (s *spotifyProvider) Name() string { return "Spotify" }

func (s *spotifyProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	sess.mu.RLock()
	c := sess.client
	sess.mu.RUnlock()
	if c == nil {
		return nil, fmt.Errorf("no Spotify session; log in first")
	}
	if query == "" {
		return []providerTrack{}, nil
	}
	// This app's Spotify token rejects search limits above searchLimitMax with
	// "Invalid limit" (surfaces as a 502). The connector bar asks for 40, so clamp
	// here just like handleSearch does.
	if limit > searchLimitMax {
		limit = searchLimitMax
	}
	res, err := c.Search(ctx, query, spotify.SearchTypeTrack, spotify.Limit(limit))
	if err != nil {
		return nil, err
	}
	out := []providerTrack{}
	if res.Tracks != nil {
		for _, t := range res.Tracks.Tracks {
			img := spotifyThumb(t.Album.Images)
			artist := ""
			if len(t.Artists) > 0 {
				artist = t.Artists[0].Name
			}
			out = append(out, providerTrack{
				ID: string(t.ID), Provider: "spotify", Title: t.Name, Artist: artist,
				Album: t.Album.Name, Thumbnail: img, DurationMs: int(t.Duration),
				Path: string(t.URI), // spotify:track:...
			})
		}
	}
	return out, nil
}

// Spotify plays via librespot/Connect, not a stream URL.
func (s *spotifyProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	return "", nil
}
