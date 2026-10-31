package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zmb3/spotify/v2"
	"golang.org/x/oauth2"
)

const (
	t4Device = "0000000000000000000000000000000000000000"
	t4Track  = "spotify:track:0FakeTrackId0000000001"
)

// t4Spotify is the Web API and librespot behind it, as they behaved on the
// mindphone at 16:54 on 2026-10-31: a librespot that lost its session is not
// listed; back, it has no track, and a play without uris is answered 204 and
// does nothing; seeks do nothing either; and too many calls in a row get a 429
// with Retry-After.
type t4Spotify struct {
	mu            sync.Mutex
	listed        bool
	track         string // what librespot has
	playing       bool
	positionMs    int
	elsewhere     bool // the play is on another device
	calls         map[string]int
	bare          int  // plays sent at a librespot with nothing
	silent        bool // librespot does not act on a play with uris
	reports       bool // the Web API says playing regardless
	limit         int  // calls allowed before the 429s; 0: no limit
	limitedFor    int  // Retry-After, s
	limitedTill   time.Time
	limitedHits   int
	afterNotFound func()
}

// state is the fields a test looks at, under the lock.
func (s *t4Spotify) state() (track string, positionMs, bare int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.track, s.positionMs, s.bare
}

func (s *t4Spotify) count(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[key]
}

