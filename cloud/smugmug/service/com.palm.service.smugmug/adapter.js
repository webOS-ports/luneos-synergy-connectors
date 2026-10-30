/* adapter.js - the SmugMug API v2, and the account's credentials, for service.js.
 *
 * Every call is an OAuth 1.0a signed GET (oauth1.js) of Config.API_URL + a path, with
 * Accept: application/json; the reply is { Code, Message, Response: {...} } and the adapter
 * gives Response. A reply outside 2xx is SMUGMUG_HTTP_ERROR (with its status), a body that is
 * not JSON SMUGMUG_BAD_JSON.
 *
 * SmugMug echoes the request in Response.Uri - the whole signed query, oauth_token and
 * signature included - and does so in error replies too. So no reply body goes into an
 * errorText or the log: an error carries SmugMug's Message alone.
 *
 * Lists come in pages (?start=1&count=N, Response.Pages { Total, Start, Count, NextPage }); all()
 * follows them up to MAX_ITEMS. An _expand'ed object comes beside Response, in Expansions keyed
 * by its Uri, so albumImages asks for LargestImage in the same request and puts its Url on each
 * image as LargestImageUrl.
 *
 * Credentials ("common", as exchangeCode stores them): { oauthToken, oauthTokenSecret, userId,
 * username, fullname }, userId being the user's NickName, which the album list is under. They
 * do not expire and are never renewed. A caller passes them inline as credentials.common, or
 * an accountId, and the service reads them from Accounts (it is in the template's
 * readPermissions): _cloudcore/node's account store wants an OAuth2 accessToken, so SmugMug
 * reads them itself, the same way.
 */
"use strict";

const ERROR = "SMUGMUG_HTTP_ERROR";
const ACCOUNTS = "luna://com.palm.service.accounts/";
const PAGE = 100;
const MAX_ITEMS = 5000;

const oneLine = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; };

// SmugMug's Message from a reply body, never the body itself (it holds the signed query). An
// OAuth failure's Message is "oauth_problem=<name>&debug_sbs=<the signature base string>", the
// base string holding the token: only the problem's name is kept, and a Message carrying any
// other oauth_ parameter is dropped.
function messageOf(body) {
	let m;
	try {
		const d = JSON.parse(body);
		m = (d && typeof d === "object" && typeof d.Message === "string") ? d.Message : "";
	} catch (e) { return ""; }
	const problem = m.match(/(?:^|&)oauth_problem=([A-Za-z0-9_]+)/);
	if (problem) { return "oauth_problem=" + problem[1]; }
	return /oauth_|debug_sbs/i.test(m) ? "" : oneLine(m, 200);
}

// The errorText of a reply outside 2xx.
function describe(status, body) {
	const m = messageOf(body);
	return "SmugMug answered HTTP " + status + (m ? ": " + m : "");
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
	if (!c || !c.oauthToken) { throw new errors.CloudError("NO_STORED_CREDENTIALS", "the account has no stored SmugMug token"); }
	return c;
}

// A path segment of the caller's (a NickName, an AlbumKey), encoded so it stays one segment.
function segment(errors, what, v) {
	if (typeof v !== "string" || !v) { throw errors.badArgs(what + ": a non-empty string"); }
	return encodeURIComponent(v);
}

// The image with the Url of its expanded LargestImage, where the reply has one.
function withLargest(img, exp) {
	const ref = img.Uris && img.Uris.LargestImage && img.Uris.LargestImage.Uri;
	const e = ref && exp[ref];
	const url = e && e.LargestImage && e.LargestImage.Url;
	return typeof url === "string" ? Object.assign({}, img, { LargestImageUrl: url }) : img;
}

function createAdapter({ config, http, errors, oauth1 }) {
	// The whole reply: { Response, Expansions?, ... }.
	async function call(path, params, creds) {
		const url = oauth1.signedUrl("GET", config.API_URL + path, params || {}, creds && creds.oauthToken, creds && creds.oauthTokenSecret);
		const r = await http.request({ method: "GET", url, headers: { Accept: "application/json" } });
		let data;
		try { data = r.text ? JSON.parse(r.text) : {}; }
		catch (e) { throw new errors.CloudError("SMUGMUG_BAD_JSON", "SmugMug's reply is not JSON", { status: r.status }); }
		if (!data || typeof data !== "object" || !data.Response || typeof data.Response !== "object") {
			throw new errors.CloudError("SMUGMUG_BAD_JSON", "SmugMug's reply has no Response", { status: r.status });
		}
		return data;
	}
	const get = async (path, params, creds) => (await call(path, params, creds)).Response;

	// Every item of a paged list (Response[key]), page after page, at most MAX_ITEMS; each item
	// through each(item, expansions) when given.
	async function all(path, params, creds, key, each) {
		const items = [];
		for (let start = 1; items.length < MAX_ITEMS;) {
			const data = await call(path, Object.assign({}, params, { start: String(start), count: String(PAGE) }), creds);
			const resp = data.Response;
			const exp = (data.Expansions && typeof data.Expansions === "object") ? data.Expansions : {};
			const got = (Array.isArray(resp[key]) ? resp[key] : []).filter((i) => i && typeof i === "object");
			items.push(...(each ? got.map((i) => each(i, exp)) : got));
			const pages = resp.Pages || {};
			if (!got.length || !pages.NextPage || items.length >= (parseInt(pages.Total, 10) || 0)) { break; }
			start += got.length;
		}
		return items.slice(0, MAX_ITEMS);
	}

	return {
		call, get, all,
		// The user the token is for: { NickName, Name, ... }.
		authUser: async (creds) => (await get("/api/v2!authuser", null, creds)).User || {},
		albums: (creds, nick) => all("/api/v2/user/" + segment(errors, "user", nick) + "!albums", null, creds, "Album"),
		albumImages: (creds, albumKey) => all("/api/v2/album/" + segment(errors, "aid", albumKey) + "!images",
			{ _expand: "LargestImage" }, creds, "AlbumImage", withLargest),
	};
}

module.exports = Object.assign(createAdapter, { ERROR, ACCOUNTS, PAGE, MAX_ITEMS, describe, messageOf, resolveCredentials, withLargest });
