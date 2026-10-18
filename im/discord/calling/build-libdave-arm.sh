#!/usr/bin/env bash
# build-libdave-arm.sh — reproduce the GREEN cross-build of discord/libdave and its
# dependency mlspp (+ nlohmann/json) for the HP TouchPad (webOS, ARMv7 glibc).
#
# Produces, under $PREFIX/lib (default: ./prebuilt):
#     libdave.a  libmlspp.a  libhpke.a  libtls_syntax.a  libbytes.a  (all ARM)
# and the public headers under $PREFIX/include.
#
# Dependencies pulled/built: OpenSSL 1.1.1w (assumed already cross-built, see OSSL),
# mlspp (cisco), nlohmann/json (header-only). libdave links OpenSSL::Crypto + MLSPP.
#
# Proven notes (do not "fix" these):
#   * Toolchain: crosstool-NG GCC 12.5, -march=armv7-a -mfpu=neon -mfloat-abi=softfp.
#   * GCC 12.5 emits FALSE-POSITIVE -Warray-bounds/-Wstringop-overflow in mlspp's
#     std::vector inlining. libdave adds -Werror ONLY for Clang/MSVC (not GNU), so
#     no source patch is needed; the toolchain file adds -Wno-* belt-and-suspenders.
#   * DO NOT use `ld --whole-archive` here: binutils 2.34 BFD has a bug that trips on
#     the mlspp archives. Plain static linking (as in probe/build-probe.sh) works.
#
# Usage:
#   ./build-libdave-arm.sh              # full from-clean (clones into ./src-build)
#   PREFIX=/path ./build-libdave-arm.sh # install artifacts elsewhere
#   LIBDAVE_ONLY=1 ./build-libdave-arm.sh   # rebuild only libdave against existing $PREFIX
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLCHAIN="$HERE/toolchain/arm-webos.cmake"

PREFIX="${PREFIX:-$HERE/prebuilt}"
WORK="${WORK:-$HERE/src-build}"
LOGS="$HERE/logs"
JOBS="${JOBS:-$(nproc)}"
mkdir -p "$PREFIX" "$WORK" "$LOGS"

# Pinned upstreams (override via env). libdave must be cloned --recursive for vcpkg,
# but we build mlspp/json ourselves so vcpkg is not required.
LIBDAVE_REPO="${LIBDAVE_REPO:-https://github.com/discord/libdave}"
MLSPP_REPO="${MLSPP_REPO:-https://github.com/cisco/mlspp}"
JSON_REPO="${JSON_REPO:-https://github.com/nlohmann/json}"

cmake_cross() { cmake -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" "$@" ; }

clone() { # repo dir [--recursive]
  local repo="$1" dir="$2" rec="${3:-}"
  if [ ! -d "$dir/.git" ]; then
    echo "[clone] $repo -> $dir"
    git clone $rec "$repo" "$dir"
  else
    echo "[clone] reuse existing $dir"
  fi
}

build_json() {
  clone "$JSON_REPO" "$WORK/json"
  echo "[json] configure+install (header-only)"
  cmake_cross -S "$WORK/json" -B "$WORK/json/build-arm" \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" -DJSON_BuildTests=OFF \
    >"$LOGS/json-arm-cfg.log" 2>&1
  cmake --install "$WORK/json/build-arm" >"$LOGS/json-arm-inst.log" 2>&1
}

build_mlspp() {
  clone "$MLSPP_REPO" "$WORK/mlspp" --recursive
  echo "[mlspp] configure (this is the long one)"
  cmake_cross -S "$WORK/mlspp" -B "$WORK/mlspp/build-arm" \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_BUILD_TYPE=Release \
    -DTESTING=OFF -DCLI=OFF \
    >"$LOGS/mlspp-arm-cfg.log" 2>&1
  echo "[mlspp] build"
  cmake --build "$WORK/mlspp/build-arm" -j"$JOBS" >"$LOGS/mlspp-arm-build.log" 2>&1
  cmake --install "$WORK/mlspp/build-arm" >"$LOGS/mlspp-arm-inst.log" 2>&1
}

build_libdave() {
  clone "$LIBDAVE_REPO" "$WORK/libdave" --recursive
  echo "[libdave] configure against $PREFIX"
  rm -rf "$WORK/libdave/cpp/build-arm"
  cmake_cross -S "$WORK/libdave/cpp" -B "$WORK/libdave/cpp/build-arm" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF -DTESTING=OFF -DPERSISTENT_KEYS=OFF \
    -DMLSPP_DIR="$PREFIX/share/MLSPP" \
    -Dnlohmann_json_DIR="$PREFIX/share/cmake/nlohmann_json" \
    >"$LOGS/libdave-arm-cfg.log" 2>&1
  echo "[libdave] build"
  cmake --build "$WORK/libdave/cpp/build-arm" -j"$JOBS" >"$LOGS/libdave-arm-build.log" 2>&1
  cp "$WORK/libdave/cpp/build-arm/libdave.a" "$PREFIX/lib/"
  # refresh public headers
  mkdir -p "$PREFIX/include/dave"
  cp "$WORK/libdave/cpp/includes/dave/"*.h "$PREFIX/include/dave/"
}

if [ "${LIBDAVE_ONLY:-0}" = "1" ]; then
  build_libdave
else
  build_json
  build_mlspp
  build_libdave
fi

echo "=== ARM artifacts in $PREFIX/lib ==="
ls -la "$PREFIX/lib/"*.a
echo "=== libdave.a arch ==="
"${ARM_TC:-/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125}/bin/arm-unknown-linux-gnueabi-ar" t "$PREFIX/lib/libdave.a" | head
file "$PREFIX/lib/libdave.a"
echo "[done] libdave + mlspp cross-build complete."
