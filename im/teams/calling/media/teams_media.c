/*
 * teams_media.c - Microsoft Teams (personal/TFL) 1:1 call MEDIA ENGINE for LuneOS.
 *
 * Forked from the on-device-proven Signal engine (signal_media.c). Teams consumer calling turns out
 * to offer EXACTLY what that engine already does: AEAD_AES_256_GCM SRTP + Opus (PT 102) + ICE
 * (libnice). The ONLY real difference is keying: Teams uses SDES (the SRTP master key is carried
 * inline in the SDP `a=crypto` line), NOT an X25519 DH. So instead of deriving keys, we:
 *   - take the peer's RX master (base64 from the offer's `a=crypto:4 AEAD_AES_256_GCM inline:...`),
 *   - generate our own random TX master and hand it back (base64) for the SDP answer's a=crypto.
 * We also generate our own ICE ufrag/pwd (libnice) and emit them + our candidates for the answer.
 *
 *   RX: nicesrc -> srtpdec(peer master via request-key) -> rtpptdemux --pt 102--> rtpjitterbuffer
 *       -> rtpopusdepay -> opusdec -> pulsesink device=voipcall
 *                                                       `--other PTs--> fakesink
 *   TX: pulsesrc device=webcall -> opusenc -> rtpopuspay -> srtpenc(our master) -> queue -> nicesink
 *
 * The peer BUNDLEs video onto the same ICE/SRTP transport when it has a camera on: rtpptdemux
 * splits its H264 off to the video branch (see the video section), RTX and the rest are dropped.
 *
 * Audio uses the PulseAudio call devices by name: voipcall (playback) and webcall (capture). A stream
 * that names its sink is routed by palm-policy to the output device for the call (earpiece, speaker,
 * headset or Bluetooth, as audiod sets it), which the plugin has told audiod about with
 * phone/CallStatusUpdate.
 *
 * IPC (line protocol over stdin/stdout, driven by teams_calling.c):
 *   in : START <rx_master_b64> <remote_ufrag> <remote_pwd> <pt>   (--answer)
 *        START [pt]                                              (--caller)
 *        ANSWER <rx_master_b64> <remote_ufrag> <remote_pwd>       (--caller, the peer's answer)
 *        RELAY turn <ip> <port> <user> <pass> <udp|tcp|tls>   (optional; MS-TURN relay)
 *        RELAY stun <host|ip> <port>                          (optional; a name is resolved here,
 *                                                               libnice takes only an address)
 *        RCAND <candidate:... sdp line>                       (a remote ICE candidate; repeatable)
 *        RESTART <rx_master_b64|-> <remote_ufrag> <remote_pwd> (mid-call renegotiation: peer swapped
 *                                                               to a new media leg - new remote ICE
 *                                                               creds [+ optionally a new RX key],
 *                                                               applied WITHOUT rebuilding the
 *                                                               already-PLAYING pipeline; follow with
 *                                                               RCAND for the new leg's candidates)
 *        VIDEO <0|1> [<w> <h> <kbps>]                        (the user turned our camera off/on;
 *                                                               optional: the size and bitrate to
 *                                                               send, from the far side's fmtp)
 *        STOP
 *   out: UFRAG <our_ufrag>
 *        PWD <our_pwd>
 *        TXKEY <tx_master_b64>                                (our a=crypto inline key for the answer)
 *        SSRC <n>                                             (our audio RTP SSRC, for the answer's
 *                                                               a=x-ssrc-range)
 *        VSSRC <n>                                            (our video SSRC, only when this device
 *                                                               can do video; for the video m-line)
 *        VSHM, VPREVIEW, VTX, PEERVIDEO, VIDEOERR             (video events, see the video section)
 *        CAND <candidate:... sdp line>                        (our local ICE candidate)
 *        AUDIOD <0|1>
 *        GATHERED                                             (local candidates complete)
 *        READY | ANSWERED | RESTARTED | ERR <msg>
 *
 * Diagnostics go to stderr (g_message/g_printerr), which the plugin's process passes through. The
 * SRTP keys and TURN credentials are never logged.
 *
 * --loopback runs a self-test: an SRTP-GCM + RTP + Opus round trip, without ICE or audio devices,
 * with the receive key supplied through srtpdec's request-key as on a call.
 */

#include <gst/gst.h>
#include <nice/agent.h>
#include <glib.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <errno.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>

#include "teams_video.h"

/* Opus RTP: 48 kHz. PT is dictated by the peer's offer (Teams uses 102); parsed from START. */
#define TM_OPUS_CLOCKRATE 48000
#define TM_OPUS_CHANNELS  1
#define TM_DEFAULT_PT     102

/* The PulseAudio call devices (pulseaudio-distro-conf's webos-virtual-devices.pa). */
#define TM_PLAYBACK_DEVICE "voipcall"
#define TM_CAPTURE_DEVICE  "webcall"

#define SRTP_CIPHER_GCM256 "aes-256-gcm"
#define SRTP_AUTH_NULL     "null"          /* GCM is AEAD -> no separate auth transform */
#define TM_GCM_MASTER_SIZE 44              /* AEAD_AES_256_GCM: 32-byte key || 12-byte salt */

typedef struct {
    GMainContext *ctx;
    GMainLoop    *loop;
    GThread      *thread;

    /* libnice runs on its own context and thread (tm_nice_thread), never on ctx: nicesink waits
     * for the agent's "writable" notice when a TCP path is full, and that notice is dispatched on
     * the agent's context. On ctx, any media-thread callback that pushes into the send path (the
     * camera's start-capture) waited on nicesink while nicesink waited on ctx: the media loop,
     * ICE checks and all sending stopped for the rest of the call. */
    GMainContext *nice_ctx;
    GMainLoop    *nice_loop;
    GThread      *nice_thread;

    NiceAgent    *agent;
    guint         stream_id;
    guint         component;   /* 1 = RTP (rtcp-mux) */

    GstElement   *pipeline;

    GMutex        key_lock;     /* rx_master: swapped by RESTART, read by srtpdec's request-key */
    GstBuffer    *rx_master;    /* peer's SRTP master (decrypt RX), 44B */
    GstBuffer    *tx_master;    /* our SRTP master (encrypt TX), 44B */
    int           pt;           /* opus payload type from the offer */
    guint32       tx_ssrc;      /* our audio RTP SSRC: chosen here, so the answer can declare it */

    void (*cand_cb)(const char *sdp);
    void (*gathered_cb)(void);
    void (*audiod_cb)(int active);

    gboolean      audiod_on;
    gboolean      running;

    GstElement   *rx_audio_caps;    /* rx-rtpcaps: ptdemux routing target for the audio PT */

    /* Call statistics, logged every TM_STATS_SECONDS (tm_stats_tick), so a log of a call with
     * one-way audio shows which side loses it. Written by the streaming threads' pad probes. */
    struct {
        gint tx_pkts, tx_bytes, tx_ssrc, rx_pkts, mic_peak;
        gint rtcp_pkts, rr_reports, rr_ssrc, rr_frac, rr_cum_lost, rr_hseq;
        gint v_rx_pkts, v_decoded, v_pli_sent, v_tx_pkts, v_key_asked;
    } stats;
    GSource      *stats_src;

    /* Video (see the video section). Off unless every element it needs is installed and
     * TEAMS_MEDIA_VIDEO is not "0"; then START also reports VSSRC, our video SSRC, which the
     * plugin declares in the answer's video m-line. */
    gboolean      video;
    guint32       vtx_ssrc;
    GstElement   *vrx_caps;       /* ptdemux target for the H264 payload type */
    GstElement   *vtx_queue;      /* input of the persistent send tail; a camera head links here */
    GstElement   *vtx_head;       /* the camera bin while the camera is on */
    GstElement   *vtx_cam;        /* the droidcamsrc in it, if any (start-capture, orientation) */
    gboolean      vtx_wanted;     /* VIDEO 1: the user has the camera on */
    guint         vtx_w, vtx_h, vtx_kbps; /* VIDEO 1 <w> <h> <kbps>: what to send; 0 = defaults */
    gint          vtx_capture;    /* atomic: start-capture sent to the droid camera */
    gint          vtx_announced;  /* atomic: VPREVIEW sent for this camera head */
    GstElement   *rtcp_out;       /* appsrc: our RTCP, to srtpenc */
    gint          vrx_announced;  /* atomic: VSHM sent */
    gint          peer_vssrc;     /* atomic: the far side's video SSRC, 0 none yet */
    gint          pli_wanted;     /* atomic: our decoder wants a keyframe */
    gint          key_wanted;     /* atomic: the far side asked us for a keyframe */
    gint          peer_video;     /* media thread only: last PEERVIDEO said, -1 none */
    gint64        last_pli, last_report, last_key;  /* media thread only */
    GMutex        vlock;          /* everything below */
    TvRxStats     vstats;
    gint64        v_first, v_last, v_dec;           /* first/last video packet, last decoded frame */
    guint32       sr_ntp_mid;     /* the far side's last sender report about its video */
    gint64        sr_at;
    GSource      *vtimer;
    void        (*event_cb)(const char *line);
} TeamsMedia;

#define TM_STATS_SECONDS 5

static TeamsMedia g_tm;
static gsize      g_inited = 0;

/* STUN/TURN relays (set via RELAY before START) */
#define TM_MAX_TURN 8
typedef struct { char host[64]; int port; char user[128]; char pass[256]; NiceRelayType type; } TmTurn;
static char   g_stun_host[64];
static int    g_stun_port;
static TmTurn g_turn[TM_MAX_TURN];
static int    g_n_turn;

/* ------------------------------------------------------------------ helpers ------------------- */

static GstBuffer *master_buffer_from_bytes(const guchar *data, gsize len)
{
    GstBuffer *buf = gst_buffer_new_and_alloc(TM_GCM_MASTER_SIZE);
    GstMapInfo map;
    if (!gst_buffer_map(buf, &map, GST_MAP_WRITE)) { gst_buffer_unref(buf); return NULL; }
    memset(map.data, 0, TM_GCM_MASTER_SIZE);
    memcpy(map.data, data, len < TM_GCM_MASTER_SIZE ? len : TM_GCM_MASTER_SIZE);
    gst_buffer_unmap(buf, &map);
    return buf;
}

/* Decode a base64 SRTP master (key||salt). NULL if it is too short to be one. */
static GstBuffer *master_buffer_from_b64(const char *b64)
{
    gsize len = 0;
    guchar *k;
    GstBuffer *buf = NULL;
    if (!b64) return NULL;
    k = g_base64_decode(b64, &len);
    if (k && len >= 32) buf = master_buffer_from_bytes(k, len);
    if (k) { memset(k, 0, len); g_free(k); }
    return buf;
}

/* Fill buf with len bytes from the kernel CSPRNG. */
static gboolean random_bytes(guchar *buf, gsize len)
{
    gsize got = 0;
    while (got < len) {
        ssize_t r = getrandom(buf + got, len - got, 0);
        if (r < 0) {
            if (errno == EINTR) continue;
            return FALSE;
        }
        got += (gsize) r;
    }
    return TRUE;
}

static GstElement *mk(const char *factory, const char *name)
{
    GstElement *e = gst_element_factory_make(factory, name);
    if (!e) g_printerr("teams_media: missing GStreamer element '%s'\n", factory);
    return e;
}

static void configure_srtpenc(GstElement *enc, GstBuffer *master)
{
    g_object_set(enc, "key", master, NULL);
    gst_util_set_object_arg(G_OBJECT(enc), "rtp-cipher",  SRTP_CIPHER_GCM256);
    gst_util_set_object_arg(G_OBJECT(enc), "rtp-auth",    SRTP_AUTH_NULL);
    gst_util_set_object_arg(G_OBJECT(enc), "rtcp-cipher", SRTP_CIPHER_GCM256);
    gst_util_set_object_arg(G_OBJECT(enc), "rtcp-auth",   SRTP_AUTH_NULL);
}

