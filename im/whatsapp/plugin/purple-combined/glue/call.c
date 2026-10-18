// call.c — luna-service2 call service for WhatsApp calling, hosted INSIDE the
// messaging plugin (imlibpurpletransport) instead of a separate wacallm process.
//
// Ported from wacallm's svc/main.c. Differences:
//   * registers com.palm.whatsapp.call and attaches to libpurple's default
//     GMainContext (the transport already services it) — no own mainloop, mirroring
//     signal/purple-presage/src/c/call.c and telegram/tdlib-purple/call-luna.cpp.
//   * initialised once from glue/login.c (whatsapp_call_luna_init) on login.
//   * the WhatsApp engine (meowcaller) is attached to the plugin's shared whatsmeow
//     client in Go (call.go:startCalling) — C here only bridges Luna + audio.
//
// Go -> C callbacks (called from call.go):
//   gowhatsapp_call_on_state(json)      -> push to callStateQuery subscribers (mainloop-safe)
//   gowhatsapp_call_on_speaker(pcm, n)  -> received PCM -> ALSA playback
//   gowhatsapp_call_audio_active(on)    -> open/close the ALSA playback+capture path
//   gowhatsapp_call_read_mic(out, n)    -> Go PULLS mic PCM from the C ring
// C -> Go exports (from libwhatsmeow.h): gowhatsapp_go_call_dial/_answer/_hangup/_hangup_all

#include <glib.h>
#include "webos-ls2-compat.h"   /* legacy split-bus API on either luna-service2 */
#include <alsa/asoundlib.h>
#include <pthread.h>
#include <unistd.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <dirent.h>
#include <sys/resource.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <linux/input.h> // EVIOCGSW / SW_HEADPHONE_INSERT — detect a plugged headset for call routing
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include "denoise.h"
#include "aec.h"

// Acoustic-echo-cancellation delay hint (render -> mic echo). MEASURED on-device by cross-correlating
// the played far-end against the raw mic echo (AEC_CALIB build + scratchpad/echo_delay.py): 179ms,
// peak/median 17.8 (confident). AECM's own estimator refines around it. Re-run the calibration if the
// audio path (ALSA buffer sizes, kernel) changes.
#define WA_AEC_DELAY_MS 179

#include "libwhatsmeow.h" // go-generated: gowhatsapp_go_call_dial/_answer/_hangup/_hangup_all
#include "voipkit.h"     // native SkypeKit RTP bridge (see WHATSAPP_VIDEO_STATUS.md "hook it
                          // up properly" plan) — capture/playback socket threads

static LSPalmService *g_psh = NULL;
static LSHandle *g_pub = NULL;
static LSHandle *g_prv = NULL;
static GMainLoop *g_loopRef = NULL;
static int g_registered = 0;

/* ---------- minimal JSON helpers (flat CallSynergizer payloads only) ---------- */
static gboolean json_str(const char *json, const char *key, char *out, size_t outsz) {
	char pat[64];
	snprintf(pat, sizeof pat, "\"%s\"", key);
	const char *k = strstr(json, pat);
	if (!k) return FALSE;
	const char *c = strchr(k + strlen(pat), ':');
	if (!c) return FALSE;
	for (c++; *c == ' ' || *c == '\t'; c++) {}
	if (*c != '"') return FALSE;
	c++;
	size_t i = 0;
	while (*c && *c != '"' && i + 1 < outsz) {
		if (*c == '\\' && c[1]) c++;
		out[i++] = *c++;
	}
	out[i] = 0;
	return TRUE;
}
static gboolean json_true(const char *json, const char *key) {
	char pat[64];
	snprintf(pat, sizeof pat, "\"%s\"", key);
	const char *k = strstr(json, pat);
	if (!k) return FALSE;
	const char *c = strchr(k + strlen(pat), ':');
	if (!c) return FALSE;
	for (c++; *c == ' ' || *c == '\t'; c++) {}
	return strncmp(c, "true", 4) == 0;
}

static void reply(LSHandle *sh, LSMessage *msg, const char *payload) {
	LSError e;
	LSErrorInit(&e);
	if (!LSMessageReply(sh, msg, payload, &e)) {
		fprintf(stderr, "wa-call: LSMessageReply failed: %s\n", e.message);
		LSErrorFree(&e);
	}
}

/* ---------- clonk: the real-time video-call session backing "videoURI" ----------
 * See messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md (Parts 1-18) for the full
 * reverse-engineering writeup this is built against: the LS2 call sequence, the native
 * firmware caps-negotiation bug and its argument-shift workaround (Part 16), the SkypeKit
 * RTP socket ordering dependency (Part 17), and the wire format (Part 18) that glue/voipkit.cpp
 * implements. Session *creation* was always confirmed working; this deepens clonk_open/
 * clonk_close to actually bring up capture+playback and the voipkit.cpp socket bridge. */
static char g_clonk_uri[256] = {0};
// Set synchronously the moment clonk_open() issues its LSCallOneReply, cleared once the
// reply lands (clonk_open_reply, success or failure) or clonk_close() tears the session
// down. g_clonk_uri alone isn't enough to guard against a second clonk_open() call: it only
// gets populated inside the ASYNC reply, so two calls close together (confirmed live: the
// dial path's OnReady-triggered open and the incoming-video OnVideoState-triggered open
// firing near-simultaneously) can both see g_clonk_uri still empty and both fire a real
// LSCallOneReply -- observed live as the SAME session opened/started 3 times over, each
// with its own videoCaptureStart/videoPlayerStart. Whether or not mediaserver's own
// pipeline construction is safe against 3 overlapping start calls for one session was never
// verified and isn't worth relying on.
static volatile int g_clonk_opening = 0;
static char *g_last_callstate_json = NULL; // most recent raw JSON from Go, pre-URI-injection
// Keyframe-restart cooldown clock (see KEYFRAME_COOLDOWN_US / gowhatsapp_call_request_keyframe
// below). Declared here, not next to its main use, so clonk_video_capture_start_reply can seed
// it at call start -- that function runs earlier in this file than the keyframe-restart code.
static gint64 g_last_keyframe_restart_us = 0;

// Durable clonk-session-lifecycle log: every open/close/start/stop and every
// gowhatsapp_call_video_active() flip, timestamped, appended to a plain file under
// /media/internal. Needed because the fprintf(stderr,...) trail throughout this file only
// survives while something is actively tailing imwrap.sh's stdout live -- reconstructing
// what happened on a call after the fact (e.g. whether OnVideoState flapped and tore the
// clonk session down/up repeatedly, moments after the incoming-video "black screen"/
// instant-teardown symptom was captured) was otherwise impossible.
static void clonk_diag_log(const char *fmt, ...) {
	FILE *f = fopen("/media/internal/wacall_clonk.log", "a");
	if (!f) return;
	fprintf(f, "[%lld] ", (long long)(g_get_real_time() / 1000));
	va_list ap;
	va_start(ap, fmt);
	vfprintf(f, fmt, ap);
	va_end(ap);
	fprintf(f, "\n");
	fclose(f);
}

static bool clonk_video_capture_start_reply(LSHandle *sh, LSMessage *msg, void *ctx);
static bool clonk_video_player_start_reply(LSHandle *sh, LSMessage *msg, void *ctx);
// TEST-ONLY harness (see its definition further down, after clonk_video_player_start_reply,
// for the full explanation): lets a debug LS2 call drive the clonk pipeline + inject a real
// captured H.264 access unit WITHOUT a live WhatsApp call, to iterate on the native
// clonk_video_play render bug without needing Android to answer each time.
static volatile int g_test_inject_mode;
static int g_test_inject_delay_ms;
static int g_test_inject_interval_ms;
static int g_test_inject_use_real_stream;
static gboolean test_inject_start_tick(gpointer data);
static void clonk_open(void);
static void clonk_close(void);
// Forward declarations: g_audio_on/audiod_status_idle are defined further down (near the
// rest of the ALSA/audiod bridge) but clonk_video_player_start_reply above needs to
// re-assert the audiod phone scenario once clonk's video pipeline is up.
static gboolean audiod_status_idle(gpointer d);
static volatile int g_audio_on;

