// Phase 1c spike: round-trip the signaling JSON codec and exercise the ported AES-CTR crypto
// helper, cross-compiled and run under qemu-arm to catch build/link/runtime issues before wiring
// either into the real engine.
#include <cstdio>
#include <cstring>
#include <string>
#include "../signaling_message.h"
#include "../crypto_helper.h"
#include "../encrypted_connection.h"

using namespace tgcalls_lite;

static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { fprintf(stderr, "FAIL: %s\n", msg); failures++; } } while (0)

static void test_initial_setup() {
	SignalingMessage m;
	m.type = SignalingMessageType::InitialSetup;
	m.initialSetup.ufrag = "abcd1234";
	m.initialSetup.pwd = "supersecretpwd";
	m.initialSetup.supportsRenomination = true;
	DtlsFingerprint fp;
	fp.hash = "sha-256";
	fp.setup = "actpass";
	fp.fingerprint = "AA:BB:CC:DD";
	m.initialSetup.fingerprints.push_back(fp);

	auto bytes = signaling_message_serialize(m);
	fprintf(stderr, "InitialSetup JSON: %.*s\n", (int)bytes.size(), bytes.data());

	SignalingMessage parsed;
	CHECK(signaling_message_parse(bytes.data(), bytes.size(), &parsed), "parse InitialSetup");
	CHECK(parsed.type == SignalingMessageType::InitialSetup, "type InitialSetup");
	CHECK(parsed.initialSetup.ufrag == "abcd1234", "ufrag roundtrip");
	CHECK(parsed.initialSetup.pwd == "supersecretpwd", "pwd roundtrip");
	CHECK(parsed.initialSetup.supportsRenomination == true, "renomination roundtrip");
	CHECK(parsed.initialSetup.fingerprints.size() == 1, "fingerprints count");
	if (!parsed.initialSetup.fingerprints.empty()) {
		CHECK(parsed.initialSetup.fingerprints[0].fingerprint == "AA:BB:CC:DD", "fingerprint value");
	}
}

static void test_candidates() {
	SignalingMessage m;
	m.type = SignalingMessageType::Candidates;
	IceCandidate c1; c1.sdpString = "candidate:1 1 udp 12345 1.2.3.4 5000 typ host";
	IceCandidate c2; c2.sdpString = "candidate:2 1 udp 12346 1.2.3.4 5001 typ srflx";
	m.candidates.iceCandidates.push_back(c1);
	m.candidates.iceCandidates.push_back(c2);

	auto bytes = signaling_message_serialize(m);
	fprintf(stderr, "Candidates JSON: %.*s\n", (int)bytes.size(), bytes.data());

	SignalingMessage parsed;
	CHECK(signaling_message_parse(bytes.data(), bytes.size(), &parsed), "parse Candidates");
	CHECK(parsed.candidates.iceCandidates.size() == 2, "candidates count");
	if (parsed.candidates.iceCandidates.size() == 2) {
		CHECK(parsed.candidates.iceCandidates[0].sdpString == c1.sdpString, "candidate 0");
		CHECK(parsed.candidates.iceCandidates[1].sdpString == c2.sdpString, "candidate 1");
	}
}

static void test_negotiate_channels() {
	SignalingMessage m;
	m.type = SignalingMessageType::NegotiateChannels;
	m.negotiateChannels.exchangeId = 42;
	MediaContent video;
	video.type = MediaContent::Type::Video;
	video.ssrc = 123456789;
	PayloadType h264;
	h264.id = 100;
	h264.name = "H264";
	h264.clockrate = 90000;
	h264.parameters.push_back({"profile-level-id", "42e01f"});
	FeedbackType nack; nack.type = "nack"; nack.subtype = "";
	h264.feedbackTypes.push_back(nack);
	video.payloadTypes.push_back(h264);
	m.negotiateChannels.contents.push_back(video);

	auto bytes = signaling_message_serialize(m);
	fprintf(stderr, "NegotiateChannels JSON: %.*s\n", (int)bytes.size(), bytes.data());

	SignalingMessage parsed;
	CHECK(signaling_message_parse(bytes.data(), bytes.size(), &parsed), "parse NegotiateChannels");
	CHECK(parsed.negotiateChannels.exchangeId == 42, "exchangeId roundtrip");
	CHECK(parsed.negotiateChannels.contents.size() == 1, "contents count");
	if (!parsed.negotiateChannels.contents.empty()) {
		const auto &c = parsed.negotiateChannels.contents[0];
		CHECK(c.type == MediaContent::Type::Video, "content type video");
		CHECK(c.ssrc == 123456789, "ssrc roundtrip");
		CHECK(c.payloadTypes.size() == 1, "payloadTypes count");
		if (!c.payloadTypes.empty()) {
			CHECK(c.payloadTypes[0].name == "H264", "payload name");
			CHECK(c.payloadTypes[0].clockrate == 90000, "clockrate");
			CHECK(c.payloadTypes[0].parameters.size() == 1, "parameters count");
		}
	}
}