static GstCaps *on_srtpdec_request_key(GstElement *dec, guint ssrc, gpointer user)
{
    (void)dec;
    TeamsMedia *tm = (TeamsMedia *)user;
    GstBuffer *key;
    g_message("teams_media: srtpdec request-key ssrc %u (inbound SRTP arriving)", ssrc);
    g_mutex_lock(&tm->key_lock);
    key = tm->rx_master ? gst_buffer_ref(tm->rx_master) : NULL;
    g_mutex_unlock(&tm->key_lock);
    if (!key) return NULL;
    GstCaps *caps = gst_caps_new_simple("application/x-srtp",
                                        "srtp-cipher",  G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtp-auth",    G_TYPE_STRING, SRTP_AUTH_NULL,
                                        "srtcp-cipher", G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtcp-auth",   G_TYPE_STRING, SRTP_AUTH_NULL, NULL);
    gst_caps_set_simple(caps, "srtp-key", GST_TYPE_BUFFER, key, NULL);
    gst_buffer_unref(key);
    return caps;
}

/* Replace the RX master (RESTART with a new key). srtpdec picks it up on its next request-key. */
static void set_rx_master(TeamsMedia *tm, GstBuffer *master)
{
    GstBuffer *old;
    g_mutex_lock(&tm->key_lock);
    old = tm->rx_master;
    tm->rx_master = master;
    g_mutex_unlock(&tm->key_lock);
    if (old) gst_buffer_unref(old);
}

/* ------------------------------------------------------------------ call statistics ----------- */

/* A second RTP header byte of 192..223 is an RTCP packet type (rtcp-mux, RFC 5761). */
static gboolean tm_is_rtcp(const guint8 *p, gsize len)
{
    return len >= 2 && p[1] >= 192 && p[1] <= 223;
}

/* The report block about ssrc (0: the first one) in a decrypted compound RTCP packet. TRUE, with
 * the block's ssrc, fraction lost (of 256), cumulative loss and extended highest sequence number,
 * if one of its SR or RR packets carries it. */
static gboolean tm_rtcp_find_report(const guint8 *p, gsize len, guint32 ssrc, guint32 *got_ssrc,
                                    guint *frac, gint *cum_lost, guint32 *hseq)
{
    while (len >= 4) {
        guint rc = p[0] & 0x1fu, pt = p[1];
        gsize plen = ((gsize)(((guint)p[2] << 8) | p[3]) + 1) * 4;
        if ((p[0] >> 6) != 2 || plen > len) return FALSE;
        if (pt == 200 || pt == 201) {
            gsize off = pt == 200 ? 28 : 8;   /* SR: ssrc + 20 bytes of sender info; RR: ssrc */
            for (guint i = 0; i < rc && off + 24 <= plen; i++, off += 24) {
                const guint8 *b = p + off;
                guint32 s = GST_READ_UINT32_BE(b);
                if (!ssrc || s == ssrc) {
                    guint32 cl = ((guint32)b[5] << 16) | ((guint32)b[6] << 8) | b[7];
                    *got_ssrc = s;
                    *frac = b[4];
                    *cum_lost = (cl & 0x800000u) ? (gint)cl - 0x1000000 : (gint)cl;
                    *hseq = GST_READ_UINT32_BE(b + 8);
                    return TRUE;
                }
            }
        }
        p += plen; len -= plen;
    }
    return FALSE;
}

/* What leaves for the network: packet count and size, and our RTP SSRC. */
static void tm_count_tx(TeamsMedia *tm, GstBuffer *b)
{
    GstMapInfo m;
    g_atomic_int_inc(&tm->stats.tx_pkts);
    if (!gst_buffer_map(b, &m, GST_MAP_READ)) return;
    g_atomic_int_add(&tm->stats.tx_bytes, (gint)m.size);
    /* The audio stream's SSRC only: video and RTCP go out on the same socket. */
    if (m.size >= 12 && (m.data[0] >> 6) == 2 && !tm_is_rtcp(m.data, m.size) && (m.data[1] & 0x7f) == tm->pt)
        g_atomic_int_set(&tm->stats.tx_ssrc, (gint)GST_READ_UINT32_BE(m.data + 8));
    gst_buffer_unmap(b, &m);
}

static GstPadProbeReturn tm_probe_tx(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    (void)pad;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER) {
        tm_count_tx(tm, GST_PAD_PROBE_INFO_BUFFER(info));
    } else if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        GstBufferList *l = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
        for (guint i = 0; i < gst_buffer_list_length(l); i++) tm_count_tx(tm, gst_buffer_list_get(l, i));
    }
    return GST_PAD_PROBE_OK;
}

/* nicesrc pushes buffer lists: count their buffers. */
static GstPadProbeReturn tm_probe_rx(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    (void)pad;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST)
        g_atomic_int_add(&tm->stats.rx_pkts, (gint)gst_buffer_list_length(GST_PAD_PROBE_INFO_BUFFER_LIST(info)));
    else
        g_atomic_int_inc(&tm->stats.rx_pkts);
    return GST_PAD_PROBE_OK;
}

/* The loudest S16 sample the microphone gave since the last stats line: 0 means silence. */
static GstPadProbeReturn tm_probe_mic(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info);
    GstMapInfo m;
    gint peak = g_atomic_int_get(&tm->stats.mic_peak);
    (void)pad;
    if (!b || !gst_buffer_map(b, &m, GST_MAP_READ)) return GST_PAD_PROBE_OK;
    for (gsize i = 0; i + 1 < m.size; i += 2) {
        gint v = (gint16)GST_READ_UINT16_LE(m.data + i);
        if (v < 0) v = -v;
        if (v > peak) peak = v;
    }
    gst_buffer_unmap(b, &m);
    g_atomic_int_set(&tm->stats.mic_peak, peak);
    return GST_PAD_PROBE_OK;
}

/* The peer's RTCP reports: what it says it receives from us. */
static void tm_read_rtcp(TeamsMedia *tm, GstBuffer *b)
{
    GstMapInfo m;
    guint32 got = 0, hseq = 0; guint frac = 0; gint lost = 0;
    g_atomic_int_inc(&tm->stats.rtcp_pkts);
    if (!b || !gst_buffer_map(b, &m, GST_MAP_READ)) return;
    if (tm_rtcp_find_report(m.data, m.size, (guint32)g_atomic_int_get(&tm->stats.tx_ssrc),
                            &got, &frac, &lost, &hseq)) {
        g_atomic_int_inc(&tm->stats.rr_reports);
        g_atomic_int_set(&tm->stats.rr_ssrc, (gint)got);
        g_atomic_int_set(&tm->stats.rr_frac, (gint)frac);
        g_atomic_int_set(&tm->stats.rr_cum_lost, lost);
        g_atomic_int_set(&tm->stats.rr_hseq, (gint)hseq);
    }
    if (tm->video) {
        guint32 mid = 0, peer = (guint32)g_atomic_int_get(&tm->peer_vssrc);
        if (peer && tv_rtcp_find_sr(m.data, m.size, peer, &mid) == 1) {
            g_mutex_lock(&tm->vlock);
            tm->sr_ntp_mid = mid;
            tm->sr_at = g_get_monotonic_time();
            g_mutex_unlock(&tm->vlock);
        }
        if (tv_rtcp_wants_keyframe(m.data, m.size, tm->vtx_ssrc) == 1)
            g_atomic_int_set(&tm->key_wanted, 1);
    }
    gst_buffer_unmap(b, &m);
}

static GstPadProbeReturn tm_probe_rtcp(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    (void)pad;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        GstBufferList *l = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
        for (guint i = 0; i < gst_buffer_list_length(l); i++) tm_read_rtcp(tm, gst_buffer_list_get(l, i));
    } else {
        tm_read_rtcp(tm, GST_PAD_PROBE_INFO_BUFFER(info));
    }
    return GST_PAD_PROBE_OK;
}

static gboolean tm_stats_tick(gpointer user)
{
    TeamsMedia *tm = user;
    gint mic = g_atomic_int_get(&tm->stats.mic_peak);
    g_atomic_int_set(&tm->stats.mic_peak, 0);
    g_message("teams_media: stats tx=%d pkts/%d B ssrc=%u mic_peak=%d rx=%d pkts rtcp_in=%d "
              "peer_reports_about_us=%d (last: ssrc=%u lost=%d frac=%d/256 hseq=%u)",
              g_atomic_int_get(&tm->stats.tx_pkts), g_atomic_int_get(&tm->stats.tx_bytes),
              (guint)g_atomic_int_get(&tm->stats.tx_ssrc), mic, g_atomic_int_get(&tm->stats.rx_pkts),
              g_atomic_int_get(&tm->stats.rtcp_pkts), g_atomic_int_get(&tm->stats.rr_reports), (guint)g_atomic_int_get(&tm->stats.rr_ssrc),
              g_atomic_int_get(&tm->stats.rr_cum_lost), g_atomic_int_get(&tm->stats.rr_frac),
              (guint)g_atomic_int_get(&tm->stats.rr_hseq));
    if (tm->video)
        g_message("teams_media: video rx=%d pkts decoded=%d pli_sent=%d tx=%d pkts keyframes_asked=%d",
                  g_atomic_int_get(&tm->stats.v_rx_pkts), g_atomic_int_get(&tm->stats.v_decoded),
                  g_atomic_int_get(&tm->stats.v_pli_sent), g_atomic_int_get(&tm->stats.v_tx_pkts),
                  g_atomic_int_get(&tm->stats.v_key_asked));
    return G_SOURCE_CONTINUE;
}

/* A buffer probe on el's pad. */
static void tm_add_probe(GstElement *el, const char *pad_name, GstPadProbeType type,
                         GstPadProbeCallback cb, TeamsMedia *tm)
{
    GstPad *pad = gst_element_get_static_pad(el, pad_name);
    if (!pad) return;
    gst_pad_add_probe(pad, type, cb, tm, NULL);
    gst_object_unref(pad);
}

static GstCaps *opus_rtp_caps(int pt)
{
    return gst_caps_new_simple("application/x-rtp",
                               "media",         G_TYPE_STRING, "audio",
                               "clock-rate",    G_TYPE_INT,    TM_OPUS_CLOCKRATE,
                               "encoding-name", G_TYPE_STRING, "OPUS",
                               "payload",       G_TYPE_INT,    pt, NULL);
}

/* ------------------------------------------------------------------ video ---------------------
 * The Teams app sends H264 (PT 107, packetization-mode 1) on the audio's ICE component and SRTP
 * key (BUNDLE). Received video is split off by rtpptdemux, decoded and published as I420 frames
 * on a gst-shm socket for the Phone app (RemoteVideo.qml, the contract the Signal engine has).
 * While the user has the camera on (VIDEO 1), the front camera's hardware H264 (droidcamsrc in
 * video mode, as luneos-rtc-engine does for WhatsApp) is sent on PT 107 from our own SSRC, and
 * the viewfinder goes to a second shm socket for the self-view.
 *
 *   RX: ptdemux --107--> capsfilter -> rtpjitterbuffer -> rtph264depay -> h264parse -> avdec_h264
 *       -> videoconvert -> videoscale -> I420 640x480 -> leaky queue -> shmsink /tmp/teams-video
 *   TX: [camera head: droidcamsrc vidsrc -> h264parse] -> queue -> rtph264pay -> srtpenc
 *   RTCP: appsrc -> srtpenc (rtcp) : RR + REMB every second, PLI when our decoder needs a keyframe
 *
 * A WebRTC-style sender sends a keyframe only when asked and sizes its bitrate from what the
 * receiver reports: so keyframe requests repeat while packets arrive and nothing decodes, and the
 * receiver reports and REMB go out for the whole call. The offer has no transport-wide sequence
 * number extension, so REMB is the bandwidth feedback there is.
 *
 * Video lines (stdout, through event_cb):
 *   VSHM <path> <w> <h>           the far side's decoded picture is on this gst-shm socket
 *   VPREVIEW <path> <w> <h> <q> <m> our camera's picture (q quarter turns, m mirrored 0/1)
 *   VTX <0|1>                     our camera is sending / stopped
 *   PEERVIDEO <0|1>               the far side's video is arriving / stopped for 2 s
 *   VIDEOERR <what>               a video part could not be built; the call goes on without it */

#define TM_VIDEO_W          640
#define TM_VIDEO_H          480
#define TM_PREVIEW_W        320
#define TM_PREVIEW_H        240
#define TM_VIDEO_BITRATE    800000
#define TM_REMB_BPS         1500000u
#define TM_VIDEO_SHM        "/tmp/teams-video"      /* device-side sockets: the Phone app opens them */
#define TM_PREVIEW_SHM      "/tmp/teams-preview"
#define TM_SHM_SIZE         (8u << 20)
#define TM_VTICK_MS         100
#define TM_PLI_INTERVAL_US  500000                  /* at most two keyframe requests a second */
#define TM_REPORT_US        1000000                 /* RR + REMB once a second */
#define TM_PEER_GONE_US     2000000                 /* no video for 2 s: PEERVIDEO 0 */

static void tm_event(TeamsMedia *tm, const char *fmt, ...) G_GNUC_PRINTF(2, 3);
static void tm_event(TeamsMedia *tm, const char *fmt, ...)
{
    if (!tm->event_cb)
        return;
    va_list ap;
    va_start(ap, fmt);
    gchar *line = g_strdup_vprintf(fmt, ap);
    va_end(ap);
    tm->event_cb(line);
    g_free(line);
}

