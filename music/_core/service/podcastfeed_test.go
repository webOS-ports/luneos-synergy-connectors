package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// rssFeed is an RSS 2.0 podcast as hosts write them (the shape of Libsyn's
// and Simplecast's feeds): itunes: elements, CDATA HTML, an atom:link to
// itself in the channel.
const rssFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <atom:link href="https://feeds.example/self.xml" rel="self" type="application/rss+xml"/>
  <title>The  Test Show</title>
  <link>https://show.example/</link>
  <description><![CDATA[<p>A show about <b>tests</b> &amp; more.</p>]]></description>
  <itunes:author>Test Studios</itunes:author>
  <itunes:image href="https://img.example/show.jpg"/>
  <item>
    <title>Episode 3: The newest</title>
    <guid isPermaLink="false">ep-3</guid>
    <pubDate>Tue, 03 Nov 2026 10:00:00 +0000</pubDate>
    <enclosure url="https://media.example/ep3.mp3" type="audio/mpeg" length="1234"/>
    <itunes:duration>1:02:03</itunes:duration>
    <itunes:image href="https://img.example/ep3.jpg"/>
    <description><![CDATA[<p>First paragraph.</p><p>Second&nbsp;one<br>with a break.</p>]]></description>
    <link>https://show.example/3</link>
  </item>
  <item>
    <title>Episode 2</title>
    <pubDate>Mon, 2 Nov 2026 10:00:00 GMT</pubDate>
    <enclosure url="/media/ep2.m4a" type="audio/x-m4a" length="not a number"/>
    <itunes:duration>45:30</itunes:duration>
    <itunes:summary>Summary of two.</itunes:summary>
  </item>
  <item>
    <title>Episode 1</title>
    <guid>ep-1</guid>
    <pubDate>Sun, 01 Nov 2026 10:00:00 -0500</pubDate>
    <enclosure url="https://media.example/ep1.mp3" type="audio/mpeg"/>
    <itunes:duration>1830</itunes:duration>
    <content:encoded><![CDATA[<div>From content:encoded</div>]]></content:encoded>
  </item>
  <item>
    <title>A blog post</title>
    <guid>post</guid>
  </item>
  <item>
    <title>FTP episode</title>
    <guid>ftp</guid>
    <enclosure url="ftp://media.example/x.mp3" type="audio/mpeg"/>
  </item>
  <item>
    <title>Episode 1 again</title>
    <guid>ep-1</guid>
    <enclosure url="https://media.example/ep1-dup.mp3" type="audio/mpeg"/>
  </item>
