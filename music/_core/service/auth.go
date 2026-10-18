package main

import (
	"net/http"
	"sync"
	"time"

	spotifyauth "github.com/zmb3/spotify/v2/auth"
	"golang.org/x/oauth2"
)

// OAuth2 Authorization-Code + PKCE, run entirely in the backend so the ancient
// on-device browser never handles secrets or crypto. Flow:
//
//   1. app  GET  /auth/login   -> backend builds PKCE verifier+challenge, returns
//                                 {authUrl}. App opens authUrl in the browser.
//   2. user logs in at Spotify; Spotify redirects to the backend:
//      GET /auth/callback?code=&state=  -> backend exchanges code+verifier for a
//                                 token, builds the spotify.Client, stores session.
//   3. app  GET  /auth/status   -> {authenticated: true|false}
//
// No client secret is used (PKCE). Configure with -client-id and -redirect.

type pkceState struct {
	mu       sync.Mutex
	verifier string
	state    string
}

var pkce = &pkceState{}

// scopes needed for search/browse + Connect playback control.
var authScopes = []string{
	spotifyauth.ScopeUserReadPrivate,
	spotifyauth.ScopeUserReadEmail,
	spotifyauth.ScopePlaylistReadPrivate,
	spotifyauth.ScopeUserLibraryRead,
	spotifyauth.ScopeUserReadPlaybackState,
	spotifyauth.ScopeUserModifyPlaybackState,
	spotifyauth.ScopeStreaming,
}

func newAuthenticator() *spotifyauth.Authenticator {
	return spotifyauth.New(
		spotifyauth.WithClientID(cfg.clientID),
		spotifyauth.WithRedirectURL(cfg.redirectURL),
		spotifyauth.WithScopes(authScopes...),
	)
}

// GET /auth/login -> {authUrl}
func handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if cfg.clientID == "" {
		httpErr(w, http.StatusPreconditionFailed, "no client id; start the service with -client-id")
		return
	}
	verifier := oauth2.GenerateVerifier()
	state := oauth2.GenerateVerifier() // reuse as an opaque random state

	pkce.mu.Lock()
	pkce.verifier = verifier
	pkce.state = state
	pkce.mu.Unlock()

	url := newAuthenticator().AuthURL(state, oauth2.S256ChallengeOption(verifier))
	writeJSON(w, map[string]string{"authUrl": url})
}

// GET /login -> 302 redirect straight to the Spotify authorize URL.
// Lets the user just type "127.0.0.1:8730/login" in Atlas's address bar (a real
// user navigation, which always loads — unlike an app relaunch that Atlas may
// drop). Generates fresh PKCE just like /auth/login.
func handleLoginRedirect(w http.ResponseWriter, r *http.Request) {
	if cfg.clientID == "" {
		http.Error(w, "no client id; start the service with -client-id", http.StatusPreconditionFailed)
		return
	}
	verifier := oauth2.GenerateVerifier()
	state := oauth2.GenerateVerifier()
	pkce.mu.Lock()
	pkce.verifier = verifier
	pkce.state = state
	pkce.mu.Unlock()
	url := newAuthenticator().AuthURL(state, oauth2.S256ChallengeOption(verifier))
	http.Redirect(w, r, url, http.StatusFound)
}

// GET /auth/callback?code=&state= -> exchanges and stores the session
func handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	pkce.mu.Lock()
	verifier, want := pkce.verifier, pkce.state
	pkce.mu.Unlock()

	if got := r.URL.Query().Get("state"); got != want || want == "" {
		http.Error(w, "state mismatch", http.StatusForbidden)
		return
	}
	auth := newAuthenticator()
	tok, err := auth.Token(r.Context(), want, r, oauth2.VerifierOption(verifier))
	if err != nil {
		http.Error(w, "token exchange failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	sess.mu.Lock()
	sess.client = clientFromToken(tok) // persists the token + auto-saves refreshes
	sess.mu.Unlock()
	go selectLibrespotDevice()
	startLibrespot()

	// simple page the on-device browser lands on after login
	w.Header().Set("Content-Type", "text/html")
	_, _ = w.Write([]byte("<html><body style='font-family:sans-serif'>" +
		"<h2>Spotify connected ✓</h2><p>You can close this and return to the app.</p></body></html>"))
}

// GET /auth/status -> {authenticated: bool}
func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	sess.mu.RLock()
	ok := sess.client != nil
	sess.mu.RUnlock()
	writeJSON(w, map[string]bool{"authenticated": ok})
}

// handleAuthToken returns the current OAuth token in the account-credential
// shape ({accessToken, refreshToken, expiry}) so the Accounts validator app
// (org.webosports.app.musicauth) can hand it to the Accounts service after login. The
// server listens on 127.0.0.1 only, so this never leaves the device.
func handleAuthToken(w http.ResponseWriter, r *http.Request) {
	if currentTokenSource == nil {
		httpErr(w, http.StatusNotFound, "not authenticated")
		return
	}
	t, err := currentTokenSource.Token()
	if err != nil || t == nil {
		httpErr(w, http.StatusNotFound, "no token")
		return
	}
	writeJSON(w, map[string]string{
		"accessToken":  t.AccessToken,
		"refreshToken": t.RefreshToken,
		"expiry":       t.Expiry.Format(time.RFC3339),
	})
}
