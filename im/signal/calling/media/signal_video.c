/*
 * signal_video.c - byte-level helpers for the video half of a 1:1 Signal call. See signal_video.h.
 */
#include "signal_video.h"

#include <string.h>

uint32_t sv_video_ssrc(int is_caller)      { return is_caller ? 1003u : 2003u; }
uint32_t sv_peer_video_ssrc(int is_caller) { return is_caller ? 2003u : 1003u; }

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

int sv_rtp_parse(const uint8_t *p, size_t n, SvRtp *out)
{
    if (!p || !out || n < 12 || (p[0] >> 6) != 2)
        return -1;
    size_t len = 12 + 4u * (p[0] & 0x0f);
    if (len > n)
        return -1;
    memset(out, 0, sizeof *out);
    out->marker = (p[1] & 0x80) != 0;
    out->pt = p[1] & 0x7f;
    out->seq = rd16(p + 2);
    out->ts = rd32(p + 4);
    out->ssrc = rd32(p + 8);
    if (p[0] & 0x10) {
        if (len + 4 > n)
            return -1;
        size_t words = rd16(p + len + 2);
        out->ext_profile = rd16(p + len);
        out->ext_off = len + 4;
        out->ext_len = 4 * words;
        len += 4 + 4 * words;
        if (len > n)
            return -1;
    }
    out->header_len = len;
    return 0;
}

int sv_rtp_find_ext(const uint8_t *p, size_t n, const SvRtp *rtp, unsigned id,
                    const uint8_t **data, size_t *len)
{
    if (!p || !rtp || !rtp->ext_off || rtp->ext_off + rtp->ext_len > n)
        return -1;
    const uint8_t *e = p + rtp->ext_off, *end = e + rtp->ext_len;
    if (rtp->ext_profile == 0xBEDE) {
        while (e < end) {
            if (*e == 0) { e++; continue; }          /* padding */
            unsigned eid = *e >> 4;
            size_t elen = (size_t)(*e & 0x0f) + 1;
            if (eid == 15)                         /* reserved: stop, RFC 8285 4.2 */
                return -1;
            if (e + 1 + elen > end)
                return -1;
            if (eid == id) { *data = e + 1; *len = elen; return 0; }
            e += 1 + elen;
        }
    } else if ((rtp->ext_profile & 0xfff0) == 0x1000) {
        while (e < end) {
            if (*e == 0) { e++; continue; }
            if (e + 2 > end)
                return -1;
            unsigned eid = e[0];
            size_t elen = e[1];
            if (e + 2 + elen > end)
                return -1;
            if (eid == id) { *data = e + 2; *len = elen; return 0; }
            e += 2 + elen;
        }
    }
    return -1;
}

size_t sv_rtp_add_ext(const uint8_t *in, size_t n, unsigned id, const uint8_t *data, size_t dlen,
                      uint8_t *out, size_t cap)
{
    SvRtp r;
    if (!in || !out || !data || id < 1 || id > 14 || dlen < 1 || dlen > 16)
        return 0;
    if (sv_rtp_parse(in, n, &r) != 0)
        return 0;
    if (r.ext_off && r.ext_profile != 0xBEDE)
        return 0;

    size_t fixed = 12 + 4u * (in[0] & 0x0f);   /* header and CSRCs */
    /* The elements already there, without their trailing padding. */
    size_t used = 0;
    if (r.ext_off) {
        const uint8_t *e = in + r.ext_off;
        size_t i = 0;
        while (i < r.ext_len) {
            if (e[i] == 0) { i++; continue; }
            size_t elen = (size_t)(e[i] & 0x0f) + 1;
            if ((e[i] >> 4) == 15 || i + 1 + elen > r.ext_len)
                return 0;
            i += 1 + elen;
            used = i;
        }
    }
    size_t body = used + 1 + dlen;
    size_t words = (body + 3) / 4;
    size_t payload = n - r.header_len;
    size_t total = fixed + 4 + 4 * words + payload;
    if (words > 0xffff || total > cap)
        return 0;

    memcpy(out, in, fixed);
    out[0] |= 0x10;
    wr16(out + fixed, 0xBEDE);
    wr16(out + fixed + 2, (uint16_t)words);
    uint8_t *e = out + fixed + 4;
    if (used)
        memcpy(e, in + r.ext_off, used);
    e[used] = (uint8_t)((id << 4) | (dlen - 1));
    memcpy(e + used + 1, data, dlen);
    memset(e + body, 0, 4 * words - body);
    memcpy(out + fixed + 4 + 4 * words, in + r.header_len, payload);
    return total;
}

