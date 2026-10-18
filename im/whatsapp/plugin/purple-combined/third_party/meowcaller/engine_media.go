package meowcaller

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/purpshell/meowcaller/diag"
	"github.com/purpshell/meowcaller/mlow"
	"github.com/purpshell/meowcaller/relay"
	"github.com/purpshell/meowcaller/rtp"
	"github.com/purpshell/meowcaller/srtp"
	"github.com/purpshell/meowcaller/stun"
	"github.com/rs/zerolog"
)

// The live-relay media loop: connect+allocate to the elected relay, then run the
// per-frame send/recv loop. Outbound pulls frames from the Call's Player (silence when
// idle), encodes via MLow + ProtectAudio, and sends to the relay; inbound classifies
// relay packets, unprotects+decodes RTP, and writes to the Call's sink.

// maybeStartMedia launches the media loop for callID once both the callKey and the relay
// endpoint are known. It is idempotent — the loop starts exactly once per call.
func (e *engine) maybeStartMedia(callID string) {
	e.mu.Lock()
	m := e.calls[callID]
	if m == nil || m.started || m.callKey == nil || m.relay == nil {
		e.mu.Unlock()
		return
	}
	m.started = true
	mctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	call := m.call
	callKey, selfLID, peerLID, rd := m.callKey, m.selfLID, m.peerLID, m.relay
	e.mu.Unlock()

	if call != nil {
		call.setPhase(CallPhaseConnecting)
	}
	e.c.log.Info().Str("call_id", callID).Msg("starting media")
	go func() {
		if err := e.runMedia(mctx, callID, call, callKey, selfLID, peerLID, rd); err != nil {
			e.c.log.Warn().Err(err).Str("call_id", callID).Msg("media ended")
		}
	}()
}