func (s *t4Spotify) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := r.Method + " " + r.URL.Path
	s.calls[key]++
	n := 0
	for _, c := range s.calls {
		n += c
	}
	if s.limit > 0 && n > s.limit && s.limitedTill.IsZero() {
		s.limitedTill = time.Now().Add(time.Duration(s.limitedFor) * time.Second)
	}
	if time.Now().Before(s.limitedTill) {
		s.limitedHits++
		w.Header().Set("Retry-After", strconv.Itoa(s.limitedFor))
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"status":429,"message":"API rate limit exceeded"}}`))
		return
	}
	notFound := func() {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"status":404,"message":"Not found."}}`))
		if f := s.afterNotFound; f != nil {
			s.afterNotFound = nil
			f()
		}
	}
	switch key {
	case "GET /me/player/devices":
		out := map[string]interface{}{"devices": []interface{}{}}
		if s.listed {
			out["devices"] = []interface{}{map[string]interface{}{"id": t4Device, "name": "webOS"}}
		}
		_ = json.NewEncoder(w).Encode(out)
	case "GET /me/player":
		id := t4Device
		if s.elsewhere {
			id = "aaaa"
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"is_playing": s.playing || s.elsewhere, "device": map[string]interface{}{"id": id}})
	case "GET /me/player/currently-playing":
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"is_playing": s.playing || s.reports, "progress_ms": s.positionMs})
	case "PUT /me/player/play":
		if !s.listed {
			notFound()
			return
		}
		var body struct {
			URIs       []string `json:"uris"`
			PositionMs int      `json:"position_ms"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch {
		case len(body.URIs) > 0:
			if s.silent {
				break
			}
			s.track, s.positionMs, s.playing = body.URIs[0], body.PositionMs, true
			uri, pos := body.URIs[0], strconv.Itoa(body.PositionMs)
			go func() {
				noteLibrespotEvent(map[string]string{"PLAYER_EVENT": "track_changed", "URI": uri})
				noteLibrespotEvent(map[string]string{"PLAYER_EVENT": "playing", "POSITION_MS": pos})
			}()
		case s.track == "":
			s.bare++
		default:
			s.playing = true
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		if strings.HasPrefix(key, "GET /tracks/") {
			_, _ = w.Write([]byte(`{"duration_ms":454560}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func useT4(t *testing.T) (*t4Spotify, *librespotHealer) {
	t.Helper()
	useHold(t, 0)
	s := &t4Spotify{listed: true, calls: map[string]int{}, limitedFor: 1}
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	f := &fakeConnect{listed: true}
	h := newTestHealer(t, f, newFakeClock(), time.Hour)
	h.list, h.now, h.sleep = webAPIDevices, time.Now, sleepCtx
	h.poll, h.wait = 20*time.Millisecond, 3*time.Second
	h.setDevice = func(id string) { setDeviceID(spotify.ID(id)) }
	oldHeal, oldName, oldWatch, oldRate := librespotHeal, sess.librespotName, librespotCommands, webRate
	librespotHeal = h
	librespotCommands = &commandWatch{sleep: func(time.Duration) {}, now: time.Now,
		since: func(time.Time) bool { return true }, running: func() bool { return false }}
	sess.mu.Lock()
	oldClient, oldDev := sess.client, sess.deviceID
	sess.client = spotify.New(testWebClient(srv.Client()), spotify.WithBaseURL(srv.URL+"/"))
	sess.deviceID, sess.librespotName = t4Device, "webOS"
	sess.mu.Unlock()
	resetT4State(t)
	t.Cleanup(func() {
		librespotHeal, librespotCommands, webRate = oldHeal, oldWatch, oldRate
		sess.mu.Lock()
		sess.client, sess.deviceID, sess.librespotName = oldClient, oldDev, oldName
		sess.mu.Unlock()
	})
	return s, h
}

// testWebClient is a client of srv with the daemon's guard.
func testWebClient(c *http.Client) *http.Client {
	webRate = newRateGuard(c.Transport)
	return &http.Client{Transport: webRate}
}

// resetT4State: no resume point, no status left by another test.
func resetT4State(t *testing.T) {
	t.Helper()
	oldResume, oldStatus := librespotResume, playerStatus
	librespotResume, playerStatus = newResumePoint(""), newStatusCache()
	t.Cleanup(func() { librespotResume, playerStatus = oldResume, oldStatus })
}

// the session as it stood before the Wi-Fi went: a track paused at 163 s
func t4Playing(t *testing.T) {
	t.Helper()
	if w := post(handlePlayerLoad, "/player/load", `{"uri":"`+t4Track+`"}`); w.Code != http.StatusOK {
		t.Fatalf("load: %d %s", w.Code, w.Body.String())
	}
	noteLibrespotEvent(map[string]string{"PLAYER_EVENT": "track_changed", "URI": t4Track})
	noteLibrespotEvent(map[string]string{"PLAYER_EVENT": "playing", "POSITION_MS": "1000"})
	noteLibrespotEvent(map[string]string{"PLAYER_EVENT": "paused", "POSITION_MS": "163026"})
}

// librespot, the Wi-Fi back: its Connect state machine ended, its device
// unlisted, and when it comes back it has no track.
func t4SessionLost(s *t4Spotify) {
	o, _ := testOutput(nil, newFakeClock(), nil)
	o.line("[2026-10-31T15:54:09Z WARN  librespot_connect::spirc] unexpected shutdown")
	s.mu.Lock()
	s.listed, s.track, s.playing = false, "", false
	s.mu.Unlock()
}

// The order of the failed T4: the app's polls, held up by the outage, all at once;
// its play at a librespot without a device, the rate limit on the look that
// follows; librespot back with nothing; and the play must still play the track,
// from where it was, in one go.
func TestT4PlayAfterTheSessionWasLostResumesTheTrack(t *testing.T) {
	s, h := useT4(t)
	t4Playing(t)
	t4SessionLost(s)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			handlePlayerStatus(w, httptest.NewRequest(http.MethodGet, "/player/status", nil))
		}()
	}
	wg.Wait()
	if n := s.count("GET /me/player/currently-playing"); n > 3 {
		t.Errorf("100 polls at once made %d calls to Spotify", n)
	}

	s.mu.Lock()
	s.calls = map[string]int{}
	s.afterNotFound = func() { s.listed = true; s.limit = 1; s.calls["x"] = 2 } // the look gets a 429
	s.mu.Unlock()

	w := post(handlePlayerPlay, "/player/play", ``)
	if w.Code != http.StatusOK {
		t.Fatalf("play: %d %s", w.Code, w.Body.String())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.track != t4Track || !s.playing || s.positionMs != 163026 || s.bare != 0 {
		t.Fatalf("librespot has %q at %d, playing %v; %d plays at nothing", s.track, s.positionMs, s.playing, s.bare)
	}
	if h.restarts != 0 {
		t.Fatalf("%d restarts: librespot came back by itself", h.restarts)
	}
}