// clonk_uri_call — fires "<g_clonk_uri><method>" with the given JSON payload. Every clonk
// action method needs the {"args":[...]} wrapper even for zero-arg calls (see
// LunaInterface::getArguments's dom["args"] requirement, WHATSAPP_VIDEO_STATUS.md Part 8) --
// callers always pass a literal "{\"args\":[...]}" string, never "{}".
static void clonk_uri_call_ctx(const char *method, const char *payload, LSFilterFunc cb,
                                void *ctx) {
	if (!g_prv || !g_clonk_uri[0]) return;
	char uri[320];
	snprintf(uri, sizeof uri, "%s%s", g_clonk_uri, method);
	LSError e;
	LSErrorInit(&e);
	LSMessageToken t;
	if (!LSCallOneReply(g_prv, uri, payload, cb, ctx, &t, &e)) {
		fprintf(stderr, "wa-call: clonk %s call failed: %s\n", method, e.message);
		LSErrorFree(&e);
	}
}
static void clonk_uri_call(const char *method, const char *payload, LSFilterFunc cb) {
	clonk_uri_call_ctx(method, payload, cb, NULL);
}

// videoCaptureStart args are (w, h, fps, bitrate) on the wire, but ClonkPipeline::
// setCamCapsFilter() reads the *wrong* VideoSettings offsets when building camsrc's caps
// filter (+4/+8 instead of +0/+4) -- a real, shipped firmware bug (WHATSAPP_VIDEO_STATUS.md
// Part 16). Since VideoSettings is otherwise a plain unshifted copy of these same arguments,
// putting our intended width in the h slot and our intended height in the fps slot lands the
// CORRECT width/height in the actual applied caps once that bug reads them one field over.
// Confirmed live: camsrc reaches PLAYING with zero GStreamer errors using exactly this shape.
// Fires videoPlayerStart on the mainloop, once, a moment after videoCaptureStart's LS2
// reply arrived. See clonk_video_capture_start_reply's comment for why this delay exists.
static gboolean fire_video_player_start(gpointer data) {
	(void)data;
	clonk_diag_log("fire_video_player_start: issuing videoPlayerStart");
	clonk_uri_call("videoPlayerStart", "{\"args\":[320,240]}", clonk_video_player_start_reply);
	return FALSE; // one-shot
}

static bool clonk_video_capture_start_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "wa-call: clonk videoCaptureStart: %s\n", LSMessageGetPayload(msg));
	clonk_diag_log("clonk_video_capture_start_reply: %s", LSMessageGetPayload(msg));
	// Thread A (capture->peer) must be bound+listening before videoPlayerStart triggers
	// mediaserver's RunVideoHost() -- see WHATSAPP_VIDEO_STATUS.md Part 17 and skypekit.h.
	voipkit_video_start();
	// PREVIOUSLY just a blind 400ms g_timeout_add before firing videoPlayerStart, on the theory
	// that the "resolution not set on capsfilter" WARN was benign and only needed the capture
	// side's own state-change handling a moment to finish. Disproven by a real --gst-debug=6
	// capture (GST_DEBUG_FILE, targeted at just the palmvideosink/basesink/GST_PADS/clonk
	// categories to keep volume sane): the playback pipeline's palmvideosink genuinely FAILS its
	// own READY->PAUSED state change (`PmMediaGstVideoSinkLib.c:621 "State change of parent
	// element not a success"`) within ~100ms of entering PAUSED, and the whole clonk_video_play
	// bin gets torn down to NULL within ~300ms of being built -- every single time, including on
	// the very first videoPlayerStart of a call, with no restart/keyframe cycle involved at all.
	// clonkvhsrc's own gst_skype_video_src_change_state fires the same WARN in the same window.
	// Local camera preview (palmvideosink0/2/4, no network dependency) never fails this way; only
	// the peer-video playback sink (which needs data flowing over the SkypeKit socket) does --
	// pointing at Thread B specifically, not a fixed-delay-vs-capture-side race. Thread B must
	// wait for Thread A to already be listening, then complete its OWN connect-retry loop (up to
	// 500ms per attempt) before mediaserver's clonkvhsrc has anything to actually read -- a fixed
	// 400ms delay could not reliably outlast that. Block here for a real "Thread B connected"
	// signal instead of guessing a delay (see voipkit_video_wait_thread_b's own comment).
	if (!voipkit_video_wait_thread_b(3000)) {
		fprintf(stderr, "wa-call: skypekit thread B did not connect within 3s, "
		                "firing videoPlayerStart anyway\n");
	}
	fire_video_player_start(NULL);
	// Seed the keyframe-restart cooldown clock here, at call start, instead of leaving it at
	// its zero-value default. Without this, the FIRST-ever gowhatsapp_call_request_keyframe()
	// call always fires immediately regardless of KEYFRAME_COOLDOWN_US (now - 0 always exceeds
	// any real cooldown), tearing down this freshly-built playback pipeline before it has any
	// real chance to receive/decode/preroll a frame. Confirmed live: a real capture showed the
	// H.264 decoder reaching PAUSED_TO_PLAYING, then the whole pipeline getting flushed only
	// ~460ms later -- an early PLI from the peer (arriving within the first couple seconds,
	// before it has ever decoded anything from us) killing the pipeline almost as soon as it's
	// built, well before the 25s cooldown between LATER restarts ever gets a chance to help.
	g_last_keyframe_restart_us = g_get_monotonic_time();
	return true;
}
static bool clonk_video_player_start_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "wa-call: clonk videoPlayerStart: %s\n", LSMessageGetPayload(msg));
	clonk_diag_log("clonk_video_player_start_reply: %s", LSMessageGetPayload(msg));
	// NOTE: a videoPlayerStop+videoPlayerStart retry workaround was tried here (theorized
	// from ClonkPipeline::initializeVPlayPipeline's "resolution not set on capsfilter"
	// ordering bug) but was never actually confirmed against a peer that was sending real
	// video, and reintroducing the pipeline teardown mid-call is a plausible way to disrupt
	// the skypekit socket bridge's own session state. Reverted to the simple single-call
	// flow, which is what was in place during the one confirmed live test where real
	// incoming H.264 RTP did arrive and reach skypekit's Thread B.
	//
	// Re-assert the audiod phone scenario here: video calls have never had working audio in
	// either direction, while audio-only calls (which never touch clonk at all) are fine.
	// mediaserver's clonk pipeline construction (confirmed via a --gst-debug=4 capture to
	// include its own skypeaudiosrc/skypeaudiosink elements, part of the same skypekit
	// plugin family as the video capture/sink) runs fully AFTER gowhatsapp_call_audio_active()
	// already set our own "voip"/"voipsource" ALSA route via audiod's phone scenario at call
	// start -- if clonk's own pipeline construction resets/steals that routing, re-sending the
	// SAME scenario call now (once clonk is fully up) should win it back without needing to
	// touch mediaserver/clonk itself.
	if (g_audio_on) g_idle_add(audiod_status_idle, GINT_TO_POINTER(1));
	if (g_test_inject_mode) {
		clonk_diag_log("TEST: videoPlayerStart replied, scheduling frame injection start in %dms", g_test_inject_delay_ms);
		g_timeout_add(g_test_inject_delay_ms > 0 ? g_test_inject_delay_ms : 1, test_inject_start_tick, NULL);
	}
	return true;
}

// ---------- TEST-ONLY: inject a real captured H.264 IDR access unit into the clonk
// playback pipeline WITHOUT a real WhatsApp call, to iterate on the native
// clonk_video_play render bug (see WHATSAPP_VIDEO_STATUS.md and tonight's session) without
// needing Android to answer a call each time. Triggered via:
//   luna-send -n 1 palm://com.palm.whatsapp.call/testInjectVideo '{"delayMs":"500"}'
// delayMs (optional, default 0) is how long AFTER videoPlayerStart's own LS2 reply to wait
// before the first voipkit_video_receive_frame() call -- the whole point of this harness
// is to let that delay be swept without a rebuild, to test whether the native
// busMsg_STATE_CHANGED bug (tearing clonk_video_play down within ~1s of construction,
// before ClonkSession's internal "VPlay active" flag is set -- see tonight's disassembly)
// is sensitive to exactly when the first access unit lands relative to videoPlayerStart.
// ---------------------------------------------------------------------------------------

