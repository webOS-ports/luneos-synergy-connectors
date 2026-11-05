package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeInnerTube stands in for www.youtube.com: "/" is the visitor bootstrap page, and
// /youtubei/v1/player answers per clientName with whatever the test put in reply.
type fakeInnerTube struct {
	mu      sync.Mutex
	clients []string                 // clientName of every player request, in order
	bodies  []map[string]interface{} // their decoded bodies
	headers []http.Header
	// reply, keyed on clientName: an HTTP status (int) or a player response (string).
	reply map[string]interface{}
}

func (f *fakeInnerTube) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" {
		fmt.Fprint(w, `<script>ytcfg.set({"visitorData": "VD-FAKE"})</script>`)
		return
	}
	if r.URL.Path != "/youtubei/v1/player" {
		http.NotFound(w, r)
		return
	}
	var body map[string]interface{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	name, _ := body["context"].(map[string]interface{})["client"].(map[string]interface{})["clientName"].(string)
	f.mu.Lock()
	f.clients = append(f.clients, name)
	f.bodies = append(f.bodies, body)
	f.headers = append(f.headers, r.Header.Clone())
	rep, ok := f.reply[name]
	f.mu.Unlock()
	switch v := rep.(type) {
	case int:
		w.WriteHeader(v)
	case string:
		fmt.Fprint(w, v)
	default:
		if !ok {
			w.WriteHeader(http.StatusBadRequest)
		}
	}
}

func (f *fakeInnerTube) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.clients...)
}

// withFakeYouTube points the resolver at an httptest InnerTube and resets the cached
// visitor session, restoring both afterwards. Signed-out (no OAuth token) throughout.
func withFakeYouTube(t *testing.T, it *fakeInnerTube) {
	t.Helper()
	srv := httptest.NewServer(it)
	t.Cleanup(srv.Close)
	old := itBaseURL
	itBaseURL = func(string) string { return srv.URL }
	resetVisitor := func() {
		ytVisMu.Lock()
		ytVisData, ytVisAt = "", time.Time{}
		ytVisMu.Unlock()
	}
	resetVisitor()
	ytTokMu.Lock()
	oldTok := ytTok
	ytTok = nil
	ytTokMu.Unlock()
	t.Cleanup(func() {
		itBaseURL = old
		resetVisitor()
		ytTokMu.Lock()
		ytTok = oldTok
		ytTokMu.Unlock()
	})
}

// playerOK is a playable player response whose formats point at gv.
func playerOK(muxed, adaptive map[int]string) string {
	list := func(m map[int]string) string {
		var parts []string
		for itag, u := range m {
			mime := "audio/mp4; codecs=\"mp4a.40.2\""
			switch itag {
			case 18, 22:
				mime = "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\""
			case 251, 250, 249:
				mime = "audio/webm; codecs=\"opus\""
			case 136, 137:
				mime = "video/mp4; codecs=\"avc1.4d401f\""
			}
			b, _ := json.Marshal(map[string]interface{}{"itag": itag, "url": u, "mimeType": mime})
			parts = append(parts, string(b))
		}
		return "[" + strings.Join(parts, ",") + "]"
	}
	return `{"playabilityStatus":{"status":"OK"},"streamingData":{"formats":` + list(muxed) +
		`,"adaptiveFormats":` + list(adaptive) + `}}`
}

func TestPlayerClientOrder(t *testing.T) {
	var got []string
	for _, c := range itPlayerClients {
		got = append(got, c.name)
	}
	want := []string{"VISIONOS", "ANDROID_VR", "TVHTML5_SIMPLY_EMBEDDED_PLAYER", "WEB_EMBEDDED_PLAYER", "ANDROID"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("client order %v, want %v", got, want)
	}
}

