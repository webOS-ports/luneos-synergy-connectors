/*
 * Unit tests for signal_video.c: RTP parsing, the orientation extension, RTCP keyframe requests
 * and RingRTC's rtp-data messages. Plain C, no framework:
 *   cc -I.. test_signal_video.c ../signal_video.c && ./a.out
 */
#include "signal_video.h"

#include <stdio.h>
#include <string.h>

static int failures;
#define CHECK(c) do { if (!(c)) { failures++; fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); } } while (0)

/* A 12-byte header: V=2, the given PT/marker, seq 0x1234, ts 0x01020304, ssrc. */
static size_t rtp_header(uint8_t *p, uint8_t pt, int marker, uint32_t ssrc)
{
    p[0] = 0x80; p[1] = (uint8_t)(pt | (marker ? 0x80 : 0));
    p[2] = 0x12; p[3] = 0x34;
    p[4] = 1; p[5] = 2; p[6] = 3; p[7] = 4;
    p[8] = (uint8_t)(ssrc >> 24); p[9] = (uint8_t)(ssrc >> 16); p[10] = (uint8_t)(ssrc >> 8); p[11] = (uint8_t)ssrc;
    return 12;
}

static void test_ssrcs(void)
{
    CHECK(sv_video_ssrc(1) == 1003 && sv_video_ssrc(0) == 2003);
    CHECK(sv_peer_video_ssrc(1) == 2003 && sv_peer_video_ssrc(0) == 1003);
}

static void test_parse(void)
{
    uint8_t p[64];
    SvRtp r;
    size_t n = rtp_header(p, SV_PT_VP8, 1, 1003);
    memcpy(p + n, "\x90\xe0", 2);
    CHECK(sv_rtp_parse(p, n + 2, &r) == 0);
    CHECK(r.pt == 108 && r.marker && r.seq == 0x1234 && r.ts == 0x01020304 && r.ssrc == 1003);
    CHECK(r.header_len == 12 && r.ext_off == 0);

    CHECK(sv_rtp_parse(p, 11, &r) == -1);          /* short */
    p[0] = 0x40;
    CHECK(sv_rtp_parse(p, n, &r) == -1);           /* version 1 */
    p[0] = 0x82;                                   /* two CSRCs, not there */
    CHECK(sv_rtp_parse(p, 12, &r) == -1);
    CHECK(sv_rtp_parse(p, 20, &r) == 0 && r.header_len == 20);

    /* One-byte extension: id 4 len 1 = 0x03, then padding. */
    rtp_header(p, SV_PT_VP8, 0, 2003);
    p[0] |= 0x10;
    memcpy(p + 12, "\xbe\xde\x00\x01\x40\x03\x00\x00", 8);
    CHECK(sv_rtp_parse(p, 20, &r) == 0);
    CHECK(r.ext_profile == 0xBEDE && r.ext_off == 16 && r.ext_len == 4 && r.header_len == 20);
    CHECK(sv_rtp_parse(p, 19, &r) == -1);          /* extension runs past the end */
    CHECK(sv_rtp_parse(p, 15, &r) == -1);          /* extension header cut */
}

static void test_find_ext(void)
{
    uint8_t p[64];
    SvRtp r;
    const uint8_t *d = NULL;
    size_t dl = 0;
    rtp_header(p, SV_PT_VP8, 0, 2003);
    p[0] |= 0x10;
    /* id 1 (2 bytes), padding, id 4 (1 byte) */
    memcpy(p + 12, "\xbe\xde\x00\x02\x11\xaa\xbb\x00\x40\x01\x00\x00", 12);
    CHECK(sv_rtp_parse(p, 24, &r) == 0);
    CHECK(sv_rtp_find_ext(p, 24, &r, 4, &d, &dl) == 0 && dl == 1 && d[0] == 0x01);
    CHECK(sv_rtp_find_ext(p, 24, &r, 1, &d, &dl) == 0 && dl == 2 && d[0] == 0xaa && d[1] == 0xbb);
    CHECK(sv_rtp_find_ext(p, 24, &r, 12, &d, &dl) == -1);
    /* An element claiming more than the block holds. */
    p[16] = 0x1f;
    CHECK(sv_rtp_find_ext(p, 24, &r, 4, &d, &dl) == -1);
    /* id 15 stops the walk. */
    p[16] = 0xf0;
    CHECK(sv_rtp_find_ext(p, 24, &r, 4, &d, &dl) == -1);

    /* Two-byte form: profile 0x1000, id 4 len 1. */
    rtp_header(p, SV_PT_VP8, 0, 2003);
    p[0] |= 0x10;
    memcpy(p + 12, "\x10\x00\x00\x01\x04\x01\x02\x00", 8);
    CHECK(sv_rtp_parse(p, 20, &r) == 0);
    CHECK(sv_rtp_find_ext(p, 20, &r, 4, &d, &dl) == 0 && dl == 1 && d[0] == 0x02);

    /* No extension at all. */
    rtp_header(p, SV_PT_VP8, 0, 2003);
    CHECK(sv_rtp_parse(p, 12, &r) == 0 && sv_rtp_find_ext(p, 12, &r, 4, &d, &dl) == -1);
}

