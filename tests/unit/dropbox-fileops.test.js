// node --test tests/unit
// The Dropbox adapter's createFolder, moveItem and deleteItem (the adapter half of
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

const SVC = path.join(__dirname, "../../cloud/dropbox/service/com.palm.service.dropbox");
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
const API = "https://api.dropboxapi.com/2";
const body = (r) => JSON.parse(r.body);

const FILE = { ".tag": "file", name: "Report.PDF", id: "id:F1", path_lower: "/docs/report.pdf",
	path_display: "/Docs/Report.PDF", size: 1234, server_modified: "2026-10-01T10:00:00Z" };
const FILE_ENTRY = { id: "id:F1", type: "file", name: "Report.PDF", size: 1234,
	modified: "2026-10-01T10:00:00Z", path: "/docs/report.pdf" };
const CONFLICT = { error_summary: "path/conflict/folder/..", error: { ".tag": "path",
	path: { ".tag": "conflict", conflict: { ".tag": "folder" } } } };

test("listFolder output is unchanged by the shared normaliser", async () => {
	const { Adapter } = load([["POST", /\/files\/list_folder$/, () => ({ status: 200, body: {
		entries: [FILE, { ".tag": "folder", name: "Sub", id: "id:D1", path_lower: "/docs/sub" }] } })]]);
	const r = await settle(Adapter.listFolder(CREDS, "/docs"));
	assert.deepStrictEqual(plain(r.value.entries), [FILE_ENTRY,
		{ id: "id:D1", type: "folder", name: "Sub", path: "/docs/sub" }]);
});

test("createFolder: POST create_folder_v2 { path, autorename:false }; the entry is a folder", async () => {
	const { Adapter, requests } = load([["POST", /\/files\/create_folder_v2$/, () => ({ status: 200,
		body: { metadata: { name: "New", id: "id:N1", path_lower: "/docs/new", path_display: "/Docs/New" } } })]]);
	const r = await settle(Adapter.createFolder(CREDS, "/docs", "New"));
	assert.strictEqual(requests.length, 1);
	assert.strictEqual(requests[0].method, "POST");
	assert.strictEqual(requests[0].url, API + "/files/create_folder_v2");
	assert.strictEqual(requests[0].bearer, "tok");
	assert.strictEqual(requests[0].headers["Content-Type"], "application/json");
	assert.deepStrictEqual(body(requests[0]), { path: "/docs/New", autorename: false });
	// FolderMetadata comes without ".tag"; it is still a folder.
	assert.deepStrictEqual(plain(r.value), { entry: { id: "id:N1", type: "folder", name: "New", path: "/docs/new" } });
});

test("createFolder: the root (\"\", \"/\", \"root\") gives /name", async () => {
	for (const root of ["", "/", "root"]) {
		const { Adapter, requests } = load([["POST", /create_folder_v2$/, () => ({ status: 200, body: { metadata: {} } })]]);
		await settle(Adapter.createFolder(CREDS, root, "Top"));
		assert.strictEqual(body(requests[0]).path, "/Top", JSON.stringify(root));
	}
});

test("createFolder: a 409 conflict is a DROPBOX_API_ERROR with status and body", async () => {
	const { Adapter } = load([["POST", /create_folder_v2$/, () => ({ status: 409, body: CONFLICT })]]);
	const r = await settle(Adapter.createFolder(CREDS, "/docs", "New"));
	assert.strictEqual(r.error.returnValue, false);
	assert.strictEqual(r.error.errorCode, "DROPBOX_API_ERROR");
	assert.strictEqual(r.error.status, 409);
	assert.deepStrictEqual(JSON.parse(r.error.body), CONFLICT);
});

