/*
 * teams_video.h - byte-level helpers for the video half of a Teams call: RTP header fields, the
 * receive statistics an RTCP receiver report carries, and the RTCP packets teams_media sends
 * (receiver report, REMB, PLI) or reads (PLI, FIR). No GStreamer, so tests/test_teams_video.c
 * runs them on their own.
 *
 * What the Teams Android app offers for video (captured 2026-11-04, teams.live.com answering):
 * H264/90000 on PT 107 (packetization-mode=1, constrained baseline), rtx PT 99, rtcp-fb nack, nack
 * pli, goog-remb and transport-cc, and of the header extensions only abs-send-time. Without a
 * transport-wide sequence number extension the sender's bandwidth estimate has only what the
 * receiver reports: REMB and receiver reports.
 */
#ifndef TEAMS_VIDEO_H
#define TEAMS_VIDEO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TV_PT_H264      107
#define TV_PT_H264_RTX  99
#define TV_VIDEO_CLOCK  90000

typedef struct {
    uint8_t  pt;
    int      marker;
    uint16_t seq;
    uint32_t ts;
    uint32_t ssrc;
    size_t   header_len;     /* fixed header + CSRCs + extension block: where the payload starts */
} TvRtp;

/* 0 and *out filled if p[0..n) is an RTP packet (version 2, not RTCP by its second byte), -1 if
 * not. */
int tv_rtp_parse(const uint8_t *p, size_t n, TvRtp *out);

/* Receive statistics of one stream, RFC 3550 appendix A.1 and A.3. */
typedef struct {
    int      have;           /* a packet was seen */
    uint32_t ssrc;
    uint16_t max_seq;
    uint32_t cycles;         /* sequence number wraps, times 65536 */
    uint32_t base_seq;
    uint32_t received;
    uint32_t expected_prior, received_prior;   /* at the last report */
} TvRxStats;

/* Count a received packet of the stream (a new SSRC starts the statistics afresh). */
void tv_rx_stats_update(TvRxStats *s, uint32_t ssrc, uint16_t seq);

/* A receiver report from sender_ssrc with one block about the stream in s, into out (32 bytes),
 * and its interval counters moved on. lsr/dlsr: the middle 32 bits of the NTP time of the last
 * sender report received from that stream and the delay since, in 1/65536 s (0 if none). Returns
 * 32, or 0 if nothing was received yet. */
size_t tv_rtcp_build_rr(TvRxStats *s, uint32_t sender_ssrc, uint32_t lsr, uint32_t dlsr, uint8_t out[32]);

/* A REMB (PSFB FMT 15, draft-alvestrand-rmcat-remb) from sender_ssrc saying media_ssrc may be sent
 * at up to bitrate_bps, into out (24 bytes). Returns 24. */
size_t tv_rtcp_build_remb(uint32_t sender_ssrc, uint32_t media_ssrc, uint64_t bitrate_bps, uint8_t out[24]);

/* A PLI (PSFB FMT 1) from sender_ssrc about media_ssrc into out (12 bytes). Returns 12. */
size_t tv_rtcp_build_pli(uint32_t sender_ssrc, uint32_t media_ssrc, uint8_t out[12]);

/* 1 if the compound RTCP packet p asks media_ssrc for a keyframe (a PLI naming it, or a FIR with an
 * entry for it), 0 if not, -1 if p is not RTCP. */
int tv_rtcp_wants_keyframe(const uint8_t *p, size_t n, uint32_t media_ssrc);

/* The middle 32 bits of the NTP timestamp of the first sender report in p from ssrc (any SSRC if
 * ssrc is 0) into *ntp_mid: 1 if there is one, 0 if not, -1 if p is not RTCP. */
int tv_rtcp_find_sr(const uint8_t *p, size_t n, uint32_t ssrc, uint32_t *ntp_mid);

/* Whether to ask the far side for a keyframe now: packets are arriving (the last one less than a
 * second ago) but nothing was decoded for a second, counting from the first packet if nothing
 * was ever decoded. All times in microseconds on one clock, 0 meaning never. */
int tv_keyframe_overdue(int64_t now, int64_t last_packet, int64_t first_packet, int64_t last_decoded);

/* The plugin's "VIDEO 0", "VIDEO 1" or "VIDEO 1 <width> <height> <kbit/s>" (the size and bitrate
 * our camera sends, from the far side's H264 fmtp limits). Returns 1 and fills *on (and *w, *h,
 * *kbps, 0 when not given) for a valid line, 0 otherwise. Sizes are even, 96..1920; 32..4000 kbit/s. */
int tv_parse_video_cmd(const char *line, int *on, unsigned *w, unsigned *h, unsigned *kbps);

/* The plugin's "TURN <0..3>": how the phone is held, in the shell's quarter turns (0 top up,
 * 1 left edge up, 2 upside down, 3 right edge up). Returns 1 and fills *turns for a valid line. */
int tv_parse_turn_cmd(const char *line, int *turns);

/* Teams carries no rotation with the video (its SDP has no urn:3gpp:video-orientation): the far
 * side shows the picture as it comes. The videoflip direction that keeps our front camera's
 * picture upright with the phone held device_turns quarter turns round, on top of the turn that
 * makes it upright held upright. The front camera's picture is not mirrored, so it turns the
 * opposite way to the phone: one quarter turn counter-clockwise for each the phone is turned
 * (checked on a call to Android, sargo 10 Nov 2026: the other way round it came upside down). */
const char *tv_send_direction(int device_turns);

#ifdef __cplusplus
}
#endif

#endif
