/*global IMPORTS, Config, HttpCurl, console */
/* oauth2.js - OAuth2 Authorization Code for pCloud. pCloud is the SIMPLEST of the
 * connectors' auth flows in two ways, and the trickiest in one:
 *
 *   1. NO PKCE. pCloud does not support the S256 code_challenge, so - like the gdrive
 *      "Desktop app" client - the code->token exchange authenticates with a SHIPPED
 *      client_secret instead of a PKCE verifier. There is therefore no verifier to
 *      generate/carry (buildAuthorizeUrl takes no crypto, exchangeCode takes no verifier).
 *   2. NO REFRESH. pCloud access tokens are LONG-LIVED and there is no refresh_token and no
 *      refresh endpoint - a token is valid until the user revokes the app. So there is no
 *      refresh() here and no refresh-on-401 in adapter.js (a 401/"login required" means
 *      the user revoked access and must re-add the account).
 *   3. REGION HOST. The token exchange must hit the account's REGION host (api.pcloud.com or
 *      eapi.pcloud.com), which the OAuth2 redirect told the auth app. exchangeCode() takes
 *      that apiHost and posts to https://<apiHost>/oauth2_token.
 *
 * All HTTPS runs through the modern curl (HttpCurl) because device node is OpenSSL 0.9.8k.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var OAuth2 = {
	// Build the consent URL. No PKCE, so no verifier side effect - pCloud sends the
	// client_secret at exchange time instead.
	buildAuthorizeUrl: function (state) {
		return Config.AUTHORIZE_URL +
			"?response_type=code" +
			"&client_id="    + encodeURIComponent(Config.CLIENT_ID) +
			"&redirect_uri=" + encodeURIComponent(Config.REDIRECT_URI) +
			"&state="        + encodeURIComponent(state || "pcloud");
	},

	// Exchange the ?code= for a bearer access_token on the account's REGION host.
	// apiHost comes from the OAuth2 redirect (hostname/locationid) via exchangeCode_command;
	// it defaults to the US host if the redirect carried neither.
	exchangeCode: function (code, apiHost) {
		var host = Config.sanitizeHost(apiHost) || Config.DEFAULT_API_HOST;
		var url = "https://" + host + Config.TOKEN_PATH;
		var f = new Future();
		f.now(this, function () {
			return HttpCurl.request({ method: "POST", url: url, form: {
				client_id:     Config.CLIENT_ID,
				client_secret: Config.CLIENT_SECRET,
				code:          code
			} });
		});
		f.then(this, function () {
			var r = f.result;
			if (!r || r.status !== 200) {
				if (typeof console !== "undefined") {
					console.log("pcloud: token endpoint failed status=" + (r && r.status) +
						" body=" + (r && r.responseText));
				}
				f.setException({ returnValue: false, errorCode: "OAUTH_TOKEN_FAILED",
					status: r && r.status, body: r && r.responseText });
				return;
			}
			var t = JSON.parse(r.responseText);
			// pCloud returns HTTP 200 even on logical errors, flagged by a nonzero `result`.
			if (t.result && t.result !== 0) {
				f.setException({ returnValue: false, errorCode: "OAUTH_TOKEN_FAILED",
					result: t.result, error: t.error });
				return;
			}
			f.result = {
				returnValue: true,
				accessToken: t.access_token,
				tokenType:   t.token_type,
				uid:         t.userid || t.uid,
				// pCloud may echo the region back in the token response; the redirect host wins.
				locationid:  t.locationid,
				apiHost:     host
			};
		});
		return f;
	}
};

if (typeof exports !== "undefined") { exports.OAuth2 = OAuth2; }
