/*
 * signal_media.c - Signal 1:1 call MEDIA ENGINE for webOS (HP TouchPad), answerer side.
 *
 * Reuses the exact audio recipe proven for the Telegram port: GStreamer 1.20.7 on-device, capture
 * from ALSA "voipsource" / play to "voip" (the PulseAudio pvoip/pvoipsource PCMs under the phone
 * scenario), Opus over RTP. The one thing Signal does differently from Telegram/WhatsApp: media is
 * ICE (libnice) + *manual-keyed* AEAD_AES_256_GCM SRTP whose master keys come from an X25519 DH
 * (srtp_kdf.c), NOT DTLS. So we drive srtpenc/srtpdec with keys we set ourselves.
 *
 *   RX: nicesrc -> srtpdec(offer_key||offer_salt via request-key) -> rtpopusdepay -> opusdec -> alsasink device=voip
 *   TX: alsasrc device=voipsource -> opusenc -> rtpopuspay -> srtpenc(answer_key||answer_salt) -> nicesink
 *
 * Both nicesrc and nicesink bind the SAME NiceAgent stream/component (RTP send+recv on one 5-tuple,
 * rtcp-mux). We are the CALLEE: DECRYPT the caller with offer_key/salt, ENCRYPT ours with answer_key/salt.
 *
 * Build + loopback self-test: see build-signal-media.sh and README.md. This file compiles to both a
 * standalone test binary (main() -> --loopback / --selftest) and, via -DSIGNAL_MEDIA_NO_MAIN, an
 * object the presage bridge links against for the signal_media_* API.
 *
 * NOTE (unverified on device tonight): every ICE/pipeline caps detail below is reasoned-out, not yet
 * run against a live Signal call. The loopback self-test is the only end-to-end-verifiable piece and
 * it deliberately avoids ICE + ALSA so it can pass on any GStreamer host. TODOs are marked inline.
 */

#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <nice/agent.h>
#include <srtp2/srtp.h>   /* manual SRTP for the rtp-data (Accepted) packet -> pushed via a 2nd nicesink */
#include <glib.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <signal.h>     /* SIGBUS/SIGSEGV crash handler (temp diagnostic) */
#include <execinfo.h>   /* backtrace/backtrace_symbols_fd */
#include <unistd.h>     /* write, _exit */
#include <sys/resource.h>  /* setpriority - realtime nice for the call */
#include <sched.h>         /* SCHED_FIFO for the capture/send threads */
#include <speex/speex_echo.h>        /* SpeexDSP acoustic echo canceller */
#include <speex/speex_preprocess.h>  /* residual-echo suppression + denoise */

#include "srtp_kdf.h"
#include "signal_media.h"

/* ------------------------------------------------------------------ tunables / constants ------- */

/* Opus RTP is always 48 kHz. Payload type: RingRTC's opus PT (Signal). Left configurable; the peer
 * dictates it in a real call - TODO: parse it from the offer instead of hard-coding. Loopback uses
 * the same PT on both ends so its value doesn't matter there. */
#define SIGNAL_OPUS_PT        102
#define SIGNAL_OPUS_CLOCKRATE 48000
#define SIGNAL_OPUS_CHANNELS  1

#define SRTP_CIPHER_GCM256    "aes-256-gcm"
#define SRTP_AUTH_NULL        "null"   /* GCM is AEAD -> no separate SRTP auth transform */

/* ------------------------------------------------------------------ engine state --------------- */

typedef struct {
    GMainContext   *ctx;        /* private context the agent + bus watch live on */
    GMainLoop      *loop;
    GThread        *thread;

    NiceAgent      *agent;
    guint           stream_id;
    guint           component;  /* 1 = RTP (rtcp-mux) */

    GstElement     *pipeline;

    signal_srtp_keys keys;      /* offer_* = decrypt caller, answer_* = encrypt us */
    GstBuffer      *rx_master;  /* the master we hand srtpdec on request-key (44B) */
    /* Role. As the ANSWERER (callee, default) we DECRYPT the caller with offer_key and ENCRYPT
     * ours with answer_key. As the CALLER (outgoing) it is the mirror image: DECRYPT the answerer
     * with answer_key, ENCRYPT ours with offer_key. Both peers derive the identical offer/answer
     * keys from the same X25519 DH; only which one is RX vs TX flips. */
    gboolean        is_caller;

    signal_media_candidate_cb cand_cb;
    void           *cand_user;
    signal_media_audiod_cb    audiod_cb;
    void           *audiod_user;

    gboolean        audiod_on;
    gboolean        running;
} SignalMedia;

static SignalMedia g_sm;         /* single active call (the device rings one at a time) */
static void sm_enable_nice_debug(void);  /* fwd decl - defined near signal_media_init, called from build_ice */

/* TX gate: don't let ANY TX buffer (audio or the rtp-data Accepted) reach nicesink until ICE has a
 * validated pair (CONNECTED). Before that, nice_agent_send() can only ever fail - but the pipeline
 * doesn't know that and keeps trying at full audio-frame rate, plus the rtp-data resend thread pushing
 * too, generating THOUSANDS of failed nice_agent_send calls per call (measured: 2670 in 8s = ~330/s -
 * a spin pattern, not periodic traffic). Every one of those takes the nice agent's lock, contending
 * with the STUN conncheck processing that's trying to use that SAME lock on the SAME thread to actually
 * get the call connected. Dropping TX buffers pre-CONNECTED costs nothing (they'd never have been
 * delivered anyway) and removes that self-inflicted contention during the critical connectivity window. */
static gboolean g_ice_tx_ready = FALSE;

static GstPadProbeReturn sm_tx_gate_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)info; (void)u;
    return g_ice_tx_ready ? GST_PAD_PROBE_OK : GST_PAD_PROBE_DROP;
}

/* --- Acoustic echo cancellation (SpeexDSP) --------------------------------------------------------
 * The tablet is on speakerphone: the mic captures the far-end audio coming out of the speaker and
 * would send it back = echo. WhatsApp/Telegram cancel this inside their own engines; our GStreamer
 * engine uses SpeexDSP's echo canceller. Its split playback/capture API is built for exactly our case
 * (playback and capture on different threads): speex_echo_playback() buffers each frame we PLAY (the
 * reference); speex_echo_capture() cancels that echo out of each mic frame we CAPTURE. Both sides are
 * reframed to a fixed 10 ms (480-sample @ 48 kHz mono) buffer by an audiobuffersplit so the fixed-size
 * frames Speex requires arrive cleanly. A mutex guards the shared state (the two calls run on the RX
 * and TX streaming threads). Unlike webrtc-audio-processing (which alignment-traps this old kernel),
 * libspeexdsp is pure C, tiny, and loads fine. */
#define AEC_FRAME 480    /* 10 ms @ 48 kHz mono = the Speex frame size */
#define AEC_TAIL  4800   /* 100 ms echo tail (filter length) - covers the speakerphone loop delay */
static SpeexEchoState        *g_echo    = NULL;
static SpeexPreprocessState  *g_preproc = NULL;
static GMutex                 g_echo_lock;
static gboolean               g_echo_ready = FALSE;
/* Shared "latest played frame" = the AEC reference. The RX probe updates it; the TX probe reads it and
 * calls speex_echo_cancellation() per mic frame. Using the single-call API (not the split
 * playback/capture one) avoids the queue-underrun "No playback frame available" flood that our async
 * RX/TX clocks caused. speex keeps the tail history internally, so passing the current play frame each
 * capture is correct. */
static spx_int16_t            g_ref_frame[AEC_FRAME];
static gboolean               g_ref_valid = FALSE;

static void sm_echo_init(void)
{
    if (g_echo_ready) return;
    g_mutex_init(&g_echo_lock);
    g_ref_valid = FALSE;
    memset(g_ref_frame, 0, sizeof g_ref_frame);
    g_echo = speex_echo_state_init(AEC_FRAME, AEC_TAIL);
    if (!g_echo) { g_message("signal_media: speex_echo_state_init failed -> AEC OFF"); return; }
    int rate = SIGNAL_OPUS_CLOCKRATE;
    speex_echo_ctl(g_echo, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
    g_preproc = speex_preprocess_state_init(AEC_FRAME, rate);
    if (g_preproc) {
        speex_preprocess_ctl(g_preproc, SPEEX_PREPROCESS_SET_ECHO_STATE, g_echo);
        int on = 1;
        speex_preprocess_ctl(g_preproc, SPEEX_PREPROCESS_SET_DENOISE, &on);
    }
    g_echo_ready = TRUE;
    g_message("signal_media: SpeexDSP AEC ON (frame=%d tail=%d @ %d Hz)", AEC_FRAME, AEC_TAIL, rate);
}

static void sm_echo_free(void)
{
    if (!g_echo_ready) return;
    g_echo_ready = FALSE;
    g_mutex_lock(&g_echo_lock);
    if (g_preproc) { speex_preprocess_state_destroy(g_preproc); g_preproc = NULL; }
    if (g_echo)    { speex_echo_state_destroy(g_echo);          g_echo = NULL; }
    g_mutex_unlock(&g_echo_lock);
}

/* RX (playback) probe: stash the last 10ms of the far-end audio we're about to play as the AEC
 * reference (g_ref_frame). Buffer passes through unchanged; S16LE from rxcaps2, any size. */
static GstPadProbeReturn sm_rx_ref_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    GstBuffer *buf = GST_PAD_PROBE_INFO_BUFFER(info);
    GstMapInfo m;
    if (g_echo_ready && buf && gst_buffer_map(buf, &m, GST_MAP_READ)) {
        gsize samples = m.size / 2;
        if (samples >= (gsize)AEC_FRAME) {
            /* copy the MOST RECENT AEC_FRAME samples of this buffer as the current reference */
            const spx_int16_t *tail = (const spx_int16_t *)m.data + (samples - AEC_FRAME);
            g_mutex_lock(&g_echo_lock);
            memcpy(g_ref_frame, tail, AEC_FRAME * 2);
            g_ref_valid = TRUE;
            g_mutex_unlock(&g_echo_lock);
        }
        gst_buffer_unmap(buf, &m);
    }
    return GST_PAD_PROBE_OK;
}

