/* config.js - Immich (self-hosted photo server) API settings.
 *
 * Nothing here is a secret or the builder's: every account brings its own server address and
 * an API key the user creates in Immich (Account Settings -> API Keys), entered in the sign-in
 * app and kept in Accounts.
 */
var Config = {
	// Not used by the service, which speaks HTTP(S) through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// The API is <server>/api.
	API_PATH: "/api",

	// Originals of these types go to the Photos app as they are; any other image (HEIC, RAW such
	// as DNG, TIFF, AVIF, ...) as Immich's preview, a JPEG it renders (or WebP, if the server's
	// admin chose that format for previews).
	ORIGINAL_MIME_TYPES: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"],

	// Immich 3.2 takes a search as { filter, cursor } and calls the flat albumIds / page fields
	// deprecated (to be removed in v4); older servers know only the flat ones.
	FILTER_SEARCH_SINCE: [3, 2]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
