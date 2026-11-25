package main

import (
	"errors"
	"testing"
)

// Each device is its own Connect receiver: librespot's device id is the sha1
// of its name, so two devices on one account must not share one.
func TestDefaultLibrespotName(t *testing.T) {
	host := func(h string, err error) func() (string, error) {
		return func() (string, error) { return h, err }
	}
	id := func(s string) func() string { return func() string { return s } }
	for _, c := range []struct {
		host      string
		hostErr   error
		machineID string
		want      string
	}{
		{"mindphone", nil, "0123456789abcdef", "webOS (mindphone)"},
		{"qx1000\n", nil, "", "webOS (qx1000)"},
		{"localhost", nil, "a1b2c3d4e5f6\n", "webOS (a1b2c3)"},
		{"", errors.New("no uts"), "a1b2c3d4e5f6", "webOS (a1b2c3)"},
		{"(none)", nil, "abc", "webOS"},
		{"", nil, "", "webOS"},
	} {
		if got := defaultLibrespotName(host(c.host, c.hostErr), id(c.machineID)); got != c.want {
			t.Errorf("host %q, machine id %q: %q, want %q", c.host, c.machineID, got, c.want)
		}
	}
	// two devices, two names
	a := defaultLibrespotName(host("mindphone", nil), id(""))
	b := defaultLibrespotName(host("qx1000", nil), id(""))
	if a == b {
		t.Errorf("two hosts share the name %q", a)
	}
}
