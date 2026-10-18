// h264_rtp.c — see h264_rtp.h.
#include "h264_rtp.h"
#include <stdlib.h>
#include <string.h>

static const unsigned char kStartCode[4] = {0, 0, 0, 1};

void h264_depacketizer_init(h264_depacketizer *d) {
	memset(d, 0, sizeof(*d));
}

void h264_depacketizer_free(h264_depacketizer *d) {
	free(d->buf);
	memset(d, 0, sizeof(*d));
}

static int buf_reserve(h264_depacketizer *d, size_t extra) {
	if (d->len + extra <= d->cap) return 1;
	size_t want = d->cap ? d->cap * 2 : 4096;
	while (want < d->len + extra) want *= 2;
	unsigned char *n = (unsigned char *)realloc(d->buf, want);
	if (!n) return 0;
	d->buf = n;
	d->cap = want;
	return 1;
}

static int buf_append(h264_depacketizer *d, const unsigned char *data, size_t n) {
	if (!buf_reserve(d, n)) return 0;
	memcpy(d->buf + d->len, data, n);
	d->len += n;
	return 1;
}

static int append_nal(h264_depacketizer *d, const unsigned char *nal, size_t nal_len) {
	if (!buf_append(d, kStartCode, 4)) return 0;
	return buf_append(d, nal, nal_len);
}

int h264_depacketizer_feed(h264_depacketizer *d, const unsigned char *payload, size_t len,
                            int marker, const unsigned char **out_data, size_t *out_len) {
	if (len < 1) return 0;
	unsigned char nal_type = payload[0] & 0x1f;
	int appended_any = 0;

	if (nal_type >= 1 && nal_type <= 23) {
		// Single NAL unit packet (RFC 6184 5.6): payload is the whole NAL (header+data).
		d->fu_active = 0;
		appended_any = append_nal(d, payload, len);
	} else if (nal_type == 24) {
		// STAP-A (5.7.1): payload[0] is the STAP-A header, followed by a sequence of
		// (2-byte big-endian size, NAL bytes) entries.
		d->fu_active = 0;
		size_t off = 1;
		while (off + 2 <= len) {
			size_t nal_len = ((size_t)payload[off] << 8) | payload[off + 1];
			off += 2;
			if (off + nal_len > len) break; // malformed: truncated NAL, stop here
			if (!append_nal(d, payload + off, nal_len)) return 0;
			appended_any = 1;
			off += nal_len;
		}
	} else if (nal_type == 28) {
		// FU-A (5.8): payload[0]=FU indicator, payload[1]=FU header, payload[2..]=fragment.
		if (len < 2) return 0;
		unsigned char fu_indicator = payload[0];
		unsigned char fu_header = payload[1];
		int start = (fu_header >> 7) & 1;
		int end = (fu_header >> 6) & 1;
		unsigned char orig_nal_type = fu_header & 0x1f;
		const unsigned char *frag = payload + 2;
		size_t frag_len = len - 2;
		if (start) {
			unsigned char reconstructed_header = (unsigned char)((fu_indicator & 0xe0) | orig_nal_type);
			if (!buf_append(d, kStartCode, 4)) return 0;
			if (!buf_append(d, &reconstructed_header, 1)) return 0;
			if (!buf_append(d, frag, frag_len)) return 0;
			d->fu_active = 1;
			appended_any = 1;
		} else if (d->fu_active) {
			if (!buf_append(d, frag, frag_len)) return 0;
			appended_any = 1;
		}
		// else: missed the start fragment (e.g. a dropped packet) — drop this one; the
		// partially-accumulated NAL (if any) stays incomplete and gets discarded when the
		// access unit is reset below, rather than being handed upstream corrupted.
		if (end) d->fu_active = 0;
	}
	// Unknown/unsupported NAL type (25-27, 29-31 reserved/STAP-B/MTAP/FU-B): dropped.

	(void)appended_any;
	if (marker && d->len > 0) {
		*out_data = d->buf;
		*out_len = d->len;
		d->len = 0; // buffer/capacity kept for reuse; next feed starts a fresh access unit
		d->fu_active = 0;
		return 1;
	}
	return 0;
}

