package main

// Internet radio: the stations of Radio Browser (radio-browser.info, a free
// directory of about 50 000 stations kept by its users), and the user's own
// station lists (M3U or PLS playlists at an address they gave).
//
// The app shows them as playlists, so they need no screens of their own:
// Radio Browser's most played and most voted stations, those of the user's
// country and a few genres, then a playlist for each of the user's lists (one
// per group, when a list has groups). Search looks in both. A station is a
// track without a length.
//
// Radio Browser asks its users to pick a server from the DNS name
// all.api.radio-browser.info (in random order, the next one when one fails),
// to send a User-Agent that names the app, and to count a click on
// /json/url/<stationuuid> each time a station is played, which ranks the
// popular ones. See https://api.radio-browser.info.
//
// Tracks: "radio:rb.<stationuuid>" for a Radio Browser station, and
// "radio:u.<base64url of the stream address>" for a station of the user's
// lists, so a station kept in a playlist of the app still plays after its list
// changed.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	radioListsFile = spotifyDataDir + "/radio-lists"
	radioUserAgent = "LuneOS-Music/1.0"
	// The name every Radio Browser server is under, and the one to use when
	// the lookup fails.
	radioDNSName      = "all.api.radio-browser.info"
	radioFallbackHost = "de1.api.radio-browser.info"
	// The most of the user's lists kept, of stations taken from one list, and
	// of the bytes read of one.
	radioMaxLists     = 20
	radioMaxStations  = 5000
	radioMaxListBytes = 4 << 20
	// How long what Radio Browser and the user's lists answered is kept.
	radioCacheTTL   = 10 * time.Minute
	radioServersTTL = time.Hour
	// Stations in one of Radio Browser's playlists.
	radioListSize = 100
)

// radioGenres are the genres offered as playlists: Radio Browser's tags with
// the most stations that name a kind of music or radio (its biggest tags,
// "music" and "radio", say nothing).
var radioGenres = []struct{ Tag, Name string }{
	{"pop", "Pop"}, {"rock", "Rock"}, {"news", "News"}, {"jazz", "Jazz"}, {"classical", "Classical"},
	{"dance", "Dance"}, {"electronic", "Electronic"}, {"talk", "Talk"}, {"hits", "Hits"}, {"oldies", "Oldies"},
}

// Variables for the tests.
var (
	radioListsPath = radioListsFile
	radioHTTP      = &http.Client{Timeout: 15 * time.Second}
	// radioServers gives the Radio Browser servers' base URLs, in the order to
	// try them.
	radioServers = lookupRadioServers
	// radioCountry gives the user's country (ISO 3166-1 alpha-2), "" when it
	// is not known.
	radioCountry = systemCountry
	// radioClick counts a click; asynchronous in the daemon.
	radioClick = func(uuid string) { go radioCountClick(uuid) }
)

var (
	radioServersMu sync.Mutex
	radioServersAt time.Time
	radioServerSet []string
)

// lookupRadioServers is every server behind radioDNSName, by name (HTTPS needs
// the name), shuffled; the fallback server alone when the lookup finds none.
// Kept for radioServersTTL.
func lookupRadioServers() []string {
	radioServersMu.Lock()
	defer radioServersMu.Unlock()
	if len(radioServerSet) > 0 && time.Since(radioServersAt) < radioServersTTL {
		return append([]string(nil), radioServerSet...)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	seen := map[string]bool{}
	names := []string{}
	addrs, _ := net.DefaultResolver.LookupHost(ctx, radioDNSName)
	for _, a := range addrs {
		hosts, err := net.DefaultResolver.LookupAddr(ctx, a)
		if err != nil {
			continue
		}
		for _, h := range hosts {
			h = strings.TrimSuffix(h, ".")
			if strings.HasSuffix(h, ".api.radio-browser.info") && !seen[h] {
				seen[h] = true
				names = append(names, h)
			}
		}
	}
	rand.Shuffle(len(names), func(i, j int) { names[i], names[j] = names[j], names[i] })
	if !seen[radioFallbackHost] {
		names = append(names, radioFallbackHost)
	}
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = "https://" + n
	}
	radioServerSet, radioServersAt = out, time.Now()
	return append([]string(nil), out...)
}

