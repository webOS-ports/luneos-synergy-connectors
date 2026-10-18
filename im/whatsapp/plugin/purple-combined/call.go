package main

// call.go — WhatsApp voice calling, unified into the messaging plugin.
//
// Ported from the standalone `wacallm` mediator, but instead of opening its own
// whatsmeow session it attaches meowcaller to the plugin's EXISTING client
// (handler.client) — so there is ONE WhatsApp companion for both messaging and
// calling. One pairing (adding the account) enables both; the calling session can
// no longer get logged out independently, and it inherits the messaging session's
// own-LID (which meowcaller needs to place calls).
//
// The Go side owns the WhatsApp session + the VoIP engine (meowcaller); the C side
// (glue/call.c) owns the Luna bus (com.palm.whatsapp.call), the callStateQuery
// subscription, and the audiod PCM routing.
//
// C  -> Go (exported): gowhatsapp_go_call_dial / _answer / _hangup / _hangup_all,
//                      gowhatsapp_call_video_frame_out(data,len) (glue/voipkit.cpp, Thread A ->
//                      Call.SendVideoWithDuration — see WHATSAPP_VIDEO_STATUS.md "hook it up
//                      properly" plan)
// Go -> C (glue/call.c): gowhatsapp_call_on_state(json), gowhatsapp_call_on_speaker(pcm,n),
//                        gowhatsapp_call_audio_active(on), gowhatsapp_call_read_mic(out,n)
// Go -> C (glue/voipkit.cpp): voipkit_video_receive_frame(data,len) — Call.ReceiveVideo's
//                        sink (attachMedia) forwards each peer access unit here.

/*
#include <stdlib.h>
// Implemented in glue/call.c:
extern void gowhatsapp_call_on_state(const char *json);      // full callStateQuery payload JSON
extern void gowhatsapp_call_on_speaker(const float *frame, int n); // received PCM -> speaker
extern void gowhatsapp_call_audio_active(int on);            // open/close ALSA playback+capture
extern int  gowhatsapp_call_read_mic(float *out, int n);    // Go pulls mic PCM from the C ring
extern void gowhatsapp_call_video_active(int on);            // open/note-close the clonk session (videoURI)
extern void gowhatsapp_call_request_keyframe(void);           // stop+restart capture -> fresh IDR
// Implemented in glue/voipkit.cpp:
extern void voipkit_video_receive_frame(const unsigned char *access_unit, unsigned int len);
*/
import "C"

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"sync"
	"time"
	"unsafe"

	"github.com/purpshell/meowcaller"
	"github.com/purpshell/meowcaller/diag"
	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow/types"
)

const (
	callSampleRate   = meowcaller.SampleRate   // 16000
	callFrameSamples = meowcaller.FrameSamples // 960 (60ms)
)

type callInfo struct {
	c           *meowcaller.Call
	id          string
	address     string
	displayName string
	origin      string // "incoming" | "outgoing"
	state       string // dialing|incoming|active|onHold|disconnected
	incomingVid bool
	outgoingVid bool
	// incomingVideoState mirrors the CallSynergizer tri-state (see
	// core-apps com.palm.app.phone/source/ActiveCall.js): "unavailable" (this call has
	// no video), "available" (video capability exists but the peer isn't currently
	// streaming), "streaming" (peer video actively flowing). Driven by
	// meowcaller's OnVideoState callback, see wireCall.
	incomingVideoState string
	cause              string
	mic                *micSource
	// everActive latches true the first time this call reaches "active" (peer accepted) and is
	// never cleared — state itself gets overwritten to "disconnected" on end (see setCallState),
	// so callWasAnswered needs this separately to tell "answered then hung up" apart from "never
	// answered" once the call has ended.
	everActive bool
}

