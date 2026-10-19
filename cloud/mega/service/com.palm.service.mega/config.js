/* config.js - MEGA (mega.nz) endpoint and the _cloudcore wiring.
 *
 * MEGA is not OAuth2 and not a plaintext REST API: it is a zero-knowledge, end-to-end-encrypted
 * store with one JSON command endpoint (the "cs" API) at https://g.api.mega.co.nz/cs, to which
 * a JSON array of commands is POSTed and a JSON array of results read back. The login handshake
 * and all the file and name crypto happen on the device (megacrypto.js, megaapi.js).
 *
 * There is nothing to register and no client id or secret: the account owner signs in with
 * their own MEGA email and password (the mega-auth app collects them, login.js runs the us0/us
 * handshake), so the same package ships to every device.
 */
/* A plain file, read with require(). */
var Config = {
	// Not used by the service, which speaks HTTPS through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// The MEGA "cs" (client->server) command endpoint. Requests are POSTed as a JSON array
	// [ {a:'...', ...} ] and answered with a JSON array (or a bare negative int on error).
	// An increasing ?id=<seq> and, once signed in, &sid=<session> are appended (megaapi.js).
	API_BASE:   "https://g.api.mega.co.nz/cs",

	// Mega node handles are opaque 8-char base64 tokens; the account root is the "Cloud Drive"
	// filesystem root ("ROOT" node), discovered from the `f` tree (t===2). ROOT_FOLDER is the
	// sentinel the generic commands pass as the default folderId; adapter.js maps it to the
	// real root handle at call time.
	ROOT_FOLDER: "root",
	LIST_LIMIT:  0,   // Mega `f` returns the WHOLE tree in one shot; no server-side paging.

	// Photos (PHOTO.UPLOAD): the folder surfaced to the stock Photos app as one album, and the
	// device->cloud upload target. Mega has no canonical "camera uploads" folder, so we use a
	// named folder under the Cloud Drive root (created on first upload).
	PHOTO_ALBUM_NAME: "Camera Uploads",

	// --- _cloudcore generic wiring (read by _cloudcore/node) ----------------------------
	SERVICE_NAME:  "com.palm.service.mega",
	DISPLAY_NAME:  "MEGA",
	STATE:         "mega",
	// The credentials-collecting customUI app (email+password form). MEGA has no OAuth webview,
	// so it is its own app, not the shared com.palm.app.cloud-auth. Not checked: login is open
	// (login.js).
	AUTH_APP_IDS:  ["com.palm.app.mega-auth"],
	FILE_APP_IDS:  ["org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
