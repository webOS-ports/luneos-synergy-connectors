package main

import (
	"encoding/xml"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// opmlServer serves feeds /a, /b and /c, and /bad, which is none.
func opmlServer(t *testing.T) string {
	srv := feedServer(t, map[string]http.HandlerFunc{
		"/a":   serveXML(`<rss><channel><title>Alpha &amp; "Co"</title><link>https://a.example/</link>` + item("a1", 1, "https://m.example") + `</channel></rss>`),
		"/b":   serveXML(`<rss><channel><title>Beta</title>` + item("b1", 1, "https://m.example") + `</channel></rss>`),
		"/c":   serveXML(`<rss><channel><title>Gamma</title></channel></rss>`),
		"/bad": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>nope</html>")) },
	})
	return srv.URL
}

func TestOPMLRoundTrip(t *testing.T) {
	e := usePodcasts(t)
	base := opmlServer(t)
	e.subscribe(t, base+"/a")
	e.subscribe(t, base+"/b")
	_, out := e.call(t, http.MethodGet, "/podcasts/opml", nil)
	doc := out["body"].(string)
	var parsed struct {
		XMLName xml.Name `xml:"opml"`
		Version string   `xml:"version,attr"`
		Body    struct {
			Outlines []struct {
				Type    string `xml:"type,attr"`
				Text    string `xml:"text,attr"`
				Title   string `xml:"title,attr"`
				XMLURL  string `xml:"xmlUrl,attr"`
				HTMLURL string `xml:"htmlUrl,attr"`
			} `xml:"outline"`
		} `xml:"body"`
	}
	if err := xml.Unmarshal([]byte(doc), &parsed); err != nil {
		t.Fatalf("%v\n%s", err, doc)
	}
	o := parsed.Body.Outlines
	if parsed.Version != "2.0" || len(o) != 2 || o[0].Type != "rss" || o[0].Text != `Alpha & "Co"` || o[0].Title != o[0].Text ||
		o[0].XMLURL != base+"/a" || o[0].HTMLURL != "https://a.example/" || o[1].XMLURL != base+"/b" || o[1].HTMLURL != "" {
		t.Fatalf("%+v", parsed)
	}
	// Export writes the same to the folder.
	p := e.post(t, "/podcasts/opml/export", nil)["path"].(string)
	if p != filepath.Join(e.files, "podcasts.opml") {
		t.Errorf("path %s", p)
	}
	if b, err := os.ReadFile(p); err != nil || string(b) != doc {
		t.Errorf("written: %v", err)
	}
	// Into an empty store: both added; again: both skipped.
	for _, id := range []string{podcastID(base + "/a"), podcastID(base + "/b")} {
		e.post(t, "/podcasts/unsubscribe", map[string]interface{}{"id": id})
	}
	res := e.post(t, "/podcasts/opml/import", map[string]string{"opml": doc})
	if res["added"] != 2.0 || res["skipped"] != 0.0 || len(res["failed"].([]interface{})) != 0 {
		t.Errorf("import: %v", res)
	}
	res = e.post(t, "/podcasts/opml/import", map[string]string{"opml": doc})
	if res["added"] != 0.0 || res["skipped"] != 2.0 {
		t.Errorf("again: %v", res)
	}
	if n := len(list(e.get(t, "/podcasts")["podcasts"])); n != 2 {
		t.Errorf("%d podcasts", n)
	}
}

func TestOPMLImportNestedAndFailures(t *testing.T) {
	e := usePodcasts(t)
	base := opmlServer(t)
	e.subscribe(t, base+"/b")
	doc := `<?xml version="1.0"?><opml version="1.0"><head/><body>
	<outline text="Folder"><outline text="Deeper"><outline type="rss" xmlurl="` + base + `/a"/></outline>
	  <outline type="rss" xmlUrl="` + base + `/b"/></outline>
	<outline type="rss" xmlUrl="` + base + `/a"/>
	<outline type="rss" xmlUrl="` + base + `/c"/>
	<outline type="rss" xmlUrl="` + base + `/bad"/>
	<outline type="rss" xmlUrl="ftp://x.example/feed"/>
	<outline text="no address"/>
	</body></opml>`
	res := e.post(t, "/podcasts/opml/import", map[string]string{"opml": doc})
	failed := list(res["failed"])
	if res["added"] != 2.0 || res["skipped"] != 2.0 || len(failed) != 2 {
		t.Fatalf("%v", res)
	}
	urls := []string{failed[0]["url"].(string), failed[1]["url"].(string)}
	if !strings.Contains(strings.Join(urls, " "), base+"/bad") || !strings.Contains(strings.Join(urls, " "), "ftp://x.example/feed") {
		t.Errorf("failed %v", failed)
	}
	for _, bad := range []string{"", "not xml", "<rss><channel/></rss>"} {
		code, out := e.call(t, http.MethodPost, "/podcasts/opml/import", map[string]string{"opml": bad})
		if code != 400 {
			t.Errorf("%q: %d %v", bad, code, out)
		}
	}
	if code, _ := e.call(t, http.MethodPost, "/podcasts/opml/import", map[string]string{"opml": doc, "url": base + "/x"}); code != 400 {
		t.Errorf("two sources: %d", code)
	}
}

func TestOPMLImportLimit(t *testing.T) {
	e := usePodcasts(t)
	srv := feedServer(t, nil) // every feed: 404
	var b strings.Builder
	b.WriteString(`<opml version="2.0"><body>`)
	for i := 0; i < podcastMaxOPMLFeeds+3; i++ {
		fmt.Fprintf(&b, `<outline type="rss" xmlUrl="%s/f%d"/>`, srv.URL, i)
	}
	b.WriteString(`</body></opml>`)
	res := e.post(t, "/podcasts/opml/import", map[string]string{"opml": b.String()})
	failed := list(res["failed"])
	over := 0
	for _, f := range failed {
		if strings.Contains(f["error"].(string), "more than 500") {
			over++
		}
	}
	if len(failed) != podcastMaxOPMLFeeds+3 || over != 3 || res["added"] != 0.0 {
		t.Errorf("%d failed, %d over the limit", len(failed), over)
	}
	// Bodies over 4 MiB are refused.
	big := `{"opml":"` + strings.Repeat("x", podcastMaxOPMLBytes) + `"}`
	if code, _ := e.call(t, http.MethodPost, "/podcasts/opml/import", big); code != http.StatusRequestEntityTooLarge {
		t.Errorf("big: %d", code)
	}
}

func TestOPMLImportFromPathAndURL(t *testing.T) {
	e := usePodcasts(t)
	base := opmlServer(t)
	doc := `<opml version="2.0"><body><outline type="rss" xmlUrl="` + base + `/a"/></body></opml>`
	inside := filepath.Join(e.root, "Downloads", "subs.opml")
	if err := os.MkdirAll(filepath.Dir(inside), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inside, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	if res := e.post(t, "/podcasts/opml/import", map[string]string{"path": inside}); res["added"] != 1.0 {
		t.Errorf("path: %v", res)
	}
	outsideDir := t.TempDir()
	outside := filepath.Join(outsideDir, "subs.opml")
	if err := os.WriteFile(outside, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(e.root, "link.opml")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(e.root, "big.opml")
	if err := os.WriteFile(big, make([]byte, podcastMaxOPMLBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{outside, link, e.root + "/../" + filepath.Base(outsideDir) + "/subs.opml", "Downloads/subs.opml",
		filepath.Join(e.root, "Downloads"), filepath.Join(e.root, "missing.opml"), big, e.root, "/etc/passwd"} {
		if code, out := e.call(t, http.MethodPost, "/podcasts/opml/import", map[string]string{"path": p}); code != 400 {
			t.Errorf("%s: %d %v", p, code, out)
		}
	}
	// From a web address.
	srv := feedServer(t, map[string]http.HandlerFunc{"/subs.opml": func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/x-opml")
		_, _ = w.Write([]byte(`<opml version="2.0"><body><outline type="rss" xmlUrl="` + base + `/b"/></body></opml>`))
	}})
	if res := e.post(t, "/podcasts/opml/import", map[string]string{"url": srv.URL + "/subs.opml"}); res["added"] != 1.0 {
		t.Errorf("url: %v", res)
	}
	for url, code := range map[string]int{"file:///etc/passwd": 400, srv.URL + "/missing": 502, "javascript:1": 400} {
		if c, _ := e.call(t, http.MethodPost, "/podcasts/opml/import", map[string]string{"url": url}); c != code {
			t.Errorf("%s: %d", url, c)
		}
	}
}

func TestOPMLFiles(t *testing.T) {
	e := usePodcasts(t)
	write := func(rel string, age time.Duration) {
		p := filepath.Join(e.root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("<opml/>"), 0o644); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(-age)
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	write("top.opml", 3*time.Hour)
	write("a/b/c/deep.OPML", time.Hour)
	write("a/b/c/d/too-deep.opml", 0)
	write(".hidden/x.opml", 0)
	write("a/.secret/y.opml", 0)
	write("a/notes.txt", 0)
	write("a/new.opml", 2*time.Hour)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "o.opml"), []byte("<opml/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(e.root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "o.opml"), filepath.Join(e.root, "link.opml")); err != nil {
		t.Fatal(err)
	}
	files := list(e.get(t, "/podcasts/opml/files")["files"])
	got := []string{}
	for _, f := range files {
		got = append(got, f["name"].(string))
	}
	if strings.Join(got, " ") != "deep.OPML new.opml top.opml" {
		t.Fatalf("files %v", got)
	}
	f := files[0]
	if f["path"] != filepath.Join(e.root, "a/b/c/deep.OPML") || f["size"] != 7.0 || f["modified"].(float64) < float64(time.Now().Add(-2*time.Hour).UnixMilli()) {
		t.Errorf("%v", f)
	}
	for i := 0; i < 60; i++ {
		write(fmt.Sprintf("many/%02d.opml", i), time.Duration(i)*time.Minute)
	}
	if files := list(e.get(t, "/podcasts/opml/files")["files"]); len(files) != 50 || files[0]["name"] != "00.opml" {
		t.Errorf("%d files, first %v", len(files), files[0]["name"])
	}
}