static const char *tm_env_or(const char *env, const char *dflt)
{
    const char *v = g_getenv(env);
    return v && *v ? v : dflt;
}

/* Whether this device can do video calls at all: every element the video branches create. */
static gboolean tm_video_available(void)
{
    static const char *const need[] = {
        "rtpjitterbuffer", "rtph264depay", "rtph264pay", "h264parse", "avdec_h264", "videoconvert",
        "videoscale", "shmsink", "appsrc", "funnel", NULL,
    };
    if (g_strcmp0(g_getenv("TEAMS_MEDIA_VIDEO"), "0") == 0)
        return FALSE;
    for (int i = 0; need[i]; i++) {
        GstElementFactory *f = gst_element_factory_find(need[i]);
        if (!f) {
            g_message("teams_media: no %s, calls stay voice only", need[i]);
            return FALSE;
        }
        gst_object_unref(f);
    }
    return TRUE;
}

static void tm_try_set(GstElement *e, const char *prop, const char *value)
{
    if (g_object_class_find_property(G_OBJECT_GET_CLASS(e), prop))
        gst_util_set_object_arg(G_OBJECT(e), prop, value);
}

static void tm_drop_elements(GstElement **els, int n)
{
    for (int i = 0; i < n; i++)
        if (els[i])
            gst_object_unref(gst_object_ref_sink(els[i]));
}

/* A shmsink the Phone app reads, which must never hold the pipeline up: frames are dropped in the
 * leaky queue in front of it, and it keeps no last sample (its deep copy on a drain query blocked
 * a stop for ever in luneos-rtc-engine). */
/* shmsink offers its shm area as the allocator upstream. When nothing between it and the decoder
 * copies (no scaling needed), the decoder keeps its frames in that area, the area fills and the
 * whole chain blocks ahead of the leaky queue: the jitter buffer stops pushing (Signal engine,
 * fd22e21). Answer no allocation query, so upstream allocates its own memory and shmsink copies. */
static GstPadProbeReturn tm_no_shm_allocation(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    (void)pad; (void)user;
    GstQuery *q = GST_PAD_PROBE_INFO_QUERY(info);
    return q && GST_QUERY_TYPE(q) == GST_QUERY_ALLOCATION ? GST_PAD_PROBE_DROP : GST_PAD_PROBE_OK;
}

static void tm_configure_shm(GstElement *queue, GstElement *shm, const char *path)
{
    GstPad *sp = gst_element_get_static_pad(shm, "sink");
    if (sp) {
        gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_QUERY_DOWNSTREAM, tm_no_shm_allocation, NULL, NULL);
        gst_object_unref(sp);
    }
    if (queue)
        g_object_set(queue, "leaky", 2 /* downstream */, "max-size-buffers", 2, "max-size-time", (guint64)0,
                     "max-size-bytes", 0, NULL);
    g_object_set(shm, "socket-path", path, "shm-size", (guint)TM_SHM_SIZE, "wait-for-connection", FALSE,
                 "sync", FALSE, "async", FALSE, "enable-last-sample", FALSE, NULL);
}

static GstCaps *tm_i420_caps(int w, int h)
{
    return gst_caps_new_simple("video/x-raw", "format", G_TYPE_STRING, "I420", "width", G_TYPE_INT, w,
                               "height", G_TYPE_INT, h, "pixel-aspect-ratio", GST_TYPE_FRACTION, 1, 1, NULL);
}

/* One received video packet, before the jitter buffer: statistics and the far side's SSRC. */
static void tm_video_rx_packet(TeamsMedia *tm, GstBuffer *b)
{
    GstMapInfo m;
    TvRtp r;
    if (!gst_buffer_map(b, &m, GST_MAP_READ))
        return;
    if (tv_rtp_parse(m.data, m.size, &r) == 0) {
        gint64 now = g_get_monotonic_time();
        g_atomic_int_inc(&tm->stats.v_rx_pkts);
        g_atomic_int_set(&tm->peer_vssrc, (gint)r.ssrc);
        g_mutex_lock(&tm->vlock);
        tv_rx_stats_update(&tm->vstats, r.ssrc, r.seq);
        if (!tm->v_first)
            tm->v_first = now;
        tm->v_last = now;
        g_mutex_unlock(&tm->vlock);
    }
    gst_buffer_unmap(b, &m);
}

static GstPadProbeReturn tm_probe_vrx(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    (void)pad;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        GstBufferList *l = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
        for (guint i = 0; i < gst_buffer_list_length(l); i++) tm_video_rx_packet(tm, gst_buffer_list_get(l, i));
    } else {
        tm_video_rx_packet(tm, GST_PAD_PROBE_INFO_BUFFER(info));
    }
    return GST_PAD_PROBE_OK;
}

/* rtph264depay asks upstream for a keyframe (GstForceKeyUnit) when it lost data: send a PLI. */
static GstPadProbeReturn tm_probe_vkey(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    GstEvent *ev = GST_PAD_PROBE_INFO_EVENT(info);
    (void)pad;
    if (ev && GST_EVENT_TYPE(ev) == GST_EVENT_CUSTOM_UPSTREAM && gst_event_has_name(ev, "GstForceKeyUnit"))
        g_atomic_int_set(&tm->pli_wanted, 1);
    return GST_PAD_PROBE_OK;
}

static GstPadProbeReturn tm_probe_vdec(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    (void)pad; (void)info;
    g_atomic_int_inc(&tm->stats.v_decoded);
    g_mutex_lock(&tm->vlock);
    tm->v_dec = g_get_monotonic_time();
    g_mutex_unlock(&tm->vlock);
    return GST_PAD_PROBE_OK;
}

/* The first decoded frame on its way to the Phone app's socket: say where it is. */
static GstPadProbeReturn tm_probe_vshm(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    (void)info;
    if (g_atomic_int_compare_and_exchange(&tm->vrx_announced, 0, 1)) {
        GstElement *shm = gst_pad_get_parent_element(pad);
        gchar *path = NULL;
        if (shm) {
            g_object_get(shm, "socket-path", &path, NULL);
            gst_object_unref(shm);
        }
        tm_event(tm, "VSHM %s %d %d", path ? path : TM_VIDEO_SHM, TM_VIDEO_W, TM_VIDEO_H);
        g_free(path);
    }
    return GST_PAD_PROBE_REMOVE;
}

/* The receive branch, added to pipeline; tm->vrx_caps is where rtpptdemux links PT 107. Nothing
 * runs until the far side sends video. FALSE (and nothing added) without one of its elements. */
static gboolean tm_video_rx_build(TeamsMedia *tm, GstElement *pipeline)
{
    GstElement *e[10] = {
        mk("capsfilter", "rxv-rtpcaps"), mk("rtpjitterbuffer", "rxv-jitterbuf"), mk("rtph264depay", "rxv-depay"),
        mk("h264parse", "rxv-parse"), mk("avdec_h264", "rxv-dec"), mk("videoconvert", "rxv-conv"),
        mk("videoscale", "rxv-scale"), mk("capsfilter", "rxv-caps"), mk("queue", "rxv-queue"),
        mk("shmsink", "rxv-shm"),
    };
    for (int i = 0; i < 10; i++) {
        if (!e[i]) {
            tm_drop_elements(e, 10);
            return FALSE;
        }
    }
    GstCaps *rc = gst_caps_new_simple("application/x-rtp", "media", G_TYPE_STRING, "video",
                                      "clock-rate", G_TYPE_INT, TV_VIDEO_CLOCK,
                                      "encoding-name", G_TYPE_STRING, "H264",
                                      "payload", G_TYPE_INT, TV_PT_H264, NULL);
    g_object_set(e[0], "caps", rc, NULL);
    gst_caps_unref(rc);
    g_object_set(e[1], "latency", 200, "do-lost", TRUE, NULL);
    tm_try_set(e[2], "request-keyframe", "true");
    tm_try_set(e[2], "wait-for-keyframe", "true");
    tm_try_set(e[4], "output-corrupt", "false");
    tm_try_set(e[6], "add-borders", "true");
    GstCaps *vc = tm_i420_caps(TM_VIDEO_W, TM_VIDEO_H);
    g_object_set(e[7], "caps", vc, NULL);
    gst_caps_unref(vc);
    tm_configure_shm(e[8], e[9], tm_env_or("TEAMS_MEDIA_VIDEO_SHM", TM_VIDEO_SHM));

    for (int i = 0; i < 10; i++)
        gst_bin_add(GST_BIN(pipeline), e[i]);
    for (int i = 0; i + 1 < 10; i++) {
        if (!gst_element_link(e[i], e[i + 1])) {
            g_printerr("teams_media: video receive link %d failed\n", i);
            return FALSE;
        }
    }
    tm_add_probe(e[0], "sink", GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, tm_probe_vrx, tm);
    tm_add_probe(e[2], "sink", GST_PAD_PROBE_TYPE_EVENT_UPSTREAM, tm_probe_vkey, tm);
    tm_add_probe(e[4], "src", GST_PAD_PROBE_TYPE_BUFFER, tm_probe_vdec, tm);
    tm_add_probe(e[9], "sink", GST_PAD_PROBE_TYPE_BUFFER, tm_probe_vshm, tm);
    tm->vrx_caps = e[0];
    g_message("teams_media: video receive branch up");
    return TRUE;
}

static GstPadProbeReturn tm_probe_vtx(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    (void)pad;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST)
        g_atomic_int_add(&tm->stats.v_tx_pkts, (gint)gst_buffer_list_length(GST_PAD_PROBE_INFO_BUFFER_LIST(info)));
    else
        g_atomic_int_inc(&tm->stats.v_tx_pkts);
    return GST_PAD_PROBE_OK;
}

/* The persistent send tail: queue -> rtph264pay -> sink_element (srtpenc's next rtp_sink, or a
 * test's sink), plus the RTCP appsrc. A camera head (tm_video_tx_start) links to tm->vtx_queue.
 * Returns the RTP and RTCP outputs to link, or FALSE. */
static gboolean tm_video_tx_build(TeamsMedia *tm, GstElement *pipeline, GstElement **rtp_out, GstElement **rtcp_out)
{
    GstElement *q = mk("queue", "txv-queue"), *cf = mk("capsfilter", "txv-caps"), *pay = mk("rtph264pay", "txv-pay");
    GstElement *rtcp = mk("appsrc", "tx-rtcp");
    if (!q || !cf || !pay || !rtcp) {
        GstElement *all[4] = { q, cf, pay, rtcp };
        tm_drop_elements(all, 4);
        return FALSE;
    }
    /* Leaky: a stalled network side drops video, never the audio sharing the funnel. */
    g_object_set(q, "leaky", 2, "max-size-buffers", 30, "max-size-time", (guint64)0, "max-size-bytes", 0, NULL);
    GstCaps *c = gst_caps_new_simple("video/x-h264", "stream-format", G_TYPE_STRING, "byte-stream",
                                     "alignment", G_TYPE_STRING, "au", NULL);
    g_object_set(cf, "caps", c, NULL);
    gst_caps_unref(c);
    g_object_set(pay, "pt", TV_PT_H264, "ssrc", tm->vtx_ssrc, "mtu", 1200, "config-interval", -1, NULL);
    c = gst_caps_new_empty_simple("application/x-rtcp");
    g_object_set(rtcp, "caps", c, "is-live", TRUE, "format", GST_FORMAT_TIME, "do-timestamp", TRUE,
                 "block", FALSE, "max-bytes", (guint64)65536, NULL);
    gst_caps_unref(c);
    gst_bin_add_many(GST_BIN(pipeline), q, cf, pay, rtcp, NULL);
    if (!gst_element_link_many(q, cf, pay, NULL))
        return FALSE;
    tm_add_probe(pay, "src", GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, tm_probe_vtx, tm);
    tm->vtx_queue = q;
    tm->rtcp_out = rtcp;
    *rtp_out = pay;
    *rtcp_out = rtcp;
    return TRUE;
}

/* Hand bytes to the RTCP appsrc (srtpenc protects and the funnel sends them). */
static void tm_push_rtcp(TeamsMedia *tm, const guint8 *p, gsize n)
{
    if (!tm->rtcp_out || !n)
        return;
    GstBuffer *b = gst_buffer_new_allocate(NULL, n, NULL);
    GstFlowReturn fr = GST_FLOW_OK;
    gst_buffer_fill(b, 0, p, n);
    g_signal_emit_by_name(tm->rtcp_out, "push-buffer", b, &fr);   /* takes its own reference */
    gst_buffer_unref(b);
    if (fr != GST_FLOW_OK && fr != GST_FLOW_FLUSHING)
        g_message("teams_media: could not queue RTCP: %s", gst_flow_get_name(fr));
}

