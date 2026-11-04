// video_receiver.h — turns the peer's H.264 RTP packets into access units a decoder can start
// from and keep decoding: h264_rtp.c's depacketizer plus loss handling.
//
// There is no retransmission (RTX/NACK) in tgcalls-lite. When a packet is missing, the access
// unit it belonged to is dropped (packets of that RTP timestamp), and so is everything up to the
// next IDR, because the frames in between refer to what was lost. The stream also starts held
// back until its first IDR that carries a sequence parameter set. keyframeNeeded() says when
// the engine should ask the peer for one.
// Late and duplicate packets are dropped: there is no reorder buffer.
#ifndef TGCALLS_LITE_VIDEO_RECEIVER_H
#define TGCALLS_LITE_VIDEO_RECEIVER_H

#include <cstddef>
#include <cstdint>

namespace tgcalls_lite {

// True if the Annex-B access unit holds an IDR slice (NAL type 5).
bool h264_au_has_idr(const uint8_t *au, size_t len);

class VideoReceiver {
public:
	VideoReceiver();
	~VideoReceiver();
	VideoReceiver(const VideoReceiver &) = delete;
	VideoReceiver &operator=(const VideoReceiver &) = delete;

	// A new stream (or none): forgets everything and waits for an IDR again.
	void reset();

	// One RTP packet of the stream. Returns true when it completed an access unit to pass on;
	// *au / *auLen then point at it until the next feed() or reset().
	bool feed(uint16_t seq, uint32_t timestamp, const uint8_t *payload, size_t len, bool marker,
	          const uint8_t **au, size_t *auLen);

	// The stream cannot be decoded until the peer sends an IDR.
	bool keyframeNeeded() const { return _waitIdr; }

	struct Stats {
		uint64_t accessUnits = 0; // passed on
		uint64_t dropped = 0;     // completed but held back (no IDR yet)
		uint64_t gaps = 0;        // sequence gaps seen
		uint64_t late = 0;        // late or duplicate packets dropped
	};
	const Stats &stats() const { return _stats; }

private:
	void restartDepacketizer();

	void *_depkt; // h264_depacketizer*
	bool _haveSeq = false;
	uint16_t _lastSeq = 0;
	uint32_t _lastTs = 0;
	bool _skipTs = false;     // drop the rest of the access unit with timestamp _brokenTs
	uint32_t _brokenTs = 0;
	bool _waitIdr = true;
	bool _haveSps = false;    // a sequence parameter set came since reset()
	Stats _stats;
};

} // namespace tgcalls_lite

#endif
