package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"regexp"
	"strings"
	"sync"
	"time"
)

// youtubeProvider: a free, no-DRM source. The device has no Python/yt-dlp, so we
// talk to YouTube's InnerTube API DIRECTLY from the Go backend (self-contained, no
// middleman) — search via the WEB client, and resolve a direct audio stream URL via
// mobile/VR clients that return UN-ciphered URLs (no signature descrambling needed).
// The URL is then played by the shared gst stream player (curl | decodebin), which
// decodes AAC (itag 140, ffdec_aac) or Opus (itag 251, opusdec) — both present on
// the device. This establishes the stream-URL connector pattern.
type youtubeProvider struct{}

func (y *youtubeProvider) ID() string   { return "youtube" }
func (y *youtubeProvider) Name() string { return "YouTube Music" }

const innertubeKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"

type itClient struct {
	name, version, userAgent string
	num                      int // X-Youtube-Client-Name (0 = omit)
	extra                    map[string]interface{}
}

// Player clients that return direct (un-ciphered) audio URLs to a server, tried in
// order until one yields a playable audio format. IOS is deliberately omitted — it
// now 400s with "Precondition check failed" (needs attestation we can't provide).
// ANDROID_VR is the most reliable; embedded players bypass many age/precondition
// gates.
var itPlayerClients = []itClient{
	androidVRClient,
	{name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", version: "2.0",
		extra: map[string]interface{}{"clientScreen": "EMBED"}},
	{name: "WEB_EMBEDDED_PLAYER", version: "1.20240723.01.00",
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
		extra:     map[string]interface{}{"clientScreen": "EMBED"}},
	{name: "ANDROID", version: "19.29.37",
		userAgent: "com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip",
		extra:     map[string]interface{}{"androidSdkVersion": 30}},
}

// Clients used WITH the user's OAuth token (Authorization: Bearer). The token is
// issued for the "YouTube on TV" client, so it MUST be paired with the TVHTML5
// client context (other clients 400). Authenticated requests clear the bot-check,
// so official music resolves. Tried before the anonymous clients when signed in.
var itAuthedClients = []itClient{
	// Mobile clients return UN-ciphered URLs; with the OAuth token they also clear
	// the bot-check. TVHTML5 is a fallback (clears the check but returns ciphered
	// URLs we can't yet descramble).
	androidVRClient,
	{name: "ANDROID", version: "19.29.37",
		userAgent: "com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip",
		extra:     map[string]interface{}{"androidSdkVersion": 30}},
	{name: "TVHTML5", version: "7.20240724.13.00"},
}

// androidVRClient is the Oculus Quest ("VR") InnerTube client. Its player responses
// carry DIRECT, un-ciphered, un-throttled audio URLs and — crucially — it clears the
// "sign in to confirm you're not a bot" gate on OFFICIAL music tracks (the ATV art
// tracks) with NOTHING but an anonymous visitor session (visitorData + visitor
// cookies). No OAuth, no PoToken, no signature descrambling. This is the whole reason
// YouTube Music playback works self-contained on-device. Client name number is 28.
var androidVRClient = itClient{
	name: "ANDROID_VR", version: "1.65.10", num: 28,
	userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
	extra: map[string]interface{}{
		"deviceMake": "Oculus", "deviceModel": "Quest 3",
		"androidSdkVersion": 32, "osName": "Android", "osVersion": "12L",
	},
}

// itHTTP carries a cookie jar so the anonymous visitor cookies YouTube sets on the
// bootstrap page GET (VISITOR_INFO1_LIVE / VISITOR_PRIVACY_METADATA / YSC / SOCS) ride
// along on the subsequent InnerTube POSTs — required, together with visitorData, to
// clear the bot-check for official music.
var itHTTP = func() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Timeout: 25 * time.Second, Jar: jar}
}()

// ---- anonymous visitor session (visitorData) ----
// yt-dlp's trick: GET a normal YouTube page (which Set-Cookies a visitor session and
// embeds a matching "visitorData" token in its ytcfg), then send BOTH on every player
// call. Cached and refreshed lazily; a stale token just re-bootstraps.
var (
	ytVisMu     sync.Mutex
	ytVisData   string
	ytVisAt     time.Time
	ytVisitorRe = regexp.MustCompile(`"visitorData":\s*"([^"]+)"`)
)

const ytVisitorTTL = 3 * time.Hour

