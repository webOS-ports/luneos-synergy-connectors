package main

// Spotify as a media session of com.webos.service.mediacontroller.
//
// librespot plays Spotify on its own: a Connect controller (the Music app through
// /player/*, or Spotify on another device) starts it, and nothing on the device
// knew it was playing. mediacontroller pauses the sessions it has when another
// player starts, audiod pauses the last one for a call and resumes it after, and
// a headset's keys and the dashboard go to it - so librespot played on over the
// Music app and over calls, and no key reached it.
//
// So the service holds a session for librespot, as the Music app and Chromium
// hold theirs (qml/MediaSession.qml, media_session_webos.cc):
//
//   - registered, under the service's own id, once librespot has a track and is
//     not the Music app's (below); its subscription is the session, and ends when
//     librespot exits or mediacontroller goes away. Registered again when
//     mediacontroller is back.
//   - activated when librespot starts playing, which makes it the session the
//     keys, audiod's pause and its "play" after a call go to; deactivated when
//     librespot has stopped or the Music app has it.
//   - told PLAYING / PAUSED / STOPPED and the track's title, artists, album,
//     duration and number, from librespot's own events (librespotevents.go),
//     which come with or without a network.
//   - its keys: "play" and "pause" are play and pause, never a toggle, as the
//     Music app takes them; "next" and "previous" skip. Each goes to librespot
//     through spotifyControl (librespotcontrol.go), which pauses even without
//     the Web API: it holds librespot's output still (holdLibrespotOutput).
//
// What happens on a pause is what Android asks of a player losing audio focus:
// mediacontroller sends one when another player starts (a permanent loss - paused,
// and nothing resumes it but the user), audiod sends one when a call starts and
// "play" when it is over (a transient loss - paused, then resumed), and only to a
// session it saw playing.
//
// The Music app's own session covers what it plays through librespot: it sends
// /player/load, polls /player/status every second while a Spotify track is loaded,
// and pauses librespot for its own keys. Two sessions for one sound would pause
// each other: the second to start would pause the first, and the Music app would
// pause librespot. So the service's session stands aside while the Music app has
// spoken to /player/* in the last appHeartbeat and librespot plays what the app
// loaded; it takes over when the app goes quiet (closed, or killed) or librespot
// plays something else (another Connect controller). Keys that reach the session
// while the app has librespot are not acted on.
//
// The session's state is kept by one goroutine (run); everything else posts to it.

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	mcServiceURI = "luna://com.webos.service.mediacontroller/"
	mcName       = "com.webos.service.mediacontroller"
	// The hub's server-status signal: {"connected": bool} on every change.
	busServerStatusURI = "luna://com.webos.service.bus/signal/registerServerStatus"

	// The Music app polls /player/status every second while a Spotify track is
	// loaded (SpotifyEngine.qml); this many seconds without any /player/* call
	// and librespot is no longer the app's.
	appHeartbeat = 5 * time.Second

	sessionRetryMin = 5 * time.Second
	sessionRetryMax = 60 * time.Second

	playStatePlaying = "PLAYSTATE_PLAYING"
	playStatePaused  = "PLAYSTATE_PAUSED"
	playStateStopped = "PLAYSTATE_STOPPED"
)

// lunaSub is an open subscription: its replies, one parsed JSON object each,
// until the call ends and the channel is closed. cancel ends it.
type lunaSub interface {
	replies() <-chan map[string]interface{}
	cancel()
}

// mcBus is how the session reaches the bus. send is fire and forget, in order;
// subscribe opens a subscription.
type mcBus interface {
	send(uri string, payload map[string]interface{})
	subscribe(uri string, payload map[string]interface{}) (lunaSub, error)
}

// spotifyControl drives librespot for the session's keys. None of them blocks.
// holding reports whether librespot's output is held still by a pause.
type spotifyControl interface {
	pause()
	// play calls done, on its own goroutine, with whether librespot plays now
	play(done func(ok bool))
	next()
	previous()
	holding() bool
}

// lsTrack is the track librespot has, from its track_changed event.
type lsTrack struct {
	uri  string
	meta map[string]interface{}
}

