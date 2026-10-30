/* login.js - the account validator: com.palm.service.photoprism/login { server, username, password }.
 *
 * The sign-in app (com.palm.app.photoprism-auth, the template's customUI) collects these and
 * calls this. It
 *   1. settles the address: "photos.example.org", "https://photos.example.org/library/" and
 *      "http://192.168.1.5:2342/api/v1" all work; no scheme means https;
 *   2. asks the server's status, without anything secret (the endpoint is open), so a wrong
 *      address fails as one, and so a redirect (http -> https, say) is followed once, here,
 *      before the password is sent anywhere - the requests later follow none;
 *   3. with a password: opens a session, makes an app password for this device in it
 *      (Config.CLIENT_NAME, Config.SCOPE: read-only, no expiry), and closes the session, so the
 *      password itself is kept nowhere. With an app password the user made (PhotoPrism shows them
 *      as xxxxxx-xxxxxx-xxxxxx-xxxxxx; the way in with two-factor sign-in): that is kept;
 *   4. checks the token reads the config, which holds the tokens the photo links carry.
 * and returns the credentials in the shape Accounts stores and the adapter reads:
 *   { username ("<user>@<host>"), alias (the display name), credentials:{ common:{ server, token,
 *     userId, username, name } } }
 * Open, as S3's is: the sign-in app's calls arrive as com.palm.app.accounts-<pid>.
 */
"use strict";

const TIMEOUT_MS = 60000;
const APP_PASSWORD = /^[A-Za-z0-9]{6}(-[A-Za-z0-9]{6}){3}$/;

// "http(s)://host[:port][/path]" from what the user typed; null when it is no such address.
// A pasted page or API address (/library/..., /api/v1) is cut back to the server's.
function normalizeServer(raw) {
	let s = String(raw || "").trim();
	if (!s) { return null; }
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { s = "https://" + s; }
	let u;
	try { u = new URL(s); } catch (e) { return null; }
	if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) { return null; }
	let p = u.pathname;
	const i = p.search(/\/(library|api)(\/|$)/i);
	if (i >= 0) { p = p.slice(0, i); }
	return u.origin + p.replace(/\/+$/, "");
}

// The server a status request redirected to, from its Location; null when it is not one on
// the same host.
function redirectedServer(server, location, config) {
	const tail = config.API_PATH + "/status";
	let u;
	try { u = new URL(location, server + tail); } catch (e) { return null; }
	if (u.hostname !== new URL(server).hostname || !u.pathname.endsWith(tail)) { return null; }
	u.pathname = u.pathname.slice(0, -tail.length);
	u.search = ""; u.hash = "";
	return normalizeServer(u.href);
}

const str = (x) => (typeof x === "string" && x ? x : null);

function loginMethods({ config, adapter, CloudError, log = console }) {
	async function status(server) {
		try { return await adapter.status(server); }
		catch (e) {
			const why = String((e && (e.errorText || e.message)) || e);
			const tls = /^https:/.test(server) && /SSL|TLS|EPROTO|WRONG_VERSION/i.test(why);
			throw new CloudError("PHOTOPRISM_UNREACHABLE", "no PhotoPrism server answers at " + server + " (" + why + ")" +
				(tls ? " - if the server speaks only plain http, enter its address with http://" : ""), { status: e && e.status });
		}
	}
	const authFailed = (text) => new CloudError("PHOTOPRISM_AUTH_FAILED", text || "PhotoPrism does not accept this user name and password", { status: 401 });

	// A session's token and user from the password, or the reason it cannot be had.
	async function session(server, username, password) {
		try { return await adapter.createSession(server, username, password); }
		catch (e) {
			const m = String((e && e.errorText) || "");
			if (e && e.status === 401 && /passcode|verification|2fa|two-factor/i.test(m)) {
				throw new CloudError("PHOTOPRISM_2FA", "this account signs in with two-factor authentication: make an app password in " +
					"PhotoPrism (Settings → Account → Apps and Devices) and enter it as the password", { status: 401 });
			}
			if (e && (e.status === 401 || e.status === 400)) { throw authFailed(); }
			throw e;
		}
	}

	return {
		login: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const username = typeof p.username === "string" ? p.username.trim() : "";
			const password = typeof p.password === "string" ? p.password : "";
			if (!p.server || !username || !password) { throw new CloudError("MISSING_CREDENTIALS", "need server, username and password"); }
			let server = normalizeServer(p.server);
			if (!server) { throw new CloudError("BAD_SERVER", "the server address is not an http(s) address"); }
			let st = await status(server);
			if (st.redirect !== undefined) {
				const to = redirectedServer(server, st.redirect, config);
				if (!to) { throw new CloudError("PHOTOPRISM_NOT_FOUND", server + " redirects somewhere that is not a PhotoPrism server on the same host"); }
				log.log("photoprism: " + server + " redirects to " + to);
				server = to;
				st = await status(server);
				if (st.redirect !== undefined) { throw new CloudError("PHOTOPRISM_NOT_FOUND", server + " redirects again"); }
			}
			if (st.status !== "operational") { throw new CloudError("PHOTOPRISM_NOT_FOUND", "no PhotoPrism server at " + server); }

			let token, user = null;
			if (APP_PASSWORD.test(password)) {
				token = password;
				try { user = ((await adapter.session(server, token)) || {}).user || null; }
				catch (e) {
					if (e && e.status === 401) { throw authFailed("PhotoPrism does not accept this app password"); }
					user = null;   // a scoped app password may not read the session; the config check below decides
				}
			} else {
				const s = await session(server, username, password);
				if (!s || !str(s.access_token)) { throw new CloudError("PHOTOPRISM_AUTH_FAILED", "PhotoPrism opened no session"); }
				user = s.user || null;
				try {
					const t = await adapter.mintToken(server, s.access_token, username, password);
					token = t && str(t.access_token);
					if (!token) { throw new CloudError("PHOTOPRISM_NO_APP_PASSWORD", "PhotoPrism made no app password"); }
				} catch (e) {
					if (e && e.errorCode === "PHOTOPRISM_NO_APP_PASSWORD") { throw e; }
					throw new CloudError("PHOTOPRISM_NO_APP_PASSWORD", "PhotoPrism would not make an app password for this device (" +
						((e && (e.errorText || e.message)) || e) + "); make one in Settings → Account → Apps and Devices and enter it as the password",
						{ status: e && e.status });
				} finally {
					try { await adapter.endSession(server, s.access_token); } catch (e) { log.log("photoprism: the sign-in session could not be closed: " + (e && e.status)); }
				}
			}

			const creds = { server, token };
			let cfg;
			try { cfg = await adapter.config(creds); }
			catch (e) {
				if (e && e.status === 401) { throw authFailed("PhotoPrism does not accept this app password"); }
				if (e && e.status === 403) { throw new CloudError("PHOTOPRISM_KEY_SCOPE", "this app password may not read the server's config: give it the albums, config and photos scopes, or full access", { status: 403 }); }
				throw e;
			}
			if (!cfg || !str(cfg.downloadToken) || !str(cfg.previewToken)) {
				throw new CloudError("PHOTOPRISM_NO_DOWNLOADS", "the server gives this account no download and preview tokens: downloads may be off in its settings");
			}
			const name = (user && (str(user.DisplayName) || str(user.Name))) || username;
			const common = { server, token, userId: user && str(user.UID), username: (user && str(user.Name)) || username, name };
			return { username: common.username + "@" + new URL(server).host, alias: name, credentials: { common } };
		} },
	};
}

module.exports = Object.assign(loginMethods, { normalizeServer, redirectedServer, APP_PASSWORD });
