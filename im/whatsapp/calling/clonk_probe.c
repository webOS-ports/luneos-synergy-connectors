// clonk_probe — persistent-connection test client for com.palm.mediad's "clonk" real-time
// video-call session (the same media engine Skype's video calling used on this hardware,
// see messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md for the full writeup).
//
// WHY THIS EXISTS: probing over one-shot `luna-send` processes is actively misleading for
// this API. Each `luna-send -n 1 ...` opens a new bus connection, waits for one reply, and
// disconnects — but a Clonk session's lifetime is tied to its *creating client's connection*
// (confirmed on-device: killing the luna-send process that created a session immediately
// logged "Stopping session palm://com.palm.mediad.Clonk_NNNN/" in /var/log/messages). Every
// prior "TIMED OUT" on an action method (setVideoCaptureActive, etc.) is confounded by this —
// we can't tell a genuinely hung call from a session that got torn out from under it. This
// tool holds ONE LSHandle for the whole sequence, exactly like a real client (skypem) would.
//
// Sequence: create session -> getDeviceUri -> setDeviceUri -> videoCaptureStart
// {"args":[w,h,fps,bitrate]} -> wait 3s -> getVideoCaptureActive/HasPipeline -> (capture left
// active) -> videoPlayerStart {"args":[w,h]} -> wait 90s (both capture and player active
// concurrently, the whole time a vidrtp_sniffer `server` instance should already be bound to
// /tmp/vidrtp_to_skypekit_key to catch mediaserver's outbound connection attempt — see Part 16)
// -> getVideoPlayerActive/HasPipeline -> videoPlayerStop + videoCaptureStop -> wait 1.5s -> quit.
// Every reply is printed verbatim to stdout/stderr for inspection. Payload shape for every
// action method is {"args":[...]} — see the WHATSAPP_VIDEO_STATUS.md Part 8 writeup for why
// (LunaInterface::getArguments does dom["args"] internally; a bare top-level array parses
// fine but fails that check silently).
//
// Build (cross, from the repo root):
//   see build-clonk-probe.sh in this directory.
//
// Run on-device:
//   ./clonk_probe
//
// Safe to Ctrl-C at any point: mediaserver's session-on-disconnect teardown (the same
// mechanism that confounded the luna-send probing) means killing this process cleans up
// the session server-side automatically.

#include <glib.h>
#include <luna-service2/lunaservice.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static LSHandle *g_sh;
static GMainLoop *g_loop;
static char g_session_uri[256];

// Naive "extract a JSON string field" helper — mirrors glue/call.c's json_true() in spirit
// (this codebase deliberately avoids pulling in a JSON library for small glue/probe tools).
static int extract_string_field(const char *json, const char *key, char *out, size_t outlen) {
	char needle[64];
	snprintf(needle, sizeof(needle), "\"%s\"", key);
	const char *p = strstr(json, needle);
	if (!p) return 0;
	p = strchr(p + strlen(needle), '"');
	if (!p) return 0;
	p++;
	const char *end = strchr(p, '"');
	if (!end) return 0;
	size_t n = (size_t)(end - p);
	if (n >= outlen) n = outlen - 1;
	memcpy(out, p, n);
	out[n] = '\0';
	return 1;
}

static void call_next_ctx(const char *method, const char *payload, LSFilterFunc cb, void *ctx) {
	char uri[512];
	snprintf(uri, sizeof(uri), "%s%s", g_session_uri, method);
	LSError e;
	LSErrorInit(&e);
	fprintf(stderr, "\n>>> CALL %s %s\n", uri, payload);
	if (!LSCallOneReply(g_sh, uri, payload, cb, ctx, NULL, &e)) {
		fprintf(stderr, "!!! LSCallOneReply failed for %s: %s\n", uri, e.message);
		LSErrorFree(&e);
	}
}

static void call_next(const char *method, const char *payload, LSFilterFunc cb) {
	call_next_ctx(method, payload, cb, NULL);
}

static gboolean on_safety_timeout(gpointer data) {
	fprintf(stderr, "\n!!! safety timeout hit — something never replied; quitting\n");
	g_main_loop_quit((GMainLoop *)data);
	return FALSE;
}