// radioGet asks Radio Browser for path (with query), each server in turn until
// one answers, and decodes its JSON into out.
func radioGet(ctx context.Context, path string, query url.Values, out interface{}) error {
	var last error = errors.New("no server")
	for _, base := range radioServers() {
		u := base + path
		if len(query) > 0 {
			u += "?" + query.Encode()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return fmt.Errorf("radio: bad request")
		}
		req.Header.Set("User-Agent", radioUserAgent)
		resp, err := radioHTTP.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("radio: Radio Browser did not answer in time")
			}
			last = err
			continue
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK {
			last = fmt.Errorf("HTTP %d", resp.StatusCode)
			continue
		}
		if err := json.Unmarshal(body, out); err != nil {
			last = errors.New("unreadable answer")
			continue
		}
		return nil
	}
	return fmt.Errorf("radio: Radio Browser cannot be reached (%v)", last)
}

// radioStation is a station as Radio Browser gives it.
type radioStation struct {
	UUID        string `json:"stationuuid"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	URLResolved string `json:"url_resolved"`
	Favicon     string `json:"favicon"`
	Tags        string `json:"tags"`
	Country     string `json:"country"`
	CountryCode string `json:"countrycode"`
	Codec       string `json:"codec"`
	Bitrate     int    `json:"bitrate"`
	LastCheckOK int    `json:"lastcheckok"`
}

// isWebLink: an http(s) address with a host, the only kind a station plays
// from or shows a picture from.
func isWebLink(s string) bool {
	if len(s) > 2048 {
		return false
	}
	u, err := url.Parse(strings.TrimSpace(s))
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// radioUUID: what Radio Browser's station ids look like.
var radioUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// radioDetails is what a station's "album" says: its codec and bitrate,
// "MP3 · 128 kbps".
func radioDetails(codec string, bitrate int) string {
	codec = strings.TrimSpace(codec)
	if strings.EqualFold(codec, "unknown") {
		codec = ""
	}
	parts := []string{}
	if codec != "" {
		parts = append(parts, codec)
	}
	if bitrate > 0 {
		parts = append(parts, strconv.Itoa(bitrate)+" kbps")
	}
	if len(parts) == 0 {
		return "Internet radio"
	}
	return strings.Join(parts, " · ")
}

// radioTracks are the stations as tracks: the ones that play (a stream
// address, not failing Radio Browser's last check), once each, up to max.
func radioTracks(in []radioStation, max int) []providerTrack {
	out := []providerTrack{}
	seen := map[string]bool{}
	for _, s := range in {
		if !radioUUID.MatchString(s.UUID) || seen[s.UUID] || s.LastCheckOK == 0 {
			continue
		}
		if !isWebLink(s.URLResolved) && !isWebLink(s.URL) {
			continue
		}
		seen[s.UUID] = true
		name := strings.TrimSpace(s.Name)
		if name == "" {
			name = "Radio station"
		}
		artist := strings.TrimSpace(s.Country)
		if artist == "" {
			artist = strings.ToUpper(s.CountryCode)
		}
		thumb := ""
		if isWebLink(s.Favicon) {
			thumb = strings.TrimSpace(s.Favicon)
		}
		out = append(out, providerTrack{ID: "rb." + s.UUID, Provider: "radio", Title: name, Artist: artist,
			Album: radioDetails(s.Codec, s.Bitrate), Thumbnail: thumb, Path: "radio:rb." + s.UUID})
		if len(out) == max {
			break
		}
	}
	return out
}

// --- the user's station lists ---------------------------------------------

// radioEntry is a station of a list.
type radioEntry struct {
	Name, URL, Logo, Group string
}

var (
	extinfAttr = regexp.MustCompile(`([a-zA-Z0-9_-]+)="([^"]*)"`)
	plsKey     = regexp.MustCompile(`(?i)^(file|title)(\d+)$`)
)

