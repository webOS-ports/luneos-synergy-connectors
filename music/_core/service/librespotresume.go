package main

// Playing on after librespot lost its session.
//
// librespot that comes back from a lost session, by its own reconnect or as a new
// process, knows no track, and neither does Spotify: "active device is <>". A play
// without a track then reaches it as Resume, which it answers with load_track on
// nothing (connect/src/spirc.rs: "No active track, stopping", "failed filling up
// next_track during stopping", at 99b6088b), and Spotify answers 204; a seek
// finds a track of 0 ms. A play with uris is another command, which makes it load
// the track whatever state it is in. So the daemon remembers what librespot has,
// from /player/load and librespot's own events, and the first play after a loss
// names the track and the position.
//
// Only a track: the Music app plays single tracks, and librespot's events
// name no context. A context another Connect controller started resumes as its
// one track.
//
// A play Spotify took and librespot did not is not a play: the answer to one that
// resumes waits for librespot's event, and says so when it does not come. And
// /player/status does not say playing while librespot has nothing, whatever the
// Web API says, and when it cannot be asked says what librespot's events say.
// The Music app ran its counter over a silent librespot without that.
//
// It is written to spotifyDataDir at each stop, so that it outlives the daemon
// too; while the Music app has a track loaded, a restart of the service is no
// different from a loss.

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/zmb3/spotify/v2"
)

// librespotSessionGone are the lines of a Connect state machine that ended, and
// the state with it (connect/src/spirc.rs, src/main.rs). A dealer connection lost
// and found again keeps it.
var librespotSessionGone = []string{"Spirc shut down unexpectedly", "unexpected shutdown"}

// resumeWait is how long a resumed play waits for librespot to take it.
const resumeWait = 6 * time.Second

var errPlayNotStarted = errors.New("librespot did not start the track")

type resumePoint struct {
	path string
	now  func() time.Time
	wait time.Duration

	mu    sync.Mutex
	uri   string
	pos   int64         // ms, at since when it runs
	since time.Time     // when it started running; zero when it stands
	lost  bool          // librespot has lost it
	found chan struct{} // closed when lost ends
}

func newResumePoint(path string) *resumePoint {
	r := &resumePoint{path: path, now: time.Now, wait: resumeWait, found: make(chan struct{})}
	if path == "" {
		return r
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return r
	}
	var saved struct {
		URI        string `json:"uri"`
		PositionMs int64  `json:"position_ms"`
	}
	if json.Unmarshal(b, &saved) == nil && saved.URI != "" {
		r.uri, r.pos, r.lost = saved.URI, saved.PositionMs, true
	}
	return r
}

var librespotResume = newResumePoint(spotifyDataDir + "/resume.json")

func (r *resumePoint) current() int64 {
	if r.since.IsZero() {
		return r.pos
	}
	return r.pos + r.now().Sub(r.since).Milliseconds()
}

// save needs r.mu. Not a file anyone waits for: a failure costs a resume.
func (r *resumePoint) save() {
	if r.path == "" {
		return
	}
	b, err := json.Marshal(map[string]interface{}{"uri": r.uri, "position_ms": r.current()})
	if err != nil {
		return
	}
	tmp := r.path + ".new"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, r.path)
	}
}

// loaded: /player/load put uri on librespot, at position ms.
func (r *resumePoint) loaded(uri string, position int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.uri, r.pos, r.since = uri, int64(position), time.Time{}
	r.save()
}

// freeze stops the clock: the output was held, and librespot's "paused" may be
// long in coming, if it comes.
func (r *resumePoint) freeze() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pos, r.since = r.current(), time.Time{}
	r.save()
}

// forgot: librespot has lost what it had.
func (r *resumePoint) forgot() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pos, r.since = r.current(), time.Time{}
	if !r.lost {
		r.lost, r.found = true, make(chan struct{})
	}
	r.save()
}

// foundAgain needs r.mu: librespot has a track again.
func (r *resumePoint) foundAgain() {
	if r.lost {
		r.lost = false
		close(r.found)
	}
}

// waitFound waits for librespot to have a track, at most r.wait.
func (r *resumePoint) waitFound(ctx context.Context) bool {
	r.mu.Lock()
	lost, found := r.lost, r.found
	r.mu.Unlock()
	if !lost {
		return true
	}
	t := time.NewTimer(r.wait)
	defer t.Stop()
	select {
	case <-found:
		return true
	case <-t.C:
	case <-ctx.Done():
	}
	return false
}

// report is what librespot's events say: its track, where, and whether it
// lost them.
func (r *resumePoint) report() (uri string, position int64, lost bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.uri, r.current(), r.lost
}

// seek: a seek while there is nothing to seek in moves where the play resumes.
// False when librespot has its track, and the seek is for it.
func (r *resumePoint) seek(position int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.lost || r.uri == "" {
		return false
	}
	r.pos = int64(position)
	r.save()
	return true
}

// pending is where to resume, when librespot has lost it.
func (r *resumePoint) pending() (string, int64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.uri, r.current(), r.lost && r.uri != ""
}

// event takes one of librespot's events.
func (r *resumePoint) event(ev map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pos, posErr := strconv.ParseInt(ev["POSITION_MS"], 10, 64)
	switch ev["PLAYER_EVENT"] {
	case "track_changed":
		if u := ev["URI"]; u != "" && u != r.uri {
			r.uri, r.pos, r.since = u, 0, time.Time{}
		}
		r.foundAgain()
	case "loading":
		r.foundAgain()
	case "playing":
		if posErr == nil {
			r.pos = pos
		}
		r.since = r.now()
		r.foundAgain()
	case "paused":
		if posErr == nil {
			r.pos, r.since = pos, time.Time{}
		} else {
			r.pos, r.since = r.current(), time.Time{}
		}
		r.save()
	case "seeked", "position_correction":
		if posErr == nil {
			r.pos = pos
			if !r.since.IsZero() {
				r.since = r.now()
			}
		}
	case "stopped":
		r.pos, r.since = r.current(), time.Time{}
		r.save()
	case "end_of_track":
		r.pos, r.since = 0, time.Time{}
	}
}

// playingElsewhere: Spotify says the play is on another device.
func playingElsewhere(ctx context.Context, c *spotify.Client, here spotify.ID) bool {
	st, err := c.PlayerState(ctx)
	return err == nil && st != nil && st.Playing && st.Device.ID != "" && st.Device.ID != here
}

// playOrResume is a play on librespot's device: as it is, or, when librespot lost
// its session, naming the track. asked: somebody asked for this here. A play from
// nobody in particular (the media session's, after a call) leaves a play the
// user has moved to another device there.
func playOrResume(ctx context.Context, c *spotify.Client, opt *spotify.PlayOptions, asked bool) error {
	uri, pos, ok := librespotResume.pending()
	if !ok || opt == nil || opt.DeviceID == nil {
		return c.PlayOpt(ctx, opt)
	}
	if playingElsewhere(ctx, c, *opt.DeviceID) {
		if !asked {
			log.Printf("librespot: session lost, and the play is on another device: left there")
			return nil
		}
		return c.PlayOpt(ctx, opt)
	}
	log.Printf("librespot: its session was lost: resuming %s at %d ms", uri, pos)
	o := *opt
	o.URIs = []spotify.URI{spotify.URI(uri)}
	o.PositionMs = spotify.Numeric(pos)
	if err := c.PlayOpt(ctx, &o); err != nil {
		return err
	}
	if !librespotResume.waitFound(ctx) {
		log.Printf("librespot: Spotify took the play of %s, but librespot did not start it", uri)
		return errPlayNotStarted
	}
	return nil
}
