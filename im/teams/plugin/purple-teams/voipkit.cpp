// voipkit.cpp — native bridge between mediaserver's local SkypeKit RTP sockets and the network
// peer's RTP stream. Lives in the main plugin process (libteams-personal.so); teams_video_relay.cpp
// drives this via voipkit_set_frame_out_callback / voipkit_video_receive_frame, and itself
// shuttles the RTP-framed H.264 access units across one more hop (a UNIX relay socket) to/from the
// teams_media subprocess, which owns the actual SRTP/ICE network transport (see teams_media.c's
// top-of-file comment for why the network I/O and the clonk bridge can't live in the same process).
// See voipkit.h and messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md (Parts 10-18) for the
// full reverse-engineering trail this is built from.
//
// Adapted verbatim from messaging/telegram/plugin/tdlib-purple/voipkit.cpp (itself adapted from
// messaging/facebook-e2ee/plugin/purple-combined/glue/voipkit.cpp) — identical thread logic;
// Thread A delivers decoded access units via a settable callback
// (voipkit_set_frame_out_callback) rather than a protocol-specific export, so this file has no
// dependency on any particular calling protocol's media stack.
//
// Links directly against the real, extracted libpalmgstskype.so (no public SDK headers exist
// for SkypeKit) via the asm-mangled-symbol binding trick proven in
// messaging/whatsapp/calling/skypekit_send_test.cpp and skypekit_decode_test.cpp — we only need
// our own object layout to be right (sizes, which offset holds what), not the wire format; the
// real compiled code does 100% of the encoding/decoding. Safety property (same as those test
// tools): a layout mistake can only crash THIS process, since mediaserver only ever sees bytes
// that already passed through its own trusted encoder, and only after our own decode calls
// return successfully do we trust what they handed back.
//
// Two threads, one per SkypeKit socket:
//   Thread A ("capture->peer"): binds+listens /tmp/vidrtp_to_skypekit_key (mediaserver dials
//     out here once /tmp/vidrtp_from_skypekit_key has an accepted peer — Part 17), decodes each
//     SendRTPPacket call with the real Sid::Protocol::BinServer, strips the RTP header,
//     reassembles access units via h264_rtp.c, and hands complete ones to the registered callback.
//   Thread B ("peer->display"): connects as a client to /tmp/vidrtp_from_skypekit_key (its mere
//     connection is what unlocks Thread A's dial per Part 17), and on each access unit handed to
//     it via voipkit_video_receive_frame, RTP-packetizes it (h264_rtp.c, with our own local
//     seq/timestamp/SSRC state) and sends each resulting packet as a real RtpPacketReceived
//     call, exactly as skypekit_send_test.cpp proved for one canned payload.

#include <pthread.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <ctime>
#include <unistd.h>

#include "voipkit.h"
#include "h264_rtp.h"

