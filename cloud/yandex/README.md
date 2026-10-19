# Yandex Disk connector

A **Yandex Disk** (`cloud-api.yandex.net/v1/disk`) Synergy connector providing both
**DOCUMENTS** and **PHOTO.UPLOAD** (photo source + device→cloud upload), built to the same
architecture as the Dropbox/OneDrive connectors. Credentialed and **verified end-to-end
against the live API** (OAuth incl. refresh, identity, docs up/download, folder-create, photo
list + signed links); on-device account sign-in remains the only step exercised solely by the
framework.

Yandex Disk is **path-based like Dropbox** — a resource is a real path
(`disk:/Documents/foo.docx`), not an opaque item id — so this connector is a near-clone of
Dropbox, and the uniform consumer contract maps cleanly (no opaque-id filename recovery).

## What's here

```
service/com.palm.service.yandexdisk/   node service on _cloudcore/node (node 22, fetch, no curl),
                                       laid out as the Dropbox connector is
  package.json     main: service.js; run-js-service requires the directory and calls run()
  service.js       wires config.js, adapter.js and photos.js into _cloudcore/node's connector()
  config.js        OAuth (oauth.yandex.com) + REST (cloud-api.yandex.net/v1/disk) endpoints;
                   CLIENT_ID + CLIENT_SECRET placeholders (filled in by the build with sed)
  adapter.js       Disk REST: /resources listing (paged with offset), the two-step signed-href
                   download/upload, create/move (overwrite=false)/delete (to the Trash), 202
                   operations polled with a bound. "Authorization: OAuth <token>" (NOT Bearer)
  photos.js        listAlbums / listPhotos for the Photos service
account/com.palm.yandexdisk.json   Synergy template: customUI validator (com.palm.app.cloud-auth),
                                   DOCUMENTS + PHOTO.UPLOAD capabilities
account/images/                    32x32 / 48x48 icons (PLACEHOLDERS — rebrand for Yandex)
```

The generic methods (`getAuthorizeUrl`, `exchangeCode`, `checkCredentials`, `listFolder`,
`downloadFile`, `uploadFile`, `createFolder`, `moveItem`, `deleteItem`, `upload`, `deletePhoto`)
come from `_cloudcore/node/commands.js`, with their arguments and replies listed at its head.

Icons under `apps/*/icon.png` and `account/images/*` are **placeholders copied from the
Dropbox connector** — replace them with Yandex Disk artwork before shipping.

## Identifiers

- Bus/service name: **`com.palm.service.yandexdisk`**
- Account templateId: **`com.palm.yandexdisk`**
- QuickOffice reroute mxId: **`yandex`** (the integrator wires the reroute; this connector
  only provides the service methods it calls)

## How the API is used (web-verified July 2026)

| Operation | Endpoint |
|---|---|
| Authorize | `GET https://oauth.yandex.com/authorize?response_type=code&client_id=…&redirect_uri=…&scope=…&code_challenge=…&code_challenge_method=S256` |
| Token | `POST https://oauth.yandex.com/token` — `grant_type=authorization_code&code=&client_id=&client_secret=&code_verifier=` → `{access_token, refresh_token, expires_in}` |
| Refresh | same token endpoint, `grant_type=refresh_token&refresh_token=` |
| Identity | `GET https://login.yandex.ru/info?format=json` → `{login, default_email, real_name}` (for `username`) |
| List | `GET /v1/disk/resources?path=disk:/FOLDER&limit=200` → `_embedded.items[]` `{name, type("dir"\|"file"), path, size, modified, mime_type}` |
| Download | `GET /v1/disk/resources/download?path=…` → `{href, method}`; then GET `href` (signed, no auth) to disk |
| Upload | `GET /v1/disk/resources/upload?path=DEST&overwrite=true` → `{href, method:"PUT"}`; then PUT the file to `href` (signed, no auth) |

All authenticated Disk/identity requests send **`Authorization: OAuth <access_token>`**.
`type:"dir"` maps to the uniform `"folder"`; files map to their `mime_type` (or `"file"`).

## Uniform consumer contract

- `listFolder {accountId, path}` → `{entries:[{type, name, path, size, modified}]}`
  (`path` is a `disk:/…` locator; `""`/`"/"`/`"disk:/"` = root)
- `downloadFile {accountId, path|dropboxPath, localPath}`
- `uploadFile {accountId, localPath, path | folderId, name, replace}` — a full `path` wins;
  otherwise `folderId`+`name` are joined. **Replace = overwrite** (path-based), which is also
  the create-default, so `replace` never needs an item id.

## Configuration (required before it can run)

