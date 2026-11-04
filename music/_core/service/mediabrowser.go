package main

// Jellyfin and Emby: the music on the user's own server, signed in in Videos
// (videoaccounts.go). One provider for both - Emby is where Jellyfin came from
// and answers the same calls - with what differs in a mediaVariant.
//
// Checked against Jellyfin Server 12.4.0 and Emby Server 4.10.2.0 (the
// vt-jellyfin and vt-emby test servers, 2026-11-04). The calls:
//
//	search    /Items?searchTerm=&IncludeItemTypes=Audio&Recursive=true
//	artists   /Artists/AlbumArtists
//	albums    /Items?IncludeItemTypes=MusicAlbum&Recursive=true (&AlbumArtistIds= for an artist's,
//	          SortBy for the lists)
//	tracks    /Items?ParentId=<album>&IncludeItemTypes=Audio
//	playlists /Items?IncludeItemTypes=Playlist&Recursive=true, /Playlists/{id}/Items
//	play      /Audio/{id}/stream?static=true: the file as it is
//	covers    /Items/{id}/Images/Primary
//
// Jellyfin takes the user as ?userId= on /Items; Emby has its items under
// /Users/{userId}/Items. Every request carries the token in the Authorization
// header ("MediaBrowser ..., Token="), so no URL holds it; the app gets this
// daemon's /mediastream and /mediaart, which add it.
//
// Credentials (Videos' credentials.common): { accessToken, server (origin +
// path, no trailing "/"), userId, deviceId, serverId, serverName, username }.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// mediaVariant is what differs between Jellyfin and Emby.
type mediaVariant struct {
	id, name string
	// itemsPath is where the user's items are; userQuery says whether the user
	// goes in the query instead.
	itemsPath func(userID string) string
	userQuery bool
}

var (
	jellyfinMusic = mediaVariant{id: "jellyfin", name: "Jellyfin",
		itemsPath: func(string) string { return "/Items" }, userQuery: true}
	embyMusic = mediaVariant{id: "emby", name: "Emby",
		itemsPath: func(u string) string { return "/Users/" + url.PathEscape(u) + "/Items" }}
)

const (
	// The client Videos signs in as: the token is that device's, so this
	// daemon says it is the same.
	mediaClientName    = "LuneOS Videos"
	mediaClientVersion = "1.0.0"
	ticksPerMs         = 10000
	mediaLocalBase     = "http://127.0.0.1:8730"
)

var (
	mediaHTTP       = &http.Client{Timeout: 20 * time.Second}
	mediaStreamHTTP = &http.Client{} // a whole track goes through it
)

// mediaID is what an item id may be: Jellyfin's are hex, Emby's numbers.
var mediaID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type mediaBrowserCreds struct {
	AccessToken string `json:"accessToken"`
	Server      string `json:"server"`
	UserID      string `json:"userId"`
	DeviceID    string `json:"deviceId"`
}

type mediaBrowserProvider struct {
	v     mediaVariant
	creds mediaBrowserCreds
}

// newMediaBrowserProvider is nil when the credentials cannot reach a server.
func newMediaBrowserProvider(v mediaVariant, raw json.RawMessage) MusicProvider {
	var c mediaBrowserCreds
	if json.Unmarshal(raw, &c) != nil || c.AccessToken == "" || c.UserID == "" {
		return nil
	}
	u, err := url.Parse(c.Server)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil
	}
	c.Server = strings.TrimRight(c.Server, "/")
	if c.DeviceID == "" {
		c.DeviceID = "luneos-music"
	}
	return &mediaBrowserProvider{v: v, creds: c}
}

func (p *mediaBrowserProvider) ID() string   { return p.v.id }
func (p *mediaBrowserProvider) Name() string { return p.v.name }

func (p *mediaBrowserProvider) authHeader() string {
	q := func(s string) string { return strings.NewReplacer(`"`, "", `\`, "", "\r", "", "\n", "").Replace(s) }
	return `MediaBrowser Client="` + mediaClientName + `", Device="LuneOS", DeviceId="` + q(p.creds.DeviceID) +
		`", Version="` + mediaClientVersion + `", Token="` + q(p.creds.AccessToken) + `"`
}

func (p *mediaBrowserProvider) request(ctx context.Context, rel string, q url.Values) (*http.Request, error) {
	u := p.creds.Server + rel
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("%s: bad server address", p.v.id)
	}
	req.Header.Set("Authorization", p.authHeader())
	req.Header.Set("Accept", "application/json")
	return req, nil
}

// mediaQuietErr is a request's failure without the URL it was for.
func mediaQuietErr(who string, err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("%s: the server did not answer in time", who)
	}
	return fmt.Errorf("%s: the server cannot be reached (%v)", who, err)
}

