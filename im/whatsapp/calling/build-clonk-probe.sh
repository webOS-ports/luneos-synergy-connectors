#!/bin/bash
# Cross-compile clonk_probe.c for the device. Mirrors the LS2/glib toolchain setup in
# ../../facebook-e2ee/plugin/purple-combined/build-combined.sh.
set -e

REPO=/home/herrie/Documents/GitHub/webos-synergy-revival
SRC=$REPO/messaging/whatsapp/calling
GLIB_STAGING=/home/herrie/webos/wpe/staging-glibc-252
TC=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125
LUNA_INC=/home/herrie/webos/touchpad-kernel/doctor305/build-deps/luna-service2/include/public
PMLOG_INC=/home/herrie/webos/touchpad-kernel/doctor305/build-deps/woce-build-support/staging/arm-none-linux-gnueabi/include/PmLogLib/IncsPublic
LSSTUB=$REPO/build-output/imtransport/lib/liblunaservice.so

source /home/herrie/webos/wpe/env-glibc-gcc125.sh 2>/dev/null || true
export PATH=$TC/bin:$PATH
: "${CC:=arm-unknown-linux-gnueabi-gcc}"
: "${STRIP:=arm-unknown-linux-gnueabi-strip}"

GCFLAGS="$CFLAGS $CPPFLAGS -I$GLIB_STAGING/include -I$LUNA_INC -I$LUNA_INC/luna-service2 -I$PMLOG_INC $(PKG_CONFIG_PATH=$GLIB_STAGING/lib/pkgconfig PKG_CONFIG_LIBDIR=$GLIB_STAGING/lib/pkgconfig pkg-config --cflags glib-2.0)"
# --allow-shlib-undefined: the imtransport liblunaservice.so stub's own transitive deps
# (libcjson/libmjson/libgoodfork) aren't present in this cross sysroot — they resolve fine
# on-device (this is link-time only, same reason build-combined.sh's .so target doesn't hit
# this: -shared doesn't verify transitive symbols the way a plain executable link does).
GLDFLAGS="$LDFLAGS -Wl,--allow-shlib-undefined -L$GLIB_STAGING/lib $(PKG_CONFIG_PATH=$GLIB_STAGING/lib/pkgconfig PKG_CONFIG_LIBDIR=$GLIB_STAGING/lib/pkgconfig pkg-config --libs glib-2.0) -L$(dirname "$LSSTUB") -llunaservice"

echo "=== CC clonk_probe.c ==="
$CC $GCFLAGS -o "$SRC/clonk_probe" "$SRC/clonk_probe.c" $GLDFLAGS
$STRIP "$SRC/clonk_probe" 2>/dev/null || true
echo "-> $SRC/clonk_probe ($(stat -c%s "$SRC/clonk_probe" 2>/dev/null || stat -f%z "$SRC/clonk_probe") bytes)"
echo
echo "Deploy + run (real liblunaservice resolves on-device, the stub above is link-time only):"
echo "  novacom put file://media/internal/clonk_probe < $SRC/clonk_probe"
echo "  # then on-device: chmod +x /media/internal/clonk_probe && /media/internal/clonk_probe"