// A real IDR access unit (SPS+PPS+IDR slice, Annex-B), captured verbatim from
// meowcaller_diag/video.jsonl during tonight's confirmed-working relay fix (call
// 8A9AF80DFD82D24BB4B13931E89DA473, nal_types "7,8,5" — a genuine keyframe, not the
// non-IDR "1"-only frames also present in that log). Repeating the SAME real IDR is fine
// for this test: the question is only whether the native FULL-type palmvideosink ever
// reaches PLAYING and renders anything at all, not video quality/continuity.
static const unsigned char TEST_IDR_FRAME[] = {
	0x00, 0x00, 0x00, 0x01, 0x67, 0x4d, 0x4c, 0x0c, 0x8c, 0x68, 0x14, 0x1d,
	0x79, 0xe0, 0x1e, 0x11, 0x08, 0xd4, 0x00, 0x00, 0x00, 0x01, 0x68, 0xee,
	0x3c, 0x80, 0x00, 0x00, 0x00, 0x01, 0x65, 0xb8, 0x00, 0x04, 0x08, 0xff,
	0x00, 0x4e, 0x4b, 0xdf, 0xfe, 0x15, 0xb9, 0x3c, 0x98, 0x9c, 0x72, 0x70,
	0x33, 0xeb, 0x1e, 0x37, 0xac, 0xe7, 0xce, 0x68, 0x12, 0xb7, 0x0c, 0xcb,
	0xad, 0xaf, 0x24, 0xd0, 0x7a, 0x2a, 0x05, 0xdd, 0x6b, 0x3b, 0xe9, 0x96,
	0x12, 0x30, 0x73, 0xa3, 0xbb, 0x94, 0x48, 0x63, 0x05, 0x47, 0xe0, 0x47,
	0x39, 0x99, 0xa5, 0xee, 0x45, 0x38, 0x1d, 0x1d, 0x9f, 0xcc, 0x7c, 0x92,
	0x02, 0x0e, 0x5f, 0x99, 0x5f, 0xcb, 0xb1, 0xb2, 0x6b, 0xef, 0xe5, 0xba,
	0x8e, 0x14, 0x8e, 0x72, 0x6a, 0xf6, 0x1d, 0x4c, 0xb0, 0x4b, 0x85, 0xe8,
	0x28, 0x0e, 0xd7, 0x86, 0xf1, 0x59, 0xa8, 0xed, 0xf2, 0x40, 0x6e, 0x1a,
	0x55, 0xa5, 0xcf, 0xec, 0x60, 0x3d, 0xea, 0x4b, 0x9f, 0xeb, 0x30, 0x06,
	0x12, 0xbc, 0x66, 0xb7, 0xa3, 0xfd, 0xeb, 0x70, 0x83, 0xbb, 0xcf, 0xc9,
	0x00, 0x07, 0x29, 0x46, 0xb5, 0x5b, 0x5a, 0x36, 0xa3, 0xae, 0x16, 0xdf,
	0xac, 0xe7, 0x6d, 0x60, 0x15, 0xaa, 0xbe, 0xf3, 0x2d, 0x4e, 0xbe, 0xae,
	0xa3, 0x18, 0x8d, 0x11, 0xa1, 0xbd, 0x11, 0x83, 0x68, 0x7a, 0x78, 0xb5,
	0x25, 0xff, 0x17, 0x35, 0x9b, 0x66, 0xd4, 0x7e, 0x05, 0x3a, 0x9c, 0x1b,
	0x04, 0xc5, 0xe8, 0x99, 0xf4, 0x79, 0xbb, 0x65, 0x3e, 0xac, 0xc7, 0x8c,
	0x7a, 0x6c, 0xbc, 0x2c, 0xd6, 0xe6, 0xcb, 0x8c, 0xb3, 0x30, 0x37, 0x4b,
	0x12, 0x24, 0xc7, 0x25, 0x88, 0x3f, 0x8b, 0x12, 0x24, 0xa8, 0xd9, 0x4f,
	0x8b, 0xcb, 0xed, 0x7e, 0xe0, 0xd2, 0x4e, 0x00, 0x00, 0x23, 0x60, 0xea,
	0x6c, 0xa1, 0x1f, 0x92, 0xb5, 0x16, 0xd5, 0x08, 0x91, 0x34, 0x97, 0xc3,
	0xc5, 0x63, 0x9f, 0x5e, 0x56, 0x18, 0x9f, 0x97, 0xd7, 0x43, 0x1f, 0xfa,
	0x32, 0x92, 0xc2, 0xbe, 0x70, 0xd3, 0x50, 0x13, 0x01, 0xd9, 0xbf, 0x7c,
	0x86, 0x2e, 0xfa, 0x43, 0xfc, 0x94, 0x42, 0x8d, 0x99, 0x21, 0x9c, 0x13,
	0xe2, 0x0a, 0xf4, 0xdd, 0xaf, 0x86, 0xfb, 0x83, 0x1e, 0x56, 0xec, 0x17,
	0xa5, 0xb7, 0xdd, 0x9a, 0xcf, 0xe2, 0x01, 0x6b, 0x7b, 0x6a, 0xfb, 0x7f,
	0x3f, 0xea, 0x63, 0x0b, 0x5d, 0x39, 0x5d, 0x7b, 0xdd, 0x44, 0x99, 0x73,
	0xd3, 0x59, 0x03, 0xf1, 0xa8, 0x55, 0x81, 0x67, 0x22, 0x26, 0xf5, 0x59,
	0x7c, 0x79, 0xbc, 0xdf, 0x18, 0xe0, 0xb8, 0x8c, 0xca, 0x45, 0x55, 0x4a,
	0x65, 0x88, 0x0b, 0xca, 0xe9, 0xbe, 0xae, 0xa1, 0x51, 0x46, 0x9a, 0x63,
	0xbd, 0x72, 0x8b, 0x86, 0x14, 0x3d, 0x44, 0x3d, 0xa7, 0x27, 0xd0, 0xd2,
	0x0c, 0xd5, 0x3b, 0x4e, 0xd6, 0x57, 0xf6, 0xfe, 0x53, 0x7c, 0x18, 0xb2,
	0x7a, 0x53, 0x7a, 0x92, 0x82, 0x24, 0xca, 0x63, 0x46, 0x4a, 0xf8, 0x36,
	0x55, 0x48, 0xe0, 0xa2, 0xf5, 0x8f, 0x62, 0x6a, 0x1e, 0x00, 0xba, 0xa2,
	0x8a, 0x6e, 0x26, 0xcc, 0xc2, 0xc4, 0x78, 0x21, 0x9c, 0x33, 0x52, 0x60,
	0x88, 0x4c, 0x45, 0xe3, 0x6d, 0x6d, 0x1f, 0x28, 0x5a, 0xe3, 0x86, 0x50,
	0x94, 0x24, 0xff, 0x6a, 0xab, 0x5b, 0x07, 0xf4, 0x3b, 0xa2, 0xda, 0x9b,
	0x9d, 0x3b, 0x1b, 0x46, 0x63, 0x19, 0xb4, 0x4e, 0x1e, 0xac, 0x6e, 0xf1,
	0x90, 0x58, 0x98, 0xf8, 0x99, 0x3e, 0x14, 0xec, 0x95, 0x92, 0xe0, 0x4e,
	0x76, 0x19, 0xe1, 0xa5, 0x36, 0xc9, 0x64, 0xd0, 0x23, 0xa4, 0xf1, 0x71,
	0xf7, 0x48, 0xe7, 0xb2, 0x2c, 0x9f, 0x2f, 0xe9, 0x9d, 0x95, 0xc9, 0xa1,
	0xf9, 0x54, 0x45, 0xc8, 0xfc, 0xd4, 0x43, 0x97, 0xbb, 0xaa, 0x0f, 0xf4,
	0xf9, 0x19, 0x99, 0xd2, 0xea, 0xe7, 0xf0, 0xa8, 0x91, 0x5b, 0x1d, 0x1f,
	0xac, 0x02, 0x74, 0x37, 0x1f, 0x2b, 0xf6, 0x76, 0x0b, 0x84, 0x9b, 0xdf,
	0x8b, 0x8e, 0x87, 0xac, 0x28, 0x9b, 0x48, 0x1b, 0xb5, 0xc1, 0x56, 0x8d,
	0x23, 0x4a, 0xf1, 0x67, 0x9d, 0x19, 0x29, 0x01, 0xe1, 0x70,
};