/* TX (capture) probe: cancel the speaker echo out of the mic frame IN PLACE before encoding, using the
 * latest RX reference frame (silence if none yet). Fixed 480-sample buffers from the TX
 * audiobuffersplit; single-call speex_echo_cancellation (no play/capture queue -> no underrun flood). */
static GstPadProbeReturn sm_tx_aec_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    if (!g_echo_ready) return GST_PAD_PROBE_OK;
    GstBuffer *buf = gst_buffer_make_writable(GST_PAD_PROBE_INFO_BUFFER(info));
    GST_PAD_PROBE_INFO_DATA(info) = buf;   /* make_writable may have returned a new buffer */
    GstMapInfo m;
    if (buf && gst_buffer_map(buf, &m, GST_MAP_READWRITE)) {
        if (m.size >= (gsize)(AEC_FRAME * 2)) {
            spx_int16_t out[AEC_FRAME], ref[AEC_FRAME];
            g_mutex_lock(&g_echo_lock);
            if (g_echo_ready) {
                if (g_ref_valid) memcpy(ref, g_ref_frame, AEC_FRAME * 2);
                else             memset(ref, 0, AEC_FRAME * 2);   /* no playback yet -> nothing to cancel */
                speex_echo_cancellation(g_echo, (const spx_int16_t *)m.data, ref, out);
                if (g_preproc) speex_preprocess_run(g_preproc, out);
                memcpy(m.data, out, AEC_FRAME * 2);
            }
            g_mutex_unlock(&g_echo_lock);
        }
        gst_buffer_unmap(buf, &m);
    }
    return GST_PAD_PROBE_OK;
}

/* --- RingRTC rtp-data channel (the "Accepted" signal) ----------------------------------------------
 * A 1:1 RingRTC call stays "ringing" on the caller and gates ALL media until the callee sends an
 * `Accepted` message over RingRTC's RTP data channel: a tiny proto2 `rtp_data.Message{accepted{id}}`
 * carried as an RTP packet on PT 101 / SSRC 0xD, SRTP-encrypted with the same key as audio, re-sent
 * at ~1 Hz (ref: ringrtc core/connection.rs). We SRTP-encrypt the packet ourselves with libsrtp2,
 * then push the encrypted bytes into an appsrc feeding a SECOND nicesink bound to the same agent/
 * stream/component. THAT nicesink does the nice_agent_send from its own streaming thread - the only
 * sanctioned, deadlock-free send path (calling nice_agent_send ourselves, even off the media thread,
 * eventually deadlocks libnice 0.1.21's agent mutex, freezing audio + STUN; a funnel-merge into the
 * audio nicesink broke caps negotiation and killed all TX). Two nicesinks on one component each send
 * from their own thread and libnice serializes internally. signal_media_accept() (from the ACCEPT
 * stdin cmd = the user tapped Answer) turns it on. */
#define RTP_DATA_PT       101
#define RTP_DATA_SSRC     0x0000000DU
static srtp_t      g_data_srtp    = NULL;  /* TX SRTP session for the data SSRC (our TX key) */
static gboolean    g_srtp_inited  = FALSE;
static GstElement *g_datasrc      = NULL;  /* appsrc -> 2nd nicesink (that nicesink does the actual send) */
static guint64     g_accept_id    = 0;     /* RingRTC call_id -> Accepted.id */
static gboolean    g_accepted     = FALSE; /* user accepted -> keep resending */
static GThread    *g_accept_thread= NULL;  /* dedicated resend thread (NOT g_sm.ctx - see below) */
static guint16     g_data_seq     = 0;     /* RTP seq for the data stream */
static guint32     g_data_ts      = 0;     /* RTP timestamp for the data stream */

/* minimal LEB128 varint writer (proto wire type 0) */
static int sm_varint(guint8 *out, guint64 v)
{
    int i = 0;
    do { guint8 b = v & 0x7f; v >>= 7; if (v) b |= 0x80; out[i++] = b; } while (v);
    return i;
}

/* Lazily create the TX SRTP session for the data SSRC, keyed with OUR TX master (answerer=answer_key,
 * caller=offer_key) - the same key the audio srtpenc uses; different SSRC, so no keystream reuse. */
static gboolean sm_data_srtp_init(void)
{
    if (g_data_srtp) return TRUE;
    if (!g_srtp_inited) {
        /* GStreamer's srtpenc/srtpdec have already srtp_init()'d libsrtp2 (audio SRTP works), and a
         * second srtp_init() returns non-ok ("already initialized") on this build. That's NOT fatal -
         * the library is ready - so log and proceed to srtp_create rather than bailing. */
        srtp_err_status_t is = srtp_init();
        if (is != srtp_err_status_ok)
            g_message("signal_media: srtp_init returned %d (already init by gstreamer) - continuing", (int)is);
        g_srtp_inited = TRUE;
    }
    unsigned char master[SIGNAL_SRTP_MASTER_SIZE];
    const unsigned char *k = g_sm.is_caller ? g_sm.keys.offer_key  : g_sm.keys.answer_key;
    const unsigned char *s = g_sm.is_caller ? g_sm.keys.offer_salt : g_sm.keys.answer_salt;
    memcpy(master,                       k, SIGNAL_SRTP_KEY_SIZE);
    memcpy(master + SIGNAL_SRTP_KEY_SIZE, s, SIGNAL_SRTP_SALT_SIZE);
    srtp_policy_t policy;
    memset(&policy, 0, sizeof policy);
    srtp_crypto_policy_set_aes_gcm_256_16_auth(&policy.rtp);
    srtp_crypto_policy_set_aes_gcm_256_16_auth(&policy.rtcp);
    policy.ssrc.type  = ssrc_specific;
    policy.ssrc.value = RTP_DATA_SSRC;
    policy.key        = master;
    policy.next       = NULL;
    if (srtp_create(&g_data_srtp, &policy) != srtp_err_status_ok) {
        g_message("signal_media: srtp_create(data) failed"); g_data_srtp = NULL; return FALSE;
    }
    return TRUE;
}

/* Build one rtp_data.Message{ accepted{id=call_id}, seqnum }, SRTP-encrypt it, send it out the nice
 * component. Runs only on the media thread. */
static void sm_push_accepted(void)
{
    if (!g_accepted || !g_datasrc || !sm_data_srtp_init()) return;
    /* proto: Accepted{ id(1,varint) } */
    guint8 acc[16]; int an = 0;
    acc[an++] = 0x08; an += sm_varint(acc + an, g_accept_id);
    /* proto: Message{ accepted(1,LEN), seqnum(4,varint) } */
    guint8 body[48]; int bn = 0;
    body[bn++] = 0x0A; body[bn++] = (guint8)an; memcpy(body + bn, acc, an); bn += an;
    static guint64 seqnum = 0; seqnum++;
    body[bn++] = 0x20; bn += sm_varint(body + bn, seqnum);
    /* 12-byte RTP header + payload, with slack for the GCM tag srtp_protect appends in place */
    guint8 pkt[12 + 48 + SRTP_MAX_TRAILER_LEN];
    pkt[0] = 0x80; pkt[1] = RTP_DATA_PT;
    g_data_seq++; pkt[2] = (guint8)(g_data_seq >> 8); pkt[3] = (guint8)g_data_seq;
    g_data_ts++;  pkt[4] = (guint8)(g_data_ts >> 24); pkt[5] = (guint8)(g_data_ts >> 16);
                  pkt[6] = (guint8)(g_data_ts >> 8);  pkt[7] = (guint8)g_data_ts;
    pkt[8] = 0; pkt[9] = 0; pkt[10] = 0; pkt[11] = 0x0D;   /* SSRC = 0x0000000D */
    memcpy(pkt + 12, body, bn);
    int len = 12 + bn;
    srtp_err_status_t st = srtp_protect(g_data_srtp, pkt, &len);
    if (st != srtp_err_status_ok) { g_message("signal_media: srtp_protect(data) failed %d", (int)st); return; }
    /* Hand the SRTP-encrypted bytes to the 2nd nicesink via its appsrc. That nicesink calls
     * nice_agent_send on its OWN streaming thread - never us - so no agent-mutex deadlock. */
    GstBuffer *buf = gst_buffer_new_allocate(NULL, len, NULL);
    gst_buffer_fill(buf, 0, pkt, (gsize)len);
    GstFlowReturn fr = gst_app_src_push_buffer(GST_APP_SRC(g_datasrc), buf);  /* takes ownership */
    static int logged = 0;
    if (logged < 3) { g_message("signal_media: pushed rtp-data Accepted (%d enc bytes) -> appsrc flow=%d", len, (int)fr); logged++; }
}

/* Dedicated resend thread. CRITICAL: nice_agent_send() must NOT be called from the agent's own
 * GMainContext (g_sm.ctx) - doing so self-deadlocks on the agent mutex in libnice 0.1.21, which froze
 * BOTH the media thread (no more STUN consent responses) AND nicesink's audio (also nice_agent_send),
 * so the peer saw us go silent and hung up ~2-5s in. Sending from a separate thread is exactly what
 * gstnicesink does from its streaming thread, and is safe. This thread also owns g_data_srtp, so
 * srtp_protect is never hit concurrently. */
static gpointer accept_thread_fn(gpointer u)
{
    (void)u;
    while (g_accepted) {
        sm_push_accepted();
        g_usleep(500 * 1000);   /* ~1-2 Hz resend, like RingRTC */
    }
    return NULL;
}

/* The user tapped Answer (ACCEPT stdin cmd): start emitting the RingRTC Accepted so the caller's phone
 * stops ringing and both sides ungate audio. Idempotent. */
void signal_media_accept(guint64 call_id)
{
    g_accept_id = call_id;
    if (g_accepted) return;         /* already emitting */
    g_accepted = TRUE;
    g_accept_thread = g_thread_new("sig-accept", accept_thread_fn, NULL);
    g_message("signal_media: ACCEPT call_id=%" G_GUINT64_FORMAT " -> emitting rtp-data Accepted", call_id);
}

