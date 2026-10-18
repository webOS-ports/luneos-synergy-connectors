// voipkit.h — C entry points for the native SkypeKit video bridge (voipkit.cpp).
//
// Bridges mediaserver's local SkypeKit RTP sockets (the /tmp/vidrtp_{to,from}_skypekit_key
// abstract Unix sockets — see messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md Parts 10-18)
// to the network peer's RTP stream. Lives in the main plugin process (libteams-personal.so)
// alongside teams_call_luna.c, which drives the clonk session lifecycle (videoCaptureStart/
// videoPlayerStart) and calls voipkit_video_start()/voipkit_video_stop() directly (in-process,
// same pattern as Telegram's call-luna.cpp) at the right points in that sequence. The actual
// network RTP I/O (SRTP/ICE) lives in a separate subprocess, teams_media — teams_video_relay.cpp
// bridges this module's callback API to that subprocess over a UNIX-domain relay socket, since
// teams_media's runtime environment can't satisfy this file's libpalmgstskype.so dependency chain
// (see teams_media.c's top-of-file comment for the full glibc/libstdc++ ABI conflict rationale).
//
// Adapted verbatim from messaging/telegram/plugin/tdlib-purple/voipkit.h — Thread A's decoded
// access units are delivered via a settable callback here instead of a protocol-specific export,
// so this header has no dependency on any particular calling protocol's media stack.
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

// Blocks (up to timeoutMs) until Thread B's own connect to mediaserver actually succeeds; returns
// nonzero if connected, zero on timeout. Call this AFTER voipkit_video_start() and BEFORE firing
// videoPlayerStart — mediaserver's RunVideoHost() outbound dial to Thread A (WHATSAPP_VIDEO_STATUS.md
// Part 17) is a single, non-retried attempt, so any timing slop here silently drops every outgoing
// video frame for the rest of the call with no error anywhere in the logs (found+fixed 2026-08-05:
// this file was missing this call entirely, matching a confirmed live capture where Android's
// video reached webOS fine but webOS sent none back).
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
