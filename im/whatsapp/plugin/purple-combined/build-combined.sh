#!/bin/bash
# Cross-compile the COMBINED WhatsApp+Facebook prpl -> ONE libwhatsmeow.so for webOS ARM.
# Adapted from ../../../whatsapp/build-whatsapp.sh: same two-stage build, plus the Facebook
# (messagix) half — glue/gometa_init.c (second prpl registration) + root gometabridge.c
# (the Go->purple dispatch). One .so = one Go runtime hosting BOTH prpls.
set -e

REPO=/home/herrie/Documents/GitHub/webos-synergy-revival
SRC=$REPO/messaging/facebook-e2ee/plugin/purple-combined
GLUE=$SRC/glue
BUILD=$SRC/build-arm
PURPLE=$REPO/messaging/libpurple
GLIB_STAGING=/home/herrie/webos/wpe/staging-glibc-252
# WebRTC noise-suppression sources (harvested from libtgvoip) for the WhatsApp-call mic NS (glue/denoise.c)
WEBRTC_DSP=$REPO/messaging/telegram/plugin/libtgvoip/webrtc_dsp
GO=${GO:-/home/herrie/webos/gotool/go125/bin/go}
TC=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125

# webOS WhatsApp calling (glue/call.c): luna-service2 + PmLog headers for the in-plugin
# com.palm.whatsapp.call LS2 service, and ALSA (glib staging) for its audio bridge. Link the LS2
# stub .so - the real liblunaservice resolves at load inside imlibpurpletransport.
LUNA_INC=/home/herrie/webos/touchpad-kernel/doctor305/build-deps/luna-service2/include/public
PMLOG_INC=/home/herrie/webos/touchpad-kernel/doctor305/build-deps/woce-build-support/staging/arm-none-linux-gnueabi/include/PmLogLib/IncsPublic
LSSTUB=$REPO/build-output/imtransport/lib/liblunaservice.so

# glue/voipkit.cpp links directly against the real, headerless libpalmgstskype.so (SkypeKit's
# native RTP transport — see messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md) using the
# asm-mangled-symbol trick proven in that directory's skypekit_send_test.cpp/
# skypekit_decode_test.cpp. FW_ROOTFS/SOLIB_DIR match those scripts exactly.
# Resolved from a candidate list rather than one hardcoded path -- the doctor extraction under
# ~/Downloads this used to point at is long gone. topaz first: that is the TouchPad, and the
# mantaray build of this library is a different binary. libpalmgstskype is LEGACY-ONLY, so
# WA_VOIPKIT=0 builds without the video bridge for targets that lack it (LuneOS).
FW_ROOTFS=${FW_ROOTFS:-}
if [ -z "$FW_ROOTFS" ]; then
  for c in /home/herrie/webos/305att/nova-cust-image-topaz.rootfs-att \
           /home/herrie/webos/224/nova-cust-image-mantaray.rootfs \
           /home/herrie/Downloads/webosdoctorp305hstnhatt/resources/webOS/nova-cust-image-topaz.rootfs; do
    [ -f "$c/usr/lib/gstreamer-0.10/libpalmgstskype.so" ] && { FW_ROOTFS=$c; break; }
  done
fi
SOLIB_DIR=$FW_ROOTFS/usr/lib/gstreamer-0.10

WA_VOIPKIT=${WA_VOIPKIT:-1}
if [ "$WA_VOIPKIT" = "1" ]; then
  if [ ! -f "$SOLIB_DIR/libpalmgstskype.so" ]; then
    echo "!! libpalmgstskype.so not found (looked under the candidate rootfs list)."
    echo "   Set FW_ROOTFS=/path/to/rootfs, or WA_VOIPKIT=0 to build without the video bridge."
    exit 1
  fi
  VOIPKIT_LDFLAGS="-L$SOLIB_DIR -lpalmgstskype
                   -Wl,-rpath-link,$FW_ROOTFS/usr/lib -Wl,-rpath,/usr/lib/gstreamer-0.10"