/* Ask the camera's encoder for a keyframe: the far side sent a PLI or FIR. */
static void tm_video_force_keyframe(TeamsMedia *tm)
{
    if (!tm->vtx_queue || !tm->vtx_head)
        return;
    GstPad *sink = gst_element_get_static_pad(tm->vtx_queue, "sink");
    if (sink) {
        /* GstForceKeyUnit as libgstvideo builds it, without linking libgstvideo for it */
        GstStructure *st = gst_structure_new("GstForceKeyUnit", "running-time", G_TYPE_UINT64, GST_CLOCK_TIME_NONE,
                                             "all-headers", G_TYPE_BOOLEAN, TRUE, "count", G_TYPE_UINT, 0u, NULL);
        gst_pad_push_event(sink, gst_event_new_custom(GST_EVENT_CUSTOM_UPSTREAM, st));
        gst_object_unref(sink);
    }
}

/* Every TM_VTICK_MS on the media thread: keyframe requests, receiver reports and REMB, and
 * whether the far side's video is arriving. */
static gboolean tm_video_tick(gpointer user)
{
    TeamsMedia *tm = user;
    gint64 now = g_get_monotonic_time();
    guint8 pkt[32 + 24 + 12];
    gsize n = 0;
    guint32 peer = (guint32)g_atomic_int_get(&tm->peer_vssrc);

    g_mutex_lock(&tm->vlock);
    gint64 first = tm->v_first, last = tm->v_last, dec = tm->v_dec;
    if (tv_keyframe_overdue(now, last, first, dec))
        g_atomic_int_set(&tm->pli_wanted, 1);
    gboolean pli = peer && g_atomic_int_get(&tm->pli_wanted) && now - tm->last_pli >= TM_PLI_INTERVAL_US;
    gboolean report = peer && now - tm->last_report >= TM_REPORT_US;
    if (pli || report) {
        guint32 lsr = tm->sr_at ? tm->sr_ntp_mid : 0;
        guint32 dlsr = tm->sr_at ? (guint32)(((now - tm->sr_at) * 65536) / 1000000) : 0;
        n = tv_rtcp_build_rr(&tm->vstats, tm->vtx_ssrc, lsr, dlsr, pkt);
    }
    g_mutex_unlock(&tm->vlock);

    if (report) {
        n += tv_rtcp_build_remb(tm->vtx_ssrc, peer, TM_REMB_BPS, pkt + n);
        tm->last_report = now;
    }
    if (pli) {
        n += tv_rtcp_build_pli(tm->vtx_ssrc, peer, pkt + n);
        g_atomic_int_set(&tm->pli_wanted, 0);
        g_atomic_int_inc(&tm->stats.v_pli_sent);
        tm->last_pli = now;
    }
    tm_push_rtcp(tm, pkt, n);

    if (g_atomic_int_get(&tm->key_wanted) && now - tm->last_key >= TM_PLI_INTERVAL_US) {
        g_atomic_int_set(&tm->key_wanted, 0);
        g_atomic_int_inc(&tm->stats.v_key_asked);
        tm->last_key = now;
        tm_video_force_keyframe(tm);
    }

    gint arriving = dec && now - dec < TM_PEER_GONE_US ? 1 : 0;
    if (arriving != tm->peer_video && (arriving || tm->peer_video == 1)) {
        tm->peer_video = arriving;
        tm_event(tm, "PEERVIDEO %d", arriving);
    }
    return G_SOURCE_CONTINUE;
}

/* The camera head: front camera, hardware H264 from droidcamsrc's video pad, its viewfinder to
 * the self-view socket. TEAMS_MEDIA_CAMERA replaces it (tests, or another camera setup); it must
 * have an element "tmvout" whose src pad gives H264 byte-stream access units, and may have a
 * shmsink "tmpvshm" for the self-view. The vfsrc caps are fully fixed: droidcamsrc fixes only
 * size and frame rate of its viewfinder, and left the pixel aspect ratio a range that the
 * converters after it cannot take ("failed to negotiate vfsrc", Signal engine 9f38163). */
static gchar *tm_camera_description(const TeamsMedia *tm, gboolean *mirrored)
{
    int w = tm->vtx_w ? (int)tm->vtx_w : TM_VIDEO_W, h = tm->vtx_h ? (int)tm->vtx_h : TM_VIDEO_H;
    int bps = tm->vtx_kbps ? (int)tm->vtx_kbps * 1000 : TM_VIDEO_BITRATE;
    const char *env = g_getenv("TEAMS_MEDIA_CAMERA");
    if (env && *env) {
        *mirrored = FALSE;
        return g_strdup(env);
    }
    *mirrored = TRUE;
    return g_strdup_printf(
        "droidcamsrc name=tmcam mode=2 camera-device=1 target-bitrate=%d "
        "tmcam.imgsrc ! fakesink async=false "
        "tmcam.vfsrc ! video/x-raw,format=NV21,width=%d,height=%d,framerate=30/1,pixel-aspect-ratio=1/1 ! "
        "queue leaky=downstream max-size-buffers=2 ! videoconvert ! videoscale ! "
        "video/x-raw,format=I420,width=%d,height=%d,pixel-aspect-ratio=1/1 ! "
        "queue leaky=downstream max-size-buffers=2 ! shmsink name=tmpvshm "
        "tmcam.vidsrc ! video/x-h264,width=%d,height=%d ! h264parse config-interval=-1 ! "
        "video/x-h264,stream-format=byte-stream,alignment=au ! queue name=tmvout",
        bps, TM_VIDEO_W, TM_VIDEO_H, TM_PREVIEW_W, TM_PREVIEW_H, w, h);
}

/* Quarter turns (counter-clockwise, as the Phone app turns the self-view) for the camera's sensor
 * orientation; TEAMS_MEDIA_VIDEO_ROTATION overrides it. */
static gint tm_preview_turns(TeamsMedia *tm)
{
    const char *env = g_getenv("TEAMS_MEDIA_VIDEO_ROTATION");
    gint cw = 0;
    if (env && *env)
        cw = (gint)(g_ascii_strtoll(env, NULL, 10) & 3);
    else if (tm->vtx_cam && g_object_class_find_property(G_OBJECT_GET_CLASS(tm->vtx_cam), "sensor-orientation")) {
        gint deg = 0;
        g_object_get(tm->vtx_cam, "sensor-orientation", &deg, NULL);
        cw = ((deg + 45) / 90) & 3;
    }
    return (4 - cw) & 3;
}

static gboolean tm_video_tx_mirrored;

/* Media thread: begin the hardware-encoded stream, once per camera head. droidcamsrc ignores a
 * start-capture before the camera runs, so it waits for the first viewfinder frame. */
static gboolean tm_start_capture(gpointer user)
{
    TeamsMedia *tm = user;
    if (tm->vtx_cam && g_atomic_int_compare_and_exchange(&tm->vtx_capture, 0, 1)) {
        g_signal_emit_by_name(tm->vtx_cam, "start-capture");
        g_message("teams_media: camera capture started");
    }
    return G_SOURCE_REMOVE;
}

static GstPadProbeReturn tm_probe_vpreview(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    TeamsMedia *tm = user;
    (void)info;
    if (g_atomic_int_compare_and_exchange(&tm->vtx_announced, 0, 1)) {
        GstElement *shm = gst_pad_get_parent_element(pad);
        gchar *path = NULL;
        if (shm) {
            g_object_get(shm, "socket-path", &path, NULL);
            gst_object_unref(shm);
        }
        tm_event(tm, "VPREVIEW %s %d %d %d %d", path ? path : TM_PREVIEW_SHM, TM_PREVIEW_W, TM_PREVIEW_H,
                 tm_preview_turns(tm), tm_video_tx_mirrored ? 1 : 0);
        g_free(path);
        if (tm->vtx_cam && g_signal_lookup("start-capture", G_OBJECT_TYPE(tm->vtx_cam))) {
            GSource *s = g_idle_source_new();
            g_source_set_callback(s, tm_start_capture, tm, NULL);
            g_source_attach(s, tm->ctx);
            g_source_unref(s);
        }
    }
    return GST_PAD_PROBE_REMOVE;
}

/* Media thread: put a camera head in front of the send tail. */
static gboolean tm_video_tx_start(gpointer user)
{
    TeamsMedia *tm = user;
    if (tm->vtx_head || !tm->vtx_wanted || !tm->vtx_queue || !tm->pipeline)
        return G_SOURCE_REMOVE;
    gboolean mirrored = FALSE;
    gchar *desc = tm_camera_description(tm, &mirrored);
    GError *err = NULL;
    GstElement *head = gst_parse_bin_from_description(desc, FALSE, &err);
    if (!head) {
        g_printerr("teams_media: camera '%s': %s\n", desc, err ? err->message : "?");
        g_clear_error(&err);
        g_free(desc);
        tm_event(tm, "VIDEOERR tx-camera");
        return G_SOURCE_REMOVE;
    }
    g_clear_error(&err);
    GstElement *out = gst_bin_get_by_name(GST_BIN(head), "tmvout");
    GstPad *src = out ? gst_element_get_static_pad(out, "src") : NULL;
    GstPad *ghost = src ? gst_ghost_pad_new("src", src) : NULL;
    if (src) gst_object_unref(src);
    if (out) gst_object_unref(out);
    if (!ghost || !gst_element_add_pad(head, ghost)) {
        gst_object_unref(gst_object_ref_sink(head));
        g_free(desc);
        tm_event(tm, "VIDEOERR tx-camera");
        return G_SOURCE_REMOVE;
    }
    GstElement *pv = gst_bin_get_by_name(GST_BIN(head), "tmpvshm");
    if (pv) {
        tm_configure_shm(NULL, pv, tm_env_or("TEAMS_MEDIA_PREVIEW_SHM", TM_PREVIEW_SHM));
        tm_add_probe(pv, "sink", GST_PAD_PROBE_TYPE_BUFFER, tm_probe_vpreview, tm);
        gst_object_unref(pv);
    }
    tm->vtx_cam = gst_bin_get_by_name(GST_BIN(head), "tmcam");
    tm_video_tx_mirrored = mirrored;
    g_atomic_int_set(&tm->vtx_announced, 0);
    g_atomic_int_set(&tm->vtx_capture, 0);

    gst_bin_add(GST_BIN(tm->pipeline), head);
    GstPad *qsink = gst_element_get_static_pad(tm->vtx_queue, "sink");
    GstPadLinkReturn lr = gst_pad_link(ghost, qsink);
    gst_object_unref(qsink);
    if (lr != GST_PAD_LINK_OK || !gst_element_sync_state_with_parent(head)) {
        gst_element_set_state(head, GST_STATE_NULL);
        gst_bin_remove(GST_BIN(tm->pipeline), head);
        if (tm->vtx_cam) { gst_object_unref(tm->vtx_cam); tm->vtx_cam = NULL; }
        g_free(desc);
        tm_event(tm, "VIDEOERR tx-camera");
        return G_SOURCE_REMOVE;
    }
    tm->vtx_head = head;
    tm_event(tm, "VTX 1");
    g_message("teams_media: camera on (%s)", desc);
    g_free(desc);
    return G_SOURCE_REMOVE;
}

/* Media thread: take the camera head away again. */
static gboolean tm_video_tx_stop(gpointer user)
{
    TeamsMedia *tm = user;
    if (!tm->vtx_head)
        return G_SOURCE_REMOVE;
    GstElement *head = tm->vtx_head;
    tm->vtx_head = NULL;
    gst_element_set_state(head, GST_STATE_NULL);
    GstPad *ghost = gst_element_get_static_pad(head, "src");
    GstPad *peer = ghost ? gst_pad_get_peer(ghost) : NULL;
    if (peer) {
        gst_pad_unlink(ghost, peer);
        gst_object_unref(peer);
    }
    if (ghost) gst_object_unref(ghost);
    gst_bin_remove(GST_BIN(tm->pipeline), head);
    if (tm->vtx_cam) { gst_object_unref(tm->vtx_cam); tm->vtx_cam = NULL; }
    tm_event(tm, "VTX 0");
    g_message("teams_media: camera off");
    return G_SOURCE_REMOVE;
}

/* Run fn on the media thread, through one idle source attached to its context. */
static void tm_on_media_thread(TeamsMedia *tm, GSourceFunc fn)
{
    if (!tm->ctx)
        return;
    GSource *s = g_idle_source_new();
    g_source_set_callback(s, fn, tm, NULL);
    g_source_attach(s, tm->ctx);
    g_source_unref(s);
}

/* VIDEO 0|1 from the plugin: the user turned the camera off or on. */
static void tm_set_video(TeamsMedia *tm, gboolean on)
{
    if (!tm->video) {
        tm_event(tm, "VIDEOERR unavailable");
        return;
    }
    tm->vtx_wanted = on;
    tm_on_media_thread(tm, on ? tm_video_tx_start : tm_video_tx_stop);
}