type spotifySession struct {
	bus mcBus
	ctl spotifyControl
	now func() time.Time
	// a session id of this run's own, different for every registration
	newMediaID func() string

	// librespot, from its events
	lsRunning bool
	hasTrack  bool
	playing   bool
	track     lsTrack
	// bumped by every key and every playing event, so that a play that failed
	// is not taken back after something newer
	seq int

	// the Music app's /player/* calls
	appSeen time.Time
	appURI  string

	// mediacontroller
	mcUp       bool
	sub        lunaSub
	subGen     int
	mediaID    string
	registered bool
	retryAt    time.Time
	retryDelay time.Duration
	sentStatus string
	sentMeta   string
	active     bool

	// the server-status watch
	watch      lunaSub
	watchGen   int
	watchRetry time.Time

	events chan func()
}

func newSpotifySession(bus mcBus, ctl spotifyControl, now func() time.Time) *spotifySession {
	return &spotifySession{
		bus:        bus,
		ctl:        ctl,
		now:        now,
		newMediaID: func() string { return serviceCallerID + "-spotify-" + strconv.FormatInt(now().UnixNano(), 36) },
		mcUp:       true, // until the hub says otherwise; a refused registration is retried anyway
		retryDelay: sessionRetryMin,
		events:     make(chan func(), 256),
	}
}

// post runs f on the session's goroutine. It never blocks: an event that does not
// fit is dropped, and the next one brings the session up to date.
func (s *spotifySession) post(f func()) {
	select {
	case s.events <- f:
	default:
		log.Printf("media session: event queue full, one dropped")
	}
}

// run is the session's goroutine.
func (s *spotifySession) run() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case f := <-s.events:
			f()
		case <-tick.C:
			s.sync()
		}
	}
}

// --- what comes in ---------------------------------------------------------------

// onLibrespotEvent takes one of librespot's --onevent events (its environment).
func (s *spotifySession) onLibrespotEvent(ev map[string]string) {
	s.lsRunning = true
	switch ev["PLAYER_EVENT"] {
	case "track_changed":
		s.hasTrack = true
		s.track = lsTrack{uri: ev["URI"], meta: trackMetaData(ev)}
	case "playing":
		// Held still by a pause, librespot cannot be playing: this was sent
		// before the hold took, and the queue it waited in is behind it.
		if s.ctl.holding() {
			break
		}
		s.hasTrack = true
		s.playing = true
		s.seq++
	case "paused":
		s.hasTrack = true
		s.playing = false
	case "end_of_track", "unavailable":
		s.playing = false
	case "stopped":
		s.playing = false
		s.hasTrack = false
	case "loading":
		s.hasTrack = true
	default:
		return
	}
	s.sync()
}

// onLibrespotExit: librespot has gone; the session goes with it.
func (s *spotifySession) onLibrespotExit() {
	s.lsRunning = false
	s.hasTrack = false
	s.playing = false
	s.track = lsTrack{}
	s.sync()
}

// onAppRequest: the Music app called /player/*; uri is what it loaded, for
// /player/load, or "".
func (s *spotifySession) onAppRequest(uri string) {
	s.appSeen = s.now()
	if uri != "" {
		s.appURI = uri
	}
	s.sync()
}

func (s *spotifySession) onServerStatus(gen int, reply map[string]interface{}) {
	if gen != s.watchGen {
		return
	}
	if name, _ := reply["serviceName"].(string); name != "" && name != mcName {
		return
	}
	up, ok := reply["connected"].(bool)
	if !ok {
		return
	}
	if up == s.mcUp {
		return
	}
	s.mcUp = up
	if !up {
		log.Printf("media session: mediacontroller has gone")
		s.dropSession()
	} else {
		log.Printf("media session: mediacontroller is back")
		s.retryAt = time.Time{}
		s.retryDelay = sessionRetryMin
	}
	s.sync()
}

func (s *spotifySession) onWatchClosed(gen int) {
	if gen != s.watchGen {
		return
	}
	s.watch = nil
	s.watchRetry = s.now().Add(sessionRetryMin)
}

