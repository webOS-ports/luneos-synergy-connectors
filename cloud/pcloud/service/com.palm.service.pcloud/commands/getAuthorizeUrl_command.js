/*global OAuth2, Config, console */
/* getAuthorizeUrl - returns the OAuth2 consent URL for the auth webview to load.
 * client_id / redirect_uri all live in the service config (single source of truth), so
 * the app never needs to know them. Called by the generic com.palm.app.cloud-auth at the
 * start of account creation (caller allow-list from Config.AUTH_APP_IDS).
 *
 * LOCAL to pCloud (not the _cloudcore generic one): unlike Box/OneDrive there is NO PKCE
 * verifier to return - pCloud does not support PKCE and instead authenticates the code
 * exchange with the shipped client_secret. So this returns { url } with no codeVerifier.
 */
function GetAuthorizeUrlCommandAssistant() {}

GetAuthorizeUrlCommandAssistant.prototype = {
	allowedAppIds: (typeof Config !== "undefined" && Config.AUTH_APP_IDS) || [],

	run: function (future) {
		var args = this.controller.args || {};
		try {
			var url = OAuth2.buildAuthorizeUrl(args.state || "pcloud");
			future.result = { returnValue: true, url: url };
		} catch (e) {
			future.setException(e);
		}
	}
};
