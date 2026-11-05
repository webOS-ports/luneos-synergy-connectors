/*
 * GStreamer tests for teams_media's video: the receive branch behind rtpptdemux (H264 RTP from a
 * fixture, one packet lost on the way) up to the Phone app's shm socket, the receiver reports,
 * REMB and keyframe requests it sends, and the send tail with a camera head turned on and off
 * twice, and audio, video and RTCP through srtpenc into one funnel. Needs TEAMS_TEST_H264 (an
 * H264 byte-stream file, 15 fps, a keyframe every second), made for instance with
 *   ffmpeg -f lavfi -i testsrc=size=320x240:rate=15 -t 4 -c:v libx264 -profile:v baseline \
 *          -pix_fmt yuv420p -g 15 -bf 0 -x264-params repeat-headers=1 -f h264 testsrc-320x240.h264
 * and TEAMS_TEST_DIR (a directory for the shm sockets).
 */
#define TEAMS_MEDIA_NO_MAIN 1
#include "../teams_media.c"
#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <stun/stunagent.h>

static gint gathered_calls;
static void ipc_gathered(void) { g_atomic_int_inc(&gathered_calls); }

static int failures;
#define CHECK(c) do { if (!(c)) { failures++; fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); } } while (0)

/* ------------------------------------------------------------------ events ------------------- */

static GMutex ev_lock;
static GPtrArray *events;

static void on_event(const char *line)
{
    g_mutex_lock(&ev_lock);
    g_ptr_array_add(events, g_strdup(line));
    g_mutex_unlock(&ev_lock);
}

static int events_with(const char *prefix)
{
    int n = 0;
    g_mutex_lock(&ev_lock);
    for (guint i = 0; i < events->len; i++)
        if (g_str_has_prefix(g_ptr_array_index(events, i), prefix)) n++;
    g_mutex_unlock(&ev_lock);
    return n;
}

static gchar *event_with(const char *prefix)
{
    gchar *r = NULL;
    g_mutex_lock(&ev_lock);
    for (guint i = 0; i < events->len && !r; i++)
        if (g_str_has_prefix(g_ptr_array_index(events, i), prefix)) r = g_strdup(g_ptr_array_index(events, i));
    g_mutex_unlock(&ev_lock);
    return r;
}

/* Run the engine's media context (tm->ctx) until cond or timeout_ms. */
static gboolean wait_for(gboolean (*cond)(void), int timeout_ms)
{
    gint64 end = g_get_monotonic_time() + (gint64)timeout_ms * 1000;
    while (!cond()) {
        if (g_get_monotonic_time() > end) return FALSE;
        while (g_main_context_iteration(g_tm.ctx, FALSE)) {}
        g_usleep(10000);
    }
    return TRUE;
}

static GstElement *el(const char *f, const char *n)
{
    GstElement *e = gst_element_factory_make(f, n);
    if (!e) { fprintf(stderr, "missing element %s\n", f); exit(77); }
    return e;
}

static void setup(void)
{
    memset(&g_tm, 0, sizeof g_tm);
    g_mutex_init(&g_tm.key_lock);
    g_mutex_init(&g_tm.vlock);
    g_tm.ctx = g_main_context_new();
    g_tm.pt = TM_DEFAULT_PT;
    g_tm.video = TRUE;
    g_tm.vtx_ssrc = 4242;
    g_tm.event_cb = on_event;
    g_tm.peer_video = -1;
    g_mutex_lock(&ev_lock);
    g_ptr_array_set_size(events, 0);
    g_mutex_unlock(&ev_lock);
}

static void teardown(GstElement *p)
{
    if (g_tm.vtimer) { g_source_destroy(g_tm.vtimer); g_source_unref(g_tm.vtimer); g_tm.vtimer = NULL; }
    gst_element_set_state(p, GST_STATE_NULL);
    if (g_tm.vtx_cam) { gst_object_unref(g_tm.vtx_cam); g_tm.vtx_cam = NULL; }
    gst_object_unref(p);
    g_main_context_unref(g_tm.ctx);
    g_tm.ctx = NULL;
    g_mutex_clear(&g_tm.key_lock);
    g_mutex_clear(&g_tm.vlock);
}

/* ------------------------------------------------------------------ RTCP we send -------------- */

static GMutex rtcp_lock;
static int rtcp_rr, rtcp_remb, rtcp_pli, rtcp_rr_lsr;

/* Looks at each RTCP packet the engine queued for srtpenc. */
static GstFlowReturn on_rtcp_sample(GstElement *sink, gpointer u)
{
    (void)u;
    GstSample *s = NULL;
    g_signal_emit_by_name(sink, "pull-sample", &s);
    if (!s) return GST_FLOW_OK;
    GstMapInfo m;
    GstBuffer *b = gst_sample_get_buffer(s);
    if (gst_buffer_map(b, &m, GST_MAP_READ)) {
        gsize off = 0;
        g_mutex_lock(&rtcp_lock);
        while (off + 4 <= m.size) {
            const guint8 *h = m.data + off;
            gsize len = 4 * ((gsize)GST_READ_UINT16_BE(h + 2) + 1);
            if (off + len > m.size) break;
            if (h[1] == 201 && len == 32 && GST_READ_UINT32_BE(h + 4) == 4242 && GST_READ_UINT32_BE(h + 8) == 8836) {
                rtcp_rr++;
                if (GST_READ_UINT32_BE(h + 24) == 0xCCDD1122) rtcp_rr_lsr++;
            }
            if (h[1] == 206 && (h[0] & 0x1f) == 15 && len == 24 && !memcmp(h + 12, "REMB", 4) &&
                GST_READ_UINT32_BE(h + 20) == 8836)
                rtcp_remb++;
            if (h[1] == 206 && (h[0] & 0x1f) == 1 && GST_READ_UINT32_BE(h + 4) == 4242 &&
                GST_READ_UINT32_BE(h + 8) == 8836)
                rtcp_pli++;
            off += len;
        }
        g_mutex_unlock(&rtcp_lock);
        gst_buffer_unmap(b, &m);
    }
    gst_sample_unref(s);
    return GST_FLOW_OK;
}