// onReply takes a reply on the registerMediaSession call: the registration, a
// key, or a refusal.
func (s *spotifySession) onReply(gen int, reply map[string]interface{}) {
	if gen != s.subGen || s.sub == nil {
		return
	}
	if ok, _ := reply["returnValue"].(bool); !ok {
		text, _ := reply["errorText"].(string)
		log.Printf("media session: mediacontroller refused the session: %s", orDefault(text, "no reason given"))
		s.failSession()
		return
	}
	if key, ok := reply["keyEvent"].(string); ok {
		// the service sends a session only its own keys; check all the same
		if id, _ := reply["mediaId"].(string); id != "" && id != s.mediaID {
			return
		}
		s.onKey(key)
		return
	}
	if subscribed, _ := reply["subscribed"].(bool); subscribed && !s.registered {
		log.Printf("media session: registered as %s", s.mediaID)
		s.registered = true
		s.retryDelay = sessionRetryMin
		s.sentStatus, s.sentMeta, s.active = "", "", false
		s.sync()
	}
}

func (s *spotifySession) onSubClosed(gen int) {
	if gen != s.subGen || s.sub == nil {
		return
	}
	log.Printf("media session: the session's call has ended")
	s.failSession()
}

// onKey acts on a key event of the session.
func (s *spotifySession) onKey(key string) {
	if !s.owned() || !s.hasTrack {
		log.Printf("media session: %q not acted on: librespot is the Music app's or has nothing", key)
		return
	}
	if key == "playPause" {
		key = "pause"
		if !s.playing {
			key = "play"
		}
	}
	log.Printf("media session: key %q", key)
	s.seq++
	seq := s.seq
	switch key {
	case "play":
		s.playing = true
		s.ctl.play(func(ok bool) {
			if !ok {
				s.post(func() { s.onPlayFailed(seq) })
			}
		})
	case "pause", "stop":
		s.playing = false
		s.ctl.pause()
	case "next":
		s.ctl.next()
	case "previous":
		s.ctl.previous()
	default:
		return
	}
	s.sync()
}

// onPlayFailed: a play of the session's did not reach librespot, which stays
// paused - and says so, instead of a play that never happened.
func (s *spotifySession) onPlayFailed(seq int) {
	if seq != s.seq || !s.playing {
		return
	}
	log.Printf("media session: librespot could not be played")
	s.playing = false
	s.sync()
}

// --- what goes out ---------------------------------------------------------------

// owned: librespot's sound is the session's, not the Music app's.
func (s *spotifySession) owned() bool {
	if s.appSeen.IsZero() || s.now().Sub(s.appSeen) >= appHeartbeat {
		return true
	}
	return s.appURI != "" && s.track.uri != "" && s.appURI != s.track.uri
}

// status is what the session tells mediacontroller.
func (s *spotifySession) status() string {
	switch {
	case !s.lsRunning || !s.hasTrack || !s.owned():
		return playStateStopped
	case s.playing:
		return playStatePlaying
	default:
		return playStatePaused
	}
}

// sync brings mediacontroller up to date with what the session knows.
func (s *spotifySession) sync() {
	now := s.now()
	if s.watch == nil && !now.Before(s.watchRetry) {
		s.startWatch()
	}
	if !s.lsRunning {
		if s.sub != nil {
			s.endSession()
		}
		return
	}
	if s.sub == nil {
		if !s.mcUp || !s.hasTrack || !s.owned() || now.Before(s.retryAt) {
			return
		}
		s.register()
		return
	}
	if !s.registered {
		return
	}
	st := s.status()
	if st == playStatePlaying && s.sentStatus != playStatePlaying {
		// playing makes it the session the keys, and audiod's pause, go to
		s.bus.send(mcServiceURI+"activateMediaSession", map[string]interface{}{"mediaId": s.mediaID})
		s.active = true
	}
	if st == playStateStopped && s.active {
		s.bus.send(mcServiceURI+"deactivateMediaSession", map[string]interface{}{"mediaId": s.mediaID})
		s.active = false
	}
	if st != s.sentStatus {
		s.bus.send(mcServiceURI+"setMediaPlayStatus", map[string]interface{}{"mediaId": s.mediaID, "playStatus": st})
		s.sentStatus = st
	}
	if st == playStateStopped {
		return
	}
	meta := s.track.meta
	if meta == nil {
		meta = map[string]interface{}{}
	}
	text, _ := json.Marshal(meta)
	if string(text) != s.sentMeta {
		s.bus.send(mcServiceURI+"setMediaMetaData", map[string]interface{}{"mediaId": s.mediaID, "mediaMetaData": meta})
		s.sentMeta = string(text)
	}
}

