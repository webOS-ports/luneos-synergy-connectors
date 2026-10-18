/*
 * srtp_kdf.h - public surface of srtp_kdf.c (RingRTC 1:1 Signal-call SRTP key derivation).
 *
 * srtp_kdf.c defines these itself (it predates this header and is left byte-for-byte untouched);
 * this header just lets signal_media.c call into it without re-declaring. The struct layout here
 * MUST match srtp_kdf.c exactly (verified against messaging/signal/calling/media/srtp_kdf.py).
 *
 * AEAD_AES_256_GCM: each key is 32 bytes, each salt 12 bytes; the SRTP master key handed to
 * libsrtp/gstsrtp is key||salt = 44 bytes.
 */
#ifndef SIGNAL_SRTP_KDF_H
#define SIGNAL_SRTP_KDF_H

#include <stddef.h>

#define SIGNAL_SRTP_KEY_SIZE  32
#define SIGNAL_SRTP_SALT_SIZE 12
#define SIGNAL_SRTP_MASTER_SIZE (SIGNAL_SRTP_KEY_SIZE + SIGNAL_SRTP_SALT_SIZE) /* 44 */

typedef struct {
    unsigned char offer_key[SIGNAL_SRTP_KEY_SIZE],  offer_salt[SIGNAL_SRTP_SALT_SIZE];   /* caller (offerer) sends */
    unsigned char answer_key[SIGNAL_SRTP_KEY_SIZE], answer_salt[SIGNAL_SRTP_SALT_SIZE];  /* callee (answerer) sends */
} signal_srtp_keys;

#ifdef __cplusplus
extern "C" {
#endif

/* Derive our X25519 public key from a 32-byte private key (for the Answer's public_key). 0 on ok. */
int signal_x25519_public_from_private(const unsigned char local_priv[32], unsigned char out_pub[32]);

/* Full RingRTC derivation. caller_id/callee_id are the two parties' Signal identity PUBLIC keys
 * (libsignal 33-byte 0x05-prefixed form). Returns 0 on success, -1 on error (incl. non-contributory). */
int signal_negotiate_srtp_keys(const unsigned char local_priv[32], const unsigned char remote_pub[32],
                               const unsigned char *caller_id, size_t caller_id_len,
                               const unsigned char *callee_id, size_t callee_id_len,
                               signal_srtp_keys *out);

#ifdef __cplusplus
}
#endif

#endif /* SIGNAL_SRTP_KDF_H */
