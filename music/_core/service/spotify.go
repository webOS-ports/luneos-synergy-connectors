package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/zmb3/spotify/v2"
	"golang.org/x/oauth2"
)

// track is the normalised shape the Enyo app consumes (kindSpotifyIndex).
type track struct {
	Path       string `json:"path"` // spotify:track:...
	SpotifyID  string `json:"spotifyId"`
	Source     string `json:"source"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	ArtistID   string `json:"artistId"`
	Album      string `json:"album"`
	AlbumID    string `json:"albumId"`
	DurationMs int    `json:"duration_ms"`
	Thumbnail  string `json:"thumbnail"`
}

// spotifyThumb picks the SMALLEST album image. Spotify orders Images largest-first
// (typically 640, 300, 64), so the last one is ~64px — right for a list-row thumbnail
// and far quicker to load on-device than the 640px cover.
func spotifyThumb(images []spotify.Image) string {
	if len(images) == 0 {
		return ""
	}
	return images[len(images)-1].URL
}

func normalizeTrack(t spotify.FullTrack) track {
	img := spotifyThumb(t.Album.Images)
	artist, artistID := "", ""
	if len(t.Artists) > 0 {
		artist, artistID = t.Artists[0].Name, string(t.Artists[0].ID)
	}
	return track{
		Path:       string(t.URI),
		SpotifyID:  string(t.ID),
		Source:     "spotify",
		Title:      t.Name,
		Artist:     artist,
		ArtistID:   artistID,
		Album:      t.Album.Name,
		AlbumID:    string(t.Album.ID),
		DurationMs: int(t.Duration),
		Thumbnail:  img,
	}
}

// POST /session — the front-end posts its PKCE-obtained OAuth2 token here.
func handleSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AccessToken  string    `json:"access_token"`
		RefreshToken string    `json:"refresh_token"`
		TokenType    string    `json:"token_type"`
		Expiry       time.Time `json:"expiry"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad token payload")
		return
	}
	tok := &oauth2.Token{
		AccessToken:  body.AccessToken,
		RefreshToken: body.RefreshToken,
		TokenType:    orDefault(body.TokenType, "Bearer"),
		Expiry:       body.Expiry,
	}
	sess.mu.Lock()
	sess.client = clientFromToken(tok) // persists the token + auto-saves refreshes
	sess.mu.Unlock()

	// Best-effort: find the librespot Connect device so playback can target it.
	go selectLibrespotDevice()
	startLibrespot()

	writeJSON(w, map[string]bool{"ok": true})
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func currentClient(w http.ResponseWriter) *spotify.Client {
	sess.mu.RLock()
	c := sess.client
	sess.mu.RUnlock()
	if c == nil {
		httpErr(w, http.StatusUnauthorized, "no session; POST /session first")
	}
	return c
}

// searchLimitMax is the largest page size this app's Spotify token accepts on
// /search; above it the API replies "Invalid limit". Kept here so search and any
// future paginated fetch share the cap.
const searchLimitMax = 10

// GET /search?q=&type=track|album|artist|playlist&limit=
func handleSearch(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	q := r.URL.Query().Get("q")
	if q == "" {
		writeJSON(w, map[string]interface{}{"tracks": []track{}})
		return
	}
	limit := searchLimitMax
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 {
		limit = l
	}
	// This app's Spotify token rejects search limits above ~10 with "Invalid
	// limit" (a 502 to the caller). Clamp so any client (the app sends 50) is safe.
	if limit > searchLimitMax {
		limit = searchLimitMax
	}

	var st spotify.SearchType
	switch r.URL.Query().Get("type") {
	case "album":
		st = spotify.SearchTypeAlbum
	case "artist":
		st = spotify.SearchTypeArtist
	case "playlist":
		st = spotify.SearchTypePlaylist
	default:
		st = spotify.SearchTypeTrack
	}

	res, err := c.Search(r.Context(), q, st, spotify.Limit(limit))
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}

	out := map[string]interface{}{}
	if res.Tracks != nil {
		tracks := make([]track, 0, len(res.Tracks.Tracks))
		for _, t := range res.Tracks.Tracks {
			tracks = append(tracks, normalizeTrack(t))
		}
		out["tracks"] = tracks
	}
	// albums/artists/playlists are returned raw for now; the app maps them.
	if res.Albums != nil {
		out["albums"] = res.Albums.Albums
	}
	if res.Artists != nil {
		out["artists"] = res.Artists.Artists
	}
	if res.Playlists != nil {
		out["playlists"] = res.Playlists.Playlists
	}
	writeJSON(w, out)
}

// GET /browse/album?id=
func handleBrowseAlbum(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	id := spotify.ID(r.URL.Query().Get("id"))
	page, err := c.GetAlbumTracks(r.Context(), id, spotify.Limit(50))
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	// GetAlbumTracks returns SimpleTracks; fetch the full album for artwork once.
	album, _ := c.GetAlbum(r.Context(), id)
	tracks := make([]track, 0, len(page.Tracks))
	for _, st := range page.Tracks {
		full := spotify.FullTrack{SimpleTrack: st}
		if album != nil {
			full.Album = album.SimpleAlbum
		}
		tracks = append(tracks, normalizeTrack(full))
	}
	writeJSON(w, map[string]interface{}{"tracks": tracks})
}

// GET /browse/artist?id=  -> artist top tracks
func handleBrowseArtist(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	id := spotify.ID(r.URL.Query().Get("id"))
	tops, err := c.GetArtistsTopTracks(r.Context(), id, "US")
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	tracks := make([]track, 0, len(tops))
	for _, t := range tops {
		tracks = append(tracks, normalizeTrack(t))
	}
	writeJSON(w, map[string]interface{}{"tracks": tracks})
}

// GET /me/playlists
func handleMyPlaylists(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	page, err := c.CurrentUsersPlaylists(r.Context(), spotify.Limit(50))
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"playlists": page.Playlists})
}

// handleMe returns the authenticated Spotify user's identity so the Accounts
// validator can label the account with the real email/display name.
func handleMe(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	u, err := c.CurrentUser(r.Context())
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]string{
		"id":          string(u.ID),
		"displayName": u.DisplayName,
		"email":       u.Email,
	})
}
