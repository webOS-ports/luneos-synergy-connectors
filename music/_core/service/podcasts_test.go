package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// podEnv is a podcast store for one test: its state file, downloads folder
// and import root in temporary folders, a clock, the bus and the free space
// the test sets.
type podEnv struct {
	s     *podcastStore
	mux   *http.ServeMux
	root  string // stands for /media/internal
	files string // stands for /media/internal/podcasts
	now   atomic.Int64
	free  atomic.Uint64

	mu    sync.Mutex
	calls []lunaRecord
	wifi  string // "connected", anything else, or "fail"
}

type lunaRecord struct{ URI, Payload string }

func usePodcasts(t *testing.T) *podEnv {
	t.Helper()
	e := &podEnv{root: t.TempDir(), wifi: "connected"}
	e.files = filepath.Join(e.root, "podcasts")
	e.now.Store(time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC).UnixMilli())
	e.free.Store(1 << 40)
	old := struct {
		path, files, root, search, itunes string
		now                               func() time.Time
		luna                              func(string, string) (map[string]interface{}, error)
		free                              func(string) (uint64, error)
		feedHTTP, dlHTTP                  *http.Client
		delay, stall                      time.Duration
		store                             *podcastStore
	}{podcastStatePath, podcastFilesDir, podcastImportRoot, podcastSearchBase, podcastITunesBase, podcastNow, podcastLuna,
		podcastFreeSpace, podcastHTTP, podcastDLHTTP, podcastSaveDelay, podcastStall, pods}
	podcastStatePath = filepath.Join(t.TempDir(), "podcasts.json")
	podcastFilesDir, podcastImportRoot = e.files, e.root
	podcastSearchBase, podcastITunesBase = "http://127.0.0.1:1", "http://127.0.0.1:1"
	podcastNow = func() time.Time { return time.UnixMilli(e.now.Load()).UTC() }
	podcastLuna = e.luna
	podcastFreeSpace = func(string) (uint64, error) { return e.free.Load(), nil }
	podcastHTTP = &http.Client{Timeout: 10 * time.Second}
	podcastDLHTTP = &http.Client{Timeout: 30 * time.Second}
	podcastSaveDelay = time.Hour // the tests flush
	podcastStall = 10 * time.Second
	e.s = newPodcastStore(podcastStatePath)
	pods = e.s
	e.mux = http.NewServeMux()
	registerPodcastRoutes(e.mux)
	t.Cleanup(func() {
		pods.close()
		podcastStatePath, podcastFilesDir, podcastImportRoot = old.path, old.files, old.root
		podcastSearchBase, podcastITunesBase, podcastNow, podcastLuna = old.search, old.itunes, old.now, old.luna
		podcastFreeSpace, podcastHTTP, podcastDLHTTP = old.free, old.feedHTTP, old.dlHTTP
		podcastSaveDelay, podcastStall, pods = old.delay, old.stall, old.store
	})
	return e
}

func (e *podEnv) luna(uri, payload string) (map[string]interface{}, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, lunaRecord{uri, payload})
	if strings.HasSuffix(uri, "/getStatus") {
		if e.wifi == "fail" {
			return nil, errors.New("no bus")
		}
		return map[string]interface{}{"returnValue": true, "wifi": map[string]interface{}{"state": e.wifi}}, nil
	}
	return map[string]interface{}{"returnValue": true}, nil
}

func (e *podEnv) toasts() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := []string{}
	for _, c := range e.calls {
		if c.URI == "luna://com.webos.notification/createToast" {
			out = append(out, c.Payload)
		}
	}
	return out
}

func (e *podEnv) advance(d time.Duration) { e.now.Add(d.Milliseconds()) }

// call runs a request through the routes; the reply decoded.
func (e *podEnv) call(t *testing.T, method, path string, body interface{}) (int, map[string]interface{}) {
	t.Helper()
	var rd *bytes.Reader
	switch b := body.(type) {
	case nil:
		rd = bytes.NewReader(nil)
	case string:
		rd = bytes.NewReader([]byte(b))
	default:
		j, _ := json.Marshal(b)
		rd = bytes.NewReader(j)
	}
	req := httptest.NewRequest(method, path, rd)
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	out := map[string]interface{}{}
	if strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s %s: %v: %s", method, path, err, rec.Body.String())
		}
	} else {
		out["body"] = rec.Body.String()
	}
	return rec.Code, out
}

func (e *podEnv) post(t *testing.T, path string, body interface{}) map[string]interface{} {
	t.Helper()
	code, out := e.call(t, http.MethodPost, path, body)
	if code != http.StatusOK {
		t.Fatalf("POST %s: %d %v", path, code, out)
	}
	return out
}

func (e *podEnv) get(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	code, out := e.call(t, http.MethodGet, path, nil)
	if code != http.StatusOK {
		t.Fatalf("GET %s: %d %v", path, code, out)
	}
	return out
}

// subscribe subscribes to addr and gives the podcast's id.
func (e *podEnv) subscribe(t *testing.T, addr string) string {
	t.Helper()
	out := e.post(t, "/podcasts/subscribe", map[string]string{"url": addr})
	return out["podcast"].(map[string]interface{})["id"].(string)
}

// episodes is a podcast's episodes as the route gives them.
func (e *podEnv) episodes(t *testing.T, id string) []map[string]interface{} {
	t.Helper()
	return list(e.get(t, "/podcasts/episodes?id="+id+"&limit=200")["episodes"])
}

func list(v interface{}) []map[string]interface{} {
	out := []map[string]interface{}{}
	for _, x := range v.([]interface{}) {
		out = append(out, x.(map[string]interface{}))
	}
	return out
}

