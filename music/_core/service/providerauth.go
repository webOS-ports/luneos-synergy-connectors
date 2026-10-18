package main

// Credential setup for the first-party music services (Qobuz / Deezer / Tidal),
// driven by the Accounts "Add a Music account" flow. The musicauth validator posts
// the user's credentials here; on success we persist the service's cred file and
// HOT-REGISTER the provider so it appears in /providers without a service restart.
//
//   Tidal  -> device-code OAuth (mirrors ytauth.go), writes tidal-token
//   Qobuz  -> email + password  (app_id/secret auto-scraped), writes qobuz-auth
//   Deezer -> ARL cookie,                                      writes deezer-arl
//
// SoundCloud / Jamendo / Internet Archive need no credentials (the validator
// registers those accounts directly) so they have no endpoint here.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	qobuzAuthFile  = spotifyDataDir + "/qobuz-auth"
	deezerArlFile  = spotifyDataDir + "/deezer-arl"
	tidalAuthorize = "https://login.tidal.com/authorize"
	tidalScope     = "r_usr w_usr"
)

// refreshFirstPartyServices rebuilds the Qobuz/Tidal/Deezer adapters from their
// (freshly written) credential files and swaps them into the live provider registry
// and downloader list. Call AFTER a cred file is written and validated. It performs
// no network I/O itself, so it is safe to hold providersMu for its duration.
func refreshFirstPartyServices() {
	qz := newQobuzDL()
	td := newTidalDL()
	dz := newDeezerDL()

	providersMu.Lock()
	defer providersMu.Unlock()
	dzDL = dz
	tdDL = td // handle for the /tidalstream proxy
	// The Deezer provider is always present (public search + 30s preview); just
	// rebind it to the fresh adapter so full-track streaming picks up a new ARL.
	providers["deezer"] = &deezerProvider{dl: dz}
	if qz.Available() {
		providers["qobuz"] = &qobuzProvider{dl: qz}
	}
	if td.Available() {
		providers["tidal"] = &tidalProvider{dl: td}
	}
	if (&appleProvider{}).Available() {
		providers["apple"] = &appleProvider{}
	} else {
		delete(providers, "apple")
	}
	// Rebuild the lossless downloader list from the three first-party services.
	downloaders = downloaders[:0]
	for _, d := range []LosslessDownloader{qz, td, dz} {
		if d.Available() {
			downloaders = append(downloaders, d)
		}
	}
}

// --- Qobuz: email + password -------------------------------------------------

// POST /qobuzauth/login {email, password}
func handleQobuzAuthLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	email := strings.TrimSpace(body.Email)
	pw := strings.TrimSpace(body.Password)
	if email == "" || pw == "" {
		httpErr(w, http.StatusBadRequest, "email and password required")
		return
	}
	// Persist as (email\npassword); qobuzDL scrapes app_id/app_secret itself.
	if err := os.WriteFile(qobuzAuthFile, []byte(email+"\n"+pw+"\n"), 0600); err != nil {
		httpErr(w, http.StatusInternalServerError, "write cred: "+err.Error())
		return
	}
	// Validate by actually logging in; drop the cred file if it fails so we don't
	// leave a broken account that 502s on every search.
	q := newQobuzDL()
	if err := q.ensureAuth(r.Context()); err != nil {
		_ = os.Remove(qobuzAuthFile)
		httpErr(w, http.StatusBadGateway, "qobuz login failed: "+err.Error())
		return
	}
	refreshFirstPartyServices()
	writeJSON(w, map[string]interface{}{"ok": true, "username": email})
}

// --- Deezer: ARL cookie ------------------------------------------------------