// ---------- TEST-ONLY: real multi-frame stream injection (WHATSAPP_VIDEO_STATUS.md Part 27) ----
// The single-repeated-static-IDR harness above proved (Part 27, a 35s no-op-teardown capture)
// that clonk_vplay_h264dec NEVER outputs a single decoded frame given that unrealistic input --
// no advancing timestamps, no P-frames. This second harness cycles through a real, validated
// 240-frame captured stream (received.h264 + its per-frame size/timing metadata from a real
// meowcaller loopback test) to test whether the decoder can produce output at all given a
// realistic access unit sequence, without needing a real WhatsApp call to find out.
#include "test_stream_data.h"
static int g_test_stream_frame_idx = 0;
// ---------- end real-stream data include ----------

static gboolean test_inject_frame_tick(gpointer data) {
	(void)data;
	voipkit_video_receive_frame(TEST_IDR_FRAME, sizeof(TEST_IDR_FRAME));
	return TRUE; // keep repeating every 200ms until the test session is closed
}

static gboolean test_inject_stream_tick(gpointer data) {
	(void)data;
	if (!g_test_inject_mode) return FALSE; // stopped
	int idx = g_test_stream_frame_idx;
	const unsigned char *frame = TEST_STREAM_DATA + TEST_FRAME_OFFSETS[idx];
	unsigned int size = TEST_FRAME_SIZES[idx];
	voipkit_video_receive_frame(frame, size);
	g_test_stream_frame_idx = (idx + 1) % TEST_STREAM_NUM_FRAMES;
	unsigned int next_delta = TEST_FRAME_DELTA_MS[g_test_stream_frame_idx];
	if (next_delta < 1) next_delta = 1;
	g_timeout_add(next_delta, test_inject_stream_tick, NULL);
	return FALSE; // one-shot; reschedules itself with the next frame's real delta
}

static gboolean test_inject_start_tick(gpointer data) {
	(void)data;
	if (g_test_inject_use_real_stream) {
		fprintf(stderr, "wa-call: TEST starting REAL STREAM injection loop (%d frames, real timing)\n",
		        TEST_STREAM_NUM_FRAMES);
		clonk_diag_log("TEST: starting real-stream frame injection loop (%d frames)",
		               TEST_STREAM_NUM_FRAMES);
		g_test_stream_frame_idx = 0;
		test_inject_stream_tick(NULL);
		return FALSE;
	}
	fprintf(stderr, "wa-call: TEST starting frame injection loop (%zu bytes/frame, %dms interval)\n",
	        sizeof(TEST_IDR_FRAME), g_test_inject_interval_ms);
	clonk_diag_log("TEST: starting frame injection loop (%zu bytes/frame, %dms interval)",
	               sizeof(TEST_IDR_FRAME), g_test_inject_interval_ms);
	g_timeout_add(g_test_inject_interval_ms, test_inject_frame_tick, NULL);
	return FALSE; // one-shot (the repeat above is the real loop)
}

static bool m_test_inject_video(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	const char *p = LSMessageGetPayload(msg);
	char buf[32] = "";
	g_test_inject_delay_ms = 0;
	g_test_inject_interval_ms = 200;
	g_test_inject_use_real_stream = 0;
	if (p && json_str(p, "delayMs", buf, sizeof buf)) g_test_inject_delay_ms = atoi(buf);
	if (p && json_str(p, "intervalMs", buf, sizeof buf)) g_test_inject_interval_ms = atoi(buf);
	if (p && json_str(p, "realStream", buf, sizeof buf)) g_test_inject_use_real_stream = atoi(buf);
	if (g_test_inject_interval_ms < 1) g_test_inject_interval_ms = 1;
	g_test_inject_mode = 1;
	fprintf(stderr, "wa-call: TEST testInjectVideo triggered, delayMs=%d intervalMs=%d realStream=%d\n",
	        g_test_inject_delay_ms, g_test_inject_interval_ms, g_test_inject_use_real_stream);
	clonk_diag_log("TEST: testInjectVideo triggered, delayMs=%d intervalMs=%d realStream=%d",
	               g_test_inject_delay_ms, g_test_inject_interval_ms, g_test_inject_use_real_stream);
	clonk_open();
	reply(sh, msg, "{\"returnValue\":true}");
	return true;
}

static bool m_test_stop_inject_video(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	fprintf(stderr, "wa-call: TEST testStopInjectVideo triggered\n");
	clonk_diag_log("TEST: testStopInjectVideo triggered");
	g_test_inject_mode = 0;
	clonk_close();
	reply(sh, msg, "{\"returnValue\":true}");
	return true;
}
// ---------- end TEST-ONLY harness ----------

static bool clonk_keyframe_start_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "wa-call: clonk keyframe-restart videoCaptureStart: %s\n", LSMessageGetPayload(msg));
	clonk_diag_log("clonk_keyframe_start_reply: %s", LSMessageGetPayload(msg));
	// PREVIOUSLY assumed (see clonk_keyframe_stop_reply's old comment) that videoCaptureStop
	// only tears down the capture pipeline, leaving playback untouched. Disproven live via a
	// real --gst-debug=4 capture of an actual call (GST_DEBUG_FILE, routed around the
	// per-session mediaserver child that the upstart job's own stdout redirect never
	// reached): the ENTIRE clonk_video_play bin -- palmvideosink1, video_decode_output_queue,
	// clonk_vplay_h264dec, clonkvhsrc -- gets removed and gst_element_finalize'd roughly a
	// second after the first videoPlayerStart, in lockstep with the first keyframe-restart
	// cycle a real peer PLI triggers early in the call. initializeVPlayPipeline never runs
	// again for the rest of the call. Since this handler previously only called
	// videoCaptureStart and never videoPlayerStart again, incoming video rendering died
	// permanently the moment the first real keyframe-restart happened -- exactly the reported
	// "incoming video flickers/doesn't display" symptom. Rebuild playback the same way the
	// first-time-open path does (clonk_video_capture_start_reply): give the capture side's own
	// state-change handling a moment to finish, then fire videoPlayerStart.
	//
	// Also mirror clonk_video_capture_start_reply's voipkit_video_start()/wait_thread_b() here.
	// Since videoCaptureStop/Start tears down and rebuilds mediaserver's WHOLE clonk session
	// (see above), the SkypeKit RTP sockets Thread A/B are bridging (/tmp/vidrtp_{to,from}_
	// skypekit_key) get replaced by a fresh pair too -- but voipkit_video_stop() in
	// clonk_keyframe_stop_reply already tore our OLD Thread A/B down, so this call is NOT a
	// no-op (g_running is false) and genuinely reconnects them to the NEW sockets. Without this,
	// Thread A/B stayed latched onto the now-dead old sockets, and Thread B's blocking native
	// send call (send_access_unit -> wr_call_lst) sat stuck for tens of seconds until some
	// underlying socket-level timeout eventually kicked it loose and its own reconnect loop
	// found the new listener -- exactly matching the observed "incoming video freezes for
	// ~30s, then recovers on its own" symptom on every keyframe-restart cycle after the first.
	voipkit_video_start();
	if (!voipkit_video_wait_thread_b(3000)) {
		fprintf(stderr, "wa-call: keyframe-restart: skypekit thread B did not reconnect within "
		                "3s, firing videoPlayerStart anyway\n");
	}
	g_timeout_add(400, fire_video_player_start, NULL);
	return true;
}
static bool clonk_keyframe_stop_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "wa-call: clonk keyframe-restart videoCaptureStop: %s\n", LSMessageGetPayload(msg));
	clonk_diag_log("clonk_keyframe_stop_reply: %s", LSMessageGetPayload(msg));
	// Tear our own bridge threads down here, BEFORE requesting the new capture session -- see
	// clonk_keyframe_start_reply's comment for why they'd otherwise be left stuck on the old,
	// about-to-be-replaced RTP sockets.
	voipkit_video_stop();
	clonk_uri_call("videoCaptureStart", "{\"args\":[320,320,240,400000]}", clonk_keyframe_start_reply);
	return true;
}

