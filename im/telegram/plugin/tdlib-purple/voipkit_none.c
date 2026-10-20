// voipkit_none.c -- stand-in for voipkit.cpp on targets without libpalmgstskype.so.
//
// The real bridge (voipkit.cpp) binds directly to libpalmgstskype.so, SkypeKit's native RTP
// transport, which ships as a gstreamer-0.10 plugin in the legacy webOS 3.0.5 firmware. LuneOS
// has neither gstreamer-0.10 nor that library, so there is nothing to bind to there.
//
// Rather than thread #ifdefs through call-luna.cpp's call sequencing, the whole video bridge
// is swapped out at link time: CMakeLists.txt compiles this file instead of voipkit.cpp when
// SkypeKitFwRootfs is unset, and drops -lpalmgstskype. Everything else in the plugin --
// messaging, contacts, login, secret chats, and voice calling -- is unaffected, so what is lost
// is video only.
//
// This is the same seam purple-combined (WA_VOIPKIT=0) and purple-teams (TEAMS_VOIPKIT=0)
// already use; tdlib-purple was the only one of the three still compiling voipkit.cpp
// unconditionally. That left its SkypeKit references undefined in the finished plugin, and two
// of them are data rather than functions:
//
//   U _ZN3Sid5Field31M_SkypeVideoRTPInterface_fieldsE
//   U _ZN3Sid5Field33M_SkypeVideoRTPInterfaceCb_fieldsE
//
// GModule opens plugins with RTLD_NOW, and the dynamic linker cannot defer a data symbol in any
// case, so libpurple refused to load the plugin at all. Measured on a MindPhone:
//
//   plugins: /usr/lib/purple-2/libtelegram-tdlib.so is not loadable:
//            undefined symbol: _ZN3Sid5Field31M_SkypeVideoRTPInterface_fieldsE
//
// With no prpl registered, purple_find_prpl("prpl-telegram") returned NULL and the transport
// failed every Telegram login before it began ("createPurpleAccount threw ... prpl NOT
// registered"), which reached the account UI as AcctMgr_Generic_Error. So this file is what
// makes Telegram work at all on LuneOS, not merely what disables its video.
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
	fprintf(stderr, "telegram: %s called, but this build has no SkypeKit video bridge "
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
 * honest answer here and is the value call-luna.cpp already handles: it logs and carries on
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
