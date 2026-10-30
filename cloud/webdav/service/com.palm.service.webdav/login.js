/* login.js - the account validator: com.palm.service.webdav/login
 *   { flavor ("webdav" | "nextcloud" | "owncloud"), server, username, password, photoFolder? }
 *
 * The sign-in app (com.palm.app.webdav-auth, the template's customUI) collects these and calls
 * this. It
 *   1. settles the address: no scheme means https; for Nextcloud and ownCloud the server's own
 *      address is wanted, so a pasted WebDAV address (".../remote.php/dav/files/alice/",
 *      ".../remote.php/webdav") is cut back to it; for generic WebDAV the address is the folder;
 *   2. asks once without the password (a PROPFIND), so a redirect (http -> https, say) is
 *      followed here, once and only on the same host, before the password is sent anywhere -
 *      the requests later follow none;
 *   3. for Nextcloud and ownCloud, asks the server who the user is (current-user-principal):
 *      one may sign in with an email address, but the files are under the user id;
 *   4. PROPFINDs the account's folder with the password: the server, the sign-in and the
 *      folder all work.
 * and returns the credentials in the shape Accounts stores and the adapter reads:
 *   { username ("<user>@<host>"), alias, credentials:{ common:{ accessToken (the password),
 *     username, server (the WebDAV folder, ending in "/"), flavor, photoFolder? } } }
 * Open, as S3's is: the sign-in app's calls arrive as com.palm.app.accounts-<pid>.
 */
"use strict";

const TIMEOUT_MS = 60000;
const ANY_STATUS = Array.from({ length: 500 }, (_, i) => i + 100);
const PRINCIPAL_BODY = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
	"<d:propfind xmlns:d=\"DAV:\"><d:prop><d:current-user-principal/></d:prop></d:propfind>";

const asFolder = (p) => (p.endsWith("/") ? p : p + "/");

// "http(s)://host[:port][/path]" from what the user typed, for the flavor: the WebDAV folder
// (ending in "/") for generic WebDAV, the server's address (no trailing "/") for the others.
// null when it is no such address.
function normalizeServer(raw, flavor) {
	let s = String(raw || "").trim();
	if (!s) { return null; }
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { s = "https://" + s; }
	let u;
	try { u = new URL(s); } catch (e) { return null; }
	if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) { return null; }
	let p = u.pathname;
	if (flavor === "webdav") { return u.origin + asFolder(p); }
	const i = p.search(/\/(remote|index)\.php(\/|$)/i);
	if (i >= 0) { p = p.slice(0, i); }
	return u.origin + p.replace(/\/+$/, "");
}

// The user id in a principal's href ("/remote.php/dav/principals/users/alice/") -> "alice".
function principalUser(href) {
	const m = /\/principals\/(?:users\/)?([^/]+)\/?$/.exec(String(href || ""));
	if (!m) { return null; }
	try { return decodeURIComponent(m[1]) || null; } catch (e) { return null; }
}

