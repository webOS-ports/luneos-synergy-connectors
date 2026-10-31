package main

// Pausing, playing and skipping librespot, for the media session's keys
// (mediasession.go) and the Music app's /player/pause (player.go).
//
// librespot takes its commands from Spotify Connect only, so play, next and
// previous go through the Web API, as /player/* does. A pause does too, but it
// does not wait for it: without a network, without a Web API session, or while
// Spotify's servers take their time, librespot plays on - over a call. So a pause
// first holds librespot's output still: the gst-launch librespot pipes its sound
// into is stopped (SIGSTOP). Its PulseAudio stream runs dry and is silent, and
// librespot, its pipe full, waits at the track's position, so nothing is lost.
// The hold is let go (SIGCONT) by a play, a next or a previous, from the session
// or the Music app; and, once the Web API has the pause, by a resume from another
// Connect controller, which the Web API shows (watchRemoteResume). When librespot
// itself pauses - it kills the stopped gst-launch and starts another on play -
// the hold has nothing left to hold and ends.
//
// SIGKILL ends a stopped process, so librespot can always replace its pipeline.

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/zmb3/spotify/v2"
)

// The command librespot pipes its sound into (gstDevice), as /proc/<pid>/stat
// names it.
const librespotSinkComm = "gst-launch-1.0"

// heldProc is a stopped process; start (its start time) tells it from a later
// process with the same pid.
type heldProc struct {
	pid   int
	start string
}

// outputHold holds librespot's pipeline still.
type outputHold struct {
	mu           sync.Mutex
	procRoot     string
	signal       func(pid int, sig syscall.Signal) error
	librespotPid func() int
	held         []heldProc
	gen          int // bumped by every hold and release
}

var librespotHold = &outputHold{procRoot: "/proc", signal: syscall.Kill, librespotPid: currentLibrespotPid}

// hold stops librespot's pipeline. It returns the hold's generation, and whether
// anything is held: nothing is when librespot has no pipeline, i.e. is not
// playing.
func (h *outputHold) hold() (int, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.gen++
	parent := h.librespotPid()
	if parent <= 0 {
		return h.gen, len(h.held) > 0
	}
	for _, p := range procChildren(h.procRoot, parent, librespotSinkComm) {
		if h.isHeld(p.pid) {
			continue
		}
		if err := h.signal(p.pid, syscall.SIGSTOP); err != nil {
			log.Printf("librespot: cannot hold its output (pid %d): %v", p.pid, err)
			continue
		}
		h.held = append(h.held, p)
	}
	if len(h.held) > 0 {
		log.Printf("librespot: output held")
	}
	return h.gen, len(h.held) > 0
}

func (h *outputHold) isHeld(pid int) bool {
	for _, p := range h.held {
		if p.pid == pid {
			return true
		}
	}
	return false
}

// release lets the pipeline go again.
func (h *outputHold) release() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.releaseLocked()
}

// releaseIf lets it go only if nothing held or released it since gen.
func (h *outputHold) releaseIf(gen int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if gen != h.gen {
		return false
	}
	h.releaseLocked()
	return true
}

func (h *outputHold) releaseLocked() {
	h.gen++
	for _, p := range h.held {
		if procStart(h.procRoot, p.pid) == p.start {
			_ = h.signal(p.pid, syscall.SIGCONT)
		}
	}
	if len(h.held) > 0 {
		log.Printf("librespot: output let go")
	}
	h.held = nil
}

// holding reports whether a held process is still there.
func (h *outputHold) holding() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	alive := h.held[:0]
	for _, p := range h.held {
		if procStart(h.procRoot, p.pid) == p.start {
			alive = append(alive, p)
		}
	}
	h.held = alive
	return len(h.held) > 0
}

func (h *outputHold) generation() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.gen
}

// procStat is /proc/<pid>/stat: the command, the state, the parent and the start
// time. The command is in parentheses and may hold anything, parentheses too, so
// the fields are counted from the last ')'.
func procStat(root string, pid int) (comm, state string, ppid int, start string, ok bool) {
	b, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", "", 0, "", false
	}
	s := string(b)
	open, end := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if open < 0 || end < open {
		return "", "", 0, "", false
	}
	comm = s[open+1 : end]
	// after ')': state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt
	// cmajflt utime stime cutime cstime priority nice num_threads itrealvalue
	// starttime - field 22 of the whole line, the 20th here
	f := strings.Fields(s[end+1:])
	if len(f) < 20 {
		return "", "", 0, "", false
	}
	ppid, err = strconv.Atoi(f[1])
	if err != nil {
		return "", "", 0, "", false
	}
	return comm, f[0], ppid, f[19], true
}

