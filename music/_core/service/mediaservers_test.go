package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- Accounts ----------------------------------------------------------------

// fakeAccounts stands in for com.palm.service.accounts: listAccounts gives
// rows, readCredentials the credentials kept for an account id.
type fakeAccounts struct {
	mu    sync.Mutex
	rows  []map[string]interface{}
	creds map[string]interface{} // account id -> {"common": ...} or a refusal
	down  bool
	key   string // where listAccounts puts its rows ("results" unless set)
	calls []string
}

func (f *fakeAccounts) call(uri, payload string) (map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, uri[strings.LastIndexByte(uri, '/')+1:])
	if f.down {
		return nil, errors.New("no bus")
	}
	switch {
	case strings.HasSuffix(uri, "/listAccounts"):
		rows := make([]interface{}, len(f.rows))
		for i, r := range f.rows {
			rows[i] = r
		}
		k := f.key
		if k == "" {
			k = "results"
		}
		return map[string]interface{}{"returnValue": true, k: rows}, nil
	case strings.HasSuffix(uri, "/readCredentials"):
		var p struct{ AccountID, Name string }
		_ = json.Unmarshal([]byte(payload), &p)
		if p.Name != "common" {
			return map[string]interface{}{"returnValue": false}, nil
		}
		c, ok := f.creds[p.AccountID]
		if !ok {
			return map[string]interface{}{"returnValue": false, "errorText": "Permission denied!"}, nil
		}
		// A round trip, so the reply is as fresh as one off the bus.
		b, _ := json.Marshal(c)
		var m map[string]interface{}
		_ = json.Unmarshal(b, &m)
		m["returnValue"] = true
		return m, nil
	}
	return nil, errors.New("unexpected call " + uri)
}

func (f *fakeAccounts) count(what string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == what {
			n++
		}
	}
	return n
}

// useAccounts puts f in place of the Accounts service, with a clock the test
// moves, and a registry without media servers.
func useAccounts(t *testing.T, f *fakeAccounts) *time.Time {
	t.Helper()
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	oldCall, oldNow := accountsCall, mediaNow
	accountsCall = f.call
	mediaNow = func() time.Time { return now }
	clearMedia := func() {
		mediaMu.Lock()
		mediaLoaded = time.Time{}
		mediaCredsOf = map[string]string{}
		mediaMu.Unlock()
		providersMu.Lock()
		for id := range videoTemplatesByID() {
			delete(providers, id)
		}
		providersMu.Unlock()
	}
	clearMedia()
	t.Cleanup(func() {
		accountsCall, mediaNow = oldCall, oldNow
		clearMedia()
	})
	return &now
}

func registered(id string) MusicProvider {
	providersMu.RLock()
	defer providersMu.RUnlock()
	return providers[id]
}

func jfCreds(server string) map[string]interface{} {
	return map[string]interface{}{"common": map[string]interface{}{"accessToken": "tok-jf", "server": server,
		"userId": "u1", "deviceId": "luneos-abc", "serverId": "s", "serverName": "Home", "username": "alice"}}
}

func TestVideoAccountsBringTheirServers(t *testing.T) {
	f := &fakeAccounts{
		rows: []map[string]interface{}{
			{"_id": "a1", "templateId": "org.webosports.video.jellyfin"},
			{"_id": "a2", "templateId": "org.webosports.video.emby"},
			{"_id": "a3", "templateId": "org.webosports.video.plex"},
			{"_id": "a4", "templateId": "org.webosports.video.peertube"},
			{"_id": "a5", "templateId": "com.palm.google"},
		},
		creds: map[string]interface{}{
			"a1": jfCreds("http://jf.example:8096/"),
			// Emby's reply nests them one deeper, as some builds do.
			"a2": map[string]interface{}{"credentials": jfCreds("http://emby.example")},
			"a3": map[string]interface{}{"common": map[string]interface{}{"mode": "direct", "server": "http://plex.example:32400"}},
			"a4": map[string]interface{}{"common": map[string]interface{}{"server": "http://pt.example"}},
		},
	}
	useAccounts(t, f)
	refreshMediaAccounts(false)
	jf, ok := registered("jellyfin").(*mediaBrowserProvider)
	if !ok || jf.creds.Server != "http://jf.example:8096" || jf.creds.AccessToken != "tok-jf" || jf.creds.DeviceID != "luneos-abc" || jf.v.id != "jellyfin" {
		t.Fatalf("jellyfin = %#v", registered("jellyfin"))
	}
	if em, ok := registered("emby").(*mediaBrowserProvider); !ok || em.v.id != "emby" || em.creds.Server != "http://emby.example" {
		t.Fatalf("emby = %#v", registered("emby"))
	}
	if px, ok := registered("plex").(*plexMusicProvider); !ok || px.servers[0].Connections[0].URI != "http://plex.example:32400" {
		t.Fatalf("plex = %#v", registered("plex"))
	}
	if registered("peertube") != nil {
		t.Fatal("a PeerTube account brought a music service")
	}
	if n := f.count("readCredentials"); n != 3 {
		t.Fatalf("credentials read %d times, want 3 (only the media servers')", n)
	}
}

func TestVideoAccountsAreLookedAtNowAndThen(t *testing.T) {
	f := &fakeAccounts{rows: []map[string]interface{}{{"_id": "a1", "templateId": "org.webosports.video.jellyfin"}},
		creds: map[string]interface{}{"a1": jfCreds("http://jf.example")}}
	now := useAccounts(t, f)
	refreshMediaAccounts(false)
	first := registered("jellyfin")
	*now = now.Add(mediaAccountsTTL - time.Second)
	refreshMediaAccounts(false)
	if n := f.count("listAccounts"); n != 1 {
		t.Fatalf("Accounts asked %d times within the TTL", n)
	}
	// Past it: asked again; the same sign-in keeps the provider (and its caches).
	*now = now.Add(2 * time.Second)
	refreshMediaAccounts(false)
	if n := f.count("listAccounts"); n != 2 {
		t.Fatalf("Accounts asked %d times past the TTL", n)
	}
	if registered("jellyfin") != first {
		t.Fatal("an unchanged sign-in made a new provider")
	}
	// Signed in again in Videos: a new token, a new provider - at once when forced.
	f.creds["a1"].(map[string]interface{})["common"].(map[string]interface{})["accessToken"] = "tok-2"
	refreshMediaAccounts(true)
	if jf := registered("jellyfin").(*mediaBrowserProvider); jf.creds.AccessToken != "tok-2" {
		t.Fatalf("token = %q after a new sign-in", jf.creds.AccessToken)
	}
	// A refusal makes the next look go to Accounts again, TTL or not.
	expireMediaAccounts()
	refreshMediaAccounts(false)
	if n := f.count("listAccounts"); n != 4 {
		t.Fatalf("Accounts asked %d times after a refusal, want 4", n)
	}
}

