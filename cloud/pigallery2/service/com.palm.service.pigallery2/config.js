/* config.js - PiGallery2 (self-hosted, folder-based photo gallery) API settings.
 *
 * Nothing here is a secret or the builder's: every account brings its own server address and
 * sign-in, entered in the sign-in app.
 */
var Config = {
	// Not used by the service, which speaks HTTP(S) through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// The API is <server>/pgapi (PiGallery2's Server.apiPath, which its settings do not change).
	API_PATH: "/pgapi",

	// A signed-in session is used for this long, then a new one is opened. PiGallery2 keeps one
	// for a week of no use (Server.sessionTimeout); the Photos service downloads a listing's
	// photos with it right after the listing.
	SESSION_MAX_AGE_MS: 60 * 60 * 1000,

	// Every folder is an album: at most this many folders are read, this many at a time. The
	// walk is a job (_cloudcore jobs.js), so it need not fit in one bus call; the cap is there
	// for a gallery with a loop or a runaway tree, not to keep the walk short.
	MAX_ALBUMS:  20000,
	CONCURRENCY: 4,
	// The gallery's own top folder, when it has photos itself.
	ROOT_ALBUM_NAME: "Gallery",

	// Originals of these types go to the Photos app as they are; any other image (HEIC, AVIF,
	// TIFF, RAW, SVG) as PiGallery2's THUMB_BIG thumbnail (WebP, unless its settings say
	// otherwise). A size its settings do not have gets its smallest.
	ORIGINAL_EXTENSIONS: ["jpg", "jpeg", "jpe", "png", "gif", "webp", "bmp"],
	VIDEO_EXTENSIONS: ["mp4", "webm", "ogv", "ogg", "avi", "mkv", "mov", "wmv", "flv", "mts", "m2ts", "mpg", "3gp",
		"m4v", "mpeg", "vob", "divx", "xvid", "ts"],
	THUMB_BIG:   1080,
	THUMB_SMALL: 320
};

if (typeof exports !== "undefined") { exports.Config = Config; }
