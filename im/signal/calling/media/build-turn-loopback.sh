#!/bin/sh
# build-turn-loopback.sh - cross-compile turn_loopback (see turn_loopback.c) for the TouchPad.
# Only needs glib/gobject/nice (no gstreamer/opus/srtp/openssl) - much smaller/faster than
# build-signal-media.sh. Same toolchain/sysroot/loader as the real engine so it's an apples-to-apples
# test of the same libnice build.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

TOOLCHAIN=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125
CROSS=$TOOLCHAIN/bin/arm-unknown-linux-gnueabi-
SYSROOT=/home/herrie/webos/wpe/staging-glibc-252
CC=${CROSS}gcc

export PKG_CONFIG_PATH=$SYSROOT/lib/pkgconfig
export PKG_CONFIG_LIBDIR=$SYSROOT/lib/pkgconfig

if [ ! -x "$CC" ]; then echo "ERROR: cross gcc not found at $CC" >&2; exit 1; fi

PKGS="nice glib-2.0 gobject-2.0"
CFLAGS="-O2 -Wall -Wextra -Wno-unused-parameter $(pkg-config --cflags $PKGS)"
LIBS="$(pkg-config --libs $PKGS) -pthread"

WPE_LD="/media/cryptofs/wpe-glibc/lib/ld-linux.so.3"
LDFLAGS="$LIBS -rdynamic -Wl,-rpath-link,$SYSROOT/lib -Wl,--dynamic-linker=$WPE_LD"

echo "== cross-compiling turn_loopback =="
$CC $CFLAGS -c turn_loopback.c -o turn_loopback.o
$CC turn_loopback.o -o turn_loopback $LDFLAGS
echo "   -> turn_loopback (ARM binary)"
file turn_loopback 2>/dev/null || true

echo
echo "Deploy + run on device (same env as the real engine):"
echo "  GST_PLUGIN_PATH=... LD_LIBRARY_PATH=<sig-gst-libs>:<wpe libnice dir> ./turn_loopback <host> <port> <user> <pass>"
