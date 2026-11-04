/*
 * teams_video.c - byte-level helpers for the video half of a Teams call. See teams_video.h.
 */
#include "teams_video.h"

#include <string.h>

static uint16_t rd16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t rd32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static void wr16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void wr32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v;
}

static int is_rtcp(const uint8_t *p, size_t n)
{
    return n >= 4 && (p[0] >> 6) == 2 && p[1] >= 192 && p[1] <= 223;
}

int tv_rtp_parse(const uint8_t *p, size_t n, TvRtp *out)
{
    if (!p || !out || n < 12 || (p[0] >> 6) != 2 || is_rtcp(p, n))
        return -1;
    size_t len = 12 + 4u * (p[0] & 0x0f);
    if (len > n)
        return -1;
    if (p[0] & 0x10) {
        if (len + 4 > n)
            return -1;
        len += 4 + 4u * rd16(p + len + 2);
        if (len > n)
            return -1;
    }
    memset(out, 0, sizeof *out);
    out->marker = (p[1] & 0x80) != 0;
    out->pt = p[1] & 0x7f;
    out->seq = rd16(p + 2);
    out->ts = rd32(p + 4);
    out->ssrc = rd32(p + 8);
    out->header_len = len;
    return 0;
}

void tv_rx_stats_update(TvRxStats *s, uint32_t ssrc, uint16_t seq)
{
    if (!s->have || s->ssrc != ssrc) {
        memset(s, 0, sizeof *s);
        s->have = 1;
        s->ssrc = ssrc;
        s->base_seq = seq;
        s->max_seq = seq;
        s->received = 1;
        return;
    }
    uint16_t delta = (uint16_t)(seq - s->max_seq);
    if (delta != 0 && delta < 0x8000) {           /* in order, with a permissible gap */
        if (seq < s->max_seq)
            s->cycles += 65536;
        s->max_seq = seq;
    }
    s->received++;                                 /* duplicates and late packets count too (A.3) */
}

size_t tv_rtcp_build_rr(TvRxStats *s, uint32_t sender_ssrc, uint32_t lsr, uint32_t dlsr, uint8_t out[32])
{
    if (!s || !s->have)
        return 0;
    uint32_t ext_max = s->cycles + s->max_seq;
    uint32_t expected = ext_max - s->base_seq + 1;
    int64_t lost = (int64_t)expected - (int64_t)s->received;
    if (lost > 0x7fffff) lost = 0x7fffff;
    if (lost < -0x800000) lost = -0x800000;
    uint32_t exp_int = expected - s->expected_prior;
    uint32_t rec_int = s->received - s->received_prior;
    s->expected_prior = expected;
    s->received_prior = s->received;
    int64_t lost_int = (int64_t)exp_int - (int64_t)rec_int;
    uint8_t fraction = (exp_int == 0 || lost_int <= 0) ? 0 : (uint8_t)((lost_int << 8) / exp_int);

    out[0] = 0x81;                                  /* V=2, RC=1 */
    out[1] = 201;                                   /* RR */
    wr16(out + 2, 7);                               /* 8 words, minus one */
    wr32(out + 4, sender_ssrc);
    wr32(out + 8, s->ssrc);
    uint32_t cl = (uint32_t)lost & 0xffffffu;
    out[12] = fraction;
    out[13] = (uint8_t)(cl >> 16); out[14] = (uint8_t)(cl >> 8); out[15] = (uint8_t)cl;
    wr32(out + 16, ext_max);
    wr32(out + 20, 0);                              /* interarrival jitter: not measured */
    wr32(out + 24, lsr);
    wr32(out + 28, lsr ? dlsr : 0);
    return 32;
}

