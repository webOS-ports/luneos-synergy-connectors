// Phase 1d spike: two IceSession instances (controlling + controlled) on the SAME machine,
// exchanging credentials/candidates directly in-process (standing in for what would normally
// cross via signaling_message.h + encrypted_connection.h + TDLib's sendCallSignalingData), driven
// to a real ICE CONNECTED state over real loopback sockets, then a real nice_agent_send/recv round
// trip. Proves the ice_session.h wrapper's basic mechanics work before building DTLS-SRTP on top.
#include <cstdio>
#include <cstring>
#include <atomic>
#include "../ice_session.h"

using namespace tgcalls_lite;

static std::atomic<bool> g_a_connected{false};
static std::atomic<bool> g_b_connected{false};
static std::atomic<bool> g_a_gathered{false};
static std::atomic<bool> g_b_gathered{false};
static std::atomic<bool> g_b_received{false};
static char g_b_recv_buf[256];
static size_t g_b_recv_len = 0;

int main() {
	GMainContext *ctx = g_main_context_default();

	IceSession a(ctx, /*controlling=*/true);
	IceSession b(ctx, /*controlling=*/false);

	a.onGatheringDone = [&]() { fprintf(stderr, "spike: A gathering done\n"); g_a_gathered = true; };
	b.onGatheringDone = [&]() { fprintf(stderr, "spike: B gathering done\n"); g_b_gathered = true; };
	a.onStateChanged = [&](IceConnectionState s) {
		fprintf(stderr, "spike: A state=%d\n", (int)s);
		if (s == IceConnectionState::Connected) g_a_connected = true;
	};
	b.onStateChanged = [&](IceConnectionState s) {
		fprintf(stderr, "spike: B state=%d\n", (int)s);
		if (s == IceConnectionState::Connected) g_b_connected = true;
	};
	b.onDataReceived = [&](const uint8_t *data, size_t len) {
		fprintf(stderr, "spike: B received %zu bytes: %.*s\n", len, (int)len, (const char *)data);
		memcpy(g_b_recv_buf, data, len);
		g_b_recv_len = len;
		g_b_received = true;
	};

	a.gatherCandidates();
	b.gatherCandidates();

	// Drive gathering to completion (local-only candidates on loopback -- should be fast, no STUN
	// server needed since both are on this same host).
	for (int i = 0; i < 2000 && !(g_a_gathered && g_b_gathered); i++) {
		g_main_context_iteration(ctx, TRUE);
	}
	if (!g_a_gathered || !g_b_gathered) {
		fprintf(stderr, "FAIL: gathering did not complete (a=%d b=%d)\n", (int)g_a_gathered, (int)g_b_gathered);
		return 1;
	}

	// Exchange credentials + candidates directly (this in-process hand-off is what
	// signaling_message.h + encrypted_connection.h + TDLib's sendCallSignalingData will do for a
	// real call).
	std::string aUfrag, aPwd, bUfrag, bPwd;
	a.getLocalCredentials(&aUfrag, &aPwd);
	b.getLocalCredentials(&bUfrag, &bPwd);
	fprintf(stderr, "spike: A ufrag=%s B ufrag=%s\n", aUfrag.c_str(), bUfrag.c_str());

	a.setRemoteCredentials(bUfrag, bPwd);
	b.setRemoteCredentials(aUfrag, aPwd);

	auto aCands = a.getLocalCandidateSdpStrings();
	auto bCands = b.getLocalCandidateSdpStrings();
	fprintf(stderr, "spike: A has %zu local candidates, B has %zu\n", aCands.size(), bCands.size());
	for (const auto &c : aCands) {
		fprintf(stderr, "spike: A cand: %s\n", c.c_str());
		if (!b.addRemoteCandidateSdp(c)) fprintf(stderr, "spike: B failed to parse A's candidate\n");
	}
	for (const auto &c : bCands) {
		fprintf(stderr, "spike: B cand: %s\n", c.c_str());
		if (!a.addRemoteCandidateSdp(c)) fprintf(stderr, "spike: A failed to parse B's candidate\n");
	}

	// Drive connectivity checks to completion.
	for (int i = 0; i < 5000 && !(g_a_connected && g_b_connected); i++) {
		g_main_context_iteration(ctx, TRUE);
	}
	if (!g_a_connected || !g_b_connected) {
		fprintf(stderr, "FAIL: ICE did not connect (a=%d b=%d)\n", (int)g_a_connected, (int)g_b_connected);
		return 1;
	}
	fprintf(stderr, "spike: ICE CONNECTED both sides\n");

	const char *msg = "hello over ICE";
	int sent = a.send((const uint8_t *)msg, strlen(msg));
	fprintf(stderr, "spike: A sent %d bytes\n", sent);

	for (int i = 0; i < 2000 && !g_b_received; i++) {
		g_main_context_iteration(ctx, TRUE);
	}
	if (!g_b_received) {
		fprintf(stderr, "FAIL: B never received A's message\n");
		return 1;
	}
	if (g_b_recv_len != strlen(msg) || memcmp(g_b_recv_buf, msg, g_b_recv_len) != 0) {
		fprintf(stderr, "FAIL: B's received data does not match\n");
		return 1;
	}

	fprintf(stderr, "ALL OK\n");
	return 0;
}
