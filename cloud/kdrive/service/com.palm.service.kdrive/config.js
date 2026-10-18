/* config.js - Infomaniak kDrive REST API for the modern connector.
 *
 * kDrive is TOKEN-based. Infomaniak lets any account (incl. the FREE 15 GB kSuite tier) mint a
 * personal API token with the "Drive" scope at manager.infomaniak.com -> Profile -> API tokens.
 * That token is a long-lived Bearer credential, so this connector needs NO client_id/secret,
 * NO OAuth, NO Atlas, and NO refresh flow - the user simply pastes the token when adding the
 * account, and the service auto-discovers account_id + drive_id from it (GET /2/profile ->
 * GET /2/drive). (WebDAV also exists but is PAID-only, so the REST API is the free path.)
 *
 * OAuth was investigated and RULED OUT (verified live): Infomaniak's OAuth is an OIDC LOGIN
 * server (login.infomaniak.com) that only grants identity scopes (openid/profile/email/phone)
 * and REJECTS the `drive` scope with invalid_scope. The kDrive API's `drive`/`user_info` scopes
 * exist ONLY in the personal-API-token system, a separate namespace OAuth cannot issue. So there
 * is no OAuth path here - the token is the credential.
 *
 * The API is RESTful, ID-addressed (numeric file/dir ids; the drive root dir id is 1) and uses a
 * pCloud-style envelope: HTTP 200 with { result:"success", data:... } on success,
 * { result:"error", error:{...} } on a logical error. API versions are MIXED per endpoint
 * (verified on-device against a free drive): files list/metadata + upload = v3; drive list +
 * file download = v2. adapter.js builds the versioned path per call off API_HOST.
 *
 * The Bearer token per account is stored in the account credentials (common.accessToken); the
 * discovered drive_id/account_id ride alongside it (common.driveId / common.accountId). No
 * secret is ever committed - the token lives ONLY in the on-device account DB.
 */
var Config = {
	// Modern-TLS HTTP: device node is OpenSSL 0.9.8k, so ALL kDrive HTTPS shells out to the
	// bundled modern curl (same binary + system CA store the other connectors use).
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// Single API host; the adapter prefixes "/2/..." or "/3/..." per endpoint (versions differ).
	API_HOST:    "https://api.infomaniak.com",
	ROOT_FOLDER: 1,                       // kDrive drive-root id (a non-writable container; the
	                                      // adapter resolves it to the writable private space)

	// Photos (PHOTO.UPLOAD) role: the ONE folder (by name, directly under the private-space root)
	// surfaced to the stock Photos app as an album. The aggregator auto-downloads every image in
	// it to /media/internal, so it's a named folder rather than the whole drive. Create a folder
	// with this name in kDrive and drop photos in it; change the name here to point elsewhere.
	PHOTO_ALBUM_NAME: "Pictures",

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.kdrive",
	DISPLAY_NAME:  "kDrive",                  // account username fallback
	STATE:         "kdrive",
	AUTH_APP_IDS:  ["com.palm.app.kdrive-auth"],   // token-entry customUI app (verifyToken)
	FILE_APP_IDS:  ["com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