/* ------------------------------------------------------------------ bus ------------------------ */

static gboolean on_bus(GstBus *bus, GstMessage *msg, gpointer user)
{
    (void)bus;
    TeamsMedia *tm = (TeamsMedia *)user;
    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_ERROR: {
            GError *err = NULL; gchar *dbg = NULL;
            gst_message_parse_error(msg, &err, &dbg);
            g_printerr("teams_media: pipeline ERROR from %s: %s (%s)\n",
                       GST_OBJECT_NAME(msg->src), err ? err->message : "?", dbg ? dbg : "");
            if (err) g_error_free(err);
            g_free(dbg);
            /* A camera that fails takes our video away, not the call. */
            if (tm->vtx_head && GST_MESSAGE_SRC(msg) &&
                (GST_MESSAGE_SRC(msg) == GST_OBJECT(tm->vtx_head) ||
                 gst_object_has_as_ancestor(GST_MESSAGE_SRC(msg), GST_OBJECT(tm->vtx_head)))) {
                tm_event(tm, "VIDEOERR tx-camera");
                tm_video_tx_stop(tm);
            }
            break;
        }
        case GST_MESSAGE_WARNING: {
            GError *err = NULL; gchar *dbg = NULL;
            gst_message_parse_warning(msg, &err, &dbg);
            g_printerr("teams_media: pipeline WARNING from %s: %s (%s)\n",
                       GST_OBJECT_NAME(msg->src), err ? err->message : "?", dbg ? dbg : "");
            if (err) g_error_free(err);
            g_free(dbg);
            break;
        }
        case GST_MESSAGE_STATE_CHANGED:
            if (GST_MESSAGE_SRC(msg) == GST_OBJECT(tm->pipeline)) {
                GstState o, n; gst_message_parse_state_changed(msg, &o, &n, NULL);
                if (n == GST_STATE_PLAYING && !tm->audiod_on) {
                    g_message("teams_media: pipeline PLAYING");
                    tm->audiod_on = TRUE;
                    if (tm->audiod_cb) tm->audiod_cb(1);
                }
            }
            break;
        default: break;
    }
    return TRUE;
}

/* ------------------------------------------------------------------ ICE ------------------------ */

static void on_nice_candidate(NiceAgent *agent, NiceCandidate *cand, gpointer user)
{
    TeamsMedia *tm = (TeamsMedia *)user;
    gchar *sdp = nice_agent_generate_local_candidate_sdp(agent, cand);
    if (sdp) {
        const char *bare = (strncmp(sdp, "a=", 2) == 0) ? sdp + 2 : sdp;
        g_message("teams_media: LOCAL candidate -> %s", bare);
        if (tm->cand_cb) tm->cand_cb(bare);
        g_free(sdp);
    }
}

static void on_nice_gathering_done(NiceAgent *agent, guint stream_id, gpointer user)
{
    TeamsMedia *tm = (TeamsMedia *)user;
    (void)agent; (void)stream_id;
    g_message("teams_media: ICE gathering done");
    if (tm->gathered_cb) tm->gathered_cb();
}

static void on_nice_state(NiceAgent *agent, guint stream_id, guint cid, guint state, gpointer user)
{
    (void)user;
    g_message("teams_media: ICE state -> %s", nice_component_state_to_string(state));
    if (state == NICE_COMPONENT_STATE_CONNECTED || state == NICE_COMPONENT_STATE_READY) {
        NiceCandidate *lc = NULL, *rc = NULL;
        if (nice_agent_get_selected_pair(agent, stream_id, cid, &lc, &rc) && lc && rc) {
            gchar *ls = nice_agent_generate_local_candidate_sdp(agent, lc);
            gchar *rs = nice_agent_generate_local_candidate_sdp(agent, rc);
            g_message("teams_media: ICE SELECTED local[%s] remote[%s]", ls?ls:"?", rs?rs:"?");
            g_free(ls); g_free(rs);
        }
    }
}

/* Build the agent, set remote creds (may be NULL for the caller at offer time), gather. Our local
 * creds are generated by libnice and read back by the caller of this fn (to emit UFRAG/PWD).
 * controlling = TRUE for the CALLER (outgoing), FALSE for the answerer (incoming). */
static void tm_drop_early_rx(NiceAgent *agent, guint stream_id, guint component_id, guint len,
                             gchar *buf, gpointer user);

static gboolean build_ice(TeamsMedia *tm, gboolean controlling, const char *remote_ufrag, const char *remote_pwd)
{
    /* NICE_COMPATIBILITY_RFC5245 = standard ICE. Teams' MS-ICE is close enough for host/srflx/relay
     * pairing in practice; if MS-specific quirks block it we may need MS-TURN via RELAY. */
    tm->agent = nice_agent_new(tm->nice_ctx, NICE_COMPATIBILITY_RFC5245);
    if (!tm->agent) { g_printerr("teams_media: nice_agent_new failed\n"); return FALSE; }
    g_object_set(tm->agent, "controlling-mode", controlling ? TRUE : FALSE, NULL);

    /* THE incoming-ICE fix, ported from Signal (7dd3ab2): Teams' caller (WebRTC/RingRTC-style)
     * nominates the selected pair via Google's ICE RENOMINATION extension (GOOG-NOMINATION STUN
     * attr 0xC001), NOT the standard USE-CANDIDATE. libnice's controlled answerer forms a valid pair
     * but never nominates it without this -> ICE goes connecting -> FAILED (exactly our symptom).
     * libnice 0.1.21 implements it behind support-renomination (defaults FALSE). Enable it. */
    g_object_set(tm->agent, "support-renomination", TRUE, NULL);

    if (g_stun_port)
        g_object_set(tm->agent, "stun-server", g_stun_host, "stun-server-port", (guint)g_stun_port, NULL);

    tm->component = 1;
    tm->stream_id = nice_agent_add_stream(tm->agent, 1);
    if (!tm->stream_id) { g_printerr("teams_media: add_stream failed\n"); return FALSE; }

    /* libnice reads a component's sockets only once something receives on it ("all I/O paused"
     * until nice_agent_attach_recv). nicesrc does that, but the caller builds its pipeline only
     * when the answer comes, so while it gathered nobody read the STUN server's reply: every
     * call we placed had no server-reflexive candidate, the peer had no address of ours behind
     * the NAT and the call ended up on TCP through the peer's relay. Receive (and drop) on the
     * agent's thread until nicesrc takes over. */
    if (!nice_agent_attach_recv(tm->agent, tm->stream_id, tm->component, tm->nice_ctx,
                                tm_drop_early_rx, NULL))
        g_printerr("teams_media: could not receive on the ICE stream before the pipeline\n");

    for (int i = 0; i < g_n_turn; i++) {
        TmTurn *t = &g_turn[i];
        if (nice_agent_set_relay_info(tm->agent, tm->stream_id, tm->component,
                                      t->host, (guint)t->port, t->user, t->pass, t->type))
            g_message("teams_media: TURN relay %s:%d type=%d", t->host, t->port, (int)t->type);
        else
            g_printerr("teams_media: set_relay_info failed %s:%d\n", t->host, t->port);
    }

    if (remote_ufrag && remote_pwd)
        nice_agent_set_remote_credentials(tm->agent, tm->stream_id, remote_ufrag, remote_pwd);

    g_signal_connect(tm->agent, "new-candidate-full",       G_CALLBACK(on_nice_candidate),      tm);
    g_signal_connect(tm->agent, "candidate-gathering-done", G_CALLBACK(on_nice_gathering_done), tm);
    g_signal_connect(tm->agent, "component-state-changed",  G_CALLBACK(on_nice_state),          tm);

    if (!nice_agent_gather_candidates(tm->agent, tm->stream_id)) {
        g_printerr("teams_media: gather_candidates failed\n"); return FALSE;
    }
    return TRUE;
}

/* ------------------------------------------------------------------ pipeline ------------------- */

/* rtpptdemux "pad-added": a src pad appears the first time each payload type is seen on the
 * decrypted RTP stream (the peer BUNDLEs audio, video and RTX onto one srtpdec/ICE component).
 * Pad names are "src_%u" where %u is the payload type. Route the audio PT to the Opus chain and
 * anything else to a fresh fakesink so it doesn't stall the demux. */
static void on_rtpptdemux_new_pt(GstElement *demux, GstPad *pad, gpointer user)
{
    (void)demux;
    TeamsMedia *tm = (TeamsMedia *)user;
    guint pt = 0;
    if (sscanf(GST_PAD_NAME(pad), "src_%u", &pt) != 1) {
        g_printerr("teams_media: ptdemux pad-added with unparsable name %s\n", GST_PAD_NAME(pad));
        return;
    }

    gboolean audio = (int)pt == tm->pt;
    gboolean video = pt == TV_PT_H264 && tm->vrx_caps;
    GstPad *sink = NULL;
    if (audio) {
        sink = gst_element_get_static_pad(tm->rx_audio_caps, "sink");
    } else if (video) {
        sink = gst_element_get_static_pad(tm->vrx_caps, "sink");
    } else {
        GstElement *fs = mk("fakesink", NULL);
        if (fs) {
            g_object_set(fs, "sync", FALSE, "async", FALSE, NULL);
            gst_bin_add(GST_BIN(tm->pipeline), fs);
            gst_element_sync_state_with_parent(fs);
            sink = gst_element_get_static_pad(fs, "sink");
        }
    }
    if (sink) {
        GstPadLinkReturn r = gst_pad_link(pad, sink);
        gst_object_unref(sink);
        g_message("teams_media: ptdemux PT %u -> %s (%s)", pt, audio ? "audio" : video ? "video" : "dropped",
                  r == GST_PAD_LINK_OK ? "linked" : "LINK FAILED");
    }
}

/* Link up's src pad through a new srtpenc stream ("rtp" or "rtcp") into a new funnel sink pad.
 * srtpenc numbers the <kind>_src_N it makes by the requested sink pad's name, so the sink pad is
 * requested by name: requested without one it is called "padN", every stream then maps to
 * <kind>_src_0 and only the first one links. */
static gboolean tm_link_srtp_stream(GstElement *up, GstElement *senc, const char *kind, GstElement *funnel)
{
    gchar *tmpl_name = g_strdup_printf("%s_sink_%%u", kind);
    GstPadTemplate *tmpl = gst_element_get_pad_template(senc, tmpl_name);
    g_free(tmpl_name);
    GstPad *sink = NULL;
    guint n = 0;
    for (; tmpl && !sink && n < 16; n++) {
        gchar *name = g_strdup_printf("%s_sink_%u", kind, n);
        GstPad *have = gst_element_get_static_pad(senc, name);
        if (have) gst_object_unref(have);
        else sink = gst_element_request_pad(senc, tmpl, name, NULL);
        g_free(name);
    }
    if (!sink)
        return FALSE;
    gchar *src_name = g_strdup_printf("%s_src_%u", kind, n - 1);
    GstPad *upsrc = gst_element_get_static_pad(up, "src");
    gboolean ok = upsrc && gst_pad_link(upsrc, sink) == GST_PAD_LINK_OK;
    if (upsrc) gst_object_unref(upsrc);
    gst_object_unref(sink);
    GstPad *esrc = ok ? gst_element_get_static_pad(senc, src_name) : NULL;
    g_free(src_name);
    GstPad *fsink = esrc ? gst_element_request_pad_simple(funnel, "sink_%u") : NULL;
    ok = esrc && fsink && gst_pad_link(esrc, fsink) == GST_PAD_LINK_OK;
    if (esrc) gst_object_unref(esrc);
    if (fsink) gst_object_unref(fsink);
    if (!ok)
        g_printerr("teams_media: could not link a %s stream through srtpenc\n", kind);
    return ok;
}