static void test_media_state() {
	SignalingMessage m;
	m.type = SignalingMessageType::MediaState;
	m.mediaState.isMuted = true;
	m.mediaState.videoState = MediaStateMessage::VideoState::Active;
	m.mediaState.videoRotation = MediaStateMessage::VideoRotation::Rotation90;

	auto bytes = signaling_message_serialize(m);
	fprintf(stderr, "MediaState JSON: %.*s\n", (int)bytes.size(), bytes.data());

	SignalingMessage parsed;
	CHECK(signaling_message_parse(bytes.data(), bytes.size(), &parsed), "parse MediaState");
	CHECK(parsed.mediaState.isMuted == true, "isMuted roundtrip");
	CHECK(parsed.mediaState.videoState == MediaStateMessage::VideoState::Active, "videoState roundtrip");
	CHECK(parsed.mediaState.videoRotation == MediaStateMessage::VideoRotation::Rotation90, "videoRotation roundtrip");
}

static void test_crypto_roundtrip() {
	uint8_t key[256];
	for (int i = 0; i < 256; i++) key[i] = (uint8_t)(i * 7 + 3);
	uint8_t msgKey[16];
	for (int i = 0; i < 16; i++) msgKey[i] = (uint8_t)(i * 13 + 1);

	const char *plaintext = "the quick brown fox jumps over the lazy dog, 1234567890";
	size_t len = strlen(plaintext);
	std::vector<uint8_t> ciphertext(len), decrypted(len);

	AesKeyIv keyIv1;
	CHECK(prepare_aes_key_iv(key, msgKey, 0, keyIv1), "key/IV derivation succeeds");
	CHECK(aes_process_ctr((const uint8_t *)plaintext, len, ciphertext.data(), keyIv1), "AES-CTR succeeds");

	CHECK(memcmp(ciphertext.data(), plaintext, len) != 0, "ciphertext differs from plaintext");

	AesKeyIv keyIv2;
	CHECK(prepare_aes_key_iv(key, msgKey, 0, keyIv2), "key/IV derivation succeeds");
	CHECK(aes_process_ctr(ciphertext.data(), len, decrypted.data(), keyIv2), "AES-CTR succeeds");

	CHECK(memcmp(decrypted.data(), plaintext, len) == 0, "AES-CTR roundtrip recovers plaintext");
	fprintf(stderr, "crypto roundtrip: %s\n", memcmp(decrypted.data(), plaintext, len) == 0 ? "OK" : "MISMATCH");
}

// Known answer, computed independently with Python's hashlib and cryptography (AES-256-CTR) from
// tgcalls' formula: the outgoing side's first packet, seq 1, key[i] = i * 3 + 11.
static void test_encrypted_connection_known_answer() {
	uint8_t key[256];
	for (int i = 0; i < 256; i++) key[i] = (uint8_t)(i * 3 + 11);
	static const uint8_t expected[] = {
		0x37,0x73,0xe6,0x25,0x0a,0x74,0x26,0x05,0x32,0xaa,0x6d,0x84,0xbc,0x01,0x67,0x3c,
		0xf9,0x4b,0x3c,0x69,0x3b,0xcc,0xb3,0x9d,0xd3,0xbe,0x43,0x74,0xe9,0xff,0xb8,0x56,
	};
	const char *text = "known answer";
	EncryptedConnection caller(key, true);
	auto ct = caller.encrypt(std::vector<uint8_t>(text, text + strlen(text)));
	CHECK(ct.size() == sizeof(expected) && memcmp(ct.data(), expected, sizeof(expected)) == 0,
	      "first outgoing packet matches the independent reference");
	EncryptedConnection callee(key, false);
	auto pt = callee.decrypt(std::vector<uint8_t>(expected, expected + sizeof(expected)));
	CHECK(pt && std::string(pt->begin(), pt->end()) == text, "reference packet decrypts");
}