static GstElement *rtcp_sink(GstElement *p, GstElement *rtcp)
{
    GstElement *sink = el("appsink", NULL);
    g_object_set(sink, "emit-signals", TRUE, "sync", FALSE, "async", FALSE, NULL);
    g_signal_connect(sink, "new-sample", G_CALLBACK(on_rtcp_sample), NULL);
    gst_bin_add(GST_BIN(p), sink);
    CHECK(gst_element_link(rtcp, sink));
    return sink;
}

/* ------------------------------------------------------------------ rx ---------------------- */

static gint shm_frames, shm_bad_size, far_pkts, far_dropped, demux_other;

static GstPadProbeReturn count_shm(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad;
    if (gst_buffer_get_size(GST_PAD_PROBE_INFO_BUFFER(info)) == GPOINTER_TO_SIZE(u)) g_atomic_int_inc(&shm_frames);
    else g_atomic_int_inc(&shm_bad_size);
    return GST_PAD_PROBE_OK;
}

static GstElement *shm_reader(const char *path, int w, int h)
{
    GstElement *p = gst_pipeline_new("reader");
    GstElement *src = el("shmsrc", NULL), *cf = el("capsfilter", NULL), *sink = el("fakesink", NULL);
    g_object_set(src, "socket-path", path, "is-live", TRUE, NULL);
    GstCaps *c = gst_caps_new_simple("video/x-raw", "format", G_TYPE_STRING, "I420", "width", G_TYPE_INT, w,
                                     "height", G_TYPE_INT, h, "framerate", GST_TYPE_FRACTION, 0, 1, NULL);
    g_object_set(cf, "caps", c, NULL);
    gst_caps_unref(c);
    g_object_set(sink, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add_many(GST_BIN(p), src, cf, sink, NULL);
    gst_element_link_many(src, cf, sink, NULL);
    GstPad *sp = gst_element_get_static_pad(sink, "sink");
    gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_BUFFER, count_shm, GSIZE_TO_POINTER((gsize)w * h * 3 / 2), NULL);
    gst_object_unref(sp);
    return p;
}

/* The far side's sender: drops its 40th packet, as a lossy network would. */
static GstPadProbeReturn far_side_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER) {
        if (g_atomic_int_add(&far_pkts, 1) == 40) { g_atomic_int_inc(&far_dropped); return GST_PAD_PROBE_DROP; }
        return GST_PAD_PROBE_OK;
    }
    GstBufferList *in = GST_PAD_PROBE_INFO_BUFFER_LIST(info), *out = gst_buffer_list_new();
    for (guint i = 0; i < gst_buffer_list_length(in); i++) {
        if (g_atomic_int_add(&far_pkts, 1) == 40) { g_atomic_int_inc(&far_dropped); continue; }
        gst_buffer_list_add(out, gst_buffer_ref(gst_buffer_list_get(in, i)));
    }
    gst_buffer_list_unref(in);
    GST_PAD_PROBE_INFO_DATA(info) = out;
    return GST_PAD_PROBE_OK;
}

static GstPadProbeReturn count_other(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)info; (void)u;
    g_atomic_int_inc(&demux_other);
    return GST_PAD_PROBE_OK;
}

static gboolean has_vshm(void) { return events_with("VSHM ") > 0; }
static gboolean rx_done(void)
{
    g_mutex_lock(&rtcp_lock);
    gboolean r = rtcp_pli > 0 && rtcp_remb > 0 && rtcp_rr_lsr > 0;
    g_mutex_unlock(&rtcp_lock);
    return r && g_atomic_int_get(&shm_frames) >= 20 && events_with("PEERVIDEO 1") > 0;
}
static gboolean peer_gone(void) { return events_with("PEERVIDEO 0") > 0; }

