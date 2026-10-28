package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// tdDL is the package handle for the /tidalstream proxy (set in main + on cred refresh).
var tdDL *tidalDL

// tidalProvider streams lossless from the user's Tidal account, reusing tidalDL auth
// + playbackinfo (FileURL). Tidal's LOSSLESS URLs are plain, so they go straight to
// the stream player. Registered only when a tidal-token cred file is present.
type tidalProvider struct{ dl *tidalDL }

func (p *tidalProvider) ID() string   { return "tidal" }
func (p *tidalProvider) Name() string { return "Tidal" }

func (p *tidalProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	cc := p.dl.countryCode()
	u := fmt.Sprintf("%s/search/tracks?query=%s&limit=%d&offset=0&countryCode=%s",
		tidalAPIBase, url.QueryEscape(query), limit, url.QueryEscape(cc))
	body, err := p.dl.authGet(ctx, u)
	if err != nil {
		return nil, err
	}
	var r struct {
		Items []struct {
			ID       json.Number `json:"id"`
			Title    string      `json:"title"`
			Duration int         `json:"duration"` // seconds
			Artist   struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				Title string `json:"title"`
				Cover string `json:"cover"`
			} `json:"album"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("tidal search parse: %w", err)
	}
	out := []providerTrack{}
	for _, it := range r.Items {
		id := it.ID.String()
		thumb := ""
		if it.Album.Cover != "" { // cover is a UUID with dashes -> path with slashes
			thumb = "https://resources.tidal.com/images/" + strings.ReplaceAll(it.Album.Cover, "-", "/") + "/320x320.jpg"
		}
		out = append(out, providerTrack{
			ID: id, Provider: "tidal", Title: it.Title, Artist: it.Artist.Name,
			Album: it.Album.Title, Thumbnail: thumb,
			DurationMs: it.Duration * 1000, Path: "tidal:" + id,
		})
	}
	return out, nil
}

// tidalImage is the URL of a Tidal image id (a UUID: its dashes are the path).
func tidalImage(id string) string {
	if id == "" {
		return ""
	}
	return "https://resources.tidal.com/images/" + strings.ReplaceAll(id, "-", "/") + "/320x320.jpg"
}

type tidalPlaylistsPage struct {
	TotalNumberOfItems int `json:"totalNumberOfItems"`
	Items              []struct {
		Playlist struct {
			UUID           string `json:"uuid"`
			Title          string `json:"title"`
			NumberOfTracks int    `json:"numberOfTracks"`
			SquareImage    string `json:"squareImage"`
			Creator        struct {
				Name string `json:"name"`
			} `json:"creator"`
		} `json:"playlist"`
	} `json:"items"`
}

func tidalPlaylistsOf(page tidalPlaylistsPage) []providerPlaylist {
	out := []providerPlaylist{}
	for _, it := range page.Items {
		pl := it.Playlist
		if pl.UUID == "" {
			continue
		}
		out = append(out, providerPlaylist{
			ID: pl.UUID, Provider: "tidal", Name: pl.Title, Owner: pl.Creator.Name,
			Thumbnail: tidalImage(pl.SquareImage), Tracks: pl.NumberOfTracks,
		})
	}
	return out
}

type tidalItemsPage struct {
	TotalNumberOfItems int `json:"totalNumberOfItems"`
	Items              []struct {
		Type string `json:"type"`
		Item struct {
			ID          json.Number `json:"id"`
			Title       string      `json:"title"`
			Duration    int         `json:"duration"` // seconds
			StreamReady *bool       `json:"streamReady"`
			Artist      struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				Title string `json:"title"`
				Cover string `json:"cover"`
			} `json:"album"`
		} `json:"item"`
	} `json:"items"`
}

// tidalTracksOf are the tracks of an items page that can be played: not videos,
// nor tracks Tidal no longer streams.
func tidalTracksOf(page tidalItemsPage) []providerTrack {
	out := []providerTrack{}
	for _, it := range page.Items {
		t := it.Item
		id := t.ID.String()
		if (it.Type != "" && it.Type != "track") || id == "" || id == "0" || (t.StreamReady != nil && !*t.StreamReady) {
			continue
		}
		out = append(out, providerTrack{
			ID: id, Provider: "tidal", Title: t.Title, Artist: t.Artist.Name,
			Album: t.Album.Title, Thumbnail: tidalImage(t.Album.Cover),
			DurationMs: t.Duration * 1000, Path: "tidal:" + id,
		})
	}
	return out
}

// tidalPages pages through a Tidal list (limit/offset/totalNumberOfItems), handing
// each page's body to parse (-> its items and how many entries it had).
func tidalPages[T any](ctx context.Context, p *tidalProvider, max, limit int, path string,
	parse func([]byte) ([]T, int, int, error)) ([]T, error) {
	offset := 0
	return pageAll(max, func(int) ([]T, bool, error) {
		body, err := p.dl.authGet(ctx, fmt.Sprintf("%s/%s?limit=%d&offset=%d&countryCode=%s",
			tidalAPIBase, path, limit, offset, url.QueryEscape(p.dl.countryCode())))
		if err != nil {
			return nil, false, err
		}
		items, entries, total, err := parse(body)
		if err != nil {
			return nil, false, err
		}
		offset += entries
		return items, entries > 0 && offset < total, nil
	})
}

// Playlists: the user's own playlists and the ones they favourited (playlistSource).
func (p *tidalProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	p.dl.mu.Lock()
	uid := p.dl.tok.UserID
	p.dl.mu.Unlock()
	if uid == 0 {
		return nil, fmt.Errorf("tidal: the sign-in has no user id")
	}
	return tidalPages(ctx, p, maxPlaylists, 50, fmt.Sprintf("users/%d/playlistsAndFavoritePlaylists", uid),
		func(body []byte) ([]providerPlaylist, int, int, error) {
			var page tidalPlaylistsPage
			if err := json.Unmarshal(body, &page); err != nil {
				return nil, 0, 0, fmt.Errorf("tidal playlists parse: %w", err)
			}
			return tidalPlaylistsOf(page), len(page.Items), page.TotalNumberOfItems, nil
		})
}

// PlaylistTracks: the playable tracks of one playlist, in its order.
func (p *tidalProvider) PlaylistTracks(ctx context.Context, playlistID string) ([]providerTrack, error) {
	return tidalPages(ctx, p, maxPlaylistTracks, 100, "playlists/"+url.PathEscape(playlistID)+"/items",
		func(body []byte) ([]providerTrack, int, int, error) {
			var page tidalItemsPage
			if err := json.Unmarshal(body, &page); err != nil {
				return nil, 0, 0, fmt.Errorf("tidal playlist parse: %w", err)
			}
			return tidalTracksOf(page), len(page.Items), page.TotalNumberOfItems, nil
		})
}

func (p *tidalProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	// Tidal LOSSLESS is a DASH manifest of fMP4/FLAC segments, so we can't hand a
	// single URL to gst — point it at the local proxy that reassembles the segments.
	return "http://127.0.0.1:8730/tidalstream?id=" + url.QueryEscape(trackID), nil
}

// handleTidalStream fetches a track's DASH (or BTS) segments and streams them
// concatenated, so the gst stream player plays Tidal HiFi. GET /tidalstream?id=<trackID>.
func handleTidalStream(w http.ResponseWriter, r *http.Request) {
	providersMu.RLock()
	dl := tdDL
	providersMu.RUnlock()
	if dl == nil || !dl.Available() {
		http.Error(w, "tidal not configured", http.StatusServiceUnavailable)
		return
	}
	spec, err := dl.streamSpec(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", spec.ContentType)
	if !spec.MP4FLAC {
		// BTS: a single native FLAC file — straight passthrough.
		for _, u := range spec.URLs {
			if fetchTo(r.Context(), w, u) != nil {
				return
			}
		}
		return
	}
	// DASH fMP4/FLAC: emit "fLaC" + STREAMINFO (from the init segment's dfLa box),
	// then the raw FLAC frames from each media segment's mdat — a native FLAC stream.
	if len(spec.URLs) < 2 {
		http.Error(w, "tidal: empty dash manifest", http.StatusBadGateway)
		return
	}
	initData, err := fetchBytes(r.Context(), spec.URLs[0])
	if err != nil {
		http.Error(w, "tidal init: "+err.Error(), http.StatusBadGateway)
		return
	}
	hdr := tidalFlacHeader(initData)
	if hdr == nil {
		http.Error(w, "tidal: no FLAC header in init segment", http.StatusBadGateway)
		return
	}
	if _, werr := w.Write(hdr); werr != nil {
		return
	}
	for _, u := range spec.URLs[1:] {
		seg, err := fetchBytes(r.Context(), u)
		if err != nil {
			return
		}
		for _, m := range tidalMdats(seg) {
			if _, werr := w.Write(m); werr != nil {
				return
			}
		}
	}
}

func fetchTo(ctx context.Context, w io.Writer, u string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, err = io.Copy(w, resp.Body)
	return err
}

func fetchBytes(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// mp4Box returns the payload (bytes after the 8-byte header) of the first top-level
// box of the given 4-char type within data, or nil.
func mp4Box(data []byte, typ string) []byte {
	off := 0
	for off+8 <= len(data) {
		sz := int(binary.BigEndian.Uint32(data[off:]))
		if sz < 8 || off+sz > len(data) {
			return nil
		}
		if string(data[off+4:off+8]) == typ {
			return data[off+8 : off+sz]
		}
		off += sz
	}
	return nil
}

// tidalFlacHeader builds the native FLAC header ("fLaC" + metadata blocks) from an
// init segment: moov/trak/mdia/minf/stbl/stsd -> fLaC sample entry -> dfLa.
func tidalFlacHeader(init []byte) []byte {
	p := init
	for _, t := range []string{"moov", "trak", "mdia", "minf", "stbl", "stsd"} {
		p = mp4Box(p, t)
		if p == nil {
			return nil
		}
	}
	if len(p) < 8 { // stsd: 4 version/flags + 4 entryCount, then the sample entry box
		return nil
	}
	fLaC := mp4Box(p[8:], "fLaC")
	if fLaC == nil || len(fLaC) < 28 { // 28 = AudioSampleEntry fixed fields
		return nil
	}
	dfLa := mp4Box(fLaC[28:], "dfLa")
	if dfLa == nil || len(dfLa) < 4 { // 4 = FullBox version/flags
		return nil
	}
	blocks := append([]byte(nil), dfLa[4:]...) // copy so we can set the last-block flag
	// Ensure the final metadata block has the last-block flag (0x80) set.
	off, last := 0, -1
	for off+4 <= len(blocks) {
		last = off
		off += 4 + (int(blocks[off+1])<<16 | int(blocks[off+2])<<8 | int(blocks[off+3]))
	}
	if last >= 0 {
		blocks[last] |= 0x80
	}
	return append([]byte("fLaC"), blocks...)
}

// tidalMdats returns the payloads of all top-level mdat boxes in a media segment
// (the raw FLAC frames).
func tidalMdats(seg []byte) [][]byte {
	var out [][]byte
	off := 0
	for off+8 <= len(seg) {
		sz := int(binary.BigEndian.Uint32(seg[off:]))
		if sz < 8 || off+sz > len(seg) {
			break
		}
		if string(seg[off+4:off+8]) == "mdat" {
			out = append(out, seg[off+8:off+sz])
		}
		off += sz
	}
	return out
}