func TestACommandWaitsOutAShortLimit(t *testing.T) {
	s, _ := useT4(t)
	s.mu.Lock()
	s.limit = 1
	s.calls["x"] = 5
	s.mu.Unlock()
	if w := post(handlePlayerPlay, "/player/play", ``); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestLoadIsRememberedBeforeLibrespotSaysSo(t *testing.T) {
	// the session can go between the load and librespot's first event
	s, _ := useT4(t)
	s.mu.Lock()
	s.silent = true
	s.mu.Unlock()
	if w := post(handlePlayerLoad, "/player/load", `{"uri":"`+t4Track+`","position_ms":7000}`); w.Code != http.StatusOK {
		t.Fatalf("%d", w.Code)
	}
	librespotResume.forgot()
	if uri, pos, ok := librespotResume.pending(); !ok || uri != t4Track || pos != 7000 {
		t.Fatalf("%q at %d, %v", uri, pos, ok)
	}
}

func TestASeekOnAPlayingTrackIsSent(t *testing.T) {
	s, _ := useT4(t)
	t4Playing(t)
	if w := post(handlePlayerSeek, "/player/seek", `{"position_ms":5000}`); w.Code != http.StatusOK {
		t.Fatalf("%d", w.Code)
	}
	if n := s.count("PUT /me/player/seek"); n != 1 {
		t.Fatalf("%d seeks sent", n)
	}
}

func TestSeekAfterTheSessionWasLostMovesTheResume(t *testing.T) {
	s, _ := useT4(t)
	t4Playing(t)
	t4SessionLost(s)
	s.mu.Lock()
	s.listed = true
	s.mu.Unlock()
	if w := post(handlePlayerSeek, "/player/seek", `{"position_ms":288959}`); w.Code != http.StatusOK {
		t.Fatalf("seek: %d", w.Code)
	}
	if n := s.count("PUT /me/player/seek"); n != 0 {
		t.Fatalf("%d seeks sent at a librespot with no track", n)
	}
	if w := post(handlePlayerPlay, "/player/play", ``); w.Code != http.StatusOK {
		t.Fatalf("play: %d", w.Code)
	}
	if track, pos, _ := s.state(); pos != 288959 || track != t4Track {
		t.Fatalf("%q at %d", track, pos)
	}
}

func TestAPlayingUserOnAnotherDeviceStaysThere(t *testing.T) {
	// T6, with a session lost: the media session's "play" after a call must not
	// fetch the play back
	s, _ := useT4(t)
	t4Playing(t)
	t4SessionLost(s)
	s.mu.Lock()
	s.listed, s.elsewhere = true, true
	s.mu.Unlock()
	before := s.count("PUT /me/player/play")
	if err := (webAPI{}).play(context.Background()); err != nil {
		t.Fatal(err)
	}
	if track, _, _ := s.state(); track != "" || s.count("PUT /me/player/play") != before {
		t.Fatalf("resumed %q here, %d plays sent", track, s.count("PUT /me/player/play")-before)
	}
	// the Music app's own play is somebody asking: as ever, without the resume
	w := post(handlePlayerPlay, "/player/play", ``)
	if track, _, _ := s.state(); w.Code != http.StatusOK || s.count("PUT /me/player/play") != before+1 || track != "" {
		t.Fatalf("%d, %d plays, track %q", w.Code, s.count("PUT /me/player/play")-before, track)
	}
}

func TestPlayKeysResumeToo(t *testing.T) {
	s, _ := useT4(t)
	t4Playing(t)
	t4SessionLost(s)
	s.mu.Lock()
	s.listed = true
	s.mu.Unlock()
	if err := (webAPI{}).play(context.Background()); err != nil {
		t.Fatal(err)
	}
	if track, pos, _ := s.state(); track != t4Track || pos != 163026 {
		t.Fatalf("%q at %d", track, pos)
	}
}

func TestAPlainPlayStaysBare(t *testing.T) {
	// nothing was lost: a paused track resumes with a bare play, not a reload
	s, _ := useT4(t)
	t4Playing(t)
	if w := post(handlePlayerPlay, "/player/play", ``); w.Code != http.StatusOK {
		t.Fatalf("%d", w.Code)
	}
	if n := s.count("GET /me/player"); n != 0 {
		t.Fatalf("%d looks at the player for a plain play", n)
	}
	if _, pos, _ := s.state(); pos != 0 {
		t.Fatalf("reloaded at %d", pos)
	}
}

func TestResumeEndsWithLibrespotPlayingAgain(t *testing.T) {
	for _, ev := range []string{"playing", "loading", "track_changed"} {
		s, _ := useT4(t)
		t4Playing(t)
		t4SessionLost(s)
		noteLibrespotEvent(map[string]string{"PLAYER_EVENT": ev, "URI": t4Track})
		if _, _, ok := librespotResume.pending(); ok {
			t.Errorf("still pending after %s", ev)
		}
	}
}

func TestNothingToResumeIsABarePlay(t *testing.T) {
	s, _ := useT4(t)
	t4SessionLost(s)
	s.mu.Lock()
	s.listed = true
	s.mu.Unlock()
	if w := post(handlePlayerPlay, "/player/play", ``); w.Code != http.StatusOK {
		t.Fatalf("%d", w.Code)
	}
	if _, _, bare := s.state(); bare != 1 {
		t.Fatalf("%d bare plays", bare)
	}
}

func status(t *testing.T) (int, map[string]interface{}) {
	t.Helper()
	playerStatus = newStatusCache()
	w := httptest.NewRecorder()
	handlePlayerStatus(w, httptest.NewRequest(http.MethodGet, "/player/status", nil))
	var out map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// The user's T4: the old track, tapped, the counter running over silence. Spotify
// takes the play, librespot does nothing: the play must say so, and the reports
// must not say playing.
func TestAPlayLibrespotDidNotTakeIsNotAPlay(t *testing.T) {
	s, _ := useT4(t)
	t4Playing(t)
	librespotPlaying.Store(false)
	t4SessionLost(s)
	librespotResume.wait = 30 * time.Millisecond
	s.mu.Lock()
	s.listed, s.silent, s.reports = true, true, true
	s.mu.Unlock()
	w := post(handlePlayerPlay, "/player/play", ``)
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "did not start") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if code, out := status(t); code != http.StatusOK || out["is_playing"] != false {
		t.Fatalf("%d %v: reported playing over a silent librespot", code, out)
	}
}

func TestReportsWithoutTheWebAPIAreLibrespots(t *testing.T) {
	s, _ := useT4(t)
	t4Playing(t)
	defer librespotPlaying.Store(false)
	s.mu.Lock()
	s.limit, s.limitedFor = 1, 60
	s.calls["x"] = 5
	s.mu.Unlock()

	// no librespot, nothing lost: nothing to say
	if code, _ := status(t); code != http.StatusTooManyRequests {
		t.Fatalf("%d", code)
	}
	librespotResume.forgot() // librespot went
	code, out := status(t)
	if code != http.StatusOK || out["is_playing"] != false || out["uri"] != t4Track || out["position_ms"] != float64(163026) {
		t.Fatalf("%d %v", code, out)
	}
	noteLibrespotEvent(map[string]string{"PLAYER_EVENT": "track_changed", "URI": t4Track})
	noteLibrespotEvent(map[string]string{"PLAYER_EVENT": "playing", "POSITION_MS": "1000"})
	librespotResume.forgot()
	librespotPlaying.Store(true)
	if _, out = status(t); out["is_playing"] != false {
		t.Fatalf("lost and playing: %v", out)
	}
}

func TestPositionRunsOnWhilePlayingAndStopsAtAPause(t *testing.T) {
	clk := newFakeClock()
	r := newResumePoint("")
	r.now = clk.now
	r.event(map[string]string{"PLAYER_EVENT": "track_changed", "URI": t4Track})
	r.event(map[string]string{"PLAYER_EVENT": "playing", "POSITION_MS": "1000"})
	clk.advance(10 * time.Second)
	r.forgot()
	if _, pos, ok := r.pending(); !ok || pos != 11000 {
		t.Fatalf("pos %d ok %v", pos, ok)
	}
	r = newResumePoint("")
	r.now = clk.now
	r.event(map[string]string{"PLAYER_EVENT": "track_changed", "URI": t4Track})
	r.event(map[string]string{"PLAYER_EVENT": "playing", "POSITION_MS": "1000"})
	clk.advance(2 * time.Second)
	r.freeze() // the hold: librespot's "paused" may not come
	clk.advance(time.Hour)
	r.forgot()
	if _, pos, _ := r.pending(); pos != 3000 {
		t.Fatalf("pos %d", pos)
	}
	r.event(map[string]string{"PLAYER_EVENT": "end_of_track"})
	if _, pos, _ := r.pending(); pos != 0 {
		t.Fatalf("pos %d after the end", pos)
	}
}

func TestPausesStopTheClockBeforeLibrespotSaysSo(t *testing.T) {
	// held, librespot's "paused" can be long in coming
	for name, pause := range map[string]func(){
		"app":     func() { post(handlePlayerPause, "/player/pause", ``) },
		"session": func() { (&librespotControl{hold: librespotHold, api: nopAPI{}, timeout: time.Second}).pause() },
	} {
		s, _ := useT4(t)
		_ = s
		clk := newFakeClock()
		librespotResume.now = clk.now
		librespotResume.event(map[string]string{"PLAYER_EVENT": "track_changed", "URI": t4Track})
		librespotResume.event(map[string]string{"PLAYER_EVENT": "playing", "POSITION_MS": "1000"})
		clk.advance(time.Second)
		pause()
		clk.advance(time.Hour)
		if _, pos, _ := librespotResume.pending(); pos != 2000 {
			t.Errorf("%s: position %d", name, pos)
		}
	}
}

type nopAPI struct{}

func (nopAPI) pause(context.Context) error         { return nil }
func (nopAPI) play(context.Context) error          { return nil }
func (nopAPI) next(context.Context) error          { return nil }
func (nopAPI) previous(context.Context) error      { return nil }
func (nopAPI) state(context.Context) (bool, error) { return false, nil }

func TestEventsMoveThePosition(t *testing.T) {
	clk := newFakeClock()
	r := newResumePoint("")
	r.now = clk.now
	r.loaded(t4Track, 5000)
	r.event(map[string]string{"PLAYER_EVENT": "track_changed", "URI": t4Track})
	if _, pos, _ := r.pending(); pos != 5000 {
		t.Fatalf("the same track lost its position: %d", pos)
	}
	r.event(map[string]string{"PLAYER_EVENT": "playing", "POSITION_MS": "5000"})
	clk.advance(time.Second)
	r.event(map[string]string{"PLAYER_EVENT": "seeked", "POSITION_MS": "9000"})
	clk.advance(time.Second)
	if _, pos, _ := r.pending(); pos != 10000 {
		t.Fatalf("after a seek: %d", pos)
	}
	r.event(map[string]string{"PLAYER_EVENT": "stopped"})
	clk.advance(time.Hour)
	if _, pos, _ := r.pending(); pos != 10000 {
		t.Fatalf("after a stop: %d", pos)
	}
	r.event(map[string]string{"PLAYER_EVENT": "track_changed", "URI": "spotify:track:other"})
	if uri, pos, _ := r.pending(); pos != 0 || uri != "spotify:track:other" {
		t.Fatalf("a new track: %q at %d", uri, pos)
	}
}

func TestResumeSurvivesARestartOfTheDaemon(t *testing.T) {
	p := filepath.Join(t.TempDir(), "resume.json")
	r := newResumePoint(p)
	r.loaded(t4Track, 0)
	r.event(map[string]string{"PLAYER_EVENT": "paused", "POSITION_MS": "5000"})
	r2 := newResumePoint(p)
	if uri, pos, ok := r2.pending(); !ok || uri != t4Track || pos != 5000 {
		t.Fatalf("%q %d %v", uri, pos, ok)
	}
	if fi, err := os.Stat(p); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", fi, err)
	}
	_ = os.WriteFile(p, []byte("not json"), 0o600)
	if _, _, ok := newResumePoint(p).pending(); ok {
		t.Fatal("garbage taken for a track")
	}
}

