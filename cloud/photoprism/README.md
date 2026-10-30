# PhotoPrism connector

A **photo-only** Synergy connector for [PhotoPrism](https://www.photoprism.app), the self-hosted
photo server: the user's PhotoPrism albums and folders show up in the Photos app and their
photos come down into it. There is no OAuth and nothing to register: each account brings its
own server, user name and password. No upload, no documents/files role.

**Read-only: nothing is uploaded.** `PHOTO.UPLOAD` is only the name of the account capability the
Photos service looks for to list an account as a photo source (Immich, SmugMug and Flickr carry
it too); this connector has no upload method.

## Status and limitations

> **Works against a real server; not yet run on a device, and not in the LuneOS image.** Checked
> 2026-10-30 against PhotoPrism 261029 (the `photoprism/photoprism` Docker image): sign-in with
> a password and with an app password, a wrong password, a two-factor account, an album and a
> folder, originals byte for byte.

- **The password is used once.** Sign-in opens a session with it, makes an **app password** for
  the device in that session (named `LuneOS`, scopes `albums config photos`, no expiry), and
  closes the session. Only the app password is kept. Each sign-in makes a new one.
- **Two-factor sign-in**: PhotoPrism wants a code the sign-in form does not ask for. The user
  makes an app password in PhotoPrism (Settings → Account → Apps and Devices) and enters it as
  the password; the form says so when the server asks for a code. An app password needs at
  least the `albums`, `config` and `photos` scopes (or full access).
- **Removing the account leaves its app password in PhotoPrism.** Delete it there under Apps
  and Devices. (PhotoPrism's `/oauth/revoke` did not revoke one in testing, so the connector
  does not try.)
- **The photo links carry the server's download and preview tokens**, not the app password:
  the Photos service fetches URLs without headers, and PhotoPrism takes `/dl/<hash>?t=` and
  `/t/<hash>/<token>/<size>` with those tokens. They are the server's (one each, for every
  user), read from `/config` at every listing so a renewed one is picked up. **Over plain
  `http://` they cross the network in the clear**: fine on a home LAN, not across the
  internet. Use https there.
- **Self-signed certificates are refused** (node's own TLS checks); a server behind one needs a
  certificate the device trusts, or plain http on the LAN.
- **HEIC, RAW, TIFF, SVG and other non-web formats come over as PhotoPrism's 1920 px JPEG
  thumbnail** (`fit_1920`), not the original. JPEG, PNG, GIF, WebP and BMP come over as the
  original, byte for byte. A server with downloads turned off (no download token) lists no
  photos and refuses sign-in, saying so.
- **Photos only, read-only**: videos are left out (a live photo comes over as its still);
  nothing is uploaded. An album's count in the list is PhotoPrism's and includes its videos; a
  folder has no count, so its photos are counted, and an empty one is left out.
- **At most 5000 photos per album** and 200 albums (and 200 folders) are listed.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.photoprism/` | The node service on `_cloudcore/node` (node 22): `service.js` (the methods), `login.js` (the account validator), `adapter.js` (the API, paging, credentials), `photos.js` (listAlbums/listPhotos), `config.js`. |
| `apps/com.palm.app.photoprism-auth/` | customUI sign-in form (server address, user name, password or app password), as cloud/immich's. |
| `account/com.palm.photoprism/` | Synergy account template — **PHOTO.UPLOAD capability only**. The icons are PhotoPrism's app icon (`assets/static/icons/app.svg`): the black prism on its sky-to-lilac tile, drawn at our corner radius. |
| `files/sysbus/` | The service's LS2 files. |

## Service methods

| Method | Caller | Purpose |
|---|---|---|
| `login` | sign-in app (account validator) | `{ server, username, password }`: settles the address, checks it is PhotoPrism (`/status`, nothing secret sent), signs in and makes the app password (or takes one given), checks it reads `/config`, returns `credentials.common` = `{ server, token, userId, username, name }`, `<user>@<host>` as the username. |
| `checkCredentials` | accounts | `/config` with the stored app password; a failure means it was deleted in PhotoPrism. |
| `listAlbums` / `listPhotos` | Photos service | `GET /albums?type=album`, then `type=folder`; an album's photos through `GET /photos?s=<uid>&merged=true`, paged. |
| `downloadFile` | Photos app | Fetches a photo URL to a local path. |

## The server address

`photos.example.org`, `https://photos.example.org/library/browse` and
`http://192.168.1.5:2342/api/v1` are all taken: no scheme means https, a pasted page or API
address is cut back at `/library` or `/api`, a sub-path (`https://example.org/photoprism`) is
kept. A redirect of the status request (http → https, say) to the same host is followed **once,
at sign-in, before anything secret is sent**; the address it leads to is stored. Afterwards
requests follow no redirect, since fetch would carry the token along to wherever one points. A
server that moves later answers an error asking to sign in again.

## Errors

PhotoPrism's own `message` (else its `error`) makes the `errorText`; no reply body, and never
the password or a token. The sign-in errors have their own codes: `PHOTOPRISM_UNREACHABLE`
(with a hint when an https address meets a plain-http server), `PHOTOPRISM_NOT_FOUND`,
`PHOTOPRISM_AUTH_FAILED`, `PHOTOPRISM_2FA`, `PHOTOPRISM_NO_APP_PASSWORD`, `PHOTOPRISM_KEY_SCOPE`
and `PHOTOPRISM_NO_DOWNLOADS`. The sign-in app shows the service's error and logs only how the
sign-in ended, not its result (which holds the app password).

## Tests

`tests/unit/photoprism.test.js`: every method over a stand-in bus and fetch, with the reply
shapes a PhotoPrism 261029 server gave: both sign-in paths, the session always closed, the
redirect handling, Go's zero time as "not deleted", folders counted, originals against
thumbnails, paging, the error cases. Every request of every method also fails in turn.
