package main

// The Spotify client id the Web API sign-in uses (auth.go, token.go).
//
// Spotify keeps an app in development mode to five users, and lifts that only for
// services with 250k monthly users, so one client id shipped in the image cannot
// serve everyone. Each user registers a developer app of their own (free, with
// their Spotify account) and gives its client id in the account's sign-in
// (org.webosports.app.musicauth): POST /auth/client-id. PKCE needs no secret, so
// the client id is all there is to give.
//
// It is kept in spotifyDataDir/spotify-client-id, and in keymanager with the
// token it was issued for (secrets.go): a refresh token is only good for the
// client id that got it, so the two go to a restored device together. Where it
// comes from, first found:
//
//	-client-id                     "flag"   (development; not changed at runtime)
//	-client-id-file, if given      "file"
//	spotifyDataDir/spotify-client-id "device" (the user's own app)
//	/etc/spotify-webos/...         "image"  (a build's SPOTIFY_CLIENT_ID)
//
// librespot signs in under its own client id (librespotauth.go) and is not
// affected: changing this one signs out the Web API session only.

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

const spotifyDashboardURL = "https://developer.spotify.com/dashboard"

var (
	clientIDPath = spotifyDataDir + "/spotify-client-id"

	clientIDMu     sync.RWMutex
	clientIDSource string // see above; "" with no client id
)

// clientIDShape is what Spotify hands out: 32 hex digits.
var clientIDShape = regexp.MustCompile(`^[0-9a-f]{32}$`)

// normalClientID returns s as Spotify writes a client id, and whether it is one.
// A copy from the dashboard can bring spaces or capitals along; nothing else.
func normalClientID(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	return s, clientIDShape.MatchString(s)
}

func spotifyClientID() string {
	clientIDMu.RLock()
	defer clientIDMu.RUnlock()
	return cfg.clientID
}

func spotifyClientIDSource() (string, string) {
	clientIDMu.RLock()
	defer clientIDMu.RUnlock()
	return cfg.clientID, clientIDSource
}

func setSpotifyClientID(id, source string) {
	clientIDMu.Lock()
	cfg.clientID, clientIDSource = id, source
	clientIDMu.Unlock()
}

// loadSpotifyClientID sets the client id at startup, from the flag or the first
// file that has one.
func loadSpotifyClientID(flagID, flagFile string) {
	if flagID != "" {
		setSpotifyClientID(flagID, "flag")
		log.Printf("Spotify client id from -client-id; redirect=%s", cfg.redirectURL)
		return
	}
	paths, sources := []string{clientIDPath, packagedConfigDir + "/spotify-client-id"}, []string{"device", "image"}
	if flagFile != "" {
		paths, sources = []string{flagFile}, []string{"file"}
	}
	for i, p := range paths {
		if id, from := readFirstNonEmpty(p); from != "" {
			setSpotifyClientID(id, sources[i])
			log.Printf("Spotify client id from %s; redirect=%s", from, cfg.redirectURL)
			return
		}
	}
	setSpotifyClientID("", "")
	log.Printf("no Spotify client id: the account's sign-in asks for one")
}

// signOutWebAPI forgets the Web API session and its token: they belong to a
// client id that is no longer the one in use. librespot's sign-in stays.
func signOutWebAPI() {
	sess.mu.Lock()
	sess.client = nil
	sess.mu.Unlock()
	currentTokenSource = nil
	currentAccountID = ""
	removeSecret(tokenPath)
}

// GET  /auth/client-id -> {clientId, source, redirectUri, dashboardUrl}
// POST /auth/client-id {clientId} -> the same, for the client id now in use.
//
// The sign-in shows redirectUri for the user to register on their app; Spotify
// refuses a sign-in whose redirect_uri the app does not list.
func handleClientID(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		var body struct {
			ClientID string `json:"clientId"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			httpErr(w, http.StatusBadRequest, "bad payload")
			return
		}
		id, ok := normalClientID(body.ClientID)
		if !ok {
			httpErr(w, http.StatusBadRequest, "a Spotify client id is 32 letters and digits")
			return
		}
		if code, msg := changeSpotifyClientID(id); code != 0 {
			httpErr(w, code, msg)
			return
		}
	default:
		httpErr(w, http.StatusMethodNotAllowed, "GET or POST")
		return
	}
	id, source := spotifyClientIDSource()
	writeJSON(w, map[string]string{
		"clientId":     id,
		"source":       source,
		"redirectUri":  cfg.redirectURL,
		"dashboardUrl": spotifyDashboardURL,
	})
}

// changeSpotifyClientID makes id the client id in use and keeps it. It returns
// an HTTP status and message when it cannot, 0 when it did.
func changeSpotifyClientID(id string) (int, string) {
	cur, source := spotifyClientIDSource()
	if source == "flag" || source == "file" {
		return http.StatusConflict, "the service was started with -client-id or -client-id-file"
	}
	if id == cur && source == "device" {
		return 0, ""
	}
	if err := writeSecret(clientIDPath, []byte(id+"\n")); err != nil {
		log.Printf("client id: %v", err)
		return http.StatusInternalServerError, "could not keep the client id"
	}
	if id != cur {
		signOutWebAPI()
	}
	setSpotifyClientID(id, "device")
	log.Printf("Spotify client id set by the sign-in")
	return 0, ""
}
