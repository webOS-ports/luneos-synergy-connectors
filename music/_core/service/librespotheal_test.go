package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zmb3/spotify/v2"
)

// fakeClock: sleeping moves it on, at once.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Date(2026, 10, 31, 14, 0, 0, 0, time.UTC)} }

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func (c *fakeClock) sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.advance(d)
	return nil
}

// fakeConnect is Spotify's device list, and librespot in it.
type fakeConnect struct {
	mu        sync.Mutex
	listed    bool // librespot's device is in the list
	active    bool // and plays
	others    []connectDevice
	listErr   error
	restarts  int
	reappear  int // looks after a restart until it is listed again; -1: never
	countdown int
	device    string
	looks     int
}

func (f *fakeConnect) list(ctx context.Context) ([]connectDevice, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.looks++
	if f.listErr != nil {
		return nil, f.listErr
	}
	if !f.listed && f.countdown > 0 {
		f.countdown--
		if f.countdown == 0 {
			f.listed = true
		}
	}
	devs := append([]connectDevice(nil), f.others...)
	if f.listed {
		devs = append(devs, connectDevice{id: "ad6d078a", name: "webOS", active: f.active})
	}
	return devs, nil
}

func (f *fakeConnect) restart() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarts++
	if f.reappear >= 0 {
		f.countdown = f.reappear + 1
	}
}

func (f *fakeConnect) setDevice(id string) {
	f.mu.Lock()
	f.device = id
	f.mu.Unlock()
}

func (f *fakeConnect) restartCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.restarts
}

func newTestHealer(t *testing.T, f *fakeConnect, clk *fakeClock, librespotAge time.Duration) *librespotHealer {
	t.Helper()
	h := newLibrespotHealer()
	h.name = "webOS"
	h.list, h.restart, h.setDevice = f.list, f.restart, f.setDevice
	h.now, h.sleep = clk.now, clk.sleep
	h.running = func() (int, time.Time) { return 4242, clk.now().Add(-librespotAge) }
	h.playing = func() bool { return false }
	return h
}

func TestHealRestartsWhenTheDeviceIsGoneAndWaitsForIt(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{reappear: 2}
	h := newTestHealer(t, f, clk, time.Hour)
	if err := h.heal(context.Background(), "test", true); err != nil {
		t.Fatalf("heal: %v", err)
	}
	if f.restartCount() != 1 || f.device != "ad6d078a" {
		t.Fatalf("restarts %d, device %q", f.restarts, f.device)
	}
}

func TestHealGivesUpAfterItsWait(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{reappear: -1}
	h := newTestHealer(t, f, clk, time.Hour)
	start := clk.now()
	if err := h.heal(context.Background(), "test", true); !errors.Is(err, errDeviceMissing) {
		t.Fatalf("heal: %v, want errDeviceMissing", err)
	}
	if waited := clk.now().Sub(start); waited < h.wait || waited > h.wait+2*h.poll {
		t.Fatalf("waited %v, want about %v", waited, h.wait)
	}
}

func TestHealLeavesAListedDeviceAlone(t *testing.T) {
	// the user moved the play to their phone: ours is listed, not active
	clk := newFakeClock()
	f := &fakeConnect{listed: true, others: []connectDevice{{id: "p", name: "Pixel", active: true}}}
	h := newTestHealer(t, f, clk, time.Hour)
	for i := 0; i < 3; i++ {
		if err := h.heal(context.Background(), "test", true); err != nil {
			t.Fatal(err)
		}
		h.onLossNow("Connection to server closed.")
	}
	if f.restartCount() != 0 {
		t.Fatalf("restarted %d times; the device was there, only inactive", f.restarts)
	}
}

func TestHealDoesNotRestartWithoutANetwork(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{listErr: errors.New("dial tcp: lookup api.spotify.com: server misbehaving")}
	h := newTestHealer(t, f, clk, time.Hour)
	if err := h.heal(context.Background(), "test", true); err == nil || f.restartCount() != 0 {
		t.Fatalf("err %v, restarts %d", err, f.restarts)
	}
}

func TestHealGivesAYoungLibrespotTime(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{reappear: -1}
	h := newTestHealer(t, f, clk, 10*time.Second)
	_ = h.heal(context.Background(), "test", true)
	if f.restartCount() != 0 {
		t.Fatal("restarted a librespot still registering")
	}
}

