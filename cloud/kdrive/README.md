# kDrive connector

An **Infomaniak kDrive** **DOCUMENTS** connector on the shared **`_cloudcore`** runtime, using a
**personal API token** to authenticate.

kDrive was the *easiest* provider to reach — **a free 15 GB account can use the REST API**, and
Infomaniak issues a **personal API token** (a long-lived Bearer credential), so this connector
needs **no OAuth app, no PKCE, no Atlas** — the single most fragile part of every other connector.
(Verified live against a free account: profile, drive list, folder listing, metadata, and the
302→pre-signed download all work with just a token.)

## Sign-in: paste an API token

1. On a computer, open the Infomaniak API-token page:
   **<https://manager.infomaniak.com/v3/ng/profile/user/token/list>**
   (manager.infomaniak.com → your avatar/**Profile** → **API tokens**).
2. Click **Create a token**, set the scope to **Drive**, and copy the token.
3. In webOS: **Settings → Accounts → Add an account → kDrive**, paste the token, tap **Connect**.
   (The account screen also has an **"Open token page in browser"** button, so you can create +
   copy the token on the device itself and paste it into the field.)

The service validates the token and **auto-discovers** your account_id + drive_id, so the token
is all you provide. It is stored ONLY in the on-device account DB — never in this repo.

### Why not OAuth?

Investigated and **ruled out** (verified live). Infomaniak's OAuth (`login.infomaniak.com`) is an
**OIDC login/SSO** server: its scopes are identity-only (`openid profile email phone`) and it
**rejects the `drive` scope with `invalid_scope`**. The kDrive API's `drive`/`user_info` scopes
exist only in the personal-API-token system — a separate namespace OAuth cannot issue — so an
OAuth token gets `403 … require scope "drive"` from the API. The token is the only credential
that works, hence a single-field sign-in.

## What's here

```
service/com.palm.service.kdrive/     node service on the shared _cloudcore runtime
  config.js        API host + ROOT_FOLDER=1 + _cloudcore wiring (token-only, no OAuth)
  adapter.js       kDrive REST: /3/drive/{id}/files/{fid}/files (list), /2/…/download (302 ->
                   pre-signed), /3/…/upload (conflict=version); result-envelope, Bearer token,
                   no refresh; + discoverAccount() (profile -> drive_id) for verifyToken
  commands/verifyToken_command.js    the account validator: validate token, discover the drive
  sources.json     ../_cloudcore/{acl,httpcurl,creds,cloudservice} + generic
                   checkCredentials/listFolder/uploadFile/downloadFile + local verifyToken
apps/
  com.palm.app.kdrive-auth/          token-entry customUI (single field -> verifyToken)
account/com.palm.kdrive.json         Synergy template: customUI -> kdrive-auth, DOCUMENTS
```

## API shape (verified)

- **Envelope:** HTTP 200 `{ "result":"success", "data":… }` / `{ "result":"error", "error":… }`
- **IDs:** numeric; a file/dir has `id`, `type` (`dir`/`file`), `name`, `size`,
  `last_modified_at`, `parent_id`, `visibility`
- **Root is NOT writable.** The drive-root (id `1`) is a container: `visibility:"is_root"`,
  `capabilities.can_write=false`, and it **rejects listing-as-upload-target / uploads**
  (`403 upload_destination_not_writable`). User files live one level down in the **private space**
  (`visibility:"is_private_space"`, "Private"). The connector therefore treats that private folder
  as its root: `findPrivateRoot()` lists id 1's children, picks the `is_private_space` one, and
  caches it as `creds.rootFolderId` (discovered at account-add; lazily on first op for older creds).
- **Upload requires `total_size`** (query param) up front, or `422 validation_failed`. The adapter
  `stat`s the local file (`require("fs")`, available in the service context) and sends it.
- **Mixed versions:** files list/metadata + upload = **v3**; drive list + download = **v2**
- **Download:** `GET /2/drive/{drive}/files/{id}/download` → **302** to
  `*.download.kdrive.infomaniakusercontent.com` (curl `-L` follows, drops auth cross-host)
- **Upload:** `POST /3/drive/{drive}/upload?directory_id={writable-folder}&file_name={name}`
  `&conflict=version&total_size={bytes}`, raw file as body → `200 {data:{id,…}}`
- **Discovery:** `GET /2/profile` → `preferences.account.current_account_id`; then
  `GET /2/drive?account_id={id}` → drives; then `findPrivateRoot` → writable root folder id

## Configuration

Nothing to configure in the repo — the user pastes the token at add-time and it is stored ONLY
in the on-device account DB. Same modern system-curl (`/usr/bin/curl`) + current-CA prerequisites
as the other connectors.

## Status / caveats

- ✅ Service + adapter + validator + token-entry app + template. All `node --check` / JSON-valid.
- ✅ **Deployed + verified on device** (webOS 3.0.5 TouchPad): `verifyToken` cold-starts, validates
  the token and auto-discovers account_id + drive_id; `listFolder` returns normalised entries
  (v3 API). New LS2 bus registered via role/dbus/`palm_bus_config` files + `ls-control scan-services`.
- ✅ **Account created + credentials persisted end-to-end**: an account lands in `listAccounts`
  (DOCUMENTS provider), the token is stored in keymanager under `common`, and `listFolder` called
  with **only the accountId** reads that stored token back and returns the real drive root — so the
  service-side `AccountCreds.resolve` → readCredentials → Bearer path is proven, not just hand-passed
  tokens.
- ✅ **Appears + lists in QuickOffice** (account-derived reroute — see `../../quickoffice-integration/`).
  Box + Dropbox still list; kDrive shows up with **no QuickOffice code change**.
- ✅ **Upload / save-back verified on device**: `uploadFile` into the account root creates the file
  (`returnValue:true`) — this drove the fixes above (`total_size` required; drive-root not writable
  → resolve the private space; **numeric ids stringified** because QuickOffice does string ops like
  `.replace()` on the locator). `listFolder` at root returns the private-space contents directly.
- ✅ **Photo source (`PHOTO.UPLOAD`)**: `listAlbums`/`listPhotos` surface one folder
  (`Config.PHOTO_ALBUM_NAME`, default "Pictures", under the private root) as an album; `src_big` =
  `…/download?access_token=` and `src_small` = `…/thumbnail?access_token=` (headerless auth, so the
  stock Photos aggregator's curl fetch works — see `../../photos-integration/`). Verified on device:
  album + photo entries + working URLs. The account carries DOCUMENTS **and** PHOTO.UPLOAD.
- ✅ **Photo UPLOAD (device→cloud, "Add Photos")**: the generic `_cloudcore/commands/uploadPhoto_command.js`
  implements the aggregator's `<service>/upload {accountId, albumId, path}` contract (the
  `AlbumManageAssistant.uploadPhotoToCloud` call) → `Adapter.uploadFile` into the album folder →
  `{returnValue:true, pid}`. `Adapter.ensureAlbumFolder` find-or-creates the "Pictures" folder if the
  aggregator passes an empty albumId. Verified on device: `upload` returns a `pid` and the file then
  appears in `listPhotos`. **The Library name is the account `alias`** (Box/Dropbox show the holder
  name); the headless-created kDrive account had no alias, set once via
  `accounts/modifyAccount {object:{alias}}` (no credentials passed → token + capabilities preserved).
- ⏳ **Account-add through the Settings customUI** (token-entry app) not exercised live — the account
  was created headlessly via `createAccount` (the user has no easy way to paste an 80-char token on
  the device). The app is deployed and derives its service URI correctly; only the manual paste is
  untested.
- ⚠️ Picks the **first** drive the account owns (fine for single-drive accounts).
