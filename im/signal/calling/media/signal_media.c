/*
 * signal_media.c - the media engine for 1:1 Signal voice calls on LuneOS.
 *
 * purple-presage (the Signal libpurple plug-in) runs it as a separate process for each call and
 * drives it over stdin/stdout (see run_ipc below). Signal's media is ICE (libnice) plus SRTP with
 * AEAD_AES_256_GCM, keyed from an X25519 DH (srtp_kdf.c) rather than DTLS, so srtpenc/srtpdec get
 * keys we set ourselves. Audio is Opus over RTP, played to and captured from the PulseAudio call
 * sink and source, voipcall and webcall, which module-palm-policy routes to the device audiod picks
 * for the call:
 *
 *   RX: nicesrc -> srtpdec(peer's key via request-key) -> rtpopusdepay -> opusdec -> pulsesink device=voipcall
 *   TX: pulsesrc device=webcall -> opusenc -> rtpopuspay -> srtpenc(our key) -> nicesink
 *
 * Both nicesrc and nicesink bind the same NiceAgent stream/component (RTP send and receive on one
 * 5-tuple, rtcp-mux). As the answerer we decrypt the caller with offer_key/salt and encrypt ours
 * with answer_key/salt; as the caller it is the other way round.
 *
 * `signal_media --loopback` runs a self-test of the SRTP-GCM + RTP + Opus path without ICE or audio
 * devices. Compiled with -DSIGNAL_MEDIA_NO_MAIN this file is just the signal_media_* API.
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
#include <errno.h>
#include <speex/speex_echo.h>        /* SpeexDSP acoustic echo canceller */
#include <speex/speex_preprocess.h>  /* residual-echo suppression + denoise */

#include "srtp_kdf.h"
#include "signal_media.h"
#include "signal_video.h"

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
    GstElement     *mic;        /* the pulsesrc, held out of the pipeline until the user answers */

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

static gboolean g_accepted;     /* defined with the rtp-data channel below */

/* --- Video ------------------------------------------------------------------------------------
 * A 1:1 Signal call carries VP8 next to the audio, on the same ICE component and SRTP keys (see
 * signal_video.h for what RingRTC puts on the wire). Received VP8 is split off after srtpdec,
 * decoded and published as I420 frames on a gst-shm socket for the Phone app (RemoteVideo.qml,
 * the same contract luneos-rtc-engine has for WhatsApp). Our camera, while the user has it on,
 * is encoded to VP8 and joins the audio's funnel to the nicesink; its picture also goes to a
 * second shm socket for the Phone app's self-view. Video events go to the event callback
 * (signal_media_set_event_cb) as lines for purple-presage. */
#define SM_VIDEO_W          640
#define SM_VIDEO_H          480
#define SM_PREVIEW_W        320
#define SM_PREVIEW_H        240
#define SM_VIDEO_FPS        15
#define SM_VIDEO_BITRATE    600000
#define SM_VIDEO_SHM        "/tmp/signal-video"     /* device-side sockets: the Phone app opens them */
#define SM_PREVIEW_SHM      "/tmp/signal-preview"
#define SM_SHM_SIZE         (8u << 20)
#define SM_PLI_INTERVAL_US  500000                  /* at most two keyframe requests a second */

typedef struct {
    GstElement *rx_src;         /* appsrc the split probe feeds received VP8 RTP into */
    GstElement *rx_shm;         /* its shmsink */
    GstElement *rx_jb;          /* its jitter buffer (statistics) */
    gint        st_depay_in;    /* atomic: packets into the depayloader */
    gint        rx_announced;   /* atomic: VSHM sent */
    GstElement *tx_enc;         /* the VP8 encoder in the persistent send tail */
    gint        tx_announced;   /* atomic: VPREVIEW sent */
    gboolean    tx_wanted;      /* VIDEO 1: the user has the camera on */
    gint        tx_cvo;         /* atomic: our CVO byte */
    gboolean    tx_mirrored;    /* front camera: the self-view is shown mirrored */
    gint        status_known;   /* atomic: send SenderStatus (video was asked for at least once) */
    gint        status_video;   /* atomic: SenderStatus.video_enabled we send */
    gint        peer_rot;       /* atomic: last PEERROT reported, -1 none */
    gint        peer_video;     /* atomic: last PEERVIDEO reported, -1 none */
    gint        pli_wanted;     /* atomic: our decoder wants a keyframe from the far side */
    gint64      last_pli_us;    /* sender thread only */
    guint64     call_id;        /* RingRTC call id for SenderStatus (CALLID, or ACCEPT's) */
    gint        have_call_id;   /* atomic */
    /* receive statistics (atomic), logged by the sender thread while they change */
    gint        st_vp8;         /* VP8 packets routed to the video branch */
    gint        st_push_fail;   /* of them refused by the appsrc */
    gint        st_other;       /* packets of another payload type, not audio or data */
    gint        st_depay;       /* VP8 frames out of the depayloader */
    gint        st_dec;         /* decoded frames */
    gint        st_pli;         /* keyframe requests sent */
    gint        st_tcc;         /* congestion feedback packets sent */
    gint        st_kf;          /* VP8 keyframe starts received */
    gint        st_gap;         /* VP8 sequence numbers missing (lost or late) */
    gint        st_last_seq;    /* receive thread only: last VP8 sequence number, -1 none */
    gint        st_last_pt;     /* last "other" payload type seen */
    guint16     rx_fec_skipped; /* receive thread only: ULPFEC packets taken out of the VP8 stream */
} SmVideo;

static SmVideo g_v;

/* Transport-cc: the receive thread records, the sender thread sends the feedback. */
static GMutex g_tcc_lock;
static SvTcc  g_tcc;
static gint64 g_tcc_t0;         /* arrival times count from here (the 24-bit reference time wraps) */

static signal_media_event_cb g_event_cb;
static void                 *g_event_user;

void signal_media_set_event_cb(signal_media_event_cb cb, void *user)
{
    g_event_cb = cb;
    g_event_user = user;
}

static void sm_event(const char *fmt, ...) G_GNUC_PRINTF(1, 2);
static void sm_event(const char *fmt, ...)
{
    if (!g_event_cb)
        return;
    va_list ap;
    va_start(ap, fmt);
    gchar *line = g_strdup_vprintf(fmt, ap);
    va_end(ap);
    g_event_cb(line, g_event_user);
    g_free(line);
}

/* Run fn on the media thread (the thread that runs g_sm.ctx), through one idle source attached
 * to that context: g_main_context_invoke() would run it on the calling thread whenever nobody
 * owns the context yet. */
static void sm_on_media_thread(GSourceFunc fn, gpointer data)
{
    if (!g_sm.ctx)
        return;
    GSource *s = g_idle_source_new();
    g_source_set_callback(s, fn, data, NULL);
    g_source_attach(s, g_sm.ctx);
    g_source_unref(s);
}

/* Mic gate: as the answerer the engine starts when the offer arrives, so ICE is ready by the time the
 * user answers. The pulsesrc only joins the pipeline when they do (sm_open_mic), so nothing records
 * while the phone rings; this probe is the second line, so no audio can leave before then either.
 * As the caller the engine only starts once the peer has answered. */
static GstPadProbeReturn sm_tx_audio_gate_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)info; (void)u;
    return (g_sm.is_caller || g_accepted) ? GST_PAD_PROBE_OK : GST_PAD_PROBE_DROP;
}

/* --- Acoustic echo cancellation (SpeexDSP) --------------------------------------------------------
 * On the loudspeaker the mic captures the far-end audio coming out of the speaker and would send it
 * back as echo. PulseAudio's call sink and source have no echo canceller of their own, so the engine
 * runs SpeexDSP's. Its split playback/capture API is built for exactly our case
 * (playback and capture on different threads): speex_echo_playback() buffers each frame we PLAY (the
 * reference); speex_echo_capture() cancels that echo out of each mic frame we CAPTURE. Both sides are
 * reframed to a fixed 10 ms (480-sample @ 48 kHz mono) buffer by an audiobuffersplit so the fixed-size
 * frames Speex requires arrive cleanly. A mutex guards the shared state (the two calls run on the RX
 * and TX streaming threads). */
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
 * stdin cmd = the user tapped Answer) turns it on; the sender thread below sends it, and the
 * video's SenderStatus and keyframe requests. */
#define RTP_DATA_PT       101
#define RTP_DATA_SSRC     0x0000000DU
static srtp_t      g_data_srtp    = NULL;  /* TX SRTP session for the data SSRC (our TX key) */
static gboolean    g_srtp_inited  = FALSE;
static GstElement *g_datasrc      = NULL;  /* appsrc -> 2nd nicesink (that nicesink does the actual send) */
static guint64     g_accept_id    = 0;     /* RingRTC call_id -> Accepted.id */
static gboolean    g_accepted     = FALSE; /* user accepted -> keep resending; also opens the mic gate */
static guint16     g_data_seq     = 0;     /* RTP seq for the data stream */
static guint32     g_data_ts      = 0;     /* RTP timestamp for the data stream */

/* Lazily create the TX SRTP session, keyed with OUR TX master (answerer=answer_key, caller=offer_key),
 * the same key the audio srtpenc uses. Two streams: RTP for the data SSRC, and RTCP for our video
 * SSRC (the keyframe requests we send). Neither SSRC/direction is protected anywhere else - srtpenc
 * protects RTP only, and never for 0xD - so no keystream is used twice. */
