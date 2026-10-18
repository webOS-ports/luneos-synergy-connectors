/* config.js - Microsoft OneDrive (Microsoft Graph) OAuth2 + REST endpoints for the
 * modern connector. Mirrors com.palm.service.boxnet/config.js: Graph is REST and
 * ID-based like Box (a folder is an item id; the root is addressed as "root"), so the
 * connector is a near-clone of Box with Microsoft's identity platform bolted on.
 *
 * REGISTER a free app in the Azure portal -> "App registrations" -> New:
 *   - Supported account types: "Accounts in any org directory AND personal Microsoft
 *     accounts" (so consumer OneDrive works).
 *   - Platform: "Mobile and desktop applications"; add REDIRECT_URI below verbatim.
 *   - Authentication -> "Allow public client flows" = Yes (isFallbackPublicClient).
 * Paste the Application (client) ID into CLIENT_ID. NO client_secret is used or wanted:
 * Microsoft public/native clients MUST redeem the code WITHOUT a secret, so the identical
 * package ships to every device with nothing to provision (see oauth2.js).
 */
var Config = {
	// Modern-TLS HTTP: device node is OpenSSL 0.9.8k, so ALL Graph HTTPS shells out to the
	// bundled modern curl (same binary + system CA store the Dropbox/Box connectors use).
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	CLIENT_ID:     "8b20aa5b-7480-461d-a32b-2fc5bde09701",   // Azure App registration (client) ID
	// Microsoft public clients redeem the auth code with NO secret. Leave this placeholder;
	// oauth2.js runs pure PKCE and never sends a secret when it starts with "PLACEHOLDER".
	CLIENT_SECRET: "PLACEHOLDER_ONEDRIVE_CLIENT_SECRET",
	REDIRECT_URI:  "http://localhost/onedrive/oauth2callback",

	// Microsoft identity platform v2.0 (common = work/school OR personal accounts)
	AUTHORIZE_URL: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
	TOKEN_URL:     "https://login.microsoftonline.com/common/oauth2/v2.0/token",

	// Microsoft Graph REST
	API_BASE:      "https://graph.microsoft.com/v1.0",  // /me, /me/drive/...
	ROOT_FOLDER:   "root",                              // OneDrive root item id sentinel

	// Files.ReadWrite = read/write the user's own OneDrive; offline_access = refresh token;
	// User.Read = /me profile for the account display name. Space-separated per OAuth2.
	SCOPE:         "Files.ReadWrite offline_access User.Read",

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.onedrive",
	DISPLAY_NAME:  "OneDrive",               // exchangeCode username fallback
	STATE:         "onedrive",               // OAuth `state` + Atlas result-key stem
	// ROOT_FOLDER ("root") is defined above. Microsoft needs no extra authorize params, but
	// DOES require `scope` on the token + refresh calls (shared oauth2.js opts in via the flag).
	AUTHORIZE_EXTRA:  "",
	TOKEN_SEND_SCOPE: true,
	// Caller allow-lists enforced by _cloudcore/acl.js.
	AUTH_APP_IDS:  ["com.palm.app.cloud-auth"],
	FILE_APP_IDS:  ["com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