static int payload_is_start3(const unsigned char *p) {
	return p[0] == 0 && p[1] == 0 && p[2] == 1;
}
static int payload_is_start4(const unsigned char *p) {
	return p[0] == 0 && p[1] == 0 && p[2] == 0 && p[3] == 1;
}

void h264_packetize(const unsigned char *access_unit, size_t len, size_t mtu,
                     h264_rtp_emit_fn emit, void *ctx) {
	if (!emit || len < 4 || mtu < 3) return;

	// Find NAL boundaries: Annex-B start codes (3- or 4-byte 0x000001 / 0x00000001).
	// Collect (offset,len) pairs first so we know which one is last (for the marker bit).
	size_t starts[256];
	size_t lens[256];
	int n = 0;
	size_t i = 0;
	while (i + 3 <= len && n < 256) {
		size_t sc_len = 0;
		if (i + 4 <= len && payload_is_start4(access_unit + i)) sc_len = 4;
		else if (payload_is_start3(access_unit + i)) sc_len = 3;
		if (sc_len == 0) { i++; continue; }
		size_t nal_off = i + sc_len;
		size_t j = nal_off;
		while (j + 3 <= len && !payload_is_start3(access_unit + j)) j++;
		size_t nal_end;
		if (j + 3 > len) {
			nal_end = len; // no further start code: this NAL runs to the end
		} else {
			// j is where the NEXT "00 00 01" begins. If it's actually the tail of a
			// 4-byte "00 00 00 01" start code, that leading zero belongs to the start
			// code, not this NAL's data — trim it. (Safe: H.264's emulation-prevention
			// byte guarantees real NAL payload never contains a 00 00 01 run, 3- or
			// 4-byte, so any match here is genuinely a start code, never data.)
			nal_end = (j > nal_off && access_unit[j - 1] == 0) ? j - 1 : j;
		}
		if (nal_end > nal_off) {
			starts[n] = nal_off;
			lens[n] = nal_end - nal_off;
			n++;
		}
		i = j;
	}

	for (int k = 0; k < n; k++) {
		const unsigned char *nal = access_unit + starts[k];
		size_t nal_len = lens[k];
		int is_last_nal = (k == n - 1);
		if (nal_len == 0) continue;

		if (nal_len <= mtu) {
			emit(ctx, nal, nal_len, is_last_nal ? 1 : 0);
			continue;
		}

		// FU-A fragmentation (RFC 6184 5.8).
		unsigned char nal_header = nal[0];
		unsigned char nal_type = nal_header & 0x1f;
		unsigned char nri = nal_header & 0x60;
		unsigned char fu_indicator = (unsigned char)(nri | 28);
		const unsigned char *data = nal + 1;
		size_t data_len = nal_len - 1;
		size_t chunk = mtu - 2; // 2 bytes overhead: FU indicator + FU header
		unsigned char frag[1500];
		size_t chunk_cap = chunk < sizeof(frag) - 2 ? chunk : sizeof(frag) - 2;
		size_t off = 0;
		while (off < data_len) {
			size_t take = data_len - off;
			if (take > chunk_cap) take = chunk_cap;
			int is_start = (off == 0);
			int is_end = (off + take >= data_len);
			unsigned char fu_header = (unsigned char)((is_start ? 0x80 : 0) |
			                                            (is_end ? 0x40 : 0) | nal_type);
			frag[0] = fu_indicator;
			frag[1] = fu_header;
			memcpy(frag + 2, data + off, take);
			int marker = (is_end && is_last_nal) ? 1 : 0;
			emit(ctx, frag, take + 2, marker);
			off += take;
		}
	}
}
