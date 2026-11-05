package main

// Podcast feeds: reading one from its address, and making sense of it.
//
// A podcast is an RSS 2.0 (or 0.9x) feed with Apple's itunes: elements, an
// Atom 1.0 feed whose entries link their audio with rel="enclosure", or now
// and then an RSS 1.0 (RDF) feed. Each item that carries a file to play (an
// http or https enclosure) is an episode; the others (news posts, links) are
// left out.
//
// Feeds are read with encoding/xml into a small tree first, as the three
// kinds name the same things differently and many feeds get the details
// wrong: undeclared namespace prefixes, HTML entities such as &nbsp;, tags
// closed in the wrong order, stray control characters and Latin-1 bytes.

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	podcastUserAgent = radioUserAgent
	// The most of a feed read, and how long reading it may take.
	podcastMaxFeedBytes = 16 << 20
	podcastFeedTimeout  = 30 * time.Second
	// The longest description kept, in characters.
	podcastMaxDescription = 8000
	// The most elements read of one feed: a bound on memory for a feed that
	// is all elements.
	podcastMaxNodes = 2_000_000
)

// podcastHTTP reads feeds, the directory and OPML files (a variable for the
// tests).
var podcastHTTP = &http.Client{Timeout: podcastFeedTimeout}

// The namespaces of the elements a podcast feed uses.
const (
	nsAtom    = "http://www.w3.org/2005/Atom"
	nsAtom03  = "http://purl.org/atom/ns#"
	nsRSS1    = "http://purl.org/rss/1.0/"
	nsRSS090  = "http://my.netscape.com/rdf/simple/0.9/"
	nsRSS2    = "http://backend.userland.com/rss2"
	nsContent = "http://purl.org/rss/1.0/modules/content/"
	nsDC      = "http://purl.org/dc/elements/1.1/"
)

// parsedFeed is what a feed says of itself and its episodes.
type parsedFeed struct {
	Title, Author, Description, Image, Link string
	Episodes                                []parsedEpisode
}

// parsedEpisode is one episode as the feed gives it.
type parsedEpisode struct {
	GUID        string // the guid, else the enclosure's address
	Title       string
	URL         string // the enclosure
	Type        string
	Size        int64
	Published   int64 // unix ms, 0: not known
	DurationMs  int64
	Description string
	Image       string
	Link        string
}

// podcastID is the first 12 hex digits of the SHA-1 of a feed's address.
func podcastID(feedURL string) string {
	s := sha1.Sum([]byte(feedURL))
	return hex.EncodeToString(s[:])[:12]
}

// episodeKey is the first 16 hex digits of the SHA-1 of an episode's guid.
func episodeKey(guid string) string {
	s := sha1.Sum([]byte(guid))
	return hex.EncodeToString(s[:])[:16]
}

// --- reading ---------------------------------------------------------------

// feedFetch is what reading a feed gave.
type feedFetch struct {
	Feed         *parsedFeed
	NotModified  bool   // 304: nothing changed since the last time
	ETag         string // to send the next time
	LastModified string
	MovedTo      string // where it moved for good (301/308), "" if it did not
}

// fetchFeed reads and parses the feed at feedURL. etag and lastModified are
// what it answered the last time ("" the first time), so an unchanged feed
// answers 304 and is not read again.
func fetchFeed(ctx context.Context, feedURL, etag, lastModified string) (*feedFetch, error) {
	if !isWebLink(feedURL) {
		return nil, errors.New("that is not a web address")
	}
	ctx, cancel := context.WithTimeout(ctx, podcastFeedTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feedURL, nil)
	if err != nil {
		return nil, errors.New("that is not a web address")
	}
	req.Header.Set("User-Agent", podcastUserAgent)
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if lastModified != "" {
		req.Header.Set("If-Modified-Since", lastModified)
	}
	// A copy of the client, to see the redirects of this one request: only a
	// chain of permanent ones moves the feed.
	c := *podcastHTTP
	redirected, permanent := false, true
	c.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		if r.URL.Scheme != "http" && r.URL.Scheme != "https" {
			return errors.New("redirected away from the web")
		}
		redirected = true
		if r.Response == nil || (r.Response.StatusCode != http.StatusMovedPermanently && r.Response.StatusCode != http.StatusPermanentRedirect) {
			permanent = false
		}
		return nil
	}
	resp, err := c.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("the feed did not answer in time")
		}
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("the feed cannot be reached (%v)", err)
	}
	defer resp.Body.Close()
	out := &feedFetch{ETag: resp.Header.Get("ETag"), LastModified: resp.Header.Get("Last-Modified")}
	if final := resp.Request.URL.String(); redirected && permanent && final != feedURL {
		out.MovedTo = final
	}
	switch {
	case resp.StatusCode == http.StatusNotModified && (etag != "" || lastModified != ""):
		out.NotModified = true
		if out.ETag == "" {
			out.ETag = etag
		}
		if out.LastModified == "" {
			out.LastModified = lastModified
		}
		return out, nil
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("the feed answered HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, podcastMaxFeedBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("the feed did not answer in time")
		}
		return nil, errors.New("the feed could not be read")
	}
	if len(body) > podcastMaxFeedBytes {
		return nil, errors.New("the feed is larger than 16 MiB")
	}
	base := resp.Request.URL
	f, err := parseFeed(body, base)
	if err != nil {
		return nil, err
	}
	out.Feed = f
	return out, nil
}

