# Box connector

A full Box (`box.com`) **DOCUMENTS + PHOTO.UPLOAD** connector, built to the same
architecture as Dropbox. Code-complete; **untested on device** only because it needs a Box
`client_id` (see Configuration) — everything else mirrors the verified Dropbox stack.

## What's here

```
service/com.palm.service.boxnet/   node service: OAuth2/PKCE + Box REST API v2
  oauth2.js        public-client PKCE (no client_secret); client_secret optional & auto-detected
  boxapi.js        REST v2: GET /folders/{id}/items, /files/{id}/content, upload, refresh-on-401
  httpcurl.js      shells all TLS to the bundled modern curl (follow + multipart added for Box)
  creds.js acl.js  credentials-by-accountId; allowedAppIds enforcement
  commands/        getAuthorizeUrl, exchangeCode, checkCredentials,
                   listFolder, downloadFile, uploadFile,           <- DOCUMENTS
                   photolib, listAlbums, listPhotos                <- PHOTO.UPLOAD
apps/
  com.palm.app.boxnet-auth/    customUI OAuth login (Atlas simple-mode, stateless PKCE verifier)
  com.palm.app.boxnet-files/   Enyo file browser/uploader (folder-ID breadcrumb stack)
account/com.palm.boxnet.json   Synergy template: customUI validator, DOCUMENTS + PHOTO.UPLOAD,
                               permissions for the auth app + both services
```

## How it differs from Dropbox (Box is REST, not RPC)

| | Dropbox (v2) | Box (v2) |
|---|---|---|
| Style | RPC — POST, JSON path args | REST — GET, numeric IDs |
| Folder locator | path string (`/Camera Uploads`) | folder **ID** (root = `"0"`) |
| Refresh token | long-lived | **rotates on every use** — persist the new one each call |
| Photo `src_big` | `/files/get_temporary_link` (pre-signed, per file) | `/files/{id}/content?access_token=` (token in query; no per-file call) |
| List entry `path` | Dropbox path | the Box **id** (folder id to descend, file id to fetch) |

The service accepts a generic `path` locator (= folder/file ID) so the file-picker and the
QuickOffice reroute can call it Dropbox-uniformly.

## Configuration (required before it can run)

Register a Box app at <https://app.box.com/developers/console> → **Custom App → OAuth 2.0
(User Authentication)**, add redirect URI `http://localhost/boxnet/oauth2callback`, scope
`root_readwrite`. Put the `client_id` into `service/com.palm.service.boxnet/config.js`
(`CLIENT_ID`). A `client_secret` is **optional** — `oauth2.js` auto-detects the `PLACEHOLDER_`
sentinel and runs pure PKCE (public client) when no real secret is set. Same modern-curl +
current-CA prerequisites as Dropbox.

## Status / remaining

- ✅ Service, both apps, template, Photos-aggregator `case "com.palm.boxnet"` (in
  [`../../photos-integration/patches/Utils.js.patch`](../../photos-integration/patches/Utils.js.patch)).
- ⏳ **Account sign-in untested** — needs a real `client_id`.
- ⏳ **QuickOffice Box reroute** — mirror the Dropbox `mxId "drop"` branch with an `mxId "box"`
  branch (Box was an original QuickOffice provider, so the mapping already exists); this is an
  on-device `RemoteFileService.js` edit, same as Dropbox.
