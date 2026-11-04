package main

// Plex: the music on the user's Plex servers, signed in in Videos
// (videoaccounts.go) - through plex.tv (every server the account reaches) or
// at a server's address.
//
// Checked against Plex Media Server 1.43.5 (the vt-plex test server,
// 2026-11-04). The calls, on each server with a music library ("artist"
// section):
//
//	sections  /library/sections
//	search    /hubs/search?query= (its "track" hub)
//	artists   /library/sections/{key}/all?type=8
//	albums    /library/metadata/{artist}/children; the lists from
//	          /library/sections/{key}/all?type=9&sort=
//	tracks    /library/metadata/{album}/children
//	playlists /playlists?playlistType=audio, /playlists/{id}/items
//	play      the track's file (/library/parts/...), found through /library/metadata/{id}
//	covers    /photo/:/transcode?url=<thumb>
//
// A server can be reached at several addresses; as in Videos the local ones
// are tried first, the relay last, and the first that answers /identity is
// kept for ten minutes. The servers are the ones Videos saved with the
// account (Videos keeps that list current). Requests carry the token in
// X-Plex-Token, so no URL holds it; the app gets this daemon's /mediastream
// and /mediaart.
//
// An id here is "<server>.<Plex id>", the server being its machine id ("d"
// for an account at an address), so ids from two servers do not meet.
//
// Credentials (Videos' credentials.common):
//
//	plex.tv  { mode: "plextv", accessToken, clientId, username,
//	           servers: [{ id, name, owned, accessToken, connections: [{ uri, local, relay }] }] }
//	address  { mode: "direct", server, accessToken (may be ""), clientId, machineId, serverName }

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	plexConnTTL     = 10 * time.Minute
	plexSectionsTTL = 5 * time.Minute
	plexProbe       = 4 * time.Second
)

var (
	plexServerID = regexp.MustCompile(`^[A-Za-z0-9]{1,64}$`)
	plexKey      = regexp.MustCompile(`^[0-9]{1,20}$`)
	// A file on the server, as a track's Part key gives it.
	plexPartKey = regexp.MustCompile(`^/library/parts/[0-9]+/[^?#]*$`)
	// A picture on the server, as thumb/parentThumb give it.
	plexThumb = regexp.MustCompile(`^/library/metadata/[0-9]+/(thumb|art)(/[0-9]+)?$`)
)

type plexConn struct {
	URI   string `json:"uri"`
	Local bool   `json:"local"`
	Relay bool   `json:"relay"`
}

type plexServer struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	AccessToken string     `json:"accessToken"`
	Connections []plexConn `json:"connections"`
}

type plexMusicCreds struct {
	Mode        string       `json:"mode"`
	AccessToken string       `json:"accessToken"`
	ClientID    string       `json:"clientId"`
	Servers     []plexServer `json:"servers"`
	Server      string       `json:"server"`
	ServerName  string       `json:"serverName"`
}

type plexMusicProvider struct {
	clientID string
	servers  []plexServer // in the account's order

	mu       sync.Mutex
	conn     map[string]plexPicked // server id -> the address that answered
	sections map[string]plexSections
	parts    map[string]string // "<server>.<id>" -> the track's file
}

type plexPicked struct {
	uri string
	at  time.Time
}

type plexSections struct {
	keys []string
	at   time.Time
}

// newPlexMusicProvider is nil when the credentials hold no server to reach.
func newPlexMusicProvider(raw json.RawMessage) MusicProvider {
	var c plexMusicCreds
	if json.Unmarshal(raw, &c) != nil {
		return nil
	}
	p := &plexMusicProvider{clientID: c.ClientID, conn: map[string]plexPicked{}, sections: map[string]plexSections{},
		parts: map[string]string{}}
	if p.clientID == "" {
		p.clientID = "luneos-music"
	}
	if c.Mode == "direct" {
		if isWebLink(c.Server) {
			p.servers = []plexServer{{ID: "d", Name: c.ServerName, AccessToken: c.AccessToken,
				Connections: []plexConn{{URI: strings.TrimRight(c.Server, "/"), Local: true}}}}
		}
	} else {
		for _, s := range c.Servers {
			if !plexServerID.MatchString(s.ID) || s.ID == "d" {
				continue
			}
			if s.AccessToken == "" {
				s.AccessToken = c.AccessToken
			}
			conns := []plexConn{}
			for _, cn := range s.Connections {
				if isWebLink(cn.URI) {
					cn.URI = strings.TrimRight(cn.URI, "/")
					conns = append(conns, cn)
				}
			}
			if len(conns) == 0 {
				continue
			}
			// Local addresses first, then the server's own public ones, the relay last.
			rank := func(c plexConn) int {
				if c.Relay {
					return 2
				}
				if c.Local {
					return 0
				}
				return 1
			}
			sort.SliceStable(conns, func(i, j int) bool { return rank(conns[i]) < rank(conns[j]) })
			s.Connections = conns
			p.servers = append(p.servers, s)
		}
	}
	if len(p.servers) == 0 {
		return nil
	}
	return p
}

