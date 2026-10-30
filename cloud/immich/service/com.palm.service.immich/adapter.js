/* adapter.js - the Immich API, and the account's credentials, for service.js.
 *
 * Every call goes to <server>/api with the account's API key in the x-api-key header, and
 * asks for JSON. A reply outside 2xx is IMMICH_HTTP_ERROR (with its status), a body that is not
 * JSON IMMICH_BAD_JSON. Keyed requests do not follow redirects: fetch would carry x-api-key
 * along to wherever one points. The server's address is settled at sign-in (login.js), before
 * the key is sent anywhere.
 *
 * An album's assets come from POST /search/metadata. Immich 3.2 takes it as
 * { filter: { albumIds: { any:[id] } }, size, cursor } and pages by nextCursor; older servers
 * take the flat { albumIds:[id], size, page } and page by nextPage, which 3.2 calls deprecated
 * (to go in v4). The server's version (GET /server/version, open) picks the shape, once per
 * server for the life of the service. A server whose search cannot filter by album at all gets
 * GET /albums/<id>, which listed the assets itself before Immich 3. At most MAX_ITEMS assets.
 *
 * Credentials ("common", as login stores them): { server, apiKey, userId, email, name }; server
 * is "http(s)://host[:port][/path]" with no trailing slash and no /api. A caller passes them
 * inline as credentials.common, or an accountId, and the service reads them from Accounts (it
 * is in the template's readPermissions).
 */
"use strict";

const ERROR = "IMMICH_HTTP_ERROR";
const ACCOUNTS = "luna://com.palm.service.accounts/";
const PAGE = 500;
const MAX_ITEMS = 5000;
const REDIRECTS = [301, 302, 303, 307, 308];

const oneLine = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; };

// Immich's message from an error body: { message: "..." | ["..."], error, statusCode }. A
// validation failure's { errors:[{ message }] } too.
function messageOf(body) {
	let d;
	try { d = JSON.parse(body); } catch (e) { return ""; }
	if (!d || typeof d !== "object") { return ""; }
	let m = d.message;
	if (Array.isArray(m)) { m = m.filter((x) => typeof x === "string").join("; "); }
	if (Array.isArray(d.errors)) {
		const more = d.errors.map((e) => e && typeof e.message === "string" ? e.message : "").filter(Boolean).join("; ");
		if (more) { m = (typeof m === "string" && m ? m + ": " : "") + more; }
	}
	return typeof m === "string" ? oneLine(m, 200) : "";
}

// The errorText of a reply outside 2xx.
function describe(status, body) {
	const m = messageOf(body);
	return "Immich answered HTTP " + status + (m ? ": " + m : "");
}

// The account's credentials: inline (with an apiKey and a server), or read from Accounts.
async function resolveCredentials(call, errors, args) {
	args = args || {};
	const ok = (c) => c && typeof c.apiKey === "string" && c.apiKey && typeof c.server === "string" && c.server;
	const inline = args.credentials && args.credentials.common;
	if (ok(inline)) { return inline; }
	if (!args.accountId) { throw new errors.CloudError("NO_CREDENTIALS", "pass credentials or accountId"); }
	// The reply may carry them as credentials, credentials.common or common.
	const r = await call(ACCOUNTS + "readCredentials", { accountId: args.accountId, name: "common" });
	let c = (r && r.credentials) || r || {};
	if (c && c.common) { c = c.common; }
	if (!ok(c)) { throw new errors.CloudError("NO_STORED_CREDENTIALS", "the account has no stored Immich server and API key"); }
	return c;
}

// [major, minor] of "v3.3.5" or { major, minor }; null when unknown.
function versionOf(v) {
	if (v && typeof v === "object" && Number.isInteger(v.major)) { return [v.major, Number.isInteger(v.minor) ? v.minor : 0]; }
	return null;
}
const atLeast = (v, min) => !!v && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]));

function createAdapter({ config, http, errors }) {
	const versions = new Map();   // server -> [major, minor] | null

	async function call(creds, method, path, json) {
		const opts = { method, url: creds.server + config.API_PATH + path, redirect: "manual", accept: REDIRECTS,
			headers: { "x-api-key": creds.apiKey, Accept: "application/json" } };
		if (json !== undefined) { opts.json = json; }
		const r = await http.request(opts);
		if (r.status >= 300) {
			throw new errors.CloudError(ERROR, "Immich answered HTTP " + r.status + " (a redirect); sign in again with the server's final address",
				{ status: r.status });
		}
		try { return r.text ? JSON.parse(r.text) : {}; }
		catch (e) { throw new errors.CloudError("IMMICH_BAD_JSON", "Immich's reply is not JSON", { status: r.status }); }
	}

	// The server's version, without a key (the endpoint is open). { major, minor, patch }.
	async function serverVersion(server) {
		const r = await http.request({ method: "GET", url: server + config.API_PATH + "/server/version", redirect: "manual",
			headers: { Accept: "application/json" }, accept: REDIRECTS });
		if (r.status >= 300) {
			const loc = r.headers && typeof r.headers.get === "function" ? r.headers.get("location") : null;
			return { redirect: loc || "" };
		}
		let d;
		try { d = r.text ? JSON.parse(r.text) : null; } catch (e) { d = null; }
		return d && typeof d === "object" ? d : {};
	}

	async function versionFor(creds) {
		if (!versions.has(creds.server)) {
			let v = null;
			try { v = versionOf(await serverVersion(creds.server)); } catch (e) { v = null; }
			if (v) { versions.set(creds.server, v); }
			return v;
		}
		return versions.get(creds.server);
	}

	// Every asset of an album, page after page, at most MAX_ITEMS.
	async function albumAssets(creds, albumId) {
		if (typeof albumId !== "string" || !albumId) { throw errors.badArgs("aid: a non-empty string"); }
		const filterShape = atLeast(await versionFor(creds), config.FILTER_SEARCH_SINCE);
		const items = [];
		let next = null;
		try {
			do {
				const body = filterShape
					? Object.assign({ filter: { albumIds: { any: [albumId] } }, size: PAGE }, next ? { cursor: next } : {})
					: { albumIds: [albumId], size: PAGE, page: next ? parseInt(next, 10) : 1 };
				const d = await call(creds, "POST", "/search/metadata", body);
				const a = (d && d.assets) || {};
				const got = (Array.isArray(a.items) ? a.items : []).filter((i) => i && typeof i === "object");
				items.push(...got);
				next = filterShape ? a.nextCursor : a.nextPage;
				if (!got.length) { break; }
			} while (next && items.length < MAX_ITEMS);
		} catch (e) {
			// A server whose search does not take an album: the album lists its own assets.
			if (!(e && e.status === 400 && !items.length && !filterShape)) { throw e; }
			const album = await call(creds, "GET", "/albums/" + encodeURIComponent(albumId));
			return (Array.isArray(album.assets) ? album.assets : []).filter((i) => i && typeof i === "object").slice(0, MAX_ITEMS);
		}
		return items.slice(0, MAX_ITEMS);
	}

	return {
		call, serverVersion, albumAssets,
		me: (creds) => call(creds, "GET", "/users/me"),
		albums: async (creds) => {
			const d = await call(creds, "GET", "/albums");
			return Array.isArray(d) ? d.filter((a) => a && typeof a === "object") : [];
		},
	};
}

module.exports = Object.assign(createAdapter, { ERROR, ACCOUNTS, PAGE, MAX_ITEMS, describe, messageOf, resolveCredentials, versionOf, atLeast });
