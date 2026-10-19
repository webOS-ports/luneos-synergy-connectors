/* bus.js - the connector on the luna bus, through palmbus directly.
 *
 * As Documents' own service does (org.webosports.app.documents.service), and not through
 * webos-service: that one creates an activity for every call, and a call waits forever when the
 * activity manager refuses it. The service exits after an idle time; the bus starts it again on
 * the next call.
 *
 *   const bus = createBus({ palmbus, name });
 *   bus.serve({ listFolder: { allow: ["org.webosports.app.documents"], timeoutMs: 60000,
 *                             handler: async (params, ctx) => ({ entries }) } });
 *   await bus.call("luna://com.palm.service.accounts/readCredentials", { accountId });
 *
 * Every request gets exactly one reply, whatever the handler does: its return value with
 * returnValue:true, or what it threw (errors.toReply), or TIMEOUT when it has not settled by
 * the method's deadline. The payload must be a JSON object. A method's `allow` is a list of
 * caller globs (* ? as in the account templates, as acl.js matched them); none means open.
 * `quit` and `info` are there for the installer, which asks a service to quit before an update.
 */
"use strict";

const { CloudError, toReply, isUnexpected } = require("./errors.js");

const IDLE_MS = 30000;
const CALL_TIMEOUT_MS = 30000;
const METHOD_TIMEOUT_MS = 60000;

// The caller of an incoming message, as com.palm.service.accounts and acl.js take it: the app id
// (a WAM app's comes as "<appid> <pid>"), or else the calling service's name; "" for neither
// (a raw luna-send from a shell).
function callerId(msg) {
	let id = "";
	try { id = msg.applicationID() || msg.senderServiceName() || ""; }
	catch (e) { id = ""; }
	return String(id).split(" ")[0];
}

// Template glob: * any run, ? one character, everything else literal.
function globMatch(glob, id) {
	const re = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp("^" + re + "$").test(id);
}

function permitted(allow, caller) {
	if (!allow || !allow.length) { return true; }
	return allow.some((g) => globMatch(g, caller));
}

function decodePayload(text) {
	let p;
	try { p = JSON.parse(text || "{}"); }
	catch (e) { throw new CloudError("BAD_ARGS", "the payload is not JSON"); }
	if (!p || typeof p !== "object" || Array.isArray(p)) {
		throw new CloudError("BAD_ARGS", "the payload must be a JSON object");
	}
	return p;
}

function createBus({ palmbus, name, idleMs = IDLE_MS, callTimeoutMs = CALL_TIMEOUT_MS,
	exit = (code) => process.exit(code), log = console } = {}) {
	const handle = new palmbus.Handle(name);
	let methods = {};
	let inflight = 0;
	let idle = null;
	let stopped = false;

	// The idle clock runs only while no request is being worked on: an upload can take minutes.
	function touch() {
		if (idle) { clearTimeout(idle); idle = null; }
		if (stopped || inflight > 0 || !idleMs) { return; }
		idle = setTimeout(() => { log.log(name + ": idle, exiting"); exit(0); }, idleMs);
	}

	function builtin(method) {
		if (method === "info") {
			return { handler: () => ({ id: name, methods: Object.keys(methods).concat(["quit", "info"]) }) };
		}
		if (method === "quit") {
			return { handler: () => { setTimeout(() => exit(0), 200); return { status: "quitting" }; } };
		}
		return null;
	}

	async function dispatch(msg) {
		inflight++;
		touch();
		let done = false, deadline = null;
		const send = (obj) => {
			if (done) { return; }
			done = true;
			if (deadline) { clearTimeout(deadline); }
			let text;
			try { text = JSON.stringify(obj); }
			catch (e) { text = JSON.stringify(toReply(e)); }
			try { msg.respond(text); }
			catch (e) { log.error(name + ": respond failed: " + ((e && e.message) || e)); }
			inflight--;
			touch();
		};
		let method = "?";
		try {
			method = String(msg.method());
			const spec = (Object.prototype.hasOwnProperty.call(methods, method) && methods[method]) || builtin(method);
			if (!spec) { throw new CloudError("NOT_SUPPORTED", "unknown method " + method); }
			const caller = callerId(msg);
			if (!permitted(spec.allow, caller)) {
				log.log(name + ": " + method + " denied caller '" + caller + "'; allows " + spec.allow.join(","));
				throw new CloudError("PERMISSION_DENIED", "caller '" + caller + "' is not permitted to call this method");
			}
			const params = decodePayload(msg.payload());
			const ms = spec.timeoutMs || METHOD_TIMEOUT_MS;
			deadline = setTimeout(() => {
				log.error(name + ": " + method + " did not finish in " + ms + " ms");
				send({ returnValue: false, errorCode: "TIMEOUT", errorText: method + " timed out after " + Math.round(ms / 1000) + " s" });
			}, ms);
			const out = await spec.handler(params, { caller, method, call: bus.call });
			const reply = Object.assign({ returnValue: true }, (out && typeof out === "object") ? out : {});
			reply.returnValue = true;
			send(reply);
		} catch (e) {
			if (isUnexpected(e)) { log.error(name + ": " + method + " threw: " + ((e && e.stack) || e)); }
			send(toReply(e));
		}
	}

	const bus = {
		handle,

		// Register `methods` ({ name: { handler, allow?, timeoutMs? } }) and start answering.
		serve(table) {
			methods = Object.assign({}, table);
			for (const m of Object.keys(methods).concat(["quit", "info"])) { handle.registerMethod("/", m); }
			handle.addListener("request", (msg) => { dispatch(msg); });
			touch();
			return bus;
		},

		// One call to another service: the parsed reply, or a CloudError carrying the reply's
		// errorCode when it says returnValue:false. No reply within timeoutMs is BUS_TIMEOUT.
		call(uri, args, { timeoutMs = callTimeoutMs } = {}) {
			return new Promise((resolve, reject) => {
				let req = null, settled = false;
				const finish = (fn, v) => { if (settled) { return; } settled = true; clearTimeout(timer); fn(v); };
				const timer = setTimeout(() => {
					finish(reject, new CloudError("BUS_TIMEOUT", uri + ": no reply in " + timeoutMs + " ms"));
					try { if (req && typeof req.cancel === "function") { req.cancel(); } } catch (e) { /* gone already */ }
				}, timeoutMs);
				try {
					req = handle.call(uri, JSON.stringify(args || {}));
					req.addListener("response", (m) => {
						let r;
						try { r = JSON.parse(m.payload()); }
						catch (e) { finish(reject, new CloudError("BUS_BAD_REPLY", uri + ": reply is not JSON")); return; }
						if (!r || typeof r !== "object" || r.returnValue === false) {
							const code = (r && r.errorCode !== undefined && r.errorCode !== null) ? r.errorCode : "BUS_ERROR";
							finish(reject, new CloudError(code, (r && r.errorText) || (uri + " failed")));
							return;
						}
						finish(resolve, r);
					});
				} catch (e) {
					finish(reject, new CloudError("BUS_ERROR", uri + ": " + ((e && e.message) || e)));
				}
			});
		},

		// Tests: stop the idle clock.
		stop() { stopped = true; if (idle) { clearTimeout(idle); idle = null; } },

		get inflight() { return inflight; },
	};
	return bus;
}

module.exports = { createBus, callerId, globMatch, permitted, decodePayload, IDLE_MS };
