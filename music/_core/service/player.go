package main

import (
	"context"
	"encoding/json"
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

	opt := deviceOpt()
	if opt == nil {
		httpErr(w, http.StatusConflict, "no librespot device; is it running/logged in?")
		return
	}
	uri := spotify.URI(body.URI)
	opt.URIs = []spotify.URI{uri}
	if body.PositionMs > 0 {
		pos := spotify.Numeric(body.PositionMs)
		opt.PositionMs = pos
	}
	if err := c.PlayOpt(r.Context(), opt); err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
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
	c := currentClient(w)
	if c == nil {
		return
	}
	if err := c.PlayOpt(r.Context(), deviceOpt()); err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func handlePlayerPause(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	if err := c.PauseOpt(r.Context(), deviceOpt()); err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func handlePlayerNext(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	if err := c.NextOpt(r.Context(), deviceOpt()); err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func handlePlayerPrev(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	if err := c.PreviousOpt(r.Context(), deviceOpt()); err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// POST /player/seek {position_ms}
func handlePlayerSeek(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	var body struct {
		PositionMs int `json:"position_ms"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := c.SeekOpt(r.Context(), body.PositionMs, deviceOpt()); err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// POST /player/volume {volume} 0..100
func handlePlayerVolume(w http.ResponseWriter, r *http.Request) {
	c := currentClient(w)
	if c == nil {
		return
	}
	var body struct {
		Volume int `json:"volume"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := c.VolumeOpt(r.Context(), body.Volume, deviceOpt()); err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// GET /player/status -> {is_playing, position_ms, duration_ms, uri, state}
func handlePlayerStatus(w http.ResponseWriter, r *http.Request) {
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
