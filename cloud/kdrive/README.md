# kDrive connector

Infomaniak **kDrive**: file browse/upload/download/manage for Documents and Topaz Explorer, and
a Photos-app cloud source. It runs on `_cloudcore/node` (plain node 22 modules), laid out like
the Dropbox connector.

Sign-in today is a **personal API token** the user pastes. OAuth2 + PKCE is wired up in the
service but not switched on: LuneOS's Infomaniak OAuth app has not been granted the scope
`drive` yet (see [Switching to OAuth](#switching-to-oauth)).

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.kdrive/` | The node service (see below). |
| `apps/com.palm.app.kdrive-auth/` | The token sign-in app (customUI): one field, calls `verifyToken`. |
| `account/com.palm.kdrive.json` | Synergy account template: customUI `com.palm.app.kdrive-auth`, validator `verifyToken`, DOCUMENTS and PHOTO.UPLOAD. |
| `files/sysbus/` | Its LS2 role, permissions and service file. |

The service directory:

| File | What it is |
|---|---|
| `package.json` | `main: service.js`, so `run-js-service` `require()`s the directory and calls `run()`. |
| `service.js` | Wires `config.js`, `adapter.js`, `signin.js` and `photos.js` into `_cloudcore/node`'s `connector()`. |
| `config.js` | Endpoints, the OAuth app (placeholders the build fills in by sed), caller allow-lists. |
| `adapter.js` | The kDrive REST API as async functions on a session. |
| `signin.js` | `verifyToken` (token sign-in) and kDrive's own `exchangeCode` (OAuth), both finding the drive. |
| `photos.js` | `listAlbums` / `listPhotos` for the Photos service. |

## Service methods

The generic ones come from `_cloudcore/node/commands.js` (arguments and replies at its head).

| Method | Caller | Purpose |
|---|---|---|
| `verifyToken` | Accounts (validator, via the sign-in app) | `{ token }` -> `{ username, alias, credentials:{ common:{ accessToken, accountId, driveId, rootFolderId } } }` |
| `getAuthorizeUrl`, `exchangeCode` | (not used yet) | OAuth2 + PKCE; `exchangeCode` stores `{ accessToken, refreshToken, expiresAt, accountId, driveId, rootFolderId }`. |
| `checkCredentials` | Accounts | `onCredentialsChanged`: the profile with the token. |
| `listFolder`, `downloadFile`, `uploadFile` | Documents, Topaz Explorer | Browse (every page), fetch, store (streamed to and from disk); `replace:true` makes a new version of the file. |
| `createFolder`, `moveItem`, `deleteItem` | Documents, Topaz Explorer | Manage; a move never overwrites (`conflict:error`); delete goes to kDrive's trash; never the root. |
| `listAlbums`, `listPhotos`, `upload`, `deletePhoto` | Photos service | One folder (`Pictures` under the private space) as one album. |
| `quit`, `info` | installer | |

File methods take only `Config.FILE_APP_IDS`; the rest are open (Accounts, the sign-in app as
`com.palm.app.accounts-<pid>`, and the Photos service call without an app id that matches).

## The API (https://developer.infomaniak.com/docs/api)

- **Envelope:** `{ result:"success", data, cursor?, has_more? }`; errors `{ result:"error", error:{ code, description } }`, as a rule with a 4xx/5xx status.
- **Ids** are numeric and handed out as strings. The **drive root (id 1) is not writable**; the
  user's files are in the private space under it (`visibility:"is_private_space"`), which the
  connector treats as its root (`""`, `"/"`, `"root"` and `1` all mean it).
- Endpoints used (versions differ per endpoint):

| What | Request |
|---|---|
| profile, account id | `GET /2/profile` (`preferences.account.current_account_id`) |
| drives | `GET /2/drive?account_id={id}` (the first one is used) |
| list | `GET /3/drive/{d}/files/{id}/files?limit=1000[&cursor=]`, while `has_more` |
| info | `GET /3/drive/{d}/files/{id}` |
| download | `GET /2/drive/{d}/files/{id}/download` (302 to a pre-signed host) |
| upload | `POST /3/drive/{d}/upload?directory_id&file_name&conflict=version&total_size`, the file as the body |
| new folder | `POST /3/drive/{d}/files/{parent}/directory { name }` |
| move | `POST /3/drive/{d}/files/{id}/move/{to} { conflict:"error", name? }` |
| rename | `POST /2/drive/{d}/files/{id}/rename { name }` |
| delete (trash) | `DELETE /2/drive/{d}/files/{id}` |
| photo URLs | `/2/drive/{d}/files/{id}/download` and `/thumbnail`, `?access_token=` |

Move, rename and delete answer a cancel id, not the item, so `moveItem` reads the item
afterwards for its entry. `verifyToken`/`exchangeCode` store accountId, driveId and
rootFolderId with the token; credentials without them (an inline token, an older account) find
them on first use, and they are reported and saved like a renewed token. A refresh keeps them.

## Sign-in now: an API token

1. At <https://manager.infomaniak.com/v3/ng/profile/user/token/list> create a token with the
   scope **Drive** and copy it (the sign-in screen has a button that opens the page).
2. Settings → Accounts → Add an account → kDrive, paste it, Connect.

`verifyToken` checks it by using it (profile, drives, root listing). A token kDrive refuses is
`KDRIVE_TOKEN_INVALID`; no network is `CURL_FAILED`. The token does not expire and has no
refresh token, so a 401 is final.

## Switching to OAuth

Once Infomaniak grants LuneOS's OAuth app (type "Mobile", redirect
`http://localhost/kdrive/oauth2callback`) the scope `drive` - today its authorize answers
`error=invalid_scope` - and the build fills `PLACEHOLDER_KDRIVE_CLIENT_ID` /
`PLACEHOLDER_KDRIVE_CLIENT_SECRET` in (`KDRIVE_CLIENT_ID` / `KDRIVE_CLIENT_SECRET`):

- `account/com.palm.kdrive.json`: `validator.customUI.appId` -> `com.palm.app.cloud-auth`,
  `validator.address` -> `palm://com.palm.service.kdrive/exchangeCode`, and
  `com.palm.app.cloud-auth` instead of `com.palm.app.kdrive-auth` in `readPermissions` and
  `writePermissions` (createAccount runs as the customUI app).
- `files/sysbus/com.palm.service.kdrive.perm.json`: add `com.palm.app.cloud-auth` and
  `com.palm.app.cloud-auth-*`.
- `config.js`: `AUTH_APP_IDS: ["com.palm.app.cloud-auth"]`.
- `tests/connectors.json`: `"auth": "oauth2"`.
- Keep `apps/com.palm.app.kdrive-auth` and `verifyToken` as long as token accounts exist (they
  keep working: no refresh token, never refreshed); drop them when nobody needs them.
- Photos: `src_big`/`src_small` carry the access token, which works only as long as a short-lived
  OAuth token does; `GET /2/drive/{d}/files/{id}/temporary_url` is the alternative to look at.

## Status

- Unit tests: `tests/unit/kdrive.test.js` (every method's requests, replies and errors; each
  request of each method failing in six ways still gives exactly one error reply).
- The token connector on the old stack was verified on a TouchPad (sign-in by `createAccount`,
  list, upload, save-back, Photos). This node port has not run on a device yet; createFolder,
  moveItem and deleteItem are new and checked against the API documentation only.
- Picks the first drive the account has.
