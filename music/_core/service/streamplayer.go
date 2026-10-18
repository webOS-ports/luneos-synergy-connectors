package main

import (
	"log"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// playStreamURL plays a direct http(s) audio URL through the device speakers,
// reusing the proven audio path: curl streams the URL into gstreamer, which
// decodes it, resamples to the DAC's native 48kHz, and outputs via pulse with
// media.role=music (Palm policy routes that to the hardware sink). This is the
// shared playback path for every "stream-URL" connector (YouTube, SoundCloud,
// Deezer, …) — Spotify is the exception (librespot/Connect).
//
// souphttpsrc isn't in the device's gst plugin set, so we pipe via curl|fdsrc
// (decodebin + the ffmpeg decoders handle mp3/aac/ogg/opus). The pipeline runs in
// its OWN PROCESS GROUP so pause/resume can SIGSTOP/SIGCONT the whole curl|gst
// chain. There is no unbounded queue here (unlike librespot's) — pulsesink applies
// realtime backpressure up through the pipe to curl, so playback stays at 1x.

type streamPlayer struct {
	mu        sync.Mutex
	cmd       *exec.Cmd
	pgid      int
	startedAt time.Time // wall-clock when the current (unpaused) segment began
	accumMs   int       // ms played before the current segment
	playing   bool
	paused    bool
}

var stream = &streamPlayer{}

func (s *streamPlayer) posMs() int {
	if s.playing && !s.paused {
		return s.accumMs + int(time.Since(s.startedAt)/time.Millisecond)
	}
	return s.accumMs
}

func playStreamURL(url string) error {
	stream.mu.Lock()
	defer stream.mu.Unlock()

	stream.killLocked()

	// NOTE: an added `queue` + larger buffer-time (a BT-hiccup fix attempt) caused the live
	// curl stream to EOS a few seconds in (track cut off ~5s). Reverted to the original
	// pipeline: no queue — pulsesink applies realtime backpressure up through the pipe to
	// curl, so playback stays at 1x and runs the full track. (Re-approach BT hiccups
	// separately, verifying it doesn't break normal playback first.)
	pipeline := "curl -sL --retry 2 '" + escapeSingle(url) + "' | " +
		"gst-launch-0.10 fdsrc fd=0 ! decodebin ! audioconvert ! ffaudioresample ! " +
		"audio/x-raw-int,rate=48000,channels=2,width=16,depth=16,signed=true,endianness=1234 ! " +
		"pulsesink stream-properties=s,media.role=music buffer-time=500000 latency-time=50000"

	cmd := exec.Command("sh", "-c", pipeline)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // own group -> signal curl+gst together
	if err := cmd.Start(); err != nil {
		return err
	}
	stream.cmd = cmd
	stream.pgid = cmd.Process.Pid
	stream.startedAt = time.Now()
	stream.accumMs = 0
	stream.playing = true
	stream.paused = false
	log.Printf("stream: playing %.60s", url)
	go func() {
		_ = cmd.Wait()
		// track finished (EOF) or died -> mark ended so /stream/status reports it and
		// the app can auto-advance. Only if this is still the current pipeline.
		stream.mu.Lock()
		if stream.cmd == cmd {
			stream.playing = false
			stream.paused = false
		}
		stream.mu.Unlock()
	}()
	return nil
}

// signalGroup sends sig to the whole pipeline process group (negative pid).
func (s *streamPlayer) signalGroup(sig syscall.Signal) {
	if s.cmd != nil && s.cmd.Process != nil && s.pgid > 0 {
		_ = syscall.Kill(-s.pgid, sig)
	}
}

func (s *streamPlayer) pauseLocked() {
	if !s.playing || s.paused {
		return
	}
	s.accumMs = s.posMs()
	s.paused = true
	s.signalGroup(syscall.SIGSTOP)
}

func (s *streamPlayer) resumeLocked() {
	if !s.playing || !s.paused {
		return
	}
	s.startedAt = time.Now()
	s.paused = false
	s.signalGroup(syscall.SIGCONT)
}

func (s *streamPlayer) killLocked() {
	if s.cmd != nil && s.cmd.Process != nil {
		s.signalGroup(syscall.SIGCONT) // a stopped group must be resumed before it can die
		if s.pgid > 0 {
			_ = syscall.Kill(-s.pgid, syscall.SIGKILL)
		}
		_ = s.cmd.Process.Kill()
	}
	s.cmd = nil
	s.playing = false
	s.paused = false
}

// exported transport used by the /stream/* handlers
func streamPause()  { stream.mu.Lock(); stream.pauseLocked(); stream.mu.Unlock() }
func streamResume() { stream.mu.Lock(); stream.resumeLocked(); stream.mu.Unlock() }
func stopStream()   { stream.mu.Lock(); stream.killLocked(); stream.mu.Unlock() }

// streamStatus reports transport state. `ended` is true once the pipeline has
// exited (track finished/stopped) as opposed to merely paused (process still alive).
func streamStatus() (playing bool, positionMs int, ended bool) {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	started := stream.cmd != nil
	return stream.playing && !stream.paused, stream.posMs(), started && !stream.playing
}

// escapeSingle makes a URL safe inside a single-quoted shell string.
func escapeSingle(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '\'' {
			out = append(out, '\'', '\\', '\'', '\'')
			continue
		}
		out = append(out, r)
	}
	return string(out)
}
