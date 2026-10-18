# OneDrive connector

A full Microsoft **OneDrive** (Microsoft Graph) **DOCUMENTS + PHOTO.UPLOAD** connector on the
shared **`_cloudcore`** runtime. Credentialed with an Azure app and **verified end-to-end against
the live Microsoft Graph API** (OAuth Auth-Code+PKCE, rotating refresh, `/me` identity, list root,
upload, download byte-identical round trip, Camera Roll special folder) — public PKCE client, **no
secret**. Only the on-device customUI sign-in is exercised solely by the framework.

Of the three cloud providers investigated, OneDrive was the **cleanest fit** — a public
PKCE client with *no secret*, personal Microsoft accounts allowed, and a file-download
endpoint that 302-redirects to a pre-signed URL our curl fetches with no auth header. It is
the purest `_cloudcore` connector: **everything but `config.js`, `adapter.js`, and the three
photo commands is the shared core**, and it uses the one generic `com.palm.app.cloud-auth` app.

## What's here

```
service/com.palm.service.onedrive/   node service on the shared _cloudcore runtime
  config.js        endpoints + Azure client id + _cloudcore wiring (SCOPE, TOKEN_SEND_SCOPE,
                   AUTH_APP_IDS/FILE_APP_IDS); ROOT_FOLDER = "root"
  adapter.js       Microsoft Graph mapping: /me/drive/{root|items/{id}}/children, /content
                   (302), PUT raw-body upload, refresh-on-401; normalises to the uniform
                   _cloudcore entry shape (+ listSpecialChildren raw, for Photos)
  commands/        photolib, listAlbums, listPhotos                <- PHOTO.UPLOAD (Camera Roll)
  sources.json     pulls ../_cloudcore/{acl,httpcurl,oauth2,creds,cloudservice}.js and the six
                   generic ../_cloudcore/commands/* (getAuthorizeUrl, exchangeCode,
                   checkCredentials, listFolder, uploadFile, downloadFile) + the local photos
account/com.palm.onedrive.json   Synergy template: customUI validator -> the generic
                                 com.palm.app.cloud-auth, DOCUMENTS + PHOTO.UPLOAD, permissions
```

Auth is the shared generic app **`../cloudcore/auth/com.palm.app.cloud-auth`** (no per-provider
OneDrive auth app). The shared `_cloudcore/oauth2.js` covers OneDrive as-is: it sends `scope`
on the code-exchange + refresh (Graph requires it) via `config.js` `TOKEN_SEND_SCOPE: true`,
and runs pure PKCE because the `CLIENT_SECRET` is left as the `PLACEHOLDER_` sentinel.

## How it differs from Box (both are REST/ID-based)

| | Box | OneDrive (Graph) |
|---|---|---|
| Item tree | `/folders/{id}/items` | `/me/drive/{root\|items/{id}}/children` (URL segments) |
| Root sentinel | `"0"` | `"root"` |
| List envelope | `{entries:[…]}` | `{value:[…]}`; folder vs file = `folder`/`file` facet |
| Download | `/content` → 302 dl.boxcloud.com | `/content` → 302 pre-signed (curl strips auth on cross-host redirect) |
| Upload | multipart to upload.box.com | **PUT raw body** to `…:/{name}:/content` |
| Photo `src_big` | `/content?access_token=` | item `@microsoft.graph.downloadUrl` (pre-signed, inline in the listing) |
| Secret | optional | **never** — MS public clients redeem the code with no secret |
| Refresh token | rotates (~60d) | rotates (90-day sliding) — persist the new one each call |

The service accepts a generic `path` locator (= item ID; `"root"`/empty = drive root) so the
file-picker and a future QuickOffice reroute call it Dropbox-uniformly.

## Configuration (required before it can run)

Register a free app in the **Azure portal → App registrations**:
- **Supported account types:** *Accounts in any org directory **and** personal Microsoft accounts* (so consumer OneDrive works).
- **Platform:** *Mobile and desktop applications*; add redirect URI `http://localhost/onedrive/oauth2callback` verbatim.
- **Authentication → Allow public client flows: Yes.**
- Copy the **Application (client) ID** into `service/com.palm.service.onedrive/config.js` (`CLIENT_ID`). **No client_secret** — leave the placeholder; `oauth2.js` runs pure PKCE.

Same modern system-curl (`/usr/bin/curl`) + current-CA prerequisites as Dropbox.

## Status / caveats

- ✅ Service (on `_cloudcore`), generic `cloud-auth` app, template, Photos-aggregator `case "com.palm.onedrive"` (in
  [`../../photos-integration/patches/Utils.js.patch`](../../photos-integration/patches/Utils.js.patch)).
- ✅ **Live-API verified** (off-device, system curl): Auth-Code+PKCE (no secret), rotating
  **refresh**, `/me` identity, drive-root list, upload, download (byte-identical round trip),
  and the Camera Roll special folder — all against a real personal OneDrive.
- ✅ **Library icons** (`icon_onedrive_{40x40,20x20}.png`, from the 2025 OneDrive cloud) +
  account icons (`onedrive-{32x32,48x48}.png`), all exact-square so they don't tile.
- ⏳ **On-device customUI sign-in** — the one path exercised only by the framework; the token
  exchange it calls is verified.
- ⚠️ **Consent screen:** an unverified hobbyist app shows a one-time "this app hasn't been
  verified" notice the user accepts. Not a blocker; publisher verification is optional.
- ⚠️ **Photos:** only the **Camera Roll** special folder is surfaced (Graph has no album
  model), and only for accounts that have one; it degrades to an empty album otherwise.
- ⏳ **QuickOffice OneDrive reroute** — could mirror the Dropbox `mxId` branch, but Graph is a
  new provider QuickOffice never knew, so it needs a new `mxId` mapping first (larger than the
  Box case). Not done.
