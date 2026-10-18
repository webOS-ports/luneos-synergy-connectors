package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// /ytstream: a localhost proxy that plays a YouTube audio stream through the shared
// curl | gst stream player.
//
// googlevideo serves the audio URLs the player API hands out only in pieces: a request
// for at most 1 MiB (a Range header of bytes=0-1048575, or the &range= URL parameter)
// is answered 206, but a plain GET of the whole file and a 10 MiB range are answered
// 403, whatever the User-Agent. curl -sL '<url>' is such a plain GET, so handing the URL
// straight to the stream player played nothing: curl got a 403, gst saw an empty stream
// and the track "ended" at position 0.
//
// So the YouTube provider's StreamURL returns http://127.0.0.1:8730/ytstream?id=<videoId>
// instead, and this handler fetches the resolved URL in sequential 1 MiB Range chunks and
// writes them out as one plain response body. The total length comes from the first
// chunk's Content-Range and becomes the response's Content-Length; fetching stops at the
// end. A failed chunk is retried; a 403 (the signed URL expired, e.g. after a long pause)
// re-resolves the video once and carries on at the same offset. The next chunk is fetched
// while the current one is being written, so the player is not starved between chunks,
// and since a chunk is read into memory before it is written, a paused (SIGSTOPped)
// curl never holds an upstream request open. When the client goes away, the request
// context ends the fetching.
//
// GET /ytstream?id=<videoId>[&format=<label>]  (format: an ytFmtLabel label, as used by
// /stream/switchformat, e.g. "OPUS 160"). No CORS: only curl on this device talks to it.

// ytChunkSize is the largest range googlevideo answers with 206 (1 MiB).
const ytChunkSize = 1 << 20

// ytStreamHTTP fetches googlevideo ranges. No cookie jar (googlevideo needs none). The
// timeout covers one chunk; a chunk cut short is resumed where it stopped.
var ytStreamHTTP = &http.Client{Timeout: 60 * time.Second}

const ytStreamUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

// ytProxyURL is what the YouTube provider hands to the stream player.
func ytProxyURL(videoID, format string) string {
	u := "http://127.0.0.1:8730/ytstream?id=" + url.QueryEscape(videoID)
	if format != "" {
		u += "&format=" + url.QueryEscape(format)
	}
	return u
}

// ---- resolved-URL cache ----
// /provider/youtube/play resolves (and probes) the URL to report errors and the format
// badge at once; the curl that the player starts a moment later should not resolve it a
// second time. googlevideo URLs stay valid for hours; an expired one is caught by the 403
// re-resolve anyway.
type ytResolvedURL struct {
	url string
	at  time.Time
}

const ytResolvedTTL = time.Hour

var (
	ytResolvedMu sync.Mutex
	ytResolved   = map[string]ytResolvedURL{}
)

func ytCacheKey(id, format string) string { return id + "\x00" + format }

func ytCachePut(id, format, u string) {
	ytResolvedMu.Lock()
	defer ytResolvedMu.Unlock()
	if len(ytResolved) >= 32 { // a handful of recent tracks is all that is ever needed
		ytResolved = map[string]ytResolvedURL{}
	}
	ytResolved[ytCacheKey(id, format)] = ytResolvedURL{url: u, at: time.Now()}
}

func ytCacheGet(id, format string) string {
	ytResolvedMu.Lock()
	defer ytResolvedMu.Unlock()
	e, ok := ytResolved[ytCacheKey(id, format)]
	if !ok || time.Since(e.at) > ytResolvedTTL {
		return ""
	}
	return e.url
}

// ytResolveDirect resolves (and caches) the googlevideo audio URL for a video.
func ytResolveDirect(ctx context.Context, id, format string) (string, error) {
	u, err := (&youtubeProvider{}).streamURL(ctx, id, format, "audio")
	if err != nil {
		return "", err
	}
	ytCachePut(id, format, u)
	return u, nil
}

