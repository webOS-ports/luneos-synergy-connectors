package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/oauth2"
)

func TestPageAllFollowsNextThroughEmptyPages(t *testing.T) {
	pages := [][]int{{1, 2}, {}, {3}, {4, 5}}
	asked := []int{}
	got, err := pageAll(100, func(collected int) ([]int, bool, error) {
		asked = append(asked, collected)
		p := pages[len(asked)-1]
		return p, len(asked) < len(pages), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []int{1, 2, 3, 4, 5}) {
		t.Errorf("got %v", got)
	}
	if !reflect.DeepEqual(asked, []int{0, 2, 2, 3}) {
		t.Errorf("asked with %v", asked)
	}
}

func TestPageAllStopsAtMaxAndOnErrors(t *testing.T) {
	got, err := pageAll(5, func(int) ([]int, bool, error) { return []int{1, 2, 3}, true, nil })
	if err != nil || len(got) != 5 {
		t.Errorf("max: got %v %v", got, err)
	}
	calls := 0
	// A service that keeps saying there is more: stopped at maxPages (it gives
	// up a little later itself, so a missing cap fails here instead of hanging).
	_, err = pageAll(1000, func(int) ([]int, bool, error) { calls++; return nil, calls < maxPages+10, nil })
	if err != nil || calls != maxPages {
		t.Errorf("a service that always has a next page: %d calls, %v", calls, err)
	}
	if _, err := pageAll(10, func(int) ([]int, bool, error) { return nil, false, errors.New("401") }); err == nil {
		t.Error("no error passed on")
	}
}

// A page of playlist items as the Web API answers it since its 2026 change
// (shortened): a track under "item", a local file, a track gone from this
// market (null), and an episode.
const spotifyItemsJSON = `{"items":[
  {"is_local":false,"item":{"type":"track","episode":false,"track":true,"id":"t1","name":"If You Ever",
    "uri":"spotify:track:t1","duration_ms":254573,"is_local":false,
    "artists":[{"name":"East 17"},{"name":"Gabrielle"}],"album":{"name":"Hits","images":[{"url":"big"},{"url":"small"}]}}},
  {"is_local":true,"item":{"type":"track","id":"","name":"Mine.mp3","uri":"spotify:local:x","is_local":true}},
  {"is_local":false,"item":null},
  {"is_local":false,"item":{"type":"episode","episode":true,"track":false,"id":"e1","name":"Podcast","uri":"spotify:episode:e1"}}
 ],"next":null,"total":4}`

// The same track as the Web API answered before (under "track").
const spotifyItemsOldJSON = `{"items":[{"is_local":false,"track":{"type":"track","id":"t1","name":"If You Ever",
  "uri":"spotify:track:t1","duration_ms":254573,"artists":[{"name":"East 17"}],"album":{"name":"Hits","images":[{"url":"small"}]}}}]}`

func TestSpotifyTracksOfKeepsThePlayableOnes(t *testing.T) {
	want := []providerTrack{{ID: "t1", Provider: "spotify", Title: "If You Ever", Artist: "East 17", Album: "Hits",
		Thumbnail: "small", DurationMs: 254573, Path: "spotify:track:t1"}}
	for name, body := range map[string]string{"new": spotifyItemsJSON, "old": spotifyItemsOldJSON} {
		var page spotifyItemsPage
		if err := json.Unmarshal([]byte(body), &page); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := spotifyTracksOf(page); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %+v\nwant %+v", name, got, want)
		}
	}
}

