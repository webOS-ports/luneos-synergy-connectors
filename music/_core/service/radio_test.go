package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	rbUUID1 = "96126f56-0601-11e8-ae97-52543be04c81"
	rbUUID2 = "96185693-0601-11e8-ae97-52543be04c81"
)

// fakeRadioBrowser answers as de1.api.radio-browser.info did (2026-11-04):
// stations as JSON arrays, /json/url/<uuid> as {"ok":true,...}.
type fakeRadioBrowser struct {
	srv      *httptest.Server
	mu       sync.Mutex
	paths    []string
	queries  []url.Values
	agents   []string
	stations []radioStation
	fail     bool
}

func rbStation(uuid, name, stream string) radioStation {
	return radioStation{UUID: uuid, Name: name, URL: stream, URLResolved: stream, Favicon: "https://logo.example/" + name + ".png",
		Country: "The Netherlands", CountryCode: "NL", Codec: "MP3", Bitrate: 192, LastCheckOK: 1}
}

func newFakeRadioBrowser(t *testing.T) *fakeRadioBrowser {
	f := &fakeRadioBrowser{stations: []radioStation{
		rbStation(rbUUID1, "NPO Radio 1", "http://icecast.omroep.nl/radio1-bb-mp3"),
		rbStation(rbUUID2, "Rai Radio 1", "http://icestreaming.rai.it/1.mp3"),
	}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.queries = append(f.queries, r.URL.Query())
		f.agents = append(f.agents, r.Header.Get("User-Agent"))
		fail, stations := f.fail, f.stations
		f.mu.Unlock()
		if fail {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(r.URL.Path, "/json/url/"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "stationuuid": strings.TrimPrefix(r.URL.Path, "/json/url/")})
		case r.URL.Path == "/json/stations/byuuid":
			out := []radioStation{}
			for _, s := range stations {
				if s.UUID == r.URL.Query().Get("uuids") {
					out = append(out, s)
				}
			}
			_ = json.NewEncoder(w).Encode(out)
		default:
			_ = json.NewEncoder(w).Encode(stations)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeRadioBrowser) last() (string, url.Values) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.paths) == 0 {
		return "", nil
	}
	return f.paths[len(f.paths)-1], f.queries[len(f.queries)-1]
}

// useRadio points the provider at the fake servers, a temporary lists file, a
// country, and records clicks instead of sending them.
func useRadio(t *testing.T, servers []string, country string) *[]string {
	t.Helper()
	oldServers, oldCountry, oldClick, oldPath := radioServers, radioCountry, radioClick, radioListsPath
	clicks := &[]string{}
	var mu sync.Mutex
	radioServers = func() []string { return servers }
	radioCountry = func() string { return country }
	radioClick = func(uuid string) { mu.Lock(); *clicks = append(*clicks, uuid); mu.Unlock() }
	radioListsPath = filepath.Join(t.TempDir(), "radio-lists")
	t.Cleanup(func() {
		radioServers, radioCountry, radioClick, radioListsPath = oldServers, oldCountry, oldClick, oldPath
	})
	return clicks
}

func writeLists(t *testing.T, lists ...string) {
	t.Helper()
	if err := os.WriteFile(radioListsPath, encodeRadioLists(lists), 0600); err != nil {
		t.Fatal(err)
	}
}

