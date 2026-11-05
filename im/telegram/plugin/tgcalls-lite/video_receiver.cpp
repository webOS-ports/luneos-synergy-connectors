#include "video_receiver.h"

#include "../tdlib-purple/h264_rtp.h"

namespace tgcalls_lite {

namespace {

bool au_has_nal(const uint8_t *au, size_t len, uint8_t type) {
	if (!au) return false;
	// NAL units follow 00 00 01 (a 4-byte start code ends the same way); the NAL type is the
	// low five bits of the byte after it.
	for (size_t i = 0; i + 3 < len; i++) {
		if (au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1) {
			if ((au[i + 3] & 0x1f) == type) return true;
			i += 2;
		}
	}
	return false;
}

// True unless the RTP payload continues a NAL unit fragmented across packets (FU-A without its
// start bit).
bool starts_nal(const uint8_t *payload, size_t len) {
	if (len < 1) return false;
	if ((payload[0] & 0x1f) != 28) return true;
	return len >= 2 && (payload[1] & 0x80);
}

} // namespace

bool h264_au_has_idr(const uint8_t *au, size_t len) {
	return au_has_nal(au, len, 5);
}

VideoReceiver::VideoReceiver() {
	auto *d = new h264_depacketizer();
	h264_depacketizer_init(d);
	_depkt = d;
}

VideoReceiver::~VideoReceiver() {
	auto *d = static_cast<h264_depacketizer *>(_depkt);
	h264_depacketizer_free(d);
	delete d;
}

void VideoReceiver::restartDepacketizer() {
	auto *d = static_cast<h264_depacketizer *>(_depkt);
	h264_depacketizer_free(d);
	h264_depacketizer_init(d);
}

void VideoReceiver::reset() {
	restartDepacketizer();
	_haveSeq = false;
	_skipTs = false;
	_waitIdr = true;
	_haveSps = false;
}

bool VideoReceiver::feed(uint16_t seq, uint32_t timestamp, const uint8_t *payload, size_t len, bool marker,
                         const uint8_t **au, size_t *auLen) {
	if (_haveSeq) {
		const int16_t delta = (int16_t)(uint16_t)(seq - _lastSeq);
		if (delta <= 0) {
			_stats.late++;
			return false;
		}
		if (delta > 1) {
			_stats.gaps++;
			restartDepacketizer();
			_waitIdr = true;
			// The rest of an access unit that lost a packet is no use. A packet with a new
			// timestamp starts the next one, unless it continues a fragment, whose start was lost.
			_skipTs = timestamp == _lastTs || !starts_nal(payload, len);
			_brokenTs = timestamp;
		}
	}
	_haveSeq = true;
	_lastSeq = seq;
	_lastTs = timestamp;

	if (_skipTs) {
		if (timestamp == _brokenTs) return false;
		_skipTs = false;
	}

	const unsigned char *out = nullptr;
	size_t outLen = 0;
	if (!h264_depacketizer_feed(static_cast<h264_depacketizer *>(_depkt), payload, len, marker ? 1 : 0, &out,
	                            &outLen))
		return false;
	const bool sps = au_has_nal(out, outLen, 7);
	if (_waitIdr) {
		// A decoder starts from an IDR, and needs the parameter sets: the first IDR of a stream
		// must bring them (WebRTC puts them in front of every IDR).
		if (!h264_au_has_idr(out, outLen) || !(sps || _haveSps)) {
			_stats.dropped++;
			return false;
		}
		_waitIdr = false;
	}
	if (sps) _haveSps = true;
	_stats.accessUnits++;
	*au = out;
	*auLen = outLen;
	return true;
}

} // namespace tgcalls_lite