func titles(eps []map[string]interface{}) string {
	t := []string{}
	for _, e := range eps {
		t = append(t, e["title"].(string))
	}
	return strings.Join(t, ", ")
}

// waitRefreshed waits for the refresh going on to end.
func (e *podEnv) waitRefreshed(t *testing.T) {
	t.Helper()
	waitFor(t, "the refresh", func() bool {
		e.s.mu.Lock()
		defer e.s.mu.Unlock()
		return !e.s.refreshing
	})
}

// changingFeed is a feed whose items the test sets; it answers 304 to the
// ETag of what it serves.
type changingFeed struct {
	mu      sync.Mutex
	title   string
	items   []string
	version int
	hits    int
	fail    bool
}

func (c *changingFeed) set(items ...string) {
	c.mu.Lock()
	c.items, c.version = items, c.version+1
	c.mu.Unlock()
}

func (c *changingFeed) handler(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.hits++
	if c.fail {
		http.Error(w, "down", http.StatusInternalServerError)
		return
	}
	etag := fmt.Sprintf(`"v%d"`, c.version)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", etag)
	title := c.title
	if title == "" {
		title = "Changing"
	}
	fmt.Fprintf(w, `<rss version="2.0"><channel><title>%s</title><link>https://changing.example/</link>%s</channel></rss>`, title, strings.Join(c.items, ""))
}

func (c *changingFeed) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hits
}

// item is an RSS item n days after 2026-10-01, its enclosure at base.
func item(guid string, day int, base string) string {
	d := time.Date(2026, 10, 1+day, 9, 0, 0, 0, time.UTC).Format(time.RFC1123Z)
	return fmt.Sprintf(`<item><title>%s</title><guid>%s</guid><pubDate>%s</pubDate><enclosure url="%s/%s.mp3" type="audio/mpeg" length="0"/></item>`,
		guid, guid, d, base, guid)
}

func TestSubscribeNewestIsNewAndIdempotent(t *testing.T) {
	e := usePodcasts(t)
	feed := &changingFeed{}
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": feed.handler})
	feed.set(item("a", 1, srv.URL), item("c", 3, srv.URL), item("b", 2, srv.URL))
	id := e.subscribe(t, srv.URL+"/feed")
	if id != podcastID(srv.URL+"/feed") || len(id) != 12 {
		t.Fatalf("id %q", id)
	}
	eps := e.episodes(t, id)
	if titles(eps) != "c, b, a" {
		t.Fatalf("order: %s", titles(eps))
	}
	if eps[0]["new"] != true || eps[1]["new"] != false || eps[2]["new"] != false {
		t.Errorf("new: %v %v %v", eps[0]["new"], eps[1]["new"], eps[2]["new"])
	}
	wantID := "podcast:" + id + "." + episodeKey("c")
	if eps[0]["id"] != wantID || eps[0]["podcast"] != id || eps[0]["podcastTitle"] != "Changing" {
		t.Errorf("episode: %v", eps[0])
	}
	if again := e.subscribe(t, srv.URL+"/feed"); again != id || feed.count() != 1 {
		t.Errorf("second subscribe: %s, %d reads", again, feed.count())
	}
	p := list(e.get(t, "/podcasts")["podcasts"])
	if len(p) != 1 || p[0]["episodeCount"] != 3.0 || p[0]["newCount"] != 1.0 || p[0]["unplayedCount"] != 3.0 ||
		p[0]["added"] != float64(e.now.Load()) || p[0]["lastRefresh"] != float64(e.now.Load()) || p[0]["lastError"] != "" {
		t.Errorf("podcasts: %v", p)
	}
	// A feed that cannot be read is not subscribed.
	if code, out := e.call(t, http.MethodPost, "/podcasts/subscribe", map[string]string{"url": srv.URL + "/missing"}); code != http.StatusBadGateway {
		t.Errorf("missing feed: %d %v", code, out)
	}
	for _, bad := range []string{"", "ftp://x.example/feed", "javascript:alert(1)", "https://user:pw@x.example/feed", "not a url"} {
		if code, _ := e.call(t, http.MethodPost, "/podcasts/subscribe", map[string]string{"url": bad}); code != http.StatusBadRequest {
			t.Errorf("%q: %d", bad, code)
		}
	}
}

func TestRefreshMarksUnseenNewAndKeepsState(t *testing.T) {
	e := usePodcasts(t)
	feed := &changingFeed{}
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": feed.handler})
	feed.set(item("a", 1, srv.URL), item("b", 2, srv.URL))
	id := e.subscribe(t, srv.URL+"/feed")
	epA := "podcast:" + id + "." + episodeKey("a")
	e.post(t, "/podcasts/state", map[string]interface{}{"id": epA, "position_ms": 5000})

	// Unchanged: 304, nothing new, the refresh time moves on.
	e.advance(time.Hour)
	e.post(t, "/podcasts/refresh", map[string]string{"id": id})
	e.waitRefreshed(t)
	e.s.wg.Wait()
	if p := list(e.get(t, "/podcasts")["podcasts"])[0]; p["lastRefresh"] != float64(e.now.Load()) || p["newCount"] != 1.0 {
		t.Fatalf("after 304: %v", p)
	}

	feed.mu.Lock()
	feed.title = "Renamed"
	feed.mu.Unlock()
	feed.set(item("a", 1, srv.URL), item("b", 2, srv.URL), item("d", 4, srv.URL), item("c", 3, srv.URL))
	e.post(t, "/podcasts/refresh", nil)
	e.waitRefreshed(t)
	e.s.wg.Wait()
	eps := e.episodes(t, id)
	if titles(eps) != "d, c, b, a" {
		t.Fatalf("order %s", titles(eps))
	}
	news := []bool{}
	for _, ep := range eps {
		news = append(news, ep["new"].(bool))
	}
	if !reflect.DeepEqual(news, []bool{true, true, true, false}) {
		t.Errorf("new: %v", news)
	}
	if eps[3]["position_ms"] != 5000.0 || eps[3]["podcastTitle"] != "Renamed" {
		t.Errorf("state kept: %v", eps[3])
	}
	// An episode that leaves the feed stays.
	feed.set(item("d", 4, srv.URL))
	e.post(t, "/podcasts/refresh", nil)
	e.waitRefreshed(t)
	e.s.wg.Wait()
	if n := len(e.episodes(t, id)); n != 4 {
		t.Errorf("%d episodes", n)
	}
	// A failure is kept in lastError, and cleared by the next success.
	feed.mu.Lock()
	feed.fail = true
	feed.mu.Unlock()
	e.post(t, "/podcasts/refresh", nil)
	e.waitRefreshed(t)
	e.s.wg.Wait()
	if p := list(e.get(t, "/podcasts")["podcasts"])[0]; !strings.Contains(p["lastError"].(string), "HTTP 500") {
		t.Errorf("lastError %v", p["lastError"])
	}
	feed.mu.Lock()
	feed.fail = false
	feed.mu.Unlock()
	e.post(t, "/podcasts/refresh", nil)
	e.waitRefreshed(t)
	e.s.wg.Wait()
	if p := list(e.get(t, "/podcasts")["podcasts"])[0]; p["lastError"] != "" {
		t.Errorf("lastError %v", p["lastError"])
	}
}

