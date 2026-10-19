// Stand-ins for the node connectors' tests: a palmbus (the launcher's luna binding) and a fetch
// that records every request and answers from a route table.
"use strict";

const { EventEmitter } = require("node:events");

// --- palmbus ---------------------------------------------------------------------------------
// new palmbus.Handle(name); handle.registerMethod("/", m); handle.addListener("request", fn);
// handle.call(uri, json) -> request emitting "response" with a message whose payload() is JSON.
// onCall(uri, args) answers outgoing calls: an object (sent as the reply), a string (sent raw),
// or undefined (no reply ever).
function fakePalmbus({ onCall = () => ({ returnValue: true }) } = {}) {
	const handles = [];
	class Handle {
		constructor(name) {
			this.name = name;
			this.methods = [];
			this.listeners = {};
			this.calls = [];
			this.onCall = onCall;
			handles.push(this);
		}
		registerMethod(category, m) { this.methods.push(category + m); }
		addListener(ev, fn) { this.listeners[ev] = fn; }
		call(uri, payload) {
			const req = new EventEmitter();
			const args = JSON.parse(payload);
			this.calls.push({ uri, args });
			req.cancel = () => { req.cancelled = true; };
			setImmediate(async () => {
				const r = await this.onCall(uri, args);
				if (r === undefined) { return; }
				req.emit("response", { payload: () => (typeof r === "string" ? r : JSON.stringify(r)) });
			});
			return req;
		}
		// Deliver a request as the hub would. -> { replies, first: Promise<parsed first reply> }
		request(method, payload, { appId = "", service = "" } = {}) {
			const replies = [];
			let resolveFirst;
			const first = new Promise((r) => { resolveFirst = r; });
			const msg = {
				method: () => method,
				payload: () => (typeof payload === "string" ? payload : JSON.stringify(payload === undefined ? {} : payload)),
				applicationID: () => appId,
				senderServiceName: () => service,
				respond: (text) => { const v = JSON.parse(text); replies.push(v); if (replies.length === 1) { resolveFirst(v); } return true; },
			};
			this.listeners.request(msg);
			return { replies, first };
		}
	}
	return { Handle, handles };
}

// Ask, and wait until the reply is in and a little longer, to see that no second one follows.
async function ask(handle, method, payload, caller) {
	const r = handle.request(method, payload, caller);
	const v = await r.first;
	await new Promise((res) => setTimeout(res, 15));
	if (r.replies.length !== 1) { throw new Error(method + ": " + r.replies.length + " replies"); }
	return v;
}

// --- fetch -----------------------------------------------------------------------------------
// routes: [[method, urlRegExp, (req) => reply, { once }]], tried in order. A reply is
// { status, body (string | object -> JSON), headers } or a Response; a route function that
// throws makes fetch reject as a network failure; one that returns a never-settling Promise
// waits until the request is aborted.
// Recorded requests: { method, url, headers (as passed), body (string, or { blob: size, text },
// or { form: [[name, value | { file, name, size, text }]] }, or URLSearchParams string) }.
function fakeFetch(routes) {
	const requests = [];
	async function record(url, init) {
		const b = init.body;
		let body = b;
		if (b instanceof URLSearchParams) { body = b.toString(); }
		else if (b instanceof Blob) { body = { blob: b.size, text: await b.text() }; }
		else if (b instanceof FormData) {
			const form = [];
			for (const [k, v] of b.entries()) {
				form.push([k, (v instanceof Blob) ? { name: v.name, size: v.size, text: await v.text() } : v]);
			}
			body = { form };
		}
		const req = { method: init.method || "GET", url: String(url), headers: Object.assign({}, init.headers || {}), body };
		requests.push(req);
		return req;
	}
	async function fetch(url, init = {}) {
		const req = await record(url, init);
		const i = routes.findIndex(([m, re]) => m === req.method && re.test(req.url));
		if (i < 0) { return new Response("no route for " + req.method + " " + req.url, { status: 599 }); }
		const r = routes[i];
		if (r[3] && r[3].once) { routes.splice(i, 1); }
		let out;
		try {
			out = r[2](req);
		} catch (e) {
			throw new TypeError("fetch failed", { cause: { code: (e && e.code) || "ECONNREFUSED", message: String(e && e.message) } });
		}
		if (out && typeof out.then === "function") {
			out = await new Promise((resolve, reject) => {
				const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
				if (init.signal) { if (init.signal.aborted) { abort(); } init.signal.addEventListener("abort", abort); }
				out.then(resolve, reject);
			});
		}
		if (out instanceof Response) { return out; }
		const text = out.body === undefined ? "" : (typeof out.body === "string" || out.body instanceof Uint8Array ? out.body : JSON.stringify(out.body));
		return new Response(out.status === 204 ? null : text, { status: out.status || 200, headers: out.headers || {} });
	}
	return { fetch, requests };
}

const json = (o) => JSON.parse(JSON.stringify(o));

module.exports = { fakePalmbus, fakeFetch, ask, json };
