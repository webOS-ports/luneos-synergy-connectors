package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeVideo is the content a fake googlevideo serves: byte i is a function of i, so
// any range can be produced without holding the file in memory.
func fakeByte(i int64) byte { return byte((i*131 + i/977) & 0xff) }

func fakeContent(off, n int64) []byte {
	b := make([]byte, n)
	for k := range b {
		b[k] = fakeByte(off + int64(k))
	}
	return b
}

// googlevideo mimics what googlevideo does with the audio URLs: 403 without a Range
// header and for ranges over 1 MiB, 206 with Content-Range for smaller ones.
type googlevideo struct {
	size int64

	mu       sync.Mutex
	requests []string // "path off-end" of every request
	// hooks, keyed on the request's start offset; each fires once.
	forbidOnce map[int64]bool // 403 once
	failOnce   map[int64]bool // 500 once
	cutOnce    map[int64]bool // send half the body, then drop the connection
	// expiredPath answers 403 for every request at or after expiredFrom.
	expiredPath string
	expiredFrom int64
}

func (g *googlevideo) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rng := r.Header.Get("Range")
	if !strings.HasPrefix(rng, "bytes=") {
		g.log(r.URL.Path + " full")
		w.WriteHeader(http.StatusForbidden)
		return
	}
	a, b, ok := strings.Cut(strings.TrimPrefix(rng, "bytes="), "-")
	off, err1 := strconv.ParseInt(a, 10, 64)
	end, err2 := strconv.ParseInt(b, 10, 64)
	g.log(fmt.Sprintf("%s %s", r.URL.Path, strings.TrimPrefix(rng, "bytes=")))
	if !ok || err1 != nil || err2 != nil || end < off || off >= g.size {
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if end-off+1 > ytChunkSize {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	g.mu.Lock()
	forbid := g.forbidOnce[off]
	delete(g.forbidOnce, off)
	fail := g.failOnce[off]
	delete(g.failOnce, off)
	cut := g.cutOnce[off]
	delete(g.cutOnce, off)
	expired := g.expiredPath != "" && r.URL.Path == g.expiredPath && off >= g.expiredFrom
	g.mu.Unlock()
	if forbid || expired {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if fail {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if end >= g.size {
		end = g.size - 1
	}
	n := end - off + 1
	w.Header().Set("Content-Type", "audio/mp4")
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", off, end, g.size))
	w.Header().Set("Content-Length", strconv.FormatInt(n, 10))
	w.WriteHeader(http.StatusPartialContent)
	body := fakeContent(off, n)
	if cut {
		_, _ = w.Write(body[:n/2])
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}
	_, _ = w.Write(body)
}

func (g *googlevideo) log(s string) {
	g.mu.Lock()
	g.requests = append(g.requests, s)
	g.mu.Unlock()
}

func (g *googlevideo) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.requests)
}

// proxyFor serves fetcher f over u from a test server, like /ytstream does.
func proxyFor(t *testing.T, f *ytChunkFetcher, u string, done chan<- error) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := f.serve(w, r, u)
		if done != nil {
			done <- err
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newFetcher(reresolve func(context.Context) (string, error)) *ytChunkFetcher {
	return &ytChunkFetcher{
		client:     &http.Client{Timeout: 10 * time.Second},
		chunk:      ytChunkSize,
		retries:    2,
		reresolve:  reresolve,
		retryDelay: time.Millisecond,
	}
}

func getAll(t *testing.T, u string) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading proxied body: %v", err)
	}
	return resp, body
}

func checkBody(t *testing.T, got []byte, size int64) {
	t.Helper()
	if int64(len(got)) != size {
		t.Fatalf("got %d bytes, want %d", len(got), size)
	}
	if !bytes.Equal(got, fakeContent(0, size)) {
		for i := range got {
			if got[i] != fakeByte(int64(i)) {
				t.Fatalf("body differs from upstream at byte %d", i)
			}
		}
	}
}

// The setup that broke playback: a plain GET is refused, so the stream must come
// through as 1 MiB ranges.
func TestGooglevideoFakeRefusesPlainGet(t *testing.T) {
	gv := &googlevideo{size: 3 << 20}
	up := httptest.NewServer(gv)
	defer up.Close()
	resp, err := http.Get(up.URL + "/v1")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("plain GET: http %d, want 403", resp.StatusCode)
	}
}

