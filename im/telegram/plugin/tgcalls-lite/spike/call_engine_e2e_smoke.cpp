// Phase 1e/2 spike: the most complete proof possible without the real device/TDLib -- two
// CallEngine instances (caller + callee) that ONLY exchange opaque encrypted byte blobs through
// their onOutgoingSignalingData/handleIncomingSignalingData callbacks, exactly the shape
// td_api::sendCallSignalingData/updateNewCallSignalingData will carry for a real call. Neither
// side calls anything on the other's MediaSession/IceSession/DtlsTransport directly -- this proves
// the ENTIRE tgcalls-lite stack (signaling codec incl. NegotiateChannels, encryption, ICE,
// DTLS-SRTP, real H.264-over-RTP framing via h264_rtp.c) works together end to end, driven only
// through the same narrow interface TDLib will actually expose. startAudio() is not exercised: it
// needs the device's PulseAudio call devices.
#include <cstdio>
#include <cstring>
#include <atomic>
#include <thread>
#include <unistd.h>
#include <vector>
#include "../call_engine.h"
#include "../encrypted_connection.h"
#include "../signaling_message.h"
#include <string>

using namespace tgcalls_lite;

int main() {
	alarm(120); // a hang fails the test (SIGALRM) instead of stalling "make check"
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
	// The receiver passes a stream on from its first IDR with a sequence parameter set, so
	// a fake SPS NAL comes first.
	std::vector<uint8_t> accessUnit = {0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x01, 0x65};
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

	// Audio both ways, posted from other threads as the capture thread does. Frames carry their
	// index so loss and corruption show.
	constexpr int kFrames = 20; // fewer than the engine queues (25), so none is dropped
	std::vector<std::vector<uint8_t>> gotAtCallee, gotAtCaller;
	callee.onAudioFrame = [&](const uint8_t *p, int n) { gotAtCallee.emplace_back(p, p + n); };
	caller.onAudioFrame = [&](const uint8_t *p, int n) { gotAtCaller.emplace_back(p, p + n); };
	auto frame = [](int side, int i) {
		std::vector<uint8_t> f(40 + (size_t)i);
		for (size_t k = 0; k < f.size(); k++) f[k] = (uint8_t)(side * 100 + i + (int)k);
		return f;
	};
	std::thread t1([&]() { for (int i = 0; i < kFrames; i++) { auto f = frame(1, i); caller.postEncodedAudio(f.data(), (int)f.size()); } });
	std::thread t2([&]() { for (int i = 0; i < kFrames; i++) { auto f = frame(2, i); callee.postEncodedAudio(f.data(), (int)f.size()); } });
	t1.join();
	t2.join();
	for (int i = 0; i < 4000 && (gotAtCallee.size() < (size_t)kFrames || gotAtCaller.size() < (size_t)kFrames); i++)
		g_main_context_iteration(ctx, TRUE);
	if (gotAtCallee.size() != (size_t)kFrames || gotAtCaller.size() != (size_t)kFrames) {
		fprintf(stderr, "FAIL: audio frames received: callee %zu, caller %zu, expected %d each\n",
		        gotAtCallee.size(), gotAtCaller.size(), kFrames);
		return 1;
	}
	for (int i = 0; i < kFrames; i++) {
		if (gotAtCallee[(size_t)i] != frame(1, i) || gotAtCaller[(size_t)i] != frame(2, i)) {
			fprintf(stderr, "FAIL: audio frame %d differs from what was sent\n", i);
			return 1;
		}
	}

	// Overflow: 40 frames posted before the loop runs; the queue keeps the newest 25.
	gotAtCallee.clear();
	std::thread t3([&]() { for (int i = 0; i < 40; i++) { auto f = frame(3, i); caller.postEncodedAudio(f.data(), (int)f.size()); } });
	t3.join();
	for (int i = 0; i < 4000 && gotAtCallee.size() < 25; i++) g_main_context_iteration(ctx, TRUE);
	for (int i = 0; i < 20; i++) g_main_context_iteration(ctx, FALSE);
	if (gotAtCallee.size() != 25 || gotAtCallee.front() != frame(3, 15) || gotAtCallee.back() != frame(3, 39)) {
		fprintf(stderr, "FAIL: overflow kept %zu frames, expected the newest 25 (15..39)\n", gotAtCallee.size());
		return 1;
	}

	fprintf(stderr, "ALL OK -- full tgcalls-lite stack (signaling+NegotiateChannels+crypto+ICE+DTLS-SRTP+H.264 RTP) verified end to end\n");
	return 0;
}
