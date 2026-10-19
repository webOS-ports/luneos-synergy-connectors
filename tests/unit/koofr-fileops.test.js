// node --test tests/unit
// Koofr's createFolder, moveItem and deleteItem (commands/fileOps_commands.js). The real
// config.js, oauth2.js, adapter.js and cloudservice.js are loaded the way sources.json loads them,
// with a stand-in HttpCurl.request that records each request and answers from a script, and a
// stand-in Future that settles the way Foundations' does: a Future returned from now()/then() is
// nested, nest() takes over another Future's outcome, assigning a Future to .result does NOT.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const KOOFR = path.join(__dirname, "../../cloud/koofr/service/com.palm.service.koofr");
const CORE = path.join(__dirname, "../../cloud/_core/service/_cloudcore");

// Foundations' Future (frameworks/foundations/.../control/future.js), the parts these files use.
class Future {
	constructor() { this._then = []; this._inside = -1; this._r = { isset: false }; }
	get result() { this._r.wasread = true; if (this._r.exception) throw this._r.exception; return this._r.result; }
	set result(v) {
		if (this._r.exception && !this._r.wasread) { this._r.wasread = true; throw this._r.exception; }
		this._r = { result: v, isset: true };
		this._dispatch();
	}
	get exception() { this._r.wasread = true; return this._r.exception; }
	set exception(e) { this._r = { exception: e, isset: true }; this._dispatch(); }
	setException(e) { this.exception = e; }
	get done() { return this._r.isset; }
	_settle(v) { if (v !== undefined) { if (v && typeof v.then === "function") this.nest(v); else this.result = v; } }
	now(scope, fn) {
		this._inside = 0;
		try { this._settle(fn.call(scope, this)); } catch (e) { this._r = { exception: e, isset: true }; }
		this._inside = -1;
		this._dispatch();
		return this;
	}
	then(scope, fn) {
		if (this._inside === -1) { this._then.push({ fn, scope }); this._dispatch(); }
		else this._then.splice(this._inside++, 0, { fn, scope });
		return this;
	}
	nest(inner) {
		if (inner._r.isset) { this._r = inner._r; this._dispatch(); }
		else inner.then(this, () => { try { this.result = inner.result; } catch (e) { this.exception = e; } });
		return this;
	}
	_dispatch() {
		if (this._inside !== -1) return;
		while (this._then.length && this._r.isset) {
			this._inside = 0;
			const { fn, scope } = this._then.shift();
			try {
				this._r.isset = false;
				this._settle(fn.call(scope, this));
				if (!this._r.wasread && this._r.exception) this._r.isset = true;
			} catch (e) { this._r = { exception: e, isset: true }; }
		}
		this._inside = -1;
	}
}
const settled = (v) => { const f = new Future(); f.result = v; return f; };

const API = "https://app.koofr.net/api/v2";

// replies: one per request, in order; each { status, responseText } or a function of the request.
function koofr(replies) {
	const sent = [], refreshes = [];
	const ctx = {
		IMPORTS: { foundations: { Control: { Future } } }, require, Date, JSON, console: { log() {}, error() {} },
		HttpCurl: {
			request: (o) => {
				const isToken = /\/oauth2\/token$/.test(o.url);
				if (isToken) { refreshes.push(o.url); return settled({ status: 200, responseText: JSON.stringify({ access_token: "tok2", refresh_token: "ref2", expires_in: 3600 }) }); }
				sent.push({ method: o.method, url: o.url, headers: o.headers, body: o.body, multipart: o.multipart });
				if (!replies.length) throw new Error("unexpected request " + o.method + " " + o.url);
				const r = replies.shift();
				return settled(typeof r === "function" ? r(o) : r);
			},
		},
	};
	vm.createContext(ctx);
	for (const f of [path.join(KOOFR, "config.js"), path.join(CORE, "oauth2.js"), path.join(KOOFR, "adapter.js"), path.join(CORE, "cloudservice.js")]) {
		vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
	}
	return { Adapter: ctx.Adapter, sent, refreshes, left: replies };
}

const ok = (obj) => ({ status: 200, responseText: obj === undefined ? "" : JSON.stringify(obj) });
const status = (s) => ({ status: s, responseText: "" });
const creds = () => ({ accessToken: "tok1", refreshToken: "ref1", expiresAt: 0, mountId: "m1" });
const plain = (v) => JSON.parse(JSON.stringify(v));   // out of the vm realm
const outcome = (f) => { assert.ok(f.done, "settled"); try { return { result: plain(f.result) }; } catch (e) { return { error: e }; } };
const q = (p) => encodeURIComponent(p);

