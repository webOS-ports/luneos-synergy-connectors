// node --test tests/unit
// _cloudcore/node/http.js against a local HTTP server and Node's real fetch: bodies, errors,
// streaming downloads (0755 folders, no half files), streamed uploads (with their length),
// multipart file names, and the deadlines.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const NODE = path.join(__dirname, "../../cloud/_core/service/_cloudcore/node");
const { createHttp, makeDirs, BODY_MAX } = require(path.join(NODE, "http.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "core-http-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// The server: routes by path; each handler gets (req, res, bodyBuffer).
let server, base;
const seen = [];
const ROUTES = {
	"/echo": (req, res, body) => { res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ method: req.method, headers: req.headers, body: body.toString("utf8") })); },
	"/empty": (req, res) => { res.statusCode = 200; res.end(); },
	"/notjson": (req, res) => res.end("<html>"),
	"/conflict": (req, res) => { res.statusCode = 409; res.end(JSON.stringify({ error_summary: "path/conflict/folder/.." })); },
	"/big-error": (req, res) => { res.statusCode = 500; res.end("x".repeat(10000)); },
	"/notfound": (req, res) => { res.statusCode = 404; res.end("{}"); },
	"/file": (req, res) => { res.end(FILE_BYTES); },
	"/stall-body": (req, res) => { res.writeHead(200, { "Content-Length": "100" }); res.write("half"); },
	"/stall-headers": () => {},
	"/slow-chunks": (req, res) => {
		res.writeHead(200); let n = 0;
		const t = setInterval(() => { res.write("chunk" + n); if (++n === 6) { clearInterval(t); res.end(); } }, 40);
	},
	"/redirect": (req, res) => { res.writeHead(302, { Location: "/echo" }); res.end(); },
};
const FILE_BYTES = crypto.randomBytes(300 * 1024);

test.before(async () => {
	server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const u = new URL(req.url, "http://x");
			seen.push({ path: u.pathname, headers: req.headers, body });
			(ROUTES[u.pathname] || ((q, r) => { r.statusCode = 599; r.end(); }))(req, res, body);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.closeAllConnections(); server.close(); });

const client = (o) => createHttp(Object.assign({ errorCode: "TEST_API_ERROR" }, o || {}));
const last = () => seen[seen.length - 1];

test("connects get 2.5 s per address, not Node's 250 ms (slow Wi-Fi was ETIMEDOUT)", () => {
	assert.ok(require("node:net").getDefaultAutoSelectFamilyAttemptTimeout() >= 2500);
});

test("json: POST a JSON body with bearer and headers; the reply parsed", async () => {
	const r = await client().json({ method: "POST", url: base + "/echo", bearer: "tok", headers: { "X-A": "1" }, json: { a: [1, "é"] } });
	assert.strictEqual(r.method, "POST");
	assert.strictEqual(r.headers.authorization, "Bearer tok");
	assert.strictEqual(r.headers["x-a"], "1");
	assert.strictEqual(r.headers["content-type"], "application/json");
	assert.deepStrictEqual(JSON.parse(r.body), { a: [1, "é"] });
});

test("form: url-encoded, null and undefined fields left out", async () => {
	const r = await client().json({ method: "POST", url: base + "/echo", form: { a: "x y&z", b: null, c: undefined, d: 5 } });
	assert.match(r.headers["content-type"], /^application\/x-www-form-urlencoded/);
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(r.body)), { a: "x y&z", d: "5" });
});

test("an empty reply is {}; one that is not JSON is the provider's error", async () => {
	assert.deepStrictEqual(await client().json({ url: base + "/empty" }), {});
	await assert.rejects(client().json({ url: base + "/notjson" }), (e) => e.errorCode === "TEST_API_ERROR" && /not JSON/.test(e.errorText));
});

