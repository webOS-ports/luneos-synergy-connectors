// audio_pipeline.h — Opus capture and playback for tgcalls-lite calls through PulseAudio.
//
// It uses the call devices libtgvoip uses on LuneOS (tdlib-purple 0015): playback to the sink
// "voipcall", capture from the source "webcall". module-palm-policy routes them to the earpiece,
// speaker or headset and the matching microphone once audiod has been told a VoIP call is up
// (callLunaSetCallAudio(true)). Format: 48 kHz mono S16LE. Capture sends 20 ms frames; received
// packets may carry any Opus frame length up to 120 ms.
//
// Each direction runs a blocking pa_simple stream on its own thread. onEncodedFrame fires on the
// capture thread; receiveEncodedFrame() may be called from any thread.
#ifndef TGCALLS_LITE_AUDIO_PIPELINE_H
#define TGCALLS_LITE_AUDIO_PIPELINE_H

#include <cstdint>
#include <vector>
#include <deque>
#include <string>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <functional>

typedef struct pa_simple pa_simple;
typedef struct OpusEncoder OpusEncoder;
typedef struct OpusDecoder OpusDecoder;

namespace tgcalls_lite {

// The longest Opus packet is 120 ms; at 48 kHz mono that is 5760 samples. Peers pick their own
// frame length (tgcalls sends 60 ms frames), so the decoder must take any of them.
constexpr int kMaxOpusDecodeSamples = 5760;

// Decodes one Opus packet into pcm, sized to the samples decoded. Returns that number, or the
// negative Opus error.
int decode_opus_packet(OpusDecoder *decoder, const uint8_t *packet, int len, std::vector<int16_t> &pcm);

class AudioPipeline {
public:
	AudioPipeline();
	~AudioPipeline();

	AudioPipeline(const AudioPipeline &) = delete;
	AudioPipeline &operator=(const AudioPipeline &) = delete;

	// Opens both streams and the Opus codecs and starts the threads. Returns false (and logs
	// why) if any of them fails; the call then has no audio. An empty name means PulseAudio's
	// default device.
	bool start(const std::string &sink = "voipcall", const std::string &source = "webcall");
	void stop();

	// Fires once per captured and encoded 20 ms frame, on the capture thread.
	std::function<void(const uint8_t *opusPacket, int len)> onEncodedFrame;

	// One received Opus packet, for decoding and playback on the playback thread.
	void receiveEncodedFrame(const uint8_t *opusPacket, int len);

	// Counters for the call log, readable from any thread.
	struct Stats {
		uint64_t encoded = 0;
		uint64_t decoded = 0;
		uint64_t decodeErrors = 0;
		int lastDecodedSamples = 0;
		uint64_t receivedBytes = 0;  // Opus payload bytes handed to the decoder
		int lastPeak = 0;            // loudest sample of the last decoded frame
	};
	Stats stats() const;

private:
	void captureThreadMain();
	void playbackThreadMain();

	pa_simple *_capture = nullptr;
	pa_simple *_playback = nullptr;
	OpusEncoder *_encoder = nullptr;
	OpusDecoder *_decoder = nullptr;

	std::atomic<uint64_t> _receivedBytes{0};
	std::atomic<int> _lastPeak{0};
	std::atomic<bool> _running{false};
	std::thread _captureThread;
	std::thread _playbackThread;

	// Bounded so a late burst cannot build up latency: the oldest packet is dropped on overflow.
	std::mutex _playbackMx;
	std::condition_variable _playbackCv;
	std::deque<std::vector<uint8_t>> _playbackQueue;
	static constexpr size_t kMaxQueuedFrames = 10; // 200 ms of 20 ms frames, 600 ms of 60 ms ones

	std::atomic<uint64_t> _encoded{0};
	std::atomic<uint64_t> _decoded{0};
	std::atomic<uint64_t> _decodeErrors{0};
	std::atomic<int> _lastDecodedSamples{0};
};

} // namespace tgcalls_lite

#endif