// Called from Go (Call.OnVideoKeyframeRequest) when the peer sends authenticated PLI/FIR
// feedback asking for a fresh keyframe. See the call.go comment for why this is a
// stop/restart rather than a direct request -- no LS2-exposed keyframe trigger exists.
//
// The stop/restart itself briefly interrupts the stream, which can make a struggling peer
// send ANOTHER PLI/FIR almost immediately -- a self-inflicted restart storm (confirmed live:
// several requests per second, each one killing/reopening capture, producing the "stalled
// after a few frames" symptom). Debounce: a restart already in flight, or one that completed
// within the last KEYFRAME_COOLDOWN_US, absorbs further requests instead of stacking more
// restarts on top - the fresh IDR from the most recent restart is still on its way regardless.
//
// Raised from 5s to 25s after a real --gst-debug=4 capture (GST_DEBUG_FILE, routed around the
// per-session mediaserver child) showed every restart cycle in every real call landing almost
// exactly 5-6s apart -- i.e. we were restarting the instant OUR OWN cooldown expired, not
// because the peer's actual PLI rate demanded it. Confirmed the real cost of this: each restart
// tears down BOTH pipelines the shared clonk session owns, not just capture (see
// clonk_keyframe_start_reply's comment) -- the local self-preview PIP re-renders almost
// instantly since it's fed straight from the camera, but the FULL-screen incoming-peer-video
// pipeline depends on network-delivered, decoded data and never got a long enough uninterrupted
// window to receive+decode+preroll a single frame before being torn down again for the next
// cycle -- confirmed via the sink's own preroll/render calls: the PIP sink rendered every
// cycle, the full-screen sink never once did, across an entire real call. A much longer cooldown
// gives it a real chance.
#define KEYFRAME_COOLDOWN_US (25000 * 1000)
void gowhatsapp_call_request_keyframe(void) {
	gint64 now;
	if (!g_clonk_uri[0]) return;
	now = g_get_monotonic_time();
	if (now - g_last_keyframe_restart_us < KEYFRAME_COOLDOWN_US) {
		fprintf(stderr, "wa-call: keyframe requested, within cooldown - absorbing\n");
		clonk_diag_log("gowhatsapp_call_request_keyframe: absorbed (within cooldown, %lld us since last)",
		               (long long)(now - g_last_keyframe_restart_us));
		return;
	}
	g_last_keyframe_restart_us = now;
	fprintf(stderr, "wa-call: keyframe requested, restarting capture\n");
	clonk_diag_log("gowhatsapp_call_request_keyframe: restarting capture");
	clonk_uri_call("videoCaptureStop", "{\"args\":[]}", clonk_keyframe_stop_reply);
}

// Splices the real clonk videoURI into Go's callState JSON. Go always emits the
// literal placeholder "videoURI":"" (Go owns call-state structure/logic; C owns the
// clonk session and its URI -- this is where the two meet). Caller g_free()s the result.
static char *inject_video_uri(const char *json) {
	static const char needle[] = "\"videoURI\":\"\"";
	const char *pos = strstr(json, needle);
	if (!pos || !g_clonk_uri[0]) return g_strdup(json);
	GString *out = g_string_new(NULL);
	g_string_append_len(out, json, pos - json);
	g_string_append(out, "\"videoURI\":\"");
	g_string_append(out, g_clonk_uri); // a palm:// LS2 URI, no JSON-special characters
	g_string_append_c(out, '"');
	g_string_append(out, pos + sizeof(needle) - 1);
	return g_string_free(out, FALSE);
}

static void publish_callstate_locked(const char *json) {
	char *out = inject_video_uri(json);
	LSError e;
	LSErrorInit(&e);
	if (g_pub) LSSubscriptionReply(g_pub, "callState", out, &e);
	if (g_prv) LSSubscriptionReply(g_prv, "callState", out, &e);
	g_free(out);
}

static bool clonk_open_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	g_clonk_opening = 0; // the open attempt this reply belongs to is no longer in flight
	const char *p = LSMessageGetPayload(msg);
	char uri[sizeof g_clonk_uri] = "";
	if (p && json_str(p, "location", uri, sizeof uri)) {
		strncpy(g_clonk_uri, uri, sizeof g_clonk_uri - 1);
		g_clonk_uri[sizeof g_clonk_uri - 1] = 0;
		fprintf(stderr, "wa-call: clonk session open: %s\n", g_clonk_uri);
		clonk_diag_log("clonk_open_reply: session open %s", g_clonk_uri);
		// Re-push immediately so subscribers get the real videoURI without waiting for
		// the next unrelated call-state change.
		if (g_last_callstate_json) publish_callstate_locked(g_last_callstate_json);
		// framerate MUST be 30 (camsrc's only supported rate) and the 2nd/3rd argument
		// slots are intentionally swapped -- see clonk_video_capture_start_reply's comment.
		clonk_uri_call("videoCaptureStart", "{\"args\":[320,320,240,400000]}",
		               clonk_video_capture_start_reply);
	} else {
		fprintf(stderr, "wa-call: clonk session open failed: %s\n", p ? p : "(no payload)");
	}
	return true;
}

// Opens a clonk session for the current call if one isn't already open (or already being
// opened). Idempotent -- g_clonk_opening is set here, synchronously, BEFORE the async LS2
// call goes out, precisely so a second clonk_open() arriving before the first reply lands
// (confirmed live: the dial path's OnReady and the incoming-video-triggered OnVideoState
// path can both fire within the same moment) sees it and backs off, instead of both
// racing past a check that only g_clonk_uri (populated inside the reply) would satisfy.
static void clonk_open(void) {
	if (g_clonk_uri[0] || g_clonk_opening || !g_prv) {
		clonk_diag_log("clonk_open: skipped (uri=%s opening=%d)", g_clonk_uri, g_clonk_opening);
		return;
	}
	clonk_diag_log("clonk_open: issuing LSCallOneReply");
	g_clonk_opening = 1;
	LSError e;
	LSErrorInit(&e);
	LSMessageToken t;
	if (!LSCallOneReply(g_prv, "palm://com.palm.mediad/service/clonk", "{}",
	                    clonk_open_reply, NULL, &t, &e)) {
		fprintf(stderr, "wa-call: clonk open call failed: %s\n", e.message);
		LSErrorFree(&e);
		g_clonk_opening = 0; // no reply is coming to clear it for us
	}
}

static bool clonk_stop_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "wa-call: clonk %s: %s\n", (const char *)ctx, LSMessageGetPayload(msg));
	return true;
}

// Drops our reference to the clonk session on call end / video fully off. No confirmed
// explicit session-teardown method (see WHATSAPP_VIDEO_STATUS.md Part 3/5) -- mediaserver
// tears a session down when its *creating* client's LS2 connection drops, which we share
// with the rest of this long-lived service, so we don't disconnect to force that. A fresh
// session is opened next time video starts.
static void clonk_close(void) {
	if (!g_clonk_uri[0]) {
		clonk_diag_log("clonk_close: no-op (no uri open)");
		return;
	}
	clonk_diag_log("clonk_close: tearing down session %s", g_clonk_uri);
	voipkit_video_stop(); // stop our own socket threads before telling mediaserver to stop
	clonk_uri_call_ctx("videoPlayerStop", "{\"args\":[]}", clonk_stop_reply, "videoPlayerStop");
	clonk_uri_call_ctx("videoCaptureStop", "{\"args\":[]}", clonk_stop_reply, "videoCaptureStop");
	g_clonk_uri[0] = 0;
	g_clonk_opening = 0;
}

// Called from Go whenever this call's overall video state flips (see
// gowhatsapp_go_call_changemedia and OnEnd in call.go).
void gowhatsapp_call_video_active(int on) {
	clonk_diag_log("gowhatsapp_call_video_active(%d)", on);
	if (on) clonk_open(); else clonk_close();
}

/* ---------- Go -> C: push callState to subscribers on the mainloop ---------- */
static gboolean push_callstate(gpointer data) {
	char *json = (char *)data;
	g_free(g_last_callstate_json);
	g_last_callstate_json = g_strdup(json);
	publish_callstate_locked(json);
	g_free(json);
	return G_SOURCE_REMOVE;
}
void gowhatsapp_call_on_state(const char *json) {
	// copy now (Go frees its buffer on return) and dispatch onto the mainloop
	g_idle_add(push_callstate, g_strdup(json));
}

