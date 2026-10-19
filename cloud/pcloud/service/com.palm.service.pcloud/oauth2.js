/* oauth2.js - pCloud's own getAuthorizeUrl and exchangeCode, in place of _cloudcore/node's.
 *
 * The generic ones (_cloudcore/node/oauth.js + commands.js) cannot serve pCloud:
 *   1. NO PKCE. pCloud does not support the S256 code_challenge; the code->token exchange
 *      authenticates with the shipped client_secret instead, so there is no verifier to make or
 *      carry: getAuthorizeUrl answers { url } only.
 *   2. NO REFRESH. pCloud access tokens are long-lived and there is no refresh token or refresh
 *      endpoint; a token works until the user revokes the app. Config has no TOKEN_URL, so the
 *      connector has no oauth and no session ever refreshes.
 *   3. REGION HOST. The token exchange must go to the account's region host (api.pcloud.com or
 *      eapi.pcloud.com), which the authorize redirect names (hostname, locationid). The sign-in
 *      app (com.palm.app.cloud-auth) forwards both to exchangeCode, which picks the host - a
 *      pCloud hostname from the redirect wins, else the locationid's host, else the US one -
 *      posts the code to https://<host>/oauth2_token, and stores the host in the credentials
 *      (common.apiHost) for every later call.
 *
 *   getAuthorizeUrl { state? }                         -> { url }                                   open
 *   exchangeCode    { code, hostname?, locationid? }   -> { username, credentials:{ common:
 *                                                          { accessToken, apiHost, locationid, uid } } } open
 *
 * Both are open, as they were: Accounts calls exchangeCode with no app id, and the sign-in
 * app's calls arrive as com.palm.app.accounts-<pid>.
 */
"use strict";

const TIMEOUT_MS = 60000;

// deps: connector.js's, plus core (_cloudcore/node).
function authMethods({ core, config, http, adapter }) {
	const { CloudError, Session } = core;

	function authorizeUrl(state) {
		return config.AUTHORIZE_URL +
			"?response_type=code" +
			"&client_id=" + encodeURIComponent(config.CLIENT_ID) +
			"&redirect_uri=" + encodeURIComponent(config.REDIRECT_URI) +
			"&state=" + encodeURIComponent(state || config.STATE || "pcloud");
	}

	// POST https://<apiHost>/oauth2_token { client_id, client_secret, code }. A reply other than
	// 200, one that is not JSON, a nonzero result, or no access_token is OAUTH_TOKEN_FAILED.
	async function token(code, apiHost) {
		const host = config.sanitizeHost(apiHost) || config.DEFAULT_API_HOST;
		const r = await http.request({ method: "POST", url: "https://" + host + config.TOKEN_PATH,
			form: { client_id: config.CLIENT_ID, client_secret: config.CLIENT_SECRET, code },
			errorCode: "OAUTH_TOKEN_FAILED", describe: (status) => "pCloud token endpoint answered HTTP " + status });
		let t = null;
		try { t = JSON.parse(r.text); } catch (e) { t = null; }
		if (r.status !== 200 || !t || typeof t !== "object") {
			throw new CloudError("OAUTH_TOKEN_FAILED", "pCloud token endpoint answered HTTP " + r.status + " without JSON", { status: r.status });
		}
		if (t.result && t.result !== 0) {
			throw new CloudError("OAUTH_TOKEN_FAILED", "pCloud token endpoint: error " + t.result +
				(t.error ? ": " + String(t.error).slice(0, 200) : ""), { result: t.result });
		}
		if (!t.access_token) { throw new CloudError("OAUTH_TOKEN_FAILED", "pCloud token endpoint answered without an access token"); }
		return { accessToken: t.access_token, uid: t.userid || t.uid, locationid: t.locationid, apiHost: host };
	}

	return {
		getAuthorizeUrl: { timeoutMs: 30000, handler: async (p) => ({ url: authorizeUrl(p.state || "pcloud") }) },

		// The account validator. The identity is only a nicety once the token is there: without
		// it the account is made as "pCloud".
		exchangeCode: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			if (!p.code) { throw new CloudError("MISSING_CODE", "need code"); }
			const apiHost = config.sanitizeHost(p.hostname) ||
				((p.locationid !== undefined && p.locationid !== null) ? config.hostForLocation(p.locationid) : config.DEFAULT_API_HOST);
			const t = await token(p.code, apiHost);
			const common = { accessToken: t.accessToken, apiHost: t.apiHost || apiHost,
				locationid: (t.locationid !== undefined && t.locationid !== null) ? t.locationid : p.locationid, uid: t.uid };
			let u = {};
			try { u = ((await adapter.getAccountInfo(new Session(common))) || {}).user || {}; } catch (e) { u = {}; }
			return { username: u.emailAddress || "pCloud", credentials: { common } };
		} },
	};
}

module.exports = authMethods;
