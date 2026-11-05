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

// Writes an RTP header for payload type pt into pkt, with, when cvoId is 1..14, a one-byte
// header extension (RFC 8285) carrying the video orientation byte cvo under that id. Returns the
// header length: 12, or 20 with the extension. pkt must have room for 20 bytes.
inline size_t write_rtp_header(uint8_t *pkt, uint8_t pt, uint16_t seq, uint32_t ts, uint32_t ssrc, bool marker,
                               int cvoId = 0, uint8_t cvo = 0) {
	pkt[0] = 0x80;
	pkt[1] = (uint8_t)((marker ? 0x80 : 0) | (pt & 0x7f));
	pkt[2] = (uint8_t)(seq >> 8);
	pkt[3] = (uint8_t)seq;
	pkt[4] = (uint8_t)(ts >> 24);
	pkt[5] = (uint8_t)(ts >> 16);
	pkt[6] = (uint8_t)(ts >> 8);
	pkt[7] = (uint8_t)ts;
	pkt[8] = (uint8_t)(ssrc >> 24);
	pkt[9] = (uint8_t)(ssrc >> 16);
	pkt[10] = (uint8_t)(ssrc >> 8);
	pkt[11] = (uint8_t)ssrc;
	if (cvoId < 1 || cvoId > 14) return 12;
	pkt[0] |= 0x10;            // X: an extension follows
	pkt[12] = 0xbe;            // one-byte header profile
	pkt[13] = 0xde;
	pkt[14] = 0;
	pkt[15] = 1;               // one 32-bit word of elements
	pkt[16] = (uint8_t)(cvoId << 4); // id, length - 1 = 0
	pkt[17] = cvo;
	pkt[18] = 0;               // padding
	pkt[19] = 0;
	return 20;
}

// The one-byte header extension element with this id in an RTP packet, or -1 (no extension,
// another profile, or not there). Only 1-byte elements are returned.
inline int find_rtp_one_byte_extension(const uint8_t *data, size_t len, int id) {
	if (!data || len < 12 || !(data[0] & 0x10)) return -1;
	size_t off = 12 + 4 * (size_t)(data[0] & 0x0f);
	if (off + 4 > len || data[off] != 0xbe || data[off + 1] != 0xde) return -1;
	const size_t end = off + 4 + 4 * (((size_t)data[off + 2] << 8) | data[off + 3]);
	if (end > len) return -1;
	for (off += 4; off < end;) {
		const uint8_t b = data[off];
		if (b == 0) { off++; continue; } // padding
		const int elemId = b >> 4;
		const size_t elemLen = (size_t)(b & 0x0f) + 1;
		if (elemId == 15 || off + 1 + elemLen > end) return -1;
		if (elemId == id) return elemLen == 1 ? data[off + 1] : -1;
		off += 1 + elemLen;
	}
	return -1;
}

} // namespace tgcalls_lite

#endif
