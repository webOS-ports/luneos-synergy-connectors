// voipkit.cpp — native bridge between mediaserver's local SkypeKit RTP sockets and
// meowcaller's Call.SendVideo/ReceiveVideo. See voipkit.h and
// messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md (Parts 10-18) for the full
// reverse-engineering trail this is built from.
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
//     reassembles access units via h264_rtp.c, and hands complete ones to Go.
//   Thread B ("peer->display"): connects as a client to /tmp/vidrtp_from_skypekit_key (its mere
//     connection is what unlocks Thread A's dial per Part 17), and on each access unit Go hands
//     it via voipkit_video_receive_frame, sends it to mediaserver as-is (no RTP framing --
//     RtpPacketReceived's real handler, despite the name, is a dumb pass-through straight into
//     the H.264 decoder; see the comment on send_access_unit below) via a real RtpPacketReceived
//     call, exactly as skypekit_send_test.cpp proved for one canned payload.

#include <pthread.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cstdarg>
#include <ctime>
#include <sys/time.h>
#include <unistd.h>

#include "voipkit.h"
#include "h264_rtp.h"

extern "C" {
// Implemented in call.go: forwards one complete peer-bound... no, CAMERA-bound access unit
// (decoded from mediaserver's own capture pipeline) to Call.SendVideoWithDuration.
void gowhatsapp_call_video_frame_out(const char *data, int len);
}

