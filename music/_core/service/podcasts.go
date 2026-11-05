package main

// Podcasts: the user's subscriptions, their episodes and what was played of
// them, kept by the service, so feeds are refreshed, episodes downloaded and
// the user told of new ones while the Music app is closed. The app is a
// client of the /podcasts routes (listed in the README).
//
// A podcast's id is the first 12 hex digits of the SHA-1 of its address as
// first subscribed; it stays when the feed moves. An episode's is
// "podcast:<podcast id>.<16 hex of the SHA-1 of its guid>", which is also its
// track in the app.
//
// Everything is in one JSON file under spotifyDataDir, written whole (a
// temporary file, then a rename) a moment after a change. One mutex guards
// it, and is never held while the network is asked.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
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
	podcastsFile = spotifyDataDir + "/podcasts.json"
	// The most episodes kept of one podcast: the newest.
	podcastMaxEpisodes = 2000
	// Episodes a preview shows.
	podcastPreviewEpisodes = 50
	// The most of a request's body read (an OPML import may be bigger).
	podcastBodyLimit = 1 << 20
	// Feeds read at once by a refresh.
	podcastRefreshWorkers = 4
	// The most a podcast downloads by itself.
	podcastMaxAutoDownload = 50
	podcastMaxKeepDays     = 3650
)

// Variables for the tests.
var (
	podcastStatePath = podcastsFile
	podcastNow       = time.Now
	// podcastLuna asks the bus (Wi-Fi state, notifications).
	podcastLuna = lunaCall
	// podcastSaveDelay is how long after a change the state is written: the
	// changes of a moment are written once.
	podcastSaveDelay = 2 * time.Second
)

// pods is the podcasts of the service, nil until startPodcasts.
var pods *podcastStore

// podcastSettings are the user's choices for all podcasts.
type podcastSettings struct {
	RefreshHours   int  `json:"refreshHours"`
	WifiOnly       bool `json:"wifiOnly"`
	AutoDownload   int  `json:"autoDownload"`
	KeepPlayedDays int  `json:"keepPlayedDays"`
	Notify         bool `json:"notify"`
}

func defaultPodcastSettings() podcastSettings {
	return podcastSettings{RefreshHours: 6, WifiOnly: true, KeepPlayedDays: 7, Notify: true}
}

// podcastRefreshChoices are the refresh intervals offered.
var podcastRefreshChoices = map[int]bool{0: true, 1: true, 3: true, 6: true, 12: true, 24: true}

// The states of a download.
const (
	dlNone        = "none"
	dlQueued      = "queued"
	dlDownloading = "downloading"
	dlDone        = "done"
	dlFailed      = "failed"
)

// pcDownload is the download of an episode.
type pcDownload struct {
	State  string `json:"state"`
	Bytes  int64  `json:"bytes,omitempty"`
	Size   int64  `json:"size,omitempty"` // the whole, when known
	Path   string `json:"path,omitempty"`
	Error  string `json:"error,omitempty"`
	DoneAt int64  `json:"doneAt,omitempty"`
}

