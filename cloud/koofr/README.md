# Koofr connector

A Synergy connector for **Koofr** as a **DOCUMENTS** provider (browse, download, upload and
manage files for Documents and Topaz Explorer) and a **PHOTO.UPLOAD** source for the Photos
service. It runs on `_cloudcore/node` (plain node 22 modules), laid out like the Dropbox
connector, which is the reference.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.koofr/` | The node service (see below). |
| `account/com.palm.koofr.json` | Synergy account template. Sign-in runs in `com.palm.app.cloud-auth` (`cloud/_core/apps/`). |
| `files/sysbus/` | Its LS2 role, permissions and service file. |

The service directory:

| File | What it is |
|---|---|
| `package.json` | `main: service.js`; `run-js-service` requires the directory and calls `run()`. |
| `service.js` | Wires `config.js`, `adapter.js` and `photos.js` into `_cloudcore/node`'s `connector()`. |
| `config.js` | OAuth app, endpoints, caller allow-lists. A plain file: the build fills `PLACEHOLDER_KOOFR_CLIENT_ID` / `PLACEHOLDER_KOOFR_CLIENT_SECRET` in with sed. |
| `adapter.js` | Koofr REST v2 as async functions on a session. |
| `photos.js` | `listAlbums` / `listPhotos`, and `upload` with the album id decoded. |

## Shape

- **Auth:** OAuth2 (Ory Hydra) authorization code with PKCE **and** a client secret
  (a confidential client); scope `public`, the only one Koofr accepts. The generic
  `getAuthorizeUrl`/`exchangeCode`/`checkCredentials` of `_cloudcore/node`, a refresh on a 401.
- **API:** `https://app.koofr.net/api/v2` for metadata, `…/content/api/v2` for file bytes;
  every request carries `X-Koofr-Version: 2.1`.
- **Mount + path model:** files live under a **mount**; the user's **primary** mount
  (`GET /mounts` → `isPrimary`, else the first) is resolved the first time a request needs it
  and kept on the credentials (`mountId`), so it is saved with a renewed token. A locator is an
  absolute path in that mount; the root is `/` (`""`, `root` too).
- **File operations:** `createFolder` (an existing name fails, 409), `moveItem` (a rename in
  place is `files/rename`, anything else one `files/move`; an existing destination is refused
  first with `KOOFR_EXISTS`, a change of case of the item itself is let through), `deleteItem`
  (never the root), `uploadFile` (`files/put`, overwrite; the name in the URL and the multipart
  part), `uploadFile replace:true` (the same put into the file's folder under its name).
- **Errors:** `KOOFR_API_ERROR` with the HTTP status (Koofr's message as text);
  `KOOFR_DOWNLOAD_FAILED`, `KOOFR_MKDIR_FAILED`, `KOOFR_DELETE_FAILED`, `KOOFR_NO_MOUNT`,
  `KOOFR_EXISTS`; `CURL_FAILED` when no reply came.

## Photos

`listAlbums` lists the mount root (album "Koofr", if it holds images) and every folder directly
under it that holds images; the `aid` is the folder path URL-encoded, since the Photos service
makes a local folder from it with a non-recursive mkdir. With no images anywhere there is one
empty album (`aid` `""`, "Camera Uploads"). `listPhotos` decodes the `aid` and gives one
`files/download` link per image; `upload` decodes the `aid` too, and without one makes
"Camera Uploads" at the root and uploads there. `deletePhoto` removes the photo by path.

## Tests

`tests/unit/koofr.test.js` drives the service over a stand-in bus and fetch: every method's
requests, replies and errors, and every request of every method failing in five ways.

## Known caveats

- Without `offline_access` (Koofr refuses it) Hydra may not issue a refresh token; an account
  whose access token expires then needs signing in again.
- **Digi Storage** (Koofr's white label) would only need a different `API_BASE`/`CONTENT_BASE`.
- Placeholder icons (blue "K").
