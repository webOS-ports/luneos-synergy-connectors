#!/bin/sh
# build-signal-media.sh - cross-compile the Signal call media engine for the HP TouchPad (webOS,
# ARMv7 softfp glibc). Produces:
#   - signal_media        : standalone ARM test binary (run `signal_media --loopback` ON DEVICE)
#   - libsignalmedia.a    : static lib (srtp_kdf.o + signal_media.o, -DSIGNAL_MEDIA_NO_MAIN) for the
#                           future presage bridge to link the signal_media_* API against.
#
# Deps (all confirmed present 2026-07-21):
#   toolchain : /home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125  (gcc 12.5, softfp)
#   sysroot   : /home/herrie/webos/wpe/staging-glibc-252  (gstreamer 1.20.7, gstreamer-app, libnice
#               0.1.21, libsrtp2, opus, glib) via pkg-config
#   openssl   : link libcrypto.so.1.1 explicitly (device runtime is OpenSSL 1.1.1w; the staging
#               headers are 3.5.7 but srtp_kdf.c only uses the stable EVP_PKEY/HKDF API that both
#               versions export - the versioned symbols resolve to @@OPENSSL_1_1_x at link time).
#
# Usage: ./build-signal-media.sh            # cross-compile for ARM (default)
#        ./build-signal-media.sh host        # best-effort host build of the KDF test only
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

# --------------------------------------------------------------- host (KDF only) -----------------
if [ "$1" = "host" ]; then
    echo "== host build: srtp_kdf self-test (needs system OpenSSL) =="
    cc -DSRTP_KDF_TEST srtp_kdf.c -o srtp_kdf_host -lcrypto
    echo "run: ./srtp_kdf_host   (must match srtp_kdf.py EXPECT line)"
    echo "NOTE: the GStreamer loopback needs the device (or a host with gstreamer-1.0 + the"
    echo "      srtp/opus/nice/rtp plugins); this host has no gstreamer-1.0.pc, so skip it here."
    exit 0
fi

# --------------------------------------------------------------- cross (ARM) ---------------------
TOOLCHAIN=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125
CROSS=$TOOLCHAIN/bin/arm-unknown-linux-gnueabi-
SYSROOT=/home/herrie/webos/wpe/staging-glibc-252
CC=${CROSS}gcc
AR=${CROSS}ar

# Use ONLY the staging .pc files (not any host ones). pkg-config already emits absolute -I/-L paths
# into $SYSROOT, so we do NOT set PKG_CONFIG_SYSROOT_DIR (that would double-prefix) and we do NOT
# pass --sysroot to gcc (that would hide the toolchain's own libc headers / stdio.h).
export PKG_CONFIG_PATH=$SYSROOT/lib/pkgconfig
export PKG_CONFIG_LIBDIR=$SYSROOT/lib/pkgconfig

if [ ! -x "$CC" ]; then echo "ERROR: cross gcc not found at $CC" >&2; exit 1; fi

PKGS="gstreamer-1.0 gstreamer-app-1.0 gstreamer-base-1.0 nice libsrtp2 opus speexdsp"
GST_CFLAGS=$(pkg-config --cflags $PKGS)
GST_LIBS=$(pkg-config --libs $PKGS)

# OpenSSL: the staging libnice/libsrtp are themselves linked against OpenSSL 3.x (libcrypto.so.3,
# the copy Atlas/WPE 2.52 bundles in its deviceroot). The media engine runs INSIDE that same Atlas
# GStreamer runtime, so it must use the SAME libcrypto - link libcrypto.so.3, NOT the webOS system
# 1.1.1w. srtp_kdf.c's EVP_PKEY/HKDF calls are API-identical on 1.1 and 3.x. (If a future build
# instead runs the KDF inside the presage/1.1.1 process, swap this to -l:libcrypto.so.1.1.)
SSL_CFLAGS="-I$SYSROOT/include"
SSL_LIBS="-L$SYSROOT/lib -lcrypto"

# -Wl,-rpath-link lets the linker resolve the transitive .so deps (gio/gmodule/etc.) inside staging.
# --dynamic-linker: the engine loads the MODERN wpe-glibc libc/libpthread (the transport spawns it with
# LD_LIBRARY_PATH into /media/cryptofs/wpe-glibc/lib), so it MUST run under the wpe-glibc loader. The
# cross-toolchain default interp is the device's stock /lib/ld-linux.so.3 -> ld-2.8.so (glibc 2.8),
# which cannot set up the modern libpthread's TLS (_dl_get_tls_static_info) and segfaults before main.
# Same loader the (interp-patched) transport uses. See [[usb-drive-mode-media-internal-blockers]].
WPE_LD="/media/cryptofs/wpe-glibc/lib/ld-linux.so.3"
CFLAGS="-O2 -Wall -Wextra -Wno-unused-parameter $GST_CFLAGS $SSL_CFLAGS"
LDFLAGS="$GST_LIBS $SSL_LIBS -lgobject-2.0 -lglib-2.0 -pthread -rdynamic -Wl,-rpath-link,$SYSROOT/lib -Wl,--dynamic-linker=$WPE_LD"

echo "== cross-compiling for ARM (softfp glibc) =="
echo "   CC = $CC"

# Objects for the static lib (no main; -DSIGNAL_MEDIA_NO_MAIN).
$CC $CFLAGS -DSIGNAL_MEDIA_NO_MAIN -c srtp_kdf.c    -o srtp_kdf.o
$CC $CFLAGS -DSIGNAL_MEDIA_NO_MAIN -c signal_media.c -o signal_media_lib.o
$AR rcs libsignalmedia.a srtp_kdf.o signal_media_lib.o
echo "   -> libsignalmedia.a"

# Standalone test binary (with main()).
$CC $CFLAGS -c signal_media.c -o signal_media_main.o
$CC signal_media_main.o srtp_kdf.o -o signal_media $LDFLAGS
echo "   -> signal_media (ARM binary)"

echo
echo "== verify =="
file signal_media 2>/dev/null || true
${CROSS}nm signal_media 2>/dev/null | grep -E "signal_media_start|signal_negotiate_srtp_keys|signal_media_loopback_selftest" | head
echo
echo "Deploy signal_media to the device and run:  ./signal_media --loopback"
echo "(needs LD_LIBRARY_PATH to the wpe-252 libs + GST_PLUGIN_PATH to its gstreamer-1.0 plugins;"
echo " and for a REAL call, the SYSTEM libasound so alsa 'voip'/'voipsource' route to pulse - see README.)"