// connectAndAllocate opens the relay DataChannel and sends the STUN allocate, returning
// the channel and the allocate bytes (re-sent by the keepalive).
//
// NOT VALIDATED: live-relay only.
func (e *engine) connectAndAllocate(ctx context.Context, rd *relayData, streamSsrcs [9]uint32, peerSubscriptions [][]byte) (*relay.RelayMediaChannel, []byte, error) {
	log := e.c.log
	ep := getMediaRelayEndpoint(rd)
	if ep == nil || len(ep.addresses) == 0 {
		return nil, nil, fmt.Errorf("relay has no usable endpoint")
	}
	addr := &net.UDPAddr{IP: net.ParseIP(ep.addresses[0].ipv4), Port: int(ep.addresses[0].port)}
	log.Info().Str("relay_name", ep.relayName).Str("addr", addr.String()).Msg("connecting media transport to relay")
	e.c.diag.Emit("relay", map[string]any{
		"event": "endpoint", "relay_name": ep.relayName,
		"ipv4": ep.addresses[0].ipv4, "port": ep.addresses[0].port, "token_id": ep.tokenID,
	})

	if int(ep.tokenID) >= len(rd.relayTokens) || rd.relayTokens[ep.tokenID] == nil {
		return nil, nil, fmt.Errorf("no relay token #%d", ep.tokenID)
	}
	if len(rd.relayKeyASCII) == 0 {
		return nil, nil, fmt.Errorf("relay has no <key>")
	}
	e.c.diag.Emit("relay", map[string]any{
		"event": "keying", "token_id": ep.tokenID, "token_count": len(rd.relayTokens),
		"relay_key_hex": hex.EncodeToString(rd.relayKeyASCII),
		"token_hex":     hex.EncodeToString(rd.relayTokens[ep.tokenID]),
	})

	// Real RFC 5389/8445 ICE Binding Request, carrying the relay token as the STUN
	// USERNAME, sent on the relay's UDP socket BEFORE DTLS starts -- see
	// stun.BuildIceBindingRequest's doc comment for how this was discovered (a live
	// chrome://webrtc-internals capture of a real WhatsApp Web call) and why it's
	// suspected to be the actual gate on the relay bridging the peer's media to us: every
	// call all night reached ALLOCATE-SUCCESS + consent PONG via this codebase's own
	// custom protocol without this step, and the peer's media never once arrived.
	localUfrag := stun.GenerateIceUfrag()
	var iceTx [12]byte
	_, _ = rand.Read(iceTx[:])
	iceBindingRequest := stun.BuildIceBindingRequest(iceTx, rd.relayTokens[ep.tokenID], localUfrag, rd.relayKeyASCII, log)
	e.c.diag.Emit("stun", map[string]any{
		"event": "ice_binding_request_built", "local_ufrag": localUfrag,
		"tx_id_hex": hex.EncodeToString(iceTx[:]), "bytes": len(iceBindingRequest),
	})

	type result struct {
		ch  *relay.RelayMediaChannel
		err error
	}
	done := make(chan result, 1)
	go func() {
		ch, err := relay.ConnectRelayMedia(addr, iceBindingRequest, relay.WithLogger(log))
		done <- result{ch, err}
	}()
	var ch *relay.RelayMediaChannel
	select {
	case r := <-done:
		if r.err != nil {
			return nil, nil, fmt.Errorf("relay connect: %w", r.err)
		}
		ch = r.ch
	case <-time.After(12 * time.Second):
		return nil, nil, fmt.Errorf("relay connect timed out (DTLS didn't complete)")
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	log.Info().Str("relay_name", ep.relayName).Msg("relay DataChannel open")

	endpointXor, ok := stun.EncodeXorRelayEndpoint(ep.addresses[0].ipv4, ep.addresses[0].port, log)
	if !ok {
		ch.Close()
		return nil, nil, fmt.Errorf("bad endpoint XOR")
	}
	var tx [12]byte
	_, _ = rand.Read(tx[:])
	allocate := stun.BuildWasmStunAllocateRequestWithSubscriptions(tx, rd.relayTokens[ep.tokenID], endpointXor, streamSsrcs, peerSubscriptions, rd.relayKeyASCII, log)
	if _, err := ch.Send(allocate); err != nil {
		ch.Close()
		return nil, nil, fmt.Errorf("allocate send: %w", err)
	}
	log.Info().Int("bytes", len(allocate)).Msg("sent STUN allocate")
	e.c.diag.Emit("stun", map[string]any{
		"event": "allocate_sent", "bytes": len(allocate),
		"tx_id_hex": hex.EncodeToString(tx[:]), "allocate_hex": hex.EncodeToString(allocate),
		"stream_ssrcs": streamSsrcs,
	})
	return ch, allocate, nil
}

// runMedia runs the per-frame media loop over the relay DataChannel: the Player's frames
// (or silence) → MLow → E2E-SRTP protect → DataChannel, and DataChannel → classify →
// unprotect → MLow decode → the Call's sink. A 1 Hz allocate+ping keepalive holds the
// relay's consent freshness; the relay's binding-requests are answered with
// binding-success. The working recipe is preserved exactly: a consent ping (0x0801) goes
// out with the allocate at t+0, BEFORE any RTP; no STUN binding-requests are ever sent.
//
// NOT VALIDATED: live-relay only.
func (e *engine) runMedia(ctx context.Context, callID string, call *Call, callKey []byte, selfLID, peerLID string, rd *relayData) error {
	log := e.c.log
	selfParticipantID := rtp.FormatE2ESrtpParticipantID(selfLID)
	ssrc, err := rtp.DeriveWasmParticipantSsrc(callID, selfParticipantID, 0, log)
	if err != nil {
		return err
	}
	videoSelfSsrc, err := rtp.DeriveWasmParticipantSsrc(callID, selfParticipantID, rtp.VideoSlotWord, log)
	if err != nil {
		return err
	}
	appDataSelfSsrc, err := rtp.DeriveWasmParticipantSsrc(callID, selfParticipantID, rtp.AppDataSlotWord, log)
	if err != nil {
		return err
	}
	// The peer's video SSRC is derivable the same deterministic way as our own (SSRCs are
	// a function of call ID + participant, never negotiated) -- known before a single byte
	// of their video has arrived, which lets us target an initial PLI at it below.
	peerParticipantID := rtp.FormatE2ESrtpParticipantID(peerLID)
	peerVideoSsrc, err := rtp.DeriveWasmParticipantSsrc(callID, peerParticipantID, rtp.VideoSlotWord, log)
	if err != nil {
		return err
	}
	streamSsrcs, err := rtp.DeriveWasmRelayStreamSsrcs(callID, selfParticipantID, log)
	if err != nil {
		return err
	}
	// Peer sender-subscriptions (attr 0x4000, repeated alongside the relay token) have now
	// been tried TWICE with two different payload encodings -- CreateVoipSenderSubscriptionForLayer's
	// protobuf-style shape, and stun.CreateNativeSenderSubscription's simpler 1-byte-count +
	// BE-SSRC shape cited from the real whatsapp-rust client (wacore/src/voip/stun.rs#L121-L126)
	// -- and BOTH were rejected by the relay with the identical stun_error_code=456, confirmed
	// live via the ALLOCATE-ERROR diagnostic below. Two different payload shapes failing
	// identically points at the ATTRIBUTE ITSELF (repeating 0x4000, the same type as the
	// token) being what this relay rejects, not either specific encoding -- the relay may
	// simply not accept more than one 0x4000 attribute at all. Reverted again to nil: a
	// rejected allocate (no ALLOCATE-SUCCESS at all) is strictly worse than the current
	// baseline (ALLOCATE-SUCCESS + consent PONG, just no peer media bridged). Whatever the
	// real mechanism for requesting the peer's streams is, it is not this attribute.
	ch, allocate, err := e.connectAndAllocate(ctx, rd, streamSsrcs, nil)
	if err != nil {
		return err
	}
	defer ch.Close()

	// Durable record of what the pre-DTLS ICE Binding Request actually got back, if
	// anything -- previously only visible via ephemeral zerolog.Debug inside relay.go,
	// unrecoverable after the fact. Classify the reply the same way the receive loop below
	// classifies ALLOCATE-SUCCESS/ALLOCATE-ERROR, so a rejected or malformed ICE check
	// shows up the same way a rejected Allocate already does.
	{
		fields := map[string]any{
			"event": "ice_binding_check_result", "call_id": callID,
			"attempts": ch.IceCheckAttempts, "got_reply": ch.IceCheckReply != nil,
			"reply_bytes": len(ch.IceCheckReply), "reply_hex": hex.EncodeToString(ch.IceCheckReply),
		}
		if ch.IceCheckReply != nil {
			mt, isStun := stun.StunMessageType(ch.IceCheckReply)
			fields["is_stun"] = isStun
			fields["msg_type"] = fmt.Sprintf("0x%04x", mt)
			if stun.IsAllocateError(ch.IceCheckReply) {
				code, _ := stun.ParseStunErrorCode(ch.IceCheckReply, log)
				fields["stun_error_code"] = code
			}
		}
		e.c.diag.Emit("stun", fields)
	}

	// Force-close the channel the instant the context is cancelled (call end), instead of
	// relying solely on the deferred Close above. The receive loop below only checks
	// ctx.Err() once per iteration, BEFORE calling the blocking ch.Recv() -- cancelling ctx
	// does nothing to unblock a Recv() already in progress, so that goroutine (and its UDP
	// socket) would otherwise sit blocked until the relay happens to send it another
	// spontaneous packet, which may never come. Confirmed live: without this, every call's
	// relay socket leaked indefinitely once the relay stopped responding on that channel --
	// one real device had a dozen such abandoned sockets open after a single night of test
	// calls, all still ticking their own 1Hz keepalive forever. Closing here makes the
	// blocked Recv() return an error immediately, so the loop's ctx.Err() check (or the
	// Recv error itself) ends the goroutine right away.
	go func() {
		<-ctx.Done()
		ch.Close()
	}()

	// Send a consent ping (0x0801) immediately, together with the allocate and BEFORE any
	// RTP. The relay won't forward the peer's media until consent (ping → pong) is
	// established; RTP sent before the first ping is dropped and the relay never bridges.
	{
		var ptx [12]byte
		_, _ = rand.Read(ptx[:])
		initPing := stun.BuildWhatsappPing(ptx, log)
		_, _ = ch.Send(initPing[:])
		e.c.diag.Emit("stun", map[string]any{
			"event": "consent_ping_sent", "tx_id_hex": hex.EncodeToString(ptx[:]),
			"ping_hex": hex.EncodeToString(initPing[:]),
		})
	}

	log.Info().
		Str("self_lid", selfLID).
		Str("peer_lid", peerLID).
		Str("ssrc", fmt.Sprintf("0x%08x", ssrc)).
		Str("video_ssrc", fmt.Sprintf("0x%08x", videoSelfSsrc)).
		Str("app_data_ssrc", fmt.Sprintf("0x%08x", appDataSelfSsrc)).
		Msg("media session")
	e.c.diag.Emit("ssrc", map[string]any{
		"call_id": callID, "ssrc": ssrc, "video_ssrc": videoSelfSsrc, "app_data_ssrc": appDataSelfSsrc,
		"stream_ssrcs": streamSsrcs, "self_lid": selfLID,
		"participant_id": selfParticipantID,
	})

	enc := mlow.NewMlowEncoder(mlow.WithLogger(log))
	dec := mlow.NewMlowDecoder(mlow.WithLogger(log))
	txPipe, err := NewMediaPipeline(callKey, selfLID, peerLID, ssrc, FrameSamples, WithLogger(log))
	if err != nil {
		return err
	}
	// RTCP SDES CNAME identifies "the same participant" across streams -- audio and video
	// MUST share one CNAME (generated once per call, not once per stream) for the peer to
	// associate them, matching the "SR+SDES required for the caller's video to start
	// flowing" comment on the sender-report ticker below. Two independently-randomized
	// CNAMEs (the previous behavior) silently defeated that association on every call.
	var rtcpCnameEntropy [12]byte
	_, _ = rand.Read(rtcpCnameEntropy[:])
	rtcpCname := rtp.BuildWhatsappRtcpCname(rtcpCnameEntropy)
	audioRtcp, err := newMediaSrtcpSender(callKey, selfLID, ssrc, false, rtcpCname)
	if err != nil {
		return err
	}
	peerRtcp, err := newMediaSrtcpReceiver(callKey, peerLID)
	if err != nil {
		return err
	}
	rxPipe, err := NewMediaPipeline(callKey, selfLID, peerLID, ssrc, FrameSamples, WithLogger(log))
	if err != nil {
		return err
	}
	// The derived E2E-SRTP keys live inside MediaPipeline; record the derivation INPUTS
	// (callKey + participant-ID info strings) so a reference can re-derive and compare.
	e.c.diag.Emit("srtp", map[string]any{
		"event": "media_keys_input", "call_id": callID, "ssrc": ssrc,
		"self_participant_id": selfParticipantID,
		"peer_participant_id": rtp.FormatE2ESrtpParticipantID(peerLID),
		"call_key_hex":        hex.EncodeToString(callKey),
	})
	e.c.diag.Emit("meta", map[string]any{
		"event": "media_start", "call_id": callID, "self_lid": selfLID,
		"peer_lid": peerLID, "ssrc": ssrc,
	})

	// relayRx counts packets received from the relay, so the silence watchdog can warn if
	// the relay never answers our allocate.
	var relayRx atomic.Uint64

	// Inbound calls are torn down by the caller within ~400ms if the relay bind never
	// comes alive; check at 400ms and 900ms and say so explicitly.
	go func() {
		for _, d := range []time.Duration{400 * time.Millisecond, 900 * time.Millisecond} {
			select {
			case <-ctx.Done():
				return
			case <-time.After(d):
			}
			if relayRx.Load() == 0 {
				log.Warn().Dur("after", d).Msg("relay silent after allocate, no bytes back yet (allocate undelivered or rejected)")
			}
		}
	}()

	// Keepalive: re-send the Allocate AND a WhatsApp ping (0x0801) ~1 Hz. This matches the
	// working capture exactly — allocate+ping every second, NO STUN binding-requests at
	// all; the relay answers allocate-success + pong and bridges the peer's media.
	// Binding-requests instead flip the relay into ICE-consent mode and the bridge never
	// forms.
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		var tickCount uint64
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			var tx [12]byte
			_, _ = rand.Read(tx[:])
			ping := stun.BuildWhatsappPing(tx, log)
			if _, err := ch.Send(allocate); err != nil {
				return
			}
			_, _ = ch.Send(ping[:])
			tickCount++
			e.c.diag.Emit("stun", map[string]any{
				"event": "keepalive", "tick": tickCount,
				"tx_id_hex": hex.EncodeToString(tx[:]), "ping_hex": hex.EncodeToString(ping[:]),
			})
		}
	}()

	// Send loop: frame-paced from connect, NOT gated on the Player. WhatsApp starts media
	// on relay connection and the relay learns our SSRC from our FIRST RTP — it won't
	// bridge the peer's media until it sees our stream. So we send silence frames until the
	// Player has real audio (nextFrame() == nil means send silence).
	frameInterval := time.Duration(FrameSamples) * time.Second / SampleRate
	go func() {
		silence := make([]float32, FrameSamples)
		ticker := time.NewTicker(frameInterval)
		defer ticker.Stop()
		var txCount uint64
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			frame := silence
			if player, _ := callPlayerSink(call); player != nil {
				if f := player.nextFrame(); f != nil {
					frame = f
				}
			}
			payload, err := enc.Encode(frame)
			if err != nil {
				continue
			}
			packet, err := txPipe.ProtectAudio(payload)
			if err != nil {
				continue
			}
			e.c.diag.Emit("media_out", map[string]any{
				"frame": txCount, "frame_samples": len(frame), "pcm_rms": rmsFloat32(frame),
				"payload_len": len(payload), "payload_hex": hex.EncodeToString(payload),
				"packet_len": len(packet), "packet_hex": hex.EncodeToString(packet),
			})
			if _, err := ch.Send(packet); err != nil {
				return
			}
			if txCount++; txCount == 1 {
				log.Info().Int("bytes", len(packet)).Msg("first RTP sent to relay, outbound media flowing")
				e.c.diag.Emit("meta", map[string]any{"event": "first_rtp_sent", "call_id": callID, "bytes": len(packet)})
			}
		}
	}()

	// Receive: DataChannel → classify. RTP → unprotect → decode → sink. A non-RTP STUN
	// binding request gets a binding-success reply (ICE consent freshness, RFC 7675);
	// without it the relay drops the binding and the peer's call fails.
	// Video receive (meowcaller-native): a second WARP pipeline keyed on the video SSRC
	// (participant slot 2), demuxed off the relay by H.264 payload type 97. NALUs are
	// reassembled into Annex-B access units and emitted on the RTP marker bit, per WaCalls.
	//
	// Validated 2026-07-30 (examples/videoloop): a real two-account call confirmed video does
	// share the audio E2E keying/WARP framing and that the relay bridges the video SSRC —
	// 240/240 access units round-tripped and decoded clean.
	rxVideoPipe, err := NewMediaPipeline(callKey, selfLID, peerLID, videoSelfSsrc, FrameSamples, WithLogger(log))
	if err != nil {
		return err
	}
	rxAppDataPipe, err := NewMediaPipeline(callKey, selfLID, peerLID, appDataSelfSsrc, FrameSamples, WithLogger(log))
	if err != nil {
		return err
	}
	var peerAppDataSsrc atomic.Uint32
	setPeerAppDataSsrc := func(peer string) error {
		ssrc, err := rtp.DeriveWasmParticipantSsrc(
			callID,
			rtp.FormatE2ESrtpParticipantID(peer),
			rtp.AppDataSlotWord,
			log,
		)
		if err != nil {
			return err
		}
		peerAppDataSsrc.Store(ssrc)
		return nil
	}
	if err := setPeerAppDataSsrc(peerLID); err != nil {
		return err
	}
	rekeyPeer := func(answeringPeer string) error {
		if err := rxPipe.RekeyRecv(callKey, answeringPeer); err != nil {
			return err
		}
		if err := rxVideoPipe.RekeyRecv(callKey, answeringPeer); err != nil {
			return err
		}
		if err := rxAppDataPipe.RekeyRecv(callKey, answeringPeer); err != nil {
			return err
		}
		if err := setPeerAppDataSsrc(answeringPeer); err != nil {
			return err
		}
		return peerRtcp.rekey(callKey, answeringPeer)
	}
	e.mu.Lock()
	currentPeer := peerLID
	if m := e.calls[callID]; m != nil {
		m.rekeyPeer = rekeyPeer
		currentPeer = m.peerLID
	}
	e.mu.Unlock()
	if currentPeer != "" && currentPeer != peerLID {
		if err := rekeyPeer(currentPeer); err != nil {
			return fmt.Errorf("rekey media to answering device: %w", err)
		}
		peerLID = currentPeer
	}
	defer func() {
		e.mu.Lock()
		if m := e.calls[callID]; m != nil {
			m.rekeyPeer = nil
		}
		e.mu.Unlock()
	}()
	var videoAssembler rtp.H264AccessUnitAssembler
	var appDataRx appDataReceiver

	// Video send: a second WARP pipeline on our video SSRC, registered on the call so
	// Call.SendVideoFrame can push encoded H.264 to the relay. Cleared when the loop exits.
	txVideoPipe, err := NewMediaPipeline(callKey, selfLID, peerLID, videoSelfSsrc, FrameSamples, WithLogger(log))
	if err != nil {
		return err
	}
	videoRtcp, err := newMediaSrtcpSender(callKey, selfLID, videoSelfSsrc, true, rtcpCname)
	if err != nil {
		return err
	}
	vsender := &videoSender{
		pipe: txVideoPipe, stream: rtp.NewVideoRtpStream(videoSelfSsrc, defaultVideoRtpStepSamples),
		ch: ch, ssrc: videoSelfSsrc, callID: callID, keyframeRequired: true,
		log: log, diag: e.c.diag,
	}
	txAppDataPipe, err := NewMediaPipeline(callKey, selfLID, peerLID, appDataSelfSsrc, FrameSamples, WithLogger(log))
	if err != nil {
		return err
	}
	appSender := newAppDataSender(txAppDataPipe, appDataSelfSsrc, func(packet []byte) (int, error) {
		if header, ok := rtp.ParseRtpHeader(packet); ok {
			e.c.diag.Emit("app_data", map[string]any{
				"event": "out", "ssrc": header.Ssrc, "seq": header.SequenceNumber,
				"ts": header.Timestamp, "pt": header.PayloadType, "bytes": len(packet),
			})
		}
		return ch.Send(packet)
	})
	e.mu.Lock()
	if m := e.calls[callID]; m != nil {
		vsender.active = m.localVideo
		vsender.sendGated = m.videoGate
		m.videoTx = vsender
		m.appDataTx = appSender
	}
	e.mu.Unlock()
	defer func() {
		appSender.close()
		vsender.mu.Lock()
		vsender.ch = nil
		vsender.mu.Unlock()
		e.mu.Lock()
		if m := e.calls[callID]; m != nil {
			m.videoTx = nil
			m.appDataTx = nil
		}
		e.mu.Unlock()
	}()

	// WhatsApp associates the RTP streams with an SRTCP session. Periodic compound
	// SR+SDES packets are required for the caller's video to start flowing to the
	// answerer, and give the peer a target for PLI/FIR recovery feedback.
	//
	// gotPeerVideo is set once the receive loop below sees a first video frame from the
	// peer; until then this ticker also sends a PLI at peerVideoSsrc every tick. Real
	// video encoders commonly gate their first frame on receiving PLI/FIR feedback (this
	// codebase's own videoSender does the same thing in the other direction --
	// keyframeRequired/sendGated) — without an explicit request, the peer's encoder can
	// sit idle indefinitely even after signaling state=Enabled.
	var gotPeerVideo atomic.Bool
	// Signaled (non-blocking, capacity 1) the moment the receive loop below sees the relay's
	// first ALLOCATE-SUCCESS. The reference client (whatsapp-rust's voip engine.rs) sends its
	// first RTCP SR+SDES announcement immediately when allocation succeeds, not on a fixed
	// ticker -- our own code previously wired the SR+SDES ticker independently of allocate
	// state, so it could wait up to a full 1500ms after ALLOCATE-SUCCESS before this call's
	// first self-announcement ever reaches the relay. Matching the reference's immediate
	// announcement removes that gap.
	allocated := make(chan struct{}, 1)
	go func() {
		ticker := time.NewTicker(1500 * time.Millisecond)
		defer ticker.Stop()
		var sent uint64
		var firSeqNr uint8
		// Grace window (found live 2026-08-06): our own clonk DISPLAY pipeline opens ~200ms after
		// the first inbound video RTP arrives (OnVideoState -> videoCaptureStart/videoPlayerStart,
		// async), but skypekit's Thread B silently DROPS every frame handed to it before that
		// pipeline is up. If the peer sends its first IDR fast -- before our ~200ms startup -- that
		// IDR is dropped, and because gotPeerVideo flips true on that very first packet we then STOP
		// requesting keyframes, leaving the decoder stuck on P-frames referencing an IDR it never
		// saw (blank/frozen video until the peer volunteers another IDR, or the user toggles a
		// camera). Symptom seen live: video occasionally never displays on an incoming call until a
		// manual camera toggle. Fix: keep sending PLI/FIR for a couple ticks AFTER first video too,
		// so a fresh IDR is requested once our display pipeline is guaranteed ready. The extra 1-2
		// PLIs are harmless (real clients send them routinely on decode gaps).
		const pliGraceTicks = 2
		var firstVideoTick uint64
		var haveFirstVideo bool
		doTick := func(now time.Time) bool {
			audioPacket, err := audioRtcp.senderReport(txPipe.SenderStats(), uint64(now.UnixMilli()))
			if err != nil {
				return false
			}
			if _, err = ch.Send(audioPacket); err != nil {
				return false
			}
			videoStats := txVideoPipe.SenderStats()
			if videoStats.PacketsSent > 0 {
				videoPacket, err := videoRtcp.senderReport(videoStats, uint64(now.UnixMilli()))
				if err != nil {
					return false
				}
				if _, err = ch.Send(videoPacket); err != nil {
					return false
				}
			}
			gv := gotPeerVideo.Load()
			if gv && !haveFirstVideo {
				haveFirstVideo = true
				firstVideoTick = sent
			}
			// Request a keyframe while no video has arrived, AND for pliGraceTicks afterward, to
			// survive the clonk-display-startup drop window (see the pliGraceTicks comment above).
			inGraceWindow := haveFirstVideo && sent < firstVideoTick+pliGraceTicks
			if !gv || inGraceWindow {
				pliPacket, err := videoRtcp.pli(peerVideoSsrc)
				if err == nil {
					_, _ = ch.Send(pliPacket)
					e.c.diag.Emit("rtcp", map[string]any{
						"event": "pli_sent", "peer_video_ssrc": peerVideoSsrc, "in_grace": inGraceWindow,
					})
				}
				firSeqNr++
				firPacket, ferr := videoRtcp.fir(peerVideoSsrc, firSeqNr)
				if ferr == nil {
					_, _ = ch.Send(firPacket)
				}
				if sent%4 == 0 || inGraceWindow {
					log.Info().Uint32("peer_video_ssrc", peerVideoSsrc).Uint8("fir_seq", firSeqNr).
						Bool("pli_ok", err == nil).Bool("fir_ok", ferr == nil).Bool("post_video_grace", inGraceWindow).
						Msg("sent PLI+FIR keyframe request")
				}
			}
			sent++
			if sent == 1 {
				log.Info().Uint32("peer_video_ssrc", peerVideoSsrc).Msg("started periodic SRTCP sender reports")
			}
			e.c.diag.Emit("rtcp", map[string]any{
				"event": "sender_reports", "tick": sent,
				"audio_packets": txPipe.SenderStats().PacketsSent,
				"video_packets": videoStats.PacketsSent,
			})
			return true
		}
		select {
		case <-ctx.Done():
			return
		case <-allocated:
			if !doTick(time.Now()) {
				return
			}
		case now := <-ticker.C:
			if !doTick(now) {
				return
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				if !doTick(now) {
					return
				}
			}
		}
	}()

	buf := make([]byte, 1500)
	var rtpIn, rtpSeen, unprotectFail, rtpInspect, vidIn, appDataIn, appDataUnprotectFail, videoUnprotectFail, videoFrameIn, videoSinkMissing, rtcpIn, rtcpAuthFail, allocOK, allocErr, pongIn uint64
	var hexCaptured uint64
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, err := ch.Recv(buf)
		if err != nil {
			return fmt.Errorf("relay recv: %w", err)
		}
		relayRx.Add(1)
		pkt := buf[:n]
		packetKind := relay.ClassifyRelayPacket(pkt)
		isRTP := packetKind == relay.RelayPacketRtp
		e.c.diag.Emit("relay", map[string]any{
			"event": "packet_in", "bytes": n, "is_rtp": isRTP,
			"packet_hex": hex.EncodeToString(pkt),
		})
		switch packetKind {
		case relay.RelayPacketRtcp:
			senderSsrc, ok := rtp.ParseRtcpSenderSsrc(pkt)
			if !ok {
				continue
			}
			plain, index, ok := peerRtcp.unprotect(senderSsrc, pkt)
			if !ok {
				if rtcpAuthFail++; rtcpAuthFail == 1 {
					log.Warn().Uint32("ssrc", senderSsrc).Msg("peer SRTCP failed authentication")
				}
				e.c.diag.Emit("rtcp", map[string]any{
					"event": "auth_failed", "ssrc": senderSsrc, "bytes": n,
				})
				continue
			}
			if rtcpIn++; rtcpIn == 1 {
				log.Info().Uint32("ssrc", senderSsrc).Uint32("index", index).Msg("first authenticated peer SRTCP received")
			}
			keyframe := rtp.RtcpRequestsKeyframe(plain, videoSelfSsrc)
			if keyframe {
				vsender.requestKeyframe()
				if call != nil {
					call.requestVideoKeyframe()
				}
				log.Debug().Uint32("video_ssrc", videoSelfSsrc).Msg("peer requested a video keyframe")
			}
			e.c.diag.Emit("rtcp", map[string]any{
				"event": "in", "ssrc": senderSsrc, "index": index,
				"plain_hex": hex.EncodeToString(plain), "requests_keyframe": keyframe,
			})
			continue
		case relay.RelayPacketStun:
			mt, isStun := stun.StunMessageType(pkt)
			if isStun && mt == stun.MsgBindingRequest {
				if txid, ok := stun.StunTransactionID(pkt); ok && len(txid) == 12 {
					var tx [12]byte
					copy(tx[:], txid)
					resp := stun.EncodeStunRequest(stun.MsgBindingSuccess, tx, nil, rd.relayKeyASCII, true, log)
					if _, err := ch.Send(resp); err != nil {
						return fmt.Errorf("relay send binding-success: %w", err)
					}
					e.c.diag.Emit("stun", map[string]any{
						"event":     "binding_request_answered",
						"tx_id_hex": hex.EncodeToString(tx[:]), "resp_hex": hex.EncodeToString(resp),
					})
				}
			}
			// The relay's own Allocate/Pong responses were previously absorbed here silently --
			// IsAllocateOrBindingSuccess/IsAllocateError/IsWhatsappPong/ParseStunErrorCode
			// already existed but were never called from the receive path, so a rejected
			// allocate (wrong token, malformed stream descriptor, anything) looked identical
			// to "working fine, just no peer media yet" in every log we had.
			if mt == stun.MsgAllocateSuccess {
				if allocOK++; allocOK == 1 {
					log.Info().Msg("relay ALLOCATE-SUCCESS received")
					e.c.diag.Emit("stun", map[string]any{"event": "allocate_success", "call_id": callID})
					select {
					case allocated <- struct{}{}:
					default:
					}
				}
			}
			if stun.IsAllocateError(pkt) {
				code, _ := stun.ParseStunErrorCode(pkt, log)
				if allocErr++; allocErr == 1 {
					log.Warn().Uint16("stun_error_code", code).Msg("relay ALLOCATE-ERROR received -- this is why nothing bridges")
					e.c.diag.Emit("stun", map[string]any{
						"event": "allocate_error", "call_id": callID, "stun_error_code": code,
					})
				}
			}
			if stun.IsWhatsappPong(pkt, nil) {
				if pongIn++; pongIn == 1 {
					log.Info().Msg("relay consent PONG received, ping/pong consent established")
					e.c.diag.Emit("stun", map[string]any{"event": "pong_received", "call_id": callID})
				}
			}
			continue
		case relay.RelayPacketOther:
			continue
		}
		if rtpSeen++; rtpSeen == 1 {
			log.Info().Int("bytes", n).Msg("first RTP-classified packet from relay, relay is bridging the peer's media")
		}
		vh, vok := rtp.ParseRtpHeader(pkt)
		if vok {
			if rtpInspect < 20 || vh.PayloadType == rtp.RtpPayloadTypeH264 || vh.PayloadType == rtp.RtpPayloadTypeAppData {
				log.Debug().
					Uint8("payload_type", vh.PayloadType).
					Uint32("ssrc", vh.Ssrc).
					Uint16("seq", vh.SequenceNumber).
					Uint32("timestamp", vh.Timestamp).
					Bool("marker", vh.Marker).
					Int("bytes", n).
					Msg("relay RTP packet summary")
			}
			rtpInspect++
		}
		if !vok {
			continue
		}
		kind := classifyMediaPayload(vh)
		if kind == mediaPayloadAppData {
			wantSsrc := peerAppDataSsrc.Load()
			if vh.Ssrc != wantSsrc {
				log.Warn().Uint32("ssrc", vh.Ssrc).Uint32("expected_ssrc", wantSsrc).Msg("dropping app-data RTP from unexpected SSRC")
				e.c.diag.Emit("app_data", map[string]any{
					"event": "ssrc_mismatch", "ssrc": vh.Ssrc, "expected_ssrc": wantSsrc,
				})
				continue
			}
			hdr, payload, ok := rxAppDataPipe.UnprotectAudio(pkt)
			if !ok {
				if appDataUnprotectFail++; appDataUnprotectFail == 1 {
					log.Warn().Uint32("ssrc", vh.Ssrc).Uint16("seq", vh.SequenceNumber).Msg("app-data RTP arrived but failed to unprotect")
				}
				e.c.diag.Emit("app_data", map[string]any{"event": "unprotect_failed", "ssrc": vh.Ssrc, "seq": vh.SequenceNumber})
				continue
			}
			handled, err := handleAppDataReaction(call, &appDataRx, payload)
			if err != nil {
				log.Warn().Err(err).Uint32("ssrc", hdr.Ssrc).Uint16("seq", hdr.SequenceNumber).Msg("invalid RTC app-data payload")
				e.c.diag.Emit("app_data", map[string]any{
					"event": "decode_failed", "ssrc": hdr.Ssrc, "seq": hdr.SequenceNumber,
					"payload_hex": hex.EncodeToString(payload), "error": err.Error(),
				})
				continue
			}
			e.c.diag.Emit("app_data", map[string]any{
				"event": "in", "ssrc": hdr.Ssrc, "seq": hdr.SequenceNumber,
				"ts": hdr.Timestamp, "handled": handled, "payload_hex": hex.EncodeToString(payload),
			})
			if handled {
				if appDataIn++; appDataIn == 1 {
					log.Info().Uint32("ssrc", hdr.Ssrc).Msg("first RTC call reaction received")
				}
			}
			continue
		}
		// Demux H.264 (PT 97) to video and emit Annex-B access units on the marker bit.
		// Source of truth: https://github.com/JotaDev66/WaCalls/blob/2d6a1f666426049a89ef9541414e771acdcf8a16/internal/voip/call/callmanager_video.go#L86-L126
		if kind == mediaPayloadVideo {
			// Any video RTP at all, unprotected or not, means the peer's encoder is
			// running -- stop sending PLIs once that's established.
			gotPeerVideo.Store(true)
			_, vpayload, vunok := rxVideoPipe.UnprotectAudio(pkt)
			if !vunok {
				if videoUnprotectFail++; videoUnprotectFail == 1 {
					log.Warn().
						Uint32("ssrc", vh.Ssrc).
						Uint16("seq", vh.SequenceNumber).
						Msg("video RTP arrived but failed to unprotect")
				}
				e.c.diag.Emit("video", map[string]any{"event": "unprotect_failed", "ssrc": vh.Ssrc, "seq": vh.SequenceNumber})
				continue
			}
			// H264AccessUnitAssembler (upstream purpshell/meowcaller, rtp/h264.go) replaces our
			// previous manual depacketize-and-concatenate loop, which had NO loss/reorder recovery
			// at all: a single dropped or reordered RTP packet mid-frame silently corrupted the
			// reassembled access unit (wrong NAL boundaries / missing reference data) and handed
			// it straight to mediaserver's decoder anyway -- previously only logged via the
			// seq_gap diagnostic, never actually acted on. Matches the exact empirically-found
			// symptom this session: video sometimes never displays after a call connects, and
			// forcing the peer to toggle their camera (a fresh, guaranteed-clean IDR) is what
			// recovers it. The assembler now discards a corrupted access unit and withholds every
			// subsequent frame until a real IDR arrives, instead of ever handing the decoder
			// something broken -- self-healing the same way the camera-toggle workaround does,
			// but automatically and without user intervention.
			frame, complete, recoveryNeeded := videoAssembler.Push(vh.SequenceNumber, vh.Marker, vpayload)
			if recoveryNeeded {
				e.c.diag.Emit("video", map[string]any{
					"event": "recovery", "ssrc": vh.Ssrc, "seq": vh.SequenceNumber,
				})
			}
			if complete && len(frame) > 0 {
				fields := map[string]any{"event": "frame", "ssrc": vh.Ssrc, "bytes": len(frame)}
				// Dump reassembled access units in full so a real corruption (bad NAL types,
				// missing/garbled SPS-PPS, wrong start codes) can be inspected directly instead
				// of inferred. Capped so a long call cannot blow up the log.
				if (videoFrameIn < 8 || recoveryNeeded) && hexCaptured < 60 {
					fields["frame_hex"] = hex.EncodeToString(frame)
					fields["nal_types"] = h264NalTypes(frame)
					hexCaptured++
				}
				e.c.diag.Emit("video", fields)
				if sink := callVideoSink(call); sink != nil {
					if err := sink.WriteVideo(frame); err != nil {
						log.Warn().Err(err).Uint32("ssrc", vh.Ssrc).Int("bytes", len(frame)).Msg("failed to write WhatsApp video frame to sink")
					} else {
						if videoFrameIn == 0 {
							log.Info().Uint32("ssrc", vh.Ssrc).Int("bytes", len(frame)).Msg("first WhatsApp video frame written to sink")
						}
						videoFrameIn++
					}
				} else {
					if videoSinkMissing == 0 {
						log.Warn().Uint32("ssrc", vh.Ssrc).Int("bytes", len(frame)).Msg("WhatsApp video frame arrived with no sink attached")
					}
					videoSinkMissing++
				}
			}
			if vidIn++; vidIn == 1 {
				log.Info().Uint32("ssrc", vh.Ssrc).Msg("first video RTP demuxed from relay")
				e.c.diag.Emit("meta", map[string]any{"event": "first_video_rtp_in", "call_id": callID, "ssrc": vh.Ssrc})
				// The peer's <video state=1> stanza is only sent for a mid-call audio->video
				// upgrade, never for video that was already present in the initial offer/accept
				// (confirmed: zero OnVideoState firings across many real from-start video calls).
				// Without this, OnVideoState's caller-side "streaming" flag never flips even
				// though real decoded video is on its way, so a UI that shows a placeholder
				// until "streaming" arrives would show nothing but that placeholder for the
				// entire call. Real video RTP actually arriving is a stronger, always-true
				// substitute signal for "the peer's video is live" than that stanza is.
				if call != nil {
					if fn := call.onVideoStateFn(); fn != nil {
						fn(VideoState{Active: true, Raw: 1})
					}
				}
			}
			continue
		}
		if kind != mediaPayloadAudio {
			log.Debug().Uint8("payload_type", vh.PayloadType).Uint32("ssrc", vh.Ssrc).Msg("dropping unknown RTP payload")
			e.c.diag.Emit("rtp", map[string]any{
				"event": "unknown_payload", "pt": vh.PayloadType, "ssrc": vh.Ssrc,
				"seq": vh.SequenceNumber, "ts": vh.Timestamp,
			})
			continue
		}
		hdr, payload, ok := rxPipe.UnprotectAudio(pkt)
		if !ok {
			if unprotectFail++; unprotectFail == 1 {
				log.Warn().Int("bytes", n).Msg("RTP arrived but failed to unprotect, keying/SSRC mismatch on the recv path")
			}
			e.c.diag.Emit("srtp", map[string]any{"event": "unprotect_failed", "bytes": n})
			continue
		}
		e.c.diag.Emit("rtp", map[string]any{
			"event": "in", "ssrc": hdr.Ssrc, "seq": hdr.SequenceNumber,
			"ts": hdr.Timestamp, "pt": hdr.PayloadType, "marker": hdr.Marker,
		})
		e.c.diag.Emit("srtp", map[string]any{
			"event": "frame_unprotected", "ssrc": hdr.Ssrc, "seq": hdr.SequenceNumber,
			"payload_len": len(payload), "payload_hex": hex.EncodeToString(payload),
		})
		frame := dec.Decode(payload)
		e.c.diag.Emit("media_in", map[string]any{
			"seq": hdr.SequenceNumber, "samples": len(frame),
			"pcm_rms": rmsFloat32(frame), "payload_len": len(payload),
		})
		if _, sink := callPlayerSink(call); sink != nil {
			_ = sink.WriteFrame(frame)
		}
		if rtpIn++; rtpIn == 1 {
			log.Info().Msg("first RTP decoded from relay, inbound audio flowing")
			e.c.diag.Emit("meta", map[string]any{"event": "first_rtp_in", "call_id": callID})
			if call != nil {
				call.setPhase(CallPhaseActive)
				if fn := call.onReadyFn(); fn != nil {
					fn()
				}
			}
		}
	}
}