const DIR = { name: "New", type: "dir", modified: 1700000000000, size: 0, contentType: "" };
const FILE = { name: "b.txt", type: "file", modified: 1700000000001, size: 42, contentType: "text/plain" };

test("createFolder posts the name to files/folder and answers with listFolder's entry", () => {
	const { Adapter, sent, left } = koofr([ok(), ok(DIR)]);
	const r = outcome(Adapter.createFolder(creds(), "/Docs", "New", null));
	assert.deepStrictEqual(r.result, { entry: { id: "/Docs/New", type: "folder", name: "New", size: 0,
		modified: 1700000000000, path: "/Docs/New", mimeType: "application/x-directory" } });
	assert.strictEqual(sent[0].method, "POST");
	assert.strictEqual(sent[0].url, `${API}/mounts/m1/files/folder?path=${q("/Docs")}`);
	assert.strictEqual(sent[0].body, JSON.stringify({ name: "New" }));
	assert.strictEqual(sent[0].headers["Content-Type"], "application/json");
	assert.strictEqual(sent[0].headers.Authorization, "Bearer tok1");
	assert.strictEqual(sent[0].headers["X-Koofr-Version"], "2.1");
	assert.deepStrictEqual([sent[1].method, sent[1].url], ["GET", `${API}/mounts/m1/files/info?path=${q("/Docs/New")}`]);
	assert.strictEqual(left.length, 0);

	// The same object through listFolder gives the same entry.
	const lf = koofr([ok({ files: [DIR] })]);
	assert.deepStrictEqual(plain(lf.Adapter.listFolder(creds(), "/Docs", null).result.entries[0]), r.result.entry);
});

test("createFolder at the mount root, by '/', 'root' or nothing", () => {
	for (const parent of ["/", "root", "", null]) {
		const { Adapter, sent } = koofr([ok(), ok(DIR)]);
		const r = outcome(Adapter.createFolder(creds(), parent, "New", null));
		assert.strictEqual(r.result.entry.path, "/New", String(parent));
		assert.strictEqual(sent[0].url, `${API}/mounts/m1/files/folder?path=${q("/")}`);
		assert.strictEqual(sent[1].url, `${API}/mounts/m1/files/info?path=${q("/New")}`);
	}
});

test("createFolder: a refused create fails with KOOFR_API_ERROR and asks nothing more", () => {
	const { Adapter, sent } = koofr([status(409)]);
	const r = outcome(Adapter.createFolder(creds(), "/Docs", "New", null));
	assert.strictEqual(r.error.returnValue, false);
	assert.strictEqual(r.error.errorCode, "KOOFR_API_ERROR");
	assert.strictEqual(r.error.status, 409);
	assert.strictEqual(sent.length, 1);
});

test("createFolder resolves the primary mount first when the credentials lack it", () => {
	const { Adapter, sent } = koofr([ok({ mounts: [{ id: "other" }, { id: "prim", isPrimary: true }] }), ok(), ok(DIR)]);
	const c = creds(); delete c.mountId;
	const r = outcome(Adapter.createFolder(c, "/", "New", null));
	assert.strictEqual(r.result.entry.path, "/New");
	assert.strictEqual(sent[0].url, `${API}/mounts`);
	assert.strictEqual(sent[1].url, `${API}/mounts/prim/files/folder?path=${q("/")}`);
});

test("a 401 refreshes once and the rest of the chain uses the renewed token", () => {
	const { Adapter, sent, refreshes } = koofr([status(401), ok(), ok(DIR)]);
	const renewed = [];
	const r = outcome(Adapter.createFolder(creds(), "/", "New", (nc) => renewed.push(nc)));
	assert.ok(r.result, JSON.stringify(r.error));
	assert.strictEqual(refreshes.length, 1);
	assert.deepStrictEqual(sent.map((s) => s.headers.Authorization), ["Bearer tok1", "Bearer tok2", "Bearer tok2"]);
	assert.strictEqual(renewed.length, 1);
	assert.strictEqual(renewed[0].accessToken, "tok2");
	assert.strictEqual(renewed[0].refreshToken, "ref2");
	assert.strictEqual(renewed[0].mountId, "m1");
});

