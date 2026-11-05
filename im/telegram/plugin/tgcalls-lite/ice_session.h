// ice_session.h — thin wrapper around libnice's NiceAgent, shaped to match what
// reference/tgcalls/tgcalls/v2/NativeNetworkingImpl.h exposes (getLocalIceParameters/
// getLocalFingerprint/setRemoteParams/addCandidates) -- NativeNetworkingImpl's own
// implementation is bound entirely to WebRTC's own internal C++ classes
// (cricket::P2PTransportChannel, cricket::DtlsTransport, ...) and isn't portable as source
// (confirmed by reading its header), so this is a from-scratch reimplementation against
// libnice's own API, driven by the same signaling::InitialSetupMessage/CandidatesMessage shapes
// (see signaling_message.h) tgcalls exchanges over the encrypted signaling channel.
//
// One IceSession = one media stream (audio or video), single component (RTP+RTCP muxed, matching
// tgcalls' own contentDescription->set_rtcp_mux(true) -- confirmed in Signaling.cpp).
#ifndef TGCALLS_LITE_ICE_SESSION_H
#define TGCALLS_LITE_ICE_SESSION_H

#include <glib.h>
#include <nice/agent.h>

#include <string>
#include <vector>
#include <functional>

namespace tgcalls_lite {

// One STUN or TURN server from TDLib's callStateReady.servers (callServerTypeWebrtc). Telegram's
// own UDP reflectors (callServerTypeTelegramReflector) speak tgcalls' ReflectorPort protocol, not
// TURN, so they cannot be used here. host must be a literal IPv4/IPv6 address: libnice does not
// resolve names.
struct RtcServer {
	std::string host;
	uint16_t port = 0;
	std::string login;
	std::string password;
	bool isTurn = false;
	bool isTcp = false;
};

enum class IceConnectionState {
	Gathering,
	Checking,
	Connected,
	Failed,
	Disconnected,
};

// "host", "srflx", "prflx" or "relay" for a NiceCandidateType, for logs.
const char *candidate_type_name(int type);

class IceSession {
public:
	// ctx: the GMainContext whose loop the caller is iterating/running -- libnice's timers only
	// fire while that context is being iterated (see nice/agent.h's own top-of-file docs).
	// controlling: ICE controlling role (true for the call's initiator, matching tgcalls' own
	// caller/callee split -- see call.cpp's is_outgoing_).
	IceSession(GMainContext *ctx, bool controlling);
	~IceSession();

	IceSession(const IceSession &) = delete;
	IceSession &operator=(const IceSession &) = delete;

	// Configures STUN/TURN; call before gatherCandidates(). libnice takes one STUN server, so the
	// first usable one wins; every usable TURN server is added. Returns how many were applied.
	size_t setServers(const std::vector<RtcServer> &servers);

	// Starts local candidate gathering. onGatheringDone fires (once) when
	// getLocalCandidateSdpStrings() will return the complete set.
	void gatherCandidates();

	void getLocalCredentials(std::string *ufrag, std::string *pwd) const;

	// One SDP "candidate:..." a-line-body string per local candidate (no "a=" prefix, matching
	// signaling::IceCandidate::sdpString's own convention -- see Signaling.cpp's CandidatesMessage
	// serialization, which just wraps this string verbatim, no other transformation).
	std::vector<std::string> getLocalCandidateSdpStrings() const;

	void setRemoteCredentials(const std::string &ufrag, const std::string &pwd);
	// Returns false if the candidate string couldn't be parsed (malformed peer data -- log and
	// skip that one candidate, don't fail the whole exchange).
	bool addRemoteCandidateSdp(const std::string &sdpString);

	// Sends raw bytes over the connected component (only valid once state == Connected). Used for
	// both DTLS records and SRTP/SRTCP packets once the DTLS-SRTP layer is built on top of this --
	// ICE itself doesn't care which is which, per RFC 5764's multiplexing (demux is the caller's
	// job, by inspecting the first byte of each received packet).
	int send(const uint8_t *data, size_t len);

	std::function<void()> onGatheringDone;
	std::function<void(IceConnectionState)> onStateChanged;
	std::function<void(const uint8_t *data, size_t len)> onDataReceived;

private:
	static void gatheringDoneCb(NiceAgent *agent, guint stream_id, gpointer user_data);
	static void stateChangedCb(NiceAgent *agent, guint stream_id, guint component_id,
	                            guint state, gpointer user_data);
	static void recvCb(NiceAgent *agent, guint stream_id, guint component_id, guint len,
	                    gchar *buf, gpointer user_data);
	static void selectedPairCb(NiceAgent *agent, guint stream_id, guint component_id,
	                           NiceCandidate *local, NiceCandidate *remote, gpointer user_data);

	NiceAgent *_agent = nullptr;
	guint _streamId = 0;
	static constexpr guint kComponentId = 1; // NICE_COMPONENT_TYPE_RTP, muxed with RTCP
};

} // namespace tgcalls_lite

#endif
