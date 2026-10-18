/* config.js - Yandex Disk OAuth2 + REST endpoints for the modern connector.
 *
 * Yandex Disk is PATH-BASED like Dropbox: a resource is addressed by a real path
 * ("disk:/Documents/foo.docx"), not an opaque item id. So this connector is a close
 * clone of the Dropbox one, with Yandex's identity platform bolted on.
 *
 * REGISTER a free app at https://oauth.yandex.com/client/new :
 *   - Platform: "Web services" (a confidential client with a secret) is fine here -
 *     Yandex has no strict public-client rule, so we ship CLIENT_ID + CLIENT_SECRET.
 *   - Redirect URI: add REDIRECT_URI below verbatim.
 *   - Permissions (scopes): Yandex.Disk REST API -> read + write + info, and
 *     "Access to email address" + "Access to username, ..." (login:email / login:info)
 *     so exchangeCode can fetch the account email for the `username`.
 * Paste the app ID + secret into CLIENT_ID / CLIENT_SECRET. PKCE is also sent (S256),
 * so a build MAY run as a public client (leave CLIENT_SECRET as the placeholder and it
 * is never sent - see oauth2.js _hasSecret).
 */
var Config = {
	// Modern-TLS HTTP: the device node is OpenSSL 0.9.8k and cannot handshake with
	// cloud-api.yandex.net / oauth.yandex.com, so ALL Yandex HTTPS is shelled out to the
	// modern system curl (same binary + system CA store the Dropbox/OneDrive connectors
	// use): /usr/bin/curl, curl 7.88.1 + OpenSSL 1.1.1w (TLS 1.3), from the OpenSSL-11 update.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	CLIENT_ID:     "86411bcf2cea432db3201bfdec5ddf42",   // Yandex OAuth app ID
	// Yandex is a confidential client: the secret IS sent on the token exchange/refresh.
	// If a build wants a pure public (PKCE-only) client, leave this placeholder and
	// oauth2.js will never send a secret (it also sends an S256 code_challenge).
	CLIENT_SECRET: "20bc280e6b134ce6aeb654f12fbe4eec",   // Yandex OAuth app secret
	REDIRECT_URI:  "http://localhost/yandex/oauth2callback",

	// Yandex OAuth2 (id.yandex / oauth.yandex.com)
	AUTHORIZE_URL: "https://oauth.yandex.com/authorize",
	TOKEN_URL:     "https://oauth.yandex.com/token",

	// Yandex Disk REST API. Every request sends "Authorization: OAuth <access_token>".
	API_BASE:      "https://cloud-api.yandex.net/v1/disk",   // /resources, /resources/download, /resources/upload
	// Account identity for `username` (email) - needs the login:email/login:info scopes.
	LOGIN_INFO_URL: "https://login.yandex.ru/info?format=json",

	ROOT_PATH:     "disk:/",   // Disk root; "/" and "" normalise to this
	LIST_LIMIT:    200,        // resources?limit=

	// Photos (PHOTO.UPLOAD) role: the album surfaced to the Photos app. resolvePhotoAlbum
	// prefers Yandex's own camera-uploads folder (system_folders.photostream) when it exists,
	// and only falls back to this named folder (created on device->cloud upload) otherwise.
	PHOTO_ALBUM_NAME: "Pictures",

	// Space-separated. disk.read/write/info = files; login:email/info = account identity.
	SCOPE:         "cloud_api:disk.read cloud_api:disk.write cloud_api:disk.info login:email login:info",

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.yandexdisk",
	DISPLAY_NAME:  "Yandex Disk",
	STATE:         "yandex",
	ROOT_FOLDER:   "disk:/",                  // generic commands' default folderId (= ROOT_PATH)
	AUTHORIZE_EXTRA:  "&force_confirm=yes",   // Yandex: force the consent screen
	TOKEN_SEND_SCOPE: false,                  // Yandex derives scope from the grant
	AUTH_APP_IDS:  ["com.palm.app.cloud-auth"],
	FILE_APP_IDS:  ["com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
