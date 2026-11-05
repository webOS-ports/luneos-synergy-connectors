package main

import (
	"context"
	"net/http"
	"strconv"
)

// playlistSource is an OPTIONAL provider capability: the signed-in user's own
// playlists on the service, read through its official API, for the app to show
// beside its own. Spotify, Tidal, Qobuz and Deezer implement it.
type playlistSource interface {
	Playlists(ctx context.Context) ([]providerPlaylist, error)
	PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error)
}

// playlistPager is an OPTIONAL capability of a playlistSource whose playlists
// are read a page at a time (Radio Browser's lists): the tracks from offset
// on, and the offset of the next page (0: there is none). A page may give
// fewer tracks than it read - the unplayable are left out - so the next
// page is the provider's to say.
type playlistPager interface {
	PlaylistPage(ctx context.Context, playlistID string, offset int) ([]providerTrack, int, error)
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
// GET /provider/<id>/playlist?id=[&offset=] -> {tracks, more, next}: more
// when there is a next page, asked for with offset=next.
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
		offset := 0
		if v := r.URL.Query().Get("offset"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 || n >= maxPlaylistTracks {
				httpErr(w, http.StatusBadRequest, "offset is out of range")
				return
			}
			offset = n
		}
		var tracks []providerTrack
		next := 0
		var err error
		if pp, ok := p.(playlistPager); ok {
			tracks, next, err = pp.PlaylistPage(r.Context(), id, offset)
		} else if offset == 0 {
			tracks, err = ps.PlaylistTracks(r.Context(), id)
		} else {
			tracks = []providerTrack{} // all of it came with the first page
		}
		if err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		if next <= offset || next >= maxPlaylistTracks {
			next = 0 // no page after this one, or one going back
		}
		writeJSON(w, map[string]interface{}{"tracks": tracks, "more": next > 0, "next": next})
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
