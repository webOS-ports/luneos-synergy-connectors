// node --test tests/unit
// The Box adapter's createFolder, moveItem and deleteItem (the adapter half of
// _cloudcore's commands/fileOps_commands.js). Loads the real config.js, _cloudcore/oauth2.js and
// adapter.js into a sandbox, the way sources.json loads them on the device, with a stand-in
// HttpCurl.request that records each request and answers from a canned table.
//
// The stand-in Future follows Foundations' Future as far as these files use it: a queue of
// then() callbacks each taking the current result in turn, a Future returned from now()/then()
// is nested, and a throw inside a callback parks on that Future. Set FOUNDATIONS_FUTURE to the
// path of Foundations' control/future.js to run the same tests against the real one.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SVC = path.join(__dirname, "../../cloud/box/service/com.palm.service.boxnet");
const CORE = path.join(__dirname, "../../cloud/_core/service/_cloudcore");

class FakeFuture {
	constructor() { this._then = []; this._set = false; this._busy = false; this._read = false; }
	get result() { this._read = true; if (this._e !== undefined) { throw this._e; } return this._r; }
	set result(v) { this._r = v; this._e = undefined; this._set = true; this._read = false; this._dispatch(); }
	setException(e) { this._e = e; this._r = undefined; this._set = true; this._read = false; this._dispatch(); }
	now(scope, fn) { this._run(scope, fn); this._dispatch(); return this; }
	then(scope, fn) { this._then.push([scope, fn]); this._dispatch(); return this; }
	nest(inner) {
		inner.then(this, () => {
			let v;
			try { v = inner.result; } catch (e) { this.setException(e); return; }
			this.result = v;
		});
	}
	_run(scope, fn) {
		this._busy = true;
		try {
			const v = fn.call(scope, this);
			if (v !== undefined) {
				if (v && typeof v.then === "function") { this.nest(v); }
				else { this._r = v; this._e = undefined; this._set = true; this._read = false; }
			}
			if (this._e !== undefined && !this._read) { this._set = true; }   // unread: next then
		} catch (e) {
			this._e = e; this._r = undefined; this._set = true; this._read = false;
		}
		this._busy = false;
	}
	_dispatch() {
		if (this._busy) { return; }
		while (this._set && this._then.length) {
			const [scope, fn] = this._then.shift();
			this._set = false;
			this._run(scope, fn);
		}
	}
}

function futureClass() {
	if (!process.env.FOUNDATIONS_FUTURE) { return FakeFuture; }
	const ctx = { exports: { Control: {} }, console: { error() {} },
		Assert: { requireObject() {}, requireFunction() {} } };
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(process.env.FOUNDATIONS_FUTURE, "utf8"), ctx);
	return ctx.exports.Control.Future;
}

// routes: [[method, urlRegExp, (opts) => {status, body}]], tried in order; a route answering
// once is removed when it has `once`. Replies arrive asynchronously, as curl's do.
function load(routes) {
	const Future = futureClass();
	const requests = [];
	const HttpCurl = {
		request(opts) {
			requests.push(opts);
			const f = new Future();
			const i = routes.findIndex(([m, re]) => m === opts.method && re.test(opts.url));
			let reply = { status: 599, responseText: "no route for " + opts.method + " " + opts.url };
			if (i >= 0) {
				const r = routes[i];
				if (r[3] && r[3].once) { routes.splice(i, 1); }
				const out = r[2](opts);
				reply = { status: out.status, responseText: out.body === undefined ? "" :
					(typeof out.body === "string" ? out.body : JSON.stringify(out.body)) };
			}
			setImmediate(() => { f.result = reply; });
			return f;
		},
	};
	const ctx = { IMPORTS: { foundations: { Control: { Future } } }, HttpCurl, require, console: { log() {}, error() {} } };
	vm.createContext(ctx);
	for (const file of [path.join(SVC, "config.js"), path.join(CORE, "oauth2.js"), path.join(SVC, "adapter.js")]) {
		vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
	}
	return { Adapter: ctx.Adapter, Config: ctx.Config, requests };
}

// Resolve a Foundations-style Future into { value } or { error }.
const settle = (f) => new Promise((resolve) => f.then(null, () => {
	try { resolve({ value: f.result }); } catch (e) { resolve({ error: e }); }
}));
const plain = (o) => JSON.parse(JSON.stringify(o));
const CREDS = { accessToken: "tok", refreshToken: "ref" };
const API = "https://api.box.com/2.0";
const FIELDS = "fields=id,type,name,size,modified_at";
const body = (r) => JSON.parse(r.body);
const notFound = () => ({ status: 404, body: { type: "error", status: 404, code: "not_found" } });

const BOX_FILE = { type: "file", id: "111", name: "Report.pdf", size: 1234, modified_at: "2026-10-01T03:00:00-07:00" };
const FILE_ENTRY = { id: "111", type: "file", name: "Report.pdf", size: 1234,
	modified: "2026-10-01T10:00:00.000Z", path: "111" };