// callPlayerSink returns a Call's current Player and sink, tolerating a nil Call (an
// outbound call may never have had one attached).
func callPlayerSink(call *Call) (*Player, AudioSink) {
	if call == nil {
		return nil, nil
	}
	return call.playerAndSink()
}

// callVideoSink returns a Call's inbound-video sink, tolerating a nil Call.
func callVideoSink(call *Call) VideoSink {
	if call == nil {
		return nil
	}
	return call.videoSinkRef()
}

const defaultVideoRtpStepSamples = 90000 / 30

func videoRtpDurationSamples(duration time.Duration) uint32 {
	if duration <= 0 {
		return defaultVideoRtpStepSamples
	}
	samples := uint32((duration.Nanoseconds()*90000 + int64(time.Second)/2) / int64(time.Second))
	if samples == 0 {
		return defaultVideoRtpStepSamples
	}
	return samples
}

// videoSender packetizes encoded H.264 access units (Annex-B) into PT-97 RTP, E2E-SRTP
// protects them with the video pipeline, and sends them to the relay. The send path is
// fed encoded H.264 (e.g. from the VideoBridge / WebCodecs), not raw frames.
//
// Validated 2026-07-30 (examples/videoloop): 240/240 sent access units arrived at the peer
// and decoded clean over a real two-account WhatsApp call.
type videoSender struct {
	mu               sync.Mutex
	pipe             *MediaPipeline
	stream           *rtp.VideoRtpStream
	ch               *relay.RelayMediaChannel
	ssrc             uint32
	callID           string
	frame            uint64
	logged           bool
	active           bool
	sendGated        bool
	keyframeRequired bool
	log              zerolog.Logger
	diag             *diag.Recorder
}