test("createFolder: a 401 refreshes the token, retries, and reports the new credentials", async () => {
	const renewed = [];
	const { Adapter, Config, requests } = load([
		["POST", /create_folder_v2$/, () => ({ status: 401, body: "expired" }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 3600 } })],
		["POST", /create_folder_v2$/, () => ({ status: 200, body: { metadata: { name: "New", path_lower: "/new" } } })],
	]);
	const r = await settle(Adapter.createFolder(CREDS, "", "New", (nc) => renewed.push(nc)));
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/files/create_folder_v2", Config.TOKEN_URL,
		API + "/files/create_folder_v2"]);
	assert.strictEqual(requests[1].form.refresh_token, "ref");
	assert.strictEqual(requests[2].bearer, "tok2");
	assert.strictEqual(renewed.length, 1);
	assert.strictEqual(renewed[0].accessToken, "tok2");
	assert.strictEqual(renewed[0].refreshToken, "ref");
	assert.strictEqual(r.value.entry.path, "/new");
});

test("moveItem: rename only keeps the parent folder, one move_v2 call", async () => {
	const { Adapter, requests } = load([["POST", /\/files\/move_v2$/, () => ({ status: 200,
		body: { metadata: { ...FILE, name: "Final.pdf", path_lower: "/docs/final.pdf" } } })]]);
	const r = await settle(Adapter.moveItem(CREDS, "/docs/report.pdf", null, "Final.pdf"));
	assert.strictEqual(requests.length, 1);
	assert.strictEqual(requests[0].url, API + "/files/move_v2");
	assert.deepStrictEqual(body(requests[0]), { from_path: "/docs/report.pdf", to_path: "/docs/Final.pdf", autorename: false });
	assert.deepStrictEqual(plain(r.value), { entry: { ...FILE_ENTRY, name: "Final.pdf", path: "/docs/final.pdf" } });
});

test("moveItem: rename of an item in the root", async () => {
	const { Adapter, requests } = load([["POST", /move_v2$/, () => ({ status: 200, body: { metadata: FILE } })]]);
	await settle(Adapter.moveItem(CREDS, "/a.txt", null, "b.txt"));
	assert.strictEqual(body(requests[0]).to_path, "/b.txt");
});

test("moveItem: move only reads the cased name first, then moves under it", async () => {
	const { Adapter, requests } = load([
		["POST", /\/files\/get_metadata$/, () => ({ status: 200, body: FILE })],
		["POST", /\/files\/move_v2$/, () => ({ status: 200, body: { metadata: { ...FILE, path_lower: "/archive/report.pdf" } } })],
	]);
	const r = await settle(Adapter.moveItem(CREDS, "/docs/report.pdf", "/archive", null));
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/files/get_metadata", API + "/files/move_v2"]);
	assert.deepStrictEqual(body(requests[0]), { path: "/docs/report.pdf" });
	assert.deepStrictEqual(body(requests[1]), { from_path: "/docs/report.pdf", to_path: "/archive/Report.PDF", autorename: false });
	assert.strictEqual(r.value.entry.path, "/archive/report.pdf");
	assert.strictEqual(r.value.entry.type, "file");
});

test("moveItem: move into the root", async () => {
	const { Adapter, requests } = load([
		["POST", /get_metadata$/, () => ({ status: 200, body: FILE })],
		["POST", /move_v2$/, () => ({ status: 200, body: { metadata: FILE } })],
	]);
	await settle(Adapter.moveItem(CREDS, "/docs/report.pdf", "", null));
	assert.strictEqual(body(requests[1]).to_path, "/Report.PDF");
});

test("moveItem: move and rename at once, one move_v2 call", async () => {
	const { Adapter, requests } = load([["POST", /move_v2$/, () => ({ status: 200,
		body: { metadata: { ".tag": "folder", name: "Old", id: "id:D9", path_lower: "/archive/old" } } })]]);
	const r = await settle(Adapter.moveItem(CREDS, "/docs/sub", "/archive", "Old"));
	assert.strictEqual(requests.length, 1);
	assert.deepStrictEqual(body(requests[0]), { from_path: "/docs/sub", to_path: "/archive/Old", autorename: false });
	assert.deepStrictEqual(plain(r.value.entry), { id: "id:D9", type: "folder", name: "Old", path: "/archive/old" });
});