var (
	callCtx  = context.Background()
	mcClient *meowcaller.Client
	// The Handler that owns the whatsmeow client/store -- used to resolve an incoming caller's @lid
	// to their phone number (Store.LIDs) so the Phone app can match it to a contact. Set in startCalling.
	callHandler *Handler

	callMu  sync.Mutex
	calls   = map[string]*callInfo{} // id -> call
	dialing bool                     // an outgoing dial is in flight (guards double-dial)

	callPrevGCPercent = 100 // GC threshold saved on call start, restored on disconnect

	// Same *diag.Recorder handed to meowcaller.WithDiagnostics below, kept here too so
	// call.go's own events (which meowcaller's engine never sees, e.g. OnVideoState) can be
	// written to the same durable /media/internal/meowcaller_diag/*.jsonl trail instead of
	// only the ephemeral fprintf(stderr,...) one, which is lost once nothing is live-tailing
	// imwrap.sh's stdout -- needed to see, after the fact, whether the peer's <video> state
	// signaling flaps right after call start (each flap tears down/rebuilds the whole clonk
	// session via gowhatsapp_call_video_active, which looks exactly like the reported
	// incoming-video black-screen/instant-teardown symptom).
	diagRec *diag.Recorder
)

// startCalling attaches meowcaller to the plugin's already-created whatsmeow client.
// MUST be called before client.Connect() so meowcaller's low-level <call> interception
// is installed before the receive loop starts (see meowcaller.NewClient docs).
func (handler *Handler) startCalling() {
	if mcClient != nil {
		// Only one calling engine is supported (single WhatsApp account). Re-linking
		// the same account replaces the engine so it tracks the live client.
		mcClient = nil
	}
	callHandler = handler
	// The MLow encoder runs inline in meowcaller's 60ms send-ticker; on the dual-core ARMv7 give the Go
	// runtime both cores so GC and the ALSA/network work overlap the encode instead of stealing from it.
	if runtime.GOMAXPROCS(0) < 2 {
		runtime.GOMAXPROCS(2)
	}
	// meowcaller's own log.Info/Warn calls (video RTP demux, SRTP unprotect, sink writes --
	// see engine_media.go) are a silent no-op (zerolog.Nop()) unless a logger is supplied here.
	// Route to os.Stderr like every other log in this process, so it lands in imstdout.log.
	mcLogger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.Kitchen}).
		With().Timestamp().Logger()
	opts := []meowcaller.Option{meowcaller.WithLogger(mcLogger)}
	// Developer diagnostics: dumps every relay packet's raw hex (plus key schedule, RTCP, etc.)
	// to <dir>/<stream>.jsonl -- needed to see WHAT a mystery non-RTP packet actually is instead
	// of just its classification/length. Opt-in only (see diag.Recorder doc: can contain raw
	// secrets/media); safe here since this is the user's own device/debugging session, not a
	// shipped default. If the directory can't be created, calling still works without it.
	if rec, err := diag.NewRecorder("/media/internal/meowcaller_diag"); err == nil {
		opts = append(opts, meowcaller.WithDiagnostics(rec))
		diagRec = rec
	} else {
		fmt.Fprintln(os.Stderr, "wacall: diag recorder unavailable:", err)
	}
	mcClient = meowcaller.NewClient(handler.client, opts...)
	mcClient.OnIncomingCall(handleIncoming)
	fmt.Fprintln(os.Stderr, "wacall: calling engine attached to messaging session")
}

// ---- mic source: meowcaller PULLS frames via ReadFrame, which pulls PCM from the C
// mic ring buffer (gowhatsapp_call_read_mic). Pure Go->C on meowcaller's own thread. ----

type micSource struct{}

func newMicSource() *micSource { return &micSource{} }

func (m *micSource) ReadFrame() ([]float32, error) {
	f := make([]float32, callFrameSamples)
	C.gowhatsapp_call_read_mic((*C.float)(unsafe.Pointer(&f[0])), C.int(callFrameSamples))
	return f, nil
}

func (m *micSource) Close() error { return nil }

// ---- call-state payload pushed to Luna subscribers (CallSynergizer line/state shape) ----

