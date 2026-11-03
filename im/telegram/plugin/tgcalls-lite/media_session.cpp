#include "media_session.h"
#include "dtls_transport.h"
#include "srtp_session.h"

#include <cstring>
#include <cstdio>

namespace tgcalls_lite {

namespace {

// RFC 5764 section 5.1.2 demux rule.
bool looks_like_dtls(const uint8_t *data, size_t len) {
	return len >= 1 && data[0] >= 20 && data[0] <= 63;
}

std::vector<uint8_t> concat_key_salt(const std::array<uint8_t, 16> &key, const std::array<uint8_t, 14> &salt) {
	std::vector<uint8_t> out(30);
	memcpy(out.data(), key.data(), 16);
	memcpy(out.data() + 16, salt.data(), 14);
	return out;
}

} // namespace

MediaSession::MediaSession(GMainContext *ctx, bool isOutgoing)
	: _ctx(ctx), _isOutgoing(isOutgoing) {
	_ice = std::make_unique<IceSession>(ctx, /*controlling=*/isOutgoing);
	// See header comment: caller (isOutgoing) = DTLS server (passive), callee = DTLS client
	// (active). DtlsTransport's isClient constructor arg is the inverse of isOutgoing here.
	_dtls = std::make_unique<DtlsTransport>(/*isClient=*/!isOutgoing);

	_ice->onGatheringDone = [this]() { if (onGatheringDone) onGatheringDone(); };
	_ice->onDataReceived = [this](const uint8_t *data, size_t len) { handleIceData(data, len); };
	_ice->onStateChanged = [this](IceConnectionState s) {
		if (s == IceConnectionState::Connected && !_iceConnected) {
			_iceConnected = true;
			setState(MediaSessionState::Connecting);
			_dtls->start(); // caller is DTLS server (waits/accepts), callee is client (initiates)
		} else if (s == IceConnectionState::Failed) {
			setState(MediaSessionState::Failed);
		}
	};

	_dtls->onOutgoingData = [this](const uint8_t *data, size_t len) { _ice->send(data, len); };
	_dtls->onHandshakeComplete = [this]() {
		if (_remoteFingerprint.empty()) {
			// Fingerprint not known yet (signaling race -- peer's InitialSetupMessage hasn't
			// arrived even though media connected first). setRemoteDtlsFingerprint will finish
			// this check once it does arrive; nothing more to do here yet.
			return;
		}
		if (!_dtls->verifyPeerFingerprint(_remoteFingerprint)) {
			setState(MediaSessionState::Failed);
			return;
		}
		auto mat = _dtls->exportSrtpKeys();
		// DTLS client's "client key" is ITS send direction; DTLS server's "client key" is what it
		// receives FROM the client. isOutgoing == DTLS server here (see constructor comment).
		auto sendKey = _isOutgoing ? concat_key_salt(mat.serverKey, mat.serverSalt)
		                           : concat_key_salt(mat.clientKey, mat.clientSalt);
		auto recvKey = _isOutgoing ? concat_key_salt(mat.clientKey, mat.clientSalt)
		                           : concat_key_salt(mat.serverKey, mat.serverSalt);
		_srtp = std::make_unique<SrtpSession>(sendKey.data(), recvKey.data());
		setState(_srtp->ok() ? MediaSessionState::Ready : MediaSessionState::Failed);
	};
	_dtls->onHandshakeFailed = [this](const std::string &) {
		if (_state != MediaSessionState::Ready) setState(MediaSessionState::Failed);
	};
}

MediaSession::~MediaSession() = default;

void MediaSession::start() {
	_ice->gatherCandidates();
}

void MediaSession::getLocalIceCredentials(std::string *ufrag, std::string *pwd) const {
	_ice->getLocalCredentials(ufrag, pwd);
}

std::string MediaSession::getLocalDtlsFingerprint() const {
	return _dtls->getLocalFingerprint();
}

std::vector<std::string> MediaSession::getLocalCandidateSdpStrings() const {
	return _ice->getLocalCandidateSdpStrings();
}

void MediaSession::setRemoteIceCredentials(const std::string &ufrag, const std::string &pwd) {
	_ice->setRemoteCredentials(ufrag, pwd);
}

bool MediaSession::addRemoteCandidateSdp(const std::string &sdpString) {
	return _ice->addRemoteCandidateSdp(sdpString);
}

void MediaSession::setRemoteDtlsFingerprint(const std::string &fingerprint) {
	_remoteFingerprint = fingerprint;
	// If the DTLS handshake already finished before the fingerprint arrived (signaling race the
	// other way), re-check now instead of waiting for a callback that already fired.
	if (_state == MediaSessionState::Connecting) {
		// onHandshakeComplete already ran once with an empty _remoteFingerprint and returned
		// early; re-run its logic now that we actually have one.
		if (_dtls->verifyPeerFingerprint(_remoteFingerprint)) {
			auto mat = _dtls->exportSrtpKeys();
			auto sendKey = _isOutgoing ? concat_key_salt(mat.serverKey, mat.serverSalt)
			                           : concat_key_salt(mat.clientKey, mat.clientSalt);
			auto recvKey = _isOutgoing ? concat_key_salt(mat.clientKey, mat.clientSalt)
			                           : concat_key_salt(mat.serverKey, mat.serverSalt);
			_srtp = std::make_unique<SrtpSession>(sendKey.data(), recvKey.data());
			setState(_srtp->ok() ? MediaSessionState::Ready : MediaSessionState::Failed);
		}
	}
}

bool MediaSession::sendRtp(uint8_t *buf, int *len) {
	if (_state != MediaSessionState::Ready || !_srtp) return false;
	if (!_srtp->protectRtp(buf, len)) return false;
	return _ice->send(buf, (size_t)*len) >= 0;
}

bool MediaSession::sendRtcp(uint8_t *buf, int *len) {
	if (_state != MediaSessionState::Ready || !_srtp) return false;
	if (!_srtp->protectRtcp(buf, len)) return false;
	return _ice->send(buf, (size_t)*len) >= 0;
}

void MediaSession::tick() {
	if (_dtls) _dtls->tick();
}

void MediaSession::handleIceData(const uint8_t *data, size_t len) {
	if (looks_like_dtls(data, len)) {
		_dtls->feedIncomingData(data, len);
		return;
	}
	if (!_srtp) return; // media arrived before SRTP was ready -- drop, matches WebRTC's own behavior
	if (len < 2) return;
	uint8_t firstByte = data[0];
	bool isRtcp = firstByte >= 128 && firstByte <= 191 && data[1] >= 192 && data[1] <= 223;

	std::vector<uint8_t> copy(data, data + len);
	int copyLen = (int)copy.size();
	copy.resize(copy.size() + 200); // headroom isn't needed for unprotect (shrinks), but keep
	                                  // consistent buffer sizing with the protect path elsewhere.
	if (isRtcp) {
		if (_srtp->unprotectRtcp(copy.data(), &copyLen)) {
			if (onRtcpReceived) onRtcpReceived(copy.data(), copyLen);
		}
	} else {
		if (_srtp->unprotectRtp(copy.data(), &copyLen)) {
			if (onRtpReceived) onRtpReceived(copy.data(), copyLen);
		}
	}
}

void MediaSession::setState(MediaSessionState s) {
	if (_state == s) return;
	_state = s;
	if (onStateChanged) onStateChanged(s);
}

} // namespace tgcalls_lite