func TestRefreshPermanentRedirectKeepsID(t *testing.T) {
	e := usePodcasts(t)
	moved := atomic.Bool{}
	var srvURL string
	srv := feedServer(t, map[string]http.HandlerFunc{
		"/old": func(w http.ResponseWriter, r *http.Request) {
			if moved.Load() {
				http.Redirect(w, r, "/new", http.StatusMovedPermanently)
				return
			}
			serveXML(`<rss><channel><title>Moving</title>`+item("a", 1, srvURL)+`</channel></rss>`)(w, r)
		},
		"/new": func(w http.ResponseWriter, r *http.Request) {
			serveXML(`<rss><channel><title>Moving</title>`+item("a", 1, srvURL)+item("b", 2, srvURL)+`</channel></rss>`)(w, r)
		},
	})
	srvURL = srv.URL
	id := e.subscribe(t, srv.URL+"/old")
	moved.Store(true)
	e.post(t, "/podcasts/refresh", map[string]string{"id": id})
	e.waitRefreshed(t)
	e.s.wg.Wait()
	p := list(e.get(t, "/podcasts")["podcasts"])
	if len(p) != 1 || p[0]["id"] != id || p[0]["url"] != srv.URL+"/new" || p[0]["episodeCount"] != 2.0 {
		t.Fatalf("%v", p)
	}
	// Both addresses are the same subscription.
	if e.subscribe(t, srv.URL+"/new") != id || e.subscribe(t, srv.URL+"/old") != id {
		t.Error("subscribed twice")
	}
}

func TestStateRoute(t *testing.T) {
	e := usePodcasts(t)
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": serveXML(`<rss><channel><title>S</title>` +
		item("a", 1, "https://m.example") + item("b", 2, "https://m.example") + `</channel></rss>`)})
	id := e.subscribe(t, srv.URL+"/feed")
	b := "podcast:" + id + "." + episodeKey("b")
	e.advance(time.Minute)
	ep := e.post(t, "/podcasts/state", map[string]interface{}{"id": b, "position_ms": 61000})["episode"].(map[string]interface{})
	if ep["position_ms"] != 61000.0 || ep["new"] != false || ep["lastPlayed"] != float64(e.now.Load()) || ep["played"] != false {
		t.Fatalf("position: %v", ep)
	}
	// The id as resolve takes it works too.
	ep = e.post(t, "/podcasts/state", map[string]interface{}{"id": id + "." + episodeKey("b"), "played": true})["episode"].(map[string]interface{})
	if ep["played"] != true || ep["position_ms"] != 0.0 {
		t.Fatalf("played: %v", ep)
	}
	ep = e.post(t, "/podcasts/state", map[string]interface{}{"id": b, "played": false, "new": true})["episode"].(map[string]interface{})
	if ep["played"] != false || ep["new"] != true {
		t.Fatalf("unplayed: %v", ep)
	}
	for _, c := range []struct {
		body interface{}
		code int
	}{
		{map[string]interface{}{"id": "podcast:" + id + ".0000000000000000", "played": true}, 404},
		{map[string]interface{}{"id": "podcast:../../etc", "played": true}, 400},
		{map[string]interface{}{"id": id, "played": true}, 400},
		{map[string]interface{}{"id": b, "position_ms": -1}, 400},
		{"{not json", 400},
		{`{"id": 5}`, 400},
	} {
		if code, out := e.call(t, http.MethodPost, "/podcasts/state", c.body); code != c.code {
			t.Errorf("%v: %d %v", c.body, code, out)
		}
	}
	if code, _ := e.call(t, http.MethodGet, "/podcasts/state", nil); code != http.StatusMethodNotAllowed {
		t.Errorf("GET state: %d", code)
	}
}