</channel>
</rss>`

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}

func TestParseRSS2WithItunes(t *testing.T) {
	f, err := parseFeed([]byte(rssFeed), mustURL("https://feeds.example/show.xml"))
	if err != nil {
		t.Fatal(err)
	}
	if f.Title != "The Test Show" || f.Link != "https://show.example/" || f.Author != "Test Studios" ||
		f.Image != "https://img.example/show.jpg" || f.Description != "A show about tests & more." {
		t.Fatalf("channel: %+v", f)
	}
	if len(f.Episodes) != 3 {
		t.Fatalf("episodes: %d %+v", len(f.Episodes), f.Episodes)
	}
	e3, e2, e1 := f.Episodes[0], f.Episodes[1], f.Episodes[2]
	if e3.GUID != "ep-3" || e3.URL != "https://media.example/ep3.mp3" || e3.Type != "audio/mpeg" || e3.Size != 1234 ||
		e3.DurationMs != 3723000 || e3.Image != "https://img.example/ep3.jpg" || e3.Link != "https://show.example/3" ||
		e3.Published != time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("ep3: %+v", e3)
	}
	if e3.Description != "First paragraph.\n\nSecond one\nwith a break." {
		t.Errorf("ep3 description: %q", e3.Description)
	}
	// No guid: the enclosure, resolved against the feed, is its guid.
	if e2.GUID != "https://feeds.example/media/ep2.m4a" || e2.URL != e2.GUID || e2.Size != 0 || e2.DurationMs != 2730000 ||
		e2.Description != "Summary of two." {
		t.Errorf("ep2: %+v", e2)
	}
	if e1.Description != "From content:encoded" || e1.DurationMs != 1830000 || e1.URL != "https://media.example/ep1.mp3" ||
		e1.Published != time.Date(2026, 11, 1, 15, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("ep1: %+v", e1)
	}
}

func TestParseRSS091Latin1(t *testing.T) {
	// RSS 0.91 with no namespaces, in ISO-8859-1 (0xe9 is é), an HTML entity
	// that is no XML one, and a control character.
	feed := "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?>\n<rss version=\"0.91\"><channel><title>Caf\xe9 Radio</title>" +
		"<item><title>Num\xe9ro 1&nbsp;\x01</title><enclosure url=\"http://media.example/1.mp3\" length=\"10\" type=\"audio/mpeg\"/>" +
		"<pubDate>Wed, 4 Nov 26 08:00:00 +0100</pubDate></item></channel></rss>"
	f, err := parseFeed([]byte(feed), mustURL("http://feeds.example/"))
	if err != nil {
		t.Fatal(err)
	}
	if f.Title != "Café Radio" || len(f.Episodes) != 1 || f.Episodes[0].Title != "Numéro 1" {
		t.Fatalf("%+v", f)
	}
	if f.Episodes[0].Published != time.Date(2026, 11, 4, 7, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("date %d", f.Episodes[0].Published)
	}
}

const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <title type="text">Atom Cast</title>
  <subtitle>Talks &amp; more</subtitle>
  <link rel="self" href="https://atom.example/feed"/>
  <link href="https://atom.example/"/>
  <author><name>Ann Author</name></author>
  <logo>/logo.png</logo>
  <entry>
    <id>urn:uuid:1</id>
    <title type="html">First &lt;i&gt;talk&lt;/i&gt;</title>
    <link rel="alternate" href="https://atom.example/1"/>
    <link rel="enclosure" type="video/mp4" length="999" href="https://atom.example/1.mp4"/>
    <published>2026-11-02T08:30:00+01:00</published>
    <updated>2026-11-03T08:30:00Z</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>One</p><p>Two &amp; three</p></div></content>
  </entry>
  <entry>
    <id>urn:uuid:2</id>
    <title>Second</title>
    <link rel="enclosure" type="audio/ogg" href="https://atom.example/2.ogg"/>
    <updated>2026-11-01T00:00:00Z</updated>
    <summary>Plain &lt;not a tag&gt;</summary>
    <itunes:duration>12:00</itunes:duration>
  </entry>
  <entry>
    <id>urn:uuid:3</id>
    <title>No enclosure</title>
    <link href="https://atom.example/3"/>
  </entry>
</feed>`

func TestParseAtom(t *testing.T) {
	f, err := parseFeed([]byte(atomFeed), mustURL("https://atom.example/feed"))
	if err != nil {
		t.Fatal(err)
	}
	if f.Title != "Atom Cast" || f.Description != "Talks & more" || f.Link != "https://atom.example/" ||
		f.Author != "Ann Author" || f.Image != "https://atom.example/logo.png" {
		t.Fatalf("feed: %+v", f)
	}
	if len(f.Episodes) != 2 {
		t.Fatalf("episodes: %+v", f.Episodes)
	}
	a, b := f.Episodes[0], f.Episodes[1]
	if a.GUID != "urn:uuid:1" || a.Title != "First talk" || a.URL != "https://atom.example/1.mp4" || a.Type != "video/mp4" ||
		a.Size != 999 || a.Link != "https://atom.example/1" || a.Description != "One\n\nTwo & three" ||
		a.Published != time.Date(2026, 11, 2, 7, 30, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("a: %+v", a)
	}
	if b.DurationMs != 720000 || b.Published != time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).UnixMilli() ||
		b.Description != "Plain <not a tag>" {
		t.Errorf("b: %+v", b)
	}
}

const rdfFeed = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:enc="http://purleox.org/encoding/">
  <channel rdf:about="http://rdf.example/">
    <title>RDF Show</title>
    <link>http://rdf.example/</link>
    <description>Old school</description>
  </channel>
  <image rdf:about="http://rdf.example/i.png"><url>http://rdf.example/i.png</url></image>
  <item rdf:about="http://rdf.example/1">
    <title>One</title>
    <link>http://rdf.example/1</link>
    <dc:date>2026-10-30T12:00:00Z</dc:date>
    <enc:enclosure rdf:resource="http://rdf.example/1.mp3" enc:type="audio/mpeg" enc:length="42"/>
  </item>
  <item rdf:about="http://rdf.example/2">
    <title>Two, no audio</title>
  </item>