static gboolean build_pipeline(TeamsMedia *tm)
{
    tm->pipeline = gst_pipeline_new("teams-call");

    GstElement *nsrc  = mk("nicesrc",      "rx-nicesrc");
    GstElement *rxcap = mk("capsfilter",   "rx-srtpcaps");
    GstElement *sdec  = mk("srtpdec",      "rx-srtpdec");
    GstElement *ptdemux = mk("rtpptdemux", "rx-ptdemux");   /* splits BUNDLE'd audio/video by PT */
    GstElement *rtcpfake = mk("fakesink",  "rx-rtcpfake");   /* discards rtcp-mux'd RTCP from srtpdec */
    GstElement *rxrtp = mk("capsfilter",   "rx-rtpcaps");
    GstElement *rxjb  = mk("rtpjitterbuffer", "rx-jitterbuf"); /* reorder/dejitter + PLC */
    GstElement *depay = mk("rtpopusdepay", "rx-depay");
    GstElement *odec  = mk("opusdec",      "rx-opusdec");
    GstElement *aconv = mk("audioconvert", "rx-aconv");
    GstElement *ares  = mk("audioresample","rx-ares");
    GstElement *asink = mk("pulsesink",    "rx-pulsesink");

    GstElement *asrc  = mk("pulsesrc",     "tx-pulsesrc");
    GstElement *tconv = mk("audioconvert", "tx-aconv");
    GstElement *tres  = mk("audioresample","tx-ares");
    GstElement *tcap  = mk("capsfilter",   "tx-rawcaps");
    GstElement *oenc  = mk("opusenc",      "tx-opusenc");
    GstElement *pay   = mk("rtpopuspay",   "tx-pay");
    GstElement *senc  = mk("srtpenc",      "tx-srtpenc");
    GstElement *txq   = mk("queue",        "tx-queue");
    GstElement *nsink = mk("nicesink",     "tx-nicesink");

    if (!nsrc||!rxcap||!sdec||!ptdemux||!rtcpfake||!rxrtp||!rxjb||!depay||!odec||!aconv||!ares||!asink||
        !asrc||!tconv||!tres||!tcap||!oenc||!pay||!senc||!txq||!nsink) {
        GstElement *all[] = { nsrc, rxcap, sdec, ptdemux, rtcpfake, rxrtp, rxjb, depay, odec, aconv,
                              ares, asink, asrc, tconv, tres, tcap, oenc, pay, senc, txq, nsink };
        for (gsize i = 0; i < G_N_ELEMENTS(all); i++)
            if (all[i]) gst_object_unref(gst_object_ref_sink(all[i]));
        gst_object_unref(tm->pipeline); tm->pipeline = NULL;
        return FALSE;
    }
    g_object_set(rtcpfake, "sync", FALSE, "async", FALSE, NULL);

    g_object_set(nsrc,  "agent", tm->agent, "stream", tm->stream_id, "component", tm->component, NULL);
    /* sync=FALSE async=FALSE: live RTP egress - send as captured, never wait for preroll (as in the
     * Signal engine). */
    g_object_set(nsink, "agent", tm->agent, "stream", tm->stream_id, "component", tm->component,
                 "sync", FALSE, "async", FALSE, NULL);
    /* A leaky, shallow queue in front of nicesink, as in the Signal engine: it gives nicesink a single
     * sending thread, and drops old egress buffers instead of back-pressuring the microphone. */
    g_object_set(txq, "leaky", 2 /*downstream*/, "max-size-time", (guint64)100000000 /*100ms*/,
                 "max-size-buffers", 0, "max-size-bytes", 0, NULL);

    { GstCaps *c = gst_caps_new_empty_simple("application/x-srtp"); g_object_set(rxcap, "caps", c, NULL); gst_caps_unref(c); }
    g_signal_connect(sdec, "request-key", G_CALLBACK(on_srtpdec_request_key), tm);
    g_signal_connect(ptdemux, "pad-added", G_CALLBACK(on_rtpptdemux_new_pt), tm);
    { GstCaps *c = opus_rtp_caps(tm->pt); g_object_set(rxrtp, "caps", c, NULL); gst_caps_unref(c); }
    /* 120 ms of reordering and concealment, low-latency mode: the Signal engine's tuning. */
    g_object_set(rxjb, "latency", 120, "do-lost", TRUE, "mode", 1 /*slave*/, NULL);
    /* No clock sync on playback: the network paces RX, as with the Signal engine's alsasink. */
    g_object_set(asink, "device", TM_PLAYBACK_DEVICE, "sync", FALSE, NULL);
    /* A 200 ms capture ring, so a scheduling hiccup doesn't overrun the microphone, and not the
     * pipeline clock: as with the Signal engine's alsasrc. */
    g_object_set(asrc, "device", TM_CAPTURE_DEVICE,
                 "buffer-time", (gint64)200000, "latency-time", (gint64)20000,
                 "provide-clock", FALSE, NULL);

    { GstCaps *c = gst_caps_new_simple("audio/x-raw", "format", G_TYPE_STRING, "S16LE",
        "rate", G_TYPE_INT, TM_OPUS_CLOCKRATE, "channels", G_TYPE_INT, TM_OPUS_CHANNELS, NULL);
      g_object_set(tcap, "caps", c, NULL); gst_caps_unref(c); }
    g_object_set(oenc, "bitrate", 32000, NULL);
    gst_util_set_object_arg(G_OBJECT(oenc), "audio-type", "voice");
    g_object_set(pay,  "pt", tm->pt, "ssrc", tm->tx_ssrc, NULL);
    configure_srtpenc(senc, tm->tx_master);

    tm->rx_audio_caps = rxrtp;

    gst_bin_add_many(GST_BIN(tm->pipeline),
        nsrc, rxcap, sdec, ptdemux, rtcpfake, rxrtp, rxjb, depay, odec, aconv, ares, asink,
        asrc, tconv, tres, tcap, oenc, pay, senc, txq, nsink, NULL);

    if (!gst_element_link_many(nsrc, rxcap, sdec, NULL)) {
        g_printerr("teams_media: RX link (nsrc..sdec) failed\n"); return FALSE; }
    /* srtpdec has STATIC "always" pads rtp_src/rtcp_src. Link rtp_src to rtpptdemux explicitly
     * rather than via gst_element_link (which would be ambiguous between sdec's two src pads). */
    { GstPad *rtp_src = gst_element_get_static_pad(sdec, "rtp_src");
      GstPad *demux_sink = gst_element_get_static_pad(ptdemux, "sink");
      gboolean ok = rtp_src && demux_sink && gst_pad_link(rtp_src, demux_sink) == GST_PAD_LINK_OK;
      if (rtp_src) gst_object_unref(rtp_src);
      if (demux_sink) gst_object_unref(demux_sink);
      if (!ok) { g_printerr("teams_media: sdec.rtp_src -> ptdemux.sink link failed\n"); return FALSE; } }
    /* ptdemux's src pads appear dynamically (on_rtpptdemux_new_pt), one per payload type actually
     * seen on the wire - the audio branch below just waits, already built+added to the bin. */
    if (!gst_element_link_many(rxrtp, rxjb, depay, odec, aconv, ares, asink, NULL)) {
        g_printerr("teams_media: RX audio link failed\n"); return FALSE; }
    /* srtpdec's rtcp_src (rtcp-mux'd RTCP, decrypted) would return NOT_LINKED and kill the RX chain:
     * drain it into a fakesink. */
    { GstPad *rtcp = gst_element_get_static_pad(sdec, "rtcp_src");
      GstPad *fsink = gst_element_get_static_pad(rtcpfake, "sink");
      gboolean ok = rtcp && fsink && gst_pad_link(rtcp, fsink) == GST_PAD_LINK_OK;
      if (rtcp) gst_object_unref(rtcp);
      if (fsink) gst_object_unref(fsink);
      if (!ok) { g_printerr("teams_media: sdec.rtcp_src -> fakesink link failed\n"); return FALSE; } }
    /* Everything we send goes through srtpenc, one stream each, and a funnel into the queue in
     * front of nicesink: audio, and with video our H264 and our RTCP. */
    GstElement *funnel = mk("funnel", "tx-funnel");
    if (!funnel) return FALSE;
    gst_bin_add(GST_BIN(tm->pipeline), funnel);
    if (!gst_element_link_many(asrc, tconv, tres, tcap, oenc, pay, NULL) ||
        !tm_link_srtp_stream(pay, senc, "rtp", funnel) ||
        !gst_element_link_many(funnel, txq, nsink, NULL)) {
        g_printerr("teams_media: TX audio link failed\n"); return FALSE; }
    if (tm->video) {
        GstElement *vpay = NULL, *rtcp = NULL;
        gboolean ok = tm_video_rx_build(tm, tm->pipeline) &&
                      tm_video_tx_build(tm, tm->pipeline, &vpay, &rtcp) &&
                      tm_link_srtp_stream(vpay, senc, "rtp", funnel) &&
                      tm_link_srtp_stream(rtcp, senc, "rtcp", funnel);
        if (!ok) {
            /* Half-built video elements stay in the bin, unlinked from the audio, and do nothing. */
            g_printerr("teams_media: video could not be built, the call stays voice only\n");
            tm->vrx_caps = NULL;
            tm->vtx_queue = NULL;
            tm->rtcp_out = NULL;
            tm_event(tm, "VIDEOERR build");
        } else {
            tm->peer_video = -1;
            tm->vtimer = g_timeout_source_new(TM_VTICK_MS);
            g_source_set_callback(tm->vtimer, tm_video_tick, tm, NULL);
            g_source_attach(tm->vtimer, tm->ctx);
        }
    }

    tm_add_probe(nsink, "sink", GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, tm_probe_tx, tm);
    tm_add_probe(nsrc, "src", GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, tm_probe_rx, tm);
    tm_add_probe(tcap, "src", GST_PAD_PROBE_TYPE_BUFFER, tm_probe_mic, tm);
    tm_add_probe(sdec, "rtcp_src", GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, tm_probe_rtcp, tm);
    tm->stats_src = g_timeout_source_new_seconds(TM_STATS_SECONDS);
    g_source_set_callback(tm->stats_src, tm_stats_tick, tm, NULL);
    g_source_attach(tm->stats_src, tm->ctx);

    GstBus *bus = gst_pipeline_get_bus(GST_PIPELINE(tm->pipeline));
    GSource *src = gst_bus_create_watch(bus);
    g_source_set_callback(src, G_SOURCE_FUNC(on_bus), tm, NULL);
    g_source_attach(src, tm->ctx);
    g_source_unref(src);
    gst_object_unref(bus);
    return TRUE;
}

static gpointer media_thread(gpointer data)
{
    TeamsMedia *tm = (TeamsMedia *)data;
    g_main_context_push_thread_default(tm->ctx);
    g_main_loop_run(tm->loop);
    g_main_context_pop_thread_default(tm->ctx);
    return NULL;
}

/* Media that arrives before our pipeline (the caller's, before the answer): nothing can decrypt
 * it yet, so it is dropped. */
static void tm_drop_early_rx(NiceAgent *agent, guint stream_id, guint component_id, guint len,
                             gchar *buf, gpointer user)
{
    (void)agent; (void)stream_id; (void)component_id; (void)len; (void)buf; (void)user;
}

/* The ICE agent's thread: runs its context for the whole call (see TeamsMedia.nice_ctx). */
static gpointer tm_nice_thread(gpointer data)
{
    TeamsMedia *tm = (TeamsMedia *)data;
    g_main_context_push_thread_default(tm->nice_ctx);
    g_main_loop_run(tm->nice_loop);
    g_main_context_pop_thread_default(tm->nice_ctx);
    return NULL;
}

static void tm_init(void)
{
    if (g_once_init_enter(&g_inited)) { gst_init(NULL, NULL); g_once_init_leave(&g_inited, 1); }
}

/* Bring the pipeline up (needs rx_master set). Shared by the answerer path and, for the caller, by
 * tm_apply_answer once the peer's answer arrives. */
