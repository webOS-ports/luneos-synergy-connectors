package main

import (
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// librespot process manager. The backend spawns librespot as the Spotify Connect
// receiver "webOS" and keeps it alive; the backend's /player/* endpoints then
// control it via the Connect Web API. Audio is decoded by librespot and piped
// (subprocess backend) into a gstreamer pipeline that resamples 44.1->48kHz and
// plays through pulse with media.role=music (so Palm's audio policy routes it to
// the speakers). This exact recipe was validated on-device.

// Log and cache live under spotifyDataDir (/media/cryptofs) — NOT /media/internal,
// which would pin the USB-exported vfat partition. See paths.go. The binary is the
// image's (/usr/bin/librespot, the librespot recipe) unless one was put in
// spotifyDataDir, which wins so a hand-built librespot can be tried on one device.
var librespotCandidates = []string{spotifyDataDir + "/librespot", "/usr/bin/librespot"}

var (
	librespotBin string
	// where librespot's output went before it went to the journal (librespotlog.go);
	// removed at start, so that nobody reads an old one for the current one
	librespotOldLog = spotifyDataDir + "/librespot.log"
	librespotDir    = spotifyDataDir + "/librespot-cache"
	librespotMu     sync.Mutex
	librespotUp     bool
	librespotCur    *exec.Cmd // the running librespot, for restartLibrespot
	librespotSince  time.Time // when it started
	librespotSoon   bool      // it was ended to be restarted: no pause before the next
	// librespotVerbose runs librespot with --verbose (-librespot-verbose).
	librespotVerbose bool
)

// gstDevice: librespot subprocess sink. audioresample -> native 48kHz avoids
// pulse's low-quality "palm" resampler; media.role=music -> speakers.
// CRITICAL: the queue MUST be bounded by BYTES, not time. fdsrc emits raw PCM with
// no buffer timestamps, so a max-size-time limit can never trigger; with
// max-size-bytes=0 (unlimited) the queue accepted the WHOLE decoded track, letting
// librespot dump it into RAM at ~3-4x realtime, hit end-of-track in ~1min, and Stop
// (killing gst mid-playback — that was the "music stops after 1-2.5min then restarts
// from 0" bug). Bounding by bytes makes the queue block upstream and forces librespot
// to feed at realtime. PCM here is 44100*2ch*2B = 176400 B/s, so this is ~1s of
// jitter cushion — plenty, since the whole track is already cached within ~3s of
// load (no network underrun risk). pulse does the 44.1->48k rate conversion; a small
// 0.5s pulse buffer keeps startup preroll short.
const gstDevice = `gst-launch-1.0 fdsrc fd=0 ! ` +
	`queue max-size-buffers=0 max-size-bytes=176400 max-size-time=0 ! ` +
	`audio/x-raw,format=S16LE,rate=44100,channels=2,layout=interleaved ! ` +
	`audioconvert ! ` +
	`pulsesink stream-properties=s,media.role=music buffer-time=500000 latency-time=50000`

// gstBufferLatencyMs is how far AHEAD librespot's reported progress runs vs the
// audible output. With the small buffer above audio now starts almost immediately
// (before the queue fills), so the lag is only ~1-2s and GROWS during the first
// second of play rather than being a fixed pre-buffered amount. A big subtraction
// would wrongly pin the counter at 0 while audio plays, so we correct only a
// small amount — keeping the residual error ~1s in either direction.
const gstBufferLatencyMs = 1000

// startLibrespot launches the managed librespot loop once (idempotent).
func startLibrespot() {
	librespotMu.Lock()
	defer librespotMu.Unlock()
	if librespotUp {
		return
	}
	librespotBin = findExecutable(librespotCandidates...)
	if librespotBin == "" {
		log.Printf("librespot not found at %s; playback disabled", strings.Join(librespotCandidates, " or "))
		return
	}
	log.Printf("librespot: using %s", librespotBin)
	librespotUp = true
	go librespotLoop()
}

func killStaleLibrespot() {
	// A backend restart orphans the previous librespot; clear it so we don't get
	// two "webOS" Connect devices.
	_ = exec.Command("sh", "-c", "for p in $(pidof librespot gst-launch-1.0); do kill -9 $p 2>/dev/null; done").Run()
	time.Sleep(500 * time.Millisecond)
}

// librespotVerboseEnv: librespot reads its options from LIBRESPOT_* too
// (src/main.rs), and its log filter from RUST_LOG, both of which it inherits
// from the unit; either makes it as talkative as --verbose can.
func librespotVerboseEnv(getenv func(string) string) bool {
	return librespotVerbose || getenv("LIBRESPOT_VERBOSE") != "" || getenv("RUST_LOG") != ""
}

// librespotArgs is librespot's command line. The token is not on it: it goes in
// LIBRESPOT_ACCESS_TOKEN (librespotEnv), since anyone can read a command line in
// /proc, and only root its environment.
func librespotArgs(onevent string, verbose bool) []string {
	args := []string{
		"--name", sess.librespotName,
		"--backend", "subprocess",
		"--device", gstDevice,
		"--system-cache", librespotDir,
		"--bitrate", "320",
		"--dither", "none", // tpdf dithering is per-sample CPU we can't spare on this ARM
		"--autoplay", "off", // we play single tracks (no context); without this librespot's
		// radio/autoplay advances to a random recommended track a few seconds after pause,
		// so "resume" landed on a different song from its start.
		"--initial-volume", "100",
		"--volume-ctrl", "linear",
	}
	// its player events, for the media session (librespotevents.go)
	if onevent != "" {
		args = append(args, "--onevent", onevent)
	}
	if verbose {
		args = append(args, "--verbose")
	}
	return args
}

// librespotEnv is librespot's environment: the daemon's, and the token, when
// there is one (the first login needs it; afterwards --system-cache creds suffice).
func librespotEnv(environ []string, tok string) []string {
	env := make([]string, 0, len(environ)+1)
	for _, e := range environ {
		if !strings.HasPrefix(e, "LIBRESPOT_ACCESS_TOKEN=") {
			env = append(env, e)
		}
	}
	if tok != "" {
		env = append(env, "LIBRESPOT_ACCESS_TOKEN="+tok)
	}
	return env
}

// librespotRestartDelay is the pause before the next librespot: 5 s, doubling to
// 20 s while each runs for less than 30 s (no network at boot: it exits at once).
func librespotRestartDelay(prev, ran time.Duration, soon bool) time.Duration {
	switch {
	case soon:
		return time.Second
	case ran >= 30*time.Second || prev < 5*time.Second:
		return 5 * time.Second
	case prev*2 > 20*time.Second:
		return 20 * time.Second
	default:
		return prev * 2
	}
}

func librespotLoop() {
	killStaleLibrespot()
	_ = os.Remove(librespotOldLog)
	delay := time.Duration(0)
	for {
		// librespot's own token (librespotauth.go), not the Web API one: Connect refuses that.
		tok := freshLibrespotToken()
		if tok == "" && !fileExists(librespotDir+"/credentials.json") {
			// Not signed in yet; handleLibrespotCallback restarts the loop's librespot, and
			// until then there is nothing to log in with.
			time.Sleep(5 * time.Second)
			continue
		}
		ran, werr := runLibrespot(librespotBin, tok)
		if ran < 0 {
			time.Sleep(10 * time.Second)
			continue
		}
		// what it held, it held as this librespot; the next one starts afresh
		librespotHold.release()
		if mediaSession != nil {
			mediaSession.post(mediaSession.onLibrespotExit)
		}
		librespotMu.Lock()
		soon := librespotSoon
		librespotMu.Unlock()
		delay = librespotRestartDelay(delay, ran, soon)
		status := "exited"
		if werr != nil {
			status = werr.Error()
		}
		log.Printf("librespot: %s after %v; restarting in %v", status, ran.Round(time.Second), delay)
		time.Sleep(delay)
	}
}

// librespotLogf is where librespot's output goes (librespotlog.go).
var librespotLogf = log.Printf

// runLibrespot runs one librespot to its end, its output to the journal, and
// says how long it ran; -1 when it did not start.
func runLibrespot(bin, tok string) (time.Duration, error) {
	verbose := librespotVerboseEnv(os.Getenv)
	args := librespotArgs(librespotOnEvent(), verbose)
	cmd := exec.Command(bin, args...)
	cmd.Env = librespotEnv(os.Environ(), tok)
	// stdout and stderr, librespot's and its gst-launch's, into one pipe
	pr, pw, err := os.Pipe()
	if err != nil {
		log.Printf("librespot: no pipe for its output (%v); it goes nowhere", err)
		pr, pw = nil, nil
	} else {
		cmd.Stdout, cmd.Stderr = pw, pw
	}
	log.Printf("librespot: starting (token=%v, verbose=%v): %s %s", tok != "", verbose, bin, redactArgs(args))
	err = cmd.Start()
	if pw != nil {
		pw.Close() // librespot and its children hold the write end now
	}
	if err != nil {
		log.Printf("librespot: start failed: %v", err)
		if pr != nil {
			pr.Close()
		}
		return -1, err
	}
	consumed := make(chan struct{})
	if pr != nil {
		var onLoss func(string)
		if h := librespotHeal; h != nil {
			onLoss = h.onLoss
		}
		out := newLibrespotOutput([]string{tok}, verbose, onLoss)
		out.logf = librespotLogf
		// ends when librespot and every child of it holding the pipe have gone
		go func() { out.consume(pr); pr.Close(); close(consumed) }()
	} else {
		close(consumed)
	}
	// a new librespot has no track
	librespotResume.forgot()
	started := time.Now()
	librespotMu.Lock()
	librespotCur, librespotSince, librespotSoon = cmd, started, false
	librespotMu.Unlock()
	// once it registers, it is the playback device
	if h := librespotHeal; h != nil {
		h.started()
	}
	werr := cmd.Wait()
	ran := time.Since(started)
	librespotMu.Lock()
	librespotCur = nil
	librespotMu.Unlock()
	librespotPlaying.Store(false)
	// its last words before the line that it exited; a gst-launch it left
	// behind holding the pipe is not waited for
	select {
	case <-consumed:
	case <-time.After(500 * time.Millisecond):
	}
	return ran, werr
}

// killLibrespot ends the running librespot for the loop to start another at once:
// asked first (SIGINT: it deletes its Connect state and says goodbye), killed
// after 3 s.
func killLibrespot(why string) {
	librespotMu.Lock()
	cur := librespotCur
	if cur != nil {
		librespotSoon = true
	}
	librespotMu.Unlock()
	if cur == nil || cur.Process == nil {
		return
	}
	log.Printf("librespot: ending pid %d: %s", cur.Process.Pid, why)
	_ = cur.Process.Signal(os.Interrupt)
	go func() {
		time.Sleep(3 * time.Second)
		librespotMu.Lock()
		still := librespotCur == cur
		librespotMu.Unlock()
		if still {
			_ = cur.Process.Kill()
		}
	}()
}

// restartLibrespot makes the loop start librespot again, with the token it has now, or starts
// the loop if it is not running.
func restartLibrespot() {
	librespotMu.Lock()
	cur := librespotCur
	if cur != nil {
		librespotSoon = true
	}
	librespotMu.Unlock()
	if cur != nil && cur.Process != nil {
		_ = cur.Process.Kill()
	}
	startLibrespot()
}

// currentLibrespot is the running librespot's pid and start, or 0.
func currentLibrespot() (int, time.Time) {
	librespotMu.Lock()
	defer librespotMu.Unlock()
	if librespotCur == nil || librespotCur.Process == nil {
		return 0, time.Time{}
	}
	return librespotCur.Process.Pid, librespotSince
}

// currentLibrespotPid is the running librespot's pid, or 0.
func currentLibrespotPid() int {
	librespotMu.Lock()
	defer librespotMu.Unlock()
	if librespotCur == nil || librespotCur.Process == nil {
		return 0
	}
	return librespotCur.Process.Pid
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
