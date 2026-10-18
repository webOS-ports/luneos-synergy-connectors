package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// MusicProvider is the connector contract (see docs/MUSIC-CONNECTORS.md). Each
// music service implements it. Spotify is the special case (playback via
// librespot/Connect, no stream URL); "stream-URL" providers (SoundCloud,
// YouTube, Deezer, …) return a direct URL that the shared gst player plays.
type MusicProvider interface {
	ID() string   // short id, e.g. "spotify", "youtube", "soundcloud"
	Name() string // display name
	Search(ctx context.Context, query string, limit int) ([]providerTrack, error)
	// StreamURL resolves a playable http(s) audio URL for a track id, or "" if
	// this provider plays via its own mechanism (Spotify → Connect/librespot).
	StreamURL(ctx context.Context, trackID string) (string, error)
}

// formatSelector is an OPTIONAL provider capability: resolve a stream URL preferring a
// specific format label (e.g. "OPUS 160") for the tap-to-switch selector. Only YouTube
// implements it; resolveStream falls back to plain StreamURL for everyone else.
type formatSelector interface {
	StreamURLFormat(ctx context.Context, trackID, format string) (string, error)
}

// videoResolver is an OPTIONAL provider capability: resolve a direct, playable VIDEO
// url (as opposed to StreamURL's audio-only url) for a track id. Only YouTube
// implements it (progressive itag 22/18 — see youtube.go). Unlike /provider/<id>/play,
// the "resolveVideo" action does NOT hand the url to the internal headless audio
// pipeline — it hands the raw url back to the caller, which launches it via the
// native hardware-decoding Video Player app instead.
type videoResolver interface {
	StreamURLVideo(ctx context.Context, trackID string) (string, error)
}

// current stream context so /stream/switchformat can re-resolve the playing track in a
// different format without the UI having to re-send the track id.
var (
	curMu       sync.Mutex
	curProvider MusicProvider
	curTrackID  string
)

func setStreamContext(p MusicProvider, trackID string) {
	curMu.Lock()
	curProvider, curTrackID = p, trackID
	curMu.Unlock()
}

func streamContext() (MusicProvider, string) {
	curMu.Lock()
	defer curMu.Unlock()
	return curProvider, curTrackID
}

func resolveStream(ctx context.Context, p MusicProvider, trackID, format string) (string, error) {
	if format != "" {
		if fs, ok := p.(formatSelector); ok {
			return fs.StreamURLFormat(ctx, trackID, format)
		}
	}
	return p.StreamURL(ctx, trackID)
}

// providerTrack is the normalised track shape returned to the app.
type providerTrack struct {
	ID         string `json:"id"`
	Provider   string `json:"provider"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Album      string `json:"album"`
	Thumbnail  string `json:"thumbnail"`
	DurationMs int    `json:"duration_ms"`
	// Published is a relative-time label ("2 weeks ago") for providers that have one
	// (currently just YouTube search results, straight from InnerTube's publishedTimeText).
	Published string `json:"published,omitempty"`
	// Path the app should hand to playback. For Spotify: spotify:track:<id>.
	// For stream-URL providers: provider:<id>:<trackid> (the app calls
	// /provider/<id>/play to actually start it).
	Path string `json:"path"`
}

// providersMu guards `providers` (and the first-party `downloaders`/`dzDL` state in
// providerauth.go), which are mutated at runtime when a music account is added via
// the Accounts flow. Reads on the hot search/play path take RLock.
var (
	providers   = map[string]MusicProvider{}
	providersMu sync.RWMutex
)

func registerProvider(p MusicProvider) {
	providersMu.Lock()
	providers[p.ID()] = p
	providersMu.Unlock()
}

// providerReady reports whether a provider is usable right now, so /providers can hide
// account-required connectors until their account is added. Credential providers
// (Qobuz/Tidal) are only in the registry once configured, so they're inherently gated;
// Spotify is always registered but is useless without a login session.
func providerReady(id string) bool {
	if id == "youtube" {
		// Official-song playback now works self-contained: the ANDROID_VR InnerTube
		// client returns direct, un-ciphered, un-throttled audio URLs, and an anonymous
		// visitor session (visitorData + visitor cookies) clears the bot-check — no
		// OAuth, no PoToken, no signature descrambling. Always available.
		return true
	}
	if id == "spotify" {
		sess.mu.RLock()
		ready := sess.client != nil
		sess.mu.RUnlock()
		return ready
	}
	return true
}

// GET /providers -> [{id,name,available}]
func handleProviders(w http.ResponseWriter, r *http.Request) {
	type row struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := []row{}
	providersMu.RLock()
	for _, p := range providers {
		if !providerReady(p.ID()) {
			continue
		}
		out = append(out, row{ID: p.ID(), Name: p.Name()})
	}
	providersMu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	writeJSON(w, map[string]interface{}{"providers": out})
}

// GET /provider/<id>/search?q=&limit=
// POST /provider/<id>/play  {trackId}
func handleProviderRoute(w http.ResponseWriter, r *http.Request) {
	// path: /provider/<id>/<action>
	rest := strings.TrimPrefix(r.URL.Path, "/provider/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) < 2 {
		httpErr(w, http.StatusBadRequest, "usage: /provider/<id>/<search|play>")
		return
	}
	id, action := parts[0], parts[1]
	providersMu.RLock()
	p := providers[id]
	providersMu.RUnlock()
	if p == nil {
		httpErr(w, http.StatusNotFound, "unknown provider: "+id)
		return
	}
	switch action {
	case "search":
		q := r.URL.Query().Get("q")
		limit := 50
		if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 {
			limit = l
		}
		tracks, err := p.Search(r.Context(), q, limit)
		if err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, map[string]interface{}{"tracks": tracks})
	case "play":
		var body struct {
			TrackID string `json:"trackId"`
			Format  string `json:"format"` // optional preferred format label (selector)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		url, err := resolveStream(r.Context(), p, body.TrackID, body.Format)
		if err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		if url == "" {
			httpErr(w, http.StatusConflict, id+" has no stream URL (plays via its own engine)")
			return
		}
		setStreamContext(p, body.TrackID) // remember for /stream/switchformat
		if err := playStreamURL(url); err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	case "resolveVideo":
		var body struct {
			TrackID string `json:"trackId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		vr, ok := p.(videoResolver)
		if !ok {
			httpErr(w, http.StatusConflict, id+" has no video stream")
			return
		}
		url, err := vr.StreamURLVideo(r.Context(), body.TrackID)
		if err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, map[string]string{"url": url})
	default:
		httpErr(w, http.StatusBadRequest, "unknown action: "+action)
	}
}
