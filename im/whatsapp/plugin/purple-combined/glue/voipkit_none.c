// voipkit_none.c -- null video backend for targets without libpalmgstskype.so (LuneOS).

//
// The real bridge (voipkit.cpp) binds directly to libpalmgstskype.so, SkypeKit's native RTP
// transport, which ships as a gstreamer-0.10 plugin in the legacy webOS 3.0.5 firmware. LuneOS
// has neither gstreamer-0.10 nor that library, so there is nothing to bind to there.
//
// Rather than thread #ifdefs through call.c's call sequencing, the whole video bridge
// is swapped out at link time: build-combined.sh compiles this file instead of voipkit.cpp when
// WA_VOIPKIT=0, and drops -lpalmgstskype. Everything else in the plugin -- messaging,
// contacts, login, trouter, and voice calling -- is unaffected, so what is lost is video only.
//
// These are deliberately not silent. A call that reaches voipkit_video_start() on a build with
// no bridge is a wiring mistake worth seeing in the log, not something to swallow.
#include <stdio.h>

#include "voipkit.h"

static int s_warned = 0;

static void warn_once(const char *fn)
{
	if (s_warned)
		return;
	s_warned = 1;
	fprintf(stderr, "whatsapp: %s called, but this build has no SkypeKit video bridge "
	                "(libpalmgstskype.so is legacy webOS only). Video is unavailable; "
	                "voice calling is not affected.\n", fn);
}

void voipkit_set_frame_out_callback(void (*cb)(const unsigned char *access_unit, unsigned int len))
{
	(void) cb;   /* nothing will ever produce frames in this build */
}

void voipkit_video_start(void)
{
	warn_once("voipkit_video_start");
}

/*
 * The real implementation returns non-zero once Thread B is up. Returning 0 (timed out) is the
 * honest answer here and is the value call.c already handles: it logs and carries on
 * without video rather than failing the call.
 */
int voipkit_video_wait_thread_b(int timeoutMs)
{
	(void) timeoutMs;
	warn_once("voipkit_video_wait_thread_b");
	return 0;
}

void voipkit_video_stop(void)
{
	/* Called unconditionally on teardown, including when start never ran -- stay quiet. */
}

void voipkit_video_receive_frame(const unsigned char *access_unit, unsigned int len)
{
	(void) access_unit;
	(void) len;
	/* Inbound frames are dropped: there is no renderer without the bridge. */
}