// The VISIONOS request carries exactly yt-dlp's context and headers.
func TestVisionOSContext(t *testing.T) {
	it := &fakeInnerTube{reply: map[string]interface{}{"VISIONOS": `{"playabilityStatus":{"status":"OK"}}`}}
	withFakeYouTube(t, it)
	if _, err := innertubePost(context.Background(), "www.youtube.com", "player", visionOSClient,
		map[string]interface{}{"videoId": "abc"}, "", "VD"); err != nil {
		t.Fatal(err)
	}
	if len(it.bodies) != 1 {
		t.Fatalf("%d requests", len(it.bodies))
	}
	client := it.bodies[0]["context"].(map[string]interface{})["client"].(map[string]interface{})
	want := map[string]interface{}{
		"clientName": "VISIONOS", "clientVersion": "1.02",
		"deviceMake": "Apple", "deviceModel": "RealityDevice17,1",
		"osName": "visionOS", "osVersion": "26.5.23O471",
		"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
		"hl":        "en", "gl": "US",
		"visitorData": "VD",
	}
	if !reflect.DeepEqual(client, want) {
		t.Errorf("context.client\n got %v\nwant %v", client, want)
	}
	if it.bodies[0]["videoId"] != "abc" {
		t.Errorf("videoId %v", it.bodies[0]["videoId"])
	}
	h := it.headers[0]
	for k, v := range map[string]string{
		"User-Agent":               want["userAgent"].(string),
		"X-Youtube-Client-Name":    "101",
		"X-Youtube-Client-Version": "1.02",
		"X-Goog-Visitor-Id":        "VD",
	} {
		if h.Get(k) != v {
			t.Errorf("%s: %q, want %q", k, h.Get(k), v)
		}
	}
	if h.Get("Authorization") != "" {
		t.Error("anonymous request carries Authorization")
	}
}

// VISIONOS answers: it is the only client asked, and its URL is what comes back.
func TestResolveVisionOSFirst(t *testing.T) {
	gv := httptest.NewServer(&googlevideo{size: 3 << 20})
	defer gv.Close()
	it := &fakeInnerTube{reply: map[string]interface{}{
		"VISIONOS":   playerOK(map[int]string{18: gv.URL + "/vis18"}, map[int]string{140: gv.URL + "/vis140"}),
		"ANDROID_VR": playerOK(map[int]string{18: gv.URL + "/vr18"}, map[int]string{140: gv.URL + "/vr140"}),
	}}
	withFakeYouTube(t, it)
	y := &youtubeProvider{}
	u, err := y.streamURL(context.Background(), "vid", "", "audio")
	if err != nil || u != gv.URL+"/vis140" {
		t.Fatalf("audio: %q, %v", u, err)
	}
	u, err = y.StreamURLVideo(context.Background(), "vid")
	if err != nil || u != gv.URL+"/vis18" {
		t.Fatalf("video: %q, %v", u, err)
	}
	if got := it.seen(); !reflect.DeepEqual(got, []string{"VISIONOS", "VISIONOS"}) {
		t.Fatalf("clients asked %v", got)
	}
}

// Each way a client can fail sends the resolver on to the next one, in order: an HTTP
// error, an unplayable video, a response with no streamingData, a URL googlevideo
// refuses, and a response without the wanted format.
func TestResolveFallsBackInOrder(t *testing.T) {
	gv := httptest.NewServer(&googlevideo{size: 3 << 20, expiredPath: "/refused", expiredFrom: 0})
	defer gv.Close()
	// Unplayable even though formats are listed: the status is what counts.
	unplayable := strings.Replace(playerOK(nil, map[int]string{140: gv.URL + "/unplayable140"}),
		`"status":"OK"`, `"status":"UNPLAYABLE","reason":"Video unavailable"`, 1)
	it := &fakeInnerTube{reply: map[string]interface{}{
		"VISIONOS":                       http.StatusForbidden,
		"ANDROID_VR":                     unplayable,
		"TVHTML5_SIMPLY_EMBEDDED_PLAYER": playerOK(map[int]string{18: gv.URL + "/refused"}, map[int]string{140: gv.URL + "/refused"}),
		"WEB_EMBEDDED_PLAYER":            `{"playabilityStatus":{"status":"OK"}}`,
		"ANDROID":                        playerOK(map[int]string{18: gv.URL + "/ok18"}, map[int]string{251: gv.URL + "/ok251"}),
	}}
	withFakeYouTube(t, it)
	y := &youtubeProvider{}
	u, err := y.streamURL(context.Background(), "vid", "", "audio")
	if err != nil || u != gv.URL+"/ok251" {
		t.Fatalf("audio: %q, %v", u, err)
	}
	want := []string{"VISIONOS", "ANDROID_VR", "TVHTML5_SIMPLY_EMBEDDED_PLAYER", "WEB_EMBEDDED_PLAYER", "ANDROID"}
	if got := it.seen(); !reflect.DeepEqual(got, want) {
		t.Fatalf("clients asked %v, want %v", got, want)
	}
}

