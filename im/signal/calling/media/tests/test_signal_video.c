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

static void test_red(void)
{
    uint8_t in[64], out[64], pt = 0;
    SvRtp r;
    const uint8_t *d = NULL;
    size_t dl = 0;

    /* What WebRTC sends: RED with only the primary block (VP8), marker and CVO kept. */
    rtp_header(in, SV_PT_RED, 1, 1003);
    in[0] |= 0x10;
    memcpy(in + 12, "\xbe\xde\x00\x01\x40\x01\x00\x00", 8);
    in[20] = SV_PT_VP8;
    memcpy(in + 21, "VP8DATA", 7);
    size_t m = sv_red_unwrap(in, 28, out, sizeof out, &pt);
    CHECK(m == 27 && pt == SV_PT_VP8);
    CHECK(sv_rtp_parse(out, m, &r) == 0 && r.pt == SV_PT_VP8 && r.marker && r.ssrc == 1003 && r.seq == 0x1234);
    CHECK(memcmp(out + r.header_len, "VP8DATA", 7) == 0);
    CHECK(sv_rtp_find_ext(out, m, &r, SV_EXT_CVO, &d, &dl) == 0 && d[0] == 1);

    /* ULPFEC inside RED: reported, so the caller drops it. */
    rtp_header(in, SV_PT_RED, 0, 1003);
    in[12] = SV_PT_ULPFEC;
    memcpy(in + 13, "FEC", 3);
    CHECK(sv_red_unwrap(in, 16, out, sizeof out, &pt) == 15 && pt == SV_PT_ULPFEC && !(out[1] & 0x80));

    /* A redundant block (3 bytes) before the primary, and 2 bytes of RTP padding. */
    rtp_header(in, SV_PT_RED, 0, 1003);
    in[0] |= 0x20;
    memcpy(in + 12, "\xec\x00\x10\x03" "\x6c" "OLD" "NEW" "\x00\x02", 13);
    m = sv_red_unwrap(in, 25, out, sizeof out, &pt);
    CHECK(m == 15 && pt == SV_PT_VP8 && !(out[0] & 0x20) && memcmp(out + 12, "NEW", 3) == 0);

    /* Malformed: no primary header, a block longer than the packet, bad padding, short out. */
    rtp_header(in, SV_PT_RED, 0, 1003);
    CHECK(sv_red_unwrap(in, 12, out, sizeof out, &pt) == 0);
    memcpy(in + 12, "\xec\x00\x10\x09\x6c" "AB", 7);
    CHECK(sv_red_unwrap(in, 19, out, sizeof out, &pt) == 0);
    memcpy(in + 12, "\xec\x00\x10", 3);
    CHECK(sv_red_unwrap(in, 15, out, sizeof out, &pt) == 0);
    in[0] |= 0x20;
    memcpy(in + 12, "\x6c" "AB" "\x09", 4);
    CHECK(sv_red_unwrap(in, 16, out, sizeof out, &pt) == 0);
    in[15] = 0;
    CHECK(sv_red_unwrap(in, 16, out, sizeof out, &pt) == 0);
    in[0] &= (uint8_t)~0x20;
    CHECK(sv_red_unwrap(in, 16, out, 14, &pt) == 0);
    CHECK(sv_red_unwrap(in, 16, out, 15, &pt) == 15 && pt == SV_PT_VP8);
    CHECK(sv_red_unwrap(in, 11, out, sizeof out, &pt) == 0);
}

static void test_vp8_keyframe(void)
{
    /* No extension: S, partition 0, P bit clear = keyframe; set = delta frame. */
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x10\x00", 2) == 1);
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x10\x01", 2) == 0);
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x00\x00", 2) == 0);   /* not a start */
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x11\x00", 2) == 0);   /* partition 1 */
    /* WebRTC's form: X, I with a 15-bit picture id, then the payload header. */
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x90\x80\x81\x23\x00", 5) == 1);
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x90\x80\x81\x23\x01", 5) == 0);
    /* I with a 7-bit id, L and T/K. */
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x90\xf0\x05\x07\x20\x00", 6) == 1);
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x90\xf0\x05\x07\x20", 5) == 0);   /* cut */
    CHECK(sv_vp8_is_keyframe_start((const uint8_t *)"\x90\x80", 2) == 0);
    CHECK(sv_vp8_is_keyframe_start(NULL, 0) == 0);
}

static SvTcc tcc;   /* large: not on the stack */

