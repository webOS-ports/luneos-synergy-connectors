package main

import (
	"context"
	"net/http"
)

// libraryBrowser is an OPTIONAL provider capability: a library to walk, the
// way the app walks the music on the device: artists, an artist's albums, an
// album's tracks, and lists of albums (the newest, the most played...). Subsonic
// implements it: a user's own server is a library, not only a search box.
type libraryBrowser interface {
	Artists(ctx context.Context) ([]providerArtist, error)
	ArtistAlbums(ctx context.Context, artistID string) ([]providerAlbum, error)
	AlbumTracks(ctx context.Context, albumID string) ([]providerTrack, error)
	// Albums is one of albumLists, as the service orders it.
	Albums(ctx context.Context, list string) ([]providerAlbum, error)
}

// providerArtist and providerAlbum are the normalised shapes returned to the app.
type providerArtist struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Name      string `json:"name"`
	Thumbnail string `json:"thumbnail"`
	Albums    int    `json:"albums"` // how many the service says it has
}

type providerAlbum struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Name      string `json:"name"`
	Artist    string `json:"artist"`
	ArtistID  string `json:"artist_id"`
	Year      int    `json:"year"`
	Thumbnail string `json:"thumbnail"`
	Tracks    int    `json:"tracks"`
}

// The lists of albums the app may ask for.
var albumLists = map[string]bool{"newest": true, "recent": true, "frequent": true, "random": true, "alphabetical": true}

// Most of a library the app is given at once: enough for a large collection,
// bounded for a huge one.
const (
	maxArtists     = 5000
	maxAlbums      = 1000
	maxAlbumTracks = 1000
	albumListSize  = 60
)

// GET /provider/<id>/artists -> {artists}
// GET /provider/<id>/artist?id= -> {albums}
// GET /provider/<id>/album?id= -> {tracks}
// GET /provider/<id>/albums?list=newest|recent|frequent|random|alphabetical -> {albums}
func handleBrowseRoute(w http.ResponseWriter, r *http.Request, p MusicProvider, action string) {
	lb, ok := p.(libraryBrowser)
	if !ok {
		httpErr(w, http.StatusConflict, p.ID()+" has no library to browse")
		return
	}
	ctx := r.Context()
	id := r.URL.Query().Get("id")
	if (action == "artist" || action == "album") && id == "" {
		httpErr(w, http.StatusBadRequest, "id is required")
		return
	}
	var (
		out interface{}
		key string
		err error
	)
	switch action {
	case "artists":
		key = "artists"
		out, err = lb.Artists(ctx)
	case "artist":
		key = "albums"
		out, err = lb.ArtistAlbums(ctx, id)
	case "album":
		key = "tracks"
		out, err = lb.AlbumTracks(ctx, id)
	case "albums":
		list := r.URL.Query().Get("list")
		if list == "" {
			list = "newest"
		}
		if !albumLists[list] {
			httpErr(w, http.StatusBadRequest, "unknown list: "+list)
			return
		}
		key = "albums"
		out, err = lb.Albums(ctx, list)
	}
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{key: out})
}
