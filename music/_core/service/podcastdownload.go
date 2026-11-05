package main

// Podcast downloads: an episode's file, kept on /media/internal (where the
// user sees it over USB too) as
//
//	/media/internal/podcasts/<podcast title>/<YYYY-MM-DD> <episode title>.<ext>
//
// Two download at once, the others wait in a queue. A file is written as
// <name>.part and renamed when it is whole, so a file of that name is always
// a whole episode. Nothing is ever removed outside that folder: a path from
// the state file is checked against it first.
//
// While a download writes, /media/internal cannot be unmounted for USB drive
// mode (paths.go); the lossless downloads have the same limit.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	podcastMaxActive = 2
	// What is left free on the storage beside an episode.
	podcastSpaceMargin = 64 << 20
	// The longest file or folder name made, in bytes (vfat takes 255
	// UTF-16 units; this leaves room for " (n)" and ".part").
	podcastMaxName = 199
)

// Variables for the tests.
var (
	podcastFilesDir = "/media/internal/podcasts"
	podcastDLHTTP   = &http.Client{Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ResponseHeaderTimeout: 30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}}
	// podcastFreeSpace is the bytes free for us on the storage holding dir.
	podcastFreeSpace = statfsFree
	// podcastStall is how long a download may get nothing before it fails.
	podcastStall = 60 * time.Second
)

// pcJob is a download running.
type pcJob struct {
	cancel context.CancelFunc
	path   string // the file it writes (without .part), once chosen
}

func statfsFree(dir string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil
}

// errNoSpace: the storage has too little room for an episode.
var errNoSpace = errors.New("there is not enough free space for this episode")

// checkPodcastSpace makes the podcasts folder and checks it has room for
// size bytes and podcastSpaceMargin.
func checkPodcastSpace(size int64) error {
	if err := os.MkdirAll(podcastFilesDir, 0o755); err != nil {
		return errors.New("the podcasts folder cannot be made")
	}
	free, err := podcastFreeSpace(podcastFilesDir)
	if err != nil {
		return errors.New("the free space cannot be told")
	}
	if size < 0 {
		size = 0
	}
	if free < uint64(size)+podcastSpaceMargin {
		return errNoSpace
	}
	return nil
}

// --- names ---------------------------------------------------------------------

