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

The service runs on `_cloudcore/node` (node 22, palmbus directly, fetch), as Dropbox does:
`package.json` (main `service.js`), so `run-js-service` loads it as a node module.

- **`s3sig.js`** — AWS **Signature Version 4** with node's `crypto`, two forms: the
  `Authorization`-header form for every request, and the query-string (`X-Amz-Signature`)
  **presigned-URL** form for the links handed to the Photos service. Every header the service
  passes is signed, and the host is signed as fetch sends it (a non-default port kept).
- **`adapter.js`** — the `_cloudcore/node` adapter. Folders are key **prefixes** with the `/`
  **delimiter**; `ListObjectsV2` pages until `IsTruncated=false`. Download is a signed `GET`
  streamed to the file, upload a signed `PUT` streamed from it (`UNSIGNED-PAYLOAD` over https,
  where TLS protects the body; the file's SHA-256 over plain http), createFolder a zero-byte
  `<prefix>/` marker, a move `CopyObject` and then a delete only after a real
  `<CopyObjectResult>`, a folder delete `DeleteObjects` batches. It also reads the few S3 XML
  shapes it needs (listings, `<Error>`, `CopyObjectResult`, `DeleteResult`). Path-style
  addressing (`endpoint/bucket/key`) is the default; virtual-host style via `pathStyle: false`.
- **`login.js`** — `login`, the account validator the sign-in app calls: it signs a zero-key
  `ListObjectsV2` with the keys before Accounts stores them. The endpoint is `host[:port]`, or
  `http(s)://host[:port]`; `scheme: "http"` is stored only for an `http://` one.
- **`photos.js`** — `listAlbums`/`listPhotos`: one prefix (`Camera Uploads/`) is one album.
- **`com.palm.app.s3-auth`** — a customUI form (endpoint / region / bucket / access key / secret /
  path-style toggle) that calls `login`.

The access key id is stored as `credentials.common.accessToken` (with the secret and
endpoint/region/bucket alongside), so the generic `_cloudcore/node` commands (checkCredentials,
listFolder, downloadFile, uploadFile, createFolder, moveItem, deleteItem, upload, deletePhoto)
work unchanged. getAuthorizeUrl and exchangeCode answer NOT_SUPPORTED: there is no OAuth.

## Status

- `tests/unit/s3.test.js` runs the service on a stand-in bus and bucket: the exact requests of
  every method, every signature checked independently (and AWS's published SigV4 examples),
  and every request of every method failing in five ways, each still one error reply.
- `S3_IT=1 node --test tests/unit/s3-garage.test.js` runs it against a real S3-compatible server
  (Garage at `http://127.0.0.1:3900` by default): login, list, upload, download, replace,
  moves, a presigned link, deletes, under a fresh prefix that is removed again.

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