func TestVideoAccountGoneTakesItsServerAway(t *testing.T) {
	f := &fakeAccounts{rows: []map[string]interface{}{{"_id": "a1", "templateId": "org.webosports.video.jellyfin"}},
		creds: map[string]interface{}{"a1": jfCreds("http://jf.example")}}
	useAccounts(t, f)
	refreshMediaAccounts(true)
	if registered("jellyfin") == nil {
		t.Fatal("no jellyfin")
	}
	// Accounts cannot be asked: what is known stands.
	f.down = true
	refreshMediaAccounts(true)
	if registered("jellyfin") == nil {
		t.Fatal("jellyfin dropped while Accounts could not be asked")
	}
	f.down = false
	// Being deleted is gone already.
	f.rows[0]["beingDeleted"] = true
	refreshMediaAccounts(true)
	if registered("jellyfin") != nil {
		t.Fatal("an account being deleted kept its server")
	}
	f.rows[0]["beingDeleted"] = false
	refreshMediaAccounts(true)
	f.rows = nil
	refreshMediaAccounts(true)
	if registered("jellyfin") != nil {
		t.Fatal("a removed account kept its server")
	}
	// And back, and then its sign-in cannot be read (the template lacks this daemon).
	f.rows = []map[string]interface{}{{"_id": "a1", "templateId": "org.webosports.video.jellyfin"}}
	refreshMediaAccounts(true)
	delete(f.creds, "a1")
	refreshMediaAccounts(true)
	if registered("jellyfin") != nil {
		t.Fatal("an unreadable sign-in kept its server")
	}
	// Credentials that reach no server bring none - and take away the one before.
	f.creds["a1"] = jfCreds("http://jf.example")
	refreshMediaAccounts(true)
	if registered("jellyfin") == nil {
		t.Fatal("no jellyfin")
	}
	f.creds["a1"] = map[string]interface{}{"common": map[string]interface{}{"accessToken": "t", "userId": "u", "server": "ftp://x"}}
	refreshMediaAccounts(true)
	if registered("jellyfin") != nil {
		t.Fatal("a server address that is no web address was taken")
	}
}

func TestTheFirstVideoAccountOfAKindIsUsed(t *testing.T) {
	f := &fakeAccounts{key: "accounts", // an older build's key
		rows: []map[string]interface{}{
			{"accountId": "a1", "templateId": "org.webosports.video.jellyfin"},
			{"accountId": "a2", "templateId": "org.webosports.video.jellyfin"},
		},
		creds: map[string]interface{}{"a1": jfCreds("http://one.example"), "a2": jfCreds("http://two.example")}}
	useAccounts(t, f)
	refreshMediaAccounts(true)
	if jf := registered("jellyfin").(*mediaBrowserProvider); jf.creds.Server != "http://one.example" {
		t.Fatalf("server = %q", jf.creds.Server)
	}
	if n := f.count("readCredentials"); n != 1 {
		t.Fatalf("read %d sign-ins for one service", n)
	}
}

func TestMusicAccountsAreFoundUnderResults(t *testing.T) {
	f := &fakeAccounts{rows: []map[string]interface{}{
		{"_id": "m1", "templateId": "org.webosports.app.music.spotify", "username": "bob"},
		{"_id": "m2", "templateId": "org.webosports.app.music.tidal", "beingDeleted": true},
		{"_id": "v1", "templateId": "org.webosports.video.jellyfin"},
	}}
	useAccounts(t, f)
	got := listMusicAccounts()
	if want := []musicAccount{{ID: "m1", TemplateID: "org.webosports.app.music.spotify", Name: "bob"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("listMusicAccounts = %#v", got)
	}
}

func TestProvidersListLooksAtTheVideoAccounts(t *testing.T) {
	f := &fakeAccounts{rows: []map[string]interface{}{{"_id": "a1", "templateId": "org.webosports.video.emby"}},
		creds: map[string]interface{}{"a1": jfCreds("http://emby.example")}}
	useAccounts(t, f)
	rr := httptest.NewRecorder()
	handleProviders(rr, httptest.NewRequest("GET", "/providers", nil))
	var r struct {
		Providers []struct {
			ID     string
			Name   string
			Browse bool
		}
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &r)
	for _, p := range r.Providers {
		if p.ID == "emby" {
			if p.Name != "Emby" || !p.Browse {
				t.Fatalf("emby row = %+v", p)
			}
			return
		}
	}
	t.Fatalf("no emby in %s", rr.Body.String())
}

func TestReadCommonCredentialsShapes(t *testing.T) {
	f := &fakeAccounts{creds: map[string]interface{}{
		"flat":   map[string]interface{}{"server": "x"},
		"common": map[string]interface{}{"common": map[string]interface{}{"server": "y"}},
	}}
	useAccounts(t, f)
	for id, want := range map[string]string{"flat": `{"server":"x"}`, "common": `{"server":"y"}`} {
		got, ok := readCommonCredentials(id)
		if !ok || string(got) != want {
			t.Errorf("%s: %s %v", id, got, ok)
		}
	}
	if _, ok := readCommonCredentials("missing"); ok {
		t.Error("a refusal read as credentials")
	}
	if _, ok := readCommonCredentials(""); ok {
		t.Error("no account id read as credentials")
	}
}

// --- Jellyfin and Emby ----------------------------------------------------------

// fakeMediaBrowser answers as Jellyfin 12.4 or Emby 4.10 did (2026-11-04):
// Jellyfin's items at /Items?userId=, Emby's at /Users/{id}/Items, both
// refusing a request without the token in the Authorization header.
type fakeMediaBrowser struct {
	srv  *httptest.Server
	emby bool
	mu   sync.Mutex
	reqs []*http.Request
	// status, when set, is every answer's.
	status int
}

func newFakeMediaBrowser(t *testing.T, emby bool) *fakeMediaBrowser {
	f := &fakeMediaBrowser{emby: emby}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMediaBrowser) last() *http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[len(f.reqs)-1]
}

var mbSongs = []map[string]interface{}{
	{"Id": "s1", "Type": "Audio", "Name": "Morning", "Album": "First", "AlbumId": "al1", "AlbumPrimaryImageTag": "t-al1",
		"Artists": []string{"Ann", "Bo"}, "AlbumArtist": "Ann", "RunTimeTicks": 400457140, "IndexNumber": 1, "ParentIndexNumber": 2},
	{"Id": "s2", "Type": "Audio", "Name": "Lone", "AlbumArtist": "Cy", "ImageTags": map[string]string{"Primary": "t-s2"},
		"RunTimeTicks": 10000000, "IndexNumber": -1},
	{"Id": "v1", "Type": "MusicVideo", "Name": "A video"},
	{"Id": "bad/id", "Type": "Audio", "Name": "Odd"},
}