// pcEpisode is an episode as kept: what the feed said and what the user did.
type pcEpisode struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	URL         string `json:"url"`
	Type        string `json:"type,omitempty"`
	Size        int64  `json:"size,omitempty"`
	Published   int64  `json:"published,omitempty"`
	DurationMs  int64  `json:"durationMs,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	Link        string `json:"link,omitempty"`
	PositionMs  int64  `json:"positionMs,omitempty"`
	Played      bool   `json:"played,omitempty"`
	New         bool   `json:"new,omitempty"`
	LastPlayed  int64  `json:"lastPlayed,omitempty"`
	PlayedAt    int64  `json:"playedAt,omitempty"`
	// NoAuto: the user cancelled or removed its download, so automatic
	// downloads leave it.
	NoAuto   bool       `json:"noAuto,omitempty"`
	Download pcDownload `json:"download"`
}

// pcFeed is a subscription.
type pcFeed struct {
	ID           string       `json:"id"`
	URL          string       `json:"url"`
	Title        string       `json:"title"`
	Author       string       `json:"author,omitempty"`
	Description  string       `json:"description,omitempty"`
	Image        string       `json:"image,omitempty"`
	Link         string       `json:"link,omitempty"`
	Added        int64        `json:"added"`
	LastRefresh  int64        `json:"lastRefresh,omitempty"`
	LastError    string       `json:"lastError,omitempty"`
	AutoDownload int          `json:"autoDownload,omitempty"`
	ETag         string       `json:"etag,omitempty"`
	LastModified string       `json:"lastModified,omitempty"`
	Episodes     []*pcEpisode `json:"episodes"` // newest first

	index map[string]*pcEpisode
}

func (f *pcFeed) reindex() {
	f.index = make(map[string]*pcEpisode, len(f.Episodes))
	for _, e := range f.Episodes {
		f.index[e.Key] = e
	}
}

// podcastsData is the state file.
type podcastsData struct {
	Version         int             `json:"version"`
	Settings        podcastSettings `json:"settings"`
	LastAutoRefresh int64           `json:"lastAutoRefresh,omitempty"`
	Podcasts        []*pcFeed       `json:"podcasts"`
}

type podcastStore struct {
	mu       sync.Mutex
	path     string
	settings podcastSettings
	lastAuto int64 // when the timed refresh last began (unix ms)
	feeds    map[string]*pcFeed

	// The refresh running, and what was asked for while it ran.
	refreshing bool
	pendAll    bool
	pend       map[string]bool
	pendTimed  bool

	// Downloads: the queue (episode ids "<f>.<e>"), those running, and the
	// files they write to.
	queue    []string
	active   map[string]*pcJob
	reserved map[string]bool
	closing  bool

	// Saving.
	saveMu    sync.Mutex
	saveTimer *time.Timer
	dirty     bool

	wg sync.WaitGroup
}

func newPodcastStore(path string) *podcastStore {
	return &podcastStore{path: path, settings: defaultPodcastSettings(), feeds: map[string]*pcFeed{},
		pend: map[string]bool{}, active: map[string]*pcJob{}, reserved: map[string]bool{}}
}

// loadPodcastStore reads the state file; a missing file is no podcasts yet,
// an unreadable one is kept aside as .bad and the podcasts start empty.
// Downloads that were running are queued again (started by start).
func loadPodcastStore(path string) *podcastStore {
	s := newPodcastStore(path)
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("podcasts: %v", err)
		}
		return s
	}
	d := podcastsData{Settings: defaultPodcastSettings()}
	if err := json.Unmarshal(b, &d); err != nil {
		log.Printf("podcasts: %s cannot be read (%v); kept as %s.bad", path, err, path)
		_ = os.Rename(path, path+".bad")
		return s
	}
	s.settings = d.Settings
	if !podcastRefreshChoices[s.settings.RefreshHours] {
		s.settings.RefreshHours = defaultPodcastSettings().RefreshHours
	}
	s.lastAuto = d.LastAutoRefresh
	for _, f := range d.Podcasts {
		if f == nil || !podcastIDRe.MatchString(f.ID) || s.feeds[f.ID] != nil {
			continue
		}
		eps := f.Episodes[:0]
		for _, e := range f.Episodes {
			if e != nil && episodeKeyRe.MatchString(e.Key) {
				eps = append(eps, e)
			}
		}
		f.Episodes = eps
		f.reindex()
		s.feeds[f.ID] = f
		for _, e := range f.Episodes {
			switch e.Download.State {
			case dlQueued, dlDownloading:
				e.Download = pcDownload{State: dlQueued}
				s.queue = append(s.queue, f.ID+"."+e.Key)
			case dlDone, dlFailed:
			default:
				e.Download = pcDownload{State: dlNone}
			}
		}
	}
	return s
}

// startPodcasts loads the podcasts and starts their background work.
func startPodcasts() {
	s := loadPodcastStore(podcastStatePath)
	pods = s
	s.mu.Lock()
	s.kickLocked()
	s.mu.Unlock()
	go s.loop(nil)
}

// close stops the downloads (queued again for the next start), waits for
// the work going on and writes the state.
func (s *podcastStore) close() {
	s.mu.Lock()
	s.closing = true
	for _, j := range s.active {
		j.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	s.flush()
}

// changed marks the state as changed: it is written podcastSaveDelay later,
// once for all the changes until then. Called with s.mu held.
func (s *podcastStore) changed() {
	s.dirty = true
	if s.saveTimer == nil {
		s.saveTimer = time.AfterFunc(podcastSaveDelay, s.flush)
	}
}

// flush writes the state if it changed.
func (s *podcastStore) flush() {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	s.mu.Lock()
	if s.saveTimer != nil {
		s.saveTimer.Stop()
		s.saveTimer = nil
	}
	if !s.dirty {
		s.mu.Unlock()
		return
	}
	s.dirty = false
	d := podcastsData{Version: 1, Settings: s.settings, LastAutoRefresh: s.lastAuto, Podcasts: s.sortedFeedsLocked(false)}
	b, err := json.Marshal(d)
	s.mu.Unlock()
	if err == nil {
		err = writeFileAtomic(s.path, b)
	}
	if err != nil {
		log.Printf("podcasts: the state could not be written: %v", err)
		s.mu.Lock()
		s.changed()
		s.mu.Unlock()
	}
}

// sortedFeedsLocked is the podcasts by title (byTitle) or by id.
func (s *podcastStore) sortedFeedsLocked(byTitle bool) []*pcFeed {
	out := make([]*pcFeed, 0, len(s.feeds))
	for _, f := range s.feeds {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if byTitle {
			a, b := strings.ToLower(out[i].Title), strings.ToLower(out[j].Title)
			if a != b {
				return a < b
			}
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// lookupLocked is the podcast and episode of an episode id "<f>.<e>".
func (s *podcastStore) lookupLocked(id string) (*pcFeed, *pcEpisode) {
	f, e, ok := strings.Cut(id, ".")
	if !ok {
		return nil, nil
	}
	feed := s.feeds[f]
	if feed == nil {
		return nil, nil
	}
	return feed, feed.index[e]
}

// findFeedLocked is the podcast subscribed to at feedURL: by the id that
// address gives, or by the address it has now.
func (s *podcastStore) findFeedLocked(feedURL string) *pcFeed {
	if f := s.feeds[podcastID(feedURL)]; f != nil {
		return f
	}
	for _, f := range s.feeds {
		if f.URL == feedURL {
			return f
		}
	}
	return nil
}

// --- ids and checks ---------------------------------------------------------------

var (
	podcastIDRe  = regexp.MustCompile(`^[0-9a-f]{12}$`)
	episodeKeyRe = regexp.MustCompile(`^[0-9a-f]{16}$`)
	episodeIDRe  = regexp.MustCompile(`^[0-9a-f]{12}\.[0-9a-f]{16}$`)
)

// episodeID takes an episode id as "podcast:<f>.<e>" or "<f>.<e>" and gives
// "<f>.<e>", or "" when it is neither.
func episodeID(s string) string {
	s = strings.TrimPrefix(strings.TrimSpace(s), "podcast:")
	if !episodeIDRe.MatchString(s) {
		return ""
	}
	return s
}

// feedAddress is what the user gave as a feed's address, if it is one: http
// or https, with a host, no user name or password.
func feedAddress(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("give the address of the podcast's feed")
	}
	u, err := url.Parse(s)
	if err != nil || !isWebLink(s) {
		return "", errors.New("that is not the web address (http or https) of a feed")
	}
	if u.User != nil {
		return "", errors.New("the address may not carry a user name or password")
	}
	return s, nil
}

// --- what the app is given ----------------------------------------------------------

type downloadView struct {
	State    string  `json:"state"`
	Progress float64 `json:"progress"`
	Bytes    int64   `json:"bytes"`
	Path     string  `json:"path"`
	Error    string  `json:"error"`
}

type episodeView struct {
	ID           string       `json:"id"`
	Podcast      string       `json:"podcast"`
	PodcastTitle string       `json:"podcastTitle"`
	Title        string       `json:"title"`
	Published    int64        `json:"published"`
	DurationMs   int64        `json:"duration_ms"`
	URL          string       `json:"url"`
	Type         string       `json:"type"`
	Size         int64        `json:"size"`
	Video        bool         `json:"video"`
	Description  string       `json:"description"`
	Image        string       `json:"image"`
	Link         string       `json:"link"`
	PositionMs   int64        `json:"position_ms"`
	Played       bool         `json:"played"`
	New          bool         `json:"new"`
	LastPlayed   int64        `json:"lastPlayed"`
	Download     downloadView `json:"download"`
}

type podcastView struct {
	ID            string `json:"id"`
	URL           string `json:"url"`
	Title         string `json:"title"`
	Author        string `json:"author"`
	Description   string `json:"description"`
	Image         string `json:"image"`
	Link          string `json:"link"`
	Added         int64  `json:"added"`
	LastRefresh   int64  `json:"lastRefresh"`
	LastError     string `json:"lastError"`
	EpisodeCount  int    `json:"episodeCount"`
	UnplayedCount int    `json:"unplayedCount"`
	NewCount      int    `json:"newCount"`
	AutoDownload  int    `json:"autoDownload"`
}

func viewPodcast(f *pcFeed) podcastView {
	v := podcastView{ID: f.ID, URL: f.URL, Title: f.Title, Author: f.Author, Description: f.Description, Image: f.Image,
		Link: f.Link, Added: f.Added, LastRefresh: f.LastRefresh, LastError: f.LastError,
		EpisodeCount: len(f.Episodes), AutoDownload: f.AutoDownload}
	for _, e := range f.Episodes {
		if !e.Played {
			v.UnplayedCount++
		}
		if e.New {
			v.NewCount++
		}
	}
	return v
}

func viewEpisode(f *pcFeed, e *pcEpisode) episodeView {
	d := e.Download
	if d.State == "" {
		d.State = dlNone
	}
	dv := downloadView{State: d.State, Bytes: d.Bytes, Error: d.Error}
	switch {
	case d.State == dlDone:
		dv.Progress, dv.Path = 1, d.Path
	case d.Size > 0:
		dv.Progress = float64(d.Bytes) / float64(d.Size)
		if dv.Progress > 1 {
			dv.Progress = 1
		}
	}
	size := e.Size
	if size == 0 {
		size = d.Size
	}
	return episodeView{ID: "podcast:" + f.ID + "." + e.Key, Podcast: f.ID, PodcastTitle: f.Title, Title: e.Title,
		Published: e.Published, DurationMs: e.DurationMs, URL: e.URL, Type: e.Type, Size: size,
		Video: isVideoEpisode(e.Type, e.URL), Description: e.Description, Image: firstOf(e.Image, f.Image), Link: e.Link,
		PositionMs: e.PositionMs, Played: e.Played, New: e.New, LastPlayed: e.LastPlayed, Download: dv}
}

// isVideoEpisode: a video by its type, or by its file's extension when it
// has no audio type.
func isVideoEpisode(typ, rawURL string) bool {
	t := strings.ToLower(strings.TrimSpace(typ))
	if strings.HasPrefix(t, "video/") {
		return true
	}
	if strings.HasPrefix(t, "audio/") {
		return false
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	p := strings.ToLower(u.Path)
	for _, ext := range []string{".mp4", ".m4v", ".mov", ".webm"} {
		if strings.HasSuffix(p, ext) {
			return true
		}
	}
	return false
}

// --- merging what a feed says ---------------------------------------------------

// newFeed is a subscription to the feed at feedURL, made of what it said.
func newFeed(feedURL string, res *feedFetch, now int64, autoDownload int) *pcFeed {
	f := &pcFeed{ID: podcastID(feedURL), URL: feedURL, Added: now, LastRefresh: now, AutoDownload: autoDownload,
		ETag: res.ETag, LastModified: res.LastModified, index: map[string]*pcEpisode{}}
	if res.MovedTo != "" {
		f.URL = res.MovedTo
	}
	mergeFeed(f, res.Feed, true)
	return f
}

// mergeFeed takes what the feed says into f: its details, and its episodes
// (those known updated, keeping what the user did; the others added). The
// newly added are new, except on subscribing, when only the newest is.
// Gives how many it added.
func mergeFeed(f *pcFeed, p *parsedFeed, subscribing bool) int {
	if p.Title != "" {
		f.Title = p.Title
	}
	f.Author = firstOf(p.Author, f.Author)
	f.Description = firstOf(p.Description, f.Description)
	f.Image = firstOf(p.Image, f.Image)
	f.Link = firstOf(p.Link, f.Link)
	if f.index == nil {
		f.reindex()
	}
	added := []*pcEpisode{}
	for _, pe := range p.Episodes {
		key := episodeKey(pe.GUID)
		e := f.index[key]
		if e == nil {
			e = &pcEpisode{Key: key, New: !subscribing, Download: pcDownload{State: dlNone}}
			f.index[key] = e
			added = append(added, e)
		}
		e.Title = firstOf(pe.Title, e.Title, "Episode")
		e.URL, e.Type, e.Size = pe.URL, pe.Type, pe.Size
		e.Published, e.DurationMs = pe.Published, pe.DurationMs
		e.Description, e.Image, e.Link = pe.Description, pe.Image, pe.Link
	}
	f.Episodes = append(added, f.Episodes...)
	sortEpisodesNewestFirst(f.Episodes)
	if subscribing && len(f.Episodes) > 0 {
		f.Episodes[0].New = true
	}
	trimEpisodes(f)
	return len(added)
}

// sortEpisodesNewestFirst: newest first, the undated after the dated in the
// order they were.
func sortEpisodesNewestFirst(eps []*pcEpisode) {
	sort.SliceStable(eps, func(i, j int) bool {
		a, b := eps[i].Published, eps[j].Published
		if (a == 0) != (b == 0) {
			return a != 0
		}
		return a > b
	})
}

// trimEpisodes keeps the newest podcastMaxEpisodes, and every episode with
// a download.
func trimEpisodes(f *pcFeed) {
	if len(f.Episodes) <= podcastMaxEpisodes {
		return
	}
	over := len(f.Episodes) - podcastMaxEpisodes
	keep := make([]bool, len(f.Episodes))
	for i := range keep {
		keep[i] = true
	}
	for i := len(f.Episodes) - 1; i >= 0 && over > 0; i-- {
		if st := f.Episodes[i].Download.State; st == dlNone || st == "" {
			keep[i] = false
			over--
		}
	}
	out := f.Episodes[:0]
	for i, e := range f.Episodes {
		if keep[i] {
			out = append(out, e)
		} else {
			delete(f.index, e.Key)
		}
	}
	for i := len(out); i < len(f.Episodes); i++ {
		f.Episodes[i] = nil
	}
	f.Episodes = out
}

// --- refreshing --------------------------------------------------------------------

// refreshOne reads one podcast's feed again (conditionally) and takes in
// what changed; it gives the number of new episodes.
func (s *podcastStore) refreshOne(ctx context.Context, id string) (int, error) {
	s.mu.Lock()
	f := s.feeds[id]
	if f == nil {
		s.mu.Unlock()
		return 0, errors.New("no such podcast")
	}
	addr, etag, lm := f.URL, f.ETag, f.LastModified
	s.mu.Unlock()
	res, err := fetchFeed(ctx, addr, etag, lm)
	s.mu.Lock()
	defer s.mu.Unlock()
	f = s.feeds[id]
	if f == nil {
		return 0, nil // unsubscribed meanwhile
	}
	s.changed()
	if err != nil {
		f.LastError = err.Error()
		return 0, err
	}
	if res.MovedTo != "" {
		log.Printf("podcasts: %s moved to %s", id, res.MovedTo)
		f.URL = res.MovedTo
	}
	f.ETag, f.LastModified = res.ETag, res.LastModified
	f.LastRefresh, f.LastError = podcastNow().UnixMilli(), ""
	if res.NotModified {
		return 0, nil
	}
	return mergeFeed(f, res.Feed, false), nil
}

// askRefresh asks for a refresh of the podcasts ids (nil: all); timed marks
// the timer's, whose new episodes are notified. A refresh asked for while
// one runs is done after it. It is true when the caller is to run it
// (runRefresh), false when the run going on will.
func (s *podcastStore) askRefresh(ids []string, timed bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ids == nil {
		s.pendAll = true
	}
	for _, id := range ids {
		s.pend[id] = true
	}
	s.pendTimed = s.pendTimed || timed
	if s.refreshing {
		return false
	}
	s.refreshing = true
	return true
}

// runRefresh refreshes what was asked for until nothing more is, then the
// automatic downloads and the pruning after each run.
func (s *podcastStore) runRefresh() {
	for {
		s.mu.Lock()
		if !s.pendAll && len(s.pend) == 0 {
			s.refreshing = false
			s.mu.Unlock()
			return
		}
		list := []string{}
		for _, f := range s.sortedFeedsLocked(true) {
			if s.pendAll || s.pend[f.ID] {
				list = append(list, f.ID)
			}
		}
		timed := s.pendTimed
		s.pendAll, s.pend, s.pendTimed = false, map[string]bool{}, false
		s.mu.Unlock()
		found := s.refreshMany(list)
		if timed {
			s.notifyNew(list, found)
		}
		s.autoDownload()
		s.prune()
	}
}

// refreshMany refreshes the podcasts, a few at a time; it gives the new
// episodes each had.
func (s *podcastStore) refreshMany(ids []string) map[string]int {
	found := map[string]int{}
	var mu sync.Mutex
	work := make(chan string)
	var wg sync.WaitGroup
	for i := 0; i < podcastRefreshWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range work {
				n, err := s.refreshOne(context.Background(), id)
				if err != nil {
					log.Printf("podcasts: refresh %s: %v", id, err)
				}
				mu.Lock()
				found[id] = n
				mu.Unlock()
			}
		}()
	}
	for _, id := range ids {
		work <- id
	}
	close(work)
	wg.Wait()
	return found
}

// notifyNew tells the user of the new episodes of a timed refresh, in one
// notification, when they want that. A failing notification is logged.
func (s *podcastStore) notifyNew(order []string, found map[string]int) {
	total, first, podcasts := 0, "", 0
	s.mu.Lock()
	notify := s.settings.Notify
	for _, id := range order {
		if n := found[id]; n > 0 {
			total += n
			podcasts++
			if f := s.feeds[id]; f != nil && first == "" {
				first = f.Title
			}
		}
	}
	s.mu.Unlock()
	if total == 0 || !notify {
		return
	}
	msg := fmt.Sprintf("%d new episodes: %s", total, first)
	if total == 1 {
		msg = "1 new episode: " + first
	}
	if podcasts > 1 {
		msg += "..."
	}
	// No "type": a toast of type "light" is not kept in the notification
	// area, and this one should be.
	payload, _ := json.Marshal(map[string]interface{}{
		"sourceId": "org.webosports.app.music",
		"message":  msg,
		"onclick":  map[string]interface{}{"appId": "org.webosports.app.music", "params": map[string]string{"category": "podcasts"}},
		"noaction": false,
	})
	if _, err := podcastLuna("luna://com.webos.notification/createToast", string(payload)); err != nil {
		log.Printf("podcasts: no notification: %v", err)
	}
}

// podcastOnWifi: the connection manager says Wi-Fi is connected. Not on
// Wi-Fi when it cannot be asked.
func podcastOnWifi() bool {
	m, err := podcastLuna("luna://com.palm.connectionmanager/getStatus", "{}")
	if err != nil || m == nil {
		return false
	}
	w, _ := m["wifi"].(map[string]interface{})
	st, _ := w["state"].(string)
	return st == "connected"
}

// autoDownload queues, for each podcast that downloads by itself, those of
// its newest autoDownload unplayed episodes not downloaded yet (and not
// removed by the user). Only on Wi-Fi when the user wants that.
func (s *podcastStore) autoDownload() {
	s.mu.Lock()
	want := []string{}
	for _, f := range s.sortedFeedsLocked(true) {
		n := 0
		for _, e := range f.Episodes {
			if n >= f.AutoDownload {
				break
			}
			if e.Played {
				continue
			}
			n++
			if (e.Download.State == dlNone || e.Download.State == "") && !e.NoAuto {
				want = append(want, f.ID+"."+e.Key)
			}
		}
	}
	wifiOnly := s.settings.WifiOnly
	s.mu.Unlock()
	if len(want) == 0 {
		return
	}
	if wifiOnly && !podcastOnWifi() {
		log.Printf("podcasts: %d automatic downloads wait for Wi-Fi", len(want))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range want {
		if _, e := s.lookupLocked(id); e != nil && (e.Download.State == dlNone || e.Download.State == "") {
			s.enqueueLocked(id, e)
		}
	}
	s.kickLocked()
}

// prune removes the downloads of episodes played more than keepPlayedDays
// ago.
func (s *podcastStore) prune() {
	s.mu.Lock()
	days := s.settings.KeepPlayedDays
	if days <= 0 {
		s.mu.Unlock()
		return
	}
	cutoff := podcastNow().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	paths := []string{}
	for _, f := range s.feeds {
		for _, e := range f.Episodes {
			if e.Played && e.PlayedAt > 0 && e.PlayedAt < cutoff && e.Download.State == dlDone {
				paths = append(paths, e.Download.Path)
				e.Download = pcDownload{State: dlNone}
				e.NoAuto = true
				s.changed()
			}
		}
	}
	s.mu.Unlock()
	for _, p := range paths {
		removePodcastFile(p)
	}
}

// loop is the timed work: the refresh every refreshHours (with the
// automatic downloads and the pruning after it), and the pruning between.
func (s *podcastStore) loop(stop <-chan struct{}) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	s.tick()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			s.tick()
		}
	}
}

// tick refreshes all podcasts when refreshHours have gone by since the last
// timed refresh (or the clock went back), else prunes.
func (s *podcastStore) tick() {
	s.mu.Lock()
	now := podcastNow().UnixMilli()
	h := int64(s.settings.RefreshHours)
	due := h > 0 && len(s.feeds) > 0 && (s.lastAuto == 0 || now-s.lastAuto >= h*3600*1000 || now < s.lastAuto)
	if due {
		s.lastAuto = now
		s.changed()
	}
	s.mu.Unlock()
	if due {
		if s.askRefresh(nil, true) {
			s.runRefresh()
		}
		return
	}
	s.prune()
}

// --- search -----------------------------------------------------------------------

// Where podcasts are searched (variables for the tests): the webOS Archive's
// directory (drPodder's), then Apple's.
var (
	podcastSearchBase = "https://podcasts.webosarchive.org"
	podcastITunesBase = "https://itunes.apple.com"
)

type podcastSearchResult struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	Author      string `json:"author"`
	Image       string `json:"image"`
	Description string `json:"description"`
	Subscribed  string `json:"subscribed"`
}

// podcastGetJSON reads JSON from addr into out.
func podcastGetJSON(ctx context.Context, addr string, out interface{}) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", podcastUserAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := podcastHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 8<<20)).Decode(out)
}

// searchPodcasts finds podcasts by their name: in the webOS Archive's
// directory, else (it failed or found nothing) at Apple.
func searchPodcasts(ctx context.Context, q string, limit int) ([]podcastSearchResult, error) {
	res, err := searchWebOSArchive(ctx, q, limit)
	if err != nil {
		log.Printf("podcasts: the webOS Archive directory: %v", err)
	}
	if err != nil || len(res) == 0 {
		alt, err2 := searchITunes(ctx, q, limit)
		if err2 != nil {
			log.Printf("podcasts: Apple's directory: %v", err2)
			if err != nil {
				return nil, errors.New("the podcast directories cannot be reached")
			}
			return res, nil
		}
		res = alt
	}
	return res, nil
}

func searchWebOSArchive(ctx context.Context, q string, limit int) ([]podcastSearchResult, error) {
	var r struct {
		Status string `json:"status"`
		Msg    string `json:"msg"`
		Feeds  []struct {
			Title       string `json:"title"`
			URL         string `json:"url"`
			Author      string `json:"author"`
			Image       string `json:"image"`
			Artwork     string `json:"artwork"`
			Description string `json:"description"`
		} `json:"feeds"`
	}
	v := url.Values{"q": {q}, "max": {strconv.Itoa(limit)}}
	if err := podcastGetJSON(ctx, podcastSearchBase+"/search.php?"+v.Encode(), &r); err != nil {
		return nil, err
	}
	if r.Status != "true" {
		return nil, fmt.Errorf("it answered %q (%s)", r.Status, r.Msg)
	}
	out := []podcastSearchResult{}
	for _, f := range r.Feeds {
		out = append(out, podcastSearchResult{Title: f.Title, URL: f.URL, Author: f.Author,
			Image: firstOf(f.Artwork, f.Image), Description: f.Description})
	}
	return cleanSearchResults(out, limit), nil
}

func searchITunes(ctx context.Context, q string, limit int) ([]podcastSearchResult, error) {
	var r struct {
		Results []struct {
			CollectionName string `json:"collectionName"`
			FeedURL        string `json:"feedUrl"`
			ArtistName     string `json:"artistName"`
			ArtworkURL600  string `json:"artworkUrl600"`
			ArtworkURL100  string `json:"artworkUrl100"`
		} `json:"results"`
	}
	v := url.Values{"media": {"podcast"}, "entity": {"podcast"}, "term": {q}, "limit": {strconv.Itoa(limit)}}
	if err := podcastGetJSON(ctx, podcastITunesBase+"/search?"+v.Encode(), &r); err != nil {
		return nil, err
	}
	out := []podcastSearchResult{}
	for _, f := range r.Results {
		out = append(out, podcastSearchResult{Title: f.CollectionName, URL: f.FeedURL, Author: f.ArtistName,
			Image: firstOf(f.ArtworkURL600, f.ArtworkURL100)})
	}
	return cleanSearchResults(out, limit), nil
}

// cleanSearchResults keeps the results with a name and a feed's web address,
// each feed once, up to limit, their text plain.
func cleanSearchResults(in []podcastSearchResult, limit int) []podcastSearchResult {
	out := []podcastSearchResult{}
	seen := map[string]bool{}
	for _, r := range in {
		r.URL = strings.TrimSpace(r.URL)
		r.Title = oneLine(stripHTML(r.Title))
		if r.Title == "" || !isWebLink(r.URL) || seen[r.URL] {
			continue
		}
		seen[r.URL] = true
		r.Author = oneLine(stripHTML(r.Author))
		r.Description = podcastText(r.Description)
		if !isWebLink(r.Image) {
			r.Image = ""
		}
		out = append(out, r)
		if len(out) == limit {
			break
		}
	}
	return out
}

// --- the routes ----------------------------------------------------------------------

func registerPodcastRoutes(mux *http.ServeMux) {
	for path, h := range map[string]http.HandlerFunc{
		"/podcasts":                 handlePodcasts,
		"/podcasts/search":          handlePodcastSearch,
		"/podcasts/preview":         handlePodcastPreview,
		"/podcasts/subscribe":       handlePodcastSubscribe,
		"/podcasts/unsubscribe":     handlePodcastUnsubscribe,
		"/podcasts/episodes":        handlePodcastEpisodes,
		"/podcasts/new":             handlePodcastNew,
		"/podcasts/inprogress":      handlePodcastInProgress,
		"/podcasts/downloads":       handlePodcastDownloads,
		"/podcasts/state":           handlePodcastState,
		"/podcasts/markall":         handlePodcastMarkAll,
		"/podcasts/refresh":         handlePodcastRefresh,
		"/podcasts/download":        handlePodcastDownload,
		"/podcasts/download/cancel": handlePodcastDownloadCancel,
		"/podcasts/download/delete": handlePodcastDownloadDelete,
		"/podcasts/resolve":         handlePodcastResolve,
		"/podcasts/opml":            handlePodcastOPML,
		"/podcasts/opml/export":     handlePodcastOPMLExport,
		"/podcasts/opml/import":     handlePodcastOPMLImport,
		"/podcasts/opml/files":      handlePodcastOPMLFiles,
		"/podcasts/settings":        handlePodcastSettings,
		"/podcasts/feedsettings":    handlePodcastFeedSettings,
	} {
		mux.HandleFunc(path, withCORS(h))
	}
}

// podcastRoute checks the method and that the podcasts are there.
func podcastRoute(w http.ResponseWriter, r *http.Request, method string) *podcastStore {
	if r.Method != method {
		w.Header().Set("Allow", method)
		httpErr(w, http.StatusMethodNotAllowed, "use "+method)
		return nil
	}
	if pods == nil {
		httpErr(w, http.StatusServiceUnavailable, "podcasts are not ready yet")
		return nil
	}
	return pods
}

// podcastBody decodes a request's JSON body of at most limit bytes; an
// empty body is an empty object.
func podcastBody(w http.ResponseWriter, r *http.Request, limit int64, v interface{}) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	if err := dec.Decode(v); err != nil && !errors.Is(err, io.EOF) {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpErr(w, http.StatusRequestEntityTooLarge, "the request is too large")
		} else {
			httpErr(w, http.StatusBadRequest, "bad json")
		}
		return false
	}
	return true
}

// queryInt is the query's integer key, def when it is not given, within
// [lo, hi].
func queryInt(r *http.Request, key string, def, lo, hi int) int {
	n, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		n = def
	}
	return max(lo, min(hi, n))
}

// GET /podcasts -> {podcasts (by title), refreshing, downloading}
func handlePodcasts(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodGet)
	if s == nil {
		return
	}
	s.mu.Lock()
	list := []podcastView{}
	for _, f := range s.sortedFeedsLocked(true) {
		list = append(list, viewPodcast(f))
	}
	refreshing, downloading := s.refreshing, len(s.active)+len(s.queue)
	s.mu.Unlock()
	writeJSON(w, map[string]interface{}{"podcasts": list, "refreshing": refreshing, "downloading": downloading})
}

// GET /podcasts/search?q=&limit= -> {results}
func handlePodcastSearch(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodGet)
	if s == nil {
		return
	}
	q := oneLine(r.URL.Query().Get("q"))
	if len(q) > 200 {
		httpErr(w, http.StatusBadRequest, "that is too long to search for")
		return
	}
	if q == "" {
		writeJSON(w, map[string]interface{}{"results": []podcastSearchResult{}})
		return
	}
	res, err := searchPodcasts(r.Context(), q, queryInt(r, "limit", 30, 1, 50))
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.mu.Lock()
	for i := range res {
		if f := s.findFeedLocked(res[i].URL); f != nil {
			res[i].Subscribed = f.ID
		}
	}
	s.mu.Unlock()
	writeJSON(w, map[string]interface{}{"results": res})
}

// POST /podcasts/preview {url} -> {podcast, episodes}: read, not kept.
func handlePodcastPreview(w http.ResponseWriter, r *http.Request) {
	if podcastRoute(w, r, http.MethodPost) == nil {
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	addr, err := feedAddress(body.URL)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := fetchFeed(r.Context(), addr, "", "")
	if err != nil {
		httpErr(w, http.StatusBadGateway, "the feed: "+err.Error())
		return
	}
	f := newFeed(addr, res, 0, 0)
	f.LastRefresh = 0
	eps := []episodeView{}
	for _, e := range f.Episodes {
		e.New = false
		eps = append(eps, viewEpisode(f, e))
		if len(eps) == podcastPreviewEpisodes {
			break
		}
	}
	writeJSON(w, map[string]interface{}{"podcast": viewPodcast(f), "episodes": eps})
}

// subscribe subscribes to the feed at addr (read first); already
// subscribed gives that podcast, and added false.
func (s *podcastStore) subscribe(ctx context.Context, addr string) (podcastView, bool, error) {
	s.mu.Lock()
	if f := s.findFeedLocked(addr); f != nil {
		v := viewPodcast(f)
		s.mu.Unlock()
		return v, false, nil
	}
	s.mu.Unlock()
	res, err := fetchFeed(ctx, addr, "", "")
	if err != nil {
		return podcastView{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if f := s.findFeedLocked(addr); f != nil {
		return viewPodcast(f), false, nil
	}
	if res.MovedTo != "" {
		if f := s.findFeedLocked(res.MovedTo); f != nil {
			return viewPodcast(f), false, nil
		}
	}
	f := newFeed(addr, res, podcastNow().UnixMilli(), s.settings.AutoDownload)
	s.feeds[f.ID] = f
	s.changed()
	if f.AutoDownload > 0 {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.autoDownload()
		}()
	}
	return viewPodcast(f), true, nil
}

// POST /podcasts/subscribe {url} -> {podcast}
func handlePodcastSubscribe(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	addr, err := feedAddress(body.URL)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err.Error())
		return
	}
	v, _, err := s.subscribe(r.Context(), addr)
	if err != nil {
		httpErr(w, http.StatusBadGateway, "the feed: "+err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"podcast": v})
}

// POST /podcasts/unsubscribe {id, deleteDownloads} -> {ok}
func handlePodcastUnsubscribe(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		ID              string `json:"id"`
		DeleteDownloads bool   `json:"deleteDownloads"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	if !podcastIDRe.MatchString(body.ID) {
		httpErr(w, http.StatusBadRequest, "not a podcast")
		return
	}
	s.mu.Lock()
	f := s.feeds[body.ID]
	if f == nil {
		s.mu.Unlock()
		httpErr(w, http.StatusNotFound, "no such podcast")
		return
	}
	files := []string{}
	for _, e := range f.Episodes {
		id := f.ID + "." + e.Key
		s.stopDownloadLocked(id, e)
		if e.Download.State == dlDone && e.Download.Path != "" {
			files = append(files, e.Download.Path)
		}
	}
	delete(s.feeds, f.ID)
	s.changed()
	title := f.Title
	s.mu.Unlock()
	if body.DeleteDownloads {
		for _, p := range files {
			removePodcastFile(p)
		}
		removePodcastDir(podcastDirFor(title))
	}
	writeJSON(w, map[string]interface{}{"ok": true})
}