static gboolean sm_data_srtp_init(void)
{
    if (g_data_srtp) return TRUE;
    if (!g_srtp_inited) {
        /* GStreamer's srtpenc/srtpdec have already initialised libsrtp2, and a second srtp_init()
         * may report that. Not fatal: the library is ready, so go on to srtp_create. */
        srtp_err_status_t is = srtp_init();
        if (is != srtp_err_status_ok)
            g_debug("signal_media: srtp_init returned %d (already initialised) - continuing", (int)is);
        g_srtp_inited = TRUE;
    }
    unsigned char master[SIGNAL_SRTP_MASTER_SIZE];
    const unsigned char *k = g_sm.is_caller ? g_sm.keys.offer_key  : g_sm.keys.answer_key;
    const unsigned char *s = g_sm.is_caller ? g_sm.keys.offer_salt : g_sm.keys.answer_salt;
    memcpy(master,                       k, SIGNAL_SRTP_KEY_SIZE);
    memcpy(master + SIGNAL_SRTP_KEY_SIZE, s, SIGNAL_SRTP_SALT_SIZE);
    srtp_policy_t policy[2];
    memset(policy, 0, sizeof policy);
    for (int i = 0; i < 2; i++) {
        srtp_crypto_policy_set_aes_gcm_256_16_auth(&policy[i].rtp);
        srtp_crypto_policy_set_aes_gcm_256_16_auth(&policy[i].rtcp);
        policy[i].ssrc.type = ssrc_specific;
        policy[i].key       = master;
    }
    policy[0].ssrc.value = RTP_DATA_SSRC;
    policy[1].ssrc.value = sv_video_ssrc(g_sm.is_caller);
    policy[0].next = &policy[1];
    srtp_err_status_t st = srtp_create(&g_data_srtp, &policy[0]);
    memset(master, 0, sizeof master);
    if (st != srtp_err_status_ok) {
        g_message("signal_media: srtp_create(data) failed"); g_data_srtp = NULL; return FALSE;
    }
    return TRUE;
}

/* Hand SRTP/SRTCP-protected bytes to the data appsrc, whose funnel/queue/nicesink sends them on the
 * queue's single thread - never us - so no agent-mutex deadlock. */
static void sm_push_protected(const guint8 *pkt, int len, const char *what)
{
    GstBuffer *buf = gst_buffer_new_allocate(NULL, (gsize)len, NULL);
    gst_buffer_fill(buf, 0, pkt, (gsize)len);
    GstFlowReturn fr = gst_app_src_push_buffer(GST_APP_SRC(g_datasrc), buf);  /* takes ownership */
    if (fr != GST_FLOW_OK)
        g_message("signal_media: could not queue the %s: %s", what, gst_flow_get_name(fr));
}

/* Build our rtp_data.Message - accepted{id} once the user answered here (only the callee may send
 * it: RingRTC treats an Accepted from the caller as an error), senderStatus{id, video_enabled} once
 * video was asked for - SRTP-encrypt it and send it. Runs only on the sender thread. */
static void sm_push_data_message(void)
{
    if (!g_datasrc || !sm_data_srtp_init()) return;
    SvDataMsg m;
    sv_data_msg_init(&m);
    if (g_accepted && !g_sm.is_caller) {
        m.has_accepted = 1;
        m.accepted_id = g_accept_id;
    }
    if (g_atomic_int_get(&g_v.status_known) && g_atomic_int_get(&g_v.have_call_id)) {
        m.has_status = 1;
        m.status_id = g_v.call_id;
        m.video_enabled = g_atomic_int_get(&g_v.status_video) ? 1 : 0;
    }
    if (!m.has_accepted && !m.has_status) return;
    static guint64 seqnum = 0;
    m.has_seqnum = 1;
    m.seqnum = ++seqnum;
    /* 12-byte RTP header + payload, with slack for the GCM tag srtp_protect appends in place */
    guint8 pkt[12 + 64 + SRTP_MAX_TRAILER_LEN];
    size_t bn = sv_data_msg_encode(&m, pkt + 12, 64);
    if (bn == 0) return;
    pkt[0] = 0x80; pkt[1] = RTP_DATA_PT;
    g_data_seq++; pkt[2] = (guint8)(g_data_seq >> 8); pkt[3] = (guint8)g_data_seq;
    g_data_ts++;  pkt[4] = (guint8)(g_data_ts >> 24); pkt[5] = (guint8)(g_data_ts >> 16);
                  pkt[6] = (guint8)(g_data_ts >> 8);  pkt[7] = (guint8)g_data_ts;
    pkt[8] = 0; pkt[9] = 0; pkt[10] = 0; pkt[11] = 0x0D;   /* SSRC = 0x0000000D */
    int len = 12 + (int)bn;
    srtp_err_status_t st = srtp_protect(g_data_srtp, pkt, &len);
    if (st != srtp_err_status_ok) { g_message("signal_media: srtp_protect(data) failed %d", (int)st); return; }
    sm_push_protected(pkt, len, "rtp-data message");
}

/* Ask the far side for a VP8 keyframe: an SRTCP PLI from our video SSRC about theirs. WebRTC
 * sends keyframes only on request, so after loss this is the only way the picture recovers. Runs
 * only on the sender thread. */
static void sm_push_pli(void)
{
    if (!g_datasrc || !sm_data_srtp_init()) return;
    guint8 pkt[12 + SRTP_MAX_SRTCP_TRAILER_LEN];
    sv_rtcp_build_pli(sv_video_ssrc(g_sm.is_caller), sv_peer_video_ssrc(g_sm.is_caller), pkt);
    int len = 12;
    srtp_err_status_t st = srtp_protect_rtcp(g_data_srtp, pkt, &len);
    if (st != srtp_err_status_ok) { g_message("signal_media: srtp_protect_rtcp(pli) failed %d", (int)st); return; }
    sm_push_protected(pkt, len, "keyframe request");
    g_atomic_int_inc(&g_v.st_pli);
}

/* Transport-cc feedback for what arrived since the last one, as SRTCP from our video SSRC.
 * Sender thread only. */
static void sm_push_tcc(void)
{
    static guint8 pkt[20 + 2 * ((SV_TCC_WINDOW + 6) / 7) + 2 * SV_TCC_WINDOW + 4 + SRTP_MAX_SRTCP_TRAILER_LEN];
    if (!g_datasrc || (!g_accepted && !g_sm.is_caller))   /* nothing goes out before the answer */
        return;
    if (!sm_data_srtp_init()) return;
    g_mutex_lock(&g_tcc_lock);
    size_t n = sv_tcc_build(&g_tcc, sv_video_ssrc(g_sm.is_caller), sv_peer_video_ssrc(g_sm.is_caller),
                            pkt, sizeof pkt - SRTP_MAX_SRTCP_TRAILER_LEN);
    g_mutex_unlock(&g_tcc_lock);
    if (n == 0) return;
    int len = (int)n;
    srtp_err_status_t st = srtp_protect_rtcp(g_data_srtp, pkt, &len);
    if (st != srtp_err_status_ok) { g_message("signal_media: srtp_protect_rtcp(tcc) failed %d", (int)st); return; }
    sm_push_protected(pkt, len, "congestion feedback");
    g_atomic_int_inc(&g_v.st_tcc);
}

/* Packets keep coming but nothing decodes: the depayloader waits for a keyframe that its one
 * request did not bring. Ask again (sm_pli_take keeps it to two a second). Sender thread only,
 * called every 100 ms. */
static void sm_keyframe_watchdog(void)
{
    static gint last_vp8, last_depay, stalled;
    gint vp8 = g_atomic_int_get(&g_v.st_vp8), depay = g_atomic_int_get(&g_v.st_depay);
    if (vp8 < last_vp8 || depay < last_depay) {         /* a new call */
        last_vp8 = last_depay = stalled = 0;
    }
    if (depay != last_depay) {
        stalled = 0;
    } else if (vp8 != last_vp8 && ++stalled >= 10) {
        g_atomic_int_set(&g_v.pli_wanted, 1);
    }
    last_vp8 = vp8;
    last_depay = depay;
}

/* One line of receive statistics, when anything changed since the last one. Sender thread only. */
static void sm_log_rx_stats(void)
{
    static gint last[9];
    gint now[9] = {
        g_atomic_int_get(&g_v.st_vp8), g_atomic_int_get(&g_v.st_push_fail), g_atomic_int_get(&g_v.st_other),
        g_atomic_int_get(&g_v.st_depay), g_atomic_int_get(&g_v.st_dec), g_atomic_int_get(&g_v.st_pli),
        g_atomic_int_get(&g_v.st_tcc), g_atomic_int_get(&g_v.st_kf), g_atomic_int_get(&g_v.st_gap),
    };
    if (memcmp(now, last, sizeof now) == 0)
        return;
    memcpy(last, now, sizeof last);
    guint64 jpushed = 0, jlost = 0, jlate = 0, jdup = 0;
    GstElement *jb = g_v.rx_jb;
    if (jb) {
        GstStructure *s = NULL;
        g_object_get(jb, "stats", &s, NULL);
        if (s) {
            gst_structure_get_uint64(s, "num-pushed", &jpushed);
            gst_structure_get_uint64(s, "num-lost", &jlost);
            gst_structure_get_uint64(s, "num-late", &jlate);
            gst_structure_get_uint64(s, "num-duplicates", &jdup);
            gst_structure_free(s);
        }
    }
    g_message("signal_media: rx video vp8=%d refused=%d other=%d (pt %d) jb pushed=%" G_GUINT64_FORMAT
              " lost=%" G_GUINT64_FORMAT " late=%" G_GUINT64_FORMAT " dup=%" G_GUINT64_FORMAT
              " depay in=%d out=%d decoded=%d pli=%d tcc=%d keyframes=%d gaps=%d fec=%u",
              now[0], now[1], now[2], g_atomic_int_get(&g_v.st_last_pt), jpushed, jlost, jlate, jdup,
              g_atomic_int_get(&g_v.st_depay_in), now[3], now[4], now[5], now[6], now[7], now[8],
              (unsigned)g_v.rx_fec_skipped);
}

