package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A token shaped as Spotify's are: BQ and a long run of base64url.
const testToken = "BQDtestTOKENabcdefghijklmnopqrstuvwxyz0123456789_-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"

// A token of no known shape: only being told finds it.
const shortToken = "s3cr3t-value-x"

type logSink struct {
	mu    sync.Mutex
	lines []string
}

func (s *logSink) logf(f string, a ...interface{}) {
	s.mu.Lock()
	s.lines = append(s.lines, fmt.Sprintf(f, a...))
	s.mu.Unlock()
}

func (s *logSink) all() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.lines, "\n")
}

func testOutput(secrets []string, clk *fakeClock, onLoss func(string)) (*librespotOutput, *logSink) {
	sink := &logSink{}
	o := newLibrespotOutput(secrets, false, onLoss)
	o.logf, o.now = sink.logf, clk.now
	return o, sink
}

func TestNoTokenReachesTheLog(t *testing.T) {
	short := shortToken
	lines := []string{
		"[2026-10-31T13:42:49Z TRACE librespot] \t\taccess-token \"" + testToken + "\"",
		"--access-token " + testToken,
		"--access-token=" + testToken,
		"LIBRESPOT_ACCESS_TOKEN=" + testToken,
		`{"access_token":"` + testToken + `","token_type":"Bearer"}`,
		"Authorization: Bearer " + testToken,
		"got " + testToken + " back",
		"token " + short + " here",
		strings.Repeat("A", 2000) + testToken, // past the cut
	}
	o, sink := testOutput([]string{testToken, short}, newFakeClock(), nil)
	o.consume(strings.NewReader(strings.Join(lines, "\n") + "\n"))
	got := sink.all()
	for _, leak := range []string{testToken, short, testToken[:40], testToken[20:60]} {
		if strings.Contains(got, leak) {
			t.Fatalf("token in the log:\n%s", got)
		}
	}
	if strings.Count(got, "librespot| ") != len(lines) {
		t.Fatalf("lines lost:\n%s", got)
	}
}

func TestRedactFindsTokensItWasNotGiven(t *testing.T) {
	for _, l := range []string{
		"access_token=abcdefghijklmnop1234",
		`"refresh_token": "abcdefghijklmnop1234"`,
		"Authorization: Bearer abcdefghijklmnop1234",
		"bearer abcdefghijklmnop1234",
		"plain " + testToken,
		"plain " + strings.Repeat("Zz09", 25),
	} {
		got := redactSecrets(l, nil)
		if strings.Contains(got, "abcdefghijklmnop1234") || strings.Contains(got, testToken[:30]) || strings.Contains(got, "Zz09Zz09Zz09") || !strings.Contains(got, redacted) {
			t.Errorf("%q became %q", l, got)
		}
	}
}

func TestRedactKeepsOrdinaryLines(t *testing.T) {
	for _, l := range []string{
		`Authenticated as 'test-user' !`,
		`Loading <Some Track> from <Some Artist> with Spotify URI <spotify:track:0FakeTrackId0000000002>`,
		`playback device "webOS" -> 0000000000000000000000000000000000000000`,
		`Authorization failed`,
	} {
		if got := redactSecrets(l, nil); got != l {
			t.Errorf("%q became %q", l, got)
		}
	}
}

func TestTheTokenIsNotOnTheCommandLine(t *testing.T) {
	args := librespotArgs("/usr/sbin/spotify-webos-service -librespot-event", false)
	if strings.Contains(strings.Join(args, " "), "token") {
		t.Fatalf("args %v", args)
	}
	env := librespotEnv([]string{"PATH=/bin", "LIBRESPOT_ACCESS_TOKEN=old"}, testToken)
	if strings.Join(env, " ") != "PATH=/bin LIBRESPOT_ACCESS_TOKEN="+testToken {
		t.Fatalf("env %v", env)
	}
	if env := librespotEnv([]string{"PATH=/bin", "LIBRESPOT_ACCESS_TOKEN=old"}, ""); len(env) != 1 {
		t.Fatalf("env %v: an old token stays behind", env)
	}
	logged := redactArgs([]string{"--name", "webOS", "--access-token", shortToken, "-k", shortToken, "--access-token=" + shortToken})
	if strings.Contains(logged, shortToken) || !strings.Contains(logged, "--name webOS") {
		t.Fatalf("logged %q", logged)
	}
}

