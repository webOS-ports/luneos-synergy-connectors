#include "dtls_transport.h"

#include <openssl/err.h>
#include <openssl/srtp.h>
#include <openssl/tls1.h>
#include <openssl/x509.h>
#include <openssl/pem.h>
#include <openssl/rand.h>

#include <cstdio>
#include <cstring>

namespace tgcalls_lite {

namespace {

// One ephemeral EC keypair + self-signed cert per DtlsTransport, matching WebRTC's own model
// (identity is proven by the fingerprint exchanged over the signaling channel, not by a CA chain
// -- a fresh cert every call is fine, arguably better for privacy).
bool generate_self_signed_cert(X509 **outCert, EVP_PKEY **outKey) {
	EVP_PKEY *pkey = EVP_PKEY_Q_keygen(nullptr, nullptr, "EC", "prime256v1");
	if (!pkey) return false;

	X509 *cert = X509_new();
	if (!cert) { EVP_PKEY_free(pkey); return false; }

	X509_set_version(cert, 2); // X509v3
	ASN1_INTEGER_set(X509_get_serialNumber(cert), 1);
	X509_gmtime_adj(X509_getm_notBefore(cert), 0);
	X509_gmtime_adj(X509_getm_notAfter(cert), 60L * 60L * 24L * 30L); // 30 days, plenty for one call

	X509_NAME *name = X509_get_subject_name(cert);
	X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, (const unsigned char *)"tgcalls-lite", -1, -1, 0);
	X509_set_issuer_name(cert, name);

	X509_set_pubkey(cert, pkey);
	if (!X509_sign(cert, pkey, EVP_sha256())) {
		X509_free(cert);
		EVP_PKEY_free(pkey);
		return false;
	}

	*outCert = cert;
	*outKey = pkey;
	return true;
}

std::string fingerprint_hex(X509 *cert) {
	unsigned char digest[EVP_MAX_MD_SIZE];
	unsigned int len = 0;
	if (!X509_digest(cert, EVP_sha256(), digest, &len)) return "";

	std::string result;
	char buf[4];
	for (unsigned int i = 0; i < len; i++) {
		if (i) result += ':';
		snprintf(buf, sizeof(buf), "%02X", digest[i]);
		result += buf;
	}
	return result;
}

// tgcalls' own fingerprint strings are colon-separated uppercase hex (matching
// rtc::SSLFingerprint::GetRfc4572Fingerprint()'s format) -- compare case-insensitively just in
// case a real peer's client emits lowercase (some do).
bool fingerprints_equal(const std::string &a, const std::string &b) {
	if (a.size() != b.size()) return false;
	for (size_t i = 0; i < a.size(); i++) {
		if (toupper((unsigned char)a[i]) != toupper((unsigned char)b[i])) return false;
	}
	return true;
}

} // namespace

DtlsTransport::DtlsTransport(bool isClient) : _isClient(isClient) {
	generate_self_signed_cert(&_cert, &_pkey);

	_ctx = SSL_CTX_new(_isClient ? DTLS_client_method() : DTLS_server_method());
	SSL_CTX_use_certificate(_ctx, _cert);
	SSL_CTX_use_PrivateKey(_ctx, _pkey);
	// Self-signed, verified out-of-band via the signaled fingerprint (verifyPeerFingerprint) --
	// same trust model as WebRTC's own DTLS-SRTP identity binding. Accept any peer cert here;
	// the real check happens after the handshake completes.
	SSL_CTX_set_verify(_ctx, SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
	                    [](int, X509_STORE_CTX *) -> int { return 1; });
	SSL_CTX_set_tlsext_use_srtp(_ctx, "SRTP_AES128_CM_SHA1_80");

	_ssl = SSL_new(_ctx);
	_rbio = BIO_new(BIO_s_mem());
	_wbio = BIO_new(BIO_s_mem());
	BIO_set_mem_eof_return(_rbio, -1);
	BIO_set_mem_eof_return(_wbio, -1);
	SSL_set_bio(_ssl, _rbio, _wbio);

	if (_isClient) SSL_set_connect_state(_ssl);
	else SSL_set_accept_state(_ssl);
}

DtlsTransport::~DtlsTransport() {
	if (_ssl) SSL_free(_ssl); // frees _rbio/_wbio too (owned via SSL_set_bio)
	if (_ctx) SSL_CTX_free(_ctx);
	if (_cert) X509_free(_cert);
	if (_pkey) EVP_PKEY_free(_pkey);
}

std::string DtlsTransport::getLocalFingerprint() const {
	return fingerprint_hex(_cert);
}

void DtlsTransport::start() {
	driveHandshake();
}

void DtlsTransport::feedIncomingData(const uint8_t *data, size_t len) {
	BIO_write(_rbio, data, (int)len);
	driveHandshake();
}