static void test_encrypted_connection() {
	uint8_t key[256];
	for (int i = 0; i < 256; i++) key[i] = (uint8_t)(i * 3 + 11);

	// Caller side (isOutgoing=true) encrypts an InitialSetup message; callee side
	// (isOutgoing=false) must decrypt it, and vice versa -- proves the x-offset direction split
	// (encrypt x=(isOutgoing?0:8)+128, decrypt x=(isOutgoing?8:0)+128) is symmetric between peers.
	EncryptedConnection caller(key, /*isOutgoing=*/true);
	EncryptedConnection callee(key, /*isOutgoing=*/false);

	SignalingMessage m;
	m.type = SignalingMessageType::InitialSetup;
	m.initialSetup.ufrag = "caller-ufrag";
	m.initialSetup.pwd = "caller-pwd";
	auto plaintext = signaling_message_serialize(m);

	auto ciphertext = caller.encrypt(plaintext);
	CHECK(ciphertext.size() == 16 + 4 + plaintext.size(), "ciphertext size = msgKey + seq + plaintext");

	auto decrypted = callee.decrypt(ciphertext);
	CHECK(decrypted.has_value(), "callee decrypts caller's packet");
	if (decrypted) {
		CHECK(*decrypted == plaintext, "decrypted plaintext matches original");
		SignalingMessage parsed;
		CHECK(signaling_message_parse(decrypted->data(), decrypted->size(), &parsed), "parse decrypted JSON");
		CHECK(parsed.initialSetup.ufrag == "caller-ufrag", "ufrag survives full encrypt/decrypt round trip");
	}

	// Reverse direction: callee encrypts, caller decrypts.
	SignalingMessage m2;
	m2.type = SignalingMessageType::Candidates;
	IceCandidate c; c.sdpString = "candidate:1 1 udp 1 1.2.3.4 5000 typ host";
	m2.candidates.iceCandidates.push_back(c);
	auto plaintext2 = signaling_message_serialize(m2);
	auto ciphertext2 = callee.encrypt(plaintext2);
	auto decrypted2 = caller.decrypt(ciphertext2);
	CHECK(decrypted2.has_value(), "caller decrypts callee's packet");
	if (decrypted2) CHECK(*decrypted2 == plaintext2, "reverse direction plaintext matches");

	// Replay rejection: decrypting the exact same packet again must fail.
	auto replay = callee.decrypt(ciphertext);
	CHECK(!replay.has_value(), "replayed packet rejected");

	// Wrong key must fail integrity check, not silently return garbage. Flip a byte inside the
	// range this decrypt (x=128, isOutgoing=false) actually reads: PrepareAesKeyIv touches
	// key[128:164) and key[168:204), the msgKey integrity hash touches key[216:248) -- a
	// corruption outside all three ranges would be invisible to this specific derivation.
	uint8_t wrongKey[256];
	memcpy(wrongKey, key, 256);
	wrongKey[200] ^= 0xff;
	EncryptedConnection wrongCallee(wrongKey, /*isOutgoing=*/false);
	auto ciphertext3 = caller.encrypt(plaintext);
	auto wrongDecrypt = wrongCallee.decrypt(ciphertext3);
	CHECK(!wrongDecrypt.has_value(), "wrong key rejected by integrity check");
}

int main() {
	test_initial_setup();
	test_candidates();
	test_negotiate_channels();
	test_media_state();
	test_crypto_roundtrip();
	test_encrypted_connection_known_answer();
	test_encrypted_connection();

	if (failures == 0) {
		fprintf(stderr, "ALL OK\n");
		return 0;
	}
	fprintf(stderr, "%d FAILURES\n", failures);
	return 1;
}
