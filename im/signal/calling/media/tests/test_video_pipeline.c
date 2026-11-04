/*
 * Integration test of the engine's video paths, without ICE or audio devices: signal_media.c is
 * compiled in (SIGNAL_MEDIA_NO_MAIN) and its pieces are wired into test pipelines.
 *
 *   rx:     a VP8 file -> rtpvp8pay as the far side (SSRC 1003, CVO on the last packet of each
 *           frame, one packet lost) + its rtp-data SenderStatus + an Opus-PT packet -> srtpenc
 *           (offer key) -> srtpdec (the engine's request-key) -> the engine's split probe ->
 *           the engine's receive branch -> shm; a shmsrc reads the 640x480 I420 frames back.
 *   sender: the engine's rtp-data message and PLI, SRTP/SRTCP-protected with our key, decrypted
 *           by a srtpdec as the far side would.
 *   tx:     the engine's camera head (videotestsrc) in front of a stand-in tail: self-view frames
 *           on shm, VTX/VPREVIEW events, camera off and on again; the CVO and answer gate on our
 *           packets; the missing VP8 encoder reported.
 *
 * Needs SIGNAL_TEST_IVF (a VP8 IVF file) and SIGNAL_TEST_DIR (where the shm sockets go).
 */
#define SIGNAL_MEDIA_NO_MAIN
#include "../signal_media.c"

static int failures;
#define CHECK(c) do { if (!(c)) { failures++; g_printerr("FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); } } while (0)

/* ------------------------------------------------------------------ events ------------------ */

static GMutex   ev_lock;
static GPtrArray *events;

static void on_event(const char *line, void *user)
{
    (void)user;
    g_mutex_lock(&ev_lock);
    g_ptr_array_add(events, g_strdup(line));
    g_mutex_unlock(&ev_lock);
}

/* The first event starting with prefix, or NULL. */
static gchar *event_with(const char *prefix)
{
    gchar *found = NULL;
    g_mutex_lock(&ev_lock);
    for (guint i = 0; i < events->len && !found; i++)
        if (g_str_has_prefix(g_ptr_array_index(events, i), prefix))
            found = g_strdup(g_ptr_array_index(events, i));
    g_mutex_unlock(&ev_lock);
    return found;
}

static guint events_with(const char *prefix)
{
    guint n = 0;
    g_mutex_lock(&ev_lock);
    for (guint i = 0; i < events->len; i++)
        if (g_str_has_prefix(g_ptr_array_index(events, i), prefix))
            n++;
    g_mutex_unlock(&ev_lock);
    return n;
}

static void events_clear(void)
{
    g_mutex_lock(&ev_lock);
    g_ptr_array_set_size(events, 0);
    g_mutex_unlock(&ev_lock);
}

/* Spin the default context until cond() or timeout_ms. */
static gboolean wait_for(gboolean (*cond)(void), guint timeout_ms)
{
    gint64 end = g_get_monotonic_time() + (gint64)timeout_ms * 1000;
    while (!cond() && g_get_monotonic_time() < end) {
        g_main_context_iteration(NULL, FALSE);
        g_usleep(5000);
    }
    return cond();
}

static void test_keys(signal_srtp_keys *keys)
{
    unsigned char priv[32], remote_pub[32], cid[33], eid[33];
    for (int i = 0; i < 32; i++) priv[i] = (unsigned char)(i + 1);
    for (int i = 0; i < 32; i++) remote_pub[i] = (unsigned char)(0x40 + i);
    remote_pub[31] &= 0x7f;
    cid[0] = 0x05; memset(cid + 1, 0xAA, 32);
    eid[0] = 0x05; memset(eid + 1, 0xBB, 32);
    if (signal_negotiate_srtp_keys(priv, remote_pub, cid, 33, eid, 33, keys) != 0) {
        g_printerr("key derivation failed\n");
        exit(2);
    }
}