func (p *plexMusicProvider) ID() string   { return "plex" }
func (p *plexMusicProvider) Name() string { return "Plex" }

func (p *plexMusicProvider) server(id string) (plexServer, bool) {
	for _, s := range p.servers {
		if s.ID == id {
			return s, true
		}
	}
	return plexServer{}, false
}

func (p *plexMusicProvider) newRequest(ctx context.Context, s plexServer, base, rel string, q url.Values) (*http.Request, error) {
	u := base + rel
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, errors.New("bad server address")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Plex-Product", mediaClientName)
	req.Header.Set("X-Plex-Version", mediaClientVersion)
	req.Header.Set("X-Plex-Client-Identifier", p.clientID)
	req.Header.Set("X-Plex-Platform", "LuneOS")
	req.Header.Set("X-Plex-Device", "LuneOS")
	if s.AccessToken != "" {
		req.Header.Set("X-Plex-Token", s.AccessToken)
	}
	return req, nil
}

// base is the address of server s that answers, the one kept unless fresh.
func (p *plexMusicProvider) base(ctx context.Context, s plexServer, fresh bool) (string, error) {
	p.mu.Lock()
	hit, ok := p.conn[s.ID]
	p.mu.Unlock()
	if ok && !fresh && mediaNow().Sub(hit.at) < plexConnTTL {
		return hit.uri, nil
	}
	if len(s.Connections) == 1 {
		// Nothing to choose from: no probe, the request says whether it answers.
		return s.Connections[0].URI, nil
	}
	for _, c := range s.Connections {
		pctx, cancel := context.WithTimeout(ctx, plexProbe)
		req, err := p.newRequest(pctx, s, c.URI, "/identity", nil)
		if err == nil {
			var resp *http.Response
			if resp, err = mediaHTTP.Do(req); err == nil {
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					err = errors.New("no")
				}
			}
		}
		cancel()
		if err == nil {
			p.mu.Lock()
			p.conn[s.ID] = plexPicked{uri: c.URI, at: mediaNow()}
			p.mu.Unlock()
			return c.URI, nil
		}
	}
	p.mu.Lock()
	delete(p.conn, s.ID)
	p.mu.Unlock()
	return "", errors.New("plex: the server does not answer at any of its addresses")
}

// get asks server s; an address that stopped answering is dropped and the next tried, once.
func (p *plexMusicProvider) get(ctx context.Context, s plexServer, rel string, q url.Values, out interface{}) error {
	for try := 0; ; try++ {
		base, err := p.base(ctx, s, try > 0)
		if err != nil {
			return err
		}
		req, err := p.newRequest(ctx, s, base, rel, q)
		if err != nil {
			return err
		}
		resp, err := mediaHTTP.Do(req)
		if err != nil {
			if try == 0 && len(s.Connections) > 1 && ctx.Err() == nil {
				continue
			}
			return mediaQuietErr("plex", err)
		}
		defer resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
			return mediaRefused("Plex")
		case resp.StatusCode == http.StatusNotFound:
			return errors.New("plex: not found on the server")
		case resp.StatusCode != http.StatusOK:
			return fmt.Errorf("plex: the server answered HTTP %d", resp.StatusCode)
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		if err != nil {
			return mediaQuietErr("plex", err)
		}
		if json.Unmarshal(body, out) != nil {
			return errors.New("plex: unreadable answer")
		}
		return nil
	}
}

