// node --test tests/unit
// cloud/s3's createFolder, moveItem and deleteItem (adapter.js), loaded with the real config.js,
// s3sig.js and s3xml.js the way sources.json loads them, against a stand-in HttpCurl that records
// every request and answers with canned S3 XML. The signatures are checked with an independent
// SigV4 computation below, not with s3sig.js itself.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const S3 = path.join(__dirname, "../../cloud/s3/service/com.palm.service.s3");

// Settles like Foundations' Future (frameworks/foundations/.../control/future.js) as far as the
// adapter uses it: result/setException, then() callbacks run once settled and a throw in one
// fails the future, now() adopts a future its function returns (nest), and assigning a future to
// .result does NOT adopt it.
class Fut {
	constructor() { this._then = []; this._r = { isset: false }; this._busy = false; }
	get result() { this._r.wasread = true; if (this._r.exception) throw this._r.exception; return this._r.result; }
	set result(v) { this._r = { result: v, isset: true }; this._dispatch(); }
	setException(e) { this._r = { exception: e, isset: true }; this._dispatch(); }
	get exception() { this._r.wasread = true; return this._r.exception; }
	_ret(v) { if (v !== undefined) { if (v && typeof v.then === "function") this.nest(v); else this.result = v; } }
	now(scope, fn) {
		try { this._ret(fn.call(scope, this)); } catch (e) { this._r = { exception: e, isset: true }; }
		this._dispatch(); return this;
	}
	then(scope, fn) { this._then.push([scope, fn]); this._dispatch(); return this; }
	nest(inner) {
		inner.then(null, () => { try { this.result = inner.result; } catch (e) { this.setException(e); } });
		return this;
	}
	_dispatch() {
		if (this._busy) return;
		this._busy = true;
		while (this._then.length && this._r.isset) {
			const [scope, fn] = this._then.shift();
			this._r.isset = false;
			try {
				this._ret(fn.call(scope, this));
				if (this._r.exception && !this._r.wasread) this._r.isset = true;
			} catch (e) { this._r = { exception: e, isset: true }; }
		}
		this._busy = false;
	}
}

const SECRET = "unit-test-secret-not-a-credential";
const CREDS = { accessToken: "AKIDUNITTEST", secretAccessKey: SECRET, endpoint: "s3.example.test",
	region: "eu-test-1", bucket: "bkt", pathStyle: true };

// reply(req) -> { status, responseText }; every request is recorded in `sent`.
function setup(reply) {
	const sent = [];
	const ctx = {
		IMPORTS: { foundations: { Control: { Future: Fut } } },
		require, Buffer, Date, console,
		HttpCurl: {
			request(o) {
				const u = new URL(o.url);
				const req = { method: o.method, url: o.url, headers: o.headers, body: o.body,
					dataFile: o.dataFile, path: decodeURIComponent(u.pathname), query: Object.fromEntries(u.searchParams) };
				sent.push(req);
				const f = new Fut();
				f.result = reply(req);
				return f;
			},
		},
	};
	vm.createContext(ctx);
	for (const file of ["config.js", "s3sig.js", "s3xml.js", "adapter.js"]) {
		vm.runInContext(fs.readFileSync(path.join(S3, file), "utf8"), ctx, { filename: file });
	}
	return { Adapter: ctx.Adapter, sent };
}