type mediaSrtcpSender struct {
	mu      sync.Mutex
	keys    srtp.E2eSrtpKeys
	ssrc    uint32
	cname   [rtp.WhatsappRtcpCnameLen]byte
	profile bool
	index   uint32
}

type mediaSrtcpReceiver struct {
	mu   sync.Mutex
	keys srtp.E2eSrtpKeys
}

func newMediaSrtcpReceiver(callKey []byte, peerLID string) (*mediaSrtcpReceiver, error) {
	keys, err := srtp.DeriveE2eSrtcpKeys(callKey, rtp.FormatE2ESrtpParticipantID(peerLID))
	if err != nil {
		return nil, err
	}
	return &mediaSrtcpReceiver{keys: keys}, nil
}

func (r *mediaSrtcpReceiver) rekey(callKey []byte, peerLID string) error {
	keys, err := srtp.DeriveE2eSrtcpKeys(callKey, rtp.FormatE2ESrtpParticipantID(peerLID))
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.keys = keys
	r.mu.Unlock()
	return nil
}

func (r *mediaSrtcpReceiver) unprotect(senderSSRC uint32, packet []byte) ([]byte, uint32, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return srtp.UnprotectSrtcp(&r.keys, senderSSRC, packet)
}

func newMediaSrtcpSender(callKey []byte, selfLID string, ssrc uint32, profile bool, cname [rtp.WhatsappRtcpCnameLen]byte) (*mediaSrtcpSender, error) {
	keys, err := srtp.DeriveE2eSrtcpKeys(callKey, rtp.FormatE2ESrtpParticipantID(selfLID))
	if err != nil {
		return nil, err
	}
	return &mediaSrtcpSender{
		keys: keys, ssrc: ssrc, cname: cname,
		profile: profile, index: 1,
	}, nil
}

