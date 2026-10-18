// skypekit_send_burst — like skypekit_send_test, but sends MULTIPLE RtpPacketReceived calls
// over ONE persistent connection, mimicking glue/voipkit.cpp's real Thread B usage pattern
// (a single long-lived BinClient connection carrying many calls over the call's lifetime)
// rather than skypekit_send_test's one-shot connect-send-exit. Written to rule out session/
// connection-scoped state inside VideoHost (e.g. a "first packet primes the pipe" gate) that
// a fresh connection per packet would never satisfy.
//
// Build: see build-skypekit-send-burst.sh in this directory (mirrors build-skypekit-send-test.sh).
// Run on-device: LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10 ./skypekit_send_burst <file1> [file2] ...
//   sends each file's raw bytes as one RtpPacketReceived call, in order, ~33ms apart (30fps).

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <csignal>
#include <ucontext.h>
#include <unistd.h>

static void segv_handler(int sig, siginfo_t *si, void *ucontext_v) {
	ucontext_t *uc = (ucontext_t *)ucontext_v;
	fprintf(stderr, "\n!!! SIGSEGV: fault address = %p\n", si->si_addr);
	fprintf(stderr, "!!! pc (r15) = 0x%08lx  lr (r14) = 0x%08lx\n",
	        (unsigned long)uc->uc_mcontext.arm_pc, (unsigned long)uc->uc_mcontext.arm_lr);
	_exit(139);
}

extern "C" {
	void avtw_ctor(void *self) asm("_ZN3Sid18AVTransportWrapperC1Ev");
	int avtw_connect(void *self, const char *name, int isServer, int timeoutMs)
		asm("_ZN3Sid18AVTransportWrapper7ConnectEPKcbi");
	void binclient_ctor(void *self, void *transport)
		asm("_ZN3Sid8Protocol9BinClientC1EPNS_18TransportInterfaceE");
	void sebinary_set(void *self, const void *data, unsigned len) asm("_ZN8SEBinary3setEPKvj");
	int binclient_wr_call_lst(void *self, void *ci, const unsigned int *cmdId,
	                            const char *cmdName, unsigned int *responseIdOut,
	                            void *fields, unsigned int fieldCount, ...)
		asm("_ZN3Sid8Protocol9BinClient11wr_call_lstEPNS_16CommandInitiatorERKjPKcRjPNS_5FieldEjz");
	extern unsigned char M_SkypeVideoRTPInterface_fields[]
		asm("_ZN3Sid5Field31M_SkypeVideoRTPInterface_fieldsE");
	// Sid::Protocol::BinClient::rd_response_id(CommandInitiator*, unsigned int&) -> int.
	// Reads back the server's ack for the most recently sent call. Neither this test tool
	// (until now) nor glue/voipkit.cpp's real Thread B ever called this -- theory: wr_call_lst
	// leaves an unread response queued, and the SECOND call on the same connection then fails
	// (observed: returns 2, not 0) because of that backlog, not because of anything wrong with
	// the call itself.
	int binclient_rd_response_id(void *self, void *ci, unsigned int *responseId)
		asm("_ZN3Sid8Protocol9BinClient14rd_response_idEPNS_16CommandInitiatorERj");
}

static unsigned char g_transport[1024];
static unsigned char g_binclient[1024];

static const unsigned kRtpPacketReceivedCmdId = 19; // was 20 -- wrong firmware (224) decompiled; 305's real cmdId is 19
static const unsigned kFieldTableIndex = 91;

static unsigned char *load_file(const char *path, long *out_len) {
	FILE *f = fopen(path, "rb");
	if (!f) { perror(path); return nullptr; }
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (len <= 0 || len > 65536) { fprintf(stderr, "%s: bad size %ld\n", path, len); fclose(f); return nullptr; }
	unsigned char *buf = (unsigned char *)malloc(len);
	if (fread(buf, 1, len, f) != (size_t)len) { perror("fread"); fclose(f); return nullptr; }
	fclose(f);
	*out_len = len;
	return buf;
}

int main(int argc, char **argv) {
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_sigaction = segv_handler;
	sa.sa_flags = SA_SIGINFO;
	sigaction(SIGSEGV, &sa, nullptr);

	if (argc < 2) {
		fprintf(stderr, "usage: %s <file1> [file2] ...\n", argv[0]);
		return 1;
	}

	memset(g_transport, 0, sizeof(g_transport));
	fprintf(stderr, "constructing AVTransportWrapper...\n");
	avtw_ctor(g_transport);

	fprintf(stderr, "connecting to /tmp/vidrtp_from_skypekit_key as client...\n");
	int ok = avtw_connect(g_transport, "/tmp/vidrtp_from_skypekit_key", /*isServer=*/0, /*timeoutMs=*/2000);
	if (!ok) {
		fprintf(stderr, "AVTransportWrapper::Connect failed (returned %d)\n", ok);
		return 1;
	}
	fprintf(stderr, "connected.\n");

	memset(g_binclient, 0, sizeof(g_binclient));
	binclient_ctor(g_binclient, g_transport);

	for (int i = 1; i < argc; i++) {
		long len = 0;
		unsigned char *payload = load_file(argv[i], &len);
		if (!payload) continue;

		unsigned char sebinary[256];
		memset(sebinary, 0, sizeof(sebinary));
		*(uint32_t *)(sebinary + 12) = 1;
		sebinary_set(sebinary, payload, (unsigned)len);

		// See skypekit_send_burst_reconnect.cpp for the full explanation: vtable+0x14 (called by
		// wr_preencoded_lst as (ci, *cmdIdParam, cmdNameParam)) is really
		// AVTransportWrapper::bl_write_bytes(ci, length, data) -- so these two params are really
		// (length, pre-encoded header bytes), not an integer + a debug string. Real header:
		// ['Z']['R'][varint: unused][varint: real cmdId]; wr_preencoded_lst's own wr_value(responseId)
		// call supplies a 3rd trailing varint automatically, matching rd_call's 3-varint read.
		unsigned char header[4];
		header[0] = 0x5a;
		header[1] = 0x52;
		header[2] = 0x00;
		header[3] = (unsigned char)kRtpPacketReceivedCmdId;
		unsigned int headerLen = sizeof(header);
		unsigned int responseId = 0;
		fprintf(stderr, "[%d/%d] sending %s (%ld bytes)...\n", i, argc - 1, argv[i], len);
		int rc = binclient_wr_call_lst(g_binclient, /*ci=*/nullptr, &headerLen, (const char *)header,
		                                 &responseId, M_SkypeVideoRTPInterface_fields,
		                                 /*fieldCount=*/kFieldTableIndex, sebinary);
		fprintf(stderr, "    wr_call_lst returned %d, responseId=%u\n", rc, responseId);

		// RtpPacketReceived is fire-and-forget (ProcessCall's case 0x13 returns without ever
		// calling wr_response) -- calling rd_response_id here blocks for a ~57s read timeout
		// waiting for an ACK that will never arrive, which was silently eating the entire
		// clonk_probe test window between packets. Don't call it.

		free(payload);
		usleep(33000); // ~30fps spacing, matching real send cadence
	}

	fprintf(stderr, "done, holding connection open 3s before exit...\n");
	sleep(3);
	return 0;
}
