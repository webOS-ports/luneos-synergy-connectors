// media_session.h — combines ice_session.h + dtls_transport.h + srtp_session.h into one media
// stream: ICE connectivity, then a DTLS-SRTP handshake over the connected ICE component, demuxed
// from real RTP/RTCP by the RFC 5764 first-byte rule (20-63 = DTLS, 128-191 = RTP/RTCP), then
// SRTP-protected media flowing over the same component. One MediaSession per stream (audio or
// video), matching signaling::MediaContent's granularity.
#ifndef TGCALLS_LITE_MEDIA_SESSION_H
#define TGCALLS_LITE_MEDIA_SESSION_H

#include <glib.h>

#include <cstdint>
#include <string>
#include <vector>
#include <memory>
#include <functional>

#include "ice_session.h"

namespace tgcalls_lite {

class DtlsTransport;
class SrtpSession;

enum class MediaSessionState {
	Gathering,
	Connecting,   // ICE connected, DTLS handshake in progress
	Ready,        // DTLS done, fingerprint verified, SRTP sessions live
	Failed,
};

class MediaSession {
public:
	// isOutgoing: true for the call's initiator (caller). As in tgcalls, the caller is ICE
	// controlling and the DTLS client; the callee is ICE controlled and the DTLS server.
	MediaSession(GMainContext *ctx, bool isOutgoing);
	~MediaSession();

	MediaSession(const MediaSession &) = delete;
	MediaSession &operator=(const MediaSession &) = delete;

	// STUN/TURN servers for ICE; call before start(). Returns how many were applied.
	size_t setServers(const std::vector<RtcServer> &servers);

	void start(); // begins ICE candidate gathering

	void getLocalIceCredentials(std::string *ufrag, std::string *pwd) const;
	std::string getLocalDtlsFingerprint() const;
	std::vector<std::string> getLocalCandidateSdpStrings() const;

	void setRemoteIceCredentials(const std::string &ufrag, const std::string &pwd);
	bool addRemoteCandidateSdp(const std::string &sdpString);
	// Must be called before Ready can ever be reached -- gates the DTLS fingerprint check that
	// stands in for real peer identity verification (see DtlsTransport::verifyPeerFingerprint).
	void setRemoteDtlsFingerprint(const std::string &fingerprint);

	// Valid only once state == Ready.
	bool sendRtp(uint8_t *buf, int *len);   // in-place SRTP-protect then ICE-send
	bool sendRtcp(uint8_t *buf, int *len);

	void tick(); // drive DTLS retransmission timers; call periodically (e.g. every 500ms)

	// Packet counters for the call log.
	struct Stats {
		uint64_t dtlsIn = 0;
		uint64_t rtpIn = 0;
		uint64_t rtcpIn = 0;
		uint64_t srtpErrors = 0;   // received RTP/RTCP that failed to unprotect
		uint64_t beforeSrtp = 0;   // media received before SRTP was ready
		uint64_t rtpOut = 0;
		uint64_t sendErrors = 0;   // protect or ICE send failures
	};
	const Stats &stats() const { return _stats; }
	MediaSessionState state() const { return _state; }

	std::function<void()> onGatheringDone;
	std::function<void(MediaSessionState)> onStateChanged;
	std::function<void(const uint8_t *payload, int len)> onRtpReceived;   // already decrypted
	std::function<void(const uint8_t *payload, int len)> onRtcpReceived; // already decrypted

private:
	void handleIceData(const uint8_t *data, size_t len);
	void setState(MediaSessionState s);
	void finishHandshake();

	bool _isOutgoing;
	std::unique_ptr<IceSession> _ice;
	std::unique_ptr<DtlsTransport> _dtls;
	std::unique_ptr<SrtpSession> _srtp;
	std::string _remoteFingerprint;
	bool _iceConnected = false;
	bool _dtlsDone = false;
	MediaSessionState _state = MediaSessionState::Gathering;
	Stats _stats;
};

} // namespace tgcalls_lite

#endif
