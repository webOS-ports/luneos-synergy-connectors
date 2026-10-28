package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// deezerProvider: Deezer search is a public, no-auth API, so metadata + 30s previews
// work for everyone. FULL-track streaming needs a (free) Deezer account ARL in
// /media/cryptofs/spotify-webos/deezer-arl: Deezer streams are Blowfish-scrambled, so we can't hand
// the URL straight to gst — instead StreamURL points at a local /dzstream proxy that
// fetches + descrambles on the fly (reusing deezerDescramble) and serves plain audio.
type deezerProvider struct{ dl *deezerDL }

// package handle for the /dzstream proxy handler (set in main).
var dzDL *deezerDL

func (d *deezerProvider) ID() string   { return "deezer" }
func (d *deezerProvider) Name() string { return "Deezer" }

func (d *deezerProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	u := fmt.Sprintf("https://api.deezer.com/search?q=%s&limit=%d", url.QueryEscape(query), limit)
	body, err := httpGetString(ctx, u)
	if err != nil {
		return nil, err
	}
	var r struct {
		Data []struct {
			ID       int64  `json:"id"` // int64: Deezer IDs exceed 2^31 on 32-bit ARM
			Title    string `json:"title"`
			Duration int    `json:"duration"` // seconds
			Artist   struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				Cover string `json:"cover_medium"`
			} `json:"album"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return nil, fmt.Errorf("deezer parse: %w", err)
	}
	out := []providerTrack{}
	for _, t := range r.Data {
		if t.ID == 0 {
			continue
		}
		id := strconv.FormatInt(t.ID, 10)
		out = append(out, providerTrack{
			ID: id, Provider: "deezer", Title: t.Title, Artist: t.Artist.Name,
			Thumbnail: t.Album.Cover, DurationMs: t.Duration * 1000, Path: "deezer:" + id,
		})
	}
	return out, nil
}

// deezerAPIBase is Deezer's public API (replaceable by the tests).
var deezerAPIBase = "https://api.deezer.com"

type deezerPlaylistsPage struct {
	Data []struct {
		ID      int64  `json:"id"`
		Title   string `json:"title"`
		Tracks  int    `json:"nb_tracks"`
		Picture string `json:"picture_medium"`
		Creator struct {
			Name string `json:"name"`
		} `json:"creator"`
	} `json:"data"`
	Next  string          `json:"next"`
	Error json.RawMessage `json:"error"`
}

func deezerPlaylistsOf(page deezerPlaylistsPage) []providerPlaylist {
	out := []providerPlaylist{}
	for _, p := range page.Data {
		if p.ID == 0 {
			continue
		}
		out = append(out, providerPlaylist{
			ID: strconv.FormatInt(p.ID, 10), Provider: "deezer", Name: p.Title, Owner: p.Creator.Name,
			Thumbnail: p.Picture, Tracks: p.Tracks,
		})
	}
	return out
}

type deezerTracksPage struct {
	Data []struct {
		ID       int64  `json:"id"`
		Title    string `json:"title"`
		Duration int    `json:"duration"` // seconds
		Readable *bool  `json:"readable"`
		Artist   struct {
			Name string `json:"name"`
		} `json:"artist"`
		Album struct {
			Title string `json:"title"`
			Cover string `json:"cover_medium"`
		} `json:"album"`
	} `json:"data"`
	Next  string          `json:"next"`
	Error json.RawMessage `json:"error"`
}

// deezerTracksOf are the tracks of a playlist page Deezer plays here.
func deezerTracksOf(page deezerTracksPage) []providerTrack {
	out := []providerTrack{}
	for _, t := range page.Data {
		if t.ID == 0 || (t.Readable != nil && !*t.Readable) {
			continue
		}
		id := strconv.FormatInt(t.ID, 10)
		out = append(out, providerTrack{
			ID: id, Provider: "deezer", Title: t.Title, Artist: t.Artist.Name,
			Album: t.Album.Title, Thumbnail: t.Album.Cover, DurationMs: t.Duration * 1000, Path: "deezer:" + id,
		})
	}
	return out
}

// deezerPages pages through a public API list (limit/index/next) into page.
func deezerPages[T any](ctx context.Context, max, limit int, path string,
	parse func([]byte) ([]T, int, bool, error)) ([]T, error) {
	index := 0
	return pageAll(max, func(int) ([]T, bool, error) {
		body, err := httpGetString(ctx, fmt.Sprintf("%s/%s?limit=%d&index=%d", deezerAPIBase, path, limit, index))
		if err != nil {
			return nil, false, err
		}
		items, entries, more, err := parse([]byte(body))
		if err != nil {
			return nil, false, err
		}
		index += entries
		return items, more && entries > 0, nil
	})
}

// deezerErr is Deezer's {"error":{...}} as an error, nil for none.
func deezerErr(raw json.RawMessage) error {
	if e := strings.TrimSpace(string(raw)); e != "" && e != "null" {
		return fmt.Errorf("deezer: %s", e)
	}
	return nil
}

// Playlists: the user's playlists Deezer's public API shows - their public ones,
// with "Favourite tracks" (playlistSource). The account's sign-in says whose.
func (d *deezerProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	if d.dl == nil || !d.dl.Available() {
		return nil, fmt.Errorf("deezer: no account")
	}
	if err := d.dl.auth(ctx); err != nil {
		return nil, err
	}
	d.dl.mu.Lock()
	uid := d.dl.userID
	d.dl.mu.Unlock()
	return deezerPages(ctx, maxPlaylists, 50, fmt.Sprintf("user/%d/playlists", uid),
		func(body []byte) ([]providerPlaylist, int, bool, error) {
			var page deezerPlaylistsPage
			if err := json.Unmarshal(body, &page); err != nil {
				return nil, 0, false, fmt.Errorf("deezer playlists parse: %w", err)
			}
			if err := deezerErr(page.Error); err != nil {
				return nil, 0, false, err
			}
			return deezerPlaylistsOf(page), len(page.Data), page.Next != "", nil
		})
}

// PlaylistTracks: the playable tracks of one playlist, in its order.
func (d *deezerProvider) PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error) {
	return deezerPages(ctx, maxPlaylistTracks, 100, "playlist/"+url.PathEscape(playlistID)+"/tracks",
		func(body []byte) ([]providerTrack, int, bool, error) {
			var page deezerTracksPage
			if err := json.Unmarshal(body, &page); err != nil {
				return nil, 0, false, fmt.Errorf("deezer playlist parse: %w", err)
			}
			if err := deezerErr(page.Error); err != nil {
				return nil, 0, false, err
			}
			return deezerTracksOf(page), len(page.Data), page.Next != "", nil
		})
}

func (d *deezerProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	if d.dl != nil && d.dl.Available() {
		// full track via the local descrambling proxy
		return "http://127.0.0.1:8730/dzstream?id=" + url.QueryEscape(trackID), nil
	}
	// no ARL -> 30s preview (plain MP3, no descrambling)
	body, err := httpGetString(ctx, "https://api.deezer.com/track/"+url.PathEscape(trackID))
	if err != nil {
		return "", err
	}
	var t struct {
		Preview string `json:"preview"`
	}
	_ = json.Unmarshal([]byte(body), &t)
	if t.Preview == "" {
		return "", fmt.Errorf("deezer: no preview (full track needs a deezer-arl)")
	}
	return t.Preview, nil
}

// handleDzStream fetches a scrambled Deezer stream and serves it descrambled, so the
// gst stream player can play it. GET /dzstream?id=<deezerTrackID>.
func handleDzStream(w http.ResponseWriter, r *http.Request) {
	providersMu.RLock()
	dl := dzDL
	providersMu.RUnlock()
	if dl == nil || !dl.Available() {
		http.Error(w, "deezer not configured", http.StatusServiceUnavailable)
		return
	}
	id := r.URL.Query().Get("id")
	f, err := dl.FileURL(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "GET", f.URL, nil)
	resp, err := itHTTP.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	ct := "audio/mpeg"
	if strings.EqualFold(f.Format, "flac") {
		ct = "audio/flac"
	}
	w.Header().Set("Content-Type", ct)
	if f.DeezerKey != nil {
		if err := deezerDescramble(w, resp.Body, f.DeezerKey); err != nil {
			log.Printf("dzstream descramble: %v", err)
		}
		return
	}
	// unscrambled (shouldn't happen for Deezer) — passthrough
	_, _ = io.Copy(w, resp.Body)
}