func TestOneEmptyListIsNotARestart(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{countdown: 2} // missing from the first look, back for the second
	h := newTestHealer(t, f, clk, time.Hour)
	if err := h.heal(context.Background(), "test", true); err != nil || f.restartCount() != 0 {
		t.Fatalf("err %v, restarts %d", err, f.restarts)
	}
}

func TestABackgroundLookDoesNotCutTheMusic(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{reappear: 0}
	h := newTestHealer(t, f, clk, time.Hour)
	h.playing = func() bool { return true }
	h.check("periodic check")
	if f.restartCount() != 0 {
		t.Fatal("restarted a playing librespot from the background")
	}
	// a command that needs the device does restart it
	if err := h.heal(context.Background(), "load", true); err != nil || f.restartCount() != 1 {
		t.Fatalf("err %v, restarts %d", err, f.restarts)
	}
}

func TestHealRestartBackoff(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{reappear: -1}
	h := newTestHealer(t, f, clk, time.Hour)
	h.wait, h.poll = 0, 0 // no waiting: only the restarts count here
	heal := func() { _ = h.heal(context.Background(), "test", true) }

	heal()
	if f.restartCount() != 1 || h.backoff != h.backoffMin {
		t.Fatalf("restarts %d, backoff %v", f.restarts, h.backoff)
	}
	clk.advance(h.backoffMin - time.Second)
	heal()
	if f.restartCount() != 1 {
		t.Fatal("restarted again within the backoff")
	}
	clk.advance(time.Second)
	heal()
	if f.restartCount() != 2 || h.backoff != 2*h.backoffMin {
		t.Fatalf("restarts %d, backoff %v", f.restarts, h.backoff)
	}
	for i := 0; i < 10; i++ {
		clk.advance(h.backoffMax)
		heal()
	}
	if h.backoff != h.backoffMax {
		t.Fatalf("backoff %v, want the cap %v", h.backoff, h.backoffMax)
	}
	// listed for long enough after the last restart: the backoff starts again
	f.listed = true
	clk.advance(h.stable)
	heal()
	if h.backoff != 0 {
		t.Fatalf("backoff %v after a stable device", h.backoff)
	}
}

func TestHealsAtTheSameTimeShareOneRestart(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{reappear: 3}
	h := newTestHealer(t, f, clk, time.Hour)
	gate := make(chan struct{})
	inner := h.sleep
	h.sleep = func(ctx context.Context, d time.Duration) error { <-gate; return inner(ctx, d) }
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range errs {
		wg.Add(1)
		go func(i int) { defer wg.Done(); errs[i] = h.heal(context.Background(), "test", true) }(i)
	}
	time.Sleep(50 * time.Millisecond)
	f.mu.Lock()
	looks := f.looks
	f.mu.Unlock()
	if looks != 1 {
		t.Fatalf("%d looks at the list by 4 callers: each is healing on its own", looks)
	}
	close(gate)
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if f.restartCount() != 1 {
		t.Fatalf("%d restarts for one missing device", f.restarts)
	}
}

func TestStartedLooksUntilListedAndNeverRestarts(t *testing.T) {
	// the boot of 14:07: librespot registered after the one look 6 s in, and
	// every /player/load then had no device until the daemon was restarted
	clk := newFakeClock()
	f := &fakeConnect{countdown: 4}
	h := newTestHealer(t, f, clk, 0)
	done := make(chan struct{})
	h.setDevice = func(id string) { f.setDevice(id); close(done) }
	h.started()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("device never selected")
	}
	if f.restartCount() != 0 || f.device != "ad6d078a" {
		t.Fatalf("restarts %d, device %q", f.restarts, f.device)
	}
}

func TestLossLoggedChecksOnceAfterItsDelay(t *testing.T) {
	clk := newFakeClock()
	f := &fakeConnect{reappear: 0}
	h := newTestHealer(t, f, clk, time.Hour)
	release := make(chan struct{})
	inner := h.sleep
	slept := make(chan time.Duration, 10)
	h.sleep = func(ctx context.Context, d time.Duration) error {
		if d == h.lossDelay {
			slept <- d
			<-release
		}
		return inner(ctx, d)
	}
	h.onLoss("WARN core::session: Connection to server closed.")
	<-slept
	h.onLoss("WARN core::dealer: Websocket connection failed")
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for f.restartCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if f.restartCount() != 1 || len(slept) != 0 {
		t.Fatalf("restarts %d, pending looks %d", f.restarts, len(slept))
	}
}

