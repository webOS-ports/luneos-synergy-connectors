// node --test tests/unit
// cloud/hidrive's createFolder, moveItem and deleteItem (adapter.js) against a stand-in
// HttpCurl.request and OAuth2.refresh. config.js, adapter.js and _cloudcore's cloudservice.js are
// loaded the way sources.json loads them on the device, with a stand-in Future that settles like
// Foundations' one: each then() callback runs once, after the previous one set a result, and a
// Future assigned to .result is NOT adopted (only now()/nest() do that).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SVC = path.join(__dirname, "../../cloud/hidrive/service/com.palm.service.hidrive");
const CORE = path.join(__dirname, "../../cloud/_core/service/_cloudcore");

class FakeFuture {
	constructor() { this.q = []; this.ready = false; this.running = false; }
	set result(v) { this._e = undefined; this._r = v; this.ready = true; this._go(); }
	get result() { if (this._e !== undefined) throw this._e; return this._r; }
	setException(e) { this._e = e; this.ready = true; this._go(); }
	then(scope, fn) {
		if (typeof scope === "function") { fn = scope; scope = undefined; }
		this.q.push([scope, fn]); this._go(); return this;
	}
	now(scope, fn) {
		try {
			const r = fn.call(scope, this);
			if (r instanceof FakeFuture) this.nest(r); else if (r !== undefined) this.result = r;
		} catch (e) { this.setException(e); }
		return this;
	}
	nest(inner) {
		inner.then(this, () => { try { this.result = inner.result; } catch (e) { this.setException(e); } });
		return this;
	}
	_go() {
		while (this.ready && this.q.length && !this.running) {
			const [s, fn] = this.q.shift();
			this.ready = false; this.running = true;
			try { fn.call(s, this); } catch (e) { this.running = false; this.setException(e); continue; }
			this.running = false;
		}
	}
}
const settled = (v) => { const f = new FakeFuture(); f.result = v; return f; };

const API = "https://api.hidrive.strato.com/2.1";
const HOME = "/users/me";
const ME = { status: 200, responseText: JSON.stringify({ account: "me", home: HOME }) };
const json = (status, body) => ({ status, responseText: body === undefined ? "" : JSON.stringify(body) });

// `script` answers each request in order: [expected "METHOD url", response]. Every request is
// recorded with its token so a test can check exactly what went out.
function setup(script, { refreshTo = "tok2" } = {}) {
	const reqs = [], renewed = [], refreshes = [];
	const queue = script.slice();
	const ctx = {
		IMPORTS: { foundations: { Control: { Future: FakeFuture } } },
		Future: FakeFuture,
		console: { log() {}, error() {} },
		HttpCurl: {
			request(o) {
				const line = o.method + " " + o.url;
				reqs.push({ line, auth: o.headers && o.headers.Authorization });
				const next = queue.shift();
				if (!next) throw new Error("unexpected request " + line);
				assert.strictEqual(line, next[0]);
				return settled(next[1]);
			},
		},
		OAuth2: { refresh(rt) { refreshes.push(rt); return settled({ accessToken: refreshTo, refreshToken: "rt2", expiresIn: 3600 }); } },
	};
	vm.createContext(ctx);
	for (const f of [path.join(SVC, "config.js"), path.join(SVC, "adapter.js"), path.join(CORE, "cloudservice.js")]) {
		vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
	}
	const creds = { accessToken: "tok", refreshToken: "rt" };
	return { A: ctx.Adapter, ctx, reqs, renewed, refreshes, creds, onRenew: (nc) => renewed.push(nc), left: queue };
}

const plain = (o) => JSON.parse(JSON.stringify(o));
const failure = (f) => { try { f.result; } catch (e) { return plain(e); } return null; };
const enc = encodeURIComponent;

const DIR_META = { name: "New%20Folder", path: "/users/me/New%20Folder", type: "dir", mtime: 1700000000,
	id: "d0.d1", ctime: 1700000000, has_dirs: false, readable: true, writable: true };
const DIR_ENTRY = { id: "/users/me/New Folder", type: "folder", name: "New Folder", size: 0,
	modified: 1700000000000, path: "/users/me/New Folder", mimeType: "application/x-directory" };

