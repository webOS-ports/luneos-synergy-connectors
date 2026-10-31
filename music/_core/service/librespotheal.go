package main

// Keeping librespot's Connect device in Spotify's device list.
//
// librespot reconnects on its own after most losses: its dealer every 10 s
// (core/src/dealer/mod.rs), its session a few times in 10 min, after which it
// exits (src/main.rs). Not after all of them, though: spotifyd's users report
// devices that stay away until a restart, and its maintainers name connectivity
// drop-outs as the weak spot (Spotifyd discussion #1280); raspotify's wiki says
// librespot cannot yet recover from transient connection errors. So what
// librespot says of itself counts for little here, and the Web API's device
// list for everything:
//
//   - a /player/* command that finds no device, or that the Web API answers 404
//     (device not found), looks for librespot's device; when it is not listed,
//     librespot is restarted (with backoff), the command waits a bounded time for
//     the device to come back, and is sent once more;
//   - after librespot logs a lost session or dealer, and every few minutes while
//     there is a Web API session, the list is looked at; a device missing is a
//     librespot restarted, the same way, unless it is playing: what it has
//     buffered plays on without a network, and a user's music is not cut for
//     the sake of a list. The next command heals it, if it needs to;
//   - after each start, librespot's device is looked for until it is listed, so
//     that a slow first registration (a boot without network) does not leave the
//     commands without a device until the next restart.
//
// A device listed but not active - the user has moved the play to another Connect
// device, or nothing plays - is fine: nothing is restarted, and nothing here ever
// moves the play back. Without a network nothing is restarted either; there is
// nothing librespot could reach. One empty list is not enough: the device must be
// missing from two looks, h.poll apart.

import (
	"context"
	"errors"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zmb3/spotify/v2"
)

var errDeviceMissing = errors.New("librespot's Connect device is not in Spotify's device list")

// connectDevice is one entry of the Web API's device list.
type connectDevice struct {
	id     string
	name   string
	active bool
}

type librespotHealer struct {
	name      string
	list      func(ctx context.Context) ([]connectDevice, error)
	restart   func()                            // ends the running librespot; its loop starts another
	running   func() (pid int, since time.Time) // the running librespot, 0 when none
	playing   func() bool                       // is it playing, by its last event?
	setDevice func(id string)
	now       func() time.Time
	sleep     func(ctx context.Context, d time.Duration) error

	poll       time.Duration // between two looks while waiting for the device
	wait       time.Duration // how long a command waits for it
	grace      time.Duration // a librespot younger than this is still registering
	backoffMin time.Duration // the shortest time between two restarts, doubling
	backoffMax time.Duration
	stable     time.Duration // listed this long after a restart, the backoff starts again
	lossDelay  time.Duration // after a loss logged, librespot's own reconnect goes first
	period     time.Duration // the look every so often

	mu          sync.Mutex
	lastRestart time.Time
	backoff     time.Duration
	restarts    int
	inflight    *healRun
	lossPending bool
	startGen    int
}

// healRun is one heal, for the callers sharing it.
type healRun struct {
	done chan struct{}
	err  error
}

func newLibrespotHealer() *librespotHealer {
	return &librespotHealer{
		name:       sess.librespotName,
		list:       webAPIDevices,
		restart:    func() { killLibrespot("its Connect device is missing") },
		running:    currentLibrespot,
		playing:    librespotPlaying.Load,
		setDevice:  func(id string) { setDeviceID(spotify.ID(id)) },
		now:        time.Now,
		sleep:      sleepCtx,
		poll:       2 * time.Second,
		wait:       25 * time.Second,
		grace:      45 * time.Second,
		backoffMin: 30 * time.Second,
		backoffMax: 10 * time.Minute,
		stable:     10 * time.Minute,
		lossDelay:  30 * time.Second,
		period:     5 * time.Minute,
	}
}

// librespotHeal is the daemon's; nil until main sets it.
var librespotHeal *librespotHealer

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func webAPIDevices(ctx context.Context) ([]connectDevice, error) {
	c, err := webAPI{}.client()
	if err != nil {
		return nil, err
	}
	devs, err := c.PlayerDevices(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]connectDevice, 0, len(devs))
	for _, d := range devs {
		out = append(out, connectDevice{id: string(d.ID), name: d.Name, active: d.Active})
	}
	return out, nil
}

// look is one look at the device list: whether librespot's device is in it.
func (h *librespotHealer) look(ctx context.Context) (bool, error) {
	devs, err := h.list(ctx)
	if err != nil {
		return false, err
	}
	for _, d := range devs {
		if strings.EqualFold(d.name, h.name) {
			h.setDevice(d.id)
			h.mu.Lock()
			if h.backoff > 0 && h.now().Sub(h.lastRestart) >= h.stable {
				h.backoff = 0
			}
			h.mu.Unlock()
			return true, nil
		}
	}
	return false, nil
}

