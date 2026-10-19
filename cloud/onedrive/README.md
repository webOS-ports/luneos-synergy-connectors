# OneDrive connector

A full Microsoft **OneDrive** (Microsoft Graph) **DOCUMENTS + PHOTO.UPLOAD** connector on the
shared **`_cloudcore`** runtime. Credentialed with an Azure app and **verified end-to-end against
the live Microsoft Graph API** (OAuth Auth-Code+PKCE, rotating refresh, `/me` identity, list root,
upload, download byte-identical round trip, Camera Roll special folder) — public PKCE client, **no
secret**. Only the on-device customUI sign-in is exercised solely by the framework.

Of the three cloud providers investigated, OneDrive was the **cleanest fit** — a public
PKCE client with *no secret*, personal Microsoft accounts allowed, and a file-download
endpoint that 302-redirects to a pre-signed URL fetched with no auth header. It is the
purest `_cloudcore` connector: **everything but `config.js`, `adapter.js` and `photos.js` is
the shared core**, and it uses the one generic `com.palm.app.cloud-auth` app.

## What's here

```
service/com.palm.service.onedrive/   node service on _cloudcore/node (as Dropbox, see ../dropbox/README.md)
  package.json     main: service.js; run-js-service require()s the directory and calls run()
  service.js       config.js + adapter.js + photos.js into _cloudcore/node's connector()
  config.js        endpoints, scope, caller allow-lists; the build fills PLACEHOLDER_ONEDRIVE_* in;
                   TOKEN_SEND_SCOPE (Graph wants scope on the token calls); ROOT_FOLDER = "root"
  adapter.js       Microsoft Graph: /me/drive/{root|items/{id}}/children (every page), /content
                   (302, followed), PUT raw-body upload, conflictBehavior fail, moves by
                   parentReference (the root's real id), DELETE to the recycle bin
  photos.js        listAlbums / listPhotos: the Camera Roll special folder as one album
account/com.palm.onedrive.json   Synergy template: customUI validator -> the generic
                                 com.palm.app.cloud-auth, DOCUMENTS + PHOTO.UPLOAD, permissions
```

Auth is the shared generic app `com.palm.app.cloud-auth`. `_cloudcore/node/oauth.js` sends
`scope` on the code exchange and refresh (`TOKEN_SEND_SCOPE: true`) and runs pure PKCE because
`CLIENT_SECRET` stays the `PLACEHOLDER_` sentinel. Microsoft rotates the refresh token; the
renewed one is saved to the account on every refresh.

## How it differs from Box (both are REST/ID-based)

| | Box | OneDrive (Graph) |
|---|---|---|
| Item tree | `/folders/{id}/items` | `/me/drive/{root\|items/{id}}/children` (URL segments) |
| Root sentinel | `"0"` | `"root"` |
| List envelope | `{entries:[…]}` | `{value:[…]}`; folder vs file = `folder`/`file` facet |
| Download | `/content` → 302 dl.boxcloud.com | `/content` → 302 pre-signed (fetch drops the Authorization header on the cross-origin redirect) |
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
- The build fills the **Application (client) ID** in for `PLACEHOLDER_ONEDRIVE_CLIENT_ID`. **No client_secret** — leave the placeholder; `_cloudcore/node/oauth.js` runs pure PKCE.

The service speaks HTTPS through node's own fetch; `CURL*` in config.js is only for the
on-device harness's reachability check.

## Status / caveats

- ✅ Service (on `_cloudcore`), generic `cloud-auth` app, template, Photos-aggregator `case "com.palm.onedrive"` (in
  [`../../photos-integration/patches/Utils.js.patch`](../../photos-integration/patches/Utils.js.patch)).
- ✅ **Live-API verified** (off-device, system curl): Auth-Code+PKCE (no secret), rotating
  **refresh**, `/me` identity, drive-root list, upload, download (byte-identical round trip),
  and the Camera Roll special folder — all against a real personal OneDrive, with the
  mojoservice version. The `_cloudcore/node` port is checked by `tests/unit/onedrive.test.js`
  only; it has not yet been run against the live API or on a device.
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
