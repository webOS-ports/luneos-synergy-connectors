// node --test tests/unit
// _cloudcore/node/bus.js on a stand-in palmbus: dispatch, the caller rules, exactly one reply
// whatever the handler does, the payload check, idle exit, quit/info, and outgoing calls.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fakePalmbus, ask } = require("./lib/fakes.js");

const NODE = path.join(__dirname, "../../cloud/_core/service/_cloudcore/node");
const { createBus, callerId, globMatch } = require(path.join(NODE, "bus.js"));
const { CloudError } = require(path.join(NODE, "errors.js"));

const quiet = { log() {}, error() {} };

function setup(methods, opts = {}) {
	const pb = fakePalmbus(opts);
	const exits = [];
	const bus = createBus({ palmbus: pb, name: "com.palm.service.test", idleMs: opts.idleMs || 0,
		exit: (c) => exits.push(c), log: quiet, callTimeoutMs: opts.callTimeoutMs });
	bus.serve(methods);
	const handle = pb.handles[0];
	test.after(() => bus.stop());
	return { bus, handle, exits };
}

test("methods are registered on / with quit and info, and a reply carries returnValue:true", async () => {
	const { handle } = setup({ hello: { handler: (p, ctx) => ({ hi: p.who, caller: ctx.caller, returnValue: false }) } });
	assert.deepStrictEqual(handle.methods, ["/hello", "/quit", "/info"]);
	assert.strictEqual(handle.name, "com.palm.service.test");
	const r = await ask(handle, "hello", { who: "you" }, { appId: "org.example.app 1234" });
	assert.deepStrictEqual(r, { returnValue: true, hi: "you", caller: "org.example.app" });
	assert.deepStrictEqual(await ask(handle, "info", {}), { returnValue: true, id: "com.palm.service.test", methods: ["hello", "quit", "info"] });
});

test("a handler returning nothing still answers returnValue:true", async () => {
	const { handle } = setup({ none: { handler: async () => undefined } });
	assert.deepStrictEqual(await ask(handle, "none", {}), { returnValue: true });
});

test("every kind of failure is exactly one error reply", async () => {
	const { handle } = setup({
		cloud: { handler: () => { throw new CloudError("MISSING_ARGS", "need x"); } },
		http: { handler: async () => { throw new CloudError("DROPBOX_API_ERROR", "Dropbox answered HTTP 409", { status: 409, body: "secret-ish body" }); } },
		legacy: { handler: async () => { throw { returnValue: false, errorCode: "NO_CREDENTIALS", detail: "pass credentials or accountId" }; } },
		type: { handler: (p) => p.a.b.c },
		string: { handler: async () => { throw "boom"; } },
		bigint: { handler: () => ({ n: 1n }) },
		later: { handler: () => new Promise((res, rej) => setTimeout(() => rej(new TypeError("late")), 5)) },
	});
	assert.deepStrictEqual(await ask(handle, "cloud", {}), { returnValue: false, errorCode: "MISSING_ARGS", errorText: "need x" });
	assert.deepStrictEqual(await ask(handle, "http", {}), { returnValue: false, errorCode: "DROPBOX_API_ERROR",
		errorText: "Dropbox answered HTTP 409", status: 409 });
	assert.deepStrictEqual(await ask(handle, "legacy", {}), { returnValue: false, errorCode: "NO_CREDENTIALS",
		errorText: "pass credentials or accountId" });
	const t = await ask(handle, "type", {});
	assert.strictEqual(t.errorCode, "CONNECTOR_EXCEPTION");
	assert.match(t.errorText, /Cannot read/);
	assert.deepStrictEqual(await ask(handle, "string", {}), { returnValue: false, errorCode: "CONNECTOR_EXCEPTION", errorText: "boom" });
	assert.strictEqual((await ask(handle, "bigint", {})).errorCode, "CONNECTOR_EXCEPTION");
	assert.strictEqual((await ask(handle, "later", {})).errorText, "late");
});

test("the payload must be a JSON object", async () => {
	let ran = 0;
	const { handle } = setup({ m: { handler: () => { ran++; return {}; } } });
	for (const bad of ["[]", "null", "x", "42", "\"s\""]) {
		const r = await ask(handle, "m", bad);
		assert.strictEqual(r.errorCode, "BAD_ARGS", bad);
	}
	assert.deepStrictEqual(await ask(handle, "m", ""), { returnValue: true });   // no payload: {}
	assert.strictEqual(ran, 1);
});

test("an unknown method is NOT_SUPPORTED, and Object.prototype names are not methods", async () => {
	const { handle } = setup({});
	assert.strictEqual((await ask(handle, "nope", {})).errorCode, "NOT_SUPPORTED");
	assert.strictEqual((await ask(handle, "toString", {})).errorCode, "NOT_SUPPORTED");
	assert.strictEqual((await ask(handle, "constructor", {})).errorCode, "NOT_SUPPORTED");
});