test("listFolder output is unchanged by the shared normaliser", () => {
	const t = setup([[`GET ${API}/dir?path=${enc("/users/me/Docs")}&members=all&fields=members.name,members.type,members.size,members.mtime,members.path,members.id&limit=0,5000`,
		json(200, { members: [DIR_META, { name: "a%20b.jpg", path: "/users/me/Docs/a%20b.jpg", type: "file", size: 12, mtime: 5 }] })]]);
	const f = t.A.listFolder(t.creds, "/users/me/Docs", t.onRenew);
	assert.deepStrictEqual(plain(f.result.entries), [DIR_ENTRY,
		{ id: "/users/me/Docs/a b.jpg", type: "file", name: "a b.jpg", size: 12, modified: 5000,
			path: "/users/me/Docs/a b.jpg", mimeType: "image/jpeg" }]);
});

test("createFolder in the home sentinel: /user/me, then POST /dir with the full path", () => {
	const t = setup([
		[`GET ${API}/user/me?fields=account,alias,email,descr,home,home_id`, ME],
		[`POST ${API}/dir?path=${enc("/users/me/New Folder")}`, json(201, DIR_META)],
	]);
	const f = t.A.createFolder(t.creds, "home", "New Folder", t.onRenew);
	assert.deepStrictEqual(plain(f.result), { entry: DIR_ENTRY });
	assert.deepStrictEqual(t.reqs.map((r) => r.auth), ["Bearer tok", "Bearer tok"]);
	assert.strictEqual(t.left.length, 0);
});

test("createFolder in a path parent goes straight to POST /dir; a reply without name/path falls back", () => {
	const t = setup([[`POST ${API}/dir?path=${enc("/users/me/Docs/Sub")}`, json(201, { type: "dir", mtime: 2 })]]);
	const f = t.A.createFolder(t.creds, "/users/me/Docs/", "Sub", t.onRenew);
	assert.deepStrictEqual(plain(f.result.entry), { id: "/users/me/Docs/Sub", type: "folder", name: "Sub", size: 0,
		modified: 2000, path: "/users/me/Docs/Sub", mimeType: "application/x-directory" });
});

test("createFolder: 409 (exists) is a failure, not a success", () => {
	const t = setup([[`POST ${API}/dir?path=${enc("/users/me/X")}`, json(409, { code: "409", msg: "exists" })]]);
	const e = failure(t.A.createFolder(t.creds, "/users/me", "X", t.onRenew));
	assert.strictEqual(e.errorCode, "HIDRIVE_API_ERROR");
	assert.strictEqual(e.returnValue, false);
	assert.strictEqual(e.status, 409);
});

test("createFolder: 401 refreshes once, retries with the new token and reports it", () => {
	const t = setup([
		[`POST ${API}/dir?path=${enc("/users/me/X")}`, json(401)],
		[`POST ${API}/dir?path=${enc("/users/me/X")}`, json(201, { name: "X", path: "/users/me/X", type: "dir" })],
	]);
	const f = t.A.createFolder(t.creds, "/users/me", "X", t.onRenew);
	assert.strictEqual(f.result.entry.path, "/users/me/X");
	assert.deepStrictEqual(t.reqs.map((r) => r.auth), ["Bearer tok", "Bearer tok2"]);
	assert.deepStrictEqual(t.refreshes, ["rt"]);
	assert.strictEqual(t.renewed.length, 1);
	assert.strictEqual(t.renewed[0].accessToken, "tok2");
});

const FILE_META = (p) => ({ name: enc(p.split("/").pop()), path: p.split("/").map(enc).join("/"), type: "file", size: 7, mtime: 9, id: "d0.f1" });
const fileEntry = (p) => ({ id: p, type: "file", name: p.split("/").pop(), size: 7, modified: 9000, path: p, mimeType: "application/pdf" });

test("moveItem rename only: GET /meta for the type, then POST /file/rename", () => {
	const t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/Docs/a.pdf")}&fields=type`, json(200, { type: "file" })],
		[`POST ${API}/file/rename?path=${enc("/users/me/Docs/a.pdf")}&name=${enc("b c.pdf")}`, json(201, FILE_META("/users/me/Docs/b c.pdf"))],
	]);
	const f = t.A.moveItem(t.creds, "/users/me/Docs/a.pdf", null, "b c.pdf", t.onRenew);
	assert.deepStrictEqual(plain(f.result), { entry: fileEntry("/users/me/Docs/b c.pdf") });
	assert.strictEqual(t.left.length, 0);
});

test("moveItem rename only of a directory uses /dir/rename", () => {
	const t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/Old")}&fields=type`, json(200, { type: "dir" })],
		[`POST ${API}/dir/rename?path=${enc("/users/me/Old")}&name=New%20Folder`, json(200, DIR_META)],
	]);
	assert.deepStrictEqual(plain(t.A.moveItem(t.creds, "/users/me/Old", null, "New Folder", t.onRenew).result), { entry: DIR_ENTRY });
});

