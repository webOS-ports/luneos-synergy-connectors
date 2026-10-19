# Google Drive connector (DOCUMENTS-only)

A **Google Drive** (Drive API v3) DOCUMENTS connector, built to the same architecture as
Dropbox/Box/OneDrive. **DOCUMENTS-only** — Google Photos isn't reachable headlessly, so there
is no PHOTO.UPLOAD provider (see [`../../recon/google-drive.md`](../../recon/google-drive.md)).

> ⚠️ **This is a personal / ≤100-user, unverified build by necessity.** Browsing arbitrary
> Drive folders needs the *restricted* `drive` scope; an unverified app shows a "this app hasn't
> been verified" screen and is capped at 100 users for life. A publicly shippable version would
> need Google's CASA/app-verification. Fine for a personal TouchPad; do not redistribute.

## What's here

```
service/com.palm.service.gdrive/    node service on _cloudcore/node (as Dropbox, see ../dropbox/README.md)
  package.json     main: service.js; run-js-service require()s the directory and calls run()
  service.js       config.js + adapter.js into _cloudcore/node's connector(); upload/deletePhoto
                   answer NOT_SUPPORTED (DOCUMENTS only, as the old services.json had none)
  config.js        endpoints, scope, caller allow-lists; the build fills PLACEHOLDER_GDRIVE_* in
  adapter.js       Drive v3: query-based listing (files?q='id' in parents, every page), export of
                   Google-native docs, /about identity, two-step upload, trash, moves by parents
account/com.palm.gdrive.json   Synergy template: customUI validator, DOCUMENTS only
```

OAuth (PKCE plus the Desktop client's secret, `access_type=offline&prompt=consent`), the
refresh on a 401, the token store and the generic luna methods are `_cloudcore/node`'s.

## How it differs from the others (Drive is a query store, not a folder tree)

| | Box / OneDrive | Google Drive |
|---|---|---|
| Listing | children of an item id | **query**: `files?q='{parentId}' in parents and trashed=false` |
| Root | `"0"` / `"root"` | `"root"` alias |
| Folder marker | `folder` facet | `mimeType == application/vnd.google-apps.folder` |
| Download | `/content` (302 pre-signed) | `/files/{id}?alt=media`; **native docs must `export`** to docx/xlsx/pptx/pdf |
| Upload | single PUT | **two steps**: POST bytes → PATCH name + reparent |
| Secret | none / optional | **required** (Desktop client; Google treats it as non-confidential) |
| Refresh token | rotates | does **not** rotate (response usually omits it) |

The service accepts a generic `path` locator (= file/folder ID; `"root"`/empty = My Drive) so
the file-picker calls it Dropbox-uniformly. List entries add `mimeType` + a `googleDoc` flag; the
files app maps a Google-native doc to an export format and appends the extension on save.

## Configuration (required before it can run)

1. **Google Cloud Console** → *OAuth consent screen*: **External**, and set it to **In
   production** (not "Testing", or refresh tokens die every 7 days). Add the `.../auth/drive`
   scope.
2. *Credentials* → *Create OAuth client ID* → **Desktop app**. Add redirect URI
   `http://localhost/gdrive/oauth2callback`.
3. Paste **both** `CLIENT_ID` and `CLIENT_SECRET` into `service/com.palm.service.gdrive/config.js`.

The service speaks HTTPS through node's own fetch; `CURL*` in config.js is only for the
on-device harness's reachability check.

## Status / caveats

- ✅ Service, both apps, template. All JS/JSON validated.
- ⏳ **Account sign-in untested** — needs the Google client_id + secret above.
- ⚠️ **Unverified-app screen** + **100-user cap** (restricted scope). Personal use only.
- ✅ Large folders are listed in full (`nextPageToken`, 1000 per page).
- ⚠️ A failed second upload step (the rename/move PATCH) leaves an "Untitled" file in My Drive, as before.
- ⚠️ For a lower-risk **read-only** build, switch `SCOPE` to `.../auth/drive.readonly` (browse +
  download work; upload is rejected by Google).
