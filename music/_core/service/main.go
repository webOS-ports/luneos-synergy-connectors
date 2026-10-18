// Command spotify-webos-service is the on-device backend for the Music+Spotify
// Enyo app. It exposes a tiny localhost HTTP/JSON API that the app calls:
//
//	POST /session          {access_token, refresh_token, expiry}  -> store token
//	GET  /search?q=&type=&limit=                                   -> Spotify search
//	GET  /browse/album?id= | /browse/artist?id= | /me/playlists    -> browse
//	POST /player/load      {uri, position_ms}                      -> start a track
//	POST /player/play | /player/pause | /player/next | /player/prev
//	POST /player/seek      {position_ms}
//	POST /player/volume    {volume}   (0..100)
//	GET  /player/status                                            -> position/state
//
// Search/browse hit the Spotify Web API via github.com/zmb3/spotify.
// Playback is delegated to a local librespot Spotify Connect receiver, which the
// service drives through the Spotify Connect Web API (transfer + transport).
//
// The front-end performs the OAuth2 Authorization-Code+PKCE flow itself (the
// device now has TLS 1.3 + a modern browser) and POSTs the resulting token to
// /session, so this service never needs a client secret.
//
// Build for webOS (ARMv7) with Herrie's Go toolchain, e.g.:
//
//	GOOS=linux GOARCH=arm GOARM=7 go build -o spotify-webos-service .
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"github.com/zmb3/spotify/v2"
)

// rawAcceptListener is a net.Listener whose Accept() calls the plain "accept"
// syscall (SYS_ACCEPT) directly, instead of going through Go's net/internal-poll
// path, which unconditionally uses accept4 on every GOOS since the stdlib's
// ENOSYS fallback for pre-accept4 kernels was removed. This device's ARM kernel
// implements accept but not accept4 ("accept4: function not implemented"), so
// http.ListenAndServe (which always ends up calling accept4) never accepts a
// single connection even though it logs "listening" successfully.
type rawAcceptListener struct {
	fd   int
	addr net.Addr
	file *os.File // keeps the dup'd fd alive; do not let this be GC'd
}

func newRawAcceptListener(addr string) (*rawAcceptListener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	tcpLn := ln.(*net.TCPListener)
	f, err := tcpLn.File() // dup: independent, blocking fd
	tcpLn.Close()
	if err != nil {
		return nil, err
	}
	return &rawAcceptListener{fd: int(f.Fd()), addr: ln.Addr(), file: f}, nil
}

func (l *rawAcceptListener) Accept() (net.Conn, error) {
	for {
		var rsa syscall.RawSockaddrAny
		salen := uint32(unsafe.Sizeof(rsa))
		r0, _, e1 := syscall.Syscall(syscall.SYS_ACCEPT, uintptr(l.fd), uintptr(unsafe.Pointer(&rsa)), uintptr(unsafe.Pointer(&salen)))
		if e1 != 0 {
			switch e1 {
			case syscall.EINTR, syscall.ECONNABORTED:
				continue
			}
			return nil, e1
		}
		nfd := int(r0)
		cf := os.NewFile(uintptr(nfd), "conn")
		conn, cerr := net.FileConn(cf)
		cf.Close()
		if cerr != nil {
			continue
		}
		return conn, nil
	}
}

func (l *rawAcceptListener) Close() error { return l.file.Close() }
func (l *rawAcceptListener) Addr() net.Addr { return l.addr }

// session holds the current authenticated Spotify client + chosen device.
type session struct {
	mu            sync.RWMutex
	client        *spotify.Client
	deviceID      spotify.ID // the librespot Connect receiver we play through
	librespotName string     // Connect device name to auto-select
}

var sess = &session{}

// config holds the OAuth app identity (see auth.go).
type config struct {
	clientID    string
	redirectURL string
}

var cfg = &config{}