// plexMeta is an item of a MediaContainer: a track, an album, an artist, a playlist.
type plexMeta struct {
	RatingKey        string `json:"ratingKey"`
	Type             string `json:"type"`
	Title            string `json:"title"`
	ParentTitle      string `json:"parentTitle"`
	GrandparentTitle string `json:"grandparentTitle"`
	OriginalTitle    string `json:"originalTitle"`
	ParentRatingKey  string `json:"parentRatingKey"`
	Index            int    `json:"index"`
	ParentIndex      int    `json:"parentIndex"`
	Duration         int    `json:"duration"`
	Thumb            string `json:"thumb"`
	ParentThumb      string `json:"parentThumb"`
	Year             int    `json:"year"`
	LeafCount        int    `json:"leafCount"`
	ChildCount       int    `json:"childCount"`
	PlaylistType     string `json:"playlistType"`
	Media            []struct {
		Part []struct {
			Key string `json:"key"`
		} `json:"Part"`
	} `json:"Media"`
}

type plexContainer struct {
	MC struct {
		Metadata  []plexMeta `json:"Metadata"`
		Directory []struct {
			Key  string `json:"key"`
			Type string `json:"type"`
		} `json:"Directory"`
		Hub []struct {
			Type     string     `json:"type"`
			Metadata []plexMeta `json:"Metadata"`
		} `json:"Hub"`
	} `json:"MediaContainer"`
}

func (p *plexMusicProvider) artURL(sid, thumb string) string {
	if !plexThumb.MatchString(thumb) {
		return ""
	}
	return mediaLocalBase + "/mediaart?p=plex&s=" + sid + "&path=" + url.QueryEscape(thumb)
}

func (p *plexMusicProvider) tracks(sid string, in []plexMeta, max int) []providerTrack {
	out := []providerTrack{}
	for _, m := range in {
		if m.Type != "track" || !plexKey.MatchString(m.RatingKey) {
			continue
		}
		id := sid + "." + m.RatingKey
		if len(m.Media) > 0 && len(m.Media[0].Part) > 0 && plexPartKey.MatchString(m.Media[0].Part[0].Key) {
			p.mu.Lock()
			if len(p.parts) > 20000 {
				p.parts = map[string]string{}
			}
			p.parts[id] = m.Media[0].Part[0].Key
			p.mu.Unlock()
		}
		artist := m.OriginalTitle // the track's own artist on a compilation
		if artist == "" {
			artist = m.GrandparentTitle
		}
		thumb := m.ParentThumb
		if thumb == "" {
			thumb = m.Thumb
		}
		out = append(out, providerTrack{ID: id, Provider: "plex", Title: m.Title, Artist: artist, Album: m.ParentTitle,
			Thumbnail: p.artURL(sid, thumb), DurationMs: m.Duration, Path: "plex:" + id,
			Track: max0(m.Index), Disc: max0(m.ParentIndex)})
		if len(out) == max {
			break
		}
	}
	return out
}

func (p *plexMusicProvider) albums(sid string, in []plexMeta) []providerAlbum {
	out := []providerAlbum{}
	for _, m := range in {
		if m.Type != "album" || !plexKey.MatchString(m.RatingKey) {
			continue
		}
		a := providerAlbum{ID: sid + "." + m.RatingKey, Provider: "plex", Name: m.Title, Artist: m.ParentTitle,
			Year: m.Year, Thumbnail: p.artURL(sid, m.Thumb), Tracks: m.LeafCount}
		if plexKey.MatchString(m.ParentRatingKey) {
			a.ArtistID = sid + "." + m.ParentRatingKey
		}
		out = append(out, a)
	}
	return out
}

// split takes "<server>.<Plex id>" apart.
func (p *plexMusicProvider) split(id string) (plexServer, string, error) {
	i := strings.LastIndexByte(id, '.')
	if i < 0 {
		return plexServer{}, "", errBadMediaID
	}
	s, ok := p.server(id[:i])
	if !ok || !plexKey.MatchString(id[i+1:]) {
		return plexServer{}, "", errBadMediaID
	}
	return s, id[i+1:], nil
}

