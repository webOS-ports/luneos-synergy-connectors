package main

// Apple Music connector — full-track playback via the web player's Widevine flow,
// ported from achunt2143/jukie (jukie-drm). Apple's web player serves Widevine-CENC
// (ctrp256 AAC) to non-Safari clients; we auth as that web player, do the Widevine
// license exchange with a user-supplied L3 device credential (device.wvd), download the
// encrypted fMP4 and decrypt it to a plain AAC/m4a that gst-0.10 can play.
//
// Needs two user-supplied secrets on device:
//   /media/internal/device.wvd              — a Widevine L3 CDM (client-id + RSA key)
//   /media/cryptofs/spotify-webos/apple-music-user-token  — the Music User Token (obtained via the
//                                             MusicKit login, /appleauth/login)
// The short-lived public web developer token is auto-fetched from music.apple.com.

import (
	"bytes"
	"context"
	"encoding/base64"
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

	widevine "github.com/iyear/gowidevine"
	wvpb "github.com/iyear/gowidevine/widevinepb"
	"google.golang.org/protobuf/proto"
)

const (
	appleWebPlaybackURL    = "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback"
	appleKeySystem         = "com.widevine.alpha"
	appleUserTokenFile     = spotifyDataDir + "/apple-music-user-token"
	appleWVDFile           = "/media/internal/device.wvd"
	appleWebTokenCacheFile = spotifyDataDir + "/apple-webtoken.json"
	appleBrowserUA         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

func appleMusicUserToken() string {
	b, err := os.ReadFile(appleUserTokenFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// ---------------------------------------------------------------------------
// Public web developer token — auto-fetched from music.apple.com (no login).
// ---------------------------------------------------------------------------

type appleWebToken struct {
	Token  string    `json:"token"`
	Expiry time.Time `json:"expiry"`
}

var (
	appleJWTRe    = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}`)
	appleBundleRe = regexp.MustCompile(`/assets/[A-Za-z0-9_./-]*index[A-Za-z0-9_.-]*\.js`)
	appleScriptRe = regexp.MustCompile(`<script[^>]+src="([^"]+\.js)"`)
	appleTokenPgs = []string{"https://music.apple.com/us/browse", "https://music.apple.com/"}
)

func appleHTTPGet(client *http.Client, u string) ([]byte, error) {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", appleBrowserUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/javascript,*/*")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d for %s", resp.StatusCode, u)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 12<<20))
}

func appleJWTPayload(tok string) map[string]interface{} {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var m map[string]interface{}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

func appleJWTExp(tok string) *time.Time {
	m := appleJWTPayload(tok)
	if m == nil {
		return nil
	}
	if e, ok := m["exp"].(float64); ok {
		t := time.Unix(int64(e), 0)
		return &t
	}
	return nil
}

func appleIsDevToken(tok string) bool {
	m := appleJWTPayload(tok)
	if m == nil {
		return false
	}
	_, hasOrigin := m["root_https_origin"]
	_, hasExp := m["exp"]
	return hasOrigin && hasExp
}

func appleFindToken(s string) string {
	if dec, err := url.QueryUnescape(s); err == nil && dec != s {
		s = s + "\n" + dec
	}
	var fallback string
	for _, m := range appleJWTRe.FindAllString(s, -1) {
		if appleIsDevToken(m) {
			return m
		}
		if fallback == "" && appleJWTExp(m) != nil {
			fallback = m
		}
	}
	return fallback
}

func appleBundleURLs(html string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" || seen[p] || !strings.HasSuffix(p, ".js") {
			return
		}
		seen[p] = true
		if strings.HasPrefix(p, "http") {
			out = append(out, p)
		} else if strings.HasPrefix(p, "/") {
			out = append(out, "https://music.apple.com"+p)
		}
	}
	for _, m := range appleBundleRe.FindAllString(html, -1) {
		add(m)
	}
	for _, m := range appleScriptRe.FindAllStringSubmatch(html, -1) {
		add(m[1])
	}
	if len(out) > 6 {
		out = out[:6]
	}
	return out
}

