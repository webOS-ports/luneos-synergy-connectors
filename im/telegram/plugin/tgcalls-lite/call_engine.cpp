#include "call_engine.h"
#include "signaling_message.h"
#include "../tdlib-purple/h264_rtp.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <ctime>

namespace tgcalls_lite {

namespace {

constexpr uint8_t kOpusPayloadType = 111;  // near-universal WebRTC/tgcalls default
constexpr uint32_t kOpusClockRate = 48000;
constexpr uint8_t kH264PayloadType = 100;  // matches voipkit.cpp's kRtpPayloadType convention
constexpr uint32_t kH264ClockRate = 90000;
constexpr uint32_t kH264TimestampPerFrame = 3000; // 90kHz/30fps, matches voipkit.cpp's own comment
constexpr uint32_t kOpusTimestampPerFrame = 960;  // 1:1 with sample count at 48kHz, RFC 7587
constexpr size_t kRtpHeaderLen = 12;
constexpr size_t kVideoRtpMtu = 1200; // matches voipkit.cpp's kRtpMtu

void build_rtp_header(uint8_t *hdr, uint8_t payloadType, uint16_t seq, uint32_t ts, uint32_t ssrc, int marker) {
	hdr[0] = 0x80;
	hdr[1] = (uint8_t)((marker ? 0x80 : 0) | (payloadType & 0x7f));
	hdr[2] = (uint8_t)(seq >> 8);
	hdr[3] = (uint8_t)(seq & 0xff);
	hdr[4] = (uint8_t)(ts >> 24);
	hdr[5] = (uint8_t)(ts >> 16);
	hdr[6] = (uint8_t)(ts >> 8);
	hdr[7] = (uint8_t)(ts & 0xff);
	hdr[8] = (uint8_t)(ssrc >> 24);
	hdr[9] = (uint8_t)(ssrc >> 16);
	hdr[10] = (uint8_t)(ssrc >> 8);
	hdr[11] = (uint8_t)(ssrc & 0xff);
}

uint32_t random_ssrc() {
	// Not cryptographically random -- SSRC collision avoidance doesn't need that, just needs to
	// differ from whatever the peer picks (astronomically likely with a 32-bit space either way).
	return ((uint32_t)rand() << 16) ^ (uint32_t)rand();
}

MediaContent build_audio_content(uint32_t ssrc) {
	MediaContent c;
	c.type = MediaContent::Type::Audio;
	c.ssrc = ssrc;
	PayloadType opus;
	opus.id = kOpusPayloadType;
	opus.name = "opus";
	opus.clockrate = kOpusClockRate;
	opus.channels = 2; // RFC 7587: Opus is always declared as 2 channels in SDP regardless of the
	                    // actual encoded channel count (a real per-packet property, not fixed by
	                    // the payload type) -- matches every real WebRTC/tgcalls implementation.
	c.payloadTypes.push_back(opus);
	return c;
}

MediaContent build_video_content(uint32_t ssrc) {
	MediaContent c;
	c.type = MediaContent::Type::Video;
	c.ssrc = ssrc;
	PayloadType h264;
	h264.id = kH264PayloadType;
	h264.name = "H264";
	h264.clockrate = kH264ClockRate;
	h264.parameters.push_back({"packetization-mode", "1"});
	// Constrained Baseline, level 3.1 (42e01f) -- matches the profile most existing tgcalls/
	// WebRTC-based H.264 hardware encoders (including this project's own OMX path, per
	// TELEGRAM_VIDEO_STATUS.md's confirmed-live H.264 encode) default to offering.
	h264.parameters.push_back({"profile-level-id", "42e01f"});
	FeedbackType nack; nack.type = "nack"; nack.subtype = "";
	h264.feedbackTypes.push_back(nack);
	FeedbackType pli; pli.type = "nack"; pli.subtype = "pli";
	h264.feedbackTypes.push_back(pli);
	c.payloadTypes.push_back(h264);
	return c;
}

} // namespace

CallEngine::CallEngine(GMainContext *ctx, const uint8_t *key256, bool isOutgoing, bool isVideo)
	: _enc(key256, isOutgoing), _media(ctx, isOutgoing), _isOutgoing(isOutgoing), _isVideo(isVideo) {
	static bool seeded = false;
	if (!seeded) { srand((unsigned)time(nullptr)); seeded = true; }
	_localAudioSsrc = random_ssrc();
	_localVideoSsrc = random_ssrc();

	auto *depkt = new h264_depacketizer();
	h264_depacketizer_init(depkt);
	_h264Depacketizer = depkt;

	_media.onGatheringDone = [this]() {
		sendInitialSetupAndCandidates();
		sendNegotiateChannels();
	};
	_media.onStateChanged = [this](MediaSessionState s) {
		if (s == MediaSessionState::Ready && onMediaReady) onMediaReady();
	};
	_media.onRtpReceived = [this](const uint8_t *payload, int len) { handleIncomingRtp(payload, len); };

	_audio.onEncodedFrame = [this](const uint8_t *opusPacket, int len) {
		uint8_t pkt[kRtpHeaderLen + 1500];
		if ((size_t)len > sizeof(pkt) - kRtpHeaderLen) return; // implausibly large Opus packet, drop
		build_rtp_header(pkt, kOpusPayloadType, _audioSeq++, _audioTimestamp, _localAudioSsrc, 1);
		_audioTimestamp += kOpusTimestampPerFrame;
		memcpy(pkt + kRtpHeaderLen, opusPacket, len);
		int totalLen = (int)(kRtpHeaderLen + len);
		_media.sendRtp(pkt, &totalLen);
	};
}

CallEngine::~CallEngine() {
	if (_h264Depacketizer) {
		auto *depkt = static_cast<h264_depacketizer *>(_h264Depacketizer);
		h264_depacketizer_free(depkt);
		delete depkt;
	}
}

void CallEngine::start() {
	_media.start();
}

bool CallEngine::startAudio() {
	if (!_audio.start()) {
		fprintf(stderr, "tgcalls-lite: AudioPipeline::start() failed -- call will have no audio\n");
		return false;
	}
	return true;
}

void CallEngine::handleIncomingSignalingData(const std::vector<uint8_t> &data) {
	auto plaintext = _enc.decrypt(data);
	if (!plaintext) {
		fprintf(stderr, "tgcalls-lite: dropped undecryptable/replayed signaling packet (%zu bytes)\n", data.size());
		return;
	}
	SignalingMessage msg;
	if (!signaling_message_parse(plaintext->data(), plaintext->size(), &msg)) {
		fprintf(stderr, "tgcalls-lite: dropped unparseable signaling message (%zu bytes)\n", plaintext->size());
		return;
	}
	handleParsedMessage(msg);
}

void CallEngine::handleParsedMessage(const SignalingMessage &msg) {
	switch (msg.type) {
		case SignalingMessageType::InitialSetup: {
			const auto &setup = msg.initialSetup;
			_media.setRemoteIceCredentials(setup.ufrag, setup.pwd);
			if (!setup.fingerprints.empty()) {
				// Only sha-256/single-fingerprint handled for now -- matches the one profile
				// DtlsTransport offers (see its header comment on SRTP_AES128_CM_SHA1_80 being
				// the only cipher suite currently wired up).
				_media.setRemoteDtlsFingerprint(setup.fingerprints[0].fingerprint);
			}
			break;
		}
		case SignalingMessageType::Candidates: {
			for (const auto &c : msg.candidates.iceCandidates) {
				if (!_media.addRemoteCandidateSdp(c.sdpString)) {
					fprintf(stderr, "tgcalls-lite: failed to parse peer candidate: %s\n", c.sdpString.c_str());
				}
			}
			break;
		}
		case SignalingMessageType::NegotiateChannels: {
			// NOT full codec negotiation: we log what the peer offered but keep using our own
			// fixed PT/clockrate assumptions (kOpusPayloadType/kH264PayloadType above) rather than
			// adopting the peer's numbers, even if they differ. Real interop against a live peer
			// may require tracking the peer's own declared payload type per content instead of
			// assuming symmetry -- not resolvable further without one.
			for (const auto &c : msg.negotiateChannels.contents) {
				const char *typeName = (c.type == MediaContent::Type::Video) ? "video" : "audio";
				fprintf(stderr, "tgcalls-lite: peer offered %s content, ssrc=%u, %zu payload type(s)\n",
				        typeName, c.ssrc, c.payloadTypes.size());
				for (const auto &pt : c.payloadTypes) {
					fprintf(stderr, "tgcalls-lite:   payloadType id=%u name=%s clockrate=%u\n",
					        pt.id, pt.name.c_str(), pt.clockrate);
				}
			}
			break;
		}
		case SignalingMessageType::MediaState:
			// Mute/video-state signaling -- not yet implemented.
			break;
		default:
			break;
	}
}

void CallEngine::sendInitialSetupAndCandidates() {
	if (_sentInitialSetup) {
		// Gathering can complete more than once conceptually shouldn't happen for a single
		// MediaSession, but guard anyway -- only ever send InitialSetup once per call.
		return;
	}
	_sentInitialSetup = true;

	SignalingMessage setupMsg;
	setupMsg.type = SignalingMessageType::InitialSetup;
	_media.getLocalIceCredentials(&setupMsg.initialSetup.ufrag, &setupMsg.initialSetup.pwd);
	setupMsg.initialSetup.supportsRenomination = false;
	DtlsFingerprint fp;
	fp.hash = "sha-256";
	fp.setup = "actpass"; // matches tgcalls' own InitialSetupMessage -- see MediaSession's header
	                       // comment on the fixed caller=server/callee=client convention this
	                       // engine uses instead of actually respecting a peer's explicit setup.
	fp.fingerprint = _media.getLocalDtlsFingerprint();
	setupMsg.initialSetup.fingerprints.push_back(fp);
	emitEncrypted(setupMsg);

	SignalingMessage candMsg;
	candMsg.type = SignalingMessageType::Candidates;
	for (const auto &sdp : _media.getLocalCandidateSdpStrings()) {
		IceCandidate c;
		c.sdpString = sdp;
		candMsg.candidates.iceCandidates.push_back(c);
	}
	emitEncrypted(candMsg);
}

void CallEngine::sendNegotiateChannels() {
	if (_sentNegotiateChannels) return;
	_sentNegotiateChannels = true;

	SignalingMessage msg;
	msg.type = SignalingMessageType::NegotiateChannels;
	msg.negotiateChannels.exchangeId = 1;
	msg.negotiateChannels.contents.push_back(build_audio_content(_localAudioSsrc));
	if (_isVideo) {
		msg.negotiateChannels.contents.push_back(build_video_content(_localVideoSsrc));
	}
	emitEncrypted(msg);
}

void CallEngine::emitEncrypted(const SignalingMessage &msg) {
	auto bytes = signaling_message_serialize(msg);
	auto encrypted = _enc.encrypt(bytes);
	if (onOutgoingSignalingData) onOutgoingSignalingData(encrypted);
}

void CallEngine::handleIncomingRtp(const uint8_t *payload, int len) {
	if (len < (int)kRtpHeaderLen) return;
	uint8_t pt = payload[1] & 0x7f;
	const uint8_t *rtpPayload = payload + kRtpHeaderLen;
	size_t rtpPayloadLen = (size_t)len - kRtpHeaderLen;
	int marker = (payload[1] & 0x80) ? 1 : 0;

	if (pt == kOpusPayloadType) {
		_audio.receiveEncodedFrame(rtpPayload, (int)rtpPayloadLen);
	} else if (pt == kH264PayloadType) {
		auto *depkt = static_cast<h264_depacketizer *>(_h264Depacketizer);
		const unsigned char *au = nullptr;
		size_t auLen = 0;
		if (h264_depacketizer_feed(depkt, rtpPayload, rtpPayloadLen, marker, &au, &auLen)) {
			if (onVideoAccessUnit) onVideoAccessUnit(au, (unsigned int)auLen);
		}
	}
	// Unknown payload type (e.g. RTCP that slipped through, or a codec we don't recognize): drop.
}

void CallEngine::sendVideoAccessUnit(const uint8_t *accessUnit, size_t len) {
	struct Ctx { CallEngine *self; };
	Ctx ctx{this};
	_videoTimestamp += kH264TimestampPerFrame;
	h264_packetize(accessUnit, len, kVideoRtpMtu,
		[](void *vctx, const unsigned char *rtpPayload, size_t payloadLen, int marker) {
			auto *c = static_cast<Ctx *>(vctx);
			CallEngine *self = c->self;
			uint8_t pkt[kRtpHeaderLen + kVideoRtpMtu];
			if (payloadLen > kVideoRtpMtu) return; // h264_packetize already respects mtu; defensive only
			build_rtp_header(pkt, kH264PayloadType, self->_videoSeq++, self->_videoTimestamp,
			                  self->_localVideoSsrc, marker);
			memcpy(pkt + kRtpHeaderLen, rtpPayload, payloadLen);
			int totalLen = (int)(kRtpHeaderLen + payloadLen);
			self->_media.sendRtp(pkt, &totalLen);
		}, &ctx);
}

void CallEngine::tick() {
	_media.tick();
}

} // namespace tgcalls_lite