// onLossNow is onLoss without its delay.
func (h *librespotHealer) onLossNow(line string) { h.check("librespot logged: " + line) }

// --- the commands, through a fake Web API ------------------------------------------------

// fakeWebAPI answers the Web API as Spotify does for librespot's device: listed or
// not, and 404 for a command to a device it does not list.
type fakeWebAPI struct {
	mu       sync.Mutex
	f        *fakeConnect
	commands []string
}

func (a *fakeWebAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/me/player/devices":
		devs, _ := a.f.list(r.Context())
		var out struct {
			Devices []map[string]interface{} `json:"devices"`
		}
		for _, d := range devs {
			out.Devices = append(out.Devices, map[string]interface{}{"id": d.id, "name": d.name, "is_active": d.active})
		}
		_ = json.NewEncoder(w).Encode(out)
	case strings.HasPrefix(r.URL.Path, "/me/player/"):
		a.f.mu.Lock()
		listed := a.f.listed
		a.f.mu.Unlock()
		a.mu.Lock()
		a.commands = append(a.commands, fmt.Sprintf("%s %s %v", r.Method, r.URL.Path, listed))
		a.mu.Unlock()
		if !listed || r.URL.Query().Get("device_id") != "ad6d078a" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"status":404,"message":"Device not found"}}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(r.URL.Path, "/tracks/"):
		_, _ = w.Write([]byte(`{"duration_ms":1000}`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (a *fakeWebAPI) sent() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.commands...)
}

// useWebAPI points the session and the healer at a fake Web API.
func useWebAPI(t *testing.T, f *fakeConnect, deviceID string) (*fakeWebAPI, *fakeClock) {
	t.Helper()
	useHold(t, 0)
	api := &fakeWebAPI{f: f}
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	clk := newFakeClock()
	h := newTestHealer(t, f, clk, time.Hour)
	h.list = webAPIDevices
	h.setDevice = func(id string) { setDeviceID(spotify.ID(id)); f.setDevice(id) }
	oldHeal, oldName, oldWatch := librespotHeal, sess.librespotName, librespotCommands
	librespotHeal = h
	// the not-acted-on watch is tested on its own
	librespotCommands = &commandWatch{sleep: func(time.Duration) {}, now: time.Now,
		since: func(time.Time) bool { return true }, running: func() bool { return false }}
	sess.mu.Lock()
	oldClient, oldDev := sess.client, sess.deviceID
	sess.client = spotify.New(srv.Client(), spotify.WithBaseURL(srv.URL+"/"))
	sess.deviceID, sess.librespotName = spotify.ID(deviceID), "webOS"
	sess.mu.Unlock()
	t.Cleanup(func() {
		librespotHeal, librespotCommands = oldHeal, oldWatch
		sess.mu.Lock()
		sess.client, sess.deviceID, sess.librespotName = oldClient, oldDev, oldName
		sess.mu.Unlock()
	})
	return api, clk
}

func post(h http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
	return w
}

