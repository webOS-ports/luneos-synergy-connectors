package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// gatedMedia serves episode files that stop halfway until let go.
type gatedMedia struct {
	mu      sync.Mutex
	gates   map[string]chan struct{}
	started map[string]bool
	status  map[string]int
}

func newGatedMedia() *gatedMedia {
	return &gatedMedia{gates: map[string]chan struct{}{}, started: map[string]bool{}, status: map[string]int{}}
}

func (g *gatedMedia) gate(name string) chan struct{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.gates[name] == nil {
		g.gates[name] = make(chan struct{})
	}
	return g.gates[name]
}

func (g *gatedMedia) release(name string) { close(g.gate(name)) }

func (g *gatedMedia) isStarted(name string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.started[name]
}

// handler serves /<name>.mp3: 1000 bytes, 400 of them before its gate.
func (g *gatedMedia) handler(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"), ".mp3")
	g.mu.Lock()
	g.started[name] = true
	code := g.status[name]
	g.mu.Unlock()
	if code != 0 {
		http.Error(w, "no", code)
		return
	}
	gate := g.gate(name)
	w.Header().Set("Content-Length", "1000")
	w.Header().Set("Content-Type", "audio/mpeg")
	_, _ = w.Write([]byte(strings.Repeat("a", 400)))
	w.(http.Flusher).Flush()
	select {
	case <-gate:
	case <-r.Context().Done():
		return
	}
	_, _ = w.Write([]byte(strings.Repeat("b", 600)))
}

// mediaFixture is a podcast whose episodes are the gated files names.
func mediaFixture(t *testing.T, e *podEnv, title string, names ...string) (string, *gatedMedia) {
	g := newGatedMedia()
	var base string
	routes := map[string]http.HandlerFunc{"/feed": func(w http.ResponseWriter, r *http.Request) {
		items := ""
		for i, n := range names {
			items += item(n, len(names)-i, base)
		}
		serveXML(`<rss><channel><title>`+title+`</title>`+items+`</channel></rss>`)(w, r)
	}}
	for _, n := range names {
		routes["/"+n+".mp3"] = g.handler
	}
	srv := feedServer(t, routes)
	base = srv.URL
	return e.subscribe(t, srv.URL+"/feed"), g
}

func epID(podcast, guid string) string { return "podcast:" + podcast + "." + episodeKey(guid) }

func (e *podEnv) download(t *testing.T, id string) map[string]interface{} {
	t.Helper()
	ep := e.episode(t, id)
	return ep["download"].(map[string]interface{})
}

// episode is one episode as the routes give it.
func (e *podEnv) episode(t *testing.T, id string) map[string]interface{} {
	t.Helper()
	return e.post(t, "/podcasts/state", map[string]interface{}{"id": id})["episode"].(map[string]interface{})
}

func (e *podEnv) state(t *testing.T, id string) string {
	t.Helper()
	return e.download(t, id)["state"].(string)
}

func TestDownloadProgressAndDone(t *testing.T) {
	e := usePodcasts(t)
	pid, g := mediaFixture(t, e, "My: Show/Part 2", "ep one")
	id := epID(pid, "ep one")
	if st := e.post(t, "/podcasts/download", map[string]string{"id": id})["episode"].(map[string]interface{})["download"].(map[string]interface{})["state"]; st != "queued" && st != "downloading" {
		t.Fatalf("state %v", st)
	}
	waitFor(t, "400 bytes", func() bool { return e.download(t, id)["bytes"] == 400.0 })
	d := e.download(t, id)
	if d["state"] != "downloading" || d["progress"] != 0.4 || d["path"] != "" {
		t.Errorf("midway: %v", d)
	}
	if out := e.get(t, "/podcasts"); out["downloading"] != 1.0 {
		t.Errorf("downloading %v", out["downloading"])
	}
	g.release("ep one")
	e.s.wg.Wait()
	d = e.download(t, id)
	want := filepath.Join(e.files, "My - Show-Part 2", "2026-10-02 ep one.mp3")
	if d["state"] != "done" || d["progress"] != 1.0 || d["bytes"] != 1000.0 || d["path"] != want || d["error"] != "" {
		t.Fatalf("done: %v (want %s)", d, want)
	}
	b, err := os.ReadFile(want)
	if err != nil || len(b) != 1000 {
		t.Fatalf("file: %v %d", err, len(b))
	}
	if _, err := os.Stat(want + ".part"); !os.IsNotExist(err) {
		t.Errorf(".part left: %v", err)
	}
	// Asked again while done: nothing happens.
	if st := e.post(t, "/podcasts/download", map[string]string{"id": id})["episode"].(map[string]interface{})["download"].(map[string]interface{})["state"]; st != "done" {
		t.Errorf("again: %v", st)
	}
}