func emitCallState() {
	type callJSON struct {
		ID                 string `json:"id"`
		Address            string `json:"address"`
		DisplayName        string `json:"displayName"`
		Origin             string `json:"origin"`
		OnHold             bool   `json:"onHold"`
		IncomingVideo      bool   `json:"incomingVideo"`
		OutgoingVideo      bool   `json:"outgoingVideo"`
		IncomingVideoState string `json:"incomingVideoState"`
	}
	callMu.Lock()
	var cjs []callJSON
	lineState := ""
	cause := ""
	lineIncomingVid := false
	lineOutgoingVid := false
	lineIVS := "unavailable"
	for _, ci := range calls {
		lineState = ci.state // single call per line: the line state IS the call state
		cause = ci.cause
		ivs := ci.incomingVideoState
		if ivs == "" {
			ivs = "unavailable"
		}
		cjs = append(cjs, callJSON{
			ID: ci.id, Address: ci.address, DisplayName: ci.displayName,
			Origin: ci.origin, OnHold: ci.state == "onHold",
			IncomingVideo: ci.incomingVid, OutgoingVideo: ci.outgoingVid,
			IncomingVideoState: ivs,
		})
		// ActiveCall.js reads outgoingVideo/incomingVideo/incomingVideoState directly on
		// the LINE object (activeLines[0].outgoingVideo etc.), not nested under calls[] -
		// single call per line here, so just mirror this call's values up.
		lineIncomingVid = ci.incomingVid
		lineOutgoingVid = ci.outgoingVid
		lineIVS = ivs
	}
	callMu.Unlock()

	// CallSynergizer dispatches on the LINE-level "state" (handleActive/Incoming/
	// Disconnected) — NOT the call-level state — and logs disconnected lines.
	lines := []map[string]any{}
	if len(cjs) > 0 {
		line := map[string]any{
			"state": lineState, "calls": cjs,
			"incomingVideo": lineIncomingVid, "outgoingVideo": lineOutgoingVid,
			"incomingVideoState": lineIVS,
		}
		if lineState == "disconnected" {
			line["disconnectDetails"] = map[string]any{"cause": cause}
		}
		lines = append(lines, line)
	}
	payload := map[string]any{
		"returnValue":     true,
		"lines":           lines,
		"allowVideoCalls": true,
		"videoURI":        "",
	}
	b, _ := json.Marshal(payload)
	cs := C.CString(string(b))
	C.gowhatsapp_call_on_state(cs)
	C.free(unsafe.Pointer(cs))
}

// ---- wiring a *meowcaller.Call into our state + media ----

