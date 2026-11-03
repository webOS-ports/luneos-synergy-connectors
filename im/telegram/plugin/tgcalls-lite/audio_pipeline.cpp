#include "audio_pipeline.h"

#include <alsa/asoundlib.h>
#include <opus.h>
#include <cstdio>
#include <cstring>

namespace tgcalls_lite {

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 1;
constexpr int kFrameSamples = 960; // 20ms at 48kHz, matches libtgvoip's own AudioInputALSA BUFFER_SIZE
constexpr int kMaxOpusPacket = 1500;

// Same device-name/fallback convention as plugin/libtgvoip/os/linux/AudioInputALSA.cpp /
// AudioOutputALSA.cpp: "voipsource"/"voip" are audiod's phone-scenario-routed PCMs (real mic /
// real loudspeaker only while callLunaSetCallAudio(true) has the phone scenario active); "default"
// is the media source/sink, silent during a call.
snd_pcm_t *open_pcm(const char *primaryDevice, snd_pcm_stream_t stream) {
	snd_pcm_t *handle = nullptr;
	int rc = snd_pcm_open(&handle, primaryDevice, stream, 0);
	const char *opened = primaryDevice;
	if (rc < 0) {
		opened = "default";
		rc = snd_pcm_open(&handle, "default", stream, 0);
	}
	if (rc < 0) {
		fprintf(stderr, "tgcalls-lite audio: snd_pcm_open failed for both '%s' and 'default': %s\n",
		        primaryDevice, snd_strerror(rc));
		return nullptr;
	}
	fprintf(stderr, "tgcalls-lite audio: opened ALSA %s device '%s'\n",
	        stream == SND_PCM_STREAM_CAPTURE ? "capture" : "playback", opened);

	rc = snd_pcm_set_params(handle, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
	                          kChannels, kSampleRate, /*soft_resample=*/1, /*latency_us=*/100000);
	if (rc < 0) {
		fprintf(stderr, "tgcalls-lite audio: snd_pcm_set_params failed: %s\n", snd_strerror(rc));
		snd_pcm_close(handle);
		return nullptr;
	}
	return handle;
}

} // namespace

AudioPipeline::AudioPipeline() {}

AudioPipeline::~AudioPipeline() {
	stop();
}

bool AudioPipeline::start() {
	if (_running) return true;

	_captureHandle = open_pcm("voipsource", SND_PCM_STREAM_CAPTURE);
	_playbackHandle = open_pcm("voip", SND_PCM_STREAM_PLAYBACK);
	if (!_captureHandle || !_playbackHandle) {
		stop();
		return false;
	}

	int opusErr = 0;
	_encoder = opus_encoder_create(kSampleRate, kChannels, OPUS_APPLICATION_VOIP, &opusErr);
	if (opusErr != OPUS_OK || !_encoder) {
		fprintf(stderr, "tgcalls-lite audio: opus_encoder_create failed: %d\n", opusErr);
		stop();
		return false;
	}
	_decoder = opus_decoder_create(kSampleRate, kChannels, &opusErr);
	if (opusErr != OPUS_OK || !_decoder) {
		fprintf(stderr, "tgcalls-lite audio: opus_decoder_create failed: %d\n", opusErr);
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
	if (_captureHandle) { snd_pcm_close(_captureHandle); _captureHandle = nullptr; }
	if (_playbackHandle) { snd_pcm_close(_playbackHandle); _playbackHandle = nullptr; }
	std::lock_guard<std::mutex> lock(_playbackMx);
	_playbackQueue.clear();
}

void AudioPipeline::captureThreadMain() {
	int16_t pcm[kFrameSamples];
	uint8_t opusPacket[kMaxOpusPacket];

	while (_running) {
		snd_pcm_sframes_t frames = snd_pcm_readi(_captureHandle, pcm, kFrameSamples);
		if (frames < 0) {
			frames = snd_pcm_recover(_captureHandle, (int)frames, 0);
			if (frames < 0) {
				fprintf(stderr, "tgcalls-lite audio: snd_pcm_readi unrecoverable: %s\n",
				        snd_strerror((int)frames));
				break;
			}
			continue; // recovered (e.g. after an xrun) -- try again next loop rather than encoding
			          // a possibly-short/garbage buffer from this iteration
		}
		if (frames != kFrameSamples) continue; // partial read -- drop rather than encode a short frame

		opus_int32 len = opus_encode(_encoder, pcm, kFrameSamples, opusPacket, sizeof(opusPacket));
		if (len < 0) {
			fprintf(stderr, "tgcalls-lite audio: opus_encode failed: %d\n", (int)len);
			continue;
		}
		if (onEncodedFrame) onEncodedFrame(opusPacket, (int)len);
	}
}

void AudioPipeline::playbackThreadMain() {
	int16_t pcm[kFrameSamples];

	while (_running) {
		std::vector<uint8_t> packet;
		{
			std::unique_lock<std::mutex> lock(_playbackMx);
			_playbackCv.wait(lock, [this]() { return !_running || !_playbackQueue.empty(); });
			if (!_running) break;
			packet = std::move(_playbackQueue.front());
			_playbackQueue.pop_front();
		}

		int samples = opus_decode(_decoder, packet.data(), (opus_int32)packet.size(), pcm,
		                            kFrameSamples, /*decode_fec=*/0);
		if (samples < 0) {
			fprintf(stderr, "tgcalls-lite audio: opus_decode failed: %d\n", samples);
			continue;
		}

		snd_pcm_sframes_t written = snd_pcm_writei(_playbackHandle, pcm, samples);
		if (written < 0) {
			written = snd_pcm_recover(_playbackHandle, (int)written, 0);
			if (written < 0) {
				fprintf(stderr, "tgcalls-lite audio: snd_pcm_writei unrecoverable: %s\n",
				        snd_strerror((int)written));
			}
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
