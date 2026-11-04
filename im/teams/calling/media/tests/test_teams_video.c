/*
 * Unit tests for teams_video.c: RTP header parsing, receive statistics and the RTCP packets the
 * engine builds or reads. Plain C, no framework:
 *   cc -I.. test_teams_video.c ../teams_video.c && ./a.out
 */
#include "teams_video.h"

#include <stdio.h>
#include <string.h>

static int failures;
#define CHECK(c) do { if (!(c)) { failures++; fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); } } while (0)

static size_t rtp_header(uint8_t *p, uint8_t pt, int marker, uint16_t seq, uint32_t ssrc)
{
    p[0] = 0x80; p[1] = (uint8_t)(pt | (marker ? 0x80 : 0));
    p[2] = (uint8_t)(seq >> 8); p[3] = (uint8_t)seq;
    p[4] = 1; p[5] = 2; p[6] = 3; p[7] = 4;
    p[8] = (uint8_t)(ssrc >> 24); p[9] = (uint8_t)(ssrc >> 16); p[10] = (uint8_t)(ssrc >> 8); p[11] = (uint8_t)ssrc;
    return 12;
}

static uint32_t be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static void test_parse(void)
{
    uint8_t p[64];
    TvRtp r;
    rtp_header(p, TV_PT_H264, 1, 7, 8840);
    CHECK(tv_rtp_parse(p, 14, &r) == 0);
    CHECK(r.pt == 107 && r.marker && r.seq == 7 && r.ts == 0x01020304 && r.ssrc == 8840 && r.header_len == 12);
    /* An abs-send-time extension block (one word). */
    p[0] |= 0x10;
    memcpy(p + 12, "\xbe\xde\x00\x01\x12\x01\x02\x03", 8);
    CHECK(tv_rtp_parse(p, 20, &r) == 0 && r.header_len == 20);
    CHECK(tv_rtp_parse(p, 19, &r) == -1);
    CHECK(tv_rtp_parse(p, 15, &r) == -1);
    CHECK(tv_rtp_parse(p, 11, &r) == -1);
    p[0] = 0x40;
    CHECK(tv_rtp_parse(p, 20, &r) == -1);          /* version 1 */
    rtp_header(p, 0, 0, 0, 1);
    p[1] = 201;                                     /* an RR: not RTP */
    CHECK(tv_rtp_parse(p, 12, &r) == -1);
    CHECK(tv_rtp_parse(NULL, 12, &r) == -1);
}

static void test_rr(void)
{
    TvRxStats s;
    uint8_t rr[32];
    memset(&s, 0, sizeof s);
    CHECK(tv_rtcp_build_rr(&s, 1, 0, 0, rr) == 0);  /* nothing received */

    /* 100..109 with 103 and 104 missing: 8 of 10. */
    for (uint16_t q = 100; q < 110; q++)
        if (q != 103 && q != 104)
            tv_rx_stats_update(&s, 8840, q);
    CHECK(tv_rtcp_build_rr(&s, 4242, 0x11223344, 0x10000, rr) == 32);
    CHECK(rr[0] == 0x81 && rr[1] == 201 && rr[2] == 0 && rr[3] == 7);
    CHECK(be32(rr + 4) == 4242 && be32(rr + 8) == 8840);
    CHECK(rr[12] == 51);                            /* 2/10 of 256 */
    CHECK(rr[13] == 0 && rr[14] == 0 && rr[15] == 2);
    CHECK(be32(rr + 16) == 109);
    CHECK(be32(rr + 24) == 0x11223344 && be32(rr + 28) == 0x10000);

    /* The next interval lost nothing; a late duplicate is counted as received. */
    for (uint16_t q = 110; q < 120; q++)
        tv_rx_stats_update(&s, 8840, q);
    tv_rx_stats_update(&s, 8840, 105);
    CHECK(tv_rtcp_build_rr(&s, 4242, 0, 0x10000, rr) == 32);
    CHECK(rr[12] == 0 && rr[15] == 1);              /* cumulative: 20 expected, 19 received */
    CHECK(be32(rr + 28) == 0);                      /* no LSR, so no DLSR */

    /* Wrap: 65534, 65535, 0, 1. */
    memset(&s, 0, sizeof s);
    for (uint32_t q = 65534; q < 65538; q++)
        tv_rx_stats_update(&s, 9, (uint16_t)q);
    CHECK(tv_rtcp_build_rr(&s, 1, 0, 0, rr) == 32 && be32(rr + 16) == 65537 && rr[15] == 0);

    /* A new SSRC starts afresh. */
    tv_rx_stats_update(&s, 10, 500);
    CHECK(tv_rtcp_build_rr(&s, 1, 0, 0, rr) == 32 && be32(rr + 8) == 10 && be32(rr + 16) == 500);
}