/* STUN/TURN relays for the nice agent, populated from RELAY lines (Signal's /v2/calling/relays,
 * fetched by the presage bridge) BEFORE the START line. Kept out of SignalMedia because
 * signal_media_start() memsets g_sm; build_ice() applies these to the agent before it gathers, so
 * we get srflx/relay candidates instead of host-only (which never traverse NAT to a remote peer). */
#define SM_MAX_TURN 8
typedef struct {
    char          host[64];
    int           port;
    char          user[128];
    char          pass[256];
    NiceRelayType type;
} SmTurn;
static char   g_stun_host[64];
static int    g_stun_port;
static SmTurn g_turn[SM_MAX_TURN];
static int    g_n_turn;

/* TEMP crash-trail: writes to a dedicated file (independent of the stderr redirect) so we can see
 * exactly how far ICE setup gets when the engine segfaults on a live call. Remove once TURN is stable. */
static void sm_trace(const char *msg)
{
    FILE *f = fopen("/media/internal/sm_trace.log", "a");
    if (f) { fputs(msg, f); fputc('\n', f); fclose(f); }
}
static gsize       g_inited = 0; /* gst_init once */

/* ------------------------------------------------------------------ small helpers -------------- */

static GstBuffer *master_key_buffer(const unsigned char *key32, const unsigned char *salt12)
{
    GstBuffer *buf = gst_buffer_new_and_alloc(SIGNAL_SRTP_MASTER_SIZE);
    GstMapInfo map;
    if (!gst_buffer_map(buf, &map, GST_MAP_WRITE)) { gst_buffer_unref(buf); return NULL; }
    memcpy(map.data,                       key32,  SIGNAL_SRTP_KEY_SIZE);
    memcpy(map.data + SIGNAL_SRTP_KEY_SIZE, salt12, SIGNAL_SRTP_SALT_SIZE);
    gst_buffer_unmap(buf, &map);
    return buf;
}

static GstElement *mk(const char *factory, const char *name)
{
    GstElement *e = gst_element_factory_make(factory, name);
    if (!e) g_printerr("signal_media: missing GStreamer element '%s' (need its plugin on device)\n", factory);
    return e;
}

/* srtpenc/srtpdec want AEAD_AES_256_GCM on both RTP and RTCP, no extra auth transform.
 * NOTE: rtp-cipher/rtp-auth/rtcp-cipher/rtcp-auth are GEnum properties. g_object_set() varargs
 * read a GEnum as an *integer*, so passing the string nick "aes-256-gcm" reinterprets the char*
 * pointer as an int and silently keeps the default (AES-128-ICM, 30-byte key) -> srtpenc then
 * rejects our 44-byte GCM master key ("Master key size is wrong"). Use gst_util_set_object_arg(),
 * which parses the string nick against the enum, for those four properties. "key" is a boxed
 * GstBuffer and is set the normal way. */
static void configure_srtpenc(GstElement *enc, GstBuffer *master)
{
    g_object_set(enc, "key", master, NULL);
    gst_util_set_object_arg(G_OBJECT(enc), "rtp-cipher",  SRTP_CIPHER_GCM256);
    gst_util_set_object_arg(G_OBJECT(enc), "rtp-auth",    SRTP_AUTH_NULL);
    gst_util_set_object_arg(G_OBJECT(enc), "rtcp-cipher", SRTP_CIPHER_GCM256);
    gst_util_set_object_arg(G_OBJECT(enc), "rtcp-auth",   SRTP_AUTH_NULL);
}

/* srtpdec has no static key property: it fires "request-key" per SSRC and we return the caps
 * describing the master key + cipher/auth. Single stream -> same key for every SSRC. */
static GstCaps *on_srtpdec_request_key(GstElement *dec, guint ssrc, gpointer user)
{
    (void)dec;
    SignalMedia *sm = (SignalMedia *)user;
    /* srtpdec only asks for a key once it SEES an SRTP packet for that SSRC -> inbound media from
     * the peer is actually arriving (ICE connected + the peer is sending). Key milestone. */
    g_message("signal_media: srtpdec request-key for ssrc %u (inbound SRTP arriving)", ssrc);
    if (!sm->rx_master) return NULL;
    GstCaps *caps = gst_caps_new_simple("application/x-srtp",
                                        "srtp-cipher",  G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtp-auth",    G_TYPE_STRING, SRTP_AUTH_NULL,
                                        "srtcp-cipher", G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtcp-auth",   G_TYPE_STRING, SRTP_AUTH_NULL,
                                        NULL);
    /* gst_caps_set_simple takes ownership of neither the caps ref-count nor the buffer; ref buffer. */
    gst_caps_set_simple(caps, "srtp-key", GST_TYPE_BUFFER, gst_buffer_ref(sm->rx_master), NULL);
    return caps;
}

/* The RTP caps that describe the inner Opus stream (needed so rtpopusdepay/srtpdec agree). */
static GstCaps *opus_rtp_caps(void)
{
    return gst_caps_new_simple("application/x-rtp",
                               "media",         G_TYPE_STRING, "audio",
                               "clock-rate",    G_TYPE_INT,    SIGNAL_OPUS_CLOCKRATE,
                               "encoding-name", G_TYPE_STRING, "OPUS",
                               "payload",       G_TYPE_INT,    SIGNAL_OPUS_PT,
                               NULL);
}

/* ------------------------------------------------------------------ bus watch ------------------ */

static gboolean on_bus(GstBus *bus, GstMessage *msg, gpointer user)
{
    (void)bus;
    SignalMedia *sm = (SignalMedia *)user;
    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_ERROR: {
            GError *err = NULL; gchar *dbg = NULL;
            gst_message_parse_error(msg, &err, &dbg);
            g_printerr("signal_media: pipeline ERROR from %s: %s (%s)\n",
                       GST_OBJECT_NAME(msg->src), err ? err->message : "?", dbg ? dbg : "");
            if (err) g_error_free(err);
            g_free(dbg);
            break;
        }
        case GST_MESSAGE_STATE_CHANGED:
            if (GST_MESSAGE_SRC(msg) == GST_OBJECT(sm->pipeline)) {
                GstState olds, news;
                gst_message_parse_state_changed(msg, &olds, &news, NULL);
                if (news == GST_STATE_PLAYING && !sm->audiod_on) {
                    g_message("signal_media: pipeline PLAYING (audio TX/RX up, audiod notified)");
                    sm->audiod_on = TRUE;
                    if (sm->audiod_cb) sm->audiod_cb(1, sm->audiod_user);  /* tell audiod: voip call up */
                }
            }
            break;
        default: break;
    }
    return TRUE;
}

/* ------------------------------------------------------------------ ICE (libnice) -------------- */

static void on_nice_candidate(NiceAgent *agent, NiceCandidate *cand, gpointer user)
{
    SignalMedia *sm = (SignalMedia *)user;
    if (!sm->cand_cb) return;
    gchar *sdp = nice_agent_generate_local_candidate_sdp(agent, cand);
    if (sdp) {
        /* libnice emits the SDP attribute form "a=candidate:...", but Signal's IceCandidate opaque
         * carries the bare "candidate:..." line (verified vs a real capture). Strip the "a=". */
        const char *bare = (strncmp(sdp, "a=", 2) == 0) ? sdp + 2 : sdp;
        g_message("signal_media: LOCAL candidate -> %s", bare);
        sm->cand_cb(bare, sm->cand_user);   /* bridge -> Signal IceUpdate */
        g_free(sdp);
    }
}

static void on_nice_gathering_done(NiceAgent *agent, guint stream_id, gpointer user)
{
    (void)agent; (void)stream_id; (void)user;
    g_message("signal_media: ICE local candidate gathering done");
}

static void on_nice_state(NiceAgent *agent, guint stream_id, guint component_id,
                          guint state, gpointer user)
{
    (void)user;
    g_message("signal_media: ICE component state -> %s", nice_component_state_to_string(state));
    /* Open the TX gate the instant we have a validated pair - don't wait for full READY (which can take
     * longer to settle); CONNECTED already means media can flow. Close it again on FAILED/DISCONNECTED
     * so a later reconnect doesn't resume sending against a dead pair. */
    if (state == NICE_COMPONENT_STATE_CONNECTED || state == NICE_COMPONENT_STATE_READY)
        g_ice_tx_ready = TRUE;
    else if (state == NICE_COMPONENT_STATE_FAILED || state == NICE_COMPONENT_STATE_DISCONNECTED)
        g_ice_tx_ready = FALSE;
    /* On CONNECTED/READY, log the nominated pair so we can confirm which candidates actually paired
     * (host/srflx/relay) - the difference between "gathered candidates" and "media can flow". */
    if (state == NICE_COMPONENT_STATE_CONNECTED || state == NICE_COMPONENT_STATE_READY) {
        NiceCandidate *lc = NULL, *rc = NULL;
        if (nice_agent_get_selected_pair(agent, stream_id, component_id, &lc, &rc) && lc && rc) {
            gchar *ls = nice_agent_generate_local_candidate_sdp(agent, lc);
            gchar *rs = nice_agent_generate_local_candidate_sdp(agent, rc);
            g_message("signal_media: ICE SELECTED PAIR local[%s] remote[%s]",
                      ls ? ls : "?", rs ? rs : "?");
            g_free(ls); g_free(rs);
        }
    }
    /* On NICE_COMPONENT_STATE_FAILED the bridge should hang the call up; surfaced via the log. */
}