static void test_add_ext(void)
{
    uint8_t in[64], out[80];
    SvRtp r;
    const uint8_t *d = NULL;
    size_t dl = 0;
    uint8_t cvo = 1;

    /* No extension yet: a new block of one word. */
    size_t n = rtp_header(in, SV_PT_VP8, 1, 2003);
    memcpy(in + n, "PAYLOAD", 7);
    n += 7;
    size_t m = sv_rtp_add_ext(in, n, SV_EXT_CVO, &cvo, 1, out, sizeof out);
    CHECK(m == n + 8);
    CHECK(memcmp(out + 12, "\xbe\xde\x00\x01\x40\x01\x00\x00", 8) == 0);
    CHECK(memcmp(out + 20, "PAYLOAD", 7) == 0);
    CHECK(sv_rtp_parse(out, m, &r) == 0 && r.marker && r.pt == 108 && r.ssrc == 2003);
    CHECK(sv_rtp_find_ext(out, m, &r, SV_EXT_CVO, &d, &dl) == 0 && dl == 1 && d[0] == 1);

    /* An existing one-byte block keeps its elements and gets ours after them. */
    uint8_t in2[64];
    rtp_header(in2, SV_PT_VP8, 0, 2003);
    in2[0] |= 0x10;
    memcpy(in2 + 12, "\xbe\xde\x00\x01\x11\xaa\xbb\x00" "XY", 10);
    m = sv_rtp_add_ext(in2, 22, SV_EXT_CVO, &cvo, 1, out, sizeof out);
    CHECK(m == 12 + 4 + 8 + 2);
    CHECK(memcmp(out + 12, "\xbe\xde\x00\x02\x11\xaa\xbb\x40\x01\x00\x00\x00", 12) == 0);
    CHECK(memcmp(out + 24, "XY", 2) == 0);
    CHECK(sv_rtp_parse(out, m, &r) == 0);
    CHECK(sv_rtp_find_ext(out, m, &r, 1, &d, &dl) == 0 && dl == 2);
    CHECK(sv_rtp_find_ext(out, m, &r, SV_EXT_CVO, &d, &dl) == 0 && d[0] == 1);

    /* CSRCs are kept in front of the block. */
    uint8_t in3[64];
    rtp_header(in3, SV_PT_VP8, 0, 2003);
    in3[0] |= 1;
    memcpy(in3 + 12, "\x00\x00\x00\x07Z", 5);
    m = sv_rtp_add_ext(in3, 17, SV_EXT_CVO, &cvo, 1, out, sizeof out);
    CHECK(m == 25 && memcmp(out + 12, "\x00\x00\x00\x07\xbe\xde", 6) == 0 && out[24] == 'Z');
    CHECK(sv_rtp_parse(out, m, &r) == 0 && r.header_len == 24);

    /* Refusals: too small, two-byte block, bad id/length, not RTP. */
    CHECK(sv_rtp_add_ext(in, n, SV_EXT_CVO, &cvo, 1, out, n + 7) == 0);
    CHECK(sv_rtp_add_ext(in, n, SV_EXT_CVO, &cvo, 1, out, n + 8) == n + 8);
    uint8_t two[32];
    rtp_header(two, SV_PT_VP8, 0, 2003);
    two[0] |= 0x10;
    memcpy(two + 12, "\x10\x00\x00\x01\x04\x01\x02\x00", 8);
    CHECK(sv_rtp_add_ext(two, 20, SV_EXT_CVO, &cvo, 1, out, sizeof out) == 0);
    CHECK(sv_rtp_add_ext(in, n, 0, &cvo, 1, out, sizeof out) == 0);
    CHECK(sv_rtp_add_ext(in, n, 15, &cvo, 1, out, sizeof out) == 0);
    CHECK(sv_rtp_add_ext(in, n, 14, &cvo, 1, out, sizeof out) == n + 8);
    CHECK(sv_rtp_add_ext(in, n, SV_EXT_CVO, &cvo, 0, out, sizeof out) == 0);
    uint8_t big[17] = { 0 };
    CHECK(sv_rtp_add_ext(in, n, SV_EXT_CVO, big, 17, out, sizeof out) == 0);
    CHECK(sv_rtp_add_ext(in, n, SV_EXT_CVO, big, 16, out, sizeof out) == n + 4 + 20);
    CHECK(sv_rtp_add_ext(in, 11, SV_EXT_CVO, &cvo, 1, out, sizeof out) == 0);
}