test("a refresh while the mount is resolved leaves the mount id on the renewed credentials", () => {
	const { Adapter, sent } = koofr([status(401), ok({ mounts: [{ id: "prim", isPrimary: true }] }), ok(), ok(DIR)]);
	const c = creds(); delete c.mountId;
	const renewed = [];
	assert.ok(outcome(Adapter.createFolder(c, "/", "New", (nc) => renewed.push(nc))).result);
	assert.deepStrictEqual(sent.map((s) => s.headers.Authorization), ["Bearer tok1", "Bearer tok2", "Bearer tok2", "Bearer tok2"]);
	assert.strictEqual(renewed.length, 1);
	assert.strictEqual(renewed[0].mountId, "prim");
});

test("moveItem with a name only renames in place", () => {
	const { Adapter, sent, left } = koofr([status(404), ok(), ok(FILE)]);
	const r = outcome(Adapter.moveItem(creds(), "/Docs/a.txt", null, "b.txt", null));
	assert.deepStrictEqual(r.result, { entry: { id: "/Docs/b.txt", type: "file", name: "b.txt", size: 42,
		modified: 1700000000001, path: "/Docs/b.txt", mimeType: "text/plain" } });
	assert.deepStrictEqual([sent[0].method, sent[0].url], ["GET", `${API}/mounts/m1/files/info?path=${q("/Docs/b.txt")}`]);
	assert.deepStrictEqual([sent[1].method, sent[1].url], ["PUT", `${API}/mounts/m1/files/rename?path=${q("/Docs/a.txt")}`]);
	assert.strictEqual(sent[1].body, JSON.stringify({ name: "b.txt" }));
	assert.strictEqual(sent[1].headers["Content-Type"], "application/json");
	assert.strictEqual(sent[2].url, `${API}/mounts/m1/files/info?path=${q("/Docs/b.txt")}`);
	assert.strictEqual(left.length, 0);
});

test("moveItem to the folder it is in, with a name, is a rename too", () => {
	const { Adapter, sent } = koofr([status(404), ok(), ok(FILE)]);
	outcome(Adapter.moveItem(creds(), "/Docs/a.txt", "/Docs/", "b.txt", null));
	assert.strictEqual(sent[1].url, `${API}/mounts/m1/files/rename?path=${q("/Docs/a.txt")}`);
});

test("moveItem with a folder only moves under the same name", () => {
	const { Adapter, sent } = koofr([status(404), ok(), ok({ ...FILE, name: "a.txt" })]);
	const r = outcome(Adapter.moveItem(creds(), "/Docs/a.txt", "/Other", null, null));
	assert.strictEqual(r.result.entry.path, "/Other/a.txt");
	assert.strictEqual(sent[0].url, `${API}/mounts/m1/files/info?path=${q("/Other/a.txt")}`);
	assert.deepStrictEqual([sent[1].method, sent[1].url], ["PUT", `${API}/mounts/m1/files/move?path=${q("/Docs/a.txt")}`]);
	assert.strictEqual(sent[1].body, JSON.stringify({ toMountId: "m1", toPath: "/Other/a.txt" }));
});

test("moveItem with a folder and a name moves and renames in one move", () => {
	const { Adapter, sent } = koofr([status(404), ok(), ok(FILE)]);
	const r = outcome(Adapter.moveItem(creds(), "/Docs/a.txt", "/", "b.txt", null));
	assert.strictEqual(r.result.entry.path, "/b.txt");
	assert.strictEqual(sent.length, 3);
	assert.strictEqual(sent[1].url, `${API}/mounts/m1/files/move?path=${q("/Docs/a.txt")}`);
	assert.strictEqual(sent[1].body, JSON.stringify({ toMountId: "m1", toPath: "/b.txt" }));
});

test("moveItem moves a folder the same way and answers with a folder entry", () => {
	const { Adapter, sent } = koofr([status(404), ok(), ok(DIR)]);
	const r = outcome(Adapter.moveItem(creds(), "/Docs/Old", "/Other", "New", null));
	assert.strictEqual(r.result.entry.type, "folder");
	assert.strictEqual(r.result.entry.path, "/Other/New");
	assert.strictEqual(sent[1].body, JSON.stringify({ toMountId: "m1", toPath: "/Other/New" }));
});

test("moveItem refuses an existing destination and does not touch it", () => {
	const { Adapter, sent } = koofr([ok(FILE)]);
	const r = outcome(Adapter.moveItem(creds(), "/Docs/a.txt", null, "b.txt", null));
	assert.strictEqual(r.error.errorCode, "KOOFR_EXISTS");
	assert.strictEqual(r.error.returnValue, false);
	assert.strictEqual(sent.length, 1);
});

