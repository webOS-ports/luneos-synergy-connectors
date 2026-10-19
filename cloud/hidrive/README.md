# STRATO HiDrive connector

A Synergy connector for **STRATO HiDrive** as a **DOCUMENTS** provider (file browse / upload /
download for the file-picker + QuickOffice reroute) and a **PHOTO.UPLOAD** provider.

## Shape

HiDrive is a straightforward **OAuth2 + path-based REST** service, so this connector is a close
sibling of the Yandex/Dropbox ones. It runs on `_cloudcore/node` (node 22: palmbus, `fetch`, no
mojoservice, no curl), laid out as the Dropbox connector is, and uses the **shared** OAuth webview
app `com.palm.app.cloud-auth`. The service directory:

| File | What it is |
|---|---|
| `package.json` | `main: service.js`; `run-js-service` requires the directory and calls `run()`. |
| `service.js` | Wires `config.js`, `adapter.js` and `photos.js` into `_cloudcore/node`'s `connector()`. |
| `config.js` | OAuth app, endpoints, caller allow-lists. The build fills the `PLACEHOLDER_HIDRIVE_*` lines in with sed. |
| `adapter.js` | HiDrive REST 2.1 as async functions on a session (`listFolder`, `downloadFile`, `uploadFile`, `moveItem`, ...). |
| `photos.js` | `listAlbums` / `listPhotos` for the Photos service. |

The generic methods (`getAuthorizeUrl`, `exchangeCode`, `checkCredentials`, `listFolder`,
`downloadFile`, `uploadFile`, `createFolder`, `moveItem`, `deleteItem`, `upload`, `deletePhoto`)
come from `_cloudcore/node/commands.js`, with their arguments and replies listed at its head.

- **Auth:** OAuth2 authorization-code. Register a **native** app at
  `developer.hidrive.com/get-api-key/` (native → you get a `client_secret` *and* refresh tokens;
  HiDrive has no PKCE, so the secret ships in the package, same as pCloud/Google here). Scope
  `user,rw`. Access tokens live 1 h; the adapter refreshes transparently on 401.
- **API:** `https://api.hidrive.strato.com/2.1`, `Authorization: Bearer <token>`.
- **Paths:** absolute under the account **home** (`/users/<user>/…`). The root sentinel `home`
  resolves to the real home path from `GET /user/me` (cached per token). `GET /dir` lists (members
  array, paged with `limit=offset,count`), `GET /file` downloads, `PUT /file?dir=&name=`
  creates/overwrites, `POST /dir` makes a folder, `/file|dir/rename` and `/file|dir/move` rename
  and move (after a `GET /meta` type probe), `DELETE /file|dir` removes for good (no trash).
  HiDrive answers names and paths URL-encoded; every reply (listings and uploads alike) is
  decoded, so a locator is a plain path. `mtime` is epoch **seconds** (normalised to ms).

## Status

🟡 **Code-complete, mirrors Yandex — untested pending a HiDrive `client_id`+secret.**

Validated off-device by `tests/unit/hidrive.test.js`: the service started on a stand-in bus and
`fetch`, every method checked for its exact requests, replies and errors, and every request of
every method failed in five ways. Not yet run against the real HiDrive API.

## Known caveats / follow-ups

- **Needs credentials to test:** paste a native-app `CLIENT_ID`/`CLIENT_SECRET` into `config.js`.
- **PKCE:** the shared `_cloudcore/node/oauth.js` always sends a PKCE `code_challenge`; HiDrive has no PKCE and
  should ignore the extra param — verify on device.
- **Photos link auth:** `getTemporaryLink` returns a `/file?path=…&access_token=…` URL, assuming
  HiDrive accepts the token as a query param (common for Bearer APIs). If a device test shows it
  does not, switch `listPhotos` to a download-to-temp `file://` scheme (as the Mega connector does).
- **Placeholder icons** (green "H"); swap in real branding if desired.
