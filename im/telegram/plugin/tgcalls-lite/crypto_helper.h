// Parts of this file are derived from TelegramMessenger/tgcalls (LGPL-3.0); see NOTICE.
// crypto_helper.h — AES-CTR key/IV derivation for tgcalls' EncryptedConnection scheme, ported
// from reference/tgcalls/tgcalls/CryptoHelper.h/.cpp (TelegramMessenger/tgcalls). This is the
// same key/IV derivation formula as MTProto's own transport encryption (SHA256 over overlapping
// slices of the 256-byte auth key plus a 16-byte msg_key, at fixed offsets +x and +40+x
// distinguishing the two directions) -- standard OpenSSL primitives only, no custom asm/NEON, so
// this carries none of the alignment-trap risk that affected webrtc-audio-processing.
#ifndef TGCALLS_LITE_CRYPTO_HELPER_H
#define TGCALLS_LITE_CRYPTO_HELPER_H

#include <cstdint>
#include <array>
#include <cstddef>

namespace tgcalls_lite {

struct AesKeyIv {
	std::array<uint8_t, 32> key;
	std::array<uint8_t, 16> iv;
};

// key must point to a 256-byte call encryption key (TDLib's callStateReady.encryption_key_,
// already the same key libtgvoip's SetEncryptionKey consumes today -- see call.cpp:227).
// msgKey is a 16-byte value (see EncryptedConnection's own packet layout, not yet ported here).
// x is 0 or 8, selecting which of the two directions' derivation this is for (matches tgcalls'
// own PrepareAesKeyIv(key, msgKey, x) call sites -- outgoing vs incoming use the opposite x).
// Returns false if OpenSSL fails.
bool prepare_aes_key_iv(const uint8_t *key, const uint8_t *msgKey, int x, AesKeyIv &result);

// AES-256-CTR; writes to `to` (may equal `from` for in-place use). Returns false if OpenSSL fails.
bool aes_process_ctr(const uint8_t *from, size_t len, uint8_t *to, const AesKeyIv &keyIv);

// out = SHA-256(a || b). Returns false if OpenSSL fails.
bool concat_sha256(const uint8_t *a, size_t a_len, const uint8_t *b, size_t b_len,
                   std::array<uint8_t, 32> &out);

} // namespace tgcalls_lite

#endif
