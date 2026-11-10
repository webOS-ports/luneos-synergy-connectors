/*
 * signal_video.h - byte-level helpers for the video half of a 1:1 Signal call: RTP headers and
 * their one-byte extensions (the video orientation, CVO), RTCP keyframe requests, and RingRTC's
 * rtp-data messages. No GStreamer and no GLib, so they can be tested on their own
 * (tests/test_signal_video.c).
 *
 * What RingRTC puts on the wire (signalapp/ringrtc v2.73.0 and its webrtc tag 8037a,
 * ringrtc/rffi/src/peer_connection.cc Rust_sessionDescriptionFromV4Legacy, constants.h):
 *   - VP8 on payload type 108, its RTX on 118; Opus on 102; rtp-data on 101 with SSRC 0xD.
 *   - Fixed SSRCs: the caller sends audio 1002 and video 1003, the callee 2002 and 2003.
 *   - Header extensions: transport-cc id 1, video orientation (urn:3gpp:video-orientation) id 4,
 *     abs-send-time id 12. With the orientation extension negotiated, WebRTC sends frames as the
 *     camera took them and the rotation beside them.
 */
#ifndef SIGNAL_VIDEO_H
#define SIGNAL_VIDEO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SV_PT_OPUS       102
#define SV_PT_DATA       101
#define SV_PT_VP8        108
#define SV_PT_VP8_RTX    118
#define SV_PT_RED        120     /* RFC 2198 RED around VP8 or ULPFEC (RingRTC constants.h RED_PT) */
#define SV_PT_ULPFEC     122
#define SV_EXT_CVO       4
#define SV_EXT_TCC       1       /* transport-wide sequence number (RingRTC TRANSPORT_CC1_EXT_ID) */
#define SV_TCC_WINDOW    512     /* packets one feedback can cover */
#define SV_SSRC_DATA     0x0000000Du
#define SV_VIDEO_CLOCK   90000

/* Our video SSRC: the caller's side is 1003, the callee's 2003. */
uint32_t sv_video_ssrc(int is_caller);
/* The far side's video SSRC. */
uint32_t sv_peer_video_ssrc(int is_caller);

typedef struct {
    uint8_t  pt;
    int      marker;
    uint16_t seq;
    uint32_t ts;
    uint32_t ssrc;
    size_t   header_len;     /* fixed header + CSRCs + extension block: where the payload starts */
    size_t   ext_off;        /* the extension block's data (after its 4-byte header), 0 if none */
    size_t   ext_len;        /* its length in bytes */
    uint16_t ext_profile;    /* 0xBEDE one-byte, 0x100x two-byte, 0 if none */
} SvRtp;

/* Parse an RTP header (version 2). Returns 0, or -1 when p is not a whole RTP header. Padding is
 * not checked: the payload is not looked at. */
int sv_rtp_parse(const uint8_t *p, size_t n, SvRtp *out);

/* Find header extension element `id` in a parsed packet (one-byte or two-byte form). On success
 * returns 0 and points *data and *len at its bytes in p. -1 if there is none. */
int sv_rtp_find_ext(const uint8_t *p, size_t n, const SvRtp *rtp, unsigned id,
                    const uint8_t **data, size_t *len);

/* Copy RTP packet in[0..n) to out with the one-byte extension element id/data (1..16 bytes) added:
 * appended to an existing one-byte extension block, or a new block when the packet has none.
 * Returns the new length, or 0 when the packet is not RTP, already has a two-byte block, the
 * element does not fit the one-byte form, or out (cap bytes) is too small. in and out may not
 * overlap. */
size_t sv_rtp_add_ext(const uint8_t *in, size_t n, unsigned id, const uint8_t *data, size_t dlen,
                      uint8_t *out, size_t cap);

/* Copy RED packet in[0..n) (RFC 2198) to out as the packet of its primary block: the same RTP
 * header and extensions with the primary block's payload type, followed by that block's payload,
 * without the redundant blocks and without RTP padding (the P bit is cleared). WebRTC sends its
 * video, and its ULPFEC, this way. Returns the new length and puts the inner payload type in
 * *inner_pt, or 0 when in is not RTP, the RED headers are malformed or out (cap bytes) is too
 * small. in and out may not overlap. */
size_t sv_red_unwrap(const uint8_t *in, size_t n, uint8_t *out, size_t cap, uint8_t *inner_pt);