func wireCall(mcCall *meowcaller.Call, origin string, address string) *callInfo {
	ci := &callInfo{
		c:       mcCall,
		id:      mcCall.ID(),
		address: address,
		origin:  origin,
		mic:     newMicSource(),
	}
	if ci.address == "" {
		// Modern WhatsApp delivers an incoming caller as a @lid (an anonymised identity), NOT the phone
		// number -- so the Phone app can't match it to a contact and shows "Unknown Caller" + the raw
		// 14-digit LID. Resolve LID -> phone number via the same store the messaging side uses
		// (handler.lidToPn / Store.LIDs) and present it in the +E.164 form the WhatsApp contact records
		// are keyed on, so the caller's name resolves. Fall back to the raw id if unresolved.
		peer := mcCall.Peer()
		if callHandler != nil {
			peer = callHandler.lidToPn(peer, "incoming call peer")
		}
		if peer.Server == types.DefaultUserServer && peer.User != "" {
			ci.address = "+" + peer.User
		} else {
			ci.address = peer.User
		}
	}
	if origin == "incoming" {
		ci.state = "incoming"
	} else {
		ci.state = "dialing"
	}
	// A from-start video call (offer or our own dial-with-video) already has
	// localVideo/remoteVideo set on the meowcaller side by the time wireCall runs
	// (see engine.go's offer handling) -- IsVideo() reflects that immediately.
	if mcCall.IsVideo() {
		ci.incomingVideoState = "available"
	} else {
		ci.incomingVideoState = "unavailable"
	}

	mcCall.OnPeerAccept(func() { setCallState(ci.id, "active", "") })
	mcCall.OnReady(func() { setCallState(ci.id, "active", "") })
	mcCall.OnEnd(func(reason string) {
		if diagRec != nil {
			diagRec.Emit("clonk", map[string]any{"event": "on_end", "call_id": ci.id, "reason": reason})
		}
		C.gowhatsapp_call_video_active(C.int(0))
		setCallState(ci.id, "disconnected", reason)
	})
	// Tracks the PEER's video on/off -- independent of whether OUR OWN capture/render
	// pipeline works (see WHATSAPP_VIDEO_STATUS.md: the native clonk bug blocks local
	// camera/rendering, not the WhatsApp-level signaling this reflects).
	mcCall.OnVideoState(func(vs meowcaller.VideoState) {
		callMu.Lock()
		var anyVideo bool
		if c, ok := calls[ci.id]; ok {
			c.incomingVid = vs.Active
			switch {
			case vs.Active:
				c.incomingVideoState = "streaming"
			case c.c.IsVideo():
				c.incomingVideoState = "available"
			default:
				c.incomingVideoState = "unavailable"
			}
			anyVideo = c.outgoingVid || c.incomingVid || c.c.IsVideo()
		}
		callMu.Unlock()
		// Same fix as gowhatsapp_go_call_dial/answer: the peer's video turning on (or
		// being active from the initial offer, before changeMedia is ever called) must
		// also open the local clonk session, or voipkit_video_receive_frame silently
		// drops every frame because Thread B never started.
		on := 0
		if anyVideo {
			on = 1
		}
		// Diagnostic: correlate against video.jsonl's seq_gap/frame ts_ms to check whether
		// the peer's <video> signaling genuinely flaps (real state transitions here would
		// tear down/rebuild the local clonk pipeline via gowhatsapp_call_video_active, which
		// would visually look exactly like the reported flicker) in lockstep with the
		// measured frame-arrival stalls, or whether it fires once and stays put.
		fmt.Fprintln(os.Stderr, "wacall: OnVideoState id=", ci.id, "active=", vs.Active,
			"anyVideo=", anyVideo, "ts_ms=", time.Now().UnixMilli())
		if diagRec != nil {
			diagRec.Emit("clonk", map[string]any{
				"event": "on_video_state", "call_id": ci.id, "peer_active": vs.Active,
				"any_video": anyVideo, "video_active_arg": on,
			})
		}
		C.gowhatsapp_call_video_active(C.int(on))
		emitCallState()
	})
	// The peer's authenticated PLI/FIR feedback (packet loss recovery): our encoder should
	// make its next access unit an IDR. There's no LS2-exposed "request keyframe" on the
	// native clonk session (WHATSAPP_VIDEO_STATUS.md's "hook it up properly" plan checked --
	// ClonkPipeline::requestKeyframe() exists but isn't reachable from here), so this forces
	// one indirectly: stop and restart capture, which re-initializes the native encoder and
	// makes it emit a fresh SPS/PPS/IDR opening sequence, exactly like a fresh call start
	// (confirmed live, Part 19/20 -- every capture start begins with a real IDR).
	mcCall.OnVideoKeyframeRequest(func() {
		C.gowhatsapp_call_request_keyframe()
	})

	callMu.Lock()
	calls[ci.id] = ci
	callMu.Unlock()
	return ci
}

func setCallState(id, state, cause string) {
	callMu.Lock()
	if ci, ok := calls[id]; ok {
		ci.state = state
		if state == "active" {
			ci.everActive = true
		}
		if cause != "" {
			ci.cause = cause
		}
		if state == "disconnected" {
			if ci.mic != nil {
				ci.mic.Close()
			}
			C.gowhatsapp_call_audio_active(C.int(0)) // close ALSA playback + stop mic capture
			debug.SetGCPercent(callPrevGCPercent)   // restore normal GC pacing after the call
			// keep the disconnected call briefly so CallSynergizer logs it, then drop
			go func(delID string) { time.Sleep(1500 * time.Millisecond); dropCall(delID) }(id)
		}
	}
	callMu.Unlock()
	emitCallState()
}

func dropCall(id string) {
	callMu.Lock()
	delete(calls, id)
	callMu.Unlock()
	emitCallState()
}

// callWasAnswered reports whether the call ever reached "active" (peer accepted) at any point in
// its lifetime. Used by handler.go's CallTerminate handling to decide whether to flip a chat
// bubble from "Incoming call" to "Missed call". Defaults to false (missed) for a call ID call.go
// never tracked at all — correct for group-call notices, which this plugin can't answer anyway.
func callWasAnswered(id string) bool {
	callMu.Lock()
	defer callMu.Unlock()
	ci, ok := calls[id]
	return ok && ci.everActive
}