static void test_rx(const char *h264, const char *dir)
{
    setup();
    GstElement *p = gst_pipeline_new("rx");
    GstElement *fsrc = el("filesrc", NULL), *fcaps = el("capsfilter", NULL), *parse = el("h264parse", NULL);
    GstElement *pace = el("identity", NULL), *pay = el("rtph264pay", NULL), *demux = el("rtpptdemux", NULL);
    GstElement *audio = el("capsfilter", NULL), *asink = el("fakesink", NULL);
    g_object_set(fsrc, "location", h264, NULL);
    GstCaps *c = gst_caps_new_simple("video/x-h264", "framerate", GST_TYPE_FRACTION, 15, 1, NULL);
    g_object_set(fcaps, "caps", c, NULL);
    gst_caps_unref(c);
    g_object_set(pace, "sync", TRUE, NULL);
    g_object_set(pay, "pt", TV_PT_H264, "ssrc", 8836, "mtu", 600, NULL);
    g_object_set(asink, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add_many(GST_BIN(p), fsrc, fcaps, parse, pace, pay, demux, audio, asink, NULL);
    CHECK(gst_element_link_many(fsrc, fcaps, parse, pace, pay, demux, NULL));
    CHECK(gst_element_link(audio, asink));
    g_tm.rx_audio_caps = audio;
    g_tm.pipeline = p;
    g_signal_connect(demux, "pad-added", G_CALLBACK(on_rtpptdemux_new_pt), &g_tm);
    GstPad *pp = gst_element_get_static_pad(pay, "src");
    gst_pad_add_probe(pp, GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, far_side_probe, NULL, NULL);
    gst_object_unref(pp);
    pp = gst_element_get_static_pad(asink, "sink");
    gst_pad_add_probe(pp, GST_PAD_PROBE_TYPE_BUFFER, count_other, NULL, NULL);
    gst_object_unref(pp);

    gchar *shm = g_build_filename(dir, "teams-video.sock", NULL);
    g_setenv("TEAMS_MEDIA_VIDEO_SHM", shm, TRUE);
    CHECK(tm_video_rx_build(&g_tm, p));
    GstElement *vpay = NULL, *rtcp = NULL, *vsink = el("fakesink", NULL);
    CHECK(tm_video_tx_build(&g_tm, p, &vpay, &rtcp));
    g_object_set(vsink, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add(GST_BIN(p), vsink);
    CHECK(gst_element_link(vpay, vsink));
    rtcp_sink(p, rtcp);
    g_tm.vtimer = g_timeout_source_new(TM_VTICK_MS);
    g_source_set_callback(g_tm.vtimer, tm_video_tick, &g_tm, NULL);
    g_source_attach(g_tm.vtimer, g_tm.ctx);

    CHECK(gst_element_set_state(p, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);
    CHECK(wait_for(has_vshm, 10000));
    GstElement *reader = shm_reader(shm, TM_VIDEO_W, TM_VIDEO_H);
    gst_element_set_state(reader, GST_STATE_PLAYING);

    /* The far side's sender report about its video: our next receiver report quotes it. */
    static const guint8 sr[28] = { 0x80, 200, 0, 6, 0, 0, 0x22, 0x84, 0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44 };
    GstBuffer *srb = gst_buffer_new_memdup(sr, sizeof sr);
    tm_read_rtcp(&g_tm, srb);
    gst_buffer_unref(srb);

    wait_for(rx_done, 15000);
    gchar *vshm = event_with("VSHM ");
    gchar *want = g_strdup_printf("VSHM %s 640 480", shm);
    CHECK(vshm && !g_strcmp0(vshm, want));
    g_free(vshm); g_free(want);
    CHECK(events_with("VSHM ") == 1);
    CHECK(g_atomic_int_get(&shm_frames) >= 20);
    CHECK(g_atomic_int_get(&shm_bad_size) == 0);
    CHECK(g_atomic_int_get(&far_dropped) == 1);
    CHECK(g_atomic_int_get(&demux_other) == 0);            /* no video reached the audio chain */
    CHECK((guint32)g_atomic_int_get(&g_tm.peer_vssrc) == 8836);
    g_mutex_lock(&rtcp_lock);
    CHECK(rtcp_rr > 0 && rtcp_remb > 0 && rtcp_pli > 0 && rtcp_rr_lsr > 0);
    int pli = rtcp_pli;
    g_mutex_unlock(&rtcp_lock);
    CHECK(pli == g_atomic_int_get(&g_tm.stats.v_pli_sent));
    CHECK(events_with("PEERVIDEO 1") == 1);
    g_print("rx: %d frames on shm, %d PLI, events ok\n", g_atomic_int_get(&shm_frames), pli);

    /* The 4 s fixture ends: 2 s later the far side's video counts as stopped. */
    CHECK(wait_for(peer_gone, 10000));
    CHECK(events_with("PEERVIDEO 0") == 1);

    gst_element_set_state(reader, GST_STATE_NULL);
    gst_object_unref(reader);
    teardown(p);
    g_free(shm);
}

/* Packets keep coming but none decode (the keyframe was lost): the PLI is repeated on our own
 * rule (tv_keyframe_overdue), not only when the decoder side asks, which is switched off here. */
static GstPadProbeReturn drop_keyunit_requests(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    GstEvent *ev = GST_PAD_PROBE_INFO_EVENT(info);
    (void)pad; (void)u;
    return GST_EVENT_TYPE(ev) == GST_EVENT_CUSTOM_UPSTREAM && gst_event_has_name(ev, "GstForceKeyUnit")
               ? GST_PAD_PROBE_DROP : GST_PAD_PROBE_OK;
}

/* The first NAL unit of a type in an Annex-B file, without its start code. */
static GBytes *first_nal(const char *path, guint type)
{
    gchar *d = NULL;
    gsize n = 0;
    if (!g_file_get_contents(path, &d, &n, NULL)) return NULL;
    const guint8 *b = (const guint8 *)d;
    GBytes *r = NULL;
    for (gsize i = 0; i + 3 < n && !r; i++) {
        if (b[i] || b[i + 1] || b[i + 2] != 1 || (b[i + 3] & 0x1f) != type) continue;
        gsize s0 = i + 3, e = s0 + 1;
        while (e + 2 < n && !(b[e] == 0 && b[e + 1] == 0 && (b[e + 2] == 1 || (b[e + 2] == 0 && e + 3 < n && b[e + 3] == 1))))
            e++;
        if (e + 2 >= n) e = n;
        r = g_bytes_new(b + s0, e - s0);
    }
    g_free(d);
    return r;
}

static void push_rtp(GstElement *src, guint16 seq, guint32 ts, gboolean marker, const guint8 *nal, gsize len)
{
    guint8 *pk = g_malloc(12 + len);
    const guint8 hdr[12] = { 0x80, (guint8)((marker ? 0x80 : 0) | TV_PT_H264), (guint8)(seq >> 8), (guint8)seq,
                             (guint8)(ts >> 24), (guint8)(ts >> 16), (guint8)(ts >> 8), (guint8)ts,
                             0, 0, 0x22, 0x84 };
    memcpy(pk, hdr, 12);
    memcpy(pk + 12, nal, len);
    GstFlowReturn fr;
    GstBuffer *b = gst_buffer_new_wrapped(pk, 12 + len);
    g_signal_emit_by_name(src, "push-buffer", b, &fr);
    gst_buffer_unref(b);
}

static void test_rx_nokey(const char *h264)
{
    setup();
    GstElement *p = gst_pipeline_new("rx-nokey");
    GstElement *src = el("appsrc", NULL), *demux = el("rtpptdemux", NULL);
    GstElement *audio = el("capsfilter", NULL), *asink = el("fakesink", NULL);
    GstCaps *c = gst_caps_new_simple("application/x-rtp", "media", G_TYPE_STRING, "video",
                                     "clock-rate", G_TYPE_INT, 90000, NULL);
    g_object_set(src, "caps", c, "format", GST_FORMAT_TIME, "is-live", TRUE, "do-timestamp", TRUE, NULL);
    gst_caps_unref(c);
    g_object_set(asink, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add_many(GST_BIN(p), src, demux, audio, asink, NULL);
    CHECK(gst_element_link(src, demux));
    CHECK(gst_element_link(audio, asink));
    g_tm.rx_audio_caps = audio;
    g_tm.pipeline = p;
    g_signal_connect(demux, "pad-added", G_CALLBACK(on_rtpptdemux_new_pt), &g_tm);
    CHECK(tm_video_rx_build(&g_tm, p));
    GstElement *depay = gst_bin_get_by_name(GST_BIN(p), "rxv-depay");
    CHECK(depay != NULL);
    if (depay) {
        /* h264parse and avdec_h264 also ask upstream for a keyframe while they see no IDR, and on a
         * call those requests become PLIs too; stop them here so only our own rule is left. */
        g_object_set(depay, "request-keyframe", FALSE, NULL);
        GstPad *dp = gst_element_get_static_pad(depay, "src");
        gst_pad_add_probe(dp, GST_PAD_PROBE_TYPE_EVENT_UPSTREAM, drop_keyunit_requests, NULL, NULL);
        gst_object_unref(dp);
        gst_object_unref(depay);
    }
    GstElement *vpay = NULL, *rtcp = NULL, *vsink = el("fakesink", NULL);
    CHECK(tm_video_tx_build(&g_tm, p, &vpay, &rtcp));
    g_object_set(vsink, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add(GST_BIN(p), vsink);
    CHECK(gst_element_link(vpay, vsink));
    rtcp_sink(p, rtcp);
    g_tm.vtimer = g_timeout_source_new(TM_VTICK_MS);
    g_source_set_callback(g_tm.vtimer, tm_video_tick, &g_tm, NULL);
    g_source_attach(g_tm.vtimer, g_tm.ctx);
    CHECK(gst_element_set_state(p, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);

    /* The stream's SPS and PPS arrive, its IDR is lost, then 3 s of P-slices (NAL type 1) at 30 fps. */
    GBytes *sps = first_nal(h264, 7), *pps = first_nal(h264, 8);
    CHECK(sps && pps);
    if (sps && pps) {
        gsize l;
        const guint8 *d = g_bytes_get_data(sps, &l);
        push_rtp(src, 0, 0, FALSE, d, l);
        d = g_bytes_get_data(pps, &l);
        push_rtp(src, 1, 0, FALSE, d, l);
    }
    if (sps) g_bytes_unref(sps);
    if (pps) g_bytes_unref(pps);
    for (guint16 i = 0; i < 90; i++) {
        guint8 slice[24] = { 0x41 };
        for (guint j = 1; j < sizeof slice; j++) slice[j] = (guint8)(i * 7 + j);
        push_rtp(src, (guint16)(i + 2), (guint32)(i + 1) * 3000u, TRUE, slice, sizeof slice);
        while (g_main_context_iteration(g_tm.ctx, FALSE)) {}
        g_usleep(33000);
    }
    while (g_main_context_iteration(g_tm.ctx, FALSE)) {}
    g_mutex_lock(&rtcp_lock);
    int pli = rtcp_pli;
    g_mutex_unlock(&rtcp_lock);
    CHECK((guint32)g_atomic_int_get(&g_tm.peer_vssrc) == 8836);
    CHECK(g_atomic_int_get(&g_tm.stats.v_decoded) == 0);
    CHECK(pli >= 3);                                    /* about 1.0, 1.5, 2.0, 2.5 s */
    CHECK(events_with("PEERVIDEO 1") == 0);
    g_print("rx without keyframe: %d PLI in 3 s, nothing decoded\n", pli);
    teardown(p);
}

static void reset_rtcp_counts(void)
{
    g_mutex_lock(&rtcp_lock);
    rtcp_rr = rtcp_remb = rtcp_pli = rtcp_rr_lsr = 0;
    g_mutex_unlock(&rtcp_lock);
}

/* ------------------------------------------------------------------ tx ---------------------- */

static gint tx_pkts, tx_bad, tx_keyunit;

static GstPadProbeReturn count_tx(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info);
    GstMapInfo m;
    TvRtp r;
    if (b && gst_buffer_map(b, &m, GST_MAP_READ)) {
        if (tv_rtp_parse(m.data, m.size, &r) == 0 && r.pt == TV_PT_H264 && r.ssrc == 4242) g_atomic_int_inc(&tx_pkts);
        else g_atomic_int_inc(&tx_bad);
        gst_buffer_unmap(b, &m);
    }
    return GST_PAD_PROBE_OK;
}

/* Upstream force-key-unit events reaching the camera head's output. */
static GstPadProbeReturn count_keyunit(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    GstEvent *ev = GST_PAD_PROBE_INFO_EVENT(info);
    if (ev && GST_EVENT_TYPE(ev) == GST_EVENT_CUSTOM_UPSTREAM && gst_event_has_name(ev, "GstForceKeyUnit"))
        g_atomic_int_inc(&tx_keyunit);
    return GST_PAD_PROBE_OK;
}

static gboolean tx_flowing(void) { return g_atomic_int_get(&tx_pkts) >= 30 && events_with("VPREVIEW ") > 0; }
static gboolean keyunit_seen(void) { return g_atomic_int_get(&tx_keyunit) > 0; }

static void test_tx(const char *h264, const char *dir)
{
    setup();
    gchar *pv = g_build_filename(dir, "teams-preview.sock", NULL);
    g_setenv("TEAMS_MEDIA_PREVIEW_SHM", pv, TRUE);
    gchar *cam = g_strdup_printf(
        "filesrc location=%s ! video/x-h264,framerate=15/1 ! h264parse ! "
        "video/x-h264,stream-format=byte-stream,alignment=au ! identity sync=true ! queue name=tmvout "
        "videotestsrc is-live=true ! video/x-raw,format=I420,width=320,height=240 ! queue ! shmsink name=tmpvshm",
        h264);
    g_setenv("TEAMS_MEDIA_CAMERA", cam, TRUE);
    g_setenv("TEAMS_MEDIA_VIDEO_ROTATION", "3", TRUE);

    GstElement *p = gst_pipeline_new("tx");
    GstElement *vpay = NULL, *rtcp = NULL, *vsink = el("fakesink", NULL);
    CHECK(tm_video_tx_build(&g_tm, p, &vpay, &rtcp));
    g_object_set(vsink, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add(GST_BIN(p), vsink);
    CHECK(gst_element_link(vpay, vsink));
    rtcp_sink(p, rtcp);
    GstPad *sp = gst_element_get_static_pad(vsink, "sink");
    gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_BUFFER, count_tx, NULL, NULL);
    gst_object_unref(sp);
    sp = gst_element_get_static_pad(g_tm.vtx_queue, "sink");
    gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_EVENT_UPSTREAM, count_keyunit, NULL, NULL);
    gst_object_unref(sp);
    g_tm.pipeline = p;
    g_tm.vtimer = g_timeout_source_new(TM_VTICK_MS);
    g_source_set_callback(g_tm.vtimer, tm_video_tick, &g_tm, NULL);
    g_source_attach(g_tm.vtimer, g_tm.ctx);
    CHECK(gst_element_set_state(p, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);

    /* Nothing is sent before the camera is on. */
    wait_for(keyunit_seen, 300);
    CHECK(g_atomic_int_get(&tx_pkts) == 0);

    for (int round = 1; round <= 2; round++) {
        g_atomic_int_set(&tx_pkts, 0);
        g_atomic_int_set(&tx_keyunit, 0);
        g_mutex_lock(&ev_lock);
        g_ptr_array_set_size(events, 0);
        g_mutex_unlock(&ev_lock);
        tm_set_video(&g_tm, TRUE);
        CHECK(wait_for(tx_flowing, 10000));
        CHECK(events_with("VTX 1") == 1);
        gchar *ev = event_with("VPREVIEW ");
        gchar *want = g_strdup_printf("VPREVIEW %s 320 240 1 0", pv);   /* 3 clockwise = 1 back */
        CHECK(ev && !g_strcmp0(ev, want));
        g_free(ev); g_free(want);
        CHECK(g_atomic_int_get(&tx_bad) == 0);

        /* The far side asks for a keyframe: it reaches the camera head. */
        guint8 pli[12];
        tv_rtcp_build_pli(8836, 4242, pli);
        GstBuffer *b = gst_buffer_new_memdup(pli, sizeof pli);
        tm_read_rtcp(&g_tm, b);
        gst_buffer_unref(b);
        CHECK(wait_for(keyunit_seen, 2000));

        tm_set_video(&g_tm, FALSE);
        while (g_main_context_iteration(g_tm.ctx, FALSE)) {}
        CHECK(g_tm.vtx_head == NULL);
        CHECK(events_with("VTX 0") == 1);
        g_print("tx round %d: camera on, self-view, %d packets, keyframe request, camera off\n",
                round, g_atomic_int_get(&tx_pkts));
    }
    CHECK(g_atomic_int_get(&g_tm.stats.v_key_asked) == 2);
    /* No far-side video: no receiver reports or REMB about anyone. */
    g_mutex_lock(&rtcp_lock);
    CHECK(rtcp_rr == 0 && rtcp_remb == 0 && rtcp_pli == 0);
    g_mutex_unlock(&rtcp_lock);

    teardown(p);
    g_unsetenv("TEAMS_MEDIA_CAMERA");
    g_free(cam);
    g_free(pv);
}

/* ------------------------------------------------------------------ srtp funnel -------------- */

static gint dec_audio, dec_video, dec_rtcp;

static GstPadProbeReturn count_dec_rtp(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info);
    GstMapInfo m;
    TvRtp r;
    if (b && gst_buffer_map(b, &m, GST_MAP_READ)) {
        if (tv_rtp_parse(m.data, m.size, &r) == 0) {
            if (r.pt == TM_DEFAULT_PT && r.ssrc == 1111) g_atomic_int_inc(&dec_audio);
            if (r.pt == TV_PT_H264 && r.ssrc == 4242) g_atomic_int_inc(&dec_video);
        }
        gst_buffer_unmap(b, &m);
    }
    return GST_PAD_PROBE_OK;
}

static GstPadProbeReturn count_dec_rtcp(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info);
    GstMapInfo m;
    if (b && gst_buffer_map(b, &m, GST_MAP_READ)) {
        if (tv_rtcp_wants_keyframe(m.data, m.size, 8836) == 1) g_atomic_int_inc(&dec_rtcp);
        gst_buffer_unmap(b, &m);
    }
    return GST_PAD_PROBE_OK;
}

/* srtpenc puts its key in its output caps; strip it, so srtpdec asks for it as on a call (the
 * engine's loopback does the same, outside what this test includes). */
static GstPadProbeReturn strip_key(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    GstEvent *ev = GST_PAD_PROBE_INFO_EVENT(info);
    (void)pad; (void)user;
    if (GST_EVENT_TYPE(ev) == GST_EVENT_CAPS) {
        GstCaps *caps;
        gst_event_parse_caps(ev, &caps);
        /* The funnel's switch to the RTCP stream; srtpdec finds RTCP on rtp_sink by itself. */
        if (gst_structure_has_name(gst_caps_get_structure(caps, 0), "application/x-srtcp"))
            return GST_PAD_PROBE_DROP;
        caps = gst_caps_copy(caps);
        gst_structure_remove_fields(gst_caps_get_structure(caps, 0), "srtp-key", "srtp-cipher", "srtp-auth",
                                    "srtcp-cipher", "srtcp-auth", "mki", NULL);
        gst_event_unref(ev);
        GST_PAD_PROBE_INFO_DATA(info) = gst_event_new_caps(caps);
        gst_caps_unref(caps);
    }
    return GST_PAD_PROBE_OK;
}

/* Answer caps queries from the funnel side as nicesink does (ANY), so srtpenc's rtcp_sink is not
 * constrained by srtpdec's x-srtp-only rtp_sink behind the funnel. */
static GstPadProbeReturn caps_like_nicesink(GstPad *pad, GstPadProbeInfo *info, gpointer user)
{
    GstQuery *q = GST_PAD_PROBE_INFO_QUERY(info);
    (void)pad; (void)user;
    if (GST_QUERY_TYPE(q) == GST_QUERY_CAPS) {
        GstCaps *any = gst_caps_new_any();
        gst_query_set_caps_result(q, any);
        gst_caps_unref(any);
        return GST_PAD_PROBE_HANDLED;
    }
    if (GST_QUERY_TYPE(q) == GST_QUERY_ACCEPT_CAPS) {
        gst_query_set_accept_caps_result(q, TRUE);
        return GST_PAD_PROBE_HANDLED;
    }
    return GST_PAD_PROBE_OK;
}

static GstBuffer *rtp_packet(guint8 pt, guint32 ssrc, guint16 seq)
{
    guint8 p[20] = { 0x80, pt, (guint8)(seq >> 8), (guint8)seq, 0, 0, 0, 0,
                     (guint8)(ssrc >> 24), (guint8)(ssrc >> 16), (guint8)(ssrc >> 8), (guint8)ssrc,
                     1, 2, 3, 4, 5, 6, 7, 8 };
    return gst_buffer_new_memdup(p, sizeof p);
}

static gboolean all_decrypted(void)
{
    return g_atomic_int_get(&dec_audio) == 5 && g_atomic_int_get(&dec_video) == 5 && g_atomic_int_get(&dec_rtcp) == 1;
}

/* What leaves for nicesink: our audio, our video and our RTCP, each its own srtpenc stream into
 * one funnel, all of it decrypted with our key by the far side. */
static void test_srtp_funnel(void)
{
    setup();
    guchar k[TM_GCM_MASTER_SIZE];
    for (int i = 0; i < TM_GCM_MASTER_SIZE; i++) k[i] = (guchar)(3 * i + 1);
    GstBuffer *master = master_buffer_from_bytes(k, TM_GCM_MASTER_SIZE);
    g_tm.rx_master = gst_buffer_ref(master);

    GstElement *p = gst_pipeline_new("funnel");
    GstElement *a = el("appsrc", NULL), *v = el("appsrc", NULL), *rtcp = el("appsrc", NULL);
    GstElement *senc = el("srtpenc", NULL), *funnel = el("funnel", NULL), *q = el("queue", NULL);
    GstElement *sdec = el("srtpdec", NULL), *rtpsink = el("fakesink", NULL), *rtcpsink = el("fakesink", NULL);
    GstCaps *c = gst_caps_new_empty_simple("application/x-rtp");
    g_object_set(a, "caps", c, "format", GST_FORMAT_TIME, NULL);
    g_object_set(v, "caps", c, "format", GST_FORMAT_TIME, NULL);
    gst_caps_unref(c);
    c = gst_caps_new_empty_simple("application/x-rtcp");
    g_object_set(rtcp, "caps", c, "format", GST_FORMAT_TIME, NULL);
    gst_caps_unref(c);
    configure_srtpenc(senc, master);
    g_signal_connect(sdec, "request-key", G_CALLBACK(on_srtpdec_request_key), &g_tm);
    g_object_set(rtpsink, "sync", FALSE, "async", FALSE, NULL);
    g_object_set(rtcpsink, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add_many(GST_BIN(p), a, v, rtcp, senc, funnel, q, sdec, rtpsink, rtcpsink, NULL);
    CHECK(tm_link_srtp_stream(a, senc, "rtp", funnel));
    CHECK(tm_link_srtp_stream(v, senc, "rtp", funnel));
    CHECK(tm_link_srtp_stream(rtcp, senc, "rtcp", funnel));
    CHECK(gst_element_link_many(funnel, q, sdec, NULL));
    CHECK(gst_element_link_pads(sdec, "rtp_src", rtpsink, "sink"));
    CHECK(gst_element_link_pads(sdec, "rtcp_src", rtcpsink, "sink"));
    /* srtpenc puts its key in the caps; strip it, so srtpdec asks for it as on a call */
    GstPad *sp = gst_element_get_static_pad(sdec, "rtp_sink");
    gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM, strip_key, NULL, NULL);
    gst_object_unref(sp);
    sp = gst_element_get_static_pad(q, "sink");
    gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_QUERY_DOWNSTREAM, caps_like_nicesink, NULL, NULL);
    gst_object_unref(sp);
    sp = gst_element_get_static_pad(rtpsink, "sink");
    gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_BUFFER, count_dec_rtp, NULL, NULL);
    gst_object_unref(sp);
    sp = gst_element_get_static_pad(rtcpsink, "sink");
    gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_BUFFER, count_dec_rtcp, NULL, NULL);
    gst_object_unref(sp);
    CHECK(gst_element_set_state(p, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);

    GstFlowReturn fr;
    for (guint16 i = 0; i < 5; i++) {
        GstBuffer *ab = rtp_packet(TM_DEFAULT_PT, 1111, i), *vb = rtp_packet(TV_PT_H264, 4242, i);
        g_signal_emit_by_name(a, "push-buffer", ab, &fr);       /* the signal takes its own ref */
        g_signal_emit_by_name(v, "push-buffer", vb, &fr);
        gst_buffer_unref(ab);
        gst_buffer_unref(vb);
    }
    /* What tm_video_tick sends: a receiver report, then the PLI. */
    guint8 comp[32 + 12];
    TvRxStats st;
    memset(&st, 0, sizeof st);
    tv_rx_stats_update(&st, 8836, 1);
    gsize n = tv_rtcp_build_rr(&st, 4242, 0, 0, comp);
    n += tv_rtcp_build_pli(4242, 8836, comp + n);
    g_tm.rtcp_out = rtcp;
    tm_push_rtcp(&g_tm, comp, n);
    g_tm.rtcp_out = NULL;
    CHECK(wait_for(all_decrypted, 5000));
    CHECK(g_atomic_int_get(&dec_audio) == 5 && g_atomic_int_get(&dec_video) == 5);
    CHECK(g_atomic_int_get(&dec_rtcp) == 1);
    g_print("srtp funnel: audio %d, video %d, rtcp %d decrypted\n", g_atomic_int_get(&dec_audio),
            g_atomic_int_get(&dec_video), g_atomic_int_get(&dec_rtcp));
    set_rx_master(&g_tm, NULL);
    gst_buffer_unref(master);
    teardown(p);
}

/* Our shmsinks answer no allocation query (else the decoder fills the shm area and the receive
 * chain blocks); a plain shmsink offers its allocator (the control). */
static guint allocation_params(GstElement *shm)
{
    GstPad *sp = gst_element_get_static_pad(shm, "sink");
    GstCaps *c = tm_i420_caps(64, 64);
    GstQuery *q = gst_query_new_allocation(c, TRUE);
    gst_pad_query(sp, q);
    guint n = gst_query_get_n_allocation_params(q) + gst_query_get_n_allocation_pools(q);
    gst_query_unref(q);
    gst_caps_unref(c);
    gst_object_unref(sp);
    return n;
}

static void test_shm_allocation(const char *dir)
{
    GstElement *p = gst_pipeline_new("shm");
    GstElement *plain = el("shmsink", NULL), *ours = el("shmsink", NULL);
    gchar *a = g_build_filename(dir, "alloc-a.sock", NULL), *b = g_build_filename(dir, "alloc-b.sock", NULL);
    g_object_set(plain, "socket-path", a, "shm-size", (guint)TM_SHM_SIZE, "wait-for-connection", FALSE, NULL);
    tm_configure_shm(NULL, ours, b);
    gst_bin_add_many(GST_BIN(p), plain, ours, NULL);
    CHECK(gst_element_set_state(p, GST_STATE_PAUSED) != GST_STATE_CHANGE_FAILURE);
    guint np = allocation_params(plain), no = allocation_params(ours);
    CHECK(np > 0);
    CHECK(no == 0);
    g_print("shm allocation: plain shmsink offers %u, ours %u\n", np, no);
    gst_element_set_state(p, GST_STATE_NULL);
    gst_object_unref(p);
    g_free(a); g_free(b);
}

/* The camera head sends the size and bitrate VIDEO asked for, the defaults otherwise. */
static void test_camera_size(void)
{
    TeamsMedia tm;
    gboolean m;
    memset(&tm, 0, sizeof tm);
    g_unsetenv("TEAMS_MEDIA_CAMERA");
    gchar *d = tm_camera_description(&tm, &m);
    CHECK(strstr(d, "target-bitrate=800000 ") && strstr(d, "vidsrc ! video/x-h264,width=640,height=480 "));
    g_free(d);
    tm.vtx_w = 176; tm.vtx_h = 144; tm.vtx_kbps = 208;
    d = tm_camera_description(&tm, &m);
    CHECK(strstr(d, "target-bitrate=208000 ") && strstr(d, "vidsrc ! video/x-h264,width=176,height=144 "));
    CHECK(strstr(d, "vfsrc ! video/x-raw,format=NV21,width=640,height=480,"));   /* the viewfinder stays */
    g_free(d);
}

/* VIDEO without video support only says so. */
static void test_unavailable(void)
{
    setup();
    g_tm.video = FALSE;
    tm_set_video(&g_tm, TRUE);
    CHECK(events_with("VIDEOERR unavailable") == 1);
    CHECK(!g_tm.vtx_wanted);
    g_main_context_unref(g_tm.ctx);
    g_tm.ctx = NULL;
    g_mutex_clear(&g_tm.key_lock);
    g_mutex_clear(&g_tm.vlock);
}

/* ------------------------------------------------------------------ ICE thread --------------- */

static GMutex blk_lock;
static GCond  blk_cond;
static gboolean blk_entered, blk_release;
static gint ice_ran;

/* Stands in for a media-thread callback stuck in a push (the camera's start-capture). */
static gboolean block_media_loop(gpointer user)
{
    (void)user;
    g_mutex_lock(&blk_lock);
    blk_entered = TRUE;
    g_cond_broadcast(&blk_cond);
    while (!blk_release) g_cond_wait(&blk_cond, &blk_lock);
    g_mutex_unlock(&blk_lock);
    return G_SOURCE_REMOVE;
}

static gboolean mark_ice_ran(gpointer user)
{
    (void)user;
    g_atomic_int_set(&ice_ran, 1);
    return G_SOURCE_REMOVE;
}

/* The ICE agent's context keeps running while the media loop is stuck: nicesink's "writable"
 * notice, ICE checks and keepalives must not wait on a media-thread callback (the 5 Nov deadlock
 * of every call we placed: start-capture blocked on nicesink, nicesink waited for the loop). */
static void test_ice_own_thread(void)
{
    gchar *uf = NULL, *pw = NULL, *txk = NULL;
    GMainContext *actx = NULL;   /* "main-context" is a plain pointer property: no reference taken */

    CHECK(tm_start(1, NULL, NULL, NULL, 0, NULL, NULL, NULL, &uf, &pw, &txk) == 0);
    CHECK(g_tm.agent != NULL);
    if (g_tm.agent) g_object_get(g_tm.agent, "main-context", &actx, NULL);
    CHECK(actx != NULL && actx != g_tm.ctx);

    blk_entered = blk_release = FALSE;
    g_atomic_int_set(&ice_ran, 0);
    GSource *s = g_idle_source_new();
    g_source_set_callback(s, block_media_loop, NULL, NULL);
    g_source_attach(s, g_tm.ctx);
    g_source_unref(s);
    g_mutex_lock(&blk_lock);
    gint64 end = g_get_monotonic_time() + 2 * G_TIME_SPAN_SECOND;
    while (!blk_entered && g_cond_wait_until(&blk_cond, &blk_lock, end)) {}
    gboolean blocked = blk_entered;
    g_mutex_unlock(&blk_lock);
    CHECK(blocked);

    if (actx) {
        s = g_timeout_source_new(10);
        g_source_set_callback(s, mark_ice_ran, NULL, NULL);
        g_source_attach(s, actx);
        g_source_unref(s);
    }
    end = g_get_monotonic_time() + 2 * G_TIME_SPAN_SECOND;
    while (!g_atomic_int_get(&ice_ran) && g_get_monotonic_time() < end) g_usleep(10000);
    CHECK(g_atomic_int_get(&ice_ran));

    g_mutex_lock(&blk_lock);
    blk_release = TRUE;
    g_cond_broadcast(&blk_cond);
    g_mutex_unlock(&blk_lock);
    tm_stop();
    CHECK(g_tm.agent == NULL && g_tm.nice_thread == NULL);
    g_free(uf); g_free(pw); g_free(txk);
}

/* ------------------------------------------------------------------ caller's srflx ----------- */

/* A STUN server on loopback that answers every Binding request with a fixed mapped address, the
 * way Teams' relay tells us our address behind the NAT. */
#define FAKE_MAPPED_IP   "203.0.113.7"
#define FAKE_MAPPED_PORT 4242

static int stun_fd = -1;
static gint stun_answered, stun_stop;
static GMutex cand_lock;
static GPtrArray *cands;

static gpointer stun_server(gpointer user)
{
    (void)user;
    StunAgent agent;
    stun_agent_init(&agent, STUN_ALL_KNOWN_ATTRIBUTES, STUN_COMPATIBILITY_RFC5389, 0);
    while (!g_atomic_int_get(&stun_stop)) {
        struct pollfd pfd = { .fd = stun_fd, .events = POLLIN };
        if (poll(&pfd, 1, 50) <= 0) continue;
        uint8_t in[1500], out[1500];
        struct sockaddr_storage from;
        socklen_t flen = sizeof from;
        ssize_t n = recvfrom(stun_fd, in, sizeof in, 0, (struct sockaddr *)&from, &flen);
        if (n <= 0) continue;
        StunMessage req, resp;
        if (stun_agent_validate(&agent, &req, in, (size_t)n, NULL, NULL) != STUN_VALIDATION_SUCCESS ||
            stun_message_get_class(&req) != STUN_REQUEST || stun_message_get_method(&req) != STUN_BINDING)
            continue;
        struct sockaddr_in mapped = { .sin_family = AF_INET, .sin_port = htons(FAKE_MAPPED_PORT) };
        inet_pton(AF_INET, FAKE_MAPPED_IP, &mapped.sin_addr);
        if (!stun_agent_init_response(&agent, &resp, out, sizeof out, &req)) continue;
        if (stun_message_append_xor_addr(&resp, STUN_ATTRIBUTE_XOR_MAPPED_ADDRESS,
                                         (struct sockaddr_storage *)&mapped, sizeof mapped) != STUN_MESSAGE_RETURN_SUCCESS)
            continue;
        size_t len = stun_agent_finish_message(&agent, &resp, NULL, 0);
        if (len && sendto(stun_fd, out, len, 0, (struct sockaddr *)&from, flen) == (ssize_t)len)
            g_atomic_int_inc(&stun_answered);
    }
    return NULL;
}

static void on_cand(const char *c)
{
    g_mutex_lock(&cand_lock);
    g_ptr_array_add(cands, g_strdup(c));
    g_mutex_unlock(&cand_lock);
}

static gboolean have_fake_srflx(void)
{
    gboolean r = FALSE;
    g_mutex_lock(&cand_lock);
    for (guint i = 0; i < cands->len && !r; i++) {
        const char *c = g_ptr_array_index(cands, i);
        r = strstr(c, " typ srflx") && strstr(c, FAKE_MAPPED_IP " " G_STRINGIFY(FAKE_MAPPED_PORT));
    }
    g_mutex_unlock(&cand_lock);
    return r;
}

/* The caller (no pipeline before the answer) reads the STUN server's reply and offers the
 * server-reflexive candidate: without it the far side has no address of ours behind the NAT. */
static void test_caller_srflx(void)
{
    /* libnice sends from its host candidates, and Linux does not route those to 127.0.0.1: the
     * server listens on this machine's first IPv4 address that is not loopback. */
    struct sockaddr_in a = { .sin_family = AF_INET };
    socklen_t alen = sizeof a;
    gboolean have_ip = FALSE;
    struct ifaddrs *ifs = NULL;
    if (getifaddrs(&ifs) == 0) {
        for (struct ifaddrs *i = ifs; i && !have_ip; i = i->ifa_next)
            if (i->ifa_addr && i->ifa_addr->sa_family == AF_INET && (i->ifa_flags & IFF_UP) &&
                !(i->ifa_flags & IFF_LOOPBACK)) {
                a.sin_addr = ((struct sockaddr_in *)i->ifa_addr)->sin_addr;
                have_ip = TRUE;
            }
        freeifaddrs(ifs);
    }
    if (!have_ip) { fprintf(stderr, "SKIP test_caller_srflx: no IPv4 address that is not loopback\n"); return; }
    stun_fd = socket(AF_INET, SOCK_DGRAM, 0);
    CHECK(stun_fd >= 0);
    if (stun_fd < 0) return;
    CHECK(bind(stun_fd, (struct sockaddr *)&a, sizeof a) == 0);
    CHECK(getsockname(stun_fd, (struct sockaddr *)&a, &alen) == 0);
    inet_ntop(AF_INET, &a.sin_addr, g_stun_host, sizeof g_stun_host);
    g_stun_port = ntohs(a.sin_port);
    g_atomic_int_set(&stun_answered, 0);
    g_atomic_int_set(&stun_stop, 0);
    g_atomic_int_set(&gathered_calls, 0);
    cands = g_ptr_array_new_with_free_func(g_free);
    GThread *srv = g_thread_new("stun", stun_server, NULL);

    gchar *uf = NULL, *pw = NULL, *txk = NULL;
    CHECK(tm_start(1, NULL, NULL, NULL, 0, on_cand, NULL, NULL, &uf, &pw, &txk) == 0);
    CHECK(g_tm.pipeline == NULL);    /* the caller has no pipeline (no nicesrc) until the answer */
    gint64 end = g_get_monotonic_time() + 5 * G_TIME_SPAN_SECOND;
    while (!g_atomic_int_get(&gathered_calls) && g_get_monotonic_time() < end) g_usleep(10000);
    CHECK(g_atomic_int_get(&gathered_calls) == 1);
    CHECK(g_atomic_int_get(&stun_answered) > 0);
    CHECK(have_fake_srflx());

    tm_stop();
    g_atomic_int_set(&stun_stop, 1);
    g_thread_join(srv);
    close(stun_fd);
    stun_fd = -1;
    g_stun_host[0] = '\0';
    g_stun_port = 0;
    g_ptr_array_unref(cands);
    cands = NULL;
    g_free(uf); g_free(pw); g_free(txk);
}

int main(int argc, char **argv)
{
    (void)argc; (void)argv;
    gst_init(NULL, NULL);
    events = g_ptr_array_new_with_free_func(g_free);
    const char *h264 = g_getenv("TEAMS_TEST_H264"), *dir = g_getenv("TEAMS_TEST_DIR");
    if (!h264 || !dir) { fprintf(stderr, "TEAMS_TEST_H264 and TEAMS_TEST_DIR are needed\n"); return 2; }
    CHECK(tm_video_available());
    test_unavailable();
    test_ice_own_thread();
    test_caller_srflx();
    test_srtp_funnel();
    test_shm_allocation(dir);
    test_camera_size();
    test_rx(h264, dir);
    reset_rtcp_counts();            /* each test starts from clean RTCP counters */
    test_rx_nokey(h264);
    reset_rtcp_counts();
    test_tx(h264, dir);
    g_ptr_array_unref(events);
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    g_print("PASS test_video_pipeline\n");
    return 0;
}
