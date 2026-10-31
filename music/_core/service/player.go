package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/zmb3/spotify/v2"
)

// selectLibrespotDevice finds the local librespot Connect receiver (by name) and
// remembers its ID so all transport commands target it. librespot must already
// be running on the device and logged in (Premium).
func selectLibrespotDevice() {
	sess.mu.RLock()
	c, name := sess.client, sess.librespotName
	sess.mu.RUnlock()
	if c == nil {
		return
	}
	devices, err := c.PlayerDevices(context.Background())
	if err != nil {
		log.Printf("PlayerDevices: %v", err)
		return
	}
	for _, d := range devices {
		if strings.EqualFold(d.Name, name) {
			sess.mu.Lock()
			sess.deviceID = d.ID
			sess.mu.Unlock()
			log.Printf("playback device %q -> %s", name, d.ID)
			return
		}
	}
	log.Printf("librespot device %q not found among %d devices; is librespot running?", name, len(devices))
}

func setDeviceID(id spotify.ID) {
	sess.mu.Lock()
	sess.deviceID = id
	sess.mu.Unlock()
}

func deviceIDString() string {
	sess.mu.RLock()
	defer sess.mu.RUnlock()
	return string(sess.deviceID)
}

// playerErr answers a /player/* command that failed.
func playerErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errDeviceMissing):
		httpErr(w, http.StatusConflict, "no librespot device; is it running/logged in?")
	case errors.Is(err, errNoWebSession):
		httpErr(w, http.StatusUnauthorized, "no session; POST /session first")
	default:
		httpErr(w, http.StatusBadGateway, err.Error())
	}
}

func deviceOpt() *spotify.PlayOptions {
	sess.mu.RLock()
	id := sess.deviceID
	sess.mu.RUnlock()
	if id == "" {
		return nil
	}
	return &spotify.PlayOptions{DeviceID: &id}
}