func TestLoadAfterTheDeviceDisappearedRestartsAndRetries(t *testing.T) {
	f := &fakeConnect{reappear: 1}
	api, _ := useWebAPI(t, f, "ad6d078a") // known from before; now gone
	w := post(handlePlayerLoad, "/player/load", `{"uri":"spotify:track:x"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	got := api.sent()
	if f.restartCount() != 1 || len(got) != 2 || got[0] != "PUT /me/player/play false" || got[1] != "PUT /me/player/play true" {
		t.Fatalf("restarts %d, commands %v", f.restarts, got)
	}
}

func TestLoadWithNoDeviceKnownFindsItWithoutARestart(t *testing.T) {
	f := &fakeConnect{listed: true}
	api, _ := useWebAPI(t, f, "")
	w := post(handlePlayerLoad, "/player/load", `{"uri":"spotify:track:x"}`)
	if w.Code != http.StatusOK || f.restartCount() != 0 || len(api.sent()) != 1 {
		t.Fatalf("%d %s, restarts %d, commands %v", w.Code, w.Body.String(), f.restarts, api.sent())
	}
}

func TestLoadAnswers409WhenTheDeviceStaysAway(t *testing.T) {
	f := &fakeConnect{reappear: -1}
	api, _ := useWebAPI(t, f, "")
	w := post(handlePlayerLoad, "/player/load", `{"uri":"spotify:track:x"}`)
	if w.Code != http.StatusConflict || len(api.sent()) != 0 {
		t.Fatalf("%d %s, commands %v", w.Code, w.Body.String(), api.sent())
	}
}

func TestEveryDeviceCommandHeals(t *testing.T) {
	for _, c := range []struct {
		h    http.HandlerFunc
		path string
	}{
		{handlePlayerPlay, "/player/play"}, {handlePlayerNext, "/player/next"},
		{handlePlayerPrev, "/player/previous"}, {handlePlayerSeek, "/player/seek"},
		{handlePlayerVolume, "/player/volume"},
	} {
		f := &fakeConnect{reappear: 0}
		api, _ := useWebAPI(t, f, "ad6d078a")
		w := post(c.h, c.path, `{}`)
		if w.Code != http.StatusOK || f.restartCount() != 1 || len(api.sent()) != 2 {
			t.Errorf("%s: %d, restarts %d, commands %v", c.path, w.Code, f.restarts, api.sent())
		}
	}
}

func TestPlayOnAnotherDeviceActiveIsSentWithoutARestart(t *testing.T) {
	// the user plays on their phone; the Music app's play brings it here, as it did
	f := &fakeConnect{listed: true, others: []connectDevice{{id: "p", name: "Pixel", active: true}}}
	api, _ := useWebAPI(t, f, "ad6d078a")
	w := post(handlePlayerPlay, "/player/play", ``)
	if w.Code != http.StatusOK || f.restartCount() != 0 || len(api.sent()) != 1 {
		t.Fatalf("%d, restarts %d, commands %v", w.Code, f.restarts, api.sent())
	}
}

func TestPauseWithoutTheDeviceChecksInTheBackground(t *testing.T) {
	f := &fakeConnect{listed: true}
	api, _ := useWebAPI(t, f, "")
	w := post(handlePlayerPause, "/player/pause", ``)
	_ = w
	deadline := time.Now().Add(5 * time.Second)
	for deviceIDString() == "" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if deviceIDString() != "ad6d078a" {
		t.Fatalf("device not looked for; commands %v", api.sent())
	}
}

func TestIsDeviceGone(t *testing.T) {
	if !isDeviceGone(fmt.Errorf("wrapped: %w", spotify.Error{Status: 404, Message: "Device not found"})) {
		t.Error("404 not taken for a missing device")
	}
	if isDeviceGone(spotify.Error{Status: 502}) || isDeviceGone(errors.New("404")) || isDeviceGone(nil) {
		t.Error("taken for a missing device")
	}
}

// --- commands answered, not acted on -----------------------------------------------------

type watchTest struct {
	w      *commandWatch
	clk    *fakeClock
	mu     sync.Mutex
	logs   []string
	checks []string
	active bool
	done   chan struct{}
}

func newWatchTest() *watchTest {
	wt := &watchTest{clk: newFakeClock(), done: make(chan struct{}, 10)}
	wt.w = &commandWatch{
		after: 8 * time.Second, quiet: 30 * time.Second,
		sleep:   func(d time.Duration) { wt.clk.advance(d) },
		now:     wt.clk.now,
		since:   func(time.Time) bool { wt.mu.Lock(); defer wt.mu.Unlock(); return wt.active },
		running: func() bool { return true },
		logf: func(f string, a ...interface{}) {
			wt.mu.Lock()
			wt.logs = append(wt.logs, fmt.Sprintf(f, a...))
			wt.mu.Unlock()
		},
		check: func(why string) {
			wt.mu.Lock()
			wt.checks = append(wt.checks, why)
			wt.mu.Unlock()
		},
	}
	return wt
}

func (wt *watchTest) answer(what string) {
	wt.w.verify(what, wt.clk.now())
}

func TestCommandNotActedOnIsLoggedAndChecked(t *testing.T) {
	wt := newWatchTest()
	wt.answer("/player/play")
	if len(wt.logs) != 1 || !strings.Contains(wt.logs[0], "/player/play was answered by the Web API, but librespot logged nothing") || len(wt.checks) != 1 {
		t.Fatalf("logs %q, checks %q", wt.logs, wt.checks)
	}
	// within 30 s: counted, not logged
	wt.answer("/player/pause")
	if len(wt.logs) != 1 {
		t.Fatalf("logged again within the quiet time: %q", wt.logs)
	}
	wt.clk.advance(31 * time.Second)
	wt.answer("/player/load")
	if len(wt.logs) != 2 || !strings.Contains(wt.logs[1], "1 more like it") {
		t.Fatalf("logs %q", wt.logs)
	}
}

func TestCommandActedOnIsNotLogged(t *testing.T) {
	wt := newWatchTest()
	wt.active = true
	wt.answer("/player/play")
	if len(wt.logs) != 0 || len(wt.checks) != 0 {
		t.Fatalf("logs %q, checks %q", wt.logs, wt.checks)
	}
}

func TestActivityIsLibrespotsOutputAndEvents(t *testing.T) {
	at := time.Now()
	librespotActivity.Store(0)
	if librespotActiveSince(at) {
		t.Fatal("active before anything")
	}
	o := newLibrespotOutput(nil, false, nil)
	o.logf = func(string, ...interface{}) {}
	o.line("[2026-10-31T13:42:49Z DEBUG librespot_core::dealer] ping")
	if librespotActiveSince(at) {
		t.Fatal("a DEBUG line counted: in verbose mode everything would")
	}
	o.line("[2026-10-31T13:42:49Z INFO  librespot_playback::player] Loading <x>")
	if !librespotActiveSince(at) {
		t.Fatal("an INFO line did not count")
	}
	at = time.Now().Add(time.Millisecond)
	time.Sleep(2 * time.Millisecond)
	noteLibrespotEvent(map[string]string{"PLAYER_EVENT": "paused"})
	if !librespotActiveSince(at) {
		t.Fatal("an event did not count")
	}
}

func TestPlayerCommandsAreWatchedForLibrespotActing(t *testing.T) {
	for _, c := range []struct {
		h       http.HandlerFunc
		path    string
		watched bool
	}{
		{handlePlayerLoad, "/player/load", true}, {handlePlayerPlay, "/player/play", true},
		{handlePlayerNext, "/player/next", true}, {handlePlayerPrev, "/player/previous", true},
		{handlePlayerSeek, "/player/seek", true}, {handlePlayerPause, "/player/pause", true},
		{handlePlayerVolume, "/player/volume", false},
	} {
		f := &fakeConnect{listed: true}
		useWebAPI(t, f, "ad6d078a")
		seen := make(chan struct{}, 1)
		librespotCommands = &commandWatch{sleep: func(time.Duration) {}, now: time.Now,
			since: func(time.Time) bool { seen <- struct{}{}; return true }, running: func() bool { return true }}
		if w := post(c.h, c.path, `{"uri":"spotify:track:x"}`); w.Code != http.StatusOK {
			t.Fatalf("%s: %d", c.path, w.Code)
		}
		select {
		case <-seen:
			if !c.watched {
				t.Errorf("%s watched", c.path)
			}
		case <-time.After(300 * time.Millisecond):
			if c.watched {
				t.Errorf("%s not watched", c.path)
			}
		}
	}
}

func TestHeldPauseIsNotWatched(t *testing.T) {
	f := &fakeConnect{listed: true}
	useWebAPI(t, f, "ad6d078a")
	useHold(t, 100)
	seen := make(chan struct{}, 1)
	librespotCommands = &commandWatch{sleep: func(time.Duration) {}, now: time.Now,
		since: func(time.Time) bool { seen <- struct{}{}; return true }, running: func() bool { return true }}
	post(handlePlayerPause, "/player/pause", ``)
	select {
	case <-seen:
		t.Fatal("a held pause watched: librespot, held, says nothing")
	case <-time.After(300 * time.Millisecond):
	}
}
