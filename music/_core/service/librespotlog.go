package main

// librespot's own output, in the journal.
//
// librespot (and the gst-launch its subprocess backend starts, which inherits
// librespot's stdout and stderr; only gst-launch's stdin is the audio, a pipe
// librespot makes itself: playback/src/audio_backend/subprocess.rs) writes its
// log to stderr. Both streams come here through one pipe, and each line is
// logged as "librespot| ...", with any token in it replaced. librespot's own
// lines ("[time LEVEL module] message", env_logger's format) lose the time,
// which the journal has.
//
// Reading them also tells the daemon two things: that librespot lost its
// session or dealer connection (librespotLossLines), and that it did something
// at all after a command (librespotActivity).

import (
	"bufio"
	"io"
	"log"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A line is read up to librespotLineRead and redacted whole, so that no cut goes
// through a token, and logged up to librespotLineMax.
const (
	librespotLineRead = 16 * 1024
	librespotLineMax  = 1000
)

// librespotLossLines are what librespot 0.8 logs when it loses Spotify: its
// access point connection (core/src/session.rs), the dealer's websocket
// (core/src/dealer/mod.rs), or its Connect state machine (connect/src/spirc.rs,
// src/main.rs). It reconnects on its own after most of them; whether it did is
// for the device list to tell (librespotheal.go).
var librespotLossLines = []string{
	"Connection to server closed",
	"Spirc shut down unexpectedly",
	"unexpected shutdown",
	"Websocket connection failed",
	"Websocket peer does not respond",
	"Dealer finished with an error",
	"Error while connecting",
	"starting dealer failed",
	"Tried too many access points",
}

var (
	// env_logger's line: [2026-10-31T13:42:49Z INFO  librespot_core::session] text
	librespotLogLine = regexp.MustCompile(`^\[\S+ +(TRACE|DEBUG|INFO|WARN|ERROR) +([^\]\s]+)\] ?(.*)$`)
	// a token after its name, in any of the shapes it is written in
	tokenAfterName = regexp.MustCompile(`(?i)((?:access[-_ ]?token|refresh[-_ ]?token|authorization|bearer)["']?\s*[:=]?\s*["']?)(?:bearer\s+)?[^\s"',&;)]{16,}`)
	// a bare token: Spotify's start with BQ; anything as long as this is no word
	bareToken = regexp.MustCompile(`\bBQ[A-Za-z0-9_-]{30,}|[A-Za-z0-9+/_=-]{80,}`)
)

const redacted = "<redacted>"

// redactSecrets replaces the secrets given, and anything shaped like a token,
// in s.
func redactSecrets(s string, secrets []string) string {
	for _, sec := range secrets {
		if len(sec) >= 8 {
			s = strings.ReplaceAll(s, sec, redacted)
		}
	}
	s = tokenAfterName.ReplaceAllString(s, "${1}"+redacted)
	return bareToken.ReplaceAllString(s, redacted)
}

// redactArgs is librespot's command line as it can be logged: the value of
// --access-token (-k) replaced, and any other token too.
func redactArgs(args []string) string {
	out := make([]string, len(args))
	for i, a := range args {
		switch {
		case i > 0 && (args[i-1] == "--access-token" || args[i-1] == "-k"):
			a = redacted
		case strings.HasPrefix(a, "--access-token="):
			a = "--access-token=" + redacted
		}
		out[i] = redactSecrets(a, nil)
	}
	return strings.Join(out, " ")
}

// librespotPlaying: is librespot playing, by its last event? (librespotevents.go)
var librespotPlaying atomic.Bool

// librespotActivity is when librespot last showed it did something: a line at
// INFO or above, a line of gst-launch's, or an --onevent event.
var librespotActivity atomic.Int64

func noteLibrespotActivity(t time.Time) { librespotActivity.Store(t.UnixNano()) }

// librespotActiveSince: has librespot shown anything since t?
func librespotActiveSince(t time.Time) bool { return librespotActivity.Load() >= t.UnixNano() }

// librespotOutput logs one librespot's output.
type librespotOutput struct {
	secrets []string                     // its token, and anything else it must not show
	logf    func(string, ...interface{}) // log.Printf
	now     func() time.Time
	onLoss  func(line string) // it logged one of librespotLossLines
	// at most max lines in each window; WARN and ERROR always
	window time.Duration
	max    int

	mu       sync.Mutex
	winStart time.Time
	n        int
	dropped  int
}

func newLibrespotOutput(secrets []string, verbose bool, onLoss func(string)) *librespotOutput {
	o := &librespotOutput{secrets: secrets, logf: log.Printf, now: time.Now, onLoss: onLoss,
		window: 10 * time.Second, max: 100}
	if verbose {
		// -v is librespot=trace: every dealer message and audio request
		o.max = 500
	}
	return o
}

// consume logs r's lines until it ends. It reads on whatever it does with
// them, so that librespot never waits on a full pipe.
func (o *librespotOutput) consume(r io.Reader) {
	br := bufio.NewReaderSize(r, 4096)
	var line []byte
	cut := false
	for {
		chunk, err := br.ReadSlice('\n')
		if !cut {
			line = append(line, chunk...)
			if len(line) > librespotLineRead {
				line, cut = line[:librespotLineRead], true
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if len(line) > 0 {
			o.line(strings.TrimRight(string(line), "\r\n"))
		}
		line, cut = line[:0], false
		if err != nil {
			return
		}
	}
}

// line logs one line of librespot's.
func (o *librespotOutput) line(raw string) {
	text := redactSecrets(raw, o.secrets)
	if strings.TrimSpace(text) == "" {
		return
	}
	text = truncateUTF8(text, librespotLineMax)
	level, important := "", false
	if m := librespotLogLine.FindStringSubmatch(text); m != nil {
		level = m[1]
		text = m[1] + " " + strings.TrimPrefix(m[2], "librespot_") + ": " + m[3]
		important = level == "WARN" || level == "ERROR"
	}
	now := o.now()
	if level != "TRACE" && level != "DEBUG" {
		noteLibrespotActivity(now)
	}
	if important {
		for _, l := range librespotSessionGone {
			if strings.Contains(raw, l) {
				librespotResume.forgot()
				break
			}
		}
	}
	if important && o.onLoss != nil {
		for _, l := range librespotLossLines {
			if strings.Contains(raw, l) {
				o.onLoss(text)
				break
			}
		}
	}
	o.mu.Lock()
	if now.Sub(o.winStart) >= o.window {
		if o.dropped > 0 {
			o.logf("librespot| (%d lines not logged in %v)", o.dropped, o.window)
		}
		o.winStart, o.n, o.dropped = now, 0, 0
	}
	if o.n >= o.max && !important {
		o.dropped++
		o.mu.Unlock()
		return
	}
	o.n++
	o.mu.Unlock()
	o.logf("librespot| %s", text)
}
