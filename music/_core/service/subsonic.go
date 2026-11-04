package main

// Subsonic: the user's own music server through the Subsonic API, which
// Navidrome, Airsonic(-Advanced), Gonic, Ampache and others speak. Search
// (search3), the user's playlists on the server (getPlaylists/getPlaylist),
// and playback (stream).
//
// Sign-in: the server's address, a username and a password, checked with ping
// before they are kept (POST /subsonicauth/login). Every request carries the
// username and, as the API asks since 1.13, a token: md5(password + salt) with a
// fresh salt. A server that refuses tokens (Subsonic error 41: an LDAP user) is
// sent the password hex-encoded instead, which is what the API offers then.
//
// A token never expires, so no URL that carries one leaves this daemon: the app
// gets this daemon's /subsonicstream and /subsonicart, which add the sign-in
// when they fetch from the server, and those are what end up in its playlists.
// For the same reason no error passes on the URL it failed on.

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	subsonicAuthFile = spotifyDataDir + "/subsonic-auth"
	// The API version asked for: 1.16.1 is the last Subsonic release, and what
	// OpenSubsonic servers build on. Older servers answer error 30.
	subsonicAPIVersion = "1.16.1"
	subsonicClientName = "LuneOS"
	// Where the app fetches what this daemon fetches for it.
	subsonicLocalBase = "http://127.0.0.1:8730"
)

// subsonicAuthPath is where the sign-in is kept; a variable for the tests.
var subsonicAuthPath = subsonicAuthFile

// subsonicHTTP asks the server's API; a stream gets no overall time limit,
// since a whole track goes through it (subsonicStreamHTTP).
var (
	subsonicHTTP       = &http.Client{Timeout: 20 * time.Second}
	subsonicStreamHTTP = &http.Client{}
)

// subsonicCreds is the sign-in, kept one field a line: server, username,
// password, then "plain" when the server takes no token.
type subsonicCreds struct {
	Server   string
	User     string
	Password string
	Plain    bool
}

func (c subsonicCreds) encode() []byte {
	mode := "token"
	if c.Plain {
		mode = "plain"
	}
	return []byte(c.Server + "\n" + c.User + "\n" + c.Password + "\n" + mode + "\n")
}

func parseSubsonicCreds(b []byte) (subsonicCreds, bool) {
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) < 3 || lines[0] == "" || lines[1] == "" || lines[2] == "" {
		return subsonicCreds{}, false
	}
	c := subsonicCreds{Server: lines[0], User: lines[1], Password: lines[2]}
	c.Plain = len(lines) > 3 && lines[3] == "plain"
	return c, true
}

// normalizeSubsonicServer turns what the user typed into the server's base:
// "nas:4533", "http://nas:4533/", Navidrome's own page
// "https://music.example/app/#/album/x" or a pasted ".../rest" all become the
// address the API's /rest hangs off. A path in front of it (a server behind a
// proxy at /navidrome) is kept.
func normalizeSubsonicServer(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errors.New("the server's address is missing")
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("that is not a server address")
	}
	u.User = nil
	u.RawQuery, u.Fragment, u.RawFragment = "", "", ""
	p := strings.TrimRight(u.Path, "/")
	for _, tail := range []string{"/app", "/rest"} {
		if i := strings.Index(p+"/", tail+"/"); i >= 0 {
			p = p[:i]
		}
	}
	u.Path, u.RawPath = strings.TrimRight(p, "/"), ""
	return u.String(), nil
}

// subsonicError is the server's own refusal: {"error":{"code":40,"message":...}}.
type subsonicError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *subsonicError) Error() string {
	switch e.Code {
	case 40:
		return "wrong username or password"
	case 41:
		return "the server does not take tokens"
	case 50:
		return "this user may not do that on the server"
	case 70:
		return "not found on the server"
	}
	if e.Message != "" {
		return "the server says: " + e.Message
	}
	return "the server refused (Subsonic error " + strconv.Itoa(e.Code) + ")"
}

type subsonicClient struct {
	creds subsonicCreds
	// salt makes the salts; a variable for the tests.
	salt func() string
}

func newSubsonicClient(c subsonicCreds) *subsonicClient {
	return &subsonicClient{creds: c, salt: randomSalt}
}

func randomSalt() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// auth is the sign-in and the protocol fields every request carries.
func (s *subsonicClient) auth() url.Values {
	v := url.Values{}
	v.Set("u", s.creds.User)
	if s.creds.Plain {
		v.Set("p", "enc:"+hex.EncodeToString([]byte(s.creds.Password)))
	} else {
		salt := s.salt()
		sum := md5.Sum([]byte(s.creds.Password + salt))
		v.Set("t", hex.EncodeToString(sum[:]))
		v.Set("s", salt)
	}
	v.Set("v", subsonicAPIVersion)
	v.Set("c", subsonicClientName)
	return v
}

