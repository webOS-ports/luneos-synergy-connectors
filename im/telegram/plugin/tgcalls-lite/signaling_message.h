// signaling_message.h — the 4 signaling message shapes tgcalls v2 exchanges over its encrypted
// out-of-band channel (see reference/tgcalls/tgcalls/v2/Signaling.h/.cpp, cloned from
// TelegramMessenger/tgcalls as a read-only spec reference -- NOT built). Wire format is plain
// JSON with an "@type" discriminator, not protobuf -- confirmed by reading the real
// Message::serialize()/parse(). Field names/shapes here are copied verbatim from that source so
// a real peer's tgcalls (V2) can parse what we send and vice versa.
#ifndef TGCALLS_LITE_SIGNALING_MESSAGE_H
#define TGCALLS_LITE_SIGNALING_MESSAGE_H

#include <cstdint>
#include <string>
#include <vector>
#include <utility>

namespace tgcalls_lite {

struct DtlsFingerprint {
	std::string hash;        // e.g. "sha-256"
	std::string setup;       // "actpass" / "active" / "passive"
	std::string fingerprint; // colon-separated hex, matches rtc::SSLFingerprint::GetRfc4572Fingerprint()
};

struct InitialSetupMessage {
	std::string ufrag;
	std::string pwd;
	bool supportsRenomination = false;
	std::vector<DtlsFingerprint> fingerprints;
};

struct IceCandidate {
	std::string sdpString; // one ICE candidate a-line, e.g. "candidate:... typ host ..."
};

struct CandidatesMessage {
	std::vector<IceCandidate> iceCandidates;
};

struct FeedbackType {
	std::string type;
	std::string subtype;
};

struct PayloadType {
	uint32_t id = 0;
	std::string name;
	uint32_t clockrate = 0;
	uint32_t channels = 0;
	std::vector<FeedbackType> feedbackTypes;
	std::vector<std::pair<std::string, std::string>> parameters;
};

struct RtpExtension {
	int id = 0;
	std::string uri;
};

struct SsrcGroup {
	std::vector<uint32_t> ssrcs;
	std::string semantics;
};

struct MediaContent {
	enum class Type { Audio, Video };
	Type type = Type::Audio;
	uint32_t ssrc = 0;
	std::vector<SsrcGroup> ssrcGroups;
	std::vector<PayloadType> payloadTypes;
	std::vector<RtpExtension> rtpExtensions;
};

struct NegotiateChannelsMessage {
	uint32_t exchangeId = 0;
	std::vector<MediaContent> contents;
};

struct MediaStateMessage {
	enum class VideoState { Inactive, Suspended, Active };
	enum class VideoRotation { Rotation0, Rotation90, Rotation180, Rotation270 };

	bool isMuted = false;
	VideoState videoState = VideoState::Inactive;
	VideoRotation videoRotation = VideoRotation::Rotation0;
	VideoState screencastState = VideoState::Inactive;
	bool isBatteryLow = false;
};

enum class SignalingMessageType {
	Unknown,
	InitialSetup,
	NegotiateChannels,
	Candidates,
	MediaState,
};

struct SignalingMessage {
	SignalingMessageType type = SignalingMessageType::Unknown;
	InitialSetupMessage initialSetup;
	NegotiateChannelsMessage negotiateChannels;
	CandidatesMessage candidates;
	MediaStateMessage mediaState;
};

// Serializes to the exact JSON shape tgcalls' Message::serialize() produces for the message's
// own type (only the relevant one of the 4 structs above is read, matching msg.type).
std::vector<uint8_t> signaling_message_serialize(const SignalingMessage &msg);

// Parses a JSON blob produced by (or expected to be interoperable with) tgcalls' own
// Message::serialize(). Returns false on any malformed/unrecognized input.
bool signaling_message_parse(const uint8_t *data, size_t len, SignalingMessage *out);

} // namespace tgcalls_lite

#endif