/* Dedicated sender thread, for the whole call. CRITICAL: nice_agent_send() must NOT be called from
 * the agent's own GMainContext (g_sm.ctx) - doing so self-deadlocks on the agent mutex in libnice
 * 0.1.21, which froze BOTH the media thread (no more STUN consent responses) AND nicesink's audio
 * (also nice_agent_send), so the peer saw us go silent and hung up ~2-5s in. This thread only pushes
 * into the data appsrc. It also owns g_data_srtp, so srtp_protect is never hit concurrently. The
 * rtp-data message goes out every 500 ms (RingRTC re-sends its own every second); a keyframe
 * request as soon as one is wanted, at most every SM_PLI_INTERVAL_US. Nothing is sent until there
 * is something to say: before the user answers an incoming call, or in a voice call we placed,
 * this sends nothing at all. */
static gint     g_sender_run = 0;
static GThread *g_sender_thread = NULL;

/* TRUE if a keyframe request is wanted and the last one went out at least SM_PLI_INTERVAL_US
 * before `now`; it is then taken. */
static gboolean sm_pli_take(gint64 now)
{
    if (!g_atomic_int_get(&g_v.pli_wanted) || now - g_v.last_pli_us < SM_PLI_INTERVAL_US)
        return FALSE;
    g_atomic_int_set(&g_v.pli_wanted, 0);
    g_v.last_pli_us = now;
    return TRUE;
}

static gpointer sender_thread_fn(gpointer u)
{
    (void)u;
    guint tick = 0;
    while (g_atomic_int_get(&g_sender_run)) {
        if (tick % 20 == 0)
            sm_log_rx_stats();
        sm_push_tcc();
        sm_keyframe_watchdog();
        if (tick++ % 5 == 0)
            sm_push_data_message();
        if (sm_pli_take(g_get_monotonic_time()))
            sm_push_pli();
        g_usleep(100000);
    }
    return NULL;
}

/* Put the held-back pulsesrc into the running pipeline and start it. Runs on the media thread. */
static gboolean sm_open_mic(gpointer data)
{
    SignalMedia *sm = (SignalMedia *)data;
    if (!sm->mic || !sm->pipeline) return G_SOURCE_REMOVE;
    GstElement *mic = sm->mic;
    sm->mic = NULL;
    GstElement *txconv = gst_bin_get_by_name(GST_BIN(sm->pipeline), "tx-aconv");
    gst_bin_add(GST_BIN(sm->pipeline), mic);   /* the bin takes its own reference */
    if (!txconv || !gst_element_link(mic, txconv) || !gst_element_sync_state_with_parent(mic))
        g_printerr("signal_media: could not start the microphone\n");
    if (txconv) gst_object_unref(txconv);
    gst_object_unref(mic);
    return G_SOURCE_REMOVE;
}

/* The user tapped Answer (ACCEPT stdin cmd): open the microphone and start emitting the RingRTC
 * Accepted so the caller's phone stops ringing and both sides ungate audio. Idempotent. */
static gboolean sm_video_tx_start(gpointer data);

void signal_media_accept(unsigned long long call_id)
{
    g_accept_id = call_id;
    if (g_accepted) return;         /* already emitting */
    if (!g_atomic_int_get(&g_v.have_call_id)) {
        g_v.call_id = call_id;
        g_atomic_int_set(&g_v.have_call_id, 1);
    }
    g_accepted = TRUE;
    if (g_sm.ctx) g_main_context_invoke(g_sm.ctx, sm_open_mic, &g_sm);
    /* A camera the user turned on while it rang starts now, not before the answer. */
    if (g_v.tx_wanted) sm_on_media_thread(sm_video_tx_start, NULL);
    g_message("signal_media: ACCEPT call_id=%llu -> emitting rtp-data Accepted", call_id);
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
    if (!e) g_printerr("signal_media: missing GStreamer element '%s'\n", factory);
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
    g_message("signal_media: inbound SRTP arriving (ssrc %u)", ssrc);
    if (!sm->rx_master) return NULL;
    GstCaps *caps = gst_caps_new_simple("application/x-srtp",
                                        "srtp-cipher",  G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtp-auth",    G_TYPE_STRING, SRTP_AUTH_NULL,
                                        "srtcp-cipher", G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtcp-auth",   G_TYPE_STRING, SRTP_AUTH_NULL,
                                        NULL);
    /* gst_caps_set_simple takes its own reference to the buffer; ours stays with sm. */
    gst_caps_set_simple(caps, "srtp-key", GST_TYPE_BUFFER, sm->rx_master, NULL);
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

/* ------------------------------------------------------------------ video ---------------------- */

/* Set a property from a string only where the element has it (versions differ). */
static void sm_try_set(GstElement *e, const char *prop, const char *value)
{
    if (e && g_object_class_find_property(G_OBJECT_GET_CLASS(e), prop))
        gst_util_set_object_arg(G_OBJECT(e), prop, value);
}

/* The element factory to use: $env if set, else the first of names that exists. */
static const char *sm_pick_factory(const char *env, const char *const *names)
{
    const char *forced = g_getenv(env);
    if (forced && *forced)
        return forced;
    for (int i = 0; names[i]; i++) {
        GstElementFactory *f = gst_element_factory_find(names[i]);
        if (f) {
            gst_object_unref(f);
            return names[i];
        }
    }
    return NULL;
}

/* Free elements that were made but never added to a bin. */
static void sm_drop_elements(GstElement **els, int n)
{
    for (int i = 0; i < n; i++)
        if (els[i])
            gst_object_unref(gst_object_ref_sink(els[i]));
}

/* One received packet that srtpdec decrypted: TRUE to keep it in the audio chain. VP8, bare or
 * inside RED (how WebRTC sends it), goes to the video branch, the far side's rtp-data messages are read here, everything else (RTX, RED, FEC,
 * which we never negotiate away) is dropped instead of reaching the Opus depayloader. Runs on the
 * receive streaming thread. */
static gboolean sm_rx_route(GstBuffer *buf)
{
    GstMapInfo m;
    SvRtp r;
    gboolean keep = FALSE;
    if (!gst_buffer_map(buf, &m, GST_MAP_READ))
        return FALSE;
    if (sv_rtp_parse(m.data, m.size, &r) != 0) {
        gst_buffer_unmap(buf, &m);
        return FALSE;
    }
    const guint8 *tseq = NULL;
    size_t tseq_len = 0;
    if (sv_rtp_find_ext(m.data, m.size, &r, SV_EXT_TCC, &tseq, &tseq_len) == 0 && tseq_len >= 2) {
        g_mutex_lock(&g_tcc_lock);
        sv_tcc_record(&g_tcc, (guint16)((guint)tseq[0] << 8 | tseq[1]), g_get_monotonic_time() - g_tcc_t0);
        g_mutex_unlock(&g_tcc_lock);
    }
    /* WebRTC wraps its video in RED (and sends ULPFEC that way too): take out the VP8 inside. */
    GstBuffer *vp8 = NULL;
    if (r.pt == SV_PT_RED) {
        guint8 inner = 0;
        GstBuffer *out = gst_buffer_new_allocate(NULL, m.size, NULL);
        GstMapInfo om;
        gsize n = 0;
        if (out && gst_buffer_map(out, &om, GST_MAP_WRITE)) {
            n = sv_red_unwrap(m.data, m.size, om.data, om.size, &inner);
            gst_buffer_unmap(out, &om);
        }
        if (n > 0 && inner == SV_PT_VP8) {
            gst_buffer_set_size(out, n);
            vp8 = out;
            /* The FEC packets dropped below took sequence numbers of the same stream: close those
             * gaps, or the jitter buffer reports them lost and the depayloader waits for a
             * keyframe each time. */
            if (g_v.rx_fec_skipped && gst_buffer_map(out, &om, GST_MAP_WRITE)) {
                guint16 seq = (guint16)(((guint)om.data[2] << 8 | om.data[3]) - g_v.rx_fec_skipped);
                om.data[2] = (guint8)(seq >> 8);
                om.data[3] = (guint8)seq;
                gst_buffer_unmap(out, &om);
            }
        } else if (out) {
            gst_buffer_unref(out);
            if (n > 0 && inner == SV_PT_ULPFEC)
                g_v.rx_fec_skipped++;
        }
        if (!vp8) {
            g_atomic_int_inc(&g_v.st_other);
            g_atomic_int_set(&g_v.st_last_pt, n > 0 ? inner : r.pt);
        }
    } else if (r.pt == SV_PT_VP8) {
        vp8 = gst_buffer_ref(buf);
    }

    if (r.pt == SV_PT_OPUS) {
        keep = TRUE;
    } else if (vp8) {
        const guint8 *cvo = NULL;
        size_t cvo_len = 0;
        if (sv_rtp_find_ext(m.data, m.size, &r, SV_EXT_CVO, &cvo, &cvo_len) == 0 && cvo_len >= 1) {
            gint q = sv_cvo_to_phone_quarter_turns(cvo[0]);
            if (g_atomic_int_get(&g_v.peer_rot) != q) {
                g_atomic_int_set(&g_v.peer_rot, q);
                sm_event("PEERROT %d", q);
            }
        }
        g_atomic_int_inc(&g_v.st_vp8);
        GstMapInfo vm;
        if (gst_buffer_map(vp8, &vm, GST_MAP_READ)) {
            SvRtp vr;
            if (sv_rtp_parse(vm.data, vm.size, &vr) == 0) {
                if (g_v.st_last_seq >= 0) {
                    guint16 d = (guint16)(vr.seq - (guint16)g_v.st_last_seq);
                    if (d > 1 && d < 1000)
                        g_atomic_int_add(&g_v.st_gap, d - 1);
                }
                g_v.st_last_seq = vr.seq;
                if (sv_vp8_is_keyframe_start(vm.data + vr.header_len, vm.size - vr.header_len))
                    g_atomic_int_inc(&g_v.st_kf);
            }
            gst_buffer_unmap(vp8, &vm);
        }
        if (!g_v.rx_src)
            gst_buffer_unref(vp8);
        else if (gst_app_src_push_buffer(GST_APP_SRC(g_v.rx_src), vp8) != GST_FLOW_OK)  /* takes vp8 */
            g_atomic_int_inc(&g_v.st_push_fail);
    } else if (r.pt == SV_PT_RED) {
        /* ULPFEC or a malformed RED packet: counted above, dropped */
    } else if (r.pt != SV_PT_DATA) {
        g_atomic_int_inc(&g_v.st_other);
        g_atomic_int_set(&g_v.st_last_pt, r.pt);
    } else if (r.ssrc == SV_SSRC_DATA) {
        size_t plen = m.size - r.header_len;
        if ((m.data[0] & 0x20) && plen > 0)           /* padding: its count is the last byte */
            plen = m.data[m.size - 1] <= plen ? plen - m.data[m.size - 1] : 0;
        SvDataMsg dm;
        if (sv_data_msg_decode(m.data + r.header_len, plen, &dm) == 0 && dm.has_status &&
            dm.video_enabled >= 0 && g_atomic_int_get(&g_v.peer_video) != dm.video_enabled) {
            g_atomic_int_set(&g_v.peer_video, dm.video_enabled);
            sm_event("PEERVIDEO %d", dm.video_enabled);
        }
    }
    gst_buffer_unmap(buf, &m);
    return keep;
}

/* On srtpdec's rtp_src: route every decrypted packet (nicesrc pushes buffer lists too). */
static GstPadProbeReturn sm_rx_split_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER)
        return sm_rx_route(GST_PAD_PROBE_INFO_BUFFER(info)) ? GST_PAD_PROBE_OK : GST_PAD_PROBE_DROP;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        GstBufferList *list = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
        GstBufferList *keep = gst_buffer_list_new();
        guint n = gst_buffer_list_length(list);
        for (guint i = 0; i < n; i++) {
            GstBuffer *b = gst_buffer_list_get(list, i);
            if (sm_rx_route(b))
                gst_buffer_list_add(keep, gst_buffer_ref(b));
        }
        if (gst_buffer_list_length(keep) == 0) {
            gst_buffer_list_unref(keep);
            return GST_PAD_PROBE_DROP;
        }
        gst_buffer_list_unref(list);
        GST_PAD_PROBE_INFO_DATA(info) = keep;
    }
    return GST_PAD_PROBE_OK;
}