// procStart is the start time of a live process pid, or "" when there is none
// (gone, or a zombie).
func procStart(root string, pid int) string {
	_, state, _, start, ok := procStat(root, pid)
	if !ok || state == "Z" || state == "X" {
		return ""
	}
	return start
}

// procChildren lists the live children of parent named comm.
func procChildren(root string, parent int, comm string) []heldProc {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var kids []heldProc
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		c, state, ppid, start, ok := procStat(root, pid)
		if !ok || ppid != parent || c != comm || state == "Z" || state == "X" {
			continue
		}
		kids = append(kids, heldProc{pid: pid, start: start})
	}
	return kids
}

// --- the Web API ------------------------------------------------------------------

// spotifyAPI is the part of the Connect Web API the controls use.
type spotifyAPI interface {
	pause(ctx context.Context) error
	play(ctx context.Context) error
	next(ctx context.Context) error
	previous(ctx context.Context) error
	// state: whether Spotify says it plays - here or, after a transfer, on
	// another device; either way librespot has its commands to act on
	state(ctx context.Context) (playing bool, err error)
}

var errNoWebSession = errors.New("no Web API session")

// webAPI is spotifyAPI through the signed-in client and librespot's device.
type webAPI struct{}

func (webAPI) client() (*spotify.Client, error) {
	sess.mu.RLock()
	c := sess.client
	sess.mu.RUnlock()
	if c == nil {
		return nil, errNoWebSession
	}
	return c, nil
}

func (a webAPI) pause(ctx context.Context) error {
	c, err := a.client()
	if err != nil {
		return err
	}
	return c.PauseOpt(ctx, deviceOpt())
}

func (a webAPI) play(ctx context.Context) error {
	c, err := a.client()
	if err != nil {
		return err
	}
	return playOrResume(ctx, c, deviceOpt(), false)
}

func (a webAPI) next(ctx context.Context) error {
	c, err := a.client()
	if err != nil {
		return err
	}
	return c.NextOpt(ctx, deviceOpt())
}

func (a webAPI) previous(ctx context.Context) error {
	c, err := a.client()
	if err != nil {
		return err
	}
	return c.PreviousOpt(ctx, deviceOpt())
}

func (a webAPI) state(ctx context.Context) (bool, error) {
	c, err := a.client()
	if err != nil {
		return false, err
	}
	st, err := c.PlayerState(ctx)
	if err != nil {
		return false, err
	}
	return st.Playing, nil
}

// --- the controls -------------------------------------------------------------------

// librespotControl is spotifyControl over the hold and the Web API.
type librespotControl struct {
	hold    *outputHold
	api     spotifyAPI
	timeout time.Duration // for one Web API call
	poll    time.Duration // between two looks for a resume elsewhere
}

// librespotCtl is the daemon's controls, the session's and /player/pause's.
var librespotCtl = newLibrespotControl()

func newLibrespotControl() *librespotControl {
	return &librespotControl{hold: librespotHold, api: webAPI{}, timeout: 5 * time.Second, poll: 4 * time.Second}
}

func (c *librespotControl) call(what string, f func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	err := f(ctx)
	if err != nil {
		log.Printf("librespot: %s through the Web API: %v", what, err)
	}
	return err
}

func (c *librespotControl) pause() {
	gen, held := c.hold.hold()
	librespotResume.freeze()
	go func() {
		if c.call("pause", c.api.pause) == nil && held {
			c.watchRemoteResume(gen)
		}
	}()
}

func (c *librespotControl) play(done func(ok bool)) {
	released := c.hold.holding()
	c.hold.release()
	go func() {
		err := c.call("play", c.api.play)
		if done != nil {
			// let go, librespot plays on from where it was held
			done(err == nil || released)
		}
	}()
}

func (c *librespotControl) next() {
	c.hold.release()
	go func() { _ = c.call("next", c.api.next) }()
}

func (c *librespotControl) previous() {
	c.hold.release()
	go func() { _ = c.call("previous", c.api.previous) }()
}

func (c *librespotControl) holding() bool { return c.hold.holding() }

// watchRemoteResume lets the hold of generation gen go when Spotify says it
// plays again: another Connect controller resumed librespot, or moved the play
// to another device, and librespot, held still, could act on neither. Right after the pause the Web API can still say playing,
// so a resume counts only after it has said paused once.
func (c *librespotControl) watchRemoteResume(gen int) {
	sawPaused := false
	for {
		time.Sleep(c.poll)
		if c.hold.generation() != gen || !c.hold.holding() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
		playing, err := c.api.state(ctx)
		cancel()
		if err != nil {
			continue
		}
		if !playing {
			sawPaused = true
			continue
		}
		if !sawPaused {
			continue
		}
		if c.hold.releaseIf(gen) {
			log.Printf("librespot: resumed from elsewhere")
		}
		return
	}
}