// --- the tree ----------------------------------------------------------------

// xnode is an element: its name, attributes, the text right in it and the
// elements in it.
type xnode struct {
	space, local string
	attrs        []xml.Attr
	text         []byte
	kids         []*xnode
}

// cleanXMLBytes takes out what no XML may hold and many feeds do: a byte
// order mark and control characters other than tab and line ends.
func cleanXMLBytes(b []byte) []byte {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	if bytes.IndexFunc(b, func(r rune) bool { return r < 0x20 && r != '\t' && r != '\n' && r != '\r' }) < 0 {
		return b
	}
	out := make([]byte, 0, len(b))
	for _, c := range b {
		if c >= 0x20 || c == '\t' || c == '\n' || c == '\r' {
			out = append(out, c)
		}
	}
	return out
}

// parseXMLTree reads a document into its root element.
func parseXMLTree(b []byte) (*xnode, error) {
	d := xml.NewDecoder(bytes.NewReader(cleanXMLBytes(b)))
	d.Strict = false
	d.Entity = xml.HTMLEntity
	d.CharsetReader = podcastCharsetReader
	top := &xnode{}
	stack := []*xnode{top}
	nodes := 0
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		cur := stack[len(stack)-1]
		switch t := tok.(type) {
		case xml.StartElement:
			nodes++
			if nodes > podcastMaxNodes {
				return nil, errors.New("too many elements")
			}
			n := &xnode{space: t.Name.Space, local: t.Name.Local, attrs: append([]xml.Attr(nil), t.Attr...)}
			cur.kids = append(cur.kids, n)
			stack = append(stack, n)
		case xml.EndElement:
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			if len(stack) > 1 {
				cur.text = append(cur.text, t...)
			}
		}
	}
	if len(stack) > 1 {
		return nil, errors.New("the document ends early")
	}
	if len(top.kids) == 0 {
		return nil, errors.New("there is no document")
	}
	return top.kids[0], nil
}

// podcastCharsetReader reads the 8-bit encodings feeds still come in as
// UTF-8: Latin-1 and Windows-1252 (and ASCII, a part of both). Others are
// read as they are.
func podcastCharsetReader(charset string, in io.Reader) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "iso-8859-1", "iso8859-1", "latin1", "latin-1", "l1", "iso-8859-15", "windows-1252", "cp1252", "us-ascii", "ascii":
	default:
		return in, nil
	}
	b, err := io.ReadAll(io.LimitReader(in, podcastMaxFeedBytes+1))
	if err != nil {
		return nil, err
	}
	var out strings.Builder
	out.Grow(len(b) + len(b)/8)
	for _, c := range b {
		if c >= 0x80 && c < 0xa0 && cp1252[c-0x80] != 0 {
			out.WriteRune(cp1252[c-0x80])
		} else {
			out.WriteRune(rune(c))
		}
	}
	return strings.NewReader(out.String()), nil
}

// cp1252 is what Windows-1252 has in 0x80-0x9f, where Latin-1 has control
// characters no feed means.
var cp1252 = [32]rune{
	'€', 0, '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', 0, 'Ž', 0,
	0, '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', 0, 'ž', 'Ÿ',
}