// parseRadioList reads an M3U (plain or extended, as IPTV-style lists write
// it) or PLS playlist: its stations, relative addresses resolved against base.
// What is not http(s) is left out.
func parseRadioList(body []byte, base *url.URL) []radioEntry {
	text := strings.TrimPrefix(string(body), "\ufeff")
	if strings.HasPrefix(strings.TrimSpace(strings.ToLower(text)), "[playlist]") {
		return parsePLS(text, base)
	}
	out := []radioEntry{}
	var cur radioEntry
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() && len(out) < radioMaxStations {
		line := strings.TrimSpace(sc.Text())
		switch {
		case line == "":
		case strings.HasPrefix(line, "#EXTINF:"):
			cur = radioEntry{}
			info := line[len("#EXTINF:"):]
			// The name is after the first comma outside the attributes' quotes.
			inQuote := false
			for i, r := range info {
				if r == '"' {
					inQuote = !inQuote
				} else if r == ',' && !inQuote {
					cur.Name = strings.TrimSpace(info[i+1:])
					info = info[:i]
					break
				}
			}
			for _, m := range extinfAttr.FindAllStringSubmatch(info, -1) {
				switch strings.ToLower(m[1]) {
				case "tvg-logo", "logo":
					cur.Logo = m[2]
				case "group-title":
					cur.Group = strings.TrimSpace(m[2])
				case "tvg-name":
					if cur.Name == "" {
						cur.Name = strings.TrimSpace(m[2])
					}
				}
			}
		case strings.HasPrefix(line, "#EXTGRP:"):
			cur.Group = strings.TrimSpace(line[len("#EXTGRP:"):])
		case strings.HasPrefix(line, "#"):
		default:
			if e, ok := radioEntryAt(cur, line, base); ok {
				out = append(out, e)
			}
			cur = radioEntry{}
		}
	}
	return out
}

func parsePLS(text string, base *url.URL) []radioEntry {
	files := map[int]string{}
	titles := map[int]string{}
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		m := plsKey.FindStringSubmatch(strings.TrimSpace(k))
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(m[2])
		if strings.EqualFold(m[1], "file") {
			files[n] = strings.TrimSpace(v)
		} else {
			titles[n] = strings.TrimSpace(v)
		}
	}
	nums := make([]int, 0, len(files))
	for n := range files {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	out := []radioEntry{}
	for _, n := range nums {
		if e, ok := radioEntryAt(radioEntry{Name: titles[n]}, files[n], base); ok {
			out = append(out, e)
			if len(out) == radioMaxStations {
				break
			}
		}
	}
	return out
}

// radioEntryAt is e playing from addr (resolved against base), if that is a
// web address.
func radioEntryAt(e radioEntry, addr string, base *url.URL) (radioEntry, bool) {
	addr = strings.TrimSpace(addr)
	// No address has spaces or markup in it: a line of a web page.
	if strings.ContainsAny(addr, " \t<>\"") {
		return e, false
	}
	u, err := url.Parse(addr)
	if err != nil {
		return e, false
	}
	if base != nil {
		u = base.ResolveReference(u)
	}
	if !isWebLink(u.String()) {
		return e, false
	}
	e.URL = u.String()
	if l, err := url.Parse(strings.TrimSpace(e.Logo)); err == nil && e.Logo != "" {
		if base != nil {
			l = base.ResolveReference(l)
		}
		e.Logo = l.String()
	}
	if !isWebLink(e.Logo) {
		e.Logo = ""
	}
	if e.Name == "" {
		e.Name = streamTitle(u)
	}
	return e, true
}

// streamTitle names a station by its address when its list does not: the
// last part of the path, else the host.
func streamTitle(u *url.URL) string {
	p := strings.Trim(u.Path, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		p = p[i+1:]
	}
	if p != "" {
		return p
	}
	return u.Hostname()
}

// readRadioLists is the user's list addresses, in the order added.
func readRadioLists() []string {
	b, err := os.ReadFile(radioListsPath)
	if err != nil {
		return nil
	}
	out := []string{}
	for _, l := range strings.Split(string(b), "\n") {
		if l = strings.TrimSpace(l); isWebLink(l) {
			out = append(out, l)
		}
	}
	return out
}

