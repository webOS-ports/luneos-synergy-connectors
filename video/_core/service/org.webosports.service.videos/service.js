/* service.js - org.webosports.service.videos: the video services of Synergy (Jellyfin, UPnP/DLNA,
 * PeerTube, Plex) for Videos, on _cloudcore/node's bus and HTTP.
 *
 * The launcher (run-js-service -> jsservicelauncher/bootstrap-node.js) requires this directory, as
 * it has a package.json, and calls run(). Nothing starts on require, so a test can start() the
 * service on a stand-in bus, fetch and SSDP. See videos.js for the methods and the provider API.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.js");
const { createVideos } = require("./videos.js");
const { createSsdp } = require("./ssdp.js");
const Config = require("./config.js").Config;

// providers/<name>.js beside this file on the device; video/<name>/provider/ in the repository.
function loadProvider(name) {
	const installed = path.join(__dirname, "providers", name + ".js");
	return require(fs.existsSync(installed) ? installed : path.join(__dirname, "../../../" + name + "/provider"));
}

function start({ palmbus, fetch, ssdp, exit, idleMs, log = console, timeouts = {}, random, fanOutMs } = {}) {
	const bus = core.createBus({ palmbus, name: Config.SERVICE_NAME, exit, idleMs, log });
	const http = core.createHttp(Object.assign({ fetch, errorCode: "VIDEO_SERVER_ERROR" }, timeouts));
	const providers = Config.PROVIDERS.map(loadProvider);
	const methods = createVideos({ config: Config, providers, call: bus.call, http,
		ssdp: ssdp || createSsdp({ log }), log, random, fanOutMs });
	bus.serve(methods);
	log.log(Config.SERVICE_NAME + ": up (" + Object.keys(methods).length + " methods, node " + process.version + ")");
	return { bus, methods, http, providers };
}

let running = null;
function run() {
	if (running) { return running; }
	process.title = Config.SERVICE_NAME;
	// palmbus is the launcher's: it is there on the device and nowhere else.
	running = start({ palmbus: require("palmbus") });
	return running;
}

module.exports = { start, run, Config };

if (require.main === module) { run(); }