// setVideoCaptureActive as a literal method name is confirmed NOT registered ("Unknown
// method... for category /") — but getDeviceUri/getVideoCaptureActive DO work as literal
// per-property getters. So writes likely go through one generic property-set method
// instead of a per-property setXxx. Try the plausible shapes for a generic setter;
// "Unknown method" on a wrong guess is harmless (nothing ever reaches the pipeline).
static bool on_cleanup_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "<<< cleanup (%s) reply: %s\n", (const char *)ctx, LSMessageGetPayload(msg));
	return true;
}

static gboolean do_quit(gpointer data) {
	(void)data;
	fprintf(stderr, "\n=== done, quitting main loop ===\n");
	g_main_loop_quit(g_loop);
	return FALSE;
}

// Set to 1 on the second pass through the player start/stop cycle. Testing a theory from
// disassembly of ClonkSession::processHostEvent's VIDEO_PLAYER_START handler (mediaserver
// 0x6f530): on the *first* call, it lazily calls ClonkPipeline::initializeVPlayPipeline()
// (which builds clonkvhsrc et al) BEFORE it builds a VideoSettings{w,h} and calls
// AbstractClonk::setVideoPlaybackSettings() — an ordering bug, since setVideoPlaybackSettings
// is a pure cache-and-notify (ClonkState::setVideoPlaybackSettings, libmedia-api.so 0x78730)
// that never touches the already-built GStreamer element. That's the direct cause of
// gstskypevideosrc.c:411's "resolution not set on capsfilter" warning found via --gst-debug=4.
// Theory: a second videoPlayerStart, after a videoPlayerStop, might re-trigger lazy
// construction (if stop tears the pipeline down) *after* ClonkState already has the cached
// resolution from the first call's setVideoPlaybackSettings — fixing the ordering as a
// workaround. Untested until this run.
static int g_player_retry_count = 0;

static gboolean do_try_player_start(gpointer data);

static gboolean do_player_cleanup(gpointer data) {
	(void)data;
	// videoPlayerStop: disassembly (libmedia-api.so 0xbb58c-0xbb848) shows exactly one
	// getArguments() call and no unmarshall calls — takes no business params, but still
	// needs the "args" key present (same as videoCaptureStop) or it skips the real call.
	call_next_ctx("videoPlayerStop", "{\"args\":[]}", on_cleanup_reply, "videoPlayerStop");
	// Part 16: capture was never stopped earlier (left active alongside the player — see
	// do_check_status) so it needs stopping here too.
	call_next_ctx("videoCaptureStop", "{\"args\":[]}", on_cleanup_reply, "videoCaptureStop");
	if (g_player_retry_count == 0) {
		g_player_retry_count = 1;
		fprintf(stderr, "(retrying videoPlayerStart once more, to test the lazy-construction ordering theory)\n");
		g_timeout_add(1500, do_try_player_start, NULL);
	} else {
		g_timeout_add(1500, do_quit, NULL);
	}
	return FALSE;
}

static bool on_player_status_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "<<< player status reply: %s\n", LSMessageGetPayload(msg));
	return true;
}

static gboolean do_check_player_status(gpointer data) {
	(void)data;
	call_next("getVideoPlayerActive", "{}", on_player_status_reply);
	call_next("getVideoPlayerHasPipeline", "{}", on_player_status_reply);
	g_timeout_add(2000, do_player_cleanup, NULL);
	return FALSE;
}

static bool on_player_start_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "<<< videoPlayerStart reply (pass %d): %s\n", g_player_retry_count + 1, LSMessageGetPayload(msg));
	// Testing whether GstSkypeInstance::RunVideoHost()/the vidrtp_*_skypekit_key socket
	// setup just needs more time than a 3s window — "resolution not set on capsfilter" may
	// be a one-time non-fatal nag during the READY->PAUSED transition, not necessarily a
	// hard block on RunVideoHost ever starting. Held open much longer this run (25s) instead
	// of immediately checking status/stopping, and this run skips the second player-start
	// retry pass entirely (set g_player_retry_count=1 up front) to keep the session alive
	// and stable for the whole long wait rather than cycling stop/start again.
	// Extended further (Part 15): gst_skype_rtp_src_create's "wrong state (unlocked)"
	// (found via disassembly — libpalmgstskype.so 0x25474+) fires because its GQueue-backed
	// GstPushSrc thread got torn down (unlock()) while blocked waiting for data — almost
	// certainly because our injected RtpPacketReceived call landed right as this fixed
	// 25s window's own videoPlayerStop teardown started, not because of any real bug in
	// the call itself. Extended to 90s to leave a much wider safe window to inject data
	// into well before any teardown begins.
	fprintf(stderr, "(waiting 90s before checking player status — watching for RunVideoHost)\n");
	g_timeout_add(20000, do_check_player_status, NULL);
	return true;
}

