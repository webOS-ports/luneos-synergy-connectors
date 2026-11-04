/*
 * signal_media.h - C API of the Signal 1:1 call media engine (GStreamer + libnice + manually keyed
 * AEAD_AES_256_GCM SRTP). purple-presage runs the engine as a process and talks to it over stdin/
 * stdout (signal_media.c, run_ipc); this API is what that process uses.
 *
 * For an incoming call (answerer):
 *   RX: nicesrc -> srtpdec(offer_key||offer_salt) -> rtpopusdepay -> opusdec -> pulsesink device=voipcall
 *   TX: pulsesrc device=webcall -> opusenc -> rtpopuspay -> srtpenc(answer_key||answer_salt) -> nicesink
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

/* Called when the media pipeline is up (active=1) or torn down (active=0). purple-presage reports
 * the call to audiod itself, from the call state, so this is informational. Optional: pass NULL to
 * skip. Called on the media thread. */
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

/* The user answered an incoming call (RingRTC call id): open the microphone and send RingRTC's
 * Accepted. */
void signal_media_accept(unsigned long long call_id);

/* Video events, one line each, without a newline (called on engine threads; keep it short):
 *   VSHM <path> <w> <h>               the far side's decoded picture is on this gst-shm socket (I420)
 *   VPREVIEW <path> <w> <h> <q> <m>   our camera's picture; q quarter turns counter-clockwise to show
 *                                     it upright, m 1 if it is to be shown mirrored
 *   VTX <0|1>                         our camera is sending / stopped
 *   PEERVIDEO <0|1>                   the far side says its camera is on / off (RingRTC SenderStatus)
 *   PEERROT <q>                       the far side's picture needs q quarter turns counter-clockwise
 *   VIDEOERR <what>                   rx-elements, rx-link, tx-encoder, tx-elements, tx-link, tx-camera
 * Set before signal_media_start. */
typedef void (*signal_media_event_cb)(const char *line, void *user);
void signal_media_set_event_cb(signal_media_event_cb cb, void *user);

/* The user turned our camera on (1) or off (0). May come before signal_media_start (an outgoing
 * video call); for an incoming call the camera only starts once the user answered. */
void signal_media_set_video(int on);

/* The RingRTC call id, for the SenderStatus we send. An incoming call has it from
 * signal_media_accept; an outgoing call needs this. Only the first value counts. */
void signal_media_set_call_id(unsigned long long call_id);

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
