#include "video_rtcp.h"

namespace tgcalls_lite {

namespace {

constexpr uint8_t kPtPsfb = 206; // payload-specific feedback (RFC 4585)
constexpr uint8_t kFmtPli = 1;
constexpr uint8_t kFmtFir = 4;   // RFC 5104

void put32(uint8_t *p, uint32_t v) {
	p[0] = (uint8_t)(v >> 24);
	p[1] = (uint8_t)(v >> 16);
	p[2] = (uint8_t)(v >> 8);
	p[3] = (uint8_t)v;
}

uint32_t get32(const uint8_t *p) {
	return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

} // namespace

void rtcp_build_pli(uint8_t out[kRtcpPliSize], uint32_t senderSsrc, uint32_t mediaSsrc) {
	out[0] = 0x80 | kFmtPli; // V=2, P=0, FMT=1
	out[1] = kPtPsfb;
	out[2] = 0;
	out[3] = 2;              // length in 32-bit words minus one
	put32(out + 4, senderSsrc);
	put32(out + 8, mediaSsrc);
}

bool rtcp_requests_keyframe(const uint8_t *data, size_t len, uint32_t mediaSsrc) {
	if (!data) return false;
	size_t off = 0;
	while (off + 4 <= len) {
		const uint8_t *p = data + off;
		if ((p[0] >> 6) != 2) return false;
		const size_t size = 4 * ((((size_t)p[2] << 8) | p[3]) + 1);
		if (size > len - off) return false;
		const uint8_t fmt = p[0] & 0x1f;
		if (p[1] == kPtPsfb && size >= 12) {
			if (fmt == kFmtPli && get32(p + 8) == mediaSsrc) return true;
			if (fmt == kFmtFir) {
				// FCI entries of 8 bytes: SSRC, sequence number, reserved.
				for (size_t e = 12; e + 8 <= size; e += 8)
					if (get32(p + e) == mediaSsrc) return true;
			}
		}
		off += size;
	}
	return false;
}

} // namespace tgcalls_lite