func handleYtStream(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	format := r.URL.Query().Get("format")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	u := ytCacheGet(id, format)
	if u == "" {
		var err error
		if u, err = ytResolveDirect(r.Context(), id, format); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	f := &ytChunkFetcher{
		client:  ytStreamHTTP,
		chunk:   ytChunkSize,
		retries: 2,
		reresolve: func(ctx context.Context) (string, error) {
			log.Printf("ytstream %s: 403 mid-stream, re-resolving", id)
			return ytResolveDirect(ctx, id, format)
		},
	}
	n, err := f.serve(w, r, u)
	if err != nil && r.Context().Err() == nil {
		log.Printf("ytstream %s: stopped after %d bytes: %v", id, n, err)
		return
	}
	log.Printf("ytstream %s: %d bytes served", id, n)
}

// ---- chunked range fetching ----

// ytStatusError is a non-206 upstream answer.
type ytStatusError struct{ code int }

func (e *ytStatusError) Error() string { return fmt.Sprintf("upstream http %d", e.code) }

// ytRangeGet issues GET u with Range: bytes=off-end. The caller closes the body.
func ytRangeGet(ctx context.Context, client *http.Client, u string, off, end int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", "bytes="+strconv.FormatInt(off, 10)+"-"+strconv.FormatInt(end, 10))
	req.Header.Set("User-Agent", ytStreamUA)
	return client.Do(req)
}

// parseContentRange parses "bytes <first>-<last>/<total>". total is -1 for "*".
func parseContentRange(s string) (first, last, total int64, ok bool) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "bytes ") {
		return 0, 0, 0, false
	}
	rng, tot, found := strings.Cut(strings.TrimSpace(s[len("bytes "):]), "/")
	if !found {
		return 0, 0, 0, false
	}
	a, b, found := strings.Cut(rng, "-")
	if !found {
		return 0, 0, 0, false
	}
	var err error
	if first, err = strconv.ParseInt(a, 10, 64); err != nil || first < 0 {
		return 0, 0, 0, false
	}
	if last, err = strconv.ParseInt(b, 10, 64); err != nil || last < first {
		return 0, 0, 0, false
	}
	if tot == "*" {
		return first, last, -1, true
	}
	if total, err = strconv.ParseInt(tot, 10, 64); err != nil || total <= last {
		return 0, 0, 0, false
	}
	return first, last, total, true
}

type ytChunkFetcher struct {
	client  *http.Client
	chunk   int64 // bytes per Range request
	retries int   // extra attempts for a chunk that fails
	// reresolve returns a fresh URL for the same stream; used once, on a 403.
	reresolve func(ctx context.Context) (string, error)
	// retryDelay is the pause before retry n (n*retryDelay); 0 means 300ms.
	retryDelay time.Duration
}

// ytRangeStream is the state of one proxied stream.
type ytRangeStream struct {
	f          *ytChunkFetcher
	url        string
	total      int64 // -1 until known
	ctype      string
	eof        bool // total unknown and upstream sent a short chunk
	reresolved bool
}