// ---------------- SkypeKit bindings (see skypekit_send_test.cpp / skypekit_decode_test.cpp
// for how each of these was found and confirmed via disassembly + live testing) ----------------
extern "C" {
	void avtw_ctor(void *self) asm("_ZN3Sid18AVTransportWrapperC1Ev");
	void avtw_dtor(void *self) asm("_ZN3Sid18AVTransportWrapperD1Ev");
	int avtw_connect(void *self, const char *name, int isServer, int timeoutMs)
		asm("_ZN3Sid18AVTransportWrapper7ConnectEPKcbi");
	void avtw_terminate(void *self) asm("_ZN3Sid18AVTransportWrapper9terminateEv");

	void binclient_ctor(void *self, void *transport)
		asm("_ZN3Sid8Protocol9BinClientC1EPNS_18TransportInterfaceE");
	int binclient_wr_call_lst(void *self, void *ci, const unsigned int *cmdId,
	                            const char *cmdName, unsigned int *responseIdOut,
	                            void *fields, unsigned int fieldCount, ...)
		asm("_ZN3Sid8Protocol9BinClient11wr_call_lstEPNS_16CommandInitiatorERKjPKcRjPNS_5FieldEjz");
	extern unsigned char M_SkypeVideoRTPInterface_fields[]
		asm("_ZN3Sid5Field31M_SkypeVideoRTPInterface_fieldsE");

	void binserver_ctor(void *self, void *api, void *transport)
		asm("_ZN3Sid8Protocol9BinServerC1EPNS_3ApiEPNS_18TransportInterfaceE");
	int binserver_rd_command(void *self, void *ci, void *command)
		asm("_ZN3Sid8Protocol9BinServer10rd_commandEPNS_16CommandInitiatorERNS0_7CommandE");
	int binserver_rd_call(void *self, void *ci, unsigned int *cmdId, unsigned int *arg2,
	                        unsigned int *arg3)
		asm("_ZN3Sid8Protocol9BinServer7rd_callEPNS_16CommandInitiatorERjS4_S4_");
	int binserver_rd_parms(void *self, void *ci, void *fields, unsigned int fieldIndex, void *buf)
		asm("_ZN3Sid8Protocol9BinServer8rd_parmsEPNS_16CommandInitiatorEPNS_5FieldEjPv");
	extern unsigned char M_SkypeVideoRTPInterfaceCb_fields[]
		asm("_ZN3Sid5Field33M_SkypeVideoRTPInterfaceCb_fieldsE");

	void sebinary_set(void *self, const void *data, unsigned len) asm("_ZN8SEBinary3setEPKvj");
}

// Was 20 (0x14): see WHATSAPP_VIDEO_STATUS.md Part 36 -- traced ProcessCall's real dispatch via
// VideoHost's ELF-relocation vtable dump. RtpPacketReceived's real vtable slot is +0x58, which
// ProcessCall's case 0x13 calls (parses one param via rd_parms, returns without wr_response --
// fire-and-forget, matching this call's known behavior). Case 0x14 calls vtable+0x60
// (StopPlayback), takes no params, and IS request/response -- this was silently invoking
// StopPlayback() with no arguments instead of RtpPacketReceived on every single call.
static const unsigned kRtpPacketReceivedCmdId = 19;
static const unsigned kRtpPacketReceivedFieldIndex = 91;
static const unsigned kSendRTPPacketFieldIndex = 0;
static const unsigned kRtpPayloadType = 96; // confirmed live, Part 15/18 (H.264 dynamic PT)
static const size_t kRtpMtu = 1200;         // conservative local-IPC payload budget for FU-A

// SEBinary's real layout (Part 14/18): +4 data ptr, +8 size, +12 "resizable" flag (nonzero =
// normal/growable). Must be nonzero before the first set() or resize() silently no-ops.
static void sebinary_init(unsigned char *buf) {
	memset(buf, 0, 256);
	*(uint32_t *)(buf + 12) = 1;
}

// ---------------- RTP header helpers ----------------

static void rtp_build_header(unsigned char *hdr, uint16_t seq, uint32_t ts, uint32_t ssrc,
                              int marker) {
	hdr[0] = 0x80;
	hdr[1] = (unsigned char)((marker ? 0x80 : 0) | (kRtpPayloadType & 0x7f));
	hdr[2] = (unsigned char)(seq >> 8);
	hdr[3] = (unsigned char)(seq & 0xff);
	hdr[4] = (unsigned char)(ts >> 24);
	hdr[5] = (unsigned char)(ts >> 16);
	hdr[6] = (unsigned char)(ts >> 8);
	hdr[7] = (unsigned char)(ts & 0xff);
	hdr[8] = (unsigned char)(ssrc >> 24);
	hdr[9] = (unsigned char)(ssrc >> 16);
	hdr[10] = (unsigned char)(ssrc >> 8);
	hdr[11] = (unsigned char)(ssrc & 0xff);
}

static int rtp_parse_header(const unsigned char *pkt, size_t len, int *marker,
                             const unsigned char **payload, size_t *payload_len) {
	if (len < 12) return 0;
	*marker = (pkt[1] & 0x80) ? 1 : 0;
	*payload = pkt + 12;
	*payload_len = len - 12;
	return 1;
}