func encodeRadioLists(lists []string) []byte {
	if len(lists) == 0 {
		return nil
	}
	return []byte(strings.Join(lists, "\n") + "\n")
}

// looksLikeAudio: what a station's address answers is the stream itself, not a
// list (the user gave a station's own address as their list).
func looksLikeAudio(contentType string) bool {
	ct := strings.ToLower(contentType)
	if strings.Contains(ct, "mpegurl") || strings.Contains(ct, "scpls") {
		return false
	}
	return strings.HasPrefix(ct, "audio/") || strings.HasPrefix(ct, "application/ogg")
}

// radioCached is a list's stations, as last read.
type radioCached struct {
	at      time.Time
	entries []radioEntry
	err     error
}

// rbCached is one of Radio Browser's playlists, as last read.
type rbCached struct {
	at     time.Time
	tracks []providerTrack
}

type radioProvider struct {
	mu    sync.Mutex
	lists map[string]radioCached // list address -> its stations
	rb    map[string]rbCached    // a Radio Browser playlist id -> its stations
}

func newRadioProvider() *radioProvider {
	return &radioProvider{lists: map[string]radioCached{}, rb: map[string]rbCached{}}
}

func (p *radioProvider) ID() string   { return "radio" }
func (p *radioProvider) Name() string { return "Internet Radio" }

// listEntries is the stations of the list at addr, from the cache while fresh.
func (p *radioProvider) listEntries(ctx context.Context, addr string) ([]radioEntry, error) {
	p.mu.Lock()
	c, ok := p.lists[addr]
	p.mu.Unlock()
	if ok && time.Since(c.at) < radioCacheTTL {
		return c.entries, c.err
	}
	entries, err := loadRadioList(ctx, addr)
	p.mu.Lock()
	p.lists[addr] = radioCached{at: time.Now(), entries: entries, err: err}
	p.mu.Unlock()
	return entries, err
}

// loadRadioList reads and parses a list; a station's own address counts as a
// list of that one station.
func loadRadioList(ctx context.Context, addr string) ([]radioEntry, error) {
	u, err := url.Parse(addr)
	if err != nil || !isWebLink(addr) {
		return nil, errors.New("that is not a web address")
	}
	b, ct, err := radioFetchHead(ctx, addr)
	if err != nil {
		return nil, err
	}
	if looksLikeAudio(ct) {
		return []radioEntry{{Name: streamTitle(u), URL: addr}}, nil
	}
	if strings.HasPrefix(strings.ToLower(ct), "text/html") {
		return nil, errors.New("it is a web page, not an M3U or PLS playlist")
	}
	entries := parseRadioList(b, u)
	if len(entries) == 0 {
		return nil, errors.New("it has no stations: it is not an M3U or PLS playlist")
	}
	return entries, nil
}

// radioFetchHead reads a list, or only the first bytes of what turns out to
// be a stream (a stream never ends).
func radioFetchHead(ctx context.Context, addr string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, nil)
	if err != nil {
		return nil, "", errors.New("that is not a web address")
	}
	req.Header.Set("User-Agent", radioUserAgent)
	resp, err := radioHTTP.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, "", fmt.Errorf("it cannot be reached (%v)", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("it answered HTTP %d", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if looksLikeAudio(ct) {
		return nil, ct, nil
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, radioMaxListBytes))
	if err != nil {
		return nil, "", errors.New("it could not be read")
	}
	return b, ct, nil
}

// entryTrack is a station of a list as a track.
func entryTrack(e radioEntry, listName string) providerTrack {
	id := "u." + base64.RawURLEncoding.EncodeToString([]byte(e.URL))
	return providerTrack{ID: id, Provider: "radio", Title: e.Name, Artist: listName, Album: "Internet radio",
		Thumbnail: e.Logo, Path: "radio:" + id}
}

