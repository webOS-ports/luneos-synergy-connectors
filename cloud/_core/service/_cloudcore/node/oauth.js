/* oauth.js - OAuth2 authorization code + PKCE (S256), generic from the provider's Config.
 *
 *   const oauth = createOAuth({ config, http });
 *   oauth.authorizeUrl(state)         -> { url, codeVerifier }
 *   await oauth.exchangeCode(code, codeVerifier) -> { accessToken, refreshToken, expiresIn, tokenType }
 *   await oauth.refresh(refreshToken)  -> the same shape
 *
 * Config keys, as _cloudcore/oauth2.js read them:
 *   AUTHORIZE_URL, TOKEN_URL, CLIENT_ID, REDIRECT_URI, SCOPE, STATE (the default state)
 *   CLIENT_SECRET     sent on the token calls only when set and not a PLACEHOLDER_..._SECRET
 *                     left by the build: a public PKCE client (Dropbox) has none.
 *   AUTHORIZE_EXTRA   appended to the authorize URL verbatim ("&token_access_type=offline" for
 *                     Dropbox, "&access_type=offline&prompt=consent" for Google)
 *   TOKEN_SEND_SCOPE  true: send scope on the token calls too (OneDrive); Google must not.
 *
 * The service exits while the user signs in on the web, so the verifier goes back to the caller
 * with the URL (getAuthorizeUrl) and comes back with the code (exchangeCode). The last one made
 * is also kept here, for a caller that does not carry it.
 * A token endpoint answer other than 200, or one without an access_token, is OAUTH_TOKEN_FAILED.
 */
"use strict";

const crypto = require("node:crypto");
const { CloudError } = require("./errors.js");

function hasSecret(config) {
	return typeof config.CLIENT_SECRET === "string" && config.CLIENT_SECRET !== "" &&
		config.CLIENT_SECRET.indexOf("PLACEHOLDER") !== 0;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const challengeOf = (verifier) => b64url(crypto.createHash("sha256").update(verifier).digest());

function createOAuth({ config, http, random = (n) => crypto.randomBytes(n) }) {
	let lastVerifier = null;

	function authorizeUrl(state) {
		const verifier = b64url(random(32));
		lastVerifier = verifier;
		const url = config.AUTHORIZE_URL +
			"?response_type=code" +
			"&client_id=" + encodeURIComponent(config.CLIENT_ID) +
			"&redirect_uri=" + encodeURIComponent(config.REDIRECT_URI) +
			"&scope=" + encodeURIComponent(config.SCOPE) +
			"&code_challenge=" + encodeURIComponent(challengeOf(verifier)) +
			"&code_challenge_method=S256" +
			(config.AUTHORIZE_EXTRA || "") +
			"&state=" + encodeURIComponent(state || config.STATE || "cloud");
		return { url, codeVerifier: verifier };
	}

	async function postToken(params) {
		const form = { client_id: config.CLIENT_ID };
		if (hasSecret(config)) { form.client_secret = config.CLIENT_SECRET; }
		if (config.TOKEN_SEND_SCOPE) { form.scope = config.SCOPE; }
		for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== null) { form[k] = v; } }
		const r = await http.request({ method: "POST", url: config.TOKEN_URL, form, errorCode: "OAUTH_TOKEN_FAILED",
			describe: (status, body) => "token endpoint answered HTTP " + status + tokenError(body) });
		let t = null;
		try { t = JSON.parse(r.text); } catch (e) { t = null; }
		if (r.status !== 200 || !t || typeof t !== "object" || !t.access_token) {
			throw new CloudError("OAUTH_TOKEN_FAILED", "token endpoint answered HTTP " + r.status + " without an access token",
				{ status: r.status });
		}
		return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, tokenType: t.token_type };
	}

	function exchangeCode(code, codeVerifier) {
		const verifier = codeVerifier || lastVerifier;
		lastVerifier = null;
		return postToken({ grant_type: "authorization_code", code, redirect_uri: config.REDIRECT_URI, code_verifier: verifier });
	}

	function refresh(refreshToken) {
		return postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
	}

	return { authorizeUrl, exchangeCode, refresh };
}

// The OAuth error code of a token endpoint's error body ("invalid_grant"), nothing else from it.
function tokenError(body) {
	try { const e = JSON.parse(body); return e && typeof e.error === "string" ? " (" + e.error.slice(0, 64) + ")" : ""; }
	catch (x) { return ""; }
}

module.exports = { createOAuth, hasSecret, challengeOf };