// serveFiles is a web server of station lists and streams: path -> (content type, body).
func serveFiles(t *testing.T, files map[string][2]string) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", f[0])
		_, _ = w.Write([]byte(f[1]))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestParseRadioListExtendedM3U(t *testing.T) {
	base, _ := url.Parse("http://lists.example/dir/stations.m3u")
	body := "\ufeff#EXTM3U\n" +
		"#EXTINF:-1 tvg-logo=\"logo/a.png\" group-title=\"News, talk\",Station A, the first\n" +
		"http://stream.example/a\n" +
		"#EXTINF:-1 tvg-name=\"Named B\" group-title=\"Music\",\n" +
		"relative/b.mp3\n" +
		"#EXTINF:-1,Bad scheme\n" +
		"rtmp://stream.example/c\n" +
		"#EXTGRP:Music\n" +
		"https://stream.example/plain/d.aac\n" +
		"<a href=\"x\">a link</a>\n" +
		"not an address\n" +
		"#EXTINF:-1 tvg-logo=\"javascript:alert(1)\",Logo not web\n" +
		"http://stream.example/e\n"
	got := parseRadioList([]byte(body), base)
	want := []radioEntry{
		{Name: "Station A, the first", URL: "http://stream.example/a", Logo: "http://lists.example/dir/logo/a.png", Group: "News, talk"},
		{Name: "Named B", URL: "http://lists.example/dir/relative/b.mp3", Group: "Music"},
		{Name: "d.aac", URL: "https://stream.example/plain/d.aac", Group: "Music"},
		{Name: "Logo not web", URL: "http://stream.example/e"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d entries %+v", len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestParseRadioListInfoDoesNotLeak(t *testing.T) {
	// A station's info is its own: the next station without #EXTINF has none.
	got := parseRadioList([]byte("#EXTINF:-1 group-title=\"G\",One\nhttp://a.example/1\nhttp://a.example/2\n"), nil)
	if len(got) != 2 || got[1].Name != "2" || got[1].Group != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestParsePLS(t *testing.T) {
	body := "  [Playlist]\nNumberOfEntries=3\nFile2=http://s.example/two\nTitle2=Two\nFile1=http://s.example/one\nTitle1=One\nfile10=https://s.example/ten\nFile3=ftp://s.example/x\nVersion=2\n"
	got := parseRadioList([]byte(body), nil)
	if len(got) != 3 || got[0].Name != "One" || got[1].URL != "http://s.example/two" || got[2].URL != "https://s.example/ten" || got[2].Name != "ten" {
		t.Fatalf("got %+v", got)
	}
}

func TestParseRadioListCap(t *testing.T) {
	var b strings.Builder
	for i := 0; i < radioMaxStations+10; i++ {
		b.WriteString("http://s.example/x\n")
	}
	if n := len(parseRadioList([]byte(b.String()), nil)); n != radioMaxStations {
		t.Fatalf("got %d stations", n)
	}
}

func TestRadioTracks(t *testing.T) {
	good := rbStation(rbUUID1, "  One  ", "http://s.example/1")
	broken := rbStation(rbUUID2, "Broken", "http://s.example/2")
	broken.LastCheckOK = 0
	noURL := rbStation("0b0e7e0e-0601-11e8-ae97-52543be04c81", "No stream", "")
	badID := rbStation("not-a-uuid", "Bad id", "http://s.example/3")
	resolvedOnly := rbStation("1b0e7e0e-0601-11e8-ae97-52543be04c81", "", "http://s.example/4")
	resolvedOnly.URL, resolvedOnly.Favicon, resolvedOnly.Country, resolvedOnly.Codec, resolvedOnly.Bitrate = "", "data:x", "", "UNKNOWN", 0
	got := radioTracks([]radioStation{good, good, broken, noURL, badID, resolvedOnly}, 10)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	want := providerTrack{ID: "rb." + rbUUID1, Provider: "radio", Title: "One", Artist: "The Netherlands", Album: "MP3 · 192 kbps",
		Thumbnail: "https://logo.example/  One  .png", Path: "radio:rb." + rbUUID1}
	if got[0] != want {
		t.Errorf("got %+v\nwant %+v", got[0], want)
	}
	if got[1].Title != "Radio station" || got[1].Artist != "NL" || got[1].Album != "Internet radio" || got[1].Thumbnail != "" {
		t.Errorf("second: %+v", got[1])
	}
	if n := len(radioTracks([]radioStation{good, resolvedOnly}, 1)); n != 1 {
		t.Errorf("max 1 gave %d", n)
	}
}

func TestRadioDetails(t *testing.T) {
	for _, c := range []struct {
		codec string
		rate  int
		want  string
	}{{"AAC", 0, "AAC"}, {"", 64, "64 kbps"}, {"unknown", 0, "Internet radio"}} {
		if got := radioDetails(c.codec, c.rate); got != c.want {
			t.Errorf("%q %d: %q", c.codec, c.rate, got)
		}
	}
}

func TestRadioSearchListsFirstThenRadioBrowser(t *testing.T) {
	rb := newFakeRadioBrowser(t)
	useRadio(t, []string{rb.srv.URL}, "NL")
	lists := serveFiles(t, map[string][2]string{"/my.m3u": {"audio/x-mpegurl", "#EXTINF:-1,My Radio One\nhttp://mine.example/1\n#EXTINF:-1,Other\nhttp://mine.example/2\n"}})
	writeLists(t, lists.URL+"/my.m3u")
	p := newRadioProvider()
	got, err := p.Search(context.Background(), " radio 1 ", 10)
	if err != nil {
		t.Fatal(err)
	}
	// None of the own stations has "radio 1" in its name.
	if len(got) != 2 || got[0].ID != "rb."+rbUUID1 {
		t.Fatalf("got %+v", got)
	}
	path, q := rb.last()
	if path != "/json/stations/search" || q.Get("name") != "radio 1" || q.Get("hidebroken") != "true" || q.Get("order") != "clickcount" ||
		q.Get("reverse") != "true" || q.Get("limit") != "10" {
		t.Errorf("asked %s %v", path, q)
	}
	if rb.agents[0] != radioUserAgent {
		t.Errorf("user agent %q", rb.agents[0])
	}
	got, err = p.Search(context.Background(), "my radio", 10)
	if err != nil || len(got) != 3 || got[0].Title != "My Radio One" || got[0].Artist != "my" ||
		got[0].Path != "radio:u."+base64.RawURLEncoding.EncodeToString([]byte("http://mine.example/1")) {
		t.Fatalf("got %+v %v", got, err)
	}
	// Only what fits in the limit is asked of Radio Browser.
	if _, q := rb.last(); q.Get("limit") != "9" {
		t.Errorf("limit asked %q", q.Get("limit"))
	}
	rb.fail = true
	got, err = p.Search(context.Background(), "my radio", 10)
	if err != nil || len(got) != 1 {
		t.Fatalf("with Radio Browser down: %+v %v", got, err)
	}
	if _, err := p.Search(context.Background(), "nothing", 10); err == nil {
		t.Error("no error with Radio Browser down and nothing found")
	}
	if got, err := p.Search(context.Background(), "  ", 10); err != nil || len(got) != 0 {
		t.Errorf("empty query: %v %v", got, err)
	}
}

func TestRadioSearchLimitReachedByLists(t *testing.T) {
	rb := newFakeRadioBrowser(t)
	useRadio(t, []string{rb.srv.URL}, "")
	lists := serveFiles(t, map[string][2]string{"/l.m3u": {"text/plain", "#EXTINF:-1,Jazz 1\nhttp://j.example/1\n#EXTINF:-1,Jazz 2\nhttp://j.example/2\n"}})
	writeLists(t, lists.URL+"/l.m3u")
	got, err := newRadioProvider().Search(context.Background(), "jazz", 2)
	if err != nil || len(got) != 2 || len(rb.paths) != 0 {
		t.Fatalf("got %+v %v, Radio Browser asked %v", got, err, rb.paths)
	}
}

func TestRadioGetTriesNextServer(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "x", 500) }))
	t.Cleanup(down.Close)
	notJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>")) }))
	t.Cleanup(notJSON.Close)
	jsonError := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`[{"stationuuid":"` + rbUUID1 + `"}]`))
	}))
	t.Cleanup(jsonError.Close)
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	rb := newFakeRadioBrowser(t)
	useRadio(t, []string{closed.URL, down.URL, jsonError.URL, notJSON.URL, rb.srv.URL}, "")
	var st []radioStation
	if err := radioGet(context.Background(), "/json/stations/topclick", nil, &st); err != nil || len(st) != 2 {
		t.Fatalf("%v %d", err, len(st))
	}
	useRadio(t, []string{down.URL}, "")
	if err := radioGet(context.Background(), "/x", nil, &st); err == nil || !strings.Contains(err.Error(), "cannot be reached") {
		t.Fatalf("got %v", err)
	}
}

