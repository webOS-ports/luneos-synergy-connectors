# Flickr connector

A **photo-only** webOS Synergy connector: OAuth 1.0a sign-in and a Photos-app cloud
source that browses your Flickr albums and pulls the images into the stock Photos app.
Flickr is a **PHOTO source only** — there is no documents/files role, no QuickOffice, and
no files app.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.flickr/` | The node service: OAuth 1.0a signer, Flickr REST client, all HTTPS via the modern curl. Hosts every command below. |
| `apps/com.palm.app.flickr-auth/` | customUI OAuth webview the account template launches. Drives the Atlas login and hands the `oauth_verifier` back to the service. |
| `account/com.palm.flickr/` | Synergy account template — **PHOTO.UPLOAD capability only** (base + `en` locale override). |

## Service commands (`services.json`)

| Method | Caller | Purpose |
|---|---|---|
| `getAuthorizeUrl` | auth app | OAuth 1.0a **leg 1** — fetch a request token, return the consent URL + `requestToken`/`requestTokenSecret` (carried across the login, see below). |
| `exchangeCode` | account validator | OAuth 1.0a **leg 3** — redeem `oauth_verifier` + request token/secret → long-lived access token; return `credentials.common` + `username`. |
| `checkCredentials` | accounts | `onCredentialsChanged` validator (`flickr.test.login`). |
| `listAlbums` / `listPhotos` | **Photos aggregator** | Photo-provider contract — see [`../../photos-integration`](../../photos-integration). |
| `downloadFile` | photos app | Fetch a static photo URL to a local path (the aggregator normally downloads itself; this is for completeness). |

## OAuth 1.0a — why, and how it's split between node and curl

Flickr never adopted OAuth2; its only modern auth is **OAuth 1.0a (3-legged, HMAC-SHA1)**.
Unlike the Dropbox public-client/PKCE model, Flickr requires a real **consumer secret** — it
is one half of the HMAC signing key, so it must ship in `config.js` (`CONSUMER_SECRET`).

The critical device constraint is the **TLS wall**: the device node runtime is OpenSSL
0.9.8k and cannot open a modern TLS socket, so *all HTTPS* is shelled out to the modern
system curl (`/usr/bin/curl`, `--cacert /etc/ssl/certs/ca-certificates.crt` — installed by
the companion OpenSSL-11 update, the same prerequisite every connector relies on).

**But the OAuth 1.0a signature is computed IN node, not over TLS.** HMAC-SHA1 is an old
algorithm the 0.9.8k runtime supports via `crypto.createHmac('sha1', key)`. So the split is:

```
oauth1.js (node)                          httpcurl.js -> curl (modern TLS)
  build signature base string      ─┐
  HMAC-SHA1 with consumer&token   ─┤ produce a fully-signed request URL ─► GET over TLS
  append oauth_signature to query  ─┘
```

`oauth1.js` implements RFC 3986 percent-encoding, the base-string construction
(`METHOD & enc(url) & enc(sorted params)`), and the HMAC — see its comments. This is the
one piece of fresh, hand-written crypto in the connector; it is self-tested against the
canonical OAuth Core 1.0a Appendix A.5 vector (`node --check` plus a signature check
during bring-up).

### The 3-legged flow

```
Settings → Add Flickr ──customUI──> com.palm.app.flickr-auth
  getAuthorizeUrl ──curl──> request_token (signed)  ─► {url, requestToken, requestTokenSecret}
  launch Atlas (simple mode) ──> Flickr login in WPE (modern TLS), user approves
  Atlas captures ?oauth_token=&oauth_verifier= ──> systemservice pref ──> auth app polls it
  exchangeCode {oauth_verifier, requestToken, requestTokenSecret} ──curl──> access_token (signed)
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
so the aggregator's curl fetches these with **no auth header** (private photos included).
`fileName` is `<id>.<ext>` (Flickr photos have no real filename).

## Configuration

`service/com.palm.service.flickr/config.js`:

- `CONSUMER_KEY` / `CONSUMER_SECRET` — **required.** Create an app at
  <https://www.flickr.com/services/apps/create/> to get an API key + secret. `CONSUMER_KEY`
  is also the REST `api_key`; `CONSUMER_SECRET` signs every request (OAuth 1.0a). Both are
  placeholders in `config.js` and must be filled in.
- `CALLBACK_URL` = `http://localhost/flickr/oauth1callback` — configure the Flickr app's
  callback URL to this (Atlas intercepts navigation to it to capture `oauth_verifier`).
- `CURL` = `/usr/bin/curl` (the modern system curl from the OpenSSL-11 update; no
  `CURL_LD_LIBRARY_PATH` needed).
- `CURL_CAINFO` = `/etc/ssl/certs/ca-certificates.crt` (the current system CA store).

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
#  service -> /usr/palm/services/com.palm.service.flickr/
#  auth app -> /media/cryptofs/apps/usr/palm/applications/com.palm.app.flickr-auth/
#  template -> /usr/palm/public/accounts/com.palm.flickr/  (base + resources/*)
```

After a **template content** change, restart the accounts service then LunaSysMgr. After an
**auth-app JS** change, restart LunaSysMgr. Service `.js` reloads per-call.

> Placeholder brand icons are checked in (`account/.../images/*.png`, `apps/.../icon.png`) so
> packaging resolves; swap for real Flickr artwork before shipping.
>
> All `.js`/`.json` here pass `node --check` / JSON parse.
