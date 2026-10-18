#!/bin/bash
# Cross-compile skypekit_decode_test.cpp, linking directly against the real, extracted
# libpalmgstskype.so so we reuse its actual compiled SkypeKit wire-format DECODER instead of
# hand-parsing captured bytes. See WHATSAPP_VIDEO_STATUS.md Part 18 for why.
set -e

REPO=/home/herrie/Documents/GitHub/webos-synergy-revival
SRC=$REPO/messaging/whatsapp/calling
TC=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125
FW_ROOTFS=/home/herrie/Downloads/webosdoctorp305hstnhatt/resources/webOS/nova-cust-image-topaz.rootfs
SOLIB_DIR=$FW_ROOTFS/usr/lib/gstreamer-0.10

export PATH=$TC/bin:$PATH
: "${CXX:=arm-unknown-linux-gnueabi-g++}"

echo "=== CXX skypekit_decode_test.cpp (linking against real libpalmgstskype.so) ==="
$CXX -O0 -g -fno-rtti -o "$SRC/skypekit_decode_test" "$SRC/skypekit_decode_test.cpp" \
    -L"$SOLIB_DIR" -lpalmgstskype \
    -Wl,--allow-shlib-undefined -Wl,-rpath-link,"$FW_ROOTFS/usr/lib"
echo "-> $SRC/skypekit_decode_test ($(stat -c%s "$SRC/skypekit_decode_test" 2>/dev/null || stat -f%z "$SRC/skypekit_decode_test") bytes)"
echo
echo "Deploy + run on-device (NEEDS LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10, see Part 14):"
echo "  novacom put file://media/internal/skypekit_decode_test < $SRC/skypekit_decode_test"
echo "  # on-device:"
echo "  chmod +x /media/internal/skypekit_decode_test"
echo "  LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10 ./skypekit_decode_test server /tmp/decode_test_key &"
echo "  LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10 ./skypekit_decode_test client /tmp/decode_test_key vidrtp_to_captured_part17.bin"
