# Koofr connector

A Synergy connector for **Koofr** as a **DOCUMENTS** provider (file browse / upload / download for
the file-picker + QuickOffice reroute) and a **PHOTO.UPLOAD** provider.

## Shape

Koofr's pragmatic auth is **HTTP Basic with an app password**, not OAuth — Koofr *has* OAuth2, but
third-party client registration is support-gated, whereas app passwords are self-service (and are
what rclone's Koofr backend uses). So, like the Mega/S3 connectors, Koofr has its **own** credentials
form (`com.palm.app.koofr-auth`) and a `login` command; there is nothing to register centrally.

- **Auth:** the user generates an app password at
  `app.koofr.net → Preferences → Password → App passwords`, and signs in with email + that password.
  Every request sends `Authorization: Basic <base64(email:app-password)>` (+ `X-Koofr-Version: 2.1`).
  App passwords don't expire, so there is no token refresh.
- **API:** `https://app.koofr.net/api/v2` for metadata, `…/content/api/v2` (same host, different
  path prefix) for file bytes.
- **Mount + path model:** files live under a **mount**; the connector resolves the user's **primary**
  personal mount (`GET /mounts` → `isPrimary`) at login and stores its id in the credentials. A
  locator is an absolute path within that mount (the root sentinel `/` is the mount root). `GET
  /mounts/{id}/files/list` lists (basenames — the adapter composes full paths), the content host's
  `files/get`/`files/put` (multipart `file` field) download/upload, `files/folder` makes a folder,
  `files/remove` deletes, and `files/download` yields a ready-to-GET link for the Photos aggregator.

The credential/access model reuses all the generic `_cloudcore` commands: the app password is stored
as `credentials.common.accessToken` (with the email + resolved mount id), so `AccountCreds` and the
generic `checkCredentials`/`listFolder`/`upload`/`download`/photo commands work unchanged.

## Status

🟡 **Code-complete; wiring validated off-device.** On-device account creation still to be exercised.

All files syntax-check, and a **mock-server integration run** drives the real adapter through
identity, **primary-mount resolution**, folder listing (with full-path composition), subfolder
listing, download, multipart upload, the files/download temp link, delete, and confirms the HTTP
Basic header is exactly `base64(email:app-password)` — 13/13.

## On-device test checklist

- [ ] Add an account (Settings → Accounts → Koofr) with an email + app password; it validates and
      persists, and the primary mount is found.
- [ ] File-picker / QuickOffice browses Koofr; open a document (download).
- [ ] Upload / save-back a file (multipart PUT with `overwrite=true`).
- [ ] A "Camera Uploads" folder shows as an album in Photos; images sync down via the download links.
- [ ] Upload a photo device→cloud; confirm it lands in the folder.

## Known caveats / follow-ups

- **App-password auth only** (no OAuth path shipped) — deliberate, since Koofr's OAuth client
  registration isn't self-service. If Koofr later offers public OAuth clients, an OAuth variant could
  reuse the shared `cloud-auth` app.
- **Digi Storage** (Koofr's white-label on `storage.rcs-rds.ro`) is not wired, but would only need a
  different `API_BASE`/`CONTENT_BASE`.
- **Placeholder icons** (blue "K"); swap in real branding if desired.
- The multipart upload sends the file part without an explicit content-type; Koofr stores the object
  and re-derives the type. Fine for documents/photos.
