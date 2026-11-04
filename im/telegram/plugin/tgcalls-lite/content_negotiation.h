// content_negotiation.h — the NegotiateChannels offer/answer exchange of tgcalls V2, after
// reference/tgcalls/tgcalls/v2/ContentNegotiation.cpp, reduced to what tgcalls-lite can send and
// receive: Opus audio and H.264 (packetization-mode 1) video.
//
// Each side offers only its own outgoing (send-only) contents, under a fresh exchangeId. The peer
// answers with the same exchangeId and, per offered content it accepts, that content's ssrc and the
// payload types it will receive, keeping the offerer's payload type ids. So:
//   - the payload types in our answers are the ones the peer sends us (incoming);
//   - the payload types in the peer's answer to our offer are the ones we send (outgoing).
// If both sides offer at once, the call initiator wins: the callee drops its own offer, answers the
// caller's and offers again afterwards; the caller ignores the callee's offer.
#ifndef TGCALLS_LITE_CONTENT_NEGOTIATION_H
#define TGCALLS_LITE_CONTENT_NEGOTIATION_H

#include <cstdint>
#include <optional>
#include <vector>

#include "signaling_message.h"

namespace tgcalls_lite {

// -1 means "not negotiated".
struct NegotiatedCodecs {
	int incomingAudioPt = -1;
	int incomingVideoPt = -1;
	uint32_t incomingAudioSsrc = 0;
	uint32_t incomingVideoSsrc = 0;
	int outgoingAudioPt = -1;
	int outgoingVideoPt = -1;
};

// The payload type from `offered` we would receive for this content type, or nullopt if there is
// none we can decode: "opus" at 48000 Hz for audio; "H264" for video, preferring
// packetization-mode=1 (the only mode h264_rtp.c depacketizes).
std::optional<PayloadType> choose_payload_type(const MediaContent &offered);

class ContentNegotiator {
public:
	// localContents: our send-only contents, as offered (ssrc and payload types set).
	ContentNegotiator(bool isOutgoing, std::vector<MediaContent> localContents);

	// The offer to send now, or nullopt if no offer is needed or one is still unanswered.
	// exchangeId must be non-zero and should be random.
	std::optional<NegotiateChannelsMessage> takeOffer(uint32_t exchangeId);

	// Handles a NegotiateChannels message from the peer. Returns the answer to send, if any.
	// Call takeOffer() afterwards: a dropped offer is re-sent from there.
	std::optional<NegotiateChannelsMessage> handleRemote(const NegotiateChannelsMessage &msg);

	const NegotiatedCodecs &codecs() const { return _codecs; }
	bool offerPending() const { return _pendingExchangeId.has_value(); }

private:
	NegotiateChannelsMessage answer(const NegotiateChannelsMessage &offer);
	void applyAnswer(const NegotiateChannelsMessage &answer);

	bool _isOutgoing;
	std::vector<MediaContent> _localContents;
	bool _needOffer = true;
	std::optional<uint32_t> _pendingExchangeId;
	NegotiatedCodecs _codecs;
};

} // namespace tgcalls_lite

#endif