func TestSpotifyPlaylistsOfTheUserAndCollaborative(t *testing.T) {
	var page spotifyPlaylistsPage
	if err := json.Unmarshal([]byte(`{"items":[
		{"id":"own","name":"Herrie","owner":{"id":"me","display_name":"Herrie"},"images":null,"items":{"total":188}},
		{"id":"other","name":"Frozen","owner":{"id":"kaikahana","display_name":"Kai"},"items":{"total":38}},
		{"id":"collab","name":"Party","collaborative":true,"owner":{"id":"friend","display_name":"F"},"images":[{"url":"i"}],"tracks":{"total":7}},
		{"id":"","name":"no id","owner":{"id":"me"}}],"next":null}`), &page); err != nil {
		t.Fatal(err)
	}
	got := spotifyPlaylistsOf(page, "me")
	want := []providerPlaylist{
		{ID: "own", Provider: "spotify", Name: "Herrie", Owner: "Herrie", Tracks: 188},
		{ID: "collab", Provider: "spotify", Name: "Party", Owner: "F", Thumbnail: "i", Tracks: 7},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

// Against a stand-in for the Web API: /items with its paging, and Spotify's
// refusal passed on.
func TestSpotifyPlaylistCalls(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI())
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.URL.Path == "/v1/me":
			_, _ = w.Write([]byte(`{"id":"me"}`))
		case r.URL.Path == "/v1/me/playlists":
			_, _ = w.Write([]byte(`{"items":[{"id":"own","name":"Mine","owner":{"id":"me"},"items":{"total":2}},
				{"id":"x","name":"Theirs","owner":{"id":"them"}}],"next":null}`))
		case r.URL.Path == "/v1/playlists/own/items" && r.URL.Query().Get("offset") == "0":
			_, _ = w.Write([]byte(`{"items":[{"item":{"type":"track","id":"a","name":"A","uri":"spotify:track:a"}}],"next":"more"}`))
		case r.URL.Path == "/v1/playlists/own/items":
			_, _ = w.Write([]byte(`{"items":[{"item":{"type":"track","id":"b","name":"B","uri":"spotify:track:b"}}],"next":null}`))
		default:
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"status":403,"message":"Forbidden"}}`))
		}
	}))
	defer srv.Close()
	savedBase, savedSrc := spotifyAPIBase, currentTokenSource
	spotifyAPIBase, currentTokenSource = srv.URL+"/v1/", oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "tok"})
	defer func() { spotifyAPIBase, currentTokenSource = savedBase, savedSrc }()

	s := &spotifyProvider{}
	lists, err := s.Playlists(context.Background())
	if err != nil || len(lists) != 1 || lists[0].ID != "own" || lists[0].Tracks != 2 {
		t.Fatalf("playlists: %+v %v", lists, err)
	}
	tracks, err := s.PlaylistTracks(context.Background(), "own")
	if err != nil || len(tracks) != 2 || tracks[0].Path != "spotify:track:a" || tracks[1].Path != "spotify:track:b" {
		t.Fatalf("tracks: %+v %v", tracks, err)
	}
	wantPaths := []string{"/v1/me", "/v1/me/playlists?limit=50&offset=0",
		"/v1/playlists/own/items?limit=100&offset=0", "/v1/playlists/own/items?limit=100&offset=1"}
	if !reflect.DeepEqual(paths, wantPaths) {
		t.Errorf("asked %q", paths)
	}
	if _, err := s.PlaylistTracks(context.Background(), "x"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Errorf("someone else's playlist: %v", err)
	}
	currentTokenSource = nil
	if _, err := s.Playlists(context.Background()); err == nil {
		t.Error("no session, no error")
	}
}

// playlistProvider has playlists, as Spotify does.
type playlistProvider struct {
	fakeProvider
	err error
}

func (p *playlistProvider) Playlists(ctx context.Context) ([]providerPlaylist, error) {
	return []providerPlaylist{{ID: "p1", Provider: p.id, Name: "Road", Tracks: 2}}, p.err
}

func (p *playlistProvider) PlaylistTracks(ctx context.Context, id string) ([]providerTrack, error) {
	return []providerTrack{{ID: id + "-1", Provider: p.id, Path: p.id + ":track:" + id + "-1"}}, p.err
}

func get(t *testing.T, path string) (int, map[string]json.RawMessage) {
	t.Helper()
	rec := httptest.NewRecorder()
	handleProviderRoute(rec, httptest.NewRequest(http.MethodGet, path, nil))
	out := map[string]json.RawMessage{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestPlaylistRoutes(t *testing.T) {
	withProviders(t, &playlistProvider{fakeProvider: fakeProvider{id: "spotify"}},
		&fakeProvider{id: "jamendo"},
		&playlistProvider{fakeProvider: fakeProvider{id: "broken"}, err: errors.New("401")})

	code, out := get(t, "/provider/spotify/playlists")
	var lists []providerPlaylist
	if code != http.StatusOK || json.Unmarshal(out["playlists"], &lists) != nil || len(lists) != 1 || lists[0].Name != "Road" {
		t.Fatalf("playlists: %d %s", code, out["playlists"])
	}
	code, out = get(t, "/provider/spotify/playlist?id=p1")
	var tracks []providerTrack
	if code != http.StatusOK || json.Unmarshal(out["tracks"], &tracks) != nil || len(tracks) != 1 || tracks[0].Path != "spotify:track:p1-1" {
		t.Fatalf("playlist: %d %s", code, out["tracks"])
	}
	if code, _ := get(t, "/provider/spotify/playlist"); code != http.StatusBadRequest {
		t.Errorf("no id: %d", code)
	}
	if code, _ := get(t, "/provider/jamendo/playlists"); code != http.StatusConflict {
		t.Errorf("a service without playlists: %d", code)
	}
	if code, _ := get(t, "/provider/broken/playlists"); code != http.StatusBadGateway {
		t.Errorf("an error from the service: %d", code)
	}
}

// A page of Tidal's playlistsAndFavoritePlaylists (shortened): an own playlist,
// a favourited editorial one without a creator name, and an entry with no playlist.
func TestTidalPlaylistsOf(t *testing.T) {
	var page tidalPlaylistsPage
	if err := json.Unmarshal([]byte(`{"limit":50,"offset":0,"totalNumberOfItems":3,"items":[
		{"type":"USER_CREATED","playlist":{"uuid":"u-1","title":"Mine","numberOfTracks":12,
			"squareImage":"29798a19-7c48-41ab-8b50-a0f23ea02bb4","creator":{"id":7,"name":"Herrie"}}},
		{"type":"USER_FAVORITE","playlist":{"uuid":"u-2","title":"Rock Hits","numberOfTracks":50,"creator":{"id":0}}},
		{"type":"USER_FAVORITE","playlist":{}}]}`), &page); err != nil {
		t.Fatal(err)
	}
	want := []providerPlaylist{
		{ID: "u-1", Provider: "tidal", Name: "Mine", Owner: "Herrie", Tracks: 12,
			Thumbnail: "https://resources.tidal.com/images/29798a19/7c48/41ab/8b50/a0f23ea02bb4/320x320.jpg"},
		{ID: "u-2", Provider: "tidal", Name: "Rock Hits", Tracks: 50},
	}
	if got := tidalPlaylistsOf(page); !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

// Playlist items as Tidal answers them: a track, a video, and a track it no
// longer streams.
func TestTidalTracksOfKeepsThePlayableOnes(t *testing.T) {
	var page tidalItemsPage
	if err := json.Unmarshal([]byte(`{"totalNumberOfItems":3,"items":[
		{"type":"track","item":{"id":522030436,"title":"Something Wicked","duration":209,"streamReady":true,
			"artist":{"name":"Breaking Benjamin"},"album":{"title":"Something Wicked","cover":"d718c081-ef6d"}}},
		{"type":"video","item":{"id":1,"title":"A video","duration":200}},
		{"type":"track","item":{"id":2,"title":"Gone","duration":100,"streamReady":false}}]}`), &page); err != nil {
		t.Fatal(err)
	}
	want := []providerTrack{{ID: "522030436", Provider: "tidal", Title: "Something Wicked", Artist: "Breaking Benjamin",
		Album: "Something Wicked", Thumbnail: "https://resources.tidal.com/images/d718c081/ef6d/320x320.jpg",
		DurationMs: 209000, Path: "tidal:522030436"}}
	if got := tidalTracksOf(page); !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

func TestQobuzPlaylistsAndTracksOf(t *testing.T) {
	var lists qobuzPlaylistsPage
	if err := json.Unmarshal([]byte(`{"user":{"id":1},"playlists":{"offset":0,"limit":50,"total":2,"items":[
		{"id":123,"name":"Lossless","tracks_count":9,"images300":["a.jpg","b.jpg"],"owner":{"id":1,"name":"herrie"}},
		{"id":0,"name":"broken"}]}}`), &lists); err != nil {
		t.Fatal(err)
	}
	wantLists := []providerPlaylist{{ID: "123", Provider: "qobuz", Name: "Lossless", Owner: "herrie", Thumbnail: "a.jpg", Tracks: 9}}
	if got := qobuzPlaylistsOf(lists); !reflect.DeepEqual(got, wantLists) {
		t.Errorf("playlists: got %+v\nwant %+v", got, wantLists)
	}
	var tracks qobuzPlaylistPage
	if err := json.Unmarshal([]byte(`{"id":123,"tracks":{"total":2,"items":[
		{"id":55,"title":"Song","duration":180,"streamable":true,"performer":{"name":"Band"},
			"album":{"title":"LP","image":{"small":"s.jpg"}}},
		{"id":56,"title":"Withdrawn","duration":10,"streamable":false}]}}`), &tracks); err != nil {
		t.Fatal(err)
	}
	wantTracks := []providerTrack{{ID: "55", Provider: "qobuz", Title: "Song", Artist: "Band", Album: "LP",
		Thumbnail: "s.jpg", DurationMs: 180000, Path: "qobuz:55"}}
	if got := qobuzTracksOf(tracks); !reflect.DeepEqual(got, wantTracks) {
		t.Errorf("tracks: got %+v\nwant %+v", got, wantTracks)
	}
}

// Against a stand-in for Deezer's public API: paging by index until there is
// no next, the tracks it cannot play left out, and its error object passed on.
func TestDeezerPlaylistCalls(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI())
		switch {
		case r.URL.Path == "/playlist/9/tracks" && r.URL.Query().Get("index") == "0":
			_, _ = w.Write([]byte(`{"data":[{"id":3135556,"title":"Harder","duration":224,"readable":true,
				"artist":{"name":"Daft Punk"},"album":{"title":"Discovery","cover_medium":"c.jpg"}},
				{"id":4,"title":"Not here","readable":false}],"total":3,"next":"more"}`))
		case r.URL.Path == "/playlist/9/tracks":
			_, _ = w.Write([]byte(`{"data":[{"id":5,"title":"Last","duration":60}],"total":3}`))
		default:
			_, _ = w.Write([]byte(`{"error":{"type":"DataException","message":"no data","code":800}}`))
		}
	}))
	defer srv.Close()
	old := deezerAPIBase
	deezerAPIBase = srv.URL
	defer func() { deezerAPIBase = old }()

	d := &deezerProvider{}
	got, err := d.PlaylistTracks(context.Background(), "9")
	if err != nil {
		t.Fatal(err)
	}
	want := []providerTrack{
		{ID: "3135556", Provider: "deezer", Title: "Harder", Artist: "Daft Punk", Album: "Discovery",
			Thumbnail: "c.jpg", DurationMs: 224000, Path: "deezer:3135556"},
		{ID: "5", Provider: "deezer", Title: "Last", DurationMs: 60000, Path: "deezer:5"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
	if !reflect.DeepEqual(paths, []string{"/playlist/9/tracks?limit=100&index=0", "/playlist/9/tracks?limit=100&index=2"}) {
		t.Errorf("asked %v", paths)
	}
	if _, err := d.PlaylistTracks(context.Background(), "private"); err == nil || !strings.Contains(err.Error(), "no data") {
		t.Errorf("Deezer's error: %v", err)
	}
	if _, err := d.Playlists(context.Background()); err == nil {
		t.Error("playlists without an account")
	}
}

func TestDeezerPlaylistsOf(t *testing.T) {
	var page deezerPlaylistsPage
	if err := json.Unmarshal([]byte(`{"data":[{"id":15872242681,"title":"Favoriete nummers","nb_tracks":0,
		"picture_medium":"p.jpg","is_loved_track":true,"creator":{"id":1,"name":"herrie"}},{"id":0}],"total":1}`), &page); err != nil {
		t.Fatal(err)
	}
	want := []providerPlaylist{{ID: "15872242681", Provider: "deezer", Name: "Favoriete nummers", Owner: "herrie", Thumbnail: "p.jpg"}}
	if got := deezerPlaylistsOf(page); !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}