func TestMarkAll(t *testing.T) {
	e := usePodcasts(t)
	feed := &changingFeed{}
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": feed.handler})
	feed.set(item("a", 1, srv.URL), item("b", 2, srv.URL))
	id := e.subscribe(t, srv.URL+"/feed")
	e.post(t, "/podcasts/state", map[string]interface{}{"id": "podcast:" + id + "." + episodeKey("a"), "position_ms": 10})
	e.post(t, "/podcasts/markall", map[string]interface{}{"podcast": id, "new": true})
	for _, ep := range e.episodes(t, id) {
		if ep["new"] != true {
			t.Errorf("not new: %v", ep)
		}
	}
	e.post(t, "/podcasts/markall", map[string]interface{}{"podcast": id, "played": true})
	for _, ep := range e.episodes(t, id) {
		if ep["played"] != true || ep["new"] != false || ep["position_ms"] != 0.0 {
			t.Errorf("not played: %v", ep)
		}
	}
	if code, _ := e.call(t, http.MethodPost, "/podcasts/markall", map[string]interface{}{"podcast": id}); code != 400 {
		t.Errorf("nothing to mark: %d", code)
	}
	if code, _ := e.call(t, http.MethodPost, "/podcasts/markall", map[string]interface{}{"podcast": "abcdefabcdef", "new": false}); code != 404 {
		t.Errorf("unknown: %d", code)
	}
}

func TestPreviewSavesNothing(t *testing.T) {
	e := usePodcasts(t)
	items := ""
	for i := 0; i < 60; i++ {
		items += item(fmt.Sprintf("e%02d", i), i%28, "https://m.example")
	}
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": serveXML(`<rss><channel><title>P</title>` + items + `</channel></rss>`)})
	out := e.post(t, "/podcasts/preview", map[string]string{"url": srv.URL + "/feed"})
	if p := out["podcast"].(map[string]interface{}); p["title"] != "P" || p["id"] != podcastID(srv.URL+"/feed") || p["episodeCount"] != 60.0 {
		t.Errorf("podcast %v", p)
	}
	eps := list(out["episodes"])
	if len(eps) != 50 || eps[0]["new"] != false {
		t.Errorf("%d episodes, %v", len(eps), eps[0]["new"])
	}
	if len(list(e.get(t, "/podcasts")["podcasts"])) != 0 {
		t.Error("subscribed")
	}
	e.s.flush()
	if _, err := os.Stat(podcastStatePath); !os.IsNotExist(err) {
		t.Errorf("state written: %v", err)
	}
}

func TestEpisodesPaging(t *testing.T) {
	e := usePodcasts(t)
	items := ""
	for i := 0; i < 7; i++ {
		items += item(fmt.Sprintf("e%d", i), i, "https://m.example")
	}
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": serveXML(`<rss><channel><title>P</title>` + items + `</channel></rss>`)})
	id := e.subscribe(t, srv.URL+"/feed")
	got := []string{}
	offset := 0
	for pages := 0; pages < 10; pages++ {
		out := e.get(t, fmt.Sprintf("/podcasts/episodes?id=%s&offset=%d&limit=3", id, offset))
		got = append(got, titles(list(out["episodes"])))
		if out["more"] != true {
			if out["next"] != 0.0 {
				t.Errorf("next without more: %v", out["next"])
			}
			break
		}
		offset = int(out["next"].(float64))
	}
	if strings.Join(got, " | ") != "e6, e5, e4 | e3, e2, e1 | e0" {
		t.Errorf("pages: %v", got)
	}
	// Out of range values are clamped.
	if out := e.get(t, "/podcasts/episodes?id="+id+"&offset=-5&limit=99999"); len(list(out["episodes"])) != 7 || out["more"] != false {
		t.Errorf("clamped: %v", out)
	}
	if out := e.get(t, "/podcasts/episodes?id="+id+"&offset=100"); len(list(out["episodes"])) != 0 || out["more"] != false {
		t.Errorf("past the end: %v", out)
	}
	for q, code := range map[string]int{"id=xyz": 400, "id=": 400, "id=abcdefabcdef": 404, "id=" + id + "0": 400} {
		if c, _ := e.call(t, http.MethodGet, "/podcasts/episodes?"+q, nil); c != code {
			t.Errorf("%s: %d", q, c)
		}
	}
}

func TestNewAndInProgressLists(t *testing.T) {
	e := usePodcasts(t)
	f1 := &changingFeed{title: "Alpha"}
	f2 := &changingFeed{title: "Beta"}
	srv := feedServer(t, map[string]http.HandlerFunc{"/1": f1.handler, "/2": f2.handler})
	f1.set(item("a1", 1, srv.URL), item("a5", 5, srv.URL))
	f2.set(item("b3", 3, srv.URL), item("b7", 7, srv.URL))
	id1 := e.subscribe(t, srv.URL+"/1")
	id2 := e.subscribe(t, srv.URL+"/2")
	if got := titles(list(e.get(t, "/podcasts/new")["episodes"])); got != "b7, a5" {
		t.Errorf("new: %s", got)
	}
	f1.set(item("a1", 1, srv.URL), item("a5", 5, srv.URL), item("a6", 6, srv.URL))
	e.post(t, "/podcasts/refresh", nil)
	e.waitRefreshed(t)
	e.s.wg.Wait()
	if got := titles(list(e.get(t, "/podcasts/new")["episodes"])); got != "b7, a6, a5" {
		t.Errorf("new after refresh: %s", got)
	}
	if got := titles(list(e.get(t, "/podcasts/new?limit=1")["episodes"])); got != "b7" {
		t.Errorf("new, limit 1: %s", got)
	}
	// In progress: the last played first; a finished one is not.
	for _, s := range []struct{ id, key string }{{id1, "a1"}, {id2, "b3"}, {id1, "a5"}} {
		e.advance(time.Minute)
		e.post(t, "/podcasts/state", map[string]interface{}{"id": "podcast:" + s.id + "." + episodeKey(s.key), "position_ms": 1000})
	}
	e.post(t, "/podcasts/state", map[string]interface{}{"id": "podcast:" + id2 + "." + episodeKey("b3"), "played": true})
	if got := titles(list(e.get(t, "/podcasts/inprogress")["episodes"])); got != "a5, a1" {
		t.Errorf("in progress: %s", got)
	}
	if got := titles(list(e.get(t, "/podcasts/new")["episodes"])); got != "b7, a6" {
		t.Errorf("new after playing: %s", got)
	}
	ps := list(e.get(t, "/podcasts")["podcasts"])
	if ps[0]["title"] != "Alpha" || ps[1]["title"] != "Beta" {
		t.Errorf("by title: %v", ps)
	}
}

