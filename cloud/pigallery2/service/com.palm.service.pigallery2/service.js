/* service.js - com.palm.service.pigallery2: PiGallery2 (self-hosted, folders, photos only) on _cloudcore/node.
 *
 * The launcher (run-js-service -> jsservicelauncher/bootstrap-node.js) requires this directory,
 * as it has a package.json, and calls run(). Nothing starts on require, so a test can start()
 * it on a stand-in bus and fetch.
 *
 * Like cloud/photoprism it is a photo source with its own methods on the core's bus, http and
 * errors, not one of _cloudcore's file connectors. It has no OAuth: the user brings their server's
 * address, user name and password, so there is no getAuthorizeUrl or exchangeCode.
 *
 *   login            { server, username, password } -> { username, alias, credentials:{ common } } open (login.js)
 *   checkCredentials { credentials:{ common } }  -> { username }                                 open
 *   listAlbums, listPhotos                       -> photos.js                                    open
 *
 * Accounts calls checkCredentials with no app id, the Photos service listAlbums and listPhotos;
 * the bus role decides who reaches the service at all. There is no downloadFile: the Photos
 * service downloads the photos itself, with the session listPhotos hands it.
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

const SERVICE_NAME = "com.palm.service.pigallery2";
const { TIMEOUTS } = core;

function createMethods({ api, resolve, log }) {
	return Object.assign({
		// Accounts' onCredentialsChanged: the stored sign-in still opens a session (an open
		// gallery: still lets anyone in).
		checkCredentials: { timeoutMs: TIMEOUTS.account, handler: async (p) => {
			const creds = p.credentials && p.credentials.common;
			if (!creds || !creds.server || (creds.open !== true && (!creds.username || !creds.password))) {
				throw new core.CloudError("401_UNAUTHORIZED", "no PiGallery2 server and sign-in");
			}
			api.forget();
			await api.withSession(creds, (cookie) => api.me(creds.server, cookie));
			return { username: creds.open === true ? new URL(creds.server).host : creds.username };
		} },
	}, loginMethods({ config, adapter: api, CloudError: core.CloudError, log }),
	photoMethods({ config, adapter: api, resolve, CloudError: core.CloudError, log }));
}

// A new instance on `palmbus` each time (a test starts many); run() starts the one.
// timeouts: { timeoutMs, idleTimeoutMs } for http.js; now: the clock the sessions age by.
function start({ palmbus, fetch, exit, idleMs, log = console, timeouts = {}, now } = {}) {
	const bus = core.createBus({ palmbus, name: SERVICE_NAME, exit, idleMs, log });
	const http = core.createHttp(Object.assign({ fetch, errorCode: createAdapter.ERROR, describe: createAdapter.describe }, timeouts));
	const api = createAdapter({ config, http, errors: core, now });
	const resolve = (p) => createAdapter.resolveCredentials(bus.call, core, p);
	const methods = createMethods({ api, resolve, log });
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

module.exports = { config, start, run, SERVICE_NAME };

if (require.main === module) { run(); }
