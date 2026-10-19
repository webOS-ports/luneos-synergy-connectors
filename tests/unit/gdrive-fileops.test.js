// node --test tests/unit
// Google Drive's createFolder, moveItem and deleteItem. Loads the real config.js, oauth2.js,
// adapter.js and cloudservice.js (CloudGuard) the way sources.json loads them on the device,
// with a stand-in Future and a stand-in HttpCurl.request that records each request and answers
// from a script of canned { status, responseText } replies.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SVC = path.join(__dirname, "../../cloud/google/service/com.palm.service.gdrive");
const CORE = path.join(__dirname, "../../cloud/_core/service/_cloudcore");
const API = "https://www.googleapis.com/drive/v3";
const FIELDS = "id%2Cname%2CmimeType%2Csize%2CmodifiedTime";

// Settles like Foundations' Future (foundations/javascript/control/future.js) as far as these
// files use it: now()/then() run the callback with the future; a returned thenable is nested,
// another returned value becomes the result, a throw becomes the exception. Assigning a Future
// to .result stores the Future itself, as the real one does.
class FakeFuture {
	constructor() { this.cbs = []; this.done = false; this.inside = false; }
	set result(v) { this._r = v; this._e = undefined; this._settle(); }
	get result() { if (this._e !== undefined) throw this._e; return this._r; }
	setException(e) { this._e = e; this._settle(); }
	_settle() { this.done = true; if (!this.inside) this._dispatch(); }
	// One callback per settling: the next waits until this one has set a result again.
	_dispatch() { if (this.done && this.cbs.length) { const [scope, fn] = this.cbs.shift(); this.done = false; this._run(scope, fn); } }
	_run(scope, fn) {
		this.inside = true;
		try {
			const v = fn.call(scope, this);
			if (v !== undefined) {
				if (v && typeof v.then === "function") {
					v.then(null, () => { try { this.result = v.result; } catch (e) { this.setException(e); } });
				} else { this._r = v; this._e = undefined; this.done = true; }
			}
		} catch (e) { this._e = e; this.done = true; }
		this.inside = false;
		this._dispatch();
	}
	now(scope, fn) { this._run(scope, fn); return this; }
	then(scope, fn) { this.cbs.push([scope, fn]); this._dispatch(); return this; }
}
const settled = (v) => { const f = new FakeFuture(); f.result = v; return f; };
const reply = (status, body) => ({ status, responseText: body === undefined ? "" : JSON.stringify(body) });

function load(script) {
	const reqs = [];
	const HttpCurl = {
		request(o) {
			reqs.push(o);
			const next = script.shift();
			assert.ok(next, "unexpected request " + o.method + " " + o.url);
			return settled(typeof next === "function" ? next(o) : next);
		},
	};
	const ctx = { IMPORTS: { foundations: { Control: { Future: FakeFuture } } }, Future: FakeFuture,
		HttpCurl, console: { log() {} }, Date, JSON };
	vm.createContext(ctx);
	for (const f of [path.join(SVC, "config.js"), path.join(CORE, "oauth2.js"), path.join(SVC, "adapter.js"),
		path.join(CORE, "cloudservice.js")]) {
		vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
	}
	assert.strictEqual(ctx.Adapter.__cloudGuarded, true);
	// API requests only: the token call carries the client id, which is never compared or printed.
	const api = () => reqs.filter((r) => r.url.indexOf(API) === 0)
		.map((r) => ({ method: r.method, url: r.url, bearer: r.bearer,
			headers: r.headers && { ...r.headers }, body: r.body && JSON.parse(r.body) }));
	return { Adapter: ctx.Adapter, reqs, api };
}