static GstElement *el(const char *factory, const char *name)
{
    GstElement *e = gst_element_factory_make(factory, name);
    if (!e) { g_printerr("missing element %s\n", factory); exit(3); }
    return e;
}

/* An RTP packet as a GstBuffer: 12-byte header then payload. */
static GstBuffer *rtp_buffer(guint8 pt, guint32 ssrc, guint16 seq, const guint8 *payload, gsize plen)
{
    GstBuffer *b = gst_buffer_new_allocate(NULL, 12 + plen, NULL);
    GstMapInfo m;
    gst_buffer_map(b, &m, GST_MAP_WRITE);
    m.data[0] = 0x80; m.data[1] = pt;
    m.data[2] = (guint8)(seq >> 8); m.data[3] = (guint8)seq;
    memset(m.data + 4, 0, 4);
    m.data[8] = (guint8)(ssrc >> 24); m.data[9] = (guint8)(ssrc >> 16);
    m.data[10] = (guint8)(ssrc >> 8); m.data[11] = (guint8)ssrc;
    if (plen) memcpy(m.data + 12, payload, plen);
    gst_buffer_unmap(b, &m);
    return b;
}

/* ------------------------------------------------------------------ rx ---------------------- */

static gint audio_pkts, video_in_audio, shm_frames, shm_bad_size, far_marker_pkts, far_dropped;

static GstPadProbeReturn count_audio(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info);
    GstMapInfo m;
    if (b && gst_buffer_map(b, &m, GST_MAP_READ)) {
        SvRtp r;
        if (sv_rtp_parse(m.data, m.size, &r) == 0) {
            if (r.pt == SV_PT_OPUS) g_atomic_int_inc(&audio_pkts);
            else g_atomic_int_inc(&video_in_audio);
        }
        gst_buffer_unmap(b, &m);
    }
    return GST_PAD_PROBE_OK;
}

static GstPadProbeReturn count_shm(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad;
    gsize want = GPOINTER_TO_SIZE(u);
    GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info);
    if (b && gst_buffer_get_size(b) == want) g_atomic_int_inc(&shm_frames);
    else g_atomic_int_inc(&shm_bad_size);
    return GST_PAD_PROBE_OK;
}

/* The far side's payloader output: CVO 1 on the last packet of each frame; the 3rd frame's last
 * packet is lost on the way. TRUE to keep b; *out is b, or b with the CVO added. */
static gint pli_before_loss = -1;

static gboolean far_side_packet(GstBuffer *b, GstBuffer **out)
{
    GstMapInfo m;
    *out = b;
    if (!gst_buffer_map(b, &m, GST_MAP_READ)) return TRUE;
    gboolean marker = m.size > 1 && (m.data[1] & 0x80);
    gst_buffer_unmap(b, &m);
    if (!marker) return TRUE;
    if (g_atomic_int_add(&far_marker_pkts, 1) == 2) {
        pli_before_loss = g_atomic_int_get(&g_v.pli_wanted);
        g_atomic_int_inc(&far_dropped);
        return FALSE;
    }
    g_atomic_int_set(&g_v.tx_cvo, 1);          /* sm_tx_add_cvo stands in for the far side's sender */
    *out = sm_tx_add_cvo(gst_buffer_ref(b));
    return TRUE;
}

static GstPadProbeReturn far_side_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad; (void)u;
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER) {
        GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info), *nb;
        if (!far_side_packet(b, &nb)) return GST_PAD_PROBE_DROP;
        if (nb != b) { gst_buffer_unref(b); GST_PAD_PROBE_INFO_DATA(info) = nb; }
        return GST_PAD_PROBE_OK;
    }
    GstBufferList *in = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
    GstBufferList *outl = gst_buffer_list_new();
    for (guint i = 0; i < gst_buffer_list_length(in); i++) {
        GstBuffer *b = gst_buffer_list_get(in, i), *nb;
        if (!far_side_packet(b, &nb)) continue;
        gst_buffer_list_add(outl, nb == b ? gst_buffer_ref(b) : nb);
    }
    gst_buffer_list_unref(in);
    GST_PAD_PROBE_INFO_DATA(info) = outl;
    return GST_PAD_PROBE_OK;
}

