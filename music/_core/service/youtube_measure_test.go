package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestYouTubeMeasureClients asks the real InnerTube player endpoint, with each client,
// about a few public videos and records what comes back and which reads googlevideo
// serves. It talks to YouTube, so it only runs when YT_MEASURE names the markdown file
// to write the results to:
//
//	YT_MEASURE=$HOME/claude-scratch/youtube/measurements.md go test -run TestYouTubeMeasureClients -v
//
// Requests are spaced out (ytMeasurePause) to keep the rate modest.
func TestYouTubeMeasureClients(t *testing.T) {
	out := os.Getenv("YT_MEASURE")
	if out == "" {
		t.Skip("set YT_MEASURE=<file.md> to measure the InnerTube clients against YouTube")
	}
	videos := []struct{ id, what string }{
		{"dQw4w9WgXcQ", "music video (Rick Astley, 3:33)"},
		{"UF8uR6Z6KLc", "talk > 10 min (Steve Jobs, Stanford 2005, 15:04)"},
		{"jfKfPfyJRdk", "live stream (lofi girl, 24/7)"},
	}
	// YT_MEASURE_IDS="id:what,id:what" measures those instead, with only the clients
	// in YT_MEASURE_CLIENTS (comma-separated clientNames) when that is set.
	if ids := os.Getenv("YT_MEASURE_IDS"); ids != "" {
		videos = videos[:0]
		for _, e := range strings.Split(ids, ",") {
			id, what, _ := strings.Cut(e, ":")
			videos = append(videos, struct{ id, what string }{id, what})
		}
	}
	// The resolver's own list, plus NewPipeExtractor's flavour of VISIONOS
	// (ClientsConstants.java / getVisionOsUserAgent, dev 61e04a4) for comparison.
	newPipeVisionOS := itClient{
		name: "VISIONOS", version: "1.04", num: 101,
		userAgent: "com.google.visionos.youtube/1.04(RealityDevice17,1; U; CPU visionOS 26_6_0 like Mac OS X; US)",
		extra: map[string]interface{}{
			"deviceMake": "Apple", "deviceModel": "RealityDevice17,1",
			"osName": "visionOS", "osVersion": "26.6.0.23O770",
		},
	}
	clients := append(append([]itClient{}, itPlayerClients[:1]...), newPipeVisionOS)
	clients = append(clients, itPlayerClients[1:]...)
	if only := os.Getenv("YT_MEASURE_CLIENTS"); only != "" {
		var keep []itClient
		for _, c := range clients {
			if strings.Contains(","+only+",", ","+c.name+" "+c.version+",") || strings.Contains(","+only+",", ","+c.name+",") {
				keep = append(keep, c)
			}
		}
		clients = keep
	}
	ctx := context.Background()
	vd := ytVisitorData(ctx, false)
	var b strings.Builder
	fmt.Fprintf(&b, "# InnerTube player clients, measured %s from this host\n\n", time.Now().UTC().Format(time.RFC3339))
	fmt.Fprintf(&b, "visitorData: %v. Reads: `r1` = Range bytes=0-1048575, `r6` = Range bytes=6291456-6356991 (64 KiB past 6 MiB), "+
		"`r12` = one Range bytes=0-12582911 read to the end, `get` = plain GET (no Range) reading 12 MiB. "+
		"`ok` means the status was 206/200 and every byte asked for arrived.\n\n", vd != "")
	for _, v := range videos {
		fmt.Fprintf(&b, "## %s `%s`\n\n", v.what, v.id)
		for _, cl := range clients {
			ytMeasurePause()
			fmt.Fprintf(&b, "### %s %s\n\n", cl.name, cl.version)
			res, err := innertubePost(ctx, "www.youtube.com", "player", cl, map[string]interface{}{
				"videoId": v.id, "contentCheckOk": true, "racyCheckOk": true,
			}, "", vd)
			if err != nil {
				fmt.Fprintf(&b, "- request: %s\n\n", ytMeasureShort(err.Error()))
				continue
			}
			var ps struct{ Status, Reason string }
			_ = json.Unmarshal(res["playabilityStatus"], &ps)
			fmt.Fprintf(&b, "- playabilityStatus: %s %s\n", ps.Status, ps.Reason)
			sd, ok := res["streamingData"]
			if !ok {
				fmt.Fprintf(&b, "- no streamingData\n\n")
				continue
			}
			var st ytStreamingData
			if err := json.Unmarshal(sd, &st); err != nil {
				fmt.Fprintf(&b, "- streamingData: %v\n\n", err)
				continue
			}
			fmt.Fprintf(&b, "- muxed formats: %s\n", ytMeasureList(st.Formats))
			fmt.Fprintf(&b, "- adaptive avc1 video: %s\n", ytMeasureList(ytMeasureFilter(st.AdaptiveFormats, "avc1")))
			fmt.Fprintf(&b, "- adaptive audio: %s\n", ytMeasureList(ytMeasureFilter(st.AdaptiveFormats, "audio/")))
			fmt.Fprintf(&b, "- other adaptive: %d; hlsManifestUrl: %v; dashManifestUrl: %v; serverAbrStreamingUrl (SABR): %v\n",
				len(st.AdaptiveFormats)-len(ytMeasureFilter(st.AdaptiveFormats, "avc1"))-len(ytMeasureFilter(st.AdaptiveFormats, "audio/")),
				st.HlsManifestURL != "", st.DashManifestURL != "", st.ServerAbrStreamingURL != "")
			ciphered, nParam := 0, 0
			for _, f := range append(append([]ytFormat{}, st.Formats...), st.AdaptiveFormats...) {
				if f.URL == "" && f.SignatureCipher != "" {
					ciphered++
				}
				if strings.Contains(f.URL, "&n=") {
					nParam++
				}
			}
			fmt.Fprintf(&b, "- signatureCipher (needs deciphering): %d formats; direct URLs carrying an n= parameter: %d\n", ciphered, nParam)
			for _, itag := range []int{18, 22, 140, 251} {
				if f := ytFindItag(st, itag); f != nil && f.URL != "" {
					fmt.Fprintf(&b, "- itag %d (%d bytes): %s\n", itag, f.ContentLength, ytMeasureReads(ctx, f.URL))
				}
			}
			if f := ytBestAvc(st.AdaptiveFormats, 720); f != nil && f.URL != "" {
				fmt.Fprintf(&b, "- itag %d %s %dp (%d bytes): %s\n", f.Itag, f.MimeType, f.Height, f.ContentLength, ytMeasureReads(ctx, f.URL))
			}
			if st.HlsManifestURL != "" {
				fmt.Fprintf(&b, "- HLS: %s\n", ytMeasureHLS(ctx, st.HlsManifestURL))
			}
			b.WriteString("\n")
		}
	}
	if err := os.WriteFile(out, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Log("\n" + b.String())
}

func ytMeasureAttr(line, key string) string {
	i := strings.Index(line, key+"=")
	if i < 0 {
		return ""
	}
	v := line[i+len(key)+1:]
	if strings.HasPrefix(v, "\"") {
		v = v[1:]
		if j := strings.IndexByte(v, '"'); j >= 0 {
			return v[:j]
		}
		return v
	}
	if j := strings.IndexByte(v, ','); j >= 0 {
		v = v[:j]
	}
	return v
}

func ytMeasurePause() { time.Sleep(1500 * time.Millisecond) }

func ytMeasureShort(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}

func ytMeasureFilter(fs []ytFormat, sub string) []ytFormat {
	var out []ytFormat
	for _, f := range fs {
		if strings.Contains(f.MimeType, sub) {
			out = append(out, f)
		}
	}
	return out
}

func ytMeasureList(fs []ytFormat) string {
	if len(fs) == 0 {
		return "none"
	}
	var parts []string
	for _, f := range fs {
		mime, _, _ := strings.Cut(f.MimeType, ";")
		s := fmt.Sprintf("%d %s", f.Itag, mime)
		if f.Height > 0 {
			s += fmt.Sprintf(" %dp", f.Height)
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, ", ")
}

func ytBestAvc(fs []ytFormat, maxH int) *ytFormat {
	var best *ytFormat
	for i := range fs {
		f := &fs[i]
		if strings.Contains(f.MimeType, "avc1") && f.Height <= maxH && (best == nil || f.Height > best.Height) {
			best = f
		}
	}
	return best
}

// ytMeasureReads tries the four read shapes against a googlevideo URL.
func ytMeasureReads(ctx context.Context, u string) string {
	var parts []string
	try := func(name, rng string, want int64) {
		ytMeasurePause()
		cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(cctx, http.MethodGet, u, nil)
		req.Header.Set("User-Agent", ytStreamUA)
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		resp, err := ytStreamHTTP.Do(req)
		if err != nil {
			parts = append(parts, name+" "+ytMeasureShort(err.Error()))
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 && resp.StatusCode != 206 {
			parts = append(parts, fmt.Sprintf("%s %d", name, resp.StatusCode))
			return
		}
		n, err := io.Copy(io.Discard, io.LimitReader(resp.Body, want))
		if n == want || (err == nil && resp.ContentLength >= 0 && n == resp.ContentLength) {
			parts = append(parts, fmt.Sprintf("%s ok(%d, %d B)", name, resp.StatusCode, n))
		} else {
			parts = append(parts, fmt.Sprintf("%s short(%d, %d of %d B, %v)", name, resp.StatusCode, n, want, err))
		}
	}
	try("r1", "bytes=0-1048575", 1<<20)
	try("r6", "bytes=6291456-6356991", 64<<10)
	try("r12", "bytes=0-12582911", 12<<20)
	try("get", "", 12<<20)
	return strings.Join(parts, "; ")
}

// ytMeasureHLS fetches the master playlist, its first variant and that variant's first
// segment.
func ytMeasureHLS(ctx context.Context, master string) string {
	get := func(u string) (int, string) {
		ytMeasurePause()
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(cctx, http.MethodGet, u, nil)
		req.Header.Set("User-Agent", ytStreamUA)
		resp, err := ytStreamHTTP.Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		return resp.StatusCode, string(body)
	}
	code, body := get(master)
	if code != 200 {
		return fmt.Sprintf("master %d", code)
	}
	var codecs []string
	variant, vdesc, vh := "", "", 0
	pending := ""
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "#EXT-X-STREAM-INF") {
			pending = l
			c := ytMeasureAttr(l, "CODECS")
			if r := ytMeasureAttr(l, "RESOLUTION"); r != "" {
				c += " " + r
			}
			codecs = append(codecs, c)
		} else if pending != "" && strings.HasPrefix(l, "http") {
			h := 0
			if r := ytMeasureAttr(pending, "RESOLUTION"); r != "" {
				_, hs, _ := strings.Cut(r, "x")
				fmt.Sscan(hs, &h)
			}
			if strings.Contains(ytMeasureAttr(pending, "CODECS"), "avc1") && h <= 720 && h > vh {
				variant, vh = l, h
				vdesc = ytMeasureAttr(pending, "CODECS") + " " + ytMeasureAttr(pending, "RESOLUTION")
			}
			pending = ""
		}
	}
	s := fmt.Sprintf("master 200, %d variants [%s]", len(codecs), strings.Join(codecs, "; "))
	if variant == "" {
		return s + "; no avc1 variant <= 720p"
	}
	code, body = get(variant)
	s += fmt.Sprintf("; avc1 variant %s: %d", vdesc, code)
	if code != 200 {
		return s
	}
	seg, segs, tags := "", 0, []string{}
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(l)
		for _, tag := range []string{"#EXT-X-MAP", "#EXT-X-PLAYLIST-TYPE", "#EXT-X-ENDLIST", "#EXT-X-TARGETDURATION", "#EXT-X-KEY"} {
			if strings.HasPrefix(l, tag) {
				t := l
				if len(t) > 60 {
					t = t[:60] + "…"
				}
				tags = append(tags, t)
			}
		}
		if strings.HasPrefix(l, "http") {
			segs++
			if seg == "" {
				seg = l
			}
		}
	}
	s += fmt.Sprintf(" (%d segments; %s)", segs, strings.Join(tags, ", "))
	if seg != "" {
		code, body = get(seg)
		kind := "?"
		switch {
		case len(body) > 0 && body[0] == 0x47:
			kind = "MPEG-TS"
		case len(body) > 8 && (body[4:8] == "ftyp" || body[4:8] == "styp" || body[4:8] == "moof" || body[4:8] == "sidx"):
			kind = "fMP4 (" + body[4:8] + ")"
		}
		s += fmt.Sprintf("; first segment %d (%d B, %s)", code, len(body), kind)
	}
	return s
}
