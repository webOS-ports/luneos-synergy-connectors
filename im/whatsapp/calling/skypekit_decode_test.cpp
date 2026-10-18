// skypekit_decode_test — decodes a captured SendRTPPacket call by replaying its exact raw bytes
// through a REAL Sid::Protocol::BinServer (from the real, extracted libpalmgstskype.so), rather
// than hand-parsing the wire format. Same safety property and rationale as skypekit_send_test.cpp
// (WHATSAPP_VIDEO_STATUS.md Part 14): we only need our own object layout to be right, not the wire
// format — the real compiled decoder does 100% of the parsing.
//
// Two local processes talk over a throwaway abstract Unix socket (no dependency on mediaserver):
//   server mode: binds+listens+accepts (AVTransportWrapper::Connect(isServer=true)), constructs a
//     real Sid::Protocol::BinServer around the accepted connection, calls the real rd_call() to
//     decode the command header, then rd_parms() with Sid::Field::M_SkypeVideoRTPInterfaceCb_fields
//     at index 0 (confirmed via disassembly of SendRTPPacket's own encode call, Part 18) to decode
//     the SEBinary payload, and dumps its bytes.
//   client mode: connects, then uses AVTransportWrapper::bl_write_bytes() — a RAW byte writer,
//     bypassing BinClient's own message encoding entirely — to replay the exact captured bytes
//     verbatim onto the wire, byte for byte.
//
// Build: see build-skypekit-decode-test.sh in this directory.
// Run on-device (LD_LIBRARY_PATH required, see Part 14):
//   LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10 ./skypekit_decode_test server /tmp/decode_test_key &
//   LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10 ./skypekit_decode_test client /tmp/decode_test_key vidrtp_to_captured_part17.bin

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
	fprintf(stderr, "!!! r0=0x%08lx r1=0x%08lx r2=0x%08lx r3=0x%08lx\n",
	        (unsigned long)uc->uc_mcontext.arm_r0, (unsigned long)uc->uc_mcontext.arm_r1,
	        (unsigned long)uc->uc_mcontext.arm_r2, (unsigned long)uc->uc_mcontext.arm_r3);
	fprintf(stderr, "!!! r4=0x%08lx r5=0x%08lx r6=0x%08lx r7=0x%08lx\n",
	        (unsigned long)uc->uc_mcontext.arm_r4, (unsigned long)uc->uc_mcontext.arm_r5,
	        (unsigned long)uc->uc_mcontext.arm_r6, (unsigned long)uc->uc_mcontext.arm_r7);
	_exit(139);
}

extern "C" {
	void avtw_ctor(void *self) asm("_ZN3Sid18AVTransportWrapperC1Ev");
	int avtw_connect(void *self, const char *name, int isServer, int timeoutMs)
		asm("_ZN3Sid18AVTransportWrapper7ConnectEPKcbi");
	// bl_write_bytes(CommandInitiator*, unsigned int len, char const* data) -> bool/int.
	// A RAW byte writer — bypasses BinClient's message encoding entirely, used here to replay
	// captured bytes verbatim rather than re-encode them.
	int avtw_bl_write_bytes(void *self, void *ci, unsigned int len, const char *data)
		asm("_ZN3Sid18AVTransportWrapper14bl_write_bytesEPNS_16CommandInitiatorEjPKc");

	void binserver_ctor(void *self, void *api, void *transport)
		asm("_ZN3Sid8Protocol9BinServerC1EPNS_3ApiEPNS_18TransportInterfaceE");
	// rd_command(CommandInitiator*, Command&) -> int (0=ok). Reads exactly 2 raw bytes: byte0
	// must be the fixed sync byte 0x5a ('Z', checked internally — mismatch is an error), byte1
	// is stored into Command's first 4-byte field as the message "type" (e.g. 0x52='R' = call).
	// Confirmed via disassembly of BinCommon::rd_command (Part 18) — ProcessCommands calls this
	// BEFORE rd_call and dispatches on the type byte; skipping it desyncs rd_call's own parsing.
	int binserver_rd_command(void *self, void *ci, void *command)
		asm("_ZN3Sid8Protocol9BinServer10rd_commandEPNS_16CommandInitiatorERNS0_7CommandE");
	// rd_call(CommandInitiator*, unsigned int& cmdId, unsigned int&, unsigned int&) -> int (0=ok)
	int binserver_rd_call(void *self, void *ci, unsigned int *cmdId, unsigned int *arg2, unsigned int *arg3)
		asm("_ZN3Sid8Protocol9BinServer7rd_callEPNS_16CommandInitiatorERjS4_S4_");
	// rd_parms(CommandInitiator*, Field*, unsigned int fieldIndex, void* buf) -> int (0=ok)
	int binserver_rd_parms(void *self, void *ci, void *fields, unsigned int fieldIndex, void *buf)
		asm("_ZN3Sid8Protocol9BinServer8rd_parmsEPNS_16CommandInitiatorEPNS_5FieldEjPv");

	extern unsigned char M_SkypeVideoRTPInterfaceCb_fields[]
		asm("_ZN3Sid5Field33M_SkypeVideoRTPInterfaceCb_fieldsE");
}

static unsigned char g_transport[1024];
static unsigned char g_binserver[1024];
static unsigned char g_sebinary[256];

