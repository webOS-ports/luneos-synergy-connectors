// skypekit_send_test — sends one real RtpPacketReceived RPC call to mediaserver's SkypeKit
// server socket, using mediaserver's own compiled encoder (libpalmgstskype.so) rather than a
// hand-reconstructed byte format.
//
// WHY THIS EXISTS: WHATSAPP_VIDEO_STATUS.md Part 12 proved live connectivity to
// /tmp/vidrtp_from_skypekit_key (mediaserver = server, we = client). Part 13 decoded the
// Sid::Protocol::BinClient wire framing far enough to see it's generic and table-driven
// (16-byte Field entries, each embedding its own reader/writer/skipper function pointer) —
// correct enough to reimplement by hand, but risky to get byte-perfect through pure
// disassembly. Instead of reconstructing the wire bytes ourselves, this links directly
// against the real libpalmgstskype.so and calls its actual, already-correct, compiled C++
// functions with our own arguments. We only need the C++ object layout (sizes, which offset
// holds what) to be right, not the wire format — the real code does 100% of the encoding.
//
// Safety property: any mistake in our reconstructed object layout can only crash *this*
// process. mediaserver only ever sees whatever bytes we successfully write to the socket —
// if our call into the real encoder doesn't crash, the bytes it produces are exactly as
// valid as if mediaserver's own SkypeKit peer had produced them, since it's the same code.
//
// Command ID confirmed via disassembly cross-reference (Part 13): VideoHost::RtpPacketReceived
// (libpalmgstskype.so 0x382c4) sits at vtable slot 22 (relocation-table verified, since this
// shared library's vtables are populated by R_ARM_ABS32 relocations at load time, not literal
// file bytes). Cross-referenced against Sid::SkypeVideoRTPInterfaceServer::ProcessCall's
// jump table by finding which of its 34 branches calls that exact vtable offset (0x58) —
// found at jump-table index 19, i.e. cmdId 20. The field descriptor for its one SEBinary
// parameter lives in the shared Sid::Field::M_SkypeVideoRTPInterface_fields table (a real,
// exported symbol — confirmed via a live R_ARM_GLOB_DAT relocation lookup, not guessed) at
// index 91 (16 bytes/entry), matching the "count=91" passed to BinServer::rd_parms at
// ProcessCall's cmdId=20 branch (libpalmgstskype.so 0x3b448-0x3b490).
//
// Build (cross, from the repo root): see build-skypekit-send-test.sh in this directory.
// Run on-device AFTER a session has videoPlayerStart running long enough for the socket to
// come up (confirmed ~4-10s in Part 12 testing, mediaserver retries every 10s regardless):
//   ./skypekit_send_test <file-with-raw-h264-or-test-bytes>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <csignal>
#include <ucontext.h>
#include <unistd.h>

// Diagnostic only: gdb remote debugging has been unreliable all session (see
// WHATSAPP_VIDEO_STATUS.md Part 6/13) and this device's strace is too old to decode
// siginfo's fault address. Print it ourselves instead of guessing blind.
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
	// Sid::AVTransportWrapper::AVTransportWrapper() — default ctor, no args beyond `this`.
	void avtw_ctor(void *self) asm("_ZN3Sid18AVTransportWrapperC1Ev");
	// Sid::AVTransportWrapper::Connect(char const*, bool, int) -> bool (nonzero = success)
	int avtw_connect(void *self, const char *name, int isServer, int timeoutMs)
		asm("_ZN3Sid18AVTransportWrapper7ConnectEPKcbi");

	// Sid::Protocol::BinClient::BinClient(Sid::TransportInterface*) — assumes single
	// inheritance (AVTransportWrapper* usable directly as TransportInterface* with zero
	// offset adjustment) since AVTransportWrapper's own vtable showed no secondary-vtable
	// thunk pattern. If this assumption is wrong, the failure mode is a crash in *this*
	// process, not malformed bytes reaching mediaserver (see safety note above).
	void binclient_ctor(void *self, void *transport)
		asm("_ZN3Sid8Protocol9BinClientC1EPNS_18TransportInterfaceE");

	// SEBinary::set(void const*, unsigned) — copies/owns the given bytes.
	void sebinary_set(void *self, const void *data, unsigned len) asm("_ZN8SEBinary3setEPKvj");

	// Sid::Protocol::BinClient::wr_call_lst(CommandInitiator*, unsigned int const& cmdId,
	//   char const* cmdName, unsigned int& responseIdOut, Field* fields, unsigned int
	//   fieldCount, ...) — the real call encoder. SendRTPPacket's own (working, disassembled)
	// call passes ci=NULL and fieldCount=0, trusting the Field table's own embedded
	// structure to describe how many fields follow — matched exactly here.
	int binclient_wr_call_lst(void *self, void *ci, const unsigned int *cmdId,
	                            const char *cmdName, unsigned int *responseIdOut,
	                            void *fields, unsigned int fieldCount, ...)
		asm("_ZN3Sid8Protocol9BinClient11wr_call_lstEPNS_16CommandInitiatorERKjPKcRjPNS_5FieldEjz");

	// The shared field table for the whole SkypeVideoRTPInterface. RtpPacketReceived's own
	// one-field (SEBinary) descriptor starts at index 91 (16 bytes/entry) within it.
	extern unsigned char M_SkypeVideoRTPInterface_fields[]
		asm("_ZN3Sid5Field31M_SkypeVideoRTPInterface_fieldsE");
}