/* Ask our encoder for a keyframe (the far side sent a PLI or FIR). */
static void sm_video_force_keyframe(void)
{
    GstElement *enc = g_v.tx_enc;
    if (!enc)
        return;
    GstPad *src = gst_element_get_static_pad(enc, "src");
    if (src) {
        GstStructure *st = gst_structure_new("GstForceKeyUnit", "all-headers", G_TYPE_BOOLEAN, TRUE, NULL);
        gst_pad_send_event(src, gst_event_new_custom(GST_EVENT_CUSTOM_UPSTREAM, st));
        gst_object_unref(src);
    }
}

static void sm_rx_rtcp_buffer(GstBuffer *buf)
{
    GstMapInfo m;
    if (!gst_buffer_map(buf, &m, GST_MAP_READ))
        return;
    if (sv_rtcp_wants_keyframe(m.data, m.size, sv_video_ssrc(g_sm.is_caller)) == 1)
        sm_video_force_keyframe();
    gst_buffer_unmap(buf, &m);
}

/* On srtpdec's rtcp_src: the far side's RTCP, read for keyframe requests, then drained. */
static GstPadProbeReturn sm_rx_rtcp_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER) {
        sm_rx_rtcp_buffer(GST_PAD_PROBE_INFO_BUFFER(info));
    } else if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        GstBufferList *list = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
        guint n = gst_buffer_list_length(list);
        for (guint i = 0; i < n; i++)
            sm_rx_rtcp_buffer(gst_buffer_list_get(list, i));
    }
    return GST_PAD_PROBE_OK;
}

/* rtpvp8depay asks upstream for a keyframe (GstForceKeyUnit) when it lost data: send a PLI. */
static GstPadProbeReturn sm_rx_keyframe_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    GstEvent *ev = GST_PAD_PROBE_INFO_EVENT(info);
    if (ev && GST_EVENT_TYPE(ev) == GST_EVENT_CUSTOM_UPSTREAM && gst_event_has_name(ev, "GstForceKeyUnit"))
        g_atomic_int_set(&g_v.pli_wanted, 1);
    return GST_PAD_PROBE_OK;
}

/* Counts buffers on a pad into the int at u (receive statistics). */
static GstPadProbeReturn sm_count_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)info;
    g_atomic_int_inc((gint *)u);
    return GST_PAD_PROBE_OK;
}

/* The first decoded frame on its way to the Phone app's socket: say where it is. */
static GstPadProbeReturn sm_rx_first_frame_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)info; (void)u;
    if (g_atomic_int_compare_and_exchange(&g_v.rx_announced, 0, 1)) {
        GstElement *shm = gst_pad_get_parent_element(pad);
        gchar *path = NULL;
        if (shm) {
            g_object_get(shm, "socket-path", &path, NULL);
            gst_object_unref(shm);
        }
        sm_event("VSHM %s %d %d", path ? path : SM_VIDEO_SHM, SM_VIDEO_W, SM_VIDEO_H);
        g_free(path);
    }
    return GST_PAD_PROBE_REMOVE;
}

/* A shmsink the Phone app reads, which must never hold the pipeline up: a reader that keeps its
 * buffers fills the shm area, and a blocking shmsink would then stall everything upstream (the
 * freeze seen with WhatsApp's second reader). Frames are dropped in the leaky queue before it. */
static void sm_configure_shm(GstElement *queue, GstElement *shm, const char *path)
{
    g_object_set(queue, "leaky", 2 /* downstream */, "max-size-buffers", 2, "max-size-time", (guint64)0,
                 "max-size-bytes", 0, NULL);
    g_object_set(shm, "socket-path", path, "shm-size", (guint)SM_SHM_SIZE, "wait-for-connection", FALSE,
                 "sync", FALSE, "async", FALSE, NULL);
}

/* The shm socket paths; SIGNAL_MEDIA_VIDEO_SHM / SIGNAL_MEDIA_PREVIEW_SHM override them (tests). */
static const char *sm_shm_path(const char *env, const char *dflt)
{
    const char *p = g_getenv(env);
    return p && *p ? p : dflt;
}

static GstCaps *sm_i420_caps(int w, int h, int fps)
{
    GstCaps *c = gst_caps_new_simple("video/x-raw",
                                     "format", G_TYPE_STRING, "I420",
                                     "width", G_TYPE_INT, w,
                                     "height", G_TYPE_INT, h,
                                     "pixel-aspect-ratio", GST_TYPE_FRACTION, 1, 1, NULL);
    if (fps > 0)
        gst_caps_set_simple(c, "framerate", GST_TYPE_FRACTION, fps, 1, NULL);
    return c;
}

/* Receive branch: appsrc (VP8 RTP from sm_rx_route) -> rtpjitterbuffer -> rtpvp8depay -> VP8
 * decoder -> I420 640x480, letterboxed -> leaky queue -> shmsink. Built with the call; nothing
 * runs until the far side sends video. Without one of its elements the call stays voice only. */
static gboolean sm_video_rx_build(GstElement *pipeline)
{
    if (g_strcmp0(g_getenv("SIGNAL_MEDIA_VIDEO"), "0") == 0)
        return FALSE;
    static const char *const decoders[] = { "avdec_vp8", "vp8dec", "droidvdec", NULL };
    const char *decname = sm_pick_factory("SIGNAL_MEDIA_VP8_DEC", decoders);
    GstElement *e[9] = {
        mk("appsrc", "rxv-src"), mk("rtpjitterbuffer", "rxv-jitterbuf"), mk("rtpvp8depay", "rxv-depay"),
        decname ? mk(decname, "rxv-dec") : NULL, mk("videoconvert", "rxv-conv"),
        mk("videoscale", "rxv-scale"), mk("capsfilter", "rxv-caps"), mk("queue", "rxv-queue"),
        mk("shmsink", "rxv-shm"),
    };
    for (int i = 0; i < 9; i++) {
        if (!e[i]) {
            sm_drop_elements(e, 9);
            sm_event("VIDEOERR rx-elements");
            return FALSE;
        }
    }
    GstElement *src = e[0], *jb = e[1], *depay = e[2], *caps = e[6], *q = e[7], *shm = e[8];

    GstCaps *rc = gst_caps_new_simple("application/x-rtp",
                                      "media", G_TYPE_STRING, "video",
                                      "clock-rate", G_TYPE_INT, SV_VIDEO_CLOCK,
                                      "encoding-name", G_TYPE_STRING, "VP8",
                                      "payload", G_TYPE_INT, SV_PT_VP8, NULL);
    g_object_set(src, "caps", rc, "is-live", TRUE, "format", GST_FORMAT_TIME, "do-timestamp", TRUE,
                 "block", FALSE, "max-bytes", (guint64)(2u << 20), NULL);
    gst_caps_unref(rc);
    sm_try_set(src, "leaky-type", "downstream");
    g_object_set(jb, "latency", 200, "do-lost", TRUE, NULL);
    sm_try_set(depay, "request-keyframe", "true");
    sm_try_set(depay, "wait-for-keyframe", "true");
    GstCaps *vc = sm_i420_caps(SM_VIDEO_W, SM_VIDEO_H, 0);
    g_object_set(caps, "caps", vc, NULL);
    gst_caps_unref(vc);
    sm_configure_shm(q, shm, sm_shm_path("SIGNAL_MEDIA_VIDEO_SHM", SM_VIDEO_SHM));

    gst_bin_add_many(GST_BIN(pipeline), e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], NULL);
    if (!gst_element_link_many(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], NULL)) {
        sm_event("VIDEOERR rx-link");
        return FALSE;
    }
    GstPad *p = gst_element_get_static_pad(depay, "sink");
    gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_EVENT_UPSTREAM, sm_rx_keyframe_probe, NULL, NULL);
    gst_object_unref(p);
    p = gst_element_get_static_pad(depay, "sink");
    gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_count_probe, &g_v.st_depay_in, NULL);
    gst_object_unref(p);
    p = gst_element_get_static_pad(depay, "src");
    gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_count_probe, &g_v.st_depay, NULL);
    gst_object_unref(p);
    p = gst_element_get_static_pad(e[3], "src");
    gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_count_probe, &g_v.st_dec, NULL);
    gst_object_unref(p);
    p = gst_element_get_static_pad(shm, "sink");
    gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_rx_first_frame_probe, NULL, NULL);
    gst_object_unref(p);
    g_v.rx_src = src;
    g_v.rx_shm = shm;
    g_v.rx_jb = jb;
    g_message("signal_media: video receive branch up (%s)", decname);
    return TRUE;
}

