/* config.js - Koofr OAuth2 + REST v2 endpoints for the modern connector.
 *
 * Koofr is OAuth2 (Ory-Hydra-style) + MOUNT/PATH based. This connector mirrors the Yandex/
 * HiDrive OAuth connectors: it reuses _cloudcore (oauth2.js + the generic commands) and the
 * SHARED consent webview app com.palm.app.cloud-auth. Files live under a mount (the user's
 * primary personal storage), addressed by (mountId, absolute path); the primary mount is
 * resolved lazily and cached in the credentials. Every API call sends "Authorization: Bearer
 * <token>" and shells through the modern curl (device node is ancient).
 *
 * REGISTER a "Desktop app" client at https://app.koofr.net/developers/api . Set the redirect URI
 * to REDIRECT_URI below verbatim. Koofr is a confidential client (a client_secret is issued and
 * IS sent on the token exchange), and oauth2.js ALSO sends a PKCE challenge (harmless - Hydra
 * binds it and we send the matching verifier).
 */
var Config = {
	// Modern-TLS HTTP: device node can't handshake with app.koofr.net, so ALL HTTPS shells out
	// to the bundled modern curl (same binary + CA store as the other connectors).
	CURL:                 "/usr/bin/curl",
	CURL_LD_LIBRARY_PATH: "",
	CURL_CAINFO:          "/etc/ssl/certs/ca-certificates.crt",

	CLIENT_ID:     "DMUXM62M6F6EI3DCAR5TIMJBEP5EETPJ",   // Koofr OAuth2 "Desktop app" Client ID
	// Koofr is a confidential client: the secret IS sent on the token exchange/refresh.
	CLIENT_SECRET: "MS7G6OULP3HKIM7A2AGZHI7VJZ7MDA3X64YCW6HVNUMLINK2YZR5FUUKS6GV4MIC",
	REDIRECT_URI:  "http://localhost/koofr/oauth2callback",

	// Koofr OAuth2 (Ory Hydra) endpoints (verified live).
	AUTHORIZE_URL: "https://app.koofr.net/oauth2/auth",
	TOKEN_URL:     "https://app.koofr.net/oauth2/token",

	// Koofr REST v2. Same host for API and content - only the path prefix differs.
	API_BASE:     "https://app.koofr.net/api/v2",
	CONTENT_BASE: "https://app.koofr.net/content/api/v2",
	KOOFR_VERSION: "2.1",   // sent as X-Koofr-Version on every request

	ROOT_FOLDER: "/",   // mount root; the sentinel "root"/"" also maps here

	PHOTO_ALBUM_NAME: "Camera Uploads",   // one folder surfaced as one album

	// --- _cloudcore generic wiring (consumed by ../_cloudcore) --------------------------
	SERVICE_NAME:  "com.palm.service.koofr",
	DISPLAY_NAME:  "Koofr",
	STATE:         "koofr",
	// Koofr's Hydra accepts EXACTLY ONE scope: "public". Requesting "offline_access" makes the
	// authorize endpoint 303 straight back to the redirect_uri with
	//   ?error=invalid_scope&error_description=Invalid scope: offline_access. Valid scopes: public
	// which cloud-auth captures as an empty result, so sign-in "returns right away" and fails.
	// With "public" the consent/login page loads normally. CAVEAT: without offline_access Hydra
	// may not issue a refresh_token; if the account breaks after the access token's lifetime,
	// revisit (Koofr may issue long-lived tokens, or need re-auth) - but "public" is the only
	// scope the server will accept.
	SCOPE:            "public",
	AUTHORIZE_EXTRA:  "",
	TOKEN_SEND_SCOPE: false,             // Koofr derives scope from the grant
	AUTH_APP_IDS:  ["com.palm.app.cloud-auth"],
	FILE_APP_IDS:  ["com.palm.app.koofr-files", "com.quickoffice.webos", "com.quickoffice.ar"]
};

if (typeof exports !== "undefined") { exports.Config = Config; }