// Dedicated diagnostic log, same fopen-per-line/fclose pattern as glue/call.c's
// clonk_diag_log -- guaranteed to actually land on disk (each line is its own open/write/close),
// unlike fprintf(stderr,...) whose delivery to imstdout.log has been observed to silently stall
// after some transport respawns (still-unexplained, see WHATSAPP_VIDEO_STATUS.md Part 36's
// "Also noted" item). This bridge is exactly the layer prior investigation (Parts 30-35)
// repeatedly needed real visibility into and didn't have, so give it its own durable trail.
static void voipkit_diag_log(const char *fmt, ...) {
	FILE *f = fopen("/media/internal/wacall_voipkit.log", "a");
	if (!f) return;
	struct timeval tv;
	gettimeofday(&tv, nullptr);
	fprintf(f, "[%lld] ", (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000);
	va_list ap;
	va_start(ap, fmt);
	vfprintf(f, fmt, ap);
	va_end(ap);
	fprintf(f, "\n");
	fclose(f);
}

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

// Was 20 (0x14): traced ProcessCall's real dispatch via VideoHost's ELF-relocation vtable dump
// (see WHATSAPP_VIDEO_STATUS.md Part 36) -- RtpPacketReceived's real vtable slot is +0x58, which
// ProcessCall's case 0x13 calls (parses one param via rd_parms first, returns without wr_response
// -- fire-and-forget, exactly matching this call's known behavior). Case 0x14 calls vtable+0x60
// (StopPlayback), takes no params, and IS request/response -- every prior call was silently
// invoking StopPlayback() with no arguments instead of RtpPacketReceived.
static const unsigned kRtpPacketReceivedCmdId = 19;
static const unsigned kRtpPacketReceivedFieldIndex = 91;
static const unsigned kSendRTPPacketFieldIndex = 0;

// SEBinary's real layout (Part 14/18): +4 data ptr, +8 size, +12 "resizable" flag (nonzero =
// normal/growable). Must be nonzero before the first set() or resize() silently no-ops.
static void sebinary_init(unsigned char *buf) {
	memset(buf, 0, 256);
	*(uint32_t *)(buf + 12) = 1;
}

// ---------------- RTP header helper (Thread A only -- see send_access_unit for why Thread B
// does not build one) ----------------

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
// Set once Thread B's own avtw_connect() to mediaserver's /tmp/vidrtp_from_skypekit_key
// actually succeeds (not just once the thread starts -- Thread B must wait for Thread A to
// already be listening, then complete its own connect-retry loop, which can take longer than
// Thread A's own near-instant bind+listen). Reuses g_start_mx/g_start_cv rather than adding a
// third mutex/condvar pair, since both signals are only ever waited on sequentially, never
// concurrently, by the same caller (clonk_video_capture_start_reply in call.c).
static volatile int g_thread_b_connected = 0;
static pthread_mutex_t g_start_mx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_start_cv = PTHREAD_COND_INITIALIZER;

// Thread B's pending-frame handoff: Go overwrites, thread B drains. Live video wants the
// latest frame, not a backlog (see voipkit.h).
static pthread_mutex_t g_pending_mx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_pending_cv = PTHREAD_COND_INITIALIZER;
static unsigned char *g_pending_data = nullptr;
static unsigned int g_pending_len = 0;
static int g_pending_ready = 0;

// Diagnostic counters (see voipkit_video_receive_frame / send_access_unit) -- reset in
// voipkit_video_start, summarized in voipkit_video_stop.
static unsigned g_recv_count = 0;
static unsigned g_recv_dropped_not_running = 0;
static unsigned g_recv_overwritten = 0;
static unsigned g_au_sent_count = 0;

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
		fprintf(stderr, "wa-call: skypekit thread A accepted a connection\n");
		voipkit_diag_log("thread A accepted a connection");

		memset(binserver, 0, sizeof(binserver));
		binserver_ctor(binserver, nullptr, transport);

		for (;;) {
			unsigned char command_buf[16];
			memset(command_buf, 0, sizeof(command_buf));
			int rc0 = binserver_rd_command(binserver, nullptr, command_buf);
			if (rc0 != 0) {
				fprintf(stderr, "wa-call: skypekit thread A rd_command=%d, disconnecting\n", rc0);
				break;
			}
			uint32_t type = *(uint32_t *)command_buf;
			if (type != 0x52) continue; // not a call ('R') — ignore, keep reading

			unsigned int cmdId = 0, arg2 = 0, arg3 = 0;
			int rc1 = binserver_rd_call(binserver, nullptr, &cmdId, &arg2, &arg3);
			if (rc1 != 0) {
				fprintf(stderr, "wa-call: skypekit thread A rd_call=%d, disconnecting\n", rc1);
				break;
			}

			sebinary_init(sebinary);
			int rc2 = binserver_rd_parms(binserver, nullptr, M_SkypeVideoRTPInterfaceCb_fields,
			                               kSendRTPPacketFieldIndex, sebinary);
			if (rc2 != 0) {
				fprintf(stderr, "wa-call: skypekit thread A rd_parms=%d, dropping call\n", rc2);
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
				gowhatsapp_call_video_frame_out((const char *)au, (int)au_len);
			}
		}

		fprintf(stderr, "wa-call: skypekit thread A connection closed, re-listening\n");
		avtw_dtor(transport);
		h264_depacketizer_free(&depkt);
		h264_depacketizer_init(&depkt);
		if (!g_running) break;
	}
	return nullptr;
}

// ---------------- Thread B: peer -> display ----------------