/* Our VP8 packets, on rtpvp8pay's src pad. Nothing leaves before the user answered an incoming call
 * (the camera does not even start before that; this is the second line). The last packet of each
 * frame carries the orientation (CVO), where WebRTC's receiver reads it. */
static GstBuffer *sm_tx_add_cvo(GstBuffer *buf)
{
    GstMapInfo m;
    if (!gst_buffer_map(buf, &m, GST_MAP_READ))
        return buf;
    if (m.size < 2 || !(m.data[1] & 0x80)) {
        gst_buffer_unmap(buf, &m);
        return buf;
    }
    guint8 cvo = (guint8)g_atomic_int_get(&g_v.tx_cvo);
    gsize cap = m.size + 24;
    GstBuffer *out = gst_buffer_new_allocate(NULL, cap, NULL);
    GstMapInfo om;
    size_t n = 0;
    if (out && gst_buffer_map(out, &om, GST_MAP_WRITE)) {
        n = sv_rtp_add_ext(m.data, m.size, SV_EXT_CVO, &cvo, 1, om.data, om.size);
        gst_buffer_unmap(out, &om);
    }
    gst_buffer_unmap(buf, &m);
    if (n == 0) {
        if (out) gst_buffer_unref(out);
        return buf;
    }
    gst_buffer_set_size(out, (gssize)n);
    gst_buffer_copy_into(out, buf, GST_BUFFER_COPY_METADATA, 0, (gsize)-1);
    gst_buffer_unref(buf);
    return out;
}

static gboolean sm_tx_video_allowed(void)
{
    return g_sm.is_caller || g_accepted;
}

static GstPadProbeReturn sm_tx_video_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    if (!sm_tx_video_allowed())
        return GST_PAD_PROBE_DROP;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER) {
        GST_PAD_PROBE_INFO_DATA(info) = sm_tx_add_cvo(GST_PAD_PROBE_INFO_BUFFER(info));
    } else if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        GstBufferList *list = gst_buffer_list_make_writable(GST_PAD_PROBE_INFO_BUFFER_LIST(info));
        guint n = gst_buffer_list_length(list);
        for (guint i = 0; i < n; i++) {
            GstBuffer *b = gst_buffer_list_get(list, i);
            GstBuffer *nb = sm_tx_add_cvo(gst_buffer_ref(b));
            if (nb != b) {
                gst_buffer_list_remove(list, i, 1);
                gst_buffer_list_insert(list, (gint)i, nb);
            } else {
                gst_buffer_unref(nb);
            }
        }
        GST_PAD_PROBE_INFO_DATA(info) = list;
    }
    return GST_PAD_PROBE_OK;
}

/* The persistent send tail: queue -> vp8enc -> rtpvp8pay (our fixed SSRC) -> srtpenc (our key) ->
 * the audio's funnel. It lives as long as the call, so RTP sequence numbers and the SRTP index of
 * our video SSRC only ever go forward: a fresh payloader and srtpenc for every camera start would
 * restart them under the same key, i.e. reuse AES-GCM nonces. The camera part is added and removed
 * in front of it (sm_video_tx_start/stop). Without vp8enc - the image does not build
 * gstreamer1.0-plugins-good with vpx today - the call receives video but cannot send any. */
static GstElement *g_tx_vqueue;   /* the tail's first element; a camera head links to its sink */

static gboolean sm_video_tx_build(GstElement *pipeline, GstElement *funnel)
{
    if (g_strcmp0(g_getenv("SIGNAL_MEDIA_VIDEO"), "0") == 0)
        return FALSE;
    static const char *const encoders[] = { "vp8enc", NULL };
    const char *encname = sm_pick_factory("SIGNAL_MEDIA_VP8_ENC", encoders);
    GstElement *e[4] = {
        mk("queue", "txv-queue"), encname ? mk(encname, "txv-enc") : NULL,
        mk("rtpvp8pay", "txv-pay"), mk("srtpenc", "txv-srtpenc"),
    };
    for (int i = 0; i < 4; i++) {
        if (!e[i]) {
            sm_drop_elements(e, 4);
            sm_event("VIDEOERR tx-encoder");
            return FALSE;
        }
    }
    GstElement *q = e[0], *enc = e[1], *pay = e[2], *senc = e[3];
    g_object_set(q, "leaky", 2 /* downstream */, "max-size-buffers", 3, "max-size-time", (guint64)0,
                 "max-size-bytes", 0, NULL);
    /* Real time, constant rate, no look-ahead, keyframes only when asked for (as WebRTC does). */
    sm_try_set(enc, "deadline", "1");
    sm_try_set(enc, "cpu-used", "12");
    sm_try_set(enc, "end-usage", "cbr");
    sm_try_set(enc, "lag-in-frames", "0");
    sm_try_set(enc, "keyframe-mode", "disabled");
    sm_try_set(enc, "error-resilient", "default");
    sm_try_set(enc, "threads", "2");
    { gchar *br = g_strdup_printf("%d", SM_VIDEO_BITRATE); sm_try_set(enc, "target-bitrate", br); g_free(br); }
    g_object_set(pay, "pt", SV_PT_VP8, "ssrc", sv_video_ssrc(g_sm.is_caller), "mtu", 1200, NULL);
    sm_try_set(pay, "picture-id-mode", "15-bit");
    GstBuffer *tx_master = g_sm.is_caller
        ? master_key_buffer(g_sm.keys.offer_key,  g_sm.keys.offer_salt)
        : master_key_buffer(g_sm.keys.answer_key, g_sm.keys.answer_salt);
    configure_srtpenc(senc, tx_master);
    gst_buffer_unref(tx_master);

    gst_bin_add_many(GST_BIN(pipeline), q, enc, pay, senc, NULL);
    if (!gst_element_link_many(q, enc, pay, senc, funnel, NULL)) {
        sm_event("VIDEOERR tx-link");
        return FALSE;
    }
    GstPad *p = gst_element_get_static_pad(pay, "src");
    gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, sm_tx_video_probe, NULL, NULL);
    gst_object_unref(p);
    g_tx_vqueue = q;
    g_v.tx_enc = enc;
    return TRUE;
}

static GstElement *g_tx_head;     /* the camera part, while the camera is on */
static GstElement *g_tx_cam;      /* the droidcamsrc in it, if any (for its sensor orientation) */

/* The rotation we send: SIGNAL_MEDIA_VIDEO_ROTATION (quarter turns clockwise), else the camera's
 * sensor orientation, as WebRTC's Android capturer reports a portrait phone's frames. */
static gint sm_tx_rotation(void)
{
    const char *env = g_getenv("SIGNAL_MEDIA_VIDEO_ROTATION");
    if (env && *env)
        return (gint)(g_ascii_strtoll(env, NULL, 10) & 3);
    if (g_tx_cam && g_object_class_find_property(G_OBJECT_GET_CLASS(g_tx_cam), "sensor-orientation")) {
        gint deg = 0;
        g_object_get(g_tx_cam, "sensor-orientation", &deg, NULL);
        return ((deg + 45) / 90) & 3;
    }
    return 0;
}

/* The first self-view frame: the camera runs, so its orientation is known; say where the picture is. */
static GstPadProbeReturn sm_tx_first_frame_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)info; (void)u;
    if (g_atomic_int_compare_and_exchange(&g_v.tx_announced, 0, 1)) {
        gint rot = sm_tx_rotation();
        g_atomic_int_set(&g_v.tx_cvo, sv_cvo_from_clockwise_quarter_turns(rot));
        GstElement *shm = gst_pad_get_parent_element(pad);
        gchar *path = NULL;
        if (shm) {
            g_object_get(shm, "socket-path", &path, NULL);
            gst_object_unref(shm);
        }
        sm_event("VPREVIEW %s %d %d %d %d", path ? path : SM_PREVIEW_SHM, SM_PREVIEW_W, SM_PREVIEW_H,
                 sv_cvo_to_phone_quarter_turns((guint8)rot), g_v.tx_mirrored ? 1 : 0);
        g_free(path);
    }
    return GST_PAD_PROBE_REMOVE;
}

/* The camera source: SIGNAL_MEDIA_VIDEO_SRC (a gst-launch description), else the front camera of
 * the droid stack's viewfinder (plain NV21; the recorder path WhatsApp uses only gives H.264),
 * else the first V4L2 device. */
