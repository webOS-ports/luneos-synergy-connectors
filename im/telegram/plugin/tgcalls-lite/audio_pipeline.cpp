#include "audio_pipeline.h"

#include <glib.h>
#include <opus.h>
#include <pulse/error.h>
#include <pulse/simple.h>

namespace tgcalls_lite {

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 1;
constexpr int kFrameSamples = 960; // 20 ms
constexpr size_t kFrameBytes = kFrameSamples * sizeof(int16_t) * kChannels;
constexpr int kMaxOpusPacket = 1500;

pa_simple *open_stream(pa_stream_direction_t dir, const std::string &device) {
	pa_sample_spec spec;
	spec.format = PA_SAMPLE_S16LE;
	spec.rate = kSampleRate;
	spec.channels = kChannels;

	// Small buffers: 20 ms requests and fragments, about 60 ms queued for playback.
	pa_buffer_attr attr;
	attr.maxlength = (uint32_t)-1;
	attr.tlength = (uint32_t)(3 * kFrameBytes);
	attr.prebuf = (uint32_t)-1;
	attr.minreq = (uint32_t)kFrameBytes;
	attr.fragsize = (uint32_t)kFrameBytes;

	int err = 0;
	const bool playback = dir == PA_STREAM_PLAYBACK;
	pa_simple *s = pa_simple_new(nullptr, "Telegram call", dir, device.empty() ? nullptr : device.c_str(),
	                             playback ? "call playback" : "call capture", &spec, nullptr, &attr, &err);
	if (!s)
		g_warning("tgcalls-lite: cannot open PulseAudio %s \"%s\": %s", playback ? "sink" : "source",
		          device.c_str(), pa_strerror(err));
	return s;
}

} // namespace

int decode_opus_packet(OpusDecoder *decoder, const uint8_t *packet, int len, std::vector<int16_t> &pcm) {
	pcm.resize((size_t)kMaxOpusDecodeSamples * kChannels);
	int samples = opus_decode(decoder, packet, (opus_int32)len, pcm.data(), kMaxOpusDecodeSamples,
	                          /*decode_fec=*/0);
	pcm.resize(samples > 0 ? (size_t)samples * kChannels : 0);
	return samples;
}

AudioPipeline::AudioPipeline() {}

AudioPipeline::Stats AudioPipeline::stats() const {
	Stats s;
	s.encoded = _encoded.load();
	s.decoded = _decoded.load();
	s.decodeErrors = _decodeErrors.load();
	s.lastDecodedSamples = _lastDecodedSamples.load();
	return s;
}

AudioPipeline::~AudioPipeline() {
	stop();
}

bool AudioPipeline::start(const std::string &sink, const std::string &source) {
	if (_running) return true;

	_capture = open_stream(PA_STREAM_RECORD, source);
	_playback = open_stream(PA_STREAM_PLAYBACK, sink);
	if (!_capture || !_playback) {
		stop();
		return false;
	}

	int opusErr = 0;
	_encoder = opus_encoder_create(kSampleRate, kChannels, OPUS_APPLICATION_VOIP, &opusErr);
	if (opusErr != OPUS_OK || !_encoder) {
		g_warning("tgcalls-lite: opus_encoder_create failed: %d", opusErr);
		stop();
		return false;
	}
	// In-band FEC, which we offer (useinbandfec=1).
	opus_encoder_ctl(_encoder, OPUS_SET_INBAND_FEC(1));
	_decoder = opus_decoder_create(kSampleRate, kChannels, &opusErr);
	if (opusErr != OPUS_OK || !_decoder) {
		g_warning("tgcalls-lite: opus_decoder_create failed: %d", opusErr);
		stop();
		return false;
	}

	_running = true;
	_captureThread = std::thread([this]() { captureThreadMain(); });
	_playbackThread = std::thread([this]() { playbackThreadMain(); });
	return true;
}

void AudioPipeline::stop() {
	if (_running.exchange(false)) {
		_playbackCv.notify_all();
		if (_captureThread.joinable()) _captureThread.join();
		if (_playbackThread.joinable()) _playbackThread.join();
	}
	if (_encoder) { opus_encoder_destroy(_encoder); _encoder = nullptr; }
	if (_decoder) { opus_decoder_destroy(_decoder); _decoder = nullptr; }
	if (_capture) { pa_simple_free(_capture); _capture = nullptr; }
	if (_playback) { pa_simple_free(_playback); _playback = nullptr; }
	std::lock_guard<std::mutex> lock(_playbackMx);
	_playbackQueue.clear();
}

void AudioPipeline::captureThreadMain() {
	int16_t pcm[kFrameSamples];
	uint8_t opusPacket[kMaxOpusPacket];

	while (_running) {
		int err = 0;
		if (pa_simple_read(_capture, pcm, sizeof(pcm), &err) < 0) {
			g_warning("tgcalls-lite: PulseAudio capture failed: %s", pa_strerror(err));
			break;
		}
		opus_int32 len = opus_encode(_encoder, pcm, kFrameSamples, opusPacket, sizeof(opusPacket));
		if (len < 0) {
			g_warning("tgcalls-lite: opus_encode failed: %d", (int)len);
			continue;
		}
		_encoded++;
		if (onEncodedFrame) onEncodedFrame(opusPacket, (int)len);
	}
}

void AudioPipeline::playbackThreadMain() {
	std::vector<int16_t> pcm;

	while (_running) {
		std::vector<uint8_t> packet;
		{
			std::unique_lock<std::mutex> lock(_playbackMx);
			_playbackCv.wait(lock, [this]() { return !_running || !_playbackQueue.empty(); });
			if (!_running) break;
			packet = std::move(_playbackQueue.front());
			_playbackQueue.pop_front();
		}

		int samples = decode_opus_packet(_decoder, packet.data(), (int)packet.size(), pcm);
		if (samples <= 0) {
			// Once per call; the periodic call stats carry the count.
			if (_decodeErrors++ == 0)
				g_warning("tgcalls-lite: opus_decode failed: %d (%zu-byte packet)", samples, packet.size());
			continue;
		}
		_decoded++;
		_lastDecodedSamples = samples;

		int err = 0;
		if (pa_simple_write(_playback, pcm.data(), pcm.size() * sizeof(int16_t), &err) < 0) {
			g_warning("tgcalls-lite: PulseAudio playback failed: %s", pa_strerror(err));
			break;
		}
	}
}

void AudioPipeline::receiveEncodedFrame(const uint8_t *opusPacket, int len) {
	if (!_running || !opusPacket || len <= 0) return;
	std::lock_guard<std::mutex> lock(_playbackMx);
	while (_playbackQueue.size() >= kMaxQueuedFrames) _playbackQueue.pop_front(); // drop oldest
	_playbackQueue.emplace_back(opusPacket, opusPacket + len);
	_playbackCv.notify_one();
}

} // namespace tgcalls_lite
