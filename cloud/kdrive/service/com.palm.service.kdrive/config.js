/* config.js - Infomaniak kDrive REST API, and the OAuth2 app for when it can be used.
 *
 * Sign-in today is a personal API token: any Infomaniak account (the free 15 GB kSuite tier too)
 * can make one with the "Drive" scope at manager.infomaniak.com -> Profile -> API tokens. The
 * sign-in app com.palm.app.kdrive-auth takes it and calls verifyToken, which finds account_id,
 * drive_id and the writable root from the token alone. Such a token is long-lived and has no
 * refresh token.
 *
 * OAuth2 + PKCE against login.infomaniak.com is wired up (getAuthorizeUrl / exchangeCode, refresh
 * on a 401) but not used yet: LuneOS's Infomaniak OAuth app has not been granted the scope
 * "drive", and without it the authorize step answers error=invalid_scope (seen 2026-10-19; the
 * discovery document lists only openid profile email phone, "drive" is granted per client). The
 * account template still points at verifyToken; ../../README.md says what to switch.
 */
/* The OAuth app's credentials are not kept here. The build fills the PLACEHOLDER_KDRIVE_*
 * values in from KDRIVE_CLIENT_ID / KDRIVE_CLIENT_SECRET (meta-luneos
 * cloud-synergy-connector.inc). */
/* A plain file the build patches (sed on the PLACEHOLDER_ lines), read with require(). */
var Config = {
	// Not used by the service, which speaks HTTPS through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// OAuth2 (not in use yet, see above). Infomaniak registers the app as type "Mobile" with
	// exactly this redirect; any other is refused with HTTP 400 on authorize.
	CLIENT_ID:     "PLACEHOLDER_KDRIVE_CLIENT_ID",       // from the build, see config.js header
	CLIENT_SECRET: "PLACEHOLDER_KDRIVE_CLIENT_SECRET",   // from the build, see config.js header
	REDIRECT_URI:  "http://localhost/kdrive/oauth2callback",
	AUTHORIZE_URL: "https://login.infomaniak.com/authorize",
	TOKEN_URL:     "https://login.infomaniak.com/token",
	SCOPE:         "drive",
	AUTHORIZE_EXTRA:  "",
	TOKEN_SEND_SCOPE: false,

	// One API host; adapter.js puts "/2/..." or "/3/..." in front of each path (the versions
	// differ per endpoint).
	API_HOST:    "https://api.infomaniak.com",
	ROOT_FOLDER: 1,                       // the drive root's id: not writable, so the adapter
	                                      // takes the private space under it as the root

	// Photos (PHOTO.UPLOAD): the one folder, by name, directly under the private space, that the
	// Photos app shows as an album (it downloads every image in it to /media/internal).
	PHOTO_ALBUM_NAME: "Pictures",

	// --- _cloudcore generic wiring (read by _cloudcore/node) ----------------------------
	SERVICE_NAME:  "com.palm.service.kdrive",
	DISPLAY_NAME:  "kDrive",                  // account username fallback
	STATE:         "kdrive",
	AUTH_APP_IDS:  ["com.palm.app.kdrive-auth"],   // the token sign-in app (verifyToken)
	FILE_APP_IDS:  ["org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