// wr_call_lst's 3rd/4th params (declared here as "cmdId"/"cmdName") are NOT an integer + a
// debug string -- vtable+0x14 inside wr_preencoded_lst (called as (ci, *cmdIdParam,
// cmdNameParam)) is really AVTransportWrapper::bl_write_bytes(CommandInitiator*, unsigned int
// length, char const* data), confirmed by mapping AVTransportWrapper's real vtable. So passing
// (&cmdId, "RtpPacketReceived") wrote 19 raw bytes starting from that debug string onto the
// wire -- never a real protocol header at all. The real header BinServer::rd_command/rd_call
// expect is: ['Z'=0x5a]['R'=0x52][3 LEB128 varints], read in this order: ->(unused)
// ->(ProcessCall's dispatch cmdId) ->(echoed back as a request id). wr_preencoded_lst's own
// wr_value(&responseId) call automatically supplies that 3rd varint right after this 4-byte
// buffer, so we only construct the first two varints ourselves.
//
// Also: RtpPacketReceived is fire-and-forget (ProcessCall's case for it returns without ever
// calling wr_response), so rd_response_id must never be called after it -- it blocks for a
// real read timeout (~57s) waiting for an ACK that will never arrive, which (before this was
// understood) silently made every multi-packet test look like a one-shot connection.
//
// CORRECTED (see WHATSAPP_VIDEO_STATUS.md Part 36): the "unmodified end to end" analysis below
// this comment was real but incomplete -- it only traced gst_skype_video_rtp_submit ->
// gst_skype_rtp_src_write -> gst_skype_rtp_src_create, all genuinely custom gst_skype_* code
// that does pass the buffer through unmodified. But gst_skype_rtp_src_create's output feeds a
// *standard, unmodified* GStreamer `rtph264depay` element (clonkvhsrc's internal "depay") before
// ever reaching the decoder -- that stage was missed. Confirmed live: sending raw Annex-B here
// makes `rtph264depay` log "Received invalid RTP payload, dropping" on every single buffer
// (gst_base_rtp_depayload_chain), because it validates real RTP structure. The 12-byte-header-
// corruption theory below was reasoning about symptoms actually caused by the separate cmdId
// bug (19 vs 20, see kRtpPacketReceivedCmdId) that was misrouting every call to StopPlayback()
// instead of RtpPacketReceived() at the time -- not evidence against real RTP framing being
// required. Restored h264_packetize()-based packetization below; clonkvhsrc's own init-time caps
// (`application/x-rtp, clock-rate=90000, payload=96, encoding-name=H264`, confirmed via `strings`
// on the real libpalmgstskype.so) dictate the payload type and clock rate used here.
//
// send_access_unit sends the RAW Annex-B access unit (exactly as voipkit_video_receive_frame
// received it), with NO RTP header and NO RFC 6184 fragmentation. Decompiling the real 305
// firmware end to end (VideoHost::RtpPacketReceived -> gst_skype_video_rtp_submit ->
// gst_skype_rtp_src_write -> its internal queue -> gst_skype_rtp_src_create -> palm_video-
// decoder_chain -> OmxProvideInputBuffer) shows every one of those functions passes the buffer
// through completely unmodified -- none of them ever parses or strips an RTP header. The
// previous code (still in git history) built a real 12-byte RTP header and RFC 6184 FU-A
// fragments via h264_rtp.c's h264_packetize before calling this, which meant every access unit
// reaching the Qualcomm hardware decoder had 12 bytes of RTP header (sequence number,
// timestamp, SSRC bytes) corrupting the start of its H.264 bitstream -- consistent with the
// live "flickering/icon instead of clean video" symptom (some frames survive the corruption,
// most don't). RtpPacketReceived's real role, despite the name, is just "hand me one already-
// reassembled access unit at a time" -- h264_packetize's RFC 6184 framing was never needed here.
static const uint32_t kVideoRtpPayloadType = 96; // clonkvhsrc init-time caps: payload=(int)96
static uint16_t g_tx_seq = 0;
static const uint32_t g_tx_ssrc = 0x53545231; // arbitrary fixed SSRC, internal-only transport
static int g_tx_ts_init = 0;
static struct timeval g_tx_ts_start;

struct rtp_emit_ctx {
	void *binclient;
	uint32_t rtp_ts;
};

static void send_rtp_packet_raw(void *binclient, const unsigned char *pkt, unsigned len) {
	unsigned char sebinary[256];
	sebinary_init(sebinary);
	sebinary_set(sebinary, pkt, len);

	unsigned char header[4];
	header[0] = 0x5a;
	header[1] = 0x52;
	header[2] = 0x00;
	header[3] = (unsigned char)kRtpPacketReceivedCmdId;
	unsigned int headerLen = sizeof(header);
	unsigned int responseId = 0;
	int wr_rc = binclient_wr_call_lst(binclient, /*ci=*/nullptr, &headerLen, (const char *)header,
	                        &responseId, M_SkypeVideoRTPInterface_fields,
	                        kRtpPacketReceivedFieldIndex, sebinary);
	if (wr_rc != 0) {
		fprintf(stderr, "wa-call: send_rtp_packet_raw wr_call_lst FAILED rc=%d len=%u\n", wr_rc, len);
		voipkit_diag_log("send_rtp_packet_raw wr_call_lst FAILED rc=%d len=%u", wr_rc, len);
	}
}

