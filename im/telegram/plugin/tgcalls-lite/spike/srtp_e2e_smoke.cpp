// Phase 1e spike: full chain -- two DtlsTransport instances handshake (as in
// dtls_loopback_smoke.cpp), export SRTP keying material, feed it into two SrtpSession instances
// (one per side, with client/server key assignment swapped correctly), and prove a real fake RTP
// packet protected on one side unprotects cleanly on the other -- the exact chain the real
// tgcalls-lite media path will use once IceSession delivers bytes.
#include <cstdio>
#include <cstring>
#include <vector>
#include "../dtls_transport.h"
#include "../srtp_session.h"

using namespace tgcalls_lite;

static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { fprintf(stderr, "FAIL: %s\n", msg); failures++; } } while (0)

static std::vector<uint8_t> concat_key_salt(const std::array<uint8_t, 16> &key, const std::array<uint8_t, 14> &salt) {
	std::vector<uint8_t> out(30);
	memcpy(out.data(), key.data(), 16);
	memcpy(out.data() + 16, salt.data(), 14);
	return out;
}

int main() {
	DtlsTransport client(/*isClient=*/true);
	DtlsTransport server(/*isClient=*/false);

	client.onOutgoingData = [&](const uint8_t *data, size_t len) { server.feedIncomingData(data, len); };
	server.onOutgoingData = [&](const uint8_t *data, size_t len) { client.feedIncomingData(data, len); };

	bool clientDone = false, serverDone = false;
	client.onHandshakeComplete = [&]() { clientDone = true; };
	server.onHandshakeComplete = [&]() { serverDone = true; };

	server.start();
	client.start();

	CHECK(clientDone && serverDone, "DTLS handshake completed both sides");
	if (!clientDone || !serverDone) {
		fprintf(stderr, "%d FAILURES\n", failures);
		return 1;
	}

	auto clientMat = client.exportSrtpKeys();
	auto serverMat = server.exportSrtpKeys();

	// Client is the DTLS client: its "send" direction is clientKey/clientSalt, its "recv"
	// direction is serverKey/serverSalt. Server is the mirror image.
	auto clientSendKey = concat_key_salt(clientMat.clientKey, clientMat.clientSalt);
	auto clientRecvKey = concat_key_salt(clientMat.serverKey, clientMat.serverSalt);
	auto serverSendKey = concat_key_salt(serverMat.serverKey, serverMat.serverSalt);
	auto serverRecvKey = concat_key_salt(serverMat.clientKey, serverMat.clientSalt);

	SrtpSession clientSrtp(clientSendKey.data(), clientRecvKey.data());
	SrtpSession serverSrtp(serverSendKey.data(), serverRecvKey.data());
	CHECK(clientSrtp.ok(), "client SRTP session created");
	CHECK(serverSrtp.ok(), "server SRTP session created");

	// A minimal, plausible-looking RTP packet: version 2, no padding/extension, PT=100 (dynamic,
	// matching the H.264 payload type used elsewhere in this codebase's voipkit.cpp), seq=1,
	// timestamp=12345, ssrc=0xAABBCCDD, then some fake payload bytes.
	uint8_t rtpBuf[12 + 20 + 200 /* generous headroom for SRTP auth tag/MKI */];
	memset(rtpBuf, 0, sizeof(rtpBuf));
	rtpBuf[0] = 0x80;
	rtpBuf[1] = 100;
	rtpBuf[2] = 0x00; rtpBuf[3] = 0x01; // seq=1
	rtpBuf[4] = 0x00; rtpBuf[5] = 0x00; rtpBuf[6] = 0x30; rtpBuf[7] = 0x39; // ts=12345
	rtpBuf[8] = 0xAA; rtpBuf[9] = 0xBB; rtpBuf[10] = 0xCC; rtpBuf[11] = 0xDD; // ssrc
	for (int i = 0; i < 20; i++) rtpBuf[12 + i] = (uint8_t)(i * 5 + 1); // fake payload
	int rtpLen = 12 + 20;
	int originalLen = rtpLen;

	CHECK(clientSrtp.protectRtp(rtpBuf, &rtpLen), "client protects RTP packet");
	CHECK(rtpLen > originalLen, "protected packet grew (auth tag appended)");

	// Server decrypts using ITS recv key, which is client's send key (same master secret, same
	// direction) -- must recover the exact original bytes.
	int decryptLen = rtpLen;
	CHECK(serverSrtp.unprotectRtp(rtpBuf, &decryptLen), "server unprotects client's RTP packet");
	CHECK(decryptLen == originalLen, "unprotected length matches original");
	bool payloadOk = true;
	for (int i = 0; i < 20; i++) if (rtpBuf[12 + i] != (uint8_t)(i * 5 + 1)) payloadOk = false;
	CHECK(payloadOk, "unprotected RTP payload matches original bytes");

	// Reverse direction + RTCP: server sends an RTCP packet, client receives it.
	uint8_t rtcpBuf[8 + 200 /* generous headroom for SRTP auth tag/MKI */ + 10];
	memset(rtcpBuf, 0, sizeof(rtcpBuf));
	rtcpBuf[0] = 0x80; rtcpBuf[1] = 200; // RTCP SR
	rtcpBuf[2] = 0x00; rtcpBuf[3] = 0x06;
	rtcpBuf[4] = 0xAA; rtcpBuf[5] = 0xBB; rtcpBuf[6] = 0xCC; rtcpBuf[7] = 0xDD;
	int rtcpLen = 8;
	int origRtcpLen = rtcpLen;
	CHECK(serverSrtp.protectRtcp(rtcpBuf, &rtcpLen), "server protects RTCP packet");
	int rtcpDecryptLen = rtcpLen;
	CHECK(clientSrtp.unprotectRtcp(rtcpBuf, &rtcpDecryptLen), "client unprotects server's RTCP packet");
	CHECK(rtcpDecryptLen == origRtcpLen, "unprotected RTCP length matches original");

	if (failures == 0) {
		fprintf(stderr, "ALL OK\n");
		return 0;
	}
	fprintf(stderr, "%d FAILURES\n", failures);
	return 1;
}