// fetch requests the chunk at off and returns what arrived. On a read error after some
// bytes it returns those bytes and no error; the caller asks for the rest next.
func (s *ytRangeStream) fetch(ctx context.Context, off int64) ([]byte, error) {
	end := off + s.f.chunk - 1
	if s.total >= 0 && end >= s.total {
		end = s.total - 1
	}
	resp, err := ytRangeGet(ctx, s.f.client, s.url, off, end)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusPartialContent:
		first, last, total, ok := parseContentRange(resp.Header.Get("Content-Range"))
		if !ok || first != off || last > end {
			return nil, fmt.Errorf("bad Content-Range %q for bytes=%d-%d", resp.Header.Get("Content-Range"), off, end)
		}
		if total >= 0 {
			if s.total >= 0 && total != s.total {
				return nil, fmt.Errorf("stream length changed from %d to %d", s.total, total)
			}
			s.total = total
		}
		end = last
	case http.StatusOK:
		// Range ignored: acceptable only for a file that fits in one chunk.
		if off != 0 || resp.ContentLength < 0 || resp.ContentLength > s.f.chunk {
			return nil, fmt.Errorf("upstream ignored Range (http 200, length %d)", resp.ContentLength)
		}
		s.total = resp.ContentLength
		end = resp.ContentLength - 1
	default:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, &ytStatusError{resp.StatusCode}
	}
	if s.ctype == "" {
		s.ctype = resp.Header.Get("Content-Type")
	}
	want := end - off + 1
	buf := make([]byte, want)
	n, rerr := io.ReadFull(resp.Body, buf)
	if n == 0 && want > 0 {
		if rerr == nil || rerr == io.EOF {
			rerr = io.ErrUnexpectedEOF
		}
		return nil, rerr
	}
	if int64(n) < want && s.total < 0 && rerr == io.ErrUnexpectedEOF {
		s.eof = true // length unknown: a short body ends the stream
	}
	return buf[:n], nil
}

// next returns the bytes at off, retrying a failed chunk and re-resolving once on 403.
func (s *ytRangeStream) next(ctx context.Context, off int64) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt <= s.f.retries; {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		data, err := s.fetch(ctx, off)
		if err == nil {
			return data, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var se *ytStatusError
		if errors.As(err, &se) && se.code == http.StatusForbidden && !s.reresolved && s.f.reresolve != nil {
			s.reresolved = true
			nu, rerr := s.f.reresolve(ctx)
			if rerr != nil {
				return nil, fmt.Errorf("re-resolve after 403: %w", rerr)
			}
			s.url = nu
			continue // a fresh URL gets a fresh set of attempts
		}
		attempt++
		if attempt > s.f.retries {
			break
		}
		d := s.f.retryDelay
		if d == 0 {
			d = 300 * time.Millisecond
		}
		t := time.NewTimer(time.Duration(attempt) * d)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil, ctx.Err()
		case <-t.C:
		}
		log.Printf("ytstream: retrying bytes from %d (attempt %d): %v", off, attempt+1, err)
	}
	return nil, lastErr
}

func (s *ytRangeStream) done(off int64) bool {
	return s.eof || (s.total >= 0 && off >= s.total)
}

// serve streams u to w from offset 0 and returns the bytes written. The first chunk is
// fetched before any header is written, so a URL that cannot be played is a 502.
func (f *ytChunkFetcher) serve(w http.ResponseWriter, r *http.Request, u string) (int64, error) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s := &ytRangeStream{f: f, url: u, total: -1}
	first, err := s.next(ctx, 0)
	if err != nil {
		http.Error(w, "youtube stream: "+err.Error(), http.StatusBadGateway)
		return 0, err
	}
	if s.ctype != "" {
		w.Header().Set("Content-Type", s.ctype)
	}
	if s.total >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(s.total, 10))
	}
	w.WriteHeader(http.StatusOK)

	// Producer: fetch the following chunks, one ahead of the writer.
	chunks := make(chan []byte, 1)
	var perr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(chunks)
		off := int64(len(first))
		for !s.done(off) {
			data, err := s.next(ctx, off)
			if err != nil {
				perr = err
				return
			}
			select {
			case chunks <- data:
			case <-ctx.Done():
				perr = ctx.Err()
				return
			}
			off += int64(len(data))
		}
	}()

	var written int64
	n, werr := w.Write(first)
	written += int64(n)
	if werr == nil {
		for data := range chunks {
			n, werr = w.Write(data)
			written += int64(n)
			if werr != nil {
				break
			}
		}
	}
	cancel() // client gone or stream over: stop the producer
	for range chunks {
	}
	wg.Wait()
	if werr != nil {
		return written, werr
	}
	if perr != nil {
		return written, perr
	}
	return written, nil
}
