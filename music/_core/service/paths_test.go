package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadFirstNonEmpty(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	packaged := filepath.Join(dir, "packaged")
	blank := filepath.Join(dir, "blank")
	if err := os.WriteFile(packaged, []byte("  pkg-id\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blank, []byte(" \n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// state file missing: the packaged default is used, trimmed
	if got, from := readFirstNonEmpty(state, packaged); got != "pkg-id" || from != packaged {
		t.Fatalf("missing state file: got %q from %q", got, from)
	}
	// a blank override does not hide the packaged default
	if got, _ := readFirstNonEmpty(blank, packaged); got != "pkg-id" {
		t.Fatalf("blank state file: got %q", got)
	}
	// a device override wins
	if err := os.WriteFile(state, []byte("device-id"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, from := readFirstNonEmpty(state, packaged); got != "device-id" || from != state {
		t.Fatalf("override: got %q from %q", got, from)
	}
	// nothing anywhere
	if got, from := readFirstNonEmpty(filepath.Join(dir, "nope")); got != "" || from != "" {
		t.Fatalf("none: got %q from %q", got, from)
	}
}

func TestConfigPathsOrder(t *testing.T) {
	p := configPaths("spotify-client-id")
	if len(p) != 2 || p[0] != spotifyDataDir+"/spotify-client-id" || p[1] != packagedConfigDir+"/spotify-client-id" {
		t.Fatalf("unexpected order %v", p)
	}
}
