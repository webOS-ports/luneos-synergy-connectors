/*global MegaApi, Adapter, Config, console */
/* login - the account VALIDATOR for Mega (replaces the OAuth getAuthorizeUrl/exchangeCode pair
 * the other connectors use). Mega has no OAuth: the mega-auth customUI collects the account
 * EMAIL + PASSWORD and calls this command, which runs the us0/us handshake (MegaApi.login) and
 * returns credentials in the exact shape Accounts stores and the Adapter later reads:
 *   { returnValue, username, alias?, credentials: { common: { accessToken(sid), mk, email } } }
 * The password NEVER leaves the device or gets stored - only the derived session id + master key.
 */
function LoginCommandAssistant() {}

LoginCommandAssistant.prototype = {
	run: function (future) {
		var args = this.controller.args || {};
		var email = args.email || args.username;
		var password = args.password;
		if (!email || !password) {
			future.setException({ returnValue: false, errorCode: "MISSING_CREDENTIALS",
				detail: "need email and password" });
			return;
		}
		var lf = MegaApi.login(email, password, args.mfa);
		lf.then(this, function () {
			var creds;
			try { creds = lf.result; }               // throws on the mapped login errors
			catch (e) { future.setException(e); return; }
			// Fetch the account identity for `username`/`alias` (best-effort - we already have a
			// valid session; a failure here shouldn't block account creation).
			var info = Adapter.getAccountInfo(creds);
			info.then(this, function () {
				var u = {};
				try { u = (info.result && info.result.user) || {}; } catch (e2) { u = {}; }
				// Persist the display name so getAccountInfo can return it without another `ug`.
				if (u.displayName) { creds.name = u.displayName; }
				future.result = {
					returnValue: true,
					username:    u.emailAddress || creds.email || (Config && Config.DISPLAY_NAME) || "MEGA",
					alias:       u.displayName || undefined,
					credentials: { common: creds }
				};
			});
		});
	}
};