func (s *mediaSrtcpSender) senderReport(stats rtp.RtcpSenderStats, nowMs uint64) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	plain := rtp.BuildSenderReportWithSdes(s.ssrc, &stats, nowMs, &s.cname, s.profile)
	packet, err := srtp.ProtectSrtcp(&s.keys, s.ssrc, s.index, plain)
	if err == nil {
		s.index++
	}
	return packet, err
}

// pli builds and protects a Picture Loss Indication requesting a keyframe from
// mediaSsrc (the peer's video SSRC). s must be the sender's own video RTCP context
// (SSRC identifies us as the PLI's sender).
func (s *mediaSrtcpSender) pli(mediaSsrc uint32) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	plain := rtp.BuildRtcpPli(s.ssrc, mediaSsrc)
	packet, err := srtp.ProtectSrtcp(&s.keys, s.ssrc, s.index, plain[:])
	if err == nil {
		s.index++
	}
	return packet, err
}

// fir builds and protects a Full Intra Request (RFC 5104) requesting a keyframe from
// mediaSsrc -- an alternative to pli() above that some real clients require instead of
// (or alongside) PLI before their encoder will start sending video at all. seqNr must
// increment across calls for the same target (RFC 5104 4.3.1.1) so the receiver can tell
// a fresh request apart from a stale retransmit.
func (s *mediaSrtcpSender) fir(mediaSsrc uint32, seqNr uint8) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	plain := rtp.BuildRtcpFir(s.ssrc, mediaSsrc, seqNr)
	packet, err := srtp.ProtectSrtcp(&s.keys, s.ssrc, s.index, plain[:])
	if err == nil {
		s.index++
	}
	return packet, err
}

