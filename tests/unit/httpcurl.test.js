// node --test tests/unit
// _cloudcore's httpcurl.js (the curl transport of the connectors not yet on _cloudcore/node):
// the response-header option, multipart file names and download folders. Moved here from
// megahashcash.test.js when MEGA left httpcurl for _cloudcore/node; the tests are unchanged.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CORE = path.join(__dirname, "../../cloud/_core/service/_cloudcore");

// Settles like Foundations' Future as far as httpcurl.js uses it: result/exception, then().
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
