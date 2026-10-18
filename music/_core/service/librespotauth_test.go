package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/oauth2"
)

// fakeSpotifyToken stands in for accounts.spotify.com/api/token and records the form it got.
func fakeSpotifyToken(t *testing.T, form *url.Values) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		*form = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"lr-access","token_type":"Bearer","refresh_token":"lr-refresh","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)
	old := librespotTokenURL
	librespotTokenURL = srv.URL
	t.Cleanup(func() { librespotTokenURL = old })
}

func librespotTestDirs(t *testing.T) (cache string) {
	t.Helper()
	dir := t.TempDir()
	oldPath, oldDir, oldAddr, oldWeb := librespotTokenPath, librespotDir, cfg.addr, tokenPath
	librespotTokenPath = filepath.Join(dir, "librespot-token.json")
	tokenPath = filepath.Join(dir, "spotify-token.json")
	librespotDir = filepath.Join(dir, "librespot-cache")
	cfg.addr = "127.0.0.1:8730"
	librespotAuth.src = nil
	t.Cleanup(func() {
		librespotTokenPath, librespotDir, cfg.addr, tokenPath = oldPath, oldDir, oldAddr, oldWeb
		librespotAuth.src = nil
	})
	if err := os.MkdirAll(librespotDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return librespotDir
}

func TestLibrespotAuthURL(t *testing.T) {
	u, err := url.Parse(librespotAuthURL())
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Host != "accounts.spotify.com" || u.Path != "/authorize" {
		t.Fatalf("authorize URL %s", u)
	}
	if q.Get("client_id") != librespotClientID {
		t.Fatalf("client_id %q, want librespot's", q.Get("client_id"))
	}
	if q.Get("redirect_uri") != "http://127.0.0.1:5588/login" {
		t.Fatalf("redirect_uri %q", q.Get("redirect_uri"))
	}
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
		t.Fatalf("no PKCE challenge: %v", q)
	}
	if !strings.Contains(" "+q.Get("scope")+" ", " streaming ") {
		t.Fatalf("scope %q lacks streaming", q.Get("scope"))
	}
	librespotPKCE.mu.Lock()
	state := librespotPKCE.state
	librespotPKCE.mu.Unlock()
	if state == "" || q.Get("state") != state {
		t.Fatalf("state %q not the one kept (%q)", q.Get("state"), state)
	}
}

func TestLibrespotCallbackStoresTokenAndEndsOnDone(t *testing.T) {
	cache := librespotTestDirs(t)
	stale := filepath.Join(cache, "credentials.json")
	if err := os.WriteFile(stale, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	var form url.Values
	fakeSpotifyToken(t, &form)

	q, _ := url.Parse(librespotAuthURL())
	state := q.Query().Get("state")
	librespotPKCE.mu.Lock()
	verifier := librespotPKCE.verifier
	librespotPKCE.mu.Unlock()

	rec := httptest.NewRecorder()
	handleLibrespotCallback(rec, httptest.NewRequest("GET", "/login?code=the-code&state="+state, nil))

	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "http://127.0.0.1:8730/auth/done" {
		t.Fatalf("got %d to %q, want 302 to /auth/done: %s", rec.Code, rec.Header().Get("Location"), rec.Body)
	}
	if form.Get("code") != "the-code" || form.Get("code_verifier") != verifier || form.Get("client_id") != librespotClientID {
		t.Fatalf("token request %v", form)
	}
	if got := freshLibrespotToken(); got != "lr-access" {
		t.Fatalf("freshLibrespotToken %q", got)
	}
	st, err := os.Stat(librespotTokenPath)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("token file: %v %v", st, err)
	}
	var saved map[string]any
	b, _ := os.ReadFile(librespotTokenPath)
	if json.Unmarshal(b, &saved) != nil || saved["refresh_token"] != "lr-refresh" {
		t.Fatalf("saved token %s", b)
	}
	if fileExists(stale) {
		t.Fatal("credentials cached before this sign-in were kept")
	}

	// restored after a restart
	librespotAuth.src = nil
	if !restoreLibrespotToken() || freshLibrespotToken() != "lr-access" {
		t.Fatal("token not restored from disk")
	}
}

func TestLibrespotCallbackRefusals(t *testing.T) {
	librespotTestDirs(t)
	var form url.Values
	fakeSpotifyToken(t, &form)

	call := func(query string) int {
		rec := httptest.NewRecorder()
		handleLibrespotCallback(rec, httptest.NewRequest("GET", "/login?"+query, nil))
		return rec.Code
	}

	q, _ := url.Parse(librespotAuthURL())
	state := q.Query().Get("state")
	if c := call("code=x&state=wrong"); c != http.StatusForbidden {
		t.Fatalf("wrong state: %d", c)
	}
	// the state is spent by the first callback, right or wrong
	if c := call("code=x&state=" + state); c != http.StatusForbidden {
		t.Fatalf("reused state: %d", c)
	}

	q, _ = url.Parse(librespotAuthURL())
	if c := call("error=access_denied&state=" + q.Query().Get("state")); c != http.StatusForbidden {
		t.Fatalf("refused sign-in: %d", c)
	}
	if form != nil || freshLibrespotToken() != "" || fileExists(librespotTokenPath) {
		t.Fatal("a refused callback still fetched or stored a token")
	}
}

func TestLoginGoesStraightToLibrespotWhenOnlyItIsMissing(t *testing.T) {
	librespotTestDirs(t)
	oldID, oldClient := cfg.clientID, sess.client
	cfg.clientID = "web-api-client"
	t.Cleanup(func() { cfg.clientID, sess.client = oldID, oldClient })

	login := func() *url.URL {
		rec := httptest.NewRecorder()
		handleLoginRedirect(rec, httptest.NewRequest("GET", "/login", nil))
		u, err := url.Parse(rec.Header().Get("Location"))
		if rec.Code != http.StatusFound || err != nil {
			t.Fatalf("/login: %d %v", rec.Code, err)
		}
		return u
	}
	status := func() map[string]bool {
		rec := httptest.NewRecorder()
		handleAuthStatus(rec, httptest.NewRequest("GET", "/auth/status", nil))
		var m map[string]bool
		_ = json.Unmarshal(rec.Body.Bytes(), &m)
		return m
	}

	// nothing signed in: the Web API sign-in first
	sess.client = nil
	if got := login().Query().Get("client_id"); got != "web-api-client" {
		t.Fatalf("not signed in: /login went to client %q", got)
	}
	if s := status(); s["authenticated"] || s["librespot"] {
		t.Fatalf("status %v", s)
	}

	// Web API session restored, librespot never signed in: only its step
	sess.client = clientFromToken(&oauth2.Token{AccessToken: "a", RefreshToken: "r"})
	if got := login().Query().Get("client_id"); got != librespotClientID {
		t.Fatalf("Web API only: /login went to client %q, want librespot's", got)
	}
	if s := status(); !s["authenticated"] || s["librespot"] {
		t.Fatalf("status %v", s)
	}

	// both: a fresh full sign-in, as before
	setLibrespotToken(&oauth2.Token{AccessToken: "l", RefreshToken: "lr"})
	if got := login().Query().Get("client_id"); got != "web-api-client" {
		t.Fatalf("both signed in: /login went to client %q", got)
	}
	if s := status(); !s["authenticated"] || !s["librespot"] {
		t.Fatalf("status %v", s)
	}
}
