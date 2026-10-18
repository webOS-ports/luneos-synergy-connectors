// vidrtp_sniffer — minimal ground-truth capture tool for the SkypeKit AVTransport socket
// mediaserver's ClonkPipeline uses to hand off outgoing video RTP.
//
// WHY THIS EXISTS: WHATSAPP_VIDEO_STATUS.md Part 10 traced libpalmgstskype.so (a GStreamer
// plugin loaded by mediaserver) to a real, embedded copy of Skype's own SkypeKit SDK. Its
// AVTransport layer moves RTP packets over two fixed-name ABSTRACT-namespace AF_UNIX sockets:
//   /tmp/vidrtp_to_skypekit_key    (mediaserver = CLIENT, dials out — confirmed via
//                                   Sid::AVTransportWrapper::Connect(path, isServer=false, 500)
//                                   disassembly in ClonkPipeline's RunVideoHost)
//   /tmp/vidrtp_from_skypekit_key  (mediaserver = SERVER, listens — confirmed via
//                                   Sid::AVServer::Connect(path, 10000))
// Rather than fully reverse-engineering Sid::Protocol::BinCommon's wire-level call/field
// framing from disassembly alone, this tool gets GROUND TRUTH: bind the "_to_" socket exactly
// the way Sid::UnixSocket::ServerConnect does (same abstract-namespace construction, same
// fixed addrlen=110 matching sizeof(sockaddr_un) — the address is fully zero-padded out to
// 110 bytes, not just NUL-terminated after the name, and mediaserver's bind()/connect() calls
// use that same fixed 110 always, so a shorter addrlen here would NOT match), accept
// mediaserver's connection once videoCaptureStart is triggered, and dump every byte received
// to a log with a hex+ASCII view. That capture is the starting point for decoding the actual
// call-framing format, instead of guessing it from marshalling code in isolation.
//
// Build (cross, from the repo root): see build-vidrtp-sniffer.sh in this directory.
// Two modes, matching the two sockets' opposite roles (see WHATSAPP_VIDEO_STATUS.md Part 10/11):
//   server mode — bind+listen+accept vidrtp_to_skypekit_key (mediaserver connects as client,
//     after videoCaptureStart; retries for up to ~50s, so there's no tight race):
//       ./vidrtp_sniffer server vidrtp_to_skypekit_key vidrtp_to.log
//   client mode — connect to vidrtp_from_skypekit_key (mediaserver is already listening there,
//     confirmed live via /proc/net/unix once videoPlayerStart has had ~10-25s to run —
//     Part 11 found the "resolution not set on capsfilter" GStreamer warning does NOT block
//     RunVideoHost()/the socket setup, it just needs more time than a few seconds):
//       ./vidrtp_sniffer client vidrtp_from_skypekit_key vidrtp_from.log

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <time.h>

// Matches Sid::UnixSocket::MakeAddress exactly: memset the whole struct (all 110 bytes) to 0
// first, sun_family=AF_UNIX, leave sun_path[0]=0 (abstract-namespace marker), strcpy the name
// starting at sun_path[1]. bind()/connect() then always pass addrlen=110 (sizeof(sockaddr_un)
// on this ARM/glibc target: 2 bytes family + 108 bytes sun_path) — NOT a shorter,
// strlen-derived addrlen — so the abstract name includes the zero padding after the string.
static int make_abstract_addr(const char *name, struct sockaddr_un *addr) {
	if (strlen(name) > 106) return -1; // matches the SDK's own >106 rejection
	memset(addr, 0, sizeof(*addr));
	addr->sun_family = AF_UNIX;
	strcpy(addr->sun_path + 1, name);
	return 0;
}