// heal makes sure librespot's device is listed, restarting librespot when it is
// not, and waits for it at most h.wait. forUser: somebody asked for this, as
// opposed to a look in the background, which leaves a playing librespot alone.
// Callers at the same time share one heal.
func (h *librespotHealer) heal(ctx context.Context, why string, forUser bool) error {
	h.mu.Lock()
	if run := h.inflight; run != nil {
		h.mu.Unlock()
		select {
		case <-run.done:
			return run.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	run := &healRun{done: make(chan struct{})}
	h.inflight = run
	h.mu.Unlock()

	run.err = h.doHeal(ctx, why, forUser)

	h.mu.Lock()
	h.inflight = nil
	h.mu.Unlock()
	close(run.done)
	return run.err
}

func (h *librespotHealer) doHeal(ctx context.Context, why string, forUser bool) error {
	ok, err := h.look(ctx)
	if err != nil {
		return err // no network, no session: a restart cannot help
	}
	if ok {
		return nil
	}
	// once more before anything is done about it
	if err := h.sleep(ctx, h.poll); err != nil {
		return err
	}
	if ok, err = h.look(ctx); err != nil {
		return err
	}
	if ok {
		return nil
	}
	pid, since := h.running()
	switch {
	case !forUser && h.playing():
		log.Printf("librespot: no device %q (%s); it is playing, so it stays until a command needs the device", h.name, why)
		return errDeviceMissing
	case pid == 0:
		log.Printf("librespot: no device %q (%s); librespot is not running, waiting for it", h.name, why)
	case h.now().Sub(since) < h.grace:
		log.Printf("librespot: no device %q yet (%s); librespot (pid %d) started %v ago, waiting for it",
			h.name, why, pid, h.now().Sub(since).Round(time.Second))
	default:
		h.mu.Lock()
		next := h.lastRestart.Add(h.backoff)
		if h.now().Before(next) {
			h.mu.Unlock()
			log.Printf("librespot: no device %q (%s); restarted %v ago, not again before %v",
				h.name, why, h.now().Sub(h.lastRestart).Round(time.Second), next.Sub(h.now()).Round(time.Second))
			break
		}
		h.lastRestart = h.now()
		switch {
		case h.backoff == 0:
			h.backoff = h.backoffMin
		case h.backoff*2 > h.backoffMax:
			h.backoff = h.backoffMax
		default:
			h.backoff *= 2
		}
		h.restarts++
		backoff := h.backoff
		h.mu.Unlock()
		log.Printf("librespot: no device %q in Spotify's device list (%s); restarting librespot (pid %d; next restart no sooner than in %v)",
			h.name, why, pid, backoff)
		h.restart()
	}
	deadline := h.now().Add(h.wait)
	for h.now().Before(deadline) {
		if err := h.sleep(ctx, h.poll); err != nil {
			return err
		}
		if ok, err := h.look(ctx); err == nil && ok {
			log.Printf("librespot: device %q is back", h.name)
			return nil
		}
	}
	log.Printf("librespot: device %q still missing after %v", h.name, h.wait)
	return errDeviceMissing
}

// check is the look in the background: heal, with nobody waiting on it.
func (h *librespotHealer) check(why string) {
	ctx, cancel := context.WithTimeout(context.Background(), h.wait+30*time.Second)
	defer cancel()
	if err := h.heal(ctx, why, false); err != nil && !errors.Is(err, errDeviceMissing) && !errors.Is(err, errNoWebSession) {
		log.Printf("librespot: device check (%s): %v", why, err)
	}
}

// onLoss: librespot logged a lost session or dealer. It gets h.lossDelay to
// reconnect by itself; then the device list is looked at, once for any number
// of losses in that time.
func (h *librespotHealer) onLoss(line string) {
	h.mu.Lock()
	if h.lossPending {
		h.mu.Unlock()
		return
	}
	h.lossPending = true
	h.mu.Unlock()
	go func() {
		_ = h.sleep(context.Background(), h.lossDelay)
		h.mu.Lock()
		h.lossPending = false
		h.mu.Unlock()
		h.check("librespot logged: " + line)
	}()
}

// started: a librespot has started; its device is looked for until it is
// listed, at 3, 6, 12, 24, 48 s and then every 60 s for 5 min, and only
// looked for: a librespot that takes long is not restarted from here.
func (h *librespotHealer) started() {
	h.mu.Lock()
	h.startGen++
	gen := h.startGen
	h.mu.Unlock()
	go func() {
		d, total := 3*time.Second, time.Duration(0)
		for total < 5*time.Minute {
			_ = h.sleep(context.Background(), d)
			total += d
			h.mu.Lock()
			stale := gen != h.startGen
			h.mu.Unlock()
			if stale {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			ok, err := h.look(ctx)
			cancel()
			if err == nil && ok {
				log.Printf("playback device %q -> %s", h.name, deviceIDString())
				return
			}
			if d < time.Minute {
				d *= 2
				if d > time.Minute {
					d = time.Minute
				}
			}
		}
		log.Printf("librespot: device %q not listed 5 min after librespot started", h.name)
	}()
}

// watch looks at the device list every h.period while there is a Web API
// session. It sets no wake-up of its own: a suspended phone runs nothing, this
// included. Awake, it is one small request, where librespot's dealer pings
// Spotify every 30 s (core/src/dealer/mod.rs) anyway.
func (h *librespotHealer) watch(stop <-chan struct{}) {
	t := time.NewTicker(h.period)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if pid, _ := h.running(); pid == 0 {
				continue
			}
			if _, err := (webAPI{}).client(); err != nil {
				continue
			}
			h.check("periodic check")
		}
	}
}

// isDeviceGone: the Web API's answer to a command for a device it does not know.
func isDeviceGone(err error) bool {
	var se spotify.Error
	return errors.As(err, &se) && se.Status == 404
}

// --- /player/* commands ---------------------------------------------------------------

// commandOnDevice sends one /player/* command to librespot's device. With no
// device known, or a device the Web API does not know, the device is healed
// and the command sent once more.
func commandOnDevice(ctx context.Context, what string, send func(ctx context.Context, opt *spotify.PlayOptions) error) error {
	h := librespotHeal
	opt := deviceOpt()
	if opt == nil {
		if h == nil {
			return errDeviceMissing
		}
		if err := h.heal(ctx, what+": no device known", true); err != nil {
			return err
		}
		if opt = deviceOpt(); opt == nil {
			return errDeviceMissing
		}
	}
	err := send(ctx, opt)
	if err == nil || h == nil || !isDeviceGone(err) {
		return err
	}
	log.Printf("librespot: %s: the Web API does not know device %q (%v)", what, h.name, err)
	if herr := h.heal(ctx, what+": "+err.Error(), true); herr != nil {
		return herr
	}
	log.Printf("librespot: %s: sending it again", what)
	return send(ctx, deviceOpt())
}

// --- commands answered but not acted on -------------------------------------------------

// commandWatch notes /player/* commands the Web API answered, and logs those
// after which librespot showed nothing at all: no line at INFO or above, no
// event. That is what a librespot looks like that the command never reached
// (its dealer connection gone while Spotify still lists it). It is only a sign
// - a play when it already plays changes nothing either - so it is logged, at
// most once every 30 s, and the device list looked at, nothing more.
type commandWatch struct {
	after   time.Duration
	quiet   time.Duration
	sleep   func(time.Duration)
	now     func() time.Time
	since   func(time.Time) bool
	running func() bool
	logf    func(string, ...interface{})
	check   func(why string)

	mu         sync.Mutex
	lastLogged time.Time
	suppressed int
}

var librespotCommands = &commandWatch{
	after: 8 * time.Second, quiet: 30 * time.Second,
	sleep: time.Sleep, now: time.Now, since: librespotActiveSince,
	running: func() bool { pid, _ := currentLibrespot(); return pid != 0 },
	logf:    log.Printf,
	check: func(why string) {
		if h := librespotHeal; h != nil {
			h.check(why)
		}
	},
}

// answered: the Web API answered command what; did librespot act?
func (w *commandWatch) answered(what string) {
	go w.verify(what, w.now())
}

// verify: after w.after, has librespot shown anything since the command at at?
func (w *commandWatch) verify(what string, at time.Time) {
	w.sleep(w.after)
	if w.since(at) || !w.running() {
		return
	}
	w.mu.Lock()
	if w.now().Sub(w.lastLogged) < w.quiet {
		w.suppressed++
		w.mu.Unlock()
		return
	}
	n := w.suppressed
	w.lastLogged, w.suppressed = w.now(), 0
	w.mu.Unlock()
	more := ""
	if n > 0 {
		more = "; " + strconv.Itoa(n) + " more like it not logged"
	}
	w.logf("librespot: %s was answered by the Web API, but librespot logged nothing and sent no event in %v; it may not have got it%s", what, w.after, more)
	w.check(what + " not acted on")
}