func TestDownloadCancel(t *testing.T) {
	e := usePodcasts(t)
	pid, g := mediaFixture(t, e, "Cancel", "c1")
	id := epID(pid, "c1")
	e.post(t, "/podcasts/download", map[string]string{"id": id})
	waitFor(t, "the download", func() bool { return e.download(t, id)["bytes"] == 400.0 })
	part := filepath.Join(e.files, "Cancel", "2026-10-02 c1.mp3.part")
	if _, err := os.Stat(part); err != nil {
		t.Fatalf("part: %v", err)
	}
	ep := e.post(t, "/podcasts/download/cancel", map[string]string{"id": id})["episode"].(map[string]interface{})
	if ep["download"].(map[string]interface{})["state"] != "none" {
		t.Errorf("after cancel: %v", ep["download"])
	}
	e.s.wg.Wait()
	if _, err := os.Stat(part); !os.IsNotExist(err) {
		t.Errorf("part after cancel: %v", err)
	}
	if st := e.state(t, id); st != "none" {
		t.Errorf("state %s", st)
	}
	_ = g
	if d := list(e.get(t, "/podcasts/downloads")["episodes"]); len(d) != 0 {
		t.Errorf("downloads: %v", d)
	}
}

func TestDownloadFailureKeepsError(t *testing.T) {
	e := usePodcasts(t)
	pid, g := mediaFixture(t, e, "Fail", "f1")
	g.mu.Lock()
	g.status["f1"] = http.StatusNotFound
	g.mu.Unlock()
	id := epID(pid, "f1")
	e.post(t, "/podcasts/download", map[string]string{"id": id})
	e.s.wg.Wait()
	d := e.download(t, id)
	if d["state"] != "failed" || !strings.Contains(d["error"].(string), "HTTP 404") {
		t.Fatalf("%v", d)
	}
	if got := list(e.get(t, "/podcasts/downloads")["episodes"]); len(got) != 1 {
		t.Errorf("downloads %v", got)
	}
	// Tried again, it works.
	g.mu.Lock()
	g.status["f1"] = 0
	g.mu.Unlock()
	g.release("f1")
	e.post(t, "/podcasts/download", map[string]string{"id": id})
	e.s.wg.Wait()
	if st := e.state(t, id); st != "done" {
		t.Errorf("retry: %s", st)
	}
}

func TestDownloadStall(t *testing.T) {
	e := usePodcasts(t)
	podcastStall = 100 * time.Millisecond
	pid, _ := mediaFixture(t, e, "Stall", "s1")
	id := epID(pid, "s1")
	e.post(t, "/podcasts/download", map[string]string{"id": id})
	e.s.wg.Wait()
	if d := e.download(t, id); d["state"] != "failed" || d["error"] != "the download stalled" {
		t.Errorf("%v", d)
	}
}

