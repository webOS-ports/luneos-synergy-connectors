package main

import (
	"sync"
	"testing"
	"time"
)

// newTestKeyRetry is a keyRetry whose replays are recorded, not sent.
func newTestKeyRetry() (*keyRetry, func() []string) {
	var mu sync.Mutex
	var replays []string
	k := &keyRetry{replay: func(uri string) {
		mu.Lock()
		replays = append(replays, uri)
		mu.Unlock()
	}}
	got := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), replays...)
	}
	return k, got
}

func loading(uri string) map[string]string {
	return map[string]string{"PLAYER_EVENT": "loading", "URI": uri}
}

const keyTrack = "spotify:track:3oor02t4e60PUJ98NvIxR9"

// Q25, 18:09:41: the key did not come; the track is loaded once more.
func TestKeyMissLoadsTheTrackOnceMore(t *testing.T) {
	k, replays := newTestKeyRetry()
	k.loaded(keyTrack)
	k.event(loading(keyTrack))
	k.missed()
	waitReplays(t, replays, 1)
	if got := replays(); got[0] != keyTrack {
		t.Fatalf("loaded again %v, want %s", got, keyTrack)
	}
	if e := k.failure(keyTrack); e != "" {
		t.Fatalf("failed after one miss: %q", e)
	}
}

// One load can log the line twice (18:09:41 and 18:09:42, after two loads):
// that is one miss until librespot loads it again.
func TestKeyMissCountsOncePerLoad(t *testing.T) {
	k, replays := newTestKeyRetry()
	k.loaded(keyTrack)
	k.event(loading(keyTrack))
	k.missed()
	k.missed()
	waitReplays(t, replays, 1)
	if e := k.failure(keyTrack); e != "" {
		t.Fatalf("a second line of the same load failed the track: %q", e)
	}
	if n := len(replays()); n != 1 {
		t.Fatalf("loaded again %d times, want 1", n)
	}
}

// No key after it was loaded again either: /player/status says so.
func TestKeyMissedTwiceFailsTheTrack(t *testing.T) {
	k, replays := newTestKeyRetry()
	k.loaded(keyTrack)
	k.event(loading(keyTrack))
	k.missed()
	waitReplays(t, replays, 1)
	k.event(loading(keyTrack))
	k.missed()
	if e := k.failure(keyTrack); e != librespotKeyFailed {
		t.Fatalf("failure = %q, want %q", e, librespotKeyFailed)
	}
	if e := k.failure("spotify:track:other"); e != "" {
		t.Fatalf("another track failed too: %q", e)
	}
	if n := len(replays()); n != 1 {
		t.Fatalf("loaded again %d times, want 1", n)
	}
	// the app loads the track again: it gets its chance afresh
	k.loaded(keyTrack)
	if e := k.failure(keyTrack); e != "" {
		t.Fatalf("a new load kept the failure: %q", e)
	}
}

// A miss before librespot loads anything the app asked for (another
// controller's track) or of another track's load is not ours.
func TestKeyMissOfNoLoadOfOursIsIgnored(t *testing.T) {
	k, replays := newTestKeyRetry()
	k.missed()
	k.loaded(keyTrack)
	k.missed()
	k.event(loading("spotify:track:other"))
	k.missed()
	if n := len(replays()); n != 0 {
		t.Fatalf("loaded again %d times, want 0", n)
	}
}

// The line librespot logs reaches the retry through the log reader.
func TestKeyLineFromLibrespotsOutput(t *testing.T) {
	k, replays := newTestKeyRetry()
	old := librespotKey
	librespotKey = k
	defer func() { librespotKey = old }()
	k.loaded(keyTrack)
	k.event(loading(keyTrack))
	o := newLibrespotOutput(nil, false, nil)
	o.logf = func(string, ...interface{}) {}
	o.line("[2026-11-25T17:09:41Z WARN  librespot_playback::player] Unable to load key, continuing without decryption: Operation aborted { audio key response timeout }")
	waitReplays(t, replays, 1)
}

func waitReplays(t *testing.T, replays func() []string, n int) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if len(replays()) >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("loaded again %d times, want %d", len(replays()), n)
}
