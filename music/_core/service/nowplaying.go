package main

import "sync"

// nowPlaying tracks the format/quality of the CURRENTLY playing track so the UI can
// show a badge before the duration (and, later, offer tap-to-switch format selection).
// Each play path sets it when a track starts; the status handlers report it.
//
//	npFormat  — the active format label, e.g. "AAC 128", "OPUS 160", "OGG 320", "FLAC"
//	npFormats — the distinct labels available for the current track (for the selector)
var (
	npMu      sync.Mutex
	npFormat  string
	npFormats []string
)

func setNowPlaying(format string, formats []string) {
	npMu.Lock()
	npFormat, npFormats = format, formats
	npMu.Unlock()
}

func getNowPlaying() (string, []string) {
	npMu.Lock()
	defer npMu.Unlock()
	return npFormat, append([]string(nil), npFormats...)
}
