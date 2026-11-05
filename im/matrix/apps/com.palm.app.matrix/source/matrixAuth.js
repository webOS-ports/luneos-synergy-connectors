/*global window, fetch, crypto, TextEncoder, btoa, URLSearchParams, Promise */
/*
 * MatrixAuth - signs in to a Matrix server from the validator app, through the server's OAuth 2.0
 * service (MSC3861; matrix.org runs Matrix Authentication Service).
 *
 *   1. discover the homeserver from the Matrix ID (/.well-known/matrix/client) and ask it for
 *      its OAuth metadata (/_matrix/client/v1/auth_metadata);
 *   2. register this app as a public native client (dynamic client registration) with the
 *      loopback redirect http://localhost/matrix-signin, which MAS accepts for native clients;
 *   3. open the authorization page in a WAM window (OAuthWindow), authorization code with PKCE,
 *      for a new device ID; WAM hands back the redirect, which nothing serves;
 *   4. exchange the code for tokens and check who they belong to.
 *
 * The result goes to the plugin as the account's password: "mxoauth:" + base64url(JSON), read by
 * matrix_seed.go in purple-combined. The plugin keeps its own session from then on.
 *
 * Servers without OAuth return null from metadata(); the validator then asks for the password.
 * Every call here works from the app's file:// page: these endpoints send
 * Access-Control-Allow-Origin: *, as browser clients (Element Web) need.
 */
