#include "crypto_helper.h"

#include <openssl/sha.h>
#include <openssl/aes.h>
#include <openssl/modes.h>
#include <cstring>
#include <climits>

namespace tgcalls_lite {

namespace {

std::array<uint8_t, SHA256_DIGEST_LENGTH> concat_sha256(const uint8_t *a, size_t a_len,
                                                          const uint8_t *b, size_t b_len) {
	std::array<uint8_t, SHA256_DIGEST_LENGTH> result;
	SHA256_CTX ctx;
	SHA256_Init(&ctx);
	SHA256_Update(&ctx, a, a_len);
	SHA256_Update(&ctx, b, b_len);
	SHA256_Final(result.data(), &ctx);
	return result;
}

} // namespace

AesKeyIv prepare_aes_key_iv(const uint8_t *key, const uint8_t *msgKey, int x) {
	AesKeyIv result;

	const auto sha256a = concat_sha256(msgKey, 16, key + x, 36);
	const auto sha256b = concat_sha256(key + 40 + x, 36, msgKey, 16);

	uint8_t *aesKey = result.key.data();
	uint8_t *aesIv = result.iv.data();
	memcpy(aesKey, sha256a.data(), 8);
	memcpy(aesKey + 8, sha256b.data() + 8, 16);
	memcpy(aesKey + 8 + 16, sha256a.data() + 24, 8);
	memcpy(aesIv, sha256b.data(), 4);
	memcpy(aesIv + 4, sha256a.data() + 8, 8);
	memcpy(aesIv + 4 + 8, sha256b.data() + 24, 4);

	return result;
}

void aes_process_ctr(const uint8_t *from, size_t len, uint8_t *to, AesKeyIv &&keyIv) {
	AES_KEY aes;
	AES_set_encrypt_key(keyIv.key.data(), (int)(keyIv.key.size() * CHAR_BIT), &aes);

	unsigned char ecountBuf[16] = {0};
	unsigned int offsetInBlock = 0;
	CRYPTO_ctr128_encrypt(from, to, len, &aes, keyIv.iv.data(), ecountBuf, &offsetInBlock,
	                       block128_f(AES_encrypt));
}

} // namespace tgcalls_lite
