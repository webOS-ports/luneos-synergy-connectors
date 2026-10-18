#!/bin/bash
# Cross-compile skypekit_send_test.cpp, linking directly against the real, extracted
# libpalmgstskype.so from the device firmware image so we reuse its actual compiled
# SkypeKit wire-format encoder instead of reimplementing it by hand. See
# WHATSAPP_VIDEO_STATUS.md Part 13 for why.
set -e

REPO=/home/herrie/Documents/GitHub/webos-synergy-revival
SRC=$REPO/messaging/whatsapp/calling
TC=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125
FW_ROOTFS=/home/herrie/Downloads/webosdoctorp305hstnhatt/resources/webOS/nova-cust-image-topaz.rootfs
SOLIB_DIR=$FW_ROOTFS/usr/lib/gstreamer-0.10

export PATH=$TC/bin:$PATH
: "${CXX:=arm-unknown-linux-gnueabi-g++}"
: "${STRIP:=arm-unknown-linux-gnueabi-strip}"

echo "=== CXX skypekit_send_test.cpp (linking against real libpalmgstskype.so) ==="
$CXX -O0 -g -fno-rtti -o "$SRC/skypekit_send_test" "$SRC/skypekit_send_test.cpp" \
    -L"$SOLIB_DIR" -lpalmgstskype \
    -Wl,--allow-shlib-undefined -Wl,-rpath-link,"$FW_ROOTFS/usr/lib"
echo "-> $SRC/skypekit_send_test ($(stat -c%s "$SRC/skypekit_send_test" 2>/dev/null || stat -f%z "$SRC/skypekit_send_test") bytes)"
echo
echo "Deploy + run on-device (NEEDS libpalmgstskype.so at runtime — already present on"
echo "device at /usr/lib/gstreamer-0.10/libpalmgstskype.so, no extra deploy needed for it):"
echo "  novacom put file://media/internal/skypekit_send_test < $SRC/skypekit_send_test"
echo "  # on-device: chmod +x /media/internal/skypekit_send_test"
echo "  # AFTER videoPlayerStart has run long enough for the socket to come up:"
echo "  ./skypekit_send_test /media/internal/test_payload.bin"
