/* config.js - Box (box.com) OAuth2 + REST v2 endpoints for the modern connector.
 * Mirrors com.palm.service.dropbox/config.js. Box differs from Dropbox in two ways:
 * it is REST (GET /folders/{id}/items) not RPC, and it addresses everything by
 * numeric ID (root folder id = "0") rather than by path.
 *
 * The Box app (https://app.box.com/developers/console, Custom App -> "User
 * Authentication (OAuth 2.0)") lists REDIRECT_URI verbatim among its OAuth 2.0 Redirect
 * URIs. oauth2.js sends PKCE and CLIENT_SECRET: Box's token endpoint refuses a code
 * without the secret ("invalid_client").
 *
 * The app's id and secret are not kept here. The build fills in the two placeholders
 * from BOX_CLIENT_ID / BOX_CLIENT_SECRET (meta-luneos cloud-synergy-connector.inc); a
 * package built without them cannot sign in.
 */
var Config = {
	// Modern-TLS HTTP: device node is OpenSSL 0.9.8k, so ALL Box HTTPS shells out to
	// the bundled modern curl (same binary + system CA store the Dropbox connector uses).
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	CLIENT_ID:     "PLACEHOLDER_BOX_CLIENT_ID",     // from the build, see above
	CLIENT_SECRET: "PLACEHOLDER_BOX_CLIENT_SECRET", // likewise
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
	FILE_APP_IDS:  ["org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
