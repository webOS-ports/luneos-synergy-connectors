/* service.js - com.palm.service.photoprism: PhotoPrism (self-hosted, app password, photos only) on _cloudcore/node.
 *
 * The launcher (run-js-service -> jsservicelauncher/bootstrap-node.js) requires this directory,
 * as it has a package.json, and calls run(). Nothing starts on require, so a test can start()
 * it on a stand-in bus and fetch.
 *
 * Like cloud/immich it is a photo source with its own methods on the core's bus, http and
 * errors, not one of _cloudcore's file connectors. It has no OAuth: the user brings their server's
 * address, user name and password, which login trades for an app password of its own, so there
 * is no getAuthorizeUrl or exchangeCode.
 *
 *   login            { server, username, password } -> { username, alias, credentials:{ common } } open (login.js)
 *   checkCredentials { credentials:{ common } }  -> { username }                                 open
 *   downloadFile     { url, localPath }          -> { path }                                     the Photos app
 *   listAlbums, listPhotos                       -> photos.js                                    open
 *
 * Accounts calls checkCredentials with no app id, the Photos service listAlbums and listPhotos;
 * the bus role decides who reaches the service at all.
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
const loginMethods = require("./login.js");
const photoMethods = require("./photos.js");

const SERVICE_NAME = "com.palm.service.photoprism";
// The LuneOS Photos app (as the bus role and the account grant it), and the legacy Palm one.
const PHOTOS_APP_IDS = ["org.webosports.app.photos", "org.webosports.app.photos-*", "com.palm.app.photos"];
const { TIMEOUTS } = core;

function createMethods({ api, http, resolve, log }) {
	return Object.assign({
		// Accounts' onCredentialsChanged. The app password never expires; a failure means it was
		// deleted in PhotoPrism (Settings -> Account -> Apps and Devices).
		checkCredentials: { timeoutMs: TIMEOUTS.account, handler: async (p) => {
			const creds = p.credentials && p.credentials.common;
			if (!creds || !creds.token || !creds.server) { throw new core.CloudError("401_UNAUTHORIZED", "no PhotoPrism server and app password"); }
			await api.config(creds);
			return { username: creds.username };
		} },

		// A photo URL (listPhotos') to localPath, fetched as it is: its token is in the URL.
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
	}, loginMethods({ config, adapter: api, CloudError: core.CloudError, log }),
	photoMethods({ config, api, resolve, log }));
}

// A new instance on `palmbus` each time (a test starts many); run() starts the one.
// timeouts: { timeoutMs, idleTimeoutMs } for http.js.
function start({ palmbus, fetch, exit, idleMs, log = console, timeouts = {} } = {}) {
	const bus = core.createBus({ palmbus, name: SERVICE_NAME, exit, idleMs, log });
	const http = core.createHttp(Object.assign({ fetch, errorCode: createAdapter.ERROR, describe: createAdapter.describe }, timeouts));
	const api = createAdapter({ config, http, errors: core });
	const resolve = (p) => createAdapter.resolveCredentials(bus.call, core, p);
	const methods = createMethods({ api, http, resolve, log });
	bus.serve(methods);
	log.log(SERVICE_NAME + ": up (" + Object.keys(methods).length + " methods, node " + process.version + ")");
	return { bus, methods, api, http };
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
