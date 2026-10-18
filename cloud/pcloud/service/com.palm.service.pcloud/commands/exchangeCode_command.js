/*global Config, OAuth2, Adapter, console */
/* exchangeCode - the account VALIDATOR. Called by com.palm.service.accounts (via the generic
 * com.palm.app.cloud-auth webview) with the ?code=... captured from the OAuth2 redirect, PLUS
 * the region info the redirect carried (`hostname` and/or `locationid`) - cloud-auth forwards
 * those verbatim (see cloudAuth.js) so this LOCAL command can resolve the region.
 *
 * LOCAL to pCloud (not the _cloudcore generic exchangeCode): pCloud sends the account's data-
 * region host back in the authorize redirect. We resolve it here (redirect hostname wins; else
 * locationid; else the US default), do the token exchange ON THAT HOST, and STORE it in
 * credentials.common.apiHost so every later API call for this account uses the right region.
 * This region quirk is why pCloud cannot use the generic exchangeCode.
 *
 * Returns credentials in the shape the account DB stores and the Adapter later reads, PLUS a
 * username: accounts/handlers/create.js does Assert.require(args.username) and refuses to
 * create the account without one, so we fetch the pCloud account email here.
 */
function ExchangeCodeCommandAssistant() {}

ExchangeCodeCommandAssistant.prototype = {
	run: function (future) {
		var args = this.controller.args || {};
		if (!args.code) {
			future.setException({ returnValue: false, errorCode: "MISSING_CODE" });
			return;
		}
		// Resolve the region host from the redirect: an explicit pCloud hostname wins, else
		// map the locationid (1=US, 2=EU), else fall back to the US default host.
		var apiHost = Config.sanitizeHost(args.hostname) ||
			(args.locationid != null ? Config.hostForLocation(args.locationid) : Config.DEFAULT_API_HOST);

		// Do NOT future.nest(ex): nesting resolves `future` with the RAW token result the moment
		// ex completes, before the .then below can wrap it - so Accounts gets no `credentials`
		// and stores nothing. Instead resolve `future` ourselves, only with the wrapped shape.
		var ex = OAuth2.exchangeCode(args.code, apiHost);
		ex.then(this, function () {
			var t;
			try { t = ex.result; }               // throws if ex carried an exception
			catch (e) { future.setException(e); return; }
			var common = {
				accessToken: t.accessToken,
				apiHost:     t.apiHost || apiHost,      // region host for ALL later calls
				locationid:  (t.locationid != null ? t.locationid : args.locationid),
				uid:         t.uid
			};
			// Fetch the account identity (email) for `username`. Tolerate a failure here
			// (still create the account with a fallback) - we already have a valid token.
			// Adapter.getAccountInfo returns the normalised { user:{ emailAddress } } shape.
			var info = Adapter.getAccountInfo(common);
			info.then(this, function () {
				var u = {};
				try { u = (info.result && info.result.user) || {}; } catch (e2) { u = {}; }
				future.result = {
					returnValue: true,
					username:    u.emailAddress || "pCloud",
					credentials: { common: common }
				};
			});
		});
	}
};