// callBubbleText returns the "call log" style chat bubble text for a call, keyed by whether
// call.go has this call tracked as a video call (see callInfo.c.IsVideo()). Defaults to the
// audio phrasing when the call isn't tracked here at all (e.g. a group-call notice).
func callBubbleText(id string, missed bool) string {
	video := false
	callMu.Lock()
	if ci, ok := calls[id]; ok && ci.c != nil {
		video = ci.c.IsVideo()
	}
	callMu.Unlock()
	switch {
	case missed && video:
		return "📹 Missed video call"
	case missed:
		return "📞 Missed call"
	case video:
		return "📹 Incoming video call"
	default:
		return "📞 Incoming call"
	}
}

// attachMedia connects a call's mic source and speaker sink, and opens the ALSA
// playback+capture path so the call is audible on the loudspeaker.
func attachMedia(ci *callInfo) {
	// The MLow encoder runs on a tight 60ms budget; a mid-call GC stop-the-world can stall the send
	// loop and drop a frame. Raise the GC threshold for the call's duration (fewer, and with
	// GOMAXPROCS>=2 concurrent, collections), then restore it on disconnect. Scoped to calls so the
	// transport's steady-state memory is unaffected.
	callPrevGCPercent = debug.SetGCPercent(400)
	C.gowhatsapp_call_audio_active(C.int(1)) // open playback + start mic capture -> read_mic
	ci.c.Play(ci.mic)
	ci.c.Receive(meowcaller.SinkFunc(func(frame []float32) {
		if len(frame) == 0 {
			return
		}
		C.gowhatsapp_call_on_speaker((*C.float)(unsafe.Pointer(&frame[0])), C.int(len(frame)))
	}))
	// Peer's decoded H.264 (Annex-B access units) -> glue/voipkit.cpp's Thread B, which
	// RTP-packetizes and delivers them to mediaserver's native video player. Safe to attach
	// unconditionally like Receive above: with no video active yet, voipkit_video_receive_frame
	// just no-ops (the bridge threads aren't running -- see voipkit.h).
	ci.c.ReceiveVideo(meowcaller.VideoSinkFunc(func(accessUnit []byte) {
		if len(accessUnit) == 0 {
			return
		}
		C.voipkit_video_receive_frame((*C.uchar)(unsafe.Pointer(&accessUnit[0])), C.uint(len(accessUnit)))
	}))
}

func handleIncoming(mcCall *meowcaller.Call) {
	ci := wireCall(mcCall, "incoming", "")
	attachMedia(ci)
	emitCallState() // ring the UI
}

// gowhatsapp_call_video_frame_out — called from glue/voipkit.cpp's Thread A (a native
// pthread, NOT the luna-service mainloop the rest of this section's exports assume) with one
// complete access unit reassembled from mediaserver's own camera capture pipeline. There's no
// call-id at this layer (voipkit.cpp has no notion of "which call" -- see voipkit.h), so this
// routes to whichever call is currently live, mirroring the same single-live-call fallback
// gowhatsapp_go_call_changemedia already uses elsewhere in this file.
//
//export gowhatsapp_call_video_frame_out
func gowhatsapp_call_video_frame_out(data *C.char, length C.int) {
	if length <= 0 {
		return
	}
	callMu.Lock()
	var ci *callInfo
	for _, c := range calls {
		if c.state != "disconnected" {
			ci = c
			break
		}
	}
	callMu.Unlock()
	if ci == nil {
		return
	}
	accessUnit := C.GoBytes(unsafe.Pointer(data), length)
	// Diagnostic: dump the raw bytes of our OWN encoder's output, right at the native
	// handoff point, before anything Go-side (SRTP protect, keyframeRequired gating) ever
	// touches it. Outgoing video reaches Android fine when we ANSWER but not when we DIAL,
	// even after fixing two confirmed real bugs on the dial path (a videoTx race and a
	// clonk-session double-open race) -- this checks whether the encoder itself is even
	// producing valid H.264 (correct start codes, SPS/PPS/IDR structure) specifically on
	// the dial path, the one thing about the outgoing bitstream never directly inspected
	// (the earlier hex-dump investigation this session only ever looked at INCOMING video).
	if outgoingFrameDumped < 20 {
		outgoingFrameDumped++
		fmt.Fprintf(os.Stderr, "wacall: outgoing frame #%d (%d bytes) hex=%s\n",
			outgoingFrameDumped, len(accessUnit), hex.EncodeToString(accessUnit))
	}
	if err := ci.c.SendVideoWithDuration(accessUnit, 0); err != nil {
		fmt.Fprintln(os.Stderr, "wacall: SendVideo error:", err)
	}
}

