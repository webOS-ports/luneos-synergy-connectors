// node --test tests/unit
// cloud/mega's hashcash.js (the proof of work Mega's API asks for with HTTP 402) and the
// response-header option of _cloudcore's httpcurl.js it relies on. Loaded the way sources.json
// loads them on the device, with a stand-in Future.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const MEGA = path.join(__dirname, "../../cloud/mega/service/com.palm.service.mega");
const CORE = path.join(__dirname, "../../cloud/_core/service/_cloudcore");

// Settles like Foundations' Future as far as these files use it: result/exception, then().
class FakeFuture {
	constructor() { this.cbs = []; this.done = false; }
	set result(v) { this._r = v; this.done = true; this.cbs.splice(0).forEach((cb) => cb(this)); }
	get result() { if (this._e) throw this._e; return this._r; }
	setException(e) { this._e = e; this.done = true; this.cbs.splice(0).forEach((cb) => cb(this)); }
	then(scope, fn) { const cb = () => fn.call(scope, this); if (this.done) cb(); else this.cbs.push(cb); return this; }
}

function load(file, extra = {}) {
	const ctx = { IMPORTS: { foundations: { Control: { Future: FakeFuture } } }, Buffer, require, Date, setTimeout, ...extra };
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
	return ctx;
}

const { MegaHashcash } = load(path.join(MEGA, "hashcash.js"));
const TOKEN = crypto.randomBytes(48);
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

test("threshold follows the easiness encoding", () => {
	assert.strictEqual(MegaHashcash.threshold(192), 1 << 24);   // what Mega sent on 2026-10-19
	assert.strictEqual(MegaHashcash.threshold(0), 8);
	assert.strictEqual(MegaHashcash.threshold(63), 127 << 3);
	assert.strictEqual(MegaHashcash.threshold(255), 127 * 2 ** 24);
});

test("challenges that are not version 1 with a 48-byte token are refused", () => {
	assert.ok(MegaHashcash.parse(`1:192:1792400357:${b64url(TOKEN)}`));
	for (const bad of ["", "2:192:1:" + b64url(TOKEN), "1:256:1:" + b64url(TOKEN), "1:x:1:" + b64url(TOKEN),
		"1:192:1:" + b64url(TOKEN.slice(0, 40)), "1:192:" + b64url(TOKEN)]) {
		assert.strictEqual(MegaHashcash.parse(bad), null, bad);
	}
	const f = MegaHashcash.solve("garbage");
	assert.throws(() => f.result, (e) => e.errorCode === "MEGA_HASHCASH");
});

test("the answer satisfies the challenge, checked independently in Python", () => {
	// Easiness 255 makes the threshold ~1/2, so a few tries suffice.
	const tokenStr = b64url(TOKEN);
	const f = MegaHashcash.solve(`1:255:1792400357:${tokenStr}`, { later: (fn) => fn() });
	const answer = f.result;
	const [v, tok, prefix] = answer.split(":");
	assert.strictEqual(v, "1");
	assert.strictEqual(tok, tokenStr);
	const py = `
import base64, hashlib, sys
d = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
token, prefix = d(sys.argv[1]), d(sys.argv[2])
assert len(prefix) == 4 and len(token) == 48
h = hashlib.sha256(prefix + token * 262144).digest()
print(int.from_bytes(h[:4], "big"))`;
	const first = Number(execFileSync("python3", ["-I", "-c", py, tokenStr, prefix]).toString().trim());
	assert.ok(first <= MegaHashcash.threshold(255), `${first} > threshold`);
});

test("the prefix counts up from zero, little-endian with carry", () => {
	const seen = [];
	const hash = (b) => { seen.push(b.readUInt32LE(0)); return Buffer.from(seen.length === 300 ? [0, 0, 0, 0] : [255, 255, 255, 255]); };
	const f = MegaHashcash.solve(`1:192:1:${b64url(TOKEN)}`, { hash, later: (fn) => fn() });
	assert.deepStrictEqual(seen.slice(0, 3), [0, 1, 2]);
	assert.strictEqual(seen[256], 256);   // carried into the second byte
	assert.strictEqual(f.result.split(":")[2], b64url(Buffer.from([43, 1, 0, 0])));   // try 299
});