// ---------------- shared bridge state ----------------

static pthread_t g_thread_a, g_thread_b;
static volatile int g_running = 0;
static volatile int g_thread_a_started = 0; // set the moment thread A enters, before it blocks
// Set once Thread B's own avtw_connect() to mediaserver's /tmp/vidrtp_from_skypekit_key actually
// succeeds (not just once the thread starts). PORTED FROM WHATSAPP'S voipkit.cpp (found+fixed
// 2026-08-05): this codebase's copy was missing both this flag and voipkit_video_wait_thread_b()
// below, so teams_call_luna.c fired videoPlayerStart immediately after voipkit_video_start()
// with no wait at all. CAPTURED LIVE: mediaserver's RunVideoHost() (triggered by videoPlayerStart)
// does a SINGLE, non-retried 500ms-timeout outbound dial to reach Thread A once its own inbound
// side (what Thread B connects to) is satisfied - miss that one window and no video frame we
// capture ever leaves the device for the rest of the call, with no error anywhere in our own
// logs (Thread A still logs "accepted a connection" since OUR listen socket is fine - confirmed
// via a live packet capture: Android's video correctly arrived at webOS, but webOS sent zero
// video bytes back, for a call where every other step - SDP negotiation, ICE, acceptedCallModalities
// - had already been fixed and verified working). See WHATSAPP_VIDEO_STATUS.md Part 17.
static volatile int g_thread_b_connected = 0;
static pthread_mutex_t g_start_mx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_start_cv = PTHREAD_COND_INITIALIZER;

static void (*g_frame_out_cb)(const unsigned char *, unsigned int) = nullptr;

void voipkit_set_frame_out_callback(void (*cb)(const unsigned char *, unsigned int)) {
	g_frame_out_cb = cb;
}

// Thread B's pending-frame handoff: caller overwrites, thread B drains. Live video wants the
// latest frame, not a backlog (see voipkit.h).
static pthread_mutex_t g_pending_mx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_pending_cv = PTHREAD_COND_INITIALIZER;
static unsigned char *g_pending_data = nullptr;
static unsigned int g_pending_len = 0;
static int g_pending_ready = 0;

// ---------------- Thread A: capture -> peer ----------------

static void *thread_a_main(void *) {
	pthread_mutex_lock(&g_start_mx);
	g_thread_a_started = 1;
	pthread_cond_broadcast(&g_start_cv);
	pthread_mutex_unlock(&g_start_mx);

	unsigned char transport[1024];
	unsigned char binserver[1024];
	unsigned char sebinary[256];
	h264_depacketizer depkt;
	h264_depacketizer_init(&depkt);

	for (;;) {
		memset(transport, 0, sizeof(transport));
		avtw_ctor(transport);
		// isServer=true: real bind+listen+poll+accept in one call (Part 17 disassembly of
		// Sid::AVServer::Connect, the same primitive RunVideoHost() itself uses for its own
		// inbound socket) — retries indefinitely at mediaserver's own ~10s cadence until
		// something connects, or until pthread_cancel unwinds us out of the blocking accept.
		int ok = avtw_connect(transport, "/tmp/vidrtp_to_skypekit_key", /*isServer=*/1,
		                       /*timeoutMs=*/10000);
		if (!ok) {
			avtw_dtor(transport);
			continue;
		}
		fprintf(stderr, "tm-call: skypekit thread A accepted a connection\n");

		memset(binserver, 0, sizeof(binserver));
		binserver_ctor(binserver, nullptr, transport);

		for (;;) {
			unsigned char command_buf[16];
			memset(command_buf, 0, sizeof(command_buf));
			int rc0 = binserver_rd_command(binserver, nullptr, command_buf);
			if (rc0 != 0) {
				fprintf(stderr, "tm-call: skypekit thread A rd_command=%d, disconnecting\n", rc0);
				break;
			}
			uint32_t type = *(uint32_t *)command_buf;
			if (type != 0x52) continue; // not a call ('R') — ignore, keep reading

			unsigned int cmdId = 0, arg2 = 0, arg3 = 0;
			int rc1 = binserver_rd_call(binserver, nullptr, &cmdId, &arg2, &arg3);
			if (rc1 != 0) {
				fprintf(stderr, "tm-call: skypekit thread A rd_call=%d, disconnecting\n", rc1);
				break;
			}

			sebinary_init(sebinary);
			int rc2 = binserver_rd_parms(binserver, nullptr, M_SkypeVideoRTPInterfaceCb_fields,
			                               kSendRTPPacketFieldIndex, sebinary);
			if (rc2 != 0) {
				fprintf(stderr, "tm-call: skypekit thread A rd_parms=%d, dropping call\n", rc2);
				continue; // malformed call — drop it, stay connected
			}
			uint8_t *data = *(uint8_t **)(sebinary + 4);
			uint32_t len = *(uint32_t *)(sebinary + 8);
			if (!data || len == 0) continue;

			int marker;
			const unsigned char *payload;
			size_t payload_len;
			if (!rtp_parse_header(data, len, &marker, &payload, &payload_len)) continue;

			const unsigned char *au;
			size_t au_len;
			if (h264_depacketizer_feed(&depkt, payload, payload_len, marker, &au, &au_len)) {
				if (g_frame_out_cb) g_frame_out_cb(au, (unsigned int)au_len);
			}
		}

		fprintf(stderr, "tm-call: skypekit thread A connection closed, re-listening\n");
		avtw_dtor(transport);
		h264_depacketizer_free(&depkt);
		h264_depacketizer_init(&depkt);
		if (!g_running) break;
	}
	return nullptr;
}