// GET /podcasts/episodes?id=&offset=&limit= -> {podcast, episodes, more, next}
// next is the offset of the next page, 0 when there is none.
func handlePodcastEpisodes(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodGet)
	if s == nil {
		return
	}
	id := r.URL.Query().Get("id")
	if !podcastIDRe.MatchString(id) {
		httpErr(w, http.StatusBadRequest, "not a podcast")
		return
	}
	offset := queryInt(r, "offset", 0, 0, podcastMaxEpisodes*2)
	limit := queryInt(r, "limit", 50, 1, 200)
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.feeds[id]
	if f == nil {
		httpErr(w, http.StatusNotFound, "no such podcast")
		return
	}
	eps := []episodeView{}
	for i := offset; i < len(f.Episodes) && len(eps) < limit; i++ {
		eps = append(eps, viewEpisode(f, f.Episodes[i]))
	}
	more := offset+len(eps) < len(f.Episodes)
	next := 0
	if more {
		next = offset + len(eps)
	}
	writeJSON(w, map[string]interface{}{"podcast": viewPodcast(f), "episodes": eps, "more": more, "next": next})
}

// episodesWhere is every episode keep takes, in the order less gives, at
// most limit.
func (s *podcastStore) episodesWhere(keep func(*pcEpisode) bool, less func(a, b *pcEpisode) bool, limit int) []episodeView {
	type pair struct {
		f *pcFeed
		e *pcEpisode
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	all := []pair{}
	for _, f := range s.sortedFeedsLocked(true) {
		for _, e := range f.Episodes {
			if keep(e) {
				all = append(all, pair{f, e})
			}
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return less(all[i].e, all[j].e) })
	out := []episodeView{}
	for _, p := range all {
		if len(out) == limit {
			break
		}
		out = append(out, viewEpisode(p.f, p.e))
	}
	return out
}

func newerFirst(a, b *pcEpisode) bool {
	if (a.Published == 0) != (b.Published == 0) {
		return a.Published != 0
	}
	return a.Published > b.Published
}

// GET /podcasts/new?limit= -> {episodes}: the new ones, newest first.
func handlePodcastNew(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodGet)
	if s == nil {
		return
	}
	eps := s.episodesWhere(func(e *pcEpisode) bool { return e.New }, newerFirst, queryInt(r, "limit", 100, 1, 500))
	writeJSON(w, map[string]interface{}{"episodes": eps})
}

