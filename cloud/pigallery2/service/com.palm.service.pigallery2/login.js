/* login.js - the account validator: com.palm.service.pigallery2/login { server, username, password }.
 *
 * The sign-in app (com.palm.app.pigallery2-auth, the template's customUI) collects these and
 * calls this. It
 *   1. settles the address: "gallery.example.org", "https://gallery.example.org/gallery/2024/"
 *      and "http://192.168.1.5/pgapi" all work; no scheme means https;
 *   2. asks /user/me without a session (nothing secret is sent), so a wrong address fails as
 *      one, a gallery with sign-in turned off is known as such, and a redirect (http -> https,
 *      say) is followed once, here, before the password is sent anywhere - the requests later
 *      follow none;
 *   3. signs in with the user name and password, unless the gallery is open;
 *   4. lists the gallery's top folder with that session.
 * and returns the credentials in the shape Accounts stores and the adapter reads:
 *   { username ("<user>@<host>", or the host for an open gallery), alias, credentials:{ common:{
 *     server, username, password, open, name } } }
 * PiGallery2 has no tokens, so the password is what is kept (Accounts' credential store, as for
 * WebDAV); an open gallery keeps none. Open, as PhotoPrism's is: the sign-in app's calls arrive
 * as com.palm.app.accounts-<pid>.
 */
"use strict";

const TIMEOUT_MS = 60000;
// The web app's own pages: a pasted page address is cut back to the server's.
const PAGES = /\/(pgapi|gallery|search|login|share|shareLogin|albums|faces|admin|duplicates)(\/|$)/i;

// "http(s)://host[:port][/path]" from what the user typed; null when it is no such address.
function normalizeServer(raw) {
	let s = String(raw || "").trim();
	if (!s) { return null; }
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { s = "https://" + s; }
	let u;
	try { u = new URL(s); } catch (e) { return null; }
	if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) { return null; }
	let p = u.pathname;
	const i = p.search(PAGES);
	if (i >= 0) { p = p.slice(0, i); }
	return u.origin + p.replace(/\/+$/, "");
}

// The server a /user/me request redirected to, from its Location; null when it is not one on
// the same host.
function redirectedServer(server, location, config) {
	const tail = config.API_PATH + "/user/me";
	let u;
	try { u = new URL(location, server + tail); } catch (e) { return null; }
	if (u.hostname !== new URL(server).hostname || !u.pathname.endsWith(tail)) { return null; }
	u.pathname = u.pathname.slice(0, -tail.length);
	u.search = ""; u.hash = "";
	return normalizeServer(u.href);
}

const str = (x) => (typeof x === "string" && x ? x : null);

function loginMethods({ config, adapter, CloudError, log = console }) {
	async function probe(server) {
		try { return await adapter.probe(server); }
		catch (e) {
			if (e && e.errorCode === "PIGALLERY2_BAD_JSON" || (e && e.status >= 400 && e.status < 500)) {
				throw new CloudError("PIGALLERY2_NOT_FOUND", "no PiGallery2 server at " + server, { status: e.status });
			}
			const why = String((e && (e.errorText || e.message)) || e);
			const tls = /^https:/.test(server) && /SSL|TLS|EPROTO|WRONG_VERSION/i.test(why);
			throw new CloudError("PIGALLERY2_UNREACHABLE", "no PiGallery2 server answers at " + server + " (" + why + ")" +
				(tls ? " - if the server speaks only plain http, enter its address with http://" : ""), { status: e && e.status });
		}
	}

	return {
		login: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const username = typeof p.username === "string" ? p.username.trim() : "";
			const password = typeof p.password === "string" ? p.password : "";
			if (!p.server) { throw new CloudError("MISSING_CREDENTIALS", "need a server"); }
			let server = normalizeServer(p.server);
			if (!server) { throw new CloudError("BAD_SERVER", "the server address is not an http(s) address"); }
			let st = await probe(server);
			if (st.redirect !== undefined) {
				const to = redirectedServer(server, st.redirect, config);
				if (!to) { throw new CloudError("PIGALLERY2_NOT_FOUND", server + " redirects somewhere that is not a PiGallery2 server on the same host"); }
				log.log("pigallery2: " + server + " redirects to " + to);
				server = to;
				st = await probe(server);
				if (st.redirect !== undefined) { throw new CloudError("PIGALLERY2_NOT_FOUND", server + " redirects again"); }
			}
			const host = new URL(server).host;

			if (st.open) {
				// Anyone may look: nothing to sign in with, nothing kept.
				if (!(await adapter.directory(server, "", ""))) { throw new CloudError("PIGALLERY2_NO_ACCESS", "the gallery shows no folders"); }
				const common = { server, open: true, name: host };
				return { username: host, alias: host, credentials: { common } };
			}
			if (!username || !password) {
				throw new CloudError("PIGALLERY2_SIGN_IN_NEEDED", "this gallery needs a user name and password", { status: 401 });
			}
			let s;
			try { s = await adapter.login(server, username, password); }
			catch (e) {
				if (e && e.status === 401) { throw new CloudError("PIGALLERY2_AUTH_FAILED", "PiGallery2 does not accept this user name and password", { status: 401 }); }
				throw e;
			}
			const top = await adapter.directory(server, s.cookie, "");
			if (!top) { throw new CloudError("PIGALLERY2_NO_ACCESS", "this user may not see the gallery's folders"); }
			const name = (s.user && str(s.user.name)) || username;
			const common = { server, username, password, open: false, name };
			return { username: username + "@" + host, alias: name, credentials: { common } };
		} },
	};
}

module.exports = Object.assign(loginMethods, { normalizeServer, redirectedServer });
