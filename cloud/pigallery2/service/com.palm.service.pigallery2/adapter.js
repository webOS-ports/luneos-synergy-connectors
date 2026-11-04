/* adapter.js - the PiGallery2 API, its sessions, and the account's credentials, for service.js.
 *
 * Every call goes to <server>/pgapi and asks for JSON. PiGallery2 answers { error, result }: an
 * error there (also on HTTP 200, as a wrong password is) is PIGALLERY2_ERROR, with status 401
 * when it means "not signed in" or "wrong credentials". A reply outside 2xx is
 * PIGALLERY2_HTTP_ERROR (with its status), a body that is not JSON PIGALLERY2_BAD_JSON.
 * Requests do not follow redirects: fetch would carry the session along to wherever one points.
 * The server's address is settled at sign-in (login.js).
 *
 * PiGallery2 has no tokens: a session is a signed cookie (pigallery2-session and its .sig) that
 * /user/login sets. The adapter keeps one per server and user for Config.SESSION_MAX_AGE_MS,
 * opens a new one when a call is refused with 401, and hands it to the Photos service with each
 * listing so the photos can be downloaded with it.
 *
 *   probe(server)                   GET /user/me with no session: who an open gallery lets in,
 *                                   or that it wants a sign-in
 *   login(server, user, password)   POST /user/login -> { cookie, user }
 *   withSession(creds, fn)          fn(cookie) with the account's session ("" for an open gallery)
 *   directory(server, cookie, dir)  GET /gallery/content/<dir> -> the directory, or null when gone
 *
 * Credentials ("common", as login stores them): { server, username, password, open, name };
 * server is "http(s)://host[:port][/path]" with no trailing slash and no /pgapi. A caller passes
 * them inline as credentials.common, or an accountId, and the service reads them from Accounts.
 */
"use strict";

const ERROR = "PIGALLERY2_HTTP_ERROR";
const ACCOUNTS = "luna://com.palm.service.accounts/";
const REDIRECTS = [301, 302, 303, 307, 308];
// PiGallery2's ErrorCodes: NOT_AUTHENTICATED, ALREADY_AUTHENTICATED, NOT_AUTHORISED,
// PERMISSION_DENIED, CREDENTIAL_NOT_FOUND, NOT_AUTHENTICATED_SHARING
const NOT_AUTHENTICATED = 1, NOT_AUTHORISED = 3, CREDENTIAL_NOT_FOUND = 5;
const SESSION_COOKIE = /^pigallery2-session(\.sig)?$/;

const oneLine = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; };

// PiGallery2's message from a reply body: { error: { code, message, detailsStr } }.
function messageOf(body) {
	let d;
	try { d = JSON.parse(body); } catch (e) { return ""; }
	const err = d && typeof d === "object" && d.error && typeof d.error === "object" ? d.error : null;
	const m = err && [err.message, err.detailsStr].find((x) => typeof x === "string" && x);
	return m ? oneLine(m, 200) : "";
}

// The errorText of a reply outside 2xx.
function describe(status, body) {
	const m = messageOf(body);
	return "PiGallery2 answered HTTP " + status + (m ? ": " + m : "");
}

// "a/b c/#1.jpg" -> "a/b%20c/%231.jpg": each part of a gallery path encoded.
const encodePath = (p) => String(p).split("/").filter(Boolean).map(encodeURIComponent).join("/");

// The session cookies of a reply, as a Cookie header: "pigallery2-session=...; pigallery2-session.sig=...".
function sessionCookie(headers) {
	const lines = headers && typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
	const pairs = [];
	for (const line of lines) {
		const pair = String(line).split(";")[0].trim();
		const eq = pair.indexOf("=");
		if (eq > 0 && SESSION_COOKIE.test(pair.slice(0, eq)) && /^[\x21-\x7e]*$/.test(pair)) { pairs.push(pair); }
	}
	return pairs.length === 2 ? pairs.join("; ") : "";
}

// The account's credentials: inline (with a server), or read from Accounts.
async function resolveCredentials(call, errors, args) {
	args = args || {};
	const ok = (c) => c && typeof c.server === "string" && c.server &&
		(c.open === true || (typeof c.username === "string" && c.username && typeof c.password === "string" && c.password));
	const inline = args.credentials && args.credentials.common;
	if (ok(inline)) { return inline; }
	if (!args.accountId) { throw new errors.CloudError("NO_CREDENTIALS", "pass credentials or accountId"); }
	// The reply may carry them as credentials, credentials.common or common.
	const r = await call(ACCOUNTS + "readCredentials", { accountId: args.accountId, name: "common" });
	let c = (r && r.credentials) || r || {};
	if (c && c.common) { c = c.common; }
	if (!ok(c)) { throw new errors.CloudError("NO_STORED_CREDENTIALS", "the account has no stored PiGallery2 server and sign-in"); }
	return c;
}