// Which namespaces an element may be in. The itunes: prefix has been
// declared with several spellings of Apple's address, or not at all.
func isPlain(space string) bool {
	return space == "" || space == nsRSS1 || space == nsRSS090 || space == nsRSS2
}
func isAtomNS(space string) bool { return space == nsAtom || space == nsAtom03 || space == "" }
func isItunes(space string) bool { return strings.Contains(strings.ToLower(space), "itunes") }
func isContentNS(space string) bool {
	return space == nsContent || space == "content"
}
func isDC(space string) bool { return space == nsDC || space == "dc" }

// first is the first element in n with the name local in a namespace ns
// takes, or nil.
func (n *xnode) first(local string, ns func(string) bool) *xnode {
	if n == nil {
		return nil
	}
	for _, k := range n.kids {
		if k.local == local && ns(k.space) {
			return k
		}
	}
	return nil
}

// all is every element in n with the name local in a namespace ns takes.
func (n *xnode) all(local string, ns func(string) bool) []*xnode {
	var out []*xnode
	for _, k := range n.kids {
		if k.local == local && ns(k.space) {
			out = append(out, k)
		}
	}
	return out
}

// attr is the attribute named local, whatever its namespace.
func (n *xnode) attr(local string) string {
	if n == nil {
		return ""
	}
	for _, a := range n.attrs {
		if strings.EqualFold(a.Name.Local, local) {
			return strings.TrimSpace(a.Value)
		}
	}
	return ""
}

// str is the text right in n, trimmed; "" for no element.
func (n *xnode) str() string {
	if n == nil {
		return ""
	}
	return strings.TrimSpace(string(n.text))
}

// markup is n's content as HTML: its text, and its elements as tags (an Atom
// text of type="xhtml" holds XHTML elements).
func (n *xnode) markup() string {
	if n == nil {
		return ""
	}
	if len(n.kids) == 0 {
		return string(n.text)
	}
	var b strings.Builder
	var walk func(x *xnode)
	walk = func(x *xnode) {
		b.WriteString(html.EscapeString(string(x.text)))
		for _, k := range x.kids {
			b.WriteString("<" + k.local + ">")
			walk(k)
			b.WriteString("</" + k.local + ">")
		}
	}
	walk(n)
	return b.String()
}