func TestRadioStreamURL(t *testing.T) {
	rb := newFakeRadioBrowser(t)
	rb.stations[0].URLResolved = "http://resolved.example/radio1"
	rb.stations[1].URLResolved = ""
	clicks := useRadio(t, []string{rb.srv.URL}, "")
	p := newRadioProvider()
	ctx := context.Background()
	if u, err := p.StreamURL(ctx, "rb."+rbUUID1); err != nil || u != "http://resolved.example/radio1" {
		t.Errorf("resolved: %q %v", u, err)
	}
	if u, err := p.StreamURL(ctx, "rb."+rbUUID2); err != nil || u != "http://icestreaming.rai.it/1.mp3" {
		t.Errorf("url: %q %v", u, err)
	}
	if strings.Join(*clicks, ",") != rbUUID1+","+rbUUID2 {
		t.Errorf("clicks %v", *clicks)
	}
	if _, err := p.StreamURL(ctx, "rb.0b0e7e0e-0601-11e8-ae97-52543be04c81"); err == nil {
		t.Error("an unknown station played")
	}
	for _, bad := range []string{"rb.../json", "u.!!", "u." + base64.RawURLEncoding.EncodeToString([]byte("file:///etc/passwd")), "x.y", ""} {
		if u, err := p.StreamURL(ctx, bad); err == nil {
			t.Errorf("%q played %q", bad, u)
		}
	}
	if len(*clicks) != 2 {
		t.Errorf("clicks after failures %v", *clicks)
	}
	direct := "https://mine.example/live.aac"
	if u, err := p.StreamURL(ctx, "u."+base64.RawURLEncoding.EncodeToString([]byte(direct))); err != nil || u != direct {
		t.Errorf("own: %q %v", u, err)
	}
}

