// dtls_transport.h — DTLS-SRTP handshake over an already-ICE-connected transport, driven by the
// caller feeding in raw bytes received via IceSession::onDataReceived (this class only handles
// the subset of those bytes that look like DTLS records -- first byte 20-63 per RFC 5764's
// demux rule; RTP/RTCP, first byte 128-191, goes straight to the SRTP layer instead, never here).
//
// Unlike ice_session.h (a from-scratch reimplementation of NativeNetworkingImpl's ICE piece using
// libnice), this class leans entirely on OpenSSL's own DTLS + use_srtp extension support
// (confirmed present: openssl/srtp.h's SSL_CTX_set_tlsext_use_srtp/SSL_get_selected_srtp_profile,
// openssl/tls1.h's SSL_export_keying_material) -- no custom crypto here, just BIO plumbing to
// drive OpenSSL's DTLS state machine over a transport it doesn't control directly (we have no
// real UDP socket to hand it; ICE owns that), plus timer-driven retransmission
// (DTLSv1_get_timeout/DTLSv1_handle_timeout).
#ifndef TGCALLS_LITE_DTLS_TRANSPORT_H
#define TGCALLS_LITE_DTLS_TRANSPORT_H

#include <openssl/ssl.h>

#include <cstdint>
#include <string>
#include <vector>
#include <array>
#include <functional>

namespace tgcalls_lite {

// Exported per RFC 5764: 16-byte AES-128 keys + 14-byte salts for each direction.
struct SrtpKeyingMaterial {
	std::array<uint8_t, 16> clientKey;
	std::array<uint8_t, 14> clientSalt;
	std::array<uint8_t, 16> serverKey;
	std::array<uint8_t, 14> serverSalt;
	std::string profileName; // e.g. "SRTP_AES128_CM_SHA1_80", from SSL_get_selected_srtp_profile
};

class DtlsTransport {
public:
	// isClient: DTLS role (who sends ClientHello first). Matches the "setup" attribute in the
	// signaled DtlsFingerprint: "active" = DTLS client, "passive" = DTLS server. "actpass" (what
	// we always advertise, matching tgcalls' own InitialSetupMessage) lets the peer choose; by
	// convention the ICE-controlled side (callee, non-initiator) decides and is typically the
	// DTLS server ("passive") -- see start_engine.cpp's role assignment once that's wired up.
	explicit DtlsTransport(bool isClient);
	~DtlsTransport();

	DtlsTransport(const DtlsTransport &) = delete;
	DtlsTransport &operator=(const DtlsTransport &) = delete;

	// Colon-separated uppercase hex SHA-256 of our own certificate, matching
	// signaling::DtlsFingerprint.fingerprint's format (hash field is always "sha-256").
	std::string getLocalFingerprint() const;

	// Begins (or, for the server, prepares to accept) the handshake. Call once both ICE is
	// connected AND the peer's InitialSetupMessage has arrived (we need their fingerprint to
	// verify against, even though the DTLS handshake itself can start before that -- verification
	// just gates onHandshakeComplete from firing).
	void start();

	// Feed a received byte range that looks like a DTLS record (first byte 20-63) here.
	void feedIncomingData(const uint8_t *data, size_t len);

	// Must be called periodically (e.g. every 500ms via g_timeout_add) to drive DTLS
	// retransmission timers -- DTLS has no reliable transport of its own to lean on.
	void tick();

	// Verifies the now-connected peer's actual certificate fingerprint against what they declared
	// over the (separately encrypted) signaling channel. This is the real security binding DTLS-
	// SRTP relies on for WebRTC-style calls (self-signed certs otherwise prove nothing) -- call
	// this once both the handshake has completed AND the peer's signaled fingerprint is known.
	bool verifyPeerFingerprint(const std::string &expectedFingerprint) const;

	// Valid only after a successful handshake (see onHandshakeComplete).
	SrtpKeyingMaterial exportSrtpKeys() const;

	// Bytes that must be sent over ICE (via IceSession::send) -- DTLS records, demuxed by the
	// first-byte rule at the OTHER end.
	std::function<void(const uint8_t *data, size_t len)> onOutgoingData;
	std::function<void()> onHandshakeComplete;
	// NOTE: can fire spuriously (empty OpenSSL error queue) if this object is driven by a fully
	// synchronous/re-entrant send<->feedIncomingData wiring where trailing final-flight bytes
	// loop back after the handshake has already completed (observed in spike/
	// dtls_loopback_smoke.cpp's direct in-process wiring; doesn't affect onHandshakeComplete's own
	// correctness there -- ALL exported keys/fingerprints still matched). A real caller driven by
	// IceSession's async GLib-main-loop dispatch won't hit this, since data never arrives
	// synchronously nested inside a send() call the way this test's wiring forces it to.
	std::function<void(const std::string &error)> onHandshakeFailed;

private:
	void pumpOutgoing();
	void driveHandshake();

	bool _isClient;
	SSL_CTX *_ctx = nullptr;
	SSL *_ssl = nullptr;
	BIO *_rbio = nullptr; // we write incoming DTLS bytes here
	BIO *_wbio = nullptr; // we read outgoing DTLS bytes from here
	X509 *_cert = nullptr;
	EVP_PKEY *_pkey = nullptr;
	bool _handshakeDone = false;
};

} // namespace tgcalls_lite

#endif
