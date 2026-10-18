/* config.js - Box (box.com) OAuth2 + REST v2 endpoints for the modern connector.
 * Mirrors com.palm.service.dropbox/config.js. Box differs from Dropbox in two ways:
 * it is REST (GET /folders/{id}/items) not RPC, and it addresses everything by
 * numeric ID (root folder id = "0") rather than by path.
 *
 * SCAFFOLD: register a free Box app at https://app.box.com/developers/console
 * (Custom App -> "User Authentication (OAuth 2.0)") and paste CLIENT_ID below. Add
 * REDIRECT_URI verbatim to the app's "OAuth 2.0 Redirect URIs" list.
 *
 * PKCE (public client) is preferred, exactly like Dropbox - see oauth2.js. If your
 * Box app type still requires a confidential secret, set CLIENT_SECRET and oauth2.js
 * will include it; leave it as the placeholder to run as a pure PKCE public client.
 */
var Config = {
	// Modern-TLS HTTP: device node is OpenSSL 0.9.8k, so ALL Box HTTPS shells out to
	// the bundled modern curl (same binary + system CA store the Dropbox connector uses).
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	CLIENT_ID:     "PLACEHOLDER_BOX_CLIENT_ID",       // TODO: from Box dev console
	// Leave as the placeholder for a PKCE public client (no secret shipped). Only set
	// this if your Box app mandates a confidential secret; prefer keymanager-wrapping.
	CLIENT_SECRET: "PLACEHOLDER_BOX_CLIENT_SECRET",
	REDIRECT_URI:  "http://localhost/boxnet/oauth2callback",

	// OAuth2 (confirmed present in com.box.android 7.1.515)
	AUTHORIZE_URL: "https://account.box.com/api/oauth2/authorize",
	TOKEN_URL:     "https://api.box.com/oauth2/token",
	REVOKE_URL:    "https://api.box.com/oauth2/revoke",

	// REST v2
	API_BASE:      "https://api.box.com/2.0",          // /folders/{id}/items, /files/{id}, /users/me
	UPLOAD_BASE:   "https://upload.box.com/api/2.0",    // /files/content
	ROOT_FOLDER:   "0",                                 // Box root folder id

	// "root" scope = full read/write to the user's own content.
	SCOPE:         "root_readwrite",

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.boxnet",
	DISPLAY_NAME:  "Box",
	STATE:         "box",
	AUTHORIZE_EXTRA:  "",                     // Box needs no extra authorize params
	TOKEN_SEND_SCOPE: false,
	AUTH_APP_IDS:  ["com.palm.app.cloud-auth"],
	FILE_APP_IDS:  ["com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
