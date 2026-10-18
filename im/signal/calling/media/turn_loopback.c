/* turn_loopback.c - decisive TURN relay-to-relay ICE connectivity test, entirely self-contained
 * (no Signal account, no Android peer). Run as TWO SEPARATE PROCESSES (one --side a, one --side b,
 * normally on the same device/network), each with its own NiceAgent/GMainContext - mirroring exactly
 * how the real signal_media.c engine runs (ONE agent per process), unlike an earlier two-agents-in-
 * one-process version of this test which turned out to reproduce a shared-process TURN-retry stall
 * that a real call never hits. Both sides force-relay=TRUE through the SAME live TURN credentials
 * (captured from a real Signal call's RELAY lines - see /media/internal/turn_creds.txt), exchanging
 * their one relay candidate via small SDP-line files in a shared workdir (no signaling channel of our
 * own needed - both processes run on the same device / mounted fs).
 *
 * Why: a real incoming/outgoing Signal call (signal_media.c, same libnice build, same force-relay+
 * ice-tcp=off settings) gets a clean TURN Allocate + all CreatePermission round-trips, sends
 * byte-verified RFC5245-correct STUN connectivity checks, but never receives a single response back
 * from the TURN server afterwards - not even for the peer's plain same-LAN host candidate. This test
 * isolates whether that's (a) a bug in our own libnice/TURN client's receive path, or (b) something
 * specific to the real call against the Android/RingRTC peer. If our own two agents complete ICE with
 * each other over the SAME TURN relay, (a) is ruled out.
 *
 * Usage:
 *   turn_loopback --side a <turn_host> <turn_port> <turn_user> <turn_pass> <workdir>
 *   turn_loopback --side b <turn_host> <turn_port> <turn_user> <turn_pass> <workdir>
 * Run both (e.g. each backgrounded, or in two shells) with the SAME workdir. Exit 0 = both reached
 * CONNECTED/READY; exit 1 = timeout/failure.
 */
#include <glib.h>
#include <glib/gstdio.h>
#include <nice/agent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static GMainLoop *g_loop;
static GMainContext *g_ctx;
static NiceAgent *g_agent;
static guint g_stream_id;
static gboolean g_up;
static gboolean g_peer_fed;
static char g_my_cand_path[512];
static char g_peer_cand_path[512];
static const char *g_side;

static void on_state(NiceAgent *agent, guint stream_id, guint component_id, guint state, gpointer user) {
    (void)agent; (void)stream_id; (void)component_id; (void)user;
    static const char *names[] = {"disconnected", "gathering", "connecting", "connected", "ready", "failed"};
    g_print("[%s] component state -> %s\n", g_side, state <= 5 ? names[state] : "?");
    if (state == NICE_COMPONENT_STATE_CONNECTED || state == NICE_COMPONENT_STATE_READY) {
        g_up = TRUE;
        g_print("\n*** SUCCESS[%s]: reached CONNECTED/READY via TURN relay ***\n", g_side);
        g_main_loop_quit(g_loop);
    } else if (state == NICE_COMPONENT_STATE_FAILED) {
        g_print("\n*** FAILED[%s]: ICE component state -> failed ***\n", g_side);
        g_main_loop_quit(g_loop);
    }
}

static void on_selected_pair(NiceAgent *agent, guint stream_id, guint component_id,
                              gchar *lfoundation, gchar *rfoundation, gpointer user) {
    (void)agent; (void)stream_id; (void)component_id; (void)user;
    g_print("[%s] SELECTED PAIR: local-foundation=%s remote-foundation=%s\n", g_side, lfoundation, rfoundation);
}

static void on_recv(NiceAgent *agent, guint stream_id, guint component_id, guint len,
                     gchar *buf, gpointer user_data) {
    (void)agent; (void)stream_id; (void)component_id; (void)buf; (void)user_data;
    g_print("[%s] on_recv: %u byte(s) of data\n", g_side, len);
}

