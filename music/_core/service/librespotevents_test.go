package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLibrespotEventsThroughTheFIFO(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "librespot-events")
	r, err := openLibrespotEvents(fifo)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	fi, err := os.Lstat(fifo)
	if err != nil || fi.Mode()&os.ModeNamedPipe == 0 || fi.Mode().Perm() != 0o600 {
		t.Fatalf("FIFO %v, %v", fi.Mode(), err)
	}
	got := make(chan map[string]string, 4)
	go readLibrespotEvents(r, func(ev map[string]string) { got <- ev })

	forwardLibrespotEvent(envOf(map[string]string{
		"PLAYER_EVENT": "track_changed", "URI": "spotify:track:1", "NAME": "Song",
		"ARTISTS": "A\nB", "ACCESS_TOKEN": "must-not-pass", "HOME": "/root",
	}), fifo)
	forwardLibrespotEvent(envOf(map[string]string{"NAME": "no event"}), fifo) // nothing sent
	forwardLibrespotEvent(envOf(map[string]string{"PLAYER_EVENT": "paused", "POSITION_MS": "7"}), fifo)

	want := []map[string]string{
		{"PLAYER_EVENT": "track_changed", "URI": "spotify:track:1", "NAME": "Song", "ARTISTS": "A\nB"},
		{"PLAYER_EVENT": "paused", "POSITION_MS": "7"},
	}
	for i, w := range want {
		select {
		case ev := <-got:
			if len(ev) != len(w) {
				t.Errorf("event %d: %v, want %v", i, ev, w)
			}
			for k, v := range w {
				if ev[k] != v {
					t.Errorf("event %d: %s = %q, want %q", i, k, ev[k], v)
				}
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("event %d never came", i)
		}
	}
}

func TestLibrespotEventWithNobodyReading(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "librespot-events")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		forwardLibrespotEvent(envOf(map[string]string{"PLAYER_EVENT": "playing"}), fifo)
		forwardLibrespotEvent(envOf(map[string]string{"PLAYER_EVENT": "playing"}), filepath.Join(dir, "none"))
		// a plain file in its place is not written to
		plain := filepath.Join(dir, "plain")
		_ = os.WriteFile(plain, nil, 0o600)
		forwardLibrespotEvent(envOf(map[string]string{"PLAYER_EVENT": "playing"}), plain)
		if b, _ := os.ReadFile(plain); len(b) != 0 {
			t.Errorf("wrote %q into a plain file", b)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the forwarder waits for a reader; librespot would wait with it")
	}
}

func TestLibrespotEventFIFOReplacesAFile(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "librespot-events")
	if err := os.WriteFile(fifo, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := openLibrespotEvents(fifo)
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	// a FIFO others may write is made the owner's
	if err := os.Chmod(fifo, 0o666); err != nil {
		t.Fatal(err)
	}
	r, err = openLibrespotEvents(fifo)
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	if fi, _ := os.Lstat(fifo); fi.Mode()&os.ModeNamedPipe == 0 || fi.Mode().Perm() != 0o600 {
		t.Fatalf("FIFO is %v", fi.Mode())
	}
}

func TestLibrespotEventIsBounded(t *testing.T) {
	long := "x" + strings.Repeat("é", 5000) // two bytes each, starting at odd offsets
	line := encodeLibrespotEvent(envOf(map[string]string{"PLAYER_EVENT": "track_changed", "NAME": long, "ALBUM": long, "URI": "u"}))
	if len(line) > librespotEventMax || line[len(line)-1] != '\n' {
		t.Fatalf("%d bytes", len(line))
	}
	var ev map[string]string
	if err := json.Unmarshal(line, &ev); err != nil {
		t.Fatal(err)
	}
	if ev["PLAYER_EVENT"] != "track_changed" || ev["URI"] != "u" || !strings.HasPrefix(long, ev["NAME"]) {
		t.Errorf("shortened wrongly: %q %q", ev["PLAYER_EVENT"], ev["URI"])
	}
	if strings.ContainsRune(ev["NAME"], '�') {
		t.Error("cut inside a character")
	}
	if encodeLibrespotEvent(envOf(map[string]string{"NAME": "x"})) != nil {
		t.Error("an event without PLAYER_EVENT was encoded")
	}
}

func TestLibrespotOnEvent(t *testing.T) {
	got := librespotOnEvent()
	exe, _ := os.Executable()
	if strings.ContainsAny(exe, " \t") {
		if got != "" {
			t.Errorf("%q: librespot would split the path", got)
		}
		return
	}
	if got != exe+" "+librespotEventArg {
		t.Errorf("onevent %q", got)
	}
}
