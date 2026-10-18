/* config.js - STRATO HiDrive OAuth2 + REST 2.1 endpoints for the modern connector.
 *
 * HiDrive is PATH-BASED like Yandex/Dropbox: a resource is addressed by an absolute path under
 * the account home ("/users/<user>/Folder/file.docx"). This connector mirrors the Yandex one
 * with HiDrive's identity platform and its home-path convention bolted on. Every API call sends
 * "Authorization: Bearer <access_token>" and shells through the modern curl (device node 0.9.8k).
 *
 * REGISTER a native app at https://developer.hidrive.com/get-api-key/ (app type "native" -> you
 * get a client_secret AND refresh tokens; there is NO PKCE, so the secret ships in the package,
 * the same situation as the pCloud/Google connectors). Set the redirect URI to REDIRECT_URI
 * below. Request scope "user,rw". Paste the Client ID + Client secret into CLIENT_ID/SECRET.
 */
var Config = {
	// Modern-TLS HTTP: device node is OpenSSL 0.9.8k and cannot handshake with HiDrive, so ALL
	// HiDrive HTTPS shells out to the bundled modern curl (same binary + CA store as the others).
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	CLIENT_ID:     "2c0b0760455d5390b9a682232f844c8e",   // HiDrive "Synergy connector for webOS and LuneOS"
	// REQUIRED for HiDrive (no PKCE - the token exchange must send the secret). It ships in the
	// package; oauth2.js sends it because it is not left as the PLACEHOLDER sentinel.
	CLIENT_SECRET: "10f40a8e67a590a758d507026bc0d7fc",   // HiDrive app Client secret
	// HiDrive "native" apps require a localhost redirect WITH a port (http://localhost:<port>).
	// The cloud-auth webview captures it by URL-prefix match, so nothing listens on the port -
	// this value MUST match the redirect URI registered for the app verbatim.
	REDIRECT_URI:  "http://localhost:8888/hidrive/oauth2callback",

	// HiDrive identity platform (my.hidrive.com) - distinct from the API host below.
	AUTHORIZE_URL: "https://my.hidrive.com/client/authorize",
	TOKEN_URL:     "https://my.hidrive.com/oauth2/token",

	// HiDrive REST API 2.1 (api.hidrive.strato.com). Every request: "Authorization: Bearer <tok>".
	API_BASE:      "https://api.hidrive.strato.com/2.1",   // /dir, /file, /user/me
	// Identity + the account HOME path ("/users/<user>"), the base for all absolute paths.
	USER_INFO_PATH: "/user/me?fields=account,alias,email,descr,home,home_id",

	ROOT_FOLDER: "home",   // sentinel: adapter maps it to the account home path from /user/me
	LIST_LIMIT:  5000,     // /dir members page size (adapter pages with offset,count)

	// Photos (PHOTO.UPLOAD): HiDrive has no camera-uploads API, so one named folder under home is
	// surfaced as one album (created on first device->cloud upload).
	PHOTO_ALBUM_NAME: "Camera Uploads",

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.hidrive",
	DISPLAY_NAME:  "HiDrive",
	STATE:         "hidrive",
	SCOPE:         "user,rw",           // role,access - full file read/write on the own drive
	AUTHORIZE_EXTRA:  "",
	TOKEN_SEND_SCOPE: false,            // HiDrive derives scope from the grant
	AUTH_APP_IDS:  ["com.palm.app.cloud-auth"],
	FILE_APP_IDS:  ["com.palm.app.hidrive-files", "com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
