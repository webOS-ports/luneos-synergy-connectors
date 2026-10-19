/* creds.js - a request's credentials, and running provider calls with them.
 *
 *   const store = createAccountStore({ call: bus.call });
 *   const creds = await store.resolve(params)      // params.credentials.common, or readCredentials
 *   await store.save(accountId, creds)              // writeCredentials, best effort
 *
 *   const s = new Session(creds, { refresh: oauth.refresh });
 *   await s.authorized((token) => http.json({ ..., bearer: token }))
 *   s.renewed   // null, or the credentials after a refresh (to save and to report)
 *
 * A consumer passes either { credentials: { common: {...} } } or just { accountId } and lets the
 * service read the stored tokens itself: that keeps tokens out of the apps, and lets a refreshed
 * token go straight back to the account. The service's id must be in the template's read- and
 * writePermissions for that (the Accounts service checks them).
 *
 * Session.authorized: a call answered 401 (an HttpError, status 401) is retried once after one
 * refresh of the token, when the credentials have a refresh token and a refresh function was
 * given; the next calls in the same session use the new token. Every other failure - the call's,
 * the refresh's, the retry's - is thrown as it is.
 */
"use strict";

const { CloudError } = require("./errors.js");

const ACCOUNTS = "luna://com.palm.service.accounts/";

function createAccountStore({ call, log = console }) {
	async function resolve(args) {
		args = args || {};
		const inline = args.credentials && args.credentials.common;
		if (inline && inline.accessToken) { return inline; }
		if (!args.accountId) { throw new CloudError("NO_CREDENTIALS", "pass credentials or accountId"); }
		// exchangeCode's credentials were saved under "common" (accounts stores each top-level
		// key of the credentials object). The reply may carry them as credentials, credentials.common
		// or common - all three are taken.
		const r = await call(ACCOUNTS + "readCredentials", { accountId: args.accountId, name: "common" });
		let c = (r && r.credentials) || r || {};
		if (c && c.common) { c = c.common; }
		if (!c || !c.accessToken) { throw new CloudError("NO_STORED_CREDENTIALS", "the account has no stored access token"); }
		return c;
	}

	// Never throws: a token that cannot be saved is logged, and the request still answers.
	async function save(accountId, common) {
		if (!accountId || !common) { return false; }
		try {
			await call(ACCOUNTS + "writeCredentials", { accountId, name: "common", credentials: common });
			return true;
		} catch (e) {
			log.error("writeCredentials for account " + accountId + " failed: " + ((e && e.errorCode) || (e && e.message) || e));
			return false;
		}
	}

	return { resolve, save };
}

// The credentials after a token response: the old ones with the new tokens over them (a provider
// that does not rotate the refresh token leaves it out of the response).
function renewedFrom(creds, t, now = Date.now()) {
	const out = Object.assign({}, creds, {
		accessToken: t.accessToken,
		refreshToken: t.refreshToken || creds.refreshToken,
	});
	if (typeof t.expiresIn === "number" && isFinite(t.expiresIn)) { out.expiresAt = now + t.expiresIn * 1000; }
	return out;
}

class Session {
	constructor(creds, { refresh = null } = {}) {
		this.creds = creds;
		this.renewed = null;
		this._refresh = refresh;
	}

	get accessToken() { return this.creds.accessToken; }

	async authorized(fn) {
		try {
			return await fn(this.creds.accessToken, this.creds);
		} catch (e) {
			if (!(e && e.status === 401) || !this._refresh || !this.creds.refreshToken) { throw e; }
		}
		const t = await this._refresh(this.creds.refreshToken);
		this.creds = renewedFrom(this.creds, t);
		this.renewed = this.creds;
		return fn(this.creds.accessToken, this.creds);
	}
}

module.exports = { createAccountStore, Session, renewedFrom, ACCOUNTS };