static void emit_rtp_packet(void *ctx_v, const unsigned char *payload, size_t len, int marker) {
	rtp_emit_ctx *ctx = (rtp_emit_ctx *)ctx_v;
	unsigned char pkt[12 + 1400];
	if (len > sizeof(pkt) - 12) len = sizeof(pkt) - 12; // h264_packetize's mtu already bounds this
	pkt[0] = 0x80; // V=2, P=0, X=0, CC=0
	pkt[1] = (unsigned char)((marker ? 0x80 : 0x00) | kVideoRtpPayloadType);
	uint16_t seq = g_tx_seq++;
	pkt[2] = (unsigned char)(seq >> 8);
	pkt[3] = (unsigned char)seq;
	pkt[4] = (unsigned char)(ctx->rtp_ts >> 24);
	pkt[5] = (unsigned char)(ctx->rtp_ts >> 16);
	pkt[6] = (unsigned char)(ctx->rtp_ts >> 8);
	pkt[7] = (unsigned char)ctx->rtp_ts;
	pkt[8] = (unsigned char)(g_tx_ssrc >> 24);
	pkt[9] = (unsigned char)(g_tx_ssrc >> 16);
	pkt[10] = (unsigned char)(g_tx_ssrc >> 8);
	pkt[11] = (unsigned char)g_tx_ssrc;
	memcpy(pkt + 12, payload, len);
	send_rtp_packet_raw(ctx->binclient, pkt, (unsigned)(12 + len));
}

static void send_access_unit(void *binclient, const unsigned char *data, unsigned len) {
	g_au_sent_count++;
	if (g_au_sent_count <= 5 || g_au_sent_count % 30 == 0) {
		voipkit_diag_log("send_access_unit #%u len=%u first_bytes=%02x%02x%02x%02x%02x",
		                   g_au_sent_count, len,
		                   len > 0 ? data[0] : 0, len > 1 ? data[1] : 0, len > 2 ? data[2] : 0,
		                   len > 3 ? data[3] : 0, len > 4 ? data[4] : 0);
	}
	if (!g_tx_ts_init) {
		gettimeofday(&g_tx_ts_start, nullptr);
		g_tx_ts_init = 1;
	}
	struct timeval now;
	gettimeofday(&now, nullptr);
	long long elapsed_us = (long long)(now.tv_sec - g_tx_ts_start.tv_sec) * 1000000LL +
	                       (now.tv_usec - g_tx_ts_start.tv_usec);
	rtp_emit_ctx ctx;
	ctx.binclient = binclient;
	ctx.rtp_ts = (uint32_t)((elapsed_us * 90) / 1000); // 90kHz clock per clonkvhsrc's own caps
	h264_packetize(data, len, /*mtu=*/1400, emit_rtp_packet, &ctx);
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
		fprintf(stderr, "wa-call: skypekit thread B connected to mediaserver\n");
		voipkit_diag_log("thread B connected to mediaserver");
		pthread_mutex_lock(&g_start_mx);
		g_thread_b_connected = 1;
		pthread_cond_broadcast(&g_start_cv);
		pthread_mutex_unlock(&g_start_mx);

		memset(binclient, 0, sizeof(binclient));
		binclient_ctor(binclient, transport);

		while (g_running) {
			// Wait for a frame with a bounded timeout and an explicit g_running check,
			// rather than an unconditional pthread_cond_wait. This is deliberate: thread B is
			// never pthread_cancel'd (unlike thread A) precisely because cancelling a thread
			// blocked in cond_wait/cond_timedwait re-locks the mutex as part of POSIX's
			// cancellation cleanup, and without a matching pthread_cleanup_push/pop that mutex
			// stays locked forever once the thread exits — deadlocking voipkit_video_stop()'s
			// own later lock of it (hit exactly this live during development). Every blocking
			// call thread B makes is naturally bounded, so checking g_running between them is
			// enough for clean shutdown without cancellation at all.
			pthread_mutex_lock(&g_pending_mx);
			while (!g_pending_ready && g_running) {
				struct timespec ts;
				ts.tv_sec = time(nullptr) + 1;
				ts.tv_nsec = 0;
				pthread_cond_timedwait(&g_pending_cv, &g_pending_mx, &ts);
			}
			if (!g_running) {
				pthread_mutex_unlock(&g_pending_mx);
				break;
			}
			unsigned char *data = g_pending_data;
			unsigned int len = g_pending_len;
			g_pending_data = nullptr;
			g_pending_ready = 0;
			pthread_mutex_unlock(&g_pending_mx);

			fprintf(stderr, "wa-call: skypekit thread B sending access unit (%u bytes)\n", len);
			send_access_unit(binclient, data, len);
			free(data);
		}

		avtw_dtor(transport);
		if (!g_running) break;
	}
	return nullptr;
}

