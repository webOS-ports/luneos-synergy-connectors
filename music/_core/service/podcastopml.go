package main

// OPML: the list of subscriptions other podcast apps export and import
// (OPML 2.0, an <outline type="rss" xmlUrl="..."/> per podcast). Export
// gives it, or writes it next to the downloads; import takes it as text,
// from a file under /media/internal (where the user copies it over USB) or
// from a web address, and subscribes to each podcast it does not have yet.

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	podcastMaxOPMLBytes = 4 << 20
	// The most podcasts taken from one OPML file.
	podcastMaxOPMLFeeds = 500
	// The most OPML files offered, and how deep under /media/internal they
	// are looked for.
	podcastMaxOPMLFiles = 50
	podcastOPMLDepth    = 3
)

// podcastImportRoot is where OPML files are taken from (a variable for the
// tests).
var podcastImportRoot = "/media/internal"

// podcastsOPML is the subscriptions as an OPML 2.0 document.
func (s *podcastStore) podcastsOPML() []byte {
	var b bytes.Buffer
	esc := func(v string) string {
		var e bytes.Buffer
		_ = xml.EscapeText(&e, []byte(v))
		return e.String()
	}
	b.WriteString(xml.Header)
	b.WriteString("<opml version=\"2.0\">\n  <head>\n    <title>LuneOS Music podcasts</title>\n")
	b.WriteString("    <dateCreated>" + podcastNow().UTC().Format(time.RFC1123Z) + "</dateCreated>\n  </head>\n  <body>\n")
	s.mu.Lock()
	for _, f := range s.sortedFeedsLocked(true) {
		fmt.Fprintf(&b, "    <outline type=\"rss\" text=\"%s\" title=\"%s\" xmlUrl=\"%s\"", esc(f.Title), esc(f.Title), esc(f.URL))
		if f.Link != "" {
			fmt.Fprintf(&b, " htmlUrl=\"%s\"", esc(f.Link))
		}
		b.WriteString("/>\n")
	}
	s.mu.Unlock()
	b.WriteString("  </body>\n</opml>\n")
	return b.Bytes()
}

// opmlFeeds is the feed addresses of an OPML document, from its outlines
// at any depth, in order.
func opmlFeeds(doc []byte) ([]string, error) {
	d := xml.NewDecoder(bytes.NewReader(cleanXMLBytes(doc)))
	d.Strict = false
	d.Entity = xml.HTMLEntity
	d.CharsetReader = podcastCharsetReader
	out := []string{}
	root := ""
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			if root == "opml" {
				break // what came before the error is used
			}
			return nil, errors.New("it is not an OPML file")
		}
		t, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		if root == "" {
			root = strings.ToLower(t.Name.Local)
			if root != "opml" {
				return nil, errors.New("it is not an OPML file")
			}
			continue
		}
		if !strings.EqualFold(t.Name.Local, "outline") {
			continue
		}
		for _, a := range t.Attr {
			if strings.EqualFold(a.Name.Local, "xmlUrl") {
				if u := strings.TrimSpace(a.Value); u != "" {
					out = append(out, u)
				}
				break
			}
		}
	}
	if root != "opml" {
		return nil, errors.New("it is not an OPML file")
	}
	return out, nil
}

// insideImportRoot is p, cleaned and with its links followed, when it is a
// regular file under podcastImportRoot.
func insideImportRoot(p string) (string, error) {
	if p == "" || !filepath.IsAbs(p) {
		return "", errors.New("give the full path of the file")
	}
	within := func(base, p string) bool {
		rel, err := filepath.Rel(base, p)
		return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	base := filepath.Clean(podcastImportRoot)
	refused := errors.New("only a file under " + podcastImportRoot + " can be imported")
	if !within(base, filepath.Clean(p)) {
		return "", refused
	}
	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", refused
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", errors.New("there is no such file")
	}
	if !within(realBase, real) {
		return "", refused
	}
	fi, err := os.Stat(real)
	if err != nil || !fi.Mode().IsRegular() {
		return "", errors.New("that is not a file")
	}
	if fi.Size() > podcastMaxOPMLBytes {
		return "", errors.New("the file is larger than 4 MiB")
	}
	return real, nil
}

// fetchOPML reads an OPML file at a web address.
func fetchOPML(ctx context.Context, addr string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, podcastFeedTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, nil)
	if err != nil {
		return nil, errors.New("that is not a web address")
	}
	req.Header.Set("User-Agent", podcastUserAgent)
	resp, err := podcastHTTP.Do(req)
	if err != nil {
		return nil, errors.New("it cannot be reached")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("it answered HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, podcastMaxOPMLBytes+1))
	if err != nil {
		return nil, errors.New("it could not be read")
	}
	if len(b) > podcastMaxOPMLBytes {
		return nil, errors.New("it is larger than 4 MiB")
	}
	return b, nil
}

type opmlFailure struct {
	URL   string `json:"url"`
	Error string `json:"error"`
}

// importOPML subscribes to each feed of doc not subscribed to yet, a few at
// a time; a feed that cannot be read is listed, the others still added.
func (s *podcastStore) importOPML(ctx context.Context, doc []byte) (added, skipped int, failed []opmlFailure, err error) {
	feeds, err := opmlFeeds(doc)
	if err != nil {
		return 0, 0, nil, err
	}
	failed = []opmlFailure{}
	todo := []string{}
	seen := map[string]bool{}
	for _, raw := range feeds {
		addr, aerr := feedAddress(raw)
		switch {
		case aerr != nil:
			failed = append(failed, opmlFailure{URL: raw, Error: aerr.Error()})
		case seen[addr]:
			skipped++
		case len(todo) == podcastMaxOPMLFeeds:
			failed = append(failed, opmlFailure{URL: addr, Error: fmt.Sprintf("more than %d podcasts in one file", podcastMaxOPMLFeeds)})
		default:
			seen[addr] = true
			todo = append(todo, addr)
		}
	}
	var mu sync.Mutex
	work := make(chan string)
	var wg sync.WaitGroup
	for i := 0; i < podcastRefreshWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for addr := range work {
				_, isNew, serr := s.subscribe(ctx, addr)
				mu.Lock()
				switch {
				case serr != nil:
					failed = append(failed, opmlFailure{URL: addr, Error: serr.Error()})
				case isNew:
					added++
				default:
					skipped++
				}
				mu.Unlock()
			}
		}()
	}
	for _, addr := range todo {
		work <- addr
	}
	close(work)
	wg.Wait()
	return added, skipped, failed, nil
}

