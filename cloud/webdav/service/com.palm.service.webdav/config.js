/* config.js - generic WebDAV connector wiring.
 *
 * This connector is PROVIDER-AGNOSTIC: it speaks plain WebDAV (RFC 4918: PROPFIND, GET, PUT,
 * MKCOL, MOVE, DELETE) with HTTP Basic auth, so it works against Nextcloud, ownCloud, a NAS
 * (Synology, QNAP, ...), Apache mod_dav, nginx, rclone serve webdav, etc. There is NO OAuth and
 * NOTHING to register centrally - the account owner types their server, user name and password
 * (for Nextcloud/ownCloud an app password) into the webdav-auth form, and they are kept in
 * Accounts.
 *
 * Credentials shape (credentials.common): { accessToken: <password>, username, server (the WebDAV
 * folder that is the account's root, an http(s) URL ending in "/"), flavor ("webdav", "nextcloud"
 * or "owncloud"), photoFolder (the folder Photos reads, "/Photos/" by default) }. The password
 * doubles as _cloudcore's accessToken, so the generic commands (checkCredentials, the credential
 * lookup by accountId) work unchanged, as cloud/s3's access key id does.
 */
/* A plain file read with require() by service.js (and by the on-device harness). */
var Config = {
	// Not used by the service, which speaks HTTP(S) through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// Locators are paths under the account's root, "/" itself; a folder's ends in "/".
	ROOT_FOLDER: "/",

	// The server types the sign-in form offers. davPath is where the user's files are under the
	// server's address; "{user}" is the user id the server names (Nextcloud and ownCloud let one
	// sign in with an email address, but the files are under the id). Generic WebDAV takes the
	// address as the folder itself.
	FLAVORS: {
		webdav:    { name: "WebDAV",    davPath: "" },
		nextcloud: { name: "Nextcloud", davPath: "/remote.php/dav/files/{user}/", principals: "/remote.php/dav/" },
		owncloud:  { name: "ownCloud",  davPath: "/remote.php/dav/files/{user}/", principals: "/remote.php/dav/" }
	},

	// Photos: the folder Photos reads. Its images are one album and each folder in it another
	// (one level down, at most PHOTO_MAX_ALBUMS); uploads with no album go to PHOTO_ALBUM_NAME in it.
	// "Photos" is the folder Nextcloud and ownCloud make for a new user.
	PHOTO_FOLDER:     "Photos",
	PHOTO_ALBUM_NAME: "Camera Uploads",
	PHOTO_MAX_ALBUMS: 50,
	// The Photos service fetches photo URLs with no header, and WebDAV wants Basic auth on every
	// request, so listPhotos downloads each photo here first and gives file:// links (as cloud/
	// mega does). The folder is under /media/internal, where the Photos service copies from.
	PHOTO_TMP_DIR:    "/media/internal/.webdav-photos",
	// listPhotos stops fetching after this long and leaves the rest for the next sync, so it
	// answers within its 300 s deadline on a slow line.
	PHOTO_FETCH_BUDGET_MS: 240000,

	// --- _cloudcore generic wiring (read by _cloudcore/node) ----------------------------
	SERVICE_NAME:  "com.palm.service.webdav",
	DISPLAY_NAME:  "WebDAV",
	STATE:         "webdav",
	// WebDAV has no OAuth webview: its OWN auth app collects the server, user name and password.
	AUTH_APP_IDS:  ["com.palm.app.webdav-auth"],
	FILE_APP_IDS:  ["org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