// firstOf is the first of vals that is not empty.
func firstOf(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// oneLine is s with its runs of white space made one space.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// --- the kinds of feed -----------------------------------------------------------

// parseFeed reads an RSS, Atom or RDF feed; base is its address, against
// which relative links are resolved.
func parseFeed(body []byte, base *url.URL) (*parsedFeed, error) {
	root, err := parseXMLTree(body)
	if err != nil {
		return nil, fmt.Errorf("it is not a podcast feed (%v)", err)
	}
	var f *parsedFeed
	switch strings.ToLower(root.local) {
	case "rss", "rdf":
		f, err = parseRSS(root, base)
	case "feed":
		f, err = parseAtom(root, base)
	case "html":
		return nil, errors.New("it is a web page, not a podcast feed")
	default:
		return nil, errors.New("it is not a podcast feed")
	}
	if err != nil {
		return nil, err
	}
	// Each episode once, by its guid.
	seen := map[string]bool{}
	eps := f.Episodes[:0]
	for _, e := range f.Episodes {
		if !seen[e.GUID] {
			seen[e.GUID] = true
			eps = append(eps, e)
		}
	}
	f.Episodes = eps
	if f.Title == "" {
		f.Title = base.Hostname()
	}
	return f, nil
}

// parseRSS reads RSS 0.9x and 2.0 (items in the channel) and RSS 1.0 (items
// beside it).
func parseRSS(root *xnode, base *url.URL) (*parsedFeed, error) {
	ch := root.first("channel", isPlain)
	if ch == nil {
		return nil, errors.New("it is not a podcast feed (no channel)")
	}
	f := &parsedFeed{
		Title: oneLine(ch.first("title", isPlain).str()),
		Link:  resolveLink(base, ch.first("link", isPlain).str()),
		Description: podcastText(firstOf(ch.first("description", isPlain).str(),
			ch.first("summary", isItunes).str(), ch.first("subtitle", isItunes).str())),
		Author: oneLine(firstOf(ch.first("author", isItunes).str(), ch.first("creator", isDC).str(),
			ch.first("owner", isItunes).first("name", isItunes).str())),
		Image: resolveLink(base, firstOf(ch.first("image", isItunes).attr("href"),
			ch.first("image", isPlain).first("url", isPlain).str(), root.first("image", isPlain).first("url", isPlain).str())),
	}
	items := append(ch.all("item", isPlain), root.all("item", isPlain)...)
	for _, it := range items {
		encURL, encType, encSize := "", "", int64(0)
		for _, enc := range it.kids {
			if enc.local != "enclosure" || enc.space == nsAtom {
				continue
			}
			u := resolveLink(base, firstOf(enc.attr("url"), enc.attr("resource")))
			if isWebLink(u) {
				encURL, encType, encSize = u, enc.attr("type"), parseSize(enc.attr("length"))
				break
			}
		}
		if encURL == "" {
			continue
		}
		e := parsedEpisode{
			GUID:       firstOf(it.first("guid", isPlain).str(), encURL),
			Title:      oneLine(firstOf(it.first("title", isPlain).str(), it.first("title", isItunes).str())),
			URL:        encURL,
			Type:       strings.ToLower(encType),
			Size:       encSize,
			Published:  parseFeedDate(firstOf(it.first("pubDate", isPlain).str(), it.first("date", isDC).str())),
			DurationMs: parseItunesDuration(it.first("duration", isItunes).str()),
			Description: podcastText(firstOf(it.first("description", isPlain).str(),
				it.first("summary", isItunes).str(), it.first("encoded", isContentNS).str())),
			Image: resolveLink(base, it.first("image", isItunes).attr("href")),
			Link:  resolveLink(base, it.first("link", isPlain).str()),
		}
		f.Episodes = append(f.Episodes, e)
	}
	return f, nil
}

// parseAtom reads Atom 1.0 (and 0.3): an entry's audio is its link with
// rel="enclosure".
func parseAtom(root *xnode, base *url.URL) (*parsedFeed, error) {
	f := &parsedFeed{
		Title:       oneLine(podcastText(atomText(root.first("title", isAtomNS)))),
		Link:        resolveLink(base, atomLink(root, "alternate")),
		Description: podcastText(firstOf(atomText(root.first("subtitle", isAtomNS)), root.first("summary", isItunes).str())),
		Author:      oneLine(firstOf(root.first("author", isAtomNS).first("name", isAtomNS).str(), root.first("author", isItunes).str())),
		Image: resolveLink(base, firstOf(root.first("image", isItunes).attr("href"), root.first("logo", isAtomNS).str(),
			root.first("icon", isAtomNS).str())),
	}
	for _, en := range root.all("entry", isAtomNS) {
		encURL, encType, encSize := "", "", int64(0)
		for _, l := range en.all("link", isAtomNS) {
			if !strings.EqualFold(l.attr("rel"), "enclosure") {
				continue
			}
			if u := resolveLink(base, l.attr("href")); isWebLink(u) {
				encURL, encType, encSize = u, l.attr("type"), parseSize(l.attr("length"))
				break
			}
		}
		if encURL == "" {
			continue
		}
		e := parsedEpisode{
			GUID:       firstOf(en.first("id", isAtomNS).str(), encURL),
			Title:      oneLine(podcastText(atomText(en.first("title", isAtomNS)))),
			URL:        encURL,
			Type:       strings.ToLower(encType),
			Size:       encSize,
			Published:  parseFeedDate(firstOf(en.first("published", isAtomNS).str(), en.first("updated", isAtomNS).str(), en.first("issued", isAtomNS).str(), en.first("modified", isAtomNS).str())),
			DurationMs: parseItunesDuration(en.first("duration", isItunes).str()),
			Description: podcastText(firstOf(atomText(en.first("summary", isAtomNS)), atomText(en.first("content", isAtomNS)),
				en.first("summary", isItunes).str())),
			Image: resolveLink(base, en.first("image", isItunes).attr("href")),
			Link:  resolveLink(base, atomLink(en, "alternate")),
		}
		f.Episodes = append(f.Episodes, e)
	}
	return f, nil
}

// atomText is an Atom text element as HTML (type text, html or xhtml).
func atomText(n *xnode) string {
	if n == nil {
		return ""
	}
	switch strings.ToLower(n.attr("type")) {
	case "xhtml":
		return strings.TrimSpace(n.markup())
	case "html", "text/html":
		return strings.TrimSpace(string(n.text))
	}
	// Plain text: nothing in it is markup.
	return html.EscapeString(strings.TrimSpace(string(n.text)))
}

// atomLink is the href of n's link with the relation rel (no rel is
// "alternate").
func atomLink(n *xnode, rel string) string {
	for _, l := range n.all("link", isAtomNS) {
		r := l.attr("rel")
		if r == "" {
			r = "alternate"
		}
		if strings.EqualFold(r, rel) {
			return l.attr("href")
		}
	}
	return ""
}

// resolveLink is s resolved against base, if it is a web address; else "".
func resolveLink(base *url.URL, s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	if base != nil {
		u = base.ResolveReference(u)
	}
	if !isWebLink(u.String()) {
		return ""
	}
	return u.String()
}

// parseSize is an enclosure's length in bytes, 0 when it does not say.
func parseSize(s string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// parseItunesDuration reads itunes:duration, as seconds ("1830"), "m:s" or
// "h:m:s" (a fraction of a second allowed at the end), into milliseconds; 0
// when it is none of these.
func parseItunesDuration(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	parts := strings.Split(s, ":")
	if len(parts) > 3 {
		return 0
	}
	var ms int64
	for i, p := range parts {
		p = strings.TrimSpace(p)
		whole, frac, hasFrac := strings.Cut(p, ".")
		if whole == "" || len(whole) > 9 || strings.Trim(whole, "0123456789") != "" ||
			(hasFrac && (i != len(parts)-1 || frac == "" || strings.Trim(frac, "0123456789") != "")) {
			return 0
		}
		n, _ := strconv.ParseInt(whole, 10, 64)
		ms = ms*60 + n*1000
		if i < len(parts)-1 {
			continue
		}
		if hasFrac {
			f := (frac + "000")[:3]
			m, _ := strconv.ParseInt(f, 10, 64)
			ms += m
		}
	}
	// Rather nothing than a length of years.
	if ms > 100*24*3600*1000 {
		return 0
	}
	return ms
}

// feedDateLayouts are the dates feeds write: RFC 822 and its many variants
// (after the weekday is taken off), and ISO 8601 / RFC 3339 (Atom, dc:date).
var feedDateLayouts = []string{
	"2 Jan 2006 15:04:05 -0700",
	"2 Jan 2006 15:04:05 MST",
	"2 Jan 2006 15:04:05 -07:00",
	"2 Jan 2006 15:04 -0700",
	"2 Jan 2006 15:04 MST",
	"2 Jan 2006 15:04:05",
	"2 Jan 06 15:04:05 -0700",
	"2 Jan 06 15:04:05 MST",
	"2 Jan 06 15:04 -0700",
	"2 Jan 06 15:04 MST",
	"2 January 2006 15:04:05 -0700",
	"2 January 2006 15:04:05 MST",
	"2 January 2006 15:04 MST",
	"Jan 2 2006 15:04:05 -0700",
	"Jan 2 2006 15:04:05 MST",
	"2 Jan 2006",
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02T15:04:05Z0700",
	"2006-01-02T15:04Z07:00",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05 -0700",
	"2006-01-02 15:04:05",
	"2006-01-02",
	time.ANSIC,
}

// parseFeedDate is a feed's date as unix milliseconds, 0 when it cannot be
// read.
func parseFeedDate(s string) int64 {
	s = oneLine(s)
	if s == "" {
		return 0
	}
	// "Tue, 05 Nov 2026 ...", "Tuesday, 5 Nov ...", "Tue 05 Nov ...": the
	// weekday says nothing a date does not.
	if i := strings.IndexByte(s, ','); i > 0 && i < 10 && isLetters(s[:i]) {
		s = strings.TrimSpace(s[i+1:])
	} else if i := strings.IndexByte(s, ' '); i > 0 && i < 10 && isLetters(s[:i]) && len(s) > i+1 && s[i+1] >= '0' && s[i+1] <= '9' {
		s = s[i+1:]
	}
	s = strings.Replace(s, " UT", " UTC", 1)
	for _, l := range feedDateLayouts {
		if t, err := time.Parse(l, s); err == nil {
			if t.Year() < 1970 || t.Year() > 9999 {
				return 0
			}
			return t.UnixMilli()
		}
	}
	return 0
}

func isLetters(s string) bool {
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return s != ""
}

// --- descriptions ---------------------------------------------------------------

// blockBreaks are the elements that start a paragraph ("\n\n") or a line
// ("\n") in the plain text made of HTML.
var blockBreaks = map[string]string{
	"p": "\n\n", "h1": "\n\n", "h2": "\n\n", "h3": "\n\n", "h4": "\n\n", "h5": "\n\n", "h6": "\n\n",
	"blockquote": "\n\n", "ul": "\n\n", "ol": "\n\n", "table": "\n\n", "pre": "\n\n", "section": "\n\n",
	"br": "\n", "li": "\n", "div": "\n", "tr": "\n", "dt": "\n", "dd": "\n", "hr": "\n",
}

// podcastText is a description as plain text: HTML taken out (its paragraphs
// and line breaks kept as line ends), entities decoded, white space tidied,
// and at most podcastMaxDescription characters.
func podcastText(s string) string {
	return capRunes(stripHTML(s), podcastMaxDescription)
}

// stripHTML makes HTML plain text. Text without tags keeps its line ends;
// in HTML, only the tags break lines.
func stripHTML(s string) string {
	isHTML := hasTag(s)
	var b strings.Builder
	for i := 0; i < len(s); {
		c := s[i]
		if c == '<' && i+1 < len(s) && isTagStart(s[i+1]) {
			if strings.HasPrefix(s[i:], "<!--") {
				end := strings.Index(s[i+4:], "-->")
				if end < 0 {
					break
				}
				i += 4 + end + 3
				continue
			}
			end := tagEnd(s, i+1)
			if end < 0 {
				break // a tag left open: the rest is not text
			}
			inside := s[i+1 : end]
			name := tagName(inside)
			i = end + 1
			if (name == "script" || name == "style") && !strings.HasPrefix(inside, "/") {
				// Their content is no text: on past their end tag.
				j := strings.Index(strings.ToLower(s[i:]), "</"+name)
				if j < 0 {
					i = len(s)
					continue
				}
				i += j
				if k := strings.IndexByte(s[i:], '>'); k >= 0 {
					i += k + 1
				} else {
					i = len(s)
				}
				continue
			}
			if br, ok := blockBreaks[name]; ok {
				breakTo(&b, len(br))
			}
			continue
		}
		if isHTML && (c == '\n' || c == '\r' || c == '\t') {
			c = ' '
		}
		b.WriteByte(c)
		i++
	}
	return tidyText(html.UnescapeString(b.String()))
}

// breakTo ends what b holds with at least n line ends (a paragraph's end and
// the next one's start are one break, not two).
func breakTo(b *strings.Builder, n int) {
	t := strings.TrimRight(b.String(), " ")
	have := len(t) - len(strings.TrimRight(t, "\n"))
	for ; have < n; have++ {
		b.WriteByte('\n')
	}
}

func isTagStart(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '/' || c == '!' || c == '?'
}

// hasTag: s has something that looks like an HTML tag.
func hasTag(s string) bool {
	for i := strings.IndexByte(s, '<'); i >= 0 && i+1 < len(s); {
		if isTagStart(s[i+1]) && tagEnd(s, i+1) > 0 {
			return true
		}
		j := strings.IndexByte(s[i+1:], '<')
		if j < 0 {
			break
		}
		i += 1 + j
	}
	return false
}

// tagEnd is the index of the '>' that ends the tag begun before from, past
// any '>' in quoted attribute values; -1 when there is none.
func tagEnd(s string, from int) int {
	var quote byte
	for i := from; i < len(s); i++ {
		switch c := s[i]; {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '>':
			return i
		}
	}
	return -1
}

// tagName is the lower-case name of a tag's inside ("/p", "br/", "a href=").
func tagName(inside string) string {
	inside = strings.TrimLeft(inside, "/!? ")
	end := strings.IndexAny(inside, " \t\r\n/>")
	if end >= 0 {
		inside = inside[:end]
	}
	return strings.ToLower(inside)
}

// tidyText makes runs of spaces one space, takes the spaces off line ends,
// and keeps at most one empty line between paragraphs.
func tidyText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.ReplaceAll(s, " ", " ")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := 0
	for _, l := range lines {
		l = strings.Join(strings.FieldsFunc(l, func(r rune) bool { return r == ' ' || r == '\t' }), " ")
		if l == "" {
			blank++
			continue
		}
		if len(out) > 0 {
			if blank > 0 {
				out = append(out, "")
			}
		}
		blank = 0
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}

// capRunes is s cut to at most max characters, an ellipsis showing the cut.
func capRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	n := 0
	for i := range s {
		if n == max-1 {
			return strings.TrimRight(s[:i], " \n") + "…"
		}
		n++
	}
	return s
}
