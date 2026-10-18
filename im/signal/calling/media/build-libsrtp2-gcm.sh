#!/bin/sh
# Build a GCM-capable libsrtp2.so.1 for the TouchPad (ARMv7 softfp, wpe-glibc-252 runtime).
#
# WHY THIS EXISTS
# --------------
# The libsrtp2 shipped in the Atlas wpe-252 deviceroot was built with meson's
# `crypto-library=none` (native/internal crypto). That backend registers ONLY the AES-ICM
# cipher (srtp_aes_icm_128); it does NOT register an AES-GCM cipher_type. The GCM
# `srtp_crypto_policy_set_aes_gcm_*` helpers and the GCM *test vectors* are always compiled
# in, so `nm`/`strings` make it LOOK like GCM is supported - but at runtime
# `srtp_add_stream()` with a GCM policy returns srtp_err_status_fail(1), because the crypto
# kernel has no GCM cipher registered. That surfaces as gstsrtpenc:
#     "Failed to add stream to SRTP encoder (err: 1)".
#
# Signal calling (RingRTC V4) uses AEAD_AES_256_GCM SRTP - so we MUST have GCM. This rebuilds
# libsrtp2 2.6.0 with `-Dcrypto-library=openssl` so it registers srtp_aes_gcm_{128,256}_openssl
# (backed by libcrypto.so.3, the exact OpenSSL the rest of the wpe-252 stack already links).
#
# DEPLOY
# ------
# Drop the resulting libsrtp2.so.1 into /media/internal/sslfix on the device. That dir is FIRST
# on the media engine's LD_LIBRARY_PATH, so libgstsrtp.so's `NEEDED libsrtp2.so.1` resolves to
# THIS copy (with GCM) instead of the native wpe-252 one. Same soname + ABI => drop-in.
#     novacom put file:///media/internal/sslfix/libsrtp2.so.1 < prebuilt/libsrtp2.so.1
#
# VERIFIED 2026-07-21: with this .so in sslfix, signal_media --loopback decodes 25 Opus frames
# through SRTP-GCM -> PASS on the device.
set -e

SRC=${LIBSRTP_SRC:-/home/herrie/webos/wpe/build/libsrtp-2.6.0}
CROSSFILE=${CROSSFILE:-/home/herrie/webos/wpe/meson-cross-glibc-gcc125.txt}
TOOLBIN=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125/bin
OUT=$(cd "$(dirname "$0")" && pwd)/prebuilt

export PATH="$TOOLBIN:$PATH"
command -v arm-unknown-linux-gnueabi-gcc >/dev/null || { echo "cross gcc not on PATH ($TOOLBIN)"; exit 1; }

cd "$SRC"
rm -rf _bgcm
meson setup _bgcm \
  --cross-file "$CROSSFILE" \
  -Dcrypto-library=openssl -Dcrypto-library-kdf=disabled \
  -Ddefault_library=shared -Dtests=disabled
ninja -C _bgcm libsrtp2.so.1

mkdir -p "$OUT"
cp _bgcm/libsrtp2.so.1 "$OUT/libsrtp2.so.1"
echo "built: $OUT/libsrtp2.so.1"
readelf -sW "$OUT/libsrtp2.so.1" | grep -q aes_gcm_256_openssl \
  && echo "OK: AES-256-GCM cipher registered (openssl backend)" \
  || { echo "FAIL: no GCM cipher symbol"; exit 1; }
readelf -d "$OUT/libsrtp2.so.1" | grep -q 'libcrypto.so.3' \
  && echo "OK: links libcrypto.so.3" || echo "WARN: expected libcrypto.so.3 NEEDED"
