// Phase 1a spike: prove libnice (ICE) + libsrtp2 + OpenSSL (DTLS-SRTP) actually cross-compile
// AND run without crashing on this toolchain/target, before building the real tgcalls-lite
// engine on top of them. Not a real ICE/DTLS session -- just object creation + a few real calls
// into each library, enough to exercise their global constructors / static init paths, which is
// exactly where the webrtc-audio-processing LDREX/SIGILL alignment trap (messaging/signal/
// calling/media/, commits ee59bb9..c970846) hit.
#include <stdio.h>
#include <string.h>
#include <nice/agent.h>
#include <srtp2/srtp.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

int main(void) {
	fprintf(stderr, "spike: start\n");

	// --- libnice: create a real ICE agent (exercises glib's type system + libnice's own
	// static/global init) ---
	GMainContext *ctx = g_main_context_new();
	NiceAgent *agent = nice_agent_new(ctx, NICE_COMPATIBILITY_RFC5245);
	if (!agent) { fprintf(stderr, "spike: nice_agent_new FAILED\n"); return 1; }
	guint stream_id = nice_agent_add_stream(agent, 1);
	if (stream_id == 0) { fprintf(stderr, "spike: nice_agent_add_stream FAILED\n"); return 1; }
	fprintf(stderr, "spike: libnice agent created, stream_id=%u\n", stream_id);
	g_object_unref(agent);
	g_main_context_unref(ctx);
	fprintf(stderr, "spike: libnice OK\n");

	// --- libsrtp2: init the global crypto tables + create a real session ---
	if (srtp_init() != srtp_err_status_ok) { fprintf(stderr, "spike: srtp_init FAILED\n"); return 1; }
	srtp_policy_t policy;
	memset(&policy, 0, sizeof(policy));
	srtp_crypto_policy_set_rtp_default(&policy.rtp);
	srtp_crypto_policy_set_rtcp_default(&policy.rtcp);
	unsigned char key[46]; // AES-CM-128 + HMAC-SHA1-80 master key+salt
	memset(key, 0x42, sizeof(key));
	policy.ssrc.type = ssrc_any_outbound;
	policy.key = key;
	policy.next = NULL;
	srtp_t session;
	if (srtp_create(&session, &policy) != srtp_err_status_ok) {
		fprintf(stderr, "spike: srtp_create FAILED\n");
		return 1;
	}
	srtp_dealloc(session);
	fprintf(stderr, "spike: libsrtp2 OK\n");

	// --- OpenSSL: real DTLS context + cert generation (exercises libcrypto's global init,
	// including any NEON-accelerated primitives it autodetects at runtime) ---
	SSL_CTX *ssl_ctx = SSL_CTX_new(DTLS_method());
	if (!ssl_ctx) { fprintf(stderr, "spike: SSL_CTX_new FAILED\n"); return 1; }
	SSL_CTX_free(ssl_ctx);
	fprintf(stderr, "spike: OpenSSL DTLS OK\n");

	fprintf(stderr, "spike: ALL OK\n");
	return 0;
}
