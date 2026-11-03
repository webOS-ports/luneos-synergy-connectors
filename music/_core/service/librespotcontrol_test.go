package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A /proc of the test's own: librespot (pid 100), its gst-launch and an --onevent
// program, the stream player's gst-launch (another parent), and a zombie.
type fakeProc struct {
	t       *testing.T
	root    string
	mu      sync.Mutex
	sigs    []string
	mutes   []string
	muteErr error
	onCont  func(pid int) // what a process does when let go
}

func newFakeProc(t *testing.T) *fakeProc {
	p := &fakeProc{t: t, root: t.TempDir()}
	p.add(100, "librespot", "S", 1, "5000")
	p.add(200, "gst-launch-1.0", "S", 100, "6000")
	p.add(201, "spotify-webos-s", "S", 100, "6001")
	p.add(300, "gst-launch-1.0", "S", 50, "6002")
	p.add(301, "gst-launch-1.0", "Z", 100, "6003")
	_ = os.WriteFile(filepath.Join(p.root, "self"), nil, 0o644) // not a pid
	return p
}

func (p *fakeProc) add(pid int, comm, state string, ppid int, start string) {
	dir := filepath.Join(p.root, fmt.Sprint(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		p.t.Fatal(err)
	}
	// 52 fields as the kernel writes them; the start time is field 22
	line := fmt.Sprintf("%d (%s) %s %d 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 %s 1000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n",
		pid, comm, state, ppid, start)
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(line), 0o644); err != nil {
		p.t.Fatal(err)
	}
}

func (p *fakeProc) remove(pid int) { _ = os.RemoveAll(filepath.Join(p.root, fmt.Sprint(pid))) }

func (p *fakeProc) signal(pid int, sig syscall.Signal) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sigs = append(p.sigs, fmt.Sprintf("%d:%v", pid, sig))
	onCont := p.onCont
	p.mu.Unlock()
	if sig == syscall.SIGCONT && onCont != nil {
		onCont(pid)
	}
	p.mu.Lock()
	return nil
}

func (p *fakeProc) mute(pid int, on bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.muteErr != nil {
		return p.muteErr
	}
	what := "unmute"
	if on {
		what = "mute"
	}
	p.mutes = append(p.mutes, fmt.Sprintf("%d:%s", pid, what))
	return nil
}

func (p *fakeProc) muted() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.mutes...)
}

func (p *fakeProc) signals() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.sigs...)
}

func (p *fakeProc) hold(librespot int) *outputHold {
	return &outputHold{procRoot: p.root, signal: p.signal, mute: p.mute, librespotPid: func() int { return librespot }}
}

var (
	stop = syscall.SIGSTOP.String()
	cont = syscall.SIGCONT.String()
)

func TestHoldStopsOnlyLibrespotsPipeline(t *testing.T) {
	p := newFakeProc(t)
	h := p.hold(100)
	if _, held := h.hold(); !held || !h.holding() {
		t.Fatal("nothing held")
	}
	if got := p.signals(); !reflect.DeepEqual(got, []string{"200:" + stop}) {
		t.Fatalf("signals %v: only librespot's own, live gst-launch", got)
	}
	// held twice, stopped once
	h.hold()
	if len(p.signals()) != 1 {
		t.Fatalf("signals %v", p.signals())
	}
	h.release()
	if got := p.signals(); !reflect.DeepEqual(got, []string{"200:" + stop, "200:" + cont}) {
		t.Fatalf("signals %v", got)
	}
	if h.holding() {
		t.Error("still holding after the release")
	}
	h.release()
	if len(p.signals()) != 2 {
		t.Errorf("a second release signalled: %v", p.signals())
	}
}

func TestHoldEndsWhenLibrespotReplacesItsPipeline(t *testing.T) {
	p := newFakeProc(t)
	h := p.hold(100)
	h.hold()
	// librespot paused after all: it killed the stopped gst-launch, and the pid
	// is someone else's now
	p.remove(200)
	p.add(200, "gst-launch-1.0", "S", 100, "9999")
	h.release()
	for _, s := range p.signals()[1:] {
		t.Errorf("signalled a process that only has the pid: %s", s)
	}
	// gone, or a zombie: the hold has ended
	for _, state := range []string{"", "Z"} {
		p.add(200, "gst-launch-1.0", "S", 100, "6000")
		h = p.hold(100)
		h.hold()
		if state == "" {
			p.remove(200)
		} else {
			p.add(200, "gst-launch-1.0", state, 100, "6000")
		}
		if h.holding() {
			t.Errorf("holding a pipeline that is %q", state)
		}
	}
}

func TestHoldWithoutLibrespot(t *testing.T) {
	p := newFakeProc(t)
	for _, pid := range []int{0, 999} {
		h := p.hold(pid)
		if _, held := h.hold(); held || h.holding() {
			t.Errorf("librespot %d: held something", pid)
		}
	}
	if len(p.signals()) != 0 {
		t.Errorf("signals %v", p.signals())
	}
	// a pid that cannot be stopped is not held
	h := p.hold(100)
	h.signal = func(int, syscall.Signal) error { return errors.New("EPERM") }
	if _, held := h.hold(); held {
		t.Error("held a process that would not stop")
	}
}