func (f *fakeMediaBrowser) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.reqs = append(f.reqs, r)
	f.mu.Unlock()
	if !strings.Contains(r.Header.Get("Authorization"), `Token="tok-jf"`) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if f.status != 0 {
		w.WriteHeader(f.status)
		return
	}
	q := r.URL.Query()
	items := "/Items"
	if f.emby {
		items = "/Users/u1/Items"
	}
	reply := func(v interface{}) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"Items": v})
	}
	switch {
	case r.URL.Path == items:
		if !f.emby && q.Get("userId") != "u1" || f.emby && q.Has("userId") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch q.Get("IncludeItemTypes") {
		case "Audio":
			reply(mbSongs)
		case "MusicAlbum":
			reply([]map[string]interface{}{
				{"Id": "al1", "Type": "MusicAlbum", "Name": "First", "AlbumArtist": "Ann", "ProductionYear": 2024, "ChildCount": 2,
					"ImageTags": map[string]string{"Primary": "t-al1"}, "AlbumArtists": []map[string]string{{"Id": "ar1", "Name": "Ann"}}},
				{"Id": "al2", "Type": "MusicAlbum", "Name": "Nobody's", "AlbumArtists": []map[string]string{{"Id": "ar2", "Name": "Dee"}}},
				{"Id": "s1", "Type": "Audio", "Name": "not an album"},
			})
		case "Playlist":
			reply([]map[string]interface{}{
				{"Id": "p1", "Type": "Playlist", "Name": "Mix", "MediaType": "Audio", "ChildCount": 3},
				{"Id": "p2", "Type": "Playlist", "Name": "Films", "MediaType": "Video"},
				{"Id": "p3", "Type": "Playlist", "Name": "Untyped"},
			})
		default:
			reply([]interface{}{})
		}
	case r.URL.Path == "/Artists/AlbumArtists":
		reply([]map[string]interface{}{{"Id": "ar1", "Name": "Ann", "AlbumCount": 3, "ImageTags": map[string]string{"Primary": "t-ar1"}},
			{"Id": "ar2", "Name": "Dee", "ChildCount": 1}, {"Id": "../x", "Name": "Odd"}})
	case r.URL.Path == "/Playlists/p1/Items":
		reply(mbSongs[:1])
	case r.URL.Path == "/Audio/s1/stream":
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Accept-Ranges", "bytes")
		if r.Header.Get("Range") == "bytes=2-" {
			w.Header().Set("Content-Range", "bytes 2-9/10")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, "23456789")
			return
		}
		_, _ = io.WriteString(w, "0123456789")
	case r.URL.Path == "/Items/al1/Images/Primary":
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = io.WriteString(w, "JPEG")
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func useMediaBrowser(t *testing.T, f *fakeMediaBrowser) *mediaBrowserProvider {
	t.Helper()
	useAccounts(t, &fakeAccounts{})
	v := jellyfinMusic
	if f.emby {
		v = embyMusic
	}
	raw, _ := json.Marshal(jfCreds(f.srv.URL + "/")["common"])
	p, _ := newMediaBrowserProvider(v, raw).(*mediaBrowserProvider)
	if p == nil {
		t.Fatal("no provider")
	}
	registerProvider(p)
	return p
}

func TestMediaBrowserCredentials(t *testing.T) {
	for _, c := range []string{
		`{"server":"http://x","userId":"u"}`,
		`{"server":"http://x","accessToken":"t"}`,
		`{"server":"","accessToken":"t","userId":"u"}`,
		`{"server":"file:///etc","accessToken":"t","userId":"u"}`,
		`{"server":"http://a:b@x","accessToken":"t","userId":"u"}`,
		`not json`,
	} {
		if newMediaBrowserProvider(jellyfinMusic, json.RawMessage(c)) != nil {
			t.Errorf("%s made a provider", c)
		}
	}
	p := newMediaBrowserProvider(jellyfinMusic, json.RawMessage(`{"server":"https://x/jf//","accessToken":"t","userId":"u"}`)).(*mediaBrowserProvider)
	if p.creds.Server != "https://x/jf" || p.creds.DeviceID == "" {
		t.Fatalf("creds = %+v", p.creds)
	}
}

