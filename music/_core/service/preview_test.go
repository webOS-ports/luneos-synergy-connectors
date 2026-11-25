package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// A Tidal account without a subscription gets 30 seconds of every track, though
// the service asks for FULL: the resolve says so, so Music can tell the listener
// instead of stopping after 30 seconds unexplained.

const tidalPreviewMPD = `<?xml version='1.0' encoding='UTF-8'?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ` +
	`type="static" mediaPresentationDuration="PT29.907S"><Period id="0"><AdaptationSet id="0" ` +
	`contentType="audio" mimeType="audio/mp4"><Representation id="FLAC,44100,16" codecs="flac">` +
	`<SegmentTemplate timescale="44100" initialization="https://cdn.example/init.mp4" ` +
	`media="https://cdn.example/$Number$.mp4" startNumber="1"><SegmentTimeline>` +
	`<S d="176128" r="6"/><S d="86016"/></SegmentTimeline></SegmentTemplate></Representation>` +
	`</AdaptationSet></Period></MPD>`

// tidalStandIn answers playbackinfopostpaywall as Tidal does: presentation is
// "PREVIEW" or "FULL", with the reason Tidal gives for a preview.
func tidalStandIn(t *testing.T, presentation, reason string) (*tidalDL, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/playbackinfopostpaywall") {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("authorization %q", r.Header.Get("Authorization"))
		}
		atomic.AddInt32(&calls, 1)
		body := `{"trackId":542289,"assetPresentation":"` + presentation + `","audioQuality":"LOSSLESS",` +
			`"manifestMimeType":"application/dash+xml","manifest":"` +
			base64.StdEncoding.EncodeToString([]byte(tidalPreviewMPD)) + `"`
		if reason != "" {
			body += `,"previewReason":"` + reason + `"`
		}
		_, _ = w.Write([]byte(body + "}"))
	}))
	t.Cleanup(srv.Close)
	old := tidalAPIBase
	tidalAPIBase = srv.URL
	t.Cleanup(func() { tidalAPIBase = old })
	return &tidalDL{tok: tidalToken{AccessToken: "tok", CountryCode: "NL"}, ok: true}, &calls
}

func TestTidalPreviewIsReported(t *testing.T) {
	dl, _ := tidalStandIn(t, "PREVIEW", "FULL_REQUIRES_SUBSCRIPTION")
	ctx, f := withFormatReport(context.Background())
	u, err := (&tidalProvider{dl: dl}).StreamURL(ctx, "542289")
	if err != nil {
		t.Fatal(err)
	}
	if u != "http://127.0.0.1:8730/tidalstream?id=542289" {
		t.Errorf("url %q", u)
	}
	if f.preview != tidalPreviewWhy("FULL_REQUIRES_SUBSCRIPTION") || !strings.Contains(f.preview, "no active subscription") {
		t.Errorf("preview %q", f.preview)
	}
}

func TestTidalFullTrackIsNoPreview(t *testing.T) {
	dl, _ := tidalStandIn(t, "FULL", "")
	ctx, f := withFormatReport(context.Background())
	if _, err := (&tidalProvider{dl: dl}).StreamURL(ctx, "542289"); err != nil {
		t.Fatal(err)
	}
	if f.preview != "" {
		t.Errorf("preview %q for a full track", f.preview)
	}
}

func TestTidalPreviewWhy(t *testing.T) {
	for reason, want := range map[string]string{
		"FULL_REQUIRES_SUBSCRIPTION": "Tidal plays 30-second previews: this Tidal account has no active subscription",
		"":                           "Tidal sent a 30-second preview of this track",
		"FULL_REQUIRES_PURCHASE":     "Tidal sent a 30-second preview of this track (FULL_REQUIRES_PURCHASE)",
	} {
		if got := tidalPreviewWhy(reason); got != want {
			t.Errorf("%q: %q, want %q", reason, got, want)
		}
	}
}

// The resolve asks Tidal once; /tidalstream then plays that same stream.
func TestTidalStreamIsAskedForOnce(t *testing.T) {
	dl, calls := tidalStandIn(t, "PREVIEW", "FULL_REQUIRES_SUBSCRIPTION")
	if _, err := (&tidalProvider{dl: dl}).StreamURL(context.Background(), "542289"); err != nil {
		t.Fatal(err)
	}
	spec, err := dl.cachedStreamSpec(context.Background(), "542289")
	if err != nil {
		t.Fatal(err)
	}
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Errorf("asked Tidal %d times", n)
	}
	// init and 8 segments, a preview
	if len(spec.URLs) != 9 || !spec.Preview || spec.PreviewReason != "FULL_REQUIRES_SUBSCRIPTION" {
		t.Errorf("spec %d urls, preview %v %q", len(spec.URLs), spec.Preview, spec.PreviewReason)
	}
	// another track is asked for anew
	if _, err := dl.cachedStreamSpec(context.Background(), "1781887"); err != nil {
		t.Fatal(err)
	}
	if n := atomic.LoadInt32(calls); n != 2 {
		t.Errorf("asked Tidal %d times for two tracks", n)
	}
}

// Deezer without a sign-in plays its public previews, and says so.
func TestDeezerPreviewIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/track/3135556" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"id":3135556,"preview":"https://cdnt-preview.example/3135556.mp3"}`))
	}))
	defer srv.Close()
	old := deezerAPIBase
	deezerAPIBase = srv.URL
	defer func() { deezerAPIBase = old }()
	ctx, f := withFormatReport(context.Background())
	u, err := (&deezerProvider{}).StreamURL(ctx, "3135556")
	if err != nil {
		t.Fatal(err)
	}
	if u != "https://cdnt-preview.example/3135556.mp3" || f.preview != deezerPreviewWhy {
		t.Errorf("url %q, preview %q", u, f.preview)
	}
}

// The resolve reply carries it; a full track's reply has no preview field.
type previewProvider struct{ fakeProvider }

func (p *previewProvider) StreamURL(ctx context.Context, id string) (string, error) {
	reportPreview(ctx, "only a bit")
	return p.fakeProvider.StreamURL(ctx, id)
}

func TestResolveSaysItIsAPreview(t *testing.T) {
	withProviders(t, &previewProvider{fakeProvider{id: "tidal", url: map[string]string{"42": "http://x/42"}}})
	code, out := resolve(t, "tidal", `{"trackId":"42"}`)
	if code != http.StatusOK || out["preview"] != "only a bit" || out["url"] != "http://x/42" {
		t.Fatalf("got %d %v", code, out)
	}
	withProviders(t, &fakeProvider{id: "jamendo", url: map[string]string{"7": "https://example.com/7.mp3"}})
	code, all := resolveRaw(t, "jamendo", `{"trackId":"7"}`)
	if _, has := all["preview"]; code != http.StatusOK || has {
		t.Fatalf("got %d %v", code, all)
	}
}
