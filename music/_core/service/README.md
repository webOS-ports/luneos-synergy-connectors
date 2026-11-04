# spotify-webos-service (Go backend)

Localhost HTTP/JSON backend for the Music+Spotify app: Spotify search/browse
(`github.com/zmb3/spotify`) + librespot playback control. See
`../docs/ARCHITECTURE.md`.

## Build

Uses Herrie's Go toolchain (`/home/herrie/webos/gotool/go125`).

```bash
export PATH=/home/herrie/webos/gotool/go125/bin:$PATH
export GOROOT=/home/herrie/webos/gotool/go125
export GOPATH=/home/herrie/webos/gotool/gopath
export GOMODCACHE=/home/herrie/webos/gotool/gomod
export GOCACHE=/home/herrie/webos/gotool/gocache

go mod tidy                      # resolves zmb3/spotify + oauth2 (done; go.sum committed)
go build .                       # host build — VERIFIED OK against zmb3/spotify v2

# device build (TouchPad / ARMv7):
GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -ldflags="-s -w" \
    -o spotify-webos-service-arm .
```

Status: **compiles clean for host and ARMv7**; the ARM binary runs and binds on
the topaz TouchPad. API usage (`Search`, `PlayOpt`, `SeekOpt`, `VolumeOpt`,
`PlayerCurrentlyPlaying`, `spotifyauth`) validated by the compiler.

## ⚠️ Runtime prerequisite: `accept4` syscall (kernel one-liner)

On the stock `2.6.35-palm-tenderloin` kernel the service starts, logs
`listening on http://127.0.0.1:8730`, then dies with:

```
accept tcp 127.0.0.1:8730: accept4: function not implemented
```

Cause: Go 1.25 assumes `accept4` (present since kernel 2.6.28) and does **not**
fall back to `accept`. The kernel *binary* exports `sys_accept4`
(`80493aa8 T sys_accept4` in kallsyms), but the ARM **syscall table** never wires
it: `arch/arm/kernel/calls.S` ends at `/* 365 */ CALL(sys_recvmmsg)`, so
number 366 (accept4) falls through to `sys_ni_syscall` → ENOSYS.

