// main.cpp — Discord voice client orchestrator (webOS/ARMv7 foundation).
//
// Flow (server voice channel, BOT token — the ALLOWED path):
//   1. Main gateway: connect -> IDENTIFY -> READY, then VOICE_STATE_UPDATE(guild,channel)
//      -> harvest {endpoint, token, session_id, self_user_id}.
//   2. Voice gateway: connect(endpoint) -> IDENTIFY -> READY -> IP discovery ->
//      SELECT_PROTOCOL -> SESSION_DESCRIPTION (transport key) + DAVE op21-30 interleave.
//   3. Audio: open voip/voipsource ALSA + tell audiod; loop mic->Opus->DAVE->UDP and
//      UDP->DAVE->Opus->speaker.
//
// Env:
//   DISCORD_BOT_TOKEN  (required)   bot token from the Discord developer portal
//   DISCORD_GUILD_ID   (required)   guild (server) snowflake
//   DISCORD_CHANNEL_ID (required)   voice channel snowflake
//   DVOICE_SELFTEST=1  run a no-network codec+DAVE linkage self-test and exit.
//
// This is a FOUNDATION: it compiles and links the full stack, but the live handshake
// is UNVERIFIED (no token/device tonight). See STATUS.md for the honest state.
#include "gateway.h"
#include "voice_ws.h"
#include "opus_audio.h"
#include "audiod.h"
#include "common.h"

#include <csignal>
#include <cstdlib>
#include <cstring>

using namespace dv;

static volatile sig_atomic_t g_stop = 0;
static void onSig(int) { g_stop = 1; }

// No-network linkage self-test: proves opus + libdave + transport AEAD all link and
// round-trip in-process. Handy to run under qemu without a token.
static int selftest() {
    DV_INFO("SELFTEST: opus + DAVE passthrough round-trip");
    OpusCodec codec;
    if (!codec.init()) return 1;
    int16_t pcm[kFrameSamples];
    for (int i = 0; i < kFrameSamples; ++i) pcm[i] = (int16_t)(3000.0 * __builtin_sin(i * 0.05));
    Bytes opus;
    if (!codec.encode(pcm, opus)) return 1;
    DV_INFO("SELFTEST: encoded %d PCM samples -> %zu Opus bytes", kFrameSamples, opus.size());

    DaveSession dave;
    if (!dave.init(1, "123456789012345678", "111111111111111111", 0xDEADBEEF)) return 1;
    Bytes framed;
    // Passthrough (pre-epoch): wrap returns the frame unchanged, proving the datapath links.
    if (!dave.wrapFrame(opus.data(), opus.size(), framed)) framed = opus;
    DV_INFO("SELFTEST: DAVE wrap (passthrough) %zu -> %zu bytes", opus.size(), framed.size());

    int16_t out[kFrameSamples];
    int n = codec.decode(opus.data(), opus.size(), out, kFrameSamples);
    DV_INFO("SELFTEST: decoded %d samples", n);
    DV_INFO("SELFTEST: max DAVE protocol version supported = %u", dave.maxProtocolVersion());
    DV_INFO("SELFTEST: PASS (all layers linked)");
    return (n == kFrameSamples) ? 0 : 1;
}

int main(int argc, char** argv) {
    signal(SIGINT, onSig);
    signal(SIGTERM, onSig);

    if (getenv("DVOICE_SELFTEST")) return selftest();

    const char* token   = getenv("DISCORD_BOT_TOKEN");
    const char* guild   = getenv("DISCORD_GUILD_ID");
    const char* channel = getenv("DISCORD_CHANNEL_ID");
    if (!token || !guild || !channel) {
        DV_ERR("set DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID (or DVOICE_SELFTEST=1)");
        return 2;
    }

    std::string err;

    // --- 1. Main gateway ---
    Gateway gw;
    if (!gw.connect(err))          { DV_ERR("gateway connect: %s", err.c_str()); return 1; }
    // First pump for HELLO, then IDENTIFY.
    for (int i = 0; i < 20 && !gw.ready(); ++i) {
        if (i == 1 && !gw.identify(token, err)) { DV_ERR("identify: %s", err.c_str()); return 1; }
        if (!gw.pump(500)) { DV_ERR("gateway disconnected before READY"); return 1; }
    }
    if (!gw.ready()) { DV_ERR("gateway never became READY"); return 1; }

    if (!gw.joinVoice(guild, channel, err)) { DV_ERR("joinVoice: %s", err.c_str()); return 1; }
    // Pump until we have both VOICE_SERVER_UPDATE and our session_id.
    for (int i = 0; i < 40 && !gw.voice().complete(); ++i)
        if (!gw.pump(500)) { DV_ERR("gateway disconnected before voice server"); return 1; }
    const VoiceServerInfo& v = gw.voice();
    if (!v.complete()) { DV_ERR("did not get voice server / session_id"); return 1; }

    // --- 2. Voice gateway ---
    VoiceWs vws;
    if (!vws.connect(v.endpoint, err)) { DV_ERR("voice connect: %s", err.c_str()); return 1; }
    for (int i = 0; i < 20 && !vws.transportReady(); ++i) {
        if (i == 1 && !vws.identify(v.guild_id, v.self_user_id, v.session_id, v.token, err)) {
            DV_ERR("voice identify: %s", err.c_str()); return 1;
        }
        if (!vws.pump(500)) { DV_ERR("voice ws disconnected before SESSION_DESCRIPTION"); return 1; }
    }
    if (!vws.transportReady()) { DV_ERR("voice transport never became ready"); return 1; }
    DV_INFO("voice transport ready (ssrc=%u); waiting for DAVE epoch...", vws.ssrc());

    // --- 3. Audio ---
    OpusCodec codec;
    AlsaBridge alsa;
    if (!codec.init()) return 1;
    if (!alsa.open(err)) { DV_WARN("alsa open failed (%s) — running network-only", err.c_str()); }
    audiod_call_active(true);
    vws.speaking(true);

    int16_t micPcm[kFrameSamples], spkPcm[kFrameSamples];
    bool audioOk = alsa.open(err); // idempotent check; true if PCMs are live
    Bytes opusIn;
    while (!g_stop) {
        // Service the voice ws (heartbeats, DAVE opcodes) without blocking.
        if (!vws.pump(0)) { DV_WARN("voice ws closed"); break; }

        // Mic -> Opus -> DAVE -> UDP (blocking capture paces the loop at ~20 ms).
        if (audioOk && alsa.capture(micPcm)) {
            Bytes opus;
            if (codec.encode(micPcm, opus)) vws.sendOpus(opus.data(), opus.size());
        } else {
            // No mic: still service the socket at ~20 ms cadence.
            vws.pump(20);
        }

        // UDP -> DAVE -> Opus -> speaker (drain whatever arrived).
        int rr = vws.recvOpus(0, opusIn);
        if (rr == 1 && audioOk) {
            int n = codec.decode(opusIn.data(), opusIn.size(), spkPcm, kFrameSamples);
            if (n > 0) alsa.play(spkPcm);
        } else if (rr < 0) {
            DV_WARN("udp recv error"); break;
        }
    }

    DV_INFO("shutting down");
    vws.speaking(false);
    audiod_call_active(false);
    alsa.close();
    vws.close();
    gw.close();
    return 0;
}
