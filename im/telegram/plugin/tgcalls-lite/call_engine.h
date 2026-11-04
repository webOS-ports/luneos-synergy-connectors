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

namespace tgcalls_lite {

class CallEngine {
public:
	// key256 must point to 256 bytes (copied internally, see EncryptedConnection -- caller doesn't
	// need to keep its own buffer alive past this call). isOutgoing matches call.is_outgoing_ /
	// the caller/callee split. isVideo matches call.is_video_ -- gates whether a video
	// MediaContent is offered/expected at all.
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

	// One complete captured local H.264 access unit (Annex-B, from voipkit.cpp's Thread A /
	// VoipKitVideoSource-equivalent capture path) to RTP-packetize and send to the peer.
	void sendVideoAccessUnit(const uint8_t *accessUnit, size_t len);

	// Fires with bytes to relay via td_api::sendCallSignalingData (already encrypted).
	std::function<void(const std::vector<uint8_t> &data)> onOutgoingSignalingData;
	// Fires once the underlying MediaSession reaches Ready (ICE connected, DTLS-SRTP live).
	std::function<void()> onMediaReady;
	// Fires with one complete decrypted+depacketized incoming H.264 access unit (Annex-B) --
	// call.cpp wires this to voipkit_video_receive_frame().
	std::function<void(const uint8_t *accessUnit, unsigned int len)> onVideoAccessUnit;

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
	void sendAudioFrame(const uint8_t *opusPacket, int len);

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
	GMainContext *_ctx;

	EncryptedConnection _enc;
	MediaSession _media;
	AudioPipeline _audio;
	bool _isOutgoing;
	bool _isVideo;
	bool _sentInitialSetup = false;
	unsigned _ticks = 0;
	std::unique_ptr<ContentNegotiator> _negotiator;

	uint32_t _localAudioSsrc;
	uint32_t _localVideoSsrc;
	uint16_t _audioSeq = 0;
	uint32_t _audioTimestamp = 0;
	uint16_t _videoSeq = 0;
	uint32_t _videoTimestamp = 0;

	void *_h264Depacketizer = nullptr; // h264_depacketizer*, opaque here to avoid pulling h264_rtp.h in
};

} // namespace tgcalls_lite

#endif