static gboolean do_try_player_start(gpointer data) {
	(void)data;
	// videoPlayerStart: disassembly (libmedia-api.so 0xbad10) shows one getArguments() call
	// followed by TWO unmarshallunsigned_long(JValue::operator[](int)) calls at indices 0,1
	// — matching ClonkSession::videoPlayerStart(w,h)'s 2-arg C++ signature. Same
	// {"args":[...]} wrapper as videoCaptureStart (see the getArguments() note above).
	fprintf(stderr, "\n--- videoPlayerStart pass %d ---\n", g_player_retry_count + 1);
	call_next_ctx("videoPlayerStart", "{\"args\":[320,240]}", on_player_start_reply, "videoPlayerStart w/h");
	return FALSE;
}

static bool on_status_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "<<< status reply: %s\n", LSMessageGetPayload(msg));
	return true;
}

static gboolean do_check_status(gpointer data) {
	(void)data;
	call_next("getVideoCaptureActive", "{}", on_status_reply);
	call_next("getVideoCaptureHasPipeline", "{}", on_status_reply);
	// Part 16: found via --gst-debug=4 that videoCaptureStart hard-fails — camsrc's
	// gst_base_src_start() errors "Could not negotiate format" because the "Resolution Caps
	// Filter" element downstream of camsrc ends up with filter caps width=240, height=30 —
	// exactly our own h(240) and fps(30) argument VALUES, not our w(320)/h(240). A stop/start
	// retry pass reproduced the identical broken caps both times (ruling out timing), so this
	// is a genuine value bug, not a cache-timing one.
	//
	// Disassembly of ClonkPipeline::setCamCapsFilter() (mediaserver 0xb1fa0) confirms it:
	// gst_caps_new_simple() is called with width=<VideoSettings-object>+4,
	// height=<VideoSettings-object>+8 (framerate is hardcoded to a literal 30/1, never read
	// from the settings object at all). Matching that against the empirically observed values
	// (+4 held our own h=240, +8 held our own fps=30) means the VideoSettings object's real
	// layout is (+0=w, +4=h, +8=fps, +12=bitrate) — a plain, unshifted copy of our own LS2
	// arguments — and setCamCapsFilter itself reads one field too far for both properties: it
	// should use +0/+4 for width/height, but uses +4/+8 instead.
	//
	// Workaround, since we can only drive this via the LS2 API, not patch the binary: shift
	// our own h/fps argument VALUES by one slot so the buggy +4/+8 reads land on our intended
	// width/height. To get width=320, height=240 in the actual applied caps: put 320 in the
	// h slot and 240 in the fps slot. See do_try_start_candidates below for the actual call.
	fprintf(stderr, "(capture left active; starting player on top of it)\n");
	g_timeout_add(500, do_try_player_start, NULL);
	return FALSE;
}

static bool on_start_candidate_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "<<< start-candidate (%s) reply: %s\n", (const char *)ctx, LSMessageGetPayload(msg));
	return true;
}