// POST /dzauth/save {arl}
func handleDeezerAuthSave(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Arl string `json:"arl"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	arl := strings.TrimSpace(body.Arl)
	if arl == "" {
		httpErr(w, http.StatusBadRequest, "arl required")
		return
	}
	if err := os.WriteFile(deezerArlFile, []byte(arl), 0600); err != nil {
		httpErr(w, http.StatusInternalServerError, "write cred: "+err.Error())
		return
	}
	// Validate the ARL (getUserData); drop it on failure — Deezer still works as
	// public preview-only without one.
	d := newDeezerDL()
	if err := d.auth(r.Context()); err != nil {
		_ = os.Remove(deezerArlFile)
		httpErr(w, http.StatusBadGateway, "deezer ARL invalid: "+err.Error())
		return
	}
	refreshFirstPartyServices()
	writeJSON(w, map[string]interface{}{"ok": true, "username": "Deezer"})
}

// POST /dzauth/login {email, password} — sign in to Deezer and pull the ARL
// automatically (no cookie copying). Falls back to /dzauth/save on the client if
// Deezer blocks the login with a captcha.
func handleDeezerAuthLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	email := strings.TrimSpace(body.Email)
	pw := strings.TrimSpace(body.Password)
	if email == "" || pw == "" {
		httpErr(w, http.StatusBadRequest, "email and password required")
		return
	}
	arl, name, err := deezerLoginGetArl(r.Context(), email, pw)
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := os.WriteFile(deezerArlFile, []byte(arl), 0600); err != nil {
		httpErr(w, http.StatusInternalServerError, "write cred: "+err.Error())
		return
	}
	// Validate the pulled ARL end-to-end before registering.
	d := newDeezerDL()
	if err := d.auth(r.Context()); err != nil {
		_ = os.Remove(deezerArlFile)
		httpErr(w, http.StatusBadGateway, "deezer ARL invalid: "+err.Error())
		return
	}
	refreshFirstPartyServices()
	if name == "" {
		name = email
	}
	writeJSON(w, map[string]interface{}{"ok": true, "username": name})
}

// --- Tidal: PKCE authorization-code flow (web player client) -----------------
// The device-code flow yields a NON-streaming token (playbackinfo returns 4005); a
// PKCE web-player token is stream-entitled. The validator opens the authorize URL in
// a webview, captures the ?code= from the redirect to tidal.com/login/auth, and POSTs
// it to /tidalauth/exchange.

var (
	tidalPKCEMu       sync.Mutex
	tidalPKCEVerifier string
)

// tidalStartPKCE mints a PKCE verifier + challenge and returns the Tidal authorize URL.
func tidalStartPKCE() string {
	b := make([]byte, 48)
	_, _ = rand.Read(b)
	verifier := base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	tidalPKCEMu.Lock()
	tidalPKCEVerifier = verifier
	tidalPKCEMu.Unlock()
	v := url.Values{}
	v.Set("response_type", "code")
	v.Set("redirect_uri", tidalRedirectURI)
	v.Set("client_id", tidalClientID)
	v.Set("appMode", "WEB")
	v.Set("language", "en")
	v.Set("code_challenge", challenge)
	v.Set("code_challenge_method", "S256")
	v.Set("scope", tidalScope)
	return tidalAuthorize + "?" + v.Encode()
}

// tidalExchangePKCE swaps the redirect ?code for a token, persists it, registers the
// provider, and returns the Tidal username.
func tidalExchangePKCE(ctx context.Context, code string) (string, error) {
	tidalPKCEMu.Lock()
	ver := tidalPKCEVerifier
	tidalPKCEMu.Unlock()
	if ver == "" {
		return "", fmt.Errorf("no pending Tidal login; start again")
	}
	form := url.Values{}
	form.Set("client_id", tidalClientID)
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", tidalRedirectURI)
	form.Set("scope", tidalScope)
	form.Set("code_verifier", ver)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tidalAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("tidal token exchange http %d: %s", resp.StatusCode, tidalTrunc(string(b), 200))
	}
	var rr struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
		User         struct {
			CountryCode string `json:"countryCode"`
			UserID      int64  `json:"userId"`
		} `json:"user"`
	}
	if err := json.Unmarshal(b, &rr); err != nil {
		return "", err
	}
	if rr.AccessToken == "" {
		return "", fmt.Errorf("tidal: no access_token in exchange response")
	}
	tok := tidalToken{
		AccessToken:  rr.AccessToken,
		RefreshToken: rr.RefreshToken,
		TokenType:    rr.TokenType,
		CountryCode:  rr.User.CountryCode,
		UserID:       rr.User.UserID,
	}
	if rr.ExpiresIn > 0 {
		tok.Expiry = time.Now().Add(time.Duration(rr.ExpiresIn) * time.Second).Format(time.RFC3339)
	}
	if tok.CountryCode == "" {
		tok.CountryCode = "US"
	}
	bb, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(tidalTokenFile, bb, 0600); err != nil {
		return "", err
	}
	tidalPKCEMu.Lock()
	tidalPKCEVerifier = ""
	tidalPKCEMu.Unlock()
	refreshFirstPartyServices()
	return newTidalDL().fetchUsername(ctx), nil
}

func handleTidalAuthStart(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]interface{}{"authorize_url": tidalStartPKCE()})
}

// POST /tidalauth/exchange {code}
func handleTidalAuthExchange(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	code := strings.TrimSpace(body.Code)
	if code == "" {
		httpErr(w, http.StatusBadRequest, "code required")
		return
	}
	uname, err := tidalExchangePKCE(r.Context(), code)
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	out := map[string]interface{}{"ok": true}
	if uname != "" {
		out["username"] = uname
	}
	writeJSON(w, out)
}

func handleTidalAuthStatus(w http.ResponseWriter, r *http.Request) {
	providersMu.RLock()
	_, ok := providers["tidal"]
	providersMu.RUnlock()
	writeJSON(w, map[string]bool{"authenticated": ok})
}
