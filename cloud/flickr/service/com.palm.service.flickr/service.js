/* service.js - com.palm.service.flickr: Flickr (OAuth 1.0a, photos only) on _cloudcore/node.
 *
 * The launcher (run-js-service -> jsservicelauncher/bootstrap-node.js) requires this directory,
 * as it has a package.json, and calls run(). Nothing starts on require, so a test can start()
 * it on a stand-in bus and fetch.
 *
 * Flickr predates _cloudcore and is not one of its file connectors: it signs with OAuth 1.0a
 * (oauth1.js), its credentials are an oauthToken/oauthTokenSecret pair, and it has none of the
 * generic file methods. So it takes the core's bus, http and errors, and has its own methods,
 * the ones its services.json had, with the same arguments and replies:
 *
 *   getAuthorizeUrl  {}                                    -> { url, requestToken, requestTokenSecret }  open
 *   exchangeCode     { oauth_verifier|oauthVerifier|verifier, requestToken|oauth_token, requestTokenSecret }
 *                                                          -> { username, alias, credentials:{ common } } open
 *   checkCredentials { credentials:{ common } }             -> { username }                               open
 *   downloadFile     { url, localPath }                     -> { path }                  the Photos app
 *   listAlbums, listPhotos                                  -> photos.js                                 open
 *
 * getAuthorizeUrl is open: its command declared com.palm.app.flickr-auth but never checked it.
 * Accounts calls exchangeCode and checkCredentials with no app id, the Photos service
 * listAlbums and listPhotos; the bus role decides who reaches the service at all. The sign-in
 * app carries the request token and secret across the web login (the service exits while the
 * user signs in) and hands them back to exchangeCode.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// On the device _cloudcore is installed next to the services (synergy-cloudcore); in the
// repository it is cloud/_core/service/_cloudcore.
const installed = path.join(__dirname, "../_cloudcore/node");
const core = require(fs.existsSync(installed) ? installed : path.join(__dirname, "../../../_core/service/_cloudcore/node"));

const config = require("./config.js").Config;
const createAdapter = require("./adapter.js");
const { createOAuth1 } = require("./oauth1.js");
const photoMethods = require("./photos.js");

const SERVICE_NAME = "com.palm.service.flickr";
// The LuneOS Photos app (as the bus role and the account grant it), and the legacy Palm one.
const PHOTOS_APP_IDS = ["org.webosports.app.photos", "org.webosports.app.photos-*", "com.palm.app.photos"];
const { TIMEOUTS } = core;

function createMethods({ oauth1, api, http, resolve, log }) {
	return Object.assign({
		// OAuth leg 1, a signed request: the consent URL and the request token to carry.
		getAuthorizeUrl: { timeoutMs: TIMEOUTS.auth, handler: async () => {
			const t = await oauth1.getRequestToken();
			return { url: oauth1.authorizeUrl(t.oauthToken), requestToken: t.oauthToken, requestTokenSecret: t.oauthTokenSecret };
		} },

		// The account validator: leg 3. Flickr's access_token reply names the user, and Accounts
		// does not create an account without a username.
		exchangeCode: { timeoutMs: TIMEOUTS.account, handler: async (p) => {
			const verifier = p.oauth_verifier || p.oauthVerifier || p.verifier;
			const reqToken = p.requestToken || p.oauth_token;
			const reqSecret = p.requestTokenSecret;
			if (!verifier || !reqToken || !reqSecret) {
				throw new core.CloudError("MISSING_VERIFIER", "need oauth_verifier, requestToken and requestTokenSecret");
			}
			const common = await oauth1.getAccessToken(reqToken, reqSecret, verifier);
			return { username: common.username || common.userId || "Flickr", alias: common.fullname || undefined,
				credentials: { common } };
		} },

		// Accounts' onCredentialsChanged. The tokens never change; a failure means access was revoked.
		checkCredentials: { timeoutMs: TIMEOUTS.account, handler: async (p) => {
			const creds = p.credentials && p.credentials.common;
			if (!creds || !creds.oauthToken) { throw new core.CloudError("401_UNAUTHORIZED", "no Flickr token"); }
			const me = (await api.testLogin(creds)) || {};
			const user = (me.user && typeof me.user === "object") ? me.user : {};
			return { username: (user.username && user.username._content) || creds.username };
		} },

		// A static photo URL (listPhotos') to localPath. The URL needs no token, so nothing is signed.
		downloadFile: { allow: PHOTOS_APP_IDS, timeoutMs: TIMEOUTS.transfer, handler: async (p) => {
			if (!p.url || !p.localPath) { throw core.missingArgs("need url and localPath"); }
			if (typeof p.url !== "string" || typeof p.localPath !== "string") { throw core.badArgs("url and localPath are strings"); }
			let u = null;
			try { u = new URL(p.url); } catch (e) { u = null; }
			if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) { throw core.badArgs("url: an http(s) URL"); }
			await http.request({ method: "GET", url: p.url, toFile: p.localPath, errorCode: "DOWNLOAD_FAILED",
				describe: (status) => "the photo download answered HTTP " + status });
			return { path: p.localPath };
		} },
	}, photoMethods({ api, resolve, log }));
}

// A new instance on `palmbus` each time (a test starts many); run() starts the one.
// timeouts: { timeoutMs, idleTimeoutMs } for http.js. random(n) and now() feed the OAuth nonce
// and timestamp (tests fix them).
function start({ palmbus, fetch, exit, idleMs, log = console, random, now, timeouts = {} } = {}) {
	const bus = core.createBus({ palmbus, name: SERVICE_NAME, exit, idleMs, log });
	const http = core.createHttp(Object.assign({ fetch, errorCode: createAdapter.ERROR, describe: createAdapter.describe }, timeouts));
	const oauth1 = createOAuth1({ config, http, errors: core, random, now, log });
	const api = createAdapter({ config, http, errors: core, oauth1 });
	const resolve = (p) => createAdapter.resolveCredentials(bus.call, core, p);
	const methods = createMethods({ oauth1, api, http, resolve, log });
	bus.serve(methods);
	log.log(SERVICE_NAME + ": up (" + Object.keys(methods).length + " methods, node " + process.version + ")");
	return { bus, methods, api, oauth1, http };
}

let running = null;
function run() {
	if (running) { return running; }
	process.title = SERVICE_NAME;
	// palmbus is the launcher's: it is there on the device and nowhere else.
	running = start({ palmbus: require("palmbus") });
	return running;
}

module.exports = { config, start, run, SERVICE_NAME, PHOTOS_APP_IDS };

if (require.main === module) { run(); }