test("a reply outside 2xx: HttpError with the provider's errorCode, status, body and errorText", async () => {
	await assert.rejects(client().json({ method: "POST", url: base + "/conflict?access_token=SECRET" }), (e) => {
		assert.strictEqual(e.name, "HttpError");
		assert.strictEqual(e.errorCode, "TEST_API_ERROR");
		assert.strictEqual(e.status, 409);
		assert.deepStrictEqual(JSON.parse(e.body), { error_summary: "path/conflict/folder/.." });
		assert.match(e.errorText, /^POST http:\/\/127\.0\.0\.1:\d+\/conflict -> HTTP 409: /);
		assert.doesNotMatch(e.errorText + e.url, /SECRET/, "no query in the error");
		return true;
	});
	await assert.rejects(client({ describe: (s, b) => "said " + s + " " + JSON.parse(b).error_summary }).json({ url: base + "/conflict" }),
		(e) => e.errorText === "said 409 path/conflict/folder/..");
	await assert.rejects(client().request({ url: base + "/big-error" }), (e) => e.status === 500 && e.body.length === BODY_MAX);
	await assert.rejects(client().request({ url: base + "/notfound", errorCode: "OTHER" }), (e) => e.errorCode === "OTHER");
});

test("accept: a listed status is an answer, not an error", async () => {
	const r = await client().request({ url: base + "/notfound", accept: [404] });
	assert.strictEqual(r.status, 404);
	assert.strictEqual(r.text, "{}");
});

test("redirects are followed", async () => {
	const r = await client().json({ url: base + "/redirect" });
	assert.strictEqual(r.method, "GET");
});

test("toFile: streamed into new folders made 0755, the file 0644, no .part left", async () => {
	const old = process.umask(0o077);
	try {
		const dest = path.join(TMP, "dl", "a", "b", "file.bin");
		const r = await client().request({ method: "POST", url: base + "/file", toFile: dest });
		assert.deepStrictEqual([r.status, r.path, r.bytes], [200, dest, FILE_BYTES.length]);
		assert.ok(fs.readFileSync(dest).equals(FILE_BYTES));
		for (const d of ["dl", "dl/a", "dl/a/b"]) {
			assert.strictEqual(fs.statSync(path.join(TMP, d)).mode & 0o777, 0o755, d);
		}
		assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o644);
		assert.ok(!fs.existsSync(dest + ".part"));
	} finally { process.umask(old); }
});

test("toFile: an error reply is not written as the file, and an old file stays", async () => {
	const dest = path.join(TMP, "dl-err", "x.bin");
	await assert.rejects(client().request({ url: base + "/conflict", toFile: dest }), (e) => e.status === 409);
	assert.ok(!fs.existsSync(dest));
	assert.ok(!fs.existsSync(path.dirname(dest)), "no folder made for an error either");
	fs.mkdirSync(path.dirname(dest));
	fs.writeFileSync(dest, "previous");
	await assert.rejects(client().request({ url: base + "/notfound", toFile: dest }), (e) => e.status === 404);
	assert.strictEqual(fs.readFileSync(dest, "utf8"), "previous");
});

test("toFile: a download that fails half way leaves the file that was there as it was", async () => {
	const dest = path.join(TMP, "dl-keep", "x.bin");
	fs.mkdirSync(path.dirname(dest));
	fs.writeFileSync(dest, "previous");
	await assert.rejects(client({ idleTimeoutMs: 80 }).request({ url: base + "/stall-body", toFile: dest }), (e) => e.errorCode === "CURL_FAILED");
	assert.strictEqual(fs.readFileSync(dest, "utf8"), "previous");
	assert.ok(!fs.existsSync(dest + ".part"));
});

test("toFile: a body that stalls times out (CURL_FAILED) and leaves no file", async () => {
	const dest = path.join(TMP, "dl-stall", "x.bin");
	await assert.rejects(client({ idleTimeoutMs: 80 }).request({ url: base + "/stall-body", toFile: dest }),
		(e) => e.errorCode === "CURL_FAILED" && /timed out/.test(e.errorText));
	assert.ok(!fs.existsSync(dest));
	assert.ok(!fs.existsSync(dest + ".part"));
});

test("the idle deadline is between chunks, not for the whole body", async () => {
	const r = await client({ idleTimeoutMs: 120 }).request({ url: base + "/slow-chunks" });   // 6 x 40 ms: 240 ms in all
	assert.strictEqual(r.text, "chunk0chunk1chunk2chunk3chunk4chunk5");
	await assert.rejects(client({ idleTimeoutMs: 10 }).request({ url: base + "/slow-chunks" }),
		(e) => e.errorCode === "CURL_FAILED" && /without data/.test(e.errorText));
});

