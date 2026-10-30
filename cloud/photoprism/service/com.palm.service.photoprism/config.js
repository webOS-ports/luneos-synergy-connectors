/* config.js - PhotoPrism (self-hosted photo server) API settings.
 *
 * Nothing here is a secret or the builder's: every account brings its own server address and
 * sign-in, entered in the sign-in app. The account keeps an app password the service makes for
 * itself at sign-in (or one the user made in PhotoPrism), never the user's password.
 */
var Config = {
	// Not used by the service, which speaks HTTP(S) through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// The API is <server>/api/v1.
	API_PATH: "/api/v1",

	// The app password login makes: its name in PhotoPrism's Settings -> Account -> Apps and
	// Devices, and its scope - read the albums and photos, and the config, which holds the
	// download and preview tokens the photo links carry. Nothing else, and no expiry.
	CLIENT_NAME: "LuneOS",
	SCOPE:       "albums config photos",

	// The albums Photos shows: PhotoPrism's albums, then its folders (Library -> Folders).
	ALBUM_TYPES: ["album", "folder"],
	MAX_ALBUMS:  200,

	// Originals of these types go to the Photos app as they are; any other image (HEIC, RAW,
	// TIFF, SVG, ...) as PhotoPrism's 1920 px JPEG thumbnail.
	ORIGINAL_MIME_TYPES: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"],
	THUMB_BIG:   "fit_1920",
	THUMB_SMALL: "fit_720"
};

if (typeof exports !== "undefined") { exports.Config = Config; }