const BOX_FOLDER = { type: "folder", id: "222", name: "Sub", size: 0, modified_at: "2026-10-02T12:00:00Z" };
const FOLDER_ENTRY = { id: "222", type: "folder", name: "Sub", size: 0, modified: "2026-10-02T12:00:00.000Z", path: "222" };
// The probes that tell a file id from a folder id.
const isFile = (id) => [["GET", new RegExp("/files/" + id + "\\?fields=id,type$"), () => ({ status: 200, body: { type: "file", id } })]];
const isFolder = (id) => [["GET", new RegExp("/files/" + id + "\\?"), notFound],
	["GET", new RegExp("/folders/" + id + "\\?fields=id,type$"), () => ({ status: 200, body: { type: "folder", id } })]];

test("listFolder output is unchanged by the shared normaliser", async () => {
	const { Adapter, requests } = load([["GET", /\/folders\/0\/items/, () => ({ status: 200, body: { entries: [BOX_FILE, BOX_FOLDER] } })]]);
	const r = await settle(Adapter.listFolder(CREDS, "0"));
	assert.strictEqual(requests[0].url, API + "/folders/0/items?limit=1000&" + FIELDS);
	assert.deepStrictEqual(plain(r.value.entries), [FILE_ENTRY, FOLDER_ENTRY]);
});

test("createFolder: POST /folders { name, parent:{id} } as JSON; the entry is listFolder-shaped", async () => {
	const { Adapter, requests } = load([["POST", /\/folders\?/, () => ({ status: 201, body: BOX_FOLDER })]]);
	const r = await settle(Adapter.createFolder(CREDS, "333", "Sub"));
	assert.strictEqual(requests.length, 1);
	assert.strictEqual(requests[0].method, "POST");
	assert.strictEqual(requests[0].url, API + "/folders?" + FIELDS);
	assert.strictEqual(requests[0].bearer, "tok");
	assert.strictEqual(requests[0].headers["Content-Type"], "application/json");
	assert.deepStrictEqual(body(requests[0]), { name: "Sub", parent: { id: "333" } });
	assert.deepStrictEqual(plain(r.value), { entry: FOLDER_ENTRY });
});

test("createFolder: no parent is the root folder \"0\"", async () => {
	const { Adapter, requests } = load([["POST", /\/folders\?/, () => ({ status: 201, body: BOX_FOLDER })]]);
	await settle(Adapter.createFolder(CREDS, null, "Top"));
	assert.deepStrictEqual(body(requests[0]).parent, { id: "0" });
});

test("createFolder: a 409 item_name_in_use is a BOX_API_ERROR with status and body", async () => {
	const conflict = { type: "error", status: 409, code: "item_name_in_use" };
	const { Adapter } = load([["POST", /\/folders\?/, () => ({ status: 409, body: conflict })]]);
	const r = await settle(Adapter.createFolder(CREDS, "0", "Sub"));
	assert.strictEqual(r.error.returnValue, false);
	assert.strictEqual(r.error.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.error.status, 409);
	assert.deepStrictEqual(JSON.parse(r.error.body), conflict);
});

test("createFolder: a 401 refreshes, retries with the new token and reports the rotated refresh token", async () => {
	const renewed = [];
	const { Adapter, Config, requests } = load([
		["POST", /\/folders\?/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 3600 } })],
		["POST", /\/folders\?/, () => ({ status: 201, body: BOX_FOLDER })],
	]);
	const r = await settle(Adapter.createFolder(CREDS, "0", "Sub", (nc) => renewed.push(nc)));
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/folders?" + FIELDS, Config.TOKEN_URL, API + "/folders?" + FIELDS]);
	assert.strictEqual(requests[1].form.refresh_token, "ref");
	assert.strictEqual(requests[2].bearer, "tok2");
	assert.strictEqual(requests[2].body, requests[0].body);
	assert.strictEqual(renewed[0].refreshToken, "ref2");
	assert.deepStrictEqual(plain(r.value.entry), FOLDER_ENTRY);
});

test("moveItem on a file: probe GET /files/{id}, then PUT /files/{id}; rename only sends just name", async () => {
	const { Adapter, requests } = load([...isFile("111"),
		["PUT", /\/files\/111\?/, () => ({ status: 200, body: { ...BOX_FILE, name: "Final.pdf" } })]]);
	const r = await settle(Adapter.moveItem(CREDS, "111", null, "Final.pdf"));
	assert.deepStrictEqual(requests.map((q) => q.method + " " + q.url), [
		"GET " + API + "/files/111?fields=id,type", "PUT " + API + "/files/111?" + FIELDS]);
	assert.strictEqual(requests[1].headers["Content-Type"], "application/json");
	assert.deepStrictEqual(body(requests[1]), { name: "Final.pdf" });
	assert.deepStrictEqual(plain(r.value), { entry: { ...FILE_ENTRY, name: "Final.pdf" } });
});

test("moveItem on a file: move only sends just parent.id", async () => {
	const { Adapter, requests } = load([...isFile("111"), ["PUT", /\/files\/111\?/, () => ({ status: 200, body: BOX_FILE })]]);
	await settle(Adapter.moveItem(CREDS, "111", "444", null));
	assert.deepStrictEqual(body(requests[1]), { parent: { id: "444" } });
});