var outgoingFrameDumped int

// ============================ exported C API ============================
//
// These are called on the luna-service mainloop thread, so they MUST NOT block.
// meowcaller Call/Answer/Hangup do network I/O, so we dispatch to a goroutine and
// return immediately. State (including the real call id) flows to the UI via the
// callStateQuery subscription.

//export gowhatsapp_go_call_dial
func gowhatsapp_go_call_dial(cAddr *C.char, video C.int) *C.char {
	addr := C.GoString(cAddr)
	if mcClient == nil {
		return C.CString("")
	}
	// Dedup: the phone-app dialer double-fires dial. Refuse a second dial while one
	// is already in flight or a call is live, so we don't place two calls.
	callMu.Lock()
	busy := dialing
	for _, c := range calls {
		if c.state != "disconnected" {
			busy = true
			break
		}
	}
	if busy {
		callMu.Unlock()
		fmt.Fprintln(os.Stderr, "wacall: dial ignored (already dialing/active)")
		return C.CString("ok")
	}
	dialing = true
	callMu.Unlock()
	v := video != 0
	go func() {
		defer func() {
			callMu.Lock()
			dialing = false
			callMu.Unlock()
		}()
		fmt.Fprintln(os.Stderr, "wacall: dialing", addr, "video:", v)
		mcCall, err := mcClient.CallWithOptions(callCtx, addr, meowcaller.CallOptions{Video: v})
		if err != nil {
			fmt.Fprintln(os.Stderr, "wacall: dial error:", err)
			return
		}
		ci := wireCall(mcCall, "outgoing", addr)
		ci.outgoingVid = v
		attachMedia(ci)
		if v {
			// NOT mcCall.StartVideo(): that sends a VideoStateUpgradeRequestV2 stanza,
			// meant for upgrading an already-connected audio call to video mid-call. Our
			// offer already declares Video:true (CallWithOptions above), and placeCall
			// itself already sets localVideo/remoteVideo from opts.Video -- sending an
			// "upgrade request" on top of that, before the peer has even answered, is a
			// second, unvalidated signal that the examples/videoloop validated recipe
			// never sends (it dials with CallOptions{Video:true} and nothing else).
			// Confirmed live: this extra stanza correlated with the peer's real client
			// never starting its video encoder despite the user turning their camera on.
			//
			// gowhatsapp_call_video_active(1) is what actually opens the local clonk
			// session (videoCaptureStart/videoPlayerStart/voipkit_video_start) -- without
			// it Thread B never starts, so the peer's video would be silently dropped by
			// voipkit_video_receive_frame's own g_running guard even though signaling and
			// the relay bridge work fine. Previously only changeMedia (the Phone app's
			// mid-call video toggle) called this, so a call placed with video from the
			// start never displayed anything locally.
			//
			// Deferred rather than fired here immediately: dialing has no network
			// round-trip before this point, so opening the encoder this early races
			// ahead of the Go engine's own video-send registration (videoTx, wired up
			// inside runMedia, which only starts once a relay endpoint is known via the
			// call ack -- a later event). The encoder's first access unit -- and, per
			// gowhatsapp_call_request_keyframe's cooldown-gated stop/restart, functionally
			// the only reliably-produced IDR -- would be generated and silently dropped by
			// sendVideoFrame before videoTx exists, and every later P-frame then gets
			// gated shut by keyframeRequired until a peer PLI/FIR eventually forces a
			// disruptive capture restart.
			//
			// PREVIOUSLY gated on OnReady (first inbound audio RTP actually decoded).
			// Confirmed live this session to be the actual root cause of "peer never sees
			// our video when we dial out": OnReady depends on the peer's mic producing a
			// real, non-silence-suppressed packet -- a real test call was captured where
			// our own audio/video sent fine the whole time, but the peer's device never
			// emitted an early inbound RTP packet (silence, DTX, or timing), so OnReady
			// never fired, so gowhatsapp_call_video_active(1) never ran, so the camera
			// pipeline never opened and the peer's decoder never saw a single packet from
			// us -- for the entire call. An earlier dial-out call happened to work only
			// because inbound video/audio arrived early enough to win the race, which is
			// not a fix. OnPeerAccept fires as soon as the peer's <accept> lands (well
			// before any RTP -- runMedia/videoTx is already wired up by the earlier call
			// ack, before preaccept even), giving the same "videoTx exists" guarantee
			// without depending on anything the peer's mic does.
			//
			// ALSO now sends SetVideoEnabled(true) (a <video state="1" dec="H264"> stanza),
			// which this path never sent before. Found by re-reading WHATSAPP_VIDEO_STATUS.md
			// Part 20 -- the one and only human-confirmed "peer saw our real camera output"
			// dial-out call: it was placed by dialing with video:true (native camera NOT
			// opened automatically, exactly like today), then a SEPARATE manual
			// `changeMedia{"outgoingVideo":true}` was sent via luna-send. changeMedia's Go
			// handler, when the call is already IsVideo() (true here, since we dialed with
			// video:true), takes the SetVideoEnabled(true) branch, not StartVideo -- so the
			// historically-working recipe always included this explicit state=1 stanza on
			// top of opening the local clonk session. This is NOT the state=11
			// "VideoStateUpgradeRequestV2" stanza the comment above correctly avoids (that
			// one means "please let me add video to this call" and confused the peer); state=1
			// ("Enabled") just asserts our video is live now, and was apparently load-bearing
			// even for a call that already declared video in the offer -- contradicts this
			// codebase's own earlier assumption (engine_media.go's onVideoStanza comment) that
			// it's mid-call-upgrade-only. Every fix this session automated the *local
			// camera-open* half of what changeMedia used to do manually, but never the
			// *signaling* half -- which is very likely why dial-with-video regressed
			// somewhere after Part 20 even though the native bridge still works perfectly.
			mcCall.OnPeerAccept(func() {
				setCallState(ci.id, "active", "")
				C.gowhatsapp_call_video_active(C.int(1))
				if err := mcCall.SetVideoEnabled(true); err != nil {
					fmt.Fprintln(os.Stderr, "wacall: dial SetVideoEnabled(true) error:", err)
				}
			})
		}
		emitCallState()
		fmt.Fprintln(os.Stderr, "wacall: call placed id", ci.id)
	}()
	return C.CString("ok") // ack; real id arrives via callStateQuery
}