func TestReleaseIf(t *testing.T) {
	p := newFakeProc(t)
	h := p.hold(100)
	gen, _ := h.hold()
	h.release()
	gen2, _ := h.hold()
	if h.releaseIf(gen) {
		t.Fatal("an old hold's release let a newer hold go")
	}
	if !h.holding() {
		t.Fatal("the newer hold was let go")
	}
	if !h.releaseIf(gen2) || h.holding() {
		t.Fatal("the hold's own release did not let it go")
	}
}

func TestProcStatOddNames(t *testing.T) {
	p := newFakeProc(t)
	p.add(400, "a) (b", "S", 100, "7000")
	comm, state, ppid, start, ok := procStat(p.root, 400)
	if !ok || comm != "a) (b" || state != "S" || ppid != 100 || start != "7000" {
		t.Errorf("procStat = %q %q %d %q %v", comm, state, ppid, start, ok)
	}
	_ = os.WriteFile(filepath.Join(p.root, "400", "stat"), []byte("400 (x) S"), 0o644)
	if _, _, _, _, ok := procStat(p.root, 400); ok {
		t.Error("a short stat was taken")
	}
	_ = os.WriteFile(filepath.Join(p.root, "400", "stat"), []byte("400 x S 1"), 0o644)
	if _, _, _, _, ok := procStat(p.root, 400); ok {
		t.Error("a stat without a command was taken")
	}
}

// fakeAPI answers the Web API calls; state answers from a list.
type fakeAPI struct {
	mu     sync.Mutex
	calls  []string
	err    error
	states []bool
}

func (a *fakeAPI) record(what string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, what)
	return a.err
}

func (a *fakeAPI) pause(context.Context) error    { return a.record("pause") }
func (a *fakeAPI) play(context.Context) error     { return a.record("play") }
func (a *fakeAPI) next(context.Context) error     { return a.record("next") }
func (a *fakeAPI) previous(context.Context) error { return a.record("previous") }
func (a *fakeAPI) state(context.Context) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "state")
	if len(a.states) == 0 {
		return false, errors.New("no network")
	}
	s := a.states[0]
	a.states = a.states[1:]
	return s, nil
}

func (a *fakeAPI) called() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.calls...)
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end); time.Sleep(time.Millisecond) {
		if f() {
			return
		}
	}
	t.Fatalf("never: %s", what)
}

func TestControlPauseHoldsAndResumesFromElsewhere(t *testing.T) {
	p := newFakeProc(t)
	// the Web API still says playing right after the pause, then paused, then
	// playing again: resumed from another controller
	// (this librespot does not take the pause when let go: it is held again)
	api := &fakeAPI{states: []bool{true, false, false, true}}
	c := &librespotControl{hold: p.hold(100), api: api, timeout: time.Second, poll: time.Millisecond, settle: 20 * time.Millisecond}
	c.pause()
	if !c.holding() {
		t.Fatal("pause did not hold the output at once")
	}
	waitFor(t, "the hold let go for the resume", func() bool { return len(api.called()) == 5 && !c.holding() })
	got := api.called()
	if !reflect.DeepEqual(got, []string{"pause", "state", "state", "state", "state"}) {
		t.Errorf("Web API calls %v", got)
	}
	if s := p.signals(); !reflect.DeepEqual(s, []string{"200:" + stop, "200:" + cont, "200:" + stop, "200:" + cont}) {
		t.Errorf("signals %v", s)
	}
	if m := p.muted(); !reflect.DeepEqual(m, []string{"200:mute", "200:unmute"}) {
		t.Errorf("mutes %v", m)
	}
}

func TestControlPauseWithoutTheWebAPI(t *testing.T) {
	p := newFakeProc(t)
	api := &fakeAPI{err: errNoWebSession}
	c := &librespotControl{hold: p.hold(100), api: api, timeout: time.Second, poll: time.Millisecond}
	c.pause()
	waitFor(t, "the Web API pause", func() bool { return len(api.called()) == 1 })
	time.Sleep(20 * time.Millisecond)
	if !c.holding() {
		t.Fatal("without the Web API the hold is all that pauses librespot, and it was let go")
	}
	if got := api.called(); !reflect.DeepEqual(got, []string{"pause"}) {
		t.Errorf("Web API calls %v: no resume is watched for when the pause failed", got)
	}
	// play lets it go, and reports librespot plays even though the Web API failed
	ok := make(chan bool, 1)
	c.play(func(b bool) { ok <- b })
	if c.holding() {
		t.Fatal("play did not let the hold go")
	}
	if !<-ok {
		t.Error("a play that let the hold go reported failure")
	}
	// with nothing held and no Web API, a play fails
	c.play(func(b bool) { ok <- b })
	if <-ok {
		t.Error("a play that reached nothing reported success")
	}
}

