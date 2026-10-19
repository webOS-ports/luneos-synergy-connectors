# Box connector

A Box (`box.com`) **DOCUMENTS + PHOTO.UPLOAD** connector on `_cloudcore/node`, built the same
way as the Dropbox one (`../dropbox`, the reference). Sign-in has not been run against a real
Box account yet: that needs the build's `BOX_CLIENT_ID` / `BOX_CLIENT_SECRET`.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.boxnet/` | The node service (see below). |
| `account/com.palm.boxnet/` | Synergy account template. Sign-in runs in `com.palm.app.cloud-auth` (`cloud/_core/apps/`). |
| `files/sysbus/` | Its LS2 role, permissions and service file. |

The service directory:

| File | What it is |
|---|---|
| `package.json` | `main: service.js`: `run-js-service` (jsservicelauncher `bootstrap-node.js`) does `require()` of the directory and calls `run()`. |
| `service.js` | Wires `config.js`, `adapter.js` and `photos.js` into `_cloudcore/node`'s `connector()`. |
| `config.js` | OAuth app, endpoints, caller allow-lists. A plain file: the build fills `PLACEHOLDER_BOX_CLIENT_ID` / `PLACEHOLDER_BOX_CLIENT_SECRET` in with sed. |
| `adapter.js` | Box REST API v2 as async functions on a session (`listFolder`, `downloadFile`, `uploadFile`, ...). |
| `photos.js` | `listAlbums` / `listPhotos` for the Photos service. |

## Service methods

The generic ones come from `_cloudcore/node/commands.js` (arguments and replies listed at its
head); `listAlbums`/`listPhotos` from `photos.js`. Errors from Box are `BOX_API_ERROR` with the
HTTP `status` and Box's error code in `errorText` (`item_name_in_use`, `not_found`, ...).

| Method | Caller | Purpose |
|---|---|---|
| `getAuthorizeUrl` | sign-in app | The PKCE authorize URL; returns `codeVerifier`. |
| `exchangeCode` | Accounts (validator) | `?code=` -> tokens (PKCE and the client secret); the login as username. |
| `checkCredentials` | Accounts | `onCredentialsChanged`. |
| `listFolder`, `downloadFile`, `uploadFile` | Documents, Topaz Explorer | Browse (every page), fetch, store; `replace:true` uploads a new version. |
| `createFolder`, `moveItem`, `deleteItem` | Documents, Topaz Explorer | Manage; never autorename, never the root; delete goes to the Box trash. |
| `listAlbums`, `listPhotos`, `upload`, `deletePhoto` | Photos service | One folder (the root, `"0"`) as one album, "Box Photos". |
| `quit`, `info` | installer | Quit before an update; what the service is. |

## How it differs from Dropbox (Box is REST, not RPC)

| | Dropbox (v2) | Box (v2) |
|---|---|---|
| Style | RPC: POST, JSON path args | REST: GET/POST/PUT/DELETE, ids |
| Folder locator | path string (`/Camera Uploads`) | folder **id** (root = `"0"`) |
| Entry `path` | `path_lower` | the Box **id** (folder id to descend, file id to fetch) |
| File or folder | one endpoint for both | separate: `moveItem`/`deleteItem` probe `GET /files/{id}`, then `/folders/{id}` on a 404 |
| Uploads | `content.dropboxapi.com`, the file as the body | `upload.box.com`, multipart: `attributes` JSON, then the file |
| Downloads | `/files/download` | `GET /files/{id}/content` -> 302 to `dl.boxcloud.com` (followed; the token is not sent there) |
| Refresh token | long-lived | **rotates on every refresh**: the request's later calls use the new one, and it is saved to the account |
| Photo `src_big` | `/files/get_temporary_link` per file | `/files/{id}/content?access_token=` (no call per file) |

## Configuration

Register a Box app at <https://app.box.com/developers/console> -> **Custom App -> User
Authentication (OAuth 2.0)**, add the redirect URI `http://localhost/boxnet/oauth2callback`,
scope `root_readwrite`. The build fills its client id and secret into `config.js`; Box's token
endpoint refuses a code without the secret (`invalid_client`). HTTPS is node's own `fetch`;
`CURL`/`CURL_CAINFO` are kept only for the on-device harness's reachability check.

## Deploy (device)

The service directory is installed as `/usr/palm/services/com.palm.service.boxnet/`, next to
`/usr/palm/services/_cloudcore/`, which `service.js` requires as `../_cloudcore/node`. The
service exits after 30 s idle and is started again by the next call.