function createAdapter({ config, http, errors, now = Date.now }) {
	const url = (server, path) => server + config.API_PATH + path;
	const sessions = new Map();   // server + "\n" + user -> { cookie, at }

	// The result of a { error, result } reply; its error as a CloudError.
	function unwrap(r) {
		let d;
		try { d = r.text ? JSON.parse(r.text) : null; }
		catch (e) { throw new errors.CloudError("PIGALLERY2_BAD_JSON", "PiGallery2's reply is not JSON", { status: r.status }); }
		if (!d || typeof d !== "object" || !("result" in d || "error" in d)) {
			throw new errors.CloudError("PIGALLERY2_BAD_JSON", "PiGallery2's reply is not one of its own", { status: r.status });
		}
		if (d.error) {
			const code = d.error && d.error.code;
			const auth = [NOT_AUTHENTICATED, NOT_AUTHORISED, CREDENTIAL_NOT_FOUND].includes(code);
			throw new errors.CloudError("PIGALLERY2_ERROR", "PiGallery2: " + (messageOf(r.text) || "error " + code),
				{ status: auth ? 401 : r.status, pgCode: code });
		}
		return d.result;
	}

	// One request with `cookie` (when given), following no redirect.
	async function send(server, cookie, method, path, json) {
		const headers = { Accept: "application/json" };
		if (cookie) { headers.Cookie = cookie; }
		const opts = { method, url: url(server, path), redirect: "manual", accept: REDIRECTS, headers };
		if (json !== undefined) { opts.json = json; }
		const r = await http.request(opts);
		if (r.status >= 300) {
			throw new errors.CloudError(ERROR, "PiGallery2 answered HTTP " + r.status + " (a redirect); sign in again with the server's final address",
				{ status: r.status });
		}
		return r;
	}

	async function login(server, username, password) {
		const r = await send(server, null, "POST", "/user/login", { loginCredential: { username, password, rememberMe: true } });
		const user = unwrap(r);
		const cookie = sessionCookie(r.headers);
		if (!cookie) { throw new errors.CloudError("PIGALLERY2_NO_SESSION", "PiGallery2 signed in but gave no session", { status: r.status }); }
		return { cookie, user: user && typeof user === "object" ? user : null };
	}

	// fn(cookie) with the account's session: the kept one, or a new one; a kept one refused with
	// 401 is replaced once.
	async function withSession(creds, fn) {
		if (creds.open === true) { return fn(""); }
		const key = creds.server + "\n" + creds.username;
		const kept = sessions.get(key);
		if (kept && now() - kept.at < config.SESSION_MAX_AGE_MS) {
			try { return await fn(kept.cookie); }
			catch (e) {
				if (!(e && e.status === 401)) { throw e; }
				sessions.delete(key);
			}
		}
		const s = await login(creds.server, creds.username, creds.password);
		sessions.set(key, { cookie: s.cookie, at: now() });
		return fn(s.cookie);
	}

	return {
		send, login, withSession, unwrap,
		forget: () => sessions.clear(),

		// GET /user/me with no session: { open: true, user } when the gallery lets anyone in,
		// { open: false } when it wants a sign-in, { redirect } for a 3xx. Anything else is not
		// a PiGallery2 server: PIGALLERY2_BAD_JSON, or the HTTP error.
		async probe(server) {
			const r = await http.request({ method: "GET", url: url(server, "/user/me"), redirect: "manual",
				headers: { Accept: "application/json" }, accept: REDIRECTS.concat([401]) });
			if (REDIRECTS.includes(r.status)) {
				const loc = r.headers && typeof r.headers.get === "function" ? r.headers.get("location") : null;
				return { redirect: loc || "" };
			}
			try { return { open: true, user: unwrap(r) }; }
			catch (e) {
				if (e && e.errorCode === "PIGALLERY2_ERROR" && e.pgCode === NOT_AUTHENTICATED) { return { open: false }; }
				throw e;
			}
		},

		me: (server, cookie) => send(server, cookie, "GET", "/user/me").then(unwrap),

		// A gallery folder ("" the top one): { name, path, directories:[...], media:[...] }, or
		// null when it is not there (any more), which PiGallery2 answers with a 404.
		async directory(server, cookie, dir) {
			let r;
			try { r = await send(server, cookie, "GET", "/gallery/content/" + encodePath(dir)); }
			catch (e) { if (e && e.status === 404) { return null; } throw e; }
			const d = unwrap(r);
			const directory = d && typeof d === "object" ? d.directory : null;
			if (!directory || typeof directory !== "object") {
				throw new errors.CloudError("PIGALLERY2_BAD_JSON", "PiGallery2's listing has no directory", { status: r.status });
			}
			return directory;
		},

		// The link of a file in the gallery, and of its thumbnail of `size` px.
		fileUrl: (server, filePath, size) => url(server, "/gallery/content/" + encodePath(filePath)) + (size ? "/" + size : ""),
	};
}

module.exports = Object.assign(createAdapter, { ERROR, ACCOUNTS, describe, messageOf, encodePath, sessionCookie, resolveCredentials });
