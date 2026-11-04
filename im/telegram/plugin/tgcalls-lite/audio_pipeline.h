// audio_pipeline.h — Opus capture and playback for tgcalls-lite calls through PulseAudio.
//
// It uses the call devices libtgvoip uses on LuneOS (tdlib-purple 0015): playback to the sink
// "voipcall", capture from the source "webcall". module-palm-policy routes them to the earpiece,
// speaker or headset and the matching microphone once audiod has been told a VoIP call is up
// (callLunaSetCallAudio(true)). Format: 48 kHz mono S16LE, 20 ms frames.
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

private:
	void captureThreadMain();
	void playbackThreadMain();

	pa_simple *_capture = nullptr;
	pa_simple *_playback = nullptr;
	OpusEncoder *_encoder = nullptr;
	OpusDecoder *_decoder = nullptr;

	std::atomic<bool> _running{false};
	std::thread _captureThread;
	std::thread _playbackThread;

	// Bounded so a late burst cannot build up latency: the oldest packet is dropped on overflow.
	std::mutex _playbackMx;
	std::condition_variable _playbackCv;
	std::deque<std::vector<uint8_t>> _playbackQueue;
	static constexpr size_t kMaxQueuedFrames = 10; // ~200 ms
};

} // namespace tgcalls_lite

#endif