test("moveItem move only of a directory to home: dst is the home path plus the old leaf", () => {
	const t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/Docs/New Folder")}&fields=type`, json(200, { type: "dir" })],
		[`GET ${API}/user/me?fields=account,alias,email,descr,home,home_id`, ME],
		[`POST ${API}/dir/move?src=${enc("/users/me/Docs/New Folder")}&dst=${enc("/users/me/New Folder")}`, json(200, DIR_META)],
	]);
	assert.deepStrictEqual(plain(t.A.moveItem(t.creds, "/users/me/Docs/New Folder", "home", null, t.onRenew).result), { entry: DIR_ENTRY });
	assert.strictEqual(t.left.length, 0);
});

test("moveItem move and rename at once: one POST /file/move to the new full path", () => {
	const t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/a.pdf")}&fields=type`, json(200, { type: "file" })],
		[`POST ${API}/file/move?src=${enc("/users/me/a.pdf")}&dst=${enc("/users/me/Docs/z.pdf")}`, json(200, FILE_META("/users/me/Docs/z.pdf"))],
	]);
	assert.deepStrictEqual(plain(t.A.moveItem(t.creds, "/users/me/a.pdf", "/users/me/Docs", "z.pdf", t.onRenew).result),
		{ entry: fileEntry("/users/me/Docs/z.pdf") });
});

test("moveItem: a failed type lookup or a 409 on the move is the failure; nothing more is sent", () => {
	let t = setup([[`GET ${API}/meta?path=${enc("/users/me/gone")}&fields=type`, json(404, { code: "404" })]]);
	let e = failure(t.A.moveItem(t.creds, "/users/me/gone", null, "x", t.onRenew));
	assert.strictEqual(e.errorCode, "HIDRIVE_API_ERROR");
	assert.strictEqual(e.status, 404);
	assert.strictEqual(t.reqs.length, 1);
	t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/a")}&fields=type`, json(200, { type: "file" })],
		[`POST ${API}/file/move?src=${enc("/users/me/a")}&dst=${enc("/users/me/D/a")}`, json(409, { code: "409" })],
	]);
	e = failure(t.A.moveItem(t.creds, "/users/me/a", "/users/me/D", null, t.onRenew));
	assert.strictEqual(e.status, 409);
});

test("moveItem: after a refresh on the type lookup the move goes out with the new token", () => {
	const t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/a")}&fields=type`, json(401)],
		[`GET ${API}/meta?path=${enc("/users/me/a")}&fields=type`, json(200, { type: "file" })],
		[`POST ${API}/file/rename?path=${enc("/users/me/a")}&name=b`, json(201, { name: "b", path: "/users/me/b", type: "file" })],
	]);
	assert.strictEqual(t.A.moveItem(t.creds, "/users/me/a", null, "b", t.onRenew).result.entry.path, "/users/me/b");
	assert.deepStrictEqual(t.reqs.map((r) => r.auth), ["Bearer tok", "Bearer tok2", "Bearer tok2"]);
	assert.strictEqual(t.refreshes.length, 1);
	assert.strictEqual(t.renewed.length, 1);
});

test("deleteItem: a file goes through DELETE /file, a directory recursively through DELETE /dir", () => {
	let t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/a b.pdf")}&fields=type`, json(200, { type: "file" })],
		[`DELETE ${API}/file?path=${enc("/users/me/a b.pdf")}`, json(204)],
	]);
	assert.deepStrictEqual(plain(t.A.deleteItem(t.creds, "/users/me/a b.pdf", t.onRenew).result), {});
	assert.strictEqual(t.left.length, 0);
	t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/D")}&fields=type`, json(200, { type: "dir" })],
		[`DELETE ${API}/dir?path=${enc("/users/me/D")}&recursive=true`, json(204)],
	]);
	assert.deepStrictEqual(plain(t.A.deleteItem(t.creds, "/users/me/D", t.onRenew).result), {});
	assert.strictEqual(t.left.length, 0);
});

test("deleteItem: a refused delete is a failure", () => {
	const t = setup([
		[`GET ${API}/meta?path=${enc("/users/me/D")}&fields=type`, json(200, { type: "dir" })],
		[`DELETE ${API}/dir?path=${enc("/users/me/D")}&recursive=true`, json(403, { code: "403" })],
	]);
	const e = failure(t.A.deleteItem(t.creds, "/users/me/D", t.onRenew));
	assert.strictEqual(e.errorCode, "HIDRIVE_API_ERROR");
	assert.strictEqual(e.status, 403);
});
