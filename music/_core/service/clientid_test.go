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

const (
	ownClientID   = "0123456789abcdef0123456789abcdef"
	otherClientID = "fedcba9876543210fedcba9876543210"
)

// clientIDTestState gives the test a client id file and token of its own, and
// puts the client id, its source and the session back afterwards.
func clientIDTestState(t *testing.T, id, source string) {
	t.Helper()
	librespotTestDirs(t)
	oldPath, oldClient, oldRedirect := clientIDPath, sess.client, cfg.redirectURL
	oldID, oldSource := spotifyClientIDSource()
	clientIDPath = filepath.Join(filepath.Dir(tokenPath), "spotify-client-id")
	cfg.redirectURL = "http://127.0.0.1:8730/auth/callback"
	setSpotifyClientID(id, source)
	t.Cleanup(func() {
		clientIDPath, sess.client, cfg.redirectURL = oldPath, oldClient, oldRedirect
		setSpotifyClientID(oldID, oldSource)
		currentTokenSource = nil
	})
}

func clientIDCall(t *testing.T, method, body string) (int, map[string]string) {
	t.Helper()
	rec := httptest.NewRecorder()
	handleClientID(rec, httptest.NewRequest(method, "/auth/client-id", strings.NewReader(body)))
	var m map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	return rec.Code, m
}

func TestNormalClientID(t *testing.T) {
	for in, want := range map[string]string{
		ownClientID: ownClientID,
		" " + strings.ToUpper(ownClientID) + "\n": ownClientID,
		"\t0123456789ABCDEF0123456789abcdef  ":    ownClientID,
	} {
		if got, ok := normalClientID(in); !ok || got != want {
			t.Errorf("normalClientID(%q) = %q %v", in, got, ok)
		}
	}
	for _, in := range []string{
		"", "0123456789abcdef0123456789abcde", ownClientID + "0",
		"0123456789abcdef0123456789abcdeg", "0123456789abcdef 0123456789abcdef",
		"Client ID: " + ownClientID,
	} {
		if _, ok := normalClientID(in); ok {
			t.Errorf("normalClientID(%q) took it", in)
		}
	}
}

func TestClientIDGetTellsWhatToRegister(t *testing.T) {
	clientIDTestState(t, "", "")
	code, m := clientIDCall(t, "GET", "")
	if code != http.StatusOK || m["clientId"] != "" || m["source"] != "" ||
		m["redirectUri"] != "http://127.0.0.1:8730/auth/callback" || m["dashboardUrl"] != spotifyDashboardURL {
		t.Fatalf("GET with none: %d %v", code, m)
	}
	if code, _ := clientIDCall(t, "DELETE", ""); code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE: %d", code)
	}
}

func TestClientIDPostSetsKeepsAndSignsOut(t *testing.T) {
	clientIDTestState(t, otherClientID, "image")
	km := useFakeKeymanager(t)
	sess.client = clientFromToken(&oauth2.Token{AccessToken: "a", RefreshToken: "r"}) // writes tokenPath
	if !fileExists(tokenPath) {
		t.Fatal("no token file to begin with")
	}

	code, m := clientIDCall(t, "POST", `{"clientId":" `+strings.ToUpper(ownClientID)+` "}`)
	if code != http.StatusOK || m["clientId"] != ownClientID || m["source"] != "device" {
		t.Fatalf("POST: %d %v", code, m)
	}
	if b, _ := os.ReadFile(clientIDPath); strings.TrimSpace(string(b)) != ownClientID {
		t.Fatalf("client id file holds %q", b)
	}
	if _, there := km.keys["spotify-client-id"]; !there {
		t.Fatal("client id not in the keymanager")
	}
	// the token was the other client id's: gone, file and keymanager both
	sess.mu.RLock()
	signedIn := sess.client != nil
	sess.mu.RUnlock()
	if signedIn || currentTokenSource != nil || fileExists(tokenPath) {
		t.Fatal("the old client id's session survived")
	}
	if _, there := km.keys[filepath.Base(tokenPath)]; there {
		t.Fatal("the old client id's token is still in the keymanager")
	}

	// the sign-in now goes to the user's app
	rec := httptest.NewRecorder()
	handleLoginRedirect(rec, httptest.NewRequest("GET", "/login", nil))
	u, err := url.Parse(rec.Header().Get("Location"))
	if rec.Code != http.StatusFound || err != nil || u.Query().Get("client_id") != ownClientID {
		t.Fatalf("/login: %d %v", rec.Code, u)
	}

	// the same id again leaves a session made with it alone
	sess.client = clientFromToken(&oauth2.Token{AccessToken: "b", RefreshToken: "r2"})
	if code, _ := clientIDCall(t, "POST", `{"clientId":"`+ownClientID+`"}`); code != http.StatusOK {
		t.Fatalf("same id: %d", code)
	}
	if sess.client == nil || !fileExists(tokenPath) {
		t.Fatal("giving the same client id signed out")
	}
}

func TestClientIDPostRefusals(t *testing.T) {
	clientIDTestState(t, otherClientID, "device")
	useFakeKeymanager(t)
	for _, body := range []string{`{"clientId":"not one"}`, `{"clientId":""}`, `nope`, `{"clientId":"` + ownClientID + `0"}`} {
		if code, m := clientIDCall(t, "POST", body); code != http.StatusBadRequest || m["error"] == "" {
			t.Errorf("POST %s: %d %v", body, code, m)
		}
	}
	if id, _ := spotifyClientIDSource(); id != otherClientID || fileExists(clientIDPath) {
		t.Fatal("a refused client id changed something")
	}

	for _, src := range []string{"flag", "file"} {
		setSpotifyClientID(otherClientID, src)
		if code, _ := clientIDCall(t, "POST", `{"clientId":"`+ownClientID+`"}`); code != http.StatusConflict {
			t.Errorf("source %s: %d", src, code)
		}
		if id, s := spotifyClientIDSource(); id != otherClientID || s != src {
			t.Errorf("source %s: now %q from %q", src, id, s)
		}
	}
}

func TestLoadSpotifyClientID(t *testing.T) {
	clientIDTestState(t, "", "")

	loadSpotifyClientID(ownClientID, "")
	if id, s := spotifyClientIDSource(); id != ownClientID || s != "flag" {
		t.Fatalf("flag: %q %q", id, s)
	}

	if err := os.WriteFile(clientIDPath, []byte(otherClientID+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	loadSpotifyClientID("", "")
	if id, s := spotifyClientIDSource(); id != otherClientID || s != "device" {
		t.Fatalf("device file: %q %q", id, s)
	}

	given := filepath.Join(t.TempDir(), "id")
	if err := os.WriteFile(given, []byte(ownClientID), 0o600); err != nil {
		t.Fatal(err)
	}
	loadSpotifyClientID("", given)
	if id, s := spotifyClientIDSource(); id != ownClientID || s != "file" {
		t.Fatalf("-client-id-file: %q %q", id, s)
	}

	// a -client-id-file with nothing in it does not fall back to the device file
	empty := filepath.Join(t.TempDir(), "empty")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	loadSpotifyClientID("", empty)
	if id, _ := spotifyClientIDSource(); id != "" {
		t.Fatalf("empty -client-id-file: %q", id)
	}
}
