# tgcalls-lite: a static library for tdlib-purple, plus the loopback tests in spike/.
#
#   make                 libtgcalls-lite.a
#   make check           build and run the tests that need no audio device or network
#
# CC, CXX, AR, CFLAGS, CXXFLAGS, LDFLAGS and PKG_CONFIG come from the environment (bitbake sets
# them). h264_rtp.c is shared with tdlib-purple and lives there.

PKG_CONFIG ?= pkg-config
AR ?= ar
PKGS = glib-2.0 nice libsrtp2 openssl json-glib-1.0 opus alsa

PKG_CFLAGS := $(shell $(PKG_CONFIG) --cflags $(PKGS))
PKG_LIBS := $(shell $(PKG_CONFIG) --libs $(PKGS))

WARN = -Wall -Wextra
CXXFLAGS ?= -O2 -g
CFLAGS ?= -O2 -g
override CXXFLAGS += -std=c++17 -fPIC $(WARN) $(PKG_CFLAGS)
override CFLAGS += -fPIC $(WARN) $(PKG_CFLAGS)

H264_DIR = ../tdlib-purple

SRCS = audio_pipeline.cpp call_engine.cpp content_negotiation.cpp crypto_helper.cpp dtls_transport.cpp \
       encrypted_connection.cpp ice_session.cpp media_session.cpp signaling_message.cpp \
       srtp_session.cpp
OBJS = $(SRCS:.cpp=.o) h264_rtp.o

# The tests that run anywhere: no ALSA device, no network beyond loopback.
TESTS = spike/codec_crypto_smoke spike/negotiation_smoke spike/srtp_e2e_smoke spike/dtls_loopback_smoke \
        spike/ice_loopback_smoke spike/media_session_e2e_smoke spike/call_engine_e2e_smoke \
        spike/nice_srtp_smoke
# opus_codec_smoke opens real ALSA devices; it is built but not run by "make check".
EXTRA_TESTS = spike/opus_codec_smoke

all: libtgcalls-lite.a

libtgcalls-lite.a: $(OBJS)
	$(AR) rcs $@ $^

h264_rtp.o: $(H264_DIR)/h264_rtp.c $(H264_DIR)/h264_rtp.h
	$(CC) $(CFLAGS) -c -o $@ $<

%.o: %.cpp $(wildcard *.h)
	$(CXX) $(CXXFLAGS) -c -o $@ $<

spike/nice_srtp_smoke: spike/nice_srtp_smoke.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS) $(PKG_LIBS)

spike/%: spike/%.cpp libtgcalls-lite.a
	$(CXX) $(CXXFLAGS) -o $@ $< libtgcalls-lite.a $(LDFLAGS) $(PKG_LIBS)

tests: $(TESTS) $(EXTRA_TESTS)

check: $(TESTS)
	@set -e; for t in $(TESTS); do echo "== $$t"; $(TEST_RUNNER) ./$$t; done

clean:
	rm -f *.o libtgcalls-lite.a $(TESTS) $(EXTRA_TESTS)

.PHONY: all tests check clean
