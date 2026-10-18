package main

// Self-contained "download lossless to library" framework.
//
// The pattern learned from surveying the download tools: their "free" tiers are
// third-party proxy servers (dezalty.com, spotbye.qzz.io, an author gist) — a
// middleman that can fingerprint, rate-limit, revoke, or vanish. We deliberately
// AVOID those and use only DIRECT first-party services the user has their own
// account with (Qobuz/Tidal/Deezer). Flow, all on the backend (Go has TLS 1.3):
//
//   Spotify track -> ISRC (via our existing Spotify client, first-party)
//     -> per-service Resolve(ISRC) -> that service's track id
//     -> FileURL(track id) -> a real first-party audio URL (+ Deezer Blowfish key)
//     -> download to /media/internal/Downloads (+ descramble for Deezer)
//     -> caller indexes it into the media DB; it then plays via the local path.
//
// Each adapter (qobuzdl.go / tidaldl.go / deezerdl.go) implements LosslessDownloader
// and self-registers only when its credential file exists.

import (
	"context"
	"crypto/cipher"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/blowfish"
)

// LosslessDownloader is a first-party lossless service the user has an account with.
type LosslessDownloader interface {
	ID() string                                                           // "qobuz" | "tidal" | "deezer"
	Name() string                                                         // display name
	Available() bool                                                      // credential file present + usable
	Resolve(ctx context.Context, isrc string) (trackID string, err error) // ISRC -> service id ("" if none)
	FileURL(ctx context.Context, trackID string) (losslessFile, error)    // real downloadable URL (+ decrypt info)
}

type losslessFile struct {
	URL    string
	Format string // "flac" | "m4a" | "mp3"
	// DeezerKey, when non-nil, means the stream is Deezer-scrambled: Blowfish-CBC
	// decrypt every 3rd 2048-byte chunk with this key (see deezerDescramble).
	DeezerKey []byte
}

var downloaders = []LosslessDownloader{}

func registerDownloader(d LosslessDownloader) {
	if d != nil && d.Available() {
		downloaders = append(downloaders, d)
		logf("lossless: registered downloader %q", d.ID())
	}
}

func logf(format string, a ...interface{}) { fmt.Printf(format+"\n", a...) }

// handleDownloadProviders: GET /download/providers -> which lossless services are configured.
func handleDownloadProviders(w http.ResponseWriter, r *http.Request) {
	type row struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := []row{}
	providersMu.RLock()
	for _, d := range downloaders {
		out = append(out, row{ID: d.ID(), Name: d.Name()})
	}
	providersMu.RUnlock()
	writeJSON(w, map[string]interface{}{"downloaders": out})
}

// handleDownload: POST /download {spotify_id, provider?}
// Resolves the Spotify track's ISRC, tries the requested downloader (or each in
// order), downloads+decrypts the FLAC to /media/internal/Downloads, and returns
// the local path for the app to index/play.
func handleDownload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SpotifyID string `json:"spotify_id"`
		ISRC      string `json:"isrc"`
		Provider  string `json:"provider"`
	}
	_ = decodeJSON(r, &body)
	// Snapshot under RLock — the per-downloader work below does network I/O and
	// must not hold the lock (refresh rebuilds this slice on credential changes).
	providersMu.RLock()
	dls := append([]LosslessDownloader(nil), downloaders...)
	providersMu.RUnlock()
	if len(dls) == 0 {
		httpErr(w, http.StatusPreconditionFailed, "no lossless downloader configured (add credentials in /media/cryptofs/spotify-webos/)")
		return
	}
	isrc := strings.TrimSpace(body.ISRC)
	title, artist := "", ""
	if isrc == "" {
		if body.SpotifyID == "" {
			httpErr(w, http.StatusBadRequest, "need spotify_id or isrc")
			return
		}
		var err error
		isrc, title, artist, err = spotifyISRC(r.Context(), body.SpotifyID)
		if err != nil || isrc == "" {
			httpErr(w, http.StatusBadGateway, fmt.Sprintf("no ISRC for %s: %v", body.SpotifyID, err))
			return
		}
	}

	var lastErr error
	for _, d := range dls {
		if body.Provider != "" && d.ID() != body.Provider {
			continue
		}
		tid, err := d.Resolve(r.Context(), isrc)
		if err != nil || tid == "" {
			lastErr = fmt.Errorf("%s: not found (%v)", d.ID(), err)
			continue
		}
		f, err := d.FileURL(r.Context(), tid)
		if err != nil || f.URL == "" {
			lastErr = fmt.Errorf("%s: no file url (%v)", d.ID(), err)
			continue
		}
		path, err := downloadTrack(r.Context(), f, isrc, title, artist, d.ID())
		if err != nil {
			lastErr = fmt.Errorf("%s: download failed (%v)", d.ID(), err)
			continue
		}
		writeJSON(w, map[string]interface{}{
			"ok": true, "provider": d.ID(), "path": path, "format": f.Format, "isrc": isrc,
		})
		return
	}
	httpErr(w, http.StatusBadGateway, fmt.Sprintf("no source could provide this track: %v", lastErr))
}

const downloadDir = "/media/internal/Downloads"

// downloadTrack streams the URL to a file (applying Deezer descramble when needed).
func downloadTrack(ctx context.Context, f losslessFile, isrc, title, artist, provider string) (string, error) {
	if err := os.MkdirAll(downloadDir, 0755); err != nil {
		return "", err
	}
	name := sanitizeName(nonEmpty(artist, provider) + " - " + nonEmpty(title, isrc))
	ext := f.Format
	if ext == "" {
		ext = "flac"
	}
	dst := filepath.Join(downloadDir, name+"."+ext)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("http %d fetching audio", resp.StatusCode)
	}
	out, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	defer out.Close()

	if f.DeezerKey != nil {
		if err := deezerDescramble(out, resp.Body, f.DeezerKey); err != nil {
			return "", err
		}
	} else {
		if _, err := io.Copy(out, resp.Body); err != nil {
			return "", err
		}
	}
	return dst, nil
}

// deezerDescramble: Deezer scrambles every 3rd 2048-byte chunk with Blowfish-CBC
// (IV 00..07). Chunks 0,1,2 -> only index%3==0 is encrypted; the rest are plain.
func deezerDescramble(dst io.Writer, src io.Reader, key []byte) error {
	block, err := blowfish.NewCipher(key)
	if err != nil {
		return err
	}
	iv := []byte{0, 1, 2, 3, 4, 5, 6, 7}
	buf := make([]byte, 2048)
	for i := 0; ; i++ {
		n, rerr := io.ReadFull(src, buf)
		if n > 0 {
			chunk := buf[:n]
			if i%3 == 0 && n == 2048 {
				dec := make([]byte, 2048)
				cipher.NewCBCDecrypter(block, iv).CryptBlocks(dec, chunk)
				chunk = dec
			}
			if _, werr := dst.Write(chunk); werr != nil {
				return werr
			}
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

func nonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func sanitizeName(s string) string {
	repl := func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		}
		return r
	}
	out := strings.Map(repl, s)
	if len(out) > 120 {
		out = out[:120]
	}
	return strings.TrimSpace(out)
}