func (s *subsonicClient) restURL(method string, extra url.Values) string {
	v := s.auth()
	for k, vals := range extra {
		v[k] = vals
	}
	return s.creds.Server + "/rest/" + method + ".view?" + v.Encode()
}

// quietErr is a request's failure without the URL it was for, which holds the
// sign-in: "dial tcp ...: connection refused", "context deadline exceeded".
func quietErr(what string, err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("subsonic %s: the server did not answer in time", what)
	}
	return fmt.Errorf("subsonic %s: the server cannot be reached (%v)", what, err)
}

// call asks the API and decodes "subsonic-response" into out (which may be nil).
func (s *subsonicClient) call(ctx context.Context, method string, extra url.Values, out interface{}) error {
	if extra == nil {
		extra = url.Values{}
	}
	extra.Set("f", "json")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.restURL(method, extra), nil)
	if err != nil {
		return fmt.Errorf("subsonic %s: bad server address", method)
	}
	resp, err := subsonicHTTP.Do(req)
	if err != nil {
		return quietErr(method, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return quietErr(method, err)
	}
	var env struct {
		R json.RawMessage `json:"subsonic-response"`
	}
	if json.Unmarshal(body, &env) != nil || len(env.R) == 0 {
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("subsonic %s: the server answered HTTP %d", method, resp.StatusCode)
		}
		return fmt.Errorf("subsonic %s: that is not a Subsonic server", method)
	}
	var head struct {
		Status string         `json:"status"`
		Error  *subsonicError `json:"error"`
	}
	if err := json.Unmarshal(env.R, &head); err != nil {
		return fmt.Errorf("subsonic %s: unreadable answer", method)
	}
	if head.Status != "ok" {
		if head.Error != nil {
			return head.Error
		}
		return fmt.Errorf("subsonic %s: the server refused", method)
	}
	if out != nil {
		if err := json.Unmarshal(env.R, out); err != nil {
			return fmt.Errorf("subsonic %s: unreadable answer", method)
		}
	}
	return nil
}

// subsonicSong is a song ("child") as search3 and getPlaylist give it.
type subsonicSong struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album"`
	CoverArt string `json:"coverArt"`
	Duration int    `json:"duration"` // seconds
	IsDir    bool   `json:"isDir"`
	IsVideo  bool   `json:"isVideo"`
}

func subsonicArtURL(coverArt string) string {
	if coverArt == "" {
		return ""
	}
	return subsonicLocalBase + "/subsonicart?id=" + url.QueryEscape(coverArt)
}

func subsonicTracks(songs []subsonicSong, max int) []providerTrack {
	out := []providerTrack{}
	for _, s := range songs {
		if s.ID == "" || s.IsDir || s.IsVideo {
			continue
		}
		out = append(out, providerTrack{
			ID: s.ID, Provider: "subsonic", Title: s.Title, Artist: s.Artist, Album: s.Album,
			Thumbnail: subsonicArtURL(s.CoverArt), DurationMs: s.Duration * 1000, Path: "subsonic:" + s.ID,
		})
		if len(out) == max {
			break
		}
	}
	return out
}

type subsonicProvider struct{ cl *subsonicClient }

func (p *subsonicProvider) ID() string   { return "subsonic" }
func (p *subsonicProvider) Name() string { return "Subsonic" }

func (p *subsonicProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	v := url.Values{}
	v.Set("query", query)
	v.Set("songCount", strconv.Itoa(limit))
	v.Set("artistCount", "0")
	v.Set("albumCount", "0")
	var r struct {
		Result struct {
			Song []subsonicSong `json:"song"`
		} `json:"searchResult3"`
	}
	if err := p.cl.call(ctx, "search3", v, &r); err != nil {
		return nil, err
	}
	return subsonicTracks(r.Result.Song, limit), nil
}

// StreamURL is this daemon's /subsonicstream for the song, not the server's own
// stream URL, which carries the sign-in.
func (p *subsonicProvider) StreamURL(_ context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	return subsonicLocalBase + "/subsonicstream?id=" + url.QueryEscape(trackID), nil
}

