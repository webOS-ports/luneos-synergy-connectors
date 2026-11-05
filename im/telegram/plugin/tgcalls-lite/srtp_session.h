// srtp_session.h — SRTP protect/unprotect using the keying material DtlsTransport::exportSrtpKeys()
// produces. One SrtpSession per media stream (audio or video), covering both RTP and RTCP (muxed
// on the same ICE component, matching tgcalls' own rtcp_mux -- see signaling_message.h's comment
// on MediaContent).
#ifndef TGCALLS_LITE_SRTP_SESSION_H
#define TGCALLS_LITE_SRTP_SESSION_H

#include <cstdint>
#include <cstddef>

namespace tgcalls_lite {

class SrtpSession {
public:
	// sendKey/recvKey: 16-byte AES key followed by 14-byte salt (30 bytes total each) --
	// concatenate DtlsTransport::SrtpKeyingMaterial's clientKey+clientSalt (if we're the DTLS
	// client, that's our SEND key and the server fields are our RECV key; swapped if we're the
	// DTLS server) before calling this constructor. AES-128-CM / HMAC-SHA1-80 only for now,
	// matching the single profile DtlsTransport currently offers.
	SrtpSession(const uint8_t *sendKeyAndSalt, const uint8_t *recvKeyAndSalt);
	~SrtpSession();

	SrtpSession(const SrtpSession &) = delete;
	SrtpSession &operator=(const SrtpSession &) = delete;

	// In-place encrypt. `buf` must have at least SRTP_MAX_TRAILER_LEN (see srtp_session.cpp) bytes
	// of headroom past *len; *len is updated to the new (larger) length on success.
	bool protectRtp(uint8_t *buf, int *len);
	bool unprotectRtp(uint8_t *buf, int *len);
	bool protectRtcp(uint8_t *buf, int *len);
	bool unprotectRtcp(uint8_t *buf, int *len);

	bool ok() const { return _sendSession != nullptr && _recvSession != nullptr; }

private:
	void *_sendSession = nullptr; // srtp_t
	void *_recvSession = nullptr; // srtp_t
};

} // namespace tgcalls_lite

#endif
