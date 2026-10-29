package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"sync"

	"golang.org/x/oauth2"
)

// librespot's own sign-in, chained onto the Spotify one in the same browser window.
//
// The token from cfg.clientID drives the Web API, but librespot cannot use it for Connect:
// its Spirc asks login5 for a token with the stored credentials the access point hands back,
// and login5 accepts those only under a Spotify client id (it answers INVALID_CREDENTIALS
// under librespot's id, BAD_REQUEST under ours). So librespot gets a token of its own, from
// the client id it uses itself, the way `librespot --enable-oauth` signs in: PKCE, no secret,
// redirect http://127.0.0.1:<port>/login.
//
//   /auth/callback          (Web API token stored)  -> 302 to Spotify, librespot's client id
//   127.0.0.1:5588/login    (librespot token stored) -> 302 to /auth/done
//
// Spotify signs a first-party client in without a consent page, so the user still signs in
// once. librespot then keeps reusable credentials in its --system-cache.

const (
	// SessionConfig::default().client_id in librespot core/src/config.rs.
	librespotClientID = "65b708073fc0480ea92a077233ca87bd"
	// librespot's own --oauth-port default.
	librespotOAuthAddr = "127.0.0.1:5588"
)

var librespotRedirectURL = "http://" + librespotOAuthAddr + "/login"

// The scopes librespot requests (OAUTH_SCOPES in src/main.rs) that Connect playback needs.
var librespotScopes = []string{
	"streaming",
	"user-read-playback-state",
	"user-modify-playback-state",
	"user-read-currently-playing",
	"user-read-private",
	"user-read-email",
}

var (
	librespotTokenPath = spotifyDataDir + "/librespot-token.json"
	librespotTokenURL  = "https://accounts.spotify.com/api/token" // a test points it at a stand-in
)

func librespotOAuthConfig() *oauth2.Config {
	return &oauth2.Config{
		ClientID:    librespotClientID,
		RedirectURL: librespotRedirectURL,
		Scopes:      librespotScopes,
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://accounts.spotify.com/authorize",
			TokenURL: librespotTokenURL,
			// PKCE, no secret: Spotify wants client_id in the form, not in a Basic header.
			AuthStyle: oauth2.AuthStyleInParams,
		},
	}
}

var librespotPKCE = &pkceState{}

var librespotAuth struct {
	mu  sync.Mutex
	src oauth2.TokenSource
}

// librespotAuthURL starts librespot's sign-in: fresh PKCE, and the authorize URL to send the
// browser to.
func librespotAuthURL() string {
	verifier := oauth2.GenerateVerifier()
	state := oauth2.GenerateVerifier()
	librespotPKCE.mu.Lock()
	librespotPKCE.verifier = verifier
	librespotPKCE.state = state
	librespotPKCE.mu.Unlock()
	return librespotOAuthConfig().AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
}

// GET 127.0.0.1:5588/login?code=&state= -> exchanges for librespot's token, then lands on /auth/done.
func handleLibrespotCallback(w http.ResponseWriter, r *http.Request) {
	librespotPKCE.mu.Lock()
	verifier, want := librespotPKCE.verifier, librespotPKCE.state
	librespotPKCE.verifier, librespotPKCE.state = "", "" // one use
	librespotPKCE.mu.Unlock()

	q := r.URL.Query()
	if want == "" || q.Get("state") != want {
		http.Error(w, "state mismatch", http.StatusForbidden)
		return
	}
	if e := q.Get("error"); e != "" {
		http.Error(w, "Spotify refused librespot's sign-in: "+e, http.StatusForbidden)
		return
	}
	tok, err := librespotOAuthConfig().Exchange(r.Context(), q.Get("code"), oauth2.VerifierOption(verifier))
	if err != nil {
		http.Error(w, "token exchange failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	setLibrespotToken(tok)
	// Credentials cached from an earlier token under another client id would be offered to
	// login5 again; start librespot from this token instead.
	_ = os.Remove(librespotDir + "/credentials.json")
	restartLibrespot()
	http.Redirect(w, r, "http://"+cfg.addr+"/auth/done", http.StatusFound)
}

// GET /auth/done -> the page the sign-in window ends on.
func handleAuthDone(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	_, _ = w.Write([]byte("<html><body style='font-family:sans-serif'>" +
		"<h2>Spotify connected ✓</h2><p>You can close this and return to the app.</p></body></html>"))
}

func setLibrespotToken(tok *oauth2.Token) {
	saveLibrespotToken(tok)
	base := librespotOAuthConfig().TokenSource(context.Background(), tok)
	librespotAuth.mu.Lock()
	librespotAuth.src = oauth2.ReuseTokenSource(tok, &librespotSavingSource{src: base, last: tok.AccessToken})
	librespotAuth.mu.Unlock()
}

type librespotSavingSource struct {
	mu   sync.Mutex
	src  oauth2.TokenSource
	last string
}

func (s *librespotSavingSource) Token() (*oauth2.Token, error) {
	t, err := s.src.Token()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if t.AccessToken != s.last {
		s.last = t.AccessToken
		saveLibrespotToken(t)
	}
	s.mu.Unlock()
	return t, nil
}

func saveLibrespotToken(tok *oauth2.Token) {
	b, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return
	}
	if err := writeSecret(librespotTokenPath, b); err != nil {
		log.Printf("librespot token: %v", err)
	}
}

// restoreLibrespotToken reloads librespot's token at startup, if it signed in before.
func restoreLibrespotToken() bool {
	b, err := os.ReadFile(librespotTokenPath)
	if err != nil {
		return false
	}
	var tok oauth2.Token
	if json.Unmarshal(b, &tok) != nil || tok.RefreshToken == "" {
		return false
	}
	setLibrespotToken(&tok)
	return true
}

// librespotSignedIn reports whether librespot has a token of its own or credentials it cached.
func librespotSignedIn() bool {
	librespotAuth.mu.Lock()
	src := librespotAuth.src
	librespotAuth.mu.Unlock()
	return src != nil || fileExists(librespotDir+"/credentials.json")
}

// freshLibrespotToken is a current access token for librespot, or "" before its sign-in.
func freshLibrespotToken() string {
	librespotAuth.mu.Lock()
	src := librespotAuth.src
	librespotAuth.mu.Unlock()
	if src == nil {
		return ""
	}
	t, err := src.Token()
	if err != nil || t == nil {
		log.Printf("librespot token: refresh failed: %v", err)
		return ""
	}
	return t.AccessToken
}

// serveLibrespotOAuth listens on librespot's redirect address for the end of its sign-in.
func serveLibrespotOAuth() {
	ln, err := net.Listen("tcp", librespotOAuthAddr)
	if err != nil {
		log.Printf("librespot sign-in: cannot listen on %s: %v", librespotOAuthAddr, err)
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/login", handleLibrespotCallback)
	go func() { log.Printf("librespot sign-in: %v", http.Serve(ln, mux)) }()
}