// ---------------- Thread B: peer -> display ----------------

struct SendCtx {
	void *binclient;
	uint16_t seq;
	uint32_t ts;
	uint32_t ssrc;
};

static void send_one_packet(void *vctx, const unsigned char *payload, size_t len, int marker) {
	SendCtx *ctx = (SendCtx *)vctx;
	unsigned char pkt[12 + kRtpMtu];
	if (len > kRtpMtu) return; // h264_packetize already respects kRtpMtu; defensive only
	rtp_build_header(pkt, ctx->seq, ctx->ts, ctx->ssrc, marker);
	memcpy(pkt + 12, payload, len);
	ctx->seq++;

	unsigned char sebinary[256];
	sebinary_init(sebinary);
	sebinary_set(sebinary, pkt, (unsigned)(12 + len));

	// wr_call_lst's 3rd/4th params ("cmdId"/"cmdName") are actually consumed as
	// bl_write_bytes(ci, length, data) -- *cmdId* bytes are written raw, unencoded onto the wire
	// starting at the cmdName pointer. The real header format is [0x5a]['R'=0x52][2 LEB128
	// varints]; wr_preencoded_lst's own internal wr_value(&responseId) call appends the 3rd
	// varint automatically. Passing (&cmdId, "RtpPacketReceived") wrote raw bytes of the literal
	// debug string onto the wire -- never a real protocol header. See WHATSAPP_VIDEO_STATUS.md.
	unsigned char header[4];
	header[0] = 0x5a;
	header[1] = 0x52;
	header[2] = 0x00;
	header[3] = (unsigned char)kRtpPacketReceivedCmdId;
	unsigned int headerLen = sizeof(header);
	unsigned int responseId = 0;
	int wr_rc = binclient_wr_call_lst(ctx->binclient, /*ci=*/nullptr, &headerLen, (const char *)header,
	                        &responseId, M_SkypeVideoRTPInterface_fields,
	                        kRtpPacketReceivedFieldIndex, sebinary);
	if (wr_rc != 0) {
		fprintf(stderr, "tm-call: send_one_packet wr_call_lst FAILED rc=%d len=%u\n", wr_rc, (unsigned)len);
	}
}

