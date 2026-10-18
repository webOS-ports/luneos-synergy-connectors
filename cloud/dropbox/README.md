# Dropbox connector

A complete, decoupled Dropbox Synergy connector: OAuth2/PKCE sign-in, file
browse/upload/download, and a Photos-app cloud source. Verified end-to-end on device.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.dropbox/` | The node service: OAuth2, Dropbox API v2 client, all HTTPS via the modern curl. Hosts every command below. |
| `apps/com.palm.app.dropbox-auth/` | customUI OAuth webview the account template launches. Drives the Atlas login and hands the `?code=` back to the service. |
| `apps/com.palm.app.dropbox-files/` | Enyo 0.10 file-picker/manager consumer app (browse / upload / download). |
| `account/com.palm.dropbox/` | Synergy account template — base + 7 locale overrides. |

## Service commands (`services.json`)

| Method | Caller | Purpose |
|---|---|---|
| `getAuthorizeUrl` | auth app | Build the PKCE authorize URL; returns `codeVerifier` (stateless — see below). |
| `exchangeCode` | account validator | Redeem `?code=` → tokens; fetch email as username; return `credentials.common`. |
| `checkCredentials` | accounts | `onCredentialsChanged` validator. |
| `listFolder` | files app / photos app | Browse a folder (normalized entries). |
| `uploadFile` / `downloadFile` | files app | File I/O (curl streams to/from disk, bypasses node maxBuffer). |
| `listAlbums` / `listPhotos` | **Photos aggregator** | Photo-provider contract — see [`../../photos-integration`](../../photos-integration). |

### Access control (`acl.js`)

The stock mojoservice framework does **not** enforce a command's `allowedAppIds` — `acl.js`
adds it, mirroring `com.palm.service.accounts` (caller = `applicationID() ||
senderServiceName()`, glob-matched). App-facing methods (`listFolder`, `uploadFile`,
`downloadFile`) are gated to `com.palm.app.dropbox-files` / `com.palm.app.photos`.
`listAlbums`/`listPhotos` are intentionally **open** — the Photos aggregator calls provider
services with *no* bus identity (same as the stock facebook/photobucket providers), so they
rely on the LS2 private-bus role instead. `Acl.BRINGUP` (default **false**) is a
testing-only switch that would let anonymous shell callers through.

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

- `CLIENT_ID` — Dropbox app key (public; PKCE, no secret). Register a scoped-access app at
  <https://www.dropbox.com/developers/apps> with `account_info.read files.metadata.read
  files.content.read files.content.write`, `token_access_type=offline`, and **"Allow public
  clients" enabled**.
- `CURL` = `/usr/bin/curl` (the modern system curl from the OpenSSL-11 update; no
  `CURL_LD_LIBRARY_PATH` needed).
- `CURL_CAINFO` = `/etc/ssl/certs/ca-certificates.crt` (the current system CA store — a
  deployment prerequisite; see top-level README).

## Deploy (device)

```sh
# service + apps + template (rootfs may be read-only after reboot)
mount -o remount,rw /
#  service -> /usr/palm/services/com.palm.service.dropbox/
#  auth app -> /media/cryptofs/apps/usr/palm/applications/com.palm.app.dropbox-auth/
#  files app-> /media/cryptofs/apps/usr/palm/applications/com.palm.app.dropbox-files/
#  template -> /usr/palm/public/accounts/com.palm.dropbox/  (base + resources/*)
```

After any **template content** change, restart the accounts service (kill the
`ice.accounts.js` pid — it caches templates at startup) **then** LunaSysMgr. After an
**auth-app JS** change, restart LunaSysMgr (the accounts webview caches the app source).
Service `.js` reloads per-call.

> All `.js`/`.json` here pass `node --check` / JSON parse.