func TestDownloadTwoAtOnceRestQueued(t *testing.T) {
	e := usePodcasts(t)
	pid, g := mediaFixture(t, e, "Queue", "q1", "q2", "q3", "q4")
	ids := []string{epID(pid, "q1"), epID(pid, "q2"), epID(pid, "q3"), epID(pid, "q4")}
	for _, id := range ids {
		e.post(t, "/podcasts/download", map[string]string{"id": id})
	}
	waitFor(t, "two started", func() bool { return g.isStarted("q1") && g.isStarted("q2") })
	states := func() string {
		s := []string{}
		for _, id := range ids {
			s = append(s, e.state(t, id))
		}
		return strings.Join(s, " ")
	}
	if got := states(); got != "downloading downloading queued queued" {
		t.Fatalf("states %s", got)
	}
	if g.isStarted("q3") {
		t.Fatal("a third started")
	}
	// The list: running, then queued in their order.
	if got := titles(list(e.get(t, "/podcasts/downloads")["episodes"])); got != "q1, q2, q3, q4" {
		t.Errorf("list: %s", got)
	}
	if out := e.get(t, "/podcasts"); out["downloading"] != 4.0 {
		t.Errorf("downloading %v", out["downloading"])
	}
	// One queued taken out of the queue.
	e.post(t, "/podcasts/download/cancel", map[string]string{"id": ids[3]})
	g.release("q2")
	waitFor(t, "q3 started", func() bool { return g.isStarted("q3") })
	if got := states(); got != "downloading done downloading none" {
		t.Errorf("states %s", got)
	}
	g.release("q1")
	g.release("q3")
	e.s.wg.Wait()
	if got := states(); got != "done done done none" {
		t.Errorf("states %s", got)
	}
	if g.isStarted("q4") {
		t.Error("the cancelled one started")
	}
	// Done ones, newest first.
	if got := titles(list(e.get(t, "/podcasts/downloads")["episodes"])); got != "q1, q2, q3" {
		t.Errorf("list: %s", got)
	}
}

func TestDownloadRefusedOnLowDisk(t *testing.T) {
	e := usePodcasts(t)
	// The feed says the size: refused at once.
	srv := feedServer(t, map[string]http.HandlerFunc{
		"/feed": serveXML(`<rss><channel><title>Big</title><item><guid>big</guid><title>Big</title>` +
			`<enclosure url="http://127.0.0.1:1/big.mp3" type="audio/mpeg" length="100000000"/></item></channel></rss>`),
	})
	pid := e.subscribe(t, srv.URL+"/feed")
	e.free.Store(100000000 + podcastSpaceMargin - 1)
	if code, out := e.call(t, http.MethodPost, "/podcasts/download", map[string]string{"id": epID(pid, "big")}); code != http.StatusInsufficientStorage {
		t.Errorf("refused: %d %v", code, out)
	}
	if st := e.state(t, epID(pid, "big")); st != "none" {
		t.Errorf("state %s", st)
	}
	// Known only from the answer's Content-Length: it fails there.
	pid2, g := mediaFixture(t, e, "Small", "m1")
	g.release("m1")
	e.free.Store(podcastSpaceMargin + 999)
	e.post(t, "/podcasts/download", map[string]string{"id": epID(pid2, "m1")})
	e.s.wg.Wait()
	if d := e.download(t, epID(pid2, "m1")); d["state"] != "failed" || !strings.Contains(d["error"].(string), "free space") {
		t.Errorf("%v", d)
	}
	e.free.Store(podcastSpaceMargin + 1000)
	e.post(t, "/podcasts/download", map[string]string{"id": epID(pid2, "m1")})
	e.s.wg.Wait()
	if st := e.state(t, epID(pid2, "m1")); st != "done" {
		t.Errorf("with room: %s", st)
	}
}

