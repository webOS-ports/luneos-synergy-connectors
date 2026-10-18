#include "opus_audio.h"
#include <opus/opus.h>
#include <dlfcn.h>
#include <cstring>

namespace dv {

// ---- Opus codec -------------------------------------------------------------
bool OpusCodec::init() {
    int err = 0;
    enc_ = opus_encoder_create(kSampleRate, kChannels, OPUS_APPLICATION_VOIP, &err);
    if (err != OPUS_OK || !enc_) { DV_ERR("opus enc create: %s", opus_strerror(err)); return false; }
    opus_encoder_ctl(enc_, OPUS_SET_BITRATE(48000));
    opus_encoder_ctl(enc_, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
    dec_ = opus_decoder_create(kSampleRate, kChannels, &err);
    if (err != OPUS_OK || !dec_) { DV_ERR("opus dec create: %s", opus_strerror(err)); return false; }
    DV_INFO("opus: %d Hz %d ch, 20ms frames", kSampleRate, kChannels);
    return true;
}

OpusCodec::~OpusCodec() {
    if (enc_) opus_encoder_destroy(enc_);
    if (dec_) opus_decoder_destroy(dec_);
}

bool OpusCodec::encode(const int16_t* pcm, Bytes& out) {
    out.resize(4000);
    int n = opus_encode(enc_, pcm, kFrameSamples, out.data(), (opus_int32)out.size());
    if (n < 0) { DV_WARN("opus_encode: %s", opus_strerror(n)); return false; }
    out.resize(n);
    return true;
}

int OpusCodec::decode(const uint8_t* opus, size_t len, int16_t* pcm, int maxSamples) {
    int n = opus_decode(dec_, opus, (opus_int32)len, pcm, maxSamples, 0);
    if (n < 0) { DV_WARN("opus_decode: %s", opus_strerror(n)); return -1; }
    return n;
}

// ---- ALSA bridge (dlopen the system libasound) ------------------------------
// ALSA constants (stable ABI) — declared locally so we need no asoundlib.h.
enum { SND_PCM_STREAM_PLAYBACK = 0, SND_PCM_STREAM_CAPTURE = 1 };
enum { SND_PCM_FORMAT_S16_LE = 2 };
enum { SND_PCM_ACCESS_RW_INTERLEAVED = 3 };

typedef int   (*fn_open)(void**, const char*, int, int);
typedef int   (*fn_set_params)(void*, int, int, unsigned, unsigned, int, unsigned);
typedef long  (*fn_readi)(void*, void*, unsigned long);
typedef long  (*fn_writei)(void*, const void*, unsigned long);
typedef int   (*fn_recover)(void*, int, int);
typedef int   (*fn_close)(void*);

void* AlsaBridge::openPcm(const char* dev, int stream) {
    void* h = nullptr;
    fn_open open_ = (fn_open)p_open_;
    fn_set_params sp = (fn_set_params)p_set_params_;
    if (open_(&h, dev, stream, 0) < 0 || !h) { DV_ERR("alsa: snd_pcm_open(%s) failed", dev); return nullptr; }
    // S16_LE, mono, 48 kHz, soft-resample ON, ~120 ms latency (matches wacallm).
    if (sp(h, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
           kChannels, kSampleRate, 1, 120000) < 0) {
        DV_ERR("alsa: snd_pcm_set_params(%s) failed", dev);
        ((fn_close)p_close_)(h);
        return nullptr;
    }
    return h;
}

bool AlsaBridge::open(std::string& err) {
    // dlopen the SYSTEM libasound (never ship our own).
    dl_ = dlopen("libasound.so.2", RTLD_NOW);
    if (!dl_) dl_ = dlopen("/usr/lib/libasound.so.2", RTLD_NOW);
    if (!dl_) { err = std::string("dlopen libasound: ") + dlerror(); return false; }
    p_open_ = dlsym(dl_, "snd_pcm_open");
    p_set_params_ = dlsym(dl_, "snd_pcm_set_params");
    p_readi_ = dlsym(dl_, "snd_pcm_readi");
    p_writei_ = dlsym(dl_, "snd_pcm_writei");
    p_recover_ = dlsym(dl_, "snd_pcm_recover");
    p_close_ = dlsym(dl_, "snd_pcm_close");
    if (!p_open_ || !p_set_params_ || !p_readi_ || !p_writei_ || !p_recover_ || !p_close_) {
        err = "alsa: missing symbols"; return false;
    }
    play_ = openPcm("voip", SND_PCM_STREAM_PLAYBACK);
    cap_  = openPcm("voipsource", SND_PCM_STREAM_CAPTURE);
    if (!play_ || !cap_) { err = "alsa: PCM open failed"; return false; }
    DV_INFO("alsa: voip/voipsource PCMs open");
    return true;
}

bool AlsaBridge::capture(int16_t* pcm) {
    if (!cap_) return false;
    long r = ((fn_readi)p_readi_)(cap_, pcm, kFrameSamples);
    if (r < 0) { ((fn_recover)p_recover_)(cap_, (int)r, 1); return false; }
    if (r < kFrameSamples) memset(pcm + r, 0, (kFrameSamples - r) * sizeof(int16_t));
    return true;
}

bool AlsaBridge::play(const int16_t* pcm) {
    if (!play_) return false;
    long w = ((fn_writei)p_writei_)(play_, pcm, kFrameSamples);
    if (w < 0) { ((fn_recover)p_recover_)(play_, (int)w, 1); return false; }
    return true;
}

void AlsaBridge::close() {
    if (p_close_) {
        if (cap_)  { ((fn_close)p_close_)(cap_);  cap_ = nullptr; }
        if (play_) { ((fn_close)p_close_)(play_); play_ = nullptr; }
    }
    if (dl_) { dlclose(dl_); dl_ = nullptr; }
}

AlsaBridge::~AlsaBridge() { close(); }

} // namespace dv
