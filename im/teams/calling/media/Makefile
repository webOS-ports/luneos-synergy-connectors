# teams_media, the media engine for Teams calls on LuneOS. purple-teams' calling bridge spawns it
# for each call; see teams_media.c.
#
#   make                        build teams_media
#   make install DESTDIR=...    install it as $(libexecdir)/teams_media
#   ./teams_media --loopback    self-test: SRTP-GCM + RTP + Opus round trip
#
# It needs GStreamer 1.x and libnice at build time, and at run time the elements the pipeline uses:
# nicesrc/nicesink (libnice), srtpenc/srtpdec (gst-plugins-bad, with libsrtp built against OpenSSL
# for AES-GCM), rtpopuspay/rtpopusdepay, rtpjitterbuffer and rtpptdemux, opusenc/opusdec,
# pulsesrc/pulsesink, audioconvert and audioresample.

PKG_CONFIG ?= pkg-config
CC         ?= gcc
CFLAGS     ?= -O2 -g
prefix     ?= /usr
libexecdir ?= $(prefix)/libexec

PKGS = gstreamer-1.0 nice glib-2.0

all: teams_media

teams_media: teams_media.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -Wall -Wextra `$(PKG_CONFIG) --cflags $(PKGS)` -o $@ $< \
		$(LDFLAGS) `$(PKG_CONFIG) --libs $(PKGS)`

install: teams_media
	install -d $(DESTDIR)$(libexecdir)
	install -m 0755 teams_media $(DESTDIR)$(libexecdir)/teams_media

clean:
	rm -f teams_media

.PHONY: all install clean