/* ---------- audio bridge: ALSA voip/voipsource (routes through PulseAudio) ---------- */
// meowcaller PCM is float32, 16 kHz, mono, 960 samples/frame. "voip"/"voipsource"
// (not "default") -> PA pvoip/pvoipsource, which module-palm-policy routes under the
// phone scenario, so we coexist with audiod/PA (no hw conflict).
#define WA_RATE 16000
#define WA_FRAME 320  /* 20ms mic read chunk (was 960/60ms) — lower capture granularity = less mic->peer delay; still a multiple of the NS 160-sample frame */
#define MIC_RING 16000 /* ~1s of int16 mono */
/* Makeup gain — UNITY. An earlier +gain was based on a standalone `arecord` of voipsource that read
 * quiet (~-29dBFS). But a DUMP of the mic DURING A REAL CALL (CALL_DUMP) showed the call scenario's
 * AGC already drives it ~12dB hotter: -16.8dBFS rms, peaks at 0dBFS. Any makeup gain there just
 * hard-clips (1.5x clipped 2.45% of samples -> the harsh "distorted/tinny" the peer heard). PESQ over
 * the real call mic confirmed unity is best (1.0x: 0% clip, 3.93; 1.5x: 0.9% clip, 3.78). Leave at 1.0
 * unless a future mic route actually captures quiet. */
#define MIC_GAIN 1.0f
static snd_pcm_t *g_play = NULL; // peer -> speaker (written from the sink callback)
static snd_pcm_t *g_cap = NULL;  // mic (read by the capture thread into the ring)
static pthread_t g_cap_thread;
static volatile int g_audio_on = 0;

/* ---- CALL_DUMP: ground-truth capture of the LIVE call audio (the call-scenario mic differs from a
 * standalone arecord — audiod switches routing/DSP when a call is active, which the offline PESQ test
 * can't see). Writes raw s16le/16k/mono. capraw = straight off voipsource (pre-gain); send = what we
 * hand meowcaller (post-gain). Pull + analyze offline. Set 0 for release builds. */
#define CALL_DUMP 0
static FILE *g_dump_capraw = NULL; // written by the C capture thread
static FILE *g_dump_send = NULL;   // written by read_mic (Go thread)

/* AEC_CALIB: auto-tune the echo delay. Dumps the far-end reference (what we play) and the raw pre-AEC
 * mic on the SAME capture-thread clock (via the far-end ring below), and BYPASSES AEC so the mic keeps
 * the full echo. Cross-correlate the two offline -> the peak lag is the render->capture echo delay to
 * bake into WA_AEC_DELAY_MS. One calibration call, one measurement. Set 0 for production. */
#define AEC_CALIB 0
static FILE *g_dump_farend = NULL;

/* TONE_TEST: replace the mic with a synthetic, phase-continuous 1kHz sine in the capture thread. A
 * known steady signal makes "breaking up" unambiguous: the send dump / peer / meowcaller media_out
 * rms must be a rock-steady tone. Any amplitude modulation, gaps, or pitch error isolates WHERE the
 * pipeline breaks (our ring vs encode cadence vs network), independent of the mic + acoustics. 0=off. */
#define TONE_TEST 0
#define TONE_HZ 1000.0
// Mic ring buffer: the capture thread (pure C) fills it; Go PULLS via
// gowhatsapp_call_read_mic (Go->C, always safe). No C-thread->Go calls.
static short g_mic[MIC_RING];
static int g_mic_head = 0, g_mic_tail = 0; // tail=write, head=read
static pthread_mutex_t g_mic_mx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_mic_cv = PTHREAD_COND_INITIALIZER;

/* Far-end ring (calibration only): on_speaker pushes what we play; the capture thread drains it in
 * lockstep with the mic so the two dumps share one clock. */
static short g_far[MIC_RING];
static int g_far_head = 0, g_far_tail = 0;
static pthread_mutex_t g_far_mx = PTHREAD_MUTEX_INITIALIZER;
static void far_push(const short *f, int n) {
	pthread_mutex_lock(&g_far_mx);
	for (int i = 0; i < n; i++) {
		int nt = (g_far_tail + 1) % MIC_RING;
		if (nt == g_far_head) g_far_head = (g_far_head + 1) % MIC_RING; // drop oldest
		g_far[g_far_tail] = f[i];
		g_far_tail = nt;
	}
	pthread_mutex_unlock(&g_far_mx);
}
static void far_pull(short *out, int n) { // pull n samples, zero-padding if the ring underruns
	pthread_mutex_lock(&g_far_mx);
	int i = 0;
	while (i < n && g_far_head != g_far_tail) {
		out[i++] = g_far[g_far_head];
		g_far_head = (g_far_head + 1) % MIC_RING;
	}
	pthread_mutex_unlock(&g_far_mx);
	for (; i < n; i++) out[i] = 0;
}

static int mic_avail(void) {
	int a = g_mic_tail - g_mic_head;
	if (a < 0) a += MIC_RING;
	return a;
}

static snd_pcm_t *pcm_open(const char *dev, snd_pcm_stream_t dir, unsigned int latency_us) {
	snd_pcm_t *h = NULL;
	if (snd_pcm_open(&h, dev, dir, 0) < 0) return NULL;
	// S16_LE, mono, 16k, soft-resample on. latency_us tunes the ALSA buffer: LOW on capture cuts the
	// mic->peer delay, but PLAYBACK needs headroom >= the peer's Opus frame (60ms) or it underruns (choppy).
	if (snd_pcm_set_params(h, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
	                       1, WA_RATE, 1, latency_us) < 0) {
		snd_pcm_close(h);
		return NULL;
	}
	return h;
}

// Capture thread: pure C. Opens both ALSA devices (off the mainloop — snd_pcm_open
// on the pulse plugin can block) then reads mic -> ring buffer. Never calls into Go.
static void *audio_thread(void *arg) {
	(void)arg;
	g_play = pcm_open("voip", SND_PCM_STREAM_PLAYBACK, 120000);   // keep playback headroom (60ms Opus frames) -> no underrun/choppy
	g_cap = pcm_open("voipsource", SND_PCM_STREAM_CAPTURE, 96000); // 96ms: keep most of the latency win over the old 120ms, but enough slack above the 20ms reads that scheduling jitter doesn't xrun (40ms garbled the mic)
	fprintf(stderr, "wa-call: audio %s / %s\n",
	        g_play ? "playback-ok" : "playback-FAIL",
	        g_cap ? "capture-ok" : "capture-FAIL");
	// Optional outbound-mic NS (default OFF — objectively hurts the MLow codec, see denoise.c). When
	// disabled these are no-ops: wa_ns_start creates no handle so wa_ns_process passes the mic through.
	wa_ns_start(WA_RATE);
	wa_aec_start(WA_RATE, WA_AEC_DELAY_MS); // cancel the loudspeaker echo from the mic (speakerphone)
	short buf[WA_FRAME];
	while (g_audio_on && g_cap) {
		snd_pcm_sframes_t r = snd_pcm_readi(g_cap, buf, WA_FRAME);
		if (r < 0) {
			snd_pcm_recover(g_cap, (int)r, 1);
			continue;
		}
		if (TONE_TEST) { // overwrite the mic with a phase-continuous 1kHz sine (known steady signal)
			static double ph = 0.0;
			for (int i = 0; i < r; i++) {
				buf[i] = (short)(8000.0 * sin(ph)); // ~-12dBFS, well below clip
				ph += 2.0 * M_PI * TONE_HZ / WA_RATE;
				if (ph > 2.0 * M_PI) ph -= 2.0 * M_PI;
			}
		}
		if (g_dump_capraw) fwrite(buf, 2, (size_t)r, g_dump_capraw); // raw live mic (or injected tone), pre-gain
		if (g_dump_farend) { // calibration: dump the far-end reference on the mic clock (drain the ring)
			short fbuf[WA_FRAME];
			far_pull(fbuf, (int)r);
			fwrite(fbuf, 2, (size_t)r, g_dump_farend);
		}
		if (!AEC_CALIB)
			wa_aec_process(buf, (int)r); // remove the far-end echo (near-end speech survives) before encode
		wa_ns_process(buf, (int)r);
		pthread_mutex_lock(&g_mic_mx);
		for (int i = 0; i < r; i++) {
			int nt = (g_mic_tail + 1) % MIC_RING;
			if (nt == g_mic_head) g_mic_head = (g_mic_head + 1) % MIC_RING; // drop oldest
			g_mic[g_mic_tail] = buf[i];
			g_mic_tail = nt;
		}
		pthread_cond_signal(&g_mic_cv);
		pthread_mutex_unlock(&g_mic_mx);
	}
	wa_ns_stop();
	wa_aec_stop();
	return NULL;
}