func appleFetchWebToken(client *http.Client) (appleWebToken, error) {
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	valid := func(tok string) (appleWebToken, bool) {
		if tok == "" {
			return appleWebToken{}, false
		}
		if exp := appleJWTExp(tok); exp != nil {
			return appleWebToken{Token: tok, Expiry: *exp}, true
		}
		return appleWebToken{}, false
	}
	var lastErr error
	for _, page := range appleTokenPgs {
		html, err := appleHTTPGet(client, page)
		if err != nil {
			lastErr = err
			continue
		}
		if t, ok := valid(appleFindToken(string(html))); ok {
			return t, nil
		}
		for _, u := range appleBundleURLs(string(html)) {
			js, err := appleHTTPGet(client, u)
			if err != nil {
				continue
			}
			if t, ok := valid(appleFindToken(string(js))); ok {
				return t, nil
			}
		}
	}
	if lastErr != nil {
		return appleWebToken{}, fmt.Errorf("fetch music.apple.com: %w", lastErr)
	}
	return appleWebToken{}, fmt.Errorf("no usable developer token on music.apple.com")
}

// appleEnsureWebToken returns a valid dev token: cache -> fresh fetch (cached).
func appleEnsureWebToken() (string, error) {
	if b, err := os.ReadFile(appleWebTokenCacheFile); err == nil {
		var t appleWebToken
		if json.Unmarshal(b, &t) == nil && t.Token != "" && time.Until(t.Expiry) > 24*time.Hour {
			return t.Token, nil
		}
	}
	t, err := appleFetchWebToken(nil)
	if err != nil {
		return "", err
	}
	if b, err := json.MarshalIndent(t, "", "  "); err == nil {
		_ = os.WriteFile(appleWebTokenCacheFile, b, 0600)
	}
	return t.Token, nil
}

// ---------------------------------------------------------------------------
// Apple Music web-playback client (webPlayback + Widevine license exchange).
// ---------------------------------------------------------------------------

type appleClient struct {
	WebToken  string
	UserToken string
	HTTP      *http.Client
}

func newAppleClient(webToken, userToken string) *appleClient {
	return &appleClient{WebToken: webToken, UserToken: userToken, HTTP: &http.Client{Timeout: 60 * time.Second}}
}

func (c *appleClient) auth(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.WebToken)
	req.Header.Set("x-apple-music-user-token", c.UserToken)
	req.Header.Set("Origin", "https://music.apple.com")
	req.Header.Set("Referer", "https://music.apple.com/")
	req.Header.Set("Accept", "application/json")
}

type applePlayback struct {
	SongID      string
	ManifestURL string
	CertURL     string
	LicenseURL  string
	DurationMs  int
	Title       string
	Artist      string
}

func (c *appleClient) webPlayback(adamID, libraryID string) (*applePlayback, error) {
	reqBody := map[string]string{"subscriptionAdamId": adamID}
	if libraryID != "" {
		reqBody["universalLibraryId"] = libraryID
	}
	body, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", appleWebPlaybackURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	c.auth(req)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("webPlayback HTTP %d: %s", resp.StatusCode, appleTrunc(raw, 300))
	}
	var wp struct {
		SongList []struct {
			Assets []struct {
				Flavor   string `json:"flavor"`
				URL      string `json:"URL"`
				Metadata struct {
					Duration int    `json:"duration"`
					ItemName string `json:"itemName"`
					Artist   string `json:"artistName"`
				} `json:"metadata"`
			} `json:"assets"`
			WidevineCertURL string `json:"widevine-cert-url"`
			HLSKeyServerURL string `json:"hls-key-server-url"`
			SongID          string `json:"songId"`
		} `json:"songList"`
	}
	if err := json.Unmarshal(raw, &wp); err != nil {
		return nil, fmt.Errorf("decode webPlayback: %w", err)
	}
	if len(wp.SongList) == 0 {
		return nil, fmt.Errorf("webPlayback: empty songList: %s", appleTrunc(raw, 300))
	}
	s := wp.SongList[0]
	pb := &applePlayback{SongID: s.SongID, CertURL: s.WidevineCertURL, LicenseURL: s.HLSKeyServerURL}
	for _, a := range s.Assets {
		if strings.Contains(a.Flavor, "ctrp256") {
			pb.ManifestURL, pb.DurationMs = a.URL, a.Metadata.Duration
			pb.Title, pb.Artist = a.Metadata.ItemName, a.Metadata.Artist
		}
	}
	if pb.ManifestURL == "" {
		for _, a := range s.Assets {
			if strings.Contains(a.Flavor, "ctr") {
				pb.ManifestURL = a.URL
			}
		}
	}
	if pb.ManifestURL == "" {
		return nil, fmt.Errorf("apple: no Widevine (ctr) flavor")
	}
	return pb, nil
}

