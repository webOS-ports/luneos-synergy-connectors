# Builds the Signal call media engine, signal_media, which purple-presage runs for each call.
#
#   make                                 build signal_media
#   make install DESTDIR=... libexecdir=...  install it as $(libexecdir)/signal-call-media
#   make check                           run the video helper unit test and the SRTP-GCM + RTP +
#                                        Opus loopback self-test
#
# CC, CFLAGS, LDFLAGS and PKG_CONFIG come from the environment, as a cross build sets them.

PKG_CONFIG ?= pkg-config
PACKAGES = gstreamer-1.0 gstreamer-app-1.0 nice libsrtp2 libcrypto speexdsp glib-2.0

prefix ?= /usr
libexecdir ?= $(prefix)/libexec

CFLAGS ?= -O2 -g
CFLAGS += -Wall -Wextra
PKG_CFLAGS := $(shell $(PKG_CONFIG) --cflags $(PACKAGES))
PKG_LIBS := $(shell $(PKG_CONFIG) --libs $(PACKAGES))

OBJS = signal_media.o srtp_kdf.o signal_video.o

all: signal_media

signal_media: $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $(OBJS) $(PKG_LIBS)

%.o: %.c signal_media.h srtp_kdf.h signal_video.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(PKG_CFLAGS) -c $< -o $@

install: signal_media
	install -d $(DESTDIR)$(libexecdir)
	install -m 0755 signal_media $(DESTDIR)$(libexecdir)/signal-call-media

tests/test_signal_video: tests/test_signal_video.c signal_video.c signal_video.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -I. -o $@ tests/test_signal_video.c signal_video.c

check: signal_media tests/test_signal_video
	./tests/test_signal_video
	./signal_media --loopback

clean:
	rm -f signal_media $(OBJS) tests/test_signal_video

.PHONY: all install check clean
