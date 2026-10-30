/* config.js - SmugMug OAuth 1.0a + API v2 endpoints.
 *
 * The API key (= CONSUMER_KEY) and its secret (= CONSUMER_SECRET) are the builder's own, from
 * an app registered at https://api.smugmug.com/api/developer/apply. SmugMug signs with OAuth
 * 1.0a / HMAC-SHA1, so the secret is half of every signing key and there is no public client.
 * Both are placeholders here; meta-luneos cloud-synergy-connector.inc fills them in at build
 * time from SMUGMUG_CLIENT_ID / SMUGMUG_CLIENT_SECRET.
 *
 * SmugMug is a PHOTO source only (browse + download into the Photos app), so read-only
 * access is requested.
 */
var Config = {
	// Not used by the service, which speaks HTTPS through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// OAuth 1.0a consumer credentials (SmugMug's "API Key" and "API Secret").
	CONSUMER_KEY:    "PLACEHOLDER_SMUGMUG_CLIENT_ID",
	CONSUMER_SECRET: "PLACEHOLDER_SMUGMUG_CLIENT_SECRET",

	// Where SmugMug sends the browser back after the user approves, with ?oauth_token=
	// &oauth_verifier=. Atlas intercepts navigation to this prefix. It is also the callback
	// registered for the API key.
	CALLBACK_URL: "http://localhost/smugmug/oauth1callback",

	// OAuth 1.0a 3-legged endpoints (api.smugmug.com/api/v2/doc/tutorial/authorization.html).
	REQUEST_TOKEN_URL: "https://api.smugmug.com/services/oauth/1.0a/getRequestToken",
	AUTHORIZE_URL:     "https://api.smugmug.com/services/oauth/1.0a/authorize",
	ACCESS_TOKEN_URL:  "https://api.smugmug.com/services/oauth/1.0a/getAccessToken",

	// API v2. Every call is a signed GET of API_URL + a path (/api/v2!authuser, ...), JSON asked
	// for with Accept: application/json.
	API_URL: "https://api.smugmug.com",

	// The authorize step's Access (Public | Full) and Permissions (Read | Add | Modify). Full
	// sees the user's private and unlisted galleries; Read is all a browse/download source needs.
	ACCESS:      "Full",
	PERMISSIONS: "Read"
};

if (typeof exports !== "undefined") { exports.Config = Config; }