// gowhatsapp_call_read_mic — called from Go (meowcaller's mic source, a Go thread) to
// PULL n float32 samples. Blocks until n are available or audio stops (then silence).
int gowhatsapp_call_read_mic(float *out, int n) {
	pthread_mutex_lock(&g_mic_mx);
	while (g_audio_on && mic_avail() < n)
		pthread_cond_wait(&g_mic_cv, &g_mic_mx);
	int i = 0;
	while (i < n && g_mic_head != g_mic_tail) {
		float v = (float)g_mic[g_mic_head] / 32768.0f * MIC_GAIN;
		if (v > 1.0f) v = 1.0f; else if (v < -1.0f) v = -1.0f; // clamp so the makeup gain can't clip
		out[i++] = v;
		g_mic_head = (g_mic_head + 1) % MIC_RING;
	}
	pthread_mutex_unlock(&g_mic_mx);
	for (; i < n; i++) out[i] = 0.0f; // pad with silence if stopping
	if (g_dump_send) { // what meowcaller actually encodes (post-gain), as s16le
		short s[2048];
		int m = n > 2048 ? 2048 : n;
		for (int k = 0; k < m; k++) s[k] = (short)(out[k] * 32767.0f);
		fwrite(s, 2, (size_t)m, g_dump_send);
	}
	return n;
}

void gowhatsapp_call_on_speaker(const float *frame, int n) {
	snd_pcm_t *h = g_play;
	if (!h || n <= 0) return;
	short buf[2048];
	if (n > 2048) n = 2048;
	for (int i = 0; i < n; i++) {
		float f = frame[i];
		if (f > 1.0f) f = 1.0f;
		if (f < -1.0f) f = -1.0f;
		buf[i] = (short)(f * 32767.0f);
	}
	wa_aec_farend(buf, n); // this is exactly what hits the loudspeaker -> AECM's echo reference
	if (AEC_CALIB) far_push(buf, n); // calibration: mirror it into the ring for the aligned dump
	snd_pcm_sframes_t w = snd_pcm_writei(h, buf, n);
	if (w < 0) snd_pcm_recover(h, (int)w, 1);
}

// Tell audiod there's an active voip call so it enables the phone scenario.
static bool audiod_reply(LSHandle *sh, LSMessage *m, void *ctx) {
	(void)sh; (void)m; (void)ctx;
	return true;
}
static void audiod_send(const char *uri, const char *payload) {
	LSError e;
	LSErrorInit(&e);
	LSMessageToken t;
	if (g_prv && !LSCallOneReply(g_prv, uri, payload, audiod_reply, NULL, &t, &e)) {
		fprintf(stderr, "wa-call: audiod %s failed: %s\n", uri, e.message);
		LSErrorFree(&e);
	}
}
// Is a wired headset/headphone plugged in right now? Read the kernel switch state directly (EVIOCGSW on
// the "headset" input device) — the ground truth. audiod's own /sys/devices/platform/headset-detect nodes
// don't exist on this custom kernel, so we can't rely on it choosing the route; we pick the scenario
// ourselves. We key on SW_HEADPHONE_INSERT only (audio out present); the headset's own mic (bit
// SW_MICROPHONE_INSERT) is deliberately ignored so capture always stays on the tablet mic (see below).
#ifndef SW_HEADPHONE_INSERT
#define SW_HEADPHONE_INSERT 0x02
#endif
#ifndef SW_MAX
#define SW_MAX 0x0f
#endif
static int wa_headset_present(void) {
	int present = 0;
	for (int i = 0; i < 32; i++) {
		char path[32];
		snprintf(path, sizeof path, "/dev/input/event%d", i);
		int fd = open(path, O_RDONLY | O_NONBLOCK);
		if (fd < 0) continue;
		char name[64] = "";
		if (ioctl(fd, EVIOCGNAME(sizeof name), name) >= 0 && strcmp(name, "headset") == 0) {
			unsigned long sw[(SW_MAX / (sizeof(long) * 8)) + 1];
			memset(sw, 0, sizeof sw);
			if (ioctl(fd, EVIOCGSW(sizeof sw), sw) >= 0) {
				present = (sw[SW_HEADPHONE_INSERT / (sizeof(long) * 8)]
				           >> (SW_HEADPHONE_INSERT % (sizeof(long) * 8))) & 1;
			}
			close(fd);
			return present; // the "headset" device is unique — done
		}
		close(fd);
	}
	return present;
}

static gboolean audiod_status_idle(gpointer d) {
	int active = GPOINTER_TO_INT(d);
	if (active) {
		// NB: "id" MUST be a STRING, not an integer. PmBtEngine's HFG (CurrentCallsCallback ->
		// PmBtCreateCallStatusMessage) reads the call "id" as a string via PmBtJsonGetData; an integer makes
		// it log "Failed to find call ID" and drop the call, so BT call audio never sets up. (Skype's call id
		// was a string.) "transport" stays our real service (a 1-byte PmBtEngine patch accepts non-skype).
		audiod_send("palm://com.palm.audio/phone/CallStatusUpdate",
		            "{\"lines\":[{\"state\":\"active\",\"calls\":[{\"id\":\"1\",\"address\":\"whatsapp\",\"origin\":\"outgoing\",\"video\":false,\"transport\":\"com.palm.whatsapp\"}]}]}");
		// The TouchPad has NO earpiece/receiver, so with nothing plugged in we force the LOUDSPEAKER
		// (phone_back_speaker) — audiod would otherwise default an active phone call to the (silent)
		// earpiece scenario. When a headset IS plugged in, use phone_headset: it routes DAC -> headphone
		// while leaving the CAPTURE path untouched (verified: the mic mixer state is byte-identical between
		// the two scenarios), so playback moves to the headset but the mic stays on the tablet — exactly
		// what we want (and headsets here are typically 3-pole/no-mic anyway).
		int headset = wa_headset_present();
		audiod_send("palm://com.palm.audio/phone/setCurrentScenario",
		            headset ? "{\"scenario\":\"phone_headset\"}"
		                    : "{\"scenario\":\"phone_back_speaker\"}");
		fprintf(stderr, "wa-call: audiod voip call ON (%s)\n", headset ? "headset" : "loudspeaker");
	} else {
		audiod_send("palm://com.palm.audio/phone/CallStatusUpdate", "{\"lines\":[]}");
		fprintf(stderr, "wa-call: audiod voip call OFF\n");
	}
	return G_SOURCE_REMOVE;
}

// Raise (or restore) the scheduling priority of EVERY thread in this process. The MLow encoder is
// fast enough (~40ms/60ms frame) but the TouchPad runs ~2x oversubscribed during a call (chatthreader,
// mojodb, WebAppMgr all fighting for the 2 cores, load avg ~4). When one steals a core mid-frame the
// encode slips past its 60ms deadline and the peer hears a dropped frame. Nicing the whole transport
// down for the call's duration lets its encoder thread win that contention. Per-thread because Linux
// nice is per-task and the encoder runs on a migrating Go thread; renice all of /proc/self/task.
static void wa_renice_all_threads(int nice_val) {
	DIR *d = opendir("/proc/self/task");
	if (!d) return;
	struct dirent *e;
	int n = 0;
	while ((e = readdir(d))) {
		if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
		if (setpriority(PRIO_PROCESS, (id_t)atoi(e->d_name), nice_val) == 0) n++;
	}
	closedir(d);
	fprintf(stderr, "wa-call: reniced %d threads to %d\n", n, nice_val);
}