func TestMediaBrowserSearch(t *testing.T) {
	for _, emby := range []bool{false, true} {
		f := newFakeMediaBrowser(t, emby)
		p := useMediaBrowser(t, f)
		got, err := p.Search(context.Background(), "  morn ", 20)
		if err != nil {
			t.Fatal(err)
		}
		q := f.last().URL.Query()
		if q.Get("searchTerm") != "morn" || q.Get("IncludeItemTypes") != "Audio" || q.Get("Recursive") != "true" || q.Get("Limit") != "20" {
			t.Fatalf("emby=%v query %v", emby, q)
		}
		auth := f.last().Header.Get("Authorization")
		if !strings.HasPrefix(auth, `MediaBrowser Client="LuneOS Videos"`) || !strings.Contains(auth, `DeviceId="luneos-abc"`) {
			t.Fatalf("Authorization = %q", auth)
		}
		id := p.v.id
		want := []providerTrack{
			{ID: "s1", Provider: id, Title: "Morning", Artist: "Ann, Bo", Album: "First", DurationMs: 40045, Track: 1, Disc: 2,
				Thumbnail: mediaLocalBase + "/mediaart?p=" + id + "&id=al1&tag=t-al1", Path: id + ":s1"},
			{ID: "s2", Provider: id, Title: "Lone", Artist: "Cy", DurationMs: 1000,
				Thumbnail: mediaLocalBase + "/mediaart?p=" + id + "&id=s2&tag=t-s2", Path: id + ":s2"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("emby=%v\n got %+v\nwant %+v", emby, got, want)
		}
		if got, _ := p.Search(context.Background(), "x", 1); len(got) != 1 {
			t.Fatalf("limit 1 gave %d", len(got))
		}
		n := len(f.reqs)
		if got, err := p.Search(context.Background(), " ", 5); err != nil || len(got) != 0 || len(f.reqs) != n {
			t.Fatal("an empty search went to the server")
		}
		_, _ = p.Search(context.Background(), "x", 0)
		if l := f.last().URL.Query().Get("Limit"); l != "50" {
			t.Fatalf("no limit asked %s", l)
		}
		_, _ = p.Search(context.Background(), "x", 201)
		if l := f.last().URL.Query().Get("Limit"); l != "50" {
			t.Fatalf("a huge limit asked %s", l)
		}
	}
}

func TestMediaBrowserBrowses(t *testing.T) {
	for _, emby := range []bool{false, true} {
		f := newFakeMediaBrowser(t, emby)
		p := useMediaBrowser(t, f)
		ctx := context.Background()
		ar, err := p.Artists(ctx)
		if err != nil {
			t.Fatal(err)
		}
		user := "userId"
		if emby {
			user = "UserId"
		}
		if q := f.last().URL.Query(); q.Get(user) != "u1" || q.Get("SortBy") != "SortName" {
			t.Fatalf("artists query %v", q)
		}
		wantAr := []providerArtist{
			{ID: "ar1", Provider: p.v.id, Name: "Ann", Albums: 3, Thumbnail: mediaLocalBase + "/mediaart?p=" + p.v.id + "&id=ar1&tag=t-ar1"},
			{ID: "ar2", Provider: p.v.id, Name: "Dee", Albums: 1},
		}
		if !reflect.DeepEqual(ar, wantAr) {
			t.Fatalf("artists %+v", ar)
		}
		al, err := p.ArtistAlbums(ctx, "ar1")
		if err != nil {
			t.Fatal(err)
		}
		if q := f.last().URL.Query(); q.Get("AlbumArtistIds") != "ar1" || q.Get("Recursive") != "true" {
			t.Fatalf("artist albums query %v", q)
		}
		wantAl := []providerAlbum{
			{ID: "al1", Provider: p.v.id, Name: "First", Artist: "Ann", ArtistID: "ar1", Year: 2024, Tracks: 2,
				Thumbnail: mediaLocalBase + "/mediaart?p=" + p.v.id + "&id=al1&tag=t-al1"},
			{ID: "al2", Provider: p.v.id, Name: "Nobody's", Artist: "Dee", ArtistID: "ar2"},
		}
		if !reflect.DeepEqual(al, wantAl) {
			t.Fatalf("albums %+v", al)
		}
		tr, err := p.AlbumTracks(ctx, "al1")
		if err != nil || len(tr) != 2 {
			t.Fatalf("album tracks %v %v", tr, err)
		}
		if q := f.last().URL.Query(); q.Get("ParentId") != "al1" || q.Get("IncludeItemTypes") != "Audio" || !strings.HasPrefix(q.Get("SortBy"), "ParentIndexNumber,IndexNumber") {
			t.Fatalf("album query %v", q)
		}
		for _, bad := range []string{"", "../x", "a/b"} {
			if _, err := p.ArtistAlbums(ctx, bad); err == nil {
				t.Errorf("artist %q asked", bad)
			}
			if _, err := p.AlbumTracks(ctx, bad); err == nil {
				t.Errorf("album %q asked", bad)
			}
			if _, err := p.PlaylistTracks(ctx, bad); err == nil {
				t.Errorf("playlist %q asked", bad)
			}
			if _, err := p.StreamURL(ctx, bad); err == nil {
				t.Errorf("stream %q given", bad)
			}
		}
	}
}

func TestMediaBrowserAlbumLists(t *testing.T) {
	f := newFakeMediaBrowser(t, false)
	p := useMediaBrowser(t, f)
	for list, want := range map[string][3]string{
		"newest":       {"DateCreated,SortName", "Descending", ""},
		"recent":       {"DatePlayed,SortName", "Descending", "IsPlayed"},
		"frequent":     {"PlayCount,SortName", "Descending", "IsPlayed"},
		"random":       {"Random", "Ascending", ""},
		"alphabetical": {"SortName", "Ascending", ""},
	} {
		if _, err := p.Albums(context.Background(), list); err != nil {
			t.Fatal(list, err)
		}
		q := f.last().URL.Query()
		if q.Get("SortBy") != want[0] || q.Get("SortOrder") != want[1] || q.Get("Filters") != want[2] ||
			q.Get("Limit") != fmt.Sprint(albumListSize) || q.Get("IncludeItemTypes") != "MusicAlbum" {
			t.Errorf("%s: %v", list, q)
		}
	}
	if _, err := p.Albums(context.Background(), "best"); err == nil {
		t.Fatal("an unknown list was asked")
	}
}

func TestMediaBrowserPlaylists(t *testing.T) {
	f := newFakeMediaBrowser(t, true)
	p := useMediaBrowser(t, f)
	pl, err := p.Playlists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if names := []string{}; len(pl) != 2 || pl[0].Name != "Mix" || pl[0].Tracks != 3 || pl[1].Name != "Untyped" {
		for _, l := range pl {
			names = append(names, l.Name)
		}
		t.Fatalf("playlists %v (films are Videos')", names)
	}
	tr, err := p.PlaylistTracks(context.Background(), "p1")
	if err != nil || len(tr) != 1 || tr[0].ID != "s1" {
		t.Fatalf("playlist tracks %v %v", tr, err)
	}
	if f.last().URL.Query().Get("userId") != "u1" {
		t.Fatal("playlist items asked without the user")
	}
}

func TestMediaBrowserRefusals(t *testing.T) {
	f := newFakeMediaBrowser(t, false)
	p := useMediaBrowser(t, f)
	for status, want := range map[int]string{
		http.StatusUnauthorized: "sign in to the server again in Videos",
		http.StatusForbidden:    "sign in to the server again in Videos",
		http.StatusNotFound:     "not found",
		http.StatusBadGateway:   "HTTP 502",
	} {
		f.status = status
		mediaMu.Lock()
		mediaLoaded = time.Now()
		mediaMu.Unlock()
		_, err := p.Search(context.Background(), "x", 5)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%d: %v", status, err)
		}
		mediaMu.Lock()
		expired := mediaLoaded.IsZero()
		mediaMu.Unlock()
		if expired != (status == 401 || status == 403) {
			t.Errorf("%d: accounts expired = %v", status, expired)
		}
	}
	// Not JSON at all.
	f.status = 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "<html>") }))
	defer srv.Close()
	p.creds.Server = srv.URL
	if _, err := p.Search(context.Background(), "x", 5); err == nil || !strings.Contains(err.Error(), "unreadable") {
		t.Fatalf("html: %v", err)
	}
	// Down: the error names no address and no token.
	srv.Close()
	_, err := p.Search(context.Background(), "x", 5)
	if err == nil || strings.Contains(err.Error(), srv.URL) || strings.Contains(err.Error(), "tok-jf") || !strings.Contains(err.Error(), "cannot be reached") {
		t.Fatalf("down: %v", err)
	}
}