// listName names a list by its address: the file's name without its
// extension, else the host.
func listName(addr string) string {
	u, err := url.Parse(addr)
	if err != nil {
		return addr
	}
	n := streamTitle(u)
	if i := strings.LastIndex(n, "."); i > 0 {
		n = n[:i]
	}
	if n == "" {
		return u.Hostname()
	}
	return n
}

func (p *radioProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	// The user's own stations first: they are the ones they look for.
	out := []providerTrack{}
	q := strings.ToLower(query)
	for _, addr := range readRadioLists() {
		entries, _ := p.listEntries(ctx, addr)
		for _, e := range entries {
			if strings.Contains(strings.ToLower(e.Name), q) {
				out = append(out, entryTrack(e, listName(addr)))
				if len(out) == limit {
					return out, nil
				}
			}
		}
	}
	v := url.Values{}
	v.Set("name", query)
	v.Set("limit", strconv.Itoa(limit-len(out)))
	v.Set("hidebroken", "true")
	v.Set("order", "clickcount")
	v.Set("reverse", "true")
	var st []radioStation
	if err := radioGet(ctx, "/json/stations/search", v, &st); err != nil {
		if len(out) > 0 {
			return out, nil
		}
		return nil, err
	}
	return append(out, radioTracks(st, limit-len(out))...), nil
}

// StreamURL is the station's stream. A Radio Browser station is asked for
// again (its address may have changed since it was kept) and its play
// counted; a station's own playlist file is opened for its stream, which
// GStreamer plays where it plays no playlist.
func (p *radioProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	var addr string
	switch {
	case strings.HasPrefix(trackID, "rb."):
		uuid := strings.TrimPrefix(trackID, "rb.")
		if !radioUUID.MatchString(uuid) {
			return "", errors.New("radio: not a station")
		}
		v := url.Values{}
		v.Set("uuids", uuid)
		var st []radioStation
		if err := radioGet(ctx, "/json/stations/byuuid", v, &st); err != nil {
			return "", err
		}
		if len(st) == 0 {
			return "", errors.New("radio: Radio Browser no longer has this station")
		}
		addr = st[0].URLResolved
		if !isWebLink(addr) {
			addr = st[0].URL
		}
		if !isWebLink(addr) {
			return "", errors.New("radio: the station has no stream")
		}
		radioClick(uuid)
	case strings.HasPrefix(trackID, "u."):
		b, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(trackID, "u."))
		if err != nil || !isWebLink(string(b)) {
			return "", errors.New("radio: not a station")
		}
		addr = string(b)
	default:
		return "", errors.New("radio: not a station")
	}
	return unwrapStationPlaylist(ctx, addr), nil
}

