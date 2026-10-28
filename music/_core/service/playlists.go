package main

import (
	"context"
	"net/http"
)

// playlistSource is an OPTIONAL provider capability: the signed-in user's own
// playlists on the service, read through its official API, for the app to show
// beside its own. Spotify, Tidal, Qobuz and Deezer implement it.
type playlistSource interface {
	Playlists(ctx context.Context) ([]providerPlaylist, error)
	PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error)
}

// providerPlaylist is the normalised playlist shape returned to the app.
type providerPlaylist struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Name      string `json:"name"`
	Owner     string `json:"owner"`
	Thumbnail string `json:"thumbnail"`
	Tracks    int    `json:"tracks"` // how many the service says it has
}

// Most of a user's playlists, and of a playlist's tracks, the app is given:
// enough for any real one, bounded for the odd 10 000-track list.
const (
	maxPlaylists      = 500
	maxPlaylistTracks = 2000
)

// GET /provider/<id>/playlists -> {playlists}
// GET /provider/<id>/playlist?id= -> {tracks}
func handlePlaylistRoute(w http.ResponseWriter, r *http.Request, p MusicProvider, action string) {
	ps, ok := p.(playlistSource)
	if !ok {
		httpErr(w, http.StatusConflict, p.ID()+" has no playlists to share")
		return
	}
	switch action {
	case "playlists":
		lists, err := ps.Playlists(r.Context())
		if err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, map[string]interface{}{"playlists": lists})
	case "playlist":
		id := r.URL.Query().Get("id")
		if id == "" {
			httpErr(w, http.StatusBadRequest, "id is required")
			return
		}
		tracks, err := ps.PlaylistTracks(r.Context(), id)
		if err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, map[string]interface{}{"tracks": tracks})
	}
}

// maxPages bounds the pages pageAll asks for, whatever a service says of the next.
const maxPages = 100

// pageAll collects what fetch hands back page by page (fetch(collected) -> the
// items of that page and whether there is a next one), up to max. A page may
// bring nothing (none of it playable) and still have a next one.
func pageAll[T any](max int, fetch func(collected int) ([]T, bool, error)) ([]T, error) {
	out := []T{}
	for pages := 0; len(out) < max && pages < maxPages; pages++ {
		items, more, err := fetch(len(out))
		if err != nil {
			return nil, err
		}
		out = append(out, items...)
		if !more {
			break
		}
	}
	if len(out) > max {
		out = out[:max]
	}
	return out, nil
}
