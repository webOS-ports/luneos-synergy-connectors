package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sync"

	"github.com/dlclark/regexp2/v2"
	"github.com/dop251/goja"
)

// YouTube signature-cipher descrambling. The TVHTML5 client (authenticated via our
// OAuth token) clears the bot-check but returns adaptiveFormats whose media URL is
// hidden in `signatureCipher` (an obfuscated signature) plus a throttled `n` query
// param. To play them we must run YouTube's own JS transforms from base.js:
//   - the "sig" function unscrambles the signature -> appended as &sig=<value>
//   - the "n" function un-throttles the download (without it, audio may stall)
// We extract those two functions from base.js and execute them in goja (pure-Go JS).
// This is inherently fragile: it breaks whenever YouTube ships a new base.js, at
// which point re-fetching base.js (cached by player id) picks up the new transforms.

var (
	cipherMu     sync.Mutex
	cipherPlayer string // player id the cached transforms came from
	cipherSigSrc string // goja source defining __sig(a)
	cipherNSrc   string // goja source defining __n(a) ("" if extraction failed)
)

// resetCipherCache clears the cached sig/n transforms so the next resolve re-fetches
// base.js from scratch. Called by the StreamURL auto-heal when a whole pass produced no
// playable url (base.js may have rotated and the cached transforms gone stale).
func resetCipherCache() {
	cipherMu.Lock()
	cipherPlayer, cipherSigSrc, cipherNSrc = "", "", ""
	cipherMu.Unlock()
}