func TestControlSkipsLetGo(t *testing.T) {
	p := newFakeProc(t)
	api := &fakeAPI{}
	c := &librespotControl{hold: p.hold(100), api: api, timeout: time.Second, poll: time.Hour}
	for _, skip := range []func(){c.next, c.previous} {
		c.hold.hold()
		skip()
		if c.holding() {
			t.Fatal("a skip left the output held")
		}
	}
	waitFor(t, "both skips", func() bool { return len(api.called()) == 2 })
	got := api.called()
	if !(reflect.DeepEqual(got, []string{"next", "previous"}) || reflect.DeepEqual(got, []string{"previous", "next"})) {
		t.Errorf("Web API calls %v", got)
	}
}

func TestControlWatchStopsWhenReleased(t *testing.T) {
	p := newFakeProc(t)
	api := &fakeAPI{states: []bool{false, false, false}}
	c := &librespotControl{hold: p.hold(100), api: api, timeout: time.Second, poll: 5 * time.Millisecond}
	gen, _ := c.hold.hold()
	done := make(chan struct{})
	go func() { c.watchRemoteResume(gen); close(done) }()
	c.hold.release()
	c.hold.hold() // a newer hold is not the watch's
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the watch outlived its hold")
	}
	if !c.holding() {
		t.Fatal("the watch let a newer hold go")
	}
}

// librespot takes the pause once let go: it kills its gst-launch.
func TestControlPauseSettlesOnceSpotifyHasIt(t *testing.T) {
	p := newFakeProc(t)
	p.onCont = func(pid int) { p.remove(pid) }
	api := &fakeAPI{states: []bool{true, false, false, false}}
	c := &librespotControl{hold: p.hold(100), api: api, timeout: time.Second, poll: time.Millisecond, settle: time.Second}
	c.pause()
	waitFor(t, "the pause settled", func() bool { return !c.holding() })
	time.Sleep(20 * time.Millisecond)
	if got := api.called(); !reflect.DeepEqual(got, []string{"pause", "state", "state"}) {
		t.Errorf("Web API calls %v: the watch goes on after the pause settled", got)
	}
	if s := p.signals(); !reflect.DeepEqual(s, []string{"200:" + stop, "200:" + cont}) {
		t.Errorf("signals %v", s)
	}
	// muted before it was let go, and gone with its stream: nothing to unmute
	if m := p.muted(); !reflect.DeepEqual(m, []string{"200:mute"}) {
		t.Errorf("mutes %v", m)
	}
}

// Without a mute the hold is the only silence there is, so it stays.
func TestControlPauseStaysHeldWithoutAMute(t *testing.T) {
	p := newFakeProc(t)
	p.muteErr = errors.New("no pactl")
	api := &fakeAPI{states: []bool{false, false, false}}
	c := &librespotControl{hold: p.hold(100), api: api, timeout: time.Second, poll: time.Millisecond, settle: time.Second}
	c.pause()
	waitFor(t, "the watch saw paused", func() bool { return len(api.called()) >= 3 })
	if !c.holding() {
		t.Fatal("a hold that could not be muted was let go")
	}
	if s := p.signals(); !reflect.DeepEqual(s, []string{"200:" + stop}) {
		t.Errorf("signals %v", s)
	}
}

// A play between the mute and the release is to be heard: unmuted, not settled.
func TestSettlePauseLosesToAPlay(t *testing.T) {
	p := newFakeProc(t)
	h := p.hold(100)
	c := &librespotControl{hold: h, api: &fakeAPI{}, timeout: time.Second, settle: time.Second}
	gen, _ := h.hold()
	h.mute = func(pid int, on bool) error {
		if on {
			h.release() // the play, right after the mute
		}
		return p.mute(pid, on)
	}
	if _, settled := c.settlePause(gen); settled {
		t.Fatal("settled a pause that a play had overtaken")
	}
	if m := p.muted(); !reflect.DeepEqual(m, []string{"200:mute", "200:unmute"}) {
		t.Errorf("mutes %v: the played stream stays muted", m)
	}
}

func TestSinkInputsOf(t *testing.T) {
	// pactl lists a stream's client properties after its own, so the pid comes twice
	list := `Sink Input #0
	Driver: module-remap-sink.c
	Properties:
		media.role = "filter"
Sink Input #135
	Driver: protocol-native.c
	Properties:
		media.role = "music"
		application.process.id = "11867"
		application.process.binary = "gst-launch-1.0"
		module-stream-restore.id = "sink-input-by-media-role:music"
		application.process.id = "11867"
Sink Input #140
	Properties:
		application.process.id = "118670"
Sink Input #141
	Properties:
		application.process.id = "11867"
`
	if got := sinkInputsOf(list, 11867); !reflect.DeepEqual(got, []string{"135", "141"}) {
		t.Errorf("streams %v", got)
	}
	if got := sinkInputsOf(list, 1); got != nil {
		t.Errorf("streams of a process with none: %v", got)
	}
}
