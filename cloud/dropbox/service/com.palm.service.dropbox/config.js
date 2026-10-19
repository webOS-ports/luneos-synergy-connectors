/* config.js - Dropbox OAuth2 + API v2 endpoints.
 *
 * SCAFFOLD: register a free app at https://www.dropbox.com/developers/apps
 * (Scoped access; permissions: account_info.read, files.metadata.read,
 * files.content.read, files.content.write). Use token_access_type=offline so
 * you get a refresh_token (Dropbox access tokens are short-lived ~4h).
 */
/* The OAuth app's credentials are not kept here. The build fills the PLACEHOLDER_DROPBOX_*
 * values in from DROPBOX_CLIENT_ID / DROPBOX_CLIENT_SECRET (meta-luneos
 * cloud-synergy-connector.inc); a package built without them cannot sign in. */
/* A plain file the build patches (sed on the PLACEHOLDER_ lines), read with require(). */
var Config = {
	// Not used by the service, which speaks HTTPS through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:         "/etc/ssl/certs/ca-certificates.crt",

	// PUBLIC CLIENT (PKCE) - there is NO client_secret. The app key is not secret and
	// is the same on every device; PKCE (_cloudcore/node/oauth.js) replaces the secret. Nothing to
	// provision. Enable "Allow public clients" for this app in the Dropbox console.
	CLIENT_ID:     "PLACEHOLDER_DROPBOX_CLIENT_ID", // from the build, see config.js header
	REDIRECT_URI:  "http://localhost/dropbox/oauth2callback",

	// OAuth2 (confirmed in com.dropbox.android 482.2.2)
	AUTHORIZE_URL: "https://www.dropbox.com/oauth2/authorize",
	TOKEN_URL:     "https://api.dropboxapi.com/oauth2/token",   // APK also shows api.dropbox.com/oauth2/token

	// API v2 is RPC-style: everything is POST with a JSON body.
	API_BASE:      "https://api.dropboxapi.com/2",              // /files/list_folder, /users/get_current_account
	CONTENT_BASE:  "https://content.dropboxapi.com/2",          // /files/download, /files/upload

	SCOPE:         "account_info.read files.metadata.read files.content.read files.content.write",
	ACCESS_TYPE:   "offline",                                   // -> refresh_token

	// --- _cloudcore generic wiring (read by _cloudcore/node) ----------------------------
	SERVICE_NAME:  "com.palm.service.dropbox",
	DISPLAY_NAME:  "Dropbox",
	STATE:         "dropbox",
	ROOT_FOLDER:   "",                        // Dropbox root path (adapter treats ""/"root" as root)
	AUTHORIZE_EXTRA:  "&token_access_type=offline",
	TOKEN_SEND_SCOPE: false,
	AUTH_APP_IDS:  ["com.palm.app.cloud-auth"],
	FILE_APP_IDS:  ["org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
