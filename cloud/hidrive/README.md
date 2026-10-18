# STRATO HiDrive connector

A Synergy connector for **STRATO HiDrive** as a **DOCUMENTS** provider (file browse / upload /
download for the file-picker + QuickOffice reroute) and a **PHOTO.UPLOAD** provider.

## Shape

HiDrive is a straightforward **OAuth2 + path-based REST** service, so this connector is a close
sibling of the Yandex/Dropbox ones — it reuses `_cloudcore` (OAuth2 + all generic commands) and the
**shared** OAuth webview app `com.palm.app.cloud-auth`; only `config.js` + `adapter.js` + the photo
commands are HiDrive-specific.

- **Auth:** OAuth2 authorization-code. Register a **native** app at
  `developer.hidrive.com/get-api-key/` (native → you get a `client_secret` *and* refresh tokens;
  HiDrive has no PKCE, so the secret ships in the package, same as pCloud/Google here). Scope
  `user,rw`. Access tokens live 1 h; the adapter refreshes transparently on 401.
- **API:** `https://api.hidrive.strato.com/2.1`, `Authorization: Bearer <token>`.
- **Paths:** absolute under the account **home** (`/users/<user>/…`). The root sentinel `home`
  resolves to the real home path from `GET /user/me` (cached per token). `GET /dir` lists (members
  array), `GET /file` downloads, `PUT /file?dir=&name=` creates/overwrites, `POST /dir` makes a
  folder, `DELETE /file` removes. `mtime` is epoch **seconds** (normalised to ms).

## Status

🟡 **Code-complete, mirrors Yandex — untested pending a HiDrive `client_id`+secret.**

Validated off-device: all files syntax-check, and a **mock-server integration run** drives the real
adapter through account/home resolution, folder listing, **the OAuth refresh-on-401 path** (an
expired token transparently refreshes + retries), download, upload, presigned photo link, and
delete — 10/10.

## Known caveats / follow-ups

- **Needs credentials to test:** paste a native-app `CLIENT_ID`/`CLIENT_SECRET` into `config.js`.
- **PKCE:** the shared `oauth2.js` always sends a PKCE `code_challenge`; HiDrive has no PKCE and
  should ignore the extra param — verify on device.
- **Photos link auth:** `getTemporaryLink` returns a `/file?path=…&access_token=…` URL, assuming
  HiDrive accepts the token as a query param (common for Bearer APIs). If a device test shows it
  does not, switch `listPhotos` to a download-to-temp `file://` scheme (as the Mega connector does).
- **Listing is single-page** (up to 5000 members); very large folders would want `offset,count`
  paging — a small future add.
- **Placeholder icons** (green "H"); swap in real branding if desired.