func httpGetString(ctx context.Context, u string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
	resp, err := itHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

func rx(pattern string) *regexp2.Regexp {
	return regexp2.MustCompile(pattern, regexp2.Singleline)
}

func firstGroup(re *regexp2.Regexp, s string, n int) string {
	m, _ := re.FindStringMatch(s)
	if m == nil {
		return ""
	}
	return m.GroupByNumber(n).String()
}

// loadPlayerCipher fetches base.js (if the player id changed) and extracts the
// sig + n transforms into goja-runnable source.
func loadPlayerCipher(ctx context.Context) error {
	api, err := httpGetString(ctx, "https://www.youtube.com/iframe_api")
	if err != nil {
		return fmt.Errorf("iframe_api: %w", err)
	}
	pid := firstGroup(rx(`player\\?/([0-9a-fA-F]{8})\\?/`), api, 1)
	if pid == "" {
		return fmt.Errorf("player id not found in iframe_api")
	}
	cipherMu.Lock()
	if pid == cipherPlayer && cipherSigSrc != "" {
		cipherMu.Unlock()
		return nil
	}
	cipherMu.Unlock()

	jsURL := "https://www.youtube.com/s/player/" + pid + "/player_ias.vflset/en_US/base.js"
	js, err := httpGetString(ctx, jsURL)
	if err != nil {
		return fmt.Errorf("base.js: %w", err)
	}
	sigSrc, err := extractSigFunc(js)
	if err != nil {
		return fmt.Errorf("sig extract: %w", err)
	}
	nSrc, nErr := extractNFunc(js)
	cipherMu.Lock()
	cipherPlayer = pid
	cipherSigSrc = sigSrc
	cipherNSrc = nSrc
	cipherMu.Unlock()
	if nErr != nil {
		log.Printf("youtube: n-transform extract failed (%v) — downloads may be throttled", nErr)
	}
	log.Printf("youtube: loaded cipher transforms from player %s (n=%v)", pid, nSrc != "")
	return nil
}

// extractSigFunc pulls the signature-descramble function + its helper object out of
// base.js and returns goja source that defines __sig(a).
func extractSigFunc(js string) (string, error) {
	// name=function(a){a=a.split("");HELPER.x(a,n);...;return a.join("")}
	m, _ := rx(`(?:\b|[^$\w])([$\w]+)=function\(([$\w]+)\)\{\2=\2\.split\(""\);(.+?)return \2\.join\(""\)\}`).FindStringMatch(js)
	if m == nil {
		return "", fmt.Errorf("sig function not found")
	}
	arg := m.GroupByNumber(2).String()
	body := m.GroupByNumber(3).String()
	// helper object name = token before first '.' in the body
	helper := firstGroup(rx(`([$\w]+)\.[$\w]+\(`), body, 1)
	if helper == "" {
		return "", fmt.Errorf("sig helper object not found")
	}
	// var HELPER={ ... }};   (object of small functions, ends with "}};")
	objBody := firstGroup(rx(`var `+regexp2.Escape(helper)+`=\{(.+?)\}\};`), js, 1)
	if objBody == "" {
		return "", fmt.Errorf("sig helper object def not found for %s", helper)
	}
	return fmt.Sprintf("var %s={%s}};\nfunction __sig(%s){%s=%s.split(\"\");%sreturn %s.join(\"\")}",
		helper, objBody, arg, arg, arg, body, arg), nil
}

// extractNFunc pulls the "n" throttling function out of base.js -> __n(a).
func extractNFunc(js string) (string, error) {
	// find the n function's name (may be referenced via an array: name=arr[0])
	name := firstGroup(rx(`\.get\("n"\)\)&&\([a-zA-Z0-9$]=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(`), js, 1)
	idx := firstGroup(rx(`\.get\("n"\)\)&&\([a-zA-Z0-9$]=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(`), js, 2)
	if name == "" {
		name = firstGroup(rx(`([a-zA-Z0-9$]+)=function\(\w\)\{var \w=\w\.split\(""\),`), js, 1)
	}
	if name == "" {
		return "", fmt.Errorf("n function name not found")
	}
	if idx != "" { // name is an array: var name=[realName];
		real := firstGroup(rx(`var `+regexp2.Escape(name)+`=\[([a-zA-Z0-9$]+)`), js, 1)
		if real != "" {
			name = real
		}
	}
	// realName=function(a){...}  — capture the whole function body up to its close
	body := firstGroup(rx(regexp2.Escape(name)+`=function\((\w)\)\{(.+?return \w\.join\(""\))\}`), js, 2)
	arg := firstGroup(rx(regexp2.Escape(name)+`=function\((\w)\)\{`), js, 1)
	if body == "" || arg == "" {
		return "", fmt.Errorf("n function body not found for %s", name)
	}
	return fmt.Sprintf("function __n(%s){%s}", arg, body), nil
}

// decipherSignatureCipher turns a format's signatureCipher into a playable URL.
func decipherSignatureCipher(ctx context.Context, signatureCipher string) (string, error) {
	if err := loadPlayerCipher(ctx); err != nil {
		return "", err
	}
	vals, err := url.ParseQuery(signatureCipher)
	if err != nil {
		return "", err
	}
	s := vals.Get("s")
	sp := vals.Get("sp")
	if sp == "" {
		sp = "signature"
	}
	streamURL := vals.Get("url")
	if s == "" || streamURL == "" {
		return "", fmt.Errorf("signatureCipher missing s/url")
	}
	sig, err := runJS1(cipherSigSrc, "__sig", s)
	if err != nil {
		return "", fmt.Errorf("sig run: %w", err)
	}
	u, err := url.Parse(streamURL)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set(sp, sig)
	// n throttle transform (best effort)
	cipherMu.Lock()
	nsrc := cipherNSrc
	cipherMu.Unlock()
	if nsrc != "" {
		if nv := q.Get("n"); nv != "" {
			if nn, err := runJS1(nsrc, "__n", nv); err == nil && nn != "" {
				q.Set("n", nn)
			}
		}
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// runJS1 runs source defining fn, calls fn(arg), returns the string result.
func runJS1(source, fn, arg string) (string, error) {
	vm := goja.New()
	if _, err := vm.RunString(source); err != nil {
		return "", err
	}
	callable, ok := goja.AssertFunction(vm.Get(fn))
	if !ok {
		return "", fmt.Errorf("%s not callable", fn)
	}
	res, err := callable(goja.Undefined(), vm.ToValue(arg))
	if err != nil {
		return "", err
	}
	return res.String(), nil
}
