# SmugMug connector

A **photo-only** Synergy connector: OAuth 1.0a sign-in and a Photos source that lists your
SmugMug albums (galleries) and pulls their images into the Photos app. There is no
documents/files role and no upload: the token is read-only.

It is cloud/flickr's design with SmugMug's API v2 behind it: the same OAuth 1.0a signer, the
same Atlas sign-in flow, the same Photos contract.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.smugmug/` | The node service on `_cloudcore/node` (node 22): `service.js` (the methods), `oauth1.js` (OAuth 1.0a signer and token legs, Flickr's), `adapter.js` (API v2 calls, paging, credentials), `photos.js` (listAlbums/listPhotos), `config.js`. |
| `apps/com.palm.app.smugmug-auth/` | customUI sign-in app the account template launches. Drives the Atlas login and hands the `oauth_verifier` back to the service. |
| `account/com.palm.smugmug/` | Synergy account template — **PHOTO.UPLOAD capability only**. The icons are plain placeholders. |
| `files/sysbus/` | The service's LS2 files. |

## Service methods (`service.js`)

| Method | Caller | Purpose |
|---|---|---|
| `getAuthorizeUrl` | auth app | OAuth 1.0a **leg 1** (`getRequestToken`): the consent URL (`Access=Full&Permissions=Read`) and the request token + secret to carry across the login. |
| `exchangeCode` | account validator | **Leg 3** (`getAccessToken`), then `!authuser`: SmugMug's token reply names no user, and the albums are listed under the user's NickName. Returns `credentials.common` = `{ oauthToken, oauthTokenSecret, userId (NickName), username, fullname }`. |
| `checkCredentials` | accounts | `!authuser` with the stored token. Tokens do not expire; a failure means access was revoked. |
| `listAlbums` / `listPhotos` | Photos service | `user/<NickName>!albums`, `album/<AlbumKey>!images` (paged, at most 5000 items). |
| `downloadFile` | Photos app | Fetches a photo URL to a local path, unsigned. |

## Photos

Every SmugMug image is in exactly one album, so `listAlbums` gives the user's albums and
nothing synthetic. `listPhotos` gives each image with `src_big` = its original (`ArchivedUri`),
else the largest size SmugMug renders (`LargestImage`, expanded in the same request), and
`src_small` = its thumbnail. These `photos.smugmug.com` URLs need no token — the key in their
path is the capability, also for a private site — so the Photos service downloads them itself,
as it does Flickr's. Checked against a real account with a private site: each original came
back byte for byte (its `ArchivedMD5`). Videos and images SmugMug is still processing are left
out.

## Errors and secrets

SmugMug echoes the request in every reply's `Response.Uri` — the whole signed query, the
token included — and an OAuth failure's `Message` is `oauth_problem=…&debug_sbs=<signature
base string>`, which holds the token too. So no reply body reaches an `errorText` or the log:
an error carries SmugMug's `Message` only, an OAuth one only its `oauth_problem`, and the sign-in
app logs how the sign-in ended, not its result.

## Configuration

`config.js` carries `PLACEHOLDER_SMUGMUG_CLIENT_ID` / `PLACEHOLDER_SMUGMUG_CLIENT_SECRET`,
filled in at build time by meta-luneos `cloud-synergy-connector.inc` from the builder's
`SMUGMUG_CLIENT_ID` / `SMUGMUG_CLIENT_SECRET` (an API key from
<https://api.smugmug.com/api/developer/apply>). The key's callback is
`http://localhost/smugmug/oauth1callback` (`CALLBACK_URL`); SmugMug redirects there with
`oauth_token` and `oauth_verifier`, and Atlas captures it.

## Tests

`tests/unit/smugmug.test.js`: every method over a stand-in bus and fetch, with SmugMug's reply
shapes as a real account gave them; the signature checked independently; every request failing
in turn.