func TestPodcastFileName(t *testing.T) {
	for in, want := range map[string]string{
		"../../etc/passwd":   "-..-etc-passwd",
		"..":                 "Episode",
		".hidden":            "hidden",
		"   ":                "Episode",
		"a/b\\c|d":           "a-b-c-d",
		"Q: what? <yes>*":    "Q - what yes",
		"tab\there\nnew\x00": "tab here new",
		"end with dots...":   "end with dots",
		`say "hi"`:           "say 'hi'",
		"bad \xff byte":      "bad _ byte",
		"Café — ünïcode":     "Café — ünïcode",
		" line separator":    "line separator",
	} {
		if got := podcastFileName(in, "Episode", podcastMaxName); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("é", 300) // 600 bytes
	got := podcastFileName(long, "x", podcastMaxName)
	if len(got) >= 200 || !utf8.ValidString(got) {
		t.Errorf("long: %d bytes, valid %v", len(got), utf8.ValidString(got))
	}
	if s := podcastStem(time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC).UnixMilli(), long); len(s+" (99).mp3.part") >= 220 || !strings.HasPrefix(s, "2026-01-02 ") {
		t.Errorf("stem %d bytes", len(s))
	}
	if s := podcastStem(0, "x"); s != "x" {
		t.Errorf("undated stem %q", s)
	}
	for _, c := range [][3]string{
		{"https://x/a.M4A?x=1", "", ".m4a"}, {"https://x/a", "audio/mpeg", ".mp3"}, {"https://x/a", "video/mp4; codecs=x", ".mp4"},
		{"https://x/a.php", "audio/ogg", ".ogg"}, {"https://x/a", "", ".mp3"}, {"https://x/a.exe", "application/x-foo", ".mp3"},
	} {
		if got := podcastExt(c[0], c[1]); got != c[2] {
			t.Errorf("%v: %s", c, got)
		}
	}
}

func TestDownloadNamesUniqueAndSafe(t *testing.T) {
	e := usePodcasts(t)
	var base string
	srv := feedServer(t, map[string]http.HandlerFunc{
		"/feed": func(w http.ResponseWriter, r *http.Request) {
			serveXML(`<rss><channel><title>../../escape</title>`+
				`<item><guid>1</guid><title>../same</title><pubDate>Mon, 02 Nov 2026 10:00:00 +0000</pubDate><enclosure url="`+base+`/1.mp3"/></item>`+
				`<item><guid>2</guid><title>../same</title><pubDate>Mon, 02 Nov 2026 11:00:00 +0000</pubDate><enclosure url="`+base+`/2.mp3"/></item>`+
				`</channel></rss>`)(w, r)
		},
		"/1.mp3": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("one")) },
		"/2.mp3": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("two")) },
	})
	base = srv.URL
	pid := e.subscribe(t, srv.URL+"/feed")
	e.post(t, "/podcasts/download", map[string]string{"id": epID(pid, "1")})
	e.s.wg.Wait()
	e.post(t, "/podcasts/download", map[string]string{"id": epID(pid, "2")})
	e.s.wg.Wait()
	p1 := e.download(t, epID(pid, "1"))["path"].(string)
	p2 := e.download(t, epID(pid, "2"))["path"].(string)
	dir := filepath.Join(e.files, "-..-escape")
	if p1 != filepath.Join(dir, "2026-11-02 -same.mp3") || p2 != filepath.Join(dir, "2026-11-02 -same (2).mp3") {
		t.Errorf("paths %q %q", p1, p2)
	}
	if b, _ := os.ReadFile(p2); string(b) != "two" {
		t.Errorf("p2 holds %q", b)
	}
	entries, _ := os.ReadDir(e.root)
	if len(entries) != 1 || entries[0].Name() != "podcasts" {
		t.Errorf("outside the folder: %v", entries)
	}
}

