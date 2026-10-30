# WebDAV connector (Nextcloud, ownCloud, any WebDAV server)

One Synergy account type for **Nextcloud, ownCloud and any WebDAV server** (a NAS such as
Synology or QNAP, Apache `mod_dav`, nginx, `rclone serve webdav`, ...). The account's files
show up in Documents and in Topaz Explorer's cloud drives (DOCUMENTS), and its photo folder in
Photos (PHOTO.UPLOAD). There is no OAuth and nothing to register: each account brings its own
server, user name and password.

## Status and limitations

> **Works against real servers; not yet run on a device, and not in the LuneOS image.** Checked
> 2026-10-30 against Nextcloud 34.0.5 and Apache 2.4 `mod_dav`, both local in Docker: sign-in
> (password, app password, email address), listing, download, upload, folders, rename, move,
> delete, names with spaces, `ü`, `&`, `%` and `#`, albums and photos.

- **Pick the server type in the sign-in form.** For **Nextcloud** and **ownCloud**, give the
  server's address (`cloud.example.org`); the connector finds the user's files folder itself
  (`/remote.php/dav/files/<user id>/`, the id asked from the server, so signing in with an email
  address works). For **any other server**, give the address of the WebDAV folder itself
  (`https://nas.local:5006/`, `https://example.org/webdav/`).
- **Nextcloud and ownCloud with two-factor sign-in need an app password** (Settings → Security
  → Devices & sessions). The form says so, and so does the error. **An app password works only
  with the user name it was made under**, not with the account's email address (Nextcloud's
  rule: checked with curl as well); signing in with an email works with the account password.
- **The password is kept in Accounts and sent on every request** (HTTP Basic auth). Over plain
  `http://` it crosses the network in the clear: fine on a home LAN, not across the internet.
  Use https there. Digest-only servers are not supported.
- **Self-signed certificates are refused** (node's own TLS checks): such a server needs a
  certificate the device trusts, or plain http on the LAN. An https address at a server that
  only speaks http fails with a hint to enter it with `http://`.
- **Redirects:** a redirect of the first request (http → https, a moved folder) is followed
  **once, at sign-in, before the password is sent, and only on the same host**; the address
  it leads to is stored. Afterwards no request follows a redirect (fetch would carry the
  password along), so a server that moves later answers an error asking to sign in again.
- **Photos come from one folder**: `Photos` (the folder Nextcloud and ownCloud make for a new
  user), or the one named in the form. Its images are one album and each folder directly in it
  that holds images is another (at most 50 looked at; deeper folders are not albums). Uploads
  from Photos with no album go to `<photo folder>/Camera Uploads/`.
- **Photos are copied twice on their way in.** The Photos service fetches photo URLs without a
  header, and WebDAV wants the password on every request, so `listPhotos` downloads each new
  photo to `/media/internal/.webdav-photos` and hands the Photos service `file://` links, as
  cloud/mega does; the Photos service removes each copy once it has its own. A first sync of a
  big album stops fetching after 4 minutes (the call's deadline is 5) and leaves the rest for
  the next sync.
- **Uploads replace** a file of the same name, as the other connectors' uploads do. **Moves
  and renames never replace**: an existing destination is refused (`Overwrite: F`).
- **Delete is the server's**: Nextcloud and ownCloud keep deleted files in their trash bin; a
  plain WebDAV server deletes them for good.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.webdav/` | The node service on `_cloudcore/node` (node 22): `service.js` (wiring), `adapter.js` (WebDAV: PROPFIND, GET, PUT, MKCOL, MOVE, DELETE, the Multi-Status reader), `login.js` (the account validator), `photos.js` (listAlbums/listPhotos), `config.js`. |
| `apps/com.palm.app.webdav-auth/` | customUI sign-in form: server type (Nextcloud / ownCloud / other WebDAV), address, user name, password, photo folder. |
| `account/` | Synergy account template `com.palm.webdav` — **DOCUMENTS and PHOTO.UPLOAD**. The icon is a folder with a network globe: WebDAV has no logo of its own. |
| `files/sysbus/` | The service's LS2 files. |

## Service methods

| Method | Caller | Purpose |
|---|---|---|
| `login` | sign-in app (account validator) | `{ flavor, server, username, password, photoFolder? }`: settles the address, follows one redirect before sending the password, finds the Nextcloud/ownCloud user id (`current-user-principal`), PROPFINDs the folder; returns `credentials.common` = `{ accessToken (the password), username, server (the WebDAV folder URL), flavor, photoFolder? }` and `<user>@<host>` as the username. |
| `checkCredentials` | accounts | A PROPFIND of the folder; a failure means the password changed or the app password was revoked. |
| `listFolder`, `downloadFile`, `uploadFile`, `createFolder`, `moveItem`, `deleteItem` | Documents, Explorer | `_cloudcore`'s generic file methods. Locators are paths under the account's folder as they read: `/` is that folder, `/Docs/` a folder, `/Docs/a.pdf` a file. |
| `listAlbums` / `listPhotos` | Photos service | See above. |
| `upload` / `deletePhoto` | Photos service | `_cloudcore`'s generic ones. |

## Errors

The `errorText` says what the HTTP status means and adds the server's own message where it
gives one (Nextcloud's and ownCloud's Sabre `<s:message>`); no other reply body goes into it,
and never the password. The sign-in app shows the service's error and logs only how the
sign-in ended, not its result (which holds the password).

## Tests

`tests/unit/webdav.test.js`: every method over a stand-in bus and fetch that plays a WebDAV
server in the three XML styles real ones use (Nextcloud's `d:`, Apache's `D:`/`lp1:`, a default
namespace), with relative and absolute hrefs; the sign-in cases (Nextcloud user ids, redirects,
every error); the password in no request but its `Authorization` header; every request of every
method failing in turn.