else
  VOIPKIT_LDFLAGS=""
fi

source /home/herrie/webos/wpe/env-glibc-gcc125.sh 2>/dev/null || true
export PATH=$TC/bin:$PATH
: "${CC:=arm-unknown-linux-gnueabi-gcc}"
: "${CXX:=arm-unknown-linux-gnueabi-g++}"
: "${STRIP:=arm-unknown-linux-gnueabi-strip}"
export PKG_CONFIG_PATH=$PURPLE/lib/pkgconfig:$GLIB_STAGING/lib/pkgconfig
export PKG_CONFIG_LIBDIR=$PKG_CONFIG_PATH
VERSION=$(cat "$SRC/VERSION" 2>/dev/null || echo 0.0.1)

mkdir -p "$BUILD"

echo "=== STAGE 1: Go c-archive (libwhatsmeow.a — WhatsApp + Facebook/messagix) armv7 ==="
export GOPATH=${GOPATH:-/home/herrie/webos/gotool/gopath}
export GOCACHE=${GOCACHE:-/home/herrie/webos/gotool/gocache}
export GOMODCACHE=${GOMODCACHE:-/home/herrie/webos/gotool/gomod}
export GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=1
export CGO_CFLAGS="-I$PURPLE/include/libpurple -I$PURPLE/include -I$GLIB_STAGING/include -I$GLIB_STAGING/include/opus $(pkg-config --cflags glib-2.0) -DPLUGIN_VERSION=$VERSION -D_DEFAULT_SOURCE"
export CGO_LDFLAGS="-L$PURPLE/lib -L$GLIB_STAGING/lib -lpurple -lopusfile -lopus -logg"
( cd "$SRC" && "$GO" build -buildmode=c-archive -o "$BUILD/libwhatsmeow.a" . )
echo "  -> $(ls -la "$BUILD/libwhatsmeow.a" | awk '{print $5}') bytes"

echo "=== STAGE 2: compile C glue (whatsmeow + gometa_init) ==="
GCFLAGS="$CFLAGS $CPPFLAGS -fPIC -DPURPLE_PLUGINS -DPLUGIN_VERSION=$VERSION \
	-I$GLUE -I$SRC -I$BUILD -I$PURPLE/include $(pkg-config --cflags purple glib-2.0) -I$GLIB_STAGING/include -I$GLIB_STAGING/include/opus \
	-I$LUNA_INC -I$LUNA_INC/luna-service2 -I$PMLOG_INC -I$WEBRTC_DSP -I$REPO/messaging/common"
OBJS=()
for s in init login qrcode bridge process_message display_message groups blist \
         send_message handle_attachment send_file presence options receipt pixbuf commands \
         call denoise aec h264_rtp gometa_init; do
	echo "  CC glue/$s.c"; $CC $GCFLAGS -c "$GLUE/$s.c" -o "$BUILD/glue_$s.o"; OBJS+=("$BUILD/glue_$s.o")
done
# root C files (bridge/constants = whatsmeow; gometabridge = facebook dispatch)
for s in bridge constants gometabridge; do
	echo "  CC $s.c"; $CC $GCFLAGS -c "$SRC/$s.c" -o "$BUILD/root_$s.o"; OBJS+=("$BUILD/root_$s.o")
done

# glue/voipkit.cpp: C++ (asm-mangled SkypeKit symbol bindings need extern "C" from C++, see
# above) — compiled separately with $CXX, otherwise same include set as the C glue.
# WA_VOIPKIT=0 swaps the palmgstskype backend for the null one, same seam as Teams.
if [ "$WA_VOIPKIT" = "1" ]; then
echo "  CXX glue/voipkit.cpp"
$CXX $CFLAGS $CPPFLAGS -fPIC -fno-rtti -I"$GLUE" -I"$SRC" -I"$BUILD" \
	-c "$GLUE/voipkit.cpp" -o "$BUILD/glue_voipkit.o"