test("moveItem on a folder: the file probe's 404 leads to GET then PUT /folders/{id}, both fields", async () => {
	const { Adapter, requests } = load([...isFolder("222"),
		["PUT", /\/folders\/222\?/, () => ({ status: 200, body: { ...BOX_FOLDER, name: "Old" } })]]);
	const r = await settle(Adapter.moveItem(CREDS, "222", "0", "Old"));
	assert.deepStrictEqual(requests.map((q) => q.method + " " + q.url), [
		"GET " + API + "/files/222?fields=id,type", "GET " + API + "/folders/222?fields=id,type",
		"PUT " + API + "/folders/222?" + FIELDS]);
	assert.deepStrictEqual(body(requests[2]), { name: "Old", parent: { id: "0" } });
	assert.deepStrictEqual(plain(r.value.entry), { ...FOLDER_ENTRY, name: "Old" });
});

test("moveItem: a 409 from the PUT is reported, not retried as the other kind", async () => {
	const { Adapter, requests } = load([...isFile("111"),
		["PUT", /./, () => ({ status: 409, body: { type: "error", code: "item_name_in_use" } })]]);
	const r = await settle(Adapter.moveItem(CREDS, "111", null, "Taken.pdf"));
	assert.strictEqual(r.error.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.error.status, 409);
	assert.match(r.error.body, /item_name_in_use/);
	assert.strictEqual(requests.length, 2);
});

test("moveItem: an id that is neither file nor folder fails with the 404 and changes nothing", async () => {
	const { Adapter, requests } = load([["GET", /./, notFound], ["PUT", /./, () => ({ status: 200, body: BOX_FILE })]]);
	const r = await settle(Adapter.moveItem(CREDS, "999", "0", null));
	assert.strictEqual(r.error.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.error.status, 404);
	assert.ok(requests.every((q) => q.method === "GET"));
	assert.strictEqual(requests.length, 2);
});

test("moveItem: a probe failure other than 404 stops there (no folder probe, no PUT)", async () => {
	const { Adapter, requests } = load([["GET", /./, () => ({ status: 403, body: { code: "access_denied_insufficient_permissions" } })]]);
	const r = await settle(Adapter.moveItem(CREDS, "111", "0", null));
	assert.strictEqual(r.error.status, 403);
	assert.strictEqual(requests.length, 1);
});

test("moveItem: a token renewed during the probe is used by the PUT (Box rotates refresh tokens)", async () => {
	const renewed = [];
	const { Adapter, requests } = load([
		["GET", /\/files\/111\?/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, (o) => (o.form.refresh_token === "ref" ?
			{ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } } : { status: 400 })],
		...isFile("111"),
		["PUT", /\/files\/111\?/, (o) => (o.bearer === "tok2" ? { status: 200, body: BOX_FILE } : { status: 401 })],
	]);
	const r = await settle(Adapter.moveItem(CREDS, "111", "0", null, (nc) => renewed.push(nc)));
	assert.ok(r.value, JSON.stringify(r.error));
	assert.strictEqual(requests.length, 4);
	assert.strictEqual(requests[3].bearer, "tok2");
	assert.strictEqual(renewed.length, 1);
});

test("deleteItem on a file: DELETE /files/{id} (to the trash), 204 is success", async () => {
	const { Adapter, requests } = load([...isFile("111"), ["DELETE", /./, () => ({ status: 204 })]]);
	const r = await settle(Adapter.deleteItem(CREDS, "111"));
	assert.ok(r.value && !r.error);
	assert.strictEqual(requests[1].method, "DELETE");
	assert.strictEqual(requests[1].url, API + "/files/111");
	assert.strictEqual(requests[1].body, undefined);
});

test("deleteItem on a folder: DELETE /folders/{id}?recursive=true", async () => {
	const { Adapter, requests } = load([...isFolder("222"), ["DELETE", /./, () => ({ status: 204 })]]);
	const r = await settle(Adapter.deleteItem(CREDS, "222"));
	assert.ok(r.value && !r.error);
	assert.strictEqual(requests.length, 3);
	assert.strictEqual(requests[2].method, "DELETE");
	assert.strictEqual(requests[2].url, API + "/folders/222?recursive=true");
});

test("deleteItem: a 409 from the DELETE (operation_blocked_temporary) is a BOX_API_ERROR", async () => {
	const { Adapter } = load([...isFolder("222"), ["DELETE", /./, () => ({ status: 409, body: { code: "operation_blocked_temporary" } })]]);
	const r = await settle(Adapter.deleteItem(CREDS, "222"));
	assert.strictEqual(r.error.returnValue, false);
	assert.strictEqual(r.error.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.error.status, 409);
});

test("deleteItem: an unknown id is a 404 BOX_API_ERROR and nothing is deleted", async () => {
	const { Adapter, requests } = load([["GET", /./, notFound], ["DELETE", /./, () => ({ status: 204 })]]);
	const r = await settle(Adapter.deleteItem(CREDS, "999"));
	assert.strictEqual(r.error.status, 404);
	assert.ok(requests.every((q) => q.method === "GET"));
});
