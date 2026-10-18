package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// tidalDL downloads DRM-free FLAC from Tidal using the user's OWN OAuth session
// (the unofficial tidalapi device flow) — direct api.tidal.com, no mirror/relay.
//
// Credentials: /media/cryptofs/spotify-webos/tidal-token, a JSON blob captured from a tidalapi
// device login (see report). The access token is refreshed against
// auth.tidal.com on 401 and the new token persisted back to that file.
//
// client_id: the TIDAL WEB PLAYER client (public, no secret), authenticated via the
// PKCE authorization-code flow. This is the crucial detail: the device-code flow (any
// client) yields a token that returns 401/4005 "Asset is not ready" on every track,
// whereas a PKCE web token is stream-entitled and playbackinfo returns a real manifest.
// LOSSLESS comes back as a DASH MPD of fMP4/FLAC segments (see streamSpec/parseTidalDash).
const (
	tidalClientID     = "49YxDN9a2aFV6RTG"
	tidalClientSecret = "" // web PKCE client is public
	tidalRedirectURI  = "https://tidal.com/login/auth"
	tidalTokenFile    = spotifyDataDir + "/tidal-token"
	tidalAPIBase      = "https://api.tidal.com/v1"
	tidalAuthTokenURL = "https://auth.tidal.com/v1/oauth2/token"
)

// tidalToken mirrors /media/cryptofs/spotify-webos/tidal-token.
type tidalToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	CountryCode  string `json:"country_code"`
	UserID       int64  `json:"user_id"`
	Expiry       string `json:"expiry"` // RFC3339, optional
}

type tidalDL struct {
	mu  sync.Mutex
	tok tidalToken
	ok  bool
}

func newTidalDL() *tidalDL {
	t := &tidalDL{}
	b, err := os.ReadFile(tidalTokenFile)
	if err != nil {
		return t
	}
	if json.Unmarshal(b, &t.tok) == nil && t.tok.AccessToken != "" {
		t.ok = true
		if t.tok.CountryCode == "" {
			t.tok.CountryCode = "US"
		}
	}
	return t
}

func (t *tidalDL) ID() string      { return "tidal" }
func (t *tidalDL) Name() string    { return "Tidal" }
func (t *tidalDL) Available() bool { return t.ok }

// fetchUsername returns the account's Tidal username (or nickname/email/first name),
// so the created account is labelled with the real user rather than "Tidal". Best-effort.
func (t *tidalDL) fetchUsername(ctx context.Context) string {
	t.mu.Lock()
	uid := t.tok.UserID
	t.mu.Unlock()
	if uid == 0 {
		return ""
	}
	u := fmt.Sprintf("%s/users/%d?countryCode=%s", tidalAPIBase, uid, url.QueryEscape(t.countryCode()))
	body, err := t.authGet(ctx, u)
	if err != nil {
		return ""
	}
	var r struct {
		Username  string `json:"username"`
		Nickname  string `json:"nickname"`
		Email     string `json:"email"`
		FirstName string `json:"firstName"`
	}
	if json.Unmarshal(body, &r) != nil {
		return ""
	}
	for _, s := range []string{r.Username, r.Nickname, r.Email, r.FirstName} {
		if s != "" {
			return s
		}
	}
	return ""
}

func (t *tidalDL) countryCode() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tok.CountryCode != "" {
		return t.tok.CountryCode
	}
	return "US"
}