// --- the rate limit ---------------------------------------------------------------------

func TestRateLimitIsHonouredAndPassedOn(t *testing.T) {
	s, _ := useT4(t)
	s.mu.Lock()
	s.limit, s.limitedFor = 1, 120
	s.calls["x"] = 5
	s.mu.Unlock()
	w := post(handlePlayerPlay, "/player/play", ``)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("%d, Retry-After %q", w.Code, w.Header().Get("Retry-After"))
	}
	// everything after it waits, without bothering Spotify
	for i := 0; i < 5; i++ {
		post(handlePlayerPlay, "/player/play", ``)
		st := httptest.NewRecorder()
		handlePlayerStatus(st, httptest.NewRequest(http.MethodGet, "/player/status", nil))
		time.Sleep(2 * time.Millisecond)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.limitedHits != 1 {
		t.Fatalf("%d calls hit the limit, want the 1 that found it", s.limitedHits)
	}
}

func TestRateGuardWaitsForRetryAfter(t *testing.T) {
	clk := newFakeClock()
	g := newRateGuard(nil)
	g.now = clk.now
	g.base = roundTrip(func(*http.Request) (*http.Response, error) {
		rec := httptest.NewRecorder()
		rec.Header().Set("Retry-After", "7")
		rec.WriteHeader(http.StatusTooManyRequests)
		return rec.Result(), nil
	})
	req := httptest.NewRequest(http.MethodGet, "https://api.spotify.com/v1/me", nil)
	if _, err := g.RoundTrip(req); err != nil {
		t.Fatal(err)
	}
	if d := g.remaining(); d != 7*time.Second {
		t.Fatalf("remaining %v", d)
	}
	g.base = roundTrip(func(*http.Request) (*http.Response, error) {
		t.Fatal("sent during the limit")
		return nil, nil
	})
	resp, err := g.RoundTrip(req)
	if err != nil || resp.StatusCode != 429 || resp.Header.Get("Retry-After") != "7" {
		t.Fatalf("%v %v", resp, err)
	}
	clk.advance(7 * time.Second)
	if d := g.remaining(); d != 0 {
		t.Fatalf("remaining %v", d)
	}
	// no header: a default, not nothing
	g.base = roundTrip(func(*http.Request) (*http.Response, error) {
		rec := httptest.NewRecorder()
		rec.WriteHeader(http.StatusTooManyRequests)
		return rec.Result(), nil
	})
	_, _ = g.RoundTrip(req)
	if d := g.remaining(); d != rateDefaultWait {
		t.Fatalf("remaining %v", d)
	}
}

