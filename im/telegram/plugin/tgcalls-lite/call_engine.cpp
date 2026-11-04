#include "call_engine.h"
#include "signaling_message.h"
#include "rtp_header.h"
#include "video_rtcp.h"
#include "../tdlib-purple/h264_rtp.h"

#include <srtp2/srtp.h>

#include <cstdio>
#include <cstring>

namespace tgcalls_lite {

namespace {

constexpr uint8_t kOpusPayloadType = 111;  // what we offer; the peer's answer keeps our ids
constexpr uint32_t kOpusClockRate = 48000;
constexpr uint8_t kH264PayloadType = 100;  // matches voipkit.cpp's kRtpPayloadType convention
constexpr uint32_t kH264ClockRate = 90000;
constexpr uint32_t kOpusTimestampPerFrame = 960;  // 1:1 with sample count at 48kHz, RFC 7587
constexpr size_t kRtpHeaderLen = 12;
constexpr size_t kVideoRtpMtu = 1200; // matches voipkit.cpp's kRtpMtu
// A one-byte-header extension block (RFC 8285) with one 1-byte element, padded to a word.
constexpr size_t kCvoExtensionLen = 8;
// srtp_protect() and srtp_protect_rtcp() write their trailer behind the packet.
constexpr size_t kSrtpRoom = SRTP_MAX_TRAILER_LEN + 4;
constexpr int kTgcallsVideoRotationExtId = 13; // the id tgcalls offers it under
constexpr gint64 kPliMinIntervalUs = G_USEC_PER_SEC;

int rotation_quarter_turns(int degrees) {
	switch (degrees) {
		case 90: return 1;
		case 180: return 2;
		case 270: return 3;
		default: return 0;
	}
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
	// The receiver turns the picture by what each frame says, so we send the camera as it is.
	RtpExtension cvo;
	cvo.id = kTgcallsVideoRotationExtId;
	cvo.uri = kVideoRotationUri;
	c.rtpExtensions.push_back(cvo);
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
	: _audioQueue(std::make_shared<AudioQueue>()), _videoQueue(std::make_shared<VideoQueue>()), _ctx(ctx),
	  _enc(key256, isOutgoing), _media(ctx, isOutgoing), _isOutgoing(isOutgoing),
	  _videoOn(isVideo), _videoRx(std::make_unique<VideoReceiver>()) {
	_audioQueue->engine = this;
	_videoQueue->engine = this;
	_videoQueue->waitIdr = true; // the peer's decoder starts at an IDR
	_localAudioSsrc = random_ssrc();
	do {
		_localVideoSsrc = random_ssrc();
	} while (_localVideoSsrc == _localAudioSsrc || _localVideoSsrc == 0);
	_videoTimestampBase = g_random_int();

	_negotiator = std::make_unique<ContentNegotiator>(isOutgoing, localContents());

	_media.onGatheringDone = [this]() {
		sendInitialSetupAndCandidates();
		// As in tgcalls, the caller offers first; the callee offers once it has answered.
		if (_isOutgoing) sendOfferIfNeeded();
	};
	_media.onStateChanged = [this](MediaSessionState s) {
		if (s != MediaSessionState::Ready) return;
		_mediaReady = true;
		// tgcalls tells its state when the data channel opens, which is about now.
		sendMediaState();
		if (_rxVideoPt >= 0) requestPeerKeyframe();
		if (onMediaReady) onMediaReady();
	};
	_media.onRtpReceived = [this](const uint8_t *payload, int len) { handleIncomingRtp(payload, len); };
	_media.onRtcpReceived = [this](const uint8_t *payload, int len) { handleIncomingRtcp(payload, len); };

	_audio.onEncodedFrame = [this](const uint8_t *opusPacket, int len) { postEncodedAudio(opusPacket, len); };
}

void CallEngine::postEncodedAudio(const uint8_t *opusPacket, int len) {
	// SRTP, ICE and the negotiated state are only touched on the engine's own thread. Frames go
	// through one FIFO and one drain at a time: GLib does not dispatch separately posted sources
	// of equal priority in posting order, and RTP needs capture order.
	if (!opusPacket || len <= 0) return;
	std::shared_ptr<AudioQueue> queue = _audioQueue;
	{
		std::lock_guard<std::mutex> lock(queue->mx);
		if (!queue->engine) return;
		while (queue->frames.size() >= kMaxQueuedAudio) queue->frames.pop_front();
		queue->frames.emplace_back(opusPacket, opusPacket + len);
		if (queue->drainScheduled) return;
		queue->drainScheduled = true;
	}
	// An attached source, not g_main_context_invoke(): that runs the function right here, on the
	// capture thread, whenever no thread owns the context at this moment.
	auto *ref = new std::shared_ptr<AudioQueue>(std::move(queue));
	GSource *source = g_idle_source_new();
	g_source_set_priority(source, G_PRIORITY_HIGH);
	g_source_set_callback(source,
		[](gpointer data) -> gboolean {
			auto &q = *static_cast<std::shared_ptr<AudioQueue> *>(data);
			CallEngine *engine;
			{
				std::lock_guard<std::mutex> lock(q->mx);
				engine = q->engine;
				if (!engine) q->drainScheduled = false;
			}
			if (engine) engine->drainAudio();
			return G_SOURCE_REMOVE;
		},
		ref, [](gpointer data) { delete static_cast<std::shared_ptr<AudioQueue> *>(data); });
	g_source_attach(source, _ctx);
	g_source_unref(source);
}

void CallEngine::drainAudio() {
	std::deque<std::vector<uint8_t>> frames;
	{
		std::lock_guard<std::mutex> lock(_audioQueue->mx);
		frames.swap(_audioQueue->frames);
		_audioQueue->drainScheduled = false;
	}
	for (const auto &f : frames) sendAudioFrame(f.data(), (int)f.size());
}

void CallEngine::sendAudioFrame(const uint8_t *opusPacket, int len) {
	const int pt = _negotiator->codecs().outgoingAudioPt;
	if (pt < 0 || len <= 0) return; // the peer has not accepted our audio yet
	uint8_t pkt[kRtpHeaderLen + 1500 + kSrtpRoom];
	if ((size_t)len > 1500) return; // implausibly large Opus packet, drop
	write_rtp_header(pkt, (uint8_t)pt, _audioSeq++, _audioTimestamp, _localAudioSsrc, true);
	_audioTimestamp += kOpusTimestampPerFrame;
	memcpy(pkt + kRtpHeaderLen, opusPacket, (size_t)len);
	int totalLen = (int)(kRtpHeaderLen + (size_t)len);
	_media.sendRtp(pkt, &totalLen);
}

CallEngine::~CallEngine() {
	_audio.stop(); // joins the capture thread, the only internal caller of postEncodedAudio()
	logStats();    // the call's final counters
	{
		std::lock_guard<std::mutex> lock(_audioQueue->mx);
		_audioQueue->engine = nullptr; // a drain still queued on the context then does nothing
		_audioQueue->frames.clear();
	}
	std::lock_guard<std::mutex> lock(_videoQueue->mx);
	_videoQueue->engine = nullptr;
	_videoQueue->units.clear();
}

std::vector<MediaContent> CallEngine::localContents() const {
	std::vector<MediaContent> local;
	local.push_back(build_audio_content(_localAudioSsrc));
	if (_videoOn) local.push_back(build_video_content(_localVideoSsrc));
	return local;
}

bool CallEngine::negotiationStarted() const {
	// The caller offers once gathered; the callee only after the caller's offer.
	return _sentInitialSetup && (_isOutgoing || _peerOffered);
}

void CallEngine::setVideoSending(bool on) {
	if (on == _videoOn) return;
	_videoOn = on;
	if (on) {
		// A new stream: an answer about the old one must not enable it.
		const uint32_t old = _localVideoSsrc;
		do {
			_localVideoSsrc = random_ssrc();
		} while (_localVideoSsrc == _localAudioSsrc || _localVideoSsrc == old || _localVideoSsrc == 0);
		_sentVideo = false;
		std::lock_guard<std::mutex> lock(_videoQueue->mx);
		_videoQueue->units.clear();
		_videoQueue->waitIdr = true; // the peer's decoder starts at an IDR
		_videoQueue->keyframeWanted = true;
	}
	g_message("tgcalls-lite: our video %s", on ? "on" : "off");
	_negotiator->setLocalContents(localContents());
	if (!negotiationStarted()) return; // the first offer carries it
	if (_negotiator->offerPending()) {
		if (auto offer = _negotiator->renewOffer(random_exchange_id())) {
			_offerRetries = 0;
			emitOffer(std::move(*offer));
		}
	} else {
		sendOfferIfNeeded();
	}
	sendMediaState();
	if (on && onKeyframeRequested) onKeyframeRequested();
}

void CallEngine::setVideoRotation(int degrees) {
	degrees = rotation_quarter_turns(degrees) * 90;
	if (degrees == _videoRotation) return;
	_videoRotation = degrees;
	if (_videoOn) sendMediaState();
}

void CallEngine::sendMediaState() {
	if (!_mediaReady) return; // sent once media is up
	SignalingMessage msg;
	msg.type = SignalingMessageType::MediaState;
	msg.mediaState.isMuted = false;
	msg.mediaState.videoState =
		_videoOn ? MediaStateMessage::VideoState::Active : MediaStateMessage::VideoState::Inactive;
	static const MediaStateMessage::VideoRotation kRotations[] = {
		MediaStateMessage::VideoRotation::Rotation0, MediaStateMessage::VideoRotation::Rotation90,
		MediaStateMessage::VideoRotation::Rotation180, MediaStateMessage::VideoRotation::Rotation270};
	msg.mediaState.videoRotation = _videoOn ? kRotations[rotation_quarter_turns(_videoRotation)] : kRotations[0];
	emitEncrypted(msg);
}

void CallEngine::postVideoAccessUnit(const uint8_t *accessUnit, size_t len) {
	if (!accessUnit || len == 0) return;
	std::shared_ptr<VideoQueue> queue = _videoQueue;
	{
		std::lock_guard<std::mutex> lock(queue->mx);
		if (!queue->engine) return;
		const bool idr = h264_au_has_idr(accessUnit, len);
		if (queue->units.size() >= kMaxQueuedVideo) {
			// The queued units refer to each other: dropping one breaks the rest, so drop them
			// all and start again at an IDR.
			queue->dropped += queue->units.size();
			queue->units.clear();
			queue->waitIdr = true;
			if (!idr) queue->keyframeWanted = true;
		}
		if (idr) queue->waitIdr = false;
		if (queue->waitIdr) {
			queue->dropped++;
			// Nothing to send; a drain is still needed to pass keyframeWanted on.
			if (!queue->keyframeWanted) return;
		} else {
			queue->units.emplace_back(accessUnit, accessUnit + len);
		}
		if (queue->drainScheduled) return;
		queue->drainScheduled = true;
	}
	auto *ref = new std::shared_ptr<VideoQueue>(std::move(queue));
	GSource *source = g_idle_source_new();
	g_source_set_priority(source, G_PRIORITY_HIGH);
	g_source_set_callback(source,
		[](gpointer data) -> gboolean {
			auto &q = *static_cast<std::shared_ptr<VideoQueue> *>(data);
			CallEngine *engine;
			{
				std::lock_guard<std::mutex> lock(q->mx);
				engine = q->engine;
				if (!engine) q->drainScheduled = false;
			}
			if (engine) engine->drainVideo();
			return G_SOURCE_REMOVE;
		},
		ref, [](gpointer data) { delete static_cast<std::shared_ptr<VideoQueue> *>(data); });
	g_source_attach(source, _ctx);
	g_source_unref(source);
}

void CallEngine::drainVideo() {
	std::deque<std::vector<uint8_t>> units;
	bool keyframe;
	{
		std::lock_guard<std::mutex> lock(_videoQueue->mx);
		units.swap(_videoQueue->units);
		_videoQueue->drainScheduled = false;
		keyframe = _videoQueue->keyframeWanted;
		_videoQueue->keyframeWanted = false;
	}
	if (keyframe && onKeyframeRequested) onKeyframeRequested();
	for (const auto &u : units) sendVideoAccessUnit(u.data(), u.size());
}

size_t CallEngine::setServers(const std::vector<RtcServer> &servers) {
	return _media.setServers(servers);
}

void CallEngine::start() {
	_media.start();
}

bool CallEngine::startAudio(const std::string &sink, const std::string &source) {
	if (!_audio.start(sink, source)) {
		g_warning("tgcalls-lite: call audio could not start, the call has no audio");
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
			g_message("tgcalls-lite: peer InitialSetup, DTLS setup \"%s\"",
			          setup.fingerprints.empty() ? "" : setup.fingerprints[0].setup.c_str());
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
			// Counts only: candidate strings carry the peer's addresses. Telegram reflector
			// candidates ("... typ relay" on a reflector host) cannot be parsed or used here.
			size_t added = 0, skipped = 0;
			for (const auto &c : msg.candidates.iceCandidates) {
				if (_media.addRemoteCandidateSdp(c.sdpString))
					added++;
				else
					skipped++;
			}
			g_message("tgcalls-lite: peer candidates: %zu added, %zu unusable", added, skipped);
			break;
		}
		case SignalingMessageType::NegotiateChannels: {
			if (auto answer = _negotiator->handleRemote(msg.negotiateChannels)) {
				_peerOffered = true;
				SignalingMessage reply;
				reply.type = SignalingMessageType::NegotiateChannels;
				reply.negotiateChannels = std::move(*answer);
				emitEncrypted(reply);
			}
			sendOfferIfNeeded();
			const auto &c = _negotiator->codecs();
			g_message("tgcalls-lite: negotiated audio in=%d out=%d, video in=%d out=%d cvo=%d",
			          c.incomingAudioPt, c.outgoingAudioPt, c.incomingVideoPt, c.outgoingVideoPt,
			          c.outgoingVideoRotationExtId);
			noteIncomingVideo();
			break;
		}
		case SignalingMessageType::MediaState:
			// tgcalls sends these over its data channel only; logged in case one arrives.
			g_message("tgcalls-lite: peer MediaState video=%d", (int)msg.mediaState.videoState);
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
	_offerRetries = 0;
	emitOffer(std::move(*offer));
}

void CallEngine::emitOffer(NegotiateChannelsMessage offer) {
	_offerTick = _ticks;
	SignalingMessage msg;
	msg.type = SignalingMessageType::NegotiateChannels;
	msg.negotiateChannels = std::move(offer);
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

void CallEngine::noteIncomingVideo() {
	const auto &c = _negotiator->codecs();
	if (c.incomingVideoPt == _rxVideoPt && c.incomingVideoSsrc == _rxVideoSsrc) return;
	const bool wasOn = _rxVideoPt >= 0;
	_rxVideoPt = c.incomingVideoPt;
	_rxVideoSsrc = c.incomingVideoSsrc;
	_videoRx->reset();
	const bool on = _rxVideoPt >= 0;
	g_message("tgcalls-lite: peer video %s", on ? "on" : "off");
	if (on) {
		_lastPliUs = 0; // a new stream may ask at once
		requestPeerKeyframe();
	}
	if (on != wasOn && onIncomingVideoChanged) onIncomingVideoChanged(on);
}

void CallEngine::requestPeerKeyframe() {
	if (!_mediaReady || _rxVideoPt < 0) return;
	const gint64 now = g_get_monotonic_time();
	if (_lastPliUs && now - _lastPliUs < kPliMinIntervalUs) return;
	_lastPliUs = now;
	uint8_t pkt[kRtcpPliSize + kSrtpRoom];
	rtcp_build_pli(pkt, _videoOn ? _localVideoSsrc : _localAudioSsrc, _rxVideoSsrc);
	int len = (int)kRtcpPliSize;
	if (_media.sendRtcp(pkt, &len)) _videoStats.plisOut++;
}

void CallEngine::handleIncomingRtcp(const uint8_t *packet, int len) {
	if (!_videoOn || len <= 0) return;
	if (!rtcp_requests_keyframe(packet, (size_t)len, _localVideoSsrc)) return;
	_videoStats.keyframeRequestsIn++;
	if (onKeyframeRequested) onKeyframeRequested();
}

void CallEngine::handleIncomingRtp(const uint8_t *packet, int len) {
	RtpPacketInfo rtp;
	if (len <= 0 || !parse_rtp_header(packet, (size_t)len, rtp)) return;
	const uint8_t *payload = packet + rtp.payloadOffset;
	const auto &codecs = _negotiator->codecs();

	if (rtp.payloadType == codecs.incomingAudioPt) {
		if (rtp.payloadLength > 0) {
			if (onAudioFrame) onAudioFrame(payload, (int)rtp.payloadLength);
			_audio.receiveEncodedFrame(payload, (int)rtp.payloadLength);
		}
	} else if (_rxVideoPt >= 0 && rtp.payloadType == _rxVideoPt && rtp.ssrc == _rxVideoSsrc) {
		const uint8_t *au = nullptr;
		size_t auLen = 0;
		if (_videoRx->feed(rtp.sequence, rtp.timestamp, payload, rtp.payloadLength, rtp.marker, &au, &auLen)) {
			if (onVideoAccessUnit) onVideoAccessUnit(au, (unsigned int)auLen);
		} else if (_videoRx->keyframeNeeded()) {
			requestPeerKeyframe();
		}
	}
	// Anything else (not negotiated, or not yet): drop.
}

void CallEngine::sendVideoAccessUnit(const uint8_t *accessUnit, size_t len) {
	if (!_videoOn || !accessUnit || len == 0) return;
	const auto &codecs = _negotiator->codecs();
	const int pt = codecs.outgoingVideoPt;
	if (pt < 0) return; // the peer has not accepted our video
	struct Ctx { CallEngine *self; uint8_t pt; int cvoId; uint8_t cvo; };
	Ctx ctx{this, (uint8_t)pt, codecs.outgoingVideoRotationExtId, (uint8_t)rotation_quarter_turns(_videoRotation)};
	// 90 kHz from the clock: the encoder's frame rate is not ours to assume.
	uint32_t ts = _videoTimestampBase + (uint32_t)(g_get_monotonic_time() * 9 / 100);
	if (_sentVideo && ts == _videoTimestamp) ts++; // each access unit its own timestamp
	_videoTimestamp = ts;
	_sentVideo = true;
	_videoStats.ausOut++;
	h264_packetize(accessUnit, len, kVideoRtpMtu,
		[](void *vctx, const unsigned char *rtpPayload, size_t payloadLen, int marker) {
			auto *c = static_cast<Ctx *>(vctx);
			CallEngine *self = c->self;
			uint8_t pkt[kRtpHeaderLen + kCvoExtensionLen + kVideoRtpMtu + kSrtpRoom];
			if (payloadLen > kVideoRtpMtu) return; // h264_packetize already respects mtu; defensive only
			// WebRTC reads the orientation from the last packet of a frame.
			const size_t off = write_rtp_header(pkt, c->pt, self->_videoSeq++, self->_videoTimestamp,
			                                    self->_localVideoSsrc, marker != 0, marker ? c->cvoId : 0, c->cvo);
			memcpy(pkt + off, rtpPayload, payloadLen);
			int totalLen = (int)(off + payloadLen);
			self->_media.sendRtp(pkt, &totalLen);
		}, &ctx);
}

void CallEngine::tick() {
	_media.tick();
	// Every 10th tick (5 s at the usual 500 ms) for the first minute, then every 60th.
	_ticks++;
	if (_ticks % (_ticks <= 120 ? 10 : 60) == 0) logStats();

	if (_negotiator->offerPending() && _offerRetries < kMaxOfferRetries &&
	    _ticks - _offerTick >= kOfferRetryTicks) {
		if (auto offer = _negotiator->renewOffer(random_exchange_id())) {
			_offerRetries++;
			g_message("tgcalls-lite: offer unanswered, sending it again (%u)", _offerRetries);
			emitOffer(std::move(*offer));
		}
	}
}

void CallEngine::logStats() const {
	static const char *const kStates[] = {"gathering", "connecting", "ready", "failed"};
	const auto &m = _media.stats();
	const auto a = _audio.stats();
	g_message("tgcalls-lite: stats media=%s dtls-in=%llu rtp-in=%llu rtcp-in=%llu srtp-err=%llu early=%llu "
	          "rtp-out=%llu send-err=%llu | opus enc=%llu dec=%llu dec-err=%llu last-frame=%d samples",
	          kStates[(int)_media.state()], (unsigned long long)m.dtlsIn, (unsigned long long)m.rtpIn,
	          (unsigned long long)m.rtcpIn, (unsigned long long)m.srtpErrors,
	          (unsigned long long)m.beforeSrtp, (unsigned long long)m.rtpOut,
	          (unsigned long long)m.sendErrors, (unsigned long long)a.encoded,
	          (unsigned long long)a.decoded, (unsigned long long)a.decodeErrors, a.lastDecodedSamples);
	if (!_videoOn && _rxVideoPt < 0 && !_videoStats.ausOut && !_videoRx->stats().accessUnits) return;
	const auto &r = _videoRx->stats();
	uint64_t queueDrops;
	{
		std::lock_guard<std::mutex> lock(_videoQueue->mx);
		queueDrops = _videoQueue->dropped;
	}
	g_message("tgcalls-lite: video out=%d aus=%llu queue-drops=%llu pli-in=%llu | in=%d aus=%llu held=%llu "
	          "gaps=%llu late=%llu pli-out=%llu",
	          (int)_videoOn, (unsigned long long)_videoStats.ausOut,
	          (unsigned long long)queueDrops, (unsigned long long)_videoStats.keyframeRequestsIn,
	          (int)(_rxVideoPt >= 0), (unsigned long long)r.accessUnits, (unsigned long long)r.dropped,
	          (unsigned long long)r.gaps, (unsigned long long)r.late, (unsigned long long)_videoStats.plisOut);
}

} // namespace tgcalls_lite