// refresh swaps the refresh_token for a new access_token and persists it.
func (t *tidalDL) refresh(ctx context.Context) error {
	t.mu.Lock()
	rt := t.tok.RefreshToken
	t.mu.Unlock()
	if rt == "" {
		return fmt.Errorf("tidal: no refresh_token to refresh with")
	}
	form := url.Values{}
	form.Set("client_id", tidalClientID)
	if tidalClientSecret != "" {
		form.Set("client_secret", tidalClientSecret)
	}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", rt)
	form.Set("scope", "r_usr w_usr")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tidalAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("tidal refresh http %d: %s", resp.StatusCode, tidalTrunc(string(body), 200))
	}
	var r struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		User        struct {
			CountryCode string `json:"countryCode"`
			UserID      int64  `json:"userId"`
		} `json:"user"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return err
	}
	if r.AccessToken == "" {
		return fmt.Errorf("tidal refresh: empty access_token")
	}
	t.mu.Lock()
	t.tok.AccessToken = r.AccessToken
	if r.ExpiresIn > 0 {
		t.tok.Expiry = time.Now().Add(time.Duration(r.ExpiresIn) * time.Second).Format(time.RFC3339)
	}
	if r.User.CountryCode != "" {
		t.tok.CountryCode = r.User.CountryCode
	}
	snapshot := t.tok
	t.mu.Unlock()
	if b, err := json.MarshalIndent(snapshot, "", "  "); err == nil {
		_ = os.WriteFile(tidalTokenFile, b, 0600) // best-effort persist
	}
	return nil
}

// authGet does a bearer GET, refreshing once on 401.
func (t *tidalDL) authGet(ctx context.Context, u string) ([]byte, error) {
	do := func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		t.mu.Lock()
		at := t.tok.AccessToken
		t.mu.Unlock()
		req.Header.Set("Authorization", "Bearer "+at)
		return http.DefaultClient.Do(req)
	}
	resp, err := do()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		resp.Body.Close()
		if rerr := t.refresh(ctx); rerr != nil {
			return nil, rerr
		}
		resp, err = do()
		if err != nil {
			return nil, err
		}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("tidal http %d: %s", resp.StatusCode, tidalTrunc(string(body), 200))
	}
	return body, nil
}

// Resolve maps an ISRC to a Tidal track id. The private user-token API has no
// first-class ISRC filter, but searching the ISRC string returns the matching
// recording (Tidal indexes ISRC); we validate the isrc field when present.
func (t *tidalDL) Resolve(ctx context.Context, isrc string) (string, error) {
	if isrc == "" {
		return "", fmt.Errorf("no isrc")
	}
	cc := t.countryCode()
	u := fmt.Sprintf("%s/search/tracks?query=%s&limit=10&offset=0&countryCode=%s",
		tidalAPIBase, url.QueryEscape(isrc), url.QueryEscape(cc))
	body, err := t.authGet(ctx, u)
	if err != nil {
		return "", err
	}
	var r struct {
		Items []struct {
			ID   json.Number `json:"id"`
			ISRC string      `json:"isrc"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return "", err
	}
	if len(r.Items) == 0 {
		return "", fmt.Errorf("tidal: no match for isrc %s", isrc)
	}
	up := strings.ToUpper(isrc)
	for _, it := range r.Items {
		if strings.ToUpper(it.ISRC) == up {
			return it.ID.String(), nil
		}
	}
	return r.Items[0].ID.String(), nil // best-effort fallback
}

// FileURL resolves a LOSSLESS FLAC download URL via playbackinfopostpaywall.
func (t *tidalDL) FileURL(ctx context.Context, trackID string) (losslessFile, error) {
	cc := t.countryCode()
	u := fmt.Sprintf("%s/tracks/%s/playbackinfopostpaywall?audioquality=LOSSLESS&playbackmode=STREAM&assetpresentation=FULL&countryCode=%s",
		tidalAPIBase, url.PathEscape(trackID), url.QueryEscape(cc))
	body, err := t.authGet(ctx, u)
	if err != nil {
		return losslessFile{}, err
	}
	var pb struct {
		ManifestMimeType string `json:"manifestMimeType"`
		Manifest         string `json:"manifest"` // base64
		AudioQuality     string `json:"audioQuality"`
	}
	if err := json.Unmarshal(body, &pb); err != nil {
		return losslessFile{}, err
	}
	raw, err := base64.StdEncoding.DecodeString(pb.Manifest)
	if err != nil {
		return losslessFile{}, fmt.Errorf("tidal: manifest base64: %v", err)
	}
	// LOSSLESS FLAC => BTS manifest (application/vnd.tidal.bts): JSON with urls[].
	if strings.Contains(pb.ManifestMimeType, "bts") || (len(raw) > 0 && raw[0] == '{') {
		var m struct {
			MimeType string   `json:"mimeType"`
			Codecs   string   `json:"codecs"`
			URLs     []string `json:"urls"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			return losslessFile{}, err
		}
		if len(m.URLs) == 0 {
			return losslessFile{}, fmt.Errorf("tidal: no urls in BTS manifest")
		}
		return losslessFile{URL: m.URLs[0], Format: "flac"}, nil
	}
	// Hi-Res (HI_RES_LOSSLESS) returns a DASH/MPD manifest with segmented media.
	// TODO: parse the MPD and reassemble segments. For now we request LOSSLESS
	// (single-URL BTS) above; surface a clear error if a DASH manifest appears.
	return losslessFile{}, fmt.Errorf("tidal: got DASH/hi-res manifest (%s); segment reassembly not implemented — LOSSLESS expected", pb.ManifestMimeType)
}

// tidalStreamSpec is the ordered list of URLs whose bodies, concatenated, form the
// track's playable audio: a DASH init segment followed by its numbered media segments
// (fMP4/FLAC), or a single BTS FLAC URL.
type tidalStreamSpec struct {
	URLs        []string
	ContentType string
	// MP4FLAC true = URLs are DASH fMP4/FLAC segments (init first) that must be
	// unwrapped into a native FLAC stream (gst-0.10 has no FLAC-in-MP4 decoder).
	MP4FLAC bool
}

var (
	reTidalInit  = regexp.MustCompile(`initialization="([^"]+)"`)
	reTidalMedia = regexp.MustCompile(`media="([^"]+)"`)
	reTidalStart = regexp.MustCompile(`startNumber="(\d+)"`)
	reTidalSegS  = regexp.MustCompile(`<S\b[^>]*/>`)
	reTidalSegR  = regexp.MustCompile(`r="(\d+)"`)
)

