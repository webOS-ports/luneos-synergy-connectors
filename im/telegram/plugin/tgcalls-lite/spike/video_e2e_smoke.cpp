// Video between two CallEngines over the whole stack (signalling, ICE on loopback, DTLS-SRTP),
// as call_engine_e2e_smoke does for the basics: a voice call whose callee starts with its camera
// on, the caller turning its camera on and off mid-call, keyframe requests both ways, the send
// queue's overflow handling, and the MediaState messages that tell the peer about our camera.
#include <atomic>
#include <cstdio>
#include <cstring>
#include <thread>
#include <unistd.h>
#include <vector>

#include "../call_engine.h"
#include "../encrypted_connection.h"
#include "../signaling_message.h"

using namespace tgcalls_lite;

static int failures;
#define CHECK(c, ...) do { if (!(c)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
	fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } } while (0)

static std::vector<uint8_t> au(uint8_t type, size_t size, uint8_t fill) {
	std::vector<uint8_t> v = {0, 0, 0, 1, (uint8_t)(0x60 | type)};
	for (size_t i = 0; i < size; i++) v.push_back((uint8_t)(fill + i * 7));
	return v;
}

struct MediaStates {
	std::vector<MediaStateMessage> seen;
};

int main() {
	alarm(120);
	GMainContext *ctx = g_main_context_default();
	uint8_t key[256];
	for (int i = 0; i < 256; i++) key[i] = (uint8_t)(i * 31 + 3);

	CallEngine caller(ctx, key, true, /*isVideo=*/false);
	CallEngine callee(ctx, key, false, /*isVideo=*/true);
	callee.setVideoRotation(90);

	EncryptedConnection spyAtCaller(key, true), spyAtCallee(key, false);
	MediaStates fromCallee, fromCaller;
	auto spy = [](EncryptedConnection &conn, const std::vector<uint8_t> &data, MediaStates &out) {
		auto plain = conn.decrypt(data);
		SignalingMessage m;
		if (plain && signaling_message_parse(plain->data(), plain->size(), &m) && m.type == SignalingMessageType::MediaState)
			out.seen.push_back(m.mediaState);
	};
	caller.onOutgoingSignalingData = [&](const std::vector<uint8_t> &d) {
		spy(spyAtCallee, d, fromCaller);
		callee.handleIncomingSignalingData(d);
	};
	callee.onOutgoingSignalingData = [&](const std::vector<uint8_t> &d) {
		spy(spyAtCaller, d, fromCallee);
		caller.handleIncomingSignalingData(d);
	};

	bool callerReady = false, calleeReady = false;
	caller.onMediaReady = [&]() { callerReady = true; };
	callee.onMediaReady = [&]() { calleeReady = true; };
	std::vector<std::vector<uint8_t>> atCaller, atCallee;
	caller.onVideoAccessUnit = [&](const uint8_t *p, unsigned n) { atCaller.emplace_back(p, p + n); };
	callee.onVideoAccessUnit = [&](const uint8_t *p, unsigned n) { atCallee.emplace_back(p, p + n); };
	int callerKeyframes = 0, calleeKeyframes = 0;
	caller.onKeyframeRequested = [&]() { callerKeyframes++; };
	callee.onKeyframeRequested = [&]() { calleeKeyframes++; };
	std::vector<bool> callerSawPeerVideo, calleeSawPeerVideo;
	caller.onIncomingVideoChanged = [&](bool on) { callerSawPeerVideo.push_back(on); };
	callee.onIncomingVideoChanged = [&](bool on) { calleeSawPeerVideo.push_back(on); };

	auto run = [&](auto done, int iterations) {
		for (int i = 0; i < iterations && !done(); i++) {
			g_main_context_iteration(ctx, FALSE);
			if (i % 50 == 0) { caller.tick(); callee.tick(); }
			g_usleep(1000);
		}
		return done();
	};
	auto settle = [&](int ms) { run([] { return false; }, ms); };

	callee.start();
	caller.start();
	if (!run([&] { return callerReady && calleeReady; }, 30000)) {
		fprintf(stderr, "FAIL: never reached Ready\n");
		return 1;
	}
	settle(200);

	// The callee's camera: offered, accepted, announced.
	CHECK(callerSawPeerVideo.size() == 1 && callerSawPeerVideo[0], "caller saw the callee's video come on");
	CHECK(calleeSawPeerVideo.empty(), "the callee saw no video from the voice-only caller");
	CHECK(callee.negotiatedCodecs().outgoingVideoPt == 100, "callee video accepted (pt %d)",
	      callee.negotiatedCodecs().outgoingVideoPt);
	CHECK(callee.negotiatedCodecs().outgoingVideoRotationExtId == -1,
	      "tgcalls-lite answers without CVO, so the sender keeps frames upright");
	CHECK(!fromCallee.seen.empty() && fromCallee.seen.back().videoState == MediaStateMessage::VideoState::Active &&
	      fromCallee.seen.back().videoRotation == MediaStateMessage::VideoRotation::Rotation90,
	      "callee MediaState: active, 90 (%zu seen)", fromCallee.seen.size());
	CHECK(!fromCaller.seen.empty() && fromCaller.seen.back().videoState == MediaStateMessage::VideoState::Inactive,
	      "caller MediaState: inactive");
	CHECK(calleeKeyframes >= 1, "the caller asked the callee for a keyframe once media was up");

	// Units start at an IDR; posted from another thread, as the capture socket reader does.
	// An IDR as WebRTC sends one: SPS, PPS, then the slice.
	auto idr = au(7, 8, 9);
	for (auto part : {au(8, 4, 5), au(5, 3000, 2)}) idr.insert(idr.end(), part.begin(), part.end());
	const auto p1 = au(1, 900, 1), p2 = au(1, 1500, 3);
	std::thread t([&] {
		callee.postVideoAccessUnit(p1.data(), p1.size());
		callee.postVideoAccessUnit(idr.data(), idr.size());
		callee.postVideoAccessUnit(p2.data(), p2.size());
	});
	t.join();
	run([&] { return atCaller.size() >= 2; }, 3000);
	CHECK(atCaller.size() == 2 && atCaller[0] == idr && atCaller[1] == p2,
	      "the caller got IDR then P, not the P before the IDR (%zu)", atCaller.size());

	// Overflow: more units than the queue holds before the loop runs. All dropped, the encoder
	// asked for a keyframe, units skipped until it comes.
	atCaller.clear();
	const int before = calleeKeyframes;
	std::thread t2([&] {
		callee.postVideoAccessUnit(idr.data(), idr.size());
		for (int i = 0; i < 9; i++) callee.postVideoAccessUnit(p1.data(), p1.size());
	});
	t2.join();
	settle(100);
	CHECK(calleeKeyframes == before + 1, "overflow asked for one keyframe (%d)", calleeKeyframes - before);
	const size_t afterOverflow = atCaller.size();
	callee.postVideoAccessUnit(p2.data(), p2.size());
	callee.postVideoAccessUnit(idr.data(), idr.size());
	run([&] { return atCaller.size() > afterOverflow; }, 3000);
	settle(50);
	CHECK(!atCaller.empty() && atCaller.back() == idr, "after the overflow the next IDR arrives");
	for (size_t i = afterOverflow; i < atCaller.size(); i++)
		CHECK(atCaller[i] != p2, "the P frame before the IDR was skipped");

	// PLI from the receiver, at most once a second.
	g_usleep(1100 * 1000);
	const int k0 = calleeKeyframes;
	caller.requestPeerKeyframe();
	caller.requestPeerKeyframe();
	run([&] { return calleeKeyframes > k0; }, 2000);
	settle(200);
	CHECK(calleeKeyframes == k0 + 1, "two requests in a row make one PLI (%d)", calleeKeyframes - k0);

	// The caller turns its camera on mid-call.
	const int ck0 = callerKeyframes;
	caller.setVideoSending(true);
	caller.setVideoRotation(270);
	run([&] { return !calleeSawPeerVideo.empty(); }, 3000);
	CHECK(calleeSawPeerVideo.size() == 1 && calleeSawPeerVideo[0], "the callee saw the caller's video come on");
	run([&] { return caller.negotiatedCodecs().outgoingVideoPt >= 0; }, 3000);
	CHECK(callerKeyframes > ck0, "turning the camera on asks the encoder for an IDR");
	CHECK(!fromCaller.seen.empty() && fromCaller.seen.back().videoState == MediaStateMessage::VideoState::Active &&
	      fromCaller.seen.back().videoRotation == MediaStateMessage::VideoRotation::Rotation270,
	      "caller MediaState: active, 270");
	caller.postVideoAccessUnit(p1.data(), p1.size()); // before any IDR: not sent
	caller.postVideoAccessUnit(idr.data(), idr.size());
	run([&] { return !atCallee.empty(); }, 3000);
	CHECK(atCallee.size() == 1 && atCallee[0] == idr, "the callee got the caller's IDR (%zu)", atCallee.size());

	// And off again.
	caller.setVideoSending(false);
	run([&] { return calleeSawPeerVideo.size() >= 2; }, 3000);
	CHECK(calleeSawPeerVideo.size() == 2 && !calleeSawPeerVideo[1], "the callee saw the caller's video go off");
	CHECK(fromCaller.seen.back().videoState == MediaStateMessage::VideoState::Inactive, "caller MediaState: inactive");
	CHECK(caller.negotiatedCodecs().outgoingVideoPt == -1, "no video negotiated for the caller now");
	const size_t n = atCallee.size();
	caller.postVideoAccessUnit(idr.data(), idr.size());
	caller.sendVideoAccessUnit(idr.data(), idr.size());
	settle(200);
	CHECK(atCallee.size() == n, "nothing sent with the camera off");

	// On once more: a new stream the callee starts again from an IDR.
	caller.setVideoSending(true);
	run([&] { return calleeSawPeerVideo.size() >= 3 && caller.negotiatedCodecs().outgoingVideoPt >= 0; }, 3000);
	CHECK(calleeSawPeerVideo.size() == 3 && calleeSawPeerVideo[2], "on again");
	caller.postVideoAccessUnit(idr.data(), idr.size());
	run([&] { return atCallee.size() > n; }, 3000);
	CHECK(atCallee.size() == n + 1, "the new stream's IDR arrives");

	caller.logStats();
	callee.logStats();
	if (failures) {
		fprintf(stderr, "%d failure(s)\n", failures);
		return 1;
	}
	fprintf(stderr, "ALL OK -- video both ways over the full stack\n");
	return 0;
}