static gboolean poll_peer_cand(gpointer user) {
    (void)user;
    if (g_peer_fed) return FALSE;
    gchar *contents = NULL;
    gsize len = 0;
    if (!g_file_get_contents(g_peer_cand_path, &contents, &len, NULL) || len == 0) {
        return TRUE; /* keep polling */
    }
    g_strchomp(contents);
    g_print("[%s] read peer candidate: %s\n", g_side, contents);
    NiceCandidate *c = nice_agent_parse_remote_candidate_sdp(g_agent, g_stream_id, contents);
    g_free(contents);
    if (!c) {
        g_printerr("[%s] FAILED to parse peer candidate SDP\n", g_side);
        return TRUE;
    }
    GSList *l = g_slist_append(NULL, c);
    int n = nice_agent_set_remote_candidates(g_agent, g_stream_id, 1, l);
    g_print("[%s] set_remote_candidates -> %d\n", g_side, n);
    g_slist_free(l);
    nice_candidate_free(c);
    g_peer_fed = TRUE;
    return FALSE;
}

static void on_gathering_done(NiceAgent *agent, guint stream_id, gpointer user) {
    (void)user;
    GSList *cands = nice_agent_get_local_candidates(agent, stream_id, 1);
    g_print("[%s] gathering done, %u local candidate(s)\n", g_side, g_slist_length(cands));
    if (!cands) {
        g_printerr("[%s] NO local candidate gathered (TURN allocate failed) - aborting\n", g_side);
        g_main_loop_quit(g_loop);
        return;
    }
    NiceCandidate *c = cands->data;
    gchar *sdp = nice_agent_generate_local_candidate_sdp(agent, c);
    g_print("[%s] local candidate SDP: %s\n", g_side, sdp);
    GError *err = NULL;
    if (!g_file_set_contents(g_my_cand_path, sdp, -1, &err)) {
        g_printerr("[%s] failed to write %s: %s\n", g_side, g_my_cand_path, err->message);
    }
    g_free(sdp);
    g_slist_free_full(cands, (GDestroyNotify)nice_candidate_free);
    /* Explicit g_source_attach(ctx) rather than g_timeout_add()'s implicit thread-default: this
     * signal handler may be invoked from a libnice-internal thread, not the thread that pushed our
     * context as thread-default, in which case g_timeout_add would silently attach to the process'
     * global default context (never iterated here) and this poll would never fire - exactly the
     * earlier nice_agent_attach_recv trap, one layer up. */
    GSource *poll_src = g_timeout_source_new(200);
    g_source_set_callback(poll_src, poll_peer_cand, NULL, NULL);
    g_source_attach(poll_src, g_ctx);
    g_source_unref(poll_src);
}

static gboolean on_timeout(gpointer user) {
    (void)user;
    g_print("\n*** TIMEOUT[%s] after 90s: up=%d ***\n", g_side, g_up);
    g_main_loop_quit(g_loop);
    return FALSE;
}

