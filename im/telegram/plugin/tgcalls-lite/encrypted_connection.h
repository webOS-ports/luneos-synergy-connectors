// Parts of this file are derived from TelegramMessenger/tgcalls (LGPL-3.0); see NOTICE.
// encrypted_connection.h — the signaling-channel packet encryption tgcalls' SignalingEncryption
// actually uses (EncryptedConnection::encryptRawPacket/decryptRawPacket -- confirmed by reading
// reference/tgcalls/tgcalls/v2/SignalingEncryption.cpp, which calls exactly these two, NOT the
// fuller ack/resend/multi-message machinery EncryptedConnection also offers for the V1 media
// transport path -- signaling doesn't need that, it's a much simpler scheme).
//
// Wire format (verified against reference/tgcalls/tgcalls/EncryptedConnection.cpp):
//   ciphertext = [16-byte msgKey][AES-256-CTR(seq(4 bytes, big-endian) || plaintext)]
//   msgKey     = SHA256(key[88+x : 88+x+32] || seq || plaintext)[8:24]   (first 16 of bytes 8..24)
//   x          = (isOutgoing ? 0 : 8) + 128        -- encrypting our own outgoing signaling data
//              = (isOutgoing ? 8 : 0) + 128        -- decrypting the peer's incoming signaling data
//   key        = the 256-byte call encryption key (TDLib's callStateReady.encryption_key_, the
//                same key libtgvoip's SetEncryptionKey already consumes today)
// seq is a plain incrementing counter on the sending side; the receiving side keeps a sliding
// window of the last 64 counters seen to reject replays/duplicates (see registerIncomingCounter
// in the reference source) -- ported verbatim below.
#ifndef TGCALLS_LITE_ENCRYPTED_CONNECTION_H
#define TGCALLS_LITE_ENCRYPTED_CONNECTION_H

#include <cstdint>
#include <vector>
#include <array>
#include <optional>

namespace tgcalls_lite {

class EncryptedConnection {
public:
	// Copies 256 bytes from key -- the caller does NOT need to keep its own buffer alive past this
	// call (an earlier revision took a non-owning pointer here, which would have been a real
	// use-after-free once wired to call.cpp's real callStateReady.encryption_key_, typically held
	// in a short-lived local buffer -- fixed before any real integration used it).
	EncryptedConnection(const uint8_t *key, bool isOutgoing);

	// Encrypts one signaling payload (typically one signaling_message_serialize() JSON blob) for
	// sending via td_api::sendCallSignalingData. Always succeeds for reasonable input sizes.
	std::vector<uint8_t> encrypt(const std::vector<uint8_t> &plaintext);

	// Decrypts one payload received via td_api::updateNewCallSignalingData. Returns nullopt on
	// any integrity failure, malformed/too-short input, or a replayed/duplicate/too-old counter.
	std::optional<std::vector<uint8_t>> decrypt(const std::vector<uint8_t> &ciphertext);

private:
	std::array<uint8_t, 256> _key;
	bool _isOutgoing;
	uint32_t _counter = 0;
	std::vector<uint32_t> _largestIncomingCounters; // sorted ascending, sliding window of 64
};

} // namespace tgcalls_lite

#endif