func TestSearchAndFallback(t *testing.T) {
	e := usePodcasts(t)
	var wosaMode atomic.Int32 // 0 ok, 1 down, 2 status error, 3 empty
	var wosaQuery, appleQuery atomic.Value
	srv := feedServer(t, map[string]http.HandlerFunc{
		"/search.php": func(w http.ResponseWriter, r *http.Request) {
			wosaQuery.Store(r.URL.RawQuery)
			switch wosaMode.Load() {
			case 1:
				http.Error(w, "down", http.StatusBadGateway)
			case 2:
				_, _ = w.Write([]byte(`{"status":"error","msg":"database"}`))
			case 3:
				_, _ = w.Write([]byte(`{"status":"true","feeds":[]}`))
			default:
				_, _ = w.Write([]byte(`{"status":"true","feeds":[
					{"id":197123,"title":"Radiolab","url":"https://feeds.example/radiolab","author":"WNYC","image":"https://img/i.jpg","artwork":"https://img/a.jpg","description":"<p>Curious &amp; more</p>"},
					{"id":2,"title":"No address","url":""},
					{"id":3,"title":"Radiolab","url":"https://feeds.example/radiolab"},
					{"id":4,"title":"Bad scheme","url":"javascript:x"}]}`))
			}
		},
		"/search": func(w http.ResponseWriter, r *http.Request) {
			appleQuery.Store(r.URL.RawQuery)
			_, _ = w.Write([]byte(`{"resultCount":1,"results":[{"collectionName":"Radiolab","feedUrl":"https://apple.example/feed","artistName":"WNYC Studios","artworkUrl600":"https://img/600.jpg"}]}`))
		},
		"/feed": serveXML(rssFeed),
	})
	podcastSearchBase, podcastITunesBase = srv.URL, srv.URL
	res := list(e.get(t, "/podcasts/search?q=radio+lab&limit=5")["results"])
	if len(res) != 1 || res[0]["title"] != "Radiolab" || res[0]["image"] != "https://img/a.jpg" ||
		res[0]["description"] != "Curious & more" || res[0]["subscribed"] != "" || res[0]["author"] != "WNYC" {
		t.Fatalf("directory: %v", res)
	}
	if q := wosaQuery.Load().(string); q != "max=5&q=radio+lab" {
		t.Errorf("query %q", q)
	}
	for mode := int32(1); mode <= 3; mode++ {
		wosaMode.Store(mode)
		res = list(e.get(t, "/podcasts/search?q=radiolab")["results"])
		if len(res) != 1 || res[0]["url"] != "https://apple.example/feed" || res[0]["image"] != "https://img/600.jpg" || res[0]["author"] != "WNYC Studios" {
			t.Errorf("mode %d: %v", mode, res)
		}
	}
	if q := appleQuery.Load().(string); q != "entity=podcast&limit=30&media=podcast&term=radiolab" {
		t.Errorf("apple query %q", q)
	}
	// subscribed: the id of the podcast of that address.
	wosaMode.Store(0)
	id := e.subscribe(t, srv.URL+"/feed")
	e.s.mu.Lock()
	e.s.feeds[id].URL = "https://feeds.example/radiolab" // as if it moved there
	e.s.mu.Unlock()
	if res = list(e.get(t, "/podcasts/search?q=radiolab")["results"]); res[0]["subscribed"] != id {
		t.Errorf("subscribed: %v", res[0])
	}
	if res = list(e.get(t, "/podcasts/search?q=++")["results"]); len(res) != 0 {
		t.Errorf("empty query: %v", res)
	}
	// Both down: an error.
	podcastSearchBase, podcastITunesBase = "http://127.0.0.1:1", "http://127.0.0.1:1"
	if code, _ := e.call(t, http.MethodGet, "/podcasts/search?q=x", nil); code != http.StatusBadGateway {
		t.Errorf("both down: %d", code)
	}
	if code, _ := e.call(t, http.MethodGet, "/podcasts/search?q="+strings.Repeat("x", 201), nil); code != http.StatusBadRequest {
		t.Errorf("long query: %d", code)
	}
}

func TestUnsubscribe(t *testing.T) {
	for _, del := range []bool{false, true} {
		t.Run(fmt.Sprint("delete=", del), func(t *testing.T) {
			e := usePodcasts(t)
			srv := feedServer(t, map[string]http.HandlerFunc{
				"/feed": func(w http.ResponseWriter, r *http.Request) {
					serveXML(`<rss><channel><title>Gone Soon</title>`+item("a", 1, "http://"+r.Host)+`</channel></rss>`)(w, r)
				},
				"/a.mp3": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("audio")) },
			})
			id := e.subscribe(t, srv.URL+"/feed")
			ep := "podcast:" + id + "." + episodeKey("a")
			e.post(t, "/podcasts/download", map[string]string{"id": ep})
			e.s.wg.Wait()
			file := e.post(t, "/podcasts/state", map[string]interface{}{"id": ep})["episode"].(map[string]interface{})["download"].(map[string]interface{})["path"].(string)
			if _, err := os.Stat(file); err != nil {
				t.Fatal(err)
			}
			e.post(t, "/podcasts/unsubscribe", map[string]interface{}{"id": id, "deleteDownloads": del})
			if len(list(e.get(t, "/podcasts")["podcasts"])) != 0 {
				t.Error("still subscribed")
			}
			_, err := os.Stat(file)
			if del != os.IsNotExist(err) {
				t.Errorf("file after unsubscribe: %v", err)
			}
			_, err = os.Stat(filepath.Dir(file))
			if del != os.IsNotExist(err) {
				t.Errorf("folder after unsubscribe: %v", err)
			}
			if code, _ := e.call(t, http.MethodPost, "/podcasts/unsubscribe", map[string]interface{}{"id": id}); code != 404 {
				t.Errorf("again: %d", code)
			}
		})
	}
}