int sv_cvo_to_phone_quarter_turns(uint8_t cvo)
{
    return (4 - (cvo & 3)) & 3;
}

uint8_t sv_cvo_from_clockwise_quarter_turns(int quarter_turns)
{
    return (uint8_t)(quarter_turns & 3);
}

int sv_rtcp_wants_keyframe(const uint8_t *p, size_t n, uint32_t media_ssrc)
{
    if (!p || n < 8 || (p[0] >> 6) != 2 || p[1] < 192 || p[1] > 223)
        return -1;
    size_t off = 0;
    while (off + 4 <= n) {
        const uint8_t *h = p + off;
        if ((h[0] >> 6) != 2)
            return -1;
        size_t len = 4 * ((size_t)rd16(h + 2) + 1);
        if (off + len > n)
            return -1;
        unsigned fmt = h[0] & 0x1f;
        if (h[1] == 206 && len >= 12) {
            if (fmt == 1 && rd32(h + 8) == media_ssrc)
                return 1;
            if (fmt == 4) {
                /* FIR: media source 0, then 8-byte FCI entries {ssrc, seq, reserved}. */
                for (size_t f = 12; f + 8 <= len; f += 8)
                    if (rd32(h + f) == media_ssrc)
                        return 1;
            }
        }
        off += len;
    }
    return 0;
}

size_t sv_red_unwrap(const uint8_t *in, size_t n, uint8_t *out, size_t cap, uint8_t *inner_pt)
{
    SvRtp r;
    if (!in || !out || !inner_pt || sv_rtp_parse(in, n, &r) != 0)
        return 0;
    size_t end = n;
    if (in[0] & 0x20) {                         /* padding: its count is the last byte */
        size_t pad = in[n - 1];
        if (pad == 0 || pad > n - r.header_len)
            return 0;
        end = n - pad;
    }
    /* Block headers: 4 bytes |1|PT|ts offset(14)|length(10)| for each redundant block, then
     * the primary's single byte |0|PT|. The blocks' data follows in the same order. */
    size_t i = r.header_len, skip = 0;
    while (i < end && (in[i] & 0x80)) {
        if (i + 4 > end)
            return 0;
        skip += ((size_t)(in[i + 2] & 0x03) << 8) | in[i + 3];
        i += 4;
    }
    if (i >= end)
        return 0;
    uint8_t pt = in[i] & 0x7f;
    i += 1 + skip;
    if (i > end)
        return 0;
    size_t plen = end - i, total = r.header_len + plen;
    if (total > cap)
        return 0;
    memcpy(out, in, r.header_len);
    out[0] &= (uint8_t)~0x20;
    out[1] = (uint8_t)((in[1] & 0x80) | pt);
    memcpy(out + r.header_len, in + i, plen);
    *inner_pt = pt;
    return total;
}

int sv_vp8_is_keyframe_start(const uint8_t *p, size_t n)
{
    if (!p || n < 2 || !(p[0] & 0x10) || (p[0] & 0x07) != 0)   /* S, partition 0 */
        return 0;
    size_t i = 1;
    if (p[0] & 0x80) {                                          /* X: extension byte */
        uint8_t x = p[1];
        i = 2;
        if (x & 0x80) {                                         /* I: picture id, 1 or 2 bytes */
            if (i >= n) return 0;
            i += (p[i] & 0x80) ? 2 : 1;
        }
        if (x & 0x40) i++;                                      /* L: TL0PICIDX */
        if (x & 0x30) i++;                                      /* T or K: TID/KEYIDX */
    }
    return i < n && (p[i] & 0x01) == 0;
}

