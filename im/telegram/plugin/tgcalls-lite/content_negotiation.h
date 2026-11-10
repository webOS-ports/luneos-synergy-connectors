// Parts of this file are derived from TelegramMessenger/tgcalls (LGPL-3.0); see NOTICE.
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
#include <utility>
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
	// The id of the video orientation (CVO) header extension the peer's answer accepted for our
	// video, or -1: then the peer expects upright frames.
	int outgoingVideoRotationExtId = -1;
};

// RFC 7742 / 3GPP TS 26.114 coordination of video orientation, as WebRTC's kVideoRotationUri.
constexpr const char *kVideoRotationUri = "urn:3gpp:video-orientation";

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

	// The unanswered offer again, under a new exchangeId, or nullopt if none is pending. tgcalls
	// sends each offer once, and a caller with an offer of its own outstanding drops the callee's:
	// the callee answers and offers in one go, and the two signalling messages can reach the caller
	// in either order. Without a new offer the callee then sends nothing for the whole call. An answer
	// to any offer of the current contents, however late, settles it. Also used to replace an
	// offer whose contents setLocalContents() changed.
	std::optional<NegotiateChannelsMessage> renewOffer(uint32_t exchangeId);

	// Handles a NegotiateChannels message from the peer. Returns the answer to send, if any.
	// Call takeOffer() afterwards: a dropped offer is re-sent from there.
	std::optional<NegotiateChannelsMessage> handleRemote(const NegotiateChannelsMessage &msg);

	// The caller's first offer: held back until the callee's first offer has been answered, or
	// until releaseFirstOffer(). A callee that offers at once (as current Telegram apps do) and
	// meets the caller's offer on the way drops its own offer and never sends it again, so the
	// caller would get the callee's media described never. Holding the caller's offer means the
	// callee's offer is answered first and both directions are negotiated. takeOffer() returns
	// nothing while the offer is held.
	void holdFirstOffer() { _firstOfferHeld = true; }
	void releaseFirstOffer() { _firstOfferHeld = false; }
	bool firstOfferHeld() const { return _firstOfferHeld; }

	// Our send-only contents changed (video on or off): offers from now on carry these, and an
	// offer is due. An offer still unanswered is renewed with them (see renewOffer()).
	void setLocalContents(std::vector<MediaContent> localContents);

	const NegotiatedCodecs &codecs() const { return _codecs; }
	bool offerPending() const { return _pendingExchangeId.has_value(); }
	// False while the offer out describes contents setLocalContents() has since replaced.
	bool offerIsCurrent() const;

private:
	NegotiateChannelsMessage makeOffer(uint32_t exchangeId);
	NegotiateChannelsMessage answer(const NegotiateChannelsMessage &offer);
	void applyAnswer(const NegotiateChannelsMessage &answer);

	bool _isOutgoing;
	std::vector<MediaContent> _localContents;
	bool _needOffer = true;
	bool _firstOfferHeld = false;
	std::optional<uint32_t> _pendingExchangeId;
	unsigned _generation = 0; // bumped by setLocalContents()
	// Every exchangeId we offered under, with the generation of the contents it carried.
	std::vector<std::pair<uint32_t, unsigned>> _ownExchangeIds;
	NegotiatedCodecs _codecs;
};

} // namespace tgcalls_lite

#endif