void DtlsTransport::tick() {
	if (_handshakeDone) return;
	struct timeval timeout;
	if (DTLSv1_get_timeout(_ssl, &timeout) == 1) {
		// A real event loop would arm a timer for exactly this long; since tick() is called on a
		// fixed cadence by the caller, just handle the timeout unconditionally here -- handling it
		// "early" relative to a real timer is harmless (DTLSv1_handle_timeout is a no-op if
		// nothing has actually expired internally, only triggers a real retransmit otherwise, per
		// OpenSSL's own documented behavior for this call).
		DTLSv1_handle_timeout(_ssl);
		pumpOutgoing();
	}
}

void DtlsTransport::driveHandshake() {
	if (_handshakeDone) {
		// Post-handshake: keep draining rbio in case any application data (there shouldn't be any
		// for our use -- we only use DTLS for the handshake, SRTP carries all real media/RTCP) or
		// a post-handshake alert/close-notify arrives.
		char buf[2048];
		while (SSL_read(_ssl, buf, sizeof(buf)) > 0) { /* discard */ }
		pumpOutgoing();
		return;
	}

	int rc = SSL_do_handshake(_ssl);
	if (rc == 1) {
		// Set BEFORE pumpOutgoing(): pumpOutgoing() synchronously invokes onOutgoingData, which
		// in turn can re-enter driveHandshake() on this SAME object if the caller's send/receive
		// wiring is itself synchronous/re-entrant (as this file's own loopback spike is, though a
		// real IceSession-driven caller dispatches via the GLib main loop instead and won't hit
		// this). Setting the flag first guarantees any such reentrant call takes the
        // already-done branch above instead of calling SSL_do_handshake() again on an SSL object
		// whose internal state OpenSSL already considers finished (which can spuriously return a
		// non-1 result with nothing in the error queue).
		_handshakeDone = true;
		pumpOutgoing();
		if (onHandshakeComplete) onHandshakeComplete();
		return;
	}
	// Read the result before pumpOutgoing(): with re-entrant wiring, sending can feed the peer's
	// answer back into this object and finish the handshake, after which SSL_get_error() on this
	// old rc reports an error with nothing in the queue.
	int err = SSL_get_error(_ssl, rc);
	unsigned long errCode = ERR_get_error();
	pumpOutgoing();
	if (_handshakeDone)
		return;

	if (err != SSL_ERROR_WANT_READ && err != SSL_ERROR_WANT_WRITE) {
		if (onHandshakeFailed) {
			char errbuf[256];
			ERR_error_string_n(errCode, errbuf, sizeof(errbuf));
			onHandshakeFailed(errbuf);
		}
	}
}

void DtlsTransport::pumpOutgoing() {
	char buf[4096];
	int n;
	while ((n = BIO_read(_wbio, buf, sizeof(buf))) > 0) {
		if (onOutgoingData) onOutgoingData((const uint8_t *)buf, (size_t)n);
	}
}

bool DtlsTransport::verifyPeerFingerprint(const std::string &expectedFingerprint) const {
	if (!_handshakeDone) return false;
	X509 *peerCert = SSL_get_peer_certificate(_ssl);
	if (!peerCert) return false;
	std::string actual = fingerprint_hex(peerCert);
	X509_free(peerCert);
	return fingerprints_equal(actual, expectedFingerprint);
}

SrtpKeyingMaterial DtlsTransport::exportSrtpKeys() const {
	SrtpKeyingMaterial result;
	if (!_handshakeDone) return result;

	SRTP_PROTECTION_PROFILE *profile = SSL_get_selected_srtp_profile(_ssl);
	result.profileName = profile ? profile->name : "";

	// RFC 5764 section 4.2: exported material is laid out as
	// client_write_key || server_write_key || client_write_salt || server_write_salt
	// (NOT interleaved key+salt per side -- all keys first, then all salts).
	constexpr size_t kKeyLen = 16;
	constexpr size_t kSaltLen = 14;
	uint8_t material[2 * (kKeyLen + kSaltLen)];
	if (SSL_export_keying_material(const_cast<SSL *>(_ssl), material, sizeof(material),
	                                 "EXTRACTOR-dtls_srtp", 19, nullptr, 0, 0) != 1) {
		return result;
	}

	size_t off = 0;
	memcpy(result.clientKey.data(), material + off, kKeyLen); off += kKeyLen;
	memcpy(result.serverKey.data(), material + off, kKeyLen); off += kKeyLen;
	memcpy(result.clientSalt.data(), material + off, kSaltLen); off += kSaltLen;
	memcpy(result.serverSalt.data(), material + off, kSaltLen);

	return result;
}

} // namespace tgcalls_lite