void sv_tcc_init(SvTcc *t)
{
    t->base = -1;
    t->highest = -1;
    for (int i = 0; i < SV_TCC_WINDOW; i++)
        t->arrival[i] = -1;
    t->pending = 0;
    t->fb_count = 0;
}

void sv_tcc_record(SvTcc *t, uint16_t seq, int64_t arrival_us)
{
    int64_t u;
    if (t->highest < 0) {
        u = seq;
        t->highest = u;
    } else {
        u = t->highest + (int16_t)(uint16_t)(seq - (uint16_t)t->highest);
        if (u > t->highest)
            t->highest = u;
    }
    if (t->base < 0)
        t->base = u;
    if (u < t->base)
        return;                                 /* already reported (as lost) */
    if (u - t->base >= SV_TCC_WINDOW) {         /* no feedback for a long time: drop the oldest */
        int64_t shift = u - t->base - SV_TCC_WINDOW + 1;
        for (int i = 0; i < SV_TCC_WINDOW; i++)
            t->arrival[i] = i + shift < SV_TCC_WINDOW ? t->arrival[i + shift] : -1;
        t->base += shift;
    }
    int64_t *slot = &t->arrival[u - t->base];
    if (*slot < 0) {
        *slot = arrival_us < 0 ? 0 : arrival_us;
        t->pending++;
    }
}

size_t sv_tcc_build(SvTcc *t, uint32_t sender_ssrc, uint32_t media_ssrc, uint8_t *out, size_t cap)
{
    if (!t || !out || t->pending == 0 || t->base < 0)
        return 0;
    /* The packets from base up to the last one received. */
    int count = 0, first = -1;
    for (int i = 0; i < SV_TCC_WINDOW; i++) {
        if (t->arrival[i] >= 0) {
            count = i + 1;
            if (first < 0) first = i;
        }
    }
    if (first < 0)
        return 0;
    int chunks = (count + 6) / 7;               /* two-bit status vector chunks, 7 packets each */
    size_t need = 20 + 2u * (size_t)chunks + 2u * (size_t)count;
    need = (need + 3) & ~(size_t)3;
    if (need > cap)
        return 0;
    memset(out, 0, need);

    int64_t ref = t->arrival[first] / 64000;    /* reference time, 64 ms units (24 bits) */
    int64_t prev = ref * 64000;
    size_t d = 20 + 2u * (size_t)chunks;        /* where the receive deltas go */
    for (int i = 0; i < count; i++) {
        unsigned sym = 0;
        if (t->arrival[i] >= 0) {
            int64_t delta = (t->arrival[i] - prev + (t->arrival[i] >= prev ? 125 : -125)) / 250;
            if (delta >= 0 && delta <= 255) {
                sym = 1;
                out[d++] = (uint8_t)delta;
            } else {
                if (delta > 32767) delta = 32767;
                if (delta < -32768) delta = -32768;
                sym = 2;
                wr16(out + d, (uint16_t)(int16_t)delta);
                d += 2;
            }
            prev += delta * 250;
        }
        size_t c = 20 + 2u * (size_t)(i / 7);
        unsigned shift = 12 - 2u * (unsigned)(i % 7);
        uint16_t v = (uint16_t)(rd16(out + c) | 0xC000 | (sym << shift));
        wr16(out + c, v);
    }
    size_t len = (d + 3) & ~(size_t)3;          /* zero padded to a 32-bit boundary */

    out[0] = 0x80 | 15;                         /* V=2, FMT=15 */
    out[1] = 205;                               /* RTPFB */
    wr16(out + 2, (uint16_t)(len / 4 - 1));
    wr32(out + 4, sender_ssrc);
    wr32(out + 8, media_ssrc);
    wr16(out + 12, (uint16_t)t->base);
    wr16(out + 14, (uint16_t)count);
    out[16] = (uint8_t)(ref >> 16);
    out[17] = (uint8_t)(ref >> 8);
    out[18] = (uint8_t)ref;
    out[19] = t->fb_count++;

    /* Forget what was reported; the next feedback starts after it. */
    int64_t next = t->base + count;
    for (int i = 0; i < SV_TCC_WINDOW; i++)
        t->arrival[i] = i + count < SV_TCC_WINDOW ? t->arrival[i + count] : -1;
    t->base = next;
    t->pending = 0;
    for (int i = 0; i < SV_TCC_WINDOW; i++)
        if (t->arrival[i] >= 0) t->pending++;
    return len;
}

