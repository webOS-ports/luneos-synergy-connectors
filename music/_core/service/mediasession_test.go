package main

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// No test here reaches the bus or librespot: the session is given a fake bus that
// records what is sent and hands out subscriptions the test answers, a fake
// librespot control, and a clock the test moves.

type sentCall struct {
	method  string
	payload map[string]interface{}
}

type fakeSub struct {
	uri       string
	payload   map[string]interface{}
	ch        chan map[string]interface{}
	cancelled bool
}

func (f *fakeSub) replies() <-chan map[string]interface{} { return f.ch }
func (f *fakeSub) cancel() {
	if !f.cancelled {
		f.cancelled = true
		close(f.ch)
	}
}

type fakeBus struct {
	sent      []sentCall
	subs      []*fakeSub
	refuseSub error
}

func (b *fakeBus) send(uri string, payload map[string]interface{}) {
	b.sent = append(b.sent, sentCall{lunaMethod(uri), payload})
}

func (b *fakeBus) subscribe(uri string, payload map[string]interface{}) (lunaSub, error) {
	if b.refuseSub != nil && strings.HasPrefix(uri, mcServiceURI) {
		return nil, b.refuseSub
	}
	s := &fakeSub{uri: uri, payload: payload, ch: make(chan map[string]interface{}, 4)}
	b.subs = append(b.subs, s)
	return s, nil
}

// registrations are the registerMediaSession calls, the server-status watch left out.
func (b *fakeBus) registrations() []*fakeSub {
	var out []*fakeSub
	for _, s := range b.subs {
		if strings.HasSuffix(s.uri, "/registerMediaSession") {
			out = append(out, s)
		}
	}
	return out
}

func (b *fakeBus) watches() []*fakeSub {
	var out []*fakeSub
	for _, s := range b.subs {
		if s.uri == busServerStatusURI {
			out = append(out, s)
		}
	}
	return out
}

func (b *fakeBus) methods() []string {
	var out []string
	for _, c := range b.sent {
		out = append(out, c.method)
	}
	return out
}

func (b *fakeBus) lastStatus() string {
	for i := len(b.sent) - 1; i >= 0; i-- {
		if b.sent[i].method == "setMediaPlayStatus" {
			return b.sent[i].payload["playStatus"].(string)
		}
	}
	return ""
}

type fakeControl struct {
	calls    []string
	held     bool
	playDone func(ok bool)
}

func (c *fakeControl) pause()                  { c.calls = append(c.calls, "pause") }
func (c *fakeControl) play(done func(ok bool)) { c.calls = append(c.calls, "play"); c.playDone = done }
func (c *fakeControl) next()                   { c.calls = append(c.calls, "next") }
func (c *fakeControl) previous()               { c.calls = append(c.calls, "previous") }
func (c *fakeControl) holding() bool           { return c.held }

type sessionTest struct {
	t   *testing.T
	s   *spotifySession
	bus *fakeBus
	ctl *fakeControl
	now time.Time
	ids int
}

func newSessionTest(t *testing.T) *sessionTest {
	st := &sessionTest{t: t, bus: &fakeBus{}, ctl: &fakeControl{}, now: time.Unix(1700000000, 0)}
	st.s = newSpotifySession(st.bus, st.ctl, func() time.Time { return st.now })
	st.s.newMediaID = func() string { st.ids++; return "spotify-" + string(rune('0'+st.ids)) }
	return st
}

// pump runs what the session's goroutines posted: n events at least, then what
// else comes within a moment (an ended call's stale close, say).
func (st *sessionTest) pump(n int) {
	st.t.Helper()
	for i := 0; i < n; i++ {
		select {
		case f := <-st.s.events:
			f()
		case <-time.After(2 * time.Second):
			st.t.Fatalf("event %d of %d never came", i+1, n)
		}
	}
	for {
		select {
		case f := <-st.s.events:
			f()
		case <-time.After(20 * time.Millisecond):
			return
		}
	}
}

// reply answers the session's last registration with r.
func (st *sessionTest) reply(r map[string]interface{}) {
	st.t.Helper()
	regs := st.bus.registrations()
	if len(regs) == 0 {
		st.t.Fatal("nothing registered")
	}
	regs[len(regs)-1].ch <- r
	st.pump(1)
}

