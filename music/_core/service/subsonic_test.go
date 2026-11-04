package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const ssUser, ssPass = "alice", "s3cret pass"

// fakeSubsonic answers the Subsonic API as Navidrome 0.64 did (2026-11-04):
// JSON under "subsonic-response", status "failed" with an error code for a
// refusal, the file itself for stream and getCoverArt.
type fakeSubsonic struct {
	srv        *httptest.Server
	tokens     bool // takes token sign-ins (false: error 41, as for LDAP users)
	requests   []url.Values
	paths      []string
	streamBody []byte
}

func newFakeSubsonic(t *testing.T) *fakeSubsonic {
	f := &fakeSubsonic{tokens: true, streamBody: []byte("0123456789abcdefghij")}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func ssReply(w http.ResponseWriter, body map[string]interface{}) {
	r := map[string]interface{}{"status": "ok", "version": "1.16.1", "type": "navidrome", "openSubsonic": true}
	for k, v := range body {
		r[k] = v
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"subsonic-response": r})
}

func ssFail(w http.ResponseWriter, code int, msg string) {
	ssReply(w, map[string]interface{}{"status": "failed", "error": map[string]interface{}{"code": code, "message": msg}})
}

func (f *fakeSubsonic) signedIn(q url.Values) (bool, int) {
	if q.Get("u") != ssUser {
		return false, 40
	}
	if t := q.Get("t"); t != "" {
		if !f.tokens {
			return false, 41
		}
		sum := md5.Sum([]byte(ssPass + q.Get("s")))
		return t == hex.EncodeToString(sum[:]) && q.Get("s") != "", 40
	}
	return q.Get("p") == "enc:"+hex.EncodeToString([]byte(ssPass)), 40
}

func (f *fakeSubsonic) serve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f.requests = append(f.requests, q)
	f.paths = append(f.paths, r.URL.Path)
	if ok, code := f.signedIn(q); !ok {
		ssFail(w, code, "Wrong username or password")
		return
	}
	switch strings.TrimPrefix(r.URL.Path, "/music") {
	case "/rest/ping.view":
		ssReply(w, nil)
	case "/rest/search3.view":
		ssReply(w, map[string]interface{}{"searchResult3": map[string]interface{}{"song": []map[string]interface{}{
			{"id": "s1", "title": "Morning Tone", "artist": "Test Artist", "album": "First Album", "coverArt": "al-1", "duration": 40},
			{"id": "d1", "title": "A folder", "isDir": true},
			{"id": "v1", "title": "A video", "isVideo": true},
			{"id": "s2", "title": "Café Lossless", "artist": "Other Band", "album": "Second Album", "duration": 25},
			{"id": "s3", "title": "Third", "duration": 1, "coverArt": "al 3&size=1"},
		}}})
	case "/rest/getPlaylists.view":
		ssReply(w, map[string]interface{}{"playlists": map[string]interface{}{"playlist": []map[string]interface{}{
			{"id": "pl1", "name": "Road Trip", "owner": "alice", "songCount": 2, "coverArt": "pl-1"},
			{"id": "", "name": "broken"},
		}}})
	case "/rest/getPlaylist.view":
		if q.Get("id") != "pl1" {
			ssFail(w, 70, "Playlist not found")
			return
		}
		ssReply(w, map[string]interface{}{"playlist": map[string]interface{}{"id": "pl1", "entry": []map[string]interface{}{
			{"id": "s2", "title": "Café Lossless", "duration": 25}, {"id": "s1", "title": "Morning Tone", "duration": 40},
		}}})
	case "/rest/stream.view":
		if q.Get("id") != "s1" {
			ssFail(w, 70, "Song not found")
			return
		}
		http.ServeContent(w, r, "a.mp3", time.Unix(0, 0), bytes.NewReader(f.streamBody))
	case "/rest/getCoverArt.view":
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("jpeg:" + q.Get("id") + ":" + q.Get("size")))
	default:
		ssFail(w, 0, "unknown method")
	}
}

