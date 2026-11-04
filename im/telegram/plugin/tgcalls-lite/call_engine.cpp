#include "call_engine.h"
#include "signaling_message.h"
#include "rtp_header.h"
#include "../tdlib-purple/h264_rtp.h"

#include <cstdio>
#include <cstring>

namespace tgcalls_lite {

namespace {

constexpr uint8_t kOpusPayloadType = 111;  // what we offer; the peer's answer keeps our ids
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
	// An SSRC only has to differ from the peer's; it need not be secret. GLib seeds this
	// generator from /dev/urandom, so two calls in the same second do not repeat it.
	return g_random_int();
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
	opus.parameters.push_back({"minptime", "10"});
	opus.parameters.push_back({"useinbandfec", "1"});
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
	FeedbackType fir; fir.type = "ccm"; fir.subtype = "fir";
	h264.feedbackTypes.push_back(fir);
	c.payloadTypes.push_back(h264);
	return c;
}

uint32_t random_exchange_id() {
	uint32_t id;
	do {
		id = g_random_int();
	} while (id == 0);
	return id;
}

} // namespace

CallEngine::CallEngine(GMainContext *ctx, const uint8_t *key256, bool isOutgoing, bool isVideo)
	: _enc(key256, isOutgoing), _media(ctx, isOutgoing), _isOutgoing(isOutgoing), _isVideo(isVideo) {
	_localAudioSsrc = random_ssrc();
	do {
		_localVideoSsrc = random_ssrc();
	} while (_localVideoSsrc == _localAudioSsrc);

	std::vector<MediaContent> local;
	local.push_back(build_audio_content(_localAudioSsrc));
	if (_isVideo) local.push_back(build_video_content(_localVideoSsrc));
	_negotiator = std::make_unique<ContentNegotiator>(isOutgoing, std::move(local));

	auto *depkt = new h264_depacketizer();
	h264_depacketizer_init(depkt);
	_h264Depacketizer = depkt;

	_media.onGatheringDone = [this]() {
		sendInitialSetupAndCandidates();
		// As in tgcalls, the caller offers first; the callee offers once it has answered.
		if (_isOutgoing) sendOfferIfNeeded();
	};
	_media.onStateChanged = [this](MediaSessionState s) {
		if (s == MediaSessionState::Ready && onMediaReady) onMediaReady();
	};
	_media.onRtpReceived = [this](const uint8_t *payload, int len) { handleIncomingRtp(payload, len); };

	_audio.onEncodedFrame = [this](const uint8_t *opusPacket, int len) {
		const int pt = _negotiator->codecs().outgoingAudioPt;
		if (pt < 0 || len <= 0) return; // the peer has not accepted our audio yet
		uint8_t pkt[kRtpHeaderLen + 1500];
		if ((size_t)len > sizeof(pkt) - kRtpHeaderLen) return; // implausibly large Opus packet, drop
		build_rtp_header(pkt, (uint8_t)pt, _audioSeq++, _audioTimestamp, _localAudioSsrc, 1);
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

size_t CallEngine::setServers(const std::vector<RtcServer> &servers) {
	return _media.setServers(servers);
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
				// tgcalls sends one sha-256 fingerprint. Our DTLS role is fixed (caller = client),
				// which is what a tgcalls peer's "actpass" (caller) or "passive" (callee) gives.
				const std::string &peerSetup = setup.fingerprints[0].setup;
				if (peerSetup == (_isOutgoing ? "active" : "passive"))
					g_warning("tgcalls-lite: peer DTLS setup \"%s\" conflicts with our role", peerSetup.c_str());
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
			if (auto answer = _negotiator->handleRemote(msg.negotiateChannels)) {
				SignalingMessage reply;
				reply.type = SignalingMessageType::NegotiateChannels;
				reply.negotiateChannels = std::move(*answer);
				emitEncrypted(reply);
			}
			sendOfferIfNeeded();
			const auto &c = _negotiator->codecs();
			g_message("tgcalls-lite: negotiated audio in=%d out=%d, video in=%d out=%d",
			          c.incomingAudioPt, c.outgoingAudioPt, c.incomingVideoPt, c.outgoingVideoPt);
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
	fp.setup = _isOutgoing ? "actpass" : "passive"; // as tgcalls' sendInitialSetup()
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

void CallEngine::sendOfferIfNeeded() {
	auto offer = _negotiator->takeOffer(random_exchange_id());
	if (!offer) return;
	SignalingMessage msg;
	msg.type = SignalingMessageType::NegotiateChannels;
	msg.negotiateChannels = std::move(*offer);
	emitEncrypted(msg);
}

void CallEngine::emitEncrypted(const SignalingMessage &msg) {
	auto bytes = signaling_message_serialize(msg);
	auto encrypted = _enc.encrypt(bytes);
	if (encrypted.empty()) {
		g_warning("tgcalls-lite: could not encrypt a signaling message");
		return;
	}
	if (onOutgoingSignalingData) onOutgoingSignalingData(encrypted);
}

void CallEngine::handleIncomingRtp(const uint8_t *packet, int len) {
	RtpPacketInfo rtp;
	if (len <= 0 || !parse_rtp_header(packet, (size_t)len, rtp)) return;
	const uint8_t *payload = packet + rtp.payloadOffset;
	const auto &codecs = _negotiator->codecs();

	if (rtp.payloadType == codecs.incomingAudioPt) {
		if (rtp.payloadLength > 0) _audio.receiveEncodedFrame(payload, (int)rtp.payloadLength);
	} else if (rtp.payloadType == codecs.incomingVideoPt) {
		auto *depkt = static_cast<h264_depacketizer *>(_h264Depacketizer);
		const unsigned char *au = nullptr;
		size_t auLen = 0;
		if (h264_depacketizer_feed(depkt, payload, rtp.payloadLength, rtp.marker ? 1 : 0, &au, &auLen)) {
			if (onVideoAccessUnit) onVideoAccessUnit(au, (unsigned int)auLen);
		}
	}
	// Anything else (not negotiated, or not yet): drop.
}

void CallEngine::sendVideoAccessUnit(const uint8_t *accessUnit, size_t len) {
	const int pt = _negotiator->codecs().outgoingVideoPt;
	if (pt < 0) return; // the peer has not accepted our video
	struct Ctx { CallEngine *self; uint8_t pt; };
	Ctx ctx{this, (uint8_t)pt};
	_videoTimestamp += kH264TimestampPerFrame;
	h264_packetize(accessUnit, len, kVideoRtpMtu,
		[](void *vctx, const unsigned char *rtpPayload, size_t payloadLen, int marker) {
			auto *c = static_cast<Ctx *>(vctx);
			CallEngine *self = c->self;
			uint8_t pkt[kRtpHeaderLen + kVideoRtpMtu];
			if (payloadLen > kVideoRtpMtu) return; // h264_packetize already respects mtu; defensive only
			build_rtp_header(pkt, c->pt, self->_videoSeq++, self->_videoTimestamp,
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