static gboolean do_try_start_candidates(gpointer data) {
	(void)data;
	// videoPlayerStart: disassembly shows the same convention as videoCaptureStart — one
	// getArguments() call (name arg is a __PRETTY_FUNCTION__ debug string, not a JSON key),
	// followed by TWO unmarshallunsigned_long(JValue::operator[](int)) calls with indices
	// 0,1 — matching ClonkSession::videoPlayerStart(w,h)'s 2-arg C++ signature.
	//
	// CORRECTED shape: getArguments() (LunaInterface::getArguments, libmedia-api.so
	// 0x74568) parses the raw payload, then does dom["args"] and requires THAT to be an
	// array (pbnjson::JValue::isArray() at 0x74680) — the literal key string "args" lives
	// at .rodata 0x153f5c. A *bare* top-level array parses as valid JSON but fails the
	// isArray() check on dom["args"] (indexing an array by string key isn't an array),
	// silently setting the ok-flag false — exactly the {"returnValue":false} with no
	// error text we were seeing. Real shape is an object wrapper: {"args":[...]}.
	//
	// framerate MUST be 30: gst-inspect-0.10 camsrc shows its 'src' pad template offers
	// exactly three fixed video/x-raw-yuv caps (NV12, framerate=30/1 only, no range):
	// 640x480, 320x240, 160x128. Any other framerate (15 was tried first) fails caps
	// negotiation — confirmed via mediaserver --gst-debug=4: "Could not negotiate format,
	// gstbasesrc.c(2823): gst_base_src_start ()" / ClonkPipeline.cpp busMsg_ERROR. (The
	// caps' own "framerate" field is actually hardcoded to a literal 30/1 by
	// setCamCapsFilter — see Part 16 — so this no longer needs to literally be 30 for that
	// reason, but camsrc's pad template only ever offers 30fps regardless, so it stays 30.)
	//
	// Part 16 field-shift workaround: setCamCapsFilter reads width/height from the
	// VideoSettings object's +4/+8 (should be +0/+4), which — since the object is a plain
	// unshifted copy of these very args (+0=w,+4=h,+8=fps,+12=bitrate) — means the applied
	// caps get width=<our h arg>, height=<our fps arg>. To land width=320,height=240 in the
	// actual caps, put 320 in the h slot and 240 in the fps slot.
	call_next_ctx("videoCaptureStart", "{\"args\":[320,320,240,400000]}",
	              on_start_candidate_reply, "videoCaptureStart w/h/fps/bitrate (fields 1,2 shift-compensated)");
	fprintf(stderr, "(waiting 3s before checking status)\n");
	g_timeout_add(3000, do_check_status, NULL);
	return FALSE;
}

static bool on_set_device_uri_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "<<< setDeviceUri reply: %s\n", LSMessageGetPayload(msg));
	do_try_start_candidates(NULL);
	return true;
}

static bool on_device_uri_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	fprintf(stderr, "<<< getDeviceUri reply: %s\n", LSMessageGetPayload(msg));
	// Theory: getDeviceUri's default value may just be a display default, with no capture
	// device actually resolved/attached until setDeviceUri is explicitly called once.
	// setDeviceUri uses the same {"args":[...]} wrapper as videoCaptureStart (see the
	// getArguments() note above) — a single-element array holding the string.
	call_next_ctx("setDeviceUri", "{\"args\":[\"device://camera/front\"]}", on_set_device_uri_reply, "setDeviceUri");
	return true;
}

static bool on_create_session_reply(LSHandle *sh, LSMessage *msg, void *ctx) {
	(void)sh; (void)ctx;
	const char *payload = LSMessageGetPayload(msg);
	fprintf(stderr, "<<< create session reply: %s\n", payload);
	if (!extract_string_field(payload, "location", g_session_uri, sizeof(g_session_uri))) {
		fprintf(stderr, "!!! no \"location\" in reply, aborting\n");
		g_main_loop_quit(g_loop);
		return true;
	}
	fprintf(stderr, "session: %s\n", g_session_uri);
	call_next("getDeviceUri", "{}", on_device_uri_reply);
	return true;
}

int main(void) {
	LSError e;
	LSErrorInit(&e);

	if (!LSRegister("com.palm.whatsapp.videoprobe", &g_sh, &e)) {
		fprintf(stderr, "LSRegister failed: %s\n", e.message);
		LSErrorFree(&e);
		return 1;
	}
	g_loop = g_main_loop_new(g_main_context_default(), FALSE);
	if (!LSGmainAttach(g_sh, g_loop, &e)) {
		fprintf(stderr, "LSGmainAttach failed: %s\n", e.message);
		LSErrorFree(&e);
		return 1;
	}

	LSError e2;
	LSErrorInit(&e2);
	fprintf(stderr, ">>> CALL palm://com.palm.mediad/service/clonk {}\n");
	if (!LSCallOneReply(g_sh, "palm://com.palm.mediad/service/clonk", "{}",
	                    on_create_session_reply, NULL, NULL, &e2)) {
		fprintf(stderr, "!!! create session call failed: %s\n", e2.message);
		LSErrorFree(&e2);
		return 1;
	}

	// Overall safety net: never run longer than 30s even if something never replies.
	// (Sequence now covers both capture and player start/status/stop, ~13s of scheduled
	// waits alone plus LS2 round-trip overhead.)
	// Total sequence budget: ~3s + 0.5s + 90s (capture+player both active concurrently) +
	// ~2s + 1.5s (cleanup) ~= 97s. 150s leaves comfortable margin.
	g_timeout_add(150000, on_safety_timeout, g_loop);
	g_main_loop_run(g_loop);

	LSError e3;
	LSErrorInit(&e3);
	LSUnregister(g_sh, &e3);
	return 0;
}
