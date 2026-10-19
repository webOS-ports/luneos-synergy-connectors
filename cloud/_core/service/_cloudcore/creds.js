/*global IMPORTS, console */
/* creds.js - resolve/persist Google Drive account credentials from the service side.
 *
 * A consumer app can pass raw { credentials:{common:{...}} }, OR just an { accountId }
 * and let the service read the stored tokens itself. The latter keeps tokens out of the
 * app and lets the service persist a refreshed token straight back to the account.
 * Requires com.palm.service.gdrive in the template read+writePermissions (the accounts
 * service permission-checks readCredentials/writeCredentials against those lists).
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;
var PalmCall = Foundations.Comms.PalmCall;

var AccountCreds = {
	// resolve(args) -> Future resolving to the `common` credentials object.
	resolve: function (args) {
		var f = new Future();
		if (args.credentials && args.credentials.common && args.credentials.common.accessToken) {
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
			if (!c || !c.accessToken) {
				f.setException({ returnValue: false, errorCode: "NO_STORED_CREDENTIALS", detail: r });
				return;
			}
			f.result = c;
		});
		return f;
	},

	// Persist refreshed tokens back to the account (best-effort; only when we own accountId).
	// Never throws: the commands call it from inside a Future callback just before replying,
	// where a throw would be kept on that Future and the reply never sent.
	save: function (accountId, common) {
		var d;
		if (!accountId || !common) { d = new Future(); d.result = { returnValue: false }; return d; }
		try {
			return PalmCall.call("palm://com.palm.service.accounts/", "writeCredentials",
				{ accountId: accountId, name: "common", credentials: common });
		} catch (e) {
			if (typeof console !== "undefined") { console.log("AccountCreds.save failed: " + ((e && e.message) || e)); }
			d = new Future(); d.result = { returnValue: false }; return d;
		}
	}
};

if (typeof exports !== "undefined") { exports.AccountCreds = AccountCreds; }
