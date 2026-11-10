// call_engine.h — the top-level tgcalls-lite orchestrator: owns one EncryptedConnection (signaling
// channel crypto) + one MediaSession (ICE+DTLS+SRTP) + one AudioPipeline (Opus capture/playback)
// per call, and exposes exactly the shape tgcalls' own ExternalSignalingConnection does (see
// reference/tgcalls/tgcalls/v2/ExternalSignalingConnection.h) -- a plain send-bytes/receive-bytes
// pair -- so wiring this into the real call lifecycle (td-client.cpp/call.cpp) is a thin adapter
// over td_api::sendCallSignalingData / td_api::updateNewCallSignalingData, not new protocol logic.
//
// This class builds/parses signaling::Message JSON (via signaling_message.h), drives MediaSession
// from what it learns (peer's ICE credentials/candidates/DTLS fingerprint), negotiates codecs via
// NegotiateChannelsMessage, and owns the RTP packetization for both audio (raw Opus payload, one
// frame per packet) and video (H.264 via the existing h264_rtp.c/.h RFC 6184 packetizer, the same
// code voipkit.cpp already uses for its own LOCAL RTP framing to mediaserver -- reused here for
// the REAL peer-facing RTP instead).
//
// Payload types: we offer Opus (111) and H.264 (100); what is actually sent and accepted comes from
// the NegotiateChannels exchange (content_negotiation.h).
//
// Video, as tgcalls V2 does it: our camera is one send-only video content, added when it goes on
// and removed when it goes off, each time with a new offer; the peer's camera is the video content
// in its offers. Our camera state and picture rotation go to the peer in MediaState messages over
// the signalling channel (tgcalls sends them over an SCTP data channel tgcalls-lite does not have,
// but handles them from either). Keyframes are asked for with RTCP PLI both ways.
#ifndef TGCALLS_LITE_CALL_ENGINE_H
#define TGCALLS_LITE_CALL_ENGINE_H

#include <glib.h>

#include <cstdint>
#include <vector>
#include <memory>
#include <functional>
#include <string>
#include <deque>
#include <mutex>

#include "encrypted_connection.h"
#include "media_session.h"
#include "signaling_message.h"
#include "audio_pipeline.h"
#include "content_negotiation.h"
#include "video_receiver.h"

namespace tgcalls_lite {

class CallEngine {
public:
	// key256 must point to 256 bytes (copied internally, see EncryptedConnection -- caller doesn't
	// need to keep its own buffer alive past this call). isOutgoing matches call.is_outgoing_ /
	// the caller/callee split. isVideo: our camera is on from the start (see
	// setVideoSending()); the peer's video is received whenever it offers some.
	CallEngine(GMainContext *ctx, const uint8_t *key256, bool isOutgoing, bool isVideo);
	~CallEngine();

	CallEngine(const CallEngine &) = delete;
	CallEngine &operator=(const CallEngine &) = delete;

	// STUN/TURN servers from callStateReady; call before start(). Returns how many were applied.
	size_t setServers(const std::vector<RtcServer> &servers);

	// Begins ICE gathering only (safe to call unconditionally -- no hardware resource contention).
	// Once gathering completes, sends our InitialSetupMessage + CandidatesMessage +
	// NegotiateChannelsMessage via onOutgoingSignalingData automatically.
	void start();

	// Starts call audio through PulseAudio (see audio_pipeline.h); only once this engine carries
	// the call, so no other engine holds the call devices. Returns false if audio could not start.
	// Captured frames are encrypted and sent on this engine's GMainContext thread.
	bool startAudio(const std::string &sink = "voipcall", const std::string &source = "webcall");

	// One encoded Opus frame to send. May be called from any thread, but not concurrently with
	// the destructor: frames are queued in order and sent from this engine's GMainContext, or
	// dropped if the engine has been destroyed by then.
	void postEncodedAudio(const uint8_t *opusPacket, int len);

	// Feed bytes received via td_api::updateNewCallSignalingData here (still encrypted -- this
	// class owns decrypting them).
	void handleIncomingSignalingData(const std::vector<uint8_t> &data);

	// Our camera on or off (the constructor's isVideo is the initial state). Renegotiates and
	// tells the peer. Engine thread only.
	void setVideoSending(bool on);
	bool videoSending() const { return _videoOn; }

	// How far the receiver must turn our picture clockwise to show it upright: 0, 90, 180 or
	// 270. Sent in MediaState and, when the peer accepted it, in each frame's RTP header (CVO).
	// Engine thread only.
	void setVideoRotation(int degrees);

	// One complete encoded camera access unit (Annex-B, AU-aligned) to send. May be called from
	// any thread, but not concurrently with the destructor; queued in order and sent from the
	// engine's GMainContext. When the queue overflows, the queued units are dropped, units are
	// skipped until the next IDR and onKeyframeRequested fires so the encoder makes one soon.
	void postVideoAccessUnit(const uint8_t *accessUnit, size_t len);

	// One complete access unit to RTP-packetize and send now. Engine thread only.
	void sendVideoAccessUnit(const uint8_t *accessUnit, size_t len);

	// Asks the peer for an IDR (RTCP PLI), at most once a second. Engine thread only.
	void requestPeerKeyframe();

	// What the NegotiateChannels exchanges settled on so far. Engine thread only.
	const NegotiatedCodecs &negotiatedCodecs() const { return _negotiator->codecs(); }

