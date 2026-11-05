// Phase 1e spike: the FULL combined stack -- two MediaSession instances (caller + callee) driven
// through real ICE gathering/connectivity, a real DTLS-SRTP handshake over the connected
// component, and a real RTP packet round trip, all through the actual MediaSession class (not the
// individual ice_session/dtls_transport/srtp_session pieces tested standalone before). Credential/
// fingerprint/candidate exchange is done directly in-process here, standing in for what
// signaling_message.h + encrypted_connection.h + TDLib's sendCallSignalingData will carry for a
// real call.
#include <cstdio>
#include <cstring>
#include <atomic>
#include "../media_session.h"

using namespace tgcalls_lite;

int main() {
	GMainContext *ctx = g_main_context_default();

	MediaSession caller(ctx, /*isOutgoing=*/true);
	MediaSession callee(ctx, /*isOutgoing=*/false);

	std::atomic<bool> callerGathered{false}, calleeGathered{false};
	std::atomic<bool> callerReady{false}, calleeReady{false};
	std::atomic<bool> failed{false};
	std::atomic<bool> calleeGotRtp{false};
	uint8_t calleeRtpBuf[256];
	int calleeRtpLen = 0;

	caller.onGatheringDone = [&]() { callerGathered = true; };
	callee.onGatheringDone = [&]() { calleeGathered = true; };
	caller.onStateChanged = [&](MediaSessionState s) {
		fprintf(stderr, "spike: caller state=%d\n", (int)s);
		if (s == MediaSessionState::Ready) callerReady = true;
		if (s == MediaSessionState::Failed) failed = true;
	};
	callee.onStateChanged = [&](MediaSessionState s) {
		fprintf(stderr, "spike: callee state=%d\n", (int)s);
		if (s == MediaSessionState::Ready) calleeReady = true;
		if (s == MediaSessionState::Failed) failed = true;
	};
	callee.onRtpReceived = [&](const uint8_t *payload, int len) {
		fprintf(stderr, "spike: callee received RTP, %d bytes\n", len);
		memcpy(calleeRtpBuf, payload, len);
		calleeRtpLen = len;
		calleeGotRtp = true;
	};

	caller.start();
	callee.start();

	for (int i = 0; i < 3000 && !(callerGathered && calleeGathered); i++) {
		g_main_context_iteration(ctx, TRUE);
	}
	if (!callerGathered || !calleeGathered) {
		fprintf(stderr, "FAIL: gathering never completed\n");
		return 1;
	}

	// Exchange ICE credentials + candidates + DTLS fingerprints (this in-process hand-off is what
	// signaling_message.h's InitialSetupMessage/CandidatesMessage + encrypted_connection.h +
	// TDLib's sendCallSignalingData/updateNewCallSignalingData will do for a real call).
	std::string callerUfrag, callerPwd, calleeUfrag, calleePwd;
	caller.getLocalIceCredentials(&callerUfrag, &callerPwd);
	callee.getLocalIceCredentials(&calleeUfrag, &calleePwd);
	caller.setRemoteIceCredentials(calleeUfrag, calleePwd);
	callee.setRemoteIceCredentials(callerUfrag, callerPwd);

	for (const auto &c : caller.getLocalCandidateSdpStrings()) callee.addRemoteCandidateSdp(c);
	for (const auto &c : callee.getLocalCandidateSdpStrings()) caller.addRemoteCandidateSdp(c);

	std::string callerFp = caller.getLocalDtlsFingerprint();
	std::string calleeFp = callee.getLocalDtlsFingerprint();
	caller.setRemoteDtlsFingerprint(calleeFp);
	callee.setRemoteDtlsFingerprint(callerFp);

	for (int i = 0; i < 5000 && !(callerReady && calleeReady) && !failed; i++) {
		g_main_context_iteration(ctx, TRUE);
		if (i % 50 == 0) { caller.tick(); callee.tick(); }
	}

	if (failed) {
		fprintf(stderr, "FAIL: a media session reported Failed state\n");
		return 1;
	}
	if (!callerReady || !calleeReady) {
		fprintf(stderr, "FAIL: media sessions never reached Ready (caller=%d callee=%d)\n",
		        (int)callerReady, (int)calleeReady);
		return 1;
	}
	fprintf(stderr, "spike: BOTH SESSIONS READY (full ICE+DTLS+SRTP stack live)\n");

	// Real RTP send/receive through the whole stack.
	uint8_t rtp[12 + 20 + 200];
	memset(rtp, 0, sizeof(rtp));
	rtp[0] = 0x80; rtp[1] = 100;
	rtp[2] = 0; rtp[3] = 1;
	rtp[8] = 0xAA; rtp[9] = 0xBB; rtp[10] = 0xCC; rtp[11] = 0xDD;
	const char *payload = "hello from caller!!!";
	memcpy(rtp + 12, payload, strlen(payload));
	int rtpLen = 12 + (int)strlen(payload);

	if (!caller.sendRtp(rtp, &rtpLen)) {
		fprintf(stderr, "FAIL: caller.sendRtp failed\n");
		return 1;
	}

	for (int i = 0; i < 2000 && !calleeGotRtp; i++) {
		g_main_context_iteration(ctx, TRUE);
	}
	if (!calleeGotRtp) {
		fprintf(stderr, "FAIL: callee never received the RTP packet\n");
		return 1;
	}
	if (calleeRtpLen != 12 + (int)strlen(payload) ||
	    memcmp(calleeRtpBuf + 12, payload, strlen(payload)) != 0) {
		fprintf(stderr, "FAIL: received RTP payload does not match what was sent\n");
		return 1;
	}

	fprintf(stderr, "ALL OK\n");
	return 0;
}