func (st *sessionTest) event(kv ...string) {
	ev := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		ev[kv[i]] = kv[i+1]
	}
	st.s.onLibrespotEvent(ev)
}

func (st *sessionTest) trackChanged(uri string) {
	st.event("PLAYER_EVENT", "track_changed", "URI", uri, "NAME", "Song", "ARTISTS", "A\nB",
		"ALBUM", "Album", "DURATION_MS", "201499", "NUMBER", "3", "ITEM_TYPE", "Track")
}

// playing makes librespot play uri and the session register.
func (st *sessionTest) playing(uri string) {
	st.t.Helper()
	st.trackChanged(uri)
	st.event("PLAYER_EVENT", "playing", "TRACK_ID", "x", "POSITION_MS", "0")
}

func (st *sessionTest) registered() {
	st.t.Helper()
	st.reply(map[string]interface{}{"returnValue": true, "subscribed": true})
}

func (st *sessionTest) key(k string) {
	st.t.Helper()
	st.reply(map[string]interface{}{"returnValue": true, "subscribed": true, "keyEvent": k,
		"mediaId": st.s.mediaID})
}

func (st *sessionTest) advance(d time.Duration) {
	st.now = st.now.Add(d)
	st.s.sync()
}

func TestSessionRegistersWhenLibrespotPlays(t *testing.T) {
	st := newSessionTest(t)
	st.s.sync()
	if len(st.bus.registrations()) != 0 {
		t.Fatal("registered before librespot had anything")
	}
	if len(st.bus.watches()) != 1 || st.bus.watches()[0].payload["serviceName"] != mcName {
		t.Fatalf("mediacontroller is not watched: %+v", st.bus.subs)
	}
	st.playing("spotify:track:1")
	regs := st.bus.registrations()
	if len(regs) != 1 {
		t.Fatalf("%d registrations, want 1", len(regs))
	}
	want := map[string]interface{}{"mediaId": "spotify-1", "appId": serviceCallerID, "subscribe": true}
	if !reflect.DeepEqual(regs[0].payload, want) {
		t.Errorf("registered with %v, want %v", regs[0].payload, want)
	}
	if len(st.bus.sent) != 0 {
		t.Errorf("told the service %v before it registered the session", st.bus.methods())
	}
	st.registered()
	if got := st.bus.methods(); !reflect.DeepEqual(got, []string{"activateMediaSession", "setMediaPlayStatus", "setMediaMetaData"}) {
		t.Fatalf("sent %v", got)
	}
	if st.bus.lastStatus() != playStatePlaying {
		t.Errorf("status %q", st.bus.lastStatus())
	}
	meta := st.bus.sent[2].payload["mediaMetaData"].(map[string]interface{})
	wantMeta := map[string]interface{}{"title": "Song", "artist": "A, B", "album": "Album",
		"totalDuration": "201", "trackNumber": 3}
	if !reflect.DeepEqual(meta, wantMeta) {
		t.Errorf("metadata %v, want %v", meta, wantMeta)
	}
	for _, c := range st.bus.sent {
		if c.payload["mediaId"] != "spotify-1" {
			t.Errorf("%s for %v", c.method, c.payload["mediaId"])
		}
	}
	// told once: a sync with nothing new sends nothing
	st.advance(time.Second)
	if len(st.bus.sent) != 3 {
		t.Errorf("sent again: %v", st.bus.methods())
	}
}

