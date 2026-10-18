package main

// Deezer lossless downloader (DIRECT first-party, no mirror/relay).
//
// Auth is the user's own ARL cookie (/media/cryptofs/spotify-webos/deezer-arl). Flow:
//   1. deezer.getUserData (arl cookie)   -> CSRF api_token (checkForm) + license_token
//   2. api.deezer.com/track/isrc:<ISRC>  -> numeric track id
//   3. song.getData {SNG_ID}             -> TRACK_TOKEN
//   4. media.deezer.com/v1/get_url       -> encrypted CDN URL (BF_CBC_STRIPE)
// The stream is Deezer-scrambled; we return the per-track Blowfish key and the
// shared downloader (deezerDescramble in lossless.go) does the BF-CBC-STRIPE pass.
//
// NOTE: Antra's deezer.py uses the older MD5_ORIGIN/AES-ECB dzcdn URL scheme;
// that field is often absent now, so this ports the modern get_url path instead
// (deemix/deezer-py style). Same Blowfish key derivation, same stripe cipher.

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const deezerBFSecret = "g4el58wc0zvf9na1" // public constant used by every Deezer client

type deezerDL struct {
	arl string
	hc  *http.Client

	mu           sync.Mutex
	apiToken     string // checkForm CSRF token for gw-light calls
	licenseToken string // USER.OPTIONS.license_token for get_url
	authed       bool
}

func newDeezerDL() *deezerDL {
	arl := ""
	if b, err := os.ReadFile(spotifyDataDir + "/deezer-arl"); err == nil {
		arl = strings.TrimSpace(string(b))
	}
	jar, _ := cookiejar.New(nil)
	d := &deezerDL{arl: arl, hc: &http.Client{Jar: jar, Timeout: 25 * time.Second}}
	if arl != "" {
		// Set the ARL on .deezer.com so it rides on www + media subdomains; the
		// gw-light response then adds the `sid` session cookie automatically.
		u, _ := url.Parse("https://www.deezer.com")
		jar.SetCookies(u, []*http.Cookie{{Name: "arl", Value: arl, Domain: ".deezer.com", Path: "/"}})
	}
	return d
}

func (d *deezerDL) ID() string      { return "deezer" }
func (d *deezerDL) Name() string    { return "Deezer" }
func (d *deezerDL) Available() bool { return d.arl != "" }

// gwCall POSTs a gw-light API method with a JSON payload and returns results.
func (d *deezerDL) gwCall(ctx context.Context, method, apiToken string, payload interface{}) (map[string]interface{}, error) {
	q := url.Values{}
	q.Set("method", method)
	q.Set("api_version", "1.0")
	q.Set("api_token", apiToken)
	q.Set("input", "3")
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://www.deezer.com/ajax/gw-light.php?"+q.Encode(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := d.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Error   json.RawMessage        `json:"error"`
		Results map[string]interface{} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if e := strings.TrimSpace(string(out.Error)); e != "" && e != "[]" && e != "{}" && e != "null" {
		return nil, fmt.Errorf("deezer %s error: %s", method, e)
	}
	return out.Results, nil
}

// auth performs the one-time getUserData bootstrap.
func (d *deezerDL) auth(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.authed {
		return nil
	}
	res, err := d.gwCall(ctx, "deezer.getUserData", "", map[string]interface{}{})
	if err != nil {
		return err
	}
	d.apiToken = asString(res["checkForm"])
	user, _ := res["USER"].(map[string]interface{})
	if user == nil || asFloat(user["USER_ID"]) == 0 {
		return fmt.Errorf("deezer: invalid/expired ARL (no user)")
	}
	if opts, _ := user["OPTIONS"].(map[string]interface{}); opts != nil {
		d.licenseToken = asString(opts["license_token"])
	}
	if d.apiToken == "" || d.licenseToken == "" {
		return fmt.Errorf("deezer: missing api_token/license_token")
	}
	d.authed = true
	return nil
}

