#!/bin/bash
# Cross-compile + link the voipkit.cpp/h264_rtp.c bridge with the standalone selftest driver,
# against the real, extracted libpalmgstskype.so — same technique as
# build-skypekit-send-test.sh/build-skypekit-decode-test.sh. See
# WHATSAPP_VIDEO_STATUS.md's "hook it up properly" plan, verification step 2.
set -e

REPO=/home/herrie/Documents/GitHub/webos-synergy-revival
SRC=$REPO/messaging/whatsapp/calling
GLUE=$REPO/messaging/facebook-e2ee/plugin/purple-combined/glue
TC=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125
FW_ROOTFS=/home/herrie/Downloads/webosdoctorp305hstnhatt/resources/webOS/nova-cust-image-topaz.rootfs
SOLIB_DIR=$FW_ROOTFS/usr/lib/gstreamer-0.10

export PATH=$TC/bin:$PATH
: "${CC:=arm-unknown-linux-gnueabi-gcc}"
: "${CXX:=arm-unknown-linux-gnueabi-g++}"

echo "=== compiling glue/voipkit.cpp, glue/h264_rtp.c, selftest driver ==="
$CXX -O0 -g -fno-rtti -I"$GLUE" -c "$GLUE/voipkit.cpp" -o "$SRC/.voipkit.o"
$CC  -O0 -g            -I"$GLUE" -c "$GLUE/h264_rtp.c"  -o "$SRC/.h264_rtp.o"
$CC  -O0 -g            -I"$GLUE" -c "$SRC/voipkit_bridge_selftest.c" -o "$SRC/.selftest.o"

echo "=== linking (against real libpalmgstskype.so) ==="
$CXX -O0 -g -o "$SRC/voipkit_bridge_selftest" \
    "$SRC/.selftest.o" "$SRC/.voipkit.o" "$SRC/.h264_rtp.o" \
    -L"$SOLIB_DIR" -lpalmgstskype -lpthread \
    -Wl,--allow-shlib-undefined -Wl,-rpath-link,"$FW_ROOTFS/usr/lib"
rm -f "$SRC/.voipkit.o" "$SRC/.h264_rtp.o" "$SRC/.selftest.o"
echo "-> $SRC/voipkit_bridge_selftest ($(stat -c%s "$SRC/voipkit_bridge_selftest" 2>/dev/null || stat -f%z "$SRC/voipkit_bridge_selftest") bytes)"
echo
echo "Deploy + run on-device (NEEDS LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10, see Part 14;"
echo "run alongside clonk_probe, which already drives videoCaptureStart/videoPlayerStart):"
echo "  novacom put file://media/internal/voipkit_bridge_selftest < $SRC/voipkit_bridge_selftest"
echo "  # on-device: chmod +x /media/internal/voipkit_bridge_selftest"
echo "  LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10 ./voipkit_bridge_selftest 90"