/* Build the NiceAgent, one stream / one RTP component, our + remote credentials, start gathering. */
static gboolean build_ice(SignalMedia *sm, const char *our_ufrag, const char *our_pwd,
                          const char *remote_ufrag, const char *remote_pwd)
{
    /* RFC5245 full ICE, controlled role is set implicitly (we are the answerer). Using the private
     * context so all agent signals fire on our media thread. */
    sm_trace("build_ice: enter");
    sm_enable_nice_debug();   /* before nice_agent_new so nice_debug_init() (called from agent init) sees it */
    sm->agent = nice_agent_new(sm->ctx, NICE_COMPATIBILITY_RFC5245);
    if (!sm->agent) { g_printerr("signal_media: nice_agent_new failed\n"); return FALSE; }
    sm_trace("build_ice: agent created");

    /* ICE role: the CALLER (offerer) is CONTROLLING, the answerer is CONTROLLED. */
    g_object_set(sm->agent, "controlling-mode", sm->is_caller ? TRUE : FALSE, NULL);
    g_message("signal_media: role=%s controlling-mode=%d",
              sm->is_caller ? "CALLER" : "ANSWERER", sm->is_caller ? 1 : 0);

    /* THE incoming-call fix (2026-07-29): Signal's peer is RingRTC (libwebrtc), which nominates the
     * selected pair using Google's proprietary ICE RENOMINATION extension - a STUN NOMINATION attr
     * (0xC001), NOT the standard USE-CANDIDATE. Proven via tcpdump: every inbound BindReq carried
     * GOOG-NOMINATION=1/3 and never USE-CANDIDATE, so our controlled answerer formed a valid pair but
     * libnice never nominated it -> ICE timed out to FAILED. libnice 0.1.21 already implements this
     * (conn_check_handle_renomination), gated behind support-renomination which defaults FALSE. Enable
     * it so the answerer honours RingRTC's nomination. Harmless for the caller (we drive nomination). */
    g_object_set(sm->agent, "support-renomination", TRUE, NULL);

    /* Keepalive as STUN binding REQUESTS, not indications. After ICE reaches READY, libnice's default
     * keepalive is a STUN binding *indication* (no reply expected). RingRTC/libwebrtc runs RFC7675
     * consent freshness and drops the call within seconds if the selected pair looks idle - our
     * indications don't satisfy it. keepalive-conncheck=TRUE makes libnice send binding *requests*
     * (which draw responses), keeping the peer's consent fresh so it doesn't tear the call down. */
    g_object_set(sm->agent, "keepalive-conncheck", TRUE, NULL);

    /* Cut candidate/conncheck load to match Teams' (reliable) approach on this same device/AP.
     * Teams' NGC calling deliberately uses a SINGLE relay path, not full ICE (see
     * TEAMS_MEDIA_ADAPTATION.md "single MS-TURN relay ... not full ICE") - and it connects reliably
     * over the identical WiFi hardware where Signal's full trickle-ICE (host x2 + srflx x2 + relay x6+
     * = 10-20 simultaneous candidate pairs, each independently retrying STUN checks every 500ms) was
     * seeing its connectivity checks go completely unanswered. That strongly points to burst/volume
     * (many simultaneous small UDP flows) rather than raw link quality - so shrink the candidate set:
     *   - ice-tcp=FALSE: drop TCP host/srflx candidates. We've never seen a TCP pair succeed anyway
     *     (this device doesn't do real ICE-TCP), so they're pure wasted conncheck traffic.
     *   - force-relay=TRUE: skip host/srflx UDP entirely, gather ONLY relay candidates - i.e. do what
     *     Teams does (one relay path) instead of racing many simultaneous pairs. */
    g_object_set(sm->agent, "ice-tcp", FALSE, NULL);
    g_object_set(sm->agent, "force-relay", TRUE, NULL);
    g_message("signal_media: ice-tcp=off force-relay=on (matching Teams' single-relay-path approach)");

    sm_trace("build_ice: role set");

    /* STUN (agent-global): gathers server-reflexive (srflx) candidates so we learn our public
     * ip:port behind NAT. Signal feeds this via a RELAY line before START. Set before gathering. */
    if (g_stun_port) {
        sm_trace("build_ice: setting STUN");
        g_object_set(sm->agent, "stun-server", g_stun_host,
                     "stun-server-port", (guint)g_stun_port, NULL);
        g_message("signal_media: STUN server %s:%d", g_stun_host, g_stun_port);
        sm_trace("build_ice: STUN set");
    }

    sm->component = 1;
    sm->stream_id = nice_agent_add_stream(sm->agent, 1 /* rtcp-mux -> single component */);
    if (!sm->stream_id) { g_printerr("signal_media: add_stream failed\n"); return FALSE; }
    sm_trace("build_ice: stream added");

    /* TURN relays (per component): Signal RELAYS all calls for IP privacy, so relay candidates are
     * how the two peers actually reach each other. Must be set after add_stream, before gather. */
    {
        char tb[128];
        snprintf(tb, sizeof tb, "build_ice: applying %d TURN relay(s)", g_n_turn);
        sm_trace(tb);
    }
    for (int i = 0; i < g_n_turn; i++) {
        SmTurn *t = &g_turn[i];
        char tb[256];
        snprintf(tb, sizeof tb, "build_ice: set_relay_info[%d] %s:%d type=%d ulen=%zu plen=%zu",
                 i, t->host, t->port, (int)t->type, strlen(t->user), strlen(t->pass));
        sm_trace(tb);
        if (nice_agent_set_relay_info(sm->agent, sm->stream_id, sm->component,
                                      t->host, (guint)t->port,
                                      t->user, t->pass, t->type))
            g_message("signal_media: TURN relay %s:%d type=%d", t->host, t->port, (int)t->type);
        else
            g_printerr("signal_media: set_relay_info failed for %s:%d\n", t->host, t->port);
        sm_trace("build_ice: set_relay_info done");
    }

    if (our_ufrag && our_pwd)
        nice_agent_set_local_credentials(sm->agent, sm->stream_id, our_ufrag, our_pwd);
    if (remote_ufrag && remote_pwd)
        nice_agent_set_remote_credentials(sm->agent, sm->stream_id, remote_ufrag, remote_pwd);

    g_signal_connect(sm->agent, "new-candidate-full",       G_CALLBACK(on_nice_candidate),      sm);
    g_signal_connect(sm->agent, "candidate-gathering-done", G_CALLBACK(on_nice_gathering_done), sm);
    g_signal_connect(sm->agent, "component-state-changed",  G_CALLBACK(on_nice_state),          sm);

    /* NOTE: nice_agent_gather_candidates() (opens nice's UDP sockets) is intentionally NOT called here
     * - see sm_start_gathering() and its call site in signal_media_start() for why. */
    return TRUE;
}

/* Actually start ICE gathering: opens libnice's UDP sockets and kicks off STUN/TURN discovery. Split
 * out of build_ice() and called AFTER build_pipeline()'s ALSA devices are opened (PLAYING state) - see
 * signal_media_start(). Root-caused via NICE_DEBUG: "agent_recv_message_unlocked returned -1, errno
 * (25): Inappropriate ioctl for device" on 2-3 of the ICE UDP sockets a few hundred ms into gathering,
 * which made libnice silently DETACH those sockets (no more responses ever read on them) - explaining
 * "we send checks, peer replies, but we never see anything". ENOTTY on a UDP socket is the classic
 * signature of an fd NUMBER getting reused for a different resource while a GSource still references
 * the old fd. The previous ordering created nice's sockets (build_ice, fds allocated) BEFORE the
 * GMainLoop that services them existed (that only starts after build_pipeline + gst_element_set_state
 * PLAYING, which is exactly when ALSA opens /dev/snd device nodes - heavy fd churn), leaving a window
 * where nice's just-opened socket fds could collide with fds ALSA opens/closes moments later. Opening
 * nice's sockets AFTER ALSA's device-open churn has already settled removes that overlap window. */
static gboolean sm_start_gathering(SignalMedia *sm)
{
    if (!nice_agent_gather_candidates(sm->agent, sm->stream_id)) {
        g_printerr("signal_media: gather_candidates failed\n");
        return FALSE;
    }
    return TRUE;
}

/* ------------------------------------------------------------------ pipeline ------------------- */