func TestResolve(t *testing.T) {
	e := usePodcasts(t)
	pid, g := mediaFixture(t, e, "Resolve", "r1")
	id := epID(pid, "r1")
	enclosure := e.episode(t, id)["url"].(string)
	resolve := func(track string) (string, bool) {
		out := e.post(t, "/podcasts/resolve", map[string]string{"trackId": track})
		return out["url"].(string), out["video"].(bool)
	}
	trackID := strings.TrimPrefix(id, "podcast:")
	if u, v := resolve(trackID); u != enclosure || v {
		t.Errorf("not downloaded: %s %v", u, v)
	}
	g.release("r1")
	e.post(t, "/podcasts/download", map[string]string{"id": id})
	e.s.wg.Wait()
	path := e.download(t, id)["path"].(string)
	want := "file://" + strings.ReplaceAll(path, " ", "%20")
	if u, _ := resolve(trackID); u != want {
		t.Errorf("downloaded: %s, want %s", u, want)
	}
	// Removed over USB: the enclosure again.
	if err := os.Rename(path, path+".moved"); err != nil {
		t.Fatal(err)
	}
	if u, _ := resolve(trackID); u != enclosure {
		t.Errorf("file gone: %s", u)
	}
	_ = os.Rename(path+".moved", path)
	// A path outside the folder (an edited state file) is never given, nor
	// removed; nor a link in the folder that points out of it, nor a file
	// in a linked folder.
	outside := filepath.Join(t.TempDir(), "secret.mp3")
	if err := os.WriteFile(outside, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(e.files, "Resolve", "link.mp3")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(e.files, "linked dir")
	if err := os.Symlink(filepath.Dir(outside), linkDir); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{outside, link, filepath.Join(linkDir, "secret.mp3"), filepath.Join(e.files, "..", "..", strings.TrimPrefix(outside, "/")), e.files, "relative.mp3"} {
		e.s.mu.Lock()
		_, ep := e.s.lookupLocked(trackID)
		ep.Download.Path = p
		e.s.mu.Unlock()
		if u, _ := resolve(trackID); u != enclosure {
			t.Errorf("%s: resolved to %s", p, u)
		}
		e.post(t, "/podcasts/download/delete", map[string]string{"id": id})
		if _, err := os.Stat(outside); err != nil {
			t.Fatalf("%s: the file outside was removed", p)
		}
		e.s.mu.Lock()
		ep.Download = pcDownload{State: dlDone, Path: path}
		e.s.mu.Unlock()
	}
	// Delete removes the real one.
	if st := e.post(t, "/podcasts/download/delete", map[string]string{"id": id})["episode"].(map[string]interface{})["download"].(map[string]interface{})["state"]; st != "none" {
		t.Errorf("state after delete %v", st)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("not deleted: %v", err)
	}
	for _, bad := range []map[string]string{{"trackId": "x"}, {"trackId": ""}, {"trackId": pid + ".zzzz"}} {
		if code, _ := e.call(t, http.MethodPost, "/podcasts/resolve", bad); code != 400 {
			t.Errorf("%v: %d", bad, code)
		}
	}
	if code, _ := e.call(t, http.MethodPost, "/podcasts/resolve", map[string]string{"trackId": pid + ".0123456789abcdef"}); code != 404 {
		t.Errorf("unknown: %d", code)
	}
	// A video episode says so.
	e.s.mu.Lock()
	_, ep := e.s.lookupLocked(trackID)
	ep.Type = "video/mp4"
	e.s.mu.Unlock()
	if _, v := resolve(trackID); !v {
		t.Error("not video")
	}
}

func TestDownloadsResumeAfterRestart(t *testing.T) {
	e := usePodcasts(t)
	pid, g := mediaFixture(t, e, "Restart", "x1")
	id := epID(pid, "x1")
	e.post(t, "/podcasts/download", map[string]string{"id": id})
	waitFor(t, "the download", func() bool { return e.download(t, id)["bytes"] == 400.0 })
	e.s.close() // as at shutdown: queued again
	s := loadPodcastStore(podcastStatePath)
	pods = s
	if st := e.state(t, id); st != "queued" {
		t.Fatalf("after restart: %s", st)
	}
	g.release("x1")
	s.mu.Lock()
	s.kickLocked()
	s.mu.Unlock()
	s.wg.Wait()
	if st := e.state(t, id); st != "done" {
		t.Errorf("resumed: %s", st)
	}
	s.close()
	e.s = s
}
