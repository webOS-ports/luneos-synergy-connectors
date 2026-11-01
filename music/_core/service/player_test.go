package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// useHold puts a hold over a fake /proc in librespotHold's place.
func useHold(t *testing.T, librespot int) *fakeProc {
	t.Helper()
	p := newFakeProc(t)
	old := librespotHold
	librespotHold = p.hold(librespot)
	t.Cleanup(func() { librespotHold = old })
	return p
}

func pausePlayer(t *testing.T) (int, string) {
	t.Helper()
	sess.mu.Lock()
	sess.client = nil // no Web API: nothing in the tests reaches Spotify
	sess.mu.Unlock()
	w := httptest.NewRecorder()
	handlePlayerPause(w, httptest.NewRequest(http.MethodPost, "/player/pause", nil))
	return w.Code, strings.TrimSpace(w.Body.String())
}

func TestPlayerPauseHoldsWithoutTheWebAPI(t *testing.T) {
	p := useHold(t, 100)
	code, body := pausePlayer(t)
	if code != http.StatusOK || body != `{"held":true,"ok":true}` {
		t.Fatalf("%d %s", code, body)
	}
	if !librespotHold.holding() {
		t.Fatal("not held")
	}
	// the Music app's play lets it go
	w := httptest.NewRecorder()
	handlePlayerPlay(w, httptest.NewRequest(http.MethodPost, "/player/play", nil))
	if librespotHold.holding() || len(p.signals()) != 2 {
		t.Fatalf("play left it held: %v", p.signals())
	}
}

func TestPlayerPauseWithNothingToHold(t *testing.T) {
	useHold(t, 0)
	if code, _ := pausePlayer(t); code != http.StatusUnauthorized {
		t.Fatalf("%d, want 401 as before", code)
	}
}

func TestPlayerCallsAreTheMusicAppsHeartbeat(t *testing.T) {
	useHold(t, 0)
	st := newSessionTest(t)
	old := mediaSession
	mediaSession = st.s
	t.Cleanup(func() { mediaSession = old })

	for _, h := range []http.HandlerFunc{handlePlayerStatus, handlePlayerPlay, handlePlayerPause,
		handlePlayerNext, handlePlayerPrev, handlePlayerSeek, handlePlayerVolume} {
		st.s.appSeen = time.Time{}
		h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/player/x", strings.NewReader("{}")))
		st.pump(1)
		if st.s.appSeen.IsZero() {
			t.Errorf("a /player call did not count as the app's")
		}
	}
}
