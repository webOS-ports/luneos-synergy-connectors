// Phase 1d spike: two DtlsTransport instances (client + server) wired directly to each other's
// feedIncomingData/onOutgoingData in-process (standing in for what would normally cross over an
// IceSession's connected component), driven through a real DTLS handshake, fingerprint
// verification, and SRTP keying material export -- proves the OpenSSL DTLS-SRTP plumbing works
// before wiring it to a real IceSession.
#include <cstdio>
#include <cstring>
#include "../dtls_transport.h"

using namespace tgcalls_lite;

static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { fprintf(stderr, "FAIL: %s\n", msg); failures++; } } while (0)

int main() {
	DtlsTransport client(/*isClient=*/true);
	DtlsTransport server(/*isClient=*/false);

	client.onOutgoingData = [&](const uint8_t *data, size_t len) {
		fprintf(stderr, "spike: client->server %zu bytes\n", len);
		server.feedIncomingData(data, len);
	};
	server.onOutgoingData = [&](const uint8_t *data, size_t len) {
		fprintf(stderr, "spike: server->client %zu bytes\n", len);
		client.feedIncomingData(data, len);
	};

	bool clientDone = false, serverDone = false;
	client.onHandshakeComplete = [&]() { fprintf(stderr, "spike: client handshake complete\n"); clientDone = true; };
	server.onHandshakeComplete = [&]() { fprintf(stderr, "spike: server handshake complete\n"); serverDone = true; };
	client.onHandshakeFailed = [&](const std::string &e) { fprintf(stderr, "spike: client handshake FAILED: %s\n", e.c_str()); };
	server.onHandshakeFailed = [&](const std::string &e) { fprintf(stderr, "spike: server handshake FAILED: %s\n", e.c_str()); };

	std::string clientFp = client.getLocalFingerprint();
	std::string serverFp = server.getLocalFingerprint();
	fprintf(stderr, "spike: client fp=%s\n", clientFp.c_str());
	fprintf(stderr, "spike: server fp=%s\n", serverFp.c_str());
	CHECK(!clientFp.empty(), "client fingerprint non-empty");
	CHECK(!serverFp.empty(), "server fingerprint non-empty");
	CHECK(clientFp != serverFp, "client and server have different fingerprints (different certs)");

	// Server must be ready to receive before the client's ClientHello arrives.
	server.start();
	client.start();

	// The onOutgoingData chain above drives both sides re-entrantly as bytes flow, but DTLS
	// handshakes can need a nudge if a flight is dropped/reordered -- in this direct in-process
	// wiring nothing is ever dropped, so a few ticks should be more than enough as a safety net.
	for (int i = 0; i < 20 && !(clientDone && serverDone); i++) {
		client.tick();
		server.tick();
	}

	CHECK(clientDone, "client handshake completed");
	CHECK(serverDone, "server handshake completed");

	if (clientDone && serverDone) {
		CHECK(client.verifyPeerFingerprint(serverFp), "client verifies server's real fingerprint");
		CHECK(server.verifyPeerFingerprint(clientFp), "server verifies client's real fingerprint");
		CHECK(!client.verifyPeerFingerprint("00:11:22:33"), "client rejects a WRONG fingerprint");

		auto clientKeys = client.exportSrtpKeys();
		auto serverKeys = server.exportSrtpKeys();
		fprintf(stderr, "spike: negotiated SRTP profile: %s\n", clientKeys.profileName.c_str());
		CHECK(clientKeys.profileName == "SRTP_AES128_CM_SHA1_80", "negotiated expected SRTP profile");
		CHECK(clientKeys.profileName == serverKeys.profileName, "both sides agree on SRTP profile");
		CHECK(memcmp(clientKeys.clientKey.data(), serverKeys.clientKey.data(), 16) == 0,
		      "client/server derive IDENTICAL clientKey (same DTLS master secret, same exporter label)");
		CHECK(memcmp(clientKeys.serverKey.data(), serverKeys.serverKey.data(), 16) == 0,
		      "client/server derive IDENTICAL serverKey");
		CHECK(memcmp(clientKeys.clientSalt.data(), serverKeys.clientSalt.data(), 14) == 0,
		      "client/server derive IDENTICAL clientSalt");
		CHECK(memcmp(clientKeys.serverSalt.data(), serverKeys.serverSalt.data(), 14) == 0,
		      "client/server derive IDENTICAL serverSalt");
		CHECK(memcmp(clientKeys.clientKey.data(), clientKeys.serverKey.data(), 16) != 0,
		      "client and server keys are actually DIFFERENT from each other (two real directions)");
	}

	if (failures == 0) {
		fprintf(stderr, "ALL OK\n");
		return 0;
	}
	fprintf(stderr, "%d FAILURES\n", failures);
	return 1;
}
