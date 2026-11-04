// rtp_header.h — RFC 3550 header parsing: finds the payload behind the CSRC list, a header
// extension and padding, which a fixed 12-byte offset would get wrong.
#ifndef TGCALLS_LITE_RTP_HEADER_H
#define TGCALLS_LITE_RTP_HEADER_H

#include <cstddef>
#include <cstdint>

namespace tgcalls_lite {

struct RtpPacketInfo {
	uint8_t payloadType = 0;
	bool marker = false;
	uint16_t sequence = 0;
	uint32_t timestamp = 0;
	uint32_t ssrc = 0;
	size_t payloadOffset = 0;
	size_t payloadLength = 0;
};

// Returns false if `data` is not a well-formed RTP version 2 packet.
inline bool parse_rtp_header(const uint8_t *data, size_t len, RtpPacketInfo &out) {
	if (!data || len < 12 || (data[0] >> 6) != 2) return false;
	const bool padding = (data[0] & 0x20) != 0;
	const bool extension = (data[0] & 0x10) != 0;
	const size_t csrcCount = data[0] & 0x0f;
	size_t offset = 12 + 4 * csrcCount;
	if (offset > len) return false;
	if (extension) {
		if (offset + 4 > len) return false;
		const size_t words = ((size_t)data[offset + 2] << 8) | data[offset + 3];
		offset += 4 + 4 * words;
		if (offset > len) return false;
	}
	size_t end = len;
	if (padding) {
		const size_t pad = data[len - 1];
		if (pad == 0 || pad > end - offset) return false;
		end -= pad;
	}
	out.payloadType = data[1] & 0x7f;
	out.marker = (data[1] & 0x80) != 0;
	out.sequence = (uint16_t)(((unsigned)data[2] << 8) | data[3]);
	out.timestamp = ((uint32_t)data[4] << 24) | ((uint32_t)data[5] << 16) | ((uint32_t)data[6] << 8) | data[7];
	out.ssrc = ((uint32_t)data[8] << 24) | ((uint32_t)data[9] << 16) | ((uint32_t)data[10] << 8) | data[11];
	out.payloadOffset = offset;
	out.payloadLength = end - offset;
	return true;
}

} // namespace tgcalls_lite

#endif