static void test_cvo(void)
{
    /* CVO says turn clockwise; the Phone app turns counter-clockwise. */
    CHECK(sv_cvo_to_phone_quarter_turns(0) == 0);
    CHECK(sv_cvo_to_phone_quarter_turns(1) == 3);
    CHECK(sv_cvo_to_phone_quarter_turns(2) == 2);
    CHECK(sv_cvo_to_phone_quarter_turns(3) == 1);
    CHECK(sv_cvo_to_phone_quarter_turns(0x0d) == 3);   /* C and F bits ignored */
    CHECK(sv_cvo_from_clockwise_quarter_turns(1) == 1);
    CHECK(sv_cvo_from_clockwise_quarter_turns(5) == 1);
    CHECK(sv_cvo_from_clockwise_quarter_turns(3) == 3);
}

static void test_rtcp(void)
{
    uint8_t pli[12];
    CHECK(sv_rtcp_build_pli(2003, 1003, pli) == 12);
    CHECK(memcmp(pli, "\x81\xce\x00\x02\x00\x00\x07\xd3\x00\x00\x03\xeb", 12) == 0);
    CHECK(sv_rtcp_wants_keyframe(pli, 12, 1003) == 1);
    CHECK(sv_rtcp_wants_keyframe(pli, 12, 2003) == 0);

    /* Compound: an RR (no blocks), then the PLI. */
    uint8_t comp[20];
    memcpy(comp, "\x80\xc9\x00\x01\x00\x00\x03\xeb", 8);
    memcpy(comp + 8, pli, 12);
    CHECK(sv_rtcp_wants_keyframe(comp, 20, 1003) == 1);
    CHECK(sv_rtcp_wants_keyframe(comp, 19, 1003) == -1);   /* PLI cut short */
    CHECK(sv_rtcp_wants_keyframe(comp, 8, 1003) == 0);

    /* FIR naming 2003 in its second entry. */
    uint8_t fir[28];
    memcpy(fir, "\x84\xce\x00\x06\x00\x00\x03\xeb\x00\x00\x00\x00"
                "\x00\x00\x00\x05\x01\x00\x00\x00"
                "\x00\x00\x07\xd3\x02\x00\x00\x00", 28);
    CHECK(sv_rtcp_wants_keyframe(fir, 28, 2003) == 1);
    CHECK(sv_rtcp_wants_keyframe(fir, 28, 1003) == 0);

    /* NACK (RTPFB 205) is not a keyframe request; neither is REMB (PSFB FMT 15). */
    uint8_t nack[16];
    memcpy(nack, "\x81\xcd\x00\x03\x00\x00\x07\xd3\x00\x00\x03\xeb\x00\x01\x00\x00", 16);
    CHECK(sv_rtcp_wants_keyframe(nack, 16, 1003) == 0);
    uint8_t remb[12];
    memcpy(remb, pli, 12);
    remb[0] = 0x8f;
    CHECK(sv_rtcp_wants_keyframe(remb, 12, 1003) == 0);

    /* Not RTCP: an RTP packet's second byte. */
    uint8_t rtp[12];
    rtp_header(rtp, SV_PT_VP8, 0, 1003);
    CHECK(sv_rtcp_wants_keyframe(rtp, 12, 1003) == -1);
}