// Thread B never blocks in a way that needs pthread_cancel to interrupt (see the comment on
// its queue-wait below for why that matters) — every blocking call it makes is naturally
// bounded (avtw_connect's own timeoutMs, or a short usleep), so checking g_running between
// them gives clean, prompt, cancellation-free shutdown.
static void *thread_b_main(void *) {
	unsigned char transport[1024];
	unsigned char binclient[1024];

	while (g_running) {
		memset(transport, 0, sizeof(transport));
		avtw_ctor(transport);
		int connected = 0;
		while (g_running) {
			if (avtw_connect(transport, "/tmp/vidrtp_from_skypekit_key", /*isServer=*/0,
			                   /*timeoutMs=*/500)) {
				connected = 1;
				break;
			}
			avtw_dtor(transport);
			memset(transport, 0, sizeof(transport));
			avtw_ctor(transport);
			usleep(5000);
		}
		if (!connected) { avtw_dtor(transport); continue; }
		fprintf(stderr, "tm-call: skypekit thread B connected to mediaserver\n");
		pthread_mutex_lock(&g_start_mx);
		g_thread_b_connected = 1;
		pthread_cond_broadcast(&g_start_cv);
		pthread_mutex_unlock(&g_start_mx);

		memset(binclient, 0, sizeof(binclient));
		binclient_ctor(binclient, transport);

		SendCtx ctx;
		ctx.binclient = binclient;
		ctx.seq = (uint16_t)(rand() & 0xffff);
		ctx.ts = (uint32_t)time(nullptr);
		ctx.ssrc = ((uint32_t)rand() << 16) ^ (uint32_t)rand();

		int broken = 0;
		while (!broken && g_running) {
			// Wait for a frame with a bounded timeout and an explicit g_running check,
			// rather than an unconditional pthread_cond_wait. This is deliberate: thread B is
			// never pthread_cancel'd (unlike thread A) precisely because cancelling a thread
			// blocked in cond_wait/cond_timedwait re-locks the mutex as part of POSIX's
			// cancellation cleanup, and without a matching pthread_cleanup_push/pop that mutex
			// stays locked forever once the thread exits — deadlocking voipkit_video_stop()'s
			// own later lock of it (hit this live during WhatsApp's bridge development). Every
			// blocking call thread B makes is naturally bounded, so checking g_running between
			// them is enough for clean shutdown without cancellation at all.
			pthread_mutex_lock(&g_pending_mx);
			while (!g_pending_ready && g_running) {
				struct timespec ts;
				ts.tv_sec = time(nullptr) + 1;
				ts.tv_nsec = 0;
				pthread_cond_timedwait(&g_pending_cv, &g_pending_mx, &ts);
			}
			if (!g_running) {
				pthread_mutex_unlock(&g_pending_mx);
				broken = 1;
				break;
			}
			unsigned char *data = g_pending_data;
			unsigned int len = g_pending_len;
			g_pending_data = nullptr;
			g_pending_ready = 0;
			pthread_mutex_unlock(&g_pending_mx);

			h264_packetize(data, len, kRtpMtu, send_one_packet, &ctx);
			free(data);
			ctx.ts += 3000; // 90kHz clock / 30fps, matching the clonk pipeline's fixed framerate
		}

		fprintf(stderr, "tm-call: skypekit thread B disconnected, retrying\n");
		avtw_dtor(transport);
		if (!g_running) break;
	}
	return nullptr;
}

// ---------------- public entry points ----------------

void voipkit_video_start(void) {
	if (g_running) return;
	g_running = 1;
	g_thread_a_started = 0;
	g_thread_b_connected = 0;
	pthread_create(&g_thread_a, nullptr, thread_a_main, nullptr);

	// Best-effort ordering guarantee (Part 17): wait for thread A to at least start running
	// before letting the caller proceed to videoPlayerStart. This doesn't prove bind()+listen()
	// completed (Sid::AVTransportWrapper::Connect does bind+listen+accept as one call, with no
	// intermediate signal), but bind()+listen() are the first, near-instant syscalls inside
	// that call, and videoPlayerStart's own LS2 round-trip + mediaserver's pipeline
	// construction comfortably outlasts that — matching every successful timing this session's
	// live testing already relied on (Part 16/17).
	// time(), not clock_gettime(): clock_gettime pulls in a GLIBC_2.17 symbol version this
	// device's much older libc doesn't have (see vidrtp_sniffer.c for the same finding).
	struct timespec deadline;
	deadline.tv_sec = time(nullptr) + 2;
	deadline.tv_nsec = 0;
	pthread_mutex_lock(&g_start_mx);
	while (!g_thread_a_started) {
		if (pthread_cond_timedwait(&g_start_cv, &g_start_mx, &deadline) != 0) break;
	}
	pthread_mutex_unlock(&g_start_mx);
	usleep(150000); // small additional margin, see comment above

	pthread_create(&g_thread_b, nullptr, thread_b_main, nullptr);
}