static int tm_run_pipeline(void)
{
    if (g_tm.pipeline) return 0;   /* a repeated ANSWER: already running */
    if (!build_pipeline(&g_tm)) {
        if (g_tm.pipeline) { gst_object_unref(g_tm.pipeline); g_tm.pipeline = NULL; }
        return -1;
    }
    if (gst_element_set_state(g_tm.pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
        g_printerr("teams_media: set PLAYING failed\n"); return -1;
    }
    if (!g_tm.thread) { g_tm.running = TRUE; g_tm.thread = g_thread_new("teams-media", media_thread, &g_tm); }
    /* A camera turned on before the pipeline was there (we called, the answer came later). */
    if (g_tm.vtx_wanted) tm_on_media_thread(&g_tm, tm_video_tx_start);
    return 0;
}

/* is_caller=0 (answerer): rx_master from the OFFER, pipeline starts now.
 * is_caller=1 (caller):   rx_master_b64/remote_* are NULL; we generate the TX key + local ICE and
 *                         emit them for our OFFER, but DEFER the pipeline until tm_apply_answer().
 * Our TX key is returned via *out_txkey_b64 and our libnice-generated local creds via
 * *out_ufrag and *out_pwd; the caller frees them. */
static void ipc_gathered(void);

static int tm_start(int is_caller, const char *rx_master_b64, const char *remote_ufrag,
                    const char *remote_pwd, int pt,
                    void (*cand_cb)(const char*), void (*audiod_cb)(int), void (*event_cb)(const char *),
                    gchar **out_ufrag, gchar **out_pwd, gchar **out_txkey_b64)
{
    tm_init();
    memset(&g_tm, 0, sizeof g_tm);
    g_mutex_init(&g_tm.key_lock);
    g_tm.cand_cb = cand_cb; g_tm.audiod_cb = audiod_cb;
    g_tm.gathered_cb = ipc_gathered;
    g_tm.pt = pt > 0 ? pt : TM_DEFAULT_PT;
    /* Never 0, which is how a stats line says "none yet". */
    do { g_tm.tx_ssrc = g_random_int(); } while (!g_tm.tx_ssrc);
    g_mutex_init(&g_tm.vlock);
    g_tm.event_cb = event_cb;
    g_tm.video = tm_video_available();
    if (g_tm.video)
        do { g_tm.vtx_ssrc = g_random_int(); } while (!g_tm.vtx_ssrc || g_tm.vtx_ssrc == g_tm.tx_ssrc);

    if (!is_caller) {
        g_tm.rx_master = master_buffer_from_b64(rx_master_b64);
        if (!g_tm.rx_master) { g_printerr("teams_media: bad rx master\n"); return -1; }
    }

    /* TX master: 44 random bytes, emitted as base64 for our a=crypto (offer or answer). */
    guchar txk[TM_GCM_MASTER_SIZE];
    if (!random_bytes(txk, sizeof txk)) {
        g_printerr("teams_media: no random bytes for the SRTP key: %s\n", g_strerror(errno));
        return -1;
    }
    g_tm.tx_master = master_buffer_from_bytes(txk, TM_GCM_MASTER_SIZE);
    if (out_txkey_b64) *out_txkey_b64 = g_base64_encode(txk, TM_GCM_MASTER_SIZE);
    memset(txk, 0, sizeof txk);
    if (!g_tm.tx_master) return -1;

    g_tm.ctx  = g_main_context_new();
    g_tm.loop = g_main_loop_new(g_tm.ctx, FALSE);
    g_tm.nice_ctx  = g_main_context_new();
    g_tm.nice_loop = g_main_loop_new(g_tm.nice_ctx, FALSE);
    g_tm.nice_thread = g_thread_new("teams-ice", tm_nice_thread, &g_tm);

    if (!build_ice(&g_tm, is_caller, remote_ufrag, remote_pwd)) return -1;

    { gchar *uf = NULL, *pw = NULL;
      nice_agent_get_local_credentials(g_tm.agent, g_tm.stream_id, &uf, &pw);
      if (out_ufrag) *out_ufrag = uf; else g_free(uf);
      if (out_pwd)   *out_pwd   = pw; else g_free(pw); }

    /* Caller: run the media loop now (so ICE gathering + trickle fire) but DEFER the gst pipeline
     * until we have the answer's RX key. Answerer: bring the pipeline up immediately. */
    if (is_caller) {
        g_tm.running = TRUE;
        g_tm.thread = g_thread_new("teams-media", media_thread, &g_tm);
        return 0;
    }
    return tm_run_pipeline();
}

/* Caller side: the peer's ANSWER arrived - set the RX master (from the answer's a=crypto), the
 * remote ICE creds, and bring the pipeline up. */
static int tm_apply_answer(const char *rx_master_b64, const char *remote_ufrag, const char *remote_pwd)
{
    GstBuffer *master;
    if (!g_tm.agent) return -1;
    master = master_buffer_from_b64(rx_master_b64);
    if (!master) { g_printerr("teams_media: apply_answer: bad rx master\n"); return -1; }
    set_rx_master(&g_tm, master);
    if (remote_ufrag && remote_pwd)
        nice_agent_set_remote_credentials(g_tm.agent, g_tm.stream_id, remote_ufrag, remote_pwd);
    g_message("teams_media: answer applied, starting pipeline");
    return tm_run_pipeline();
}

static int tm_add_remote_candidate(const char *sdp_candidate)
{
    if (!g_tm.agent || !sdp_candidate) return -1;
    gchar *attr = (strncmp(sdp_candidate, "a=", 2) == 0) ? g_strdup(sdp_candidate)
                                                         : g_strconcat("a=", sdp_candidate, NULL);
    NiceCandidate *c = nice_agent_parse_remote_candidate_sdp(g_tm.agent, g_tm.stream_id, attr);
    g_free(attr);
    if (!c) { g_printerr("teams_media: bad remote candidate: %s\n", sdp_candidate); return -1; }
    GSList *l = g_slist_append(NULL, c);
    int added = nice_agent_set_remote_candidates(g_tm.agent, g_tm.stream_id, g_tm.component, l);
    g_slist_free(l); nice_candidate_free(c);
    g_message("teams_media: REMOTE candidate added=%d -> %s", added, sdp_candidate);
    return added > 0 ? 0 : -1;
}

/* Tear down whatever tm_start() set up, also after it failed half-way. */
static void tm_stop(void)
{
    g_tm.running = FALSE;
    if (g_tm.pipeline) gst_element_set_state(g_tm.pipeline, GST_STATE_NULL);
    if (g_tm.audiod_on && g_tm.audiod_cb) g_tm.audiod_cb(0);
    g_tm.audiod_on = FALSE;
    if (g_tm.loop) g_main_loop_quit(g_tm.loop);
    if (g_tm.thread) { g_thread_join(g_tm.thread); g_tm.thread = NULL; }
    if (g_tm.stats_src) { g_source_destroy(g_tm.stats_src); g_source_unref(g_tm.stats_src); g_tm.stats_src = NULL; }
    if (g_tm.vtimer) { g_source_destroy(g_tm.vtimer); g_source_unref(g_tm.vtimer); g_tm.vtimer = NULL; }
    if (g_tm.vtx_cam) { gst_object_unref(g_tm.vtx_cam); g_tm.vtx_cam = NULL; }
    g_tm.vtx_head = NULL;   /* owned by the pipeline */
    if (g_tm.pipeline) { gst_object_unref(g_tm.pipeline); g_tm.pipeline = NULL; }
    /* The pipeline is down, so nothing waits on the agent any more: stop its thread first, so no
     * agent callback runs while the agent goes. */
    if (g_tm.nice_loop) g_main_loop_quit(g_tm.nice_loop);
    if (g_tm.nice_thread) { g_thread_join(g_tm.nice_thread); g_tm.nice_thread = NULL; }
    if (g_tm.agent) { g_object_unref(g_tm.agent); g_tm.agent = NULL; }
    if (g_tm.nice_loop) { g_main_loop_unref(g_tm.nice_loop); g_tm.nice_loop = NULL; }
    if (g_tm.nice_ctx) { g_main_context_unref(g_tm.nice_ctx); g_tm.nice_ctx = NULL; }
    set_rx_master(&g_tm, NULL);
    if (g_tm.tx_master) { gst_buffer_unref(g_tm.tx_master); g_tm.tx_master = NULL; }
    if (g_tm.loop) { g_main_loop_unref(g_tm.loop); g_tm.loop = NULL; }
    if (g_tm.ctx) { g_main_context_unref(g_tm.ctx); g_tm.ctx = NULL; }
    g_mutex_clear(&g_tm.key_lock);
    g_mutex_clear(&g_tm.vlock);
}

/* ------------------------------------------------------------------ IPC ------------------------ */
#ifndef TEAMS_MEDIA_NO_MAIN

static GMutex g_out_lock;
static void emit(const char *fmt, ...) G_GNUC_PRINTF(1, 2);
static void emit(const char *fmt, ...)
{
    va_list ap; va_start(ap, fmt);
    g_mutex_lock(&g_out_lock); vfprintf(stdout, fmt, ap); fflush(stdout); g_mutex_unlock(&g_out_lock);
    va_end(ap);
}
static void ipc_cand(const char *sdp)  { emit("CAND %s\n", sdp); }
static void ipc_audiod(int active)     { emit("AUDIOD %d\n", active ? 1 : 0); }
static void ipc_gathered(void)         { emit("GATHERED\n"); }
static void ipc_event(const char *line) { emit("%s\n", line); }

/* The IPv4 address of a STUN server given by name or address, into out. libnice's stun-server
 * property takes an address only; a name was silently never asked, which left a call with host
 * candidates alone and no way through the NAT. */
static gboolean resolve_stun_host(const char *host, char *out, size_t outlen)
{
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    int rc = getaddrinfo(host, NULL, &hints, &res);
    if (rc != 0 || !res) {
        g_printerr("teams_media: STUN server %s: %s\n", host, gai_strerror(rc));
        if (res) freeaddrinfo(res);
        return FALSE;
    }
    const struct sockaddr_in *sin = (const struct sockaddr_in *)res->ai_addr;
    gboolean ok = inet_ntop(AF_INET, &sin->sin_addr, out, (socklen_t)outlen) != NULL;
    freeaddrinfo(res);
    return ok;
}

/* Wipe a line or string that carried key material. explicit_bzero, because a plain memset right
 * before a free can be dropped as a dead store. */
static void wipe(char *s, size_t n) { explicit_bzero(s, n); }

static int run_ipc(int is_caller)
{
    char line[8192];
    int started = 0;
    setvbuf(stdout, NULL, _IOLBF, 0);
    g_mutex_init(&g_out_lock);

    while (fgets(line, sizeof line, stdin)) {
        char *nl = strchr(line, '\n'); if (nl) *nl = '\0';
        if (!line[0]) continue;

        if (strncmp(line, "RELAY ", 6) == 0) {
            char *sp = NULL;
            char *kind = strtok_r(line + 6, " ", &sp);
            char *host = strtok_r(NULL, " ", &sp);
            char *ports= strtok_r(NULL, " ", &sp);
            if (kind && host && ports) {
                int port = atoi(ports);
                if (!strcmp(kind, "stun")) {
                    if (resolve_stun_host(host, g_stun_host, sizeof g_stun_host)) {
                        g_stun_port = port;
                        g_message("teams_media: STUN server %s:%d", host, port);
                    }
                }
                else if (!strcmp(kind, "turn") && g_n_turn < TM_MAX_TURN) {
                    char *u = strtok_r(NULL, " ", &sp), *p = strtok_r(NULL, " ", &sp), *tr = strtok_r(NULL, " ", &sp);
                    TmTurn *t = &g_turn[g_n_turn++];
                    snprintf(t->host, sizeof t->host, "%s", host); t->port = port;
                    snprintf(t->user, sizeof t->user, "%s", u?u:""); snprintf(t->pass, sizeof t->pass, "%s", p?p:"");
                    t->type = (tr && !strcmp(tr,"tcp")) ? NICE_RELAY_TYPE_TURN_TCP
                            : (tr && !strcmp(tr,"tls")) ? NICE_RELAY_TYPE_TURN_TLS : NICE_RELAY_TYPE_TURN_UDP;
                }
            }
            wipe(line, sizeof line);
        } else if (strncmp(line, "START", 5) == 0) {
            if (started) { emit("ERR already-started\n"); continue; }
            char *sp = NULL; int rc; gchar *uf = NULL, *pw = NULL, *txk = NULL;
            strtok_r(line, " ", &sp);   /* consume "START" */
            if (is_caller) {
                /* CALLER: no rx key/remote yet - we produce the OFFER. START [pt] */
                char *pts = strtok_r(NULL, " ", &sp);
                rc = tm_start(1, NULL, NULL, NULL, pts ? atoi(pts) : TM_DEFAULT_PT,
                              ipc_cand, ipc_audiod, ipc_event, &uf, &pw, &txk);
            } else {
                /* ANSWERER: START <rxkey_b64> <rem_ufrag> <rem_pwd> [pt] */
                char *rxk = strtok_r(NULL, " ", &sp);
                char *ruf = strtok_r(NULL, " ", &sp);
                char *rpw = strtok_r(NULL, " ", &sp);
                char *pts = strtok_r(NULL, " ", &sp);
                if (!rxk || !ruf || !rpw) { wipe(line, sizeof line); emit("ERR start-missing-fields\n"); continue; }
                rc = tm_start(0, rxk, ruf, rpw, pts ? atoi(pts) : TM_DEFAULT_PT,
                              ipc_cand, ipc_audiod, ipc_event, &uf, &pw, &txk);
            }
            wipe(line, sizeof line);
            if (rc != 0) {
                emit("ERR start-failed\n");
                g_free(uf); g_free(pw); if (txk) { wipe(txk, strlen(txk)); g_free(txk); }
                tm_stop();
                return 1;
            }
            emit("UFRAG %s\n", uf ? uf : "");
            emit("PWD %s\n",   pw ? pw : "");
            emit("TXKEY %s\n", txk ? txk : "");
            emit("SSRC %u\n", g_tm.tx_ssrc);
            if (g_tm.video) emit("VSSRC %u\n", g_tm.vtx_ssrc);
            g_free(uf); g_free(pw); if (txk) { wipe(txk, strlen(txk)); g_free(txk); }
            started = 1;
            emit("READY\n");
        } else if (strncmp(line, "ANSWER ", 7) == 0) {
            /* CALLER: the peer's answer arrived. ANSWER <rxkey_b64> <rem_ufrag> <rem_pwd> */
            char *sp = NULL;
            char *rxk = strtok_r(line + 7, " ", &sp);
            char *ruf = strtok_r(NULL, " ", &sp);
            char *rpw = strtok_r(NULL, " ", &sp);
            int rc = (started && rxk) ? tm_apply_answer(rxk, ruf, rpw) : -1;
            wipe(line, sizeof line);
            if (!started || !rxk) emit("ERR answer-missing-fields\n");
            else if (rc != 0) emit("ERR answer-failed\n");
            else emit("ANSWERED\n");
        } else if (strncmp(line, "RCAND ", 6) == 0) {
            if (!started) { emit("ERR rcand-before-start\n"); continue; }
            tm_add_remote_candidate(line + 6);
        } else if (strncmp(line, "RESTART ", 8) == 0) {
            /* Mid-call ICE restart: the peer pushed a renegotiation with new remote ufrag/pwd
             * (commonly a whole new media leg/relay - Teams cycles through several of these on a
             * single renegotiation storm, captured live 2026-08-01). If a new key is given, swap
             * g_tm.rx_master, which srtpdec picks up lazily on its next request-key call
             * (on_srtpdec_request_key).
             *
             * Just calling nice_agent_set_remote_credentials() (the original version of this
             * command) is NOT enough: nice_agent_set_remote_candidates()/RCAND is purely additive
             * (agent.c: _set_remote_candidates_locked() only ever appends), so every leg Teams
             * cycles through piles its candidates on top of the previous leg's in the same
             * checklist with nothing ever cleared - by the 3rd+ restart the agent is juggling
             * candidates from 3+ unrelated legs. Do a REAL RFC 5245 restart instead via
             * nice_agent_restart_stream(): per libnice's nice_component_restart(), this clears the
             * component's stale remote-candidate list (nice_stream_restart -> component_restart)
             * and restores RFC7675 local consent, WITHOUT touching our already-bound local
             * candidates (no re-gather needed - same sockets are still valid). It also regenerates
             * our own local ice-ufrag/pwd (nice_stream_initialize_credentials); we put the old
             * ones back (below) and still re-emit them - same UFRAG/PWD lines teams_calling.c
             * parses at START - before the caller builds the next answer.
             * RESTART <rxkey_b64|-> <rem_ufrag> <rem_pwd> */
            char *sp = NULL;
            char *rxk = strtok_r(line + 8, " ", &sp);
            char *ruf = strtok_r(NULL, " ", &sp);
            char *rpw = strtok_r(NULL, " ", &sp);
            gboolean new_key = FALSE;
            if (!started || !g_tm.agent || !ruf || !rpw) {
                wipe(line, sizeof line);
                emit("ERR restart-missing-fields\n"); continue;
            }
            if (rxk && strcmp(rxk, "-") != 0) {
                GstBuffer *nb = master_buffer_from_b64(rxk);
                if (nb) { set_rx_master(&g_tm, nb); new_key = TRUE; }
            }
            /* Keep our own ufrag/pwd across the restart. Teams goes on signing its checks with
             * the password from our first answer, even after an updated answer carries new
             * ones: with the regenerated credentials every one of its checks failed the
             * integrity check, it never got to nominate a pair, ICE failed and Teams ended the
             * call as MediaError 410. RFC 8445 asks the answerer to change them on a restart,
             * but nothing here needs that, and keeping them matches either answer the peer uses. */
            gchar *keep_uf = NULL, *keep_pw = NULL;
            nice_agent_get_local_credentials(g_tm.agent, g_tm.stream_id, &keep_uf, &keep_pw);
            if (!nice_agent_restart_stream(g_tm.agent, g_tm.stream_id)) {
                g_free(keep_uf); if (keep_pw) { wipe(keep_pw, strlen(keep_pw)); g_free(keep_pw); }
                wipe(line, sizeof line);
                emit("ERR restart-stream-failed\n"); continue;
            }
            if (keep_uf && keep_pw &&
                !nice_agent_set_local_credentials(g_tm.agent, g_tm.stream_id, keep_uf, keep_pw))
                g_warning("teams_media: could not keep the local ICE credentials over the restart");
            g_free(keep_uf); if (keep_pw) { wipe(keep_pw, strlen(keep_pw)); g_free(keep_pw); }
            { gchar *uf = NULL, *pw = NULL;
              nice_agent_get_local_credentials(g_tm.agent, g_tm.stream_id, &uf, &pw);
              emit("UFRAG %s\n", uf ? uf : "");
              emit("PWD %s\n",   pw ? pw : "");
              g_free(uf); g_free(pw); }
            nice_agent_set_remote_credentials(g_tm.agent, g_tm.stream_id, ruf, rpw);
            wipe(line, sizeof line);
            g_message("teams_media: ICE restart - stream reset, new local+remote creds applied%s",
                      new_key ? " (+ new rx key)" : "");
            emit("RESTARTED\n");
        } else if (g_str_has_prefix(line, "VIDEO ")) {
            /* The user turned our camera off or on (only sent once the call is answered). */
            int on = 0;
            unsigned vw, vh, vk;
            if (!tv_parse_video_cmd(line, &on, &vw, &vh, &vk)) { emit("ERR bad-video\n"); continue; }
            if (!started) { emit("ERR video-before-start\n"); continue; }
            if (on) { g_tm.vtx_w = vw; g_tm.vtx_h = vh; g_tm.vtx_kbps = vk; }
            tm_set_video(&g_tm, on);
        } else if (!strcmp(line, "STOP")) {
            break;
        } else {
            emit("ERR unknown-cmd\n");
        }
    }
    if (started) tm_stop();
    return 0;
}

/* ------------------------------------------------------------------ loopback ------------------- */

/* Counts the Opus frames that came out of the decoder, i.e. made it through SRTP-GCM both ways. */
static GstPadProbeReturn count_buffers(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    (void)pad; (void)info;
    g_atomic_int_inc((gint *)user);
    return GST_PAD_PROBE_OK;
}

static gboolean loopback_bus(GstBus *bus, GstMessage *msg, gpointer user)
{
    (void)bus;
    GMainLoop *loop = user;
    if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
        GError *err = NULL; gchar *dbg = NULL;
        gst_message_parse_error(msg, &err, &dbg);
        g_printerr("[loopback] ERROR from %s: %s\n", GST_OBJECT_NAME(msg->src), err ? err->message : "?");
        if (err) g_error_free(err);
        g_free(dbg);
        g_main_loop_quit(loop);
    } else if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_EOS) {
        g_main_loop_quit(loop);
    }
    return TRUE;
}

