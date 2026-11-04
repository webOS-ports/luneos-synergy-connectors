// Phase 1e/2 spike: the most complete proof possible without the real device/TDLib -- two
// CallEngine instances (caller + callee) that ONLY exchange opaque encrypted byte blobs through
// their onOutgoingSignalingData/handleIncomingSignalingData callbacks, exactly the shape
// td_api::sendCallSignalingData/updateNewCallSignalingData will carry for a real call. Neither
// side calls anything on the other's MediaSession/IceSession/DtlsTransport directly -- this proves
// the ENTIRE tgcalls-lite stack (signaling codec incl. NegotiateChannels, encryption, ICE,
// DTLS-SRTP, real H.264-over-RTP framing via h264_rtp.c) works together end to end, driven only
// through the same narrow interface TDLib will actually expose. Deliberately NOT exercising
// AudioPipeline::startAudio() here -- that opens real ALSA devices, which don't exist under
// qemu-arm-static emulation (and, separately, must not run concurrently with libtgvoip's own ALSA
// session in production either -- see call_engine.h's startAudio() comment).
#include <cstdio>
#include <cstring>
#include <atomic>
#include <vector>
#include "../call_engine.h"
#include "../encrypted_connection.h"
#include "../signaling_message.h"
#include <string>

using namespace tgcalls_lite;

int main() {
	GMainContext *ctx = g_main_context_default();

	// Same 256-byte call encryption key both sides would get from TDLib's callStateReady --
	// simulated here since we have no real TDLib call in this test.
	uint8_t callKey[256];
	for (int i = 0; i < 256; i++) callKey[i] = (uint8_t)(i * 17 + 5);

	CallEngine caller(ctx, callKey, /*isOutgoing=*/true, /*isVideo=*/true);
	CallEngine callee(ctx, callKey, /*isOutgoing=*/false, /*isVideo=*/true);

	// Decrypt a copy of each direction on the side, as the receiving peer would, to check the
	// DTLS setup each side announces: tgcalls' caller says "actpass", its callee "passive".
	EncryptedConnection spyAtCallee(callKey, /*isOutgoing=*/false);
	EncryptedConnection spyAtCaller(callKey, /*isOutgoing=*/true);
	std::string callerSetup, calleeSetup;
	int firstOfferFrom = 0; // 1 = caller, 2 = callee
	uint32_t callerOfferId = 0, calleeFirstNegotiateId = 0;
	auto spy = [&](EncryptedConnection &conn, const std::vector<uint8_t> &data, std::string &setup, int who) {
		auto plain = conn.decrypt(data);
		SignalingMessage m;
		if (!plain || !signaling_message_parse(plain->data(), plain->size(), &m)) return;
		if (m.type == SignalingMessageType::InitialSetup && !m.initialSetup.fingerprints.empty())
			setup = m.initialSetup.fingerprints[0].setup;
		if (m.type != SignalingMessageType::NegotiateChannels) return;
		if (firstOfferFrom == 0) firstOfferFrom = who;
		if (who == 1 && callerOfferId == 0) callerOfferId = m.negotiateChannels.exchangeId;
		if (who == 2 && calleeFirstNegotiateId == 0) calleeFirstNegotiateId = m.negotiateChannels.exchangeId;
	};
	caller.onOutgoingSignalingData = [&](const std::vector<uint8_t> &data) {
		fprintf(stderr, "spike: caller->callee signaling, %zu bytes\n", data.size());
		spy(spyAtCallee, data, callerSetup, 1);
		callee.handleIncomingSignalingData(data);
	};
	callee.onOutgoingSignalingData = [&](const std::vector<uint8_t> &data) {
		fprintf(stderr, "spike: callee->caller signaling, %zu bytes\n", data.size());
		spy(spyAtCaller, data, calleeSetup, 2);
		caller.handleIncomingSignalingData(data);
	};

	std::atomic<bool> callerReady{false}, calleeReady{false};
	caller.onMediaReady = [&]() { fprintf(stderr, "spike: caller media READY\n"); callerReady = true; };
	callee.onMediaReady = [&]() { fprintf(stderr, "spike: callee media READY\n"); calleeReady = true; };

	std::atomic<bool> calleeGotVideo{false};
	std::vector<uint8_t> calleeVideoBuf;
	callee.onVideoAccessUnit = [&](const uint8_t *accessUnit, unsigned int len) {
		fprintf(stderr, "spike: callee received H.264 access unit via full stack, %u bytes\n", len);
		calleeVideoBuf.assign(accessUnit, accessUnit + len);
		calleeGotVideo = true;
	};

	// The callee gathers first, so it is ready before any offer arrives: it must still wait for
	// the caller's offer instead of offering itself.
	int calleeSent = 0;
	auto calleeSend = callee.onOutgoingSignalingData;
	callee.onOutgoingSignalingData = [&](const std::vector<uint8_t> &data) { calleeSent++; calleeSend(data); };
	callee.start();
	for (int i = 0; i < 2000 && calleeSent == 0; i++) g_main_context_iteration(ctx, TRUE);
	caller.start();

	for (int i = 0; i < 8000 && !(callerReady && calleeReady); i++) {
		g_main_context_iteration(ctx, TRUE);
		if (i % 50 == 0) { caller.tick(); callee.tick(); }
	}

	if (!callerReady || !calleeReady) {
		fprintf(stderr, "FAIL: never reached Ready (caller=%d callee=%d)\n", (int)callerReady, (int)calleeReady);
		return 1;
	}

	if (callerSetup != "actpass" || calleeSetup != "passive") {
		fprintf(stderr, "FAIL: DTLS setup caller=\"%s\" callee=\"%s\", tgcalls expects actpass/passive\n",
		        callerSetup.c_str(), calleeSetup.c_str());
		return 1;
	}
	// The callee's first NegotiateChannels must be its answer to the caller's offer, as in tgcalls.
	if (firstOfferFrom != 1 || calleeFirstNegotiateId != callerOfferId) {
		fprintf(stderr, "FAIL: the first NegotiateChannels came from side %d, not the caller\n", firstOfferFrom);
		return 1;
	}

	// A minimal, single-NAL Annex-B access unit (4-byte start code + a fake NAL header/payload --
	// not a real decodable frame, just enough structure for h264_rtp.c's packetizer/depacketizer
	// to round-trip, matching what a real captured frame from voipkit.cpp's Thread A looks like
	// on the wire).
	std::vector<uint8_t> accessUnit = {0x00, 0x00, 0x00, 0x01, 0x65};
	for (int i = 0; i < 50; i++) accessUnit.push_back((uint8_t)(i * 3 + 7));

	caller.sendVideoAccessUnit(accessUnit.data(), accessUnit.size());

	for (int i = 0; i < 2000 && !calleeGotVideo; i++) {
		g_main_context_iteration(ctx, TRUE);
	}
	if (!calleeGotVideo) {
		fprintf(stderr, "FAIL: callee never received the video access unit\n");
		return 1;
	}
	if (calleeVideoBuf != accessUnit) {
		fprintf(stderr, "FAIL: received access unit does not match what was sent (got %zu bytes, expected %zu)\n",
		        calleeVideoBuf.size(), accessUnit.size());
		return 1;
	}

	fprintf(stderr, "ALL OK -- full tgcalls-lite stack (signaling+NegotiateChannels+crypto+ICE+DTLS-SRTP+H.264 RTP) verified end to end\n");
	return 0;
}