size_t sv_rtcp_build_pli(uint32_t sender_ssrc, uint32_t media_ssrc, uint8_t out[12])
{
    out[0] = 0x80 | 1;     /* V=2, FMT=1 (PLI) */
    out[1] = 206;          /* PSFB */
    wr16(out + 2, 2);      /* 3 words, minus one */
    wr32(out + 4, sender_ssrc);
    wr32(out + 8, media_ssrc);
    return 12;
}

/* ------------------------------------------------------------------ protobuf ----------------- */

static size_t put_varint(uint8_t *out, size_t cap, size_t at, uint64_t v)
{
    do {
        if (at >= cap)
            return (size_t)-1;
        uint8_t b = v & 0x7f;
        v >>= 7;
        out[at++] = v ? (b | 0x80) : b;
    } while (v);
    return at;
}

static size_t varint_len(uint64_t v)
{
    size_t n = 1;
    while (v >>= 7)
        n++;
    return n;
}

static size_t put_key(uint8_t *out, size_t cap, size_t at, unsigned field, unsigned wire)
{
    return put_varint(out, cap, at, ((uint64_t)field << 3) | wire);
}

static size_t put_uint(uint8_t *out, size_t cap, size_t at, unsigned field, uint64_t v)
{
    at = put_key(out, cap, at, field, 0);
    return at == (size_t)-1 ? at : put_varint(out, cap, at, v);
}

void sv_data_msg_init(SvDataMsg *m)
{
    memset(m, 0, sizeof *m);
    m->video_enabled = -1;
    m->audio_enabled = -1;
}

size_t sv_data_msg_encode(const SvDataMsg *m, uint8_t *out, size_t cap)
{
    size_t at = 0;
    if (!m || !out)
        return 0;
    if (m->has_accepted) {
        size_t inner = 1 + varint_len(m->accepted_id);
        at = put_key(out, cap, at, 1, 2);
        if (at != (size_t)-1) at = put_varint(out, cap, at, inner);
        if (at != (size_t)-1) at = put_uint(out, cap, at, 1, m->accepted_id);
    }
    if (at != (size_t)-1 && m->has_hangup) {
        size_t inner = 1 + varint_len(m->hangup_id) + 1 + varint_len(m->hangup_type);
        at = put_key(out, cap, at, 2, 2);
        if (at != (size_t)-1) at = put_varint(out, cap, at, inner);
        if (at != (size_t)-1) at = put_uint(out, cap, at, 1, m->hangup_id);
        if (at != (size_t)-1) at = put_uint(out, cap, at, 2, m->hangup_type);
    }
    if (at != (size_t)-1 && m->has_status) {
        size_t inner = 1 + varint_len(m->status_id);
        if (m->video_enabled >= 0) inner += 2;
        if (m->audio_enabled >= 0) inner += 2;
        at = put_key(out, cap, at, 3, 2);
        if (at != (size_t)-1) at = put_varint(out, cap, at, inner);
        if (at != (size_t)-1) at = put_uint(out, cap, at, 1, m->status_id);
        if (at != (size_t)-1 && m->video_enabled >= 0) at = put_uint(out, cap, at, 2, m->video_enabled ? 1 : 0);
        if (at != (size_t)-1 && m->audio_enabled >= 0) at = put_uint(out, cap, at, 4, m->audio_enabled ? 1 : 0);
    }
    if (at != (size_t)-1 && m->has_seqnum)
        at = put_uint(out, cap, at, 4, m->seqnum);
    return at == (size_t)-1 ? 0 : at;
}

