#!/usr/bin/env bash
# build-discord-voice.sh — cross-compile the Discord voice client for ARMv7 webOS.
#
# Links the vendored prebuilt libdave + mlspp stack, the cross OpenSSL 1.1.1w, and
# libopus from the wpe staging sysroot. Produces an ARM ELF at logs/discord-voice.
#
# Deps and where they come from:
#   - libdave/mlspp : ../prebuilt/lib/*.a          (vendored ARM static libs)
#   - OpenSSL 1.1.1w: $ARM_OSSL                     (shared, matches device rootfs)
#   - libopus       : $OPUS_ROOT (wpe staging)      (shared; device has libopus.so.0)
#   - nlohmann/json : ../prebuilt/include/nlohmann  (header-only, vendored)
#   - libasound     : dlopen'd at RUNTIME (system libasound.so.2) — NOT linked here
#   - liblunaservice: NOT linked — audiod is driven via luna-send fork/exec
#
# Override via env: ARM_TC, ARM_OSSL, OPUS_ROOT.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TC="${ARM_TC:-/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125}"
OSSL="${ARM_OSSL:-/home/herrie/webos/touchpad-kernel/doctor305/OpenSSL-11-Update/openssl-1.1.1w}"
OPUS_ROOT="${OPUS_ROOT:-/home/herrie/webos/wpe/staging-glibc-252}"
CXX="$TC/bin/arm-unknown-linux-gnueabi-g++"

PREFIX="$HERE/prebuilt"
INC="$PREFIX/include"
LIB="$PREFIX/lib"
SRC="$HERE/src"
OUT="$HERE/logs/discord-voice"

ARCH_FLAGS="-march=armv7-a -mtune=cortex-a8 -mfpu=neon -mfloat-abi=softfp"

echo "[dvoice] CXX     = $CXX"
echo "[dvoice] prefix  = $PREFIX"
echo "[dvoice] openssl = $OSSL"
echo "[dvoice] opus    = $OPUS_ROOT"

[ -x "$CXX" ] || { echo "!! toolchain g++ not found: $CXX" >&2; exit 1; }
[ -f "$LIB/libdave.a" ] || { echo "!! missing prebuilt libdave.a — run build-libdave-arm.sh" >&2; exit 1; }

SRCS=(
  "$SRC/main.cpp"
  "$SRC/gateway.cpp"
  "$SRC/voice_ws.cpp"
  "$SRC/udp_transport.cpp"
  "$SRC/dave_glue.cpp"
  "$SRC/opus_audio.cpp"
  "$SRC/audiod.cpp"
  "$SRC/ws_client.cpp"
)

"$CXX" $ARCH_FLAGS -std=c++17 -O2 -Wall -Wno-array-bounds -Wno-stringop-overflow \
  -I"$SRC" \
  -I"$INC" \
  -I"$INC/dave-src" \
  -I"$INC/mlspp" \
  -I"$OSSL/include" \
  -I"$OPUS_ROOT/include" \
  "${SRCS[@]}" \
  -o "$OUT" \
  -Wl,--start-group \
    "$LIB/libdave.a" \
    "$LIB/libmlspp.a" \
    "$LIB/libhpke.a" \
    "$LIB/libtls_syntax.a" \
    "$LIB/libbytes.a" \
  -Wl,--end-group \
  -L"$OSSL" -lssl -lcrypto \
  -L"$OPUS_ROOT/lib" -Wl,-rpath-link,"$OPUS_ROOT/lib" -lopus \
  -lpthread -ldl

echo "[dvoice] built: $OUT"
file "$OUT" || true
"$TC/bin/arm-unknown-linux-gnueabi-size" "$OUT" 2>/dev/null || true