func (vs *videoSender) protectAccessUnit(au []byte, duration time.Duration) [][]byte {
	vs.mu.Lock()
	defer vs.mu.Unlock()
	return vs.protectAccessUnitLocked(au, duration)
}

func (vs *videoSender) protectAccessUnitLocked(au []byte, duration time.Duration) [][]byte {
	if !vs.active || vs.sendGated {
		return nil
	}
	idr := rtp.AUHasIDR(au)
	// Previously dropped every non-IDR frame here while keyframeRequired was true, waiting for
	// the next native-capture-restart-produced IDR (debounced to at most once per 5s -- see
	// KEYFRAME_COOLDOWN_US in glue/call.c -- specifically to avoid a documented self-inflicted
	// restart storm). That meant a single genuine peer PLI/FIR -- which arrives far more often
	// than every 5s when the peer isn't decoding anything -- could silently starve the
	// outgoing stream down to ~1-2 frames every 5 seconds for the entire call (confirmed live
	// via diagnostics this session, on the one direction where the peer's real WhatsApp client
	// never once instantiates a video decoder). A receiver that hasn't started decoding yet
	// has no "wrong reference frame" state to corrupt by receiving P-frames -- sending it a
	// continuous real stream, even one that occasionally references a keyframe it may have
	// missed, gives its jitter buffer/decoder-setup logic actual data to reason about, instead
	// of confirming its own suspicion that the stream is dead and never bothering to spin up a
	// decoder at all. Keep tracking keyframeRequired (cleared below once an IDR gets through)
	// purely for the mediaFrameInfo IDR/Delta marking -- just stop using it to withhold frames.
	nalus := rtp.SplitAnnexB(au)
	var packedAccessUnit []byte
	for _, n := range nalus {
		if len(n) == 0 || n[0]&0x1f == 9 {
			continue
		}
		if len(packedAccessUnit) > 0 {
			packedAccessUnit = append(packedAccessUnit, 0, 0, 0, 1)
		}
		packedAccessUnit = append(packedAccessUnit, n...)
	}
	if len(packedAccessUnit) == 0 {
		return nil
	}
	// WhatsApp fragments the WHOLE Annex-B access unit as one RTP NAL unit (STAP/FU-A over
	// the combined SPS+PPS+IDR blob), not one RTP unit per NALU. Found by diffing against
	// upstream purpshell/meowcaller@2d1c5bfe ("match WhatsApp access unit packetization"):
	// our previous per-NALU packetization sent real, valid H.264 (confirmed via our own
	// wire diagnostics -- every frame reached the relay with no errors) in a framing a real
	// WhatsApp client's depacketizer never reassembles correctly, so nothing ever decoded
	// on the peer's end despite our own send-side reporting success the whole time.
	payloads := rtp.PackageH264NALU(packedAccessUnit)
	vs.stream.SetTimestampStride(videoRtpDurationSamples(duration))
	mediaFrameInfo := rtp.VideoMediaFrameInfoDelta
	if idr {
		mediaFrameInfo = rtp.VideoMediaFrameInfoIDR
	}
	packets := make([][]byte, 0, len(payloads))
	for i, payload := range payloads {
		header := vs.stream.NextPacket(i == len(payloads)-1, mediaFrameInfo)
		packet, err := vs.pipe.ProtectRTP(&header, payload)
		if err == nil {
			packets = append(packets, packet)
		}
	}
	if len(packets) > 0 && idr {
		vs.keyframeRequired = false
	}
	return packets
}