// Blocks until Thread B's own connect to mediaserver's /tmp/vidrtp_from_skypekit_key actually
// succeeds, up to timeoutMs. Returns nonzero if connected, zero on timeout (the caller logs and
// proceeds anyway rather than hanging the mainloop indefinitely - a best-effort ordering
// guarantee, not a hard requirement, matching voipkit_video_start()'s own Thread A wait
// philosophy above). PORTED FROM WHATSAPP - see g_thread_b_connected's comment for why this
// exists: unlike Thread A's near-instant bind+listen, Thread B must wait for Thread A to already
// be listening and then complete its own connect-retry loop (up to 500ms per attempt), which a
// fixed short delay before videoPlayerStart cannot reliably outlast.
int voipkit_video_wait_thread_b(int timeoutMs) {
	struct timespec deadline;
	deadline.tv_sec = time(nullptr) + (timeoutMs / 1000);
	deadline.tv_nsec = (long)(timeoutMs % 1000) * 1000000L;
	pthread_mutex_lock(&g_start_mx);
	while (!g_thread_b_connected) {
		if (pthread_cond_timedwait(&g_start_cv, &g_start_mx, &deadline) != 0) break;
	}
	int connected = g_thread_b_connected;
	pthread_mutex_unlock(&g_start_mx);
	return connected;
}

void voipkit_video_stop(void) {
	if (!g_running) return;
	g_running = 0;

	// Thread A spends nearly all its time blocked in a real accept()/read() deep inside the
	// SkypeKit binary's own code, with no g_running check reachable from there — pthread_cancel
	// unwinds it at that cancellation point. Any partially-used AVTransportWrapper/BinServer
	// state is simply abandoned (lives on the cancelled thread's own stack, never reused), which
	// is safe: we never touch that instance again, and the rest of the process is unaffected —
	// the same safety property this whole bridge relies on (WHATSAPP_VIDEO_STATUS.md Part 14).
	//
	// Thread B is deliberately NOT cancelled — see the comment on its queue-wait: cancelling it
	// while blocked in pthread_cond_timedwait would leave g_pending_mx locked forever. It exits
	// on its own via the g_running checks below; broadcasting just wakes it immediately instead
	// of waiting out its up-to-1s poll interval.
	pthread_cancel(g_thread_a);
	pthread_mutex_lock(&g_pending_mx);
	pthread_cond_broadcast(&g_pending_cv);
	pthread_mutex_unlock(&g_pending_mx);

	pthread_join(g_thread_a, nullptr);
	pthread_join(g_thread_b, nullptr);

	pthread_mutex_lock(&g_pending_mx);
	free(g_pending_data);
	g_pending_data = nullptr;
	g_pending_ready = 0;
	pthread_mutex_unlock(&g_pending_mx);
}

void voipkit_video_receive_frame(const unsigned char *access_unit, unsigned int len) {
	if (!g_running || !access_unit || len == 0) return;
	unsigned char *copy = (unsigned char *)malloc(len);
	if (!copy) return;
	memcpy(copy, access_unit, len);

	pthread_mutex_lock(&g_pending_mx);
	free(g_pending_data); // drop any not-yet-sent previous frame — see voipkit.h
	g_pending_data = copy;
	g_pending_len = len;
	g_pending_ready = 1;
	pthread_cond_signal(&g_pending_cv);
	pthread_mutex_unlock(&g_pending_mx);
}