func TestSessionKeys(t *testing.T) {
	st := newSessionTest(t)
	st.playing("spotify:track:1")
	st.registered()
	st.bus.sent = nil

	st.key("pause")
	if !reflect.DeepEqual(st.ctl.calls, []string{"pause"}) {
		t.Fatalf("pause key did %v", st.ctl.calls)
	}
	if got := st.bus.methods(); !reflect.DeepEqual(got, []string{"setMediaPlayStatus"}) || st.bus.lastStatus() != playStatePaused {
		t.Fatalf("after pause sent %v (%s); a paused session stays active, for the play after a call", got, st.bus.lastStatus())
	}
	// a pause when paused is a pause, not a toggle
	st.key("pause")
	if st.ctl.calls[len(st.ctl.calls)-1] != "pause" {
		t.Errorf("second pause did %v", st.ctl.calls)
	}
	st.bus.sent = nil
	st.key("play")
	if st.ctl.calls[len(st.ctl.calls)-1] != "play" {
		t.Fatalf("play key did %v", st.ctl.calls)
	}
	if got := st.bus.methods(); !reflect.DeepEqual(got, []string{"activateMediaSession", "setMediaPlayStatus"}) || st.bus.lastStatus() != playStatePlaying {
		t.Fatalf("after play sent %v", got)
	}
	st.key("next")
	st.key("previous")
	st.key("stop")
	want := []string{"pause", "pause", "play", "next", "previous", "pause"}
	if !reflect.DeepEqual(st.ctl.calls, want) {
		t.Errorf("did %v, want %v", st.ctl.calls, want)
	}
	// playPause: what it is not doing
	st.key("playPause")
	st.key("playPause")
	want = append(want, "play", "pause")
	if !reflect.DeepEqual(st.ctl.calls, want) {
		t.Errorf("playPause did %v, want %v", st.ctl.calls, want)
	}
	// a key for another session, and one the session does not know
	n := len(st.ctl.calls)
	st.reply(map[string]interface{}{"returnValue": true, "keyEvent": "play", "mediaId": "someone-else"})
	st.key("fastForward")
	if len(st.ctl.calls) != n {
		t.Errorf("acted on another's or an unknown key: %v", st.ctl.calls[n:])
	}
}

func TestSessionStandsAsideForTheMusicApp(t *testing.T) {
	st := newSessionTest(t)
	// the app loads a track and polls; librespot plays it
	st.s.onAppRequest("spotify:track:1")
	st.playing("spotify:track:1")
	if len(st.bus.registrations()) != 0 {
		t.Fatal("registered a second session for the Music app's track")
	}
	for i := 0; i < 4; i++ {
		st.now = st.now.Add(time.Second)
		st.s.onAppRequest("")
	}
	if len(st.bus.registrations()) != 0 {
		t.Fatal("registered while the app polls")
	}
	// the app goes quiet: the session takes over
	st.advance(appHeartbeat - time.Second)
	if len(st.bus.registrations()) != 0 {
		t.Fatal("took over before the heartbeat ran out")
	}
	st.advance(time.Second)
	if len(st.bus.registrations()) != 1 {
		t.Fatal("did not take over when the app went quiet")
	}
	st.registered()
	if st.bus.lastStatus() != playStatePlaying {
		t.Fatalf("status %q", st.bus.lastStatus())
	}
	// the app comes back with the same track: the session stands aside again
	st.bus.sent = nil
	st.s.onAppRequest("")
	if got := st.bus.methods(); !reflect.DeepEqual(got, []string{"deactivateMediaSession", "setMediaPlayStatus"}) || st.bus.lastStatus() != playStateStopped {
		t.Fatalf("app back: sent %v (%s)", got, st.bus.lastStatus())
	}
	// and does nothing for keys that still reach it
	st.key("pause")
	if len(st.ctl.calls) != 0 {
		t.Errorf("acted on %v while the app has librespot", st.ctl.calls)
	}
	// librespot moves on to what the app did not load: it is the session's
	st.playing("spotify:track:2")
	if st.bus.lastStatus() != playStatePlaying {
		t.Errorf("another controller's track: status %q", st.bus.lastStatus())
	}
}

func TestSessionStoppedAndGone(t *testing.T) {
	st := newSessionTest(t)
	st.playing("spotify:track:1")
	st.registered()
	st.bus.sent = nil
	st.event("PLAYER_EVENT", "stopped", "TRACK_ID", "x")
	if got := st.bus.methods(); !reflect.DeepEqual(got, []string{"deactivateMediaSession", "setMediaPlayStatus"}) || st.bus.lastStatus() != playStateStopped {
		t.Fatalf("stopped: sent %v (%s)", got, st.bus.lastStatus())
	}
	// stopped, it takes no keys
	st.key("play")
	if len(st.ctl.calls) != 0 {
		t.Errorf("a stopped session did %v", st.ctl.calls)
	}
	reg := st.bus.registrations()[0]
	st.s.onLibrespotExit()
	if !reg.cancelled {
		t.Fatal("the session outlived librespot")
	}
	// a new librespot that plays registers a new session
	st.playing("spotify:track:1")
	if regs := st.bus.registrations(); len(regs) != 2 || regs[1].payload["mediaId"] != "spotify-2" {
		t.Fatalf("not registered again after librespot came back: %d", len(regs))
	}
}