// deps: the connector's (config, http, adapter, log), adapter.js itself (dav) and the core's Session and CloudError.
function loginMethods({ config, http, adapter, dav, Session, CloudError, log = console }) {
	// An https address at a server that speaks only http fails TLS at once (Nextcloud on the LAN
	// often does): say so, as that is what to change.
	const unreachable = (where, e) => {
		const why = String((e && (e.errorText || e.message)) || e);
		const tls = /^https:/.test(where) && /SSL|TLS|EPROTO|WRONG_VERSION/i.test(why);
		return new CloudError("WEBDAV_UNREACHABLE", "no server answers at " + where + " (" + why + ")" +
			(tls ? " - if the server speaks only plain http, enter its address with http://" : ""), { status: e && e.status });
	};

	// A PROPFIND with no password, any status taken. -> { status, location }
	async function probe(url) {
		let r;
		try {
			r = await http.request({ method: "PROPFIND", url, redirect: "manual", accept: ANY_STATUS, timeoutMs: 30000,
				headers: { Depth: "0" } });
		} catch (e) { throw unreachable(url, e); }
		return { status: r.status, location: r.headers && r.headers.get ? r.headers.get("location") : null };
	}

	// Where the address really is: itself, or where its one redirect leads on the same host.
	// tail is the path the probe asks under the address ("" or "/remote.php/dav/").
	async function settle(server, tail) {
		const url = (tail ? server + tail : server);
		const r = await probe(url);
		if (r.status < 300 || r.status >= 400) { return server; }
		let to;
		try { to = new URL(r.location || "", url); } catch (e) { to = null; }
		if (!to || (to.protocol !== "https:" && to.protocol !== "http:") || to.username || to.password) {
			throw new CloudError("WEBDAV_NOT_FOUND", url + " redirects somewhere that is no http(s) address");
		}
		if (to.hostname !== new URL(url).hostname) {
			throw new CloudError("WEBDAV_NOT_FOUND", url + " redirects to " + to.host + ": enter that address instead");
		}
		to.search = ""; to.hash = "";
		let next;
		if (tail) {
			if (!to.pathname.endsWith(tail)) { throw new CloudError("WEBDAV_NOT_FOUND", url + " redirects somewhere that is not this kind of server"); }
			next = to.origin + to.pathname.slice(0, -tail.length);
		} else {
			next = to.origin + asFolder(to.pathname);
		}
		log.log("webdav: " + url + " redirects to " + (tail ? next + tail : next));
		const again = await probe(tail ? next + tail : next);
		if (again.status >= 300 && again.status < 400) { throw new CloudError("WEBDAV_NOT_FOUND", next + " redirects again"); }
		return next;
	}

	// Nextcloud/ownCloud: the user id behind the sign-in, or null when the server does not say.
	async function userId(server, tail, username, password) {
		let r;
		try {
			r = await http.request({ method: "PROPFIND", url: server + tail, redirect: "manual", body: PRINCIPAL_BODY,
				headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8",
					Authorization: "Basic " + Buffer.from(username + ":" + password, "utf8").toString("base64") },
				errorCode: "WEBDAV_AUTH_FAILED", describe: dav.describe });
		} catch (e) {
			if (e && e.errorCode === "CURL_FAILED") { throw unreachable(server, e); }
			if (e && e.status === 401) { throw authFailed(); }
			log.log("webdav: no user id from " + server + tail + ": HTTP " + (e && e.status));
			return null;
		}
		if (!dav.isMultistatus(r.text)) { return null; }
		const m = /<(?:[\w.-]+:)?current-user-principal[^>]*>\s*<(?:[\w.-]+:)?href[^>]*>([^<]+)</.exec(r.text);
		return m ? principalUser(dav.decode(m[1].trim())) : null;
	}

	function authFailed() {
		return new CloudError("WEBDAV_AUTH_FAILED", "the server refused the user name or password (with two-factor " +
			"sign-in, Nextcloud and ownCloud want an app password: Settings → Security → Devices & sessions)", { status: 401 });
	}

	return {
		login: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const flavor = p.flavor || "webdav";
			const fl = (config.FLAVORS || {})[flavor];
			if (!fl || !Object.prototype.hasOwnProperty.call(config.FLAVORS, flavor)) { throw new CloudError("BAD_ARGS", "flavor: webdav, nextcloud or owncloud"); }
			const username = typeof p.username === "string" ? p.username.trim() : "";
			const password = typeof p.password === "string" ? p.password : "";
			if (!p.server || !username || !password) { throw new CloudError("MISSING_CREDENTIALS", "need server, username and password"); }
			if (username.indexOf(":") >= 0 || /[\u0000-\u001f]/.test(username + password)) {
				throw new CloudError("BAD_ARGS", "a user name with \":\", or control characters, cannot sign in over HTTP Basic auth");
			}
			let photoFolder;
			if (typeof p.photoFolder === "string" && p.photoFolder.trim()) {
				const f = dav.norm("/" + p.photoFolder.trim().replace(/^\/+/, ""));
				if (f === null) { throw new CloudError("BAD_ARGS", "photoFolder: a folder path in the account"); }
				photoFolder = asFolder(f);
			}
			let server = normalizeServer(p.server, flavor);
			if (!server) { throw new CloudError("BAD_ARGS", "the server address is not an http(s) address"); }

			let root;
			if (fl.davPath) {
				server = await settle(server, fl.principals);
				const id = (await userId(server, fl.principals, username, password)) || username;
				root = server + fl.davPath.replace("{user}", encodeURIComponent(id));
			} else {
				root = await settle(server, "");
			}

			const creds = { accessToken: password, username, server: root, flavor };
			if (photoFolder) { creds.photoFolder = photoFolder; }
			try { await adapter.getAccountInfo(new Session(creds)); }
			catch (e) {
				log.log("webdav: login to " + new URL(root).host + " failed: " + ((e && (e.errorCode + " " + e.status)) || e));
				if (e && e.errorCode === "CURL_FAILED") { throw unreachable(root, e); }
				if (e && e.status === 401) { throw authFailed(); }
				if (e && (e.status === 404 || e.status === 405 || e.errorCode === "WEBDAV_NOT_FOUND" || e.errorCode === "WEBDAV_AUTH_FAILED")) {
					throw new CloudError("WEBDAV_NOT_FOUND", "no WebDAV folder at " + root + (fl.davPath ? "" :
						" - check the address (a NAS's WebDAV is often on its own port or under /webdav)") +
						(e.errorText ? " (" + e.errorText + ")" : ""), { status: e.status });
				}
				throw e;
			}
			const host = new URL(root).host;
			return { username: username + "@" + host, alias: fl.name + " " + host, credentials: { common: creds } };
		} },
	};
}

module.exports = Object.assign(loginMethods, { normalizeServer, principalUser });