static gboolean has_vshm(void) { return events_with("VSHM ") > 0; }
static gboolean has_vpreview(void) { return events_with("VPREVIEW ") > 0; }

static gboolean rx_done(void)
{
    return g_atomic_int_get(&shm_frames) >= 20 && g_atomic_int_get(&g_v.pli_wanted);
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

static void test_rx(const char *ivf, const char *dir)
{
    memset(&g_sm, 0, sizeof g_sm);
    sm_video_reset();
    g_sm.is_caller = FALSE;
    test_keys(&g_sm.keys);
    g_sm.rx_master = master_key_buffer(g_sm.keys.offer_key, g_sm.keys.offer_salt);
    GstBuffer *far_master = master_key_buffer(g_sm.keys.offer_key, g_sm.keys.offer_salt);

    GstElement *p = gst_pipeline_new("rx");
    GstElement *fsrc = el("filesrc", NULL), *parse = el("ivfparse", NULL), *pay = el("rtpvp8pay", NULL);
    GstElement *pace = el("identity", NULL);    /* in real time, as a camera would send */
    GstElement *data = el("appsrc", "far-data"), *funnel = el("funnel", NULL), *senc = el("srtpenc", NULL);
    GstElement *sdec = el("srtpdec", NULL), *audio = el("fakesink", "audio"), *rtcp = el("fakesink", NULL);
    g_object_set(fsrc, "location", ivf, NULL);
    g_object_set(pace, "sync", TRUE, NULL);
    g_object_set(pay, "pt", SV_PT_VP8, "ssrc", sv_peer_video_ssrc(FALSE), "mtu", 400, NULL);
    GstCaps *rc = gst_caps_new_simple("application/x-rtp", NULL, NULL);
    g_object_set(data, "caps", rc, "format", GST_FORMAT_TIME, NULL);
    gst_caps_unref(rc);
    configure_srtpenc(senc, far_master);
    g_signal_connect(sdec, "request-key", G_CALLBACK(on_srtpdec_request_key), &g_sm);
    g_object_set(audio, "sync", FALSE, "async", FALSE, NULL);
    g_object_set(rtcp, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add_many(GST_BIN(p), fsrc, parse, pace, pay, data, funnel, senc, sdec, audio, rtcp, NULL);
    CHECK(gst_element_link_many(fsrc, parse, pace, pay, funnel, senc, sdec, audio, NULL));
    CHECK(gst_element_link(data, funnel));
    CHECK(gst_element_link_pads(sdec, "rtcp_src", rtcp, "sink"));

    GstPad *pp = gst_element_get_static_pad(pay, "src");
    gst_pad_add_probe(pp, GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, far_side_probe, NULL, NULL);
    gst_object_unref(pp);
    pp = gst_element_get_static_pad(sdec, "rtp_src");
    gst_pad_add_probe(pp, GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST, sm_rx_split_probe, NULL, NULL);
    gst_object_unref(pp);
    pp = gst_element_get_static_pad(audio, "sink");
    gst_pad_add_probe(pp, GST_PAD_PROBE_TYPE_BUFFER, count_audio, NULL, NULL);
    gst_object_unref(pp);

    gchar *shm = g_build_filename(dir, "video.sock", NULL);
    g_setenv("SIGNAL_MEDIA_VIDEO_SHM", shm, TRUE);
    CHECK(sm_video_rx_build(p));
    CHECK(g_v.rx_src != NULL);

    CHECK(gst_element_set_state(p, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);

    /* The far side's rtp-data: SenderStatus video on; and one Opus-PT packet. */
    SvDataMsg dm;
    sv_data_msg_init(&dm);
    dm.has_status = 1; dm.status_id = 42; dm.video_enabled = 1;
    dm.has_seqnum = 1; dm.seqnum = 1;
    guint8 body[32];
    gsize bn = sv_data_msg_encode(&dm, body, sizeof body);
    gst_app_src_push_buffer(GST_APP_SRC(data), rtp_buffer(SV_PT_DATA, SV_SSRC_DATA, 1, body, bn));
    static const guint8 opus[3] = { 0xf8, 0xff, 0xfe };
    gst_app_src_push_buffer(GST_APP_SRC(data), rtp_buffer(SV_PT_OPUS, 1002, 1, opus, sizeof opus));
    /* And an RTX packet (PT 118), which must go nowhere. */
    gst_app_src_push_buffer(GST_APP_SRC(data), rtp_buffer(SV_PT_VP8_RTX, 1013, 1, opus, sizeof opus));
    /* An rtp-data payload type on another SSRC is not RingRTC's data channel: no PEERVIDEO 0. */
    dm.video_enabled = 0;
    bn = sv_data_msg_encode(&dm, body, sizeof body);
    gst_app_src_push_buffer(GST_APP_SRC(data), rtp_buffer(SV_PT_DATA, 1002, 2, body, bn));

    /* The Phone app opens the socket once the engine says where it is. */
    CHECK(wait_for(has_vshm, 10000));
    GstElement *reader = shm_reader(shm, SM_VIDEO_W, SM_VIDEO_H);
    gst_element_set_state(reader, GST_STATE_PLAYING);
    wait_for(rx_done, 15000);

    gchar *vshm = event_with("VSHM ");
    gchar *want = g_strdup_printf("VSHM %s 640 480", shm);
    CHECK(vshm && !g_strcmp0(vshm, want));
    g_free(vshm); g_free(want);
    gchar *rot = event_with("PEERROT ");
    CHECK(rot && !g_strcmp0(rot, "PEERROT 3"));     /* CVO 1 = a quarter turn clockwise */
    g_free(rot);
    CHECK(events_with("PEERROT ") == 1);            /* said once, not per packet */
    gchar *pv = event_with("PEERVIDEO ");
    CHECK(pv && !g_strcmp0(pv, "PEERVIDEO 1"));
    g_free(pv);
    CHECK(events_with("PEERVIDEO ") == 1);
    CHECK(g_atomic_int_get(&shm_frames) >= 20);
    CHECK(g_atomic_int_get(&shm_bad_size) == 0);
    CHECK(g_atomic_int_get(&far_dropped) == 1);
    CHECK(pli_before_loss == 0);                     /* nothing asked before the loss... */
    CHECK(g_atomic_int_get(&g_v.pli_wanted) == 1);   /* ...the loss made the depayloader ask */
    CHECK(g_atomic_int_get(&audio_pkts) == 1);       /* the Opus packet reached the audio chain */
    CHECK(g_atomic_int_get(&video_in_audio) == 0);   /* nothing else did */
    g_print("rx: %d frames on shm, events ok\n", g_atomic_int_get(&shm_frames));

    gst_element_set_state(reader, GST_STATE_NULL);
    gst_object_unref(reader);
    gst_element_set_state(p, GST_STATE_NULL);
    gst_object_unref(p);
    g_v.rx_src = NULL;
    gst_buffer_unref(far_master);
    gst_buffer_unref(g_sm.rx_master);
    g_sm.rx_master = NULL;
    g_unsetenv("SIGNAL_MEDIA_VIDEO_SHM");
    g_free(shm);
}

/* ------------------------------------------------------------------ sender ------------------ */

static GstBuffer *got_rtp, *got_rtcp;

static GstPadProbeReturn take_rtp(GstPad *pad, GstPadProbeInfo *info, gpointer u)
{
    (void)pad;
    GstBuffer **slot = u;
    GstBuffer *b = GST_PAD_PROBE_INFO_BUFFER(info);
    if (b) gst_buffer_replace(slot, b);
    return GST_PAD_PROBE_OK;
}

static GstBuffer *far_key;

static GstCaps *far_request_key(GstElement *dec, guint ssrc, gpointer user)
{
    (void)dec; (void)ssrc; (void)user;
    GstCaps *caps = gst_caps_new_simple("application/x-srtp",
                                        "srtp-cipher", G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtp-auth", G_TYPE_STRING, SRTP_AUTH_NULL,
                                        "srtcp-cipher", G_TYPE_STRING, SRTP_CIPHER_GCM256,
                                        "srtcp-auth", G_TYPE_STRING, SRTP_AUTH_NULL, NULL);
    gst_caps_set_simple(caps, "srtp-key", GST_TYPE_BUFFER, far_key, NULL);
    return caps;
}

static gboolean got_both(void) { return got_rtp && got_rtcp; }

static void test_sender_role(gboolean is_caller)
{
    memset(&g_sm, 0, sizeof g_sm);
    sm_video_reset();
    g_sm.is_caller = is_caller;
    test_keys(&g_sm.keys);
    /* The far side decrypts us with our TX key. */
    far_key = is_caller ? master_key_buffer(g_sm.keys.offer_key, g_sm.keys.offer_salt)
                        : master_key_buffer(g_sm.keys.answer_key, g_sm.keys.answer_salt);

    GstElement *p = gst_pipeline_new("sender");
    GstElement *src = el("appsrc", NULL), *sdec = el("srtpdec", NULL);
    GstElement *a = el("fakesink", NULL), *b = el("fakesink", NULL);
    GstCaps *c = gst_caps_new_empty_simple("application/x-srtp");
    g_object_set(src, "caps", c, "format", GST_FORMAT_TIME, NULL);
    gst_caps_unref(c);
    g_signal_connect(sdec, "request-key", G_CALLBACK(far_request_key), NULL);
    g_object_set(a, "sync", FALSE, "async", FALSE, NULL);
    g_object_set(b, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add_many(GST_BIN(p), src, sdec, a, b, NULL);
    CHECK(gst_element_link_many(src, sdec, a, NULL));
    CHECK(gst_element_link_pads(sdec, "rtcp_src", b, "sink"));
    GstPad *pa = gst_element_get_static_pad(a, "sink"), *pb = gst_element_get_static_pad(b, "sink");
    gst_pad_add_probe(pa, GST_PAD_PROBE_TYPE_BUFFER, take_rtp, &got_rtp, NULL);
    gst_pad_add_probe(pb, GST_PAD_PROBE_TYPE_BUFFER, take_rtp, &got_rtcp, NULL);
    gst_object_unref(pa); gst_object_unref(pb);
    gst_element_set_state(p, GST_STATE_PLAYING);
    g_datasrc = src;

    /* Nothing to say yet: nothing sent. */
    g_accepted = FALSE;
    sm_push_data_message();

    g_accepted = TRUE;                   /* the caller has this set too: it must not send Accepted */
    g_accept_id = 77;
    signal_media_set_call_id(77);
    g_atomic_int_set(&g_v.status_known, 1);
    int want_video = is_caller ? 0 : 1;  /* what we say must be what the camera does */
    g_atomic_int_set(&g_v.status_video, want_video);
    sm_push_data_message();
    sm_push_pli();
    CHECK(wait_for(got_both, 5000));

    if (got_rtp) {
        GstMapInfo m;
        gst_buffer_map(got_rtp, &m, GST_MAP_READ);
        SvRtp r;
        SvDataMsg dm;
        CHECK(sv_rtp_parse(m.data, m.size, &r) == 0 && r.pt == SV_PT_DATA && r.ssrc == SV_SSRC_DATA);
        CHECK(sv_data_msg_decode(m.data + r.header_len, m.size - r.header_len, &dm) == 0);
        CHECK(dm.has_accepted == (is_caller ? 0 : 1));
        CHECK(is_caller || dm.accepted_id == 77);
        CHECK(dm.has_status && dm.status_id == 77 && dm.video_enabled == want_video);
        CHECK(dm.has_seqnum && dm.seqnum >= 1);
        gst_buffer_unmap(got_rtp, &m);
    }
    if (got_rtcp) {
        GstMapInfo m;
        gst_buffer_map(got_rtcp, &m, GST_MAP_READ);
        CHECK(m.size == 12);
        CHECK(sv_rtcp_wants_keyframe(m.data, m.size, sv_peer_video_ssrc(is_caller)) == 1);
        CHECK(m.size == 12 && ((guint32)m.data[4] << 24 | m.data[5] << 16 | m.data[6] << 8 | m.data[7]) ==
                              sv_video_ssrc(is_caller));
        gst_buffer_unmap(got_rtcp, &m);
    }
    g_print("sender (%s): data message and PLI decrypt as the far side\n", is_caller ? "caller" : "callee");

    gst_element_set_state(p, GST_STATE_NULL);
    gst_object_unref(p);
    g_datasrc = NULL;
    if (g_data_srtp) { srtp_dealloc(g_data_srtp); g_data_srtp = NULL; }
    gst_buffer_replace(&got_rtp, NULL);
    gst_buffer_replace(&got_rtcp, NULL);
    gst_buffer_unref(far_key);
    g_accepted = FALSE;
}

/* Keyframe requests: one when wanted, then none for SM_PLI_INTERVAL_US. */
static void test_pli_rate(void)
{
    sm_video_reset();
    g_v.last_pli_us = 0;
    gint64 t = 10 * (gint64)SM_PLI_INTERVAL_US;
    CHECK(!sm_pli_take(t));                                /* nothing wanted */
    g_atomic_int_set(&g_v.pli_wanted, 1);
    CHECK(sm_pli_take(t));
    CHECK(!sm_pli_take(t + 1));                            /* taken */
    g_atomic_int_set(&g_v.pli_wanted, 1);
    CHECK(!sm_pli_take(t + SM_PLI_INTERVAL_US - 1));       /* too soon */
    CHECK(g_atomic_int_get(&g_v.pli_wanted) == 1);         /* still wanted */
    CHECK(sm_pli_take(t + SM_PLI_INTERVAL_US));
    g_print("pli: one per %d ms\n", SM_PLI_INTERVAL_US / 1000);
}

/* ------------------------------------------------------------------ tx ---------------------- */

static GstPadProbeReturn run_probe(GstPadProbeInfo *info)
{
    return sm_tx_video_probe(NULL, info, NULL);
}

static void test_tx_probe(void)
{
    memset(&g_sm, 0, sizeof g_sm);
    sm_video_reset();
    g_atomic_int_set(&g_v.tx_cvo, 3);
    guint8 pl[4] = { 0x10, 0, 0, 0 };

    /* Answerer before the answer: dropped. */
    g_sm.is_caller = FALSE;
    g_accepted = FALSE;
    GstPadProbeInfo info = { 0 };
    info.type = GST_PAD_PROBE_TYPE_BUFFER;
    info.data = rtp_buffer(SV_PT_VP8 | 0x80, 2003, 5, pl, sizeof pl);
    CHECK(run_probe(&info) == GST_PAD_PROBE_DROP);
    gst_buffer_unref(info.data);

    /* After it: the marker packet gets CVO 3, the others pass as they are. */
    g_accepted = TRUE;
    info.data = rtp_buffer(SV_PT_VP8 | 0x80, 2003, 6, pl, sizeof pl);
    CHECK(run_probe(&info) == GST_PAD_PROBE_OK);
    GstMapInfo m;
    gst_buffer_map(info.data, &m, GST_MAP_READ);
    SvRtp r;
    const guint8 *d = NULL;
    size_t dl = 0;
    CHECK(sv_rtp_parse(m.data, m.size, &r) == 0 && r.seq == 6 && r.marker);
    CHECK(sv_rtp_find_ext(m.data, m.size, &r, SV_EXT_CVO, &d, &dl) == 0 && dl == 1 && d[0] == 3);
    CHECK(m.size - r.header_len == sizeof pl && m.data[r.header_len] == 0x10);
    gst_buffer_unmap(info.data, &m);
    gst_buffer_unref(info.data);

    info.data = rtp_buffer(SV_PT_VP8, 2003, 7, pl, sizeof pl);
    CHECK(run_probe(&info) == GST_PAD_PROBE_OK && gst_buffer_get_size(info.data) == 16);
    gst_buffer_unref(info.data);

    /* A list: only its marker packet changes. */
    GstBufferList *list = gst_buffer_list_new();
    gst_buffer_list_add(list, rtp_buffer(SV_PT_VP8, 2003, 8, pl, sizeof pl));
    gst_buffer_list_add(list, rtp_buffer(SV_PT_VP8 | 0x80, 2003, 9, pl, sizeof pl));
    info.type = GST_PAD_PROBE_TYPE_BUFFER_LIST;
    info.data = list;
    CHECK(run_probe(&info) == GST_PAD_PROBE_OK);
    list = info.data;
    CHECK(gst_buffer_list_length(list) == 2);
    CHECK(gst_buffer_get_size(gst_buffer_list_get(list, 0)) == 16);
    CHECK(gst_buffer_get_size(gst_buffer_list_get(list, 1)) == 24);
    gst_buffer_list_unref(list);

    /* The caller sends from the start. */
    g_accepted = FALSE;
    g_sm.is_caller = TRUE;
    info.type = GST_PAD_PROBE_TYPE_BUFFER;
    info.data = rtp_buffer(SV_PT_VP8, 1003, 1, pl, sizeof pl);
    CHECK(run_probe(&info) == GST_PAD_PROBE_OK);
    gst_buffer_unref(info.data);
    g_print("tx probe: gate and CVO ok\n");
}

static gboolean preview_frames(void) { return g_atomic_int_get(&shm_frames) >= 10; }
static gboolean vtx_on(void) { return events_with("VTX 1") > 0; }

static void test_tx_head(const char *dir)
{
    memset(&g_sm, 0, sizeof g_sm);
    sm_video_reset();
    g_sm.is_caller = FALSE;
    test_keys(&g_sm.keys);
    events_clear();

    /* No VP8 encoder in this sysroot (gstreamer1.0-plugins-good is built without vpx): the send
     * tail reports it and the call stays receive-only. */
    GstElement *p = gst_pipeline_new("tx");
    GstElement *funnel = el("funnel", NULL), *fsink = el("fakesink", NULL);
    g_object_set(fsink, "sync", FALSE, "async", FALSE, NULL);
    gst_bin_add_many(GST_BIN(p), funnel, fsink, NULL);
    gst_element_link(funnel, fsink);
    GstElementFactory *f = gst_element_factory_find("vp8enc");
    if (!f) {
        CHECK(!sm_video_tx_build(p, funnel));
        CHECK(events_with("VIDEOERR tx-encoder") == 1);
        CHECK(g_tx_vqueue == NULL && g_v.tx_enc == NULL);
    } else {
        gst_object_unref(f);
        g_print("tx: vp8enc present, tail built\n");
        CHECK(sm_video_tx_build(p, funnel));
    }

    /* The camera head, in front of a stand-in tail when there is no encoder. */
    if (!g_tx_vqueue) {
        GstElement *q = el("queue", NULL), *s = el("fakesink", NULL);
        g_object_set(s, "sync", FALSE, "async", FALSE, NULL);
        gst_bin_add_many(GST_BIN(p), q, s, NULL);
        gst_element_link(q, s);
        g_tx_vqueue = q;
    }
    g_sm.pipeline = p;
    CHECK(gst_element_set_state(p, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);

    gchar *shm = g_build_filename(dir, "preview.sock", NULL);
    g_setenv("SIGNAL_MEDIA_PREVIEW_SHM", shm, TRUE);
    g_setenv("SIGNAL_MEDIA_VIDEO_SRC", "videotestsrc is-live=true pattern=smpte", TRUE);
    g_setenv("SIGNAL_MEDIA_VIDEO_ROTATION", "3", TRUE);

    /* Not before the answer. */
    g_v.tx_wanted = TRUE;
    g_accepted = FALSE;
    sm_video_tx_start(NULL);
    CHECK(g_tx_head == NULL && events_with("VTX") == 0);

    g_accepted = TRUE;
    for (int round = 0; round < 2; round++) {
        g_atomic_int_set(&shm_frames, 0);
        g_atomic_int_set(&shm_bad_size, 0);
        events_clear();
        sm_video_tx_start(NULL);
        CHECK(g_tx_head != NULL);
        CHECK(wait_for(vtx_on, 5000));
        CHECK(g_atomic_int_get(&g_v.status_video) == 1 && g_atomic_int_get(&g_v.status_known) == 1);
        CHECK(wait_for(has_vpreview, 10000));
        gchar *pv = event_with("VPREVIEW ");
        gchar *want = g_strdup_printf("VPREVIEW %s 320 240 1 0", shm);   /* 3 clockwise = 1 back */
        CHECK(pv && !g_strcmp0(pv, want));
        g_free(pv); g_free(want);
        CHECK(g_atomic_int_get(&g_v.tx_cvo) == 3);
        GstElement *reader = shm_reader(shm, SM_PREVIEW_W, SM_PREVIEW_H);
        gst_element_set_state(reader, GST_STATE_PLAYING);
        CHECK(wait_for(preview_frames, 10000));
        CHECK(g_atomic_int_get(&shm_bad_size) == 0);
        gst_element_set_state(reader, GST_STATE_NULL);
        gst_object_unref(reader);

        sm_video_tx_stop(NULL);
        CHECK(g_tx_head == NULL);
        CHECK(events_with("VTX 0") == 1);
        CHECK(g_atomic_int_get(&g_v.status_video) == 0);
        GstElement *gone = gst_bin_get_by_name(GST_BIN(p), "txv-head");
        CHECK(gone == NULL);
        if (gone) gst_object_unref(gone);
        g_print("tx head round %d: camera on, self-view on shm, camera off\n", round + 1);
    }

    gst_element_set_state(p, GST_STATE_NULL);
    gst_object_unref(p);
    g_sm.pipeline = NULL;
    g_tx_vqueue = NULL;
    g_v.tx_enc = NULL;
    g_unsetenv("SIGNAL_MEDIA_PREVIEW_SHM");
    g_unsetenv("SIGNAL_MEDIA_VIDEO_SRC");
    g_unsetenv("SIGNAL_MEDIA_VIDEO_ROTATION");
    g_free(shm);
    g_accepted = FALSE;
}

int main(int argc, char **argv)
{
    gst_init(&argc, &argv);
    const char *ivf = g_getenv("SIGNAL_TEST_IVF");
    const char *dir = g_getenv("SIGNAL_TEST_DIR");
    if (!ivf || !dir) { g_printerr("set SIGNAL_TEST_IVF and SIGNAL_TEST_DIR\n"); return 2; }
    events = g_ptr_array_new_with_free_func(g_free);
    signal_media_set_event_cb(on_event, NULL);

    test_rx(ivf, dir);
    test_sender_role(FALSE);
    test_sender_role(TRUE);
    test_pli_rate();
    test_tx_probe();
    test_tx_head(dir);

    g_ptr_array_unref(events);
    if (failures) { g_printerr("%d failure(s)\n", failures); return 1; }
    g_print("PASS test_video_pipeline\n");
    return 0;
}
