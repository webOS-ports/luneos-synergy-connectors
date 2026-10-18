// skypekit_send_burst_reconnect — variant of skypekit_send_burst that RECONNECTS (fresh
// AVTransportWrapper + BinClient) before every single packet, instead of holding one
// persistent connection for the whole burst. Written to test the theory (confirmed via strace
// on skypekit_send_burst: packet 1's write() to the socket succeeds, every packet after that
// gets EPIPE) that the server closes its end of the connection after handling exactly one
// wr_call_lst call, so a real sender must reconnect per packet.
//
// Build: see build-skypekit-send-test.sh, same invocation with this file instead.
// Run on-device: LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10 ./skypekit_send_burst_reconnect <file1> [file2] ...

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

	for (int i = 1; i < argc; i++) {
		long len = 0;
		unsigned char *payload = load_file(argv[i], &len);
		if (!payload) continue;

		memset(g_transport, 0, sizeof(g_transport));
		avtw_ctor(g_transport);
		int ok = avtw_connect(g_transport, "/tmp/vidrtp_from_skypekit_key", /*isServer=*/0, /*timeoutMs=*/2000);
		if (!ok) {
			fprintf(stderr, "[%d/%d] connect failed\n", i, argc - 1);
			free(payload);
			avtw_dtor(g_transport);
			continue;
		}

		memset(g_binclient, 0, sizeof(g_binclient));
		binclient_ctor(g_binclient, g_transport);

		unsigned char sebinary[256];
		memset(sebinary, 0, sizeof(sebinary));
		*(uint32_t *)(sebinary + 12) = 1;
		sebinary_set(sebinary, payload, (unsigned)len);

		// vtable+0x14 (called by wr_preencoded_lst as (ci, *cmdIdParam, cmdNameParam)) is really
		// AVTransportWrapper::bl_write_bytes(CommandInitiator*, unsigned int length, char const*
		// data) -- confirmed via vtable slot mapping. So the "cmdId"/"cmdName" args to
		// wr_call_lst are actually (length, pre-encoded header bytes), not an integer + a debug
		// string. rd_command/rd_call (server side) expect: ['Z'=0x5a] ['R'=0x52] then three
		// LEB128 varints (read order: ->uStack_28 (unused by ProcessCall), ->local_2c (the real
		// dispatch cmdId), ->local_24 (echoed back as a request/response id)). Build that buffer
		// ourselves instead of passing a raw int + string.
		// wr_preencoded_lst automatically calls wr_value(this,ci,&responseId) right after this
		// header is written (writing *responseId as one more LEB128 byte before the field
		// data) -- that's likely rd_call's 3rd varint, not an extra/duplicate byte. So the
		// header we hand-construct should be only 4 bytes; the 5th (responseId) comes from
		// wr_call_lst's own responseId out-param automatically.
		unsigned char header[4];
		header[0] = 0x5a; // 'Z' -- rd_command's required first byte
		header[1] = 0x52; // 'R' -- rd_command's second byte, checked == 0x52 by ProcessCommands
		header[2] = 0x00; // 1st varint (uStack_28, unused)
		header[3] = (unsigned char)kRtpPacketReceivedCmdId; // 2nd varint -- real ProcessCall dispatch value
		unsigned int headerLen = sizeof(header);
		unsigned int responseId = 0;
		fprintf(stderr, "[%d/%d] sending %s (%ld bytes) on a FRESH connection...\n", i, argc - 1, argv[i], len);
		int rc = binclient_wr_call_lst(g_binclient, /*ci=*/nullptr, &headerLen, (const char *)header,
		                                 &responseId, M_SkypeVideoRTPInterface_fields,
		                                 /*fieldCount=*/kFieldTableIndex, sebinary);
		fprintf(stderr, "    wr_call_lst returned %d, responseId=%u\n", rc, responseId);

		// RtpPacketReceived is fire-and-forget -- rd_response_id would block ~57s waiting for
		// an ACK that never comes. Don't call it (see skypekit_send_burst.cpp for the story).

		free(payload);
		avtw_dtor(g_transport);
		usleep(33000); // ~30fps spacing, matching real send cadence
	}

	fprintf(stderr, "done.\n");
	return 0;
}
