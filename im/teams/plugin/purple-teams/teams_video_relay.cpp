// teams_video_relay.cpp — see teams_video_relay.h. Connects voipkit.cpp's callback-based H.264
// bridge (this process, has LS2/clonk access) to teams_media's raw-RTP relay socket (a separate
// subprocess, owns the actual SRTP/ICE network transport). We build/parse the 12-byte RTP header
// ourselves here (h264_depacketizer_feed/h264_packetize work on the payload only) since this is now
// the ONLY place in the whole call path that needs to know both "this is an RTP packet" and "this
// is an H.264 access unit" at once.

#include "voipkit.h"
#include "h264_rtp.h"
#include "teams_video_relay.h"

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cstdlib>
#include <pthread.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/un.h>

#define TM_RELAY_SOCK "/tmp/teams-video-relay.sock"
static const unsigned kVideoPt = 107;
static const size_t kRtpMtu = 1200;

static int g_relay_fd = -1;
static pthread_t g_reader_thread;
static volatile int g_running = 0;
static h264_depacketizer g_rx_depkt;
static uint16_t g_tx_seq;
static uint32_t g_tx_ts;
static uint32_t g_tx_ssrc;

static bool send_all(int fd, const void *buf, size_t n)
{
	const unsigned char *p = (const unsigned char *)buf;
	while (n) {
		ssize_t w = send(fd, p, n, MSG_NOSIGNAL);
		if (w <= 0) { if (w < 0 && errno == EINTR) continue; return false; }
		p += w; n -= (size_t)w;
	}
	return true;
}

static bool recv_all(int fd, void *buf, size_t n)
{
	unsigned char *p = (unsigned char *)buf;
	size_t got = 0;
	while (got < n) {
		ssize_t r = recv(fd, p + got, n - got, 0);
		if (r <= 0) { if (r < 0 && errno == EINTR) continue; return false; }
		got += (size_t)r;
	}
	return true;
}

static void rtp_build_header(unsigned char *hdr, uint16_t seq, uint32_t ts, uint32_t ssrc, int marker)
{
	hdr[0] = 0x80;
	hdr[1] = (unsigned char)((marker ? 0x80 : 0) | (kVideoPt & 0x7f));
	hdr[2] = (unsigned char)(seq >> 8);
	hdr[3] = (unsigned char)(seq & 0xff);
	hdr[4] = (unsigned char)(ts >> 24);
	hdr[5] = (unsigned char)(ts >> 16);
	hdr[6] = (unsigned char)(ts >> 8);
	hdr[7] = (unsigned char)(ts & 0xff);
	hdr[8]  = (unsigned char)(ssrc >> 24);
	hdr[9]  = (unsigned char)(ssrc >> 16);
	hdr[10] = (unsigned char)(ssrc >> 8);
	hdr[11] = (unsigned char)(ssrc & 0xff);
}

// h264_packetize()'s emit callback: build one RTP packet around the fragment and send it,
// length-prefixed, to teams_media over the relay socket. Runs on skypekit's Thread A.
static void relay_emit(void *ctx, const unsigned char *payload, size_t len, int marker)
{
	(void)ctx;
	if (g_relay_fd < 0 || len > 1500) return;
	unsigned char pkt[12 + 1500];
	rtp_build_header(pkt, g_tx_seq++, g_tx_ts, g_tx_ssrc, marker);
	memcpy(pkt + 12, payload, len);
	uint16_t framelen = (uint16_t)(12 + len);
	unsigned char lenhdr[2] = { (unsigned char)(framelen >> 8), (unsigned char)(framelen & 0xff) };
	if (send_all(g_relay_fd, lenhdr, 2)) send_all(g_relay_fd, pkt, framelen);
}

// skypekit's Thread A callback: one complete access unit from our own camera capture, ready to be
// RTP-packetized and relayed to teams_media for SRTP-encrypt + network send.
static void on_frame_out(const unsigned char *au, unsigned int len)
{
	g_tx_ts += 90000 / 30;   // nominal ~30fps step; one timestamp per frame
	h264_packetize(au, len, kRtpMtu, relay_emit, nullptr);
}

