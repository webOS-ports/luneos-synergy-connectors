# MEGA (mega.nz) connector

A Synergy connector for **[MEGA](https://mega.nz)**: a MEGA account as a **DOCUMENTS** provider
(browse, download, upload, manage) and a **PHOTO.UPLOAD** provider (folders with images as
albums in the stock Photos app, plus device-to-cloud upload). It runs on `_cloudcore/node`
(node 22), laid out like the Dropbox connector.

## Why MEGA is different from every other connector

1. **No OAuth.** Sign-in is the account **email + password**. There is no consent webview and no
   `?code=`: the connector ships its own auth app (`com.palm.app.mega-auth`, a two-field form)
   instead of the shared `com.palm.app.cloud-auth`, and a `login` method instead of
   `getAuthorizeUrl`/`exchangeCode` (which answer `NOT_SUPPORTED`).

2. **Zero-knowledge end-to-end encryption.** MEGA stores every name and file byte encrypted on
   the client. To list a folder the connector downloads the encrypted node tree and decrypts each
   name; to download it fetches ciphertext, decrypts it and checks its MAC; to upload it encrypts
   and MACs the file first. All of that is in `megacrypto.js` and `megaapi.js`.

The transport is one JSON command endpoint (`https://g.api.mega.co.nz/cs`), POSTed to through
the core's `http.js` (node's fetch); the file bytes go to and from the URLs it hands out.

## Components

| Path | What it is |
|---|---|
| `service/com.palm.service.mega/` | The node service (see below). |
| `apps/com.palm.app.mega-auth/` | customUI email + password sign-in form; reveals a 2FA code field on `MEGA_MFA_REQUIRED`. |
| `account/com.palm.mega.json` | Synergy template (DOCUMENTS + PHOTO.UPLOAD) and its icons. |
| `files/sysbus/` | Its LS2 role, permissions and service file. |

The service directory:

| File | What it is |
|---|---|
| `package.json` | `main: service.js`: `run-js-service` requires the directory and calls `run()`. |
| `service.js` | Wires `config.js`, `adapter.js`, `login.js` and `photos.js` into `_cloudcore/node`'s `connector()`. |
| `config.js` | The endpoint and the caller allow-lists. |
| `adapter.js` | The generic methods' adapter: tree, list, download, upload, folders, move, rename, delete. |
| `megaapi.js` | The cs requests (ids, EAGAIN retries, the 402 proof of work), the `us0`/`us` login, the decrypted tree. |
| `megacrypto.js` | AES-ECB/CBC/CTR, the file MAC, v1/v2 password keys, RSA session id, attributes. |
| `hashcash.js` | The X-Hashcash proof of work. |
| `login.js` | The `login` method (the account validator). |
| `photos.js` | `listAlbums` / `listPhotos` for the Photos service. |

## Crypto: node's own

Everything is node's `crypto` (OpenSSL) and `BigInt`; nothing is hand-rolled any more:

| Piece | How |
|---|---|
| Key wrapping, attributes | `aes-128-ecb`, `aes-128-cbc` (zero IV), no padding |
| File bytes | `aes-128-ctr`, streamed, IV = nonce + 64-bit counter |
| File MAC | `aes-128-cbc` per chunk, folded with ECB; checked on download |
| v1 password key | `prepare_key` with reused `aes-128-ecb` ciphers (65536 rounds) |
| v2 password key | `crypto.pbkdf2` (PBKDF2-HMAC-SHA512, 100 000 rounds), on the thread pool |
| Session id | `BigInt` modular exponentiation with the CRT (MEGA's raw RSA, no padding) |
| Hashcash | `crypto.subtle.digest("SHA-256")` on the thread pool, 90 s at most |

`tests/unit/mega-crypto.test.js` checks each against values made with megajs 1.3.10's own
functions (`tests/unit/lib/mega-vectors.js`) and against node's OpenSSL directly;
`tests/unit/mega.test.js` runs every method over a stand-in bus against a stand-in MEGA.

The credentials Accounts stores are `{ accessToken: <session id>, mk: <master key>, email, u,
name }`: the session id is the core's `accessToken`, so `readCredentials` and
`checkCredentials` need nothing MEGA-specific. The password is used only to derive the keys;
it is never stored or sent.

**QuickOffice needs nothing MEGA-specific either.** The reroute is account-derived: `FileStore`
routes any account whose `DOCUMENTS` capability is implemented by a `palm://com.palm.service.*`
URI through the generic `"modern"` path, keyed on the account `_id`.

## Deployment

1. Deploy `service/com.palm.service.mega/` to `/usr/palm/services/com.palm.service.mega/`
   (with `_cloudcore/node/` next to it, from synergy-cloudcore).
2. Deploy `apps/com.palm.app.mega-auth/` to `/usr/palm/applications/com.palm.app.mega-auth/`.
3. Deploy `account/com.palm.mega.json` (+ `images/`) into the accounts templates.
4. **Settings -> Accounts -> MEGA**, enter the MEGA email + password.

### On-device test checklist

- [ ] Account creates (v1 and v2 accounts; one with 2FA) and survives a reboot.
- [ ] Documents / Topaz Explorer browse the Cloud Drive; open a document (download + decrypt + MAC).
- [ ] Save-back / upload a file larger than 128 KiB (several chunks); it opens in the MEGA web client.
- [ ] Create, rename, move and delete (to the Rubbish Bin) from Topaz Explorer.
- [ ] Folders with images show as albums in Photos; images sync down decrypted.
- [ ] Upload a photo device -> cloud (into "Camera Uploads").

## Known caveats

- **Photos download eagerly.** MEGA's `g` URL serves ciphertext, so `listPhotos` downloads and
  decrypts each image to `/media/internal/.mega-photos` and hands the Photos service a
  `file://` path. A copy already there with the right size is reused.
- **Downloads go through a ciphertext file** (`<dest>.mzenc`) before they are decrypted into
  place: the core's `http.js` streams a reply to a file as it is, with no transform.
- **No writing into shared folders.** Nodes under a folder shared with others would need a `cr`
  share-key set so the sharees can decrypt them; such targets answer `MEGA_SHARE_UNSUPPORTED`.
  Folders shared *to* this account (RSA-wrapped keys) are not opened.
- **Save-back makes a second file** of the same name next to the old one: MEGA has no overwrite
  in place, and versioning (`ov`) is not used.
- **Placeholder icons.** `account/images/*` and the auth-app icon are generated red "M" squares.