static void test_data_msg(void)
{
    SvDataMsg m, back;
    uint8_t buf[64];

    /* What the engine sent before video: accepted{id} and seqnum. */
    sv_data_msg_init(&m);
    m.has_accepted = 1; m.accepted_id = 5;
    m.has_seqnum = 1; m.seqnum = 1;
    size_t n = sv_data_msg_encode(&m, buf, sizeof buf);
    CHECK(n == 6 && memcmp(buf, "\x0a\x02\x08\x05\x20\x01", 6) == 0);

    /* Accepted, sender status with video on, seqnum: field order 1, 3, 4. */
    sv_data_msg_init(&m);
    m.has_accepted = 1; m.accepted_id = 300;
    m.has_status = 1; m.status_id = 300; m.video_enabled = 1;
    m.has_seqnum = 1; m.seqnum = 7;
    n = sv_data_msg_encode(&m, buf, sizeof buf);
    CHECK(n == 14);
    CHECK(memcmp(buf, "\x0a\x03\x08\xac\x02\x1a\x05\x08\xac\x02\x10\x01\x20\x07", 14) == 0);
    CHECK(sv_data_msg_decode(buf, n, &back) == 0);
    CHECK(back.has_accepted && back.accepted_id == 300);
    CHECK(back.has_status && back.status_id == 300 && back.video_enabled == 1 && back.audio_enabled == -1);
    CHECK(back.has_seqnum && back.seqnum == 7 && !back.has_hangup);

    /* Video off is said, not left out. */
    m.video_enabled = 0;
    n = sv_data_msg_encode(&m, buf, sizeof buf);
    CHECK(sv_data_msg_decode(buf, n, &back) == 0 && back.video_enabled == 0);

    /* Too small a buffer. */
    CHECK(sv_data_msg_encode(&m, buf, 5) == 0);
    CHECK(sv_data_msg_encode(&m, buf, n - 1) == 0);
    CHECK(sv_data_msg_encode(&m, buf, n) == n);

    /* A far side's message: hangup{id 9, type 2}, sender status audio off, an unknown fixed64
     * field 7 and an unknown receiverStatus 5. */
    static const uint8_t far[] = {
        0x12, 0x04, 0x08, 0x09, 0x10, 0x02,
        0x1a, 0x04, 0x08, 0x09, 0x20, 0x00,
        0x39, 1, 2, 3, 4, 5, 6, 7, 8,
        0x2a, 0x04, 0x08, 0x09, 0x10, 0x64,
        0x20, 0x2a,
    };
    CHECK(sv_data_msg_decode(far, sizeof far, &back) == 0);
    CHECK(back.has_hangup && back.hangup_id == 9 && back.hangup_type == 2);
    CHECK(back.has_status && back.audio_enabled == 0 && back.video_enabled == -1);
    CHECK(back.has_seqnum && back.seqnum == 42 && !back.has_accepted);

    /* Round trip of a hangup. */
    sv_data_msg_init(&m);
    m.has_hangup = 1; m.hangup_id = 1ull << 40; m.hangup_type = 3;
    n = sv_data_msg_encode(&m, buf, sizeof buf);
    CHECK(n > 0 && sv_data_msg_decode(buf, n, &back) == 0 && back.hangup_id == 1ull << 40 && back.hangup_type == 3);

    /* Malformed: cut inside a length, a bad wire type, a runaway varint, field 0. */
    CHECK(sv_data_msg_decode(far, 5, &back) == -1);
    static const uint8_t wt[] = { 0x0b, 0x00 };
    CHECK(sv_data_msg_decode(wt, sizeof wt, &back) == -1);
    static const uint8_t rv[] = { 0x20, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01 };
    CHECK(sv_data_msg_decode(rv, sizeof rv, &back) == -1);
    static const uint8_t f0[] = { 0x00, 0x01 };
    CHECK(sv_data_msg_decode(f0, sizeof f0, &back) == -1);
    static const uint8_t f32[] = { 0x3d, 1, 2, 3 };
    CHECK(sv_data_msg_decode(f32, sizeof f32, &back) == -1);
    static const uint8_t f64[] = { 0x39, 1, 2, 3, 4, 5, 6, 7 };
    CHECK(sv_data_msg_decode(f64, sizeof f64, &back) == -1);
    CHECK(sv_data_msg_decode(NULL, 0, &back) == 0 && !back.has_status);
}

int main(void)
{
    test_ssrcs();
    test_parse();
    test_find_ext();
    test_add_ext();
    test_cvo();
    test_rtcp();
    test_data_msg();
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("PASS test_signal_video\n");
    return 0;
}
