#include "content_negotiation.h"

#include <strings.h>

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
	if (!_needOffer || _pendingExchangeId || exchangeId == 0) return std::nullopt;
	_needOffer = false;
	_pendingExchangeId = exchangeId;
	NegotiateChannelsMessage offer;
	offer.exchangeId = exchangeId;
	offer.contents = _localContents;
	return offer;
}

std::optional<NegotiateChannelsMessage> ContentNegotiator::handleRemote(const NegotiateChannelsMessage &msg) {
	if (_pendingExchangeId) {
		if (msg.exchangeId == *_pendingExchangeId) {
			applyAnswer(msg);
			return std::nullopt;
		}
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
	_pendingExchangeId.reset();
	_codecs.outgoingAudioPt = -1;
	_codecs.outgoingVideoPt = -1;
	for (const auto &content : answer.contents) {
		for (const auto &local : _localContents) {
			if (local.ssrc == 0 || local.ssrc != content.ssrc || local.type != content.type) continue;
			if (local.type == MediaContent::Type::Audio)
				_codecs.outgoingAudioPt = pt_for_type(content, MediaContent::Type::Audio);
			else
				_codecs.outgoingVideoPt = pt_for_type(content, MediaContent::Type::Video);
		}
	}
}

} // namespace tgcalls_lite