static void dump_bytes(FILE *log, const unsigned char *buf, ssize_t n) {
	// time(), not clock_gettime(): clock_gettime pulls in a GLIBC_2.17 symbol version this
	// device's much older libc doesn't have (confirmed via readelf --dyn-syms), even though
	// clock_gettime() itself has existed since ancient glibc — time() has always resolved to
	// an old-enough symbol version on this toolchain, matching clonk_probe's GLIBC_2.4 need.
	time_t now = time(NULL);
	fprintf(log, "\n=== recv %zd bytes @ %ld ===\n", n, (long)now);
	for (ssize_t i = 0; i < n; i += 16) {
		fprintf(log, "%6zd: ", i);
		for (ssize_t j = 0; j < 16; j++) {
			if (i + j < n) fprintf(log, "%02x ", buf[i + j]);
			else fprintf(log, "   ");
		}
		fprintf(log, " ");
		for (ssize_t j = 0; j < 16 && i + j < n; j++) {
			unsigned char c = buf[i + j];
			fputc((c >= 32 && c < 127) ? c : '.', log);
		}
		fprintf(log, "\n");
	}
	fflush(log);
}

int main(int argc, char **argv) {
	if (argc < 4) {
		fprintf(stderr, "usage: %s server|client <abstract-socket-name> <log-file>\n", argv[0]);
		fprintf(stderr, "  server: bind+listen+accept — for vidrtp_to_skypekit_key (mediaserver connects as client)\n");
		fprintf(stderr, "  client: connect — for vidrtp_from_skypekit_key (mediaserver is already listening)\n");
		return 1;
	}
	int is_server = strcmp(argv[1], "server") == 0;
	const char *name = argv[2];
	const char *logpath = argv[3];

	int cfd;
	if (is_server) {
		int fd = socket(AF_UNIX, SOCK_STREAM, 0);
		if (fd < 0) { perror("socket"); return 1; }

		struct sockaddr_un addr;
		if (make_abstract_addr(name, &addr) < 0) {
			fprintf(stderr, "name too long\n");
			return 1;
		}

		if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
			perror("bind");
			return 1;
		}
		if (listen(fd, 1) < 0) {
			perror("listen");
			return 1;
		}
		fprintf(stderr, "listening on abstract socket \"%s\", waiting for mediaserver to connect...\n", name);

		cfd = accept(fd, NULL, NULL);
		if (cfd < 0) { perror("accept"); return 1; }
		fprintf(stderr, "accepted connection, logging to %s\n", logpath);
	} else {
		struct sockaddr_un addr;
		if (make_abstract_addr(name, &addr) < 0) {
			fprintf(stderr, "name too long\n");
			return 1;
		}

		// Sid::AVServer::Run() spawns a thread that does a single non-blocking
		// (poll timeout=0) accept attempt, not a persistent listening loop (confirmed via
		// disassembly — WHATSAPP_VIDEO_STATUS.md) — so the socket is only actually
		// acceptable for a razor-thin window, likely re-created repeatedly. A single
		// connect() attempt (even found right after the name appears in /proc/net/unix,
		// per testing) reliably gets ECONNREFUSED. Retry tightly (every 5ms) instead of
		// relying on coarse shell-level retries, closing and recreating the fd each time
		// since POSIX leaves a stream socket's state unspecified after a failed connect().
		int attempts = 0;
		cfd = -1;
		for (int i = 0; i < 4000; i++) { // ~20s at 5ms
			int fd = socket(AF_UNIX, SOCK_STREAM, 0);
			if (fd < 0) { perror("socket"); return 1; }
			attempts++;
			if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
				cfd = fd;
				break;
			}
			close(fd);
			usleep(5000);
		}
		if (cfd < 0) {
			fprintf(stderr, "connect: gave up after %d attempts\n", attempts);
			return 1;
		}
		fprintf(stderr, "connected to abstract socket \"%s\" after %d attempts, logging to %s\n", name, attempts, logpath);
	}

	FILE *log = fopen(logpath, "w");
	if (!log) { perror("fopen"); return 1; }

	unsigned char buf[65536];
	for (;;) {
		ssize_t n = read(cfd, buf, sizeof(buf));
		if (n < 0) { perror("read"); break; }
		if (n == 0) { fprintf(stderr, "peer closed connection\n"); break; }
		dump_bytes(log, buf, n);
		fprintf(stderr, "logged %zd bytes\n", n);
	}

	fclose(log);
	close(cfd);
	return 0;
}