test("allow: caller globs on the app id, else the service name; none means open", async () => {
	let ran = 0;
	const { handle } = setup({
		gated: { allow: ["org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service"],
			handler: () => { ran++; return {}; } },
		open: { allow: [], handler: () => ({}) },
	});
	const ok = (c) => ask(handle, "gated", {}, c).then((r) => r.returnValue);
	assert.strictEqual(await ok({ appId: "org.webosports.app.documents 811" }), true);
	assert.strictEqual(await ok({ appId: "org.webosports.app.documents-1234" }), true);
	assert.strictEqual(await ok({ service: "com.palm.stark.files.service" }), true);
	for (const c of [{}, { appId: "org.webosports.app.documentsX" }, { appId: "com.palm.app.cloud-auth" },
		{ service: "com.palm.stark.files.serviceX" }, { appId: "org" }]) {
		const r = await ask(handle, "gated", {}, c);
		assert.strictEqual(r.errorCode, "PERMISSION_DENIED", JSON.stringify(c));
	}
	assert.strictEqual(ran, 3);
	assert.strictEqual((await ask(handle, "open", {}, {})).returnValue, true);
});

test("callerId and globMatch", () => {
	const m = (app, svc) => ({ applicationID: () => app, senderServiceName: () => svc });
	assert.strictEqual(callerId(m("a.b 12", "s")), "a.b");
	assert.strictEqual(callerId(m("", "com.palm.service.photos")), "com.palm.service.photos");
	assert.strictEqual(callerId({ applicationID() { throw new Error("x"); } }), "");
	assert.ok(globMatch("a.?.c*", "a.b.cdef"));
	assert.ok(!globMatch("a.b", "aXb"));         // "." is literal
	assert.ok(!globMatch("a+b", "aab"));         // so is every other regexp character
	assert.ok(globMatch("a+b", "a+b"));
});

test("a handler past its deadline gets TIMEOUT, and its late answer is dropped", async () => {
	let finish;
	const { handle, bus } = setup({ slow: { timeoutMs: 20, handler: () => new Promise((r) => { finish = r; }) } });
	const r = handle.request("slow", {});
	const first = await r.first;
	assert.strictEqual(first.errorCode, "TIMEOUT");
	assert.strictEqual(bus.inflight, 0);
	finish({ late: true });
	await new Promise((res) => setTimeout(res, 10));
	assert.strictEqual(r.replies.length, 1);
});

test("idle exit: only after the idle time with no request in flight", async () => {
	let finish;
	const { handle, exits } = setup({ slow: { timeoutMs: 1000, handler: () => new Promise((r) => { finish = r; }) } }, { idleMs: 40 });
	const r = handle.request("slow", {});
	await new Promise((res) => setTimeout(res, 80));
	assert.deepStrictEqual(exits, [], "no exit while a request is being worked on");
	finish({});
	await r.first;
	await new Promise((res) => setTimeout(res, 20));
	assert.deepStrictEqual(exits, [], "the idle clock starts again from the reply");
	await new Promise((res) => setTimeout(res, 40));
	assert.deepStrictEqual(exits, [0]);
});

test("idle exit: a request that is already waiting when the idle clock runs out is served, no exit", async (t) => {
	// Only setTimeout is mocked: the bus's check after the poll phase uses the real setImmediate.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const turns = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => setImmediate(r)); } };
	const { handle, exits } = setup({ fast: { handler: () => ({ ok: 1 }) } }, { idleMs: 40 });
	t.mock.timers.tick(40);   // the idle clock runs out ...
	const r = handle.request("fast", {});   // ... with a request read in the same loop turn
	assert.deepStrictEqual(await r.first, { returnValue: true, ok: 1 });
	await turns();
	assert.deepStrictEqual(exits, [], "the request called the exit off");
	t.mock.timers.tick(40);
	await turns();
	assert.deepStrictEqual(exits, [0], "and the idle clock ran again after it");
});

test("quit answers, then exits", async () => {
	const { handle, exits } = setup({});
	assert.deepStrictEqual(await ask(handle, "quit", {}), { returnValue: true, status: "quitting" });
	assert.deepStrictEqual(exits, []);
	await new Promise((res) => setTimeout(res, 250));
	assert.deepStrictEqual(exits, [0]);
});

test("call(): the parsed reply; a returnValue:false reply rejects with its errorCode", async () => {
	const { bus, handle } = setup({}, { onCall: (uri, args) => {
		if (/ok$/.test(uri)) { return { returnValue: true, echo: args }; }
		if (/denied$/.test(uri)) { return { returnValue: false, errorCode: -1, errorText: "Denied method call" }; }
		if (/raw$/.test(uri)) { return "not json"; }
		return undefined;
	} });
	assert.deepStrictEqual(await bus.call("luna://x/ok", { a: 1 }), { returnValue: true, echo: { a: 1 } });
	assert.deepStrictEqual(handle.calls[0], { uri: "luna://x/ok", args: { a: 1 } });
	await assert.rejects(bus.call("luna://x/denied", {}), (e) => e.errorCode === -1 && /Denied/.test(e.errorText));
	await assert.rejects(bus.call("luna://x/raw", {}), (e) => e.errorCode === "BUS_BAD_REPLY");
	await assert.rejects(bus.call("luna://x/silent", {}, { timeoutMs: 20 }), (e) => e.errorCode === "BUS_TIMEOUT");
});

test("call(): a handle that throws rejects instead", async () => {
	const { bus, handle } = setup({});
	handle.call = () => { throw new Error("no hub"); };
	await assert.rejects(bus.call("luna://x/y", {}), (e) => e.errorCode === "BUS_ERROR");
});