static gboolean build_pipeline(SignalMedia *sm)
{
    sm->pipeline = gst_pipeline_new("signal-call");

    /* -------- RX: nicesrc -> srtpdec -> rtpopusdepay -> opusdec -> alsasink device=voip -------- */
    GstElement *nsrc   = mk("nicesrc",       "rx-nicesrc");
    GstElement *rxcaps = mk("capsfilter",    "rx-srtpcaps");   /* label bytes as x-srtp for srtpdec */
    GstElement *sdec   = mk("srtpdec",       "rx-srtpdec");
    GstElement *rxrtp  = mk("capsfilter",    "rx-rtpcaps");    /* describe the inner Opus RTP stream */
    GstElement *rxjb   = mk("rtpjitterbuffer","rx-jitterbuf"); /* reorder/dejitter + PLC -> smooth audio */
    GstElement *depay  = mk("rtpopusdepay",  "rx-depay");
    GstElement *odec   = mk("opusdec",       "rx-opusdec");
    GstElement *aconv  = mk("audioconvert",  "rx-aconv");
    /* AEC reference tap: rxcaps2 forces S16LE/48k/mono; a read probe on it stashes the latest played
     * frame as the echo reference. Audio still flows straight to the sink (no reframing needed). */
    GstElement *rxcaps2= mk("capsfilter",     "rx-aeccaps");
    GstElement *asink  = mk("alsasink",      "rx-alsasink");
    GstElement *rxrtcp = mk("fakesink",      "rx-rtcp-drain");  /* drain srtpdec rtcp_src (rtcp-mux) */

    /* -------- TX: alsasrc device=voipsource -> opusenc -> rtpopuspay -> srtpenc -> nicesink ----- */
    GstElement *asrc   = mk("alsasrc",       "tx-alsasrc");
    GstElement *txconv = mk("audioconvert",  "tx-aconv");
    GstElement *txre   = mk("audioresample", "tx-ares");
    GstElement *txcaps = mk("capsfilter",    "tx-rawcaps");    /* force 48k/mono for opusenc */
    /* AEC on the mic: txsplit reframes to fixed 10ms buffers, a probe runs speex_echo_capture in-place
     * to subtract the speaker echo (referenced from the RX probe) before we encode. */
    GstElement *txsplit= mk("audiobuffersplit","tx-aecsplit");
    GstElement *oenc   = mk("opusenc",       "tx-opusenc");
    GstElement *pay    = mk("rtpopuspay",    "tx-pay");
    GstElement *senc   = mk("srtpenc",       "tx-srtpenc");
    GstElement *nsink  = mk("nicesink",      "tx-nicesink");
    /* rtp-data (Accepted) TX: appsrc (pre-SRTP-encrypted x-srtp bytes) -> funnel -> the SINGLE audio
     * nicesink. There must be exactly ONE nicesink: two concurrent nice_agent_send callers on one
     * libnice 0.1.21 agent deadlock the agent (proven via pcap - audio, data AND STUN all froze at
     * once with two nicesinks). The funnel merges the occasional data buffer into the audio SRTP
     * stream so a single nicesink sends everything. */
    GstElement *dsrc   = mk("appsrc",        "tx-datasrc");
    GstElement *funnel = mk("funnel",        "tx-funnel");
    /* CRITICAL: a queue between funnel and nicesink. A funnel merges pads but does NOT serialize
     * threads - each upstream branch (audio srtpenc thread, data appsrc task thread) pushes through to
     * the sink ON ITS OWN THREAD, so nicesink.render (-> nice_agent_send) runs from TWO threads and
     * deadlocks libnice's agent (proven: audio+data+STUN all froze ~1s in). The queue's src pad has a
     * single task thread that drives everything downstream of it, so the nicesink - and thus the one
     * nice_agent_send caller - always runs on that ONE thread. Single sender = no deadlock. */
    GstElement *txq    = mk("queue",         "tx-queue");
    /* Leaky downstream + shallow: a full blocking queue back-pressures the alsasrc mic ("Can't record
     * audio fast enough / Dropped N samples / DISCONT"), which wrecks the call in ~3s. Drop old egress
     * buffers instead of ever stalling capture; a live call would rather lose a few ms than wedge. */
    if (txq) g_object_set(txq, "leaky", 2 /*downstream*/, "max-size-time", (guint64)100000000 /*100ms*/,
                          "max-size-buffers", 0, "max-size-bytes", 0, NULL);

    if (!nsrc || !rxcaps || !sdec || !rxrtp || !rxjb || !depay || !odec || !aconv || !asink || !rxrtcp ||
        !asrc || !txconv || !txre || !txcaps || !oenc || !pay || !senc || !nsink || !dsrc || !funnel || !txq) {
        if (sm->pipeline) { gst_object_unref(sm->pipeline); sm->pipeline = NULL; }
        return FALSE;
    }
    /* AEC is optional: it needs audiobuffersplit (for the fixed 10ms frames Speex wants) on both RX and
     * TX. If that element is missing, run without echo cancellation rather than fail the call. */
    /* AEC is OPT-IN via /media/internal/signal_aec. It works (SpeexDSP loads + cancels) but 48 kHz
     * echo cancellation is too CPU-heavy for the TouchPad - it starves the mic (drops ~320ms of samples)
     * and the ICE thread, breaking the call. Off by default so calls work; enable the gate file only to
     * test a future lighter (16 kHz) AEC. */
    gboolean g_have_aec = (rxcaps2 != NULL && txsplit != NULL) &&
                          (access("/media/internal/signal_aec", F_OK) == 0);
    if (g_have_aec) {
        sm_echo_init();
        g_have_aec = g_echo_ready;   /* speex init could still fail */
    }
    if (!g_have_aec)
        g_message("signal_media: AEC OFF (gate /media/internal/signal_aec absent, or unavailable)");

    /* nice binding: RX nicesrc + TX audio nicesink + TX data nicesink all share the one component. */
    g_object_set(nsrc,  "agent", sm->agent, "stream", sm->stream_id, "component", sm->component, NULL);
    /* sync=FALSE async=FALSE: this is a live-call RTP egress - send as captured, and NEVER wait for
     * preroll. CRITICAL after adding the funnel + non-live data appsrc: with the default async=TRUE the
     * sink stalled in PAUSED for ~55s waiting to preroll the mixed live(audio)/non-live(data) funnel
     * input, so nothing (audio OR the Accepted) went out until far too late and the caller timed out at
     * 60s. async=FALSE makes the pipeline reach PLAYING immediately and send from the first buffer. */
    g_object_set(nsink, "agent", sm->agent, "stream", sm->stream_id, "component", sm->component,
                 "sync", FALSE, "async", FALSE, NULL);
    /* data appsrc emits already-SRTP-encrypted packets (application/x-srtp, matching srtpenc's output).
     * is-live=FALSE is CRITICAL: a live appsrc that produces nothing until the user accepts blocks the
     * pipeline's preroll -> PLAYING never happens -> NO audio (the earlier funnel attempt's bug). With
     * is-live=FALSE the audio branch drives preroll and the data appsrc just injects buffers when they
     * come. do-timestamp stamps them with running time. */
    { GstCaps *dc = gst_caps_new_empty_simple("application/x-srtp");
      g_object_set(dsrc, "caps", dc, "is-live", FALSE, "format", GST_FORMAT_TIME,
                   "do-timestamp", TRUE, "stream-type", 0, NULL);
      gst_caps_unref(dc); }
    g_datasrc = dsrc;

    /* RX caps + keys */
    { GstCaps *c = gst_caps_new_empty_simple("application/x-srtp");
      g_object_set(rxcaps, "caps", c, NULL); gst_caps_unref(c); }
    g_signal_connect(sdec, "request-key", G_CALLBACK(on_srtpdec_request_key), sm);
    { GstCaps *c = opus_rtp_caps(); g_object_set(rxrtp, "caps", c, NULL); gst_caps_unref(c); }
    /* jitter buffer: reorder out-of-order RTP, absorb network jitter, and conceal lost packets (do-lost
     * -> the opus decoder gets PLC gaps instead of garbled/choppy audio). 120ms is a good voice latency.
     * No RTCP is wired (rtcp-mux RTCP is drained), so it runs in buffer-only mode - fine for audio. */
    g_object_set(rxjb, "latency", 120, "do-lost", TRUE, "mode", 1 /*slave/low-latency*/, NULL);
    g_object_set(asink, "device", "voip", "sync", FALSE, NULL);
    g_object_set(rxrtcp, "sync", FALSE, "async", FALSE, NULL);  /* never stall the pipeline */

    if (g_have_aec) {
        /* AEC reference (RX) caps: S16LE/48k/mono; a read probe stashes the latest played frame. */
        GstCaps *c = gst_caps_new_simple("audio/x-raw",
                                         "format",   G_TYPE_STRING, "S16LE",
                                         "rate",     G_TYPE_INT,    SIGNAL_OPUS_CLOCKRATE,
                                         "channels", G_TYPE_INT,    SIGNAL_OPUS_CHANNELS, NULL);
        g_object_set(rxcaps2, "caps", c, NULL); gst_caps_unref(c);
        /* TX mic reframed to exactly AEC_FRAME (10ms = 1/100s) buffers so the probe can cancel in place. */
        g_object_set(txsplit, "output-buffer-duration", 1, 100, NULL);
        { GstPad *p = gst_element_get_static_pad(rxcaps2, "src");
          gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_rx_ref_probe, NULL, NULL);
          gst_object_unref(p); }
        { GstPad *p = gst_element_get_static_pad(txsplit, "src");
          gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_tx_aec_probe, NULL, NULL);
          gst_object_unref(p); }
    }

    /* TX caps + keys */
    { GstCaps *c = gst_caps_new_simple("audio/x-raw",
                                       "format",   G_TYPE_STRING, "S16LE",
                                       "rate",     G_TYPE_INT,    SIGNAL_OPUS_CLOCKRATE,
                                       "channels", G_TYPE_INT,    SIGNAL_OPUS_CHANNELS, NULL);
      g_object_set(txcaps, "caps", c, NULL); gst_caps_unref(c); }
    /* alsasrc: bigger ring + provide-clock off so a momentary scheduling hiccup doesn't overrun the
     * mic ("Can't record audio fast enough"). buffer-time 200ms, latency-time 40ms. */
    g_object_set(asrc, "device", "voipsource",
                 "buffer-time", (gint64)200000, "latency-time", (gint64)40000,
                 "provide-clock", FALSE, NULL);
    /* opusenc: complexity 0/24k was an emergency cut for the mic overrun, but the realtime-priority fix
     * (setpriority in signal_media_init) removed that CPU pressure, so raise quality now that we have
     * headroom: complexity 5 + 32 kbps + inband FEC (resilient to the packet loss that garbled audio).
     * complexity/bitrate/percentage are ints; audio-type is a GEnum set via string nick. */
    g_object_set(oenc, "complexity", 5, "bitrate", 32000,
                 "inband-fec", TRUE, "packet-loss-percentage", 10, NULL);
    gst_util_set_object_arg(G_OBJECT(oenc), "audio-type", "voice");
    g_object_set(pay,  "pt", SIGNAL_OPUS_PT, NULL);
    /* TX (encrypt our stream): answerer uses answer_key, caller uses offer_key. The rtp-data Accepted
     * packet is SRTP-encrypted separately (sm_data_srtp_init) with this same key + a disjoint SSRC. */
    { GstBuffer *tx_master = sm->is_caller
          ? master_key_buffer(sm->keys.offer_key,  sm->keys.offer_salt)
          : master_key_buffer(sm->keys.answer_key, sm->keys.answer_salt);
      configure_srtpenc(senc, tx_master);
      gst_buffer_unref(tx_master); /* srtpenc took its own ref via g_object_set */ }

    gst_bin_add_many(GST_BIN(sm->pipeline),
                     nsrc, rxcaps, sdec, rxrtp, rxjb, depay, odec, aconv, asink, rxrtcp,
                     asrc, txconv, txre, txcaps, oenc, pay, senc, nsink, dsrc, funnel, txq, NULL);
    if (g_have_aec)
        gst_bin_add_many(GST_BIN(sm->pipeline), rxcaps2, txsplit, NULL);

    /* srtpdec has STATIC/ALWAYS pads: rtp_src (decrypted RTP) and rtcp_src (decrypted RTCP). Link the
     * main RTP chain statically (rtp_src -> rxrtp -> depay -> ...). CRITICAL: with rtcp-mux the peer
     * sends RTP AND RTCP on the single socket, so nicesrc feeds both into srtpdec.rtp_sink; srtpdec
     * routes the RTCP packets to rtcp_src (gst_srtp_dec_chain: is_rtcp -> rtcp_srcpad). If rtcp_src is
     * unlinked that push returns GST_FLOW_NOT_LINKED, which stops the whole RX stream ("not-linked")
     * the instant real media arrives -> call dropped. Loopback never hit this (it sends no RTCP).
     * Drain rtcp_src into a fakesink so RTCP is discarded and RTP keeps flowing. */
    /* RX: ...odec -> aconv -> [rxcaps2(S16LE, probe stashes reference) ->] alsasink. Audio plays as
     * normal; the probe just observes the played frames for the AEC reference. */
    if (g_have_aec) {
        if (!gst_element_link_many(nsrc, rxcaps, sdec, rxrtp, rxjb, depay, odec, aconv, rxcaps2, asink, NULL)) {
            g_printerr("signal_media: RX link (with AEC reference) failed\n"); return FALSE;
        }
    } else if (!gst_element_link_many(nsrc, rxcaps, sdec, rxrtp, rxjb, depay, odec, aconv, asink, NULL)) {
        g_printerr("signal_media: RX link failed\n"); return FALSE;
    }
    if (!gst_element_link_pads(sdec, "rtcp_src", rxrtcp, "sink")) {
        g_printerr("signal_media: RX rtcp_src -> fakesink link failed\n"); return FALSE;
    }
    /* audio: alsasrc -> aconv -> ares -> txcaps -> [txsplit(10ms, probe=speex_echo_capture in-place) ->]
     * opusenc -> pay -> srtpenc -> funnel; data: appsrc -> funnel; funnel -> queue -> the single
     * nicesink. The txsplit's probe subtracts the speaker echo from each mic frame before encoding. */
    if (g_have_aec) {
        if (!gst_element_link_many(asrc, txconv, txre, txcaps, txsplit, oenc, pay, senc, funnel, txq, nsink, NULL)) {
            g_printerr("signal_media: TX (audio, with AEC) link failed\n"); return FALSE;
        }
    } else if (!gst_element_link_many(asrc, txconv, txre, txcaps, oenc, pay, senc, funnel, txq, nsink, NULL)) {
        g_printerr("signal_media: TX (audio) link failed\n"); return FALSE;
    }
    if (!gst_element_link(dsrc, funnel)) {
        g_printerr("signal_media: TX (data) link failed\n"); return FALSE;
    }

    /* TX gate: drop every buffer (audio AND the rtp-data Accepted, both flow through txq before
     * nicesink) until ICE is CONNECTED - see sm_tx_gate_probe's comment. */
    g_ice_tx_ready = FALSE;
    { GstPad *p = gst_element_get_static_pad(txq, "src");
      gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_tx_gate_probe, NULL, NULL);
      gst_object_unref(p); }

    GstBus *bus = gst_pipeline_get_bus(GST_PIPELINE(sm->pipeline));
    GSource *src = gst_bus_create_watch(bus);
    g_source_set_callback(src, (GSourceFunc)on_bus, sm, NULL);
    g_source_attach(src, sm->ctx);   /* watch fires on the media thread */
    g_source_unref(src);
    gst_object_unref(bus);
    return TRUE;
}

