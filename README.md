# LuneOS Synergy connectors

Account connectors for LuneOS: each one is an account type in Settings → Accounts
and plugs a network or service into the stock apps.

| Family | Connectors | What they feed |
|---|---|---|
| `cloud/` | box, dropbox, flickr, google (Drive), hidrive, kdrive, koofr, mega, onedrive, pcloud, immich, photoprism, s3, smugmug, webdav (Nextcloud, ownCloud, any WebDAV server), yandex | Documents (DOCUMENTS) and Photos (PHOTO.UPLOAD) |
| `im/` | discord, facebook (E2EE), googlechat, signal, teams, telegram, whatsapp | Messaging, through `imlibpurpleservice` and libpurple |
| `music/` | apple, archive, deezer, jamendo, qobuz, soundcloud, spotify, tidal, youtube | Music, through the streaming daemon |
| `video/` | jellyfin, peertube, plex, upnp (UPnP/DLNA media servers: MiniDLNA, NAS, Kodi, or Plex and Jellyfin's DLNA) | Videos (Video, subtype STREAMING), through org.webosports.service.videos |

## Layout

Every connector has its own folder; what the family shares lives in `_core/`.

```
cloud/_core/service/_cloudcore     shared runtime of every connector: node/ (bus, http, OAuth2/PKCE,
                                   credentials, the common commands), on LuneOS's node 22
cloud/_core/apps/                  com.palm.app.cloud-auth, the shared OAuth sign-in app
cloud/<name>/account/              account template + icons  -> /usr/palm/public/accounts/
cloud/<name>/service/              the connector's service -> /usr/palm/services/
cloud/<name>/apps/                 its own sign-in app, where it has one (kdrive, mega, s3, webdav, flickr, smugmug, immich)
cloud/<name>/apps/                 its own sign-in app, where it has one (kdrive, mega, s3, webdav, flickr, smugmug, immich, photoprism)
cloud/<name>/files/sysbus/         its service's LS2 files (webos_system_bus) -> /usr/share/luna-service2/

im/_core/include/                  webos-ls2-compat.h, shared by the plugins
im/<name>/account/                 account template + icons
im/<name>/apps/                    sign-in (validator) app
im/<name>/plugin/                  libpurple protocol plugin source (vendored fork, own licence)
im/<name>/calling/                 call bridge sources, where built
im/<name>/files/sysbus/            LS2 files for its call service (webos_system_bus), where it has one

music/_core/service/               spotify-webos-service, the Go streaming daemon (127.0.0.1:8730)
music/_core/apps/                  org.webosports.app.musicauth, the shared sign-in app
music/<name>/account/              account template + icons

video/_core/service/               org.webosports.service.videos: one node service for every video
                                   connector (bus methods, contract, SSDP, a small XML reader), on
                                   _cloudcore/node -> /usr/palm/services/
video/_core/apps/                  org.webosports.app.videoauth, the shared sign-in app
video/_core/files/sysbus/          the service's LS2 files
video/<name>/account/              account template + icons
video/<name>/provider/             the connector, a module of the service -> providers/<name>.js

tests/                             on-device test harness (see tests/README.md)
```

`im/whatsapp/plugin/purple-combined` is one library that registers both the
WhatsApp and the Facebook E2EE protocols; `im/facebook` has only its template and
sign-in app.

## Building

The connectors are built and packaged by the recipes in
[meta-webos-ports](https://github.com/webOS-ports/meta-webos-ports)
(`meta-luneos/recipes-luneos/synergy/` and `recipes-support/pidgin/`).

## Video

Videos (org.webosports.app.videoplayer) lists every account with the capability
`Video` as a library beside the device's own videos, and browses it through
`luna://org.webosports.service.videos/`:

| Method | Takes | Answers |
|---|---|---|
| `listSources` | – | `sources`: one per account; one per media server found for UPnP, and one per server a plex.tv account reaches (`sourceId` = account id, or `<account id>\|<UDN or Plex server id>`) |
| `listSections` | `sourceId` | `sections`: `{id, title, layout: row\|grid}` |
| `listItems` | `sourceId`, `sectionId` or `parentId`, `cursor`, `limit` | `items`, `nextCursor` |
| `getItem` | `sourceId`, `itemId` | `item`, with `seasons` (a show) or `children` (a season, a folder) |
| `search` | `sourceId`, `query`, `cursor`, `limit` | `items`, `nextCursor` |
| `resolve` | `sourceId`, `itemId`, `prefer {maxHeight, codecs, audioCodecs}` | `stream {url, protocol, subtitles, startMs, session, drm: null}` |
| `reportProgress` | `sourceId`, `itemId`, `positionMs`, `durationMs`, `state`, `session` | – (Jellyfin and Plex keep their place) |
| `login` | `templateId` and what the sign-in app asked for | the account (the validator) |
| `searchPeerTubeInstances` | `query` | healthy, non-NSFW instances from instances.joinpeertube.org |
| `plexPin` | – | `pinId`, `code`, `clientId`, `expiresIn`, `linkUrl`: a code to enter at plex.tv/link; `login` with `pinId` and `clientId` then signs in |

Only Videos may browse (`allow`); `login`, `plexPin` and the instance list are open, as for the
other sign-in apps. Every reply is cut to the shapes in `contract.js`; links are
http(s) only, and a stream's link can carry the server's token (Jellyfin's
`ApiKey`, Plex's `X-Plex-Token`) - the service never logs links or credentials. Errors: `AUTH_EXPIRED`,
`NOT_FOUND`, `SERVER_UNREACHABLE`, `SERVER_ERROR`, `NO_SOURCE`, `DRM_REQUIRED`,
`GEO_BLOCKED`, besides _cloudcore's.

UPnP searches with SSDP from UDP port 41900 and keeps only servers on private,
link-local or loopback addresses. The replies come from each server's own
address, which conntrack does not match to a multicast send, so the device's
firewall must let UDP to port 41900 in from the local network.

## Testing

`node --test tests/unit/*.test.js` runs the unit tests of the node code (the video
service's in `tests/unit/videos.test.js`). `tests/run.py` drives a LuneOS device over adb and checks every connector, from
"installed and registered" through live sign-in, messaging, file round-trips and
playback. See `tests/README.md`.

## Origin and licence

Imported from [webos-synergy-revival](https://github.com/Herrie82/webos-synergy-revival)
(`7db2aa6`) and [org.webosports.app.music](https://github.com/Herrie82/org.webosports.app.music)
(`06fcbde`), keeping what LuneOS uses; the HP TouchPad packaging, installers and
webOS 3.0.5 app patches stayed behind.

This repository is GPL-3.0-or-later (`LICENSE`). The vendored libpurple plugins
under `im/*/plugin/` keep their own licences, found in each plugin's directory.
