/* adapter.js - the Flickr REST API, and the account's credentials, for service.js.
 *
 * Every REST call is an OAuth 1.0a signed GET (oauth1.js) to Config.REST_URL with method,
 * api_key (= CONSUMER_KEY), format=json and nojsoncallback=1, so the user's private sets and
 * photos are visible. A reply outside 2xx is FLICKR_HTTP_ERROR (with its status), a body that
 * is not JSON FLICKR_BAD_JSON, and Flickr's own failure - HTTP 200 with
 * { stat:"fail", code, message } - FLICKR_API_FAIL with the code and message in the errorText.
 *
 * Credentials ("common", as exchangeCode stores them): { oauthToken, oauthTokenSecret, userId,
 * username, fullname }. They do not expire and are never renewed. A caller passes them inline
 * as credentials.common, or an accountId, and the service reads them from Accounts (it is in
 * the template's readPermissions): _cloudcore/node's account store wants an OAuth2 accessToken,
 * so Flickr reads them itself, the same way.
 */
"use strict";

const ERROR = "FLICKR_HTTP_ERROR";
const ACCOUNTS = "luna://com.palm.service.accounts/";

// Extras Flickr inlines on every photo, so listPhotos needs no call per photo.
const PHOTO_EXTRAS = "url_o,url_b,url_c,o_dims,original_format,media,last_update";

const oneLine = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; };

// The errorText of a REST reply outside 2xx. The URL is not in it: its query holds the token.
function describe(status, body) {
	const b = oneLine(body, 200);
	return "Flickr answered HTTP " + status + (b ? ": " + b : "");
}

// The account's credentials: inline (with an oauthToken), or read from Accounts by accountId.
async function resolveCredentials(call, errors, args) {
	args = args || {};
	const inline = args.credentials && args.credentials.common;
	if (inline && inline.oauthToken) { return inline; }
	if (!args.accountId) { throw new errors.CloudError("NO_CREDENTIALS", "pass credentials or accountId"); }
	// The reply may carry them as credentials, credentials.common or common.
	const r = await call(ACCOUNTS + "readCredentials", { accountId: args.accountId, name: "common" });
	let c = (r && r.credentials) || r || {};
	if (c && c.common) { c = c.common; }
	if (!c || !c.oauthToken) { throw new errors.CloudError("NO_STORED_CREDENTIALS", "the account has no stored Flickr token"); }
	return c;
}

function createAdapter({ config, http, errors, oauth1 }) {
	async function rest(method, params, creds) {
		const all = { method, api_key: config.CONSUMER_KEY, format: "json", nojsoncallback: "1" };
		for (const [k, v] of Object.entries(params || {})) { if (v !== null && v !== undefined) { all[k] = v; } }
		const url = oauth1.signedUrl("GET", config.REST_URL, all, creds && creds.oauthToken, creds && creds.oauthTokenSecret);
		const r = await http.request({ method: "GET", url });
		let data;
		try { data = r.text ? JSON.parse(r.text) : {}; }
		catch (e) { throw new errors.CloudError("FLICKR_BAD_JSON", method + ": the reply is not JSON", { status: r.status }); }
		if (data && typeof data === "object" && data.stat && data.stat !== "ok") {
			throw new errors.CloudError("FLICKR_API_FAIL", "Flickr " + method + " failed" +
				(data.code !== undefined ? " (code " + oneLine(data.code, 16) + ")" : "") +
				(data.message ? ": " + oneLine(data.message, 200) : ""));
		}
		return data;
	}

	return {
		rest,
		// The calling user, on tokens that still sign valid requests.
		testLogin: (creds) => rest("flickr.test.login", null, creds),
		listPhotosets: (creds) => rest("flickr.photosets.getList", { user_id: "me" }, creds),
		photosetPhotos: (creds, photosetId) => rest("flickr.photosets.getPhotos",
			{ photoset_id: photosetId, user_id: "me", extras: PHOTO_EXTRAS, per_page: "500" }, creds),
		allPhotos: (creds, perPage) => rest("flickr.people.getPhotos",
			{ user_id: "me", extras: PHOTO_EXTRAS, per_page: (perPage || "500") }, creds),
	};
}

module.exports = Object.assign(createAdapter, { ERROR, ACCOUNTS, PHOTO_EXTRAS, describe, resolveCredentials });
