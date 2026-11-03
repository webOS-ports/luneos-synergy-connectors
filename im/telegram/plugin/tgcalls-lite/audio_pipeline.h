// audio_pipeline.h — real-time Opus audio capture/playback for tgcalls-lite calls, over the same
// ALSA "voipsource"/"voip" devices libtgvoip's own AudioInputALSA/AudioOutputALSA already use
// (see plugin/libtgvoip/os/linux/AudioInput{,Output}ALSA.cpp) -- same device names, same 48kHz
// mono S16LE format, same 960-sample (20ms) frame size, same audiod phone-scenario dependency
// (callLunaSetCallAudio(true) must already be active, exactly as it is for libtgvoip calls today).
// This is a SEPARATE audio pipeline from libtgvoip's, not a shared one -- the two engines are
// mutually exclusive per call (only one is ever active), but this file doesn't enforce that
// itself; the caller (call.cpp) must not run both simultaneously.
//
// UNLIKE the ICE/DTLS-SRTP/signaling code in this directory, this file's correctness (ALSA device
// behavior, buffer sizing under real scheduling, actual audio quality) can only be confirmed on
// the real device -- qemu-arm has no real ALSA hardware to exercise. Structured as closely as
// possible to the already-proven AudioInputALSA/AudioOutputALSA code specifically to minimize the
// risk of getting device/format details wrong.
#ifndef TGCALLS_LITE_AUDIO_PIPELINE_H
#define TGCALLS_LITE_AUDIO_PIPELINE_H

#include <cstdint>
#include <vector>
#include <deque>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <functional>

typedef struct _snd_pcm snd_pcm_t;
typedef struct OpusEncoder OpusEncoder;
typedef struct OpusDecoder OpusDecoder;

namespace tgcalls_lite {

class AudioPipeline {
public:
	AudioPipeline();
	~AudioPipeline();

	AudioPipeline(const AudioPipeline &) = delete;
	AudioPipeline &operator=(const AudioPipeline &) = delete;

	// Opens ALSA capture+playback and starts both threads. Returns false (logs why) if either ALSA
	// device or either Opus codec instance fails to open/create -- caller should treat that as "no
	// audio for this call" rather than crash, same as AudioInputALSA/AudioOutputALSA's own `failed`
	// flag philosophy.
	bool start();
	void stop();

	// Fires once per captured+encoded 20ms frame, ready for RTP packetization + CallEngine::sendRtp.
	std::function<void(const uint8_t *opusPacket, int len)> onEncodedFrame;

	// Feed one received (already SRTP-decrypted, RTP-depacketized) Opus packet here for decode +
	// playback. Queued, not decoded synchronously -- see the .cpp's playback thread.
	void receiveEncodedFrame(const uint8_t *opusPacket, int len);

private:
	void captureThreadMain();
	void playbackThreadMain();

	snd_pcm_t *_captureHandle = nullptr;
	snd_pcm_t *_playbackHandle = nullptr;
	OpusEncoder *_encoder = nullptr;
	OpusDecoder *_decoder = nullptr;

	std::atomic<bool> _running{false};
	std::thread _captureThread;
	std::thread _playbackThread;

	// Playback jitter queue: bounded so a lagging peer/network can't build unbounded latency.
	// Oldest-drop on overflow (live audio wants low latency over completeness, same philosophy as
	// skypekit.h's video frame handoff).
	std::mutex _playbackMx;
	std::condition_variable _playbackCv;
	std::deque<std::vector<uint8_t>> _playbackQueue;
	static constexpr size_t kMaxQueuedFrames = 10; // ~200ms at 20ms/frame
};

} // namespace tgcalls_lite

#endif
