// media_session.h — combines ice_session.h + dtls_transport.h + srtp_session.h into one media
// stream: ICE connectivity, then a DTLS-SRTP handshake over the connected ICE component, demuxed
// from real RTP/RTCP by the RFC 5764 first-byte rule (20-63 = DTLS, 128-191 = RTP/RTCP), then
// SRTP-protected media flowing over the same component. One MediaSession per stream (audio or
// video), matching signaling::MediaContent's granularity.
#ifndef TGCALLS_LITE_MEDIA_SESSION_H
#define TGCALLS_LITE_MEDIA_SESSION_H

#include <glib.h>

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
	// isOutgoing: true for the call's initiator (caller). Controls both the ICE controlling role
	// (caller = controlling, matching ICE's usual offerer convention) and the DTLS role: by
	// convention here the caller is the DTLS server ("passive") and the callee is the DTLS client
	// ("active") -- the common WebRTC/JSEP default when the offerer advertises "actpass" (which is
	// all tgcalls' own InitialSetupMessage ever does -- see its own `setup` field, always
	// "actpass" today; a real peer conventionally responds "active"). If a real peer's fingerprint
	// message ever specifies a concrete "active"/"passive" setup instead, this fixed convention
	// will need to respect that instead -- not yet handled, tracked as a Phase 4 interop detail.
	MediaSession(GMainContext *ctx, bool isOutgoing);
	~MediaSession();

	MediaSession(const MediaSession &) = delete;
	MediaSession &operator=(const MediaSession &) = delete;

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

	std::function<void()> onGatheringDone;
	std::function<void(MediaSessionState)> onStateChanged;
	std::function<void(const uint8_t *payload, int len)> onRtpReceived;   // already decrypted
	std::function<void(const uint8_t *payload, int len)> onRtcpReceived; // already decrypted

private:
	void handleIceData(const uint8_t *data, size_t len);
	void setState(MediaSessionState s);

	bool _isOutgoing;
	std::unique_ptr<IceSession> _ice;
	std::unique_ptr<DtlsTransport> _dtls;
	std::unique_ptr<SrtpSession> _srtp;
	std::string _remoteFingerprint;
	bool _iceConnected = false;
	MediaSessionState _state = MediaSessionState::Gathering;
};

} // namespace tgcalls_lite

#endif
