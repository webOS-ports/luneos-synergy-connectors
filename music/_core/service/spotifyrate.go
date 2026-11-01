package main

// Spotify's rate limit, and the polls that run into it.
//
// The limit is on the calls of a rolling 30 s; over it, Spotify answers 429,
// normally with a Retry-After in seconds, and asks that nothing is sent until
// then (developer.spotify.com, Web API, rate limits). The client library drops the
// header, so it is read here, below it. For as long as it says, no call leaves
// the device: each is answered 429 here, which keeps a limit from being extended
// by whoever cannot see it.
//
// What ran into it on the mindphone (2026-10-31 16:54) was /player/status. The
// Music app polls it every second; with the Wi-Fi off the calls behind it hung, the
// polls stopped being answered at 16:52:43, and when the network came back at
// 16:54 about 100 of them arrived in 3 s, each a call to Spotify. So a poll now
// takes at most statusTimeout, and polls share one call: at most one is out, and
// its answer does for those that come within statusTTL.

import (
	"context"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zmb3/spotify/v2"
	"golang.org/x/oauth2"
)

const (
	// rateDefaultWait: a 429 without Retry-After
	rateDefaultWait = 5 * time.Second
	// webTimeout: one call to the Web API. Without it a call hangs for as long as
	// the network does.
	webTimeout = 15 * time.Second
	// commandLimitWait: how long a command waits out a rate limit; longer ones
	// are answered 429
	commandLimitWait = 10 * time.Second
)

// rateGuard holds calls back for as long as Spotify's last 429 said.
type rateGuard struct {
	base http.RoundTripper
	now  func() time.Time

	mu    sync.Mutex
	until time.Time
}

func newRateGuard(base http.RoundTripper) *rateGuard {
	if base == nil {
		base = http.DefaultTransport
	}
	return &rateGuard{base: base, now: time.Now}
}

// webRate guards every call of the daemon's Web API client.
var webRate = newRateGuard(nil)

// remaining is how long calls are still held back.
func (g *rateGuard) remaining() time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	if d := g.until.Sub(g.now()); d > 0 {
		return d
	}
	return 0
}

func retryAfterSeconds(d time.Duration) string {
	return strconv.Itoa(int(math.Ceil(d.Seconds())))
}

func (g *rateGuard) RoundTrip(req *http.Request) (*http.Response, error) {
	// the token endpoint is another service, with limits of its own
	if strings.HasSuffix(req.URL.Path, "/api/token") {
		return g.base.RoundTrip(req)
	}
	if d := g.remaining(); d > 0 {
		h := http.Header{}
		h.Set("Retry-After", retryAfterSeconds(d))
		h.Set("Content-Type", "application/json")
		return &http.Response{
			Status: "429 Too Many Requests", StatusCode: http.StatusTooManyRequests,
			Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1, Header: h, Request: req,
			Body: io.NopCloser(strings.NewReader(`{"error":{"status":429,"message":"API rate limit exceeded"}}`)),
		}, nil
	}
	resp, err := g.base.RoundTrip(req)
	if err != nil || resp.StatusCode != http.StatusTooManyRequests {
		return resp, err
	}
	wait := rateDefaultWait
	if s, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && s >= 0 {
		wait = time.Duration(s) * time.Second
	}
	g.mu.Lock()
	g.until = g.now().Add(wait)
	g.mu.Unlock()
	log.Printf("Spotify: rate limited on %s %s; no calls for %v", req.Method, req.URL.Path, wait)
	return resp, nil
}

// webHTTPClient is the Web API's HTTP client: signed in, guarded, bounded.
func webHTTPClient(src oauth2.TokenSource) *http.Client {
	ctx := context.WithValue(context.Background(), oauth2.HTTPClient, &http.Client{Transport: webRate})
	c := oauth2.NewClient(ctx, src)
	c.Timeout = webTimeout
	return c
}

// isRateLimited: Spotify's 429, or the guard's in its place.
func isRateLimited(err error) bool {
	var se spotify.Error
	return errors.As(err, &se) && se.Status == http.StatusTooManyRequests
}

// waitRateLimit sits out the limit when that takes at most max; false when not.
func waitRateLimit(ctx context.Context, sleep func(context.Context, time.Duration) error, max time.Duration) bool {
	d := webRate.remaining()
	if d > max {
		return false
	}
	return d == 0 || sleep(ctx, d) == nil
}

// --- /player/status -----------------------------------------------------------------------

const (
	// statusTTL is under the Music app's second between polls, which go on
	// seeing a fresh report each; only polls that come together share one.
	statusTTL     = 800 * time.Millisecond
	statusTimeout = 5 * time.Second
)

type statusRun struct {
	done chan struct{}
	st   *spotify.CurrentlyPlaying
	err  error
	at   time.Time
}

type statusCache struct {
	ttl     time.Duration
	timeout time.Duration
	now     func() time.Time

	mu   sync.Mutex
	run  *statusRun // the call out, if any
	last *statusRun // the last answer
}

func newStatusCache() *statusCache {
	return &statusCache{ttl: statusTTL, timeout: statusTimeout, now: time.Now}
}

var playerStatus = newStatusCache()

// get is the report, fresh enough. The call does not belong to any one poll: a
// poll that goes away leaves it running for the others.
func (c *statusCache) get(ctx context.Context, fetch func(context.Context) (*spotify.CurrentlyPlaying, error)) (*spotify.CurrentlyPlaying, error) {
	c.mu.Lock()
	if l := c.last; c.run == nil && l != nil && c.now().Sub(l.at) < c.ttl {
		c.mu.Unlock()
		return l.st, l.err
	}
	run := c.run
	if run == nil {
		run = &statusRun{done: make(chan struct{})}
		c.run = run
		go func() {
			fctx, cancel := context.WithTimeout(context.Background(), c.timeout)
			defer cancel()
			run.st, run.err = fetch(fctx)
			c.mu.Lock()
			run.at = c.now()
			c.run, c.last = nil, run
			c.mu.Unlock()
			close(run.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-run.done:
		return run.st, run.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