func TestRadioStreamURLOpensStationPlaylist(t *testing.T) {
	useRadio(t, nil, "")
	files := serveFiles(t, map[string][2]string{
		"/station.pls": {"audio/x-scpls", "[playlist]\nFile1=http://stream.example/live\n"},
		"/station.m3u": {"audio/x-mpegurl", "#EXTM3U\nhttp://stream.example/m3u-live\n"},
		"/live.m3u8":   {"application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-VERSION:3\nseg1.ts\n"},
		"/empty.pls":   {"audio/x-scpls", "[playlist]\n"},
		"/stream.m3u":  {"audio/mpeg", "ID3...."},
	})
	p := newRadioProvider()
	for path, want := range map[string]string{
		"/station.pls": "http://stream.example/live",
		"/station.m3u": "http://stream.example/m3u-live",
		"/live.m3u8":   files.URL + "/live.m3u8",
		"/empty.pls":   files.URL + "/empty.pls",
		"/stream.m3u":  files.URL + "/stream.m3u",
		"/gone.pls":    files.URL + "/gone.pls",
	} {
		id := "u." + base64.RawURLEncoding.EncodeToString([]byte(files.URL+path))
		if u, err := p.StreamURL(context.Background(), id); err != nil || u != want {
			t.Errorf("%s: %q %v, want %q", path, u, err, want)
		}
	}
}