// Generously over-sized opaque buffers — safe for placement construction even without
// knowing the real sizeof() for these classes (no real header exists for this SDK; see
// WHATSAPP_VIDEO_STATUS.md Part 11). A constructor never touches memory beyond its own
// object's true size, so oversizing cannot corrupt anything.
static unsigned char g_transport[1024];
static unsigned char g_binclient[1024];
static unsigned char g_sebinary[256];

static const unsigned kRtpPacketReceivedCmdId = 20;
static const unsigned kFieldTableIndex = 91;
static const unsigned kFieldEntrySize = 16;

int main(int argc, char **argv) {
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_sigaction = segv_handler;
	sa.sa_flags = SA_SIGINFO;
	sigaction(SIGSEGV, &sa, nullptr);

	if (argc < 2) {
		fprintf(stderr, "usage: %s <file-with-payload-bytes>\n", argv[0]);
		return 1;
	}

	FILE *f = fopen(argv[1], "rb");
	if (!f) { perror("fopen payload"); return 1; }
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (len <= 0 || len > 65536) {
		fprintf(stderr, "payload file empty or too large (%ld bytes)\n", len);
		fclose(f);
		return 1;
	}
	unsigned char *payload = (unsigned char *)malloc(len);
	if (fread(payload, 1, len, f) != (size_t)len) { perror("fread"); return 1; }
	fclose(f);
	fprintf(stderr, "loaded %ld bytes from %s\n", len, argv[1]);

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
	fprintf(stderr, "constructing BinClient(transport)...\n");
	binclient_ctor(g_binclient, g_transport);

	// SEBinary's pre-set() state is NOT all-zero: disassembly of VideoHost::SendRTP's own
	// inline construction of a temporary SEBinary (libpalmgstskype.so 0x36644-0x36664, right
	// before its own SEBinary::set() call) shows {word0=0, word1=0, word2=0, word3=1} —
	// word3 (offset+12) is 1, likely a refcount. An all-zero buffer here segfaulted inside
	// set() (confirmed live: crashed before anything reached mediaserver, matching the
	// safety property this whole approach relies on).
	memset(g_sebinary, 0, sizeof(g_sebinary));
	*(uint32_t *)(g_sebinary + 12) = 1;
	fprintf(stderr, "setting SEBinary payload (%ld bytes)...\n", len);
	sebinary_set(g_sebinary, payload, (unsigned)len);

	// First attempt (crashed, fault addr 0x2, deep inside wr_call_lst): passed a
	// pre-offset field pointer (base + 91*16) with fieldCount=0. Reconsidering
	// ProcessCall's own cmdId=20 dispatch site (libmedia... err, libpalmgstskype.so
	// 0x3b448-0x3b490): it calls rd_parms(ci, fields=<raw base pointer straight from the
	// GOT, unindexed>, count=91, buf) — the base pointer and the index are passed
	// *separately*, meaning the callee does the fields+index*16 arithmetic itself, not
	// the caller. Passing an already-offset pointer here was very likely the bug.
	fprintf(stderr, "M_SkypeVideoRTPInterface_fields (base) = %p\n",
	        (void *)M_SkypeVideoRTPInterface_fields);

	unsigned int cmdId = kRtpPacketReceivedCmdId;
	unsigned int responseId = 0;
	fprintf(stderr, "calling wr_call_lst(cmdId=%u, \"RtpPacketReceived\", fields=<base>, "
	                 "fieldCount=%u, &sebinary)...\n", cmdId, kFieldTableIndex);
	int rc = binclient_wr_call_lst(g_binclient, /*ci=*/nullptr, &cmdId, "RtpPacketReceived",
	                                 &responseId, M_SkypeVideoRTPInterface_fields,
	                                 /*fieldCount=*/kFieldTableIndex, g_sebinary);
	fprintf(stderr, "wr_call_lst returned %d, responseId=%u\n", rc, responseId);

	return rc == 0 ? 0 : 1;
}