size_t tv_rtcp_build_remb(uint32_t sender_ssrc, uint32_t media_ssrc, uint64_t bitrate_bps, uint8_t out[24])
{
    /* BR Exp (6 bits) and BR Mantissa (18 bits): bitrate = mantissa << exp. */
    unsigned exp = 0;
    while ((bitrate_bps >> exp) > 0x3ffffu && exp < 63)
        exp++;
    uint32_t mantissa = (uint32_t)(bitrate_bps >> exp) & 0x3ffffu;
    out[0] = 0x80 | 15;                             /* V=2, FMT=15 (application layer feedback) */
    out[1] = 206;                                   /* PSFB */
    wr16(out + 2, 5);                               /* 6 words, minus one */
    wr32(out + 4, sender_ssrc);
    wr32(out + 8, 0);                               /* media source: unused, always 0 */
    memcpy(out + 12, "REMB", 4);
    out[16] = 1;                                    /* one SSRC follows */
    out[17] = (uint8_t)((exp << 2) | (mantissa >> 16));
    out[18] = (uint8_t)(mantissa >> 8);
    out[19] = (uint8_t)mantissa;
    wr32(out + 20, media_ssrc);
    return 24;
}

size_t tv_rtcp_build_pli(uint32_t sender_ssrc, uint32_t media_ssrc, uint8_t out[12])
{
    out[0] = 0x80 | 1;                              /* V=2, FMT=1 (PLI) */
    out[1] = 206;                                   /* PSFB */
    wr16(out + 2, 2);                               /* 3 words, minus one */
    wr32(out + 4, sender_ssrc);
    wr32(out + 8, media_ssrc);
    return 12;
}

/* Calls fn on each packet of a compound RTCP packet until it returns nonzero; that value, 0 when
 * every packet was seen, or -1 if p is not RTCP. */
static int each_rtcp(const uint8_t *p, size_t n, int (*fn)(const uint8_t *h, size_t len, void *u), void *u)
{
    if (!p || !is_rtcp(p, n))
        return -1;
    size_t off = 0;
    while (off + 4 <= n) {
        const uint8_t *h = p + off;
        if ((h[0] >> 6) != 2)
            return -1;
        size_t len = 4 * ((size_t)rd16(h + 2) + 1);
        if (off + len > n)
            return -1;
        int r = fn(h, len, u);
        if (r)
            return r;
        off += len;
    }
    return 0;
}

static int wants_keyframe(const uint8_t *h, size_t len, void *u)
{
    uint32_t media_ssrc = *(const uint32_t *)u;
    unsigned fmt = h[0] & 0x1f;
    if (h[1] != 206 || len < 12)
        return 0;
    if (fmt == 1 && rd32(h + 8) == media_ssrc)
        return 1;
    if (fmt == 4)                                   /* FIR: 8-byte entries {ssrc, seq, reserved} */
        for (size_t f = 12; f + 8 <= len; f += 8)
            if (rd32(h + f) == media_ssrc)
                return 1;
    return 0;
}

int tv_rtcp_wants_keyframe(const uint8_t *p, size_t n, uint32_t media_ssrc)
{
    return each_rtcp(p, n, wants_keyframe, &media_ssrc);
}

typedef struct { uint32_t ssrc; uint32_t ntp_mid; } SrFind;

static int find_sr(const uint8_t *h, size_t len, void *u)
{
    SrFind *f = u;
    if (h[1] != 200 || len < 28)
        return 0;
    if (f->ssrc && rd32(h + 4) != f->ssrc)
        return 0;
    f->ntp_mid = (rd32(h + 8) << 16) | (rd32(h + 12) >> 16);
    return 1;
}

int tv_rtcp_find_sr(const uint8_t *p, size_t n, uint32_t ssrc, uint32_t *ntp_mid)
{
    SrFind f = { ssrc, 0 };
    int r = each_rtcp(p, n, find_sr, &f);
    if (r == 1 && ntp_mid)
        *ntp_mid = f.ntp_mid;
    return r;
}

int tv_keyframe_overdue(int64_t now, int64_t last_packet, int64_t first_packet, int64_t last_decoded)
{
    if (!last_packet || now - last_packet > 1000000)
        return 0;                                   /* nothing arriving: nothing to recover */
    int64_t since = last_decoded ? last_decoded : first_packet;
    return since && now - since >= 1000000;
}