func TestSessionPausedTrackRegisters(t *testing.T) {
	// a paused track is something a headset's play can resume
	st := newSessionTest(t)
	st.trackChanged("spotify:track:1")
	st.event("PLAYER_EVENT", "paused", "TRACK_ID", "x")
	if len(st.bus.registrations()) != 1 {
		t.Fatal("a paused track has no session")
	}
	st.registered()
	if got := st.bus.methods(); !reflect.DeepEqual(got, []string{"setMediaPlayStatus", "setMediaMetaData"}) || st.bus.lastStatus() != playStatePaused {
		t.Fatalf("sent %v (%s): paused is not activated", got, st.bus.lastStatus())
	}
	// events that change nothing send nothing
	n := len(st.bus.sent)
	st.event("PLAYER_EVENT", "seeked", "POSITION_MS", "1000")
	st.event("PLAYER_EVENT", "volume_changed")
	if len(st.bus.sent) != n {
		t.Errorf("sent %v", st.bus.methods()[n:])
	}
}

func TestSessionPlayingWhileHeldIsIgnored(t *testing.T) {
	st := newSessionTest(t)
	st.playing("spotify:track:1")
	st.registered()
	st.key("pause")
	st.ctl.held = true
	st.event("PLAYER_EVENT", "playing", "TRACK_ID", "x")
	if st.bus.lastStatus() != playStatePaused {
		t.Fatalf("a playing event from before the hold made it %s", st.bus.lastStatus())
	}
	st.ctl.held = false
	st.event("PLAYER_EVENT", "playing", "TRACK_ID", "x")
	if st.bus.lastStatus() != playStatePlaying {
		t.Fatalf("after the hold, playing is %s", st.bus.lastStatus())
	}
}

func TestSessionPlayThatFailed(t *testing.T) {
	st := newSessionTest(t)
	st.trackChanged("spotify:track:1")
	st.event("PLAYER_EVENT", "paused")
	st.registered()
	st.key("play")
	if st.bus.lastStatus() != playStatePlaying {
		t.Fatal("play not reported")
	}
	st.ctl.playDone(false)
	st.pump(1)
	if st.bus.lastStatus() != playStatePaused {
		t.Fatalf("a play that never reached librespot is %s", st.bus.lastStatus())
	}
	// a failure older than a playing event is not taken back
	st.key("play")
	done := st.ctl.playDone
	st.event("PLAYER_EVENT", "playing")
	done(false)
	st.pump(1)
	if st.bus.lastStatus() != playStatePlaying {
		t.Fatalf("a stale failure made it %s", st.bus.lastStatus())
	}
	st.ctl.playDone(true) // the newest play worked: nothing changes
	if st.bus.lastStatus() != playStatePlaying {
		t.Fatal("a play that worked changed the status")
	}
}

func TestSessionMediacontrollerRestarts(t *testing.T) {
	st := newSessionTest(t)
	st.playing("spotify:track:1")
	st.registered()
	watch := st.bus.watches()[0]
	reg := st.bus.registrations()[0]

	watch.ch <- map[string]interface{}{"serviceName": mcName, "connected": false}
	st.pump(1)
	if !reg.cancelled {
		t.Fatal("the session's call is kept with mediacontroller gone")
	}
	st.advance(time.Minute)
	if len(st.bus.registrations()) != 1 {
		t.Fatal("registered while mediacontroller is down")
	}
	// another service's status is not mediacontroller's
	watch.ch <- map[string]interface{}{"serviceName": "com.example", "connected": true}
	st.pump(1)
	if len(st.bus.registrations()) != 1 {
		t.Fatal("took another service's status for mediacontroller's")
	}
	st.bus.sent = nil
	watch.ch <- map[string]interface{}{"serviceName": mcName, "connected": true}
	st.pump(1)
	regs := st.bus.registrations()
	if len(regs) != 2 || regs[1].payload["mediaId"] == regs[0].payload["mediaId"] {
		t.Fatalf("not registered again, under a new id: %d", len(regs))
	}
	// the old call's late replies are stale
	reg.ch = make(chan map[string]interface{}, 1)
	st.s.onReply(st.s.subGen-1, map[string]interface{}{"returnValue": true, "keyEvent": "pause"})
	if len(st.ctl.calls) != 0 {
		t.Fatal("acted on a key of the old session")
	}
	st.registered()
	if got := st.bus.methods(); !reflect.DeepEqual(got, []string{"activateMediaSession", "setMediaPlayStatus", "setMediaMetaData"}) {
		t.Fatalf("after coming back sent %v, want everything again", got)
	}
}

