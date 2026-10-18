/* config.js - pCloud OAuth2 + REST endpoints for the modern connector. pCloud is REST
 * and numeric-ID-based like Box/OneDrive (a folder is a numeric folderid, the root is
 * folderid 0; a file is a numeric fileid), so the connector is a near-clone of the Box/
 * OneDrive ones with pCloud's identity platform and its REGION-HOST quirk bolted on.
 *
 * REGION-HOST QUIRK (the one thing that makes pCloud different): a pCloud account lives in
 * EITHER the US data region (api.pcloud.com) OR the EU region (eapi.pcloud.com). The OAuth2
 * authorize redirect tells you which - it carries `hostname` and `locationid` (1=US, 2=EU).
 * Every subsequent API call for that account (token exchange, listfolder, getfilelink,
 * uploadfile, userinfo) MUST go to that region's host, or pCloud returns "log in first".
 * So we STORE the region host in the account credentials (common.apiHost) at exchangeCode
 * time and the Adapter uses it for all calls. See adapter.js / exchangeCode_command.js.
 *
 * REGISTER a free app at https://docs.pcloud.com/ -> "My applications" (developer console).
 * Set the redirect URI to REDIRECT_URI below verbatim. Paste BOTH the Client ID and the
 * Client secret - UNLIKE Box/OneDrive, pCloud does NOT support PKCE, so the code->token
 * exchange REQUIRES a client_secret (same situation as the gdrive connector). Both values
 * are required before the connector can run.
 */
var Config = {
	// Modern-TLS HTTP: device node is OpenSSL 0.9.8k, so ALL pCloud HTTPS shells out to the
	// bundled modern curl (same binary + system CA store the Dropbox/Box connectors use).
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	CLIENT_ID:     "EYDr48cX1c8",                        // pCloud app "Client ID"
	// REQUIRED for pCloud (no PKCE support - the token exchange must send the secret, like
	// the gdrive "Desktop app" client). It ships in the package; oauth2.js includes it
	// because it is not left as the PLACEHOLDER sentinel.
	CLIENT_SECRET: "MKRfolugUiyIh6xS7qaNIFBGuRBV",       // pCloud app "Client secret"
	REDIRECT_URI:  "http://localhost/pcloud/oauth2callback",

	// OAuth2 consent is always on my.pcloud.com (region-independent); the redirect back tells
	// us the region host to use from then on.
	AUTHORIZE_URL: "https://my.pcloud.com/oauth2/authorize",
	// Path (appended to the REGION host) that exchanges the ?code= for a bearer access_token.
	TOKEN_PATH:    "/oauth2_token",

	// Region API hosts. DEFAULT is US; the real per-account host is resolved from the OAuth2
	// redirect (hostname / locationid) and stored in the credentials.
	API_HOST_US:      "api.pcloud.com",     // locationid 1
	API_HOST_EU:      "eapi.pcloud.com",    // locationid 2
	DEFAULT_API_HOST: "api.pcloud.com",

	ROOT_FOLDER: 0,   // pCloud root folderid sentinel (numeric 0)

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.pcloud",
	DISPLAY_NAME:  "pCloud",                 // exchangeCode username fallback
	STATE:         "pcloud",                 // OAuth `state` + Atlas result-key stem
	// pCloud's auth is LOCAL (region host, no PKCE, no refresh) so the generic oauth2.js is
	// NOT used - AUTHORIZE_EXTRA/TOKEN_SEND_SCOPE are kept only for config symmetry. The
	// generic cloud-auth forwards the redirect's hostname/locationid to the LOCAL exchangeCode.
	AUTHORIZE_EXTRA:  "",
	TOKEN_SEND_SCOPE: false,
	// Caller allow-lists enforced by _cloudcore/acl.js.
	AUTH_APP_IDS:  ["com.palm.app.cloud-auth"],
	FILE_APP_IDS:  ["com.quickoffice.webos", "com.quickoffice.ar"],

	// Map a pCloud locationid (1/2) to its API host; fall back to the US default.
	hostForLocation: function (locationid) {
		return (String(locationid) === "2") ? Config.API_HOST_EU : Config.API_HOST_US;
	},
	// Accept a hostname from the OAuth2 redirect only if it is a pCloud host (defensive).
	sanitizeHost: function (hostname) {
		return (hostname && /(^|\.)pcloud\.com$/i.test(hostname)) ? hostname : null;
	}
};

if (typeof exports !== "undefined") { exports.Config = Config; }
