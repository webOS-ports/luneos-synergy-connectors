#!/usr/bin/env python3
"""
srtp_kdf.py - reference implementation of RingRTC's 1:1 Signal-call SRTP key derivation
(ringrtc src/rust/src/core/connection.rs::negotiate_srtp_keys), for verifying the C port.

Signal 1:1 call media = AEAD_AES_256_GCM SRTP whose keys come from an X25519 DH on the
public_key carried in the offer/answer opaque (ConnectionParametersV4). NOT DTLS.

Derivation (verbatim from RingRTC):
  shared = X25519(local_secret, remote_public_key)          # reject non-contributory (all-zero)
  okm    = HKDF-SHA256(ikm=shared, salt=32*0x00,
                       info="Signal_Calling_20200807_SignallingDH_SRTPKey_KDF"
                            + caller_identity_key + callee_identity_key,
                       L=32+12+32+12 = 88)
  offer_key  = okm[0:32]   offer_salt  = okm[32:44]   # OFFERER (caller) sends with this
  answer_key = okm[44:76]  answer_salt = okm[76:88]   # ANSWERER (callee) sends with this

For an INCOMING call we are the callee/answerer:
  - DECRYPT the caller's audio with (offer_key, offer_salt)
  - ENCRYPT our audio with (answer_key, answer_salt)
Both peers compute the SAME okm (info is always caller_id then callee_id, role-independent).

identity keys: the two parties' Signal identity PUBLIC keys. libsignal serialises an IdentityKey
as 33 bytes = 0x05 (DJB type) || 32-byte X25519 pub. UNVERIFIED whether RingRTC passes the 33-byte
or 32-byte form here - flagged; confirm on a live call. Toggle IDKEY_33 below to test both.
"""
import sys, binascii
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

HKDF_INFO_PREFIX = b"Signal_Calling_20200807_SignallingDH_SRTPKey_KDF"
KEY_SIZE, SALT_SIZE = 32, 12          # AEAD_AES_256_GCM

def negotiate_srtp_keys(local_priv32: bytes, remote_pub32: bytes,
                        caller_id: bytes, callee_id: bytes):
    if len(local_priv32) != 32 or len(remote_pub32) != 32:
        raise ValueError("local priv and remote pub must be 32 bytes")
    sk = X25519PrivateKey.from_private_bytes(local_priv32)
    pk = X25519PublicKey.from_public_bytes(remote_pub32)
    shared = sk.exchange(pk)                       # X25519, RFC 7748
    if shared == b"\x00" * 32:                     # non-contributory -> RingRTC rejects
        raise ValueError("non-contributory shared secret (low-order remote key)")
    info = HKDF_INFO_PREFIX + caller_id + callee_id
    okm = HKDF(algorithm=hashes.SHA256(), length=KEY_SIZE + SALT_SIZE + KEY_SIZE + SALT_SIZE,
               salt=b"\x00" * 32, info=info).derive(shared)
    return {
        "offer_key":  okm[0:32],   "offer_salt":  okm[32:44],   # caller sends
        "answer_key": okm[44:76],  "answer_salt": okm[76:88],   # callee sends
    }

def local_pub_from_priv(local_priv32: bytes) -> bytes:
    from cryptography.hazmat.primitives import serialization
    return X25519PrivateKey.from_private_bytes(local_priv32).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)

# ---------------------------------------------------------------- self-tests (RFC vectors) -----
def _selftest():
    h = binascii.unhexlify
    # RFC 7748 s6.1 X25519 DH known-answer
    a_priv = h("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
    b_pub  = h("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
    want   = h("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
    got = X25519PrivateKey.from_private_bytes(a_priv).exchange(X25519PublicKey.from_public_bytes(b_pub))
    assert got == want, "X25519 RFC7748 vector FAILED"
    # RFC 5869 Test Case 1 HKDF-SHA256
    okm = HKDF(algorithm=hashes.SHA256(), length=42, salt=h("000102030405060708090a0b0c"),
               info=h("f0f1f2f3f4f5f6f7f8f9")).derive(h("0b"*22))
    assert okm == h("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"), \
        "HKDF RFC5869 vector FAILED"
    print("[selftest] X25519 (RFC7748) + HKDF-SHA256 (RFC5869) vectors PASS -> primitives correct")

def _hx(b): return binascii.hexlify(b).decode()

if __name__ == "__main__":
    _selftest()
    # Demo on Alan's REAL captured offer public_key (2026-07-21 sigoffer.log). Local priv + identity
    # keys are PLACEHOLDERS (the real ones come from presage at call time); this only shows the
    # derivation runs deterministically end-to-end on real remote data.
    alan_pub = binascii.unhexlify("364fb3e8d71d17b656aca498ca2c4e9ffacfab68b6a7255507a8ca1d58637361")
    local_priv = bytes(range(1, 33))                    # placeholder ephemeral secret
    caller_id  = b"\x05" + b"\xAA"*32                    # placeholder Alan identity (33B, 0x05-prefixed)
    callee_id  = b"\x05" + b"\xBB"*32                    # placeholder our identity
    print("\n[demo] our ephemeral public (goes in Answer.ConnectionParametersV4.public_key):")
    print("   ", _hx(local_pub_from_priv(local_priv)))
    k = negotiate_srtp_keys(local_priv, alan_pub, caller_id, callee_id)
    print("[demo] derived SRTP keys (AEAD_AES_256_GCM) from Alan's public_key:")
    for name in ("offer_key", "offer_salt", "answer_key", "answer_salt"):
        print(f"    {name:11} = {_hx(k[name])}")
    print("  -> incoming call: DECRYPT caller audio with offer_key/salt; ENCRYPT ours with answer_key/salt")
    # emit a machine-readable line the C port can diff against
    print("\nVECTOR local_priv=%s remote_pub=%s caller_id=%s callee_id=%s" % (
        _hx(local_priv), _hx(alan_pub), _hx(caller_id), _hx(callee_id)))
    print("EXPECT offer_key=%s offer_salt=%s answer_key=%s answer_salt=%s" % (
        _hx(k["offer_key"]), _hx(k["offer_salt"]), _hx(k["answer_key"]), _hx(k["answer_salt"])))
