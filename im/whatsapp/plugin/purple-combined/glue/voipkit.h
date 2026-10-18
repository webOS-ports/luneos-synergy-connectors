// voipkit.h — C entry points for the native SkypeKit video bridge (glue/voipkit.cpp).
//
// Bridges mediaserver's local SkypeKit RTP sockets (the /tmp/vidrtp_{to,from}_skypekit_key
// abstract Unix sockets — see messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md Parts 10-18)
// to meowcaller's Call.SendVideo/ReceiveVideo. Called from glue/call.c's clonk_open/clonk_close
// (see call.c for the LS2 videoCaptureStart/videoPlayerStart sequencing this depends on).
#ifndef VOIPKIT_H
#define VOIPKIT_H

#ifdef __cplusplus
extern "C" {
#endif

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

// Blocks until Thread B's own connect to mediaserver's peer->display socket actually succeeds
// (not just started), up to timeoutMs milliseconds. Returns nonzero if connected, zero on
// timeout. See glue/call.c's clonk_video_capture_start_reply for why this matters: mediaserver's
// clonkvhsrc source element appears to fail its own state change (and tear the whole playback
// pipeline down within ~300ms) if videoPlayerStart fires before Thread B has actually connected —
// unlike the local camera preview, which has no such network dependency and always succeeds.
int voipkit_video_wait_thread_b(int timeoutMs);

// Signals both bridge threads to stop and joins them. Idempotent; safe to call even if
// voipkit_video_start was never called or already stopped.
void voipkit_video_stop(void);

// Called from Go (call.go's Call.ReceiveVideo sink) with one decoded peer access unit —
// complete Annex-B H.264, as meowcaller delivers it. Copies the bytes (the pointer is only
// valid for the duration of this call) and hands them to the peer->display thread; overwrites
// any not-yet-sent previous frame rather than queueing (live video wants the latest frame, not
// a backlog). No-op if the bridge isn't running.
void voipkit_video_receive_frame(const unsigned char *access_unit, unsigned int len);

#ifdef __cplusplus
}
#endif

#endif