</rdf:RDF>`

func TestParseRDF(t *testing.T) {
	f, err := parseFeed([]byte(rdfFeed), mustURL("http://rdf.example/rss"))
	if err != nil {
		t.Fatal(err)
	}
	if f.Title != "RDF Show" || f.Image != "http://rdf.example/i.png" || f.Description != "Old school" || len(f.Episodes) != 1 {
		t.Fatalf("%+v", f)
	}
	e := f.Episodes[0]
	if e.URL != "http://rdf.example/1.mp3" || e.Type != "audio/mpeg" || e.Size != 42 || e.GUID != e.URL ||
		e.Published != time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("%+v", e)
	}
}

func TestParseItunesDuration(t *testing.T) {
	for in, want := range map[string]int64{
		"": 0, "90": 90000, "1830": 1830000, "5:07": 307000, "45:30": 2730000, "1:02:03": 3723000, "01:00:00": 3600000,
		" 12:00 ": 720000, "90.5": 90500, "1:02:03.25": 3723250, "1:2:3:4": 0, "abc": 0, "-5": 0, "1.5:00": 0,
		"1e3": 0, "3:": 0, "99999999999": 0, "2401:00:00": 0, "2399:59:59": 8639999000,
	} {
		if got := parseItunesDuration(in); got != want {
			t.Errorf("%q: %d, want %d", in, got, want)
		}
	}
}

func TestParseFeedDate(t *testing.T) {
	want := time.Date(2026, 11, 3, 10, 4, 5, 0, time.UTC).UnixMilli()
	for _, in := range []string{
		"Tue, 03 Nov 2026 10:04:05 +0000", // RFC 1123Z
		"Tue, 03 Nov 2026 10:04:05 GMT",   // RFC 1123
		"Tue, 3 Nov 2026 10:04:05 UT",
		"Tuesday, 03 Nov 2026 11:04:05 +0100",
		"03 Nov 26 10:04:05 +0000", // RFC 822Z
		"Tue, 03 Nov 2026 12:04:05 +02:00",
		"Wed, 03 Nov 2026 10:04:05 +0000", // a wrong weekday
		"Tue,  03  Nov 2026 10:04:05 +0000",
		"Tue 03 Nov 2026 10:04:05 +0000",
		"3 November 2026 10:04:05 +0000",
		"2026-11-03T10:04:05Z", // RFC 3339
		"2026-11-03T11:04:05+01:00",
		"2026-11-03T10:04:05.000Z",
	} {
		if got := parseFeedDate(in); got != want {
			t.Errorf("%q: %v", in, time.UnixMilli(got).UTC())
		}
	}
	if got := parseFeedDate("2026-11-03"); got != time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("date only: %d", got)
	}
	for _, bad := range []string{"", "yesterday", "13/45/2026", "Tue, 99 Nov 2026 10:00:00 +0000"} {
		if got := parseFeedDate(bad); got != 0 {
			t.Errorf("%q: %d", bad, got)
		}
	}
}

func TestParseFeedMalformed(t *testing.T) {
	base := mustURL("https://x.example/")
	for name, body := range map[string]string{
		"empty":      "",
		"garbage":    "this is not xml at all",
		"truncated":  `<rss><channel><title>T</title><item><enclosure url="https://x.example/a.mp3"/>`,
		"web page":   "<!DOCTYPE html><html><head><title>Hi</title></head><body></body></html>",
		"other xml":  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
		"no channel": `<rss version="2.0"></rss>`,
		"json":       `{"title":"no"}`,
	} {
		if f, err := parseFeed([]byte(body), base); err == nil {
			t.Errorf("%s: parsed as %+v", name, f)
		}
	}
	// Tags closed in the wrong order are taken as meant.
	f, err := parseFeed([]byte(`<rss><channel><title>T<b></title><item><title>A</title><enclosure url="https://x.example/a.mp3"/></item></channel></rss>`), base)
	if err != nil || len(f.Episodes) != 1 {
		t.Errorf("mismatched tags: %v %+v", err, f)
	}
}

func TestStripHTML(t *testing.T) {
	for in, want := range map[string]string{
		"plain text\nwith lines\n\n\n\nand a gap":         "plain text\nwith lines\n\nand a gap",
		"<p>One\ntwo</p><p>Three</p>":                     "One two\n\nThree",
		"a<br/>b<br />c":                                  "a\nb\nc",
		"<ul><li>x</li><li>y</li></ul>after":              "x\ny\n\nafter",
		"Tom &amp; Jerry &lt;3 &eacute; &#8212;":          "Tom & Jerry <3 é —",
		"<script>alert(1)</script>safe<style>p{}</style>": "safe",
		"<!-- hidden -->shown":                            "shown",
		`<a href="x>y" title='a>b'>link</a> text`:         "link text",
		"x < y and y > z":                                 "x < y and y > z",
		"  <P>  Upper   case  </P>  ":                     "Upper case",
		"open <b tag":                                     "open",
	} {
		if got := stripHTML(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("é", 9000)
	got := podcastText("<p>" + long + "</p>")
	if n := utf8.RuneCountInString(got); n != podcastMaxDescription || !strings.HasSuffix(got, "…") {
		t.Errorf("cap: %d runes", n)
	}
}

// feedServer serves feeds: path -> handler.
func feedServer(t *testing.T, routes map[string]http.HandlerFunc) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h, ok := routes[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func serveXML(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = w.Write([]byte(body))
	}
}

func TestFetchFeedConditionalGet(t *testing.T) {
	var agent string
	srv := feedServer(t, map[string]http.HandlerFunc{"/feed": func(w http.ResponseWriter, r *http.Request) {
		agent = r.UserAgent()
		if r.Header.Get("If-None-Match") == `"v1"` || r.Header.Get("If-Modified-Since") == "Tue, 03 Nov 2026 10:00:00 GMT" {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Last-Modified", "Tue, 03 Nov 2026 10:00:00 GMT")
		_, _ = w.Write([]byte(rssFeed))
	}})
	res, err := fetchFeed(context.Background(), srv.URL+"/feed", "", "")
	if err != nil || res.NotModified || res.ETag != `"v1"` || res.LastModified == "" || len(res.Feed.Episodes) != 3 {
		t.Fatalf("first: %v %+v", err, res)
	}
	if agent != "LuneOS-Music/1.0" {
		t.Errorf("User-Agent %q", agent)
	}
	res, err = fetchFeed(context.Background(), srv.URL+"/feed", `"v1"`, "")
	if err != nil || !res.NotModified || res.ETag != `"v1"` {
		t.Fatalf("etag: %v %+v", err, res)
	}
	res, err = fetchFeed(context.Background(), srv.URL+"/feed", "", "Tue, 03 Nov 2026 10:00:00 GMT")
	if err != nil || !res.NotModified {
		t.Fatalf("last-modified: %v %+v", err, res)
	}
}

func TestFetchFeedRedirects(t *testing.T) {
	srv := feedServer(t, map[string]http.HandlerFunc{
		"/old": func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/new", http.StatusMovedPermanently) },
		"/old8": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/new", http.StatusPermanentRedirect)
		},
		"/temp": func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/new", http.StatusFound) },
		"/mixed": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/temp", http.StatusMovedPermanently)
		},
		"/new": serveXML(rssFeed),
	})
	for path, moved := range map[string]bool{"/old": true, "/old8": true, "/temp": false, "/mixed": false, "/new": false} {
		res, err := fetchFeed(context.Background(), srv.URL+path, "", "")
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if got := res.MovedTo == srv.URL+"/new"; got != moved || (!moved && res.MovedTo != "") {
			t.Errorf("%s: moved to %q", path, res.MovedTo)
		}
	}
}

func TestFetchFeedErrors(t *testing.T) {
	big := strings.Repeat("x", 1<<20)
	srv := feedServer(t, map[string]http.HandlerFunc{
		"/gone": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "gone", http.StatusGone) },
		"/big": func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("<rss><channel><title>"))
			for i := 0; i < 17; i++ {
				_, _ = w.Write([]byte(big))
			}
		},
		"/html": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html><body>hi</body></html>")) },
	})
	for path, want := range map[string]string{"/gone": "HTTP 410", "/big": "larger than 16 MiB", "/html": "web page"} {
		_, err := fetchFeed(context.Background(), srv.URL+path, "", "")
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", path, err)
		}
	}
	if _, err := fetchFeed(context.Background(), "file:///etc/passwd", "", ""); err == nil {
		t.Error("file: fetched")
	}
}

func TestEpisodeVideo(t *testing.T) {
	for _, c := range []struct {
		typ, url string
		video    bool
	}{
		{"video/mp4", "https://x/a.mp3", true},
		{"audio/mp4", "https://x/a.mp4", false},
		{"", "https://x/a.MP4?x=1", true},
		{"application/octet-stream", "https://x/a.webm", true},
		{"", "https://x/a.mov", true},
		{"", "https://x/a.m4v", true},
		{"", "https://x/a.mp3", false},
		{"audio/mpeg", "https://x/a.mp3", false},
	} {
		if got := isVideoEpisode(c.typ, c.url); got != c.video {
			t.Errorf("%q %q: %v", c.typ, c.url, got)
		}
	}
}
