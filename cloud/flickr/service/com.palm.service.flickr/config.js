/* config.js - Flickr OAuth 1.0a + REST API endpoints.
 *
 * SCAFFOLD: register a (free) app at https://www.flickr.com/services/apps/create/
 * to obtain an API KEY (= CONSUMER_KEY) and its matching SECRET (= CONSUMER_SECRET).
 * Flickr signs with OAuth 1.0a / HMAC-SHA1, so - unlike a modern OAuth2 PKCE public
 * client - the consumer SECRET is genuinely required to sign every request. It is a
 * placeholder below and MUST be filled in before this connector will authenticate.
 *
 * Flickr is a PHOTO source only (browse + download into the stock Photos app). There
 * is no documents/files role here, so read=only "read" perms are requested.
 */
var Config = {
	// Not used by the service, which speaks HTTPS through node's own fetch (_cloudcore/node/
	// http.js). The on-device harness (tests/suites/cloud.py tls_reachable) still runs this curl
	// with this CA bundle to check the provider can be reached, so the keys stay.
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	// OAuth 1.0a consumer credentials. CONSUMER_KEY is also the REST "api_key".
	// oauth1.js signs every request (HMAC-SHA1) with CONSUMER_SECRET and the token secret.
	CONSUMER_KEY:    "PUT_YOUR_FLICKR_API_KEY_HERE",       // Flickr API key (= api_key)
	CONSUMER_SECRET: "PUT_YOUR_FLICKR_API_SECRET_HERE",    // Flickr API secret (signs requests)

	// Where Flickr sends the browser back after the user approves. Atlas intercepts
	// navigation to this prefix and hands us back ?oauth_token=&oauth_verifier=
	// (mirrors the Dropbox connector's redirect-capture). Configure the Flickr app's
	// callback URL to this value (or a web app that accepts it).
	CALLBACK_URL: "http://localhost/flickr/oauth1callback",

	// OAuth 1.0a 3-legged endpoints (verified against Flickr's auth.oauth docs).
	REQUEST_TOKEN_URL: "https://www.flickr.com/services/oauth/request_token",
	AUTHORIZE_URL:     "https://www.flickr.com/services/oauth/authorize",
	ACCESS_TOKEN_URL:  "https://www.flickr.com/services/oauth/access_token",

	// REST endpoint. Every call is a signed GET with method=... &format=json&nojsoncallback=1.
	REST_URL: "https://api.flickr.com/services/rest/",

	// Requested privilege at the authorize step. "read" is all a browse/download source needs.
	PERMS: "read"
};

if (typeof exports !== "undefined") { exports.Config = Config; }
