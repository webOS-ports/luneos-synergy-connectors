#!/bin/bash
# Cross-compile vidrtp_sniffer.c for the device. Plain libc sockets only — no LS2/glib deps,
# so this is a much simpler build than build-clonk-probe.sh.
set -e

REPO=/home/herrie/Documents/GitHub/webos-synergy-revival
SRC=$REPO/messaging/whatsapp/calling
TC=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125

export PATH=$TC/bin:$PATH
: "${CC:=arm-unknown-linux-gnueabi-gcc}"
: "${STRIP:=arm-unknown-linux-gnueabi-strip}"

echo "=== CC vidrtp_sniffer.c ==="
$CC -O2 -o "$SRC/vidrtp_sniffer" "$SRC/vidrtp_sniffer.c"
$STRIP "$SRC/vidrtp_sniffer" 2>/dev/null || true
echo "-> $SRC/vidrtp_sniffer ($(stat -c%s "$SRC/vidrtp_sniffer" 2>/dev/null || stat -f%z "$SRC/vidrtp_sniffer") bytes)"
echo
echo "Deploy + run on-device:"
echo "  novacom put file://media/internal/vidrtp_sniffer < $SRC/vidrtp_sniffer"
echo "  # on-device: chmod +x /media/internal/vidrtp_sniffer"
echo "  # capture (before videoCaptureStart): ./vidrtp_sniffer server vidrtp_to_skypekit_key vidrtp_to.log"
echo "  # player (after videoPlayerStart has run ~10-25s): ./vidrtp_sniffer client vidrtp_from_skypekit_key vidrtp_from.log"