// Called from Go (a goroutine thread) when a call becomes active (1) / ends (0).
// MUST NOT BLOCK — it just starts/stops the audio thread; the ALSA open (which can
// block on the pulse plugin) happens inside that thread. The audiod call is dispatched
// onto the mainloop (LSCall isn't safe off the mainloop thread).
void gowhatsapp_call_audio_active(int on) {
	if (on && !g_audio_on) {
		g_audio_on = 1;
		wa_renice_all_threads(-15); // win CPU contention for the duration of the call
		if (CALL_DUMP) {
			g_dump_capraw = fopen("/media/internal/wacall_capraw.raw", "wb");
			g_dump_send = fopen("/media/internal/wacall_send.raw", "wb");
			fprintf(stderr, "wa-call: CALL_DUMP capraw=%p send=%p\n", (void*)g_dump_capraw, (void*)g_dump_send);
		}
		if (AEC_CALIB) { // echo-delay calibration: aligned mic + far-end dumps, AEC bypassed
			g_dump_capraw = fopen("/media/internal/wacall_capraw.raw", "wb");
			g_dump_farend = fopen("/media/internal/wacall_farend.raw", "wb");
			g_far_head = g_far_tail = 0;
			fprintf(stderr, "wa-call: AEC_CALIB mic=%p farend=%p\n", (void*)g_dump_capraw, (void*)g_dump_farend);
		}
		g_idle_add(audiod_status_idle, GINT_TO_POINTER(1));
		pthread_create(&g_cap_thread, NULL, audio_thread, NULL);
	} else if (!on && g_audio_on) {
		g_idle_add(audiod_status_idle, GINT_TO_POINTER(0));
		g_audio_on = 0;
		wa_renice_all_threads(0); // restore normal priority once the call ends
		pthread_mutex_lock(&g_mic_mx);
		pthread_cond_broadcast(&g_mic_cv); // wake any blocked read_mic
		pthread_mutex_unlock(&g_mic_mx);
		pthread_join(g_cap_thread, NULL); // returns within ~one 60ms read
		if (g_cap) {
			snd_pcm_close(g_cap);
			g_cap = NULL;
		}
		snd_pcm_t *p = g_play;
		g_play = NULL;
		if (p) snd_pcm_close(p);
		// capture thread joined + Go has stopped pulling: safe to close the dump files
		if (g_dump_capraw) { fclose(g_dump_capraw); g_dump_capraw = NULL; }
		if (g_dump_send)   { fclose(g_dump_send);   g_dump_send = NULL; }
		if (g_dump_farend) { fclose(g_dump_farend); g_dump_farend = NULL; }
	}
}

/* ---------- Luna method handlers ---------- */
static bool m_dial(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	const char *p = LSMessageGetPayload(msg);
	char addr[160] = "";
	if (!p || !json_str(p, "address", addr, sizeof addr)) {
		reply(sh, msg, "{\"returnValue\":false,\"errorText\":\"missing address\"}");
		return true;
	}
	int video = json_true(p, "video") ? 1 : 0;
	char *id = gowhatsapp_go_call_dial(addr, video); // Go-malloc'd C string
	char out[256];
	// gowhatsapp_go_call_dial only ever returns "" when mcClient is still nil (WhatsApp
	// calling not yet attached to a connected session -- see call.go). The already-
	// dialing/active dedup case returns "ok" (a truthy, non-empty placeholder id -- the
	// real call id, once known, flows to the UI via the callStateQuery subscription
	// instead), so an empty id here unambiguously means "not ready yet". Give it a real
	// errorText instead of leaving the caller with returnValue:false and nothing to show.
	if (id && id[0]) {
		snprintf(out, sizeof out, "{\"returnValue\":true,\"id\":\"%s\"}", id);
	} else {
		snprintf(out, sizeof out,
		         "{\"returnValue\":false,\"errorText\":\"WhatsApp is still connecting -- try again in a moment\"}");
	}
	if (id) free(id);
	reply(sh, msg, out);
	return true;
}
static bool m_answer(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	const char *p = LSMessageGetPayload(msg);
	char id[128] = "";
	if (!p || !json_str(p, "id", id, sizeof id)) {
		reply(sh, msg, "{\"returnValue\":false,\"errorText\":\"missing id\"}");
		return true;
	}
	int video = json_true(p, "video") ? 1 : 0;
	int rc = gowhatsapp_go_call_answer(id, video);
	reply(sh, msg, rc == 0 ? "{\"returnValue\":true}" : "{\"returnValue\":false}");
	return true;
}
static bool m_disconnect(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	const char *p = LSMessageGetPayload(msg);
	char id[128] = "";
	if (p) json_str(p, "id", id, sizeof id); // may stay "" (numeric/missing) -> hangup all
	fprintf(stderr, "wa-call: disconnect id='%s' payload=%s\n", id, p ? p : "");
	gowhatsapp_go_call_hangup(id); // empty/unmatched id -> hang up all live calls
	reply(sh, msg, "{\"returnValue\":true}");
	return true;
}
static bool m_callstate(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	LSError e;
	LSErrorInit(&e);
	if (!LSSubscriptionAdd(sh, "callState", msg, &e)) {
		fprintf(stderr, "wa-call: LSSubscriptionAdd failed: %s\n", e.message);
		LSErrorFree(&e);
	}
	reply(sh, msg, "{\"returnValue\":true,\"subscribed\":true}");
	return true;
}
static bool m_hangupall(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	gowhatsapp_go_call_hangup_all();
	reply(sh, msg, "{\"returnValue\":true}");
	return true;
}
// Accept-and-ack stubs for verbs the dialer may send (wire up as needed).
static bool m_ok(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	reply(sh, msg, "{\"returnValue\":true}");
	return true;
}
// changeMedia — the Phone app's video on/off toggle (core-apps VideoCall.js/
// AbstractCall.js), params {id, outgoingVideo?, incomingVideo?}. A field's ABSENCE
// means "leave that direction as-is", not "turn it off" — VideoCall.js only sets the
// field it's actually changing (see changeMedia() there). Fire-and-forget like
// dial/answer: the real state change flows back via callStateQuery.
static bool m_changemedia(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)ctx;
	const char *p = LSMessageGetPayload(msg);
	char id[128] = "";
	if (p) json_str(p, "id", id, sizeof id);
	int has_out = p && strstr(p, "\"outgoingVideo\"") != NULL;
	int has_in  = p && strstr(p, "\"incomingVideo\"") != NULL;
	int out_on  = has_out && json_true(p, "outgoingVideo");
	int in_on   = has_in && json_true(p, "incomingVideo");
	gowhatsapp_go_call_changemedia(id, has_out, out_on, has_in, in_on);
	reply(sh, msg, "{\"returnValue\":true}");
	return true;
}

static LSMethod methods[] = {
	{"dial", m_dial},
	{"answer", m_answer},
	{"disconnect", m_disconnect},
	{"hangupAll", m_hangupall},
	{"hangupAllActive", m_hangupall},
	{"hangupAllHeld", m_hangupall},
	{"hangupMMI", m_hangupall},
	{"callStateQuery", m_callstate},
	{"hold", m_ok},
	{"swap", m_ok},
	{"merge", m_ok},
	{"extract", m_ok},
	{"dtmf", m_ok},
	{"dtmfEnd", m_ok},
	{"changeMedia", m_changemedia},
	{"testInjectVideo", m_test_inject_video},
	{"testStopInjectVideo", m_test_stop_inject_video},
	{NULL, NULL},
};

// whatsapp_call_luna_init — register com.palm.whatsapp.call on libpurple's default
// GMainContext. Idempotent: only the first WhatsApp login registers; the service then
// lives for the process lifetime (mirrors signal/purple-presage call.c).
void whatsapp_call_luna_init(void) {
	if (g_registered) return;
	LSError e;
	LSErrorInit(&e);

	if (!LSRegisterPalmService("com.palm.whatsapp.call", &g_psh, &e)) {
		fprintf(stderr, "wa-call: LSRegisterPalmService: %s\n", e.message);
		LSErrorFree(&e);
		return;
	}
	g_pub = LSPalmServiceGetPublicConnection(g_psh);
	g_prv = LSPalmServiceGetPrivateConnection(g_psh);

	if (!LSPalmServiceRegisterCategory(g_psh, "/", methods, methods, NULL, NULL, &e)) {
		fprintf(stderr, "wa-call: RegisterCategory: %s\n", e.message);
		LSErrorFree(&e);
		return;
	}
	// Attach to the GMainContext libpurple already services (no separate loop/thread).
	g_loopRef = g_main_loop_new(g_main_context_default(), FALSE);
	if (!LSGmainAttachPalmService(g_psh, g_loopRef, &e)) {
		fprintf(stderr, "wa-call: GmainAttach: %s\n", e.message);
		LSErrorFree(&e);
		return;
	}
	g_registered = 1;
	fprintf(stderr, "wa-call: com.palm.whatsapp.call up (in-plugin)\n");
}
