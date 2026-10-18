#!/bin/sh
# Cross-compile the Teams call media engine (teams_media.c) for the HP TouchPad (webOS ARMv7,
# gst-1.20.7 from the Atlas/WPE staging). Simpler than the Signal build: no OpenSSL / no KDF -
# Teams uses SDES keys carried in the SDP, so there is no DH to derive. Produces:
#   teams_media   : standalone ARM binary. `teams_media --loopback` self-tests SRTP-GCM+RTP+Opus;
#                   `teams_media --answer` drives a live call over the stdin/stdout IPC.
# Runtime: run under the wpe-glibc loader (patchelf --set-interpreter) with the WPE gst plugin path,
# same recipe as messaging/signal/calling/media/RUNTIME_STATUS.reference.md.
#
# Pure C, gstreamer/nice only - no libpalmgstskype.so dependency here. The H.264/skypekit-clonk
# video bridge (h264_rtp.c/voipkit.cpp/teams_video_relay.cpp) lives in the plugin process
# (libteams-personal.so, built by ../build-teams.sh) instead: this process's runtime environment
# (patched wpe-glibc interpreter, needed for gst-1.20/libnice) can't simultaneously satisfy
# libpalmgstskype.so's transitive libmedia-clonk/libpbnjson_cpp/liblunaservice dependency chain
# (which needs the OLD system libstdc++/libc) - confirmed via extensive live on-device testing, a
# genuine glibc/libstdc++ ABI conflict, not a missing env var. teams_media now only relays raw,
# already-RTP-framed H.264 packets to/from that other process over a UNIX socket - see
# teams_media.c's top-of-file comment.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); cd "$HERE"

TOOLCHAIN=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125
CROSS=$TOOLCHAIN/bin/arm-unknown-linux-gnueabi-
SYSROOT=/home/herrie/webos/wpe/staging-glibc-252
CC=${CROSS}gcc
[ -x "$CC" ] || { echo "ERROR: cross gcc not at $CC" >&2; exit 1; }

export PKG_CONFIG_PATH=$SYSROOT/lib/pkgconfig
export PKG_CONFIG_LIBDIR=$SYSROOT/lib/pkgconfig
PKGS="gstreamer-1.0 gstreamer-base-1.0 gstreamer-app-1.0 nice glib-2.0 gobject-2.0 gthread-2.0"
CFLAGS=$(pkg-config --cflags $PKGS)
LIBS=$(pkg-config --libs $PKGS)

# -Wl,-rpath-link resolves transitive .so deps inside staging at link time.
RPATHLINK="-Wl,-rpath-link,$SYSROOT/lib"

echo "== compiling teams_media.o (C) =="
$CC -O2 -g -c teams_media.c -o teams_media.o $CFLAGS

echo "== linking teams_media (ARM) =="
$CC -O2 -g -o teams_media teams_media.o $LIBS $RPATHLINK -lpthread

${CROSS}strip teams_media 2>/dev/null || true

# patchelf to the wpe-glibc loader (host-side, not on-device) - same recipe as
# messaging/signal/calling/media/RUNTIME_STATUS.reference.md. Without this, teams_media keeps its
# stock /lib/ld-linux.so.3 interpreter while depending on gst-1.20/libnice libs that need
# wpe-glibc's newer libc; imwrap.sh's LD_LIBRARY_PATH happens to put wpe-glibc's libc.so.6 ahead of
# the system one, so the stock interpreter loads a foreign, ABI-mismatched libc alongside itself -
# undefined behavior that sometimes runs fine and sometimes SIGSEGVs (reproduced live on-device
# after enough respawns). Setting the interpreter directly makes the loader/libc pairing correct
# and deterministic, exactly like imlibpurpletransport/WhatsApp/Telegram already are.
WPE_GLIBC_LD=/media/cryptofs/wpe-glibc/lib/ld-linux.so.3
RUNPATH="/media/cryptofs/sslfix:/media/cryptofs/wpe-glibc/lib:\
/media/cryptofs/apps/usr/palm/applications/com.palm.app.teams/backend/lib:\
/media/cryptofs/apps/usr/palm/applications/org.webosports.app.atlas/deviceroot/wpe-252/lib:\
/usr/lib:/lib"
if command -v patchelf >/dev/null 2>&1; then
	echo "== patchelf: interpreter -> $WPE_GLIBC_LD =="
	patchelf --set-interpreter "$WPE_GLIBC_LD" --set-rpath "$RUNPATH" teams_media
else
	echo "WARNING: patchelf not found on PATH - teams_media keeps its stock interpreter and is" >&2
	echo "         at risk of the glibc/libc mismatch crash described above. Install patchelf." >&2
fi

echo "== built =="
ls -la teams_media
${CROSS}readelf -d teams_media | grep NEEDED
${CROSS}readelf -l teams_media | grep -A1 -i interp
