/* config.js - Mega (mega.nz) endpoints + wiring for the modern connector.
 *
 * Mega is the ODD ONE OUT among the connectors: it is NOT OAuth2 and NOT a plaintext REST
 * API. It is a zero-knowledge, end-to-end-encrypted store. There is a single JSON command
 * endpoint (the "cs" API) at https://g.api.mega.co.nz/cs to which we POST a JSON array of
 * commands and read back a JSON array of results. Everything else - the login handshake and
 * all file/attribute crypto - happens client-side in megacrypto.js. See adapter.js/megaapi.js.
 *
 * There is NOTHING to register and NO client id/secret: the account owner signs in with their
 * OWN Mega email + password (the mega-auth app collects them, the `login` command runs the
 * us0/us handshake). So the identical package ships to every device, same as the PKCE ones.
 */
var Config = {
	// Modern-TLS HTTP: the device node is OpenSSL 0.9.8k and cannot handshake with
	// g.api.mega.co.nz, so ALL Mega HTTPS is shelled out to the modern system curl (the
	// same binary + CA store the Dropbox/OneDrive connectors use): /usr/bin/curl,
	// curl 7.88.1 + OpenSSL 1.1.1w (TLS 1.3), from the companion OpenSSL-11 update.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// The Mega "cs" (client->server) command endpoint. Requests are POSTed as a JSON array
	// [ {a:'...', ...} ] and answered with a JSON array (or a bare negative int on error).
	// A monotonically-increasing &id=<seq> and, once logged in, &sid=<session> are appended.
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

	// --- generic wiring (consumed by ../_cloudcore) -------------------------------------
	SERVICE_NAME:  "com.palm.service.mega",
	DISPLAY_NAME:  "MEGA",
	STATE:         "mega",
	// The credentials-collecting customUI app (email+password form). Mega has no OAuth webview,
	// so it is its OWN app, NOT the shared com.palm.app.cloud-auth.
	AUTH_APP_IDS:  ["com.palm.app.mega-auth"],
	FILE_APP_IDS:  ["com.palm.app.mega-files", "com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