// Video wants a muxed format: a client with only adaptive ones is passed over.
func TestResolveVideoSkipsClientWithoutMuxed(t *testing.T) {
	gv := httptest.NewServer(&googlevideo{size: 3 << 20})
	defer gv.Close()
	it := &fakeInnerTube{reply: map[string]interface{}{
		"VISIONOS":   playerOK(nil, map[int]string{136: gv.URL + "/v136", 140: gv.URL + "/a140"}),
		"ANDROID_VR": playerOK(map[int]string{18: gv.URL + "/vr18"}, nil),
	}}
	withFakeYouTube(t, it)
	u, err := (&youtubeProvider{}).StreamURLVideo(context.Background(), "vid")
	if err != nil || u != gv.URL+"/vr18" {
		t.Fatalf("video: %q, %v", u, err)
	}
	if got := it.seen(); !reflect.DeepEqual(got, []string{"VISIONOS", "ANDROID_VR"}) {
		t.Fatalf("clients asked %v", got)
	}
}

// Nothing works: every client is asked twice (the second pass after refreshing the
// visitor session) and the error names the last failure.
func TestResolveAllFail(t *testing.T) {
	it := &fakeInnerTube{reply: map[string]interface{}{}} // every client: http 400
	withFakeYouTube(t, it)
	_, err := (&youtubeProvider{}).streamURL(context.Background(), "vid", "", "audio")
	if err == nil || !strings.Contains(err.Error(), "ANDROID/player: http 400") {
		t.Fatalf("err %v", err)
	}
	if got := len(it.seen()); got != 2*len(itPlayerClients) {
		t.Fatalf("%d player requests, want %d", got, 2*len(itPlayerClients))
	}
}

func TestPickFormat(t *testing.T) {
	f := func(itag int, mime string) ytFormat {
		return ytFormat{Itag: itag, MimeType: mime, URL: fmt.Sprint("u", itag)}
	}
	st := ytStreamingData{
		Formats: []ytFormat{f(18, "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"")},
		AdaptiveFormats: []ytFormat{
			f(136, "video/mp4; codecs=\"avc1.4d401f\""),
			f(251, "audio/webm; codecs=\"opus\""),
			f(140, "audio/mp4; codecs=\"mp4a.40.2\""),
		},
	}
	cases := []struct {
		name       string
		st         ytStreamingData
		kind, pref string
		itag       int
		ok         bool
	}{
		{"audio prefers AAC 140", st, "audio", "", 140, true},
		{"format selector picks Opus", st, "audio", "OPUS 160", 251, true},
		{"unknown selector label falls back", st, "audio", "FLAC", 140, true},
		{"video takes muxed 18, not adaptive", st, "video", "", 18, true},
		{"video prefers 22", ytStreamingData{Formats: []ytFormat{f(18, ""), f(22, "")}}, "video", "", 22, true},
		{"video without muxed", ytStreamingData{AdaptiveFormats: st.AdaptiveFormats}, "video", "", 0, false},
		{"any audio as last resort", ytStreamingData{AdaptiveFormats: []ytFormat{f(600, "audio/webm; codecs=\"opus\"")}}, "audio", "", 600, true},
		{"ciphered counts", ytStreamingData{Formats: []ytFormat{{Itag: 18, SignatureCipher: "s=x"}}}, "video", "", 18, true},
		{"no url at all does not", ytStreamingData{Formats: []ytFormat{{Itag: 18}}}, "video", "", 0, false},
	}
	for _, c := range cases {
		got, ok := ytPickFormat(c.st, c.kind, c.pref)
		if ok != c.ok || got.Itag != c.itag {
			t.Errorf("%s: itag %d ok %v, want %d %v", c.name, got.Itag, ok, c.itag, c.ok)
		}
	}
}

// The format fields the resolver reads decode from a real-shaped response
// (contentLength is a string in InnerTube JSON).
func TestStreamingDataDecode(t *testing.T) {
	var st ytStreamingData
	err := json.Unmarshal([]byte(`{"formats":[{"itag":18,"url":"https://x/18","mimeType":"video/mp4","height":360,"contentLength":"1234"}],
		"adaptiveFormats":[{"itag":140,"signatureCipher":"s=a&url=b"}],"hlsManifestUrl":"https://x/h.m3u8"}`), &st)
	if err != nil {
		t.Fatal(err)
	}
	if f := ytFindItag(st, 18); f == nil || f.ContentLength != 1234 || f.Height != 360 {
		t.Errorf("itag 18: %+v", f)
	}
	if f := ytFindItag(st, 140); f == nil || f.SignatureCipher == "" {
		t.Errorf("itag 140: %+v", f)
	}
	if ytFindItag(st, 22) != nil || st.HlsManifestURL == "" {
		t.Errorf("%+v", st)
	}
}