func TestYtStreamFullBody(t *testing.T) {
	for _, size := range []int64{1, 1000, ytChunkSize, ytChunkSize + 1, 3*ytChunkSize + 12345} {
		t.Run(strconv.FormatInt(size, 10), func(t *testing.T) {
			gv := &googlevideo{size: size}
			up := httptest.NewServer(gv)
			defer up.Close()
			done := make(chan error, 1)
			px := proxyFor(t, newFetcher(nil), up.URL+"/v1", done)
			resp, body := getAll(t, px.URL)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("proxy: http %d", resp.StatusCode)
			}
			if err := <-done; err != nil {
				t.Errorf("serve: %v", err)
			}
			if resp.ContentLength != size {
				t.Errorf("Content-Length %d, want %d", resp.ContentLength, size)
			}
			if ct := resp.Header.Get("Content-Type"); ct != "audio/mp4" {
				t.Errorf("Content-Type %q, want audio/mp4", ct)
			}
			checkBody(t, body, size)
			// exactly ceil(size/chunk) requests, none past the end
			want := int((size + ytChunkSize - 1) / ytChunkSize)
			if n := gv.count(); n != want {
				t.Errorf("%d upstream requests, want %d: %v", n, want, gv.requests)
			}
		})
	}
}

func TestYtStreamReresolvesOnceOn403(t *testing.T) {
	const size = 4*ytChunkSize + 77
	gv := &googlevideo{size: size, expiredPath: "/v1", expiredFrom: 2 * ytChunkSize}
	up := httptest.NewServer(gv)
	defer up.Close()
	var resolves atomic.Int32
	f := newFetcher(func(context.Context) (string, error) {
		resolves.Add(1)
		return up.URL + "/v2", nil
	})
	px := proxyFor(t, f, up.URL+"/v1", nil)
	_, body := getAll(t, px.URL)
	checkBody(t, body, size)
	if n := resolves.Load(); n != 1 {
		t.Fatalf("re-resolved %d times, want 1", n)
	}
}

// After the one re-resolve, a further 403 is a plain failure: the body is cut short and
// the stream is not re-resolved again.
func TestYtStreamReresolvesOnlyOnce(t *testing.T) {
	const size = 4 * ytChunkSize
	gv := &googlevideo{size: size, expiredPath: "/v1", expiredFrom: ytChunkSize}
	up := httptest.NewServer(gv)
	defer up.Close()
	var resolves atomic.Int32
	f := newFetcher(func(context.Context) (string, error) {
		resolves.Add(1)
		return up.URL + "/v1", nil // still expired
	})
	done := make(chan error, 1)
	px := proxyFor(t, f, up.URL+"/v1", done)
	resp, err := http.Get(px.URL)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if int64(len(got)) != ytChunkSize {
		t.Fatalf("got %d bytes, want the %d before the expiry", len(got), ytChunkSize)
	}
	if serr := <-done; serr == nil {
		t.Fatal("serve reported success for a truncated stream")
	}
	if n := resolves.Load(); n != 1 {
		t.Fatalf("re-resolved %d times, want 1", n)
	}
}

func TestYtStreamRetriesFailedChunks(t *testing.T) {
	const size = 3*ytChunkSize + 5
	gv := &googlevideo{size: size,
		failOnce: map[int64]bool{ytChunkSize: true},
		cutOnce:  map[int64]bool{2 * ytChunkSize: true},
	}
	up := httptest.NewServer(gv)
	defer up.Close()
	px := proxyFor(t, newFetcher(nil), up.URL+"/v1", nil)
	_, body := getAll(t, px.URL)
	checkBody(t, body, size)
}