func (vs *videoSender) enable(sendGated bool) {
	vs.mu.Lock()
	needsRecovery := !vs.active || (vs.sendGated && !sendGated)
	vs.active = true
	vs.sendGated = sendGated
	vs.keyframeRequired = vs.keyframeRequired || needsRecovery
	vs.mu.Unlock()
}

func (vs *videoSender) disable() {
	vs.mu.Lock()
	vs.active = false
	vs.sendGated = false
	vs.keyframeRequired = true
	vs.mu.Unlock()
}

func (vs *videoSender) requestKeyframe() {
	vs.mu.Lock()
	vs.keyframeRequired = true
	vs.mu.Unlock()
}

// send fragments one Annex-B access unit into PT-97 RTP packets (marker on the last) and
// sends them to the relay.
func (vs *videoSender) send(au []byte, duration time.Duration) {
	if vs == nil || len(au) == 0 {
		return
	}
	vs.mu.Lock()
	defer vs.mu.Unlock()
	if vs.ch == nil {
		return
	}
	packets := vs.protectAccessUnitLocked(au, duration)
	if len(packets) == 0 {
		return
	}
	sent := 0
	wireBytes := 0
	for _, pkt := range packets {
		if _, err := vs.ch.Send(pkt); err != nil {
			return
		}
		sent++
		wireBytes += len(pkt)
	}
	frame := vs.frame
	if sent > 0 {
		vs.frame++
		if frame < 10 || frame%30 == 0 {
			vs.diag.Emit("video_out", map[string]any{
				"event": "frame", "call_id": vs.callID, "frame": frame,
				"ssrc": vs.ssrc, "rtp_ts": vs.pipe.SenderStats().RtpTimestamp,
				"packets": sent, "access_unit_bytes": len(au),
				"wire_bytes": wireBytes, "duration_ms": duration.Milliseconds(),
				"duration_samples": videoRtpDurationSamples(duration),
			})
		}
	}
	if sent > 0 && !vs.logged {
		vs.logged = true
		vs.log.Info().
			Int("packets", sent).
			Uint32("ssrc", vs.ssrc).
			Msg("first video RTP sent to relay, outbound video flowing")
	}
}

// h264NalTypes lists each NAL unit's type byte (Annex-B, per SplitAnnexB) in an access
// unit, e.g. "7,8,5" for SPS,PPS,IDR -- lets a diagnostic reader spot a malformed
// reassembly (missing SPS/PPS before an IDR, an unexpected type) without decoding hex.
func h264NalTypes(au []byte) string {
	nalus := rtp.SplitAnnexB(au)
	types := make([]string, 0, len(nalus))
	for _, n := range nalus {
		if len(n) == 0 {
			continue
		}
		types = append(types, fmt.Sprintf("%d", n[0]&0x1f))
	}
	return strings.Join(types, ",")
}

// rmsFloat32 returns the root-mean-square level of a PCM frame, a cheap loudness
// metric for the media diagnostic streams (avoids inlining raw float32 PCM).
func rmsFloat32(f []float32) float64 {
	if len(f) == 0 {
		return 0
	}
	var sum float64
	for _, s := range f {
		sum += float64(s) * float64(s)
	}
	return math.Sqrt(sum / float64(len(f)))
}
