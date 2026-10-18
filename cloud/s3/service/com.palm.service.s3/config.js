/* config.js - generic S3-compatible storage connector wiring.
 *
 * This connector is PROVIDER-AGNOSTIC: it speaks the Amazon S3 REST API (SigV4-signed), so it
 * works against AWS S3, IDrive e2, Backblaze B2 (S3 API), Wasabi, MinIO, Storj, etc. There is
 * NO OAuth and NOTHING to register centrally - the account owner supplies their own endpoint,
 * region, bucket, access key id and secret access key in the s3-auth form. Those are stored in
 * the account credentials and the adapter signs every request with them (see s3sig.js/adapter.js).
 *
 * Credentials shape (credentials.common): { accessToken: <accessKeyId>, secretAccessKey,
 * endpoint (host), region, bucket, pathStyle }. The access key id doubles as _cloudcore's
 * accessToken so AccountCreds + the generic commands work unchanged (same trick as the Mega
 * connector's session id).
 */
var Config = {
	// Modern-TLS HTTP: device node is OpenSSL 0.9.8k, so ALL S3 HTTPS shells out to the bundled
	// modern curl (same binary + CA store the other connectors use). SigV4 hashing itself runs
	// in-process via native node crypto (HMAC/SHA-256), which 0.9.8k does support.
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

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.s3",
	DISPLAY_NAME:  "S3 Storage",
	STATE:         "s3",
	// S3 has no OAuth webview: its OWN auth app collects endpoint/region/bucket/keys.
	AUTH_APP_IDS:  ["com.palm.app.s3-auth"],
	FILE_APP_IDS:  ["com.palm.app.s3-files", "com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