var (
	appleDataKeyRe = regexp.MustCompile(`#EXT-X-(?:SESSION-)?KEY:[^\n]*URI="(data:[^;,]*;base64,([A-Za-z0-9+/=]+))"`)
	appleSubM3URe  = regexp.MustCompile(`(?m)^[^#\n].*\.m3u8.*$`)
	appleMediaRe   = regexp.MustCompile(`(?m)^[^#\n].*\.mp4.*$`)
)

func (c *appleClient) widevinePSSH(manifestURL string) (initData []byte, keyURI string, err error) {
	text, err := c.getText(manifestURL)
	if err != nil {
		return nil, "", err
	}
	if m := appleDataKeyRe.FindStringSubmatch(text); m != nil {
		b, derr := base64.StdEncoding.DecodeString(m[2])
		return b, m[1], derr
	}
	if ref := appleSubM3URe.FindString(text); ref != "" {
		return c.widevinePSSH(appleResolveRef(manifestURL, strings.TrimSpace(ref)))
	}
	return nil, "", fmt.Errorf("apple: no Widevine EXT-X-KEY in manifest")
}

func (c *appleClient) widevineCert(certURL string) ([]byte, error) {
	u := certURL
	if !strings.Contains(u, "?") {
		u += fmt.Sprintf("?t=%d", time.Now().UnixMilli())
	}
	req, _ := http.NewRequest("GET", u, nil)
	c.auth(req)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("widevineCert HTTP %d", resp.StatusCode)
	}
	return b, nil
}

func (c *appleClient) acquireLicense(pb *applePlayback, challenge []byte, uri string) ([]byte, error) {
	body, _ := json.Marshal(map[string]any{
		"challenge": base64.StdEncoding.EncodeToString(challenge), "uri": uri,
		"key-system": appleKeySystem, "adamId": pb.SongID, "isLibrary": true, "user-initiated": true,
	})
	req, _ := http.NewRequest("POST", pb.LicenseURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-apple-renewal", "true")
	c.auth(req)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("acquireLicense HTTP %d: %s", resp.StatusCode, appleTrunc(raw, 300))
	}
	var lr struct {
		License   string `json:"license"`
		ErrorCode int    `json:"errorCode"`
		Status    int    `json:"status"`
	}
	if err := json.Unmarshal(raw, &lr); err != nil {
		return nil, fmt.Errorf("decode license: %w", err)
	}
	if lr.Status != 0 || lr.ErrorCode != 0 {
		return nil, fmt.Errorf("license error status=%d errorCode=%d", lr.Status, lr.ErrorCode)
	}
	return base64.StdEncoding.DecodeString(lr.License)
}

func (c *appleClient) mediaFileURL(manifestURL string) (string, error) {
	text, err := c.getText(manifestURL)
	if err != nil {
		return "", err
	}
	if ref := appleSubM3URe.FindString(text); ref != "" {
		return c.mediaFileURL(appleResolveRef(manifestURL, strings.TrimSpace(ref)))
	}
	if m := appleMediaRe.FindString(text); m != "" {
		return appleResolveRef(manifestURL, strings.TrimSpace(m)), nil
	}
	return "", fmt.Errorf("apple: no media file in manifest")
}

func (c *appleClient) getBytes(u string) ([]byte, error) {
	resp, err := c.HTTP.Get(u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GET %s -> HTTP %d", u, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func (c *appleClient) getText(u string) (string, error) {
	b, err := c.getBytes(u)
	return string(b), err
}

func appleResolveRef(base, ref string) string {
	if strings.HasPrefix(ref, "http") {
		return ref
	}
	if i := strings.LastIndex(base, "/"); i >= 0 {
		return base[:i+1] + ref
	}
	return ref
}

func appleTrunc(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n]) + "..."
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Widevine CDM (device.wvd -> license challenge -> content keys).
// ---------------------------------------------------------------------------

var appleWidevineSystemID = []byte{0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed}

func appleBuildPSSH(initData []byte) []byte {
	if len(initData) >= 8 && string(initData[4:8]) == "pssh" {
		return initData
	}
	data := append([]byte{0x12, byte(len(initData))}, initData...)
	size := 4 + 4 + 4 + 16 + 4 + len(data)
	be32 := func(v int) []byte { return []byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)} }
	box := make([]byte, 0, size)
	box = append(box, be32(size)...)
	box = append(box, 'p', 's', 's', 'h', 0, 0, 0, 0)
	box = append(box, appleWidevineSystemID...)
	box = append(box, be32(len(data))...)
	return append(box, data...)
}

