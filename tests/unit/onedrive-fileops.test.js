// node --test tests/unit
// OneDrive's (Microsoft Graph) createFolder, moveItem and deleteItem. Loads the real config.js,
// oauth2.js, adapter.js and cloudservice.js (CloudGuard) the way sources.json loads them on the
// device, with a stand-in Future and a stand-in HttpCurl.request that records each request and
// answers from a script of canned { status, responseText } replies.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SVC = path.join(__dirname, "../../cloud/onedrive/service/com.palm.service.onedrive");
const CORE = path.join(__dirname, "../../cloud/_core/service/_cloudcore");
const API = "https://graph.microsoft.com/v1.0";

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
const folderItem = { id: "F9", name: "New", folder: { childCount: 0 }, size: 0, lastModifiedDateTime: "2026-10-19T10:00:00Z",
	parentReference: { id: "P1" } };
const fileItem = { id: "A1", name: "b.txt", file: { mimeType: "text/plain" }, size: 12, lastModifiedDateTime: "2026-10-19T11:00:00Z",
	"@microsoft.graph.downloadUrl": "https://dl.example/b" };
const fileEntry = { id: "A1", type: "file", name: "b.txt", size: 12, modified: "2026-10-19T11:00:00Z", path: "A1",
	mimeType: "text/plain", downloadUrl: "https://dl.example/b" };

test("createFolder: POST to the parent's children with a folder facet and conflictBehavior fail", () => {
	const { Adapter, api } = load([reply(201, folderItem)]);
	const f = Adapter.createFolder(creds, "P1", "New", null);
	assert.deepStrictEqual(api(), [{ method: "POST", url: API + "/me/drive/items/P1/children", bearer: "at1", headers: JSONH,
		body: { name: "New", folder: {}, "@microsoft.graph.conflictBehavior": "fail" } }]);
	assert.deepStrictEqual(plain(f.result), { entry: { id: "F9", type: "folder", name: "New", size: 0,
		modified: "2026-10-19T10:00:00Z", path: "F9" } });
});

test("createFolder: the root (or no parent) is /me/drive/root/children, as listFolder addresses it", () => {
	const { Adapter, api } = load([reply(201, folderItem), reply(201, folderItem), reply(200, { value: [] })]);
	Adapter.createFolder(creds, "root", "New");
	Adapter.createFolder(creds, null, "New");
	Adapter.listFolder(creds, "root");
	assert.deepStrictEqual(api().map((r) => r.url), [API + "/me/drive/root/children", API + "/me/drive/root/children",
		API + "/me/drive/root/children?$top=1000"]);
});

test("createFolder: the JSON body does not start with @ (curl --data-binary would read a file)", () => {
	const { Adapter, reqs } = load([reply(201, folderItem)]);
	Adapter.createFolder(creds, "P1", "New");
	assert.strictEqual(reqs[0].body[0], "{");
});

test("createFolder and moveItem entries are exactly what listFolder makes of the same item", () => {
	const { Adapter } = load([reply(200, { value: [folderItem, fileItem] }), reply(201, folderItem), reply(200, fileItem)]);
	const listed = Adapter.listFolder(creds, "P1").result.entries;
	assert.deepStrictEqual(plain(Adapter.createFolder(creds, "P1", "New").result.entry), plain(listed[0]));
	assert.deepStrictEqual(plain(Adapter.moveItem(creds, "A1", null, "b.txt").result.entry), plain(listed[1]));
});

test("createFolder: a name clash (409) is GRAPH_API_ERROR with status and body", () => {
	const body = '{"error":{"code":"nameAlreadyExists"}}';
	const { Adapter } = load([{ status: 409, responseText: body }]);
	const e = errOf(Adapter.createFolder(creds, "P1", "New"));
	assert.deepStrictEqual(plain(e), { returnValue: false, errorCode: "GRAPH_API_ERROR", status: 409, body });
});