func TestVerboseIsOffByDefault(t *testing.T) {
	none := func(string) string { return "" }
	if librespotVerboseEnv(none) || containsArg(librespotArgs("", false), "--verbose") {
		t.Fatal("verbose by default")
	}
	if !containsArg(librespotArgs("", true), "--verbose") {
		t.Fatal("-librespot-verbose without --verbose")
	}
	for _, k := range []string{"LIBRESPOT_VERBOSE", "RUST_LOG"} {
		k := k
		if !librespotVerboseEnv(func(n string) string {
			if n == k {
				return "1"
			}
			return ""
		}) {
			t.Errorf("%s not taken for verbose", k)
		}
	}
}

func containsArg(args []string, a string) bool {
	for _, x := range args {
		if x == a {
			return true
		}
	}
	return false
}

func TestOutputFormatsLibrespotsLinesAndGstreamers(t *testing.T) {
	o, sink := testOutput(nil, newFakeClock(), nil)
	o.consume(strings.NewReader("[2026-10-31T13:42:49Z INFO  librespot_core::session] Country: \"NL\"\r\nSetting pipeline to PAUSED ...\n\n   \nno newline at the end"))
	want := "librespot| INFO core::session: Country: \"NL\"\nlibrespot| Setting pipeline to PAUSED ...\nlibrespot| no newline at the end"
	if got := sink.all(); got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestOutputCutsLongLinesAndReadsOn(t *testing.T) {
	o, sink := testOutput(nil, newFakeClock(), nil)
	long := strings.Repeat("x.", 50000)
	o.consume(strings.NewReader(long + "\nafter\n"))
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.lines) != 2 || len(sink.lines[0]) > librespotLineMax+len("librespot| ") || sink.lines[1] != "librespot| after" {
		t.Fatalf("%d lines, first %d bytes, last %q", len(sink.lines), len(sink.lines[0]), sink.lines[len(sink.lines)-1])
	}
}

func TestACutDoesNotGoThroughAToken(t *testing.T) {
	o, sink := testOutput([]string{testToken}, newFakeClock(), nil)
	// the token sits across the point where the line is cut
	o.consume(strings.NewReader(strings.Repeat("x ", (librespotLineMax-30)/2) + testToken + " end\n"))
	if got := sink.all(); strings.Contains(got, testToken[:20]) {
		t.Fatalf("%d bytes, a piece of the token in them", len(got))
	}
}

func TestOutputIsRateLimitedButWarningsGetThrough(t *testing.T) {
	clk := newFakeClock()
	o, sink := testOutput(nil, clk, nil)
	var in strings.Builder
	for i := 0; i < 150; i++ {
		fmt.Fprintf(&in, "[t DEBUG librespot_core::dealer] message %d\n", i)
	}
	in.WriteString("[t WARN  librespot_core::session] Connection to server closed.\n")
	o.consume(strings.NewReader(in.String()))
	clk.advance(11 * time.Second)
	o.consume(strings.NewReader("[t INFO  librespot] later\n"))
	got := sink.all()
	if n := strings.Count(got, "message "); n != o.max {
		t.Fatalf("%d of 150 logged, want %d", n, o.max)
	}
	if !strings.Contains(got, "WARN core::session: Connection to server closed.") ||
		!strings.Contains(got, "(50 lines not logged in 10s)") || !strings.HasSuffix(got, "INFO librespot: later") {
		t.Fatalf("got\n%s", got)
	}
}

func TestLossLinesAreReported(t *testing.T) {
	var lost []string
	o, _ := testOutput(nil, newFakeClock(), func(l string) { lost = append(lost, l) })
	o.consume(strings.NewReader(strings.Join([]string{
		"[t WARN  librespot_core::session] Connection to server closed.",
		"[t ERROR librespot_core::session] Connection to server closed.",
		"[t WARN  librespot_core::dealer] Websocket peer does not respond.",
		"[t WARN  librespot] Spirc shut down unexpectedly",
		"[t INFO  librespot_connect::spirc] device became inactive",    // the user moved: no loss
		"[t DEBUG librespot_core::dealer] Websocket connection failed", // not at WARN
		"Connection to server closed.",                                 // not librespot's
	}, "\n")))
	if len(lost) != 4 {
		t.Fatalf("losses %q", lost)
	}
}

