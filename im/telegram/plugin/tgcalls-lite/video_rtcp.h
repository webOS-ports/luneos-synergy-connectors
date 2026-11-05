// video_rtcp.h — the RTCP that video needs and tgcalls-lite speaks: keyframe requests.
//
// We send a Picture Loss Indication (RFC 4585 6.3.1) when the peer's stream broke and we need
// an IDR to decode again. We read PLI and Full Intra Request (RFC 5104 4.3.1) from the peer:
// either one asks our encoder for an IDR. The packets handled here are plain (already
// SRTCP-unprotected / not yet protected) RTCP; MediaSession does the SRTCP.
#ifndef TGCALLS_LITE_VIDEO_RTCP_H
#define TGCALLS_LITE_VIDEO_RTCP_H

#include <cstddef>
#include <cstdint>

namespace tgcalls_lite {

constexpr size_t kRtcpPliSize = 12;

// Writes a PLI from senderSsrc about mediaSsrc into out (kRtcpPliSize bytes).
void rtcp_build_pli(uint8_t out[kRtcpPliSize], uint32_t senderSsrc, uint32_t mediaSsrc);

// True if the (compound) RTCP packet holds a PLI about mediaSsrc, or a FIR with an entry for
// mediaSsrc. A malformed packet ends the walk; what came before it still counts.
bool rtcp_requests_keyframe(const uint8_t *data, size_t len, uint32_t mediaSsrc);

} // namespace tgcalls_lite

#endif
