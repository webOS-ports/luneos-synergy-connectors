package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// YouTube authentication via Google's OAuth "device code" (TV / limited-input)
// flow. Google blocks its login inside embedded WebViews, so a Spotify-style
// in-app OAuth is impossible; instead the user authorises once on another device
// at youtube.com/activate. The resulting token authenticates InnerTube player
// requests and clears the "Sign in to confirm you're not a bot" gate.
//
// Uses the well-known public "YouTube on TV" limited-input OAuth client.
const (
	ytOAuthClientID     = "861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com"
	ytOAuthClientSecret = "SboVhoG9s0rNafixCSGGKXAT"
	ytOAuthScope        = "https://www.googleapis.com/auth/youtube"
	ytTokenFile         = spotifyDataDir + "/youtube-oauth.json"
)

type ytToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	Expiry       int64  `json:"expiry"` // unix seconds
}

var (
	ytTokMu     sync.RWMutex
	ytTok       *ytToken
	ytDeviceMu  sync.Mutex
	ytDevicePnd struct {
		deviceCode string
		interval   int
	}
)

func loadYtToken() {
	b, err := os.ReadFile(ytTokenFile)
	if err != nil {
		return
	}
	var t ytToken
	if json.Unmarshal(b, &t) == nil && (t.AccessToken != "" || t.RefreshToken != "") {
		ytTokMu.Lock()
		ytTok = &t
		ytTokMu.Unlock()
		log.Printf("youtube: loaded OAuth token (expires %v)", time.Unix(t.Expiry, 0))
	}
}

func saveYtToken(t *ytToken) {
	ytTokMu.Lock()
	ytTok = t
	ytTokMu.Unlock()
	if b, err := json.MarshalIndent(t, "", "  "); err == nil {
		_ = os.WriteFile(ytTokenFile, b, 0600)
	}
}

// ytAccessToken returns a valid access token, refreshing if near expiry, or "".
func ytAccessToken() string {
	ytTokMu.RLock()
	t := ytTok
	ytTokMu.RUnlock()
	if t == nil {
		return ""
	}
	if t.AccessToken != "" && time.Now().Unix() < t.Expiry-60 {
		return t.AccessToken
	}
	if t.RefreshToken == "" {
		return t.AccessToken // stale but all we have
	}
	if err := ytRefresh(t.RefreshToken); err != nil {
		log.Printf("youtube: token refresh failed: %v", err)
		return t.AccessToken
	}
	ytTokMu.RLock()
	defer ytTokMu.RUnlock()
	if ytTok != nil {
		return ytTok.AccessToken
	}
	return ""
}

func ytRefresh(refresh string) error {
	form := url.Values{
		"client_id":     {ytOAuthClientID},
		"client_secret": {ytOAuthClientSecret},
		"refresh_token": {refresh},
		"grant_type":    {"refresh_token"},
	}
	resp, err := itHTTP.PostForm("https://oauth2.googleapis.com/token", form)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var r struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&r)
	if r.AccessToken == "" {
		return fmt.Errorf("refresh: %s", r.Error)
	}
	saveYtToken(&ytToken{AccessToken: r.AccessToken, RefreshToken: refresh,
		Expiry: time.Now().Unix() + int64(r.ExpiresIn)})
	return nil
}

// ytStartDeviceAuth begins the device-code flow.
func ytStartDeviceAuth() (map[string]interface{}, error) {
	form := url.Values{"client_id": {ytOAuthClientID}, "scope": {ytOAuthScope}}
	resp, err := itHTTP.PostForm("https://oauth2.googleapis.com/device/code", form)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var r struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURL string `json:"verification_url"`
		Interval        int    `json:"interval"`
		ExpiresIn       int    `json:"expires_in"`
		Error           string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	if r.DeviceCode == "" {
		return nil, fmt.Errorf("device code: %s", r.Error)
	}
	ytDeviceMu.Lock()
	ytDevicePnd.deviceCode = r.DeviceCode
	ytDevicePnd.interval = r.Interval
	ytDeviceMu.Unlock()
	return map[string]interface{}{
		"user_code": r.UserCode, "verification_url": r.VerificationURL,
		"interval": r.Interval, "expires_in": r.ExpiresIn,
	}, nil
}

// ytPollDeviceAuth polls once; returns status "pending" | "ok" | "error".
func ytPollDeviceAuth() (string, error) {
	ytDeviceMu.Lock()
	dc := ytDevicePnd.deviceCode
	ytDeviceMu.Unlock()
	if dc == "" {
		return "error", fmt.Errorf("no pending auth; call /ytauth/start first")
	}
	form := url.Values{
		"client_id":     {ytOAuthClientID},
		"client_secret": {ytOAuthClientSecret},
		"device_code":   {dc},
		"grant_type":    {"urn:ietf:params:oauth:grant-type:device_code"},
	}
	resp, err := itHTTP.PostForm("https://oauth2.googleapis.com/token", form)
	if err != nil {
		return "pending", err
	}
	defer resp.Body.Close()
	var r struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&r)
	if r.AccessToken != "" {
		saveYtToken(&ytToken{AccessToken: r.AccessToken, RefreshToken: r.RefreshToken,
			Expiry: time.Now().Unix() + int64(r.ExpiresIn)})
		ytDeviceMu.Lock()
		ytDevicePnd.deviceCode = ""
		ytDeviceMu.Unlock()
		log.Printf("youtube: OAuth authorised")
		return "ok", nil
	}
	if strings.Contains(r.Error, "authorization_pending") || strings.Contains(r.Error, "slow_down") {
		return "pending", nil
	}
	return "error", fmt.Errorf("%s", r.Error)
}

// --- HTTP handlers ---

func handleYtAuthStart(w http.ResponseWriter, r *http.Request) {
	out, err := ytStartDeviceAuth()
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, out)
}

func handleYtAuthPoll(w http.ResponseWriter, r *http.Request) {
	status, err := ytPollDeviceAuth()
	out := map[string]interface{}{"status": status}
	if err != nil && status != "pending" {
		out["error"] = err.Error()
	}
	writeJSON(w, out)
}

func handleYtAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"authenticated": ytAccessToken() != ""})
}