func TestSettingsValidation(t *testing.T) {
	e := usePodcasts(t)
	got := e.get(t, "/podcasts/settings")
	want := map[string]interface{}{"refreshHours": 6.0, "wifiOnly": true, "autoDownload": 0.0, "keepPlayedDays": 7.0, "notify": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("defaults %v", got)
	}
	for _, h := range []int{0, 1, 3, 6, 12, 24} {
		if out := e.post(t, "/podcasts/settings", map[string]int{"refreshHours": h}); out["refreshHours"] != float64(h) {
			t.Errorf("%d: %v", h, out)
		}
	}
	for _, bad := range []map[string]interface{}{
		{"refreshHours": 2}, {"refreshHours": -1}, {"refreshHours": 48}, {"autoDownload": -1}, {"autoDownload": 51},
		{"keepPlayedDays": -1}, {"keepPlayedDays": 100000}, {"wifiOnly": "yes"},
	} {
		if code, _ := e.call(t, http.MethodPost, "/podcasts/settings", bad); code != 400 {
			t.Errorf("%v: %d", bad, code)
		}
	}
	out := e.post(t, "/podcasts/settings", map[string]interface{}{"wifiOnly": false, "notify": false, "autoDownload": 3})
	if out["wifiOnly"] != false || out["notify"] != false || out["autoDownload"] != 3.0 || out["refreshHours"] != 24.0 || out["keepPlayedDays"] != 7.0 {
		t.Errorf("subset: %v", out)
	}
	// A new subscription takes the default autoDownload.
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": serveXML(`<rss><channel><title>T</title></channel></rss>`)})
	id := e.subscribe(t, srv.URL+"/feed")
	e.s.wg.Wait()
	if p := list(e.get(t, "/podcasts")["podcasts"])[0]; p["autoDownload"] != 3.0 {
		t.Errorf("autoDownload %v", p["autoDownload"])
	}
	if p := e.post(t, "/podcasts/feedsettings", map[string]interface{}{"id": id, "autoDownload": 0})["podcast"].(map[string]interface{}); p["autoDownload"] != 0.0 {
		t.Errorf("feedsettings %v", p)
	}
	for _, bad := range []map[string]interface{}{{"id": id}, {"id": id, "autoDownload": 99}, {"id": "nope", "autoDownload": 1}} {
		if code, _ := e.call(t, http.MethodPost, "/podcasts/feedsettings", bad); code != 400 {
			t.Errorf("%v: %d", bad, code)
		}
	}
}

func TestRoutesRefuseWrongMethodsAndBigBodies(t *testing.T) {
	e := usePodcasts(t)
	for _, p := range []string{"/podcasts/search", "/podcasts/episodes", "/podcasts/new", "/podcasts/inprogress",
		"/podcasts/downloads", "/podcasts/opml", "/podcasts/opml/files", "/podcasts"} {
		if code, _ := e.call(t, http.MethodPost, p, nil); code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s: %d", p, code)
		}
	}
	for _, p := range []string{"/podcasts/preview", "/podcasts/subscribe", "/podcasts/unsubscribe", "/podcasts/state",
		"/podcasts/markall", "/podcasts/refresh", "/podcasts/download", "/podcasts/download/cancel",
		"/podcasts/download/delete", "/podcasts/resolve", "/podcasts/opml/export", "/podcasts/opml/import", "/podcasts/feedsettings"} {
		if code, _ := e.call(t, http.MethodGet, p, nil); code != http.StatusMethodNotAllowed {
			t.Errorf("GET %s: %d", p, code)
		}
	}
	big := `{"url":"` + strings.Repeat("a", podcastBodyLimit) + `"}`
	if code, _ := e.call(t, http.MethodPost, "/podcasts/subscribe", big); code != http.StatusRequestEntityTooLarge {
		t.Errorf("big body: %d", code)
	}
	if code, _ := e.call(t, http.MethodOptions, "/podcasts/subscribe", nil); code != http.StatusNoContent {
		t.Errorf("OPTIONS: %d", code)
	}
	pods = nil
	if code, _ := e.call(t, http.MethodGet, "/podcasts", nil); code != http.StatusServiceUnavailable {
		t.Errorf("not started: %d", code)
	}
	pods = e.s
}

