#!/bin/sh
# build-turn-loopback-host.sh - native (x86_64) build of turn_loopback.c, for running one side of
# the TURN loopback test from THIS machine instead of the TouchPad - a genuinely cross-network/
# cross-IP test (the on-device-only test had both sides sharing one IP, which Cloudflare's anycast
# TURN infra could conceivably route identically for both allocations, understating any cross-network
# routing issue). Reuses the webOS sysroot's installed libnice headers (same 0.1.21 API) but links
# against the system's own libnice.so.10 runtime (Ubuntu ships 0.1.21 too - same major/API version).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

SYSROOT_INC=/home/herrie/webos/wpe/staging-glibc-252/include
SYSLIB=/usr/lib/x86_64-linux-gnu/libnice.so.10

[ -f "$SYSLIB" ] || { echo "ERROR: $SYSLIB not found (apt install libnice10?)" >&2; exit 1; }

CFLAGS="-O2 -Wall -Wextra -Wno-unused-parameter -I$SYSROOT_INC $(pkg-config --cflags glib-2.0 gobject-2.0)"
LIBS="$(pkg-config --libs glib-2.0 gobject-2.0) -pthread"

echo "== native (host) build of turn_loopback =="
cc $CFLAGS -c turn_loopback.c -o turn_loopback_host.o
cc turn_loopback_host.o "$SYSLIB" $LIBS -o turn_loopback_host
echo "   -> turn_loopback_host"
file turn_loopback_host 2>/dev/null || true