else
echo "  CC  glue/voipkit_none.c (no libpalmgstskype: video bridge disabled)"
$CC $CFLAGS $CPPFLAGS -fPIC -I"$GLUE" -I"$SRC" -I"$BUILD" \
	-c "$GLUE/voipkit_none.c" -o "$BUILD/glue_voipkit.o"
fi
OBJS+=("$BUILD/glue_voipkit.o")

echo "=== STAGE 2b: WebRTC float noise-suppression static lib (libwarns.a) ==="
# The proven source set libtgvoip compiles for its float NS (signal_processing + fft4g + ns), built
# standalone here so glue/denoise.c can WebRtcNs_* without pulling the whole voip engine. NDEBUG makes
# the NS's RTC_DCHECK_* no-ops (the only rtc_base dep), so it's pure C -- no libstdc++ needed.
NSFLAGS="-O2 -fPIC -std=gnu11 -DNDEBUG -DWEBRTC_POSIX -DWEBRTC_APM_DEBUG_DUMP=0 -DWEBRTC_NS_FLOAT -I$WEBRTC_DSP"
NS_SRCS=(
	common_audio/signal_processing/auto_correlation.c common_audio/signal_processing/auto_corr_to_refl_coef.c
	common_audio/signal_processing/complex_fft.c common_audio/signal_processing/copy_set_operations.c
	common_audio/signal_processing/cross_correlation.c common_audio/signal_processing/division_operations.c
	common_audio/signal_processing/downsample_fast.c common_audio/signal_processing/energy.c
	common_audio/signal_processing/filter_ar.c common_audio/signal_processing/filter_ar_fast_q12.c
	common_audio/signal_processing/filter_ma_fast_q12.c common_audio/signal_processing/get_hanning_window.c
	common_audio/signal_processing/get_scaling_square.c common_audio/signal_processing/ilbc_specific_functions.c
	common_audio/signal_processing/levinson_durbin.c common_audio/signal_processing/lpc_to_refl_coef.c
	common_audio/signal_processing/min_max_operations.c common_audio/signal_processing/randomization_functions.c
	common_audio/signal_processing/real_fft.c common_audio/signal_processing/refl_coef_to_lpc.c
	common_audio/signal_processing/resample_48khz.c common_audio/signal_processing/resample_by_2.c
	common_audio/signal_processing/resample_by_2_internal.c common_audio/signal_processing/resample.c
	common_audio/signal_processing/resample_fractional.c common_audio/signal_processing/spl_init.c
	common_audio/signal_processing/spl_inl.c common_audio/signal_processing/splitting_filter1.c
	common_audio/signal_processing/spl_sqrt.c common_audio/signal_processing/sqrt_of_one_minus_x_squared.c
	common_audio/signal_processing/vector_scaling_operations.c common_audio/signal_processing/dot_product_with_scale.cc
	common_audio/third_party/fft4g/fft4g.c
	common_audio/signal_processing/complex_bit_reverse.c common_audio/ring_buffer.c
	common_audio/third_party/spl_sqrt_floor/spl_sqrt_floor.c
	modules/audio_processing/ns/ns_core.c modules/audio_processing/ns/noise_suppression.c
)
# AECM (mobile acoustic echo canceller) C++ sources for glue/aec.c. C path only (no WEBRTC_HAS_NEON),
# so no cpu_features/NEON-core dep; shares the signal_processing objects above.
AEC_SRCS=(
	modules/audio_processing/aecm/aecm_core.cc modules/audio_processing/aecm/aecm_core_c.cc
	modules/audio_processing/aecm/echo_control_mobile.cc
	modules/audio_processing/utility/delay_estimator.cc modules/audio_processing/utility/delay_estimator_wrapper.cc
)
AECFLAGS="-O2 -fPIC -std=c++11 -DNDEBUG -DWEBRTC_POSIX -DWEBRTC_APM_DEBUG_DUMP=0 -I$WEBRTC_DSP"
WOBJS=()
for s in "${NS_SRCS[@]}"; do
	o="$BUILD/warns_$(echo "$s" | tr '/.' '__').o"
	case "$s" in
		*.cc) arm-unknown-linux-gnueabi-g++ $NSFLAGS -c "$WEBRTC_DSP/$s" -o "$o" ;;
		*)    $CC $NSFLAGS -c "$WEBRTC_DSP/$s" -o "$o" ;;
	esac
	WOBJS+=("$o")