func main() {
	addr := flag.String("addr", "127.0.0.1:8730", "listen address (localhost only)")
	librespotName := flag.String("librespot-name", "webOS", "Connect device name to target for playback")
	clientID := flag.String("client-id", "", "Spotify app client id (for the in-backend OAuth PKCE flow)")
	clientIDFile := flag.String("client-id-file", spotifyDataDir+"/spotify-client-id", "file to read the client id from if -client-id is empty")
	redirect := flag.String("redirect", "http://127.0.0.1:8730/auth/callback", "OAuth redirect URL (must be registered on the Spotify app)")
	tokenFile := flag.String("token-file", tokenPath, "where to persist the OAuth token (survives restarts)")
	flag.Parse()
	tokenPath = *tokenFile
	sess.librespotName = *librespotName
	cfg.clientID = *clientID
	cfg.redirectURL = *redirect
	if cfg.clientID == "" && *clientIDFile != "" {
		if b, err := os.ReadFile(*clientIDFile); err == nil {
			cfg.clientID = strings.TrimSpace(string(b))
		}
	}
	if cfg.clientID != "" {
		log.Printf("OAuth client id loaded (%d chars); redirect=%s", len(cfg.clientID), cfg.redirectURL)
	} else {
		log.Printf("no client id set — /auth/login will 412 until you provide one")
	}

	registerProvider(&spotifyProvider{})
	registerProvider(&youtubeProvider{})
	registerProvider(&soundcloudProvider{})
	registerProvider(newJamendoProvider())
	registerProvider(&archiveProvider{})

	// First-party services double as lossless DOWNLOADERS (self-register only if
	// their credential file exists) and streaming PROVIDERS. Qobuz/Tidal stream URLs
	// are plain (register only with creds); Deezer streams are scrambled -> the
	// provider always registers (free public search + 30s preview) and full tracks
	// go through the /dzstream descrambling proxy when a deezer-arl is present.
	qz := newQobuzDL()
	td := newTidalDL()
	dz := newDeezerDL()
	dzDL = dz
	tdDL = td
	registerDownloader(qz)
	registerDownloader(td)
	registerDownloader(dz)
	registerProvider(&deezerProvider{dl: dz})
	if qz.Available() {
		registerProvider(&qobuzProvider{dl: qz})
	}
	if td.Available() {
		registerProvider(&tidalProvider{dl: td})
	}
	if (&appleProvider{}).Available() {
		registerProvider(&appleProvider{})
	}

	restoreSession() // reload a persisted token, if any, so login survives restarts
	loadYtToken()    // reload a persisted YouTube OAuth token, if any

	mux := http.NewServeMux()
	mux.HandleFunc("/login", handleLoginRedirect) // short URL to type in the browser
	mux.HandleFunc("/providers", withCORS(handleProviders))
	mux.HandleFunc("/provider/", withCORS(handleProviderRoute))
	mux.HandleFunc("/stream/pause", withCORS(handleStreamPause))
	mux.HandleFunc("/stream/resume", withCORS(handleStreamResume))
	mux.HandleFunc("/stream/stop", withCORS(handleStreamStop))
	mux.HandleFunc("/stream/status", withCORS(handleStreamStatus))
	mux.HandleFunc("/stream/switchformat", withCORS(handleStreamSwitchFormat))
	mux.HandleFunc("/dzstream", handleDzStream)                              // Deezer descrambling stream proxy (no CORS; gst/curl only)
	mux.HandleFunc("/ytauth/start", withCORS(handleYtAuthStart))             // begin device-code login
	mux.HandleFunc("/ytauth/poll", withCORS(handleYtAuthPoll))               // poll for authorisation
	mux.HandleFunc("/ytauth/status", withCORS(handleYtAuthStatus))           // is YouTube signed in?
	mux.HandleFunc("/tidalauth/start", withCORS(handleTidalAuthStart))       // Tidal PKCE: get authorize URL
	mux.HandleFunc("/tidalauth/exchange", withCORS(handleTidalAuthExchange)) // exchange redirect ?code
	mux.HandleFunc("/tidalauth/status", withCORS(handleTidalAuthStatus))     // is Tidal signed in?
	mux.HandleFunc("/tidalstream", handleTidalStream)                        // DASH/BTS reassembly proxy (gst/curl)
	mux.HandleFunc("/applestream", handleAppleStream)                        // Apple Music Widevine decrypt proxy
	mux.HandleFunc("/appleauth/login", withCORS(handleAppleAuthLogin))       // MusicKit sign-in page
	mux.HandleFunc("/appleauth/save", withCORS(handleAppleAuthSave))         // store the Music User Token
	mux.HandleFunc("/appleauth/status", withCORS(handleAppleAuthStatus))     // is Apple Music signed in?
	mux.HandleFunc("/appleauth/done", withCORS(handleAppleAuthDone))         // post-login landing page
	mux.HandleFunc("/qobuzauth/login", withCORS(handleQobuzAuthLogin))       // Qobuz email+password
	mux.HandleFunc("/dzauth/save", withCORS(handleDeezerAuthSave))           // Deezer ARL cookie (fallback)
	mux.HandleFunc("/dzauth/login", withCORS(handleDeezerAuthLogin))         // Deezer email+password -> ARL
	mux.HandleFunc("/auth/login", withCORS(handleAuthLogin))
	mux.HandleFunc("/auth/callback", handleAuthCallback) // browser redirect target (no CORS)
	mux.HandleFunc("/auth/status", withCORS(handleAuthStatus))
	mux.HandleFunc("/auth/token", withCORS(handleAuthToken)) // for the Accounts validator app
	mux.HandleFunc("/me", withCORS(handleMe))                // Spotify profile (account label)
	mux.HandleFunc("/download/providers", withCORS(handleDownloadProviders))
	mux.HandleFunc("/download", withCORS(handleDownload)) // resolve ISRC -> first-party lossless -> file
	mux.HandleFunc("/session", withCORS(handleSession))
	mux.HandleFunc("/search", withCORS(handleSearch))
	mux.HandleFunc("/browse/album", withCORS(handleBrowseAlbum))
	mux.HandleFunc("/browse/artist", withCORS(handleBrowseArtist))
	mux.HandleFunc("/me/playlists", withCORS(handleMyPlaylists))
	mux.HandleFunc("/player/load", withCORS(handlePlayerLoad))
	mux.HandleFunc("/player/play", withCORS(handlePlayerPlay))
	mux.HandleFunc("/player/pause", withCORS(handlePlayerPause))
	mux.HandleFunc("/player/next", withCORS(handlePlayerNext))
	mux.HandleFunc("/player/prev", withCORS(handlePlayerPrev))
	mux.HandleFunc("/player/seek", withCORS(handlePlayerSeek))
	mux.HandleFunc("/player/volume", withCORS(handlePlayerVolume))
	mux.HandleFunc("/player/status", withCORS(handlePlayerStatus))

	ln, err := newRawAcceptListener(*addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("spotify-webos-service listening on http://%s (playback device: %q)", *addr, *librespotName)
	if err := http.Serve(ln, mux); err != nil {
		log.Fatal(err)
	}
}

// withCORS allows the file:// / app-origin Enyo UI to call us on localhost.
func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s (origin=%q)", r.Method, r.URL.Path, r.Header.Get("Origin"))
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