// ytVisitorData returns a cached visitorData token, bootstrapping one if missing/stale.
// force=true discards the cache first (used after a LOGIN_REQUIRED to get a fresh one).
func ytVisitorData(ctx context.Context, force bool) string {
	ytVisMu.Lock()
	defer ytVisMu.Unlock()
	if !force && ytVisData != "" && time.Since(ytVisAt) < ytVisitorTTL {
		return ytVisData
	}
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://www.youtube.com/?bpctr=9999999999&has_verified=1", nil)
	if err != nil {
		return ytVisData
	}
	// A browser UA on the bootstrap page so the ytcfg (and its visitorData) is present.
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := itHTTP.Do(req)
	if err != nil {
		log.Printf("youtube visitor bootstrap: %v", err)
		return ytVisData
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if m := ytVisitorRe.FindSubmatch(body); m != nil {
		ytVisData = string(m[1])
		ytVisAt = time.Now()
		log.Printf("youtube visitor bootstrap: got visitorData (len %d)", len(ytVisData))
	} else {
		log.Printf("youtube visitor bootstrap: visitorData not found in page")
	}
	return ytVisData
}

// innertubePost issues an InnerTube v1 call and returns the raw top-level fields.
// If bearer != "" the request is authenticated as the signed-in YouTube account
// (Authorization: Bearer), which clears the "confirm you're not a bot" gate.
func innertubePost(ctx context.Context, host, endpoint string, cl itClient, body map[string]interface{}, bearer, visitorData string) (map[string]json.RawMessage, error) {
	client := map[string]interface{}{
		"clientName": cl.name, "clientVersion": cl.version, "hl": "en", "gl": "US",
	}
	if visitorData != "" {
		client["visitorData"] = visitorData
	}
	for k, v := range cl.extra {
		client[k] = v
	}
	full := map[string]interface{}{"context": map[string]interface{}{"client": client}}
	for k, v := range body {
		full[k] = v
	}
	buf, _ := json.Marshal(full)
	// OAuth (bearer) requests must NOT carry the web API key — mixing them yields
	// http 400. Anonymous requests use the key.
	url := "https://" + host + "/youtubei/v1/" + endpoint + "?prettyPrint=false"
	if bearer == "" {
		url += "&key=" + innertubeKey
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if cl.userAgent != "" {
		req.Header.Set("User-Agent", cl.userAgent)
	}
	req.Header.Set("Origin", "https://"+host)
	if cl.num != 0 {
		req.Header.Set("X-Youtube-Client-Name", fmt.Sprintf("%d", cl.num))
		req.Header.Set("X-Youtube-Client-Version", cl.version)
	}
	if visitorData != "" {
		req.Header.Set("X-Goog-Visitor-Id", visitorData)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := itHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		snip, _ := io.ReadAll(io.LimitReader(resp.Body, 900))
		return nil, fmt.Errorf("innertube %s/%s: http %d: %s", cl.name, endpoint, resp.StatusCode, strings.TrimSpace(string(snip)))
	}
	var out map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// StreamURL resolves a direct audio URL for a videoId, preferring AAC (itag 140)
// then Opus (itag 251/250/249) — both decodable on-device.
func (y *youtubeProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	return y.streamURL(ctx, trackID, "", "audio")
}

// StreamURLFormat resolves preferring a specific format label (e.g. "OPUS 160") for the
// tap-to-switch selector; falls back to the default preference if that format isn't
// available. Implements the optional formatSelector capability (see provider.go).
func (y *youtubeProvider) StreamURLFormat(ctx context.Context, trackID, prefFormat string) (string, error) {
	return y.streamURL(ctx, trackID, prefFormat, "audio")
}

// StreamURLVideo resolves a direct PROGRESSIVE video URL for a videoId — a single
// muxed H.264+AAC file (itag 22 = 720p, falling back to itag 18 = 360p), as opposed to
// the split video-only/audio-only "adaptiveFormats" the audio path uses. These two
// legacy itags are what this device can actually play: the SoC's hardware decoder
// (OMX.qcom.video.decoder.avc) only does H.264, not VP9/AV1 (modern YouTube's default
// adaptive formats), and a single muxed file sidesteps having to mux/sync separate
// video+audio streams ourselves. Implements the optional videoResolver capability (see
// provider.go). Availability of itag 22 in particular is YouTube's choice and has grown
// intermittent across the ecosystem generally; itag 18 is the more durable fallback.
func (y *youtubeProvider) StreamURLVideo(ctx context.Context, trackID string) (string, error) {
	return y.streamURL(ctx, trackID, "", "video")
}

func (y *youtubeProvider) streamURL(ctx context.Context, trackID, prefFormat, kind string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	// Build the attempt list: anonymous clients FIRST — ANDROID_VR + a visitor session
	// resolves official music with no login, no cipher, no throttle. The OAuth clients
	// are only a fallback (and a stale TV-issued token otherwise just wastes attempts).
	type attempt struct {
		cl     itClient
		bearer string
	}
	var attempts []attempt
	for _, cl := range itPlayerClients {
		attempts = append(attempts, attempt{cl, ""})
	}
	token := ytAccessToken()
	if token != "" {
		for _, cl := range itAuthedClients {
			attempts = append(attempts, attempt{cl, token})
		}
	}
	// Anonymous visitor session — the key that clears the bot-check on official music
	// for ANDROID_VR. Fetched once, refreshed on demand if a call comes back LOGIN_REQUIRED.
	vd := ytVisitorData(ctx, false)
	log.Printf("youtube resolve %s: authed=%v visitor=%v (%d attempts)", trackID, token != "", vd != "", len(attempts))

	var lastErr error
	refreshedVD := false
	triedRefresh := false
resolve:
	for {
		for _, a := range attempts {
			cl := a.cl
		retry:
			res, err := innertubePost(ctx, "www.youtube.com", "player", cl, map[string]interface{}{
				"videoId": trackID, "contentCheckOk": true, "racyCheckOk": true,
			}, a.bearer, vd)
			if err != nil {
				log.Printf("youtube player %s(%s): %v", cl.name, trackID, err)
				lastErr = err
				continue
			}
			// playability gate
			if ps, ok := res["playabilityStatus"]; ok {
				var st struct {
					Status string `json:"status"`
					Reason string `json:"reason"`
				}
				_ = json.Unmarshal(ps, &st)
				if st.Status != "" && st.Status != "OK" {
					// A bot/login gate usually means our visitor token went stale — mint a
					// fresh one and retry this client ONCE before giving up on it.
					if !refreshedVD && (st.Status == "LOGIN_REQUIRED" || strings.Contains(st.Reason, "bot")) {
						refreshedVD = true
						vd = ytVisitorData(ctx, true)
						if vd != "" {
							log.Printf("youtube player %s(%s): %s → retrying with fresh visitorData", cl.name, trackID, st.Status)
							goto retry
						}
					}
					lastErr = fmt.Errorf("%s: %s %s", cl.name, st.Status, st.Reason)
					log.Printf("youtube player %s(%s): %v", cl.name, trackID, lastErr)
					continue
				}
			}
			sd, ok := res["streamingData"]
			if !ok {
				lastErr = fmt.Errorf("%s: no streamingData", cl.name)
				continue
			}
			var streaming struct {
				AdaptiveFormats []struct {
					Itag            int    `json:"itag"`
					URL             string `json:"url"`
					MimeType        string `json:"mimeType"`
					SignatureCipher string `json:"signatureCipher"`
				} `json:"adaptiveFormats"`
				// Formats: progressive (single muxed video+audio file) streams — itag
				// 18/22, H.264+AAC. Used only by the video path (kind=="video").
				Formats []struct {
					Itag            int    `json:"itag"`
					URL             string `json:"url"`
					MimeType        string `json:"mimeType"`
					SignatureCipher string `json:"signatureCipher"`
				} `json:"formats"`
				HlsManifestURL  string `json:"hlsManifestUrl"`
				DashManifestURL string `json:"dashManifestUrl"`
			}
			if json.Unmarshal(sd, &streaming) != nil {
				continue
			}
			log.Printf("youtube player %s(%s): formats=%d hls=%v dash=%v", cl.name, trackID,
				len(streaming.AdaptiveFormats), streaming.HlsManifestURL != "", streaming.DashManifestURL != "")
			// Pick the best format (AAC 140, then Opus tiers, then any audio -- or,
			// for video, progressive itag 22 then 18), taking either its direct URL
			// or its ciphered form.
			var directURL, cipher string
			var pickedItag int
			var pickedMime string
			pick := func(itag int) bool {
				list := streaming.AdaptiveFormats
				if kind == "video" {
					list = streaming.Formats
				}
				for i := range list {
					f := &list[i]
					match := itag > 0 && f.Itag == itag
					if itag == 0 {
						match = strings.HasPrefix(f.MimeType, "audio/")
					}
					if match {
						if f.URL != "" || f.SignatureCipher != "" {
							pickedItag, pickedMime = f.Itag, f.MimeType
						}
						if f.URL != "" {
							directURL = f.URL
							return true
						}
						if f.SignatureCipher != "" {
							cipher = f.SignatureCipher
							return true
						}
					}
				}
				return false
			}
			var order []int
			if kind == "video" {
				// Progressive muxed H.264+AAC only: 22 (720p) preferred, 18 (360p)
				// fallback -- both hardware-decodable on this device.
				order = []int{22, 18}
			} else {
				// Default preference AAC-then-Opus; if the user picked a format via
				// the selector, move the itags matching that label to the front.
				order = []int{140, 251, 250, 249, 0}
				if prefFormat != "" {
					var pref []int
					for _, it := range []int{139, 140, 141, 249, 250, 251, 256, 258} {
						if ytFmtLabel(it, "") == prefFormat {
							pref = append(pref, it)
						}
					}
					order = append(pref, order...)
				}
			}
			for _, want := range order {
				if pick(want) {
					break
				}
			}
			best := directURL
			if best == "" && cipher != "" { // TVHTML5 gives ciphered URLs -- descramble via base.js
				if u, derr := decipherSignatureCipher(ctx, cipher); derr == nil {
					best = u
					log.Printf("youtube player %s(%s): resolved via decipher", cl.name, trackID)
				} else {
					log.Printf("youtube player %s(%s): decipher failed: %v", cl.name, trackID, derr)
				}
			}
			if best != "" {
				// The player API can say playabilityStatus:OK yet hand back a googlevideo
				// CDN url that then 403s (bot-check / expired / throttled) -- the app plays
				// it, it fails instantly, and the track "skips". Verify the url is actually
				// served before returning it; if not, fall through to the next client.
				if ytProbePlayable(ctx, best) {
					if kind == "audio" {
						// Distinct audio-format labels available for this track -- for
						// the badge and the tap-to-switch selector. No equivalent UI for
						// video mode, so this is skipped there.
						var avail []string
						seenFmt := map[string]bool{}
						for i := range streaming.AdaptiveFormats {
							f := &streaming.AdaptiveFormats[i]
							if strings.HasPrefix(f.MimeType, "audio/") {
								if l := ytFmtLabel(f.Itag, f.MimeType); l != "" && !seenFmt[l] {
									seenFmt[l] = true
									avail = append(avail, l)
								}
							}
						}
						setNowPlaying(ytFmtLabel(pickedItag, pickedMime), avail)
					}
					log.Printf("youtube player %s(%s): resolved %s url (verified) [itag %d]", cl.name, trackID, kind, pickedItag)
					return best, nil
				}
				lastErr = fmt.Errorf("%s: resolved url failed playability probe", cl.name)
				log.Printf("youtube player %s(%s): %v", cl.name, trackID, lastErr)
				continue
			}
			lastErr = fmt.Errorf("%s: no direct %s url (ciphered?)", cl.name, kind)
			log.Printf("youtube player %s(%s): %v", cl.name, trackID, lastErr)
		}
		// AUTO-HEAL: a whole pass produced no *playable* url. Force-refresh the visitor
		// session + cipher transforms ONCE and retry — this recovers the stale state that
		// a process restart used to fix, without needing a restart.
		if !triedRefresh {
			triedRefresh = true
			log.Printf("youtube %s: no playable url this pass — refreshing visitorData+cipher and retrying", trackID)
			vd = ytVisitorData(ctx, true)
			resetCipherCache()
			continue resolve
		}
		break
	}
	return "", fmt.Errorf("youtube: could not resolve stream url: %v", lastErr)
}

// ytFmtLabel maps a YouTube audio itag / mimeType to a short quality badge string.
func ytFmtLabel(itag int, mime string) string {
	switch itag {
	case 139:
		return "AAC 48"
	case 140:
		return "AAC 128"
	case 141:
		return "AAC 256"
	case 249:
		return "OPUS 50"
	case 250:
		return "OPUS 70"
	case 251:
		return "OPUS 160"
	case 256, 258:
		return "AAC"
	}
	if strings.Contains(mime, "opus") || strings.Contains(mime, "webm") {
		return "OPUS"
	}
	if strings.Contains(mime, "mp4") || strings.Contains(mime, "aac") || strings.Contains(mime, "mp4a") {
		return "AAC"
	}
	return "AUDIO"
}

// ytProbePlayable does a tiny ranged GET to verify a resolved googlevideo URL is
// actually served (2xx) rather than a 403 bot-check / expired / throttled response the
// player API didn't surface. Cheap (one byte) and short-timeout so it can't stall track
// start for long. Returns true only on 200/206.
func ytProbePlayable(ctx context.Context, u string) bool {
	cctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, "GET", u, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Range", "bytes=0-1")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
	resp, err := itHTTP.Do(req)
	if err != nil {
		log.Printf("youtube probe: %v", err)
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 8))
	if resp.StatusCode == 200 || resp.StatusCode == 206 {
		return true
	}
	log.Printf("youtube probe: HTTP %d", resp.StatusCode)
	return false
}

// Search queries YouTube (WEB client, video filter) and returns normalised tracks.
func (y *youtubeProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	web := itClient{name: "WEB", version: "2.20240726.00.00", num: 1, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
	// Search is anonymous: the visitor session is enough. Never pass the OAuth token
	// here — it's issued for the TVHTML5 client and pairing it with WEB yields http 400
	// INVALID_ARGUMENT.
	res, err := innertubePost(ctx, "www.youtube.com", "search", web, map[string]interface{}{
		"query":  query,
		"params": "EgIQAQ%3D%3D", // filter: videos only
	}, "", ytVisitorData(ctx, false))
	if err != nil {
		return nil, err
	}
	tracks := parseYouTubeSearch(res, limit)
	return tracks, nil
}

// parseYouTubeSearch walks the WEB search response for videoRenderer items.
func parseYouTubeSearch(res map[string]json.RawMessage, limit int) []providerTrack {
	out := []providerTrack{}
	var top struct {
		Contents struct {
			TwoColumn struct {
				PrimaryContents struct {
					SectionList struct {
						Contents []struct {
							ItemSection struct {
								Contents []struct {
									Video *videoRenderer `json:"videoRenderer"`
								} `json:"contents"`
							} `json:"itemSectionRenderer"`
						} `json:"contents"`
					} `json:"sectionListRenderer"`
				} `json:"primaryContents"`
			} `json:"twoColumnSearchResultsRenderer"`
		} `json:"contents"`
	}
	if c, ok := res["contents"]; ok {
		_ = json.Unmarshal(c, &top.Contents)
	}
	for _, sec := range top.Contents.TwoColumn.PrimaryContents.SectionList.Contents {
		for _, it := range sec.ItemSection.Contents {
			if it.Video == nil || it.Video.VideoID == "" {
				continue
			}
			out = append(out, it.Video.toTrack())
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

type videoRenderer struct {
	VideoID string `json:"videoId"`
	Title   struct {
		Runs []struct {
			Text string `json:"text"`
		} `json:"runs"`
	} `json:"title"`
	OwnerText struct {
		Runs []struct {
			Text string `json:"text"`
		} `json:"runs"`
	} `json:"ownerText"`
	LengthText struct {
		SimpleText string `json:"simpleText"`
	} `json:"lengthText"`
	PublishedTimeText struct {
		SimpleText string `json:"simpleText"`
	} `json:"publishedTimeText"`
	Thumbnail struct {
		Thumbnails []struct {
			URL string `json:"url"`
		} `json:"thumbnails"`
	} `json:"thumbnail"`
}

func (v *videoRenderer) toTrack() providerTrack {
	title, artist := "", ""
	if len(v.Title.Runs) > 0 {
		title = v.Title.Runs[0].Text
	}
	if len(v.OwnerText.Runs) > 0 {
		artist = v.OwnerText.Runs[0].Text
	}
	thumb := ""
	if n := len(v.Thumbnail.Thumbnails); n > 0 {
		thumb = v.Thumbnail.Thumbnails[n-1].URL // largest
	}
	return providerTrack{
		ID: v.VideoID, Provider: "youtube", Title: title, Artist: artist,
		Thumbnail: thumb, DurationMs: parseClockMs(v.LengthText.SimpleText),
		Published: v.PublishedTimeText.SimpleText,
		Path:      "youtube:" + v.VideoID,
	}
}

// parseClockMs turns "3:45" / "1:02:03" into milliseconds.
func parseClockMs(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	parts := strings.Split(s, ":")
	sec := 0
	for _, p := range parts {
		n := 0
		for _, c := range p {
			if c < '0' || c > '9' {
				n = -1
				break
			}
			n = n*10 + int(c-'0')
		}
		if n < 0 {
			return 0
		}
		sec = sec*60 + n
	}
	return sec * 1000
}