/* ------------------------------------------------------------------ media thread --------------- */

static gpointer media_thread(gpointer data)
{
    SignalMedia *sm = (SignalMedia *)data;
    g_main_context_push_thread_default(sm->ctx);
    g_main_loop_run(sm->loop);
    g_main_context_pop_thread_default(sm->ctx);
    return NULL;
}

/* ------------------------------------------------------------------ public API ----------------- */

/* Crash handler: on SIGBUS/SIGSEGV, log the faulting address + a backtrace to stderr (-> the engine's
 * sigmedia_call.log) so we can see the exact crashing frame instead of a truncated minicore. Temp
 * diagnostic. Uses async-signal-unsafe backtrace_symbols_fd but we're already crashing. */
static void sm_crash_handler(int sig, siginfo_t *si, void *uctx)
{
    (void)uctx;
    void *bt[32];
    int n = backtrace(bt, 32);
    char hdr[128];
    int len = snprintf(hdr, sizeof hdr, "\n*** signal_media CRASH sig=%d addr=%p bt=%d frames ***\n",
                       sig, si ? si->si_addr : NULL, n);
    if (write(2, hdr, len) < 0) { /* ignore */ }
    backtrace_symbols_fd(bt, n, 2);   /* fd 2 = stderr = sigmedia_call.log */
    _exit(128 + sig);
}

/* Force libnice's conncheck-level debug logging to actually reach sigmedia_call.log.
 * NICE_DEBUG/G_MESSAGES_DEBUG=all env vars were set on the engine spawn but produced NOTHING - the
 * device's libnice.so (independently confirmed to have nice_debug()/the debug strings compiled in, so
 * it's NOT an NDEBUG-stripped build) never actually printed conncheck internals. Rather than keep
 * guessing at g_parse_debug_string/G_MESSAGES_DEBUG env-var mechanics, force it directly: call the
 * public nice_debug_enable() API (bypasses NICE_DEBUG parsing) and install our own handler for the
 * "libnice"/"libnice-stun" log domains that unconditionally writes to stderr (bypasses any
 * G_MESSAGES_DEBUG gating in the default handler). */
static void sm_nice_log_handler(const gchar *domain, GLogLevelFlags level, const gchar *msg, gpointer u)
{
    (void)level; (void)u;
    fprintf(stderr, "[%s] %s\n", domain ? domain : "libnice", msg ? msg : "");
    fflush(stderr);
}

static void sm_enable_nice_debug(void)
{
    nice_debug_enable(TRUE);   /* TRUE = also enable STUN-level logging */
    g_log_set_handler("libnice", G_LOG_LEVEL_MASK, sm_nice_log_handler, NULL);
    g_log_set_handler("libnice-stun", G_LOG_LEVEL_MASK, sm_nice_log_handler, NULL);
    g_message("signal_media: forced libnice debug logging on (nice_debug_enable + custom log handler)");
}

int signal_media_init(int *argc, char ***argv)
{
    if (g_once_init_enter(&g_inited)) {
        /* Realtime priority for the whole call. The mic (alsasrc) kept overrunning ("Can't record
         * audio fast enough") because this spawned engine ran at default nice and got CPU-starved by
         * the transport + others while doing Opus enc+dec + GCM SRTP + ICE. WhatsApp calling renices
         * during a call for the same reason (see whatsapp-call-audio-quality). The transport runs as
         * root so a negative nice is permitted; -15 puts us well above normal work. */
        if (setpriority(PRIO_PROCESS, 0, -15) != 0)
            g_message("signal_media: setpriority(-15) failed (continuing at default nice)");

        struct sigaction sa;
        memset(&sa, 0, sizeof sa);
        sa.sa_sigaction = sm_crash_handler;
        sa.sa_flags = SA_SIGINFO;
        sigaction(SIGBUS,  &sa, NULL);
        sigaction(SIGSEGV, &sa, NULL);
        sigaction(SIGILL,  &sa, NULL);   /* the webrtc lib's load-time LDREX alignment trap is SIGILL */
        gst_init(argc, argv);
        g_once_init_leave(&g_inited, 1);
    }
    return 0;
}