func TestRadioPlaylists(t *testing.T) {
	rb := newFakeRadioBrowser(t)
	useRadio(t, []string{rb.srv.URL}, "NL")
	files := serveFiles(t, map[string][2]string{
		"/grouped.m3u": {"audio/x-mpegurl", "#EXTINF:-1 group-title=\"News\",N1\nhttp://s.example/n1\n#EXTINF:-1 group-title=\"Jazz\",J1\nhttp://s.example/j1\n#EXTINF:-1 group-title=\"News\",N2\nhttp://s.example/n2\n"},
		"/plain.pls":   {"audio/x-scpls", "[playlist]\nFile1=http://s.example/p1\nTitle1=P1\n"},
	})
	writeLists(t, files.URL+"/grouped.m3u", files.URL+"/gone.m3u", files.URL+"/plain.pls")
	p := newRadioProvider()
	lists, err := p.Playlists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, l := range lists {
		names = append(names, l.ID+"="+l.Name)
	}
	got := strings.Join(names, " ")
	news := "l0." + base64.RawURLEncoding.EncodeToString([]byte("News"))
	jazz := "l0." + base64.RawURLEncoding.EncodeToString([]byte("Jazz"))
	want := news + "=News " + jazz + "=Jazz l2=plain rb.top=Most played rb.votes=Most liked rb.country.NL=Popular in NL rb.tag.pop=Pop"
	if !strings.HasPrefix(got, want) || len(lists) != 6+len(radioGenres) {
		t.Fatalf("got %s", got)
	}
	if lists[0].Tracks != 2 || lists[0].Owner != "grouped" || lists[2].Tracks != 1 {
		t.Errorf("counts %+v", lists[:3])
	}
	tr, err := p.PlaylistTracks(context.Background(), news)
	if err != nil || len(tr) != 2 || tr[0].Title != "N1" || tr[1].Title != "N2" {
		t.Fatalf("news: %+v %v", tr, err)
	}
	if tr, err := p.PlaylistTracks(context.Background(), "l2"); err != nil || len(tr) != 1 || tr[0].Title != "P1" {
		t.Fatalf("plain: %+v %v", tr, err)
	}
	if _, err := p.PlaylistTracks(context.Background(), "l1"); err == nil {
		t.Error("the unreachable list gave tracks")
	}
	for _, bad := range []string{"l9", "l01", "l-1", "lx", "l0.!", "rb.nope", "x"} {
		if _, err := p.PlaylistTracks(context.Background(), bad); err == nil {
			t.Errorf("%q gave tracks", bad)
		}
	}
	if tr, err := p.PlaylistTracks(context.Background(), "rb.tag.jazz"); err != nil || len(tr) != 2 {
		t.Fatalf("jazz: %v %v", tr, err)
	}
	path, q := rb.last()
	if path != "/json/stations/search" || q.Get("tag") != "jazz" || q.Get("tagExact") != "true" || q.Get("order") != "clickcount" || q.Get("limit") != "100" {
		t.Errorf("asked %s %v", path, q)
	}
	if _, err := p.PlaylistTracks(context.Background(), "rb.country.NL"); err != nil {
		t.Fatal(err)
	}
	if _, q := rb.last(); q.Get("countrycode") != "NL" {
		t.Errorf("country asked %v", q)
	}
	if _, err := p.PlaylistTracks(context.Background(), "rb.top"); err != nil {
		t.Fatal(err)
	}
	if path, _ := rb.last(); path != "/json/stations/topclick" {
		t.Errorf("top asked %s", path)
	}
	// Kept for a while: asking again does not ask Radio Browser.
	n := len(rb.paths)
	if _, err := p.PlaylistTracks(context.Background(), "rb.top"); err != nil || len(rb.paths) != n {
		t.Errorf("asked again: %d -> %d", n, len(rb.paths))
	}
	useRadio(t, []string{rb.srv.URL}, "")
	lists, _ = p.Playlists(context.Background())
	for _, l := range lists {
		if strings.HasPrefix(l.ID, "rb.country") {
			t.Error("a country playlist without a country")
		}
	}
}