test("no headers within timeoutMs: CURL_FAILED, timed out", async () => {
	const t0 = Date.now();
	await assert.rejects(client({ timeoutMs: 80 }).request({ url: base + "/stall-headers" }),
		(e) => e.errorCode === "CURL_FAILED" && /timed out after/.test(e.errorText));
	assert.ok(Date.now() - t0 < 2000);
});

test("nobody listening: CURL_FAILED, network error", async () => {
	const probe = http.createServer();
	await new Promise((r) => probe.listen(0, "127.0.0.1", r));
	const port = probe.address().port;
	await new Promise((r) => probe.close(r));
	await assert.rejects(client().request({ url: "http://127.0.0.1:" + port + "/" }),
		(e) => e.errorCode === "CURL_FAILED" && /network error: ECONNREFUSED/.test(e.errorText));
});

test("file: the local file is the body, sent with its length (not chunked)", async () => {
	const src = path.join(TMP, "up.bin");
	fs.writeFileSync(src, FILE_BYTES);
	await client().request({ method: "POST", url: base + "/echo", file: src, headers: { "Content-Type": "application/octet-stream" } });
	const s = last();
	assert.ok(s.body.equals(FILE_BYTES));
	assert.strictEqual(s.headers["content-length"], String(FILE_BYTES.length));
	assert.strictEqual(s.headers["transfer-encoding"], undefined);
	assert.strictEqual(s.headers["content-type"], "application/octet-stream");
});

test("file: a local file that is not there is LOCAL_FILE_ERROR, and nothing is sent", async () => {
	const n = seen.length;
	await assert.rejects(client().request({ method: "POST", url: base + "/echo", file: path.join(TMP, "missing.bin") }),
		(e) => e.errorCode === "LOCAL_FILE_ERROR" && /ENOENT/.test(e.errorText));
	assert.strictEqual(seen.length, n);
});

test("multipart: value parts and file parts, the file named as given or after the local file", async () => {
	const src = path.join(TMP, "photo.jpg");
	fs.writeFileSync(src, "JPEGDATA");
	await client().request({ method: "POST", url: base + "/echo", multipart: [
		{ name: "attributes", value: JSON.stringify({ name: "Holiday \"1\".jpg" }) },
		{ name: "file", file: src, filename: "Holiday \"1\".jpg" },
		{ name: "other", file: src },
	] });
	const s = last();
	const ct = s.headers["content-type"];
	assert.match(ct, /^multipart\/form-data; boundary=/);
	assert.ok(s.headers["content-length"], "a length, not chunked");
	const text = s.body.toString("utf8");
	assert.match(text, /name="attributes"\r\n\r\n\{"name":"Holiday \\"1\\".jpg"\}/);
	assert.match(text, /name="file"; filename="Holiday %221%22.jpg"/);
	assert.match(text, /name="other"; filename="photo.jpg"/);
	assert.strictEqual(text.split("JPEGDATA").length - 1, 2);
});

test("a header value HTTP cannot carry is BAD_ARGS, before anything is sent", async () => {
	const n = seen.length;
	await assert.rejects(client().request({ url: base + "/echo", headers: { "X-Name": "日本" } }), (e) => e.errorCode === "BAD_ARGS");
	await assert.rejects(client().request({ url: base + "/echo", headers: { "X-Arg": "a\r\nX-Evil: 1" } }), (e) => e.errorCode === "BAD_ARGS");
	assert.strictEqual(seen.length, n);
});

test("makeDirs: only what it makes is chmod'ed, an existing folder is left as it is", () => {
	const keep = path.join(TMP, "keep");
	fs.mkdirSync(keep, { mode: 0o700 });
	fs.chmodSync(keep, 0o700);
	makeDirs(path.join(keep, "new", "deeper"));
	assert.strictEqual(fs.statSync(keep).mode & 0o777, 0o700);
	assert.strictEqual(fs.statSync(path.join(keep, "new")).mode & 0o777, 0o755);
	assert.strictEqual(fs.statSync(path.join(keep, "new", "deeper")).mode & 0o777, 0o755);
	makeDirs(path.join(keep, "new"));   // there already: nothing to do
});
