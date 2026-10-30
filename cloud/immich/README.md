# Immich connector

A **photo-only** Synergy connector for [Immich](https://immich.app), the self-hosted photo
server: the user's Immich albums show up in the Photos app and their photos come down into it.
There is no OAuth and nothing to register: each account brings its own server and an API key.
No upload, no documents/files role.

## Status and limitations

> **Works against a real server; not yet run on a device, and not in the LuneOS image.** Checked
> 2026-10-30 against Immich's public demo (v3.3.5) with an API key holding only the five
> permissions below: sign-in, albums, photos, originals byte for byte.

- **The user makes an API key in Immich** (Account Settings → API Keys) and types it in, with
  the server's address. Give it **`album.read`, `asset.read`, `asset.view`, `asset.download`
  and `user.read`** and nothing more: the connector needs no other. A key without `user.read`
  fails sign-in with that named; one without the others leaves albums or photos empty.
- **The key travels in photo URLs.** The Photos service fetches URLs without headers, so each
  photo's URL carries the key as `?apiKey=` (Immich reads it there as from `x-api-key`). The
  Photos service keeps no URL and logs only a host, but **over plain `http://` the key crosses
  the network in the clear** — fine on a home LAN, not across the internet. Use https there.
- **Self-signed certificates are refused** (node's own TLS checks); a server behind one needs a
  certificate the device trusts, or plain http on the LAN.
- **HEIC, RAW (DNG …), TIFF and other non-web formats come over as Immich's preview** — a JPEG
  (WebP if the server's admin chose that for previews) about 1440 px on its long side, not the
  original. JPEG, PNG, GIF, WebP and BMP come over as the original, byte for byte.
- **Photos only, read-only**: videos, trashed assets and hidden ones (the video half of a live
  photo) are left out; nothing is uploaded. An album's count in the list includes its videos
  (Immich does not count them apart).
- **At most 5000 photos per album** are listed.
- **Immich versions**: 3.2 and later are asked with the new search shape (`filter`/`cursor`);
  older ones with the flat `albumIds`/`page` one, which Immich will drop in v4; a server whose
  search cannot take an album at all lists it through `GET /albums/<id>`. Only 3.3.5 was tried.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.immich/` | The node service on `_cloudcore/node` (node 22): `service.js` (the methods), `login.js` (the account validator), `adapter.js` (the API, paging, credentials), `photos.js` (listAlbums/listPhotos), `config.js`. |
| `apps/com.palm.app.immich-auth/` | customUI sign-in form (server address, API key), as cloud/s3's. |
| `account/com.palm.immich/` | Synergy account template — **PHOTO.UPLOAD capability only**. The icons are Immich's own flower (`design/immich-logo.svg`) on transparent, as Drive's and pCloud's marks are. |
| `files/sysbus/` | The service's LS2 files. |

## Service methods

| Method | Caller | Purpose |
|---|---|---|
| `login` | sign-in app (account validator) | `{ server, apiKey }`: settles the address, checks it is Immich (`/server/version`, no key), checks the key (`/users/me`), returns `credentials.common` = `{ server, apiKey, userId, email, name }`, the email as the username. |
| `checkCredentials` | accounts | `/users/me` with the stored key; a failure means the key was deleted in Immich. |
| `listAlbums` / `listPhotos` | Photos service | `GET /albums` (own and shared); an album's assets through `POST /search/metadata`, paged. |
| `downloadFile` | Photos app | Fetches a photo URL to a local path. |

## The server address

`photos.example.org`, `https://photos.example.org/` and `http://192.168.1.5:2283/api` are all
taken: no scheme means https, a trailing `/` or `/api` is dropped, a sub-path
(`https://example.org/immich`) is kept. A redirect of the version request (http → https, say)
is followed **once, at sign-in, before the key is sent**; the address it leads to is stored.
Afterwards keyed requests follow no redirect — fetch would carry `x-api-key` along to wherever
one points — so a server that moves later answers an error asking to sign in again.

## Errors

Immich's own `message` (and a validation failure's `errors[].message`) make the `errorText`;
no reply body, and never the key. The sign-in app shows the service's error and logs only how
the sign-in ended, not its result (which holds the key).

## Tests

`tests/unit/immich.test.js`: every method over a stand-in bus and fetch, with the reply shapes
an Immich 3.3.5 server gave — both search shapes and their paging, the old-server fallback, the
redirect handling, the error cases; every request failing in turn.
