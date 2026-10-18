// teams_video_relay.h — bridges voipkit.cpp's callback-based H.264 video API to teams_media's
// raw-RTP relay socket (see teams_media.c's top-of-file comment for why this extra hop exists:
// the SRTP/ICE network I/O lives in that separate subprocess, but the clonk/skypekit video bridge
// has to live here, in the main plugin process, since only this process's runtime environment can
// satisfy libpalmgstskype.so's transitive dependency chain).
//
// Wire format on the relay socket (both directions): a 2-byte big-endian length prefix followed
// by exactly one whole RTP packet (12-byte header + H.264 payload) — see teams_media.c.
#ifndef TEAMS_VIDEO_RELAY_H
#define TEAMS_VIDEO_RELAY_H

#ifdef __cplusplus
extern "C" {
#endif

// Connects to teams_media's relay socket, registers our frame-out callback with voipkit.cpp, and
// starts the reader thread that depacketizes inbound RTP video and feeds skypekit's display path.
// Call AFTER voipkit_video_start() (mirrors Telegram's call-luna.cpp ordering: capture must be
// live before we start handing it frames to send). Returns false if the socket isn't there yet
// (teams_media not up / pipeline not built) — caller should treat this as "no video this call"
// rather than retrying forever.
int teams_video_relay_connect(void);

// Stops the reader thread and closes the relay connection. Idempotent. Call BEFORE
// voipkit_video_stop().
void teams_video_relay_disconnect(void);

#ifdef __cplusplus
}
#endif

#endif