func TestPersistence(t *testing.T) {
	e := usePodcasts(t)
	feed := &changingFeed{}
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": feed.handler})
	feed.set(item("a", 1, srv.URL), item("b", 2, srv.URL))
	id := e.subscribe(t, srv.URL+"/feed")
	e.post(t, "/podcasts/state", map[string]interface{}{"id": "podcast:" + id + "." + episodeKey("a"), "position_ms": 1234})
	e.post(t, "/podcasts/settings", map[string]interface{}{"refreshHours": 12, "notify": false})
	before := e.get(t, "/podcasts/episodes?id="+id)
	beforeList := e.get(t, "/podcasts")
	e.s.flush()
	fi, err := os.Stat(podcastStatePath)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("state file: %v %v", err, fi)
	}
	if _, err := os.Stat(podcastStatePath + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("tmp left: %v", err)
	}
	pods = loadPodcastStore(podcastStatePath)
	if got := e.get(t, "/podcasts/episodes?id="+id); !reflect.DeepEqual(got, before) {
		t.Errorf("episodes differ:\n%v\n%v", got, before)
	}
	if got := e.get(t, "/podcasts"); !reflect.DeepEqual(got, beforeList) {
		t.Errorf("podcasts differ:\n%v\n%v", got, beforeList)
	}
	if st := e.get(t, "/podcasts/settings"); st["refreshHours"] != 12.0 || st["notify"] != false {
		t.Errorf("settings %v", st)
	}
	// The ETag came along: the next refresh is a 304.
	pods.mu.Lock()
	etag := pods.feeds[id].ETag
	pods.mu.Unlock()
	if etag != `"v1"` {
		t.Errorf("etag %q", etag)
	}
	pods.close()
	pods = e.s
	// A file that cannot be read is kept aside.
	if err := os.WriteFile(podcastStatePath, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s := loadPodcastStore(podcastStatePath); len(s.feeds) != 0 {
		t.Error("broken file read")
	}
	if _, err := os.Stat(podcastStatePath + ".bad"); err != nil {
		t.Errorf("not kept aside: %v", err)
	}
}

func TestSaveIsDebouncedButFlushes(t *testing.T) {
	e := usePodcasts(t)
	podcastSaveDelay = 30 * time.Millisecond
	for i := 0; i < 20; i++ {
		e.post(t, "/podcasts/settings", map[string]interface{}{"autoDownload": i})
	}
	waitFor(t, "the state file", func() bool {
		b, err := os.ReadFile(podcastStatePath)
		return err == nil && bytes.Contains(b, []byte(`"autoDownload":19`))
	})
}

func TestTrimEpisodesKeepsNewestAndDownloads(t *testing.T) {
	f := &pcFeed{ID: "abcdefabcdef"}
	p := &parsedFeed{Title: "Big"}
	for i := 0; i < podcastMaxEpisodes+10; i++ {
		p.Episodes = append(p.Episodes, parsedEpisode{GUID: fmt.Sprint(i), URL: "https://x/" + fmt.Sprint(i), Published: int64(i+1) * 1000})
	}
	mergeFeed(f, p, true)
	if len(f.Episodes) != podcastMaxEpisodes || f.Episodes[len(f.Episodes)-1].Published != 11000 || len(f.index) != podcastMaxEpisodes {
		t.Fatalf("%d, oldest %d", len(f.Episodes), f.Episodes[len(f.Episodes)-1].Published)
	}
	// The oldest has a download: it stays.
	f.Episodes[len(f.Episodes)-1].Download.State = dlDone
	p.Episodes = append(p.Episodes, parsedEpisode{GUID: "newest", URL: "https://x/n", Published: 1e12})
	mergeFeed(f, p, false)
	if len(f.Episodes) != podcastMaxEpisodes || f.Episodes[len(f.Episodes)-1].Published != 11000 || f.Episodes[len(f.Episodes)-2].Published != 13000 {
		t.Errorf("after: %d %d %d", len(f.Episodes), f.Episodes[len(f.Episodes)-1].Published, f.Episodes[len(f.Episodes)-2].Published)
	}
}

// --- the background ------------------------------------------------------------------

// timedFixture is two podcasts with a new episode to come, for the timed
// refresh.
func timedFixture(t *testing.T, e *podEnv) (*changingFeed, *changingFeed, string) {
	f1 := &changingFeed{title: "Alpha"}
	f2 := &changingFeed{title: "Beta"}
	srv := feedServer(t, map[string]http.HandlerFunc{
		"/1": f1.handler, "/2": f2.handler,
		"/a.mp3": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("A")) },
		"/b.mp3": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("B")) },
		"/c.mp3": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("C")) },
	})
	f1.set(item("a", 1, srv.URL))
	f2.set(item("x", 1, srv.URL))
	e.subscribe(t, srv.URL+"/1")
	e.subscribe(t, srv.URL+"/2")
	return f1, f2, srv.URL
}

func TestTimedRefreshDueAndNotDue(t *testing.T) {
	e := usePodcasts(t)
	f1, _, _ := timedFixture(t, e)
	e.s.tick() // the first one: due
	if f1.count() != 2 {
		t.Fatalf("first tick: %d reads", f1.count())
	}
	e.advance(5*time.Hour + 59*time.Minute)
	e.s.tick()
	if f1.count() != 2 {
		t.Errorf("before 6 h: %d reads", f1.count())
	}
	e.advance(time.Minute)
	e.s.tick()
	if f1.count() != 3 {
		t.Errorf("at 6 h: %d reads", f1.count())
	}
	e.post(t, "/podcasts/settings", map[string]int{"refreshHours": 0})
	e.advance(48 * time.Hour)
	e.s.tick()
	if f1.count() != 3 {
		t.Errorf("refreshHours 0: %d reads", f1.count())
	}
	e.post(t, "/podcasts/settings", map[string]int{"refreshHours": 1})
	e.s.tick()
	if f1.count() != 4 {
		t.Errorf("refreshHours 1: %d reads", f1.count())
	}
	// The clock going back is due as well.
	e.advance(-24 * time.Hour)
	e.s.tick()
	if f1.count() != 5 {
		t.Errorf("clock back: %d reads", f1.count())
	}
}

