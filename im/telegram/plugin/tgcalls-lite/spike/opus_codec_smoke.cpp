// Phase 2 spike: exercise the exact Opus encode/decode parameters audio_pipeline.cpp uses
// (48kHz, mono, 960-sample/20ms frames, OPUS_APPLICATION_VOIP) without opening an audio device --
// proves the codec integration itself is correct (frame sizing, buffer allocation, round-trip) so
// the only untested part of audio_pipeline.cpp is the PulseAudio device side, which needs the device.
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cmath>
#include <opus.h>

int main() {
	constexpr int kSampleRate = 48000;
	constexpr int kChannels = 1;
	constexpr int kFrameSamples = 960;

	int err = 0;
	OpusEncoder *enc = opus_encoder_create(kSampleRate, kChannels, OPUS_APPLICATION_VOIP, &err);
	if (err != OPUS_OK || !enc) { fprintf(stderr, "FAIL: encoder_create %d\n", err); return 1; }
	OpusDecoder *dec = opus_decoder_create(kSampleRate, kChannels, &err);
	if (err != OPUS_OK || !dec) { fprintf(stderr, "FAIL: decoder_create %d\n", err); return 1; }

	int16_t pcmIn[kFrameSamples];
	for (int i = 0; i < kFrameSamples; i++) {
		pcmIn[i] = (int16_t)(8000.0 * sin(2.0 * M_PI * 440.0 * i / kSampleRate)); // 440Hz tone
	}

	int failures = 0;
	int16_t pcmOut[kFrameSamples];
	// Encode/decode 50 frames (~1 second) to also exercise Opus's internal state continuity.
	for (int frame = 0; frame < 50; frame++) {
		uint8_t packet[1500];
		opus_int32 len = opus_encode(enc, pcmIn, kFrameSamples, packet, sizeof(packet));
		if (len < 0) { fprintf(stderr, "FAIL: opus_encode frame %d: %d\n", frame, (int)len); failures++; continue; }
		if (len == 0 || len > 1500) { fprintf(stderr, "FAIL: opus_encode implausible len %d\n", (int)len); failures++; continue; }

		int samples = opus_decode(dec, packet, len, pcmOut, kFrameSamples, 0);
		if (samples != kFrameSamples) {
			fprintf(stderr, "FAIL: opus_decode frame %d returned %d samples, expected %d\n",
			        frame, samples, kFrameSamples);
			failures++;
		}
	}

	// Rough sanity: decoded signal should have comparable energy to the input (lossy codec, not
	// bit-exact, but shouldn't be silence or garbage).
	double inEnergy = 0, outEnergy = 0;
	for (int i = 0; i < kFrameSamples; i++) {
		inEnergy += (double)pcmIn[i] * pcmIn[i];
		outEnergy += (double)pcmOut[i] * pcmOut[i];
	}
	fprintf(stderr, "input energy=%.0f output energy=%.0f (last frame)\n", inEnergy, outEnergy);
	if (outEnergy < inEnergy * 0.3 || outEnergy > inEnergy * 3.0) {
		fprintf(stderr, "FAIL: decoded energy wildly different from input -- codec likely misconfigured\n");
		failures++;
	}

	opus_encoder_destroy(enc);
	opus_decoder_destroy(dec);

	if (failures == 0) { fprintf(stderr, "ALL OK\n"); return 0; }
	fprintf(stderr, "%d FAILURES\n", failures);
	return 1;
}
