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
 * Voice only. The peer BUNDLEs video onto the same ICE/SRTP transport when it has a camera on; those
 * packets (and RTX) are split off by rtpptdemux and dropped.
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
 *        RELAY stun <host> <port>                             (optional)
 *        RCAND <candidate:... sdp line>                       (a remote ICE candidate; repeatable)
 *        RESTART <rx_master_b64|-> <remote_ufrag> <remote_pwd> (mid-call renegotiation: peer swapped
 *                                                               to a new media leg - new remote ICE
 *                                                               creds [+ optionally a new RX key],
 *                                                               applied WITHOUT rebuilding the
 *                                                               already-PLAYING pipeline; follow with
 *                                                               RCAND for the new leg's candidates)
 *        STOP
 *   out: UFRAG <our_ufrag>
 *        PWD <our_pwd>
 *        TXKEY <tx_master_b64>                                (our a=crypto inline key for the answer)
 *        CAND <candidate:... sdp line>                        (our local ICE candidate)
 *        AUDIOD <0|1>
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

    NiceAgent    *agent;
    guint         stream_id;
    guint         component;   /* 1 = RTP (rtcp-mux) */

    GstElement   *pipeline;

    GMutex        key_lock;     /* rx_master: swapped by RESTART, read by srtpdec's request-key */
    GstBuffer    *rx_master;    /* peer's SRTP master (decrypt RX), 44B */
    GstBuffer    *tx_master;    /* our SRTP master (encrypt TX), 44B */
    int           pt;           /* opus payload type from the offer */

    void (*cand_cb)(const char *sdp);
    void (*audiod_cb)(int active);

    gboolean      audiod_on;
    gboolean      running;

    GstElement   *rx_audio_caps;    /* rx-rtpcaps: ptdemux routing target for the audio PT */
} TeamsMedia;

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

static GstCaps *opus_rtp_caps(int pt)
{
    return gst_caps_new_simple("application/x-rtp",
                               "media",         G_TYPE_STRING, "audio",
                               "clock-rate",    G_TYPE_INT,    TM_OPUS_CLOCKRATE,
                               "encoding-name", G_TYPE_STRING, "OPUS",
                               "payload",       G_TYPE_INT,    pt, NULL);
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
{ (void)agent;(void)stream_id;(void)user; g_message("teams_media: ICE gathering done"); }

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
static gboolean build_ice(TeamsMedia *tm, gboolean controlling, const char *remote_ufrag, const char *remote_pwd)
{
    /* NICE_COMPATIBILITY_RFC5245 = standard ICE. Teams' MS-ICE is close enough for host/srflx/relay
     * pairing in practice; if MS-specific quirks block it we may need MS-TURN via RELAY. */
    tm->agent = nice_agent_new(tm->ctx, NICE_COMPATIBILITY_RFC5245);
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
    GstPad *sink = NULL;
    if (audio) {
        sink = gst_element_get_static_pad(tm->rx_audio_caps, "sink");
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
        g_message("teams_media: ptdemux PT %u -> %s (%s)", pt, audio ? "audio" : "dropped",
                  r == GST_PAD_LINK_OK ? "linked" : "LINK FAILED");
    }
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
    g_object_set(pay,  "pt", tm->pt, NULL);
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
    if (!gst_element_link_many(asrc, tconv, tres, tcap, oenc, pay, senc, txq, nsink, NULL)) {
        g_printerr("teams_media: TX audio link failed\n"); return FALSE; }

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
    return 0;
}

/* is_caller=0 (answerer): rx_master from the OFFER, pipeline starts now.
 * is_caller=1 (caller):   rx_master_b64/remote_* are NULL; we generate the TX key + local ICE and
 *                         emit them for our OFFER, but DEFER the pipeline until tm_apply_answer().
 * Our TX key is returned via *out_txkey_b64 and our libnice-generated local creds via
 * *out_ufrag and *out_pwd; the caller frees them. */
static int tm_start(int is_caller, const char *rx_master_b64, const char *remote_ufrag,
                    const char *remote_pwd, int pt,
                    void (*cand_cb)(const char*), void (*audiod_cb)(int),
                    gchar **out_ufrag, gchar **out_pwd, gchar **out_txkey_b64)
{
    tm_init();
    memset(&g_tm, 0, sizeof g_tm);
    g_mutex_init(&g_tm.key_lock);
    g_tm.cand_cb = cand_cb; g_tm.audiod_cb = audiod_cb;
    g_tm.pt = pt > 0 ? pt : TM_DEFAULT_PT;

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
    if (g_tm.pipeline) { gst_object_unref(g_tm.pipeline); g_tm.pipeline = NULL; }
    if (g_tm.agent) { g_object_unref(g_tm.agent); g_tm.agent = NULL; }
    set_rx_master(&g_tm, NULL);
    if (g_tm.tx_master) { gst_buffer_unref(g_tm.tx_master); g_tm.tx_master = NULL; }
    if (g_tm.loop) { g_main_loop_unref(g_tm.loop); g_tm.loop = NULL; }
    if (g_tm.ctx) { g_main_context_unref(g_tm.ctx); g_tm.ctx = NULL; }
    g_mutex_clear(&g_tm.key_lock);
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
                if (!strcmp(kind, "stun")) { snprintf(g_stun_host, sizeof g_stun_host, "%s", host); g_stun_port = port; }
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
                              ipc_cand, ipc_audiod, &uf, &pw, &txk);
            } else {
                /* ANSWERER: START <rxkey_b64> <rem_ufrag> <rem_pwd> [pt] */
                char *rxk = strtok_r(NULL, " ", &sp);
                char *ruf = strtok_r(NULL, " ", &sp);
                char *rpw = strtok_r(NULL, " ", &sp);
                char *pts = strtok_r(NULL, " ", &sp);
                if (!rxk || !ruf || !rpw) { wipe(line, sizeof line); emit("ERR start-missing-fields\n"); continue; }
                rc = tm_start(0, rxk, ruf, rpw, pts ? atoi(pts) : TM_DEFAULT_PT,
                              ipc_cand, ipc_audiod, &uf, &pw, &txk);
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
             * candidates (no re-gather needed - same sockets are still valid). It DOES regenerate
             * our own local ice-ufrag/pwd though (nice_stream_initialize_credentials), so we must
             * re-emit them - same UFRAG/PWD lines teams_calling.c already parses at START - before
             * the caller can build a next answer with matching local creds.
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
            if (!nice_agent_restart_stream(g_tm.agent, g_tm.stream_id)) {
                wipe(line, sizeof line);
                emit("ERR restart-stream-failed\n"); continue;
            }
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