test("createFolder: a 401 refreshes the token, reports the rotated one and retries with it", () => {
	const renewed = [];
	const { Adapter, reqs, api } = load([reply(401, {}), reply(200, { access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
		reply(201, folderItem)]);
	const f = Adapter.createFolder(creds, "P1", "New", (nc) => renewed.push(nc));
	assert.strictEqual(f.result.entry.id, "F9");
	assert.strictEqual(reqs[1].form.grant_type, "refresh_token");
	assert.strictEqual(reqs[1].form.refresh_token, "rt1");
	assert.deepStrictEqual(api().map((r) => r.bearer), ["at1", "at2"]);
	assert.deepStrictEqual(api()[1].body, api()[0].body, "the retry sends the same body");
	assert.deepStrictEqual(renewed.map((c) => [c.accessToken, c.refreshToken]), [["at2", "rt2"]]);
});

test("moveItem rename only: PATCH with the name and no parentReference", () => {
	const { Adapter, api } = load([reply(200, fileItem)]);
	const f = Adapter.moveItem(creds, "A1", null, "b.txt", null);
	assert.deepStrictEqual(api(), [{ method: "PATCH", url: API + "/me/drive/items/A1", bearer: "at1", headers: JSONH, body: { name: "b.txt" } }]);
	assert.deepStrictEqual(plain(f.result), { entry: fileEntry });
});

test("moveItem move only: PATCH with the parentReference and no name", () => {
	const { Adapter, api } = load([reply(200, fileItem)]);
	Adapter.moveItem(creds, "A1", "NEW", null, null);
	assert.deepStrictEqual(api(), [{ method: "PATCH", url: API + "/me/drive/items/A1", bearer: "at1", headers: JSONH,
		body: { parentReference: { id: "NEW" } } }]);
});

test("moveItem both: one PATCH moves and renames", () => {
	const { Adapter, api } = load([reply(200, fileItem)]);
	Adapter.moveItem(creds, "A 1", "NEW", "b.txt", null);
	assert.strictEqual(api()[0].url, API + "/me/drive/items/A%201");
	assert.deepStrictEqual(api()[0].body, { name: "b.txt", parentReference: { id: "NEW" } });
});

test("moveItem to the root: Graph refuses id \"root\", so the root's real id is looked up first", () => {
	const { Adapter, api } = load([reply(200, { id: "ROOT!101" }), reply(200, fileItem)]);
	const f = Adapter.moveItem(creds, "A1", "root", null, null);
	assert.deepStrictEqual(api().map((r) => [r.method, r.url, r.body]), [
		["GET", API + "/me/drive/root?$select=id", undefined],
		["PATCH", API + "/me/drive/items/A1", { parentReference: { id: "ROOT!101" } }],
	]);
	assert.strictEqual(f.result.entry.id, "A1");
});

test("moveItem: a failed root lookup or PATCH fails the move", () => {
	let t = load([reply(404, {})]);
	let e = errOf(t.Adapter.moveItem(creds, "A1", "root", "x", null));
	assert.strictEqual(e.errorCode, "GRAPH_API_ERROR");
	assert.strictEqual(e.status, 404);
	assert.strictEqual(t.api().length, 1);
	t = load([reply(409, { error: {} })]);
	e = errOf(t.Adapter.moveItem(creds, "A1", "NEW", "x", null));
	assert.strictEqual(e.status, 409);
});

test("moveItem: a token refreshed on the root lookup is used for the PATCH", () => {
	const renewed = [];
	const { Adapter, api } = load([reply(401, {}), reply(200, { access_token: "at2", refresh_token: "rt2", expires_in: 60 }),
		reply(200, { id: "R" }), reply(200, fileItem)]);
	const f = Adapter.moveItem(creds, "A1", "root", null, (nc) => renewed.push(nc.accessToken));
	assert.strictEqual(f.result.entry.id, "A1");
	assert.deepStrictEqual(api().map((r) => r.bearer), ["at1", "at2", "at2"]);
	assert.deepStrictEqual(renewed, ["at2"]);
});

test("deleteItem: DELETE the item (to the recycle bin); 204 resolves to {}", () => {
	const { Adapter, api } = load([{ status: 204, responseText: "" }]);
	const f = Adapter.deleteItem(creds, "A1", null);
	assert.deepStrictEqual(api(), [{ method: "DELETE", url: API + "/me/drive/items/A1", bearer: "at1", headers: undefined, body: undefined }]);
	assert.deepStrictEqual(plain(f.result), {});
});

test("deleteItem: an API error is GRAPH_API_ERROR", () => {
	const { Adapter } = load([reply(404, { error: { code: "itemNotFound" } })]);
	const e = errOf(Adapter.deleteItem(creds, "A1", null));
	assert.strictEqual(e.returnValue, false);
	assert.strictEqual(e.errorCode, "GRAPH_API_ERROR");
	assert.strictEqual(e.status, 404);
});

test("deleteItem: resolves to {} whatever a 2xx carries", () => {
	const { Adapter } = load([reply(200, { id: "A1" })]);
	assert.deepStrictEqual(plain(Adapter.deleteItem(creds, "A1", null).result), {});
});
