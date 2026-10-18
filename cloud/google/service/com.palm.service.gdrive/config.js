/* config.js - Google Drive (Drive API v3) OAuth2 + REST endpoints for the modern
 * connector. DOCUMENTS-only: Google Photos is NOT reachable headlessly (see
 * ../../recon/google-drive.md), so there is no PHOTO.UPLOAD provider here.
 *
 * IMPORTANT - this is a PERSONAL / <=100-user, UNVERIFIED build by necessity:
 *   - Browsing arbitrary Drive folders needs the RESTRICTED `drive` scope. An unverified
 *     app shows a "this app hasn't been verified" screen and is capped at 100 users for
 *     life. Public distribution would need Google's CASA/app verification.
 *   - Google's "Desktop app" client type STILL requires a client_secret on the token
 *     exchange (it treats it as non-confidential). So unlike Dropbox/Box/OneDrive this
 *     connector DOES ship a secret. Keep PKCE on too (Desktop supports both).
 *   - Keep the OAuth consent screen "In production" (NOT "Testing") or external refresh
 *     tokens are revoked every 7 days.
 *
 * REGISTER at https://console.cloud.google.com/ -> OAuth consent screen (External, In
 * production) + Credentials -> OAuth client ID -> "Desktop app". Add scope .../auth/drive
 * and the redirect URI below. Paste BOTH CLIENT_ID and CLIENT_SECRET.
 */
var Config = {
	// Modern-TLS HTTP: device node is OpenSSL 0.9.8k, so ALL Drive HTTPS shells out to the
	// bundled modern curl (same binary + system CA store the other connectors use).
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	CLIENT_ID:     "PLACEHOLDER_GDRIVE_CLIENT_ID",       // TODO: Google Cloud "Desktop app" client
	// REQUIRED for Google (Desktop clients must send it on token exchange). Treated as
	// non-confidential by Google; it ships in the package. oauth2.js includes it because it
	// is not left as the PLACEHOLDER sentinel.
	CLIENT_SECRET: "PLACEHOLDER_GDRIVE_CLIENT_SECRET",
	REDIRECT_URI:  "http://localhost/gdrive/oauth2callback",

	// OAuth2
	AUTHORIZE_URL: "https://accounts.google.com/o/oauth2/v2/auth",
	TOKEN_URL:     "https://oauth2.googleapis.com/token",

	// Drive API v3
	API_BASE:      "https://www.googleapis.com/drive/v3",         // /files, /about
	UPLOAD_BASE:   "https://www.googleapis.com/upload/drive/v3",  // /files?uploadType=media
	ROOT_FOLDER:   "root",                                        // Drive root alias id

	// Full drive access (RESTRICTED): browse + download + upload. Switch to
	// ".../auth/drive.readonly" for a lower-risk read-only build (breaks upload).
	SCOPE:         "https://www.googleapis.com/auth/drive",

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.gdrive",
	DISPLAY_NAME:  "Google Drive",          // exchangeCode username fallback
	STATE:         "gdrive",                 // OAuth `state` + Atlas result-key stem
	// Appended verbatim to the authorize URL. Google needs these to issue/re-issue a refresh
	// token; Google must NOT get scope on the token calls, so TOKEN_SEND_SCOPE stays off.
	AUTHORIZE_EXTRA:  "&access_type=offline&prompt=consent",
	TOKEN_SEND_SCOPE: false,
	// Caller allow-lists enforced by _cloudcore/acl.js.
	AUTH_APP_IDS:  ["com.palm.app.cloud-auth"],
	FILE_APP_IDS:  ["com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