**Fix (running kernel — `webos-linux-kernel-touchpad/arch/arm/kernel/calls.S`, after line 377):**
```diff
 /* 365 */	CALL(sys_recvmmsg)
+/* 366 */	CALL(sys_accept4)
```
Rebuild the kernel (Herrie's `linux-upstream-prep` tree already includes it).
Alternative if a kernel rebuild isn't desired: build this service with an older
Go (≤1.20) that still falls back to `accept` on ENOSYS, or run it inside the
bundled modern-rootfs container the other ports (Telegram/Signal) use.

## Run (on device, after the kernel fix)

```bash
/media/internal/spotify-webos-service -addr 127.0.0.1:8730 -librespot-name webOS
```

Then the app POSTs its OAuth token to `/session` and calls `/search`, `/player/*`.
Probe without a session (should be HTTP 401 "no session"):
```bash
curl 'http://127.0.0.1:8730/search?q=daft+punk&type=track'
```

## Media session (com.webos.service.mediacontroller)

librespot is a media session of mediacontroller (`mediasession.go`), so it is
paused when another player starts, paused for a call and resumed after it by
audiod, and takes a headset's and the dashboard's play/pause/next/previous. It
reports its play status and the track's metadata from librespot's own events:
librespot runs `spotify-webos-service -librespot-event` for each (`--onevent`),
which writes it into the FIFO `/media/cryptofs/spotify-webos/librespot-events`
(`librespotevents.go`). The bus is reached through `luna-send -a
org.webosports.app.music.service`, which needs `mediacontroller.query` in that
id's client permissions (the luneos-synergy-music recipe).

While the Music app drives librespot itself (`/player/*` in the last 5 s and the
track it loaded), its own session covers the sound and this one stands aside.

A pause - a key, or `/player/pause` - holds librespot's output still at once
(SIGSTOP of its gst-launch) besides pausing it through the Web API, so it is
silent without a network too (`librespotcontrol.go`); play, next and previous
let it go.

## Subsonic (your own server)

`subsonic.go`: a server that speaks the Subsonic API (Navidrome, Airsonic,
Gonic...). The sign-in app posts `{server, username, password}` to
`/subsonicauth/login`, which pings the server before keeping them in
`subsonic-auth` (and keymanager). Search, playlists and playback go through
the provider routes as for any other service.

The sign-in is a token (md5 of password and a fresh salt) on every request,
and it never expires; so the app never sees a server URL: tracks play from
`/subsonicstream?id=` and covers come from `/subsonicart?id=[&size=]`, which
add the sign-in and pass Range on for seeking. Errors never carry the URL
they failed on.

## Jellyfin, Emby and Plex (signed in in Videos)

`videoaccounts.go`, `mediabrowser.go` (Jellyfin and Emby), `plexmusic.go`:
the music on the user's media servers, with the sign-in Videos keeps. A
Videos account of type `org.webosports.video.jellyfin`, `.emby` or `.plex`
brings the `jellyfin`, `emby` or `plex` provider; the templates list
`org.webosports.app.music.service` in their readPermissions (read only:
signing in and out stays with Videos). The accounts are looked at when the
app asks for `/providers`, at most every 30 s, and again after a server
refused the sign-in. With two accounts of one kind, the first is used.

Search, playlists, and browsing artists, albums and the album lists go
through the provider routes. The token goes in a header (Jellyfin and
Emby's `Authorization: MediaBrowser ... Token=`, Plex's `X-Plex-Token`), never
in a URL: tracks play from `/mediastream?p=<id>&id=` and covers come from
`/mediaart?p=<id>&...`, which add it and pass Range on for seeking. A Plex
id is `<server>.<Plex id>`, so that one plex.tv account's servers keep
apart; Plex's addresses are tried local first, the relay last, as in Videos.

Checked on 2026-11-04 against Jellyfin 12.4.0, Emby 4.10.2.0 and Plex
Media Server 1.43.5 (test servers with a small music library): artists,
albums, tracks, the album lists, search, playlists, a seek into a stream
and covers on each.

## Internet Radio

`radio.go`: the stations of [Radio Browser](https://www.radio-browser.info),
a free directory kept by its users, and the user's own station lists (M3U or
PLS playlists at an address). The account (template
`org.webosports.app.music.radio`) needs no sign-in; the sign-in app can post a
list's address to `/radioauth/lists`, which reads it (a playlist with
stations, or a station's own stream) before keeping it in `radio-lists`.

They show as the service's playlists, so the app needs nothing new: the
user's lists (one playlist per group when a list has groups), then Radio
Browser's most played and most liked stations, those of the system's country
(the settings service's UI locale) and ten genres. Search looks in the
user's lists first, then in Radio Browser. A station is a track with no
length: `radio:rb.<stationuuid>` or `radio:u.<base64url of its stream>`.

As Radio Browser asks: the server comes from the DNS name
`all.api.radio-browser.info` (the next one when one fails), requests carry
`User-Agent: LuneOS-Music/1.0`, and each play counts a click on
`/json/url/<stationuuid>`. A station's own `.pls` or `.m3u` file is opened
for its stream when it plays (GStreamer plays HLS's `.m3u8` itself).

## Browsing a library

A provider with a library to walk implements `libraryBrowser` (`browse.go`),
and `/providers` marks it `"browse": true` (left out for the others):

| Route | Returns |
|---|---|
| `GET /provider/<id>/artists` | `{artists: [{id, provider, name, thumbnail, albums}]}` |
| `GET /provider/<id>/artist?id=` | `{albums: [{id, provider, name, artist, artist_id, year, thumbnail, tracks}]}` |
| `GET /provider/<id>/album?id=` | `{tracks: [providerTrack]}`, in the album's order, with `track` and `disc` |
| `GET /provider/<id>/albums?list=` | `{albums}`: `newest` (the default), `recent`, `frequent`, `random`, `alphabetical` |

Subsonic answers them from getArtists, getArtist, getAlbum and getAlbumList2;
its covers come through `/subsonicart` as everywhere else (Navidrome's
`artistImageUrl` is a signed link to the server, and is not used).
