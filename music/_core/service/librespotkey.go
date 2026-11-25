package main

// A track librespot got no key for.
//
// librespot asks Spotify for each track's key and waits 1.5 s for it
// (core/src/audio_key.rs, KEY_RESPONSE_TIMEOUT). On a slow network the answer
// comes too late: "Audio key response timeout", then "Unable to load key,
// continuing without decryption" (playback/src/player.rs), and the track it
// then plays is silence, while the Web API and the Music app say playing. On
// the Q25 on 2026-11-25 a track went that way at 18:09:41.
//
// So the track is loaded once more, which asks for its key again. If the key
// does not come that time either, /player/status says so ("error"), and the
// Music app fails the track instead of counting over silence. A miss counts
// once per load librespot starts (its "loading" event): one load can log the
// line more than once.

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/zmb3/spotify/v2"
)

// librespotKeyLine is what librespot logs when it plays on without a key.
const librespotKeyLine = "Unable to load key"

// librespotKeyFailed is /player/status's error for a track whose key did not come twice.
const librespotKeyFailed = "Spotify did not send the key to play this track (the network may be too slow)"

type keyRetry struct {
	mu      sync.Mutex
	uri     string // the track /player/load put on librespot
	armed   bool   // librespot started loading it, and has not missed its key since
	retried bool   // it was loaded once more after a miss
	failed  bool   // the key did not come after that either
	// replay loads uri on librespot again; it runs on a goroutine of its own
	replay func(uri string)
}

var librespotKey = &keyRetry{replay: replayLibrespotLoad}

// loaded: /player/load put uri on librespot; any earlier track's misses are over.
func (k *keyRetry) loaded(uri string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.uri, k.armed, k.retried, k.failed = uri, false, false, false
}

// event takes librespot's events: "loading" is a load that may miss its key.
func (k *keyRetry) event(ev map[string]string) {
	if ev["PLAYER_EVENT"] != "loading" {
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.uri != "" && (ev["URI"] == "" || ev["URI"] == k.uri) {
		k.armed = true
	}
}

// missed: librespot logged librespotKeyLine.
func (k *keyRetry) missed() {
	k.mu.Lock()
	if !k.armed || k.uri == "" {
		k.mu.Unlock()
		return
	}
	k.armed = false
	uri := k.uri
	if k.retried {
		k.failed = true
		k.mu.Unlock()
		log.Printf("librespot: no key for %s when loaded again either; the Music app is told", uri)
		return
	}
	k.retried = true
	replay := k.replay
	k.mu.Unlock()
	log.Printf("librespot: no key for %s; loading it once more", uri)
	if replay != nil {
		go replay(uri)
	}
}

// failure is /player/status's error for uri, or "".
func (k *keyRetry) failure(uri string) string {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.failed && uri != "" && uri == k.uri {
		return librespotKeyFailed
	}
	return ""
}

// replayLibrespotLoad loads uri on librespot again, from its start.
func replayLibrespotLoad(uri string) {
	sess.mu.RLock()
	c := sess.client
	sess.mu.RUnlock()
	if c == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err := commandOnDevice(ctx, "load again", func(ctx context.Context, opt *spotify.PlayOptions) error {
		opt.URIs = []spotify.URI{spotify.URI(uri)}
		return c.PlayOpt(ctx, opt)
	})
	if err != nil {
		log.Printf("librespot: loading %s again failed: %v", uri, err)
	}
}

// isKeyLine: a librespot line saying it plays on without a key.
func isKeyLine(raw string) bool { return strings.Contains(raw, librespotKeyLine) }
