#include "srtp_session.h"

#include <srtp2/srtp.h>
#include <cstring>
#include <mutex>

namespace tgcalls_lite {

namespace {

void ensure_srtp_init() {
	static std::once_flag flag;
	std::call_once(flag, []() { srtp_init(); });
}

srtp_t make_session(const uint8_t *keyAndSalt, srtp_ssrc_type_t ssrcType) {
	srtp_policy_t policy;
	memset(&policy, 0, sizeof(policy));
	srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&policy.rtp);
	srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&policy.rtcp);
	policy.ssrc.type = ssrcType;
	policy.ssrc.value = 0; // ignored for ssrc_any_{in,out}bound
	policy.key = const_cast<uint8_t *>(keyAndSalt);
	policy.next = nullptr;
	policy.window_size = 128;
	policy.allow_repeat_tx = 0;

	srtp_t session = nullptr;
	if (srtp_create(&session, &policy) != srtp_err_status_ok) return nullptr;
	return session;
}

} // namespace

SrtpSession::SrtpSession(const uint8_t *sendKeyAndSalt, const uint8_t *recvKeyAndSalt) {
	ensure_srtp_init();
	_sendSession = make_session(sendKeyAndSalt, ssrc_any_outbound);
	_recvSession = make_session(recvKeyAndSalt, ssrc_any_inbound);
}

SrtpSession::~SrtpSession() {
	if (_sendSession) srtp_dealloc((srtp_t)_sendSession);
	if (_recvSession) srtp_dealloc((srtp_t)_recvSession);
}

bool SrtpSession::protectRtp(uint8_t *buf, int *len) {
	if (!_sendSession) return false;
	return srtp_protect((srtp_t)_sendSession, buf, len) == srtp_err_status_ok;
}

bool SrtpSession::unprotectRtp(uint8_t *buf, int *len) {
	if (!_recvSession) return false;
	return srtp_unprotect((srtp_t)_recvSession, buf, len) == srtp_err_status_ok;
}

bool SrtpSession::protectRtcp(uint8_t *buf, int *len) {
	if (!_sendSession) return false;
	return srtp_protect_rtcp((srtp_t)_sendSession, buf, len) == srtp_err_status_ok;
}

bool SrtpSession::unprotectRtcp(uint8_t *buf, int *len) {
	if (!_recvSession) return false;
	return srtp_unprotect_rtcp((srtp_t)_recvSession, buf, len) == srtp_err_status_ok;
}

} // namespace tgcalls_lite
