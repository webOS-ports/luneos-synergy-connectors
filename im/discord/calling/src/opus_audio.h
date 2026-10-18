// opus_audio.h — Opus codec (libopus) + the webOS ALSA voip/voipsource bridge.
//
// Codec: 48 kHz mono (Discord voice), 20 ms frames = 960 samples. libopus is linked
// directly (cross-compiles trivially; device has libopus.so.0).
//
// Device audio: the PROVEN wacallm/Telegram recipe — dlopen the SYSTEM
// /usr/lib/libasound.so.2 and open the "voip" (playback) and "voipsource" (capture)
// PCMs, which route through PulseAudio's pvoip/pvoipsource into the phone audio path.
// S16_LE, mono, soft-resample on. We ship NO ALSA of our own.
#pragma once

#include "common.h"
#include <cstdint>

struct OpusEncoder;
struct OpusDecoder;

namespace dv {

static const int kSampleRate = 48000;
static const int kChannels   = 1;
static const int kFrameSamples = 960;   // 20 ms @ 48 kHz

class OpusCodec {
public:
    bool init();
    ~OpusCodec();
    // pcm: kFrameSamples int16 samples -> opus bytes into out. false on error.
    bool encode(const int16_t* pcm, Bytes& out);
    // opus bytes -> kFrameSamples int16 into pcm (must hold kFrameSamples). Returns samples.
    int  decode(const uint8_t* opus, size_t len, int16_t* pcm, int maxSamples);
private:
    OpusEncoder* enc_ = nullptr;
    OpusDecoder* dec_ = nullptr;
};

// dlopen-based ALSA bridge to the webOS voip PCMs.
class AlsaBridge {
public:
    bool open(std::string& err);        // dlopen libasound + open both PCMs
    void close();
    ~AlsaBridge();
    // Blocking capture/playback of one 20 ms frame (kFrameSamples int16 mono).
    bool capture(int16_t* pcm);         // mic -> pcm
    bool play(const int16_t* pcm);      // pcm -> speaker
private:
    void* dl_ = nullptr;
    void* cap_ = nullptr;               // snd_pcm_t* (capture)
    void* play_ = nullptr;              // snd_pcm_t* (playback)
    // resolved symbols
    void* p_open_ = nullptr; void* p_set_params_ = nullptr;
    void* p_readi_ = nullptr; void* p_writei_ = nullptr;
    void* p_recover_ = nullptr; void* p_close_ = nullptr;
    void* openPcm(const char* dev, int stream);
};

} // namespace dv