func TestMediaBrowserStreamProxy(t *testing.T) {
	f := newFakeMediaBrowser(t, false)
	p := useMediaBrowser(t, f)
	u, err := p.StreamURL(context.Background(), "s1")
	if err != nil || u != mediaLocalBase+"/mediastream?p=jellyfin&id=s1" {
		t.Fatalf("StreamURL = %q %v", u, err)
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/mediastream?p=jellyfin&id=s1", nil)
	req.Header.Set("Range", "bytes=2-")
	handleMediaStream(rr, req)
	if rr.Code != http.StatusPartialContent || rr.Body.String() != "23456789" || rr.Header().Get("Content-Range") != "bytes 2-9/10" ||
		rr.Header().Get("Content-Type") != "audio/mpeg" || rr.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("stream %d %q %v", rr.Code, rr.Body.String(), rr.Header())
	}
	sent := f.last()
	if sent.URL.Query().Get("static") != "true" || strings.Contains(sent.URL.RawQuery, "tok-jf") {
		t.Fatalf("server asked %s", sent.URL)
	}
	rr = httptest.NewRecorder()
	handleMediaArt(rr, httptest.NewRequest("GET", "/mediaart?p=jellyfin&id=al1&tag=t-al1&size=120", nil))
	if rr.Code != 200 || rr.Body.String() != "JPEG" {
		t.Fatalf("art %d %q", rr.Code, rr.Body.String())
	}
	if q := f.last().URL.Query(); q.Get("maxHeight") != "120" || q.Get("tag") != "t-al1" {
		t.Fatalf("art query %v", q)
	}
	handleMediaArt(httptest.NewRecorder(), httptest.NewRequest("GET", "/mediaart?p=jellyfin&id=al1&size=99999", nil))
	if q := f.last().URL.Query(); q.Get("maxHeight") != "300" || q.Has("tag") {
		t.Fatalf("art default query %v", q)
	}
	for path, code := range map[string]int{
		"/mediastream?p=jellyfin&id=../x":  http.StatusBadRequest,
		"/mediastream?p=spotify&id=s1":     http.StatusBadRequest,
		"/mediastream?p=emby&id=s1":        http.StatusServiceUnavailable,
		"/mediastream?p=jellyfin&id=nope1": http.StatusBadGateway,
		"/mediaart?p=jellyfin&id=":         http.StatusBadRequest,
	} {
		rr := httptest.NewRecorder()
		if strings.HasPrefix(path, "/mediaart") {
			handleMediaArt(rr, httptest.NewRequest("GET", path, nil))
		} else {
			handleMediaStream(rr, httptest.NewRequest("GET", path, nil))
		}
		if rr.Code != code {
			t.Errorf("%s: %d, want %d", path, rr.Code, code)
		}
	}
	// The server refusing the stream says so, and has the accounts read again.
	f.status = http.StatusUnauthorized
	rr = httptest.NewRecorder()
	handleMediaStream(rr, httptest.NewRequest("GET", "/mediastream?p=jellyfin&id=s1", nil))
	if rr.Code != http.StatusBadGateway || !strings.Contains(rr.Body.String(), "again in Videos") {
		t.Fatalf("refused stream %d %q", rr.Code, rr.Body.String())
	}
	// Down: neither the token nor the request's URL in what the app is told.
	f.srv.Close()
	rr = httptest.NewRecorder()
	handleMediaStream(rr, httptest.NewRequest("GET", "/mediastream?p=jellyfin&id=s1", nil))
	if body := rr.Body.String(); rr.Code != http.StatusBadGateway || strings.Contains(body, "tok-jf") || strings.Contains(body, "/Audio/") ||
		!strings.Contains(body, "cannot be reached") {
		t.Fatalf("down stream %d %q", rr.Code, rr.Body.String())
	}
}

// --- Plex ----------------------------------------------------------------------

// fakePlex answers as Plex Media Server 1.43.5 did (2026-11-04), refusing a
// request without the token in X-Plex-Token.
type fakePlex struct {
	srv   *httptest.Server
	token string
	// manyAlbums pads the album lists; identity, when set, is /identity's status.
	manyAlbums, identity int
	mu                   sync.Mutex
	reqs                 []*http.Request
}

func newFakePlex(t *testing.T, token string) *fakePlex {
	f := &fakePlex{token: token}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakePlex) last() *http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[len(f.reqs)-1]
}

func (f *fakePlex) paths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []string{}
	for _, r := range f.reqs {
		out = append(out, r.URL.Path)
	}
	return out
}

var plexTracks = []map[string]interface{}{
	{"ratingKey": "16", "type": "track", "title": "Night", "parentTitle": "Second", "grandparentTitle": "Band",
		"parentRatingKey": "15", "index": 1, "parentIndex": 1, "duration": 30041, "parentThumb": "/library/metadata/15/thumb/17",
		"Media": []map[string]interface{}{{"Part": []map[string]string{{"key": "/library/parts/9/17/file.mp3"}}}}},
	{"ratingKey": "17", "type": "track", "title": "Guest", "originalTitle": "Guest Star", "grandparentTitle": "Band",
		"parentTitle": "Second", "thumb": "/library/metadata/17/thumb/1", "duration": 1000, "index": -2},
	{"ratingKey": "x", "type": "track", "title": "Odd"},
	{"ratingKey": "18", "type": "episode", "title": "An episode"},
}