func TestSessionRetries(t *testing.T) {
	st := newSessionTest(t)
	st.playing("spotify:track:1")
	// refused
	st.reply(map[string]interface{}{"returnValue": false, "errorText": "Permission denied"})
	if !st.bus.registrations()[0].cancelled {
		t.Fatal("a refused call is left open")
	}
	delays := []time.Duration{sessionRetryMin, 2 * sessionRetryMin, 4 * sessionRetryMin, 8 * sessionRetryMin, sessionRetryMax, sessionRetryMax}
	for i, d := range delays {
		n := len(st.bus.registrations())
		st.advance(d - time.Second)
		if len(st.bus.registrations()) != n {
			t.Fatalf("retry %d came before %v", i+1, d)
		}
		st.advance(time.Second)
		if len(st.bus.registrations()) != n+1 {
			t.Fatalf("retry %d did not come after %v", i+1, d)
		}
		// the call ends without a reply: luna-send exited
		st.bus.registrations()[n].cancel()
		st.pump(1)
	}
	// a registration that works starts the delays again
	st.advance(sessionRetryMax)
	st.registered()
	st.bus.registrations()[len(st.bus.registrations())-1].cancel()
	st.pump(1)
	n := len(st.bus.registrations())
	st.advance(sessionRetryMin)
	if len(st.bus.registrations()) != n+1 {
		t.Fatal("the delay was not reset by a registration")
	}
	// luna-send cannot be run at all
	st.bus.refuseSub = errors.New("no luna-send")
	st.s.failSession()
	st.advance(sessionRetryMax)
	if st.s.sub != nil || st.s.retryAt.IsZero() {
		t.Fatal("a registration that could not be made is not retried")
	}
}

func TestSessionWatchRestarts(t *testing.T) {
	st := newSessionTest(t)
	st.s.sync()
	st.bus.watches()[0].cancel()
	st.pump(1)
	st.advance(sessionRetryMin - time.Second)
	if len(st.bus.watches()) != 1 {
		t.Fatal("the watch came back too soon")
	}
	st.advance(time.Second)
	if len(st.bus.watches()) != 2 {
		t.Fatal("the watch was not started again")
	}
}

func TestTrackMetaData(t *testing.T) {
	cases := []struct {
		ev   map[string]string
		want map[string]interface{}
	}{
		{map[string]string{}, map[string]interface{}{}},
		{map[string]string{"NAME": " T ", "ARTISTS": "A\n\nB\nC", "DURATION_MS": "500", "NUMBER": "0"},
			map[string]interface{}{"title": "T", "artist": "A, B, C", "totalDuration": "1"}},
		{map[string]string{"DURATION_MS": "-3", "NUMBER": "x"}, map[string]interface{}{}},
		{map[string]string{"ITEM_TYPE": "Episode", "NAME": "E", "SHOW_NAME": "Show", "ARTISTS": "no"},
			map[string]interface{}{"title": "E", "artist": "Show"}},
	}
	for _, c := range cases {
		got := trackMetaData(c.ev)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("trackMetaData(%v) = %v, want %v", c.ev, got, c.want)
		}
		// only the keys mediacontroller's schema has
		allowed := map[string]bool{"title": true, "artist": true, "totalDuration": true, "album": true,
			"genre": true, "trackNumber": true, "volume": true}
		for k := range got {
			if !allowed[k] {
				t.Errorf("key %q is not in setMediaMetaData's schema", k)
			}
		}
		if _, err := json.Marshal(got); err != nil {
			t.Error(err)
		}
	}
}
