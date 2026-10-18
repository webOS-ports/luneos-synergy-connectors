package main

// qobuzDL — a DIRECT, first-party Qobuz lossless downloader (no middleman).
// The user's own Qobuz account is used; audio comes straight from Qobuz's CDN as
// DRM-free FLAC. Ported from Antra's direct qobuz adapter (antra/sources/qobuz.py).
//
// Endpoints (base https://www.qobuz.com/api.json/0.2):
//   GET user/login?email=&password=&app_id=            -> user_auth_token
//   GET track/search?query=<isrc>&limit=5              -> items[].id / .isrc
//   GET track/getFileUrl?format_id=&intent=stream&track_id=&request_ts=&request_sig=
//                                                       -> { "url": <flac cdn url> }
// app_id + app_secret are scraped from the open.qobuz.com web bundle (or supplied
// in the credential file). request_sig = md5("trackgetFileUrlformat_id"+fid+
//   "intentstream"+"track_id"+trackID+ts+app_secret).
//
// Credential file /media/cryptofs/spotify-webos/qobuz-auth (one value per line):
//   line 1: email
//   line 2: password
//   line 3: app_id      (optional — else scraped)
//   line 4: app_secret  (optional — else scraped)

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const qobuzBase = "https://www.qobuz.com/api.json/0.2"

type qobuzDL struct {
	email, password  string
	appID, appSecret string
	token            string // user_auth_token (obtained lazily)
	hc               *http.Client
}

func newQobuzDL() *qobuzDL {
	q := &qobuzDL{hc: &http.Client{Timeout: 30 * time.Second}}
	b, err := os.ReadFile(spotifyDataDir + "/qobuz-auth")
	if err != nil {
		return q
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	get := func(i int) string {
		if i < len(lines) {
			return strings.TrimSpace(lines[i])
		}
		return ""
	}
	q.email, q.password, q.appID, q.appSecret = get(0), get(1), get(2), get(3)
	return q
}

func (q *qobuzDL) ID() string   { return "qobuz" }
func (q *qobuzDL) Name() string { return "Qobuz" }

// Available: credential file with email + password present. Auth is lazy.
func (q *qobuzDL) Available() bool { return q.email != "" && q.password != "" }

// get performs a Qobuz API GET with the auth headers, decoding JSON into out.
func (q *qobuzDL) get(ctx context.Context, path string, params url.Values, out interface{}) error {
	u := qobuzBase + "/" + path + "?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	if q.appID != "" {
		req.Header.Set("X-App-Id", q.appID)
	}
	if q.token != "" {
		req.Header.Set("X-User-Auth-Token", q.token)
	}
	resp, err := q.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("qobuz %s: http %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// ensureAuth scrapes app_id/secret if needed, then logs in to get a token.
func (q *qobuzDL) ensureAuth(ctx context.Context) error {
	if q.token != "" {
		return nil
	}
	if q.appID == "" || q.appSecret == "" {
		if err := q.scrapeAppCreds(ctx); err != nil {
			return fmt.Errorf("qobuz app creds: %w", err)
		}
	}
	// user/login. Antra sends the password plaintext; some Qobuz clients send
	// md5(password). Try plaintext first, then md5 as a fallback.
	if err := q.login(ctx, q.password); err == nil {
		return nil
	}
	sum := md5.Sum([]byte(q.password))
	return q.login(ctx, hex.EncodeToString(sum[:]))
}

func (q *qobuzDL) login(ctx context.Context, pw string) error {
	var res struct {
		UserAuthToken string `json:"user_auth_token"`
	}
	v := url.Values{}
	v.Set("email", q.email)
	v.Set("password", pw)
	v.Set("app_id", q.appID)
	if err := q.get(ctx, "user/login", v, &res); err != nil {
		return err
	}
	if res.UserAuthToken == "" {
		return fmt.Errorf("qobuz login: no user_auth_token")
	}
	q.token = res.UserAuthToken
	return nil
}

var (
	qbBundleRe = regexp.MustCompile(`<script[^>]+src="([^"]+(?:/js/main\.js|/resources/[^"]+/js/[^"]+\.js))"`)
	qbCredsRe  = regexp.MustCompile(`app_id:"(\d{9})",app_secret:"([a-f0-9]{32})"`)
)

// scrapeAppCreds pulls app_id + app_secret from the open.qobuz.com web bundle.
func (q *qobuzDL) scrapeAppCreds(ctx context.Context) error {
	shell, err := q.fetch(ctx, "https://open.qobuz.com/track/1")
	if err != nil {
		return err
	}
	m := qbBundleRe.FindStringSubmatch(shell)
	if m == nil {
		return fmt.Errorf("bundle url not found")
	}
	bundleURL := m[1]
	if strings.HasPrefix(bundleURL, "/") {
		bundleURL = "https://open.qobuz.com" + bundleURL
	}
	bundle, err := q.fetch(ctx, bundleURL)
	if err != nil {
		return err
	}
	c := qbCredsRe.FindStringSubmatch(bundle)
	if c == nil {
		return fmt.Errorf("app_id/app_secret not found in bundle (supply them in /media/cryptofs/spotify-webos/qobuz-auth lines 3-4)")
	}
	q.appID, q.appSecret = c[1], c[2]
	return nil
}

func (q *qobuzDL) fetch(ctx context.Context, u string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := q.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

// Resolve: ISRC -> Qobuz track id via track/search, preferring an exact ISRC match.
func (q *qobuzDL) Resolve(ctx context.Context, isrc string) (string, error) {
	if err := q.ensureAuth(ctx); err != nil {
		return "", err
	}
	var res struct {
		Tracks struct {
			Items []struct {
				ID   json.Number `json:"id"`
				ISRC string      `json:"isrc"`
			} `json:"items"`
		} `json:"tracks"`
	}
	v := url.Values{}
	v.Set("query", isrc)
	v.Set("limit", "5")
	if err := q.get(ctx, "track/search", v, &res); err != nil {
		return "", err
	}
	items := res.Tracks.Items
	// Prefer an exact ISRC match; otherwise fall back to the first result.
	for _, it := range items {
		if strings.EqualFold(it.ISRC, isrc) {
			return it.ID.String(), nil
		}
	}
	if len(items) > 0 {
		return items[0].ID.String(), nil
	}
	return "", nil
}

// FileURL: track/getFileUrl signed request; try hi-res FLAC (27) then CD FLAC (6).
func (q *qobuzDL) FileURL(ctx context.Context, trackID string) (losslessFile, error) {
	if err := q.ensureAuth(ctx); err != nil {
		return losslessFile{}, err
	}
	for _, fid := range []string{"27", "6"} {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		// request_sig = md5("trackgetFileUrlformat_id"+fid+"intentstream"+"track_id"+trackID+ts+app_secret)
		raw := "trackgetFileUrlformat_id" + fid + "intentstream" + "track_id" + trackID + ts + q.appSecret
		sig := md5.Sum([]byte(raw))
		v := url.Values{}
		v.Set("request_ts", ts)
		v.Set("request_sig", hex.EncodeToString(sig[:]))
		v.Set("track_id", trackID)
		v.Set("format_id", fid)
		v.Set("intent", "stream")
		var res struct {
			URL string `json:"url"`
		}
		if err := q.get(ctx, "track/getFileUrl", v, &res); err != nil {
			continue
		}
		if res.URL != "" {
			return losslessFile{URL: res.URL, Format: "flac"}, nil
		}
	}
	return losslessFile{}, fmt.Errorf("qobuz: no FLAC url for track %s", trackID)
}
