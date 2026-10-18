/*
 * signal_media.h - clean C API for the Signal 1:1 call MEDIA ENGINE (GStreamer + libnice + manual
 * AEAD_AES_256_GCM SRTP), for the future presage bridge (messaging/signal/plugin/purple-presage).
 *
 * This is the ANSWERER (callee) side of an INCOMING Signal voice call:
 *   RX: nicesrc -> srtpdec(offer_key||offer_salt) -> rtpopusdepay -> opusdec -> alsasink device=voip
 *   TX: alsasrc device=voipsource -> opusenc -> rtpopuspay -> srtpenc(answer_key||answer_salt) -> nicesink
 * Keys are derived by srtp_kdf.c from the X25519 DH in ConnectionParametersV4 - NOT DTLS.
 *
 * See README.md for the architecture, build, loopback self-test and the presage integration points.
 */
#ifndef SIGNAL_MEDIA_H
#define SIGNAL_MEDIA_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Emitted for each local ICE candidate we gather; the bridge relays it to the peer as a Signal
 * IceUpdate (opaque candidate string). sdp_candidate is a standard "candidate:..." line (no CRLF).
 * Called on the media engine's own GMainContext thread - keep it short / re-marshal if needed. */
typedef void (*signal_media_candidate_cb)(const char *sdp_candidate, void *user);

/* Called when the media engine wants audiod told a voip call is up (active=1) or gone (active=0).
 * The bridge (call.c, which already owns the com.palm.signal.call private LSHandle g_prv) should
 * issue the two LSCallOneReply calls documented in README (CallStatusUpdate + setCurrentScenario).
 * Optional: pass NULL to skip. Called on the media thread. */
typedef void (*signal_media_audiod_cb)(int active, void *user);

/* One-time process init (wraps gst_init). Safe to call more than once. Returns 0 on success. */
int signal_media_init(int *argc, char ***argv);

/* Derive SRTP keys, build the ICE agent + GStreamer pipeline and start it. Non-blocking: spins up a
 * private GMainContext thread that runs ICE + the pipeline bus. Returns 0 on success, -1 on error.
 *
 *   local_priv     - our 32-byte X25519 private (ephemeral) key for this call
 *   remote_pub     - caller's 32-byte Curve25519 public_key from the offer's ConnectionParametersV4
 *   caller_id/len  - caller's Signal identity public key (33-byte 0x05-prefixed) + its length
 *   callee_id/len  - our    Signal identity public key (33-byte 0x05-prefixed) + its length
 *   our_ufrag/pwd  - the ICE ufrag/pwd we advertise (bridge generates + sends them in Answer/Offer)
 *   remote_ufrag/pwd - the peer's ICE ufrag/pwd from their ConnectionParametersV4
 *   is_caller      - 0 = answerer (incoming): RX=offer_key, TX=answer_key.
 *                    1 = caller  (outgoing): RX=answer_key, TX=offer_key (mirror). Both peers derive
 *                    the identical offer/answer keys from the DH; only which is RX vs TX flips. For a
 *                    caller, remote_pub / remote_ufrag / remote_pwd come from the peer's ANSWER, and
 *                    caller_id = OUR identity key, callee_id = the peer's.
 *   cand_cb/user   - receives our local candidates to relay back (may be NULL)
 *   audiod_cb/aud_user - audiod routing hook (may be NULL)
 */
int signal_media_start(const unsigned char local_priv[32],
                       const unsigned char remote_pub[32],
                       const unsigned char *caller_id, size_t caller_id_len,
                       const unsigned char *callee_id, size_t callee_id_len,
                       const char *our_ufrag, const char *our_pwd,
                       const char *remote_ufrag, const char *remote_pwd,
                       int is_caller,
                       signal_media_candidate_cb cand_cb, void *user,
                       signal_media_audiod_cb audiod_cb, void *aud_user);

/* Feed one remote ICE candidate (a standard "candidate:..." SDP line, decoded from the peer's
 * IceUpdate opaque). Safe to call repeatedly as candidates trickle in. Returns 0 on success. */
int signal_media_add_remote_candidate(const char *sdp_candidate);

/* Tear the call down: stop the pipeline, free the ICE agent, fire audiod_cb(0), join the thread. */
void signal_media_stop(void);

/* --- loopback self-test -----------------------------------------------------------------------
 * Round-trips a test tone through opusenc -> rtpopuspay -> srtpenc -> srtpdec -> rtpopusdepay ->
 * opusdec entirely in-process (no ICE, no ALSA, no device), using a real 44-byte AEAD_AES_256_GCM
 * master key from signal_negotiate_srtp_keys. Proves the SRTP+RTP+Opus path links + negotiates.
 * Returns 0 (PASS) if enough frames decode within the timeout, non-zero (FAIL) otherwise. */
int signal_media_loopback_selftest(void);

#ifdef __cplusplus
}
#endif

#endif /* SIGNAL_MEDIA_H */