func TestListGroupsOneGroupIsWholeList(t *testing.T) {
	if g := listGroups([]radioEntry{{Group: "A"}, {Group: "A"}}); len(g) != 1 || g[0] != "" {
		t.Errorf("got %q", g)
	}
}

func postLists(t *testing.T, lists ...string) (int, map[string]interface{}) {
	t.Helper()
	b, _ := json.Marshal(map[string]interface{}{"lists": lists})
	rec := httptest.NewRecorder()
	handleRadioAuthLists(rec, httptest.NewRequest(http.MethodPost, "/radioauth/lists", bytes.NewReader(b)))
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestRadioAuthLists(t *testing.T) {
	useRadio(t, nil, "")
	files := serveFiles(t, map[string][2]string{
		"/a.m3u": {"audio/x-mpegurl", "http://s.example/1\nhttp://s.example/2\n"},
		"/b.pls": {"audio/x-scpls", "[playlist]\nFile1=http://s.example/3\n"},
		"/live":  {"audio/mpeg", "ID3 stream bytes"},
		"/page":  {"text/html", "<html>not a list</html>"},
	})
	if code, out := postLists(t, files.URL+"/a.m3u", " "+files.URL+"/b.pls "); code != 200 || out["ok"] != true {
		t.Fatalf("%d %v", code, out)
	}
	if code, out := postLists(t, files.URL+"/live", files.URL+"/a.m3u"); code != 200 || len(out["lists"].([]interface{})) != 2 {
		t.Fatalf("%d %v", code, out)
	}
	if got := strings.Join(readRadioLists(), " "); got != files.URL+"/a.m3u "+files.URL+"/b.pls "+files.URL+"/live" {
		t.Fatalf("kept %s", got)
	}
	for _, bad := range []string{files.URL + "/page", files.URL + "/gone.m3u", "ftp://x.example/l.m3u",
		"http://user:pw@x.example/l.m3u", files.URL + "/a.m3u\nhttp://evil.example/"} {
		if code, _ := postLists(t, bad); code == 200 {
			t.Errorf("%q kept", bad)
		}
	}
	if code, _ := postLists(t, "ftp://x.example/l.m3u"); code != http.StatusBadRequest {
		t.Errorf("ftp: %d", code)
	}
	if got := len(readRadioLists()); got != 3 {
		t.Errorf("%d lists after refusals", got)
	}
	// An address without a scheme is taken as http.
	host := strings.TrimPrefix(files.URL, "http://")
	if code, out := postLists(t, host+"/b.pls"); code != 200 || out["lists"].([]interface{})[0].(map[string]interface{})["address"] != files.URL+"/b.pls" {
		t.Errorf("%d %v", code, out)
	}
	// Nothing to add changes nothing.
	if code, _ := postLists(t, "", "  "); code != 200 || len(readRadioLists()) != 3 {
		t.Errorf("%d %v", code, readRadioLists())
	}
}

func TestRadioAuthListsCap(t *testing.T) {
	useRadio(t, nil, "")
	files := serveFiles(t, map[string][2]string{"/a.m3u": {"audio/x-mpegurl", "http://s.example/1\n"}})
	kept := []string{}
	for i := 0; i < radioMaxLists; i++ {
		kept = append(kept, files.URL+"/a.m3u?n="+string(rune('a'+i)))
	}
	writeLists(t, kept...)
	if code, _ := postLists(t, files.URL+"/a.m3u?n=new"); code != http.StatusBadRequest {
		t.Errorf("one over the cap: %d", code)
	}
	if len(readRadioLists()) != radioMaxLists {
		t.Error("the lists changed")
	}
}

func TestLocaleCountry(t *testing.T) {
	for in, want := range map[string]string{"nl-NL": "NL", "en_US.UTF-8": "US", "ZH": "", "en-USA": "", "zh-Hant-TW": "TW", "de": "", "": "", "C.UTF-8": "", "en-us": ""} {
		if got := localeCountry(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestIsWebLink(t *testing.T) {
	for in, want := range map[string]bool{"http://a.example/x": true, "https://a.example": true, " http://a.example ": true,
		"ftp://a.example": false, "http://": false, "javascript:alert(1)": false, "http://a.example/" + strings.Repeat("x", 2050): false} {
		if got := isWebLink(in); got != want {
			t.Errorf("%q: %v", in, got)
		}
	}
}

func TestReadRadioListsSkipsJunk(t *testing.T) {
	useRadio(t, nil, "")
	if err := os.WriteFile(radioListsPath, []byte("http://a.example/1.m3u\n\n  junk line\nftp://b.example/x\n https://c.example/2.pls \n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(readRadioLists(), " "); got != "http://a.example/1.m3u https://c.example/2.pls" {
		t.Fatalf("got %q", got)
	}
}

// endlessStream sends audio until the client goes, as a station does.
func endlessStream(contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		chunk := bytes.Repeat([]byte{0xff}, 512)
		for r.Context().Err() == nil {
			if _, err := w.Write(chunk); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			time.Sleep(5 * time.Millisecond)
		}
	}
}

func TestRadioAuthListsTakesAStationsOwnStream(t *testing.T) {
	useRadio(t, nil, "")
	mux := http.NewServeMux()
	mux.Handle("/ogg", endlessStream("application/ogg"))
	mux.Handle("/aac", endlessStream("audio/aac"))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	start := time.Now()
	if code, out := postLists(t, srv.URL+"/ogg", srv.URL+"/aac"); code != 200 || len(out["lists"].([]interface{})) != 2 {
		t.Fatalf("%d %v", code, out)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("reading the streams took %v", d)
	}
	tr, err := newRadioProvider().PlaylistTracks(context.Background(), "l1")
	if err != nil || len(tr) != 1 || tr[0].Title != "aac" {
		t.Fatalf("%+v %v", tr, err)
	}
}

func TestRadioAuthListsRefusesWhatIsNoList(t *testing.T) {
	useRadio(t, nil, "")
	var srv *httptest.Server
	files := map[string][2]string{
		"/page.html": {"text/html; charset=utf-8", "http://looks.example/like-a-station\n"},
		"/empty.m3u": {"audio/x-mpegurl", "#EXTM3U\n# nothing\n"},
		"/a.m3u":     {"audio/x-mpegurl", "http://s.example/1\n"},
	}
	srv = serveFiles(t, files)
	withUser := strings.Replace(srv.URL, "http://", "http://user:pw@", 1) + "/a.m3u"
	for _, bad := range []string{srv.URL + "/page.html", srv.URL + "/empty.m3u", withUser} {
		if code, out := postLists(t, bad); code == 200 {
			t.Errorf("%q kept: %v", bad, out)
		}
	}
	if _, err := os.Stat(radioListsPath); !os.IsNotExist(err) {
		t.Errorf("a lists file after refusals: %v", err)
	}
	// Nothing to add writes nothing.
	if code, _ := postLists(t); code != 200 {
		t.Fatal(code)
	}
	if _, err := os.Stat(radioListsPath); !os.IsNotExist(err) {
		t.Errorf("a lists file after adding nothing: %v", err)
	}
}

func TestRadioStreamURLAsksNothingForABadID(t *testing.T) {
	rb := newFakeRadioBrowser(t)
	useRadio(t, []string{rb.srv.URL}, "")
	for _, bad := range []string{"rb.not-a-uuid", "rb." + rbUUID1 + "&x=1", "rb."} {
		if _, err := newRadioProvider().StreamURL(context.Background(), bad); err == nil {
			t.Errorf("%q played", bad)
		}
	}
	if len(rb.paths) != 0 {
		t.Errorf("Radio Browser asked %v", rb.paths)
	}
}