/* srtpenc puts its key in its output caps, and srtpdec would take it from there. On a call the
 * caps carry no key and srtpdec asks for it with request-key, so the loopback strips the key to
 * test that path. */
static GstPadProbeReturn strip_srtp_key(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    GstEvent *ev = GST_PAD_PROBE_INFO_EVENT(info);
    (void)pad; (void)user;
    if (GST_EVENT_TYPE(ev) == GST_EVENT_CAPS) {
        GstCaps *caps;
        gst_event_parse_caps(ev, &caps);
        caps = gst_caps_copy(caps);
        gst_structure_remove_fields(gst_caps_get_structure(caps, 0), "srtp-key", "srtp-cipher",
                                    "srtp-auth", "srtcp-cipher", "srtcp-auth", "mki", NULL);
        gst_event_unref(ev);
        GST_PAD_PROBE_INFO_DATA(info) = gst_event_new_caps(caps);
        gst_caps_unref(caps);
    }
    return GST_PAD_PROBE_OK;
}

static int loopback(void)
{
    tm_init();
    g_mutex_init(&g_tm.key_lock);
    guchar k[TM_GCM_MASTER_SIZE]; for (int i=0;i<TM_GCM_MASTER_SIZE;i++) k[i]=(guchar)(i+1);
    GstBuffer *master = master_buffer_from_bytes(k, TM_GCM_MASTER_SIZE);
    GMainLoop *loop = g_main_loop_new(NULL, FALSE);
    GstElement *pipe = gst_pipeline_new("lt");
    GstElement *src=mk("audiotestsrc","s"),*conv=mk("audioconvert","c"),*res=mk("audioresample","r"),
        *caps=mk("capsfilter","cf"),*oenc=mk("opusenc","oe"),*pay=mk("rtpopuspay","p"),
        *senc=mk("srtpenc","se"),*sdec=mk("srtpdec","sd"),*rxc=mk("capsfilter","rc"),
        *depay=mk("rtpopusdepay","dp"),*odec=mk("opusdec","od"),*sink=mk("fakesink","fs");
    gint decoded = 0;
    int rc = 0;
    if (!master||!pipe||!src||!conv||!res||!caps||!oenc||!pay||!senc||!sdec||!rxc||!depay||!odec||!sink) {
        g_printerr("[loopback] missing element(s)\n"); return 3; }
    g_object_set(src, "num-buffers", 200, "samplesperbuffer", 480, NULL);   /* 10 ms at 48 kHz */
    { GstCaps *c=gst_caps_new_simple("audio/x-raw","format",G_TYPE_STRING,"S16LE","rate",G_TYPE_INT,TM_OPUS_CLOCKRATE,"channels",G_TYPE_INT,TM_OPUS_CHANNELS,NULL);
      g_object_set(caps,"caps",c,NULL); gst_caps_unref(c); }
    g_object_set(pay,"pt",TM_DEFAULT_PT,NULL);
    configure_srtpenc(senc, master);
    g_tm.rx_master = gst_buffer_ref(master);
    g_signal_connect(sdec,"request-key",G_CALLBACK(on_srtpdec_request_key),&g_tm);
    { GstCaps *c=opus_rtp_caps(TM_DEFAULT_PT); g_object_set(rxc,"caps",c,NULL); gst_caps_unref(c); }
    g_object_set(sink,"sync",FALSE,"async",FALSE,NULL);
    gst_bin_add_many(GST_BIN(pipe),src,conv,res,caps,oenc,pay,senc,sdec,rxc,depay,odec,sink,NULL);
    if (!gst_element_link_many(src,conv,res,caps,oenc,pay,senc,NULL)||
        !gst_element_link_many(senc,sdec,NULL)||
        !gst_element_link_many(sdec,rxc,depay,odec,sink,NULL)) {
        g_printerr("[loopback] link failed\n");
        gst_object_unref(pipe); gst_buffer_unref(master); g_main_loop_unref(loop);
        return 4;
    }
    { GstPad *p = gst_element_get_static_pad(sink, "sink");
      gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_BUFFER, count_buffers, &decoded, NULL);
      gst_object_unref(p); }
    { GstPad *p = gst_element_get_static_pad(sdec, "rtp_sink");
      gst_pad_add_probe(p, GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM, strip_srtp_key, NULL, NULL);
      gst_object_unref(p); }
    { GstBus *b = gst_pipeline_get_bus(GST_PIPELINE(pipe)); gst_bus_add_watch(b, loopback_bus, loop); gst_object_unref(b); }
    g_print("[loopback] SRTP-GCM+RTP+Opus round-trip...\n");
    if (gst_element_set_state(pipe, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
        g_printerr("[loopback] set PLAYING failed\n"); rc = 5;
    } else {
        g_main_loop_run(loop);
    }
    gst_element_set_state(pipe,GST_STATE_NULL);
    /* 200 x 10 ms test buffers make 100 20 ms Opus frames; allow a few to be lost at the edges. */
    if (!rc && g_atomic_int_get(&decoded) < 90) rc = 6;
    g_print("[loopback] %d frames decoded: %s\n", g_atomic_int_get(&decoded), rc ? "FAIL" : "PASS");
    { GstBus *b = gst_pipeline_get_bus(GST_PIPELINE(pipe)); gst_bus_remove_watch(b); gst_object_unref(b); }
    gst_object_unref(pipe); gst_buffer_unref(master); g_main_loop_unref(loop);
    set_rx_master(&g_tm, NULL);
    g_mutex_clear(&g_tm.key_lock);
    return rc;
}

int main(int argc, char **argv)
{
    tm_init();
    if (argc >= 2 && (!strcmp(argv[1],"--loopback")||!strcmp(argv[1],"--selftest"))) return loopback();
    if (argc >= 2 && !strcmp(argv[1],"--answer")) return run_ipc(0);
    if (argc >= 2 && !strcmp(argv[1],"--caller")) return run_ipc(1);
    g_print("Teams call media engine.\n  %s --loopback\n  %s --answer\n  %s --caller\n", argv[0], argv[0], argv[0]);
    return 0;
}
#endif