(function (root) {
	"use strict";

	var MatrixAuth = {
		REDIRECT: "http://localhost/matrix-signin",
		CLIENT_URI: "https://github.com/webOS-ports/luneos-synergy-connectors",
		CLIENT_NAME: "LuneOS Messaging",
		SEED_PREFIX: "mxoauth:",

		// "@you:example.org" -> "example.org" (the server name, port included).
		serverOf: function (mxid) {
			var i = (mxid || "").indexOf(":");
			return i < 0 ? "" : mxid.slice(i + 1);
		},

		// A Matrix ID: "@" + localpart + ":" + server name. The server name needs a dot, or is
		// localhost or an IP literal, so "@you:matrix" (a slip for matrix.org) is refused.
		isMatrixId: function (v) {
			var m = /^@([^:@\s]+):([^\s]+)$/.exec(v || "");
			if (!m) { return false; }
			var host = m[2].replace(/:[0-9]{1,5}$/, "");
			if (/^\[[0-9a-fA-F:.]+\]$/.test(host)) { return true; }
			if (host === "localhost") { return true; }
			return /^[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+$/.test(host);
		},

		getJSON: function (url, opts) {
			opts = opts || {};
			return fetch(url, opts).then(function (r) {
				return r.text().then(function (t) {
					var body = null;
					try { body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
					if (!r.ok) {
						var err = new Error((body && (body.error_description || body.error)) || ("HTTP " + r.status));
						err.status = r.status;
						err.body = body;
						throw err;
					}
					return body;
				});
			});
		},

		// The client-server API base URL for a server name.
		discover: function (server) {
			var fallback = "https://" + server;
			return this.getJSON("https://" + server + "/.well-known/matrix/client").then(function (wk) {
				var base = wk && wk["m.homeserver"] && wk["m.homeserver"].base_url;
				return (base || fallback).replace(/\/+$/, "");
			}, function () {
				return fallback;
			});
		},

		// The server's OAuth metadata, or null when it has none (password-only servers).
		metadata: function (hs) {
			var self = this;
			return this.getJSON(hs + "/_matrix/client/v1/auth_metadata").catch(function () {
				return self.getJSON(hs + "/_matrix/client/unstable/org.matrix.msc2965/auth_metadata");
			}).then(function (m) {
				return (m && m.authorization_endpoint && m.token_endpoint && m.registration_endpoint) ? m : null;
			}, function () {
				return null;
			});
		},

		register: function (meta) {
			return this.getJSON(meta.registration_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					application_type: "native",
					client_name: this.CLIENT_NAME,
					client_uri: this.CLIENT_URI,
					redirect_uris: [this.REDIRECT],
					// device_code too, so the plugin can reuse this client if it ever falls back.
					grant_types: ["authorization_code", "refresh_token",
						"urn:ietf:params:oauth:grant-type:device_code"],
					response_types: ["code"],
					token_endpoint_auth_method: "none"
				})
			}).then(function (r) {
				if (!r || !r.client_id) { throw new Error("the server did not register this app"); }
				return r.client_id;
			});
		},

		b64url: function (bytes) {
			var s = "";
			for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
			return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		},

		randomString: function (n) {
			var b = new Uint8Array(n);
			crypto.getRandomValues(b);
			return this.b64url(b);
		},

		// A device ID like the plugin's own: ten capital letters.
		deviceId: function () {
			var letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", b = new Uint8Array(10), s = "";
			crypto.getRandomValues(b);
			for (var i = 0; i < b.length; i++) { s += letters[b[i] % letters.length]; }
			return s;
		},

		pkce: function () {
			var self = this, verifier = this.randomString(48);
			return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (d) {
				return { verifier: verifier, challenge: self.b64url(new Uint8Array(d)) };
			});
		},

		authorizeUrl: function (meta, p) {
			var q = new URLSearchParams();
			q.set("response_type", "code");
			q.set("response_mode", "query");
			q.set("client_id", p.clientId);
			q.set("redirect_uri", this.REDIRECT);
			q.set("scope", "urn:matrix:client:api:* urn:matrix:client:device:" + p.deviceId);
			q.set("state", p.state);
			q.set("code_challenge", p.challenge);
			q.set("code_challenge_method", "S256");
			if (p.userId) { q.set("login_hint", "mxid:" + p.userId); }
			var sep = meta.authorization_endpoint.indexOf("?") < 0 ? "?" : "&";
			return meta.authorization_endpoint + sep + q.toString();
		},

		// The code from the redirect, after checking state; throws a user-facing message.
		codeFromRedirect: function (url, state) {
			var q;
			try { q = new URL(url).searchParams; } catch (e) { throw new Error("The sign-in returned an unreadable address."); }
			if (q.get("state") !== state) { throw new Error("The sign-in answer did not belong to this sign-in. Please try again."); }
			var err = q.get("error");
			if (err === "access_denied") { throw new Error("The sign-in was cancelled."); }
			if (err) { throw new Error("The server refused the sign-in: " + (q.get("error_description") || err)); }
			var code = q.get("code");
			if (!code) { throw new Error("The server did not return a sign-in code."); }
			return code;
		},

		exchange: function (meta, clientId, code, verifier) {
			var form = new URLSearchParams();
			form.set("grant_type", "authorization_code");
			form.set("code", code);
			form.set("redirect_uri", this.REDIRECT);
			form.set("client_id", clientId);
			form.set("code_verifier", verifier);
			return this.getJSON(meta.token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form.toString()
			});
		},

		whoami: function (hs, token) {
			return this.getJSON(hs + "/_matrix/client/v3/account/whoami", {
				headers: { "Authorization": "Bearer " + token }
			});
		},

		encodeSeed: function (seed) {
			return this.SEED_PREFIX + this.b64url(new TextEncoder().encode(JSON.stringify(seed)));
		},

		// Does the server take passwords (m.login.password)? Servers on MAS still do, through its
		// compatibility layer, for accounts that have a password.
		hasPasswordLogin: function (hs) {
			return this.getJSON(hs + "/_matrix/client/v3/login").then(function (r) {
				var flows = (r && r.flows) || [];
				for (var i = 0; i < flows.length; i++) {
					if (flows[i].type === "m.login.password") { return true; }
				}
				return false;
			}, function () {
				return false;
			});
		},

		// Log in with a password here, so a wrong one shows in Accounts, and the plugin gets a
		// session instead of the password. Resolves to the stored password.
		passwordLogin: function (userId, password, recoveryKey) {
			var self = this, hs, deviceId = this.deviceId();
			return this.discover(this.serverOf(userId)).then(function (h) {
				hs = h;
				return self.getJSON(hs + "/_matrix/client/v3/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						type: "m.login.password",
						identifier: { type: "m.id.user", user: userId },
						password: password,
						device_id: deviceId,
						initial_device_display_name: "LuneOS"
					})
				});
			}).then(function (r) {
				if (!r || !r.access_token) { throw new Error("The server did not hand out a token."); }
				if (r.user_id !== userId) { throw new Error("The server logged in " + r.user_id + ", not " + userId + "."); }
				var seed = {
					v: 1, homeserver: hs, user_id: r.user_id, device_id: r.device_id || deviceId,
					access_token: r.access_token
				};
				if (recoveryKey) { seed.recovery_key = recoveryKey; }
				return self.encodeSeed(seed);
			}, function (e) {
				if (e.status === 403) { throw new Error("Wrong Matrix ID or password."); }
				if (e.status === 429) { throw new Error("Too many attempts; wait a minute and try again."); }
				throw new Error("Could not sign in: " + e.message);
			});
		},

		/*
		 * Prepare a sign-in: everything up to the authorization page. Resolves to
		 *   { oauth: false, homeserver }                  when the server has no OAuth, or
		 *   { oauth: true, homeserver, meta, clientId, deviceId, state, verifier, url }
		 */
		prepare: function (userId) {
			var self = this, out = {};
			return this.discover(this.serverOf(userId)).then(function (hs) {
				out.homeserver = hs;
				return self.metadata(hs);
			}).then(function (meta) {
				if (!meta) { out.oauth = false; return out; }
				out.oauth = true;
				out.meta = meta;
				return self.register(meta).then(function (clientId) {
					out.clientId = clientId;
					out.deviceId = self.deviceId();
					out.state = self.randomString(16);
					return self.pkce();
				}).then(function (p) {
					out.verifier = p.verifier;
					out.url = self.authorizeUrl(meta, {
						clientId: out.clientId, deviceId: out.deviceId, state: out.state,
						challenge: p.challenge, userId: userId
					});
					return out;
				});
			});
		},

		// Finish a prepared sign-in with the redirect URL; resolves to the stored password.
		finish: function (prep, redirectUrl, userId, recoveryKey) {
			var self = this, code, tok;
			try { code = this.codeFromRedirect(redirectUrl, prep.state); } catch (e) { return Promise.reject(e); }
			var started = Date.now();
			return this.exchange(prep.meta, prep.clientId, code, prep.verifier).then(function (t) {
				if (!t || !t.access_token) { throw new Error("The server did not hand out a token."); }
				tok = t;
				return self.whoami(prep.homeserver, t.access_token);
			}).then(function (who) {
				if (!who || who.user_id !== userId) {
					throw new Error("You signed in as " + (who && who.user_id) + ", not " + userId +
						". Sign out of that account in the browser window, or enter that ID here.");
				}
				if (who.device_id && who.device_id !== prep.deviceId) {
					throw new Error("The server gave this device another ID than it was asked for.");
				}
				var seed = {
					v: 1,
					homeserver: prep.homeserver,
					issuer: prep.meta.issuer || "",
					client_id: prep.clientId,
					user_id: who.user_id,
					device_id: prep.deviceId,
					access_token: tok.access_token
				};
				if (tok.refresh_token) { seed.refresh_token = tok.refresh_token; }
				if (tok.expires_in) { seed.expires_at_ms = started + tok.expires_in * 1000; }
				if (recoveryKey) { seed.recovery_key = recoveryKey; }
				return self.encodeSeed(seed);
			});
		}
	};

	root.MatrixAuth = MatrixAuth;
	if (typeof module !== "undefined" && module.exports) { module.exports = MatrixAuth; }
}(typeof window !== "undefined" ? window : this));
