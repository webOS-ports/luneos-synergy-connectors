/* login.js - the account validator: com.palm.service.immich/login { server, apiKey }.
 *
 * The sign-in app (com.palm.app.immich-auth, the template's customUI) collects the server's
 * address and an API key the user made in Immich, and calls this. It
 *   1. settles the address: "photos.example.org", "https://photos.example.org/" and
 *      "http://192.168.1.5:2283/api" all work; no scheme means https, a trailing /api goes;
 *   2. asks the server's version, without the key (the endpoint is open), so a wrong address
 *      fails as one, and so a redirect (http -> https, say) is followed once, here, before the
 *      key is sent anywhere - the keyed requests later follow none;
 *   3. asks /users/me with the key: the key works, and the account is named after its user.
 * and returns the credentials in the shape Accounts stores and the adapter reads:
 *   { username (the email), alias (the name), credentials:{ common:{ server, apiKey, userId, email, name } } }
 * Open, as S3's is: the sign-in app's calls arrive as com.palm.app.accounts-<pid>.
 */
"use strict";

const TIMEOUT_MS = 60000;

// "http(s)://host[:port][/path]" from what the user typed; null when it is no such address.
function normalizeServer(raw) {
	let s = String(raw || "").trim();
	if (!s) { return null; }
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { s = "https://" + s; }
	let u;
	try { u = new URL(s); } catch (e) { return null; }
	if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) { return null; }
	const p = u.pathname.replace(/\/+$/, "").replace(/\/api$/i, "").replace(/\/+$/, "");
	return u.origin + p;
}

// The server a version request redirected to, from its Location; null when it is not one.
function redirectedServer(server, location, config) {
	let u;
	try { u = new URL(location, server + config.API_PATH + "/server/version"); } catch (e) { return null; }
	const tail = config.API_PATH + "/server/version";
	if (!u.pathname.endsWith(tail)) { return null; }
	u.pathname = u.pathname.slice(0, -tail.length);
	u.search = ""; u.hash = "";
	return normalizeServer(u.href);
}

function loginMethods({ config, adapter, versionOf, CloudError, log = console }) {
	async function version(server) {
		try { return await adapter.serverVersion(server); }
		catch (e) {
			throw new CloudError("IMMICH_UNREACHABLE", "no Immich server answers at " + server + " (" +
				((e && (e.errorText || e.message)) || e) + ")", { status: e && e.status });
		}
	}

	return {
		login: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			let server = normalizeServer(p.server);
			const apiKey = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
			if (!p.server || !apiKey) { throw new CloudError("MISSING_CREDENTIALS", "need server and apiKey"); }
			if (!server) { throw new CloudError("BAD_SERVER", "the server address is not an http(s) address"); }
			let v = await version(server);
			if (v.redirect !== undefined) {
				const to = redirectedServer(server, v.redirect, config);
				if (!to) { throw new CloudError("IMMICH_NOT_FOUND", server + " redirects somewhere that is not an Immich server"); }
				log.log("immich: " + server + " redirects to " + to);
				server = to;
				v = await version(server);
				if (v.redirect !== undefined) { throw new CloudError("IMMICH_NOT_FOUND", server + " redirects again"); }
			}
			if (!versionOf(v)) { throw new CloudError("IMMICH_NOT_FOUND", "no Immich server at " + server); }

			let me;
			try { me = await adapter.me({ server, apiKey }); }
			catch (e) {
				if (e && e.status === 401) { throw new CloudError("IMMICH_AUTH_FAILED", "Immich does not accept this API key", { status: 401 }); }
				if (e && e.status === 403) {
					throw new CloudError("IMMICH_KEY_SCOPE", "the API key may not read the user (user.read): give it user.read, album.read, " +
						"asset.read, asset.view and asset.download", { status: 403 });
				}
				throw e;
			}
			me = me && typeof me === "object" ? me : {};
			const str = (x) => (typeof x === "string" && x ? x : null);
			const email = str(me.email), name = str(me.name);
			return { username: email || name || new URL(server).host, alias: name || undefined,
				credentials: { common: { server, apiKey, userId: str(me.id), email, name } } };
		} },
	};
}

module.exports = Object.assign(loginMethods, { normalizeServer, redirectedServer });