static void test_remb(void)
{
    uint8_t b[24];
    CHECK(tv_rtcp_build_remb(4242, 8840, 1500000, b) == 24);
    CHECK(b[0] == 0x8f && b[1] == 206 && b[3] == 5 && be32(b + 4) == 4242 && be32(b + 8) == 0);
    CHECK(memcmp(b + 12, "REMB", 4) == 0 && b[16] == 1 && be32(b + 20) == 8840);
    unsigned exp = b[17] >> 2;
    unsigned long mant = ((unsigned long)(b[17] & 3) << 16) | ((unsigned long)b[18] << 8) | b[19];
    CHECK((mant << exp) <= 1500000 && (mant << exp) > 1500000 - (1ul << exp));
    CHECK(exp == 3);                                /* 1500000 needs 21 bits: shifted by 3 */
    tv_rtcp_build_remb(1, 2, 1000, b);
    CHECK((b[17] >> 2) == 0 && b[19] == (1000 & 0xff) && b[18] == (1000 >> 8));
    CHECK(tv_rtcp_wants_keyframe(b, 24, 8840) == 0);
}

static void test_keyframe_requests(void)
{
    uint8_t pli[12];
    CHECK(tv_rtcp_build_pli(4242, 8840, pli) == 12);
    CHECK(memcmp(pli, "\x81\xce\x00\x02\x00\x00\x10\x92\x00\x00\x22\x88", 12) == 0);
    CHECK(tv_rtcp_wants_keyframe(pli, 12, 8840) == 1);
    CHECK(tv_rtcp_wants_keyframe(pli, 12, 4242) == 0);

    /* Compound RR + PLI, and cut short. */
    TvRxStats s;
    memset(&s, 0, sizeof s);
    tv_rx_stats_update(&s, 8840, 1);
    uint8_t comp[44];
    tv_rtcp_build_rr(&s, 4242, 0, 0, comp);
    memcpy(comp + 32, pli, 12);
    CHECK(tv_rtcp_wants_keyframe(comp, 44, 8840) == 1);
    CHECK(tv_rtcp_wants_keyframe(comp, 43, 8840) == -1);
    CHECK(tv_rtcp_wants_keyframe(comp, 32, 8840) == 0);

    /* FIR with an entry for us. */
    uint8_t fir[20];
    memcpy(fir, "\x84\xce\x00\x04\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x22\x88\x05\x00\x00\x00", 20);
    CHECK(tv_rtcp_wants_keyframe(fir, 20, 8840) == 1);
    CHECK(tv_rtcp_wants_keyframe(fir, 20, 1) == 0);

    uint8_t rtp[12];
    rtp_header(rtp, TV_PT_H264, 0, 1, 8840);
    CHECK(tv_rtcp_wants_keyframe(rtp, 12, 8840) == -1);
}

static void test_sr(void)
{
    /* SR from 8840: NTP 0xAABBCCDD.0x11223344 -> middle 0xCCDD1122. */
    uint8_t sr[28] = { 0x80, 200, 0, 6, 0, 0, 0x22, 0x88, 0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44 };
    uint32_t mid = 0;
    CHECK(tv_rtcp_find_sr(sr, 28, 8840, &mid) == 1 && mid == 0xCCDD1122);
    CHECK(tv_rtcp_find_sr(sr, 28, 0, &mid) == 1);
    CHECK(tv_rtcp_find_sr(sr, 28, 1, &mid) == 0);
    CHECK(tv_rtcp_find_sr(sr, 27, 8840, &mid) == -1);
    uint8_t pli[12];
    tv_rtcp_build_pli(1, 2, pli);
    CHECK(tv_rtcp_find_sr(pli, 12, 0, &mid) == 0);
}

static void test_overdue(void)
{
    const int64_t s = 1000000;
    CHECK(!tv_keyframe_overdue(10 * s, 0, 0, 0));             /* nothing ever arrived */
    CHECK(!tv_keyframe_overdue(10 * s, 10 * s, 10 * s, 0));   /* first packet just now */
    CHECK(tv_keyframe_overdue(11 * s, 11 * s, 10 * s, 0));    /* a second of packets, no picture */
    CHECK(!tv_keyframe_overdue(11 * s, 11 * s, 10 * s, 11 * s - 1)); /* decoding */
    CHECK(tv_keyframe_overdue(13 * s, 13 * s, 10 * s, 12 * s)); /* stalled for a second */
    CHECK(!tv_keyframe_overdue(13 * s, 11 * s, 10 * s, 0));   /* the far side stopped sending */
}

int main(void)
{
    test_parse();
    test_rr();
    test_remb();
    test_keyframe_requests();
    test_sr();
    test_overdue();
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("PASS test_teams_video\n");
    return 0;
}