// unwrapStationPlaylist is the first stream in a station's own .pls or .m3u
// file (not HLS's .m3u8, which GStreamer plays), or addr itself.
func unwrapStationPlaylist(ctx context.Context, addr string) string {
	u, err := url.Parse(addr)
	if err != nil {
		return addr
	}
	path := strings.ToLower(u.Path)
	if !strings.HasSuffix(path, ".pls") && !strings.HasSuffix(path, ".m3u") {
		return addr
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	b, ct, err := radioFetchHead(ctx, addr)
	if err != nil || looksLikeAudio(ct) {
		return addr
	}
	for _, e := range parseRadioList(b, u) {
		return e.URL
	}
	return addr
}

// radioCountClick tells Radio Browser a station was played.
func radioCountClick(uuid string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var r struct {
		OK bool `json:"ok"`
	}
	if err := radioGet(ctx, "/json/url/"+uuid, nil, &r); err != nil {
		log.Printf("radio: click not counted: %v", err)
	}
}

// --- playlists ---------------------------------------------------------------

// rbPlaylist is one of Radio Browser's lists offered as a playlist.
type rbPlaylist struct {
	ID, Name, Path string
	Query          url.Values
}

func (p *radioProvider) rbPlaylists() []rbPlaylist {
	top := url.Values{"hidebroken": {"true"}, "limit": {strconv.Itoa(radioListSize)}}
	out := []rbPlaylist{
		{"rb.top", "Most played", "/json/stations/topclick", top},
		{"rb.votes", "Most liked", "/json/stations/topvote", top},
	}
	if cc := radioCountry(); cc != "" {
		out = append(out, rbPlaylist{"rb.country." + cc, "Popular in " + cc, "/json/stations/search", url.Values{
			"countrycode": {cc}, "hidebroken": {"true"}, "order": {"clickcount"}, "reverse": {"true"},
			"limit": {strconv.Itoa(radioListSize)}}})
	}
	for _, g := range radioGenres {
		out = append(out, rbPlaylist{"rb.tag." + g.Tag, g.Name, "/json/stations/search", url.Values{
			"tagExact": {"true"}, "tag": {g.Tag}, "hidebroken": {"true"}, "order": {"clickcount"}, "reverse": {"true"},
			"limit": {strconv.Itoa(radioListSize)}}})
	}
	return out
}

// listGroups is the playlists of one of the user's lists: the whole list, or
// one per group when it has more than one.
func listGroups(entries []radioEntry) []string {
	groups := []string{}
	seen := map[string]bool{}
	for _, e := range entries {
		if !seen[e.Group] {
			seen[e.Group] = true
			groups = append(groups, e.Group)
		}
	}
	if len(groups) < 2 {
		return []string{""}
	}
	return groups
}

func listPlaylistID(i int, group string) string {
	id := "l" + strconv.Itoa(i)
	if group != "" {
		id += "." + base64.RawURLEncoding.EncodeToString([]byte(group))
	}
	return id
}

func (p *radioProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	out := []providerPlaylist{}
	for i, addr := range readRadioLists() {
		entries, err := p.listEntries(ctx, addr)
		if err != nil {
			log.Printf("radio: list %d: %v", i, err)
			continue
		}
		name := listName(addr)
		for _, g := range listGroups(entries) {
			n := 0
			for _, e := range entries {
				if g == "" || e.Group == g {
					n++
				}
			}
			title := name
			if g != "" {
				title = g
			}
			out = append(out, providerPlaylist{ID: listPlaylistID(i, g), Provider: "radio", Name: title, Owner: name, Tracks: n})
		}
	}
	for _, l := range p.rbPlaylists() {
		// How many stations it holds is not known before it is read:
		// up to radioListSize, of those Radio Browser has.
		out = append(out, providerPlaylist{ID: l.ID, Provider: "radio", Name: l.Name, Owner: "Radio Browser"})
	}
	if len(out) > maxPlaylists {
		out = out[:maxPlaylists]
	}
	return out, nil
}

func (p *radioProvider) PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error) {
	if strings.HasPrefix(playlistID, "rb.") {
		for _, l := range p.rbPlaylists() {
			if l.ID != playlistID {
				continue
			}
			p.mu.Lock()
			c, ok := p.rb[l.ID]
			p.mu.Unlock()
			if ok && time.Since(c.at) < radioCacheTTL {
				return c.tracks, nil
			}
			var st []radioStation
			if err := radioGet(ctx, l.Path, l.Query, &st); err != nil {
				return nil, err
			}
			tracks := radioTracks(st, radioListSize)
			p.mu.Lock()
			p.rb[l.ID] = rbCached{at: time.Now(), tracks: tracks}
			p.mu.Unlock()
			return tracks, nil
		}
		return nil, fmt.Errorf("radio: no playlist %q", playlistID)
	}
	idx, group, ok := parseListPlaylistID(playlistID)
	lists := readRadioLists()
	if !ok || idx >= len(lists) {
		return nil, fmt.Errorf("radio: no playlist %q", playlistID)
	}
	entries, err := p.listEntries(ctx, lists[idx])
	if err != nil {
		return nil, fmt.Errorf("radio: the list %v", err)
	}
	name := listName(lists[idx])
	out := []providerTrack{}
	for _, e := range entries {
		if group == "" || e.Group == group {
			out = append(out, entryTrack(e, name))
			if len(out) == maxPlaylistTracks {
				break
			}
		}
	}
	return out, nil
}

