// h264_rtp.h — minimal RFC 6184 (H.264 over RTP) depacketizer/packetizer.
//
// Pure byte-buffer logic, no sockets, no SkypeKit dependency — used by glue/voipkit.cpp to
// convert between mediaserver's local SkypeKit RTP packets and meowcaller's Annex-B access
// units (see messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md Part 18 for the RTP framing
// this was reverse-engineered against, and the plan this implements).
//
// Handles single-NAL-unit packets (RFC 6184 §5.6), STAP-A aggregation (§5.7.1), and FU-A
// fragmentation (§5.8) — the three packetization modes any ordinary H.264 RTP sender/receiver
// needs. STAP-B/MTAP/FU-B (rarely used, interleaved-only) are not implemented.
#ifndef H264_RTP_H
#define H264_RTP_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Accumulates RTP payloads (H.264 payload only, no RTP header) into Annex-B access units.
// One instance per direction/stream; not thread-safe (caller serializes calls per stream).
typedef struct {
	unsigned char *buf;
	size_t len;
	size_t cap;
	int fu_active; // currently mid-way through reassembling an FU-A fragmented NAL
} h264_depacketizer;

void h264_depacketizer_init(h264_depacketizer *d);
void h264_depacketizer_free(h264_depacketizer *d);

// Feed one RTP payload + its marker bit. Returns 1 if this call completed an access unit
// (marker bit set and at least one whole NAL was accumulated): *out_data/*out_len point at
// the completed Annex-B access unit, valid only until the next h264_depacketizer_feed call on
// this same instance — the caller must consume it (e.g. hand it to Go) before calling again.
// Returns 0 if still accumulating (no output this call) or the packet was malformed/dropped.
int h264_depacketizer_feed(h264_depacketizer *d, const unsigned char *payload, size_t len,
                            int marker, const unsigned char **out_data, size_t *out_len);

// Called once per resulting RTP payload when packetizing an access unit, in order. marker is
// set only on the very last packet of the very last NAL in the access unit.
typedef void (*h264_rtp_emit_fn)(void *ctx, const unsigned char *payload, size_t len, int marker);

// Splits one Annex-B access unit (as delivered by meowcaller's VideoSink) into a sequence of
// RTP payloads, fragmenting any NAL larger than mtu bytes into FU-A fragments. Calls emit once
// per resulting packet. Never allocates — emit's payload buffer is stack/caller-owned per call.
void h264_packetize(const unsigned char *access_unit, size_t len, size_t mtu,
                     h264_rtp_emit_fn emit, void *ctx);

#ifdef __cplusplus
}
#endif

#endif
