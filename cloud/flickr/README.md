# Flickr connector

A **photo-only** webOS Synergy connector: OAuth 1.0a sign-in and a Photos-app cloud
source that browses your Flickr albums and pulls the images into the stock Photos app.
Flickr is a **PHOTO source only** — there is no documents/files role, no QuickOffice, and
no files app.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.flickr/` | The node service on `_cloudcore/node` (node 22): `service.js` (the methods), `oauth1.js` (OAuth 1.0a signer and token legs), `adapter.js` (Flickr REST, credentials), `photos.js` (listAlbums/listPhotos), `config.js`. |
| `apps/com.palm.app.flickr-auth/` | customUI OAuth webview the account template launches. Drives the Atlas login and hands the `oauth_verifier` back to the service. |
| `account/com.palm.flickr/` | Synergy account template — **PHOTO.UPLOAD capability only** (base + `en` locale override). |

## Service methods (`service.js`)

| Method | Caller | Purpose |
|---|---|---|
| `getAuthorizeUrl` | auth app | OAuth 1.0a **leg 1** — fetch a request token, return the consent URL + `requestToken`/`requestTokenSecret` (carried across the login, see below). |
| `exchangeCode` | account validator | OAuth 1.0a **leg 3** — redeem `oauth_verifier` + request token/secret → long-lived access token; return `credentials.common` + `username`. |
| `checkCredentials` | accounts | `onCredentialsChanged` validator (`flickr.test.login`). |
| `listAlbums` / `listPhotos` | **Photos aggregator** | Photo-provider contract — see [`../../photos-integration`](../../photos-integration). |
| `downloadFile` | `com.palm.app.photos` | Fetch a static http(s) photo URL `{ url, localPath }` to a local path (the aggregator normally downloads itself; this is for completeness). |

## OAuth 1.0a

Flickr never adopted OAuth2; its only modern auth is **OAuth 1.0a (3-legged, HMAC-SHA1)**.
Unlike the Dropbox public-client/PKCE model, Flickr requires a real **consumer secret** — it
is one half of the HMAC signing key, so it must ship in `config.js` (`CONSUMER_SECRET`).

`oauth1.js` signs every request with node's `crypto`: RFC 3986 percent-encoding, the base
string (`METHOD & enc(url) & enc(sorted params)`) and the HMAC — see its comments. Requests
are signed GETs with the `oauth_*` parameters in the query, sent with node's `fetch`
(`_cloudcore/node/http.js`). `tests/unit/flickr.test.js` checks the signer against the
OAuth Core 1.0a Appendix A.5 signature and the RFC 5849 3.4.1.1 base string.

### The 3-legged flow

```
Settings → Add Flickr ──customUI──> com.palm.app.flickr-auth
  getAuthorizeUrl ──────> request_token (signed)  ─► {url, requestToken, requestTokenSecret}
  launch Atlas (simple mode) ──> Flickr login in WPE (modern TLS), user approves
  Atlas captures ?oauth_token=&oauth_verifier= ──> systemservice pref ──> auth app polls it
  exchangeCode {oauth_verifier, requestToken, requestTokenSecret} ──> access_token (signed)
      └─> {oauthToken, oauthTokenSecret, userId, username} stored as credentials.common
```

Correctness points (mirroring the Dropbox bring-up lessons):

- **The request token secret is stateless across the login.** The service is idle-killed
  during the (long) web login, so `getAuthorizeUrl` returns `requestToken` +
  `requestTokenSecret`, the app carries them, and `exchangeCode` receives them back — the
  OAuth 1.0a analogue of the Dropbox PKCE verifier.
- **Capture `oauth_verifier`, not `code`.** The auth app polls the systemservice pref until
  the captured redirect contains `oauth_verifier=` (OAuth 1.0a), then closes Atlas.
- **The auth app must be in the template's `read`+`writePermissions`** (`createAccount` runs
  under the auth app's appId).
- **`exchangeCode` must return a `username`** — Flickr's access-token reply carries
  `username`/`fullname` inline, so no extra API call is needed.
- **Flickr tokens do not expire or rotate** — there is no refresh path; a `checkCredentials`
  failure means the user revoked access.

## Photo provider (albums)

Flickr has real albums, so unlike Dropbox/OneDrive (one synthetic folder) `listAlbums`
returns **every photoset** (`flickr.photosets.getList`) **plus** one synthetic
**"All Photos"** album (`aid = "__all__"`, backed by `flickr.people.getPhotos user_id=me`).
`listPhotos` returns the aggregator's photo shape:

```
listAlbums → {returnValue, albums:[{aid, name, size:{images:N}}]}
listPhotos → {returnValue, photos:[{pid, src_big, src_small, caption, type:"image", fileName}]}
```

`src_big`/`src_small` are plain `https://live.staticflickr.com/{server}/{id}_{secret}_b.jpg`
static URLs. The download URLs are inlined via `extras=url_o,url_b,url_c,...` so no
per-photo API call is made; `resolveDownloadUrl` prefers `url_o` (original) → `url_b`
(large) → `url_c` → constructs the `_b` URL. The `id_secret` pair is itself the capability,
so the aggregator fetches these with **no auth header** (private photos included).
`fileName` is `<id>.<ext>` (Flickr photos have no real filename).

## Configuration

`service/com.palm.service.flickr/config.js`:

- `CONSUMER_KEY` / `CONSUMER_SECRET` — **required.** Create an app at
  <https://www.flickr.com/services/apps/create/> to get an API key + secret. `CONSUMER_KEY`
  is also the REST `api_key`; `CONSUMER_SECRET` signs every request (OAuth 1.0a). Both are
  placeholders in `config.js` and must be filled in.
- `CALLBACK_URL` = `http://localhost/flickr/oauth1callback` — configure the Flickr app's
  callback URL to this (Atlas intercepts navigation to it to capture `oauth_verifier`).
- `CURL`, `CURL_CAINFO` — not used by the service (node's `fetch` does the HTTPS); the
  on-device harness's TLS check (`tests/suites/cloud.py`) still uses them.

## Integration (handled separately)

Making the account appear as a Photos album needs the **shared** photos-integration work
(a separate integrator owns these — this connector does **not** modify them):

1. `photos-integration/` `Utils.js` patch — add a `case "com.palm.flickr"` →
   `com.palm.service.flickr` to the aggregator's hardcoded `templateId → serviceName` switch.
2. `photos-integration/` `Sync-Manager.js` patch — the curl-based image downloader (already
   in place for Dropbox; reused unchanged — the Flickr `src_big` URLs are ordinary https).

## Deploy (device)

```sh
mount -o remount,rw /
#  service -> /usr/palm/services/com.palm.service.flickr/  (needs _cloudcore/node next to it)
#  auth app -> /media/cryptofs/apps/usr/palm/applications/com.palm.app.flickr-auth/
#  template -> /usr/palm/public/accounts/com.palm.flickr/  (base + resources/*)
```

After a **template content** change, restart the accounts service then LunaSysMgr. After an
**auth-app JS** change, restart LunaSysMgr. The service exits when idle and loads its
`.js` again on the next call (or ask it to: `luna-send -n 1 luna://com.palm.service.flickr/quit '{}'`).

> Placeholder brand icons are checked in (`account/.../images/*.png`, `apps/.../icon.png`) so
> packaging resolves; swap for real Flickr artwork before shipping.
>
> Unit tests: `node --test tests/unit/flickr.test.js`.
