/*global FlickrApi, console */
/* getAuthorizeUrl - starts the OAuth 1.0a dance for the auth webview.
 *
 * Unlike the Dropbox PKCE version (which just builds a URL locally), Flickr's leg 1 is a
 * SIGNED network call to request_token, so this performs an HTTPS GET (via curl) and
 * returns BOTH the consent URL and the temporary request token + secret. The auth app
 * must carry requestToken + requestTokenSecret across the web login and hand them back to
 * exchangeCode - the service is idle-killed during sign-in, so they can't live in memory.
 * Called by com.palm.app.flickr-auth at the start of account creation.
 */
function GetAuthorizeUrlCommandAssistant() {}

GetAuthorizeUrlCommandAssistant.prototype = {
	allowedAppIds: ["com.palm.app.flickr-auth"],

	run: function (future) {
		var call = FlickrApi.getAuthorizeUrl();
		call.then(this, function () {
			var r;
			try { r = call.result; }
			catch (e) { future.setException(e); return; }
			future.result = {
				returnValue:        true,
				url:                r.url,
				requestToken:       r.requestToken,
				requestTokenSecret: r.requestTokenSecret
			};
		});
	}
};
