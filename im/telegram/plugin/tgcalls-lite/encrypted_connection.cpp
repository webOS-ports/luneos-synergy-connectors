// Parts of this file are derived from TelegramMessenger/tgcalls (LGPL-3.0); see NOTICE.
#include "encrypted_connection.h"
#include "crypto_helper.h"

#include <cstring>
#include <algorithm>

namespace tgcalls_lite {

namespace {

constexpr size_t kKeepIncomingCountersCount = 64;
constexpr size_t kMaxIncomingPacketSize = 128 * 1024;

void write_seq_be(uint8_t *out, uint32_t seq) {
	out[0] = (uint8_t)(seq >> 24);
	out[1] = (uint8_t)(seq >> 16);
	out[2] = (uint8_t)(seq >> 8);
	out[3] = (uint8_t)(seq);
}

uint32_t read_seq_be(const uint8_t *in) {
	return ((uint32_t)in[0] << 24) | ((uint32_t)in[1] << 16) | ((uint32_t)in[2] << 8) | (uint32_t)in[3];
}

bool const_time_is_different(const uint8_t *a, const uint8_t *b, size_t size) {
	volatile uint8_t different = 0;
	for (size_t i = 0; i < size; i++) different |= (a[i] != b[i]);
	return different != 0;
}

} // namespace

EncryptedConnection::EncryptedConnection(const uint8_t *key, bool isOutgoing)
	: _isOutgoing(isOutgoing) {
	memcpy(_key.data(), key, _key.size());
}

std::vector<uint8_t> EncryptedConnection::encrypt(const std::vector<uint8_t> &plaintext) {
	uint32_t seq = ++_counter;

	// buffer = seq(4, BE) || plaintext
	std::vector<uint8_t> buffer(4 + plaintext.size());
	write_seq_be(buffer.data(), seq);
	memcpy(buffer.data() + 4, plaintext.data(), plaintext.size());

	const int x = (_isOutgoing ? 0 : 8) + 128;

	std::array<uint8_t, 32> msgKeyLarge;
	if (!concat_sha256(_key.data() + 88 + x, 32, buffer.data(), buffer.size(), msgKeyLarge))
		return {};

	std::vector<uint8_t> result(16 + buffer.size());
	memcpy(result.data(), msgKeyLarge.data() + 8, 16);

	AesKeyIv aesKeyIv;
	if (!prepare_aes_key_iv(_key.data(), result.data(), x, aesKeyIv)
	    || !aes_process_ctr(buffer.data(), buffer.size(), result.data() + 16, aesKeyIv))
		return {};

	return result;
}

std::optional<std::vector<uint8_t>> EncryptedConnection::decrypt(const std::vector<uint8_t> &ciphertext) {
	if (ciphertext.size() < 21 || ciphertext.size() > kMaxIncomingPacketSize) {
		return std::nullopt;
	}

	const int x = (_isOutgoing ? 8 : 0) + 128;

	const uint8_t *msgKey = ciphertext.data();
	const uint8_t *encryptedData = msgKey + 16;
	size_t dataSize = ciphertext.size() - 16;

	AesKeyIv aesKeyIv;
	std::vector<uint8_t> decryptionBuffer(dataSize);
	std::array<uint8_t, 32> msgKeyLarge;
	if (!prepare_aes_key_iv(_key.data(), msgKey, x, aesKeyIv)
	    || !aes_process_ctr(encryptedData, dataSize, decryptionBuffer.data(), aesKeyIv)
	    || !concat_sha256(_key.data() + 88 + x, 32, decryptionBuffer.data(), decryptionBuffer.size(), msgKeyLarge))
		return std::nullopt;
	if (const_time_is_different(msgKeyLarge.data() + 8, msgKey, 16)) {
		return std::nullopt; // integrity check failed -- wrong key, corrupted, or not really tgcalls data
	}

	uint32_t incomingSeq = read_seq_be(decryptionBuffer.data());

	// Sliding window replay/duplicate/too-old rejection, ported from
	// EncryptedConnection::registerIncomingCounter.
	auto &list = _largestIncomingCounters;
	auto position = std::lower_bound(list.begin(), list.end(), incomingSeq);
	uint32_t largest = list.empty() ? 0 : list.back();
	if (position != list.end() && *position == incomingSeq) {
		return std::nullopt; // duplicate
	} else if (incomingSeq + kKeepIncomingCountersCount <= largest) {
		return std::nullopt; // too old
	}
	auto eraseTill = std::find_if(list.begin(), list.end(), [&](uint32_t counter) {
		return counter + kKeepIncomingCountersCount > incomingSeq;
	});
	auto positionIndex = (position - list.begin()) - (eraseTill - list.begin());
	list.erase(list.begin(), eraseTill);
	list.insert(list.begin() + positionIndex, incomingSeq);

	return std::vector<uint8_t>(decryptionBuffer.begin() + 4, decryptionBuffer.end());
}

} // namespace tgcalls_lite