const plain = (o) => JSON.parse(JSON.stringify(o));
const errOf = (f) => { try { f.result; } catch (e) { return e; } return null; };
const keyOf = (req) => req.path.replace(/^\/bkt\//, "");
const isList = (r) => r.method === "GET" && r.query["list-type"] === "2";

const listXml = (keys, { prefixes = [], token = null } = {}) =>
	"<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult>" +
	keys.map((k) => {
		const [key, size = 3] = Array.isArray(k) ? k : [k];
		return `<Contents><Key>${key.replace(/&/g, "&amp;")}</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified>` +
			`<ETag>"e"</ETag><Size>${size}</Size></Contents>`;
	}).join("") +
	prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("") +
	`<IsTruncated>${token ? "true" : "false"}</IsTruncated>` +
	(token ? `<NextContinuationToken>${token}</NextContinuationToken>` : "") + "</ListBucketResult>";
const COPY_OK = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><CopyObjectResult><LastModified>2026-10-19T12:00:00.000Z</LastModified><ETag>\"e\"</ETag></CopyObjectResult>";
const DELETE_OK = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"></DeleteResult>";
const s3Error = (code) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code} happened</Message></Error>`;

// A bucket held as a key -> size map, answering list (prefix, max-keys, continuation by `page`
// keys per page), PUT (copy or marker), DELETE and DeleteObjects the way S3 does.
function bucket(objects, { page = 1000, copy, del, multi } = {}) {
	const store = new Map(Object.entries(objects));
	return {
		store,
		reply(req) {
			if (isList(req)) {
				const all = [...store.keys()].filter((k) => k.startsWith(req.query.prefix || "")).sort();
				const start = req.query["continuation-token"] ? Number(req.query["continuation-token"]) : 0;
				const n = Math.min(page, Number(req.query["max-keys"] || 1000));
				const chunk = all.slice(start, start + n);
				const more = start + n < all.length;
				return { status: 200, responseText: listXml(chunk.map((k) => [k, store.get(k)]), { token: more ? String(start + n) : null }) };
			}
			if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
				const src = decodeURIComponent(req.headers["x-amz-copy-source"]).replace(/^bkt\//, "");
				const r = copy && copy(req, src);
				if (r) return r;
				if (!store.has(src)) return { status: 404, responseText: s3Error("NoSuchKey") };
				store.set(keyOf(req), store.get(src));
				return { status: 200, responseText: COPY_OK };
			}
			if (req.method === "PUT") { store.set(keyOf(req), 0); return { status: 200, responseText: "" }; }
			if (req.method === "DELETE") {
				const r = del && del(req);
				if (r) return r;
				store.delete(keyOf(req)); return { status: 204, responseText: "" };
			}
			if (req.method === "POST" && "delete" in req.query) {
				const keys = [...req.body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1]
					.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
				const r = multi && multi(req, keys);
				if (r) return r;
				keys.forEach((k) => store.delete(k));
				return { status: 200, responseText: DELETE_OK };
			}
			throw new Error("unexpected request " + req.method + " " + req.url);
		},
	};
}

// Independent SigV4 check of a recorded request: rebuild the canonical request from what was
// actually sent (URL path/query as encoded on the wire, headers, payload hash) and compare the
// signature in the Authorization header.
function verifySig(req) {
	const auth = req.headers.Authorization;
	const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
	assert.ok(m, "Authorization header shape: " + auth);
	const [, , date, region, signedHeaders, sig] = m;
	const u = new URL(req.url);
	const hdr = {};
	Object.keys(req.headers).forEach((k) => { if (k !== "Authorization") hdr[k.toLowerCase()] = String(req.headers[k]).trim(); });
	const names = signedHeaders.split(";");
	assert.deepStrictEqual(names, Object.keys(hdr).sort(), "every header sent is signed");
	const query = u.search.replace(/^\?/, "").split("&").filter(Boolean).sort().join("&");
	const canon = [req.method, u.pathname, query, names.map((n) => n + ":" + hdr[n] + "\n").join(""),
		signedHeaders, hdr["x-amz-content-sha256"]].join("\n");
	const sts = ["AWS4-HMAC-SHA256", hdr["x-amz-date"], `${date}/${region}/s3/aws4_request`,
		crypto.createHash("sha256").update(canon).digest("hex")].join("\n");
	const h = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
	const key = h(h(h(h("AWS4" + SECRET, date), region), "s3"), "aws4_request");
	assert.strictEqual(crypto.createHmac("sha256", key).update(sts).digest("hex"), sig, "signature verifies");
	return names;
}
const EMPTY_SHA = crypto.createHash("sha256").update("").digest("hex");

test("listFolder's entries are unchanged by the shared normalisers", () => {
	const { Adapter } = setup(() => ({ status: 200,
		responseText: listXml(["Docs/", ["Docs/a.pdf", 12]], { prefixes: ["Docs/Sub/"] }) }));
	assert.deepStrictEqual(plain(Adapter.listFolder(CREDS, "Docs").result), { entries: [
		{ id: "Docs/Sub/", type: "folder", name: "Sub", size: 0, modified: 0, path: "Docs/Sub/", mimeType: "application/x-directory" },
		{ id: "Docs/a.pdf", type: "file", name: "a.pdf", size: 12, modified: Date.parse("2026-10-01T10:00:00.000Z"),
			path: "Docs/a.pdf", mimeType: "application/pdf" },
	] });
});

test("createFolder PUTs an empty, signed <parent><name>/ marker and returns a listFolder entry", () => {
	const b = bucket({});
	const { Adapter, sent } = setup(b.reply);
	const f = Adapter.createFolder(CREDS, "Docs/", "New", () => {});
	assert.deepStrictEqual(plain(f.result), { entry: { id: "Docs/New/", type: "folder", name: "New", size: 0,
		modified: 0, path: "Docs/New/", mimeType: "application/x-directory" } });
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].method, "PUT");
	assert.strictEqual(sent[0].url, "https://s3.example.test/bkt/Docs/New/");
	assert.strictEqual(sent[0].headers["content-length"], "0");
	assert.strictEqual(sent[0].headers["x-amz-content-sha256"], EMPTY_SHA);
	assert.strictEqual(sent[0].body, undefined);
	verifySig(sent[0]);
	// the root, and a parent given without its trailing slash
	Adapter.createFolder(CREDS, "root", "Top", () => {});
	Adapter.createFolder(CREDS, "Docs", "X y", () => {});
	assert.strictEqual(sent[1].url, "https://s3.example.test/bkt/Top/");
	assert.strictEqual(sent[2].url, "https://s3.example.test/bkt/Docs/X%20y/");
});

test("createFolder refuses a bad name without a request and reports a failed PUT", () => {
	const { Adapter, sent } = setup(() => ({ status: 403, responseText: s3Error("AccessDenied") }));
	assert.strictEqual(errOf(Adapter.createFolder(CREDS, "", "a/b")).errorCode, "BAD_ARGS");
	assert.strictEqual(sent.length, 0);
	const e = errOf(Adapter.createFolder(CREDS, "", "ok"));
	assert.deepStrictEqual([e.returnValue, e.errorCode, e.status, e.s3Code], [false, "S3_MKDIR_FAILED", 403, "AccessDenied"]);
});

test("renaming a file: look up, check the target is free, copy (signed copy-source), then delete", () => {
	const b = bucket({ "Docs/a b ü.txt": 7, "Docs/a b üx.txt": 1 });
	const { Adapter, sent } = setup(b.reply);
	const f = Adapter.moveItem(CREDS, "Docs/a b ü.txt", null, "c&d.txt", () => {});
	assert.deepStrictEqual(plain(f.result), { entry: { id: "Docs/c&d.txt", type: "file", name: "c&d.txt", size: 7,
		modified: Date.parse("2026-10-19T12:00:00.000Z"), path: "Docs/c&d.txt", mimeType: "text/plain" } });
	assert.deepStrictEqual(sent.map((r) => r.method + " " + (isList(r) ? "list " + r.query.prefix : keyOf(r))),
		["GET list Docs/a b ü.txt", "GET list Docs/c&d.txt", "PUT Docs/c&d.txt", "DELETE Docs/a b ü.txt"]);
	assert.strictEqual(sent[0].query["max-keys"], "1");
	const copy = sent[2];
	assert.strictEqual(copy.headers["x-amz-copy-source"], "bkt/Docs/a%20b%20%C3%BC.txt");
	assert.strictEqual(copy.url, "https://s3.example.test/bkt/Docs/c%26d.txt");
	assert.strictEqual(copy.headers["content-length"], "0");
	assert.ok(verifySig(copy).includes("x-amz-copy-source"), "copy source is a signed header");
	verifySig(sent[3]);
	assert.deepStrictEqual([...b.store.keys()].sort(), ["Docs/a b üx.txt", "Docs/c&d.txt"]);
});

test("moving a file keeps its name; move and rename together; to the root", () => {
	const b = bucket({ "Docs/a.txt": 1, "Docs/b.txt": 2, "c.txt": 3 });
	const { Adapter } = setup(b.reply);
	assert.strictEqual(Adapter.moveItem(CREDS, "Docs/a.txt", "Archive/", null).result.entry.path, "Archive/a.txt");
	assert.strictEqual(Adapter.moveItem(CREDS, "Docs/b.txt", "Archive", "z.txt").result.entry.path, "Archive/z.txt");
	assert.strictEqual(Adapter.moveItem(CREDS, "Archive/z.txt", "root", null).result.entry.path, "z.txt");
	assert.strictEqual(Adapter.moveItem(CREDS, "c.txt", null, "d.txt").result.entry.path, "d.txt");
	assert.deepStrictEqual([...b.store.keys()].sort(), ["Archive/a.txt", "d.txt", "z.txt"]);
});

test("a failed copy, or a 200 carrying an <Error>, deletes nothing", () => {
	for (const bad of [{ status: 403, responseText: s3Error("AccessDenied") },
		{ status: 200, responseText: s3Error("InternalError") },
		{ status: 200, responseText: "" }]) {
		const b = bucket({ "a.txt": 1 }, { copy: () => bad });
		const { Adapter, sent } = setup(b.reply);
		const e = errOf(Adapter.moveItem(CREDS, "a.txt", null, "b.txt"));
		assert.strictEqual(e.errorCode, "S3_COPY_FAILED", bad.responseText);
		assert.ok(!sent.some((r) => r.method === "DELETE" || r.method === "POST"), "no delete after a failed copy");
		assert.ok(b.store.has("a.txt"));
	}
});

test("a delete that fails after the copy reports S3_MOVE_INCOMPLETE with the new entry", () => {
	const b = bucket({ "a.txt": 1 }, { del: () => ({ status: 403, responseText: s3Error("AccessDenied") }) });
	const { Adapter } = setup(b.reply);
	const e = errOf(Adapter.moveItem(CREDS, "a.txt", null, "b.txt"));
	assert.strictEqual(e.errorCode, "S3_MOVE_INCOMPLETE");
	assert.strictEqual(e.entry.path, "b.txt");
});

test("moving a file onto an existing key, a missing key, or one over 5 GB is refused untouched", () => {
	let b = bucket({ "a.txt": 1, "b.txt": 2 });
	let s = setup(b.reply);
	assert.strictEqual(errOf(s.Adapter.moveItem(CREDS, "a.txt", null, "b.txt")).errorCode, "S3_DESTINATION_EXISTS");
	assert.strictEqual(errOf(s.Adapter.moveItem(CREDS, "nope.txt", null, "c.txt")).errorCode, "S3_NOT_FOUND");
	b = bucket({ "big.iso": 5 * 1024 ** 3 + 1, "ok.iso": 5 * 1024 ** 3 });
	s = setup(b.reply);
	assert.strictEqual(errOf(s.Adapter.moveItem(CREDS, "big.iso", "x/", null)).errorCode, "S3_TOO_LARGE_TO_COPY");
	assert.ok(!s.sent.some((r) => r.method !== "GET"));
	assert.strictEqual(s.Adapter.moveItem(CREDS, "ok.iso", "x/", null).result.entry.path, "x/ok.iso");
});

test("moving a file to where it already is changes nothing", () => {
	const b = bucket({ "Docs/a.txt": 1 });
	const { Adapter, sent } = setup(b.reply);
	assert.strictEqual(Adapter.moveItem(CREDS, "Docs/a.txt", "Docs/", "a.txt").result.entry.path, "Docs/a.txt");
	assert.ok(sent.every(isList));
	assert.ok(b.store.has("Docs/a.txt"));
});

test("moving a folder pages through its keys, copies them all, then deletes the originals in one batch", () => {
	const b = bucket({ "A/": 0, "A/1.txt": 1, "A/sub/2.txt": 2, "A/sub/<3>.txt": 3, "AB/x": 9 }, { page: 2 });
	const { Adapter, sent } = setup(b.reply);
	const f = Adapter.moveItem(CREDS, "A/", "Dest/", "B", () => {});
	assert.deepStrictEqual(plain(f.result), { entry: { id: "Dest/B/", type: "folder", name: "B", size: 0,
		modified: 0, path: "Dest/B/", mimeType: "application/x-directory" } });
	const lists = sent.filter((r) => isList(r) && r.query.prefix === "A/");
	assert.strictEqual(lists.length, 2, "two pages");
	assert.strictEqual(lists[1].query["continuation-token"], "2");
	assert.strictEqual(lists[0].query.delimiter, undefined, "the whole subtree, not one level");
	const writes = sent.filter((r) => !isList(r));
	assert.deepStrictEqual(writes.map((r) => r.method + " " + keyOf(r)),
		["PUT Dest/B/", "PUT Dest/B/1.txt", "PUT Dest/B/sub/2.txt", "PUT Dest/B/sub/<3>.txt", "POST "]);
	const post = writes[4];
	assert.ok(post.url.endsWith("/bkt/?delete="));
	assert.strictEqual(post.headers["content-md5"], crypto.createHash("md5").update(post.body).digest("base64"));
	assert.strictEqual(post.headers["x-amz-content-sha256"], crypto.createHash("sha256").update(post.body).digest("hex"));
	assert.match(post.body, /<Quiet>true<\/Quiet>/);
	assert.match(post.body, /<Key>A\/sub\/&lt;3&gt;\.txt<\/Key>/);
	verifySig(post);
	assert.deepStrictEqual([...b.store.keys()].sort(), ["AB/x", "Dest/B/", "Dest/B/1.txt", "Dest/B/sub/2.txt", "Dest/B/sub/<3>.txt"]);
});

test("renaming a folder in place, and moving it under the root keeping its name", () => {
	const b = bucket({ "P/A/": 0, "P/A/f": 1 });
	const { Adapter } = setup(b.reply);
	assert.strictEqual(Adapter.moveItem(CREDS, "P/A/", null, "C").result.entry.path, "P/C/");
	assert.strictEqual(Adapter.moveItem(CREDS, "P/C/", "root", null).result.entry.path, "C/");
	assert.deepStrictEqual([...b.store.keys()].sort(), ["C/", "C/f"]);
});

test("a folder copy failing part-way keeps every original and removes the copies made", () => {
	const b = bucket({ "A/1": 1, "A/2": 2, "A/3": 3 },
		{ copy: (req, src) => (src === "A/3" ? { status: 200, responseText: s3Error("SlowDown") } : null) });
	const { Adapter, sent } = setup(b.reply);
	const e = errOf(Adapter.moveItem(CREDS, "A/", "B/", null));
	assert.deepStrictEqual([e.errorCode, e.copied, e.total, e.cleanedUp], ["S3_COPY_FAILED", 2, 3, true]);
	const posts = sent.filter((r) => r.method === "POST");
	assert.strictEqual(posts.length, 1);
	assert.ok(!/<Key>A\//.test(posts[0].body), "no original is in the cleanup batch");
	assert.deepStrictEqual([...b.store.keys()].sort(), ["A/1", "A/2", "A/3"]);
});

test("moving a folder: over the bound, onto an existing folder, or into itself is refused untouched", () => {
	const many = {};
	for (let i = 0; i < 26; i++) many["A/" + i] = 1;
	let b = bucket(many, { page: 10 });
	let s = setup(b.reply);
	const e = errOf(s.Adapter.moveItem(CREDS, "A/", "B/", null));
	assert.deepStrictEqual([e.errorCode, e.limit], ["S3_TOO_MANY_KEYS", 25]);
	assert.ok(s.sent.every(isList));
	assert.strictEqual(s.sent[0].query["max-keys"], "26", "asks for one past the bound, no more");
	many["A/25"] = undefined; delete many["A/25"];
	b = bucket(many, { page: 10 });
	s = setup(b.reply);
	assert.strictEqual(s.Adapter.moveItem(CREDS, "A/", "B/", null).result.entry.path, "B/A/");

	b = bucket({ "A/1": 1, "B/A/x": 1 });
	s = setup(b.reply);
	assert.strictEqual(errOf(s.Adapter.moveItem(CREDS, "A/", "B/", null)).errorCode, "S3_DESTINATION_EXISTS");
	assert.strictEqual(errOf(s.Adapter.moveItem(CREDS, "A/", "A/in/", null)).errorCode, "S3_MOVE_INTO_SELF");
	assert.strictEqual(errOf(s.Adapter.moveItem(CREDS, "Z/", "B/", null)).errorCode, "S3_NOT_FOUND");
	assert.strictEqual(errOf(s.Adapter.moveItem(CREDS, "root", "B/", null)).errorCode, "BAD_ARGS");
	assert.ok(s.sent.every(isList));
});

test("originals a DeleteObjects batch could not remove are reported after a folder move", () => {
	const b = bucket({ "A/1": 1, "A/2": 2 }, { multi: (req, keys) => (keys.includes("A/2") ? { status: 200,
		responseText: "<DeleteResult><Error><Key>A/2</Key><Code>AccessDenied</Code><Message>no</Message></Error></DeleteResult>" } : null) });
	const { Adapter } = setup(b.reply);
	const e = errOf(Adapter.moveItem(CREDS, "A/", "B/", null));
	assert.strictEqual(e.errorCode, "S3_MOVE_INCOMPLETE");
	assert.deepStrictEqual(plain(e.notDeleted), ["A/2"]);
});

test("deleteItem on a key is one signed DELETE", () => {
	const b = bucket({ "a.txt": 1 });
	const { Adapter, sent } = setup(b.reply);
	assert.deepStrictEqual(plain(Adapter.deleteItem(CREDS, "a.txt").result), {});
	assert.deepStrictEqual(sent.map((r) => r.method + " " + keyOf(r)), ["DELETE a.txt"]);
	verifySig(sent[0]);
	const s2 = setup(() => ({ status: 403, responseText: s3Error("AccessDenied") }));
	assert.strictEqual(errOf(s2.Adapter.deleteItem(CREDS, "a.txt")).errorCode, "S3_DELETE_FAILED");
	assert.strictEqual(errOf(s2.Adapter.deleteItem(CREDS, "root")).errorCode, "BAD_ARGS");
	assert.strictEqual(errOf(s2.Adapter.deleteItem(CREDS, "")).errorCode, "BAD_ARGS");
});

test("deleteItem on a folder lists every page and deletes all of it, marker included, in batches", () => {
	const b = bucket({ "A/": 0, "A/1": 1, "A/s/2": 2, "A/s/3": 3, "A/s/4": 4, "AB": 5 }, { page: 2 });
	const { Adapter, sent } = setup(b.reply);
	Adapter.DELETE_BATCH_KEYS = 3;
	assert.deepStrictEqual(plain(Adapter.deleteItem(CREDS, "A/").result), {});
	assert.strictEqual(sent.filter(isList).length, 3);
	const posts = sent.filter((r) => r.method === "POST");
	assert.strictEqual(posts.length, 2);
	assert.match(posts[0].body, /<Key>A\/<\/Key>/);
	assert.deepStrictEqual([...b.store.keys()], ["AB"]);
	// by size as well: keys near S3's 1024-byte limit split well before 1000 per batch
	const big = {};
	for (let i = 0; i < 200; i++) big["L/" + String(i).padStart(3, "0") + "x".repeat(1000)] = 1;
	const b2 = bucket(big);
	const s2 = setup(b2.reply);
	assert.deepStrictEqual(plain(s2.Adapter.deleteItem(CREDS, "L/").result), {});
	const p2 = s2.sent.filter((r) => r.method === "POST");
	assert.ok(p2.length >= 3 && p2.every((r) => Buffer.byteLength(r.body) < 100 * 1024), String(p2.length));
	assert.strictEqual(b2.store.size, 0);
});

test("deleteItem on a folder: the bound, per-key errors and a rejected batch fail it", () => {
	const many = {};
	for (let i = 0; i < 1001; i++) many["A/" + i] = 1;
	let s = setup(bucket(many).reply);
	assert.deepStrictEqual([errOf(s.Adapter.deleteItem(CREDS, "A/")).errorCode], ["S3_TOO_MANY_KEYS"]);
	assert.ok(s.sent.every(isList));

	s = setup(bucket({ "A/1": 1, "A/2": 1 }, { multi: () => ({ status: 200,
		responseText: "<DeleteResult><Error><Key>A/1</Key><Code>AccessDenied</Code><Message>no</Message></Error></DeleteResult>" }) }).reply);
	let e = errOf(s.Adapter.deleteItem(CREDS, "A/"));
	assert.deepStrictEqual([e.errorCode, e.s3Code, plain(e.notDeleted)], ["S3_DELETE_FAILED", "AccessDenied", ["A/1"]]);

	s = setup(bucket({ "A/1": 1 }, { multi: () => ({ status: 200, responseText: s3Error("MalformedXML") }) }).reply);
	e = errOf(s.Adapter.deleteItem(CREDS, "A/"));
	assert.deepStrictEqual([e.errorCode, e.s3Code], ["S3_DELETE_FAILED", "MalformedXML"]);
	s = setup(bucket({ "A/1": 1 }, { multi: () => ({ status: 200, responseText: "" }) }).reply);
	assert.strictEqual(errOf(s.Adapter.deleteItem(CREDS, "A/")).errorCode, "S3_DELETE_FAILED", "a 200 with no DeleteResult");

	s = setup(bucket({}).reply);
	assert.deepStrictEqual(plain(s.Adapter.deleteItem(CREDS, "Gone/").result), {}, "an empty prefix is already gone");
	assert.ok(!s.sent.some((r) => r.method === "POST"));
});

test("an http:// endpoint with a port (self-hosted) is called over http, its host:port signed", () => {
	const { Adapter, sent } = setup(() => ({ status: 200, responseText: listXml(["a.txt"]) }));
	const creds = Object.assign({}, CREDS, { endpoint: "127.0.0.1:3900", scheme: "http" });
	Adapter.listFolder(creds, "").result;
	const u = new URL(sent[0].url);
	assert.strictEqual(u.protocol, "http:");
	assert.strictEqual(u.host, "127.0.0.1:3900");
	assert.strictEqual(sent[0].headers.host || sent[0].headers.Host, "127.0.0.1:3900", "the Host header carries the port");
	verifySig(sent[0]);
	// without a scheme in the credentials, https as before
	const t2 = setup(() => ({ status: 200, responseText: listXml([]) }));
	t2.Adapter.listFolder(CREDS, "").result;
	assert.strictEqual(new URL(t2.sent[0].url).protocol, "https:");
});

test("login keeps http only for an endpoint given as http://, and the host:port either way", () => {
	const seen = [];
	const run = (endpoint) => {
		const ctx = { Future: Fut, Config: { DEFAULT_REGION: "us-east-1" }, console,
			Adapter: { getAccountInfo(c) { seen.push(c); const f = new Fut(); f.result = { user: { emailAddress: "x" } }; return f; } } };
		vm.createContext(ctx);
		const f = path.join(S3, "commands", "login_command.js");
		vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
		const a = new ctx.LoginCommandAssistant();
		a.controller = { args: { endpoint, bucket: "b", accessKeyId: "k", secretAccessKey: "s" } };
		const fut = new Fut();
		a.run(fut);
		return fut;
	};
	run(" http://127.0.0.1:3900/ ");
	run("https://s3.eu-central-1.amazonaws.com");
	run("s3.us-west-1.idrivee2.com");
	assert.deepStrictEqual(seen.map((c) => [c.endpoint, c.scheme]), [
		["127.0.0.1:3900", "http"], ["s3.eu-central-1.amazonaws.com", undefined], ["s3.us-west-1.idrivee2.com", undefined]]);
});
