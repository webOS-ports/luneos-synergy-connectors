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

type qobuzPlaylistsPage struct {
	Playlists struct {
		Total int `json:"total"`
		Items []struct {
			ID          json.Number `json:"id"`
			Name        string      `json:"name"`
			TracksCount int         `json:"tracks_count"`
			Images300   []string    `json:"images300"`
			Owner       struct {
				Name string `json:"name"`
			} `json:"owner"`
		} `json:"items"`
	} `json:"playlists"`
}

func qobuzPlaylistsOf(page qobuzPlaylistsPage) []providerPlaylist {
	out := []providerPlaylist{}
	for _, it := range page.Playlists.Items {
		id := it.ID.String()
		if id == "" || id == "0" {
			continue
		}
		thumb := ""
		if len(it.Images300) > 0 {
			thumb = it.Images300[0]
		}
		out = append(out, providerPlaylist{
			ID: id, Provider: "qobuz", Name: it.Name, Owner: it.Owner.Name,
			Thumbnail: thumb, Tracks: it.TracksCount,
		})
	}
	return out
}

type qobuzPlaylistPage struct {
	Tracks struct {
		Total int `json:"total"`
		Items []struct {
			ID         json.Number `json:"id"`
			Title      string      `json:"title"`
			Duration   int         `json:"duration"` // seconds
			Streamable *bool       `json:"streamable"`
			Performer  struct {
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

// qobuzTracksOf are the tracks of a playlist page Qobuz streams.
func qobuzTracksOf(page qobuzPlaylistPage) []providerTrack {
	out := []providerTrack{}
	for _, it := range page.Tracks.Items {
		id := it.ID.String()
		if id == "" || id == "0" || (it.Streamable != nil && !*it.Streamable) {
			continue
		}
		out = append(out, providerTrack{
			ID: id, Provider: "qobuz", Title: it.Title, Artist: it.Performer.Name,
			Album: it.Album.Title, Thumbnail: it.Album.Image.Small,
			DurationMs: it.Duration * 1000, Path: "qobuz:" + id,
		})
	}
	return out
}

// Playlists: the user's own playlists and the ones they follow (playlistSource).
func (p *qobuzProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	if err := p.dl.ensureAuth(ctx); err != nil {
		return nil, err
	}
	offset := 0
	return pageAll(maxPlaylists, func(int) ([]providerPlaylist, bool, error) {
		var page qobuzPlaylistsPage
		v := url.Values{}
		v.Set("limit", "50")
		v.Set("offset", strconv.Itoa(offset))
		if err := p.dl.get(ctx, "playlist/getUserPlaylists", v, &page); err != nil {
			return nil, false, err
		}
		n := len(page.Playlists.Items)
		offset += n
		return qobuzPlaylistsOf(page), n > 0 && offset < page.Playlists.Total, nil
	})
}

// PlaylistTracks: the playable tracks of one playlist, in its order.
func (p *qobuzProvider) PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error) {
	if err := p.dl.ensureAuth(ctx); err != nil {
		return nil, err
	}
	offset := 0
	return pageAll(maxPlaylistTracks, func(int) ([]providerTrack, bool, error) {
		var page qobuzPlaylistPage
		v := url.Values{}
		v.Set("playlist_id", playlistID)
		v.Set("extra", "tracks")
		v.Set("limit", "500")
		v.Set("offset", strconv.Itoa(offset))
		if err := p.dl.get(ctx, "playlist/get", v, &page); err != nil {
			return nil, false, err
		}
		n := len(page.Tracks.Items)
		offset += n
		return qobuzTracksOf(page), n > 0 && offset < page.Tracks.Total, nil
	})
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