	// Fires with bytes to relay via td_api::sendCallSignalingData (already encrypted).
	std::function<void(const std::vector<uint8_t> &data)> onOutgoingSignalingData;
	// Fires once the underlying MediaSession reaches Ready (ICE connected, DTLS-SRTP live).
	std::function<void()> onMediaReady;
	// Fires with each complete incoming H.264 access unit (Annex-B) a decoder can use: the
	// stream starts at an IDR, and after a loss continues from the next one.
	std::function<void(const uint8_t *accessUnit, unsigned int len)> onVideoAccessUnit;
	// Our encoder should make its next access unit an IDR: the peer asked (PLI/FIR), or units
	// were dropped on the way out.
	std::function<void()> onKeyframeRequested;
	// The peer's camera came on (true) or went off: its offer gained or lost the video content.
	std::function<void(bool on)> onIncomingVideoChanged;

	// Fires with each received Opus payload, on the engine's thread, before it goes to playback.
	std::function<void(const uint8_t *opusPacket, int len)> onAudioFrame;

	// Drive periodically (e.g. every 500ms) for DTLS retransmission timers. Also logs packet and
	// audio counters every 10th tick for the first 120 ticks, then every 60th.
	void tick();

	// Logs the packet and audio counters once.
	void logStats() const;

private:
	void sendInitialSetupAndCandidates();
	void sendOfferIfNeeded();
	void handleParsedMessage(const SignalingMessage &msg);
	void emitEncrypted(const SignalingMessage &msg);
	void handleIncomingRtp(const uint8_t *packet, int len);
	void handleIncomingRtcp(const uint8_t *packet, int len);
	void sendAudioFrame(const uint8_t *opusPacket, int len);
	std::vector<MediaContent> localContents() const;
	void sendMediaState();
	bool negotiationStarted() const;
	void noteIncomingVideo();

	// Encoded audio waiting to be sent, in capture order, shared with the drain posted to the
	// context so that drain can tell whether this engine still exists.
	struct AudioQueue {
		CallEngine *engine = nullptr; // cleared, under mx, when the engine goes away
		std::mutex mx;
		std::deque<std::vector<uint8_t>> frames;
		bool drainScheduled = false;
	};
	static constexpr size_t kMaxQueuedAudio = 25; // 500 ms; older frames are dropped
	void drainAudio();
	std::shared_ptr<AudioQueue> _audioQueue;

	// Encoded camera access units waiting to be sent, as AudioQueue.
	struct VideoQueue {
		CallEngine *engine = nullptr;
		std::mutex mx;
		std::deque<std::vector<uint8_t>> units;
		bool drainScheduled = false;
		bool waitIdr = false;        // dropped some: skip to the next IDR
		bool keyframeWanted = false; // tell onKeyframeRequested on the engine thread
		uint64_t dropped = 0;        // units never sent
	};
	static constexpr size_t kMaxQueuedVideo = 6; // 200 ms at 30 fps
	void drainVideo();
	std::shared_ptr<VideoQueue> _videoQueue;
	GMainContext *_ctx;

	EncryptedConnection _enc;
	MediaSession _media;
	AudioPipeline _audio;
	bool _isOutgoing;
	bool _videoOn;
	int _videoRotation = 0; // degrees
	bool _sentInitialSetup = false;
	bool _peerOffered = false;   // the peer's first offer has arrived
	bool _mediaReady = false;
	unsigned _ticks = 0;
	// An unanswered offer is sent again under a new exchangeId every kOfferRetryTicks, at most
	// kMaxOfferRetries times (see ContentNegotiator::renewOffer()).
	static constexpr unsigned kOfferRetryTicks = 4; // 2 s at the usual 500 ms tick
	static constexpr unsigned kMaxOfferRetries = 5;
	// How long the caller waits for the callee's offer before offering first. Current Telegram
	// apps offer as the callee within the same second as ICE and DTLS start (logged on Sargo,
	// 2026-11-10 04:22:24 and 04:45:50), so 3 ticks (1-1.5 s) is enough, and a callee that only
	// offers after answering costs that long before its media is negotiated.
	static constexpr unsigned kFirstOfferHoldTicks = 3;
	unsigned _firstOfferHoldTick = 0;
	unsigned _offerTick = 0;
	unsigned _offerRetries = 0;
	void emitOffer(NegotiateChannelsMessage offer);
	std::unique_ptr<ContentNegotiator> _negotiator;

	uint32_t _localAudioSsrc;
	uint32_t _localVideoSsrc;
	uint32_t _localVideoRtxSsrc; // offered in the FID group, never sent on
	uint32_t pick_rtx_ssrc() const;
	uint16_t _audioSeq = 0;
	uint32_t _audioTimestamp = 0;
	uint16_t _videoSeq = 0;
	uint32_t _videoTimestamp = 0;
	uint32_t _videoTimestampBase;
	bool _sentVideo = false;

	std::unique_ptr<VideoReceiver> _videoRx;
	int _rxVideoPt = -1;          // the incoming video channel the receiver is set up for
	uint32_t _rxVideoSsrc = 0;
	gint64 _lastPliUs = 0;

	struct VideoStats {
		uint64_t ausOut = 0, plisOut = 0, keyframeRequestsIn = 0;
	};
	VideoStats _videoStats;
};

} // namespace tgcalls_lite

#endif
