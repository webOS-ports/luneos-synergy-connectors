# Dropbox connector

OAuth2/PKCE sign-in, file browse/upload/download/manage, and a Photos-app cloud source.
The reference connector for `_cloudcore/node`: the first one ported off mojoservice onto
plain node (22) modules, and the one the others copy.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.dropbox/` | The node service (see below). |
| `account/com.palm.dropbox/` | Synergy account template. Sign-in runs in `com.palm.app.cloud-auth` (`cloud/_core/apps/`). |
| `files/sysbus/` | Its LS2 role, permissions and service file. |

The service directory:

| File | What it is |
|---|---|
| `package.json` | `main: service.js`. With it, `run-js-service` (jsservicelauncher `bootstrap-node.js`) does `require()` of the directory and calls `run()` instead of loading a mojoservice `sources.json`. |
| `service.js` | Wires `config.js`, `adapter.js` and `photos.js` into `_cloudcore/node`'s `connector()`. |
| `config.js` | OAuth app, endpoints, caller allow-lists. A plain file: the build fills `PLACEHOLDER_DROPBOX_CLIENT_ID` in with sed. |
| `adapter.js` | Dropbox API v2 as async functions on a session (`listFolder`, `downloadFile`, `uploadFile`, ...). |
| `photos.js` | `listAlbums` / `listPhotos` for the Photos service. |

## Service methods

The generic ones come from `_cloudcore/node/commands.js` (arguments and replies listed at its
head); `listAlbums`/`listPhotos` from `photos.js`.

| Method | Caller | Purpose |
|---|---|---|
| `getAuthorizeUrl` | sign-in app | The PKCE authorize URL; returns `codeVerifier` (stateless, see below). |
| `exchangeCode` | Accounts (validator) | `?code=` -> tokens; the account email as username; `credentials.common`. |
| `checkCredentials` | Accounts | `onCredentialsChanged`. |
| `listFolder`, `downloadFile`, `uploadFile` | Documents, Topaz Explorer | Browse, fetch, store (streamed to and from disk). |
| `createFolder`, `moveItem`, `deleteItem` | Documents, Topaz Explorer | Manage; never autorename, never the root. |
| `listAlbums`, `listPhotos`, `upload`, `deletePhoto` | Photos service | One folder (`/Camera Uploads`) as one album. |
| `quit`, `info` | installer | Quit before an update; what the service is. |

### Access control

The file methods take only the callers in `Config.FILE_APP_IDS` (caller = `applicationID()`
without its pid, else `senderServiceName()`, glob-matched as `com.palm.service.accounts`
does). The others are open: Accounts and the Photos service call with no app id, and the
sign-in app's calls arrive as `com.palm.app.accounts-<pid>`. The LS2 files decide who reaches
the service at all.

## How sign-in works (no client secret)

```
Settings → Add Dropbox ──customUI──> com.palm.app.dropbox-auth
   getAuthorizeUrl ──> service returns {url, codeVerifier}        (PKCE, S256)
   launch Atlas (simple mode) ──> Dropbox login in WPE (modern TLS)
   Atlas captures ?code= ──> systemservice pref ──> auth app polls it
   exchangeCode {code, codeVerifier} ──> service ──curl──> token endpoint
       └─> {access, refresh} stored as account credentials.common; email = username
```

Key correctness points (each was a real bug fixed during bring-up):

- **PKCE is stateless.** The service is idle-killed during the (long) web login, so the
  `code_verifier` can't live in service memory — `getAuthorizeUrl` returns it, the app
  carries it, and `exchangeCode` receives it back.
- **The auth app must be in the template's `read`+`writePermissions`.** `createAccount`
  runs under the auth app's appId and is permission-checked against the template.
- **`exchangeCode` must return a `username`** (Dropbox account email) — `createAccount`
  rejects a missing username.
- **Credentials by `accountId`.** Consumer apps never handle tokens; they pass `accountId`
  and the service does `readCredentials`/`writeCredentials` (key `"common"`) itself,
  persisting rotated refresh tokens.

## Configuration

`service/com.palm.service.dropbox/config.js`:

- `CLIENT_ID` - Dropbox app key (public; PKCE, no secret), filled in by the build. Register a
  scoped-access app at <https://www.dropbox.com/developers/apps> with `account_info.read
  files.metadata.read files.content.read files.content.write`, `token_access_type=offline`, and
  **"Allow public clients" enabled**.
- HTTPS is node's own `fetch` with node's CA store. `CURL`/`CURL_CAINFO` are no longer used by
  the service; the on-device harness still reads them for its reachability check.

## Deploy (device)

The `synergy-cloud-dropbox` recipe (meta-luneos) installs the service directory as
`/usr/palm/services/com.palm.service.dropbox/`, next to `/usr/palm/services/_cloudcore/`
from `synergy-cloudcore`, which `service.js` requires as `../_cloudcore/node`.
After a template change, restart the Accounts service (it reads templates at startup).
The service itself exits after 30 s idle and is started again by the next call.
