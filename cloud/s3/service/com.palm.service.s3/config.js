/* config.js - generic S3-compatible storage connector wiring.
 *
 * This connector is PROVIDER-AGNOSTIC: it speaks the Amazon S3 REST API (SigV4-signed), so it
 * works against AWS S3, IDrive e2, Backblaze B2 (S3 API), Wasabi, MinIO, Garage, Storj, etc.
 * There is NO OAuth and NOTHING to register centrally - the account owner supplies their own
 * endpoint, region, bucket, access key id and secret access key in the s3-auth form. Those are
 * stored in the account credentials and the adapter signs every request with them (s3sig.js,
 * adapter.js).
 *
 * Credentials shape (credentials.common): { accessToken: <accessKeyId>, secretAccessKey,
 * endpoint ("host[:port]"), region, bucket, pathStyle, scheme? ("http" only for an endpoint
 * given as http://) }. The access key id doubles as _cloudcore's accessToken, so the generic
 * commands (checkCredentials, the credential lookup by accountId) work unchanged.
 */
/* A plain file read with require() by service.js (and by the on-device harness). */
var Config = {
	// Not used by the service, which speaks HTTP(S) through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// S3 folders are emulated with key prefixes + the "/" delimiter; the bucket root is the empty
	// prefix. ROOT_FOLDER is the sentinel the generic commands pass as the default folderId.
	ROOT_FOLDER: "",
	LIST_LIMIT:  1000,   // ListObjectsV2 max-keys per page (adapter pages until IsTruncated=false)

	// Photos: one prefix surfaced as one album, and the device->cloud upload target.
	PHOTO_ALBUM_NAME: "Camera Uploads",

	// Endpoint presets offered by the s3-auth form (host + a sensible default region). The user
	// can always type a custom endpoint. Backblaze/IDrive e2 endpoints are region-specific, so
	// these are just starting points.
	PROVIDER_PRESETS: [
		{ name: "Amazon S3",     endpoint: "s3.amazonaws.com",              region: "us-east-1", pathStyle: false },
		{ name: "IDrive e2",     endpoint: "<region>.idrivee2.com",         region: "us-west-1", pathStyle: true },
		{ name: "Backblaze B2",  endpoint: "s3.<region>.backblazeb2.com",   region: "us-west-004", pathStyle: true },
		{ name: "Wasabi",        endpoint: "s3.<region>.wasabisys.com",     region: "us-east-1", pathStyle: true },
		{ name: "MinIO / custom", endpoint: "",                             region: "us-east-1", pathStyle: true }
	],
	DEFAULT_REGION: "us-east-1",

	// --- _cloudcore generic wiring (read by _cloudcore/node) ----------------------------
	SERVICE_NAME:  "com.palm.service.s3",
	DISPLAY_NAME:  "S3 Storage",
	STATE:         "s3",
	// S3 has no OAuth webview: its OWN auth app collects endpoint/region/bucket/keys.
	AUTH_APP_IDS:  ["com.palm.app.s3-auth"],
	FILE_APP_IDS:  ["org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