// SEBinary layout, confirmed via disassembly of SEBinary::resize/set_at_offset (Part 18):
//   +0  unused by these methods
//   +4  malloc'd data pointer
//   +8  current size in bytes
//   +12 "resizable" flag — nonzero means resize() is allowed to grow the buffer; zero means
//       fixed/external and resize() silently no-ops (confirmed the OPPOSITE of Part 14's original
//       guess: field+12=1 means "normal, resizable" not "refcount")
static void dump_bytes(const unsigned char *buf, unsigned int n) {
	for (unsigned int i = 0; i < n; i += 16) {
		fprintf(stderr, "%6u: ", i);
		for (unsigned int j = 0; j < 16; j++) {
			if (i + j < n) fprintf(stderr, "%02x ", buf[i + j]);
			else fprintf(stderr, "   ");
		}
		fprintf(stderr, " ");
		for (unsigned int j = 0; j < 16 && i + j < n; j++) {
			unsigned char c = buf[i + j];
			fputc((c >= 32 && c < 127) ? c : '.', stderr);
		}
		fprintf(stderr, "\n");
	}
}

static int run_server(const char *name) {
	memset(g_transport, 0, sizeof(g_transport));
	avtw_ctor(g_transport);
	fprintf(stderr, "server: binding %s and waiting for client...\n", name);
	int ok = avtw_connect(g_transport, name, /*isServer=*/1, /*timeoutMs=*/10000);
	if (!ok) {
		fprintf(stderr, "server: AVTransportWrapper::Connect(isServer=true) failed (returned %d)\n", ok);
		return 1;
	}
	fprintf(stderr, "server: accepted connection.\n");

	memset(g_binserver, 0, sizeof(g_binserver));
	binserver_ctor(g_binserver, nullptr, g_transport);

	unsigned char command_buf[16];
	memset(command_buf, 0, sizeof(command_buf));
	int rc0 = binserver_rd_command(g_binserver, nullptr, command_buf);
	uint32_t cmd_type = *(uint32_t *)command_buf;
	fprintf(stderr, "rd_command returned %d, type=0x%02x ('%c')\n", rc0, cmd_type,
	        (cmd_type >= 32 && cmd_type < 127) ? (char)cmd_type : '?');

	unsigned int cmdId = 0, arg2 = 0, arg3 = 0;
	int rc = binserver_rd_call(g_binserver, nullptr, &cmdId, &arg2, &arg3);
	fprintf(stderr, "rd_call returned %d, cmdId=%u arg2=%u arg3=%u\n", rc, cmdId, arg2, arg3);

	memset(g_sebinary, 0, sizeof(g_sebinary));
	*(uint32_t *)(g_sebinary + 12) = 1;  // resizable flag, see Part 14/18
	int rc2 = binserver_rd_parms(g_binserver, nullptr, M_SkypeVideoRTPInterfaceCb_fields,
	                               /*fieldIndex=*/0, g_sebinary);
	fprintf(stderr, "rd_parms returned %d\n", rc2);

	uint8_t *data = *(uint8_t **)(g_sebinary + 4);
	uint32_t len = *(uint32_t *)(g_sebinary + 8);
	fprintf(stderr, "decoded SEBinary: data=%p len=%u\n", (void *)data, len);
	if (data && len > 0 && len < 1000000) {
		dump_bytes(data, len);
	}
	return (rc == 0 && rc2 == 0) ? 0 : 1;
}

static int run_client(const char *name, const char *path) {
	FILE *f = fopen(path, "rb");
	if (!f) { perror("fopen"); return 1; }
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
	fseek(f, 0, SEEK_SET);
	unsigned char *payload = (unsigned char *)malloc(len);
	if (fread(payload, 1, len, f) != (size_t)len) { perror("fread"); return 1; }
	fclose(f);
	fprintf(stderr, "client: loaded %ld bytes from %s\n", len, path);

	memset(g_transport, 0, sizeof(g_transport));
	avtw_ctor(g_transport);

	int cfd_ok = 0, attempts = 0;
	for (attempts = 0; attempts < 2000; attempts++) {
		if (avtw_connect(g_transport, name, /*isServer=*/0, /*timeoutMs=*/500)) { cfd_ok = 1; break; }
		memset(g_transport, 0, sizeof(g_transport));
		avtw_ctor(g_transport);
		usleep(5000);
	}
	if (!cfd_ok) {
		fprintf(stderr, "client: connect gave up after %d attempts\n", attempts);
		return 1;
	}
	fprintf(stderr, "client: connected after %d attempts. writing %ld raw bytes...\n", attempts, len);

	int rc = avtw_bl_write_bytes(g_transport, nullptr, (unsigned int)len, (const char *)payload);
	fprintf(stderr, "bl_write_bytes returned %d\n", rc);
	return rc ? 0 : 1;
}

int main(int argc, char **argv) {
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_sigaction = segv_handler;
	sa.sa_flags = SA_SIGINFO;
	sigaction(SIGSEGV, &sa, nullptr);

	if (argc < 3) {
		fprintf(stderr, "usage: %s server <name> | client <name> <file>\n", argv[0]);
		return 1;
	}
	if (strcmp(argv[1], "server") == 0) {
		return run_server(argv[2]);
	} else if (strcmp(argv[1], "client") == 0 && argc >= 4) {
		return run_client(argv[2], argv[3]);
	}
	fprintf(stderr, "bad args\n");
	return 1;
}