int signal_media_start(const unsigned char local_priv[32],
                       const unsigned char remote_pub[32],
                       const unsigned char *caller_id, size_t caller_id_len,
                       const unsigned char *callee_id, size_t callee_id_len,
                       const char *our_ufrag, const char *our_pwd,
                       const char *remote_ufrag, const char *remote_pwd,
                       int is_caller,
                       signal_media_candidate_cb cand_cb, void *user,
                       signal_media_audiod_cb audiod_cb, void *aud_user)
{
    signal_media_init(NULL, NULL);

    memset(&g_sm, 0, sizeof g_sm);
    g_sm.is_caller = is_caller ? TRUE : FALSE;
    g_sm.cand_cb = cand_cb; g_sm.cand_user = user;
    g_sm.audiod_cb = audiod_cb; g_sm.audiod_user = aud_user;

    if (signal_negotiate_srtp_keys(local_priv, remote_pub, caller_id, caller_id_len,
                                   callee_id, callee_id_len, &g_sm.keys) != 0) {
        g_printerr("signal_media: SRTP key derivation failed (non-contributory / bad key?)\n");
        return -1;
    }
    /* RX (decrypt the peer): answerer uses offer_key, caller uses answer_key. */
    g_sm.rx_master = g_sm.is_caller
        ? master_key_buffer(g_sm.keys.answer_key, g_sm.keys.answer_salt)
        : master_key_buffer(g_sm.keys.offer_key,  g_sm.keys.offer_salt);

    g_sm.ctx  = g_main_context_new();
    g_sm.loop = g_main_loop_new(g_sm.ctx, FALSE);

    if (!build_ice(&g_sm, our_ufrag, our_pwd, remote_ufrag, remote_pwd)) return -1;
    if (!build_pipeline(&g_sm)) return -1;

    if (gst_element_set_state(g_sm.pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
        g_printerr("signal_media: failed to set PLAYING\n");
        return -1;
    }

    /* Start ICE gathering (opens nice's UDP sockets) only NOW, after ALSA's device-open fd churn from
     * the PLAYING transition above has settled - see sm_start_gathering()'s comment for why. */
    if (!sm_start_gathering(&g_sm)) return -1;

    g_sm.running = TRUE;
    g_sm.thread = g_thread_new("signal-media", media_thread, &g_sm);
    return 0;
}

int signal_media_add_remote_candidate(const char *sdp_candidate)
{
    if (!g_sm.agent || !sdp_candidate) return -1;
    /* Peer candidates arrive bare ("candidate:...") from the Signal opaque; libnice's parser wants
     * the SDP attribute form "a=candidate:...". Prepend "a=" if it isn't already there. */
    gchar *attr = (strncmp(sdp_candidate, "a=", 2) == 0)
                      ? g_strdup(sdp_candidate)
                      : g_strconcat("a=", sdp_candidate, NULL);
    NiceCandidate *c = nice_agent_parse_remote_candidate_sdp(g_sm.agent, g_sm.stream_id, attr);
    g_free(attr);
    if (!c) { g_printerr("signal_media: could not parse remote candidate: %s\n", sdp_candidate); return -1; }
    GSList *list = g_slist_append(NULL, c);
    int added = nice_agent_set_remote_candidates(g_sm.agent, g_sm.stream_id, g_sm.component, list);
    g_slist_free(list);
    nice_candidate_free(c);
    g_message("signal_media: REMOTE candidate (added=%d) -> %s", added, sdp_candidate);
    return added > 0 ? 0 : -1;
}

void signal_media_stop(void)
{
    if (!g_sm.running) return;
    g_sm.running = FALSE;

    /* stop + join the rtp-data resend thread BEFORE freeing the agent/srtp it uses (no use-after-free) */
    g_accepted = FALSE;
    if (g_accept_thread) { g_thread_join(g_accept_thread); g_accept_thread = NULL; }
    g_datasrc = NULL;   /* owned by the pipeline (freed below); thread is joined so no more pushes */
    if (g_data_srtp) { srtp_dealloc(g_data_srtp); g_data_srtp = NULL; }

    if (g_sm.pipeline) gst_element_set_state(g_sm.pipeline, GST_STATE_NULL);
    if (g_sm.audiod_on && g_sm.audiod_cb) g_sm.audiod_cb(0, g_sm.audiod_user);
    g_sm.audiod_on = FALSE;

    if (g_sm.loop) g_main_loop_quit(g_sm.loop);
    if (g_sm.thread) { g_thread_join(g_sm.thread); g_sm.thread = NULL; }
    sm_echo_free();     /* now that the streaming threads (probe callers) are stopped, free the AEC */

    if (g_sm.pipeline) { gst_object_unref(g_sm.pipeline); g_sm.pipeline = NULL; }
    if (g_sm.agent)    { g_object_unref(g_sm.agent);      g_sm.agent = NULL; }
    if (g_sm.rx_master){ gst_buffer_unref(g_sm.rx_master); g_sm.rx_master = NULL; }
    if (g_sm.loop)     { g_main_loop_unref(g_sm.loop);    g_sm.loop = NULL; }
    if (g_sm.ctx)      { g_main_context_unref(g_sm.ctx);  g_sm.ctx = NULL; }
}

/* ------------------------------------------------------------------ loopback self-test --------- */
/*
 * audiotestsrc -> audioconvert -> audioresample -> [48k/mono] -> opusenc -> rtpopuspay
 *   -> srtpenc(master) -> srtpdec(same master via request-key) -> rtpopusdepay -> opusdec -> fakesink
 * A pad probe on opusdec's src pad counts decoded frames; PASS once we clear the threshold.
 * No ICE, no ALSA, no device: this is the piece we can reason about fully tonight.
 */
typedef struct {
    GMainLoop *loop;
    GstBuffer *master;
    guint      decoded;
    gboolean   ok;
    gboolean   errored;
} LoopbackCtx;

#define LOOPBACK_NEED_FRAMES 25   /* ~0.5 s of 20 ms Opus frames */

static GstCaps *loopback_request_key(GstElement *dec, guint ssrc, gpointer user)
{
    (void)dec; (void)ssrc;
    LoopbackCtx *lc = (LoopbackCtx *)user;
    GstCaps *caps = gst_caps_new_simple("application/x-srtp",
                                        "srtp-cipher",  G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtp-auth",    G_TYPE_STRING, SRTP_AUTH_NULL,
                                        "srtcp-cipher", G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtcp-auth",   G_TYPE_STRING, SRTP_AUTH_NULL,
                                        NULL);
    gst_caps_set_simple(caps, "srtp-key", GST_TYPE_BUFFER, gst_buffer_ref(lc->master), NULL);
    return caps;
}

static GstPadProbeReturn loopback_count(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    (void)pad; (void)info;
    LoopbackCtx *lc = (LoopbackCtx *)user;
    if (++lc->decoded >= LOOPBACK_NEED_FRAMES && !lc->ok) {
        lc->ok = TRUE;
        g_main_loop_quit(lc->loop);
    }
    return GST_PAD_PROBE_OK;
}

static gboolean loopback_bus(GstBus *bus, GstMessage *msg, gpointer user)
{
    (void)bus;
    LoopbackCtx *lc = (LoopbackCtx *)user;
    if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
        GError *err = NULL; gchar *dbg = NULL;
        gst_message_parse_error(msg, &err, &dbg);
        g_printerr("[loopback] ERROR from %s: %s (%s)\n", GST_OBJECT_NAME(msg->src),
                   err ? err->message : "?", dbg ? dbg : "");
        if (err) g_error_free(err);
        g_free(dbg);
        lc->errored = TRUE;
        g_main_loop_quit(lc->loop);
    }
    return TRUE;
}

static gboolean loopback_timeout(gpointer user)
{
    LoopbackCtx *lc = (LoopbackCtx *)user;
    g_main_loop_quit(lc->loop);
    return G_SOURCE_REMOVE;
}

int signal_media_loopback_selftest(void)
{
    signal_media_init(NULL, NULL);

    /* Real 44-byte AEAD_AES_256_GCM master from the KDF, using the same fixed vector as
     * srtp_kdf.py's demo so a human can eyeball the key against the reference if needed. We use the
     * answer_* key for both directions here - loopback only needs a valid GCM key. */
    unsigned char priv[32], remote_pub[32], cid[33], eid[33];
    for (int i = 0; i < 32; i++) priv[i] = (unsigned char)(i + 1);
    static const unsigned char alan_pub[32] = {
        0x36,0x4f,0xb3,0xe8,0xd7,0x1d,0x17,0xb6,0x56,0xac,0xa4,0x98,0xca,0x2c,0x4e,0x9f,
        0xfa,0xcf,0xab,0x68,0xb6,0xa7,0x25,0x55,0x07,0xa8,0xca,0x1d,0x58,0x63,0x73,0x61 };
    memcpy(remote_pub, alan_pub, 32);
    cid[0] = 0x05; memset(cid + 1, 0xAA, 32);
    eid[0] = 0x05; memset(eid + 1, 0xBB, 32);

    signal_srtp_keys keys;
    if (signal_negotiate_srtp_keys(priv, remote_pub, cid, 33, eid, 33, &keys) != 0) {
        g_printerr("[loopback] FAIL: key derivation failed\n");
        return 2;
    }

    LoopbackCtx lc; memset(&lc, 0, sizeof lc);
    lc.master = master_key_buffer(keys.answer_key, keys.answer_salt);
    lc.loop   = g_main_loop_new(NULL, FALSE);

    GstElement *pipe = gst_pipeline_new("loopback");
    GstElement *src   = mk("audiotestsrc",  "lt-src");
    GstElement *conv  = mk("audioconvert",  "lt-conv");
    GstElement *res   = mk("audioresample", "lt-res");
    GstElement *caps  = mk("capsfilter",    "lt-caps");
    GstElement *oenc  = mk("opusenc",       "lt-opusenc");
    GstElement *pay   = mk("rtpopuspay",    "lt-pay");
    GstElement *senc  = mk("srtpenc",       "lt-srtpenc");
    GstElement *sdec  = mk("srtpdec",       "lt-srtpdec");
    GstElement *rxc   = mk("capsfilter",    "lt-rxcaps");
    GstElement *depay = mk("rtpopusdepay",  "lt-depay");
    GstElement *odec  = mk("opusdec",       "lt-opusdec");
    GstElement *sink  = mk("fakesink",      "lt-sink");

    if (!pipe || !src || !conv || !res || !caps || !oenc || !pay || !senc || !sdec ||
        !rxc || !depay || !odec || !sink) {
        g_printerr("[loopback] FAIL: missing GStreamer element(s) - is the plugin path set?\n");
        return 3;
    }

    g_object_set(src, "is-live", TRUE, "wave", 0 /* sine */, "num-buffers", 400, NULL);
    { GstCaps *c = gst_caps_new_simple("audio/x-raw",
                                       "format",   G_TYPE_STRING, "S16LE",
                                       "rate",     G_TYPE_INT,    SIGNAL_OPUS_CLOCKRATE,
                                       "channels", G_TYPE_INT,    SIGNAL_OPUS_CHANNELS, NULL);
      g_object_set(caps, "caps", c, NULL); gst_caps_unref(c); }
    g_object_set(pay, "pt", SIGNAL_OPUS_PT, NULL);
    configure_srtpenc(senc, lc.master);
    g_signal_connect(sdec, "request-key", G_CALLBACK(loopback_request_key), &lc);
    { GstCaps *c = opus_rtp_caps(); g_object_set(rxc, "caps", c, NULL); gst_caps_unref(c); }
    g_object_set(sink, "sync", FALSE, "async", FALSE, NULL);

    gst_bin_add_many(GST_BIN(pipe), src, conv, res, caps, oenc, pay, senc, sdec, rxc, depay, odec, sink, NULL);
    if (!gst_element_link_many(src, conv, res, caps, oenc, pay, senc, NULL) ||
        !gst_element_link_many(senc, sdec, NULL) ||
        !gst_element_link_many(sdec, rxc, depay, odec, sink, NULL)) {
        g_printerr("[loopback] FAIL: could not link pipeline (caps mismatch?)\n");
        return 4;
    }

    GstPad *p = gst_element_get_static_pad(odec, "src");
    gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, loopback_count, &lc, NULL);
    gst_object_unref(p);

    GstBus *bus = gst_element_get_bus(pipe);
    gst_bus_add_watch(bus, loopback_bus, &lc);
    gst_object_unref(bus);

    g_timeout_add_seconds(10, loopback_timeout, &lc);

    g_print("[loopback] starting SRTP(AEAD_AES_256_GCM)+RTP+Opus round-trip...\n");
    if (gst_element_set_state(pipe, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
        g_printerr("[loopback] FAIL: could not set PLAYING\n");
        gst_object_unref(pipe);
        return 5;
    }
    g_main_loop_run(lc.loop);
    gst_element_set_state(pipe, GST_STATE_NULL);

    int rc = (lc.ok && !lc.errored) ? 0 : 1;
    g_print("[loopback] decoded %u Opus frames through SRTP-GCM -> %s\n",
            lc.decoded, rc == 0 ? "PASS" : "FAIL");

    gst_object_unref(pipe);
    gst_buffer_unref(lc.master);
    g_main_loop_unref(lc.loop);
    return rc;
}