static int get_varint(const uint8_t *p, size_t n, size_t *at, uint64_t *v)
{
    uint64_t r = 0;
    for (unsigned shift = 0; shift < 64; shift += 7) {
        if (*at >= n)
            return -1;
        uint8_t b = p[(*at)++];
        r |= (uint64_t)(b & 0x7f) << shift;
        if (!(b & 0x80)) { *v = r; return 0; }
    }
    return -1;
}

/* One field: its number, wire type, and either the varint value or the length-delimited bytes. */
typedef struct {
    unsigned field;
    unsigned wire;
    uint64_t value;
    const uint8_t *bytes;
    size_t len;
} PbField;

static int next_field(const uint8_t *p, size_t n, size_t *at, PbField *f)
{
    uint64_t key;
    if (get_varint(p, n, at, &key) != 0 || (key >> 3) == 0 || (key >> 3) > 0x1fffffff)
        return -1;
    f->field = (unsigned)(key >> 3);
    f->wire = (unsigned)(key & 7);
    f->bytes = NULL;
    f->len = 0;
    switch (f->wire) {
    case 0:
        return get_varint(p, n, at, &f->value);
    case 1:
        if (n - *at < 8) return -1;
        *at += 8;
        return 0;
    case 2:
        if (get_varint(p, n, at, &f->value) != 0 || f->value > n - *at)
            return -1;
        f->bytes = p + *at;
        f->len = (size_t)f->value;
        *at += f->len;
        return 0;
    case 5:
        if (n - *at < 4) return -1;
        *at += 4;
        return 0;
    default:
        return -1;
    }
}

int sv_data_msg_decode(const uint8_t *p, size_t n, SvDataMsg *m)
{
    if (!m || (!p && n))
        return -1;
    sv_data_msg_init(m);
    size_t at = 0;
    while (at < n) {
        PbField f;
        if (next_field(p, n, &at, &f) != 0)
            return -1;
        if (f.wire == 0 && f.field == 4) {
            m->has_seqnum = 1;
            m->seqnum = f.value;
            continue;
        }
        if (f.wire != 2 || f.field < 1 || f.field > 3)
            continue;
        size_t in = 0;
        if (f.field == 1) m->has_accepted = 1;
        if (f.field == 2) m->has_hangup = 1;
        if (f.field == 3) m->has_status = 1;
        while (in < f.len) {
            PbField g;
            if (next_field(f.bytes, f.len, &in, &g) != 0)
                return -1;
            if (g.wire != 0)
                continue;
            if (f.field == 1 && g.field == 1) m->accepted_id = g.value;
            else if (f.field == 2 && g.field == 1) m->hangup_id = g.value;
            else if (f.field == 2 && g.field == 2) m->hangup_type = (uint32_t)g.value;
            else if (f.field == 3 && g.field == 1) m->status_id = g.value;
            else if (f.field == 3 && g.field == 2) m->video_enabled = g.value != 0;
            else if (f.field == 3 && g.field == 4) m->audio_enabled = g.value != 0;
        }
    }
    return 0;
}

int sv_s16_peak(const uint8_t *p, size_t n)
{
    int peak = 0;
    for (size_t i = 0; i + 1 < n; i += 2) {
        int v = (int16_t)(uint16_t)(p[i] | (unsigned)p[i + 1] << 8);
        if (v < 0) v = v == -32768 ? 32767 : -v;
        if (v > peak) peak = v;
    }
    return peak;
}

int sv_tx_quarter_turns(int camera_turns, int device_turns)
{
    return ((camera_turns - device_turns) % 4 + 4) % 4;
}
