/* adapter.js - the PhotoPrism API, and the account's credentials, for service.js.
 *
 * Every keyed call goes to <server>/api/v1 with the account's app password as a Bearer token,
 * and asks for JSON. A reply outside 2xx is PHOTOPRISM_HTTP_ERROR (with its status), a body that
 * is not JSON PHOTOPRISM_BAD_JSON. Keyed requests do not follow redirects: fetch would carry the
 * token along to wherever one points. The server's address is settled at sign-in (login.js),
 * before anything secret is sent.
 *
 *   albums(creds, type)     GET /albums?type=album|folder, paged by count/offset
 *   albumPhotos(creds, uid) GET /photos?s=<album uid>&merged=true, paged, at most MAX_ITEMS
 *   config(creds)           GET /config: the download and preview tokens for photo links
 *   createSession / mintToken / endSession: sign-in (login.js)
 *
 * Credentials ("common", as login stores them): { server, token, userId, username, name };
 * server is "http(s)://host[:port][/path]" with no trailing slash and no /api/v1. A caller passes
 * them inline as credentials.common, or an accountId, and the service reads them from Accounts
 * (it is in the template's readPermissions).
 */
"use strict";

const ERROR = "PHOTOPRISM_HTTP_ERROR";
const ACCOUNTS = "luna://com.palm.service.accounts/";
const PAGE = 500;
const MAX_ITEMS = 5000;
const REDIRECTS = [301, 302, 303, 307, 308];

const oneLine = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; };

// PhotoPrism's message from an error body: { code, error, message?, messageId? }.
function messageOf(body) {
	let d;
	try { d = JSON.parse(body); } catch (e) { return ""; }
	if (!d || typeof d !== "object") { return ""; }
	const m = [d.message, d.error].find((x) => typeof x === "string" && x);
	return m ? oneLine(m, 200) : "";
}

// The errorText of a reply outside 2xx.
function describe(status, body) {
	const m = messageOf(body);
	return "PhotoPrism answered HTTP " + status + (m ? ": " + m : "");
}

// The account's credentials: inline (with a token and a server), or read from Accounts.
async function resolveCredentials(call, errors, args) {
	args = args || {};
	const ok = (c) => c && typeof c.token === "string" && c.token && typeof c.server === "string" && c.server;
	const inline = args.credentials && args.credentials.common;
	if (ok(inline)) { return inline; }
	if (!args.accountId) { throw new errors.CloudError("NO_CREDENTIALS", "pass credentials or accountId"); }
	// The reply may carry them as credentials, credentials.common or common.
	const r = await call(ACCOUNTS + "readCredentials", { accountId: args.accountId, name: "common" });
	let c = (r && r.credentials) || r || {};
	if (c && c.common) { c = c.common; }
	if (!ok(c)) { throw new errors.CloudError("NO_STORED_CREDENTIALS", "the account has no stored PhotoPrism server and app password"); }
	return c;
}

function createAdapter({ config, http, errors }) {
	const url = (server, path) => server + config.API_PATH + path;
	const parse = (r) => {
		try { return r.text ? JSON.parse(r.text) : {}; }
		catch (e) { throw new errors.CloudError("PHOTOPRISM_BAD_JSON", "PhotoPrism's reply is not JSON", { status: r.status }); }
	};

	// One request, Bearer `bearer` when given, following no redirect.
	async function send(server, bearer, method, path, json) {
		const headers = { Accept: "application/json" };
		if (bearer) { headers.Authorization = "Bearer " + bearer; }
		const opts = { method, url: url(server, path), redirect: "manual", accept: REDIRECTS, headers };
		if (json !== undefined) { opts.json = json; }
		const r = await http.request(opts);
		if (r.status >= 300) {
			throw new errors.CloudError(ERROR, "PhotoPrism answered HTTP " + r.status + " (a redirect); sign in again with the server's final address",
				{ status: r.status });
		}
		return parse(r);
	}
	const call = (creds, method, path, json) => send(creds.server, creds.token, method, path, json);

	// GET path&count=PAGE&offset=n until a short page, at most `max` items.
	async function paged(creds, path, max) {
		const items = [];
		for (let offset = 0; items.length < max; offset += PAGE) {
			const d = await call(creds, "GET", path + "&count=" + PAGE + "&offset=" + offset);
			const got = (Array.isArray(d) ? d : []).filter((i) => i && typeof i === "object");
			items.push(...got);
			if (got.length < PAGE) { break; }
		}
		return items.slice(0, max);
	}

	return {
		call, send,

		// The server's status, without a token (the endpoint is open): { status:"operational" },
		// or { redirect } for a 3xx.
		async status(server) {
			const r = await http.request({ method: "GET", url: url(server, "/status"), redirect: "manual",
				headers: { Accept: "application/json" }, accept: REDIRECTS });
			if (r.status >= 300) {
				const loc = r.headers && typeof r.headers.get === "function" ? r.headers.get("location") : null;
				return { redirect: loc || "" };
			}
			let d;
			try { d = r.text ? JSON.parse(r.text) : null; } catch (e) { d = null; }
			return d && typeof d === "object" ? d : {};
		},

		// Sign-in: a session from the user name and password -> { access_token, user, ... }.
		createSession: (server, username, password) => send(server, null, "POST", "/session", { username, password }),
		// An app password for this device, made in that session: never expires, Config.SCOPE.
		mintToken: (server, sessionToken, username, password) => send(server, sessionToken, "POST", "/oauth/token",
			{ grant_type: "password", client_name: config.CLIENT_NAME, scope: config.SCOPE, lifetime: 0, username, password }),
		endSession: (server, sessionToken) => send(server, sessionToken, "DELETE", "/session"),
		// The signed-in user of a token with the session scope (a full app password); a scoped one gets 403.
		session: (server, token) => send(server, token, "GET", "/session"),

		config: (creds) => call(creds, "GET", "/config"),
		albums: (creds, type) => paged(creds, "/albums?type=" + encodeURIComponent(type) + "&order=name", config.MAX_ALBUMS || 200),
		albumPhotos(creds, uid) {
			if (typeof uid !== "string" || !/^[a-z0-9]{8,32}$/.test(uid)) { throw errors.badArgs("aid: a PhotoPrism album id"); }
			return paged(creds, "/photos?merged=true&s=" + uid, MAX_ITEMS);
		},
	};
}

module.exports = Object.assign(createAdapter, { ERROR, ACCOUNTS, PAGE, MAX_ITEMS, describe, messageOf, resolveCredentials });
