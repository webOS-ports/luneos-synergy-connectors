// node --test tests/unit
// cloud/yandex's createFolder, moveItem and deleteItem (adapter.js) against a stand-in
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

const SVC = path.join(__dirname, "../../cloud/yandex/service/com.palm.service.yandexdisk");
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

const API = "https://cloud-api.yandex.net/v1/disk";
const OP = API + "/operations?id=op1";
const json = (status, body) => ({ status, responseText: body === undefined ? "" : JSON.stringify(body) });
const link = (href) => ({ href, method: "GET", templated: false });

// `script` answers each request in order: [expected "METHOD url", response]. The poll delay is
// stubbed: it runs the next poll at once and records the delay asked for.
function setup(script, { refreshTo = "tok2" } = {}) {
	const reqs = [], renewed = [], refreshes = [], delays = [];
	const queue = script.slice();
	const ctx = {
		IMPORTS: { foundations: { Control: { Future: FakeFuture } } },
		Future: FakeFuture,
		console: { log() {}, error() {} },
		setTimeout: () => { throw new Error("must not really sleep"); },
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
	ctx.Adapter._later = (fn, ms) => { delays.push(ms); fn(); };
	const creds = { accessToken: "tok", refreshToken: "rt" };
	return { A: ctx.Adapter, ctx, reqs, renewed, refreshes, delays, creds, onRenew: (nc) => renewed.push(nc), left: queue };
}

const plain = (o) => JSON.parse(JSON.stringify(o));
const failure = (f) => { try { f.result; } catch (e) { return plain(e); } return null; };
const enc = encodeURIComponent;
const get = (p) => `GET ${API}/resources?path=${enc(p)}&limit=0`;

const res = (p, type) => ({ path: p, name: p.split("/").pop(), type, created: "2026-10-19T10:00:00+00:00",
	modified: "2026-10-19T10:00:00+00:00", resource_id: "1:abc", ...(type === "file" ? { size: 7, mime_type: "application/pdf" } : {}) });
const entry = (p, type) => ({ id: p, type: type === "dir" ? "folder" : "file", name: p.split("/").pop(),
	...(type === "file" ? { size: 7 } : {}), modified: "2026-10-19T10:00:00+00:00", path: p,
	...(type === "file" ? { mimeType: "application/pdf" } : {}) });

test("listFolder output is unchanged by the shared normaliser", () => {
	const t = setup([[`GET ${API}/resources?path=${enc("disk:/Docs")}&limit=200`,
		json(200, { _embedded: { items: [res("disk:/Docs/Sub", "dir"), res("disk:/Docs/a.pdf", "file")] } })]]);
	assert.deepStrictEqual(plain(t.A.listFolder(t.creds, "disk:/Docs", t.onRenew).result.entries),
		[entry("disk:/Docs/Sub", "dir"), entry("disk:/Docs/a.pdf", "file")]);
});

test("createFolder at the root: PUT /resources, then the new folder read back", () => {
	const t = setup([
		[`PUT ${API}/resources?path=${enc("disk:/Новая папка")}`, json(201, link(`${API}/resources?path=disk%3A%2F`))],
		[get("disk:/Новая папка"), json(200, res("disk:/Новая папка", "dir"))],
	]);
	const f = t.A.createFolder(t.creds, "disk:/", "Новая папка", t.onRenew);
	assert.deepStrictEqual(plain(f.result), { entry: entry("disk:/Новая папка", "dir") });
	assert.deepStrictEqual(t.reqs.map((r) => r.auth), ["OAuth tok", "OAuth tok"]);
	assert.strictEqual(t.left.length, 0);
});

test("createFolder in a sub-folder; 409 (exists) is a failure and nothing is read back", () => {
	let t = setup([
		[`PUT ${API}/resources?path=${enc("disk:/Docs/X")}`, json(201, link("x"))],
		[get("disk:/Docs/X"), json(200, res("disk:/Docs/X", "dir"))],
	]);
	assert.strictEqual(t.A.createFolder(t.creds, "disk:/Docs", "X", t.onRenew).result.entry.path, "disk:/Docs/X");
	t = setup([[`PUT ${API}/resources?path=${enc("disk:/Docs/X")}`, json(409, { error: "DiskPathPointsToExistentDirectoryError" })]]);
	const e = failure(t.A.createFolder(t.creds, "disk:/Docs", "X", t.onRenew));
	assert.strictEqual(e.errorCode, "YANDEX_API_ERROR");
	assert.strictEqual(e.returnValue, false);
	assert.strictEqual(e.status, 409);
	assert.strictEqual(t.reqs.length, 1);
});

const move = (from, to) => `POST ${API}/resources/move?from=${enc(from)}&path=${enc(to)}&overwrite=false`;

test("moveItem rename only: the new path is in the item's own folder", () => {
	const t = setup([
		[move("disk:/Docs/a.pdf", "disk:/Docs/b 100%.pdf"), json(201, link("x"))],
		[get("disk:/Docs/b 100%.pdf"), json(200, res("disk:/Docs/b 100%.pdf", "file"))],
	]);
	assert.deepStrictEqual(plain(t.A.moveItem(t.creds, "disk:/Docs/a.pdf", null, "b 100%.pdf", t.onRenew).result),
		{ entry: entry("disk:/Docs/b 100%.pdf", "file") });
	assert.strictEqual(t.left.length, 0);
});

test("moveItem rename only of a top-level item stays at the root", () => {
	const t = setup([[move("disk:/a.pdf", "disk:/b.pdf"), json(201, link("x"))], [get("disk:/b.pdf"), json(200, res("disk:/b.pdf", "file"))]]);
	assert.strictEqual(t.A.moveItem(t.creds, "disk:/a.pdf", null, "b.pdf", t.onRenew).result.entry.path, "disk:/b.pdf");
});

test("moveItem move only keeps the name (even one with a %); move and rename is one request", () => {
	let t = setup([[move("disk:/Docs/50%25.pdf", "disk:/50%25.pdf"), json(201, link("x"))], [get("disk:/50%25.pdf"), json(200, res("disk:/50%25.pdf", "file"))]]);
	assert.strictEqual(t.A.moveItem(t.creds, "disk:/Docs/50%25.pdf", "disk:/", null, t.onRenew).result.entry.path, "disk:/50%25.pdf");
	t = setup([[move("disk:/a.pdf", "disk:/Docs/z.pdf"), json(201, link("x"))], [get("disk:/Docs/z.pdf"), json(200, res("disk:/Docs/z.pdf", "file"))]]);
	assert.deepStrictEqual(plain(t.A.moveItem(t.creds, "disk:/a.pdf", "disk:/Docs", "z.pdf", t.onRenew).result),
		{ entry: entry("disk:/Docs/z.pdf", "file") });
	assert.strictEqual(t.left.length, 0);
});

test("moveItem: 409 (target exists) is a failure", () => {
	const t = setup([[move("disk:/a", "disk:/D/a"), json(409, { error: "DiskResourceAlreadyExistsError" })]]);
	const e = failure(t.A.moveItem(t.creds, "disk:/a", "disk:/D", null, t.onRenew));
	assert.strictEqual(e.errorCode, "YANDEX_API_ERROR");
	assert.strictEqual(e.status, 409);
	assert.strictEqual(t.reqs.length, 1);
});

test("moveItem 202: the operation is polled until success, then the entry is read", () => {
	const t = setup([
		[move("disk:/Big", "disk:/Docs/Big"), json(202, link(OP))],
		[`GET ${OP}`, json(200, { status: "in-progress" })],
		[`GET ${OP}`, json(200, { status: "in-progress" })],
		[`GET ${OP}`, json(200, { status: "success" })],
		[get("disk:/Docs/Big"), json(200, res("disk:/Docs/Big", "dir"))],
	]);
	assert.deepStrictEqual(plain(t.A.moveItem(t.creds, "disk:/Big", "disk:/Docs", null, t.onRenew).result),
		{ entry: entry("disk:/Docs/Big", "dir") });
	assert.deepStrictEqual(t.delays, [1000, 1000]);
	assert.ok(t.reqs.every((r) => r.auth === "OAuth tok"));
	assert.strictEqual(t.left.length, 0);
});

test("moveItem 202: a failed operation is a failure and nothing is read back", () => {
	const t = setup([
		[move("disk:/Big", "disk:/Docs/Big"), json(202, link(OP))],
		[`GET ${OP}`, json(200, { status: "failed" })],
	]);
	const e = failure(t.A.moveItem(t.creds, "disk:/Big", "disk:/Docs", null, t.onRenew));
	assert.strictEqual(e.errorCode, "YANDEX_OPERATION_FAILED");
	assert.strictEqual(e.returnValue, false);
	assert.strictEqual(t.reqs.length, 2);
});

test("moveItem 202: polling stops after _POLL_TRIES polls", () => {
	const n = 30;
	const script = [[move("disk:/Big", "disk:/B2"), json(202, link(OP))]];
	for (let i = 0; i < n; i++) script.push([`GET ${OP}`, json(200, { status: "in-progress" })]);
	const t = setup(script);
	assert.strictEqual(t.A._POLL_TRIES, n);
	const e = failure(t.A.moveItem(t.creds, "disk:/Big", null, "B2", t.onRenew));
	assert.strictEqual(e.errorCode, "YANDEX_OPERATION_TIMEOUT");
	assert.strictEqual(t.reqs.length, 1 + n);
	assert.strictEqual(t.delays.length, n - 1);
	assert.strictEqual(t.left.length, 0);
});

test("202 with an operation link off the API host: the token is not sent there", () => {
	const t = setup([[move("disk:/Big", "disk:/B2"), json(202, link("https://evil.example/v1/disk/operations?id=1"))]]);
	assert.strictEqual(failure(t.A.moveItem(t.creds, "disk:/Big", null, "B2", t.onRenew)).errorCode, "YANDEX_BAD_OPERATION");
	assert.strictEqual(t.reqs.length, 1);
});

test("moveItem: 401 refreshes once and the read-back uses the new token", () => {
	const t = setup([
		[move("disk:/a", "disk:/b"), json(401)],
		[move("disk:/a", "disk:/b"), json(201, link("x"))],
		[get("disk:/b"), json(200, res("disk:/b", "file"))],
	]);
	assert.strictEqual(t.A.moveItem(t.creds, "disk:/a", null, "b", t.onRenew).result.entry.path, "disk:/b");
	assert.deepStrictEqual(t.reqs.map((r) => r.auth), ["OAuth tok", "OAuth tok2", "OAuth tok2"]);
	assert.deepStrictEqual(t.refreshes, ["rt"]);
	assert.strictEqual(t.renewed.length, 1);
});

test("deleteItem: DELETE without permanently (to the Trash); 204 resolves to {}", () => {
	const t = setup([[`DELETE ${API}/resources?path=${enc("disk:/Docs/a b.pdf")}`, json(204)]]);
	assert.deepStrictEqual(plain(t.A.deleteItem(t.creds, "disk:/Docs/a b.pdf", t.onRenew).result), {});
	assert.ok(!t.reqs[0].line.includes("permanently"));
});

test("deleteItem 202: polled to success; a refused delete is a failure", () => {
	let t = setup([
		[`DELETE ${API}/resources?path=${enc("disk:/Big")}`, json(202, link(OP))],
		[`GET ${OP}`, json(200, { status: "in-progress" })],
		[`GET ${OP}`, json(200, { status: "success" })],
	]);
	assert.deepStrictEqual(plain(t.A.deleteItem(t.creds, "disk:/Big", t.onRenew).result), {});
	assert.strictEqual(t.left.length, 0);
	t = setup([[`DELETE ${API}/resources?path=${enc("disk:/gone")}`, json(404, { error: "DiskNotFoundError" })]]);
	const e = failure(t.A.deleteItem(t.creds, "disk:/gone", t.onRenew));
	assert.strictEqual(e.errorCode, "YANDEX_API_ERROR");
	assert.strictEqual(e.status, 404);
	t = setup([
		[`DELETE ${API}/resources?path=${enc("disk:/Big")}`, json(202, link(OP))],
		[`GET ${OP}`, json(500, { error: "x" })],
	]);
	assert.strictEqual(failure(t.A.deleteItem(t.creds, "disk:/Big", t.onRenew)).status, 500);
});