func (p *subsonicProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	var r struct {
		Playlists struct {
			Playlist []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				Owner     string `json:"owner"`
				SongCount int    `json:"songCount"`
				CoverArt  string `json:"coverArt"`
			} `json:"playlist"`
		} `json:"playlists"`
	}
	if err := p.cl.call(ctx, "getPlaylists", nil, &r); err != nil {
		return nil, err
	}
	out := []providerPlaylist{}
	for _, l := range r.Playlists.Playlist {
		if l.ID == "" {
			continue
		}
		out = append(out, providerPlaylist{ID: l.ID, Provider: "subsonic", Name: l.Name, Owner: l.Owner,
			Thumbnail: subsonicArtURL(l.CoverArt), Tracks: l.SongCount})
		if len(out) == maxPlaylists {
			break
		}
	}
	return out, nil
}

func (p *subsonicProvider) PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error) {
	v := url.Values{}
	v.Set("id", playlistID)
	var r struct {
		Playlist struct {
			Entry []subsonicSong `json:"entry"`
		} `json:"playlist"`
	}
	if err := p.cl.call(ctx, "getPlaylist", v, &r); err != nil {
		return nil, err
	}
	return subsonicTracks(r.Playlist.Entry, maxPlaylistTracks), nil
}

// loadSubsonic reads the kept sign-in into the provider registry, or takes
// Subsonic out of it when there is none. At startup and after a sign-in.
func loadSubsonic() {
	b, err := os.ReadFile(subsonicAuthPath)
	c, ok := parseSubsonicCreds(b)
	providersMu.Lock()
	defer providersMu.Unlock()
	if err != nil || !ok {
		delete(providers, "subsonic")
		return
	}
	providers["subsonic"] = &subsonicProvider{cl: newSubsonicClient(c)}
}

func currentSubsonic() *subsonicProvider {
	providersMu.RLock()
	defer providersMu.RUnlock()
	p, _ := providers["subsonic"].(*subsonicProvider)
	return p
}

// subsonicProxy fetches method from the server with the sign-in added and
// passes the answer on: the status, the headers a player seeks with, the body.
// A Range from the player goes to the server, so seeking works.
func subsonicProxy(w http.ResponseWriter, r *http.Request, method string, extra url.Values) {
	p := currentSubsonic()
	if p == nil {
		http.Error(w, "subsonic not configured", http.StatusServiceUnavailable)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, p.cl.restURL(method, extra), nil)
	if err != nil {
		http.Error(w, "bad server address", http.StatusBadGateway)
		return
	}
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	resp, err := subsonicStreamHTTP.Do(req)
	if err != nil {
		http.Error(w, quietErr(method, err).Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	// A refusal comes back as a Subsonic answer instead of the file.
	if strings.HasPrefix(ct, "application/json") || strings.HasPrefix(ct, "text/xml") || strings.HasPrefix(ct, "application/xml") {
		msg := "the server refused"
		var env struct {
			R struct {
				Error *subsonicError `json:"error"`
			} `json:"subsonic-response"`
		}
		if b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10)); err == nil && json.Unmarshal(b, &env) == nil && env.R.Error != nil {
			msg = env.R.Error.Error()
		}
		http.Error(w, "subsonic "+method+": "+msg, http.StatusBadGateway)
		return
	}
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// GET /subsonicstream?id=<song id>: the song as the server streams it.
func handleSubsonicStream(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id is required", http.StatusBadRequest)
		return
	}
	v := url.Values{}
	v.Set("id", id)
	subsonicProxy(w, r, "stream", v)
}

// GET /subsonicart?id=<coverArt id>[&size=]: a cover, by default 300 pixels.
func handleSubsonicArt(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id is required", http.StatusBadRequest)
		return
	}
	size := 300
	if n, err := strconv.Atoi(r.URL.Query().Get("size")); err == nil && n > 0 && n <= 2000 {
		size = n
	}
	v := url.Values{}
	v.Set("id", id)
	v.Set("size", strconv.Itoa(size))
	subsonicProxy(w, r, "getCoverArt", v)
}

// subsonicPing signs in once: with a token, and with the password when the
// server takes no token. It returns the sign-in that worked.
func subsonicPing(ctx context.Context, c subsonicCreds) (subsonicCreds, error) {
	c.Plain = false
	err := newSubsonicClient(c).call(ctx, "ping", nil, nil)
	var se *subsonicError
	if errors.As(err, &se) && se.Code == 41 {
		c.Plain = true
		err = newSubsonicClient(c).call(ctx, "ping", nil, nil)
	}
	return c, err
}