func appleParseServiceCert(raw []byte) (*wvpb.DrmCertificate, error) {
	signed := &wvpb.SignedDrmCertificate{}
	if err := proto.Unmarshal(raw, signed); err != nil {
		return nil, fmt.Errorf("unmarshal signed drm cert: %w", err)
	}
	cert := &wvpb.DrmCertificate{}
	if err := proto.Unmarshal(signed.DrmCertificate, cert); err != nil {
		return nil, fmt.Errorf("unmarshal drm cert: %w", err)
	}
	return cert, nil
}

func appleGetKeys(wvd []byte, cert *wvpb.DrmCertificate, psshBytes []byte, acquire func([]byte) ([]byte, error)) ([]*widevine.Key, error) {
	device, err := widevine.NewDevice(widevine.FromWVD(bytes.NewReader(wvd)))
	if err != nil {
		return nil, fmt.Errorf("load device.wvd: %w", err)
	}
	cdm := widevine.NewCDM(device)
	pssh, err := widevine.NewPSSH(psshBytes)
	if err != nil {
		return nil, fmt.Errorf("parse pssh: %w", err)
	}
	challenge, parseLicense, err := cdm.GetLicenseChallenge(pssh, wvpb.LicenseType_AUTOMATIC, true, cert)
	if err != nil {
		return nil, fmt.Errorf("build challenge: %w", err)
	}
	licenseBytes, err := acquire(challenge)
	if err != nil {
		return nil, err
	}
	return parseLicense(licenseBytes)
}

// appleDecryptTo runs the whole flow for a track and writes the decrypted AAC/m4a to w.
func appleDecryptTo(ctx context.Context, adamID, libraryID string, w io.Writer) error {
	userToken := appleMusicUserToken()
	if userToken == "" {
		return fmt.Errorf("apple: no Music User Token (sign in first)")
	}
	wvd, err := os.ReadFile(appleWVDFile)
	if err != nil {
		return fmt.Errorf("apple: device.wvd missing (put a Widevine L3 CDM at %s)", appleWVDFile)
	}
	webToken, err := appleEnsureWebToken()
	if err != nil {
		return fmt.Errorf("apple web token: %w", err)
	}
	c := newAppleClient(webToken, userToken)
	pb, err := c.webPlayback(adamID, libraryID)
	if err != nil {
		return err
	}
	initData, keyURI, err := c.widevinePSSH(pb.ManifestURL)
	if err != nil {
		return err
	}
	certBytes, err := c.widevineCert(pb.CertURL)
	if err != nil {
		return err
	}
	cert, err := appleParseServiceCert(certBytes)
	if err != nil {
		return err
	}
	keys, err := appleGetKeys(wvd, cert, appleBuildPSSH(initData), func(ch []byte) ([]byte, error) {
		return c.acquireLicense(pb, ch, keyURI)
	})
	if err != nil {
		return err
	}
	mediaURL, err := c.mediaFileURL(pb.ManifestURL)
	if err != nil {
		return err
	}
	encrypted, err := c.getBytes(mediaURL)
	if err != nil {
		return err
	}
	return widevine.DecryptMP4Auto(bytes.NewReader(encrypted), keys, w)
}

// ---------------------------------------------------------------------------
// Provider + HTTP handlers.
// ---------------------------------------------------------------------------

type appleProvider struct{}

func (a *appleProvider) ID() string   { return "apple" }
func (a *appleProvider) Name() string { return "Apple Music" }

// Available: both the Widevine CDM and a Music User Token are present.
func (a *appleProvider) Available() bool {
	if _, err := os.Stat(appleWVDFile); err != nil {
		return false
	}
	return appleMusicUserToken() != ""
}

// Search via the public iTunes Search API — trackId IS the adamID used for playback.
func (a *appleProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	u := fmt.Sprintf("https://itunes.apple.com/search?term=%s&entity=song&limit=%d", url.QueryEscape(query), limit)
	body, err := httpGetString(ctx, u)
	if err != nil {
		return nil, err
	}
	var r struct {
		Results []struct {
			TrackID        int64  `json:"trackId"`
			TrackName      string `json:"trackName"`
			ArtistName     string `json:"artistName"`
			CollectionName string `json:"collectionName"`
			ArtworkURL100  string `json:"artworkUrl100"`
			TrackTimeMs    int    `json:"trackTimeMillis"`
		} `json:"results"`
	}
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return nil, fmt.Errorf("apple search: %w", err)
	}
	out := []providerTrack{}
	for _, t := range r.Results {
		if t.TrackID == 0 {
			continue
		}
		id := strconv.FormatInt(t.TrackID, 10)
		out = append(out, providerTrack{
			ID: id, Provider: "apple", Title: t.TrackName, Artist: t.ArtistName,
			Album: t.CollectionName, Thumbnail: t.ArtworkURL100, DurationMs: t.TrackTimeMs,
			Path: "apple:" + id,
		})
	}
	return out, nil
}