static const char *sm_camera_description(gboolean *mirrored)
{
    const char *env = g_getenv("SIGNAL_MEDIA_VIDEO_SRC");
    const char *mir = g_getenv("SIGNAL_MEDIA_VIDEO_MIRROR");
    if (env && *env) {
        *mirrored = g_strcmp0(mir, "1") == 0;
        return env;
    }
    GstElementFactory *f = gst_element_factory_find("droidcamsrc");
    if (f) {
        gst_object_unref(f);
        *mirrored = g_strcmp0(mir, "0") != 0;
        /* Fixed viewfinder caps: droidcamsrc only fixes the size and frame rate of what its peer
         * accepts, and a peer that scales to pixel-aspect-ratio 1/1 accepts a range of them; the
         * unfixed caps then fail the viewfinder ("failed to negotiate vfsrc", seen on sargo
         * 2026-11-04). 640x480 at 30 fps is a viewfinder mode of sargo's front camera. */
        return "droidcamsrc camera-device=1 name=sigcam sigcam.vfsrc ! "
               "video/x-raw,format=NV21,width=640,height=480,framerate=30/1,pixel-aspect-ratio=1/1 ! queue "
               "sigcam.imgsrc ! fakesink sigcam.vidsrc ! fakesink";
    }
    f = gst_element_factory_find("v4l2src");
    if (f) {
        gst_object_unref(f);
        *mirrored = g_strcmp0(mir, "1") == 0;
        return "v4l2src ! queue";
    }
    return NULL;
}

/* Turn the camera on (media thread): camera -> I420 640x480 at 15 fps -> tee -> the send tail, and
 * -> 320x240 -> the self-view socket. */
static gboolean sm_video_tx_start(gpointer data)
{
    (void)data;
    if (g_tx_head || !g_v.tx_wanted || !g_tx_vqueue || !g_sm.pipeline || !sm_tx_video_allowed())
        return G_SOURCE_REMOVE;
    gboolean mirrored = FALSE;
    const char *desc = sm_camera_description(&mirrored);
    if (!desc) {
        sm_event("VIDEOERR tx-camera");
        return G_SOURCE_REMOVE;
    }
    GError *err = NULL;
    GstElement *cam = gst_parse_bin_from_description(desc, TRUE, &err);
    if (!cam) {
        g_printerr("signal_media: camera '%s': %s\n", desc, err ? err->message : "?");
        g_clear_error(&err);
        sm_event("VIDEOERR tx-camera");
        return G_SOURCE_REMOVE;
    }
    g_clear_error(&err);
    GstElement *e[9] = {
        cam, mk("videoconvert", "txv-conv"), mk("videoscale", "txv-scale"), mk("videorate", "txv-rate"),
        mk("capsfilter", "txv-caps"), mk("tee", "txv-tee"), mk("queue", "txv-pvqueue"),
        mk("videoscale", "txv-pvscale"), mk("capsfilter", "txv-pvcaps"),
    };
    GstElement *pshm = mk("shmsink", "txv-pvshm");
    GstElement *pq = mk("queue", "txv-pvleak");
    for (int i = 0; i < 9; i++) {
        if (!e[i] || !pshm || !pq) {
            sm_drop_elements(e, 9);
            GstElement *rest[2] = { pshm, pq };
            sm_drop_elements(rest, 2);
            sm_event("VIDEOERR tx-elements");
            return G_SOURCE_REMOVE;
        }
    }
    GstElement *head = gst_bin_new("txv-head");
    GstCaps *c = sm_i420_caps(SM_VIDEO_W, SM_VIDEO_H, SM_VIDEO_FPS);
    g_object_set(e[4], "caps", c, NULL);
    gst_caps_unref(c);
    c = sm_i420_caps(SM_PREVIEW_W, SM_PREVIEW_H, 0);
    g_object_set(e[8], "caps", c, NULL);
    gst_caps_unref(c);
    g_object_set(e[6], "leaky", 2, "max-size-buffers", 2, "max-size-time", (guint64)0, "max-size-bytes", 0, NULL);
    sm_configure_shm(pq, pshm, sm_shm_path("SIGNAL_MEDIA_PREVIEW_SHM", SM_PREVIEW_SHM));
    sm_try_set(e[3], "drop-only", "true");
    gst_bin_add_many(GST_BIN(head), e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], pq, pshm, NULL);
    gboolean ok = gst_element_link_many(e[0], e[1], e[2], e[3], e[4], e[5], NULL) &&
                  gst_element_link_many(e[5], e[6], e[7], e[8], pq, pshm, NULL);
    GstPad *teesrc = ok ? gst_element_request_pad_simple(e[5], "src_%u") : NULL;
    GstPad *ghost = teesrc ? gst_ghost_pad_new("src", teesrc) : NULL;
    if (teesrc) gst_object_unref(teesrc);
    if (ghost) ok = gst_element_add_pad(head, ghost);
    else ok = FALSE;
    if (!ok) {
        gst_object_unref(gst_object_ref_sink(head));
        sm_event("VIDEOERR tx-link");
        return G_SOURCE_REMOVE;
    }
    GstPad *p = gst_element_get_static_pad(pshm, "sink");
    gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_tx_first_frame_probe, NULL, NULL);
    gst_object_unref(p);

    g_v.tx_mirrored = mirrored;
    g_atomic_int_set(&g_v.tx_announced, 0);
    g_tx_cam = GST_IS_BIN(cam) ? gst_bin_get_by_name(GST_BIN(cam), "sigcam") : NULL;
    gst_bin_add(GST_BIN(g_sm.pipeline), head);
    GstPad *qsink = gst_element_get_static_pad(g_tx_vqueue, "sink");
    GstPadLinkReturn lr = gst_pad_link(ghost, qsink);
    gst_object_unref(qsink);
    if (lr != GST_PAD_LINK_OK || !gst_element_sync_state_with_parent(head)) {
        gst_element_set_state(head, GST_STATE_NULL);
        gst_bin_remove(GST_BIN(g_sm.pipeline), head);
        if (g_tx_cam) { gst_object_unref(g_tx_cam); g_tx_cam = NULL; }
        sm_event("VIDEOERR tx-camera");
        return G_SOURCE_REMOVE;
    }
    g_tx_head = head;
    g_atomic_int_set(&g_v.status_video, 1);
    g_atomic_int_set(&g_v.status_known, 1);
    sm_event("VTX 1");
    g_message("signal_media: camera on (%s)", desc);
    return G_SOURCE_REMOVE;
}

/* Turn the camera off (media thread): the camera part leaves the pipeline, the send tail stays. */
static gboolean sm_video_tx_stop(gpointer data)
{
    (void)data;
    if (!g_tx_head)
        return G_SOURCE_REMOVE;
    GstElement *head = g_tx_head;
    g_tx_head = NULL;
    gst_element_set_state(head, GST_STATE_NULL);
    GstPad *ghost = gst_element_get_static_pad(head, "src");
    GstPad *peer = ghost ? gst_pad_get_peer(ghost) : NULL;
    if (peer) {
        gst_pad_unlink(ghost, peer);
        gst_object_unref(peer);
    }
    if (ghost) gst_object_unref(ghost);
    gst_bin_remove(GST_BIN(g_sm.pipeline), head);
    if (g_tx_cam) { gst_object_unref(g_tx_cam); g_tx_cam = NULL; }
    g_atomic_int_set(&g_v.status_video, 0);
    sm_event("VTX 0");
    g_message("signal_media: camera off");
    return G_SOURCE_REMOVE;
}

void signal_media_set_video(int on)
{
    g_v.tx_wanted = on ? TRUE : FALSE;
    /* Said even before the camera runs, so a camera turned off reaches the far side as off. */
    g_atomic_int_set(&g_v.status_known, 1);
    if (!on)
        g_atomic_int_set(&g_v.status_video, 0);
    sm_on_media_thread(on ? sm_video_tx_start : sm_video_tx_stop, NULL);
}

void signal_media_set_call_id(unsigned long long call_id)
{
    /* Set once; the sender thread reads it after seeing have_call_id. */
    if (g_atomic_int_get(&g_v.have_call_id))
        return;
    g_v.call_id = call_id;
    g_atomic_int_set(&g_v.have_call_id, 1);
}