// streamSpec resolves a LOSSLESS playback manifest into the ordered segment URLs.
func (t *tidalDL) streamSpec(ctx context.Context, trackID string) (*tidalStreamSpec, error) {
	cc := t.countryCode()
	u := fmt.Sprintf("%s/tracks/%s/playbackinfopostpaywall?audioquality=LOSSLESS&playbackmode=STREAM&assetpresentation=FULL&countryCode=%s",
		tidalAPIBase, url.PathEscape(trackID), url.QueryEscape(cc))
	body, err := t.authGet(ctx, u)
	if err != nil {
		return nil, err
	}
	var pb struct {
		ManifestMimeType string `json:"manifestMimeType"`
		Manifest         string `json:"manifest"` // base64
	}
	if err := json.Unmarshal(body, &pb); err != nil {
		return nil, err
	}
	raw, err := base64.StdEncoding.DecodeString(pb.Manifest)
	if err != nil {
		return nil, fmt.Errorf("tidal: manifest base64: %v", err)
	}
	// BTS manifest (application/vnd.tidal.bts): JSON with a single-file urls[].
	if strings.Contains(pb.ManifestMimeType, "bts") || (len(raw) > 0 && raw[0] == '{') {
		var m struct {
			URLs []string `json:"urls"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, err
		}
		if len(m.URLs) == 0 {
			return nil, fmt.Errorf("tidal: no urls in BTS manifest")
		}
		return &tidalStreamSpec{URLs: m.URLs, ContentType: "audio/flac"}, nil
	}
	// DASH MPD: an init segment + numbered fMP4/FLAC media segments.
	if strings.Contains(pb.ManifestMimeType, "dash") || bytes.Contains(raw, []byte("<MPD")) {
		return parseTidalDash(string(raw))
	}
	return nil, fmt.Errorf("tidal: unsupported manifest %q", pb.ManifestMimeType)
}

func parseTidalDash(mpd string) (*tidalStreamSpec, error) {
	mm := reTidalMedia.FindStringSubmatch(mpd)
	if mm == nil {
		return nil, fmt.Errorf("tidal: no media template in MPD")
	}
	media := html.UnescapeString(mm[1])
	start := 1
	if s := reTidalStart.FindStringSubmatch(mpd); s != nil {
		start, _ = strconv.Atoi(s[1])
	}
	count := 0
	for _, seg := range reTidalSegS.FindAllString(mpd, -1) {
		rep := 0
		if r := reTidalSegR.FindStringSubmatch(seg); r != nil {
			rep, _ = strconv.Atoi(r[1])
		}
		count += 1 + rep
	}
	if count == 0 {
		count = 1
	}
	urls := make([]string, 0, count+1)
	if im := reTidalInit.FindStringSubmatch(mpd); im != nil {
		urls = append(urls, html.UnescapeString(im[1]))
	}
	for i := 0; i < count; i++ {
		urls = append(urls, strings.ReplaceAll(media, "$Number$", strconv.Itoa(start+i)))
	}
	return &tidalStreamSpec{URLs: urls, ContentType: "audio/flac", MP4FLAC: true}, nil
}

func tidalTrunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