// POST /subsonicauth/login {server, username, password} -> {ok, username}
func handleSubsonicAuthLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Server   string `json:"server"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	server, err := normalizeSubsonicServer(body.Server)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err.Error())
		return
	}
	user := strings.TrimSpace(body.Username)
	// A password is taken as typed: spaces in it are its own.
	if user == "" || body.Password == "" || strings.ContainsAny(user+body.Password, "\n\r") {
		httpErr(w, http.StatusBadRequest, "username and password required")
		return
	}
	c, err := subsonicPing(r.Context(), subsonicCreds{Server: server, User: user, Password: body.Password})
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := writeSecret(subsonicAuthPath, c.encode()); err != nil {
		httpErr(w, http.StatusInternalServerError, "the sign-in could not be kept")
		return
	}
	loadSubsonic()
	host := server
	if u, err := url.Parse(server); err == nil {
		host = u.Host
	}
	writeJSON(w, map[string]interface{}{"ok": true, "username": user + "@" + host})
}

// --- browsing (libraryBrowser, browse.go) ------------------------------------

// subsonicAlbum is an album ("AlbumID3") as getArtist and getAlbumList2 give it.
type subsonicAlbum struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Artist    string `json:"artist"`
	ArtistID  string `json:"artistId"`
	Year      int    `json:"year"`
	CoverArt  string `json:"coverArt"`
	SongCount int    `json:"songCount"`
}

func subsonicAlbums(in []subsonicAlbum) []providerAlbum {
	out := []providerAlbum{}
	for _, a := range in {
		if a.ID == "" {
			continue
		}
		out = append(out, providerAlbum{ID: a.ID, Provider: "subsonic", Name: a.Name, Artist: a.Artist, ArtistID: a.ArtistID,
			Year: a.Year, Thumbnail: subsonicArtURL(a.CoverArt), Tracks: a.SongCount})
		if len(out) == maxAlbums {
			break
		}
	}
	return out
}

// Artists is the ID3 artist index (getArtists), the server's own order kept:
// it sorts as its users set it up (articles ignored and the like).
func (p *subsonicProvider) Artists(ctx context.Context) ([]providerArtist, error) {
	var r struct {
		Artists struct {
			Index []struct {
				Artist []struct {
					ID         string `json:"id"`
					Name       string `json:"name"`
					AlbumCount int    `json:"albumCount"`
					CoverArt   string `json:"coverArt"`
				} `json:"artist"`
			} `json:"index"`
		} `json:"artists"`
	}
	if err := p.cl.call(ctx, "getArtists", nil, &r); err != nil {
		return nil, err
	}
	out := []providerArtist{}
	for _, ix := range r.Artists.Index {
		for _, a := range ix.Artist {
			if a.ID == "" {
				continue
			}
			out = append(out, providerArtist{ID: a.ID, Provider: "subsonic", Name: a.Name,
				Thumbnail: subsonicArtURL(a.CoverArt), Albums: a.AlbumCount})
			if len(out) == maxArtists {
				return out, nil
			}
		}
	}
	return out, nil
}

func (p *subsonicProvider) ArtistAlbums(ctx context.Context, artistID string) ([]providerAlbum, error) {
	v := url.Values{}
	v.Set("id", artistID)
	var r struct {
		Artist struct {
			Album []subsonicAlbum `json:"album"`
		} `json:"artist"`
	}
	if err := p.cl.call(ctx, "getArtist", v, &r); err != nil {
		return nil, err
	}
	return subsonicAlbums(r.Artist.Album), nil
}

func (p *subsonicProvider) AlbumTracks(ctx context.Context, albumID string) ([]providerTrack, error) {
	v := url.Values{}
	v.Set("id", albumID)
	var r struct {
		Album struct {
			Song []subsonicSong `json:"song"`
		} `json:"album"`
	}
	if err := p.cl.call(ctx, "getAlbum", v, &r); err != nil {
		return nil, err
	}
	return subsonicTracks(r.Album.Song, maxAlbumTracks), nil
}

// subsonicListTypes names albumLists in getAlbumList2's words.
var subsonicListTypes = map[string]string{
	"newest": "newest", "recent": "recent", "frequent": "frequent", "random": "random", "alphabetical": "alphabeticalByName",
}

func (p *subsonicProvider) Albums(ctx context.Context, list string) ([]providerAlbum, error) {
	typ, ok := subsonicListTypes[list]
	if !ok {
		return nil, fmt.Errorf("subsonic: no album list %q", list)
	}
	v := url.Values{}
	v.Set("type", typ)
	v.Set("size", strconv.Itoa(albumListSize))
	var r struct {
		List struct {
			Album []subsonicAlbum `json:"album"`
		} `json:"albumList2"`
	}
	if err := p.cl.call(ctx, "getAlbumList2", v, &r); err != nil {
		return nil, err
	}
	return subsonicAlbums(r.List.Album), nil
}