static void test_tcc(void)
{
    uint8_t out[1400];
    sv_tcc_init(&tcc);
    CHECK(sv_tcc_build(&tcc, 2003, 1003, out, sizeof out) == 0);   /* nothing yet */

    /* 65534 received 1 ms after the reference time 2 (128 ms), 65535 lost, 0 (wrapped) 70 ms
     * later: a small delta, a gap, a large delta. */
    sv_tcc_record(&tcc, 65534, 129000);
    sv_tcc_record(&tcc, 0, 199000);
    size_t n = sv_tcc_build(&tcc, 2003, 1003, out, sizeof out);
    static const uint8_t want1[28] = {
        0x8f, 0xcd, 0x00, 0x06, 0x00, 0x00, 0x07, 0xd3, 0x00, 0x00, 0x03, 0xeb,
        0xff, 0xfe, 0x00, 0x03, 0x00, 0x00, 0x02, 0x00,
        0xd2, 0x00,                 /* status vector: small, not received, large */
        0x04, 0x01, 0x18, 0x00,     /* 4 x 250 us, 280 x 250 us, padding */
        0x00, 0x00,
    };
    CHECK(n == 28 && memcmp(out, want1, 26) == 0 && out[26] == 0 && out[27] == 0);
    CHECK(sv_tcc_build(&tcc, 2003, 1003, out, sizeof out) == 0);   /* all reported */

    /* A late 65535 was already reported lost: ignored. The next starts after the last. */
    sv_tcc_record(&tcc, 65535, 199500);
    CHECK(sv_tcc_build(&tcc, 2003, 1003, out, sizeof out) == 0);
    sv_tcc_record(&tcc, 1, 200000);
    n = sv_tcc_build(&tcc, 2003, 1003, out, sizeof out);
    CHECK(n == 24);
    CHECK(out[12] == 0x00 && out[13] == 0x01 && out[14] == 0 && out[15] == 1);
    CHECK(out[16] == 0 && out[17] == 0 && out[18] == 3 && out[19] == 1);   /* ref 192 ms, count 1 */
    CHECK(out[20] == 0xd0 && out[21] == 0x00 && out[22] == 32);

    /* Out of order: the second packet arrived 1 ms before the first, a negative delta. */
    sv_tcc_record(&tcc, 3, 299000);
    sv_tcc_record(&tcc, 2, 300000);
    n = sv_tcc_build(&tcc, 2003, 1003, out, sizeof out);
    CHECK(n == 28);
    CHECK(out[13] == 2 && out[15] == 2 && out[18] == 4 && out[19] == 2);
    CHECK(out[20] == 0xd8 && out[21] == 0x00);                 /* small, large */
    CHECK(out[22] == 176 && out[23] == 0xff && out[24] == 0xfc); /* 44 ms, -1 ms */

    /* More than a window without feedback: the oldest are dropped, the rest reported. */
    for (int i = 0; i < 600; i++)
        sv_tcc_record(&tcc, (uint16_t)(4 + i), 400000 + 1000 * i);
    n = sv_tcc_build(&tcc, 2003, 1003, out, sizeof out);
    CHECK(n > 0 && ((out[14] << 8) | out[15]) == SV_TCC_WINDOW);
    CHECK(((out[12] << 8) | out[13]) == 4 + 600 - SV_TCC_WINDOW);
    CHECK((size_t)((out[2] << 8) | out[3]) == n / 4 - 1);
    CHECK(sv_tcc_build(&tcc, 2003, 1003, out, sizeof out) == 0);

    /* Too small a buffer: nothing built, nothing forgotten. */
    sv_tcc_record(&tcc, 604, 900000);
    CHECK(sv_tcc_build(&tcc, 2003, 1003, out, 23) == 0);
    CHECK(sv_tcc_build(&tcc, 2003, 1003, out, sizeof out) == 24);
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

static void test_tx_turns(void)
{
    /* sargo's front camera: 270 degrees, 3 quarter turns; one fewer for each turn of the phone */
    CHECK(sv_tx_quarter_turns(3, 0) == 3);
    CHECK(sv_tx_quarter_turns(3, 1) == 2);
    CHECK(sv_tx_quarter_turns(3, 2) == 1);
    CHECK(sv_tx_quarter_turns(3, 3) == 0);
    CHECK(sv_tx_quarter_turns(0, 1) == 3);
    CHECK(sv_tx_quarter_turns(1, -1) == 2);
}

static void test_s16_peak(void)
{
    const uint8_t quiet[] = { 0x05, 0x00, 0xfb, 0xff };          /* 5, -5 */
    const uint8_t loud[] = { 0x00, 0x10, 0x00, 0x80, 0xff, 0x7f };  /* 4096, -32768, 32767 */
    const uint8_t odd[] = { 0x10, 0x00, 0xff };                    /* 16 and a stray byte */
    CHECK(sv_s16_peak(quiet, sizeof quiet) == 5);
    CHECK(sv_s16_peak(loud, sizeof loud) == 32767);
    CHECK(sv_s16_peak(loud, 2) == 4096);
    CHECK(sv_s16_peak(odd, sizeof odd) == 16);
    CHECK(sv_s16_peak(quiet, 0) == 0);
    {
        const uint8_t neg[] = { 0xd4, 0xfe, 0x0a, 0x00 };          /* -300, 10 */
        CHECK(sv_s16_peak(neg, sizeof neg) == 300);
    }
}

int main(void)
{
    test_ssrcs();
    test_parse();
    test_find_ext();
    test_add_ext();
    test_cvo();
    test_rtcp();
    test_red();
    test_tcc();
    test_vp8_keyframe();
    test_data_msg();
    test_tx_turns();
    test_s16_peak();
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("PASS test_signal_video\n");
    return 0;
}