test("moveItem lets a change of case through only when the probe finds the item itself", () => {
	let k = koofr([ok({ ...FILE, name: "a.txt" }), ok(), ok({ ...FILE, name: "A.txt" })]);
	let r = outcome(k.Adapter.moveItem(creds(), "/Docs/a.txt", null, "A.txt", null));
	assert.strictEqual(r.result.entry.path, "/Docs/A.txt");
	assert.strictEqual(k.sent[1].url, `${API}/mounts/m1/files/rename?path=${q("/Docs/a.txt")}`);
	k = koofr([ok({ ...FILE, name: "A.txt" })]);
	r = outcome(k.Adapter.moveItem(creds(), "/Docs/a.txt", null, "A.txt", null));
	assert.strictEqual(r.error.errorCode, "KOOFR_EXISTS");
});

test("moveItem: a probe or move that fails is KOOFR_API_ERROR with the status", () => {
	let k = koofr([status(500)]);
	assert.strictEqual(outcome(k.Adapter.moveItem(creds(), "/a", null, "b", null)).error.status, 500);
	assert.strictEqual(k.sent.length, 1);
	k = koofr([status(404), status(404)]);
	const e = outcome(k.Adapter.moveItem(creds(), "/a", "/x", null, null)).error;
	assert.deepStrictEqual([e.errorCode, e.status], ["KOOFR_API_ERROR", 404]);
	assert.strictEqual(k.sent.length, 2);
});

test("moveItem onto itself only reads it back; root and into-itself are refused unsent", () => {
	let k = koofr([ok({ ...FILE, name: "a.txt" })]);
	assert.strictEqual(outcome(k.Adapter.moveItem(creds(), "/Docs/a.txt", "/Docs", "a.txt", null)).result.entry.path, "/Docs/a.txt");
	assert.deepStrictEqual(k.sent.map((s) => s.url), [`${API}/mounts/m1/files/info?path=${q("/Docs/a.txt")}`]);
	for (const [item, to] of [["/", "/x"], ["root", "/x"], ["/Docs", "/Docs"], ["/Docs", "/Docs/Sub"], ["/Docs/", "/Docs/Sub/Deeper"]]) {
		k = koofr([]);
		const e = outcome(k.Adapter.moveItem(creds(), item, to, null, null)).error;
		assert.strictEqual(e.errorCode, "BAD_ARGS", item + " -> " + to);
		assert.strictEqual(k.sent.length, 0);
	}
	// A sibling whose name starts the same is not "inside".
	k = koofr([status(404), ok(), ok(DIR)]);
	assert.ok(outcome(k.Adapter.moveItem(creds(), "/Docs", "/Docs2", null, null)).result);
});

test("deleteItem sends DELETE files/remove and answers {}", () => {
	const { Adapter, sent } = koofr([ok()]);
	assert.deepStrictEqual(outcome(Adapter.deleteItem(creds(), "/Docs/a b.txt", null)).result, {});
	assert.deepStrictEqual([sent[0].method, sent[0].url], ["DELETE", `${API}/mounts/m1/files/remove?path=${q("/Docs/a b.txt")}`]);
	assert.ok(/path=%2FDocs%2Fa%20b\.txt$/.test(sent[0].url));
	assert.strictEqual(sent[0].body, undefined);
});

test("deleteItem: a failure is KOOFR_API_ERROR; the root is refused unsent", () => {
	let k = koofr([status(404)]);
	const e = outcome(k.Adapter.deleteItem(creds(), "/gone", null)).error;
	assert.deepStrictEqual([e.returnValue, e.errorCode, e.status], [false, "KOOFR_API_ERROR", 404]);
	for (const item of ["/", "root", "", "//"]) {
		k = koofr([]);
		assert.strictEqual(outcome(k.Adapter.deleteItem(creds(), item, null)).error.errorCode, "BAD_ARGS", item);
		assert.strictEqual(k.sent.length, 0);
	}
});

test("the three methods are CloudGuard entry points", () => {
	const { Adapter } = koofr([]);
	for (const call of [() => Adapter.createFolder(null, "/", "x"), () => Adapter.moveItem(null, "/a", null, "b"), () => Adapter.deleteItem(null, "/a")]) {
		assert.strictEqual(outcome(call()).error.errorCode, "CONNECTOR_EXCEPTION");
	}
});
