# Generic S3-compatible storage connector

A Synergy connector for **any S3-compatible object store** — AWS S3, **IDrive e2**, **Backblaze B2**
(S3 API), **Wasabi**, **MinIO**, Storj, etc. — as a **DOCUMENTS** provider (file browse / upload /
download for the file-picker + QuickOffice reroute) and a **PHOTO.UPLOAD** provider.

## Why it's provider-agnostic

The S3 REST API is a de-facto standard, so one connector covers a whole tier of cheap,
developer-centric storage. There is **no OAuth and nothing to register centrally**: the account
owner enters their own **endpoint, region, bucket, access key id and secret access key** in the
`s3-auth` form, and the connector signs every request with them. The same package ships to every
device (same ethos as the PKCE connectors), but the credential model is the account owner's own
keys — like the Mega connector, not the OAuth ones.

## How it works

- **`s3sig.js`** — AWS **Signature Version 4** request signing (HMAC-SHA256 chain + SHA-256 payload
  hash), two forms: the `Authorization`-header form for list/get/put/delete, and the query-string
  (`X-Amz-Signature`) **presigned-URL** form for handing the Photos aggregator a self-authenticating
  GET URL. All hashing uses **native node `crypto`** (SHA-256/HMAC-SHA256 exist on the device's
  OpenSSL-0.9.8k node, same as the OAuth connectors' PKCE S256 challenge), so signing is fast and
  dependency-free.
- **`s3xml.js`** — a tiny reader for the two S3 XML shapes we need (`ListObjectsV2` results +
  `<Error>`); S3's XML is flat, so no general parser is required.
- **`adapter.js`** — the uniform `_cloudcore` adapter. Folders are emulated with key **prefixes**
  and the `/` **delimiter**; `ListObjectsV2` pages until `IsTruncated=false`. Download is a signed
  `GET`, upload a signed `PUT` (`UNSIGNED-PAYLOAD` so the file streams without a full hash), delete
  a signed `DELETE`. Path-style addressing (`endpoint/bucket/key`) is the default (needed for most
  non-AWS endpoints); virtual-host style is available via the `pathStyle` flag.
- **`com.palm.app.s3-auth`** — a customUI form (endpoint / region / bucket / access key / secret /
  path-style toggle) that calls `login`, which validates the keys with a signed `ListObjectsV2`
  before the account is stored.

The **session/access model reuses all the generic `_cloudcore` commands**: the access key id is
stored as `credentials.common.accessToken` (with the secret + endpoint/region/bucket alongside), so
`AccountCreds` and the generic `checkCredentials`/`listFolder`/`upload`/`download`/photo commands
work unchanged. QuickOffice needs nothing S3-specific — the reroute is account-derived.

## Status

🟢 **Code-complete; signing + wiring validated off-device.** On-device account creation still to be
exercised.

- The SigV4 signer is checked against **AWS's official published test vectors** — the canonical
  GET Object, PUT Object and presigned-GET examples (signatures + canonical-request hash) all match.
- The XML parser is unit-tested (entity decoding, sizes, timestamps, common-prefixes, truncation,
  error bodies).
- A **full mock-server integration run** drives the real adapter: credential validation, **paged**
  folder listing (folder + files, placeholder-object skipped), download, upload (body captured),
  delete, presigned photo URL, and confirms every request is SigV4-signed with the right key — 12/12.

## On-device test checklist

- [ ] Add an account (Settings → Accounts → S3 Storage) against a real bucket (e.g. an IDrive e2 or
      Backblaze B2 bucket); it validates and persists.
- [ ] File-picker / QuickOffice browses the bucket; open a document (signed GET download).
- [ ] Upload / save-back a file (signed PUT); confirm it appears in the bucket.
- [ ] A "Camera Uploads/" prefix shows as an album in Photos; images sync down via presigned URLs.
- [ ] Upload a photo device→cloud; confirm the object lands under the prefix.

## Known caveats / follow-ups

- **Endpoint presets** (`config.js` `PROVIDER_PRESETS`) are informational; the form takes a free-form
  endpoint host. Region must match the endpoint for providers that are region-specific (Backblaze
  B2, IDrive e2).
- **Placeholder icons** (orange "bucket"); swap in real branding if desired.
- **No multipart upload** — a file is a single signed `PUT`. Fine for documents/photos; very large
  objects (multi-GiB) would want multipart, a future add.
- **Delete is unconditional** (`DELETE` returns 204 even if the key was absent), matching S3.
- **B2 note:** Backblaze's native B2 API differs, but its **S3-compatible** endpoint works here; use
  the S3 endpoint/region and an S3-compatible application key.
