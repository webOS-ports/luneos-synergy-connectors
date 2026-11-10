// Parts of this file are derived from TelegramMessenger/tgcalls (LGPL-3.0); see NOTICE.
#include "content_negotiation.h"

#include <strings.h>

#include <string>
#include <utility>

namespace tgcalls_lite {

namespace {

bool name_is(const PayloadType &pt, const char *name) {
	return strcasecmp(pt.name.c_str(), name) == 0;
}

const std::string *param(const PayloadType &pt, const char *key) {
	for (const auto &p : pt.parameters)
		if (p.first == key) return &p.second;
	return nullptr;
}

// Feedback we can live with the peer expecting. transport-cc and goog-remb would leave the peer's
// bandwidth estimator waiting for reports tgcalls-lite never sends.
bool feedback_supported(const FeedbackType &fb) {
	return fb.type == "nack" || fb.type == "ccm";
}

PayloadType answer_payload_type(const PayloadType &offered) {
	PayloadType pt = offered;
	pt.feedbackTypes.clear();
	for (const auto &fb : offered.feedbackTypes)
		if (feedback_supported(fb)) pt.feedbackTypes.push_back(fb);
	return pt;
}

int pt_for_type(const MediaContent &content, MediaContent::Type type) {
	if (content.type != type || content.payloadTypes.empty()) return -1;
	if (auto chosen = choose_payload_type(content)) return (int)chosen->id;
	return -1;
}

} // namespace

std::optional<PayloadType> choose_payload_type(const MediaContent &offered) {
	const PayloadType *fallback = nullptr;
	for (const auto &pt : offered.payloadTypes) {
		if (pt.id > 127) continue;
		if (offered.type == MediaContent::Type::Audio) {
			if (name_is(pt, "opus") && pt.clockrate == 48000) return pt;
		} else if (name_is(pt, "H264")) {
			const std::string *mode = param(pt, "packetization-mode");
			if (mode && *mode == "1") return pt;
			if (!fallback) fallback = &pt;
		}
	}
	// H.264 without packetization-mode=1 is mode 0 (single NAL unit), which h264_rtp.c also
	// receives: every packet is one whole NAL.
	if (fallback) return *fallback;
	return std::nullopt;
}

ContentNegotiator::ContentNegotiator(bool isOutgoing, std::vector<MediaContent> localContents)
	: _isOutgoing(isOutgoing), _localContents(std::move(localContents)) {}

std::optional<NegotiateChannelsMessage> ContentNegotiator::takeOffer(uint32_t exchangeId) {
	if (_firstOfferHeld || !_needOffer || _pendingExchangeId || exchangeId == 0) return std::nullopt;
	_needOffer = false;
	return makeOffer(exchangeId);
}

void ContentNegotiator::setLocalContents(std::vector<MediaContent> localContents) {
	_localContents = std::move(localContents);
	_generation++;
	// An offer still out describes the old contents; renewOffer() replaces it.
	if (!_pendingExchangeId) _needOffer = true;
}

std::optional<NegotiateChannelsMessage> ContentNegotiator::renewOffer(uint32_t exchangeId) {
	if (!_pendingExchangeId || exchangeId == 0) return std::nullopt;
	for (const auto &own : _ownExchangeIds)
		if (own.first == exchangeId) return std::nullopt;
	return makeOffer(exchangeId);
}

NegotiateChannelsMessage ContentNegotiator::makeOffer(uint32_t exchangeId) {
	_pendingExchangeId = exchangeId;
	_ownExchangeIds.emplace_back(exchangeId, _generation);
	NegotiateChannelsMessage offer;
	offer.exchangeId = exchangeId;
	offer.contents = _localContents;
	return offer;
}

bool ContentNegotiator::offerIsCurrent() const {
	if (!_pendingExchangeId) return true;
	for (const auto &own : _ownExchangeIds)
		if (own.first == *_pendingExchangeId) return own.second == _generation;
	return false;
}

std::optional<NegotiateChannelsMessage> ContentNegotiator::handleRemote(const NegotiateChannelsMessage &msg) {
	for (const auto &own : _ownExchangeIds) {
		if (msg.exchangeId != own.first) continue;
		// An answer to one of our offers. Offers of the same contents are interchangeable, so even
		// a late answer to an offer renewOffer() has since replaced settles the current one. An
		// answer to older contents is applied (it still describes what the peer receives) but
		// leaves the offer of the current contents outstanding.
		applyAnswer(msg);
		if (own.second == _generation) _pendingExchangeId.reset();
		return std::nullopt;
	}
	// The callee's offer, answered: the caller's own offer may go now (see holdFirstOffer()).
	_firstOfferHeld = false;
	if (_pendingExchangeId) {
		// Both offered at once: the initiator wins.
		if (_isOutgoing) return std::nullopt;
		_pendingExchangeId.reset();
		_needOffer = true;
	}
	return answer(msg);
}

NegotiateChannelsMessage ContentNegotiator::answer(const NegotiateChannelsMessage &offer) {
	NegotiateChannelsMessage result;
	result.exchangeId = offer.exchangeId;
	// Like tgcalls, each answer describes the complete set of incoming channels.
	NegotiatedCodecs incoming;
	for (const auto &content : offer.contents) {
		auto chosen = choose_payload_type(content);
		if (!chosen) continue;
		MediaContent accepted;
		accepted.type = content.type;
		accepted.ssrc = content.ssrc;
		accepted.ssrcGroups = content.ssrcGroups;
		accepted.payloadTypes.push_back(answer_payload_type(*chosen));
		// No RTP header extensions: the peer then sends none.
		if (content.type == MediaContent::Type::Audio && incoming.incomingAudioPt < 0) {
			incoming.incomingAudioPt = (int)chosen->id;
			incoming.incomingAudioSsrc = content.ssrc;
		} else if (content.type == MediaContent::Type::Video && incoming.incomingVideoPt < 0) {
			incoming.incomingVideoPt = (int)chosen->id;
			incoming.incomingVideoSsrc = content.ssrc;
		} else {
			continue; // one channel per media type
		}
		result.contents.push_back(std::move(accepted));
	}
	_codecs.incomingAudioPt = incoming.incomingAudioPt;
	_codecs.incomingAudioSsrc = incoming.incomingAudioSsrc;
	_codecs.incomingVideoPt = incoming.incomingVideoPt;
	_codecs.incomingVideoSsrc = incoming.incomingVideoSsrc;
	return result;
}

void ContentNegotiator::applyAnswer(const NegotiateChannelsMessage &answer) {
	_codecs.outgoingAudioPt = -1;
	_codecs.outgoingVideoPt = -1;
	_codecs.outgoingVideoRotationExtId = -1;
	for (const auto &content : answer.contents) {
		for (const auto &local : _localContents) {
			if (local.ssrc == 0 || local.ssrc != content.ssrc || local.type != content.type) continue;
			if (local.type == MediaContent::Type::Audio)
				_codecs.outgoingAudioPt = pt_for_type(content, MediaContent::Type::Audio);
			else {
				_codecs.outgoingVideoPt = pt_for_type(content, MediaContent::Type::Video);
				for (const auto &ext : content.rtpExtensions)
					if (ext.uri == kVideoRotationUri && ext.id >= 1 && ext.id <= 14)
						_codecs.outgoingVideoRotationExtId = ext.id;
			}
		}
	}
}

namespace {
constexpr uint8_t kH264PayloadType = 100;  // matches voipkit.cpp's kRtpPayloadType convention
constexpr uint32_t kH264ClockRate = 90000;
// RTX (RFC 4588) for the H.264 stream. We never retransmit, but tgcalls' receiver learns our video
// SSRC only from the content's ssrcGroups (IncomingV2VideoChannel builds its stream's SSRC list
// from them alone), and the FID group WebRTC offers names an RTX stream, so we offer one too.
constexpr uint8_t kRtxPayloadType = 101;
constexpr int kTgcallsVideoRotationExtId = 13; // the id tgcalls offers it under
} // namespace

MediaContent make_video_content(uint32_t ssrc, uint32_t rtxSsrc) {
	MediaContent c;
	c.type = MediaContent::Type::Video;
	c.ssrc = ssrc;
	// What WebRTC's AddVideoSender gives tgcalls' own offers: the main SSRC and its RTX SSRC in a
	// FID group. Without a group a tgcalls receiver has no SSRC for the stream and drops our video.
	SsrcGroup fid;
	fid.semantics = "FID";
	fid.ssrcs = {ssrc, rtxSsrc};
	c.ssrcGroups.push_back(std::move(fid));
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
	PayloadType rtx;
	rtx.id = kRtxPayloadType;
	rtx.name = "rtx";
	rtx.clockrate = kH264ClockRate;
	rtx.parameters.push_back({"apt", std::to_string(kH264PayloadType)});
	c.payloadTypes.push_back(rtx);
	// The receiver turns the picture by what each frame says, so we send the camera as it is.
	RtpExtension cvo;
	cvo.id = kTgcallsVideoRotationExtId;
	cvo.uri = kVideoRotationUri;
	c.rtpExtensions.push_back(cvo);
	return c;
}

} // namespace tgcalls_lite