/* A new call: what IPC said before START (camera wanted, call id) is kept, the rest starts over. */
static void sm_video_reset(void)
{
    SmVideo keep = g_v;
    memset(&g_v, 0, sizeof g_v);
    g_v.tx_wanted = keep.tx_wanted;
    g_v.status_known = keep.status_known;
    g_v.call_id = keep.call_id;
    g_v.have_call_id = keep.have_call_id;
    g_v.peer_rot = -1;
    g_v.peer_video = -1;
    g_v.st_last_seq = -1;
    g_mutex_lock(&g_tcc_lock);
    sv_tcc_init(&g_tcc);
    g_tcc_t0 = g_get_monotonic_time();
    g_mutex_unlock(&g_tcc_lock);
    g_tx_vqueue = NULL;
    g_tx_head = NULL;
    g_tx_cam = NULL;
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
        g_debug("signal_media: local candidate %s", bare);
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
            g_debug("signal_media: ICE selected pair local[%s] remote[%s]",
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
    /* RFC5245 full ICE. Using the private context so all agent signals fire on our media thread. */
    sm->agent = nice_agent_new(sm->ctx, NICE_COMPATIBILITY_RFC5245);
    if (!sm->agent) { g_printerr("signal_media: nice_agent_new failed\n"); return FALSE; }

    /* ICE role: the CALLER (offerer) is CONTROLLING, the answerer is CONTROLLED. */
    g_object_set(sm->agent, "controlling-mode", sm->is_caller ? TRUE : FALSE, NULL);
    g_message("signal_media: role=%s controlling-mode=%d",
              sm->is_caller ? "CALLER" : "ANSWERER", sm->is_caller ? 1 : 0);

    /* Signal's peer is RingRTC (libwebrtc), which nominates the selected pair with Google's ICE
     * renomination extension - a STUN NOMINATION attribute (0xC001) - not USE-CANDIDATE: in captures
     * every inbound binding request carried GOOG-NOMINATION and never USE-CANDIDATE. libnice
     * implements it behind support-renomination, which defaults to FALSE; without it the answerer
     * never nominates a pair and ICE fails. Harmless for the caller, which drives nomination. */
    g_object_set(sm->agent, "support-renomination", TRUE, NULL);

    /* Keepalive as STUN binding REQUESTS, not indications. After ICE reaches READY, libnice's default
     * keepalive is a STUN binding *indication* (no reply expected). RingRTC/libwebrtc runs RFC7675
     * consent freshness and drops the call within seconds if the selected pair looks idle - our
     * indications don't satisfy it. keepalive-conncheck=TRUE makes libnice send binding *requests*
     * (which draw responses), keeping the peer's consent fresh so it doesn't tear the call down. */
    g_object_set(sm->agent, "keepalive-conncheck", TRUE, NULL);

    /* Keep the candidate set small. With full trickle ICE (host, srflx and several relays, 10-20
     * pairs each retrying every 500 ms) connectivity checks went unanswered on WiFi, so:
     *   - ice-tcp=FALSE: no TCP host/srflx candidates; a TCP pair never succeeded.
     *   - force-relay: only relay candidates, a single relay path - but only when there is a TURN
     *     server to relay through, or there would be no candidates at all. */
    g_object_set(sm->agent, "ice-tcp", FALSE, NULL);
    g_object_set(sm->agent, "force-relay", g_n_turn > 0, NULL);
    g_message("signal_media: %d TURN relay(s), %s", g_n_turn,
              g_n_turn > 0 ? "relay candidates only" : "host and server-reflexive candidates");


    /* STUN (agent-global): gathers server-reflexive (srflx) candidates so we learn our public
     * ip:port behind NAT. Signal feeds this via a RELAY line before START. Set before gathering. */
    if (g_stun_port) {
        g_object_set(sm->agent, "stun-server", g_stun_host,
                     "stun-server-port", (guint)g_stun_port, NULL);
    }

    sm->component = 1;
    sm->stream_id = nice_agent_add_stream(sm->agent, 1 /* rtcp-mux -> single component */);
    if (!sm->stream_id) { g_printerr("signal_media: add_stream failed\n"); return FALSE; }

    /* TURN relays (per component): relay candidates are how the two peers reach each other.
     * Must be set after add_stream, before gathering. */
    for (int i = 0; i < g_n_turn; i++) {
        SmTurn *t = &g_turn[i];
        if (!nice_agent_set_relay_info(sm->agent, sm->stream_id, sm->component,
                                       t->host, (guint)t->port,
                                       t->user, t->pass, t->type))
            g_printerr("signal_media: set_relay_info failed for %s:%d\n", t->host, t->port);
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
 * out of build_ice() and called after the pipeline is PLAYING, i.e. after the audio devices are open
 * - see signal_media_start(). With the sockets opened first, a few of them failed with ENOTTY a few
 * hundred ms into gathering and libnice detached them (an fd number reused while a GSource still
 * watched it, during the device-open fd churn), so replies on them were never read. */
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

    /* -------- RX: nicesrc -> srtpdec -> rtpopusdepay -> opusdec -> pulsesink device=voipcall ---- */
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
    GstElement *asink  = mk("pulsesink",     "rx-pulsesink");
    GstElement *rxrtcp = mk("fakesink",      "rx-rtcp-drain");  /* drain srtpdec rtcp_src (rtcp-mux) */

    /* -------- TX: pulsesrc device=webcall -> opusenc -> rtpopuspay -> srtpenc -> nicesink -------- */
    GstElement *asrc   = mk("pulsesrc",      "tx-pulsesrc");
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
    /* rtp-data (Accepted) TX: appsrc (pre-SRTP-encrypted x-srtp bytes) -> funnel -> the single audio
     * nicesink. There must be exactly one nicesink: two concurrent nice_agent_send callers on one
     * agent deadlocked it (audio, data and STUN all froze at once). The funnel merges the occasional
     * data buffer into the audio SRTP stream so a single nicesink sends everything. */
    GstElement *dsrc   = mk("appsrc",        "tx-datasrc");
    GstElement *funnel = mk("funnel",        "tx-funnel");
    /* CRITICAL: a queue between funnel and nicesink. A funnel merges pads but does NOT serialize
     * threads - each upstream branch (audio srtpenc thread, data appsrc task thread) pushes through to
     * the sink ON ITS OWN THREAD, so nicesink.render (-> nice_agent_send) runs from TWO threads and
     * deadlocks libnice's agent (proven: audio+data+STUN all froze ~1s in). The queue's src pad has a
     * single task thread that drives everything downstream of it, so the nicesink - and thus the one
     * nice_agent_send caller - always runs on that ONE thread. Single sender = no deadlock. */
    GstElement *txq    = mk("queue",         "tx-queue");
    /* Leaky downstream + shallow: a full blocking queue back-pressures the mic source ("Can't record
     * audio fast enough / Dropped N samples / DISCONT"), which wrecks the call in ~3s. Drop old egress
     * buffers instead of ever stalling capture; a live call would rather lose a few ms than wedge. */
    if (txq) g_object_set(txq, "leaky", 2 /*downstream*/, "max-size-time", (guint64)100000000 /*100ms*/,
                          "max-size-buffers", 0, "max-size-bytes", 0, NULL);

    if (!nsrc || !rxcaps || !sdec || !rxrtp || !rxjb || !depay || !odec || !aconv || !asink || !rxrtcp ||
        !asrc || !txconv || !txre || !txcaps || !oenc || !pay || !senc || !nsink || !dsrc || !funnel || !txq) {
        if (sm->pipeline) { gst_object_unref(sm->pipeline); sm->pipeline = NULL; }
        return FALSE;
    }
    /* Echo cancellation is on unless SIGNAL_MEDIA_AEC=0. It needs audiobuffersplit (for the fixed 10 ms
     * frames Speex wants); without that element the call runs without it rather than failing. At
     * 48 kHz it is CPU-heavy: on the HP TouchPad (under legacy webOS) it starved the mic and the ICE
     * thread, which is what the variable is for. */
    gboolean g_have_aec = (rxcaps2 != NULL && txsplit != NULL) &&
                          g_strcmp0(g_getenv("SIGNAL_MEDIA_AEC"), "0") != 0;
    if (g_have_aec) {
        sm_echo_init();
        g_have_aec = g_echo_ready;   /* speex init could still fail */
    }
    if (!g_have_aec)
        g_message("signal_media: echo cancellation off");

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
    g_object_set(asink, "device", "voipcall", "sync", FALSE, NULL);
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
    /* Mic: bigger ring + provide-clock off so a momentary scheduling hiccup doesn't overrun it
     * ("Can't record audio fast enough"). buffer-time 200ms, latency-time 40ms. */
    g_object_set(asrc, "device", "webcall",
                 "buffer-time", (gint64)200000, "latency-time", (gint64)40000,
                 "provide-clock", FALSE, NULL);
    /* opusenc: complexity 5 + 32 kbps + inband FEC (resilient to the packet loss that garbled audio).
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
                     txconv, txre, txcaps, oenc, pay, senc, nsink, dsrc, funnel, txq, NULL);
    if (g_have_aec)
        gst_bin_add_many(GST_BIN(sm->pipeline), rxcaps2, txsplit, NULL);
    /* The microphone: in the pipeline from the start for an outgoing (or already answered) call;
     * for an incoming one held back until the user answers, so PulseAudio records nothing while it
     * rings. */
    gboolean mic_now = sm->is_caller || g_accepted;
    if (mic_now) gst_bin_add(GST_BIN(sm->pipeline), asrc);
    else         sm->mic = gst_object_ref_sink(asrc);

    /* srtpdec has STATIC/ALWAYS pads: rtp_src (decrypted RTP) and rtcp_src (decrypted RTCP). Link the
     * main RTP chain statically (rtp_src -> rxrtp -> depay -> ...). CRITICAL: with rtcp-mux the peer
     * sends RTP AND RTCP on the single socket, so nicesrc feeds both into srtpdec.rtp_sink; srtpdec
     * routes the RTCP packets to rtcp_src (gst_srtp_dec_chain: is_rtcp -> rtcp_srcpad). If rtcp_src is
     * unlinked that push returns GST_FLOW_NOT_LINKED, which stops the whole RX stream ("not-linked")
     * the instant real media arrives -> call dropped. Loopback never hit this (it sends no RTCP).
     * Drain rtcp_src into a fakesink so RTCP is discarded and RTP keeps flowing. */
    /* RX: ...odec -> aconv -> [rxcaps2(S16LE, probe stashes reference) ->] pulsesink. Audio plays as
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
    /* audio: pulsesrc -> aconv -> ares -> txcaps -> [txsplit(10ms, probe=speex_echo_capture in-place) ->]
     * opusenc -> pay -> srtpenc -> funnel; data: appsrc -> funnel; funnel -> queue -> the single
     * nicesink. The txsplit's probe subtracts the speaker echo from each mic frame before encoding. */
    if (g_have_aec) {
        if (!gst_element_link_many(txconv, txre, txcaps, txsplit, oenc, pay, senc, funnel, txq, nsink, NULL)) {
            g_printerr("signal_media: TX (audio, with AEC) link failed\n"); return FALSE;
        }
    } else if (!gst_element_link_many(txconv, txre, txcaps, oenc, pay, senc, funnel, txq, nsink, NULL)) {
        g_printerr("signal_media: TX (audio) link failed\n"); return FALSE;
    }
    if (mic_now && !gst_element_link(asrc, txconv)) {
        g_printerr("signal_media: TX (microphone) link failed\n"); return FALSE;
    }
    if (!gst_element_link(dsrc, funnel)) {
        g_printerr("signal_media: TX (data) link failed\n"); return FALSE;
    }

    /* TX gate: drop every buffer (audio AND the rtp-data Accepted, both flow through txq before
     * nicesink) until ICE is CONNECTED - see sm_tx_gate_probe's comment. */
    g_ice_tx_ready = FALSE;
    /* Mic gate, on the encoded audio before it joins the rtp-data in the funnel. */
    { GstPad *p = gst_element_get_static_pad(oenc, "src");
      gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, sm_tx_audio_gate_probe, NULL, NULL);
      gst_object_unref(p); }
    /* Buffer lists too: video packets (rtpvp8pay, srtpenc) travel as lists. */
    { GstPad *p = gst_element_get_static_pad(txq, "src");
      gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST,
                        sm_tx_gate_probe, NULL, NULL);
      gst_object_unref(p); }

    /* Received packets split by payload type (audio stays, VP8 to the video branch, the far
     * side's rtp-data read), and its RTCP read for keyframe requests before it is drained. */
    { GstPad *p = gst_element_get_static_pad(sdec, "rtp_src");
      gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST,
                        sm_rx_split_probe, NULL, NULL);
      gst_object_unref(p); }
    { GstPad *p = gst_element_get_static_pad(sdec, "rtcp_src");
      gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST,
                        sm_rx_rtcp_probe, NULL, NULL);
      gst_object_unref(p); }
    /* Video: both halves optional, the call works as voice without them. */
    sm_video_rx_build(sm->pipeline);
    sm_video_tx_build(sm->pipeline, funnel);

    GstBus *bus = gst_pipeline_get_bus(GST_PIPELINE(sm->pipeline));
    GSource *src = gst_bus_create_watch(bus);
    g_source_set_callback(src, G_SOURCE_FUNC(on_bus), sm, NULL);
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