/* ------------------------------------------------------------------ standalone main ------------ */
#ifndef SIGNAL_MEDIA_NO_MAIN

/* --answer IPC driver: the separate-process contract the presage bridge speaks (see RUNTIME_STATUS).
 * presage spawns `signal_media --answer`, then talks a line protocol over the pipes:
 *
 *   presage -> us (stdin):
 *     START <priv_hex64> <pub_hex64> <callerid_hex> <calleeid_hex> <ourufrag> <ourpwd> <remufrag> <rempwd>
 *     RCAND <candidate:... sdp line>      (peer IceUpdate, may repeat / trickle)
 *     STOP
 *   us -> presage (stdout, line-buffered):
 *     CAND <candidate:... sdp line>       (our local candidate to send as an IceUpdate)
 *     AUDIOD <0|1>                        (bridge should drive audiod scenario)
 *     READY                               (engine started ok)
 *     ERR <msg>                           (fatal; we exit non-zero)
 *
 * Keys/ids are lowercase hex. ufrag/pwd are single whitespace-free tokens (ICE creds never contain
 * spaces). Our callbacks fire from the engine's GMainContext thread, so stdout writes take a lock. */
static GMutex g_out_lock;

static void emit(const char *fmt, ...)
{
    va_list ap; va_start(ap, fmt);
    g_mutex_lock(&g_out_lock);
    vfprintf(stdout, fmt, ap);
    fflush(stdout);
    g_mutex_unlock(&g_out_lock);
    va_end(ap);
}

static void ipc_candidate_cb(const char *sdp, void *user) { (void)user; emit("CAND %s\n", sdp); }
static void ipc_audiod_cb(int active, void *user)         { (void)user; emit("AUDIOD %d\n", active ? 1 : 0); }

/* hex -> bytes; returns byte count, or -1 on bad/odd input. out must hold len(hex)/2 bytes. */
static int unhex(const char *h, unsigned char *out, size_t out_max)
{
    size_t n = strlen(h);
    if (n % 2) return -1;
    if (n / 2 > out_max) return -1;
    for (size_t i = 0; i < n; i += 2) {
        int hi = g_ascii_xdigit_value(h[i]), lo = g_ascii_xdigit_value(h[i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i / 2] = (unsigned char)((hi << 4) | lo);
    }
    return (int)(n / 2);
}

/* Derive + emit our X25519 public key from a hex private key ("PUB <pub_hex>"); returns 0 on ok.
 * Used by the CALLER's two-phase flow to get its public key BEFORE the Answer arrives (so it can be
 * put in the outgoing Offer) and by the START path (so the Answer's key matches the SRTP keys). */
static int emit_pubkey_from_priv_hex(const char *ph)
{
    unsigned char priv[32], ourpub[32];
    if (unhex(ph, priv, sizeof priv) != 32) { emit("ERR bad-key-hex\n"); return -1; }
    if (signal_x25519_public_from_private(priv, ourpub) != 0) { emit("ERR pubkey-derive-failed\n"); return -1; }
    char hexp[65];
    for (int k = 0; k < 32; k++) g_snprintf(hexp + k * 2, 3, "%02x", ourpub[k]);
    emit("PUB %s\n", hexp);
    return 0;
}

static int run_ipc(int is_caller)
{
    char line[8192];
    int started = 0;
    unsigned char priv[32], pub[32], caller_id[64], callee_id[64];
    int caller_len = 0, callee_len = 0;

    setvbuf(stdout, NULL, _IOLBF, 0);
    g_mutex_init(&g_out_lock);

    while (fgets(line, sizeof line, stdin)) {
        char *nl = strchr(line, '\n'); if (nl) *nl = '\0';
        if (line[0] == '\0') continue;

        if (strncmp(line, "PREPARE ", 8) == 0) {
            /* Caller phase 1: just report our public key so the bridge can send the Offer. No media
             * yet - the answerer's key + ICE creds arrive later in START. */
            emit_pubkey_from_priv_hex(line + 8);
        } else if (strncmp(line, "RELAY ", 6) == 0) {
            sm_trace("ipc: RELAY line");
            /* STUN/TURN config, sent before START:  RELAY stun <host> <port>
             *                                       RELAY turn <ip> <port> <user> <pass> <transport> */
            char *sp = NULL;
            char *kind = strtok_r(line + 6, " ", &sp);
            char *host = strtok_r(NULL, " ", &sp);
            char *ports = strtok_r(NULL, " ", &sp);
            if (kind && host && ports) {
                int port = atoi(ports);
                if (strcmp(kind, "stun") == 0) {
                    snprintf(g_stun_host, sizeof g_stun_host, "%s", host);
                    g_stun_port = port;
                } else if (strcmp(kind, "turn") == 0 && g_n_turn < SM_MAX_TURN) {
                    char *user = strtok_r(NULL, " ", &sp);
                    char *pass = strtok_r(NULL, " ", &sp);
                    char *tr   = strtok_r(NULL, " ", &sp);
                    SmTurn *t = &g_turn[g_n_turn++];
                    snprintf(t->host, sizeof t->host, "%s", host);
                    t->port = port;
                    snprintf(t->user, sizeof t->user, "%s", user ? user : "");
                    snprintf(t->pass, sizeof t->pass, "%s", pass ? pass : "");
                    t->type = (tr && strcmp(tr, "tcp") == 0) ? NICE_RELAY_TYPE_TURN_TCP
                            : (tr && strcmp(tr, "tls") == 0) ? NICE_RELAY_TYPE_TURN_TLS
                            :                                  NICE_RELAY_TYPE_TURN_UDP;
                    sm_trace("RELAY: stored turn entry");
                }
            }
        } else if (strncmp(line, "START ", 6) == 0) {
            sm_trace("ipc: START line");
            if (started) { emit("ERR already-started\n"); continue; }
            /* Tokenise the 8 START fields. strtok is fine: no field contains whitespace. */
            char *sp = NULL;
            char *ph  = strtok_r(line + 6, " ", &sp);
            char *pubh= strtok_r(NULL, " ", &sp);
            char *cah = strtok_r(NULL, " ", &sp);
            char *ceh = strtok_r(NULL, " ", &sp);
            char *ouf = strtok_r(NULL, " ", &sp);
            char *opw = strtok_r(NULL, " ", &sp);
            char *ruf = strtok_r(NULL, " ", &sp);
            char *rpw = strtok_r(NULL, " ", &sp);
            if (!ph || !pubh || !cah || !ceh || !ouf || !opw || !ruf || !rpw) {
                emit("ERR start-missing-fields\n"); continue;
            }
            if (unhex(ph, priv, sizeof priv) != 32 || unhex(pubh, pub, sizeof pub) != 32) {
                emit("ERR bad-key-hex\n"); continue;
            }
            caller_len = unhex(cah, caller_id, sizeof caller_id);
            callee_len = unhex(ceh, callee_id, sizeof callee_id);
            if (caller_len < 0 || callee_len < 0) { emit("ERR bad-id-hex\n"); continue; }

            /* Report OUR X25519 public key (derived from priv via the SAME OpenSSL primitive that
             * does the DH) so the bridge puts a public key in the Answer that is guaranteed
             * consistent with the SRTP keys this engine will derive. The CALLER already reported it
             * in PREPARE (and put it in the Offer), so only the answerer emits it here. */
            if (!is_caller) { emit_pubkey_from_priv_hex(ph); }

            int rc = signal_media_start(priv, pub,
                                        caller_id, (size_t)caller_len,
                                        callee_id, (size_t)callee_len,
                                        ouf, opw, ruf, rpw,
                                        is_caller,
                                        ipc_candidate_cb, NULL, ipc_audiod_cb, NULL);
            if (rc != 0) { emit("ERR start-failed\n"); return 1; }
            started = 1;
            emit("READY\n");
        } else if (strncmp(line, "RCAND ", 6) == 0) {
            if (!started) { emit("ERR rcand-before-start\n"); continue; }
            signal_media_add_remote_candidate(line + 6);
        } else if (strncmp(line, "ACCEPT ", 7) == 0) {
            /* user tapped Answer -> start emitting the RingRTC rtp-data Accepted (stops caller ringing) */
            if (!started) { emit("ERR accept-before-start\n"); continue; }
            signal_media_accept(g_ascii_strtoull(line + 7, NULL, 10));
        } else if (strcmp(line, "STOP") == 0) {
            break;
        } else {
            emit("ERR unknown-cmd\n");
        }
    }
    if (started) signal_media_stop();
    return 0;
}

int main(int argc, char **argv)
{
    sm_trace("main: enter");
    signal_media_init(&argc, &argv);
    sm_trace("main: gst_init done");
    if (argc >= 2 && (strcmp(argv[1], "--loopback") == 0 || strcmp(argv[1], "--selftest") == 0)) {
        int rc = signal_media_loopback_selftest();
        return rc;
    }
    if (argc >= 2 && strcmp(argv[1], "--answer") == 0) {
        return run_ipc(0);   /* answerer: RX=offer_key, TX=answer_key */
    }
    if (argc >= 2 && strcmp(argv[1], "--caller") == 0) {
        return run_ipc(1);   /* caller (outgoing): RX=answer_key, TX=offer_key */
    }
    g_print("Signal call media engine (webOS).\n");
    g_print("  %s --loopback   run the SRTP-GCM+RTP+Opus loopback self-test\n", argv[0]);
    g_print("  %s --answer     drive a live INCOMING call over the stdin/stdout IPC (presage bridge)\n", argv[0]);
    g_print("  %s --caller     drive a live OUTGOING call over the stdin/stdout IPC (presage bridge)\n", argv[0]);
    return 0;
}
#endif
