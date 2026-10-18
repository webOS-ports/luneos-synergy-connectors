/*
 * srtp_kdf.c - RingRTC 1:1 Signal-call SRTP key derivation, OpenSSL/C port for the teamsm-style
 * Signal call mediator. Mirrors ringrtc connection.rs::negotiate_srtp_keys exactly; verified byte-
 * for-byte against messaging/signal/calling/media/srtp_kdf.py (RFC7748 X25519 + RFC5869 HKDF).
 *
 *   shared = X25519(local_priv, remote_pub)                 // reject all-zero (non-contributory)
 *   okm    = HKDF-SHA256(ikm=shared, salt=32*0x00,
 *                        info="Signal_Calling_20200807_SignallingDH_SRTPKey_KDF"+caller_id+callee_id, L=88)
 *   offer_key=okm[0:32] offer_salt=okm[32:44] answer_key=okm[44:76] answer_salt=okm[76:88]  // AEAD_AES_256_GCM
 *
 * OpenSSL 1.1.1+ (device has 1.1.1w). Build/test on host:
 *   cc srtp_kdf.c -o srtp_kdf -lcrypto && ./srtp_kdf   # runs the same vector as srtp_kdf.py --demo
 */
#include <stdio.h>
#include <string.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/err.h>

#define KEY_SIZE 32
#define SALT_SIZE 12
#define OKM_LEN (KEY_SIZE + SALT_SIZE + KEY_SIZE + SALT_SIZE)   /* 88 */
static const char *HKDF_INFO_PREFIX = "Signal_Calling_20200807_SignallingDH_SRTPKey_KDF";

typedef struct {
    unsigned char offer_key[KEY_SIZE],  offer_salt[SALT_SIZE];   /* caller (offerer) sends */
    unsigned char answer_key[KEY_SIZE], answer_salt[SALT_SIZE];  /* callee (answerer) sends */
} signal_srtp_keys;

/* X25519 shared secret. Returns 0 on success. */
static int x25519_shared(const unsigned char local_priv[32], const unsigned char remote_pub[32],
                         unsigned char out_shared[32]) {
    int rc = -1;
    EVP_PKEY *loc = EVP_PKEY_new_raw_private_key(EVP_PKEY_X25519, NULL, local_priv, 32);
    EVP_PKEY *rem = EVP_PKEY_new_raw_public_key(EVP_PKEY_X25519, NULL, remote_pub, 32);
    EVP_PKEY_CTX *ctx = loc ? EVP_PKEY_CTX_new(loc, NULL) : NULL;
    size_t len = 32;
    if (loc && rem && ctx && EVP_PKEY_derive_init(ctx) == 1 &&
        EVP_PKEY_derive_set_peer(ctx, rem) == 1 &&
        EVP_PKEY_derive(ctx, out_shared, &len) == 1 && len == 32)
        rc = 0;
    EVP_PKEY_CTX_free(ctx); EVP_PKEY_free(loc); EVP_PKEY_free(rem);
    return rc;
}

/* Derive the local X25519 public key from a private key (for the Answer's public_key). 0 on success. */
int signal_x25519_public_from_private(const unsigned char local_priv[32], unsigned char out_pub[32]) {
    size_t len = 32;
    EVP_PKEY *loc = EVP_PKEY_new_raw_private_key(EVP_PKEY_X25519, NULL, local_priv, 32);
    int rc = (loc && EVP_PKEY_get_raw_public_key(loc, out_pub, &len) == 1 && len == 32) ? 0 : -1;
    EVP_PKEY_free(loc);
    return rc;
}

/* The full derivation. caller/callee identity keys are the two parties' Signal identity PUBLIC keys
 * (libsignal 33-byte 0x05-prefixed form). Returns 0 on success, -1 on error (incl. non-contributory). */
int signal_negotiate_srtp_keys(const unsigned char local_priv[32], const unsigned char remote_pub[32],
                               const unsigned char *caller_id, size_t caller_id_len,
                               const unsigned char *callee_id, size_t callee_id_len,
                               signal_srtp_keys *out) {
    unsigned char shared[32], okm[OKM_LEN], zero[32] = {0}, salt[32] = {0};
    if (x25519_shared(local_priv, remote_pub, shared) != 0) return -1;
    if (memcmp(shared, zero, 32) == 0) return -1;   /* non-contributory */

    size_t info_len = strlen(HKDF_INFO_PREFIX) + caller_id_len + callee_id_len;
    unsigned char *info = OPENSSL_malloc(info_len);
    if (!info) return -1;
    size_t off = strlen(HKDF_INFO_PREFIX);
    memcpy(info, HKDF_INFO_PREFIX, off);
    memcpy(info + off, caller_id, caller_id_len); off += caller_id_len;
    memcpy(info + off, callee_id, callee_id_len);

    int rc = -1;
    EVP_PKEY_CTX *h = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, NULL);
    size_t olen = OKM_LEN;
    if (h && EVP_PKEY_derive_init(h) == 1 &&
        EVP_PKEY_CTX_set_hkdf_md(h, EVP_sha256()) == 1 &&
        EVP_PKEY_CTX_set1_hkdf_salt(h, salt, 32) == 1 &&
        EVP_PKEY_CTX_set1_hkdf_key(h, shared, 32) == 1 &&
        EVP_PKEY_CTX_add1_hkdf_info(h, info, info_len) == 1 &&
        EVP_PKEY_derive(h, okm, &olen) == 1 && olen == OKM_LEN) {
        memcpy(out->offer_key,   okm,                              KEY_SIZE);
        memcpy(out->offer_salt,  okm + KEY_SIZE,                   SALT_SIZE);
        memcpy(out->answer_key,  okm + KEY_SIZE + SALT_SIZE,       KEY_SIZE);
        memcpy(out->answer_salt, okm + KEY_SIZE + SALT_SIZE + KEY_SIZE, SALT_SIZE);
        rc = 0;
    }
    EVP_PKEY_CTX_free(h);
    OPENSSL_clear_free(info, info_len);
    OPENSSL_cleanse(shared, 32); OPENSSL_cleanse(okm, OKM_LEN);
    return rc;
}

#ifdef SRTP_KDF_TEST
static void hx(const char *l, const unsigned char *b, size_t n) {
    printf("%s", l); for (size_t i = 0; i < n; i++) printf("%02x", b[i]); printf("\n");
}
static int fromhex(const char *h, unsigned char *out, size_t n) {
    for (size_t i = 0; i < n; i++) if (sscanf(h + 2*i, "%2hhx", &out[i]) != 1) return -1;
    return 0;
}
int main(void) {
    /* Same fixed vector as srtp_kdf.py's demo — must match its EXPECT line byte-for-byte. */
    unsigned char priv[32], alan[32], cid[33], eid[33];
    fromhex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", priv, 32);
    fromhex("364fb3e8d71d17b656aca498ca2c4e9ffacfab68b6a7255507a8ca1d58637361", alan, 32);
    fromhex("05aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", cid, 33);
    fromhex("05bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", eid, 33);
    unsigned char pub[32];
    signal_x25519_public_from_private(priv, pub);
    hx("our_public  = ", pub, 32);
    signal_srtp_keys k;
    if (signal_negotiate_srtp_keys(priv, alan, cid, 33, eid, 33, &k) != 0) {
        fprintf(stderr, "derivation FAILED\n"); return 1;
    }
    hx("offer_key   = ", k.offer_key, 32);
    hx("offer_salt  = ", k.offer_salt, 12);
    hx("answer_key  = ", k.answer_key, 32);
    hx("answer_salt = ", k.answer_salt, 12);
    return 0;
}
#endif