test("moveItem: a 409 from move_v2 (to/conflict) is a DROPBOX_API_ERROR", async () => {
	const { Adapter } = load([["POST", /move_v2$/, () => ({ status: 409,
		body: { error_summary: "to/conflict/file/.", error: { ".tag": "to" } } })]]);
	const r = await settle(Adapter.moveItem(CREDS, "/a.txt", null, "b.txt"));
	assert.strictEqual(r.error.errorCode, "DROPBOX_API_ERROR");
	assert.strictEqual(r.error.status, 409);
	assert.match(r.error.body, /to\/conflict/);
});

test("moveItem: a missing item (get_metadata 409 not_found) fails without moving", async () => {
	const { Adapter, requests } = load([
		["POST", /get_metadata$/, () => ({ status: 409, body: { error_summary: "path/not_found/.." } })],
		["POST", /move_v2$/, () => ({ status: 200, body: { metadata: FILE } })],
	]);
	const r = await settle(Adapter.moveItem(CREDS, "/gone.txt", "/x", null));
	assert.strictEqual(r.error.errorCode, "DROPBOX_API_ERROR");
	assert.strictEqual(r.error.status, 409);
	assert.strictEqual(requests.length, 1);
});

test("moveItem: a token renewed by get_metadata is used by move_v2", async () => {
	const renewed = [];
	const { Adapter, requests } = load([
		["POST", /get_metadata$/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
		["POST", /get_metadata$/, () => ({ status: 200, body: FILE })],
		["POST", /move_v2$/, (o) => (o.bearer === "tok2" ? { status: 200, body: { metadata: FILE } } : { status: 401 })],
	]);
	const r = await settle(Adapter.moveItem(CREDS, "/docs/report.pdf", "/x", null, (nc) => renewed.push(nc)));
	assert.ok(r.value, JSON.stringify(r.error));
	assert.strictEqual(requests[3].bearer, "tok2");
	assert.strictEqual(requests.length, 4);
	assert.strictEqual(renewed.length, 1);
});

test("deleteItem: POST delete_v2 { path }", async () => {
	const { Adapter, requests } = load([["POST", /\/files\/delete_v2$/, () => ({ status: 200, body: { metadata: FILE } })]]);
	const r = await settle(Adapter.deleteItem(CREDS, "/docs/report.pdf"));
	assert.strictEqual(requests.length, 1);
	assert.strictEqual(requests[0].method, "POST");
	assert.strictEqual(requests[0].url, API + "/files/delete_v2");
	assert.deepStrictEqual(body(requests[0]), { path: "/docs/report.pdf" });
	assert.ok(r.value && !r.error);
});

test("deleteItem: a 409 not_found is a DROPBOX_API_ERROR", async () => {
	const { Adapter } = load([["POST", /delete_v2$/, () => ({ status: 409, body: { error_summary: "path_lookup/not_found/" } })]]);
	const r = await settle(Adapter.deleteItem(CREDS, "/gone"));
	assert.strictEqual(r.error.returnValue, false);
	assert.strictEqual(r.error.errorCode, "DROPBOX_API_ERROR");
	assert.strictEqual(r.error.status, 409);
});

test("uploadFile still writes to folder/name after the path-join refactor", async () => {
	const { Adapter, requests } = load([["POST", /\/files\/upload$/, () => ({ status: 200, body: {} })]]);
	await settle(Adapter.uploadFile(CREDS, "/docs", "/local/a.txt", "a.txt"));
	await settle(Adapter.uploadFile(CREDS, "root", "/local/a.txt", "/b.txt"));
	assert.strictEqual(JSON.parse(requests[0].headers["Dropbox-API-Arg"]).path, "/docs/a.txt");
	assert.strictEqual(JSON.parse(requests[1].headers["Dropbox-API-Arg"]).path, "/b.txt");
});