func TestYtStreamGivesUpAfterRetries(t *testing.T) {
	const size = 2 * ytChunkSize
	gv := &googlevideo{size: size, expiredPath: "/v1", expiredFrom: ytChunkSize}
	up := httptest.NewServer(gv)
	defer up.Close()
	done := make(chan error, 1)
	px := proxyFor(t, newFetcher(nil), up.URL+"/v1", done)
	resp, err := http.Get(px.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if serr := <-done; serr == nil {
		t.Fatal("serve reported success")
	}
	// 1 good chunk + 3 attempts (1 + 2 retries) at the failing offset
	if n := gv.count(); n != 4 {
		t.Fatalf("%d upstream requests, want 4: %v", n, gv.requests)
	}
}

// A URL that is refused from the start is a 502 from the proxy, not an empty 200.
func TestYtStreamFirstChunkRefused(t *testing.T) {
	gv := &googlevideo{size: ytChunkSize, expiredPath: "/v1", expiredFrom: 0}
	up := httptest.NewServer(gv)
	defer up.Close()
	px := proxyFor(t, newFetcher(nil), up.URL+"/v1", nil)
	resp, _ := getAll(t, px.URL)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("proxy: http %d, want 502", resp.StatusCode)
	}
}

// When the client (curl, killed by stop/next track) goes away, fetching stops.
func TestYtStreamClientDisconnectStopsFetching(t *testing.T) {
	const size = 64 * ytChunkSize
	gv := &googlevideo{size: size}
	up := httptest.NewServer(gv)
	defer up.Close()
	done := make(chan error, 1)
	px := proxyFor(t, newFetcher(nil), up.URL+"/v1", done)

	resp, err := http.Get(px.URL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(resp.Body, make([]byte, 2*ytChunkSize)); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close() // hang up mid-stream

	select {
	case err := <-done:
		if err == nil {
			t.Error("serve reported a complete stream to a client that hung up")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("proxy handler still running 5s after the client hung up")
	}
	n := gv.count()
	time.Sleep(200 * time.Millisecond)
	if m := gv.count(); m != n {
		t.Fatalf("upstream requests went on after serve returned: %d -> %d", n, m)
	}
	// 2 chunks read + one being written + one fetched ahead, plus slack for socket buffers
	if n > 12 {
		t.Fatalf("%d of %d chunks fetched for a client that read 2", n, size/ytChunkSize)
	}
}

// The probe must refuse a URL whose server takes a tiny range but not the proxy's 1 MiB
// one -- the bytes=0-1 probe it replaces passed such URLs.
func TestYtProbeUsesProxyRequestShape(t *testing.T) {
	gv := &googlevideo{size: 5 * ytChunkSize}
	good := httptest.NewServer(gv)
	defer good.Close()
	if !ytProbePlayable(context.Background(), good.URL+"/v1") {
		t.Fatal("probe refused a servable URL")
	}
	if r := gv.requests[0]; r != "/v1 0-1048575" {
		t.Fatalf("probe sent %q, want the proxy's first chunk", r)
	}
	smallOnly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=0-1" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Range", "bytes 0-1/5000000")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte{1, 2})
	}))
	defer smallOnly.Close()
	if ytProbePlayable(context.Background(), smallOnly.URL) {
		t.Fatal("probe passed a URL that refuses 1 MiB ranges")
	}
	noRange := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("whole file"))
	}))
	defer noRange.Close()
	if ytProbePlayable(context.Background(), noRange.URL) {
		t.Fatal("probe passed a URL that ignores Range")
	}
	// a 200 is the whole file even if it carries a Content-Range; the proxy cannot
	// chunk such a stream
	plain200 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Range", "bytes 0-1048575/5000000")
		_, _ = w.Write(make([]byte, 64))
	}))
	defer plain200.Close()
	if ytProbePlayable(context.Background(), plain200.URL) {
		t.Fatal("probe passed a 200 answer")
	}
}

func TestParseContentRange(t *testing.T) {
	for _, c := range []struct {
		in                 string
		first, last, total int64
		ok                 bool
	}{
		{"bytes 0-1048575/3456789", 0, 1048575, 3456789, true},
		{"bytes 1048576-2097151/2097152", 1048576, 2097151, 2097152, true},
		{"bytes 0-9/*", 0, 9, -1, true},
		{"bytes 0-9/9", 0, 0, 0, false},   // last past the end
		{"bytes 9-0/100", 0, 0, 0, false}, // reversed
		{"bytes */100", 0, 0, 0, false},   // unsatisfied-range form
		{"0-9/100", 0, 0, 0, false},
		{"", 0, 0, 0, false},
	} {
		f, l, tot, ok := parseContentRange(c.in)
		if ok != c.ok || (ok && (f != c.first || l != c.last || tot != c.total)) {
			t.Errorf("parseContentRange(%q) = %d,%d,%d,%v; want %d,%d,%d,%v",
				c.in, f, l, tot, ok, c.first, c.last, c.total, c.ok)
		}
	}
}