// GET /podcasts/inprogress?limit= -> {episodes}: begun and not finished,
// the last played first.
func handlePodcastInProgress(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodGet)
	if s == nil {
		return
	}
	eps := s.episodesWhere(func(e *pcEpisode) bool { return e.PositionMs > 0 && !e.Played },
		func(a, b *pcEpisode) bool { return a.LastPlayed > b.LastPlayed }, queryInt(r, "limit", 50, 1, 200))
	writeJSON(w, map[string]interface{}{"episodes": eps})
}

// GET /podcasts/downloads -> {episodes}: downloading, queued (in the queue's
// order), failed, then done, newest first.
func handlePodcastDownloads(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodGet)
	if s == nil {
		return
	}
	s.mu.Lock()
	place := map[string]int{}
	for i, id := range s.queue {
		_, key, _ := strings.Cut(id, ".")
		place[key] = i
	}
	s.mu.Unlock()
	rank := map[string]int{dlDownloading: 0, dlQueued: 1, dlFailed: 2, dlDone: 3}
	eps := s.episodesWhere(func(e *pcEpisode) bool { return e.Download.State != dlNone && e.Download.State != "" },
		func(a, b *pcEpisode) bool {
			ra, rb := rank[a.Download.State], rank[b.Download.State]
			if ra != rb {
				return ra < rb
			}
			if ra == 1 {
				return place[a.Key] < place[b.Key]
			}
			return newerFirst(a, b)
		}, podcastMaxEpisodes)
	writeJSON(w, map[string]interface{}{"episodes": eps})
}

