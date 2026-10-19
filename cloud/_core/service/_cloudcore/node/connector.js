/* connector.js - one cloud connector service: Config + adapter + the generic commands, on the bus.
 *
 *   module.exports = connector({
 *       config,                         // the provider's config.js Config
 *       errorCode: "DROPBOX_API_ERROR", // what a provider HTTP error replies
 *       describe,                       // optional (status, body) -> errorText for those
 *       adapter: ({ config, http, errors }) => adapter,  // the provider's API, see commands.js
 *       methods: (deps) => ({ listAlbums: {...}, .. }),  // optional: extra or replaced methods
 *   });
 *
 * The launcher (jsservicelauncher bootstrap-node.js) does require(service_dir) for a service
 * directory with a package.json, then calls the module's run(appId). Nothing starts on require,
 * so a test can require the service and start() it on a stand-in bus and fetch.
 *
 * deps, for the methods factory: { config, http, adapter, oauth, store, log, withAccount, call }.
 * oauth is null for a connector whose Config has no TOKEN_URL (or that passes oauth:false).
 */
"use strict";

const errors = require("./errors.js");
const { createBus } = require("./bus.js");
const { createHttp } = require("./http.js");
const { createOAuth } = require("./oauth.js");
const { createAccountStore } = require("./creds.js");
const { createCommands, createAccountRunner } = require("./commands.js");

function connector(spec) {
	const { config } = spec;
	let running = null;

	// A new instance on `palmbus` each time (a test starts many); run() starts the one.
	// timeouts: { timeoutMs, idleTimeoutMs } for http.js (tests shorten them).
	function start({ palmbus, fetch, exit, idleMs, log = console, random, timeouts = {} } = {}) {
		const bus = createBus({ palmbus, name: config.SERVICE_NAME, exit, idleMs, log });
		const http = createHttp(Object.assign({ fetch, errorCode: spec.errorCode, describe: spec.describe }, timeouts));
		const oauth = (spec.oauth === false || !config.TOKEN_URL) ? null : createOAuth({ config, http, random });
		const adapter = spec.adapter({ config, http, errors });
		const store = createAccountStore({ call: bus.call, log });
		const deps = { config, http, adapter, oauth, store, log, call: bus.call,
			withAccount: createAccountRunner({ store, oauth }) };
		const methods = Object.assign(createCommands({ config, adapter, store, oauth }),
			spec.methods ? spec.methods(deps) : {});
		bus.serve(methods);
		log.log(config.SERVICE_NAME + ": up (" + Object.keys(methods).length + " methods, node " + process.version + ")");
		return { bus, methods, adapter, oauth, http, store };
	}

	function run() {
		if (running) { return running; }
		process.title = config.SERVICE_NAME;
		// palmbus is the launcher's: it is there on the device and nowhere else.
		running = start({ palmbus: require("palmbus") });
		return running;
	}

	return { config, start, run };
}

module.exports = { connector };
