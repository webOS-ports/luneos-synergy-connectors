package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeProvider is a MusicProvider with a canned stream URL per track id;
// "" plays through its own engine (as Spotify does), "fail" is an error.
type fakeProvider struct {
	id  string
	url map[string]string
}

func (f *fakeProvider) ID() string   { return f.id }
func (f *fakeProvider) Name() string { return strings.ToUpper(f.id) }
func (f *fakeProvider) Search(ctx context.Context, q string, limit int) ([]providerTrack, error) {
	return nil, nil
}
func (f *fakeProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "fail" {
		return "", errors.New("upstream said no")
	}
	return f.url[trackID], nil
}

// formatProvider also picks a URL by format, as YouTube does.
type formatProvider struct{ fakeProvider }

func (f *formatProvider) StreamURLFormat(ctx context.Context, trackID, format string) (string, error) {
	return "https://example.com/" + trackID + "." + format, nil
}

func withProviders(t *testing.T, ps ...MusicProvider) {
	t.Helper()
	providersMu.Lock()
	saved := providers
	providers = map[string]MusicProvider{}
	for _, p := range ps {
		providers[p.ID()] = p
	}
	providersMu.Unlock()
	t.Cleanup(func() {
		providersMu.Lock()
		providers = saved
		providersMu.Unlock()
	})
}

func resolve(t *testing.T, provider, body string) (int, map[string]string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/provider/"+provider+"/resolve", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handleProviderRoute(rec, req)
	out := map[string]string{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestResolveReturnsTheStreamURL(t *testing.T) {
	withProviders(t, &fakeProvider{id: "tidal", url: map[string]string{"42": "http://127.0.0.1:8730/tidalstream?id=42"}})
	code, out := resolve(t, "tidal", `{"trackId":"42"}`)
	if code != http.StatusOK || out["url"] != "http://127.0.0.1:8730/tidalstream?id=42" {
		t.Fatalf("got %d %v", code, out)
	}
}

func TestResolveDoesNotStartTheDaemonsOwnPlayback(t *testing.T) {
	withProviders(t, &fakeProvider{id: "jamendo", url: map[string]string{"7": "https://example.com/7.mp3"}})
	setStreamContext(nil, "")
	if code, _ := resolve(t, "jamendo", `{"trackId":"7"}`); code != http.StatusOK {
		t.Fatalf("got %d", code)
	}
	// /play records the track for /stream/switchformat; resolve must not.
	if p, id := streamContext(); p != nil || id != "" {
		t.Fatalf("resolve touched the stream context: %v %q", p, id)
	}
}

func TestResolveWithFormat(t *testing.T) {
	withProviders(t, &formatProvider{fakeProvider{id: "youtube"}})
	code, out := resolve(t, "youtube", `{"trackId":"abc","format":"opus"}`)
	if code != http.StatusOK || out["url"] != "https://example.com/abc.opus" {
		t.Fatalf("got %d %v", code, out)
	}
}

func TestResolveOwnEngineIsConflict(t *testing.T) {
	withProviders(t, &fakeProvider{id: "spotify", url: map[string]string{}})
	if code, out := resolve(t, "spotify", `{"trackId":"x"}`); code != http.StatusConflict || out["error"] == "" {
		t.Fatalf("got %d %v", code, out)
	}
}

func TestResolveErrors(t *testing.T) {
	withProviders(t, &fakeProvider{id: "deezer", url: map[string]string{}})
	if code, _ := resolve(t, "deezer", `{"trackId":"fail"}`); code != http.StatusBadGateway {
		t.Fatalf("upstream error: got %d", code)
	}
	if code, _ := resolve(t, "deezer", `{}`); code != http.StatusBadRequest {
		t.Fatalf("no track id: got %d", code)
	}
	if code, _ := resolve(t, "nosuch", `{"trackId":"1"}`); code != http.StatusNotFound {
		t.Fatalf("unknown provider: got %d", code)
	}
}