// musicSections are the keys of server s's music libraries.
func (p *plexMusicProvider) musicSections(ctx context.Context, s plexServer) ([]string, error) {
	p.mu.Lock()
	hit, ok := p.sections[s.ID]
	p.mu.Unlock()
	if ok && mediaNow().Sub(hit.at) < plexSectionsTTL {
		return hit.keys, nil
	}
	var r plexContainer
	if err := p.get(ctx, s, "/library/sections", nil, &r); err != nil {
		return nil, err
	}
	keys := []string{}
	for _, d := range r.MC.Directory {
		if d.Type == "artist" && plexKey.MatchString(d.Key) {
			keys = append(keys, d.Key)
		}
	}
	p.mu.Lock()
	p.sections[s.ID] = plexSections{keys: keys, at: mediaNow()}
	p.mu.Unlock()
	return keys, nil
}

// eachServer runs f on every server; a server that fails is left out, unless every one does.
func (p *plexMusicProvider) eachServer(f func(s plexServer) error) error {
	var first error
	ok := false
	for _, s := range p.servers {
		if err := f(s); err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		ok = true
	}
	if !ok {
		return first
	}
	return nil
}

func (p *plexMusicProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	out := []providerTrack{}
	err := p.eachServer(func(s plexServer) error {
		q := url.Values{}
		q.Set("query", query)
		q.Set("limit", strconv.Itoa(limit))
		var r plexContainer
		if err := p.get(ctx, s, "/hubs/search", q, &r); err != nil {
			return err
		}
		for _, h := range r.MC.Hub {
			// tracks keeps to the tracks: other hubs (films, artists) give none.
			if len(out) < limit {
				out = append(out, p.tracks(s.ID, h.Metadata, limit-len(out))...)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (p *plexMusicProvider) StreamURL(_ context.Context, trackID string) (string, error) {
	if _, _, err := p.split(trackID); err != nil {
		return "", errors.New("plex: no such track")
	}
	return mediaLocalBase + "/mediastream?p=plex&id=" + url.QueryEscape(trackID), nil
}

func (p *plexMusicProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	out := []providerPlaylist{}
	err := p.eachServer(func(s plexServer) error {
		q := url.Values{}
		q.Set("playlistType", "audio")
		var r plexContainer
		if err := p.get(ctx, s, "/playlists", q, &r); err != nil {
			return err
		}
		for _, m := range r.MC.Metadata {
			if m.Type != "playlist" || m.PlaylistType != "audio" || !plexKey.MatchString(m.RatingKey) || len(out) == maxPlaylists {
				continue
			}
			// No cover: Plex's is a collage made on the fly, not one of the pictures /mediaart passes on.
			out = append(out, providerPlaylist{ID: s.ID + "." + m.RatingKey, Provider: "plex", Name: m.Title,
				Tracks: m.LeafCount})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (p *plexMusicProvider) PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error) {
	s, key, err := p.split(playlistID)
	if err != nil {
		return nil, errors.New("plex: no such playlist")
	}
	var r plexContainer
	if err := p.get(ctx, s, "/playlists/"+key+"/items", nil, &r); err != nil {
		return nil, err
	}
	return p.tracks(s.ID, r.MC.Metadata, maxPlaylistTracks), nil
}

// --- browsing (libraryBrowser, browse.go) ------------------------------------

func (p *plexMusicProvider) Artists(ctx context.Context) ([]providerArtist, error) {
	out := []providerArtist{}
	err := p.eachServer(func(s plexServer) error {
		keys, err := p.musicSections(ctx, s)
		if err != nil {
			return err
		}
		for _, k := range keys {
			q := url.Values{}
			q.Set("type", "8")
			q.Set("sort", "titleSort")
			var r plexContainer
			if err := p.get(ctx, s, "/library/sections/"+k+"/all", q, &r); err != nil {
				return err
			}
			for _, m := range r.MC.Metadata {
				if m.Type != "artist" || !plexKey.MatchString(m.RatingKey) || len(out) == maxArtists {
					continue
				}
				out = append(out, providerArtist{ID: s.ID + "." + m.RatingKey, Provider: "plex", Name: m.Title,
					Thumbnail: p.artURL(s.ID, m.Thumb), Albums: m.ChildCount})
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (p *plexMusicProvider) ArtistAlbums(ctx context.Context, artistID string) ([]providerAlbum, error) {
	s, key, err := p.split(artistID)
	if err != nil {
		return nil, errors.New("plex: no such artist")
	}
	var r plexContainer
	if err := p.get(ctx, s, "/library/metadata/"+key+"/children", nil, &r); err != nil {
		return nil, err
	}
	return p.albums(s.ID, r.MC.Metadata), nil
}

func (p *plexMusicProvider) AlbumTracks(ctx context.Context, albumID string) ([]providerTrack, error) {
	s, key, err := p.split(albumID)
	if err != nil {
		return nil, errors.New("plex: no such album")
	}
	var r plexContainer
	if err := p.get(ctx, s, "/library/metadata/"+key+"/children", nil, &r); err != nil {
		return nil, err
	}
	return p.tracks(s.ID, r.MC.Metadata, maxAlbumTracks), nil
}

// plexListSort: albumLists in Plex's sort words.
var plexListSort = map[string]string{
	"newest": "addedAt:desc", "recent": "lastViewedAt:desc", "frequent": "viewCount:desc",
	"random": "random", "alphabetical": "titleSort",
}

func (p *plexMusicProvider) Albums(ctx context.Context, list string) ([]providerAlbum, error) {
	srt, ok := plexListSort[list]
	if !ok {
		return nil, fmt.Errorf("plex: no album list %q", list)
	}
	out := []providerAlbum{}
	err := p.eachServer(func(s plexServer) error {
		keys, err := p.musicSections(ctx, s)
		if err != nil {
			return err
		}
		for _, k := range keys {
			q := url.Values{}
			q.Set("type", "9")
			q.Set("sort", srt)
			if list == "recent" {
				q.Set("lastViewedAt>", "0")
			} else if list == "frequent" {
				q.Set("viewCount>", "0")
			}
			q.Set("X-Plex-Container-Start", "0")
			q.Set("X-Plex-Container-Size", strconv.Itoa(albumListSize))
			var r plexContainer
			if err := p.get(ctx, s, "/library/sections/"+k+"/all", q, &r); err != nil {
				return err
			}
			out = append(out, p.albums(s.ID, r.MC.Metadata)...)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(out) > albumListSize {
		out = out[:albumListSize]
	}
	return out, nil
}

// --- the stream and cover proxy (mediaProxied, mediabrowser.go) ---------------

func (p *plexMusicProvider) streamRequest(ctx context.Context, id string) (*http.Request, error) {
	s, key, err := p.split(id)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	part, ok := p.parts[s.ID+"."+key]
	p.mu.Unlock()
	if !ok {
		var r plexContainer
		if err := p.get(ctx, s, "/library/metadata/"+key, nil, &r); err != nil {
			return nil, err
		}
		for _, m := range r.MC.Metadata {
			if m.Type == "track" && len(m.Media) > 0 && len(m.Media[0].Part) > 0 && plexPartKey.MatchString(m.Media[0].Part[0].Key) {
				part, ok = m.Media[0].Part[0].Key, true
			}
		}
		if !ok {
			return nil, errors.New("the track has no file on the server")
		}
	}
	base, err := p.base(ctx, s, false)
	if err != nil {
		return nil, err
	}
	req, err := p.newRequest(ctx, s, base, part, nil)
	if req != nil {
		req.Header.Del("Accept")
	}
	return req, err
}

func (p *plexMusicProvider) artRequest(ctx context.Context, in url.Values) (*http.Request, error) {
	s, ok := p.server(in.Get("s"))
	thumb := in.Get("path")
	if !ok || !plexThumb.MatchString(thumb) {
		return nil, errBadMediaID
	}
	base, err := p.base(ctx, s, false)
	if err != nil {
		return nil, err
	}
	n := strconv.Itoa(artSize(in))
	q := url.Values{}
	q.Set("width", n)
	q.Set("height", n)
	q.Set("minSize", "1")
	q.Set("upscale", "1")
	q.Set("url", thumb)
	req, err := p.newRequest(ctx, s, base, "/photo/:/transcode", q)
	if req != nil {
		req.Header.Del("Accept")
	}
	return req, err
}