// Reader thread: pulls length-prefixed RTP packets off the relay socket (packets arriving from the
// network peer, already SRTP-decrypted by teams_media), depacketizes, and feeds completed access
// units to skypekit for on-screen display. Exits (and the connection is torn down) on any read
// error/EOF or when teams_video_relay_disconnect() shuts the socket down from under it.
static void *reader_main(void *)
{
	while (g_running) {
		unsigned char lenhdr[2];
		if (!recv_all(g_relay_fd, lenhdr, 2)) break;
		uint16_t framelen = (uint16_t)((lenhdr[0] << 8) | lenhdr[1]);
		if (framelen < 12 || framelen > 1600) break;
		unsigned char pkt[1600];
		if (!recv_all(g_relay_fd, pkt, framelen)) break;
		int marker = (pkt[1] & 0x80) ? 1 : 0;
		const unsigned char *au = nullptr; size_t au_len = 0;
		if (h264_depacketizer_feed(&g_rx_depkt, pkt + 12, framelen - 12, marker, &au, &au_len))
			voipkit_video_receive_frame(au, (unsigned int)au_len);
	}
	fprintf(stderr, "tm-call: video relay reader exiting\n");
	return nullptr;
}

extern "C" int teams_video_relay_connect(void)
{
	if (g_relay_fd >= 0) return 1;   // idempotent

	struct sockaddr_un addr;
	memset(&addr, 0, sizeof addr);
	addr.sun_family = AF_UNIX;
	strncpy(addr.sun_path, TM_RELAY_SOCK, sizeof(addr.sun_path) - 1);

	/* Found+fixed 2026-08-05: this was a SINGLE connect() attempt with no retry at all, racing
	 * teams_media's own relay_listen_start() - for the CALLER role that's deferred until
	 * tm_apply_answer() fires, triggered by the SAME mediaAnswer event that also kicks off this
	 * whole clonk video chain in the plugin process, with no synchronization between the two
	 * processes. CAPTURED LIVE: "video relay connect() failed (is teams_media up?)" still fired on
	 * real test calls even after voipkit_video_wait_thread_b() was added (that only orders the
	 * plugin<->mediaserver bridge, not this separate plugin<->teams_media one) - meaning every
	 * outgoing video frame silently had nowhere to go for the whole call. Retry briefly instead of
	 * giving up on the first attempt; a short blocking retry here is consistent with this same
	 * call chain already blocking up to 3s in voipkit_video_wait_thread_b() right after this. */
	int fd = -1;
	for (int attempt = 0; attempt < 20; attempt++) {
		fd = socket(AF_UNIX, SOCK_STREAM, 0);
		if (fd < 0) { fprintf(stderr, "tm-call: video relay socket() failed\n"); return 0; }
		if (connect(fd, (struct sockaddr *)&addr, sizeof addr) == 0) break;
		close(fd); fd = -1;
		usleep(100000); /* 100ms */
	}
	if (fd < 0) {
		fprintf(stderr, "tm-call: video relay connect() failed after retries (is teams_media up?)\n");
		return 0;
	}

	g_relay_fd = fd;
	g_tx_seq  = (uint16_t)(random() & 0xffff);
	g_tx_ts   = (uint32_t)random();
	g_tx_ssrc = (uint32_t)random();
	h264_depacketizer_init(&g_rx_depkt);
	voipkit_set_frame_out_callback(on_frame_out);

	g_running = 1;
	if (pthread_create(&g_reader_thread, nullptr, reader_main, nullptr) != 0) {
		fprintf(stderr, "tm-call: video relay reader thread create failed\n");
		g_running = 0;
		close(g_relay_fd); g_relay_fd = -1;
		h264_depacketizer_free(&g_rx_depkt);
		return 0;
	}
	fprintf(stderr, "tm-call: video relay connected to %s\n", TM_RELAY_SOCK);
	return 1;
}

extern "C" void teams_video_relay_disconnect(void)
{
	if (g_relay_fd < 0 && !g_running) return;
	g_running = 0;
	if (g_relay_fd >= 0) shutdown(g_relay_fd, SHUT_RDWR);   // unblock the reader thread's recv()
	pthread_join(g_reader_thread, nullptr);
	if (g_relay_fd >= 0) { close(g_relay_fd); g_relay_fd = -1; }
	h264_depacketizer_free(&g_rx_depkt);
	fprintf(stderr, "tm-call: video relay disconnected\n");
}