// StreamURL points gst at the local decrypt proxy (decryption needs the whole file).
func (a *appleProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	return "http://127.0.0.1:8730/applestream?id=" + url.QueryEscape(trackID), nil
}

// handleAppleStream: webPlayback + Widevine license + download + decrypt, streamed as m4a.
func handleAppleStream(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "audio/mp4")
	if err := appleDecryptTo(r.Context(), id, r.URL.Query().Get("lib"), w); err != nil {
		// Headers may already be sent; log-style error only if nothing written yet.
		http.Error(w, err.Error(), http.StatusBadGateway)
	}
}

// POST /appleauth/save {musicUserToken} — store the token + register the provider.
func handleAppleAuthSave(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MusicUserToken string `json:"musicUserToken"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	tok := strings.TrimSpace(body.MusicUserToken)
	if tok == "" {
		httpErr(w, http.StatusBadRequest, "musicUserToken required")
		return
	}
	if err := os.WriteFile(appleUserTokenFile, []byte(tok), 0600); err != nil {
		httpErr(w, http.StatusInternalServerError, "write token: "+err.Error())
		return
	}
	refreshFirstPartyServices()
	writeJSON(w, map[string]interface{}{"ok": true})
}

// GET /appleauth/status — is Apple Music usable (CDM + token present)?
func handleAppleAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{
		"authenticated": (&appleProvider{}).Available(),
		"hasCDM":        appleFileExists(appleWVDFile),
	})
}

func appleFileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// GET /appleauth/login — a MusicKit page that signs the user in and posts the token back.
func handleAppleAuthLogin(w http.ResponseWriter, r *http.Request) {
	devToken, err := appleEnsureWebToken()
	if err != nil {
		http.Error(w, "apple dev token: "+err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, appleLoginHTML, devToken)
}

// MusicKit v3 login page: configure with the dev token, authorize() to get the Music
// User Token, POST it to /appleauth/save, then show a done state the validator polls for.
const appleLoginHTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Apple Music</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;text-align:center;padding:24px}
button{font-size:20px;padding:14px 28px;border:0;border-radius:10px;background:#fa2d48;color:#fff}
#s{margin-top:18px;opacity:.85}</style>
<script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>
</head><body>
<h2>Apple Music</h2>
<button id="b" onclick="go()">Sign in with Apple ID</button>
<div id="s">Loading…</div>
<script>
var DEV=%q, mk=null;
function st(m){document.getElementById('s').textContent=m;}
document.addEventListener('musickitloaded', async function(){
  try{
    await MusicKit.configure({developerToken:DEV, app:{name:'Music',build:'1'}});
    mk=MusicKit.getInstance();
    st('Tap “Sign in with Apple ID”.');
    if(mk.isAuthorized){ save(mk.musicUserToken); }
  }catch(e){ st('MusicKit error: '+e); }
});
async function go(){
  if(!mk){ st('Still loading MusicKit…'); return; }
  try{ st('Opening Apple sign-in…'); var t=await mk.authorize(); save(t||mk.musicUserToken); }
  catch(e){ st('Sign-in failed: '+e); }
}
function save(tok){
  if(!tok){ st('No token returned.'); return; }
  st('Saving…');
  fetch('http://127.0.0.1:8730/appleauth/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({musicUserToken:tok})}).then(function(r){return r.json();}).then(function(j){
      st(j&&j.ok? 'Signed in! You can close this.' : 'Save failed.');
      if(j&&j.ok){ location.href='http://127.0.0.1:8730/appleauth/done'; }
    }).catch(function(e){ st('Save error: '+e); });
}
</script></body></html>`

func handleAppleAuthDone(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!doctype html><meta charset=utf-8><body style="background:#111;color:#eee;font-family:sans-serif;text-align:center;padding:40px"><h2>Apple Music connected</h2></body>`)
}
