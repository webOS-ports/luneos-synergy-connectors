// Parts of this file are derived from TelegramMessenger/tgcalls (LGPL-3.0); see NOTICE.
#include "crypto_helper.h"

#include <openssl/evp.h>
#include <cstring>
#include <memory>

namespace tgcalls_lite {

namespace {

struct MdCtxFree {
	void operator()(EVP_MD_CTX *ctx) const { EVP_MD_CTX_free(ctx); }
};
struct CipherCtxFree {
	void operator()(EVP_CIPHER_CTX *ctx) const { EVP_CIPHER_CTX_free(ctx); }
};

} // namespace

bool concat_sha256(const uint8_t *a, size_t a_len, const uint8_t *b, size_t b_len,
                   std::array<uint8_t, 32> &out) {
	std::unique_ptr<EVP_MD_CTX, MdCtxFree> ctx(EVP_MD_CTX_new());
	unsigned int len = 0;
	return ctx
		&& EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) == 1
		&& EVP_DigestUpdate(ctx.get(), a, a_len) == 1
		&& EVP_DigestUpdate(ctx.get(), b, b_len) == 1
		&& EVP_DigestFinal_ex(ctx.get(), out.data(), &len) == 1
		&& len == out.size();
}

bool prepare_aes_key_iv(const uint8_t *key, const uint8_t *msgKey, int x, AesKeyIv &result) {
	std::array<uint8_t, 32> sha256a, sha256b;
	if (!concat_sha256(msgKey, 16, key + x, 36, sha256a)
	    || !concat_sha256(key + 40 + x, 36, msgKey, 16, sha256b))
		return false;

	uint8_t *aesKey = result.key.data();
	uint8_t *aesIv = result.iv.data();
	memcpy(aesKey, sha256a.data(), 8);
	memcpy(aesKey + 8, sha256b.data() + 8, 16);
	memcpy(aesKey + 8 + 16, sha256a.data() + 24, 8);
	memcpy(aesIv, sha256b.data(), 4);
	memcpy(aesIv + 4, sha256a.data() + 8, 8);
	memcpy(aesIv + 4 + 8, sha256b.data() + 24, 4);

	return true;
}

bool aes_process_ctr(const uint8_t *from, size_t len, uint8_t *to, const AesKeyIv &keyIv) {
	// AES-256-CTR with the whole 16-byte IV as a big-endian counter, as tgcalls'
	// CRYPTO_ctr128_encrypt call does.
	std::unique_ptr<EVP_CIPHER_CTX, CipherCtxFree> ctx(EVP_CIPHER_CTX_new());
	if (!ctx || EVP_EncryptInit_ex(ctx.get(), EVP_aes_256_ctr(), nullptr, keyIv.key.data(),
	                               keyIv.iv.data()) != 1)
		return false;
	while (len > 0) {
		const int chunk = len > (1u << 30) ? (1 << 30) : (int)len;
		int outLen = 0;
		if (EVP_EncryptUpdate(ctx.get(), to, &outLen, from, chunk) != 1 || outLen != chunk)
			return false;
		from += chunk;
		to += chunk;
		len -= (size_t)chunk;
	}
	return true;
}

} // namespace tgcalls_lite
