// voipkit.h — C entry points for the native SkypeKit video bridge (voipkit.cpp).
//
// Bridges mediaserver's local SkypeKit RTP sockets (the /tmp/vidrtp_{to,from}_skypekit_key
// abstract Unix sockets — see messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md Parts 10-18)
// to libtgvoip's VoIPController, via the VoipKitVideoSource/VoipKitVideoRenderer adapters in
// voipkit-tgvoip.cpp. Called from call-luna.cpp's callLunaOpenClonk/callLunaCloseClonk (see
// that file for the LS2 videoCaptureStart/videoPlayerStart sequencing this depends on).
//
// Adapted from messaging/facebook-e2ee/plugin/purple-combined/glue/voipkit.h — the only
// difference from that version is that Thread A's decoded access units are delivered via a
// settable callback here instead of a hardcoded Go export (this plugin is pure C++, no cgo).
#ifndef VOIPKIT_H
#define VOIPKIT_H

#ifdef __cplusplus
extern "C" {
#endif

// Registers the callback Thread A calls with each complete access unit it reassembles from
// mediaserver's own camera capture pipeline (Annex-B H.264, one call per frame). Must be set
// before voipkit_video_start() — typically once, from VoipKitVideoSource's constructor.
// The passed pointer is only valid for the duration of the call; the callee must copy if it
// needs to retain the data.
void voipkit_set_frame_out_callback(void (*cb)(const unsigned char *access_unit, unsigned int len));

// Starts the bridge for the current call: binds+listens the capture->peer socket
// (/tmp/vidrtp_to_skypekit_key) and blocks until that's confirmed listening, then starts the
// peer->display socket's connect-retry loop (/tmp/vidrtp_from_skypekit_key). Idempotent — a
// second call while already running is a no-op.
//
// MUST be called after videoCaptureStart and BEFORE videoPlayerStart (WHATSAPP_VIDEO_STATUS.md
// Part 17: mediaserver's RunVideoHost() won't dial the outbound socket until something has
// already connected to the inbound one, and won't even attempt the outbound dial until AFTER
// the inbound accept succeeds — the capture->peer listener must be up first so that dial lands).
void voipkit_video_start(void);

// Blocks until Thread B's own connect to mediaserver's /tmp/vidrtp_from_skypekit_key actually
// succeeds, up to timeoutMs. Returns nonzero if connected, zero on timeout (caller should log and
// proceed anyway rather than hanging the mainloop indefinitely -- best-effort ordering guarantee,
// not a hard requirement). Call this AFTER voipkit_video_start() and BEFORE videoPlayerStart:
// unlike Thread A's near-instant bind+listen, Thread B must wait for Thread A to already be
// listening and then complete its own connect-retry loop (up to 500ms per attempt), which
// voipkit_video_start()'s own fixed short margin cannot reliably outlast.
int voipkit_video_wait_thread_b(int timeoutMs);

// Signals both bridge threads to stop and joins them. Idempotent; safe to call even if
// voipkit_video_start was never called or already stopped.
void voipkit_video_stop(void);

// Called with one decoded peer access unit (complete Annex-B H.264, as libtgvoip's
// VideoRenderer::DecodeAndDisplay delivers it via VoipKitVideoRenderer). Copies the bytes (the
// pointer is only valid for the duration of this call) and hands them to the peer->display
// thread; overwrites any not-yet-sent previous frame rather than queueing (live video wants the
// latest frame, not a backlog). No-op if the bridge isn't running.
void voipkit_video_receive_frame(const unsigned char *access_unit, unsigned int len);

#ifdef __cplusplus
}
#endif

#endif