// mediaRefused is the error for a server's 401/403, which also makes the
// accounts be read again: Videos may have signed in anew.
func mediaRefused(name string) error {
	expireMediaAccounts()
	return fmt.Errorf("%s refused the sign-in: sign in to the server again in Videos", name)
}

func (p *mediaBrowserProvider) get(ctx context.Context, rel string, q url.Values, out interface{}) error {
	req, err := p.request(ctx, rel, q)
	if err != nil {
		return err
	}
	resp, err := mediaHTTP.Do(req)
	if err != nil {
		return mediaQuietErr(p.v.id, err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return mediaRefused(p.v.name)
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%s: not found on the server", p.v.id)
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("%s: the server answered HTTP %d", p.v.id, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return mediaQuietErr(p.v.id, err)
	}
	if json.Unmarshal(body, out) != nil {
		return fmt.Errorf("%s: unreadable answer", p.v.id)
	}
	return nil
}

// mbItem is an item as /Items gives it: a song, an album, an artist, a playlist.
type mbItem struct {
	ID                   string            `json:"Id"`
	Name                 string            `json:"Name"`
	Type                 string            `json:"Type"`
	MediaType            string            `json:"MediaType"`
	Album                string            `json:"Album"`
	AlbumID              string            `json:"AlbumId"`
	AlbumArtist          string            `json:"AlbumArtist"`
	Artists              []string          `json:"Artists"`
	AlbumArtists         []mbRef           `json:"AlbumArtists"`
	AlbumPrimaryImageTag string            `json:"AlbumPrimaryImageTag"`
	ImageTags            map[string]string `json:"ImageTags"`
	RunTimeTicks         int64             `json:"RunTimeTicks"`
	IndexNumber          int               `json:"IndexNumber"`
	ParentIndexNumber    int               `json:"ParentIndexNumber"`
	ProductionYear       int               `json:"ProductionYear"`
	ChildCount           int               `json:"ChildCount"`
	AlbumCount           int               `json:"AlbumCount"`
}

type mbRef struct {
	ID   string `json:"Id"`
	Name string `json:"Name"`
}

type mbItems struct {
	Items []mbItem `json:"Items"`
}

func (p *mediaBrowserProvider) artURL(id, tag string) string {
	if id == "" || tag == "" || !mediaID.MatchString(id) {
		return ""
	}
	return mediaLocalBase + "/mediaart?p=" + p.v.id + "&id=" + url.QueryEscape(id) + "&tag=" + url.QueryEscape(tag)
}

func (p *mediaBrowserProvider) tracks(items []mbItem, max int) []providerTrack {
	out := []providerTrack{}
	for _, it := range items {
		if it.Type != "Audio" || !mediaID.MatchString(it.ID) {
			continue
		}
		artist := strings.Join(it.Artists, ", ")
		if artist == "" {
			artist = it.AlbumArtist
		}
		art := p.artURL(it.AlbumID, it.AlbumPrimaryImageTag)
		if art == "" {
			art = p.artURL(it.ID, it.ImageTags["Primary"])
		}
		out = append(out, providerTrack{ID: it.ID, Provider: p.v.id, Title: it.Name, Artist: artist, Album: it.Album,
			Thumbnail: art, DurationMs: int(it.RunTimeTicks / ticksPerMs), Path: p.v.id + ":" + it.ID,
			Track: max0(it.IndexNumber), Disc: max0(it.ParentIndexNumber)})
		if len(out) == max {
			break
		}
	}
	return out
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

// items asks the user's items with q, the user added the way the server takes it.
func (p *mediaBrowserProvider) items(ctx context.Context, q url.Values) ([]mbItem, error) {
	if p.v.userQuery {
		q.Set("userId", p.creds.UserID)
	}
	var r mbItems
	if err := p.get(ctx, p.v.itemsPath(p.creds.UserID), q, &r); err != nil {
		return nil, err
	}
	return r.Items, nil
}

func (p *mediaBrowserProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := url.Values{}
	q.Set("searchTerm", query)
	q.Set("IncludeItemTypes", "Audio")
	q.Set("Recursive", "true")
	q.Set("Limit", strconv.Itoa(limit))
	items, err := p.items(ctx, q)
	if err != nil {
		return nil, err
	}
	return p.tracks(items, limit), nil
}

// StreamURL is this daemon's /mediastream for the song: the server's own needs the token.
func (p *mediaBrowserProvider) StreamURL(_ context.Context, trackID string) (string, error) {
	if !mediaID.MatchString(trackID) {
		return "", fmt.Errorf("%s: no such track", p.v.id)
	}
	return mediaLocalBase + "/mediastream?p=" + p.v.id + "&id=" + url.QueryEscape(trackID), nil
}

func (p *mediaBrowserProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	q := url.Values{}
	q.Set("IncludeItemTypes", "Playlist")
	q.Set("Recursive", "true")
	q.Set("Fields", "ChildCount")
	items, err := p.items(ctx, q)
	if err != nil {
		return nil, err
	}
	out := []providerPlaylist{}
	for _, it := range items {
		// A playlist of films is Videos', not ours.
		if it.Type != "Playlist" || !mediaID.MatchString(it.ID) || (it.MediaType != "" && it.MediaType != "Audio") {
			continue
		}
		out = append(out, providerPlaylist{ID: it.ID, Provider: p.v.id, Name: it.Name,
			Thumbnail: p.artURL(it.ID, it.ImageTags["Primary"]), Tracks: it.ChildCount})
		if len(out) == maxPlaylists {
			break
		}
	}
	return out, nil
}

func (p *mediaBrowserProvider) PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error) {
	if !mediaID.MatchString(playlistID) {
		return nil, fmt.Errorf("%s: no such playlist", p.v.id)
	}
	q := url.Values{}
	q.Set("userId", p.creds.UserID)
	var r mbItems
	if err := p.get(ctx, "/Playlists/"+playlistID+"/Items", q, &r); err != nil {
		return nil, err
	}
	return p.tracks(r.Items, maxPlaylistTracks), nil
}

// --- browsing (libraryBrowser, browse.go) ------------------------------------

func (p *mediaBrowserProvider) albums(items []mbItem) []providerAlbum {
	out := []providerAlbum{}
	for _, it := range items {
		if it.Type != "MusicAlbum" || !mediaID.MatchString(it.ID) {
			continue
		}
		a := providerAlbum{ID: it.ID, Provider: p.v.id, Name: it.Name, Artist: it.AlbumArtist, Year: it.ProductionYear,
			Thumbnail: p.artURL(it.ID, it.ImageTags["Primary"]), Tracks: it.ChildCount}
		if len(it.AlbumArtists) > 0 && mediaID.MatchString(it.AlbumArtists[0].ID) {
			a.ArtistID = it.AlbumArtists[0].ID
			if a.Artist == "" {
				a.Artist = it.AlbumArtists[0].Name
			}
		}
		out = append(out, a)
		if len(out) == maxAlbums {
			break
		}
	}
	return out
}

func (p *mediaBrowserProvider) Artists(ctx context.Context) ([]providerArtist, error) {
	q := url.Values{}
	q.Set(map[bool]string{true: "userId", false: "UserId"}[p.v.userQuery], p.creds.UserID)
	q.Set("SortBy", "SortName")
	q.Set("Fields", "ChildCount")
	q.Set("Limit", strconv.Itoa(maxArtists))
	var r mbItems
	if err := p.get(ctx, "/Artists/AlbumArtists", q, &r); err != nil {
		return nil, err
	}
	out := []providerArtist{}
	for _, it := range r.Items {
		if !mediaID.MatchString(it.ID) {
			continue
		}
		n := it.AlbumCount
		if n == 0 {
			n = it.ChildCount
		}
		out = append(out, providerArtist{ID: it.ID, Provider: p.v.id, Name: it.Name,
			Thumbnail: p.artURL(it.ID, it.ImageTags["Primary"]), Albums: n})
	}
	return out, nil
}

func (p *mediaBrowserProvider) albumQuery() url.Values {
	q := url.Values{}
	q.Set("IncludeItemTypes", "MusicAlbum")
	q.Set("Recursive", "true")
	q.Set("Fields", "ChildCount,ProductionYear")
	return q
}

func (p *mediaBrowserProvider) ArtistAlbums(ctx context.Context, artistID string) ([]providerAlbum, error) {
	if !mediaID.MatchString(artistID) {
		return nil, fmt.Errorf("%s: no such artist", p.v.id)
	}
	q := p.albumQuery()
	q.Set("AlbumArtistIds", artistID)
	q.Set("SortBy", "ProductionYear,SortName")
	items, err := p.items(ctx, q)
	if err != nil {
		return nil, err
	}
	return p.albums(items), nil
}

func (p *mediaBrowserProvider) AlbumTracks(ctx context.Context, albumID string) ([]providerTrack, error) {
	if !mediaID.MatchString(albumID) {
		return nil, fmt.Errorf("%s: no such album", p.v.id)
	}
	q := url.Values{}
	q.Set("ParentId", albumID)
	q.Set("IncludeItemTypes", "Audio")
	q.Set("Recursive", "true")
	q.Set("SortBy", "ParentIndexNumber,IndexNumber,SortName")
	items, err := p.items(ctx, q)
	if err != nil {
		return nil, err
	}
	return p.tracks(items, maxAlbumTracks), nil
}

// mbListSort: albumLists in the server's sort words, and the filter a list needs.
var mbListSort = map[string][3]string{
	"newest":       {"DateCreated,SortName", "Descending", ""},
	"recent":       {"DatePlayed,SortName", "Descending", "IsPlayed"},
	"frequent":     {"PlayCount,SortName", "Descending", "IsPlayed"},
	"random":       {"Random", "Ascending", ""},
	"alphabetical": {"SortName", "Ascending", ""},
}

func (p *mediaBrowserProvider) Albums(ctx context.Context, list string) ([]providerAlbum, error) {
	s, ok := mbListSort[list]
	if !ok {
		return nil, fmt.Errorf("%s: no album list %q", p.v.id, list)
	}
	q := p.albumQuery()
	q.Set("SortBy", s[0])
	q.Set("SortOrder", s[1])
	if s[2] != "" {
		q.Set("Filters", s[2])
	}
	q.Set("Limit", strconv.Itoa(albumListSize))
	items, err := p.items(ctx, q)
	if err != nil {
		return nil, err
	}
	return p.albums(items), nil
}

// --- the stream and cover proxy (/mediastream, /mediaart) ---------------------

// mediaProxied is a provider whose streams and covers this daemon fetches for
// the app, adding the sign-in.
type mediaProxied interface {
	streamRequest(ctx context.Context, id string) (*http.Request, error)
	artRequest(ctx context.Context, q url.Values) (*http.Request, error)
	Name() string
}

func (p *mediaBrowserProvider) streamRequest(ctx context.Context, id string) (*http.Request, error) {
	if !mediaID.MatchString(id) {
		return nil, errBadMediaID
	}
	q := url.Values{}
	q.Set("static", "true")
	return p.request(ctx, "/Audio/"+id+"/stream", q)
}

func (p *mediaBrowserProvider) artRequest(ctx context.Context, in url.Values) (*http.Request, error) {
	id := in.Get("id")
	if !mediaID.MatchString(id) {
		return nil, errBadMediaID
	}
	q := url.Values{}
	q.Set("maxHeight", strconv.Itoa(artSize(in)))
	q.Set("quality", "90")
	if t := in.Get("tag"); t != "" {
		q.Set("tag", t)
	}
	req, err := p.request(ctx, "/Items/"+id+"/Images/Primary", q)
	if req != nil {
		req.Header.Del("Accept")
	}
	return req, err
}

var errBadMediaID = errors.New("no such item")

// artSize is the cover size asked for, 300 pixels unless said otherwise.
func artSize(q url.Values) int {
	if n, err := strconv.Atoi(q.Get("size")); err == nil && n > 0 && n <= 2000 {
		return n
	}
	return 300
}

func mediaProxyOf(w http.ResponseWriter, r *http.Request) mediaProxied {
	id := r.URL.Query().Get("p")
	if _, ok := videoTemplatesByID()[id]; !ok {
		http.Error(w, "unknown server", http.StatusBadRequest)
		return nil
	}
	providersMu.RLock()
	p, _ := providers[id].(mediaProxied)
	providersMu.RUnlock()
	if p == nil {
		http.Error(w, id+" is not signed in", http.StatusServiceUnavailable)
		return nil
	}
	return p
}

// GET /mediastream?p=<jellyfin|emby|plex>&id=<track>: the song as the server
// has it. A Range from the player goes to the server, so seeking works.
func handleMediaStream(w http.ResponseWriter, r *http.Request) {
	p := mediaProxyOf(w, r)
	if p == nil {
		return
	}
	req, err := p.streamRequest(r.Context(), r.URL.Query().Get("id"))
	mediaProxy(w, r, p.Name(), req, err, mediaStreamHTTP)
}

// GET /mediaart?p=...&id=...: a cover, by default 300 pixels.
func handleMediaArt(w http.ResponseWriter, r *http.Request) {
	p := mediaProxyOf(w, r)
	if p == nil {
		return
	}
	req, err := p.artRequest(r.Context(), r.URL.Query())
	mediaProxy(w, r, p.Name(), req, err, mediaHTTP)
}

func mediaProxy(w http.ResponseWriter, r *http.Request, name string, req *http.Request, err error, cl *http.Client) {
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, errBadMediaID) {
			code = http.StatusBadRequest
		}
		http.Error(w, name+": "+err.Error(), code)
		return
	}
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	resp, err := cl.Do(req)
	if err != nil {
		http.Error(w, mediaQuietErr(name, err).Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		http.Error(w, mediaRefused(name).Error(), http.StatusBadGateway)
		return
	}
	if resp.StatusCode >= 400 {
		http.Error(w, fmt.Sprintf("%s: the server answered HTTP %d", name, resp.StatusCode), http.StatusBadGateway)
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