int main(int argc, char **argv) {
    if (argc < 8 || strcmp(argv[1], "--side") != 0) {
        fprintf(stderr, "usage: %s --side a|b <turn_host> <turn_port> <turn_user> <turn_pass> <workdir>\n", argv[0]);
        return 2;
    }
    const char *side = argv[2];
    const char *turn_host = argv[3];
    int turn_port = atoi(argv[4]);
    const char *turn_user = argv[5];
    const char *turn_pass = argv[6];
    const char *workdir = argv[7];
    g_side = strcmp(side, "a") == 0 ? "A(controlling)" : "B(controlled)";
    gboolean controlling = strcmp(side, "a") == 0;

    snprintf(g_my_cand_path, sizeof g_my_cand_path, "%s/%s.cand", workdir, side);
    snprintf(g_peer_cand_path, sizeof g_peer_cand_path, "%s/%s.cand", workdir, controlling ? "b" : "a");
    /* Clear any stale candidate file from a previous run before we start. */
    g_unlink(g_my_cand_path);

    const char *local_ufrag = controlling ? "aaaa" : "bbbb";
    const char *local_pwd   = controlling ? "aaaaaaaaaaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbbbbbbbbbb";
    const char *remote_ufrag = controlling ? "bbbb" : "aaaa";
    const char *remote_pwd   = controlling ? "bbbbbbbbbbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaaaaaaaaaa";

    GMainContext *ctx = g_main_context_new();
    g_ctx = ctx;
    g_loop = g_main_loop_new(ctx, FALSE);
    g_print("[%s] my ctx = %p\n", g_side, (void *)ctx);

    g_agent = nice_agent_new(ctx, NICE_COMPATIBILITY_RFC5245);
    g_object_set(g_agent, "controlling-mode", controlling, NULL);
    g_object_set(g_agent, "ice-tcp", FALSE, NULL);
    g_object_set(g_agent, "force-relay", TRUE, NULL);
    g_object_set(g_agent, "support-renomination", TRUE, NULL);
    g_object_set(g_agent, "keepalive-conncheck", TRUE, NULL);
    g_stream_id = nice_agent_add_stream(g_agent, 1);
    if (!nice_agent_set_relay_info(g_agent, g_stream_id, 1, turn_host, (guint)turn_port,
                                    turn_user, turn_pass, NICE_RELAY_TYPE_TURN_UDP))
        g_printerr("[%s] set_relay_info FAILED\n", g_side);
    nice_agent_set_local_credentials(g_agent, g_stream_id, local_ufrag, local_pwd);
    nice_agent_set_remote_credentials(g_agent, g_stream_id, remote_ufrag, remote_pwd);

    /* CRITICAL: nice_agent_new()'s context is only used for signal emission - each NiceComponent
     * gets its own PRIVATE GMainContext (component->own_ctx, component.c:1139) for actual socket I/O
     * by default, which nothing here would ever iterate. The real engine (signal_media.c) never hits
     * this because its GStreamer nicesrc/nicesink elements pull data via their own blocking-recv
     * streaming thread, bypassing the component's GSource dispatch entirely. This test has no such
     * thread, so without explicitly redirecting the component's I/O context via nice_agent_attach_recv
     * (func=NULL: we don't need the data, just need the STUN/TURN control-plane dispatch that happens
     * as a side effect of the component actually being read), inbound packets are proven (via tcpdump)
     * to arrive at the NIC but our own component never reads them - the STUN retry/discovery state
     * machine sits forever waiting for a response it never sees. */
    if (!nice_agent_attach_recv(g_agent, g_stream_id, 1, ctx, on_recv, NULL))
        g_printerr("[%s] nice_agent_attach_recv FAILED\n", g_side);

    g_signal_connect(g_agent, "component-state-changed", G_CALLBACK(on_state), NULL);
    g_signal_connect(g_agent, "candidate-gathering-done", G_CALLBACK(on_gathering_done), NULL);
    g_signal_connect(g_agent, "new-selected-pair", G_CALLBACK(on_selected_pair), NULL);

    g_print("[%s] gathering (force-relay via %s:%d) ==\n", g_side, turn_host, turn_port);
    nice_agent_gather_candidates(g_agent, g_stream_id);

    GSource *to_src = g_timeout_source_new_seconds(90);
    g_source_set_callback(to_src, on_timeout, NULL, NULL);
    g_source_attach(to_src, ctx);
    /* Matches signal_media.c's build_pipeline() thread: some of libnice's internal scheduling (e.g.
     * re-sending an authenticated TURN Allocate after a 401 challenge, via discovery_unsched_items)
     * is scheduled on the "thread-default" GMainContext, not necessarily the explicit one passed to
     * nice_agent_new(). Without pushing our context as thread-default, that retry silently attaches
     * to the process' global default context, which nothing here ever iterates - so it never fires. */
    g_main_context_push_thread_default(ctx);
    g_main_loop_run(g_loop);
    g_main_context_pop_thread_default(ctx);
    g_source_destroy(to_src);
    g_source_unref(to_src);

    int rc = g_up ? 0 : 1;
    g_print("[%s] == result: %s ==\n", g_side, rc == 0 ? "PASS" : "FAIL");
    return rc;
}
