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
// Fixed payload-type/clockrate assumptions (NOT yet negotiated against a real peer's own numbers --
// see handleParsedMessage's NegotiateChannels case): Opus PT 111 @ 48000Hz (the near-universal
// WebRTC/tgcalls default), H.264 PT 100 @ 90000Hz. Real interop may need these to track a peer's
// own declared numbers instead of assuming symmetry -- a live-peer-testing concern, not something
// resolvable further without one.
#ifndef TGCALLS_LITE_CALL_ENGINE_H
#define TGCALLS_LITE_CALL_ENGINE_H

#include <glib.h>

#include <cstdint>
#include <vector>
#include <memory>
#include <functional>

#include "encrypted_connection.h"
#include "media_session.h"
#include "signaling_message.h"
#include "audio_pipeline.h"

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

	// Begins ICE gathering only (safe to call unconditionally -- no hardware resource contention).
	// Once gathering completes, sends our InitialSetupMessage + CandidatesMessage +
	// NegotiateChannelsMessage via onOutgoingSignalingData automatically.
	void start();

	// Opens the ALSA "voipsource"/"voip" devices for real audio capture/playback. Deliberately
	// SEPARATE from start(): these are the SAME device names libtgvoip's own AudioInputALSA/
	// AudioOutputALSA use for every call today (see plugin/libtgvoip/os/linux/Audio{Input,Output}
	// ALSA.cpp) -- calling this while that path is also active for the same call would have both
	// competing for the same ALSA hardware (EBUSY or worse). Call this ONLY once tgcalls-lite is
	// actually the active engine for a call (i.e. together with, not before, the real switch-over
	// in getCallProtocol() -- see call.cpp's comment on why that hasn't happened yet). NOT called
	// anywhere in call.cpp yet as of this writing -- deliberately left for that switch-over.
	bool startAudio();

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

	// Drive periodically (e.g. every 500ms) for DTLS retransmission timers.
	void tick();

private:
	void sendInitialSetupAndCandidates();
	void sendNegotiateChannels();
	void handleParsedMessage(const SignalingMessage &msg);
	void emitEncrypted(const SignalingMessage &msg);
	void handleIncomingRtp(const uint8_t *payload, int len);

	EncryptedConnection _enc;
	MediaSession _media;
	AudioPipeline _audio;
	bool _isOutgoing;
	bool _isVideo;
	bool _sentInitialSetup = false;
	bool _sentNegotiateChannels = false;

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
