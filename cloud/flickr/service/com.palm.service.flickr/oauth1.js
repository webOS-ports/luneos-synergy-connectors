/* oauth1.js - OAuth 1.0a (RFC 5849, HMAC-SHA1) for Flickr, which never adopted OAuth2.
 *
 *   const o = createOAuth1({ config, http, errors, random, now });
 *   o.signedUrl("GET", url, params, token, tokenSecret)  -> url?<params, oauth_*, oauth_signature>
 *   await o.getRequestToken()                  -> { oauthToken, oauthTokenSecret }          (leg 1)
 *   o.authorizeUrl(requestToken)               -> AUTHORIZE_URL?oauth_token=..&perms=..      (leg 2)
 *   await o.getAccessToken(reqToken, reqSecret, verifier)
 *        -> { oauthToken, oauthTokenSecret, userId, username, fullname }                    (leg 3)
 *
 * The consumer secret is half of the signing key, so Flickr has no public client: config.js
 * carries CONSUMER_KEY and CONSUMER_SECRET. Every request is a signed GET with the oauth_*
 * parameters in the query string, as before.
 *
 * Signing (RFC 5849 3.4):
 *   percentEncode  RFC 3986: only A-Z a-z 0-9 - . _ ~ stay literal, everything else is %XX in
 *                  upper case over UTF-8: encodeURIComponent, plus ! * ' ( ).
 *   base string    METHOD & enc(url) & enc(k1=v1&k2=v2...), each key and value encoded, the
 *                  pairs sorted by encoded key, then by encoded value, in byte order. The url is
 *                  used as given (Config's are lower case, without port or query).
 *   key            enc(consumerSecret) & enc(tokenSecret), the "&" there even without a token.
 *   signature      base64(HMAC-SHA1(key, base string)).
 *
 * Flickr's tokens do not expire and there is no refresh. The token endpoints answer form
 * encoded: anything but a 200 is OAUTH_*_TOKEN_FAILED (with the status), a 200 without
 * oauth_token and oauth_token_secret is OAUTH_*_TOKEN_MALFORMED. Neither puts the reply into
 * the errorText or the log: a malformed one may hold half a token.
 */
"use strict";

const crypto = require("node:crypto");

// A value encodeURIComponent cannot take (a lone surrogate from the payload) is the caller's
// error, not the connector's: an error with an errorCode replies as that code (errors.toReply).
function percentEncode(str) {
	let s;
	try { s = encodeURIComponent(String(str)); }
	catch (e) {
		throw Object.assign(new Error("a request parameter is not valid Unicode"),
			{ errorCode: "BAD_ARGS", errorText: "a request parameter is not valid Unicode" });
	}
	return s.replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// params: an object, or a list of [key, value] (where a key may repeat); null and undefined
// values are left out. oauth_signature must not be in it.
function pairsOf(params) {
	const list = Array.isArray(params) ? params : Object.entries(params || {});
	return list.filter(([, v]) => v !== null && v !== undefined);
}

function buildBaseString(method, baseUrl, params) {
	const pairs = pairsOf(params).map(([k, v]) => ({ k: percentEncode(k), v: percentEncode(v) }));
	pairs.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
	const paramString = pairs.map((p) => p.k + "=" + p.v).join("&");
	return String(method).toUpperCase() + "&" + percentEncode(baseUrl) + "&" + percentEncode(paramString);
}

function signingKey(consumerSecret, tokenSecret) {
	return percentEncode(consumerSecret || "") + "&" + percentEncode(tokenSecret || "");
}

function sign(method, baseUrl, params, consumerSecret, tokenSecret) {
	return crypto.createHmac("sha1", signingKey(consumerSecret, tokenSecret))
		.update(buildBaseString(method, baseUrl, params)).digest("base64");
}

// An application/x-www-form-urlencoded token reply; null when an escape in it is malformed.
function parseForm(text) {
	const out = {};
	try {
		for (const pair of String(text || "").split("&")) {
			if (!pair) { continue; }
			const eq = pair.indexOf("=");
			const k = eq >= 0 ? pair.substring(0, eq) : pair;
			const v = eq >= 0 ? pair.substring(eq + 1) : "";
			out[decodeURIComponent(k)] = decodeURIComponent(v);
		}
	} catch (e) { return null; }
	return out;
}

function createOAuth1({ config, http, errors, random = (n) => crypto.randomBytes(n), now = () => Date.now(), log = console }) {
	const nonce = () => Buffer.from(random(16)).toString("hex");
	const timestamp = () => String(Math.floor(now() / 1000));

	function signedUrl(method, baseUrl, extraParams, token, tokenSecret) {
		const params = {
			oauth_consumer_key: config.CONSUMER_KEY,
			oauth_nonce: nonce(),
			oauth_signature_method: "HMAC-SHA1",
			oauth_timestamp: timestamp(),
			oauth_version: "1.0",
		};
		if (token) { params.oauth_token = token; }
		for (const [k, v] of pairsOf(extraParams)) { params[k] = v; }
		params.oauth_signature = sign(method, baseUrl, params, config.CONSUMER_SECRET, tokenSecret);
		return baseUrl + "?" + Object.keys(params).map((k) => percentEncode(k) + "=" + percentEncode(params[k])).join("&");
	}

	// One token leg: the signed GET, its form reply, oauth_token and oauth_token_secret in it.
	async function tokenLeg(url, failed, malformed, leg) {
		const what = "Flickr's " + leg + " endpoint";
		const r = await http.request({ method: "GET", url, errorCode: failed,
			describe: (status) => what + " answered HTTP " + status });
		if (r.status !== 200) { throw new errors.CloudError(failed, what + " answered HTTP " + r.status, { status: r.status }); }
		const p = parseForm(r.text);
		if (!p || !p.oauth_token || !p.oauth_token_secret) {
			log.log("flickr: " + leg + " reply without oauth_token/oauth_token_secret");
			throw new errors.CloudError(malformed, what + " answered without a token");
		}
		return p;
	}

	async function getRequestToken() {
		const url = signedUrl("GET", config.REQUEST_TOKEN_URL, { oauth_callback: config.CALLBACK_URL }, null, "");
		const p = await tokenLeg(url, "OAUTH_REQUEST_TOKEN_FAILED", "OAUTH_REQUEST_TOKEN_MALFORMED", "request_token");
		return { oauthToken: p.oauth_token, oauthTokenSecret: p.oauth_token_secret };
	}

	// Flickr's access_token reply carries the user as well: user_nsid, username, fullname.
	async function getAccessToken(requestToken, requestTokenSecret, verifier) {
		const url = signedUrl("GET", config.ACCESS_TOKEN_URL, { oauth_verifier: verifier }, requestToken, requestTokenSecret);
		const p = await tokenLeg(url, "OAUTH_ACCESS_TOKEN_FAILED", "OAUTH_ACCESS_TOKEN_MALFORMED", "access_token");
		return { oauthToken: p.oauth_token, oauthTokenSecret: p.oauth_token_secret,
			userId: p.user_nsid || null, username: p.username || null, fullname: p.fullname || null };
	}

	// The consent page. The request token is the credential there; nothing is signed.
	function authorizeUrl(requestToken) {
		return config.AUTHORIZE_URL + "?oauth_token=" + percentEncode(requestToken) + "&perms=" + percentEncode(config.PERMS);
	}

	return { signedUrl, getRequestToken, getAccessToken, authorizeUrl };
}

module.exports = { createOAuth1, percentEncode, buildBaseString, signingKey, sign, parseForm };