// ---------------- public entry points ----------------

void voipkit_video_start(void) {
	voipkit_diag_log("voipkit_video_start ENTRY g_running=%d", g_running);
	if (g_running) return;
	g_running = 1;
	g_thread_a_started = 0;
	g_thread_b_connected = 0;
	g_au_sent_count = 0;
	g_recv_count = 0;
	g_recv_dropped_not_running = 0;
	g_recv_overwritten = 0;
	voipkit_diag_log("voipkit_video_start");
	pthread_create(&g_thread_a, nullptr, thread_a_main, nullptr);

	// Best-effort ordering guarantee (Part 17): wait for thread A to at least start running
	// before letting call.c proceed to videoPlayerStart. This doesn't prove bind()+listen()
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
// succeeds, up to timeoutMs. Returns nonzero if connected, zero on timeout (call.c logs and
// proceeds anyway rather than hanging the mainloop indefinitely -- this is a best-effort
// ordering guarantee, not a hard requirement, matching the existing Thread A wait's own
// philosophy). See the comment on g_thread_b_connected for why this exists: unlike Thread A's
// near-instant bind+listen, Thread B must wait for Thread A to already be listening and then
// complete its own connect-retry loop (up to 500ms per attempt), which a fixed short delay
// before videoPlayerStart cannot reliably outlast.
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
	voipkit_diag_log("voipkit_video_wait_thread_b(%d) -> connected=%d", timeoutMs, connected);
	return connected;
}

void voipkit_video_stop(void) {
	voipkit_diag_log("voipkit_video_stop ENTRY g_running=%d recv accepted=%u "
	                   "dropped_not_running=%u overwritten=%u sent=%u", g_running, g_recv_count,
	                   g_recv_dropped_not_running, g_recv_overwritten, g_au_sent_count);
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
	// while blocked in pthread_cond_timedwait would leave g_pending_mx locked forever (hit this
	// live). It exits on its own via the g_running checks below; broadcasting just wakes it
	// immediately instead of waiting out its up-to-1s poll interval.
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
	if (!g_running || !access_unit || len == 0) {
		if (!g_running && access_unit && len > 0) {
			g_recv_dropped_not_running++;
			if (g_recv_dropped_not_running <= 5 || g_recv_dropped_not_running % 30 == 0) {
				voipkit_diag_log("voipkit_video_receive_frame DROPPED (bridge not running) "
				                   "#%u len=%u", g_recv_dropped_not_running, len);
			}
		}
		return;
	}
	g_recv_count++;
	if (g_recv_count <= 5 || g_recv_count % 30 == 0) {
		voipkit_diag_log("voipkit_video_receive_frame accepted #%u len=%u", g_recv_count, len);
	}
	unsigned char *copy = (unsigned char *)malloc(len);
	if (!copy) return;
	memcpy(copy, access_unit, len);

	pthread_mutex_lock(&g_pending_mx);
	if (g_pending_ready) {
		g_recv_overwritten++;
	}
	free(g_pending_data); // drop any not-yet-sent previous frame — see voipkit.h
	g_pending_data = copy;
	g_pending_len = len;
	g_pending_ready = 1;
	pthread_cond_signal(&g_pending_cv);
	pthread_mutex_unlock(&g_pending_mx);
}