func TestRateGuardLeavesTheTokenEndpointAlone(t *testing.T) {
	calls := 0
	g := newRateGuard(roundTrip(func(*http.Request) (*http.Response, error) {
		calls++
		rec := httptest.NewRecorder()
		return rec.Result(), nil
	}))
	g.until = time.Now().Add(time.Hour)
	req := httptest.NewRequest(http.MethodPost, "https://accounts.spotify.com/api/token", nil)
	if _, err := g.RoundTrip(req); err != nil || calls != 1 {
		t.Fatalf("%d calls, %v", calls, err)
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestStatusAnswersWithinItsTimeoutWhenSpotifyHangs(t *testing.T) {
	// 16:52:43: the Wi-Fi gone, the polls stopped being answered and piled up
	release := make(chan struct{})
	c := newStatusCache()
	c.timeout = 20 * time.Millisecond
	done := make(chan error, 1)
	go func() {
		_, err := c.get(context.Background(), func(ctx context.Context) (*spotify.CurrentlyPlaying, error) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return nil, nil
			}
		})
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("no error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("hung")
	}
	close(release)
}

func TestStatusIsSharedButNotKept(t *testing.T) {
	clk := newFakeClock()
	c := newStatusCache()
	c.now = clk.now
	calls := 0
	fetch := func(context.Context) (*spotify.CurrentlyPlaying, error) {
		calls++
		return &spotify.CurrentlyPlaying{}, nil
	}
	_, _ = c.get(context.Background(), fetch)
	_, _ = c.get(context.Background(), fetch)
	if calls != 1 {
		t.Fatalf("%d calls within the ttl", calls)
	}
	clk.advance(c.ttl)
	_, _ = c.get(context.Background(), fetch)
	if calls != 2 {
		t.Fatalf("%d calls after the ttl", calls)
	}
	if c.ttl >= time.Second {
		t.Fatal("ttl of a second or more: the app's 1 Hz poll would see stale reports")
	}
}

func TestDaemonWebClientHasATimeout(t *testing.T) {
	c := webHTTPClient(oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "test"}))
	if c.Timeout == 0 || c.Timeout > 30*time.Second {
		t.Fatalf("timeout %v", c.Timeout)
	}
	if tr, ok := c.Transport.(*oauth2.Transport); !ok || tr.Base != http.RoundTripper(webRate) {
		t.Fatalf("not guarded: %T", c.Transport)
	}
}