Register a free app at **https://oauth.yandex.com/client/new**:
- **Redirect URI:** add `http://localhost/yandex/oauth2callback` verbatim.
- **Permissions (scopes):** Yandex.Disk REST API — *Read* + *Write* + *Info*; plus
  *Access to email address* and *Access to username* (so `exchangeCode` can fetch the email).
- Copy the **ID** into `service/com.palm.service.yandexdisk/config.js` `CLIENT_ID`, and the
  **Password/secret** into `CLIENT_SECRET`. *(Already populated with a registered app; the
  steps above are for re-registering under a different Yandex account.)*
  - To run as a **public (PKCE-only) client** instead, leave `CLIENT_SECRET` as the
    `PLACEHOLDER…` default — `_cloudcore/node/oauth.js` then never sends a secret (it still sends the S256
    challenge). Whether Yandex accepts a secret-less exchange depends on the app type chosen.

HTTPS is node's own `fetch` with node's CA store; `CURL`/`CURL_CAINFO` stay in `config.js` only
for the on-device harness's reachability check.

## Photos (PHOTO.UPLOAD)

Yandex Disk also registers as a **photo source + upload target** (like Box/Dropbox/kDrive).
The album is resolved at call time by `Adapter.resolvePhotoAlbum`: Yandex's own **camera-uploads
folder** (`GET /v1/disk?fields=system_folders` → `system_folders.photostream`, server-localized —
e.g. `disk:/Camera Uploads/` or `disk:/Фотокамера/`) when that folder exists, else the
`Config.PHOTO_ALBUM_NAME` fallback (`Pictures`, created on first device→cloud upload). `photostream`
is *listed* even before first use, so `resolvePhotoAlbum` probes the folder and only adopts it when
it really exists. Like Dropbox, `listPhotos` resolves a short-lived signed `/resources/download`
href **per photo** for `src_big`/`src_small` (self-authenticating; the aggregator's curl fetch
needs no auth header). Wiring: the `PHOTO.UPLOAD` capabilityProvider in the account template, the
`listAlbums`/`listPhotos`/`upload` commands, and the `com.palm.yandexdisk` entry in
`../../photos-integration/patches/Utils.js.patch` (+ the Library icon in the CSS patch).

> **⚠️ Re-add the account after enabling photos.** An account's `capabilityProviders` are
> snapshotted into its `com.palm.account` DB record at **creation time** — updating this template
> does NOT retroactively add `PHOTO.UPLOAD` to an account that was created when the template was
> DOCUMENTS-only. So a Yandex account added before this change will **not** appear in the Photos &
> Videos app. Deploy the updated template, restart the accounts service, then **remove and re-add
> the Yandex account** so its record picks up `PHOTO.UPLOAD`. Verify with:
> `luna-send -n 1 -f luna://com.palm.db/find '{"query":{"from":"com.palm.account:1","where":[{"prop":"templateId","op":"=","val":"com.palm.yandexdisk"}]}}'`
> — the record's `capabilityProviders` must list `PHOTO.UPLOAD`.

## Status / caveats

- ✅ Service, both apps, template — all `node --check` clean.
- ✅ **Live-API verified** (off-device, system curl): OAuth Authorization-Code+PKCE+secret,
  **refresh-token**, identity, docs list/upload/download (byte-identical round trip), photo
  `ensureAlbumFolder`/upload, `resolvePhotoAlbum` (incl. the Pictures fallback), and per-photo
  signed `src_big` links — all confirmed against a real Yandex account.
- ⏳ **On-device account sign-in** — the customUI OAuth webview flow is the one path exercised
  only by the framework on hardware; the token exchange it calls is verified.
- ⚠️ **Icons are placeholders** (copied from Dropbox) — rebrand before shipping. (The Photos
  **Library** icon `icon_yandexdisk_{40x40,20x20}.png` under `../../photos-integration/assets/` is
  already Yandex-branded.)
- ✅ **Unit-tested on `_cloudcore/node`** (`tests/unit/yandex.test.js`): exact requests,
  replies, errors, root handling, operation polling, and every request of every method failed
  in five ways. The live-API checks above were made with the earlier curl-based service.
- **List paging:** folders are read in full, `limit=200` per page with `offset`, up to
  `_embedded.total`.
- ⚠️ **Signed-href auth:** the download/upload hrefs are treated as self-authenticating
  (fetched with no OAuth header), per Yandex docs ("you don't need an OAuth token to
  upload"). Redirects are followed in case the download href 302-redirects to a storage host.
- ⏳ **QuickOffice reroute (mxId `yandex`)** — provided by the integrator; not in this dir.
