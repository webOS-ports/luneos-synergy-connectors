# MEGA (mega.nz) connector

A Synergy connector for **[MEGA](https://mega.nz)**, exposing a MEGA account on the TouchPad as
a **DOCUMENTS** provider (file browse / upload / download for the file-picker + QuickOffice
reroute) and a **PHOTO.UPLOAD** provider (a MEGA folder surfaced as an album in the stock Photos
app, plus device→cloud upload).

## Why MEGA is different from every other connector

Every other connector here (Dropbox, Box, OneDrive, Drive, pCloud, Yandex, kDrive) is the same
shape: **OAuth2/PKCE → plaintext REST → shell HTTPS out to the modern curl**, and `_cloudcore`
is byte-identical across all of them. MEGA breaks that mold in two ways, so it carries more of
its own code than the others:

1. **No OAuth.** Sign-in is the account **email + password**. There is no consent webview and no
   `?code=` — this connector goes back to the classic username/password account-validator model.
   It therefore ships its **own** auth app (`com.palm.app.mega-auth`, a two-field form) instead of
   the shared OAuth webview `com.palm.app.cloud-auth`, and a `login` command instead of
   `getAuthorizeUrl`/`exchangeCode`.

2. **Zero-knowledge end-to-end encryption.** MEGA stores every filename and file byte
   client-side-encrypted. To list a folder we download the encrypted node tree and AES-decrypt
   each name; to download a file we fetch ciphertext and AES-CTR-decrypt it; to upload we encrypt
   first and compute a chunked MAC. All of that lives in `megacrypto.js` + `megaapi.js`.

The transport itself still fits the house style: a single JSON command endpoint
(`https://g.api.mega.co.nz/cs`) that we POST to through the existing `HttpCurl` modern-curl
shim — the device OpenSSL 0.9.8k can't TLS-handshake MEGA either.

## Pure-JS crypto, no native SDK

MEGA ships an official **C++** SDK (`github.com/meganz/sdk`). We deliberately do **not** use it:
cross-compiling it for ARMv7 webOS + a native wrapper is the same class of work as the
`messaging/` calling libs and clashes with this repo's "one identical pure-JS package ships to
every device" ethos. Instead the protocol is reimplemented in ES5, the way `megajs` / `mega.py`
do it. The device `node` is OpenSSL-0.9.8k-era, which still does AES/SHA/RSA-public natively but
**lacks** `crypto.privateDecrypt` and SHA-512 PBKDF2, so the split is:

| Piece | Engine | When |
|---|---|---|
| Bulk file bytes (AES-128-CTR) | native node `crypto`, streamed from disk | every up/download |
| Key unwrap / attributes / v1 key-derivation / chunk MAC (AES-128) | pure-JS AES (`megacrypto.js`) | small data |
| RSA session-id decrypt | pure-JS bignum `modPow` (`bignum.js`, trimmed jsbn) | once per sign-in |
| v2 password key (PBKDF2-HMAC-SHA512, 100k iters) | pure-JS SHA-512 (`megacrypto.js`) | once per sign-in |

## Layout

```
mega/
  service/com.palm.service.mega/
    config.js            endpoints + generic wiring
    bignum.js            trimmed jsbn BigInteger (RSA modPow) — BSD, Tom Wu
    megacrypto.js        AES/SHA-512/PBKDF2/RSA/base64 + file CTR + meta-MAC
    megaapi.js           the /cs command queue + us0/us login handshake + node-tree fetch
    adapter.js           the uniform _cloudcore adapter (list/download/upload/photos)
    sources.json         wiring (NO oauth2.js; login replaces getAuthorizeUrl/exchangeCode)
    services.json
    commands/
      login_command.js   the email+password account validator
      photolib.js  listAlbums_command.js  listPhotos_command.js   (PHOTO.UPLOAD)
  apps/com.palm.app.mega-auth/   customUI email+password sign-in form
  account/com.palm.mega.json     Synergy template (DOCUMENTS + PHOTO.UPLOAD) + placeholder icons
```

The generic `checkCredentials` / `listFolder` / `uploadFile` / `downloadFile` / `upload` (photo)
/ `deletePhoto` commands are reused verbatim from `../_cloudcore/commands/`. That works because
the MEGA **session id is stored as `credentials.common.accessToken`** (it *is* the session
token) with the master key alongside it as `mk`, so `AccountCreds` and the generic commands need
no MEGA-specific changes.

**QuickOffice needs nothing MEGA-specific either.** The reroute (`quickoffice-integration/`) is
account-derived: `FileStore` routes *any* account whose `DOCUMENTS` capability is implemented by
a `palm://com.palm.service.*` URI through the generic `"modern"` path, keyed on the account `_id`
(`FileStore.js` → `modernServiceByAccountId`). MEGA's template already declares that capability,
so it is picked up automatically — no per-provider `mxId`, no switch case, no patch.

## Status

🟡 **Code-complete; crypto validated off-device; on-device sign-in still to be exercised.**

The whole crypto + protocol path is exercised by a local harness (dev-box node) that:

- checks the primitives (base64 MEGA-variant, AES-128-ECB/CBC/CTR, SHA-512, HMAC-SHA512,
  PBKDF2-SHA512) byte-for-byte against node's **native** `crypto`,
- checks the bignum `modPow` against native `BigInt` (incl. a 2048-bit case),
- validates `prepareKey`, attribute CBC, the chunked **meta-MAC**, and **RSA session-id decrypt**
  against independent references, and
- runs a **full end-to-end flow** — v1 *and* v2 login (the v2 case with a non-ASCII password),
  account info, folder listing, file download, file upload (verifying the wrapped key, encrypted
  name, ciphertext and meta-MAC all round-trip), and delete — against a mock MEGA server whose
  RSA account is built with a fully independent keypair.

What that does **not** prove is the on-device pieces: the real `/cs` field shapes under a live
account, the modern-curl POST/upload behaviour, and account-DB persistence. Those need a device.

## Deployment

Same prerequisites as the other connectors (see the top-level README): the modern system curl
at `/usr/bin/curl` (from the OpenSSL-11 update) and a current CA store at
`/etc/ssl/certs/ca-certificates.crt`. Then:

1. Deploy `service/com.palm.service.mega/` → `/usr/palm/services/com.palm.service.mega/`
   (alongside the existing `_cloudcore/`).
2. Deploy `apps/com.palm.app.mega-auth/` → `/usr/palm/applications/com.palm.app.mega-auth/`.
3. Deploy `account/com.palm.mega.json` (+ `images/`) into the accounts templates dir
   (`/usr/palm/public/accounts/com.palm.mega/`), matching how the other templates are installed.
4. Apply the `../../photos-integration/` patches (once, shared by all photo providers) and restart
   the accounts + photos services.
5. **Settings → Accounts → MEGA**, enter your MEGA email + password.

### On-device test checklist

- [ ] Account creates and survives a reboot (session id + master key persisted).
- [ ] File-picker / QuickOffice browses the Cloud Drive; open a document (download+decrypt).
- [ ] Save-back / upload a file (`uploadReplace` uploads a new version into the same folder).
- [ ] A "Camera Uploads" folder shows as an album in Photos; images sync down decrypted.
- [ ] Upload a photo device→cloud; confirm it opens correctly in the MEGA web client (proves the
      key wrap + meta-MAC are byte-correct against the real service).

## Known caveats / follow-ups

- **v2 sign-in latency.** PBKDF2-SHA512 at 100 000 iterations in pure JS is slow on the TouchPad
  (order of tens of seconds), one-time at sign-in. v1 (legacy) accounts use the fast AES
  `prepareKey` path. A future optimisation could move PBKDF2 to a small native helper.
- **Photos download eagerly.** Because MEGA's `g` URL serves ciphertext, `listPhotos` must
  download+decrypt each image to a local temp file (`/media/internal/.mega-photos`) and hand the
  aggregator a `file://` path — the aggregator's curl can't decrypt. So the crypto+network cost
  is paid at list time, and it assumes the bundled curl was built with `file://` support.
- **No shared-folder / contact keys.** Only the owner's own Cloud Drive tree is handled (node
  keys unwrapped with the master key). Inbound shares (share keys) are out of scope for now.
- **Placeholder icons.** `account/images/*` and the auth-app icon are generated red "M" squares;
  swap in real MEGA branding.
- **2FA** is wired end-to-end (the form reveals a code field on `MEGA_MFA_REQUIRED` and retries
  with `mfa`), but untested against a real 2FA-enabled account.
- **Download integrity (meta-MAC) is not verified** on download (decryption yields the bytes
  regardless); it is only *computed* on upload, where it must be correct. Verifying on download
  is a cheap future add.
```
