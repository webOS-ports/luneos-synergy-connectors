package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeLunaSend is a luna-send command that runs script, a shell script standing
// in for luna-send; it is given luna-send's arguments, and writes them to args.
func fakeLunaSend(t *testing.T, script string) (string, func(...string) *exec.Cmd) {
	t.Helper()
	args := filepath.Join(t.TempDir(), "args")
	return args, func(a ...string) *exec.Cmd {
		full := append([]string{"-c", `printf '%s\n' "$@" > "$ARGS"; ` + script, "luna-send"}, a...)
		cmd := exec.Command("/bin/sh", full...)
		cmd.Env = append(os.Environ(), "ARGS="+args)
		return cmd
	}
}

func readArgs(t *testing.T, path string) []string {
	t.Helper()
	var b []byte
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end); time.Sleep(time.Millisecond) {
		b, _ = os.ReadFile(path)
		if len(b) > 0 {
			break
		}
	}
	return strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
}

func TestLunaSendSubscription(t *testing.T) {
	args, cmd := fakeLunaSend(t, `echo '{"returnValue":true,"subscribed":true}'; echo 'not json'; echo '[1]'; `+
		`echo '{"returnValue":true,"keyEvent":"pause"}'; exec cat`) // holds stdout open until its stdin closes
	sub, err := (&lunaSendBus{command: cmd}).subscribe(mcServiceURI+"registerMediaSession", map[string]interface{}{"mediaId": "m"})
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]interface{}{
		{"returnValue": true, "subscribed": true},
		{"returnValue": true, "keyEvent": "pause"},
	}
	for i, w := range want {
		select {
		case r := <-sub.replies():
			if !reflect.DeepEqual(r, w) {
				t.Errorf("reply %d: %v, want %v", i, r, w)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("reply %d never came", i)
		}
	}
	if got := readArgs(t, args); !reflect.DeepEqual(got, []string{"-i", "-a", serviceCallerID,
		mcServiceURI + "registerMediaSession", `{"mediaId":"m"}`}) {
		t.Errorf("luna-send %q", got)
	}
	// luna-send -i ends when its stdin closes
	start := time.Now()
	sub.cancel()
	sub.cancel()
	select {
	case _, open := <-sub.replies():
		if open {
			t.Fatal("a reply after the cancel")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not end the call")
	}
	if time.Since(start) > 900*time.Millisecond {
		t.Errorf("luna-send was killed, not let go: %v", time.Since(start))
	}
}

func TestLunaSendSubscriptionKilledWhenItHangsOn(t *testing.T) {
	_, cmd := fakeLunaSend(t, `echo '{"returnValue":true,"subscribed":true}'; exec sleep 30`)
	sub, err := (&lunaSendBus{command: cmd}).subscribe(busServerStatusURI, map[string]interface{}{})
	if err != nil {
		t.Fatal(err)
	}
	<-sub.replies()
	sub.cancel()
	select {
	case _, open := <-sub.replies():
		if open {
			t.Fatal("a reply after the cancel")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a luna-send that ignores its stdin outlived the cancel")
	}
}

func TestLunaSendSubscriptionEnds(t *testing.T) {
	_, cmd := fakeLunaSend(t, `echo '{"returnValue":false,"errorText":"Service does not exist"}'`)
	sub, err := (&lunaSendBus{command: cmd}).subscribe(busServerStatusURI, map[string]interface{}{})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for range sub.replies() {
		n++
	}
	if n != 1 {
		t.Errorf("%d replies before the end, want 1", n)
	}
}

func TestLunaSendOnce(t *testing.T) {
	args, cmd := fakeLunaSend(t, `echo '{"returnValue":true}'; echo '{"second":1}'`)
	r, err := lunaSendOnce(cmd, mcServiceURI+"setMediaPlayStatus", `{"mediaId":"m"}`)
	if err != nil || r["returnValue"] != true || len(r) != 1 {
		t.Fatalf("%v, %v", r, err)
	}
	if got := readArgs(t, args); !reflect.DeepEqual(got, []string{"-n", "1", "-a", serviceCallerID,
		mcServiceURI + "setMediaPlayStatus", `{"mediaId":"m"}`}) {
		t.Errorf("luna-send %q", got)
	}
	_, cmd = fakeLunaSend(t, `exit 3`)
	if _, err := lunaSendOnce(cmd, "luna://x/y", "{}"); err == nil {
		t.Error("a failing luna-send is no error")
	}
}

func TestLunaSendBusKeepsOrder(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "log")
	b := newLunaSendBus(func(a ...string) *exec.Cmd {
		cmd := exec.Command("/bin/sh", "-c", `printf '%s\n' "$1" >> "$LOG"; echo '{"returnValue":true}'`, "luna-send", a[len(a)-1])
		cmd.Env = append(os.Environ(), "LOG="+log)
		return cmd
	})
	for i := 0; i < 10; i++ {
		b.send(mcServiceURI+"setMediaPlayStatus", map[string]interface{}{"n": i})
	}
	var lines []string
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		data, _ := os.ReadFile(log)
		lines = strings.Fields(string(data))
		if len(lines) == 10 {
			break
		}
	}
	for i, l := range lines {
		if want := `{"n":` + string(rune('0'+i)) + `}`; l != want {
			t.Fatalf("call %d was %s, want %s", i, l, want)
		}
	}
	if len(lines) != 10 {
		t.Fatalf("%d calls, want 10", len(lines))
	}
}
