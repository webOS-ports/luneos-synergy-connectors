// voipkit_bridge_selftest.c — standalone smoke test for glue/voipkit.cpp's connection
// lifecycle, run OUTSIDE the full purple-combined/cgo/Go stack (see
// WHATSAPP_VIDEO_STATUS.md's "hook it up properly" plan, verification step 2): drives
// voipkit_video_start()/stop() against the live device and stands in for meowcaller by
// providing gowhatsapp_call_video_frame_out itself (just logs what it receives) and pushing a
// synthetic access unit into voipkit_video_receive_frame() to exercise the send-to-mediaserver
// path. Does NOT touch clonk/videoCaptureStart/videoPlayerStart itself — pair with clonk_probe
// (already extended with the Part 16 field-shift-compensated args) running concurrently, same
// as every other test in this session's WHATSAPP_VIDEO_STATUS.md.
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>

#include "../../facebook-e2ee/plugin/purple-combined/glue/skypekit.h"

// Stands in for call.go's implementation of this Go export.
void gowhatsapp_call_video_frame_out(const char *data, int len) {
	fprintf(stderr, "[selftest] frame_out: %d bytes, first 16:", len);
	int n = len < 16 ? len : 16;
	for (int i = 0; i < n; i++) fprintf(stderr, " %02x", (unsigned char)data[i]);
	fprintf(stderr, "\n");
}

static volatile int g_stop = 0;
static void on_sigint(int sig) { (void)sig; g_stop = 1; }

int main(int argc, char **argv) {
	signal(SIGINT, on_sigint);
	signal(SIGTERM, on_sigint);

	fprintf(stderr, "[selftest] starting voipkit_video_start()...\n");
	voipkit_video_start();
	fprintf(stderr, "[selftest] started. Ctrl-C to stop, or wait %ds.\n", argc > 1 ? atoi(argv[1]) : 30);

	// Push one synthetic access unit a couple of seconds in, to exercise the peer->display
	// (Thread B, RtpPacketReceived) path independent of whether real camera data is flowing.
	int total = argc > 1 ? atoi(argv[1]) : 30;
	for (int i = 0; i < total && !g_stop; i++) {
		sleep(1);
		if (i == 3) {
			unsigned char au[] = {0,0,0,1, 0x67,0x42,0x00,0x0a, 0,0,0,1, 0x68,0xce,0x3c,0x80,
			                        0,0,0,1, 0x65,0x88,0x84,0x21,0xff,0x00,0xaa,0xbb,0xcc};
			fprintf(stderr, "[selftest] pushing synthetic access unit (%zu bytes)...\n", sizeof(au));
			voipkit_video_receive_frame(au, (unsigned int)sizeof(au));
		}
	}

	fprintf(stderr, "[selftest] stopping...\n");
	voipkit_video_stop();
	fprintf(stderr, "[selftest] stopped cleanly.\n");
	return 0;
}