done
for s in "${AEC_SRCS[@]}"; do
	o="$BUILD/warns_$(echo "$s" | tr '/.' '__').o"
	arm-unknown-linux-gnueabi-g++ $AECFLAGS -c "$WEBRTC_DSP/$s" -o "$o"
	WOBJS+=("$o")
done
arm-unknown-linux-gnueabi-ar rcs "$BUILD/libwarns.a" "${WOBJS[@]}"
echo "  -> libwarns.a $(ls -la "$BUILD/libwarns.a" | awk '{print $5}') bytes"

echo "=== STAGE 3: link libwhatsmeow.so ==="
# -lpalmgstskype/-L$SOLIB_DIR/-rpath-link resolve glue/voipkit.cpp's real SkypeKit symbols at
# link time; -rpath (not just -rpath-link) bakes /usr/lib/gstreamer-0.10 into the built .so's own
# DT_RUNPATH so it finds libpalmgstskype.so at runtime on-device without needing
# LD_LIBRARY_PATH set by whatever launches this plugin (unlike the standalone test tools in
# messaging/whatsapp/calling/, which do need it set manually each run).
# -Bsymbolic-functions: this plugin and Teams' (purple-teams) both dlopen into the SAME
# imlibpurpletransport process, and both define the identically-named voipkit_video_start/
# _receive_frame/_stop/_wait_thread_b bridge symbols (Teams' copy was ported verbatim from this
# one). Neither .so hides these symbols, so without this flag, GModule's default global symbol
# export lets ELF interposition redirect one plugin's calls into the OTHER plugin's copy depending
# on dlopen order -- confirmed live: this plugin's own calls into voipkit_video_start were
# silently not running this plugin's code at all. -Bsymbolic-functions makes intra-.so calls to
# these bind to the LOCAL definition first, regardless of what else is loaded.
$CC -shared -fPIC $LDFLAGS -Wl,-Bsymbolic-functions -Wl,-soname,libwhatsmeow.so -o "$BUILD/libwhatsmeow.so" \
	"${OBJS[@]}" "$BUILD/libwhatsmeow.a" "$BUILD/libwarns.a" \
	-L"$PURPLE/lib" -L"$GLIB_STAGING/lib" $(pkg-config --libs purple glib-2.0) \
	"$LSSTUB" -lasound \
	$VOIPKIT_LDFLAGS -Wl,--allow-shlib-undefined \
	-lopusfile -lopus -logg -lpthread -ldl -lm -lresolv -lstdc++

echo "=== Stripping ==="
cp "$BUILD/libwhatsmeow.so" "$BUILD/libwhatsmeow.stripped.so"
"$STRIP" --strip-unneeded "$BUILD/libwhatsmeow.stripped.so"
ls -la "$BUILD/libwhatsmeow.stripped.so"
echo ""
echo "=== NEEDED ===" && arm-unknown-linux-gnueabi-readelf -d "$BUILD/libwhatsmeow.so" | grep NEEDED
echo "purple_init_plugin: $(arm-unknown-linux-gnueabi-nm -D "$BUILD/libwhatsmeow.so" | grep -c purple_init_plugin)"
echo "prpl ids: $(arm-unknown-linux-gnueabi-strings "$BUILD/libwhatsmeow.so" | grep -m1 -E 'prpl-hehoe-whatsmeow'); $(arm-unknown-linux-gnueabi-strings "$BUILD/libwhatsmeow.so" | grep -m1 'prpl-gometa')"
