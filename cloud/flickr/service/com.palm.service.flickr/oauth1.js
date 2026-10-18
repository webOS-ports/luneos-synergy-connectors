/*global IMPORTS, Config, HttpCurl, require, console */
/* oauth1.js - OAuth 1.0a (3-legged, HMAC-SHA1) signer + token dance for Flickr.
 *
 * WHY OAuth 1.0a and not PKCE/OAuth2: Flickr never adopted OAuth2 - its only modern
 * auth is OAuth 1.0a. That means a real CONSUMER SECRET is required (it is half of the
 * HMAC signing key), unlike the Dropbox public-client/PKCE model. See config.js.
 *
 * THE KEY ARCHITECTURE POINT: the signature itself (HMAC-SHA1) is computed HERE, in
 * node. HMAC-SHA1 is an old algorithm that the device's OpenSSL-0.9.8k node runtime
 * supports via crypto.createHmac('sha1', key). Only the resulting *signed* HTTPS GET is
 * handed to the modern curl (HttpCurl) for the TLS transport - node never opens a
 * modern TLS socket. So: build base string + signature in JS, curl does the wire.
 *
 * The 3-legged flow (all three legs are signed GETs through curl):
 *   1. getRequestToken()  -> GET request_token  (signed with consumer secret only)
 *        returns a temporary { oauthToken, oauthTokenSecret }
 *   2. the user approves at AUTHORIZE_URL?oauth_token=<reqToken>&perms=read  (in Atlas);
 *        Flickr redirects to CALLBACK_URL?oauth_token=<reqToken>&oauth_verifier=<v>
 *   3. getAccessToken(reqToken, reqTokenSecret, verifier) -> GET access_token
 *        (signed with consumer secret & the REQUEST token secret, carrying oauth_verifier)
 *        returns the long-lived { oauthToken, oauthTokenSecret, userId, username, fullname }
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

// crypto.createHmac('sha1', key) exists on the device node (HMAC-SHA1 is old). fs is
// used for a strong nonce from /dev/urandom (node 0.4.x lacks crypto.randomBytes),
// with a Math.random fallback if /dev/urandom is somehow unavailable.
var _reqf = (typeof require !== "undefined") ? require : (IMPORTS.require || null);
var _crypto = _reqf ? _reqf("crypto") : null;
var _fs = _reqf ? _reqf("fs") : null;

var OAuth1 = {

	// --- RFC 3986 percent-encoding ------------------------------------------------
	// OAuth 1.0a requires strict RFC 3986 encoding: only A-Z a-z 0-9 - _ . ~ are left
	// literal; EVERYTHING else is %XX (uppercase hex). encodeURIComponent already does
	// this except it leaves ! * ' ( ) literal, so we escape those four extra chars.
	// (~ is unreserved in RFC 3986 and encodeURIComponent correctly leaves it literal.)
	percentEncode: function (str) {
		return encodeURIComponent(String(str)).replace(/[!*'()]/g, function (c) {
			return "%" + c.charCodeAt(0).toString(16).toUpperCase();
		});
	},

	// --- signature base string ----------------------------------------------------
	// base = METHOD & percentEncode(baseUrl) & percentEncode(sortedParamString)
	// where sortedParamString = k1=v1&k2=v2&... with each k and v percent-encoded, and
	// the pairs sorted by encoded key, then by encoded value (lexicographic byte order).
	// `params` is a plain object; oauth_signature must NOT be present in it.
	buildBaseString: function (method, baseUrl, params) {
		var self = this;
		var pairs = [];
		Object.keys(params).forEach(function (k) {
			if (params[k] === null || params[k] === undefined) { return; }
			pairs.push({ k: self.percentEncode(k), v: self.percentEncode(params[k]) });
		});
		pairs.sort(function (a, b) {
			if (a.k < b.k) { return -1; }
			if (a.k > b.k) { return 1; }
			if (a.v < b.v) { return -1; }
			if (a.v > b.v) { return 1; }
			return 0;
		});
		var paramString = pairs.map(function (p) { return p.k + "=" + p.v; }).join("&");
		return method.toUpperCase() + "&" +
			this.percentEncode(baseUrl) + "&" +
			this.percentEncode(paramString);
	},

	// --- HMAC-SHA1 signature ------------------------------------------------------
	// key = percentEncode(consumerSecret) & percentEncode(tokenSecret)   (tokenSecret
	// may be "" for the request-token leg; the trailing '&' is ALWAYS present). Returns
	// the base64 digest (the value that becomes oauth_signature before URL-encoding).
	sign: function (method, baseUrl, params, tokenSecret) {
		if (!_crypto) {
			throw { returnValue: false, errorCode: "NO_CRYPTO",
				detail: "crypto.createHmac('sha1') needed for OAuth 1.0a signing" };
		}
		var base = this.buildBaseString(method, baseUrl, params);
		var key = this.percentEncode(Config.CONSUMER_SECRET) + "&" +
			this.percentEncode(tokenSecret || "");
		return _crypto.createHmac("sha1", key).update(base).digest("base64");
	},

	// --- helpers ------------------------------------------------------------------
	_timestamp: function () { return Math.floor(Date.now() / 1000).toString(); },

	_nonce: function () {
		if (_fs) {
			try {
				var fd = _fs.openSync("/dev/urandom", "r");
				var buf = new Buffer(16);
				_fs.readSync(fd, buf, 0, 16, 0);
				_fs.closeSync(fd);
				return buf.toString("hex");
			} catch (e) { /* fall through to Math.random */ }
		}
		return (Date.now().toString(16) +
			Math.floor(Math.random() * 0xffffffff).toString(16) +
			Math.floor(Math.random() * 0xffffffff).toString(16));
	},

	// Build a fully-signed request URL: merges the standard oauth_* params with the
	// caller's `extraParams` (e.g. oauth_callback, oauth_verifier, or REST api params),
	// signs, appends oauth_signature, and returns baseUrl + "?" + full query string.
	// `token` / `tokenSecret` are optional (omit both for the request-token leg).
	signedUrl: function (method, baseUrl, extraParams, token, tokenSecret) {
		var self = this;
		var params = {
			oauth_consumer_key:     Config.CONSUMER_KEY,
			oauth_nonce:            this._nonce(),
			oauth_signature_method: "HMAC-SHA1",
			oauth_timestamp:        this._timestamp(),
			oauth_version:          "1.0"
		};
		if (token) { params.oauth_token = token; }
		if (extraParams) {
			Object.keys(extraParams).forEach(function (k) {
				if (extraParams[k] !== null && extraParams[k] !== undefined) {
					params[k] = extraParams[k];
				}
			});
		}
		params.oauth_signature = this.sign(method, baseUrl, params, tokenSecret);

		var query = Object.keys(params).map(function (k) {
			return self.percentEncode(k) + "=" + self.percentEncode(params[k]);
		}).join("&");
		return baseUrl + "?" + query;
	},

	// Parse an application/x-www-form-urlencoded body (Flickr's token endpoints reply
	// with one, e.g. "oauth_token=...&oauth_token_secret=...&oauth_callback_confirmed=true").
	_parseForm: function (text) {
		var out = {};
		(text || "").split("&").forEach(function (pair) {
			if (!pair) { return; }
			var eq = pair.indexOf("=");
			var k = eq >= 0 ? pair.substring(0, eq) : pair;
			var v = eq >= 0 ? pair.substring(eq + 1) : "";
			out[decodeURIComponent(k)] = decodeURIComponent(v);
		});
		return out;
	},

	// --- leg 1: temporary request token -------------------------------------------
	// GET request_token with oauth_callback, signed with consumer secret only.
	// Resolves to { oauthToken, oauthTokenSecret }.
	getRequestToken: function () {
		var self = this;
		var f = new Future();
		var url = this.signedUrl("GET", Config.REQUEST_TOKEN_URL,
			{ oauth_callback: Config.CALLBACK_URL }, null, "");
		f.now(this, function () { return HttpCurl.request({ method: "GET", url: url }); });
		f.then(this, function () {
			var r = f.result;
			if (!r || r.status !== 200) {
				if (typeof console !== "undefined") {
					console.log("flickr: request_token failed status=" + (r && r.status) +
						" body=" + (r && r.responseText));
				}
				f.setException({ returnValue: false, errorCode: "OAUTH_REQUEST_TOKEN_FAILED",
					status: r && r.status, body: r && r.responseText });
				return;
			}
			var p = self._parseForm(r.responseText);
			if (!p.oauth_token || !p.oauth_token_secret) {
				f.setException({ returnValue: false, errorCode: "OAUTH_REQUEST_TOKEN_MALFORMED",
					body: r.responseText });
				return;
			}
			f.result = { oauthToken: p.oauth_token, oauthTokenSecret: p.oauth_token_secret };
		});
		return f;
	},

	// --- leg 3: exchange the verifier for the long-lived access token -------------
	// GET access_token, signed with consumer secret & the REQUEST token secret, carrying
	// the request token + oauth_verifier. Resolves to
	// { oauthToken, oauthTokenSecret, userId, username, fullname }.
	getAccessToken: function (requestToken, requestTokenSecret, verifier) {
		var self = this;
		var f = new Future();
		var url = this.signedUrl("GET", Config.ACCESS_TOKEN_URL,
			{ oauth_verifier: verifier }, requestToken, requestTokenSecret);
		f.now(this, function () { return HttpCurl.request({ method: "GET", url: url }); });
		f.then(this, function () {
			var r = f.result;
			if (!r || r.status !== 200) {
				if (typeof console !== "undefined") {
					console.log("flickr: access_token failed status=" + (r && r.status) +
						" body=" + (r && r.responseText));
				}
				f.setException({ returnValue: false, errorCode: "OAUTH_ACCESS_TOKEN_FAILED",
					status: r && r.status, body: r && r.responseText });
				return;
			}
			// Flickr's access_token reply also carries user identity inline:
			//   oauth_token, oauth_token_secret, user_nsid, username, fullname
			var p = self._parseForm(r.responseText);
			if (!p.oauth_token || !p.oauth_token_secret) {
				f.setException({ returnValue: false, errorCode: "OAUTH_ACCESS_TOKEN_MALFORMED",
					body: r.responseText });
				return;
			}
			f.result = {
				oauthToken:       p.oauth_token,
				oauthTokenSecret: p.oauth_token_secret,
				userId:           p.user_nsid || null,
				username:         p.username || null,
				fullname:         p.fullname || null
			};
		});
		return f;
	},

	// Build the browser consent URL for leg 2 (no signing needed - the request token is
	// the credential here). Atlas loads this; the user approves; Flickr redirects to
	// CALLBACK_URL with oauth_token + oauth_verifier.
	buildAuthorizeUrl: function (requestToken) {
		return Config.AUTHORIZE_URL +
			"?oauth_token=" + this.percentEncode(requestToken) +
			"&perms="       + this.percentEncode(Config.PERMS);
	}
};

if (typeof exports !== "undefined") { exports.OAuth1 = OAuth1; }
