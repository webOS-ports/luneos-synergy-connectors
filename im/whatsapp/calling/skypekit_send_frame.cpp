// skypekit_send_frame — tests VideoHost::FrameReceived(SEBinary const&, int) instead of
// RtpPacketReceived(SEBinary const&). Discovered via ProcessCall's dispatcher (case 0x22 ->
// cmdId 34, field table index 0x5c=92, vtable+0x5c) that VideoHost implements a SECOND,
// parallel receive method taking a COMPLETE access unit (no RTP header framing at all) plus an
// int flag, mirroring SendFrame(SEBinary const&, int) on the outbound Cb side. This sidesteps
// the whole RTP-packetization approach (RtpPacketReceived, cmdId 19) entirely -- send one raw
// Annex-B access unit per call instead of MTU-fragmented RTP packets.
//
// Build: see build-skypekit-send-test.sh pattern, same invocation with this file instead.
// Run on-device: LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10 ./skypekit_send_frame <access-unit-file> [flag]

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
	void avtw_dtor(void *self) asm("_ZN3Sid18AVTransportWrapperD1Ev");
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
	int binclient_rd_response_id(void *self, void *ci, unsigned int *responseId)
		asm("_ZN3Sid8Protocol9BinClient14rd_response_idEPNS_16CommandInitiatorERj");
}

static unsigned char g_transport[1024];
static unsigned char g_binclient[1024];

static const unsigned kFrameReceivedCmdId = 34;   // case 0x22 in ProcessCall
static const unsigned kFrameReceivedFieldIndex = 92; // 0x5c

static unsigned char *load_file(const char *path, long *out_len) {
	FILE *f = fopen(path, "rb");
	if (!f) { perror(path); return nullptr; }
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (len <= 0 || len > 1000000) { fprintf(stderr, "%s: bad size %ld\n", path, len); fclose(f); return nullptr; }
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
		fprintf(stderr, "usage: %s <access-unit-file> [int-flag]\n", argv[0]);
		return 1;
	}
	unsigned int flag = (argc >= 3) ? (unsigned int)atoi(argv[2]) : 1;

	long len = 0;
	unsigned char *payload = load_file(argv[1], &len);
	if (!payload) return 1;

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

	unsigned char sebinary[256];
	memset(sebinary, 0, sizeof(sebinary));
	*(uint32_t *)(sebinary + 12) = 1;
	sebinary_set(sebinary, payload, (unsigned)len);

	unsigned int cmdId = kFrameReceivedCmdId;
	unsigned int responseId = 0;
	fprintf(stderr, "sending %s (%ld bytes) as FrameReceived, flag=%u...\n", argv[1], len, flag);
	int rc = binclient_wr_call_lst(g_binclient, /*ci=*/nullptr, &cmdId, "FrameReceived",
	                                 &responseId, M_SkypeVideoRTPInterface_fields,
	                                 /*fieldCount=*/kFrameReceivedFieldIndex, sebinary, &flag);
	fprintf(stderr, "    wr_call_lst returned %d, responseId=%u\n", rc, responseId);

	unsigned int ackId = 0;
	int rrc = binclient_rd_response_id(g_binclient, /*ci=*/nullptr, &ackId);
	fprintf(stderr, "    rd_response_id returned %d, ackId=%u\n", rrc, ackId);

	free(payload);
	fprintf(stderr, "done, holding connection open 3s before exit...\n");
	sleep(3);
	return 0;
}
