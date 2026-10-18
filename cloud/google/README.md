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
service/com.palm.service.gdrive/    node service: OAuth2/PKCE(+secret) + Drive API v3
  oauth2.js        Google auth-code + PKCE; DOES ship a client_secret (Desktop clients must
                   send it); access_type=offline + prompt=consent for a refresh token
  driveapi.js      Drive v3 REST: query-based listing (files?q='id' in parents), export of
                   Google-native docs, /about identity, two-step upload, refresh-on-401
  httpcurl.js      shells all TLS to the bundled modern curl
  creds.js acl.js  credentials-by-accountId; allowedAppIds enforcement
  commands/        getAuthorizeUrl, exchangeCode, checkCredentials,
                   listFolder, downloadFile, uploadFile
apps/
  com.palm.app.gdrive-auth/    customUI OAuth login (Atlas simple-mode, stateless PKCE verifier)
  com.palm.app.gdrive-files/   Enyo file browser/uploader (folder-ID breadcrumb; native-doc export)
account/com.palm.gdrive.json   Synergy template: customUI validator, DOCUMENTS only
```

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

Same modern system-curl (`/usr/bin/curl`) + current-CA prerequisites as the other connectors.

## Status / caveats

- ✅ Service, both apps, template. All JS/JSON validated.
- ⏳ **Account sign-in untested** — needs the Google client_id + secret above.
- ⚠️ **Unverified-app screen** + **100-user cap** (restricted scope). Personal use only.
- ⚠️ **Listing caps at pageSize 1000** per folder (no pagination loop) — huge folders truncate.
- ⚠️ For a lower-risk **read-only** build, switch `SCOPE` to `.../auth/drive.readonly` (browse +
  download work; upload is rejected by Google).
