package main

// librespot's player events, for the media session (mediasession.go).
//
// librespot runs the program given with --onevent for each event, with the event
// in its environment (PLAYER_EVENT, TRACK_ID, URI, NAME, ARTISTS, ...; librespot's
// src/player_event_handler.rs), one at a time, waiting for each to exit. The
// program is this binary again, as `spotify-webos-service -librespot-event`: it
// writes the event as one line of JSON into a FIFO the daemon reads, and exits.
// The FIFO is in spotifyDataDir, which only root can enter, and nothing is
// written when the daemon is not reading it.
//
// No --emit-sink-events: librespot runs those on its player thread and waits for
// the program, which would hold the sound up for as long as this binary takes to
// start.

import (
	"bufio"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strings"
	"syscall"
	"time"
)

// librespotEventArg is the argument that makes this binary forward one event.
const librespotEventArg = "-librespot-event"

var librespotEventFIFO = spotifyDataDir + "/librespot-events"

// librespotEventKeys are the variables passed on; everything else librespot's
// environment carries stays behind.
var librespotEventKeys = []string{
	"PLAYER_EVENT", "TRACK_ID", "URI", "NAME", "ARTISTS", "ALBUM", "DURATION_MS",
	"NUMBER", "ITEM_TYPE", "SHOW_NAME", "POSITION_MS",
}

// librespotEventMax keeps an event within what one write to a pipe delivers whole.
const librespotEventMax = 4000

// librespotOnEvent is the --onevent program, or "" when there is none: librespot
// splits it on white space, so a path with any cannot be passed.
func librespotOnEvent() string {
	exe, err := os.Executable()
	if err != nil || exe == "" || strings.ContainsAny(exe, " \t\n") {
		return ""
	}
	return exe + " " + librespotEventArg
}

// forwardLibrespotEvent is the whole of `spotify-webos-service -librespot-event`.
// It always succeeds: librespot only logs a failing program, and an event that
// cannot be delivered is one the session does without.
func forwardLibrespotEvent(getenv func(string) string, fifo string) {
	line := encodeLibrespotEvent(getenv)
	if line == nil {
		return
	}
	// O_NONBLOCK: with nobody reading, the open fails at once (ENXIO) instead of
	// waiting for a reader.
	f, err := os.OpenFile(fifo, os.O_WRONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || fi.Mode()&os.ModeNamedPipe == 0 {
		return
	}
	_, _ = f.Write(line)
}

// encodeLibrespotEvent is the event as one line of JSON, at most
// librespotEventMax bytes, or nil when there is no event.
func encodeLibrespotEvent(getenv func(string) string) []byte {
	ev := map[string]string{}
	for _, k := range librespotEventKeys {
		if v := getenv(k); v != "" {
			ev[k] = v
		}
	}
	if ev["PLAYER_EVENT"] == "" {
		return nil
	}
	for {
		b, err := json.Marshal(ev)
		if err != nil {
			return nil
		}
		if len(b)+1 <= librespotEventMax {
			return append(b, '\n')
		}
		// too long: shorten the longest value, which is never the event's name
		longest := ""
		for k, v := range ev {
			if k != "PLAYER_EVENT" && len(v) > len(ev[longest]) {
				longest = k
			}
		}
		if longest == "" {
			return nil
		}
		ev[longest] = truncateUTF8(ev[longest], len(ev[longest])/2)
	}
}

// truncateUTF8 cuts s to at most n bytes, not inside a character.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

// openLibrespotEvents makes the FIFO (again, if something else is in its place)
// and opens it for reading. Opened read-write, so that it is never at end of file
// between two events, and the open does not wait for a writer.
func openLibrespotEvents(fifo string) (*os.File, error) {
	if fi, err := os.Lstat(fifo); err == nil && fi.Mode()&os.ModeNamedPipe == 0 {
		if err := os.Remove(fifo); err != nil {
			return nil, err
		}
	}
	if err := syscall.Mkfifo(fifo, 0o600); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	f, err := os.OpenFile(fifo, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err == nil && fi.Mode()&os.ModeNamedPipe == 0 {
		err = errors.New("not a FIFO")
	}
	if err == nil && fi.Mode().Perm() != 0o600 {
		err = f.Chmod(0o600)
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// readLibrespotEvents hands each event in r to deliver until r ends.
func readLibrespotEvents(r *os.File, deliver func(map[string]string)) {
	lines := bufio.NewScanner(r)
	lines.Buffer(make([]byte, 0, librespotEventMax), 64*1024)
	for lines.Scan() {
		var ev map[string]string
		if err := json.Unmarshal(lines.Bytes(), &ev); err != nil || ev["PLAYER_EVENT"] == "" {
			continue
		}
		deliver(ev)
	}
	if err := lines.Err(); err != nil {
		log.Printf("librespot events: %v", err)
	}
}

// noteLibrespotEvent: librespot did something (librespotlog.go). Its session
// events are logged; session_disconnected is librespot becoming inactive -
// another device took the play over, or it shut down (connect/src/spirc.rs
// handle_disconnect) - and not, by itself, a lost connection.
func noteLibrespotEvent(ev map[string]string) {
	noteLibrespotActivity(time.Now())
	librespotResume.event(ev)
	switch e := ev["PLAYER_EVENT"]; e {
	case "session_connected", "session_disconnected", "session_client_changed":
		log.Printf("librespot event: %s", e)
	case "playing":
		librespotPlaying.Store(true)
	case "paused", "stopped", "end_of_track", "unavailable":
		librespotPlaying.Store(false)
	}
}