test("it yields between batches and gives up after its time limit", () => {
	let t = 0, yields = 0;
	const pending = [];
	const f = MegaHashcash.solve(`1:192:1:${b64url(TOKEN)}`, {
		hash: () => Buffer.from([255, 255, 255, 255]),
		now: () => t,
		later: (fn) => { yields++; pending.push(fn); },
	});
	assert.strictEqual(yields, 1, "one batch, then the event loop");
	assert.strictEqual(f.done, false);
	t = 91000;
	pending.shift()();
	assert.throws(() => f.result, (e) => e.errorCode === "MEGA_HASHCASH" && /gave up/.test(e.detail));
});

function curlWith(stdout) {
	const calls = [];
	const cp = { execFile: (bin, args, opts, cb) => { calls.push(args); cb(null, stdout, ""); } };
	const ctx = load(path.join(CORE, "httpcurl.js"), { require: (m) => (m === "child_process" ? cp : require(m)), Config: {}, process: { env: {} } });
	return { HttpCurl: ctx.HttpCurl, calls };
}

test("httpcurl returns the asked-for response header apart from the body", () => {
	const { HttpCurl, calls } = curlWith('{"a":1}\nline two\n1:192:1:abc\n402');
	const r = HttpCurl.request({ url: "https://x", responseHeader: "X-Hashcash" }).result;
	assert.strictEqual(r.status, 402);
	assert.strictEqual(r.header, "1:192:1:abc");
	assert.strictEqual(r.responseText, '{"a":1}\nline two');
	assert.ok(calls[0].includes("\n%header{X-Hashcash}\n%{http_code}"));
});

test("httpcurl without responseHeader is unchanged", () => {
	const { HttpCurl, calls } = curlWith('body\nmore\n200');
	const r = HttpCurl.request({ url: "https://x" }).result;
	assert.deepStrictEqual({ ...r }, { status: 200, responseText: "body\nmore" });
	assert.ok(calls[0].includes("\n%{http_code}"));
	const odd = curlWith("b\n200").HttpCurl.request({ url: "https://x", responseHeader: "X-Bad}" }).result;
	assert.strictEqual(odd.header, undefined, "a name that is not a header name is not asked for");
});

// Foundations' Future (frameworks/foundations/.../control/future.js), a little further: now()
// waits on a future its function returns before the next then(), and nest() takes over another
// future's outcome. Assigning a future to .result does NOT: the future itself becomes the result,
// as in the real setter.
class ChainFuture extends FakeFuture {
	now(scope, fn) { this._wait = fn.call(scope, this); return this; }
	then(scope, fn) {
		const w = this._wait;
		if (w instanceof FakeFuture) { this._wait = null; w.then(null, () => fn.call(scope, this)); return this; }
		return super.then(scope, fn);
	}
	nest(inner) {
		inner.then(null, () => { try { this.result = inner.result; } catch (e) { this.setException(e); } });
		return this;
	}
}

function megaApiWith(replies, solve) {
	const sent = [];
	const settled = (v) => { const f = new ChainFuture(); f.result = v; return f; };
	const ctx = load(path.join(MEGA, "megaapi.js"), {
		IMPORTS: { foundations: { Control: { Future: ChainFuture } } },
		Config: { API_BASE: "https://g.api.mega.co.nz/cs" },
		HttpCurl: { request: (o) => { sent.push(o); return settled(replies.shift()); } },
		MegaCrypto: {},
		MegaHashcash: { solve: (c) => { solve.calls.push(c); return settled(solve.answer); } },
	});
	return { MegaApi: ctx.MegaApi, sent };
}

test("a 402 with a challenge is answered and the request sent again under the same id", () => {
	const solve = { calls: [], answer: "1:tok:AAAAAA" };
	const { MegaApi, sent } = megaApiWith([
		{ status: 402, header: "1:192:1:challenge", responseText: "" },
		{ status: 200, header: "", responseText: '[{"v":1}]' },
	], solve);
	const f = MegaApi.post([{ a: "us" }]);
	assert.strictEqual(JSON.stringify(f.result), "[{\"v\":1}]");   // built in the vm realm
	assert.deepStrictEqual(solve.calls, ["1:192:1:challenge"]);
	assert.strictEqual(sent.length, 2);
	assert.strictEqual(sent[0].headers["X-Hashcash"], undefined);
	assert.strictEqual(sent[1].headers["X-Hashcash"], "1:tok:AAAAAA");
	assert.strictEqual(sent[0].url, sent[1].url, "same ?id=");
	assert.strictEqual(sent[0].responseHeader, "X-Hashcash");
});

