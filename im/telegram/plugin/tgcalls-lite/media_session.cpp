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
	: _isOutgoing(isOutgoing) {
	_ice = std::make_unique<IceSession>(ctx, /*controlling=*/isOutgoing);
	// tgcalls' roles (NativeNetworkingImpl::setRemoteParams): the caller offers "actpass", the
	// callee answers "passive", so the caller is the DTLS client and the callee the server.
	_dtls = std::make_unique<DtlsTransport>(/*isClient=*/isOutgoing);

	_ice->onGatheringDone = [this]() { if (onGatheringDone) onGatheringDone(); };
	_ice->onDataReceived = [this](const uint8_t *data, size_t len) { handleIceData(data, len); };
	_ice->onStateChanged = [this](IceConnectionState s) {
		if (s == IceConnectionState::Connected && !_iceConnected) {
			_iceConnected = true;
			setState(MediaSessionState::Connecting);
			_dtls->start(); // the client sends the ClientHello, the server waits for it
		} else if (s == IceConnectionState::Failed) {
			setState(MediaSessionState::Failed);
		}
	};

	_dtls->onOutgoingData = [this](const uint8_t *data, size_t len) { _ice->send(data, len); };
	_dtls->onHandshakeComplete = [this]() {
		g_message("tgcalls-lite: DTLS handshake done (%s)", _isOutgoing ? "client" : "server");
		_dtlsDone = true;
		// If the peer's fingerprint has not arrived yet (media connected before signalling),
		// setRemoteDtlsFingerprint() finishes this once it does.
		if (!_remoteFingerprint.empty()) finishHandshake();
	};
	_dtls->onHandshakeFailed = [this](const std::string &reason) {
		g_warning("tgcalls-lite: DTLS handshake failed: %s", reason.c_str());
		if (_state != MediaSessionState::Ready) setState(MediaSessionState::Failed);
	};
}

void MediaSession::finishHandshake() {
	if (_srtp || _state == MediaSessionState::Failed) return;
	if (!_dtls->verifyPeerFingerprint(_remoteFingerprint)) {
		g_warning("tgcalls-lite: the peer's DTLS certificate does not match its fingerprint");
		setState(MediaSessionState::Failed);
		return;
	}
	auto mat = _dtls->exportSrtpKeys();
	// RFC 5764 4.2: the client sends with the client write key, the server with the server one.
	const bool isClient = _isOutgoing;
	auto sendKey = isClient ? concat_key_salt(mat.clientKey, mat.clientSalt)
	                        : concat_key_salt(mat.serverKey, mat.serverSalt);
	auto recvKey = isClient ? concat_key_salt(mat.serverKey, mat.serverSalt)
	                        : concat_key_salt(mat.clientKey, mat.clientSalt);
	_srtp = std::make_unique<SrtpSession>(sendKey.data(), recvKey.data());
	if (!_srtp->ok()) g_warning("tgcalls-lite: SRTP setup failed");
	setState(_srtp->ok() ? MediaSessionState::Ready : MediaSessionState::Failed);
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
	if (_dtlsDone) finishHandshake();
}

size_t MediaSession::setServers(const std::vector<RtcServer> &servers) {
	return _ice->setServers(servers);
}

bool MediaSession::sendRtp(uint8_t *buf, int *len) {
	if (_state != MediaSessionState::Ready || !_srtp) return false;
	if (!_srtp->protectRtp(buf, len) || _ice->send(buf, (size_t)*len) < 0) {
		_stats.sendErrors++;
		return false;
	}
	_stats.rtpOut++;
	return true;
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
		_stats.dtlsIn++;
		_dtls->feedIncomingData(data, len);
		return;
	}
	if (!_srtp) { // media arrived before SRTP was ready -- drop, matches WebRTC's own behavior
		_stats.beforeSrtp++;
		return;
	}
	if (len < 2) return;
	uint8_t firstByte = data[0];
	bool isRtcp = firstByte >= 128 && firstByte <= 191 && data[1] >= 192 && data[1] <= 223;

	std::vector<uint8_t> copy(data, data + len);
	int copyLen = (int)copy.size();
	copy.resize(copy.size() + 200); // headroom isn't needed for unprotect (shrinks), but keep
	                                  // consistent buffer sizing with the protect path elsewhere.
	if (isRtcp) {
		if (_srtp->unprotectRtcp(copy.data(), &copyLen)) {
			_stats.rtcpIn++;
			if (onRtcpReceived) onRtcpReceived(copy.data(), copyLen);
		} else {
			_stats.srtpErrors++;
		}
	} else {
		if (_srtp->unprotectRtp(copy.data(), &copyLen)) {
			_stats.rtpIn++;
			if (onRtpReceived) onRtpReceived(copy.data(), copyLen);
		} else {
			_stats.srtpErrors++;
		}
	}
}

void MediaSession::setState(MediaSessionState s) {
	if (_state == s) return;
	_state = s;
	if (onStateChanged) onStateChanged(s);
}

} // namespace tgcalls_lite