// POST /podcasts/state {id, position_ms?, played?, new?} -> {episode}
// A position also sets lastPlayed and clears new; played clears the position
// (and new). New, when given, is applied last.
func handlePodcastState(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		ID         string `json:"id"`
		PositionMs *int64 `json:"position_ms"`
		Played     *bool  `json:"played"`
		New        *bool  `json:"new"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	id := episodeID(body.ID)
	if id == "" {
		httpErr(w, http.StatusBadRequest, "not an episode")
		return
	}
	if body.PositionMs != nil && (*body.PositionMs < 0 || *body.PositionMs > 100*24*3600*1000) {
		httpErr(w, http.StatusBadRequest, "position_ms is out of range")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, e := s.lookupLocked(id)
	if e == nil {
		httpErr(w, http.StatusNotFound, "no such episode")
		return
	}
	now := podcastNow().UnixMilli()
	if body.PositionMs != nil {
		e.PositionMs = *body.PositionMs
		e.LastPlayed = now
		e.New = false
	}
	if body.Played != nil {
		setPlayed(e, *body.Played, now)
	}
	if body.New != nil {
		e.New = *body.New
	}
	s.changed()
	writeJSON(w, map[string]interface{}{"episode": viewEpisode(f, e)})
}

// setPlayed marks an episode played (from the start again, not new) or not.
func setPlayed(e *pcEpisode, played bool, now int64) {
	if played {
		if !e.Played || e.PlayedAt == 0 {
			e.PlayedAt = now
		}
		e.Played, e.PositionMs, e.New = true, 0, false
		return
	}
	e.Played, e.PlayedAt = false, 0
}

// POST /podcasts/markall {podcast, played?, new?} -> {ok}
func handlePodcastMarkAll(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		Podcast string `json:"podcast"`
		Played  *bool  `json:"played"`
		New     *bool  `json:"new"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	if !podcastIDRe.MatchString(body.Podcast) {
		httpErr(w, http.StatusBadRequest, "not a podcast")
		return
	}
	if body.Played == nil && body.New == nil {
		httpErr(w, http.StatusBadRequest, "say played or new")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.feeds[body.Podcast]
	if f == nil {
		httpErr(w, http.StatusNotFound, "no such podcast")
		return
	}
	now := podcastNow().UnixMilli()
	for _, e := range f.Episodes {
		if body.Played != nil {
			setPlayed(e, *body.Played, now)
		}
		if body.New != nil {
			e.New = *body.New
		}
	}
	s.changed()
	writeJSON(w, map[string]interface{}{"ok": true})
}

// POST /podcasts/refresh {id?} -> {refreshing: true}, the work in the
// background.
func handlePodcastRefresh(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	var ids []string
	if body.ID != "" {
		if !podcastIDRe.MatchString(body.ID) {
			httpErr(w, http.StatusBadRequest, "not a podcast")
			return
		}
		s.mu.Lock()
		f := s.feeds[body.ID]
		s.mu.Unlock()
		if f == nil {
			httpErr(w, http.StatusNotFound, "no such podcast")
			return
		}
		ids = []string{body.ID}
	}
	if s.askRefresh(ids, false) {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.runRefresh()
		}()
	}
	writeJSON(w, map[string]interface{}{"refreshing": true})
}