//export gowhatsapp_go_call_answer
func gowhatsapp_go_call_answer(cID *C.char, video C.int) C.int {
	id := C.GoString(cID)
	v := video != 0
	go func() {
		callMu.Lock()
		ci := calls[id]
		callMu.Unlock()
		if ci == nil {
			return
		}
		if err := ci.c.Answer(); err != nil {
			fmt.Fprintln(os.Stderr, "wacall: answer error:", err)
			return
		}
		if v {
			// NOT ci.c.AcceptVideo(): that sends a VideoStateUpgradeAccept stanza, meant
			// for accepting a peer's mid-call video upgrade request. engine.go's onOffer
			// (the incoming-offer handler) already sets m.localVideo/m.remoteVideo from the
			// offer's own Video flag (mirroring placeCall on the dial side), and sendAccept
			// already derives the <accept> stanza's Video field from m.localVideo||m.remoteVideo.
			// So Answer() alone already communicates video correctly; AcceptVideo() on top of
			// that is the same redundant/premature extra signal as StartVideo() was in dial().
			ci.outgoingVid = true
			// gowhatsapp_call_video_active(1) is what actually opens the local clonk session
			// (videoCaptureStart/videoPlayerStart/voipkit_video_start) -- without it Thread B
			// never starts, so the peer's video would be silently dropped by
			// voipkit_video_receive_frame's own g_running guard even though signaling and the
			// relay bridge work fine.
			C.gowhatsapp_call_video_active(C.int(1))
		}
		setCallState(id, "active", "")
	}()
	return 0
}