func (f *fakePlex) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.reqs = append(f.reqs, r)
	f.mu.Unlock()
	if r.Header.Get("X-Plex-Token") != f.token {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	mc := func(v map[string]interface{}) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"MediaContainer": v})
	}
	q := r.URL.Query()
	switch r.URL.Path {
	case "/identity":
		if f.identity != 0 {
			w.WriteHeader(f.identity)
			return
		}
		mc(map[string]interface{}{"machineIdentifier": "abc"})
	case "/library/sections":
		mc(map[string]interface{}{"Directory": []map[string]string{{"key": "1", "type": "movie"}, {"key": "3", "type": "artist"}, {"key": "x", "type": "artist"}}})
	case "/library/sections/3/all":
		switch q.Get("type") {
		case "8":
			mc(map[string]interface{}{"Metadata": []map[string]interface{}{
				{"ratingKey": "14", "type": "artist", "title": "Band", "thumb": "/library/metadata/14/thumb/9", "childCount": 2},
				{"ratingKey": "10", "type": "artist", "title": "Solo"}}})
		case "9":
			if f.manyAlbums > 0 {
				many := []map[string]interface{}{}
				for i := 0; i < f.manyAlbums; i++ {
					many = append(many, map[string]interface{}{"ratingKey": fmt.Sprint(100 + i), "type": "album", "title": "A"})
				}
				mc(map[string]interface{}{"Metadata": many})
				return
			}
			mc(map[string]interface{}{"Metadata": []map[string]interface{}{
				{"ratingKey": "15", "type": "album", "title": "Second", "parentTitle": "Band", "parentRatingKey": "14", "year": 2024,
					"thumb": "/library/metadata/15/thumb/17", "leafCount": 2},
				{"ratingKey": "11", "type": "album", "title": "First", "parentTitle": "Solo", "thumb": "http://elsewhere/x.jpg"}}})
		}
	case "/library/metadata/14/children":
		mc(map[string]interface{}{"Metadata": []map[string]interface{}{{"ratingKey": "15", "type": "album", "title": "Second", "parentTitle": "Band", "parentRatingKey": "14"}}})
	case "/library/metadata/15/children", "/playlists/20/items":
		mc(map[string]interface{}{"Metadata": plexTracks})
	case "/library/metadata/17":
		mc(map[string]interface{}{"Metadata": []map[string]interface{}{{"ratingKey": "17", "type": "track",
			"Media": []map[string]interface{}{{"Part": []map[string]string{{"key": "/library/parts/10/18/file.flac"}}}}}}})
	case "/library/metadata/19":
		mc(map[string]interface{}{"Metadata": []map[string]interface{}{{"ratingKey": "19", "type": "track",
			"Media": []map[string]interface{}{{"Part": []map[string]string{{"key": "http://elsewhere/file"}}}}}}})
	case "/hubs/search":
		mc(map[string]interface{}{"Hub": []map[string]interface{}{
			{"type": "movie", "Metadata": []map[string]interface{}{{"ratingKey": "1", "type": "movie", "title": "Film"}}},
			{"type": "track", "Metadata": plexTracks}}})
	case "/playlists":
		mc(map[string]interface{}{"Metadata": []map[string]interface{}{
			{"ratingKey": "20", "type": "playlist", "playlistType": "audio", "title": "Mix", "leafCount": 3},
			{"ratingKey": "21", "type": "playlist", "playlistType": "video", "title": "Films"}}})
	case "/library/parts/9/17/file.mp3", "/library/parts/10/18/file.flac":
		w.Header().Set("Content-Type", "audio/mpeg")
		if r.Header.Get("Range") != "" {
			w.Header().Set("Content-Range", "bytes 0-3/4")
			w.WriteHeader(http.StatusPartialContent)
		}
		_, _ = io.WriteString(w, "MP3!")
	case "/photo/:/transcode":
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = io.WriteString(w, "JPEG")
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func usePlex(t *testing.T, creds string) *plexMusicProvider {
	t.Helper()
	useAccounts(t, &fakeAccounts{})
	p, _ := newPlexMusicProvider(json.RawMessage(creds)).(*plexMusicProvider)
	if p == nil {
		t.Fatalf("no provider from %s", creds)
	}
	registerProvider(p)
	return p
}

func TestPlexCredentials(t *testing.T) {
	for _, c := range []string{`{"mode":"direct","server":"ftp://x"}`, `{"mode":"plextv","servers":[]}`,
		`{"servers":[{"id":"a|b","connections":[{"uri":"http://x"}]}]}`, `{"servers":[{"id":"d","connections":[{"uri":"http://x"}]}]}`,
		`{"servers":[{"id":"ab","connections":[{"uri":"file:///x"}]}]}`, `[`} {
		if newPlexMusicProvider(json.RawMessage(c)) != nil {
			t.Errorf("%s made a provider", c)
		}
	}
	p := newPlexMusicProvider(json.RawMessage(`{"mode":"plextv","accessToken":"acct","clientId":"cid","servers":[
		{"id":"one","accessToken":"own","connections":[{"uri":"https://relay/","relay":true},{"uri":"https://public"},{"uri":"http://lan/","local":true}]},
		{"id":"two","connections":[{"uri":"http://shared"}]}]}`)).(*plexMusicProvider)
	var got []string
	for _, c := range p.servers[0].Connections {
		got = append(got, c.URI)
	}
	if !reflect.DeepEqual(got, []string{"http://lan", "https://public", "https://relay"}) {
		t.Fatalf("order %v", got)
	}
	if p.servers[0].AccessToken != "own" || p.servers[1].AccessToken != "acct" || p.clientID != "cid" {
		t.Fatalf("tokens %+v", p.servers)
	}
	d := newPlexMusicProvider(json.RawMessage(`{"mode":"direct","server":"http://nas:32400/"}`)).(*plexMusicProvider)
	if d.servers[0].ID != "d" || d.servers[0].Connections[0].URI != "http://nas:32400" || d.clientID == "" {
		t.Fatalf("direct %+v", d)
	}
}

func TestPlexSearchAndTracks(t *testing.T) {
	f := newFakePlex(t, "own")
	p := usePlex(t, `{"mode":"direct","server":"`+f.srv.URL+`","accessToken":"own","clientId":"cid"}`)
	got, err := p.Search(context.Background(), " night ", 10)
	if err != nil {
		t.Fatal(err)
	}
	r := f.last()
	if r.URL.Query().Get("query") != "night" || r.URL.Query().Get("limit") != "10" || strings.Contains(r.URL.RawQuery, "own") ||
		r.Header.Get("X-Plex-Client-Identifier") != "cid" || r.Header.Get("X-Plex-Product") != "LuneOS Videos" {
		t.Fatalf("asked %s %v", r.URL, r.Header)
	}
	want := []providerTrack{
		{ID: "d.16", Provider: "plex", Title: "Night", Artist: "Band", Album: "Second", DurationMs: 30041, Track: 1, Disc: 1,
			Thumbnail: mediaLocalBase + "/mediaart?p=plex&s=d&path=%2Flibrary%2Fmetadata%2F15%2Fthumb%2F17", Path: "plex:d.16"},
		{ID: "d.17", Provider: "plex", Title: "Guest", Artist: "Guest Star", Album: "Second", DurationMs: 1000,
			Thumbnail: mediaLocalBase + "/mediaart?p=plex&s=d&path=%2Flibrary%2Fmetadata%2F17%2Fthumb%2F1", Path: "plex:d.17"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("\n got %+v\nwant %+v", got, want)
	}
	if got, _ := p.Search(context.Background(), "x", 1); len(got) != 1 {
		t.Fatalf("limit 1: %d", len(got))
	}
	n := len(f.paths())
	if got, _ := p.Search(context.Background(), "", 5); len(got) != 0 || len(f.paths()) != n {
		t.Fatal("an empty search went to the server")
	}
	if u, err := p.StreamURL(context.Background(), "d.16"); err != nil || u != mediaLocalBase+"/mediastream?p=plex&id=d.16" {
		t.Fatalf("StreamURL %q %v", u, err)
	}
	for _, bad := range []string{"16", "d.", ".16", "e.16", "d.x", "d.1/2"} {
		if _, err := p.StreamURL(context.Background(), bad); err == nil {
			t.Errorf("%q streamed", bad)
		}
	}
}

func TestPlexBrowses(t *testing.T) {
	f := newFakePlex(t, "own")
	p := usePlex(t, `{"mode":"direct","server":"`+f.srv.URL+`","accessToken":"own"}`)
	ctx := context.Background()
	ar, err := p.Artists(ctx)
	if err != nil {
		t.Fatal(err)
	}
	wantAr := []providerArtist{
		{ID: "d.14", Provider: "plex", Name: "Band", Albums: 2, Thumbnail: mediaLocalBase + "/mediaart?p=plex&s=d&path=%2Flibrary%2Fmetadata%2F14%2Fthumb%2F9"},
		{ID: "d.10", Provider: "plex", Name: "Solo"},
	}
	if !reflect.DeepEqual(ar, wantAr) {
		t.Fatalf("artists %+v", ar)
	}
	if q := f.last().URL.Query(); q.Get("type") != "8" {
		t.Fatalf("artists asked %v", q)
	}
	// The sections are kept: a second look asks for the artists alone.
	n := len(f.paths())
	_, _ = p.Artists(ctx)
	if got := f.paths()[n:]; !reflect.DeepEqual(got, []string{"/library/sections/3/all"}) {
		t.Fatalf("second look asked %v", got)
	}
	al, err := p.ArtistAlbums(ctx, "d.14")
	if err != nil || len(al) != 1 || al[0].ID != "d.15" || al[0].ArtistID != "d.14" || al[0].Artist != "Band" {
		t.Fatalf("artist albums %+v %v", al, err)
	}
	tr, err := p.AlbumTracks(ctx, "d.15")
	if err != nil || len(tr) != 2 || tr[0].ID != "d.16" {
		t.Fatalf("album tracks %+v %v", tr, err)
	}
	for _, bad := range []string{"14", "z.14"} {
		if _, err := p.ArtistAlbums(ctx, bad); err == nil {
			t.Errorf("artist %q asked", bad)
		}
		if _, err := p.AlbumTracks(ctx, bad); err == nil {
			t.Errorf("album %q asked", bad)
		}
		if _, err := p.PlaylistTracks(ctx, bad); err == nil {
			t.Errorf("playlist %q asked", bad)
		}
	}
	for list, want := range map[string][2]string{"newest": {"addedAt:desc", ""}, "recent": {"lastViewedAt:desc", "lastViewedAt>"},
		"frequent": {"viewCount:desc", "viewCount>"}, "random": {"random", ""}, "alphabetical": {"titleSort", ""}} {
		got, err := p.Albums(ctx, list)
		if err != nil {
			t.Fatal(list, err)
		}
		q := f.last().URL.Query()
		if q.Get("type") != "9" || q.Get("sort") != want[0] || q.Get("X-Plex-Container-Size") != fmt.Sprint(albumListSize) {
			t.Errorf("%s asked %v", list, q)
		}
		if want[1] != "" && q.Get(want[1]) != "0" {
			t.Errorf("%s without %s: %v", list, want[1], q)
		}
		for _, other := range []string{"lastViewedAt>", "viewCount>"} {
			if other != want[1] && q.Has(other) {
				t.Errorf("%s with %s", list, other)
			}
		}
		// The album with a picture from elsewhere has no cover.
		if len(got) != 2 || got[0].Thumbnail == "" || got[1].Thumbnail != "" || got[0].Tracks != 2 || got[0].Year != 2024 || got[1].ArtistID != "" {
			t.Errorf("%s: %+v", list, got)
		}
	}
	if _, err := p.Albums(ctx, "best"); err == nil {
		t.Fatal("an unknown list was asked")
	}
	pl, err := p.Playlists(ctx)
	if err != nil || len(pl) != 1 || pl[0].ID != "d.20" || pl[0].Tracks != 3 || pl[0].Name != "Mix" {
		t.Fatalf("playlists %+v %v", pl, err)
	}
	if f.last().URL.Query().Get("playlistType") != "audio" {
		t.Fatal("playlists asked without the type")
	}
	if tr, err := p.PlaylistTracks(ctx, "d.20"); err != nil || len(tr) != 2 {
		t.Fatalf("playlist tracks %+v %v", tr, err)
	}
}

func TestPlexAlbumListIsBounded(t *testing.T) {
	// Two servers with the same library: one list, no longer than one server's.
	f := newFakePlex(t, "own")
	p := usePlex(t, `{"servers":[{"id":"a","accessToken":"own","connections":[{"uri":"`+f.srv.URL+`"}]},
		{"id":"b","accessToken":"own","connections":[{"uri":"`+f.srv.URL+`"}]}]}`)
	got, err := p.Albums(context.Background(), "newest")
	if err != nil || len(got) != 4 || got[0].ID != "a.15" || got[2].ID != "b.15" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestPlexLimitsHoldAcrossServers(t *testing.T) {
	f := newFakePlex(t, "own")
	p := usePlex(t, `{"servers":[{"id":"a","accessToken":"own","connections":[{"uri":"`+f.srv.URL+`"}]},
		{"id":"b","accessToken":"own","connections":[{"uri":"`+f.srv.URL+`"}]}]}`)
	if got, err := p.Search(context.Background(), "x", 3); err != nil || len(got) != 3 || got[2].ID != "b.16" {
		t.Fatalf("search over two servers: %+v %v", got, err)
	}
	if got, _ := p.Search(context.Background(), "x", 2); len(got) != 2 || got[1].ID != "a.17" {
		t.Fatalf("search filled by the first server: %+v", got)
	}
	f.manyAlbums = albumListSize - 10
	if got, err := p.Albums(context.Background(), "newest"); err != nil || len(got) != albumListSize || got[0].ID != "a.100" {
		t.Fatalf("album list over two servers: %d %v", len(got), err)
	}
}

func TestPlexAddressAnsweringAnErrorIsPassedOver(t *testing.T) {
	good := newFakePlex(t, "own")
	bad := newFakePlex(t, "own")
	bad.identity = http.StatusServiceUnavailable
	p := usePlex(t, `{"servers":[{"id":"one","accessToken":"own","connections":[{"uri":"`+bad.srv.URL+`","local":true},{"uri":"`+good.srv.URL+`"}]}]}`)
	if _, err := p.Search(context.Background(), "x", 5); err != nil {
		t.Fatal(err)
	}
	if got := bad.paths(); !reflect.DeepEqual(got, []string{"/identity"}) {
		t.Fatalf("the failing address was asked %v", got)
	}
}

func TestPlexStreamProxy(t *testing.T) {
	f := newFakePlex(t, "own")
	p := usePlex(t, `{"mode":"direct","server":"`+f.srv.URL+`","accessToken":"own"}`)
	// A track seen in a listing has its file kept: no lookup.
	if _, err := p.Search(context.Background(), "x", 10); err != nil {
		t.Fatal(err)
	}
	n := len(f.paths())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/mediastream?p=plex&id=d.16", nil)
	req.Header.Set("Range", "bytes=0-")
	handleMediaStream(rr, req)
	if rr.Code != http.StatusPartialContent || rr.Body.String() != "MP3!" || rr.Header().Get("Content-Range") != "bytes 0-3/4" {
		t.Fatalf("stream %d %q", rr.Code, rr.Body.String())
	}
	if got := f.paths()[n:]; !reflect.DeepEqual(got, []string{"/library/parts/9/17/file.mp3"}) {
		t.Fatalf("asked %v", got)
	}
	if sent := f.last(); sent.Header.Get("X-Plex-Token") != "own" || strings.Contains(sent.URL.RawQuery, "own") {
		t.Fatal("the token was not sent as a header")
	}
	// One not seen: looked up first.
	p.mu.Lock()
	p.parts = map[string]string{}
	p.mu.Unlock()
	n = len(f.paths())
	rr = httptest.NewRecorder()
	handleMediaStream(rr, httptest.NewRequest("GET", "/mediastream?p=plex&id=d.17", nil))
	if rr.Code != 200 || !reflect.DeepEqual(f.paths()[n:], []string{"/library/metadata/17", "/library/parts/10/18/file.flac"}) {
		t.Fatalf("lookup %d %v", rr.Code, f.paths()[n:])
	}
	// A part key that is not a file on the server is not fetched.
	rr = httptest.NewRecorder()
	handleMediaStream(rr, httptest.NewRequest("GET", "/mediastream?p=plex&id=d.19", nil))
	if rr.Code != http.StatusBadGateway || !strings.Contains(rr.Body.String(), "no file") {
		t.Fatalf("odd part %d %q", rr.Code, rr.Body.String())
	}
	rr = httptest.NewRecorder()
	handleMediaStream(rr, httptest.NewRequest("GET", "/mediastream?p=plex&id=d.404", nil))
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("missing track %d", rr.Code)
	}
	// Covers: only the server's own pictures.
	rr = httptest.NewRecorder()
	handleMediaArt(rr, httptest.NewRequest("GET", "/mediaart?p=plex&s=d&path=%2Flibrary%2Fmetadata%2F15%2Fthumb%2F17&size=64", nil))
	if rr.Code != 200 || rr.Body.String() != "JPEG" {
		t.Fatalf("art %d", rr.Code)
	}
	if q := f.last().URL.Query(); q.Get("url") != "/library/metadata/15/thumb/17" || q.Get("width") != "64" || q.Get("height") != "64" {
		t.Fatalf("art asked %v", q)
	}
	for _, path := range []string{"/mediaart?p=plex&s=d&path=http%3A%2F%2Fevil%2Fx", "/mediaart?p=plex&s=zz&path=%2Flibrary%2Fmetadata%2F15%2Fthumb",
		"/mediaart?p=plex&s=d&path=%2Flibrary%2Fmetadata%2F15%2Fthumb%2F..%2F..%2Fx"} {
		rr = httptest.NewRecorder()
		handleMediaArt(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", path, rr.Code)
		}
	}
}

func TestPlexPicksAnAddressThatAnswers(t *testing.T) {
	f := newFakePlex(t, "own")
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close()
	p := usePlex(t, `{"servers":[{"id":"one","accessToken":"own","connections":[{"uri":"`+f.srv.URL+`"},{"uri":"`+deadURL+`","local":true}]}]}`)
	now := mediaNow()
	mediaNow = func() time.Time { return now }
	if _, err := p.Search(context.Background(), "x", 5); err != nil {
		t.Fatal(err)
	}
	if got := f.paths(); !reflect.DeepEqual(got, []string{"/identity", "/hubs/search"}) {
		t.Fatalf("asked %v", got)
	}
	// Kept: no probe for the next request, nor until the TTL is over.
	now = now.Add(plexConnTTL - time.Second)
	_, _ = p.Search(context.Background(), "x", 5)
	if got := f.paths(); len(got) != 3 {
		t.Fatalf("probed again within the TTL: %v", got)
	}
	now = now.Add(2 * time.Second)
	_, _ = p.Search(context.Background(), "x", 5)
	if got := f.paths(); len(got) != 5 || got[3] != "/identity" {
		t.Fatalf("not probed after the TTL: %v", got)
	}
	// Every address down: an error, the kept one forgotten.
	f.srv.Close()
	_, err := p.Search(context.Background(), "x", 5)
	if err == nil || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("down: %v", err)
	}
	p.mu.Lock()
	_, kept := p.conn["one"]
	p.mu.Unlock()
	if kept {
		t.Fatal("a dead address is still kept")
	}
}

func TestPlexAddressThatStopsAnsweringIsLeft(t *testing.T) {
	good := newFakePlex(t, "own")
	gone := newFakePlex(t, "own")
	p := usePlex(t, `{"servers":[{"id":"one","accessToken":"own","connections":[{"uri":"`+gone.srv.URL+`","local":true},{"uri":"`+good.srv.URL+`"}]}]}`)
	if _, err := p.Search(context.Background(), "x", 5); err != nil {
		t.Fatal(err)
	}
	gone.srv.Close()
	// The kept address fails; the next one is probed and asked, once.
	if _, err := p.Search(context.Background(), "x", 5); err != nil {
		t.Fatalf("after the kept address went: %v", err)
	}
	if got := good.paths(); !reflect.DeepEqual(got, []string{"/identity", "/hubs/search"}) {
		t.Fatalf("good asked %v", got)
	}
}

func TestPlexOneServerDownLeavesTheOthers(t *testing.T) {
	f := newFakePlex(t, "own")
	p := usePlex(t, `{"servers":[{"id":"a","accessToken":"wrong","connections":[{"uri":"`+f.srv.URL+`"}]},
		{"id":"b","accessToken":"own","connections":[{"uri":"`+f.srv.URL+`"}]}]}`)
	got, err := p.Search(context.Background(), "x", 10)
	if err != nil || len(got) != 2 || got[0].ID != "b.16" {
		t.Fatalf("%+v %v", got, err)
	}
	// All refusing: the refusal is the error.
	p.servers = p.servers[:1]
	if _, err := p.Search(context.Background(), "x", 10); err == nil || !strings.Contains(err.Error(), "again in Videos") {
		t.Fatalf("all refused: %v", err)
	}
	for _, f := range []func() error{
		func() error { _, err := p.Artists(context.Background()); return err },
		func() error { _, err := p.Playlists(context.Background()); return err },
		func() error { _, err := p.Albums(context.Background(), "newest"); return err },
	} {
		if err := f(); err == nil {
			t.Error("a refusal was no error")
		}
	}
}

func TestPlexErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/hubs/search":
			_, _ = io.WriteString(w, "<html>")
		case "/playlists":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	p := usePlex(t, `{"mode":"direct","server":"`+srv.URL+`"}`)
	if _, err := p.Search(context.Background(), "x", 5); err == nil || !strings.Contains(err.Error(), "unreadable") {
		t.Errorf("html: %v", err)
	}
	if _, err := p.Playlists(context.Background()); err == nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Errorf("500: %v", err)
	}
	if _, err := p.AlbumTracks(context.Background(), "d.1"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("404: %v", err)
	}
	// No token at an address: none sent.
	if _, err := p.Artists(context.Background()); err == nil {
		t.Error("no sections and no error")
	}
}