func TestYtProxyURL(t *testing.T) {
	if got, want := ytProxyURL("dQw4w9WgXcQ", ""), "http://127.0.0.1:8730/ytstream?id=dQw4w9WgXcQ"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got, want := ytProxyURL("a&b", "OPUS 160"), "http://127.0.0.1:8730/ytstream?id=a%26b&format=OPUS+160"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func getRange(t *testing.T, u, rng string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Range", rng)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading proxied body: %v", err)
	}
	return resp, body
}

// gst's souphttpsrc asks for ranges when the app plays the URL itself (an MP4 index at
// the end, a seek) and stops with "Server does not support seeking" on a 200.
func TestYtStreamServesRanges(t *testing.T) {
	const size = 2*ytChunkSize + 12345
	g := &googlevideo{size: size}
	up := httptest.NewServer(g)
	defer up.Close()
	srv := proxyFor(t, newFetcher(nil), up.URL+"/v", nil)

	for _, c := range []struct {
		rng         string
		first, last int64
	}{
		{"bytes=1000-", 1000, size - 1},
		{"bytes=0-", 0, size - 1},
		{"bytes=1048000-1049999", 1048000, 1049999}, // across a chunk boundary
		{"bytes=5-5", 5, 5},
		{"bytes=100-99999999", 100, size - 1}, // last past the end
	} {
		resp, body := getRange(t, srv.URL, c.rng)
		if resp.StatusCode != http.StatusPartialContent {
			t.Fatalf("%s: status %d, want 206", c.rng, resp.StatusCode)
		}
		if want := fmt.Sprintf("bytes %d-%d/%d", c.first, c.last, size); resp.Header.Get("Content-Range") != want {
			t.Errorf("%s: Content-Range %q, want %q", c.rng, resp.Header.Get("Content-Range"), want)
		}
		if resp.ContentLength != c.last-c.first+1 {
			t.Errorf("%s: Content-Length %d, want %d", c.rng, resp.ContentLength, c.last-c.first+1)
		}
		if !bytes.Equal(body, fakeContent(c.first, c.last-c.first+1)) {
			t.Errorf("%s: body is not bytes %d-%d (%d bytes)", c.rng, c.first, c.last, len(body))
		}
	}
	if resp, _ := getAll(t, srv.URL); resp.Header.Get("Accept-Ranges") != "bytes" {
		t.Errorf("Accept-Ranges %q, want bytes", resp.Header.Get("Accept-Ranges"))
	}
}

func TestYtStreamRangePastEnd(t *testing.T) {
	g := &googlevideo{size: 5000}
	up := httptest.NewServer(g)
	defer up.Close()
	srv := proxyFor(t, newFetcher(nil), up.URL+"/v", nil)
	if resp, _ := getRange(t, srv.URL, "bytes=5000-"); resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status %d, want 416", resp.StatusCode)
	}
}

func TestYtStreamUnservedRangeFormGetsEverything(t *testing.T) {
	const size = ytChunkSize + 77
	g := &googlevideo{size: size}
	up := httptest.NewServer(g)
	defer up.Close()
	srv := proxyFor(t, newFetcher(nil), up.URL+"/v", nil)
	resp, body := getRange(t, srv.URL, "bytes=-500")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	checkBody(t, body, size)
}

func TestParseByteRange(t *testing.T) {
	for _, c := range []struct {
		h           string
		first, last int64
		ok          bool
	}{
		{"bytes=0-", 0, -1, true},
		{"bytes=10-20", 10, 20, true},
		{"bytes=7-7", 7, 7, true},
		{"", 0, 0, false},
		{"bytes=-500", 0, 0, false},
		{"bytes=0-1,5-6", 0, 0, false},
		{"bytes=20-10", 0, 0, false},
		{"bytes=x-", 0, 0, false},
		{"items=0-", 0, 0, false},
	} {
		first, last, ok := parseByteRange(c.h)
		if ok != c.ok || (ok && (first != c.first || last != c.last)) {
			t.Errorf("%q: got %d %d %v, want %d %d %v", c.h, first, last, ok, c.first, c.last, c.ok)
		}
	}
}