const creds = { accessToken: "at1", refreshToken: "rt1" };
const plain = (o) => JSON.parse(JSON.stringify(o));
const errOf = (f) => { assert.strictEqual(f.done, true, "future settled"); try { f.result; } catch (e) { return e; } return null; };
const JSONH = { "Content-Type": "application/json" };
const folderRes = { id: "F9", name: "New", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-10-19T10:00:00Z" };
const fileRes = { id: "A1", name: "b.txt", mimeType: "text/plain", size: "12", modifiedTime: "2026-10-19T11:00:00Z" };
const fileEntry = { id: "A1", type: "file", name: "b.txt", size: "12", modified: "2026-10-19T11:00:00Z", path: "A1", mimeType: "text/plain", googleDoc: false };

test("createFolder: files.create with the folder mimeType and the parent; a listFolder entry comes back", () => {
	const { Adapter, api } = load([reply(200, folderRes)]);
	const f = Adapter.createFolder(creds, "P1", "New", () => {});
	assert.deepStrictEqual(api(), [{ method: "POST", url: API + "/files?fields=" + FIELDS, bearer: "at1", headers: JSONH,
		body: { name: "New", mimeType: "application/vnd.google-apps.folder", parents: ["P1"] } }]);
	assert.deepStrictEqual(plain(f.result), { entry: { id: "F9", type: "folder", name: "New",
		modified: "2026-10-19T10:00:00Z", path: "F9", mimeType: "application/vnd.google-apps.folder", googleDoc: false } });
});

test("createFolder: the entry is exactly what listFolder makes of the same resource", () => {
	const { Adapter } = load([reply(200, { files: [folderRes, fileRes, { id: "D", name: "Doc", mimeType: "application/vnd.google-apps.document" }] }),
		reply(200, fileRes), reply(200, { id: "D", name: "Doc", mimeType: "application/vnd.google-apps.document" })]);
	const listed = Adapter.listFolder(creds, "root", null).result.entries;
	assert.deepStrictEqual(plain(Adapter.createFolder(creds, "root", "b.txt").result.entry), plain(listed[1]));
	assert.deepStrictEqual(plain(Adapter.createFolder(creds, "root", "Doc").result.entry), plain(listed[2]));
	assert.strictEqual(listed[2].googleDoc, true);
});

test("listFolder still asks for the same fields", () => {
	const { Adapter, api } = load([reply(200, { files: [] })]);
	Adapter.listFolder(creds, "X", null);
	assert.ok(api()[0].url.includes("&fields=" + encodeURIComponent("files(id,name,mimeType,size,modifiedTime),nextPageToken") + "&"));
});

test("createFolder: the root parent stays the root alias; no parent means the root", () => {
	const { Adapter, api } = load([reply(200, folderRes), reply(200, folderRes)]);
	Adapter.createFolder(creds, "root", "New");
	Adapter.createFolder(creds, null, "New");
	assert.deepStrictEqual(api().map((r) => r.body.parents), [["root"], ["root"]]);
});

test("createFolder: an API error is GDRIVE_API_ERROR with status and body", () => {
	const { Adapter } = load([{ status: 403, responseText: '{"error":{"code":403}}' }]);
	const e = errOf(Adapter.createFolder(creds, "P1", "New"));
	assert.deepStrictEqual(plain(e), { returnValue: false, errorCode: "GDRIVE_API_ERROR", status: 403, body: '{"error":{"code":403}}' });
});

test("createFolder: a 401 refreshes the token, reports it and retries with it", () => {
	const renewed = [];
	const { Adapter, reqs, api } = load([reply(401, {}), reply(200, { access_token: "at2", expires_in: 3600 }), reply(200, folderRes)]);
	const f = Adapter.createFolder(creds, "P1", "New", (nc) => renewed.push(nc));
	assert.strictEqual(f.result.entry.id, "F9");
	assert.strictEqual(reqs[1].form.grant_type, "refresh_token");
	assert.strictEqual(reqs[1].form.refresh_token, "rt1");
	assert.deepStrictEqual(api().map((r) => r.bearer), ["at1", "at2"]);
	assert.strictEqual(renewed.length, 1);
	assert.strictEqual(renewed[0].accessToken, "at2");
	assert.strictEqual(renewed[0].refreshToken, "rt1");   // Google keeps the old one
});

test("moveItem rename only: one PATCH with the name, no parents lookup", () => {
	const { Adapter, api } = load([reply(200, fileRes)]);
	const f = Adapter.moveItem(creds, "A1", null, "b.txt", null);
	assert.deepStrictEqual(api(), [{ method: "PATCH", url: API + "/files/A1?fields=" + FIELDS, bearer: "at1", headers: JSONH, body: { name: "b.txt" } }]);
	assert.deepStrictEqual(plain(f.result), { entry: fileEntry });
});

test("moveItem move only: the current parents first, then add the new one and remove them", () => {
	const { Adapter, api } = load([reply(200, { parents: ["OLD"] }), reply(200, fileRes)]);
	const f = Adapter.moveItem(creds, "A1", "NEW", null, null);
	assert.deepStrictEqual(api(), [
		{ method: "GET", url: API + "/files/A1?fields=parents", bearer: "at1", headers: undefined, body: undefined },
		{ method: "PATCH", url: API + "/files/A1?addParents=NEW&removeParents=OLD&fields=" + FIELDS, bearer: "at1", headers: JSONH, body: {} },
	]);
	assert.deepStrictEqual(plain(f.result), { entry: fileEntry });
});

test("moveItem both: one PATCH moves and renames", () => {
	const { Adapter, api } = load([reply(200, { parents: ["OLD"] }), reply(200, fileRes)]);
	Adapter.moveItem(creds, "A1", "NEW", "b.txt", null);
	assert.deepStrictEqual(api()[1].body, { name: "b.txt" });
	assert.strictEqual(api()[1].url, API + "/files/A1?addParents=NEW&removeParents=OLD&fields=" + FIELDS);
});

test("moveItem to the root: the root alias is resolved to its id and an item already there stays put", () => {
	let t = load([reply(200, { parents: ["0ARoot"] }), reply(200, { id: "0ARoot" }), reply(200, fileRes)]);
	t.Adapter.moveItem(creds, "A1", "root", "b.txt", null);
	assert.deepStrictEqual(t.api().map((r) => r.method + " " + r.url), [
		"GET " + API + "/files/A1?fields=parents",
		"GET " + API + "/files/root?fields=id",
		"PATCH " + API + "/files/A1?fields=" + FIELDS,
	]);
	t = load([reply(200, { parents: ["OLD"] }), reply(200, { id: "0ARoot" }), reply(200, fileRes)]);
	t.Adapter.moveItem(creds, "A1", "root", null, null);
	assert.strictEqual(t.api()[2].url, API + "/files/A1?addParents=0ARoot&removeParents=OLD&fields=" + FIELDS);
});

test("moveItem into the folder it is in only renames; no parents means nothing to remove", () => {
	let t = load([reply(200, { parents: ["P"] }), reply(200, fileRes)]);
	t.Adapter.moveItem(creds, "A1", "P", "c.txt", null);
	assert.strictEqual(t.api()[1].url, API + "/files/A1?fields=" + FIELDS);
	t = load([reply(200, {}), reply(200, fileRes)]);
	t.Adapter.moveItem(creds, "A1", "P", null, null);
	assert.strictEqual(t.api()[1].url, API + "/files/A1?addParents=P&fields=" + FIELDS);
});

test("moveItem: ids are URL-encoded", () => {
	const { Adapter, api } = load([reply(200, { parents: ["o/1"] }), reply(200, fileRes)]);
	Adapter.moveItem(creds, "a b", "n&1", null, null);
	assert.strictEqual(api()[1].url, API + "/files/a%20b?addParents=n%261&removeParents=o%2F1&fields=" + FIELDS);
});

test("moveItem: a failed parents lookup or PATCH fails the move and stops there", () => {
	let t = load([reply(404, { error: {} })]);
	let e = errOf(t.Adapter.moveItem(creds, "A1", "NEW", null, null));
	assert.strictEqual(e.errorCode, "GDRIVE_API_ERROR");
	assert.strictEqual(e.status, 404);
	assert.strictEqual(t.api().length, 1);
	t = load([reply(200, { parents: ["OLD"] }), reply(403, { error: {} })]);
	e = errOf(t.Adapter.moveItem(creds, "A1", "NEW", null, null));
	assert.strictEqual(e.status, 403);
	t = load([reply(200, { parents: ["OLD"] }), reply(500, {})]);
	e = errOf(t.Adapter.moveItem(creds, "A1", "root", null, null));
	assert.strictEqual(e.status, 500);
	assert.strictEqual(t.api().length, 2);
});

test("moveItem: a token refreshed on the lookup is used for the PATCH and reported once", () => {
	const renewed = [];
	const { Adapter, api } = load([reply(401, {}), reply(200, { access_token: "at2", expires_in: 60 }),
		reply(200, { parents: ["OLD"] }), reply(200, fileRes)]);
	const f = Adapter.moveItem(creds, "A1", "NEW", null, (nc) => renewed.push(nc.accessToken));
	assert.strictEqual(f.result.entry.id, "A1");
	assert.deepStrictEqual(api().map((r) => r.bearer), ["at1", "at2", "at2"]);
	assert.deepStrictEqual(renewed, ["at2"]);
});

test("deleteItem: to the trash with files.update, never files.delete", () => {
	const { Adapter, api } = load([reply(200, { id: "A1" })]);
	const f = Adapter.deleteItem(creds, "A1", null);
	assert.deepStrictEqual(api(), [{ method: "PATCH", url: API + "/files/A1?fields=id", bearer: "at1", headers: JSONH, body: { trashed: true } }]);
	assert.deepStrictEqual(plain(f.result), {});
});

test("deleteItem: a file the user does not own (403) is GDRIVE_API_ERROR", () => {
	const { Adapter } = load([{ status: 403, responseText: '{"error":{"reason":"insufficientFilePermissions"}}' }]);
	const e = errOf(Adapter.deleteItem(creds, "A1", null));
	assert.strictEqual(e.returnValue, false);
	assert.strictEqual(e.errorCode, "GDRIVE_API_ERROR");
	assert.match(e.body, /insufficientFilePermissions/);
});
