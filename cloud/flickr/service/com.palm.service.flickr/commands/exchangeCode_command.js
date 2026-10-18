/*global FlickrApi, console */
/* exchangeCode - the account VALIDATOR. Called by com.palm.service.accounts (via the
 * customUI auth webview) with the oauth_verifier captured from the OAuth 1.0a redirect,
 * plus the request token + secret carried across from getAuthorizeUrl.
 *
 * Returns credentials in the shape the account DB stores (and flickrapi later reads),
 * PLUS a username: accounts/handlers/create.js does Assert.require(args.username) and
 * refuses to create the account without one. Flickr's access_token reply carries the
 * username/fullname inline, so no extra API call is needed for identity.
 *
 * NOTE the OAuth1 param names: the auth app forwards the captured `oauth_verifier` and
 * the `oauth_token` from the redirect (which is the REQUEST token) plus the
 * requestTokenSecret it held. We accept both verifier/oauthVerifier spellings defensively.
 */
function ExchangeCodeCommandAssistant() {}

ExchangeCodeCommandAssistant.prototype = {
	run: function (future) {
		var args = this.controller.args || {};
		var verifier    = args.oauth_verifier || args.oauthVerifier || args.verifier;
		var reqToken    = args.requestToken   || args.oauth_token;
		var reqSecret   = args.requestTokenSecret;
		if (!verifier || !reqToken || !reqSecret) {
			future.setException({ returnValue: false, errorCode: "MISSING_VERIFIER",
				detail: "need oauth_verifier, requestToken and requestTokenSecret" });
			return;
		}
		// Do NOT future.nest(ex): nesting would resolve `future` with the RAW access-token
		// result before we can wrap it in { credentials, username } - so Accounts would
		// store nothing. Resolve `future` ourselves with the wrapped shape.
		var ex = FlickrApi.exchange(reqToken, reqSecret, verifier);
		ex.then(this, function () {
			var common;
			try { common = ex.result; }        // throws if ex carried an exception
			catch (e) { future.setException(e); return; }
			future.result = {
				returnValue: true,
				username:    common.username || common.userId || "Flickr",
				alias:       common.fullname || undefined,
				credentials: { common: common }
			};
		});
	}
};