func hangupLive() {
	callMu.Lock()
	var live []*callInfo
	for _, c := range calls {
		if c.state != "disconnected" {
			live = append(live, c)
		}
	}
	callMu.Unlock()
	fmt.Fprintln(os.Stderr, "wacall: hangup all live:", len(live))
	for _, ci := range live {
		if ci.state == "incoming" {
			_ = ci.c.Reject()
		} else {
			_ = ci.c.Hangup()
		}
		setCallState(ci.id, "disconnected", "local")
	}
}

//export gowhatsapp_go_call_hangup_all
func gowhatsapp_go_call_hangup_all() C.int {
	go hangupLive()
	return 0
}

// changeMedia is the Phone app's video on/off toggle (core-apps VideoCall.js/
// AbstractCall.js: "changeMedia" against this service's implementation, params
// {id, outgoingVideo?, incomingVideo?} -- a field's ABSENCE means "leave that
// direction as it is", not "turn it off", matching how VideoCall.js builds the
// call (only sets the field it's actually changing).
//
// outgoingVideo:true starts a fresh audio->video upgrade (StartVideo) if the call
// doesn't have video yet, or just unmutes the camera (SetVideoEnabled) if it does --
// mirrors how dial-with-video/answer-with-video already choose between StartVideo/
// AcceptVideo elsewhere in this file. incomingVideo has no dedicated wire signal in
// the protocol (WhatsApp video state is sender-driven); it's tracked locally as
// whether we're willing to render what the peer sends.
//
//export gowhatsapp_go_call_changemedia
func gowhatsapp_go_call_changemedia(cID *C.char, hasOutgoing, outgoing, hasIncoming, incoming C.int) C.int {
	id := C.GoString(cID)
	go func() {
		callMu.Lock()
		ci := calls[id]
		if ci == nil {
			// id can lag behind the UI (same tolerance as hangup/dial elsewhere in this
			// file) -- fall back to the sole live call, if there is exactly one.
			for _, c := range calls {
				if c.state != "disconnected" {
					if ci != nil {
						ci = nil
						break
					}
					ci = c
				}
			}
		}
		callMu.Unlock()
		if ci == nil {
			fmt.Fprintln(os.Stderr, "wacall: changeMedia: no matching call for id", id)
			return
		}

		if hasOutgoing != 0 {
			want := outgoing != 0
			var err error
			switch {
			case want && ci.c.IsVideo():
				err = ci.c.SetVideoEnabled(true)
			case want:
				err = ci.c.StartVideo()
			case ci.c.IsVideo():
				err = ci.c.SetVideoEnabled(false)
			}
			if err != nil {
				fmt.Fprintln(os.Stderr, "wacall: changeMedia outgoingVideo error:", err)
			}
			ci.outgoingVid = want
		}
		if hasIncoming != 0 {
			ci.incomingVid = incoming != 0
		}

		anyVideo := ci.outgoingVid || ci.incomingVid || ci.c.IsVideo()
		on := 0
		if anyVideo {
			on = 1
		}
		C.gowhatsapp_call_video_active(C.int(on))
		emitCallState()
	}()
	return 0
}

//export gowhatsapp_go_call_hangup
func gowhatsapp_go_call_hangup(cID *C.char) C.int {
	id := C.GoString(cID)
	go func() {
		callMu.Lock()
		ci := calls[id]
		callMu.Unlock()
		if ci == nil {
			// id didn't match (or empty) — the UI's id can lag; hang up all live.
			fmt.Fprintln(os.Stderr, "wacall: hangup id not found:", id, "-> hangup all")
			hangupLive()
			return
		}
		fmt.Fprintln(os.Stderr, "wacall: hangup id", id)
		if ci.state == "incoming" {
			_ = ci.c.Reject()
		} else {
			_ = ci.c.Hangup()
		}
		setCallState(id, "disconnected", "local")
	}()
	return 0
}