int signal_media_init(int *argc, char ***argv)
{
    if (g_once_init_enter(&g_inited)) {
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
    sm_video_reset();
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
    g_atomic_int_set(&g_sender_run, 1);
    g_sender_thread = g_thread_new("sig-sender", sender_thread_fn, NULL);
    /* A camera asked for before START (an outgoing video call) starts now. */
    if (g_v.tx_wanted) sm_on_media_thread(sm_video_tx_start, NULL);
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
    if (!c) { g_printerr("signal_media: could not parse a remote candidate\n"); return -1; }
    GSList *list = g_slist_append(NULL, c);
    int added = nice_agent_set_remote_candidates(g_sm.agent, g_sm.stream_id, g_sm.component, list);
    g_slist_free(list);
    nice_candidate_free(c);
    g_debug("signal_media: remote candidate (added=%d) %s", added, sdp_candidate);
    return added > 0 ? 0 : -1;
}

void signal_media_stop(void)
{
    if (!g_sm.running) return;
    g_sm.running = FALSE;

    /* stop + join the sender thread BEFORE freeing the agent/srtp it uses (no use-after-free) */
    g_accepted = FALSE;
    g_atomic_int_set(&g_sender_run, 0);
    if (g_sender_thread) { g_thread_join(g_sender_thread); g_sender_thread = NULL; }
    g_datasrc = NULL;   /* owned by the pipeline (freed below); thread is joined so no more pushes */
    if (g_data_srtp) { srtp_dealloc(g_data_srtp); g_data_srtp = NULL; }

    if (g_sm.pipeline) gst_element_set_state(g_sm.pipeline, GST_STATE_NULL);
    /* The streaming threads are stopped: nothing reaches the video elements any more. They are
     * the pipeline's and go with it below. */
    g_v.rx_src = NULL;
    g_v.rx_shm = NULL;
    g_v.rx_jb = NULL;
    g_v.tx_enc = NULL;
    g_tx_vqueue = NULL;
    g_tx_head = NULL;
    if (g_tx_cam) { gst_object_unref(g_tx_cam); g_tx_cam = NULL; }
    if (g_sm.audiod_on && g_sm.audiod_cb) g_sm.audiod_cb(0, g_sm.audiod_user);
    g_sm.audiod_on = FALSE;

    if (g_sm.loop) g_main_loop_quit(g_sm.loop);
    if (g_sm.thread) { g_thread_join(g_sm.thread); g_sm.thread = NULL; }
    sm_echo_free();     /* now that the streaming threads (probe callers) are stopped, free the AEC */

    if (g_sm.pipeline) { gst_object_unref(g_sm.pipeline); g_sm.pipeline = NULL; }
    if (g_sm.mic)      { gst_object_unref(g_sm.mic);      g_sm.mic = NULL; }   /* never answered */
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
    gst_caps_set_simple(caps, "srtp-key", GST_TYPE_BUFFER, lc->master, NULL);
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

/* IPC driver: the separate-process contract purple-presage speaks. It spawns `signal_media --answer`
 * (incoming call) or `--caller` (outgoing), then talks a line protocol over the pipes:
 *
 *   presage -> us (stdin):
 *     PREPARE <priv_hex64>                (caller only: report PUB for the Offer, no media yet)
 *     RELAY stun <host> <port>            (STUN/TURN servers, before START)
 *     RELAY turn <ip> <port> <user> <pass> <udp|tcp|tls>
 *     START <priv_hex64> <pub_hex64> <callerid_hex> <calleeid_hex> <ourufrag> <ourpwd> <remufrag> <rempwd>
 *     RCAND <candidate:... sdp line>      (peer IceUpdate, may repeat / trickle)
 *     ACCEPT <call_id>                    (the user answered: send RingRTC's Accepted, open the mic)
 *     CALLID <call_id>                    (our outgoing call's id, for the video SenderStatus)
 *     VIDEO <0|1>                         (the user turned our camera off / on; may precede START)
 *     STOP                                (or EOF on stdin)
 *   us -> presage (stdout, line-buffered):
 *     PUB <pub_hex64>                     (our X25519 public key)
 *     CAND <candidate:... sdp line>       (our local candidate to send as an IceUpdate)
 *     AUDIOD <0|1>                        (media pipeline up / down)
 *     READY                               (engine started ok)
 *     VSHM / VPREVIEW / VTX / PEERVIDEO / PEERROT / VIDEOERR ...   (video, see signal_media.h)
 *     ERR <msg>                           (fatal; we exit non-zero)
 *
 * Keys/ids are lowercase hex. ufrag/pwd are single whitespace-free tokens (ICE creds never contain
 * spaces). Our callbacks fire from the engine's GMainContext thread, so stdout writes take a lock. */
static GMutex g_out_lock;

static void emit(const char *fmt, ...) G_GNUC_PRINTF(1, 2);
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
static void ipc_event_cb(const char *line, void *user)    { (void)user; emit("%s\n", line); }

/* "<n>" with nothing after it, as an unsigned 64-bit number. */
static gboolean ipc_u64(const char *s, guint64 *out)
{
    gchar *end = NULL;
    if (!s || !g_ascii_isdigit(*s)) return FALSE;
    errno = 0;
    guint64 v = g_ascii_strtoull(s, &end, 10);
    if (errno || !end || *end != '\0') return FALSE;
    *out = v;
    return TRUE;
}

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
    signal_media_set_event_cb(ipc_event_cb, NULL);

    while (fgets(line, sizeof line, stdin)) {
        char *nl = strchr(line, '\n'); if (nl) *nl = '\0';
        if (line[0] == '\0') continue;

        if (strncmp(line, "PREPARE ", 8) == 0) {
            /* Caller phase 1: just report our public key so the bridge can send the Offer. No media
             * yet - the answerer's key + ICE creds arrive later in START. */
            emit_pubkey_from_priv_hex(line + 8);
        } else if (strncmp(line, "RELAY ", 6) == 0) {
            /* STUN/TURN config, sent before START:  RELAY stun <host> <port>
             *                                       RELAY turn <ip> <port> <user> <pass> <transport> */
            char *sp = NULL;
            char *kind = strtok_r(line + 6, " ", &sp);
            char *host = strtok_r(NULL, " ", &sp);
            char *ports = strtok_r(NULL, " ", &sp);
            char *pend = NULL;
            long port = ports ? strtol(ports, &pend, 10) : -1;
            if (kind && host && ports && *pend == '\0' && port > 0 && port <= 65535) {
                if (strcmp(kind, "stun") == 0) {
                    snprintf(g_stun_host, sizeof g_stun_host, "%s", host);
                    g_stun_port = (int)port;
                } else if (strcmp(kind, "turn") == 0 && g_n_turn < SM_MAX_TURN) {
                    char *user = strtok_r(NULL, " ", &sp);
                    char *pass = strtok_r(NULL, " ", &sp);
                    char *tr   = strtok_r(NULL, " ", &sp);
                    SmTurn *t = &g_turn[g_n_turn++];
                    snprintf(t->host, sizeof t->host, "%s", host);
                    t->port = (int)port;
                    snprintf(t->user, sizeof t->user, "%s", user ? user : "");
                    snprintf(t->pass, sizeof t->pass, "%s", pass ? pass : "");
                    t->type = (tr && strcmp(tr, "tcp") == 0) ? NICE_RELAY_TYPE_TURN_TCP
                            : (tr && strcmp(tr, "tls") == 0) ? NICE_RELAY_TYPE_TURN_TLS
                            :                                  NICE_RELAY_TYPE_TURN_UDP;
                }
            }
        } else if (strncmp(line, "START ", 6) == 0) {
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
        } else if (strncmp(line, "CALLID ", 7) == 0) {
            guint64 id;
            if (!ipc_u64(line + 7, &id)) { emit("ERR bad-callid\n"); continue; }
            signal_media_set_call_id(id);
        } else if (strncmp(line, "VIDEO ", 6) == 0) {
            if (strcmp(line + 6, "0") != 0 && strcmp(line + 6, "1") != 0) { emit("ERR bad-video\n"); continue; }
            signal_media_set_video(line[6] == '1');
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
    signal_media_init(&argc, &argv);
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
    g_print("Signal call media engine.\n");
    g_print("  %s --loopback   run the SRTP-GCM+RTP+Opus loopback self-test\n", argv[0]);
    g_print("  %s --answer     drive a live INCOMING call over the stdin/stdout IPC (presage bridge)\n", argv[0]);
    g_print("  %s --caller     drive a live OUTGOING call over the stdin/stdout IPC (presage bridge)\n", argv[0]);
    return 0;
}
#endif