func (s *spotifySession) register() {
	s.mediaID = s.newMediaID()
	s.subGen++
	gen := s.subGen
	sub, err := s.bus.subscribe(mcServiceURI+"registerMediaSession",
		map[string]interface{}{"mediaId": s.mediaID, "appId": serviceCallerID, "subscribe": true})
	if err != nil {
		log.Printf("media session: cannot register: %v", err)
		s.backOff()
		return
	}
	s.sub = sub
	go func() {
		for r := range sub.replies() {
			s.post(func() { s.onReply(gen, r) })
		}
		s.post(func() { s.onSubClosed(gen) })
	}()
}

func (s *spotifySession) startWatch() {
	s.watchGen++
	gen := s.watchGen
	w, err := s.bus.subscribe(busServerStatusURI, map[string]interface{}{"serviceName": mcName})
	if err != nil {
		s.watchRetry = s.now().Add(sessionRetryMin)
		return
	}
	s.watch = w
	go func() {
		for r := range w.replies() {
			s.post(func() { s.onServerStatus(gen, r) })
		}
		s.post(func() { s.onWatchClosed(gen) })
	}()
}

// endSession ends the session on purpose: librespot has gone.
func (s *spotifySession) endSession() {
	if s.registered {
		log.Printf("media session: %s ends with librespot", s.mediaID)
	}
	s.dropSession()
	s.retryAt = time.Time{}
	s.retryDelay = sessionRetryMin
}

// failSession: the session was refused or lost; registered again later.
func (s *spotifySession) failSession() {
	s.dropSession()
	s.backOff()
}

func (s *spotifySession) dropSession() {
	if s.sub != nil {
		s.sub.cancel()
	}
	s.sub = nil
	s.subGen++ // what the old call still sends is stale
	s.registered = false
	s.active = false
	s.sentStatus, s.sentMeta = "", ""
}

func (s *spotifySession) backOff() {
	s.retryAt = s.now().Add(s.retryDelay)
	s.retryDelay *= 2
	if s.retryDelay > sessionRetryMax {
		s.retryDelay = sessionRetryMax
	}
}

// trackMetaData is mediacontroller's mediaMetaData of a track_changed event:
// strings, the duration in seconds as text, the track number as a number, and
// nothing for what the track does not have. The service's schema allows no
// other keys.
func trackMetaData(ev map[string]string) map[string]interface{} {
	meta := map[string]interface{}{}
	put := func(key, value string) {
		if v := strings.TrimSpace(value); v != "" {
			meta[key] = v
		}
	}
	put("title", ev["NAME"])
	artists := ev["ARTISTS"]
	if ev["ITEM_TYPE"] == "Episode" {
		artists = ev["SHOW_NAME"]
	}
	put("artist", strings.Join(strings.FieldsFunc(artists, func(r rune) bool { return r == '\n' }), ", "))
	put("album", ev["ALBUM"])
	if ms, err := strconv.ParseInt(ev["DURATION_MS"], 10, 64); err == nil && ms > 0 {
		meta["totalDuration"] = strconv.FormatInt((ms+500)/1000, 10)
	}
	if n, err := strconv.Atoi(ev["NUMBER"]); err == nil && n > 0 {
		meta["trackNumber"] = n
	}
	return meta
}

// mediaSession is the daemon's session, or nil without one.
var mediaSession *spotifySession

// startMediaSession starts the session and the reading of librespot's events. Without
// luna-send or the FIFO there is no session, and librespot plays as it did before.
func startMediaSession() {
	if findExecutable("/usr/bin/luna-send") == "" {
		log.Printf("media session: no luna-send; Spotify plays without one")
		return
	}
	events, err := openLibrespotEvents(librespotEventFIFO)
	if err != nil {
		log.Printf("media session: cannot read librespot's events: %v", err)
		return
	}
	s := newSpotifySession(newLunaSendBus(lunaSendCommand), librespotCtl, time.Now)
	mediaSession = s
	go s.run()
	go func() {
		// opened read-write, so it only ends if reading fails; read on after that
		for {
			readLibrespotEvents(events, func(ev map[string]string) {
				noteLibrespotEvent(ev)
				s.post(func() { s.onLibrespotEvent(ev) })
			})
			time.Sleep(time.Second)
		}
	}()
}

// noteAppPlayer tells the session the Music app called /player/*; uri is what it
// loaded, or "".
func noteAppPlayer(uri string) {
	if s := mediaSession; s != nil {
		s.post(func() { s.onAppRequest(uri) })
	}
}