test("a 402 without a challenge, or past four rounds, is an HTTP error", () => {
	let { MegaApi } = megaApiWith([{ status: 402, header: "", responseText: "" }], { calls: [], answer: "x" });
	assert.throws(() => MegaApi.post([{ a: "us" }]).result, (e) => e.errorCode === "MEGA_EHTTP_402");
	const busy = Array.from({ length: 6 }, () => ({ status: 402, header: "1:192:1:c", responseText: "" }));
	const solve = { calls: [], answer: "1:t:p" };
	({ MegaApi } = megaApiWith(busy, solve));
	assert.throws(() => MegaApi.post([{ a: "us" }]).result, (e) => e.errorCode === "MEGA_EHTTP_402");
	assert.strictEqual(solve.calls.length, 4);
});

test("a failed proof of work fails the request with MEGA_HASHCASH", () => {
	const failing = new ChainFuture();
	failing.setException({ errorCode: "MEGA_HASHCASH" });
	const ctx = load(path.join(MEGA, "megaapi.js"), {
		IMPORTS: { foundations: { Control: { Future: ChainFuture } } },
		Config: { API_BASE: "https://g.api.mega.co.nz/cs" },
		HttpCurl: { request: () => { const f = new ChainFuture(); f.result = { status: 402, header: "1:192:1:c", responseText: "" }; return f; } },
		MegaCrypto: {},
		MegaHashcash: { solve: () => failing },
	});
	assert.throws(() => ctx.MegaApi.post([{ a: "us" }]).result, (e) => e.errorCode === "MEGA_HASHCASH");
});

test("EAGAIN (-3) is retried and the retry's reply is the result", async () => {
	const { MegaApi, sent } = megaApiWith([
		{ status: 200, header: "", responseText: "-3" },
		{ status: 200, header: "", responseText: '[{"v":2}]' },
	], { calls: [], answer: "" });
	const f = MegaApi.post([{ a: "us0" }]);
	await new Promise((r) => setTimeout(r, 700));   // post() backs off 500 ms before the retry
	assert.strictEqual(sent.length, 2);
	assert.strictEqual(JSON.stringify(f.result), "[{\"v\":2}]");
});

test("httpcurl names a multipart file part when asked, quoted for curl", () => {
	const { HttpCurl, calls } = curlWith("ok\n200");
	HttpCurl.request({ url: "https://x", multipart: [
		{ name: "file", file: "/media/internal/tmp-1.bin", filename: 'my "odd"; file.txt' },
		{ name: "attributes", value: "{}" },
		{ name: "plain", file: "/media/internal/a.txt" },
	] }).result;
	const parts = calls[0].filter((a, i) => calls[0][i - 1] === "-F");
	assert.deepStrictEqual(JSON.parse(JSON.stringify(parts)), ['file=@/media/internal/tmp-1.bin;filename="my \\"odd\\"; file.txt"',
		"attributes={}", "plain=@/media/internal/a.txt"]);
});

test("httpcurl makes a download's missing folders 0755 before curl runs", () => {
	const os = require("node:os");
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "curldirs-"));
	try {
		fs.chmodSync(base, 0o700);
		const { HttpCurl, calls } = curlWith("\n200");
		const out = path.join(base, "a", "b", "file.docx");
		const old = process.umask(0o077);
		try { HttpCurl.request({ url: "https://x", outFile: out }).result; } finally { process.umask(old); }
		for (const d of [path.join(base, "a"), path.join(base, "a", "b")]) {
			assert.strictEqual(fs.statSync(d).mode & 0o777, 0o755, d);
		}
		assert.strictEqual(fs.statSync(base).mode & 0o777, 0o700, "existing folders are left alone");
		assert.ok(calls[0].includes(out));
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});