func parseListPlaylistID(id string) (int, string, bool) {
	if !strings.HasPrefix(id, "l") {
		return 0, "", false
	}
	num, group, hasGroup := strings.Cut(id[1:], ".")
	i, err := strconv.Atoi(num)
	if err != nil || i < 0 || strconv.Itoa(i) != num {
		return 0, "", false
	}
	if !hasGroup {
		return i, "", true
	}
	g, err := base64.RawURLEncoding.DecodeString(group)
	if err != nil || len(g) == 0 {
		return 0, "", false
	}
	return i, string(g), true
}

// --- the sign-in: the user's lists ----------------------------------------------

// POST /radioauth/lists {lists: [address]} -> {ok, lists: [{address, stations}]}
// Each new address is read before it is kept: it must be a playlist with
// stations, or a station's own stream. Addresses already kept stay; the order
// is the order added.
func handleRadioAuthLists(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Lists []string `json:"lists"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	kept := readRadioLists()
	have := map[string]bool{}
	for _, l := range kept {
		have[l] = true
	}
	type row struct {
		Address  string `json:"address"`
		Stations int    `json:"stations"`
	}
	added := []row{}
	p := currentRadio()
	for _, raw := range body.Lists {
		addr := strings.TrimSpace(raw)
		if addr == "" {
			continue
		}
		if !strings.Contains(addr, "://") {
			addr = "http://" + addr
		}
		if !isWebLink(addr) {
			httpErr(w, http.StatusBadRequest, "that is not a web address of a playlist")
			return
		}
		if u, _ := url.Parse(addr); u != nil && u.User != nil {
			httpErr(w, http.StatusBadRequest, "the address may not carry a user name or password")
			return
		}
		entries, err := loadRadioList(r.Context(), addr)
		if err != nil {
			httpErr(w, http.StatusBadGateway, "the playlist: "+err.Error())
			return
		}
		if p != nil {
			p.mu.Lock()
			p.lists[addr] = radioCached{at: time.Now(), entries: entries}
			p.mu.Unlock()
		}
		added = append(added, row{Address: addr, Stations: len(entries)})
		if !have[addr] {
			have[addr] = true
			kept = append(kept, addr)
		}
	}
	if len(kept) > radioMaxLists {
		httpErr(w, http.StatusBadRequest, "at most "+strconv.Itoa(radioMaxLists)+" lists")
		return
	}
	if len(added) > 0 {
		if err := writeSecret(radioListsPath, encodeRadioLists(kept)); err != nil {
			httpErr(w, http.StatusInternalServerError, "the list could not be kept")
			return
		}
	}
	writeJSON(w, map[string]interface{}{"ok": true, "lists": added})
}

func currentRadio() *radioProvider {
	providersMu.RLock()
	defer providersMu.RUnlock()
	p, _ := providers["radio"].(*radioProvider)
	return p
}

// systemCountry is the country of the system's locale ("nl-NL" -> "NL"), from
// the settings service, else from LANG.
func systemCountry() string {
	if m, err := lunaCall("luna://com.webos.settingsservice/getSystemSettings", `{"keys":["localeInfo"]}`); err == nil {
		if s, ok := m["settings"].(map[string]interface{}); ok {
			if li, ok := s["localeInfo"].(map[string]interface{}); ok {
				if ls, ok := li["locales"].(map[string]interface{}); ok {
					if c := localeCountry(fmt.Sprint(ls["UI"])); c != "" {
						return c
					}
				}
			}
		}
	}
	return localeCountry(os.Getenv("LANG"))
}

// localeCountry: "nl-NL", "en_US.UTF-8" -> "NL", "US"; "" without a country.
func localeCountry(locale string) string {
	locale, _, _ = strings.Cut(locale, ".")
	parts := strings.FieldsFunc(locale, func(r rune) bool { return r == '-' || r == '_' })
	for _, p := range parts[min(1, len(parts)):] {
		if len(p) == 2 && bytes.IndexFunc([]byte(p), func(r rune) bool { return r < 'A' || r > 'Z' }) < 0 {
			return p
		}
	}
	return ""
}
