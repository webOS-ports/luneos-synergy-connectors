/*global IMPORTS, console */
/* creds.js - resolve/persist Flickr account credentials from the service side.
 *
 * Flickr's OAuth 1.0a access credentials are LONG-LIVED and do NOT expire or rotate
 * (no refresh token, no expiry), so - unlike Dropbox/OneDrive - there is no renew-on-401
 * path and `save` is only used at account-create time. The stored `common` object is:
 *   { oauthToken, oauthTokenSecret, userId, username, fullname }
 * oauthToken + oauthTokenSecret are what every REST call must be signed with.
 *
 * A consumer can pass raw { credentials:{common:{...}} }, OR just an { accountId } and
 * let the service read the stored tokens itself (keeps tokens out of the app). The
 * latter requires com.palm.service.flickr in the template read+writePermissions.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;
var PalmCall = Foundations.Comms.PalmCall;

var AccountCreds = {
	// resolve(args) -> Future resolving to the `common` credentials object.
	resolve: function (args) {
		var f = new Future();
		if (args.credentials && args.credentials.common && args.credentials.common.oauthToken) {
			f.result = args.credentials.common;
			return f;
		}
		if (!args.accountId) {
			f.setException({ returnValue: false, errorCode: "NO_CREDENTIALS",
				detail: "pass credentials or accountId" });
			return f;
		}
		// Credentials are stored per named key; exchangeCode saved them under "common"
		// (accounts saveCredentials stores each top-level key of the credentials object).
		var call = PalmCall.call("palm://com.palm.service.accounts/", "readCredentials",
			{ accountId: args.accountId, name: "common" });
		f.now(this, function () { return call; });
		f.then(this, function () {
			var r = f.result;
			// KeyStore may return the value directly, or wrapped as {credentials:...}, or
			// still nested under {common:...} - normalise all three.
			var c = (r && r.credentials) || r || {};
			if (c && c.common) { c = c.common; }
			if (!c || !c.oauthToken) {
				f.setException({ returnValue: false, errorCode: "NO_STORED_CREDENTIALS", detail: r });
				return;
			}
			f.result = c;
		});
		return f;
	},

	// Persist credentials back to the account (best-effort; only when we own accountId).
	// Flickr tokens don't rotate, so in practice this is a no-op after create - kept for
	// symmetry with the other connectors and in case identity fields are backfilled.
	save: function (accountId, common) {
		if (!accountId || !common) { var d = new Future(); d.result = { returnValue: false }; return d; }
		return PalmCall.call("palm://com.palm.service.accounts/", "writeCredentials",
			{ accountId: accountId, name: "common", credentials: common });
	}
};

if (typeof exports !== "undefined") { exports.AccountCreds = AccountCreds; }
