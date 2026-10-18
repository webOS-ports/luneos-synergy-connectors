cmake_minimum_required(VERSION 3.2 FATAL_ERROR)
# versions before 3.2 don't pass CMAKE_EXE_LINKER_FLAGS when using try_compile

set(VERSION 0.8.1)
project(tdlib-purple VERSION ${VERSION} LANGUAGES C CXX)

find_package(Td REQUIRED)
math(EXPR TDLIB_VERSION_NUMBER "10000*${Td_VERSION_MAJOR} + 100*${Td_VERSION_MINOR} + ${Td_VERSION_PATCH}")
# webOS Teams port: accept tdlib >= 1.7.9 (was pinned to exactly 1.7.9). Upgraded to
# tdlib 1.8.66 (MTPROTO layer 228) to clear Telegram's UPDATE_APP_TO_LOGIN gate.
if (${TDLIB_VERSION_NUMBER} LESS 10709)
    # Error message must begin with "tdlib version" for a grep command from readme
    message(FATAL_ERROR "tdlib version 1.7.9 or newer is required
(version found: ${Td_VERSION_MAJOR}.${Td_VERSION_MINOR}.${Td_VERSION_PATCH})")
endif (${TDLIB_VERSION_NUMBER} LESS 10709)

set(NoPkgConfig FALSE CACHE BOOL "Do not use pkg-config")
set(NoWebp FALSE CACHE BOOL "Do not decode webp stickers")
set(NoBundledLottie FALSE CACHE BOOL "Do not use bundled rlottie library")
set(NoLottie FALSE CACHE BOOL "Disable animated sticker conversion")
set(NoTranslations FALSE CACHE BOOL "Disable translation support")
set(NoVoip FALSE CACHE BOOL "Disable voice call support")
set(NoTgcallsLite FALSE CACHE BOOL "Disable tgcalls-lite (ICE/DTLS-SRTP video calling engine)")
set(tgvoip_INCLUDE_DIRS "" CACHE STRING "Path to libtgvoip headers")
set(tgvoip_LIBRARIES "tgvoip" CACHE STRING "tgvoip library to link against")
set(API_ID 94575 CACHE STRING "API id")
set(API_HASH a3406de8d171bb422bb6ddf3bbd800e2 CACHE STRING "API hash")
set(STUFF "" CACHE STRING "")

if (NOT NoPkgConfig)
    include(FindPkgConfig)
    pkg_check_modules(Purple REQUIRED purple)
    if (NOT NoWebp)
        pkg_check_modules(libwebp libwebp)
        pkg_check_modules(libpng libpng)
    endif (NOT NoWebp)
    pkg_get_variable(PURPLE_PLUGIN_DIR purple plugindir)
    pkg_get_variable(PURPLE_DATA_DIR purple datarootdir)
    if (NOT NoTgcallsLite)
        # tgcalls-lite's own dependencies -- all already staged/proven cross-building on this
        # toolchain for Atlas's in-browser WebRTC support (see plugin/tgcalls-lite/ for the engine
        # itself and its spike/ tests, all passing under qemu-arm-static before this was wired in
        # here). NOT Google's own libwebrtc/Bazel build -- see plugin/tgcalls-lite/reference/ for
        # why that's a from-scratch reimplementation instead of a vendor-and-build.
        pkg_check_modules(TgcallsLite REQUIRED nice libsrtp2 openssl json-glib-1.0)
    endif (NOT NoTgcallsLite)
endif (NOT NoPkgConfig)

link_directories(${Purple_LIBRARY_DIRS})
if (NOT NoTgcallsLite)
    link_directories(${TgcallsLite_LIBRARY_DIRS})
endif (NOT NoTgcallsLite)

if (NOT NoWebp)
    if ("${libwebp_LIBRARIES}" STREQUAL "")
        message(FATAL_ERROR "Webp library not found, build with -DNoWebp=TRUE to disable webp sticker decoding")
    endif ("${libwebp_LIBRARIES}" STREQUAL "")
    if ("${libpng_LIBRARIES}" STREQUAL "")
        message(FATAL_ERROR "libpng not found, build with -DNoWebp=TRUE to disable webp sticker decoding")
    endif ("${libpng_LIBRARIES}" STREQUAL "")
    link_directories(${libwebp_LIBRARY_DIRS} ${libpng_LIBRARY_DIRS})
endif (NOT NoWebp)

configure_file(buildopt.h.in buildopt.h)
configure_file(config.cpp.in config.cpp)

add_library(telegram-tdlib SHARED
    tdlib-purple.cpp
    td-client.cpp
    transceiver.cpp
    account-data.cpp
    purple-info.cpp
    ${CMAKE_BINARY_DIR}/config.cpp
    client-utils.cpp
    receiving.cpp
    format.cpp
    sticker.cpp
    file-transfer.cpp
    call.cpp
    call-luna.cpp
    identifiers.cpp
    secret-chat.cpp
    voipkit.cpp
    voipkit-tgvoip.cpp
    h264_rtp.c
)

if (NOT NoTgcallsLite)
    target_sources(telegram-tdlib PRIVATE
        ../tgcalls-lite/signaling_message.cpp
        ../tgcalls-lite/crypto_helper.cpp
        ../tgcalls-lite/encrypted_connection.cpp
        ../tgcalls-lite/ice_session.cpp
        ../tgcalls-lite/dtls_transport.cpp
        ../tgcalls-lite/srtp_session.cpp
        ../tgcalls-lite/media_session.cpp
        ../tgcalls-lite/call_engine.cpp
    )
endif (NOT NoTgcallsLite)

# libpurple uses the deprecated glib-type `GParameter` and the deprecated glib-macro `G_CONST_RETURN`, which
# spams the console with useless warnings that we can do nothing about.
target_compile_definitions(telegram-tdlib PRIVATE GLIB_DISABLE_DEPRECATION_WARNINGS)
#target_compile_options(telegram-tdlib PRIVATE -Wmissing-declarations)

include_directories(${Purple_INCLUDE_DIRS} ${CMAKE_BINARY_DIR})
target_link_libraries(telegram-tdlib PRIVATE Td::TdStatic ${Purple_LIBRARIES})

set(VERSION_SCRIPT_FLAG "-Wl,--version-script=${CMAKE_SOURCE_DIR}/ld_version_script")
set(CMAKE_EXE_LINKER_FLAGS ${VERSION_SCRIPT_FLAG})
try_compile(VERSION_SCRIPT_SUPPORTED ${CMAKE_BINARY_DIR} ${CMAKE_SOURCE_DIR}/cmake/testflag.cpp)
set(CMAKE_EXE_LINKER_FLAGS "")
if (${VERSION_SCRIPT_SUPPORTED})
    set_target_properties(telegram-tdlib PROPERTIES LINK_FLAGS ${VERSION_SCRIPT_FLAG})
endif (${VERSION_SCRIPT_SUPPORTED})

if (NOT NoWebp)
    include_directories(${libwebp_INCLUDE_DIRS} ${libpng_INCLUDE_DIRS})
    target_link_libraries(telegram-tdlib PRIVATE ${libwebp_LIBRARIES} ${libpng_LIBRARIES})
endif (NOT NoWebp)

# Bumped 14 -> 17: tgcalls-lite (plugin/tgcalls-lite/) uses std::optional and other C++17 features.
# C++17 is a superset of the C++14 subset the rest of this codebase was written against, so this
# shouldn't change how any existing file compiles.
set_property(TARGET telegram-tdlib PROPERTY CXX_STANDARD 17)

set(BUILD_SHARED_LIBS OFF)
add_subdirectory(fmt)
target_compile_options(fmt PRIVATE -fPIC)
target_link_libraries(telegram-tdlib PRIVATE fmt::fmt)

if (NOT NoLottie)
    if (NOT NoBundledLottie)
        add_subdirectory(rlottie)
        target_compile_options(rlottie PRIVATE -fPIC)
        target_include_directories(telegram-tdlib PRIVATE rlottie/inc)
    endif (NOT NoBundledLottie)
    target_link_libraries(telegram-tdlib PRIVATE rlottie)
    # When building with cygwin, lack of LOT_BUILD would add dllimport attribute to function
    # prototypes from rlottie, causing them to have different name mangling from what they had when
    # building rlottie.
    target_compile_definitions(telegram-tdlib PRIVATE LOT_BUILD)
endif (NOT NoLottie)

if (NOT DEFINED SHARE_INSTALL_PREFIX)
    set(SHARE_INSTALL_PREFIX "share")
endif (NOT DEFINED SHARE_INSTALL_PREFIX)

if (NOT tgvoip_INCLUDE_DIRS STREQUAL "")
    target_include_directories(telegram-tdlib SYSTEM PRIVATE ${tgvoip_INCLUDE_DIRS})
endif (NOT tgvoip_INCLUDE_DIRS STREQUAL "")

# luna-service2 for the com.palm.telegram.call LS2 service (call-luna.cpp)
set(lunaservice_INCLUDE_DIRS "" CACHE STRING "Path to luna-service2 public headers")
set(lunaservice_LIBRARIES "lunaservice" CACHE STRING "luna-service2 library to link")
if (NOT lunaservice_INCLUDE_DIRS STREQUAL "")
    target_include_directories(telegram-tdlib SYSTEM PRIVATE ${lunaservice_INCLUDE_DIRS})
endif (NOT lunaservice_INCLUDE_DIRS STREQUAL "")
target_link_libraries(telegram-tdlib PRIVATE ${lunaservice_LIBRARIES})
if (NOT NoTgcallsLite)
    target_include_directories(telegram-tdlib SYSTEM PRIVATE ${TgcallsLite_INCLUDE_DIRS})
    target_link_libraries(telegram-tdlib PRIVATE ${TgcallsLite_LIBRARIES})
endif (NOT NoTgcallsLite)

if (NOT NoVoip)
    target_link_libraries(telegram-tdlib PRIVATE ${tgvoip_LIBRARIES})
    if (tgvoip_NO_DSP)
        # libtgvoip was built with --disable-dsp: EchoCanceller.h gates its webrtc:: members on
        # TGVOIP_NO_DSP, so compile with the same define to match the ABI and avoid referencing
        # webrtc types we didn't build.
        target_compile_definitions(telegram-tdlib PRIVATE TGVOIP_NO_DSP)
    endif (tgvoip_NO_DSP)

    # voipkit.cpp/voipkit-tgvoip.cpp (native SkypeKit video bridge) link directly against the
    # real, headerless libpalmgstskype.so on the device firmware image -- see
    # messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md and
    # messaging/whatsapp/calling/build-skypekit-send-test.sh for the technique this mirrors.
    # -Wl,-rpath (not just -rpath-link) bakes /usr/lib/gstreamer-0.10 into the built .so's own
    # runtime search path so it finds libpalmgstskype.so on-device unconditionally, the same
    # robustness fix used for the WhatsApp plugin's build-combined.sh.
    set(SkypeKitFwRootfs "" CACHE STRING "webOS firmware rootfs path (for libpalmgstskype.so)")
    if (NOT SkypeKitFwRootfs STREQUAL "")
        target_link_libraries(telegram-tdlib PRIVATE palmgstskype)
        target_link_options(telegram-tdlib PRIVATE
            -L${SkypeKitFwRootfs}/usr/lib/gstreamer-0.10
            -Wl,--allow-shlib-undefined
            -Wl,-rpath-link,${SkypeKitFwRootfs}/usr/lib
            -Wl,-rpath,/usr/lib/gstreamer-0.10)
    endif (NOT SkypeKitFwRootfs STREQUAL "")
endif (NOT NoVoip)

if (DEFINED STANDARD_LIBRARIES_EXTRA)
    set (CMAKE_CXX_STANDARD_LIBRARIES "${CMAKE_CXX_STANDARD_LIBRARIES} ${STANDARD_LIBRARIES_EXTRA}")
endif (DEFINED STANDARD_LIBRARIES_EXTRA)

install(TARGETS telegram-tdlib DESTINATION "${PURPLE_PLUGIN_DIR}")
install(FILES data/telegram16.png DESTINATION "${PURPLE_DATA_DIR}/pixmaps/pidgin/protocols/16" RENAME telegram.png)
install(FILES data/telegram22.png DESTINATION "${PURPLE_DATA_DIR}/pixmaps/pidgin/protocols/22" RENAME telegram.png)
install(FILES data/telegram48.png DESTINATION "${PURPLE_DATA_DIR}/pixmaps/pidgin/protocols/48" RENAME telegram.png)
install(FILES data/tdlib-purple.metainfo.xml DESTINATION "${SHARE_INSTALL_PREFIX}/metainfo")

# add_subdirectory(test)  # webOS: plugin only, skip gtest-based tests

add_custom_command(
    OUTPUT libtelegram-tdlib-stripped.dll
    COMMAND i686-w64-mingw32-strip -o libtelegram-tdlib-stripped.dll libtelegram-tdlib.dll
    DEPENDS telegram-tdlib
)
add_custom_command(
    OUTPUT lang.nsi
    COMMAND ${CMAKE_SOURCE_DIR}/po/gen-nsi.sh lang.nsi
    DEPENDS ${CMAKE_SOURCE_DIR}/po/gen-nsi.sh
    DEPENDS ${CMAKE_SOURCE_DIR}/po/LINGUAS
)
add_custom_target(nsis
    makensis -DBUILD_DIR=${CMAKE_BINARY_DIR} -DPRPL_LIBRARY=libtelegram-tdlib-stripped.dll -DPLUGIN_VERSION=${VERSION} ${CMAKE_SOURCE_DIR}/tdlib-purple.nsi
    DEPENDS libtelegram-tdlib-stripped.dll lang.nsi
)

if (NOT NoTranslations)
    find_package(Gettext REQUIRED)
    file(STRINGS po/LINGUAS _linguas)
    foreach(_lang ${_linguas})
        GETTEXT_PROCESS_PO_FILES(
            ${_lang} ALL
            PO_FILES "${CMAKE_SOURCE_DIR}/po/${_lang}.po"
        )
        install(
            FILES ${CMAKE_CURRENT_BINARY_DIR}/${_lang}.gmo
            DESTINATION "${SHARE_INSTALL_PREFIX}/locale/${_lang}/LC_MESSAGES"
            RENAME tdlib-purple.mo
        )
        add_custom_target(idontwanttohavethisrule_${_lang} DEPENDS ${CMAKE_CURRENT_BINARY_DIR}/${_lang}.gmo)
        add_dependencies(nsis idontwanttohavethisrule_${_lang})
    endforeach()

    find_package(Intl REQUIRED)
    target_include_directories(telegram-tdlib PRIVATE ${Intl_INCLUDE_DIRS})
    target_link_libraries(telegram-tdlib PRIVATE ${Intl_LIBRARIES})
endif (NOT NoTranslations)
