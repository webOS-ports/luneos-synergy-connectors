package main

import (
	"encoding/json"
	"net/http"
)

// Transport for the shared stream player (YouTube and any future stream-URL
// connector). Playback is started via /provider/<id>/play; these control it.
//   POST /stream/pause  | /stream/resume | /stream/stop
//   GET  /stream/status -> {is_playing, position_ms}

func handleStreamPause(w http.ResponseWriter, r *http.Request) {
	streamPause()
	writeJSON(w, map[string]bool{"ok": true})
}

func handleStreamResume(w http.ResponseWriter, r *http.Request) {
	streamResume()
	writeJSON(w, map[string]bool{"ok": true})
}

func handleStreamStop(w http.ResponseWriter, r *http.Request) {
	stopStream()
	writeJSON(w, map[string]bool{"ok": true})
}

// POST /stream/switchformat {format} — re-resolve the CURRENT stream track in the given
// format and restart playback. Used by the tap-to-switch quality badge. (Restarts the
// track; position-resume would need seekable byte-range support we don't have yet.)
func handleStreamSwitchFormat(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Format string `json:"format"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	p, tid := streamContext()
	if p == nil || tid == "" {
		httpErr(w, http.StatusConflict, "nothing playing to switch")
		return
	}
	url, err := resolveStream(r.Context(), p, tid, body.Format)
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if url == "" {
		httpErr(w, http.StatusConflict, "no stream url for the chosen format")
		return
	}
	if err := playStreamURL(url); err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func handleStreamStatus(w http.ResponseWriter, r *http.Request) {
	playing, pos, ended := streamStatus()
	fmtLabel, fmts := getNowPlaying()
	writeJSON(w, map[string]interface{}{
		"is_playing": playing, "position_ms": pos, "ended": ended,
		"format": fmtLabel, "formats": fmts,
	})
}
