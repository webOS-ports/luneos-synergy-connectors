# pCloud connector

A **pCloud** **DOCUMENTS + PHOTO.UPLOAD** Synergy connector on **`_cloudcore/node`** (plain
node 22 modules), laid out like the Dropbox connector, which is the reference.

pCloud uses the generic file methods of `_cloudcore/node` (listFolder, download, upload,
create/move/delete, checkCredentials, upload/deletePhoto) but has its **own `getAuthorizeUrl`
and `exchangeCode`** (`oauth2.js`): its region-host + no-PKCE + no-refresh auth cannot use the
generic ones. It still uses the one generic `com.palm.app.cloud-auth` app, which forwards the
redirect's `hostname`/`locationid` so `exchangeCode` can resolve the region.

pCloud is a clean REST/ID fit (folders and files are numeric IDs, the root is `folderid 0`),
so the service is a near-clone of the Box/OneDrive ones — with **one thing that makes pCloud
different: the data-region host.**

## The region-host quirk (read this first)

A pCloud account lives in **either** the US data region (**`api.pcloud.com`**, `locationid 1`)
**or** the EU region (**`eapi.pcloud.com`**, `locationid 2`). You cannot know which up front,
and calling the wrong host returns *"log in first"*. pCloud solves this by returning the
account's region in the **OAuth2 authorize redirect** — the redirect URL carries `hostname`
and `locationid` alongside the `?code=`.

So the connector:

1. The generic **`cloud-auth`** app extracts `hostname` + `locationid` from the captured
   redirect and forwards them (with the `code`) to `exchangeCode`. (It forwards those params
   for every provider; only pCloud's local `exchangeCode` reads them — harmless elsewhere.)
2. The **local `exchangeCode`** resolves the region host (redirect `hostname` wins → else
   `locationid` map → else the US default), does the **token exchange on that host**, and
   **stores it** in the account credentials as `common.apiHost`.
3. `adapter.js` reads `creds.apiHost` on **every** call (listfolder / getfilelink /
   uploadfile / userinfo), so all traffic for that account hits the correct region.

## What's here

```
service/com.palm.service.pcloud/     node service on _cloudcore/node
  package.json     main: service.js (run-js-service requires the directory, calls run())
  service.js       config + adapter + oauth2 + photos into _cloudcore/node's connector()
  config.js        endpoints + client id/secret (PLACEHOLDER_PCLOUD_*, filled in by the build)
                   + US/EU region hosts + _cloudcore wiring; ROOT_FOLDER = 0
  adapter.js       pCloud REST mapping: /listfolder (folderid), /getfilelink -> download,
                   /uploadfile (multipart, overwrite-by-name), /checksumfile, /userinfo,
                   create/rename/delete; region host per call; nonzero `result` -> PCLOUD_API_ERROR
  oauth2.js        pCloud's getAuthorizeUrl / exchangeCode: NO PKCE (ships a client_secret),
                   NO refresh (tokens are long-lived); region-host-aware token exchange
  photos.js        listAlbums / listPhotos                       <- PHOTO.UPLOAD
account/com.palm.pcloud.json   Synergy template: customUI validator -> the generic
                               com.palm.app.cloud-auth, DOCUMENTS + PHOTO.UPLOAD, permissions
```

File-manager locators are the numeric ids `listFolder` gives, or pCloud's typed ids (`d123`
folder, `f456` file); a bare number is looked up as both and refused when it names both
(`PCLOUD_AMBIGUOUS_ID`) or neither (`PCLOUD_NOT_FOUND`). A file move first lists the
destination and refuses an existing name (`PCLOUD_EXISTS`), since `renamefile` would replace
it. The root is `0` (also `"root"`, `""`, `"/"`, `d0`) and is never moved or deleted.
`tests/unit/pcloud.test.js` covers all of it over a stand-in bus and fetch.

## How it differs from the others (all REST/ID-based)

| | Box / OneDrive | pCloud |
|---|---|---|
| Root sentinel | `"0"` / `"root"` | `0` (numeric folderid) |
| List | `{entries}` / `{value}` | `{metadata:{contents:[…]}}`, folder vs file = `isfolder` bool |
| Item id | one `id` | `folderid` (folders) **or** `fileid` (files) |
| Download | `/content` → 302 pre-signed | `/getfilelink` → `{hosts,path}`; fetch `https://hosts[0]+path` |
| Upload | multipart / PUT raw | multipart `/uploadfile`; same-name **overwrites** (no `renameifexists`) |
| Overwrite by id | PUT to item id | no upload-by-id: `/checksumfile` → name+parent, re-upload there |
| Auth | PKCE, no secret / secret | **client_secret, NO PKCE** |
| Refresh token | rotates | **none** — tokens are long-lived until revoked |
| **Region host** | single global host | **per-account US/EU host, stored in credentials** |
| Photos | Camera Roll special folder | no album API → one folder (default root) as one album |

The service accepts a generic `path` locator (= numeric folderid/fileid; empty/0 = root) so
the file-picker and a future QuickOffice reroute call it Dropbox-uniformly.

## Configuration (required before it can run)

Register a free app in the **pCloud developer console** (<https://docs.pcloud.com/> → *My
applications*):
- Set the redirect URI to `http://localhost/pcloud/oauth2callback` **verbatim**.
- The build fills **both** the **Client ID** and **Client secret** in
  (`PCLOUD_CLIENT_ID` / `PCLOUD_CLIENT_SECRET`, meta-luneos cloud-synergy-connector.inc).
  **Both are required** — pCloud does **not** support PKCE, so the code→token exchange must
  send the secret (same as the gdrive "Desktop app" client).

HTTPS is node's own `fetch`; `CURL`/`CURL_CAINFO` in config.js are only read by the on-device
harness's reachability check.

## Status / caveats

- ✅ Service (on `_cloudcore/node`), generic `cloud-auth` app, template. Needs the Photos-aggregator `case "com.palm.pcloud"`
  (in `../../photos-integration/`) added by the integrator to route photo calls here.
- ⏳ **Account sign-in untested** — needs a real `client_id` + `client_secret`.
- ⚠️ **Region host** is resolved from the OAuth2 redirect and stored per account; if a
  particular pCloud build ever omits `hostname`/`locationid` from the redirect, the connector
  falls back to the US host (`api.pcloud.com`) — an EU account would then need the redirect
  region params to work. Verified against the current docs that both are sent.
- ⚠️ **Overwrite semantics:** a plain `uploadFile` into a folder **overwrites** a same-named
  file (pCloud keeps the old copy as a revision), matching the OneDrive PUT. `replace:true`
  (save-back by fileid) looks up the file's name+parent via `/checksumfile` and re-uploads.
- ⚠️ **Photos:** pCloud has no album API, so **one folder** (default `folderid 0` = the account
  root) is surfaced as one album; point `ALBUM_FOLDER` in `photos.js` at a specific folderid to
  narrow it. Listing is flat (not recursive), matching the Dropbox provider.

## Web-verified API details

Verified against <https://docs.pcloud.com/> (July 2026): OAuth2 `authorize`
(`my.pcloud.com/oauth2/authorize`, redirect returns `code`/`hostname`/`locationid`),
`oauth2_token` (client_id+client_secret+code → `access_token`/`userid`), the US/EU host split
(`api.pcloud.com` / `eapi.pcloud.com`), `listfolder` (`metadata.contents[]`, root `folderid 0`),
`getfilelink` (`{hosts,path}`), `uploadfile` (multipart; same-name overwrite when
`renameifexists` unset), `checksumfile` (metadata `name`+`parentfolderid`), and `userinfo`
(`email`).