// podcastFileName is s as a file or folder name: no path separators, no
// control characters, none of the characters vfat refuses, no dot or space
// at either end (so not "." or ".."), at most max bytes of whole characters;
// fallback when nothing is left.
func podcastFileName(s, fallback string, max int) string {
	var b strings.Builder
	for i, w := 0, 0; i < len(s); i += w {
		r, size := utf8.DecodeRuneInString(s[i:])
		w = size
		switch {
		case r == utf8.RuneError && size == 1:
			b.WriteByte('_')
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == ' ' || r == ' ':
			b.WriteByte(' ')
		case r == '/' || r == '\\' || r == '|':
			b.WriteByte('-')
		case r == ':':
			b.WriteString(" -")
		case r == '"':
			b.WriteByte('\'')
		case r == '*' || r == '?' || r == '<' || r == '>':
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Trim(oneLine(b.String()), ". ")
	if len(out) > max {
		cut := max
		for cut > 0 && !utf8.RuneStart(out[cut]) {
			cut--
		}
		out = strings.TrimRight(out[:cut], ". ")
	}
	if out == "" {
		return fallback
	}
	return out
}

// podcastDirFor is the folder of a podcast's downloads.
func podcastDirFor(podcastTitle string) string {
	return filepath.Join(podcastFilesDir, podcastFileName(podcastTitle, "Podcast", podcastMaxName))
}

// podcastAudioExts are the extensions taken from an enclosure's address.
var podcastAudioExts = map[string]bool{
	".mp3": true, ".m4a": true, ".m4b": true, ".aac": true, ".ogg": true, ".oga": true, ".opus": true, ".flac": true,
	".wav": true, ".mp4": true, ".m4v": true, ".mov": true, ".webm": true, ".mka": true, ".mkv": true,
}

// podcastMimeExts are the extensions of the types an enclosure says.
var podcastMimeExts = map[string]string{
	"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/x-mpeg": ".mp3", "audio/mpeg3": ".mp3",
	"audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a", "audio/x-m4b": ".m4b", "audio/aac": ".aac",
	"audio/aacp": ".aac", "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/flac": ".flac", "audio/x-flac": ".flac",
	"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".webm",
	"video/mp4": ".mp4", "video/x-m4v": ".m4v", "video/quicktime": ".mov", "video/webm": ".webm",
}

// podcastExt is a download's extension: the enclosure address's, else its
// type's, else .mp3.
func podcastExt(rawURL, typ string) string {
	if u, err := url.Parse(rawURL); err == nil {
		if ext := strings.ToLower(path.Ext(u.Path)); podcastAudioExts[ext] {
			return ext
		}
	}
	if t, _, err := mime.ParseMediaType(typ); err == nil {
		if ext, ok := podcastMimeExts[t]; ok {
			return ext
		}
	}
	return ".mp3"
}

// podcastStem is a download's name without its extension: the date it was
// published (when known) and its title.
func podcastStem(published int64, title string) string {
	name := podcastFileName(title, "Episode", podcastMaxName-16)
	if published > 0 {
		name = time.UnixMilli(published).Format("2006-01-02") + " " + name
	}
	return name
}

// uniquePathLocked is a free path in dir for stem+ext ("stem (2).ext" when
// that one is taken, on the storage or by another download), reserved
// until the download ends.
func (s *podcastStore) uniquePathLocked(dir, stem, ext string) string {
	for i := 1; ; i++ {
		name := stem
		if i > 1 {
			name += " (" + strconv.Itoa(i) + ")"
		}
		p := filepath.Join(dir, name+ext)
		if s.reserved[p] {
			continue
		}
		if _, err := os.Lstat(p); err == nil {
			continue
		}
		if _, err := os.Lstat(p + ".part"); err == nil {
			continue
		}
		s.reserved[p] = true
		return p
	}
}

// --- inside the folder ---------------------------------------------------------------

// insidePodcastDir: p is a regular file (not a link) in the podcasts folder,
// both as written and with any links in the folder's path followed.
func insidePodcastDir(p string) bool {
	if p == "" || !filepath.IsAbs(p) {
		return false
	}
	within := func(base, p string) bool {
		rel, err := filepath.Rel(base, p)
		return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
	}
	base := filepath.Clean(podcastFilesDir)
	if !within(base, filepath.Clean(p)) {
		return false
	}
	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return false
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil || !within(realBase, real) {
		return false
	}
	fi, err := os.Lstat(p)
	return err == nil && fi.Mode().IsRegular()
}

// removePodcastFile removes a download, only when it is in the folder.
func removePodcastFile(p string) {
	if !insidePodcastDir(p) {
		if p != "" {
			log.Printf("podcasts: %q is not in %s, left alone", p, podcastFilesDir)
		}
		return
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		log.Printf("podcasts: %v", err)
	}
}

// removePodcastDir removes a podcast's folder in the podcasts folder, when it
// is empty.
func removePodcastDir(dir string) {
	base := filepath.Clean(podcastFilesDir)
	if filepath.Dir(filepath.Clean(dir)) != base {
		return
	}
	if fi, err := os.Lstat(dir); err == nil && fi.IsDir() {
		_ = os.Remove(dir) // fails when it still has files: then it stays
	}
}

// --- the queue ----------------------------------------------------------------------

// enqueueLocked queues an episode's download.
func (s *podcastStore) enqueueLocked(id string, e *pcEpisode) {
	if e.Download.State == dlQueued || e.Download.State == dlDownloading {
		return
	}
	e.Download = pcDownload{State: dlQueued}
	s.queue = append(s.queue, id)
	s.changed()
}

// kickLocked starts queued downloads while fewer than podcastMaxActive run.
func (s *podcastStore) kickLocked() {
	for !s.closing && len(s.active) < podcastMaxActive && len(s.queue) > 0 {
		id := s.queue[0]
		s.queue = s.queue[1:]
		f, e := s.lookupLocked(id)
		if e == nil || e.Download.State != dlQueued {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		job := &pcJob{cancel: cancel}
		s.active[id] = job
		e.Download = pcDownload{State: dlDownloading, Size: e.Size}
		s.changed()
		d := dlInfo{dir: podcastDirFor(f.Title), stem: podcastStem(e.Published, e.Title), ext: podcastExt(e.URL, e.Type),
			url: e.URL, size: e.Size}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer cancel()
			s.runDownload(ctx, job, id, d)
		}()
	}
}

// stopDownloadLocked ends an episode's download, queued or running (its
// part file goes); the episode is then not downloaded.
func (s *podcastStore) stopDownloadLocked(id string, e *pcEpisode) {
	switch e.Download.State {
	case dlQueued:
		for i, q := range s.queue {
			if q == id {
				s.queue = append(s.queue[:i:i], s.queue[i+1:]...)
				break
			}
		}
	case dlDownloading:
		if j := s.active[id]; j != nil {
			j.cancel()
			delete(s.active, id)
		}
	default:
		return
	}
	e.Download = pcDownload{State: dlNone}
	s.changed()
	s.kickLocked()
}

// dlInfo is what a download needs of its episode.
type dlInfo struct {
	dir, stem, ext, url string
	size                int64
}

// runDownload downloads one episode and records how it went, unless it was
// stopped meanwhile.
func (s *podcastStore) runDownload(ctx context.Context, job *pcJob, id string, d dlInfo) {
	final, n, err := s.fetchEpisode(ctx, job, id, d)
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.reserved, job.path)
	current := s.active[id] == job
	if current {
		delete(s.active, id)
	}
	_, e := s.lookupLocked(id)
	switch {
	case !current || e == nil:
		// Stopped or unsubscribed meanwhile: what it made goes.
		if err == nil {
			removePodcastFile(final)
		}
	case s.closing && ctx.Err() != nil:
		e.Download = pcDownload{State: dlQueued} // again at the next start
	case err != nil:
		log.Printf("podcasts: download %s: %v", id, err)
		e.Download = pcDownload{State: dlFailed, Error: err.Error()}
	default:
		e.Download = pcDownload{State: dlDone, Bytes: n, Size: n, Path: final, DoneAt: podcastNow().UnixMilli()}
	}
	s.changed()
	s.kickLocked()
}

// progress records a running download's bytes (and size, once known).
func (s *podcastStore) progress(id string, job *pcJob, bytes, size int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[id] != job {
		return
	}
	if _, e := s.lookupLocked(id); e != nil {
		e.Download.Bytes = bytes
		if size > 0 {
			e.Download.Size = size
		}
	}
}

// fetchEpisode writes the episode to a new file in its podcast's folder; it
// gives the file and its size.
func (s *podcastStore) fetchEpisode(ctx context.Context, job *pcJob, id string, d dlInfo) (string, int64, error) {
	if err := checkPodcastSpace(d.size); err != nil {
		return "", 0, err
	}
	if err := os.MkdirAll(d.dir, 0o755); err != nil {
		return "", 0, errors.New("the podcast's folder cannot be made")
	}
	s.mu.Lock()
	final := s.uniquePathLocked(d.dir, d.stem, d.ext)
	job.path = final
	s.mu.Unlock()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var stalled atomic.Bool
	watchdog := time.AfterFunc(podcastStall, func() { stalled.Store(true); cancel() })
	defer watchdog.Stop()
	fail := func(err error) error {
		switch {
		case stalled.Load():
			return errors.New("the download stalled")
		case ctx.Err() != nil:
			return errors.New("the download was stopped")
		}
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.url, nil)
	if err != nil {
		return "", 0, errors.New("the episode has no web address")
	}
	req.Header.Set("User-Agent", podcastUserAgent)
	resp, err := podcastDLHTTP.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return "", 0, fail(fmt.Errorf("the episode cannot be reached (%v)", err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("the episode's server answered HTTP %d", resp.StatusCode)
	}
	size := resp.ContentLength
	if size <= 0 {
		size = 0
	}
	if size > 0 && size != d.size {
		if err := checkPodcastSpace(size); err != nil {
			return "", 0, err
		}
	}
	s.progress(id, job, 0, size)

	part := final + ".part"
	out, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return "", 0, errors.New("the file cannot be written")
	}
	var n, reported int64
	lastReport := time.Now()
	buf := make([]byte, 64<<10)
	for {
		k, rerr := resp.Body.Read(buf)
		if k > 0 {
			watchdog.Reset(podcastStall)
			if _, werr := out.Write(buf[:k]); werr != nil {
				out.Close()
				os.Remove(part)
				return "", 0, fail(errors.New("the file cannot be written (is the storage full?)"))
			}
			n += int64(k)
			// The first bytes at once, then every 256 KiB or half second.
			if reported == 0 || n-reported >= 256<<10 || time.Since(lastReport) > 500*time.Millisecond {
				s.progress(id, job, n, size)
				reported, lastReport = n, time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			os.Remove(part)
			return "", 0, fail(errors.New("the download broke off"))
		}
	}
	if err := out.Close(); err != nil {
		os.Remove(part)
		return "", 0, errors.New("the file cannot be written")
	}
	if size > 0 && n != size {
		os.Remove(part)
		return "", 0, errors.New("the download broke off")
	}
	if ctx.Err() != nil {
		os.Remove(part)
		return "", 0, fail(ctx.Err())
	}
	if err := os.Rename(part, final); err != nil {
		os.Remove(part)
		return "", 0, errors.New("the file cannot be written")
	}
	return final, n, nil
}

// --- the routes ------------------------------------------------------------------------

// episodeRoute reads {id} of an episode and looks it up: the store, the id
// "<f>.<e>", or nil when it answered already.
func episodeRoute(w http.ResponseWriter, r *http.Request) (*podcastStore, string) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return nil, ""
	}
	var body struct {
		ID string `json:"id"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return nil, ""
	}
	id := episodeID(body.ID)
	if id == "" {
		httpErr(w, http.StatusBadRequest, "not an episode")
		return nil, ""
	}
	s.mu.Lock()
	_, e := s.lookupLocked(id)
	s.mu.Unlock()
	if e == nil {
		httpErr(w, http.StatusNotFound, "no such episode")
		return nil, ""
	}
	return s, id
}

// episodeReply answers with an episode as it is now.
func (s *podcastStore) episodeReply(w http.ResponseWriter, id string) {
	s.mu.Lock()
	f, e := s.lookupLocked(id)
	if e == nil {
		s.mu.Unlock()
		httpErr(w, http.StatusNotFound, "no such episode")
		return
	}
	v := viewEpisode(f, e)
	s.mu.Unlock()
	writeJSON(w, map[string]interface{}{"episode": v})
}

// POST /podcasts/download {id} -> {episode}, queued. Refused (507) when the
// storage has too little room for the size the feed gives.
func handlePodcastDownload(w http.ResponseWriter, r *http.Request) {
	s, id := episodeRoute(w, r)
	if s == nil {
		return
	}
	s.mu.Lock()
	_, e := s.lookupLocked(id)
	size, state, path := int64(0), "", ""
	if e != nil {
		size, state, path = e.Size, e.Download.State, e.Download.Path
	}
	s.mu.Unlock()
	if state == dlQueued || state == dlDownloading || (state == dlDone && insidePodcastDir(path)) {
		s.episodeReply(w, id)
		return
	}
	if err := checkPodcastSpace(size); err != nil {
		code := http.StatusInternalServerError
		if errors.Is(err, errNoSpace) {
			code = http.StatusInsufficientStorage
		}
		httpErr(w, code, err.Error())
		return
	}
	s.mu.Lock()
	if _, e := s.lookupLocked(id); e != nil {
		if e.Download.State == dlDone || e.Download.State == dlFailed {
			e.Download = pcDownload{State: dlNone}
		}
		e.NoAuto = false
		s.enqueueLocked(id, e)
		s.kickLocked()
	}
	s.mu.Unlock()
	s.episodeReply(w, id)
}

// POST /podcasts/download/cancel {id} -> {episode}: a queued or running
// download stops (a failed one is forgotten); a done one stays.
func handlePodcastDownloadCancel(w http.ResponseWriter, r *http.Request) {
	s, id := episodeRoute(w, r)
	if s == nil {
		return
	}
	s.mu.Lock()
	if _, e := s.lookupLocked(id); e != nil {
		switch e.Download.State {
		case dlQueued, dlDownloading:
			s.stopDownloadLocked(id, e)
			e.NoAuto = true
		case dlFailed:
			e.Download = pcDownload{State: dlNone}
			e.NoAuto = true
			s.changed()
		}
	}
	s.mu.Unlock()
	s.episodeReply(w, id)
}

// POST /podcasts/download/delete {id} -> {episode}: the download stops, its
// file is removed.
func handlePodcastDownloadDelete(w http.ResponseWriter, r *http.Request) {
	s, id := episodeRoute(w, r)
	if s == nil {
		return
	}
	file := ""
	s.mu.Lock()
	if _, e := s.lookupLocked(id); e != nil {
		if e.Download.State == dlDone {
			file = e.Download.Path
		}
		s.stopDownloadLocked(id, e)
		e.Download = pcDownload{State: dlNone}
		e.NoAuto = true
		s.changed()
	}
	s.mu.Unlock()
	removePodcastFile(file)
	s.episodeReply(w, id)
}

// POST /podcasts/resolve {trackId: "<f>.<e>"} -> {url, video}: the
// download's file:// address while the file is there, else the enclosure.
func handlePodcastResolve(w http.ResponseWriter, r *http.Request) {
	s := podcastRoute(w, r, http.MethodPost)
	if s == nil {
		return
	}
	var body struct {
		TrackID string `json:"trackId"`
	}
	if !podcastBody(w, r, podcastBodyLimit, &body) {
		return
	}
	id := episodeID(body.TrackID)
	if id == "" {
		httpErr(w, http.StatusBadRequest, "not an episode")
		return
	}
	s.mu.Lock()
	_, e := s.lookupLocked(id)
	if e == nil {
		s.mu.Unlock()
		httpErr(w, http.StatusNotFound, "no such episode")
		return
	}
	addr, video, file := e.URL, isVideoEpisode(e.Type, e.URL), ""
	if e.Download.State == dlDone {
		file = e.Download.Path
	}
	s.mu.Unlock()
	if file != "" && insidePodcastDir(file) {
		addr = (&url.URL{Scheme: "file", Path: file}).String()
	}
	writeJSON(w, map[string]interface{}{"url": addr, "video": video})
}