// GET|POST /podcasts/settings -> Settings; POST takes any of them.
func handlePodcastSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s := podcastRoute(w, r, http.MethodGet)
		if s == nil {
			return
		}
		s.mu.Lock()
		st := s.settings
		s.mu.Unlock()
		writeJSON(w, st)
		return
	}
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		RefreshHours   *int  `json:"refreshHours"`
		WifiOnly       *bool `json:"wifiOnly"`
		AutoDownload   *int  `json:"autoDownload"`
		KeepPlayedDays *int  `json:"keepPlayedDays"`
		Notify         *bool `json:"notify"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	switch {
	case body.RefreshHours != nil && !podcastRefreshChoices[*body.RefreshHours]:
		httpErr(w, http.StatusBadRequest, "refreshHours is one of 0, 1, 3, 6, 12 and 24")
		return
	case body.AutoDownload != nil && (*body.AutoDownload < 0 || *body.AutoDownload > podcastMaxAutoDownload):
		httpErr(w, http.StatusBadRequest, "autoDownload is from 0 to "+strconv.Itoa(podcastMaxAutoDownload))
		return
	case body.KeepPlayedDays != nil && (*body.KeepPlayedDays < 0 || *body.KeepPlayedDays > podcastMaxKeepDays):
		httpErr(w, http.StatusBadRequest, "keepPlayedDays is from 0 to "+strconv.Itoa(podcastMaxKeepDays))
		return
	}
	s.mu.Lock()
	if body.RefreshHours != nil {
		s.settings.RefreshHours = *body.RefreshHours
	}
	if body.WifiOnly != nil {
		s.settings.WifiOnly = *body.WifiOnly
	}
	if body.AutoDownload != nil {
		s.settings.AutoDownload = *body.AutoDownload
	}
	if body.KeepPlayedDays != nil {
		s.settings.KeepPlayedDays = *body.KeepPlayedDays
	}
	if body.Notify != nil {
		s.settings.Notify = *body.Notify
	}
	s.changed()
	st := s.settings
	s.mu.Unlock()
	writeJSON(w, st)
}

// POST /podcasts/feedsettings {id, autoDownload} -> {podcast}
func handlePodcastFeedSettings(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		ID           string `json:"id"`
		AutoDownload *int   `json:"autoDownload"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	if !podcastIDRe.MatchString(body.ID) {
		httpErr(w, http.StatusBadRequest, "not a podcast")
		return
	}
	if body.AutoDownload == nil || *body.AutoDownload < 0 || *body.AutoDownload > podcastMaxAutoDownload {
		httpErr(w, http.StatusBadRequest, "autoDownload is from 0 to "+strconv.Itoa(podcastMaxAutoDownload))
		return
	}
	s.mu.Lock()
	f := s.feeds[body.ID]
	if f == nil {
		s.mu.Unlock()
		httpErr(w, http.StatusNotFound, "no such podcast")
		return
	}
	f.AutoDownload = *body.AutoDownload
	s.changed()
	v := viewPodcast(f)
	s.mu.Unlock()
	if v.AutoDownload > 0 {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.autoDownload()
		}()
	}
	writeJSON(w, map[string]interface{}{"podcast": v})
}