// POST /player/load {uri, position_ms}
func handlePlayerLoad(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	var body struct {
		URI        string `json:"uri"`
		PositionMs int    `json:"position_ms"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	noteAppPlayer(body.URI)

	librespotHold.release()
	err := commandOnDevice(r.Context(), "load", func(ctx context.Context, opt *spotify.PlayOptions) error {
		opt.URIs = []spotify.URI{spotify.URI(body.URI)}
		if body.PositionMs > 0 {
			opt.PositionMs = spotify.Numeric(body.PositionMs)
		}
		return c.PlayOpt(ctx, opt)
	})
	if err != nil {
		playerErr(w, err)
		return
	}
	librespotCommands.answered("/player/load")
	// report duration so the UI can show the seek bar immediately
	dur := 0
	if id := strings.TrimPrefix(body.URI, "spotify:track:"); id != body.URI {
		if t, err := c.GetTrack(r.Context(), spotify.ID(id)); err == nil {
			dur = int(t.Duration)
		}
	}
	writeJSON(w, map[string]interface{}{"ok": true, "duration_ms": dur})
}

func handlePlayerPlay(w http.ResponseWriter, r *http.Request) {
	noteAppPlayer("")
	librespotHold.release()
	c := currentClient(w)
	if c == nil {
		return
	}
	if err := commandOnDevice(r.Context(), "play", func(ctx context.Context, opt *spotify.PlayOptions) error {
		return c.PlayOpt(ctx, opt)
	}); err != nil {
		playerErr(w, err)
		return
	}
	librespotCommands.answered("/player/play")
	writeJSON(w, map[string]bool{"ok": true})
}

// POST /player/pause. librespot's output is held still first (librespotcontrol.go),
// so that it is silent at once, and even when the Web API cannot pause it: the
// reply is then {ok, held}.
func handlePlayerPause(w http.ResponseWriter, r *http.Request) {
	noteAppPlayer("")
	gen, held := librespotHold.hold()
	c, err := webAPI{}.client()
	if err == nil {
		opt := deviceOpt()
		err = c.PauseOpt(r.Context(), opt)
		// not healed here, where the hold has silenced librespot already: looked
		// at in the background
		if h := librespotHeal; h != nil && (opt == nil || isDeviceGone(err)) {
			go h.check("pause without librespot's device")
		}
	}
	switch {
	case err == nil:
		if held {
			go librespotCtl.watchRemoteResume(gen)
		} else {
			// held, librespot's player waits on its pipe and says nothing
			librespotCommands.answered("/player/pause")
		}
		writeJSON(w, map[string]bool{"ok": true})
	case held:
		log.Printf("player/pause: %v; librespot's output held", err)
		writeJSON(w, map[string]bool{"ok": true, "held": true})
	case errors.Is(err, errNoWebSession):
		httpErr(w, http.StatusUnauthorized, "no session; POST /session first")
	default:
		httpErr(w, http.StatusBadGateway, err.Error())
	}
}

func handlePlayerNext(w http.ResponseWriter, r *http.Request) {
	noteAppPlayer("")
	librespotHold.release()
	c := currentClient(w)
	if c == nil {
		return
	}
	if err := commandOnDevice(r.Context(), "next", func(ctx context.Context, opt *spotify.PlayOptions) error {
		return c.NextOpt(ctx, opt)
	}); err != nil {
		playerErr(w, err)
		return
	}
	librespotCommands.answered("/player/next")
	writeJSON(w, map[string]bool{"ok": true})
}

func handlePlayerPrev(w http.ResponseWriter, r *http.Request) {
	noteAppPlayer("")
	librespotHold.release()
	c := currentClient(w)
	if c == nil {
		return
	}
	if err := commandOnDevice(r.Context(), "previous", func(ctx context.Context, opt *spotify.PlayOptions) error {
		return c.PreviousOpt(ctx, opt)
	}); err != nil {
		playerErr(w, err)
		return
	}
	librespotCommands.answered("/player/previous")
	writeJSON(w, map[string]bool{"ok": true})
}

// POST /player/seek {position_ms}
func handlePlayerSeek(w http.ResponseWriter, r *http.Request) {
	noteAppPlayer("")
	c := currentClient(w)
	if c == nil {
		return
	}
	var body struct {
		PositionMs int `json:"position_ms"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := commandOnDevice(r.Context(), "seek", func(ctx context.Context, opt *spotify.PlayOptions) error {
		return c.SeekOpt(ctx, body.PositionMs, opt)
	}); err != nil {
		playerErr(w, err)
		return
	}
	librespotCommands.answered("/player/seek")
	writeJSON(w, map[string]bool{"ok": true})
}

// POST /player/volume {volume} 0..100
func handlePlayerVolume(w http.ResponseWriter, r *http.Request) {
	noteAppPlayer("")
	c := currentClient(w)
	if c == nil {
		return
	}
	var body struct {
		Volume int `json:"volume"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// not watched for librespot acting on it: the same volume again changes nothing
	if err := commandOnDevice(r.Context(), "volume", func(ctx context.Context, opt *spotify.PlayOptions) error {
		return c.VolumeOpt(ctx, body.Volume, opt)
	}); err != nil {
		playerErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// GET /player/status -> {is_playing, position_ms, duration_ms, uri, state}
func handlePlayerStatus(w http.ResponseWriter, r *http.Request) {
	// the Music app polls this every second while it has a Spotify track
	noteAppPlayer("")
	c := currentClient(w)
	if c == nil {
		return
	}
	st, err := c.PlayerCurrentlyPlaying(r.Context())
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	// librespot's reported progress runs ~gstBufferLatencyMs ahead of the audible
	// output (it decodes into the gst queue faster than realtime). Subtract it so
	// the counter reflects what's being heard; clamp to 0 so it shows 0 while the
	// buffer is still filling at track start.
	pos := int(st.Progress) - gstBufferLatencyMs
	if pos < 0 {
		pos = 0
	}
	out := map[string]interface{}{
		"is_playing":  st.Playing,
		"position_ms": pos,
	}
	if st.Item != nil {
		out["uri"] = string(st.Item.URI)
		out["duration_ms"] = int(st.Item.Duration)
		out["state"] = "playing"
		// librespot streams Ogg Vorbis at --bitrate 320 (see librespot.go), so Spotify's
		// quality badge is constant.
		out["format"] = "OGG 320"
		out["formats"] = []string{"OGG 320"}
	} else {
		out["state"] = "idle"
	}
	writeJSON(w, out)
}
