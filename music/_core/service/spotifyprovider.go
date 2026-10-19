package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/zmb3/spotify/v2"
	"golang.org/x/oauth2"
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

// Spotify's Web API changed its playlists (2026): a playlist's tracks come from
// /playlists/{id}/items, each under "item" (no longer "track", which is now a
// flag inside it), and the playlist's count is "items": {"total"}. The old
// /playlists/{id}/tracks answers 403, and so does /items for a playlist the
// user neither owns nor collaborates on. The library still has the old shape,
// so these few calls are made here.

// spotifyAPIBase is where the calls below go; the tests point it elsewhere.
var spotifyAPIBase = "https://api.spotify.com/v1/"

func spotifyAPIGet(ctx context.Context, path string, out interface{}) error {
	if currentTokenSource == nil {
		return fmt.Errorf("no Spotify session; log in first")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, spotifyAPIBase+path, nil)
	if err != nil {
		return err
	}
	resp, err := oauth2.NewClient(ctx, currentTokenSource).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("spotify %s: http %d %s", strings.SplitN(path, "?", 2)[0], resp.StatusCode, tidalTrunc(string(body), 120))
	}
	return json.Unmarshal(body, out)
}

type spotifyPlaylistJSON struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Collaborative bool   `json:"collaborative"`
	Owner         struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
	} `json:"owner"`
	Images []spotify.Image `json:"images"`
	Items  struct {
		Total int `json:"total"`
	} `json:"items"`
	Tracks struct { // the count before the change
		Total int `json:"total"`
	} `json:"tracks"`
}

type spotifyPlaylistsPage struct {
	Items []spotifyPlaylistJSON `json:"items"`
	Next  string                `json:"next"`
}

type spotifyItemJSON struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	URI        string `json:"uri"`
	DurationMs int    `json:"duration_ms"`
	IsLocal    bool   `json:"is_local"`
	Artists    []struct {
		Name string `json:"name"`
	} `json:"artists"`
	Album struct {
		Name   string          `json:"name"`
		Images []spotify.Image `json:"images"`
	} `json:"album"`
}

type spotifyItemsPage struct {
	Items []struct {
		IsLocal bool             `json:"is_local"`
		Item    *spotifyItemJSON `json:"item"`
		Track   json.RawMessage  `json:"track"` // the object before the change
	} `json:"items"`
	Next string `json:"next"`
}

// spotifyPlaylistsOf are the playlists of a page the user can open: their own
// and collaborative ones. Spotify refuses the tracks of anyone else's.
func spotifyPlaylistsOf(page spotifyPlaylistsPage, me string) []providerPlaylist {
	out := []providerPlaylist{}
	for _, p := range page.Items {
		if p.ID == "" || (p.Owner.ID != me && !p.Collaborative) {
			continue
		}
		count := p.Items.Total
		if count == 0 {
			count = p.Tracks.Total
		}
		out = append(out, providerPlaylist{
			ID: p.ID, Provider: "spotify", Name: p.Name, Owner: p.Owner.DisplayName,
			Thumbnail: spotifyThumb(p.Images), Tracks: count,
		})
	}
	return out
}

// spotifyTracksOf are the tracks of an items page that can be played: not the
// user's local files, episodes, or tracks gone from this market (null).
func spotifyTracksOf(page spotifyItemsPage) []providerTrack {
	out := []providerTrack{}
	for _, it := range page.Items {
		t := it.Item
		if t == nil && len(it.Track) > 0 && it.Track[0] == '{' {
			t = &spotifyItemJSON{}
			if json.Unmarshal(it.Track, t) != nil {
				t = nil
			}
		}
		if it.IsLocal || t == nil || t.IsLocal || t.ID == "" || (t.Type != "" && t.Type != "track") {
			continue
		}
		artist := ""
		if len(t.Artists) > 0 {
			artist = t.Artists[0].Name
		}
		out = append(out, providerTrack{
			ID: t.ID, Provider: "spotify", Title: t.Name, Artist: artist,
			Album: t.Album.Name, Thumbnail: spotifyThumb(t.Album.Images),
			DurationMs: t.DurationMs, Path: t.URI,
		})
	}
	return out
}

// Playlists: the user's own and collaborative ones (playlistSource).
func (s *spotifyProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	var me struct {
		ID string `json:"id"`
	}
	if err := spotifyAPIGet(ctx, "me", &me); err != nil {
		return nil, err
	}
	offset := 0
	return pageAll(maxPlaylists, func(int) ([]providerPlaylist, bool, error) {
		var page spotifyPlaylistsPage
		if err := spotifyAPIGet(ctx, fmt.Sprintf("me/playlists?limit=50&offset=%d", offset), &page); err != nil {
			return nil, false, err
		}
		offset += len(page.Items)
		return spotifyPlaylistsOf(page, me.ID), page.Next != "" && len(page.Items) > 0, nil
	})
}

// PlaylistTracks: the playable tracks of one playlist, in its order.
func (s *spotifyProvider) PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error) {
	offset := 0
	return pageAll(maxPlaylistTracks, func(int) ([]providerTrack, bool, error) {
		var page spotifyItemsPage
		path := fmt.Sprintf("playlists/%s/items?limit=100&offset=%d", url.PathEscape(playlistID), offset)
		if err := spotifyAPIGet(ctx, path, &page); err != nil {
			return nil, false, err
		}
		offset += len(page.Items)
		return spotifyTracksOf(page), page.Next != "" && len(page.Items) > 0, nil
	})
}