func ssCreds(server string) subsonicCreds {
	return subsonicCreds{Server: server, User: ssUser, Password: ssPass}
}

// useSubsonic signs in to f and puts the provider in the registry, as a login does.
func useSubsonic(t *testing.T, f *fakeSubsonic) *subsonicProvider {
	t.Helper()
	p := &subsonicProvider{cl: newSubsonicClient(ssCreds(f.srv.URL))}
	providersMu.Lock()
	old, had := providers["subsonic"]
	providers["subsonic"] = p
	providersMu.Unlock()
	t.Cleanup(func() {
		providersMu.Lock()
		if had {
			providers["subsonic"] = old
		} else {
			delete(providers, "subsonic")
		}
		providersMu.Unlock()
	})
	return p
}

func useSubsonicAuthPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "subsonic-auth")
	old := subsonicAuthPath
	subsonicAuthPath = path
	t.Cleanup(func() { subsonicAuthPath = old })
	return path
}

func TestSubsonicServerAddress(t *testing.T) {
	for in, want := range map[string]string{
		"nas:4533":                                    "http://nas:4533",
		" http://nas:4533/ ":                          "http://nas:4533",
		"https://music.example/app/#/album/x":         "https://music.example",
		"https://music.example/app/":                  "https://music.example",
		"http://nas:4533/rest":                        "http://nas:4533",
		"http://nas:4533/rest/ping.view?u=a&t=b":      "http://nas:4533",
		"https://proxy.example/navidrome/":            "https://proxy.example/navidrome",
		"https://proxy.example/navidrome/app/#/":      "https://proxy.example/navidrome",
		"https://bob:pw@music.example":                "https://music.example",
		"192.168.1.233:4533":                          "http://192.168.1.233:4533",
		"http://[fd00::5]:4533/":                      "http://[fd00::5]:4533",
		"https://music.example/rest-of-things/apples": "https://music.example/rest-of-things/apples",
	} {
		got, err := normalizeSubsonicServer(in)
		if err != nil || got != want {
			t.Errorf("normalizeSubsonicServer(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", "ftp://nas", "http://", "http://%zz"} {
		if got, err := normalizeSubsonicServer(in); err == nil {
			t.Errorf("normalizeSubsonicServer(%q) = %q, want an error", in, got)
		}
	}
}

func TestSubsonicCredsKeepEveryField(t *testing.T) {
	for _, c := range []subsonicCreds{ssCreds("http://nas:4533"), {Server: "https://x", User: "u", Password: " p ", Plain: true}} {
		got, ok := parseSubsonicCreds(c.encode())
		if !ok || got != c {
			t.Errorf("round trip of %+v gave %+v, %v", c, got, ok)
		}
	}
	for _, b := range []string{"", "http://x\n", "http://x\nu\n", "http://x\n\npw\n", "\nu\npw\n"} {
		if _, ok := parseSubsonicCreds([]byte(b)); ok {
			t.Errorf("parseSubsonicCreds(%q) took it", b)
		}
	}
}

func TestSubsonicSignsEachRequestWithAFreshToken(t *testing.T) {
	f := newFakeSubsonic(t)
	p := useSubsonic(t, f)
	for i := 0; i < 2; i++ {
		if _, err := p.Search(context.Background(), "tone", 10); err != nil {
			t.Fatal(err)
		}
	}
	a, b := f.requests[0], f.requests[1]
	for _, q := range []url.Values{a, b} {
		if q.Get("v") != subsonicAPIVersion || q.Get("c") != subsonicClientName || q.Get("f") != "json" || q.Get("p") != "" {
			t.Errorf("request fields %v", q)
		}
	}
	if a.Get("s") == b.Get("s") || a.Get("t") == b.Get("t") {
		t.Errorf("salt and token reused: %v / %v", a, b)
	}
	if len(a.Get("s")) < 12 {
		t.Errorf("salt %q too short", a.Get("s"))
	}
}

func TestSubsonicSearch(t *testing.T) {
	f := newFakeSubsonic(t)
	p := useSubsonic(t, f)
	got, err := p.Search(context.Background(), "  tone ", 2)
	if err != nil {
		t.Fatal(err)
	}
	want := []providerTrack{
		{ID: "s1", Provider: "subsonic", Title: "Morning Tone", Artist: "Test Artist", Album: "First Album",
			Thumbnail: "http://127.0.0.1:8730/subsonicart?id=al-1", DurationMs: 40000, Path: "subsonic:s1"},
		{ID: "s2", Provider: "subsonic", Title: "Café Lossless", Artist: "Other Band", Album: "Second Album",
			DurationMs: 25000, Path: "subsonic:s2"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
	q := f.requests[0]
	if q.Get("query") != "tone" || q.Get("songCount") != "2" || q.Get("artistCount") != "0" || q.Get("albumCount") != "0" {
		t.Errorf("search3 asked %v", q)
	}
	got, _ = p.Search(context.Background(), "x", 0)
	if len(got) != 3 || f.requests[1].Get("songCount") != "50" {
		t.Fatalf("no limit: %d tracks, songCount %s", len(got), f.requests[1].Get("songCount"))
	}
	if got[2].Thumbnail != "http://127.0.0.1:8730/subsonicart?id=al+3%26size%3D1" {
		t.Errorf("a cover id is not escaped: %s", got[2].Thumbnail)
	}
	if got, err := p.Search(context.Background(), "  ", 5); err != nil || len(got) != 0 || len(f.requests) != 2 {
		t.Errorf("a blank search asked the server: %v %v", got, err)
	}
}

func TestSubsonicPlaylists(t *testing.T) {
	f := newFakeSubsonic(t)
	p := useSubsonic(t, f)
	lists, err := p.Playlists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(lists) != 1 || lists[0] != (providerPlaylist{ID: "pl1", Provider: "subsonic", Name: "Road Trip", Owner: "alice",
		Thumbnail: "http://127.0.0.1:8730/subsonicart?id=pl-1", Tracks: 2}) {
		t.Errorf("playlists %+v", lists)
	}
	tracks, err := p.PlaylistTracks(context.Background(), "pl1")
	if err != nil || len(tracks) != 2 || tracks[0].Path != "subsonic:s2" || tracks[1].Path != "subsonic:s1" {
		t.Errorf("tracks %+v %v", tracks, err)
	}
	if _, err := p.PlaylistTracks(context.Background(), "nope"); err == nil || err.Error() != "not found on the server" {
		t.Errorf("a missing playlist: %v", err)
	}
}

func TestSubsonicTakesThePasswordWhenTheServerTakesNoToken(t *testing.T) {
	f := newFakeSubsonic(t)
	f.tokens = false
	c, err := subsonicPing(context.Background(), ssCreds(f.srv.URL))
	if err != nil || !c.Plain {
		t.Fatalf("ping: %+v %v", c, err)
	}
	if f.requests[0].Get("t") == "" || f.requests[1].Get("p") != "enc:"+hex.EncodeToString([]byte(ssPass)) {
		t.Errorf("asked %v then %v", f.requests[0], f.requests[1])
	}
	// A server that takes tokens is kept on tokens.
	f.tokens = true
	if c, err := subsonicPing(context.Background(), ssCreds(f.srv.URL)); err != nil || c.Plain {
		t.Errorf("token server: %+v %v", c, err)
	}
}

func TestSubsonicRefusalsSayWhy(t *testing.T) {
	f := newFakeSubsonic(t)
	bad := ssCreds(f.srv.URL)
	bad.Password = "wrong"
	if _, err := subsonicPing(context.Background(), bad); err == nil || err.Error() != "wrong username or password" {
		t.Errorf("wrong password: %v", err)
	}
	if len(f.requests) != 1 {
		t.Errorf("a wrong password was tried %d times", len(f.requests))
	}
	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>router login</html>"))
	}))
	defer html.Close()
	if _, err := subsonicPing(context.Background(), ssCreds(html.URL)); err == nil || !strings.Contains(err.Error(), "not a Subsonic server") {
		t.Errorf("a web page: %v", err)
	}
	gone := httptest.NewServer(http.NotFoundHandler())
	defer gone.Close()
	if _, err := subsonicPing(context.Background(), ssCreds(gone.URL)); err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Errorf("no API there: %v", err)
	}
	silent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"subsonic-response":{"status":"failed","version":"1.16.1"}}`))
	}))
	defer silent.Close()
	if _, err := subsonicPing(context.Background(), ssCreds(silent.URL)); err == nil || !strings.Contains(err.Error(), "the server refused") {
		t.Errorf("a refusal without a reason: %v", err)
	}
	for code, want := range map[int]string{50: "this user may not do that on the server", 30: "the server says: x"} {
		if got := (&subsonicError{Code: code, Message: "x"}).Error(); got != want {
			t.Errorf("error %d: %q", code, got)
		}
	}
	if got := (&subsonicError{Code: 99}).Error(); got != "the server refused (Subsonic error 99)" {
		t.Errorf("error 99: %q", got)
	}
}

// No error, log line or answer to the app carries the token, the salt or the
// password: the URL a failed request was for is never passed on.
func TestSubsonicErrorsHideTheSignIn(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // nothing listens there now
	cl := newSubsonicClient(ssCreds("http://" + addr))
	cl.salt = func() string { return "SALTSALT" }
	sum := md5.Sum([]byte(ssPass + "SALTSALT"))
	token := hex.EncodeToString(sum[:])
	check := func(what, msg string) {
		t.Helper()
		for _, secret := range []string{token, "SALTSALT", ssPass, "t=", "/rest/"} {
			if strings.Contains(msg, secret) {
				t.Errorf("%s gives away %q: %s", what, secret, msg)
			}
		}
	}
	err = cl.call(context.Background(), "ping", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "cannot be reached") {
		t.Fatalf("unreachable: %v", err)
	}
	check("unreachable", err.Error())

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer slow.Close()
	cl = newSubsonicClient(ssCreds(slow.URL))
	cl.salt = func() string { return "SALTSALT" }
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err = cl.call(ctx, "ping", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "did not answer in time") {
		t.Fatalf("slow: %v", err)
	}
	check("slow", err.Error())

	// The stream proxy's answer to the app, for a server that is gone.
	providersMu.Lock()
	old, had := providers["subsonic"]
	gone := newSubsonicClient(ssCreds("http://" + addr))
	gone.salt = func() string { return "SALTSALT" }
	providers["subsonic"] = &subsonicProvider{cl: gone}
	providersMu.Unlock()
	defer func() {
		providersMu.Lock()
		if had {
			providers["subsonic"] = old
		} else {
			delete(providers, "subsonic")
		}
		providersMu.Unlock()
	}()
	rec := httptest.NewRecorder()
	handleSubsonicStream(rec, httptest.NewRequest("GET", "/subsonicstream?id=s1", nil))
	if rec.Code != http.StatusBadGateway {
		t.Errorf("stream from a gone server: %d", rec.Code)
	}
	check("stream", rec.Body.String())
}

func TestSubsonicStreamURLCarriesNoSignIn(t *testing.T) {
	f := newFakeSubsonic(t)
	p := useSubsonic(t, f)
	u, err := p.StreamURL(context.Background(), "s 1/&x")
	if err != nil || u != "http://127.0.0.1:8730/subsonicstream?id=s+1%2F%26x" {
		t.Errorf("StreamURL = %q, %v", u, err)
	}
	if _, err := p.StreamURL(context.Background(), ""); err == nil {
		t.Error("no id took")
	}
	if len(f.requests) != 0 {
		t.Errorf("StreamURL asked the server")
	}
}

func TestSubsonicStreamProxySeeks(t *testing.T) {
	f := newFakeSubsonic(t)
	useSubsonic(t, f)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/subsonicstream?id=s1", nil)
	req.Header.Set("Range", "bytes=10-14")
	handleSubsonicStream(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "abcde" ||
		rec.Header().Get("Content-Range") != "bytes 10-14/20" || rec.Header().Get("Content-Length") != "5" ||
		rec.Header().Get("Accept-Ranges") != "bytes" {
		t.Errorf("range: %d %q %v", rec.Code, rec.Body.String(), rec.Header())
	}
	if q := f.requests[0]; f.paths[0] != "/rest/stream.view" || q.Get("id") != "s1" || q.Get("t") == "" {
		t.Errorf("asked %s %v", f.paths[0], q)
	}
	rec = httptest.NewRecorder()
	handleSubsonicStream(rec, httptest.NewRequest("GET", "/subsonicstream?id=s1", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != string(f.streamBody) {
		t.Errorf("whole: %d %q", rec.Code, rec.Body.String())
	}
	// A refusal is the server's JSON, not a song: the player gets an error.
	rec = httptest.NewRecorder()
	handleSubsonicStream(rec, httptest.NewRequest("GET", "/subsonicstream?id=nope", nil))
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "not found on the server") {
		t.Errorf("refused: %d %q", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handleSubsonicStream(rec, httptest.NewRequest("GET", "/subsonicstream", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("no id: %d", rec.Code)
	}
}

func TestSubsonicArtProxy(t *testing.T) {
	f := newFakeSubsonic(t)
	useSubsonic(t, f)
	for q, want := range map[string]string{
		"id=al-1":           "jpeg:al-1:300",
		"id=al-1&size=64":   "jpeg:al-1:64",
		"id=al-1&size=9999": "jpeg:al-1:300",
		"id=al-1&size=-3":   "jpeg:al-1:300",
	} {
		rec := httptest.NewRecorder()
		handleSubsonicArt(rec, httptest.NewRequest("GET", "/subsonicart?"+q, nil))
		if rec.Code != http.StatusOK || rec.Body.String() != want || rec.Header().Get("Content-Type") != "image/jpeg" {
			t.Errorf("%s: %d %q", q, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	handleSubsonicArt(rec, httptest.NewRequest("GET", "/subsonicart", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("no id: %d", rec.Code)
	}
}

func TestSubsonicProxyWithoutASignIn(t *testing.T) {
	providersMu.Lock()
	old, had := providers["subsonic"]
	delete(providers, "subsonic")
	providersMu.Unlock()
	defer func() {
		if had {
			providersMu.Lock()
			providers["subsonic"] = old
			providersMu.Unlock()
		}
	}()
	rec := httptest.NewRecorder()
	handleSubsonicStream(rec, httptest.NewRequest("GET", "/subsonicstream?id=s1", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("%d", rec.Code)
	}
}

func subsonicLogin(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	handleSubsonicAuthLogin(rec, httptest.NewRequest("POST", "/subsonicauth/login", strings.NewReader(body)))
	return rec
}

func TestSubsonicLoginKeepsTheSignIn(t *testing.T) {
	f := newFakeSubsonic(t)
	path := useSubsonicAuthPath(t)
	km := useFakeKeymanager(t)
	useSubsonic(t, f) // restores the registry afterwards
	providersMu.Lock()
	delete(providers, "subsonic")
	providersMu.Unlock()

	// Navidrome's own page, pasted, with a path in front (a proxy at /music).
	server := f.srv.URL + "/music/app/#/album/1"
	b, _ := json.Marshal(map[string]string{"server": server, "username": " " + ssUser + " ", "password": ssPass})
	rec := subsonicLogin(t, string(b))
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	var r map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &r)
	host := strings.TrimPrefix(f.srv.URL, "http://")
	if r["ok"] != true || r["username"] != ssUser+"@"+host {
		t.Errorf("answer %v", r)
	}
	if f.paths[0] != "/music/rest/ping.view" {
		t.Errorf("pinged %s", f.paths[0])
	}
	kept, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	c, ok := parseSubsonicCreds(kept)
	if !ok || c != (subsonicCreds{Server: f.srv.URL + "/music", User: ssUser, Password: ssPass}) {
		t.Errorf("kept %+v", c)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm()&0o077 != 0 {
		t.Errorf("sign-in file mode %v", fi.Mode())
	}
	if _, there := km.keys[secretName(path)]; !there {
		t.Errorf("not in the keymanager: %v", km.calls)
	}
	p := currentSubsonic()
	if p == nil || p.cl.creds != c {
		t.Fatalf("not registered: %+v", p)
	}
	if _, err := p.Search(context.Background(), "tone", 5); err != nil {
		t.Errorf("search after login: %v", err)
	}
}

func TestSubsonicLoginRefusals(t *testing.T) {
	f := newFakeSubsonic(t)
	path := useSubsonicAuthPath(t)
	useFakeKeymanager(t)
	for body, want := range map[string]int{
		`not json`: http.StatusBadRequest,
		`{"server":"","username":"alice","password":"x"}`:                      http.StatusBadRequest,
		`{"server":"` + f.srv.URL + `","username":"","password":"x"}`:          http.StatusBadRequest,
		`{"server":"` + f.srv.URL + `","username":"alice","password":""}`:      http.StatusBadRequest,
		`{"server":"` + f.srv.URL + `","username":"alice","password":"a\nb"}`:  http.StatusBadRequest,
		`{"server":"` + f.srv.URL + `","username":"alice","password":"wrong"}`: http.StatusBadGateway,
	} {
		rec := subsonicLogin(t, body)
		if rec.Code != want {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "wrong") && !strings.Contains(rec.Body.String(), "wrong username or password") {
			t.Errorf("%s: %s", body, rec.Body.String())
		}
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("a refused sign-in was kept: %v", err)
	}
}

func TestLoadSubsonicFollowsTheFile(t *testing.T) {
	f := newFakeSubsonic(t)
	path := useSubsonicAuthPath(t)
	useSubsonic(t, f)
	if err := os.WriteFile(path, ssCreds(f.srv.URL).encode(), 0o600); err != nil {
		t.Fatal(err)
	}
	loadSubsonic()
	if p := currentSubsonic(); p == nil || p.cl.creds.Server != f.srv.URL {
		t.Fatalf("not loaded: %+v", p)
	}
	_ = os.WriteFile(path, []byte("garbage"), 0o600)
	loadSubsonic()
	if currentSubsonic() != nil {
		t.Error("a broken file stays registered")
	}
	_ = os.WriteFile(path, ssCreds(f.srv.URL).encode(), 0o600)
	loadSubsonic()
	_ = os.Remove(path)
	loadSubsonic()
	if currentSubsonic() != nil {
		t.Error("no file stays registered")
	}
}

func TestSubsonicIsAKeptSecret(t *testing.T) {
	for _, p := range secretPaths() {
		if p == subsonicAuthPath {
			return
		}
	}
	t.Error("subsonic-auth is not synced with the keymanager")
}

func TestSubsonicThroughTheProviderRoutes(t *testing.T) {
	f := newFakeSubsonic(t)
	useSubsonic(t, f)
	get := func(path string) (int, string) {
		rec := httptest.NewRecorder()
		handleProviderRoute(rec, httptest.NewRequest("GET", path, nil))
		b, _ := io.ReadAll(rec.Body)
		return rec.Code, string(b)
	}
	if code, body := get("/provider/subsonic/search?q=tone&limit=1"); code != 200 || !strings.Contains(body, `"path":"subsonic:s1"`) {
		t.Errorf("search: %d %s", code, body)
	}
	if code, body := get("/provider/subsonic/playlists"); code != 200 || !strings.Contains(body, `"name":"Road Trip"`) {
		t.Errorf("playlists: %d %s", code, body)
	}
	rec := httptest.NewRecorder()
	handleProviderRoute(rec, httptest.NewRequest("POST", "/provider/subsonic/resolve", strings.NewReader(`{"trackId":"s1"}`)))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"url":"http://127.0.0.1:8730/subsonicstream?id=s1"`) {
		t.Errorf("resolve: %d %s", rec.Code, rec.Body.String())
	}
}