/* Transport-wide congestion control feedback (draft-holmer-rmcat-transport-wide-cc-extensions-01,
 * RTCP RTPFB FMT 15). RingRTC negotiates transport-cc for video, and WebRTC's sender then sets its
 * bitrate from this feedback alone: without it the far side's video falls to a trickle. Record
 * each received packet's transport sequence number with its arrival time, then build a feedback
 * packet now and then (WebRTC sends one about every 100 ms). */
typedef struct {
    int64_t  base;                     /* unwrapped seq of arrival[0], -1 before the first packet */
    int64_t  highest;                  /* highest unwrapped seq seen, -1 before the first */
    int64_t  arrival[SV_TCC_WINDOW];   /* arrival times in microseconds, -1 not received */
    int      pending;                  /* packets recorded since the last feedback */
    uint8_t  fb_count;                 /* feedback packet count */
} SvTcc;

void   sv_tcc_init(SvTcc *t);
/* One received packet: its transport sequence number and arrival time (microseconds, any
 * monotonic clock). Packets older than what was already reported are ignored. */
void   sv_tcc_record(SvTcc *t, uint16_t seq, int64_t arrival_us);
/* The feedback for everything recorded since the last one, from sender_ssrc about media_ssrc,
 * into out (cap bytes). Returns its length (a multiple of 4), or 0 when there is nothing to
 * report or it does not fit. The recorded packets are then forgotten. */
size_t sv_tcc_build(SvTcc *t, uint32_t sender_ssrc, uint32_t media_ssrc, uint8_t *out, size_t cap);

/* 1 if the VP8 RTP payload p (RFC 7741: payload descriptor, then the VP8 payload header) starts a
 * keyframe: S set, partition 0, and the payload header's inverse keyframe bit clear. */
int sv_vp8_is_keyframe_start(const uint8_t *p, size_t n);

/* The CVO byte |0 0 0 0 C F R1 R0|: R1R0 is how far the picture has to be turned CLOCKWISE, in
 * quarter turns, to be upright (webrtc rtp_cvo.h, VideoRotation "enum for clockwise rotation").
 * The Phone app's incomingVideoOrientation turns the picture back by its value COUNTER-clockwise
 * (RemoteVideo.qml rotation: -90 * quarterTurns), so the two are each other's complement. */
int     sv_cvo_to_phone_quarter_turns(uint8_t cvo);

/* The clockwise quarter turns our CVO byte says, for the front camera's own turn (sensor) with
 * the phone held device_turns round (the shell's quarter turns: 1 = left edge up): one fewer for
 * each, as teams_media turns the same viewfinder (checked on calls to Android, sargo 10 Nov 2026:
 * one more for each came out half a turn off at a quarter turn). */
int     sv_tx_quarter_turns(int camera_turns, int device_turns);

/* The loudest sample of n bytes of S16LE audio, 0..32767 (32768 counts as 32767); 0 for none. */
int     sv_s16_peak(const uint8_t *p, size_t n);
uint8_t sv_cvo_from_clockwise_quarter_turns(int quarter_turns);

/* 1 if the compound RTCP packet p asks `media_ssrc` for a keyframe (a PLI, PSFB FMT 1, naming
 * it, or a FIR, PSFB FMT 4, with an entry for it), 0 if not, -1 if p is not RTCP. */
int sv_rtcp_wants_keyframe(const uint8_t *p, size_t n, uint32_t media_ssrc);

/* A PLI from sender_ssrc about media_ssrc into out (12 bytes). Returns 12. */
size_t sv_rtcp_build_pli(uint32_t sender_ssrc, uint32_t media_ssrc, uint8_t out[12]);

/* RingRTC's rtp_data.Message, the parts a 1:1 call uses (protobuf/rtp_data.proto). */
typedef struct {
    int      has_accepted;
    uint64_t accepted_id;
    int      has_hangup;
    uint64_t hangup_id;
    uint32_t hangup_type;
    int      has_status;
    uint64_t status_id;
    int      video_enabled;  /* -1 not said, 0 off, 1 on */
    int      audio_enabled;  /* -1 not said, 0 off, 1 on */
    int      has_seqnum;
    uint64_t seqnum;
} SvDataMsg;

void sv_data_msg_init(SvDataMsg *m);
/* Serialize m into out (cap bytes); fields in field-number order, as prost writes them. Returns
 * the length, or 0 if it does not fit. */
size_t sv_data_msg_encode(const SvDataMsg *m, uint8_t *out, size_t cap);
/* Parse a message; unknown fields are skipped. Returns 0, or -1 on malformed input. */
int    sv_data_msg_decode(const uint8_t *p, size_t n, SvDataMsg *m);

#ifdef __cplusplus
}
#endif

#endif /* SIGNAL_VIDEO_H */
