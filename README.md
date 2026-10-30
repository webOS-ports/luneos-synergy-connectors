# LuneOS Synergy connectors

Account connectors for LuneOS: each one is an account type in Settings → Accounts
and plugs a network or service into the stock apps.

| Family | Connectors | What they feed |
|---|---|---|
| `cloud/` | box, dropbox, flickr, google (Drive), hidrive, kdrive, koofr, mega, onedrive, pcloud, immich, photoprism, s3, smugmug, webdav (Nextcloud, ownCloud, any WebDAV server), yandex | Documents (DOCUMENTS) and Photos (PHOTO.UPLOAD) |
| `im/` | discord, facebook (E2EE), googlechat, signal, teams, telegram, whatsapp | Messaging, through `imlibpurpleservice` and libpurple |
| `music/` | apple, archive, deezer, jamendo, qobuz, soundcloud, spotify, tidal, youtube | Music, through the streaming daemon |

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

tests/                             on-device test harness (see tests/README.md)
```

`im/whatsapp/plugin/purple-combined` is one library that registers both the
WhatsApp and the Facebook E2EE protocols; `im/facebook` has only its template and
sign-in app.

## Building

The connectors are built and packaged by the recipes in
[meta-webos-ports](https://github.com/webOS-ports/meta-webos-ports)
(`meta-luneos/recipes-luneos/synergy/` and `recipes-support/pidgin/`).

## Testing

`tests/run.py` drives a LuneOS device over adb and checks every connector, from
"installed and registered" through live sign-in, messaging, file round-trips and
playback. See `tests/README.md`.

## Origin and licence

Imported from [webos-synergy-revival](https://github.com/Herrie82/webos-synergy-revival)
(`7db2aa6`) and [org.webosports.app.music](https://github.com/Herrie82/org.webosports.app.music)
(`06fcbde`), keeping what LuneOS uses; the HP TouchPad packaging, installers and
webOS 3.0.5 app patches stayed behind.

This repository is GPL-3.0-or-later (`LICENSE`). The vendored libpurple plugins
under `im/*/plugin/` keep their own licences, found in each plugin's directory.