// GET /podcasts/opml -> the subscriptions as OPML 2.0.
func handlePodcastOPML(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodGet)
	if s == nil {
		return
	}
	w.Header().Set("Content-Type", "text/x-opml; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="podcasts.opml"`)
	_, _ = w.Write(s.podcastsOPML())
}

// POST /podcasts/opml/export -> {path}: written beside the downloads.
func handlePodcastOPMLExport(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	if err := os.MkdirAll(podcastFilesDir, 0o755); err != nil {
		httpErr(w, http.StatusInternalServerError, "the podcasts folder cannot be made")
		return
	}
	p := filepath.Join(podcastFilesDir, "podcasts.opml")
	if err := writeFileAtomic(p, s.podcastsOPML()); err != nil {
		httpErr(w, http.StatusInternalServerError, "the file cannot be written")
		return
	}
	writeJSON(w, map[string]interface{}{"path": p})
}

// POST /podcasts/opml/import {opml} | {path} | {url} -> {added, skipped, failed}
func handlePodcastOPMLImport(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		OPML string `json:"opml"`
		Path string `json:"path"`
		URL  string `json:"url"`
	}
	if !podcastBody(w, r, podcastMaxOPMLBytes, &body) {
		return
	}
	given := 0
	for _, v := range []string{body.OPML, body.Path, body.URL} {
		if strings.TrimSpace(v) != "" {
			given++
		}
	}
	if given != 1 {
		httpErr(w, http.StatusBadRequest, "give one of opml, path and url")
		return
	}
	var doc []byte
	switch {
	case body.OPML != "":
		doc = []byte(body.OPML)
	case body.Path != "":
		p, err := insideImportRoot(strings.TrimSpace(body.Path))
		if err != nil {
			httpErr(w, http.StatusBadRequest, err.Error())
			return
		}
		b, err := os.ReadFile(p)
		if err != nil || len(b) > podcastMaxOPMLBytes {
			httpErr(w, http.StatusBadRequest, "the file cannot be read")
			return
		}
		doc = b
	default:
		addr, err := feedAddress(body.URL)
		if err != nil {
			httpErr(w, http.StatusBadRequest, "that is not the web address (http or https) of an OPML file")
			return
		}
		b, err := fetchOPML(r.Context(), addr)
		if err != nil {
			httpErr(w, http.StatusBadGateway, "the OPML file: "+err.Error())
			return
		}
		doc = b
	}
	added, skipped, failed, err := s.importOPML(r.Context(), doc)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"added": added, "skipped": skipped, "failed": failed})
}

type opmlFile struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Modified int64  `json:"modified"`
	Size     int64  `json:"size"`
}

// findOPMLFiles is the .opml files under podcastImportRoot, in it and in
// folders up to podcastOPMLDepth below it: not in hidden folders, not
// through links, newest first, at most podcastMaxOPMLFiles.
func findOPMLFiles() []opmlFile {
	root := filepath.Clean(podcastImportRoot)
	out := []opmlFile{}
	visited := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() && p != root {
				return fs.SkipDir
			}
			return nil
		}
		visited++
		if visited > 100000 {
			return fs.SkipAll
		}
		if d.IsDir() {
			if p == root {
				return nil
			}
			rel, _ := filepath.Rel(root, p)
			if strings.HasPrefix(d.Name(), ".") || strings.Count(rel, string(filepath.Separator))+1 > podcastOPMLDepth {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || !strings.HasSuffix(strings.ToLower(d.Name()), ".opml") {
			return nil
		}
		fi, err := d.Info()
		if err != nil || fi.Size() > podcastMaxOPMLBytes {
			return nil
		}
		out = append(out, opmlFile{Path: p, Name: d.Name(), Modified: fi.ModTime().UnixMilli(), Size: fi.Size()})
		return nil
	})
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Modified != out[j].Modified {
			return out[i].Modified > out[j].Modified
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > podcastMaxOPMLFiles {
		out = out[:podcastMaxOPMLFiles]
	}
	return out
}

// GET /podcasts/opml/files -> {files: [{path, name, modified, size}]}
func handlePodcastOPMLFiles(w http.ResponseWriter, r *http.Request) {
	if podcastRoute(w, r, http.MethodGet) == nil {
		return
	}
	writeJSON(w, map[string]interface{}{"files": findOPMLFiles()})
}