func TestTimedRefreshNotifiesOnce(t *testing.T) {
	e := usePodcasts(t)
	f1, f2, base := timedFixture(t, e)
	e.s.tick()
	if n := len(e.toasts()); n != 0 {
		t.Fatalf("nothing new, %d notifications", n)
	}
	f1.set(item("a", 1, base), item("b", 2, base), item("c", 3, base))
	f2.set(item("x", 1, base), item("y", 2, base))
	e.advance(6 * time.Hour)
	e.s.tick()
	toasts := e.toasts()
	if len(toasts) != 1 {
		t.Fatalf("%d notifications", len(toasts))
	}
	var p map[string]interface{}
	if err := json.Unmarshal([]byte(toasts[0]), &p); err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{"sourceId": "org.webosports.app.music", "message": "3 new episodes: Alpha...",
		"onclick":  map[string]interface{}{"appId": "org.webosports.app.music", "params": map[string]interface{}{"category": "podcasts"}},
		"noaction": false}
	if !reflect.DeepEqual(p, want) {
		t.Errorf("toast %v", p)
	}
	// A refresh asked for by the app notifies nothing.
	f2.set(item("x", 1, base), item("y", 2, base), item("z", 3, base))
	e.post(t, "/podcasts/refresh", nil)
	e.waitRefreshed(t)
	e.s.wg.Wait()
	if n := len(e.toasts()); n != 1 {
		t.Errorf("asked refresh: %d notifications", n)
	}
	// Notify off: none.
	e.post(t, "/podcasts/settings", map[string]bool{"notify": false})
	f2.set(item("x", 1, base), item("y", 2, base), item("z", 3, base), item("w", 4, base))
	e.advance(6 * time.Hour)
	e.s.tick()
	if n := len(e.toasts()); n != 1 {
		t.Errorf("notify off: %d notifications", n)
	}
	// One podcast, one episode.
	e.post(t, "/podcasts/settings", map[string]bool{"notify": true})
	f2.set(item("x", 1, base), item("y", 2, base), item("z", 3, base), item("w", 4, base), item("v", 5, base))
	e.advance(6 * time.Hour)
	e.s.tick()
	if ts := e.toasts(); len(ts) != 2 || !strings.Contains(ts[1], `"message":"1 new episode: Beta"`) {
		t.Errorf("toasts %v", ts)
	}
}

func TestAutoDownloadHonoursWifi(t *testing.T) {
	e := usePodcasts(t)
	f1, _, base := timedFixture(t, e)
	f1.set(item("a", 1, base), item("b", 2, base), item("c", 3, base))
	ids := list(e.get(t, "/podcasts")["podcasts"])
	alpha := ids[0]["id"].(string)
	e.post(t, "/podcasts/state", map[string]interface{}{"id": "podcast:" + alpha + "." + episodeKey("a"), "played": true})
	e.post(t, "/podcasts/feedsettings", map[string]interface{}{"id": alpha, "autoDownload": 2})
	e.s.wg.Wait()
	for _, wifi := range []string{"fail", "disconnected"} {
		e.mu.Lock()
		e.wifi = wifi
		e.mu.Unlock()
		e.advance(7 * time.Hour)
		e.s.tick()
		e.s.wg.Wait()
		if d := list(e.get(t, "/podcasts/downloads")["episodes"]); len(d) != 0 {
			t.Errorf("wifi %s: %s", wifi, titles(d))
		}
	}
	e.mu.Lock()
	e.wifi = "connected"
	e.mu.Unlock()
	e.advance(7 * time.Hour)
	e.s.tick()
	e.s.wg.Wait()
	// The newest two: c and b (a is played).
	d := list(e.get(t, "/podcasts/downloads")["episodes"])
	if titles(d) != "c, b" {
		t.Fatalf("downloads: %s", titles(d))
	}
	// Off Wi-Fi it downloads when wifiOnly is off.
	e.post(t, "/podcasts/settings", map[string]bool{"wifiOnly": false})
	e.mu.Lock()
	e.wifi = "disconnected"
	e.mu.Unlock()
	e.post(t, "/podcasts/download/delete", map[string]string{"id": d[0]["id"].(string)}) // c, removed by the user: not again
	e.post(t, "/podcasts/state", map[string]interface{}{"id": d[1]["id"].(string), "played": true})
	e.post(t, "/podcasts/state", map[string]interface{}{"id": "podcast:" + alpha + "." + episodeKey("a"), "played": false})
	e.advance(7 * time.Hour)
	e.s.tick()
	e.s.wg.Wait()
	if got := titles(list(e.get(t, "/podcasts/downloads")["episodes"])); got != "b, a" {
		t.Errorf("after: %s", got)
	}
}

func TestPruneAfterKeepPlayedDays(t *testing.T) {
	e := usePodcasts(t)
	_, _, _ = timedFixture(t, e)
	alpha := list(e.get(t, "/podcasts")["podcasts"])[0]["id"].(string)
	ep := "podcast:" + alpha + "." + episodeKey("a")
	e.post(t, "/podcasts/download", map[string]string{"id": ep})
	e.s.wg.Wait()
	path := list(e.get(t, "/podcasts/downloads")["episodes"])[0]["download"].(map[string]interface{})["path"].(string)
	e.post(t, "/podcasts/state", map[string]interface{}{"id": ep, "played": true})
	e.post(t, "/podcasts/settings", map[string]int{"refreshHours": 0})
	e.advance(7*24*time.Hour - time.Minute)
	e.s.tick()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("pruned early: %v", err)
	}
	e.advance(2 * time.Minute)
	e.s.tick()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("not pruned: %v", err)
	}
	if d := list(e.get(t, "/podcasts/downloads")["episodes"]); len(d) != 0 {
		t.Errorf("downloads %v", d)
	}
	// keepPlayedDays 0 keeps them.
	e.post(t, "/podcasts/settings", map[string]int{"keepPlayedDays": 0})
	e.post(t, "/podcasts/download", map[string]string{"id": ep})
	e.s.wg.Wait()
	e.advance(365 * 24 * time.Hour)
	e.s.tick()
	if d := list(e.get(t, "/podcasts/downloads")["episodes"]); len(d) != 1 {
		t.Errorf("keep 0: %v", d)
	}
}