func TestPlexTokenlessServerGetsNoTokenHeader(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Values("X-Plex-Token")...)
		_, _ = io.WriteString(w, `{"MediaContainer":{}}`)
	}))
	defer srv.Close()
	p := usePlex(t, `{"mode":"direct","server":"`+srv.URL+`","accessToken":""}`)
	if _, err := p.Search(context.Background(), "x", 5); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("token header %q", got)
	}
}

func TestMediaServersThroughTheProviderRoutes(t *testing.T) {
	f := newFakeMediaBrowser(t, false)
	useMediaBrowser(t, f)
	rr := httptest.NewRecorder()
	handleProviderRoute(rr, httptest.NewRequest("GET", "/provider/jellyfin/album?id=al1", nil))
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"path":"jellyfin:s1"`) {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
	rr = httptest.NewRecorder()
	handleProviderRoute(rr, httptest.NewRequest("POST", "/provider/jellyfin/resolve", strings.NewReader(`{"trackId":"s1"}`)))
	var res struct{ URL string }
	_ = json.Unmarshal(rr.Body.Bytes(), &res)
	if rr.Code != 200 || res.URL != mediaLocalBase+"/mediastream?p=jellyfin&id=s1" {
		t.Fatalf("resolve %d %s", rr.Code, rr.Body.String())
	}
}