func TestPlayingFollowsTheEvents(t *testing.T) {
	defer librespotPlaying.Store(false)
	for _, c := range []struct {
		ev   string
		want bool
	}{{"playing", true}, {"volume_changed", true}, {"paused", false}, {"playing", true}, {"stopped", false},
		{"playing", true}, {"end_of_track", false}, {"playing", true}, {"unavailable", false}} {
		noteLibrespotEvent(map[string]string{"PLAYER_EVENT": c.ev})
		if librespotPlaying.Load() != c.want {
			t.Fatalf("after %s: %v", c.ev, !c.want)
		}
	}
}

func TestRestartDelay(t *testing.T) {
	for _, c := range []struct {
		prev, ran time.Duration
		soon      bool
		want      time.Duration
	}{
		{0, time.Second, false, 5 * time.Second},
		{5 * time.Second, time.Second, false, 10 * time.Second},
		{10 * time.Second, time.Second, false, 20 * time.Second},
		{20 * time.Second, time.Second, false, 20 * time.Second},
		{20 * time.Second, time.Hour, false, 5 * time.Second},
		{20 * time.Second, time.Second, true, time.Second},
	} {
		if got := librespotRestartDelay(c.prev, c.ran, c.soon); got != c.want {
			t.Errorf("%+v: %v", c, got)
		}
	}
}

// A librespot of the test's own: it writes on stdout and stderr, as does a
// child of it (gst-launch inherits both), and shows what it was given.
func TestRunLibrespotLogsBothStreamsWithoutTheToken(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "librespot")
	script := `#!/bin/sh
echo "[2026-10-31T13:42:49Z INFO  librespot] args: $*"
echo "[2026-10-31T13:42:49Z TRACE librespot] token from env: $LIBRESPOT_ACCESS_TOKEN" >&2
sh -c 'echo "Setting pipeline to PAUSED ..."; echo "child stderr" >&2'
echo "[2026-10-31T13:42:50Z WARN  librespot_core::session] Connection to server closed." >&2
exit 3
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sink := &logSink{}
	oldLogf, oldHeal, oldName := librespotLogf, librespotHeal, sess.librespotName
	librespotLogf = sink.logf
	clk := newFakeClock()
	f := &fakeConnect{listed: true}
	h := newTestHealer(t, f, clk, time.Hour)
	var lossMu sync.Mutex
	var losses []string
	h.sleep = func(ctx context.Context, d time.Duration) error {
		if d == h.lossDelay {
			lossMu.Lock()
			losses = append(losses, "loss")
			lossMu.Unlock()
		}
		return clk.sleep(ctx, d)
	}
	librespotHeal = h
	sess.librespotName = "webOS"
	t.Cleanup(func() { librespotLogf, librespotHeal, sess.librespotName = oldLogf, oldHeal, oldName })

	librespotPlaying.Store(true)
	resetT4State(t)
	librespotResume.loaded(t4Track, 1000)
	ran, err := runLibrespot(bin, shortToken)
	if ran < 0 || err == nil || !strings.Contains(err.Error(), "exit status 3") {
		t.Fatalf("ran %v, err %v", ran, err)
	}
	got := sink.all()
	for _, want := range []string{
		"librespot| INFO librespot: args: --name webOS",
		"librespot| TRACE librespot: token from env: " + redacted,
		"librespot| Setting pipeline to PAUSED ...",
		"librespot| child stderr",
		"librespot| WARN core::session: Connection to server closed.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("no %q in\n%s", want, got)
		}
	}
	if librespotPlaying.Load() {
		t.Fatal("still playing after its end")
	}
	if _, _, ok := librespotResume.pending(); !ok {
		t.Fatal("a new librespot taken to have the track")
	}
	if strings.Contains(got, shortToken) || strings.Contains(got, "--access-token") {
		t.Fatalf("token on the command line or in the log:\n%s", got)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		lossMu.Lock()
		n := len(losses)
		lossMu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d losses passed on", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pid, _ := currentLibrespot(); pid != 0 {
		t.Fatal("still current after its end")
	}
}