// Resolve maps an ISRC to a numeric Deezer track id via the public API.
func (d *deezerDL) Resolve(ctx context.Context, isrc string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.deezer.com/track/isrc:"+url.PathEscape(isrc), nil)
	if err != nil {
		return "", err
	}
	resp, err := d.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		ID    json.Number            `json:"id"`
		Error map[string]interface{} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if len(out.Error) > 0 || out.ID.String() == "" || out.ID.String() == "0" {
		return "", fmt.Errorf("deezer: no track for isrc %s", isrc)
	}
	return out.ID.String(), nil
}

// FileURL fetches the TRACK_TOKEN then requests an encrypted CDN URL, preferring FLAC.
func (d *deezerDL) FileURL(ctx context.Context, trackID string) (losslessFile, error) {
	if err := d.auth(ctx); err != nil {
		return losslessFile{}, err
	}
	// TRACK_TOKEN via song.getData (try results.TRACK_TOKEN then results.DATA.TRACK_TOKEN).
	res, err := d.gwCall(ctx, "song.getData", d.apiToken, map[string]interface{}{"SNG_ID": trackID})
	if err != nil {
		return losslessFile{}, err
	}
	token := asString(res["TRACK_TOKEN"])
	if token == "" {
		if data, _ := res["DATA"].(map[string]interface{}); data != nil {
			token = asString(data["TRACK_TOKEN"])
		}
	}
	if token == "" {
		return losslessFile{}, fmt.Errorf("deezer: no TRACK_TOKEN for %s", trackID)
	}

	getURLBody := map[string]interface{}{
		"license_token": d.licenseToken,
		"track_tokens":  []string{token},
		"media": []interface{}{
			map[string]interface{}{
				"type": "FULL",
				"formats": []interface{}{
					map[string]string{"cipher": "BF_CBC_STRIPE", "format": "FLAC"},
					map[string]string{"cipher": "BF_CBC_STRIPE", "format": "MP3_320"},
				},
			},
		},
	}
	body, _ := json.Marshal(getURLBody)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://media.deezer.com/v1/get_url", bytes.NewReader(body))
	if err != nil {
		return losslessFile{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.hc.Do(req)
	if err != nil {
		return losslessFile{}, err
	}
	defer resp.Body.Close()
	var gu struct {
		Data []struct {
			Media []struct {
				Format  string `json:"format"`
				Sources []struct {
					URL string `json:"url"`
				} `json:"sources"`
			} `json:"media"`
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&gu); err != nil {
		return losslessFile{}, err
	}
	if len(gu.Data) == 0 || len(gu.Data[0].Media) == 0 || len(gu.Data[0].Media[0].Sources) == 0 {
		msg := "no media"
		if len(gu.Data) > 0 && len(gu.Data[0].Errors) > 0 {
			msg = gu.Data[0].Errors[0].Message
		}
		return losslessFile{}, fmt.Errorf("deezer get_url: %s (Deezer HiFi/FLAC needs a Premium plan)", msg)
	}
	m := gu.Data[0].Media[0]
	format := "mp3"
	if strings.EqualFold(m.Format, "FLAC") {
		format = "flac"
	}
	return losslessFile{URL: m.Sources[0].URL, Format: format, DeezerKey: deezerBlowfishKey(trackID)}, nil
}

// deezerBlowfishKey derives the per-track Blowfish key:
//
//	md5 = hex(md5(decimal track id)); key[i] = md5[i] ^ md5[i+16] ^ SECRET[i]
//
// (ASCII of the hex chars, i in 0..15), matching every Deezer client.
func deezerBlowfishKey(trackID string) []byte {
	sum := md5.Sum([]byte(trackID))
	h := []byte(hex.EncodeToString(sum[:])) // 32 ASCII hex chars
	key := make([]byte, 16)
	for i := 0; i < 16; i++ {
		key[i] = h[i] ^ h[i+16] ^ deezerBFSecret[i]
	}
	return key
}

// deezerLoginGetArl logs in to Deezer with email + password (the web gw-light flow)
// and returns the account's ARL cookie + display name — so the user signs in normally
// instead of hand-copying a cookie. Best-effort: Deezer sometimes gates the web login
// behind a captcha; on failure the caller falls back to asking for the ARL directly.
func deezerLoginGetArl(ctx context.Context, email, password string) (arl, name string, err error) {
	jar, _ := cookiejar.New(nil)
	hc := &http.Client{Jar: jar, Timeout: 25 * time.Second}
	// gw-light call returning the raw `results` payload (getArl returns a bare string,
	// getUserData returns an object, so we decode per-call).
	gw := func(method, apiToken string, payload interface{}) (json.RawMessage, error) {
		q := url.Values{}
		q.Set("method", method)
		q.Set("api_version", "1.0")
		q.Set("api_token", apiToken)
		q.Set("input", "3")
		body, _ := json.Marshal(payload)
		req, e := http.NewRequestWithContext(ctx, http.MethodPost,
			"https://www.deezer.com/ajax/gw-light.php?"+q.Encode(), bytes.NewReader(body))
		if e != nil {
			return nil, e
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0")
		resp, e := hc.Do(req)
		if e != nil {
			return nil, e
		}
		defer resp.Body.Close()
		var out struct {
			Error   json.RawMessage `json:"error"`
			Results json.RawMessage `json:"results"`
		}
		if e := json.NewDecoder(resp.Body).Decode(&out); e != nil {
			return nil, e
		}
		if es := strings.TrimSpace(string(out.Error)); es != "" && es != "[]" && es != "{}" && es != "null" {
			return nil, fmt.Errorf("deezer %s: %s", method, es)
		}
		return out.Results, nil
	}
	// 1. bootstrap: obtain the login CSRF token + sid cookie.
	raw, err := gw("deezer.getUserData", "", map[string]interface{}{})
	if err != nil {
		return "", "", err
	}
	var ud1 map[string]interface{}
	_ = json.Unmarshal(raw, &ud1)
	token := asString(ud1["checkFormLogin"])
	if token == "" {
		return "", "", fmt.Errorf("deezer: no login token")
	}
	// 2. POST the login form.
	form := url.Values{}
	form.Set("type", "login")
	form.Set("mail", email)
	form.Set("password", password)
	form.Set("checkFormLogin", token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://www.deezer.com/ajax/action.php", strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := hc.Do(req)
	if err != nil {
		return "", "", err
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if strings.Contains(strings.ToLower(string(b)), "captcha") {
		return "", "", fmt.Errorf("Deezer wants a captcha for this login — paste your ARL instead")
	}
	// 3. confirm we're logged in, then pull the ARL.
	raw2, err := gw("deezer.getUserData", "", map[string]interface{}{})
	if err != nil {
		return "", "", err
	}
	var ud2 map[string]interface{}
	_ = json.Unmarshal(raw2, &ud2)
	user, _ := ud2["USER"].(map[string]interface{})
	if user == nil || asFloat(user["USER_ID"]) == 0 {
		return "", "", fmt.Errorf("Deezer login failed — check your email/password (or paste your ARL)")
	}
	name = asString(user["BLOG_NAME"])
	if name == "" {
		name = asString(user["FIRSTNAME"])
	}
	arlRaw, err := gw("user.getArl", asString(ud2["checkForm"]), map[string]interface{}{})
	if err != nil {
		return "", "", err
	}
	_ = json.Unmarshal(arlRaw, &arl) // user.getArl -> results is the bare ARL string
	arl = strings.Trim(arl, "\" \n\r\t")
	if arl == "" {
		return "", "", fmt.Errorf("Deezer: logged in but no ARL returned")
	}
	return arl, name, nil
}

func asString(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return fmt.Sprintf("%.0f", t)
	}
	return ""
}

func asFloat(v interface{}) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case json.Number:
		f, _ := t.Float64()
		return f
	case string:
		var f float64
		fmt.Sscanf(t, "%f", &f)
		return f
	}
	return 0
}