// --- the bus, through luna-send ---------------------------------------------------

// lunaSendCommand makes the luna-send command for args.
func lunaSendCommand(args ...string) *exec.Cmd { return exec.Command("luna-send", args...) }

// lunaSendBus is mcBus over luna-send acting for the service's id, as the
// Accounts and keymanager calls are made (creds.go, secrets.go).
type lunaSendBus struct {
	queue   chan lunaMessage
	command func(args ...string) *exec.Cmd
}

type lunaMessage struct {
	uri     string
	payload string
}

// newLunaSendBus is the bus over command, lunaSendCommand but in the tests.
func newLunaSendBus(command func(args ...string) *exec.Cmd) *lunaSendBus {
	b := &lunaSendBus{queue: make(chan lunaMessage, 128), command: command}
	go b.worker()
	return b
}

func (b *lunaSendBus) send(uri string, payload map[string]interface{}) {
	text, err := json.Marshal(payload)
	if err != nil {
		return
	}
	select {
	case b.queue <- lunaMessage{uri, string(text)}:
	default:
		log.Printf("media session: bus queue full, %s dropped", lunaMethod(uri))
	}
}

// worker sends one call at a time, so they reach the service in order.
func (b *lunaSendBus) worker() {
	for m := range b.queue {
		reply, err := lunaSendOnce(b.command, m.uri, m.payload)
		if err != nil {
			log.Printf("media session: %s: %v", lunaMethod(m.uri), err)
			continue
		}
		if ok, _ := reply["returnValue"].(bool); !ok {
			text, _ := reply["errorText"].(string)
			log.Printf("media session: %s refused: %s", lunaMethod(m.uri), orDefault(text, "no reason given"))
		}
	}
}

func lunaSendOnce(command func(...string) *exec.Cmd, uri, payload string) (map[string]interface{}, error) {
	cmd := command("-n", "1", "-a", serviceCallerID, uri, payload)
	done := make(chan struct{})
	timer := time.AfterFunc(6*time.Second, func() {
		select {
		case <-done:
		default:
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
	})
	out, err := cmd.Output()
	close(done)
	timer.Stop()
	if err != nil {
		return nil, err
	}
	var m map[string]interface{}
	if err := json.Unmarshal(firstLine(out), &m); err != nil {
		return nil, err
	}
	return m, nil
}

func firstLine(b []byte) []byte {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return []byte(s)
}

func lunaMethod(uri string) string {
	if i := strings.LastIndexByte(uri, '/'); i >= 0 {
		return uri[i+1:]
	}
	return uri
}

func (b *lunaSendBus) subscribe(uri string, payload map[string]interface{}) (lunaSub, error) {
	text, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return startLunaSendSub(b.command, uri, string(text))
}

// lunaSendSub is a subscription held open by an interactive luna-send: one
// reply per line on its stdout, each flushed as it comes. Its exit ends the
// call. luna-send -i runs until its stdin is closed, so closing that cancels the
// call; it is killed if it has not gone a second later. Either way the hub tells
// the service.
type lunaSendSub struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	ch    chan map[string]interface{}
	done  chan struct{}
	once  sync.Once
}

func startLunaSendSub(command func(...string) *exec.Cmd, uri, payload string) (*lunaSendSub, error) {
	cmd := command("-i", "-a", serviceCallerID, uri, payload)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s := &lunaSendSub{cmd: cmd, stdin: in, ch: make(chan map[string]interface{}, 16), done: make(chan struct{})}
	go func() {
		lines := bufio.NewScanner(out)
		lines.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for lines.Scan() {
			var m map[string]interface{}
			// not a reply when it is not an object; luna-send printed something else
			if json.Unmarshal(lines.Bytes(), &m) == nil && m != nil {
				s.ch <- m
			}
		}
		// a line over the limit ends the scan: the call is ended with it
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
		_, _ = io.Copy(io.Discard, out)
		_ = cmd.Wait()
		close(s.done)
		close(s.ch)
	}()
	return s, nil
}

func (s *lunaSendSub) replies() <-chan map[string]interface{} { return s.ch }

func (s *lunaSendSub) cancel() {
	s.once.Do(func() {
		_ = s.stdin.Close()
		go func() {
			select {
			case <-s.done:
			case <-time.After(time.Second):
				_ = s.cmd.Process.Kill()
			}
		}()
	})
}
