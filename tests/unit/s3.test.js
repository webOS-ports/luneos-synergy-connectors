// node --test tests/unit
// The S3 connector (cloud/s3/service/com.palm.service.s3) as the launcher runs it: service.js
// started on a stand-in palmbus, with a stand-in fetch that plays an S3 bucket (list with prefix,
// delimiter and continuation, GET, PUT, CopyObject, DELETE, DeleteObjects) and records every
// request. Each method is called over the bus as its real caller would call it, and checked for
// the requests it makes, its reply and its errors. Every signature is checked with an independent
// SigV4 computation below, from what was actually sent, not with s3sig.js.
//
// The last part fails every request of every method in turn, in each way a request can fail,
// and checks the method still answers exactly once, with an error.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fakePalmbus, fakeFetch, ask, json } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/s3/service/com.palm.service.s3");
const service = require(SVC);   // through package.json "main", as the launcher does
const sig = require(path.join(SVC, "s3sig.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "s3-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const SECRET = "unit-test-secret-not-a-credential";
const CREDS = { accessToken: "AKIDUNITTEST", secretAccessKey: SECRET, endpoint: "s3.example.test",
	region: "eu-test-1", bucket: "bkt", pathStyle: true };
const EMPTY_SHA = crypto.createHash("sha256").update("").digest("hex");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// --- an S3 bucket ------------------------------------------------------------------------------

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const listXml = (items, token) => "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">" +
	items.filter((i) => i.key !== undefined).map((i) => `<Contents><Key>${xmlEsc(i.key)}</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified>` +
		`<ETag>"e"</ETag><Size>${i.size}</Size></Contents>`).join("") +
	items.filter((i) => i.prefix !== undefined).map((i) => `<CommonPrefixes><Prefix>${xmlEsc(i.prefix)}</Prefix></CommonPrefixes>`).join("") +
	`<IsTruncated>${token ? "true" : "false"}</IsTruncated>` +
	(token ? `<NextContinuationToken>${token}</NextContinuationToken>` : "") + "</ListBucketResult>";
const COPY_OK = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><CopyObjectResult><LastModified>2026-10-19T12:00:00.000Z</LastModified><ETag>\"e\"</ETag></CopyObjectResult>";
const DELETE_OK = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"></DeleteResult>";
const s3Error = (code) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code} happened</Message></Error>`;
const xmlReply = (status, body) => ({ status, body, headers: { "content-type": "application/xml" } });

const urlOf = (req) => new URL(req.url);
// The object key a request addresses (path style: /bkt/<key>; virtual host: /<key>).
const keyOf = (req) => { const u = urlOf(req); const p = decodeURIComponent(u.pathname); return u.host.startsWith("bkt.") ? p.slice(1) : p.replace(/^\/bkt\/?/, ""); };
const queryOf = (req) => Object.fromEntries(urlOf(req).searchParams);
const isList = (r) => r.method === "GET" && queryOf(r)["list-type"] === "2";
const describeReq = (r) => r.method + " " + (isList(r) ? "list " + (queryOf(r).prefix || "") : keyOf(r));

// objects: { key: size | Buffer }. Hooks copy/del/multi/put(req, ...) may answer instead.
function bucket(objects = {}, { page = 1000, copy, del, multi, put } = {}) {
	const store = new Map(Object.entries(objects).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.alloc(v)]));
	function list(req) {
		const q = queryOf(req), prefix = q.prefix || "", delim = q.delimiter;
		const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
		let items = all.map((key) => ({ key, size: store.get(key).length }));
		if (delim) {
			const seen = new Set();
			items = [];
			for (const key of all) {
				const i = key.slice(prefix.length).indexOf(delim);
				if (i < 0) { items.push({ key, size: store.get(key).length }); continue; }
				const p = prefix + key.slice(prefix.length, prefix.length + i + 1);
				if (!seen.has(p)) { seen.add(p); items.push({ prefix: p }); }
			}
		}
		const start = q["continuation-token"] ? Number(q["continuation-token"]) : 0;
		const n = Math.min(page, q["max-keys"] === undefined ? 1000 : Number(q["max-keys"]));
		const chunk = items.slice(start, start + n);
		const more = n > 0 && start + n < items.length;
		return xmlReply(200, listXml(chunk, more ? String(start + n) : null));
	}
	function reply(req) {
		if (isList(req)) { return list(req); }
		const key = keyOf(req);
		if (req.method === "GET") {
			return store.has(key) ? new Response(store.get(key), { status: 200 }) : xmlReply(404, s3Error("NoSuchKey"));
		}
		if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
			const src = decodeURIComponent(req.headers["x-amz-copy-source"]).replace(/^bkt\//, "");
			const r = copy && copy(req, src);
			if (r) { return r; }
			if (!store.has(src)) { return xmlReply(404, s3Error("NoSuchKey")); }
			store.set(key, store.get(src));
			return xmlReply(200, COPY_OK);
		}
		if (req.method === "PUT") {
			const r = put && put(req);
			if (r) { return r; }
			const b = req.body;
			store.set(key, b && b.blob !== undefined ? Buffer.alloc(b.blob) : Buffer.from(b || ""));
			return { status: 200, body: "" };
		}
		if (req.method === "DELETE") {
			const r = del && del(req);
			if (r) { return r; }
			store.delete(key);
			return { status: 204 };
		}
		if (req.method === "POST" && "delete" in queryOf(req)) {
			const keys = [...req.body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1]
				.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
			const r = multi && multi(req, keys);
			if (r) { return r; }
			keys.forEach((k) => store.delete(k));
			return xmlReply(200, DELETE_OK);
		}
		return { status: 599, body: "unexpected " + req.method + " " + req.url };
	}
	return { store, reply, keys: () => [...store.keys()].sort() };
}

const routesFor = (reply) => ["GET", "PUT", "POST", "DELETE", "HEAD"].map((m) => [m, /./, reply]);

// The service on a stand-in bus. Accounts: readCredentials gives `stored`.
function start(reply, { stored = CREDS, onCall, timeouts } = {}) {
	const f = fakeFetch(routesFor(reply));
	const pb = fakePalmbus({ onCall: onCall || ((uri) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: { common: Object.assign({}, stored) } } : { returnValue: true }; }
		if (/writeCredentials$/.test(uri)) { return { returnValue: true }; }
		return { returnValue: false, errorCode: -1, errorText: "Unknown service" };
	}) });
	const s = service.start({ palmbus: pb, fetch: f.fetch, idleMs: 0, exit: () => {}, log: { log() {}, error() {} }, timeouts });
	const handle = pb.handles[0];
	return { s, handle, adapter: s.adapter, requests: f.requests,
		call: (method, payload, caller = DOCS) => ask(handle, method, payload, caller) };
}

// --- independent SigV4 checks ------------------------------------------------------------------

const hm = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const keyFor = (secret, date, region) => hm(hm(hm(hm("AWS4" + secret, date), region), "s3"), "aws4_request");

// Rebuild the canonical request from what was sent - the URL as on the wire, the host fetch
// sends for it (the URL's), every header passed - and check the Authorization signature.
// -> the signed header names
function verifySig(req, secret = SECRET) {
	const auth = req.headers.Authorization;
	const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
	assert.ok(m, "Authorization header shape: " + auth);
	const [, , date, region, signedHeaders, signature] = m;
	const u = urlOf(req);
	const hdr = { host: u.host };
	for (const k of Object.keys(req.headers)) { if (k !== "Authorization") { hdr[k.toLowerCase()] = String(req.headers[k]).trim(); } }
	const names = signedHeaders.split(";");
	assert.deepStrictEqual(names, Object.keys(hdr).sort(), "every header sent, and the host, is signed");
	assert.ok(!("host" in req.headers) && !("Host" in req.headers), "no Host header is passed (fetch sends the URL's)");
	const query = u.search.replace(/^\?/, "").split("&").filter(Boolean).sort().join("&");
	const canon = [req.method, u.pathname, query, names.map((n) => n + ":" + hdr[n] + "\n").join(""),
		signedHeaders, hdr["x-amz-content-sha256"]].join("\n");
	assert.strictEqual(hdr["x-amz-date"].slice(0, 8), date);
	const sts = ["AWS4-HMAC-SHA256", hdr["x-amz-date"], `${date}/${region}/s3/aws4_request`, sha(canon)].join("\n");
	assert.strictEqual(crypto.createHmac("sha256", keyFor(secret, date, region)).update(sts).digest("hex"), signature, "signature verifies");
	return names;
}

// A presigned URL: X-Amz-* in the query, only the host signed, UNSIGNED-PAYLOAD.
function verifyPresigned(link, secret = SECRET) {
	const u = new URL(link);
	const q = Object.fromEntries(u.searchParams);
	const [, date, region] = /^[^/]+\/(\d{8})\/([^/]+)\/s3\/aws4_request$/.exec(q["X-Amz-Credential"]);
	assert.strictEqual(q["X-Amz-SignedHeaders"], "host");
	const query = u.search.replace(/^\?/, "").split("&").filter((p) => !p.startsWith("X-Amz-Signature=")).sort().join("&");
	const canon = ["GET", u.pathname, query, "host:" + u.host + "\n", "host", "UNSIGNED-PAYLOAD"].join("\n");
	const sts = ["AWS4-HMAC-SHA256", q["X-Amz-Date"], `${date}/${region}/s3/aws4_request`, sha(canon)].join("\n");
	assert.strictEqual(crypto.createHmac("sha256", keyFor(secret, date, region)).update(sts).digest("hex"), q["X-Amz-Signature"]);
	return q;
}

// --- the service -------------------------------------------------------------------------------

test("the service: its bus name, the old services.json's methods plus the core's, and the package layout", () => {
	const { handle } = start(bucket().reply);
	assert.strictEqual(handle.name, "com.palm.service.s3");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem",
		"deletePhoto", "downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos",
		"login", "moveItem", "quit", "upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	assert.deepStrictEqual(fs.readdirSync(SVC).sort(), ["adapter.js", "config.js", "login.js", "package.json", "photos.js", "s3sig.js", "service.js"]);
});

test("config.js keeps its keys", () => {
	const Config = require(path.join(SVC, "config.js")).Config;
	assert.deepStrictEqual(Object.keys(Config), ["CURL", "CURL_LD_LIBRARY_PATH", "CURL_CAINFO", "ROOT_FOLDER", "LIST_LIMIT",
		"PHOTO_ALBUM_NAME", "PROVIDER_PRESETS", "DEFAULT_REGION", "SERVICE_NAME", "DISPLAY_NAME", "STATE", "AUTH_APP_IDS", "FILE_APP_IDS"]);
});

test("caller rules: file methods for the FILE_APP_IDS; login, checkCredentials and photo methods open; no OAuth", async () => {
	const { call } = start(bucket({ "a.txt": 1 }).reply);
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.s3-auth" }, PHOTOS, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", path: "a.txt", name: "b", localPath: LOCAL, fileId: "a.txt" }, who);
			assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m + " " + JSON.stringify(who));
		}
	}
	for (const who of [DOCS, { appId: "org.webosports.app.documents-77" }, { service: "com.palm.stark.files.service" }]) {
		assert.strictEqual((await call("listFolder", { accountId: "acc" }, who)).returnValue, true, JSON.stringify(who));
	}
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: "x" }, {})).returnValue, true);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS)).returnValue, true);
	assert.strictEqual((await call("login", { endpoint: "s3.example.test", bucket: "bkt", accessKeyId: "k", secretAccessKey: SECRET },
		{ appId: "com.palm.app.accounts 99" })).returnValue, true);
	for (const m of ["getAuthorizeUrl", "exchangeCode"]) {
		assert.strictEqual((await call(m, { code: "c" }, {})).errorCode, "NOT_SUPPORTED", m);
	}
});

// --- SigV4 ---------------------------------------------------------------------------------------

test("s3sig matches AWS's published SigV4 examples (GET Object, presigned GET)", () => {
	// docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html and
	// sigv4-query-string-auth.html: the example keys, 2013-05-24, us-east-1.
	const keys = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		region: "us-east-1", date: new Date(Date.UTC(2013, 4, 24)) };
	const r = sig.signRequest(Object.assign({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "test.txt",
		headers: { range: "bytes=0-9" } }, keys));
	assert.strictEqual(r.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
	assert.strictEqual(r.url, "https://examplebucket.s3.amazonaws.com/test.txt");
	const link = sig.presignUrl(Object.assign({ host: "examplebucket.s3.amazonaws.com", path: "test.txt", expires: 86400 }, keys));
	assert.strictEqual(new URL(link).searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});

test("s3sig: RFC 3986 encoding, the host as fetch sends it", () => {
	assert.strictEqual(sig.uriEncode("a b/ü~*'()!+=&", false), "a%20b/%C3%BC~%2A%27%28%29%21%2B%3D%26");
	assert.strictEqual(sig.uriEncode("a/b", true), "a%2Fb");
	assert.strictEqual(sig.hostOf("S3.Example.TEST:443"), "s3.example.test");
	assert.strictEqual(sig.hostOf("nas.local:80", "http"), "nas.local");
	assert.strictEqual(sig.hostOf("127.0.0.1:3900", "http"), "127.0.0.1:3900");
	assert.strictEqual(sig.hostOf("s3.example.test:8443"), "s3.example.test:8443");
});

// --- the methods ---------------------------------------------------------------------------------

test("listFolder: a signed ListObjectsV2 with prefix and delimiter, every page; entries as before", async () => {
	const b = bucket({ "Docs/": 0, "Docs/a.pdf": 12, "Docs/Sub/x": 1, "Docs/z.JPG": 2, "Other": 1 }, { page: 2 });
	const { call, requests } = start(b.reply);
	const r = await call("listFolder", { accountId: "acc", path: "Docs" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entries: [
		{ id: "Docs/Sub/", type: "folder", name: "Sub", size: 0, modified: 0, path: "Docs/Sub/", mimeType: "application/x-directory" },
		{ id: "Docs/a.pdf", type: "file", name: "a.pdf", size: 12, modified: Date.parse("2026-10-01T10:00:00.000Z"), path: "Docs/a.pdf", mimeType: "application/pdf" },
		{ id: "Docs/z.JPG", type: "file", name: "z.JPG", size: 2, modified: Date.parse("2026-10-01T10:00:00.000Z"), path: "Docs/z.JPG", mimeType: "image/jpeg" },
	] }, "the folder's own marker is left out");
	assert.deepStrictEqual(requests.map((q) => q.url), [
		"https://s3.example.test/bkt/?delimiter=%2F&list-type=2&max-keys=1000&prefix=Docs%2F",
		"https://s3.example.test/bkt/?continuation-token=2&delimiter=%2F&list-type=2&max-keys=1000&prefix=Docs%2F"]);
	for (const q of requests) {
		assert.strictEqual(q.method, "GET");
		assert.strictEqual(q.body, undefined);
		assert.strictEqual(q.headers["x-amz-content-sha256"], EMPTY_SHA);
		assert.deepStrictEqual(verifySig(q), ["host", "x-amz-content-sha256", "x-amz-date"]);
	}
	for (const root of [{}, { path: "" }, { folderId: "root" }]) {
		await call("listFolder", Object.assign({ accountId: "acc" }, root));
		assert.strictEqual(queryOf(requests[requests.length - 1]).prefix, "", JSON.stringify(root));
	}
});

test("listFolder: inline credentials; a 403 is S3_LIST_FAILED with S3's code; a 200 that is no listing is an error", async () => {
	const ok = start(bucket({ "a": 1 }).reply, { stored: null });
	assert.strictEqual((await ok.call("listFolder", { credentials: { common: CREDS } })).entries.length, 1);
	assert.strictEqual(ok.handle.calls.length, 0);
	const denied = start(() => xmlReply(403, s3Error("AccessDenied")));
	assert.deepStrictEqual(await denied.call("listFolder", { accountId: "acc" }), { returnValue: false, errorCode: "S3_LIST_FAILED",
		errorText: "S3 answered HTTP 403: AccessDenied (AccessDenied happened)", status: 403 });
	const html = start(() => ({ status: 200, body: "<html>portal</html>" }));
	assert.strictEqual((await html.call("listFolder", { accountId: "acc" })).errorCode, "S3_LIST_FAILED");
});

test("credentials: readCredentials name common; missing fields are MISSING_CREDENTIALS with no request", async () => {
	const { call, handle, requests } = start(bucket().reply);
	await call("listFolder", { accountId: "acc-1" });
	assert.deepStrictEqual(handle.calls, [{ uri: "luna://com.palm.service.accounts/readCredentials", args: { accountId: "acc-1", name: "common" } }]);
	for (const missing of ["secretAccessKey", "endpoint", "bucket"]) {
		const c = Object.assign({}, CREDS);
		delete c[missing];
		const t = start(bucket().reply, { stored: c });
		assert.strictEqual((await t.call("listFolder", { accountId: "acc" })).errorCode, "MISSING_CREDENTIALS", missing);
		assert.strictEqual(t.requests.length, 0);
	}
	const bad = start(bucket().reply, { stored: Object.assign({}, CREDS, { endpoint: "a b" }) });
	assert.strictEqual((await bad.call("listFolder", { accountId: "acc" })).errorCode, "BAD_ARGS");
	assert.strictEqual((await start(bucket().reply, { stored: null }).call("listFolder", { accountId: "acc" })).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual(requests.length, 1);
});

test("downloadFile: a signed GET of the key, the bytes to localPath (folders 0755); a 404 writes nothing", async () => {
	const BYTES = crypto.randomBytes(70000);
	const b = bucket({ "Docs/Café ü.pdf": BYTES });
	const { call, requests } = start(b.reply);
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { accountId: "acc", fileId: "Docs/Café ü.pdf", localPath: dest }),
		{ returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.strictEqual(requests[0].url, "https://s3.example.test/bkt/Docs/Caf%C3%A9%20%C3%BC.pdf");
	assert.strictEqual(requests[0].body, undefined);
	verifySig(requests[0]);
	const gone = dl();
	const r = await call("downloadFile", { accountId: "acc", path: "nope.pdf", localPath: gone });
	assert.deepStrictEqual([r.errorCode, r.status], ["S3_DOWNLOAD_FAILED", 404]);
	assert.match(r.errorText, /NoSuchKey/);
	assert.ok(!fs.existsSync(gone));
});

test("uploadFile: a PUT of <folder>/<name> streaming the file, UNSIGNED-PAYLOAD over https, its length and type signed", async () => {
	const b = bucket();
	const { call, requests } = start(b.reply);
	const r = await call("uploadFile", { accountId: "acc", path: "Docs", localPath: LOCAL, name: "Notes é.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Notes é.txt", id: "Docs/Notes é.txt", size: 5000 });
	const q = requests[0];
	assert.strictEqual(q.method, "PUT");
	assert.strictEqual(q.url, "https://s3.example.test/bkt/Docs/Notes%20%C3%A9.txt");
	assert.strictEqual(q.body.blob, LOCAL_BYTES.length, "a Blob of the file, streamed by fetch");
	assert.strictEqual(q.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
	assert.deepStrictEqual(verifySig(q), ["content-length", "content-type", "host", "x-amz-content-sha256", "x-amz-date"]);
	assert.strictEqual(q.headers["content-length"], "5000");
	assert.strictEqual(q.headers["content-type"], "text/plain");
	// the root, the local name by default, no type
	await call("uploadFile", { accountId: "acc", folderId: "root", localPath: LOCAL });
	await call("uploadFile", { accountId: "acc", path: "Docs/", localPath: LOCAL, name: "c.txt" });
	assert.deepStrictEqual(requests.slice(1).map(keyOf), ["local.bin", "Docs/c.txt"]);
	assert.strictEqual(requests[1].headers["content-type"], undefined);
	assert.deepStrictEqual(b.keys(), ["Docs/Notes é.txt", "Docs/c.txt", "local.bin"]);
});

test("uploadFile replace:true is a PUT at the file's own key; a missing local file is LOCAL_FILE_ERROR with no request", async () => {
	const { call, requests } = start(bucket({ "Docs/r.pdf": 9 }).reply);
	const r = await call("uploadFile", { accountId: "acc", fileId: "Docs/r.pdf", localPath: LOCAL, replace: true });
	assert.deepStrictEqual([r.id, r.name, r.size], ["Docs/r.pdf", "r.pdf", 5000]);
	assert.strictEqual(keyOf(requests[0]), "Docs/r.pdf");
	assert.strictEqual((await call("uploadFile", { accountId: "acc", localPath: path.join(TMP, "nope.bin") })).errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual((await call("uploadFile", { accountId: "acc", localPath: TMP })).errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual(requests.length, 1);
});

test("an http:// endpoint with a port: called over http, host:port signed, the upload's SHA-256 signed", async () => {
	const text = path.join(TMP, "text.txt");
	fs.writeFileSync(text, "hello over plain http\n");
	const creds = Object.assign({}, CREDS, { endpoint: "127.0.0.1:3900", scheme: "http" });
	const { call, requests } = start(bucket({ "a.txt": 1 }).reply, { stored: creds });
	await call("listFolder", { accountId: "acc" });
	await call("uploadFile", { accountId: "acc", localPath: text });
	const u = urlOf(requests[0]);
	assert.deepStrictEqual([u.protocol, u.host], ["http:", "127.0.0.1:3900"]);
	verifySig(requests[0]);
	assert.strictEqual(requests[1].url, "http://127.0.0.1:3900/bkt/text.txt");
	assert.strictEqual(requests[1].headers["x-amz-content-sha256"], sha(fs.readFileSync(text)));
	verifySig(requests[1]);
	// https, with a default port given and capitals: signed as fetch sends it
	const t2 = start(bucket().reply, { stored: Object.assign({}, CREDS, { endpoint: "S3.Example.test:443" }) });
	await t2.call("listFolder", { accountId: "acc" });
	assert.strictEqual(urlOf(t2.requests[0]).origin, "https://s3.example.test");
	verifySig(t2.requests[0]);
	// virtual-host style
	const t3 = start(bucket({ "a.txt": 1 }).reply, { stored: Object.assign({}, CREDS, { pathStyle: false }) });
	await t3.call("downloadFile", { accountId: "acc", fileId: "a.txt", localPath: dl() });
	assert.strictEqual(t3.requests[0].url, "https://bkt.s3.example.test/a.txt");
	verifySig(t3.requests[0]);
});

test("createFolder: a signed, empty <parent><name>/ marker; the root; a bad name; a failed PUT", async () => {
	const b = bucket();
	const { call, requests } = start(b.reply);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", path: "Docs/", name: "New" }), { returnValue: true,
		renewedCredentials: null, entry: { id: "Docs/New/", type: "folder", name: "New", size: 0, modified: 0, path: "Docs/New/", mimeType: "application/x-directory" } });
	const q = requests[0];
	assert.strictEqual(q.method, "PUT");
	assert.strictEqual(q.url, "https://s3.example.test/bkt/Docs/New/");
	assert.strictEqual(q.body, undefined, "no body, so no text/plain type");
	assert.strictEqual(q.headers["content-length"], "0");
	assert.strictEqual(q.headers["x-amz-content-sha256"], EMPTY_SHA);
	verifySig(q);
	await call("createFolder", { accountId: "acc", folderId: "root", name: "Top" });
	await call("createFolder", { accountId: "acc", path: "Docs", name: "X y" });
	assert.deepStrictEqual(requests.slice(1).map((r) => r.url), ["https://s3.example.test/bkt/Top/", "https://s3.example.test/bkt/Docs/X%20y/"]);
	assert.strictEqual((await call("createFolder", { accountId: "acc", name: "a/b" })).errorCode, "MISSING_ARGS");
	assert.strictEqual(requests.length, 3);
	const denied = start(() => xmlReply(403, s3Error("AccessDenied")));
	const e = await denied.call("createFolder", { accountId: "acc", name: "ok" });
	assert.deepStrictEqual([e.errorCode, e.status], ["S3_MKDIR_FAILED", 403]);
	assert.match(e.errorText, /AccessDenied/);
});

test("renaming a file: look up, check the target is free, copy (signed copy-source), then delete", async () => {
	const b = bucket({ "Docs/a b ü.txt": 7, "Docs/a b üx.txt": 1 });
	const { call, requests } = start(b.reply);
	const r = await call("moveItem", { accountId: "acc", path: "Docs/a b ü.txt", name: "c&d.txt" });
	assert.deepStrictEqual(r.entry, { id: "Docs/c&d.txt", type: "file", name: "c&d.txt", size: 7,
		modified: Date.parse("2026-10-19T12:00:00.000Z"), path: "Docs/c&d.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(requests.map(describeReq), ["GET list Docs/a b ü.txt", "GET list Docs/c&d.txt", "PUT Docs/c&d.txt", "DELETE Docs/a b ü.txt"]);
	assert.strictEqual(queryOf(requests[0])["max-keys"], "1");
	const copy = requests[2];
	assert.strictEqual(copy.headers["x-amz-copy-source"], "bkt/Docs/a%20b%20%C3%BC.txt");
	assert.strictEqual(copy.url, "https://s3.example.test/bkt/Docs/c%26d.txt");
	assert.strictEqual(copy.headers["content-length"], "0");
	assert.ok(verifySig(copy).includes("x-amz-copy-source"), "copy source is a signed header");
	verifySig(requests[3]);
	assert.deepStrictEqual(b.keys(), ["Docs/a b üx.txt", "Docs/c&d.txt"]);
});

test("moving a file keeps its name; move and rename together; to the root", async () => {
	const b = bucket({ "Docs/a.txt": 1, "Docs/b.txt": 2, "c.txt": 3 });
	const { call } = start(b.reply);
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "Docs/a.txt", toPath: "Archive/" })).entry.path, "Archive/a.txt");
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "Docs/b.txt", toPath: "Archive", name: "z.txt" })).entry.path, "Archive/z.txt");
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "Archive/z.txt", toRoot: true })).entry.path, "z.txt");
	assert.strictEqual((await call("moveItem", { accountId: "acc", fileId: "c.txt", name: "d.txt" })).entry.path, "d.txt");
	assert.deepStrictEqual(b.keys(), ["Archive/a.txt", "d.txt", "z.txt"]);
});

test("a failed copy, or a 200 carrying an <Error> or no <CopyObjectResult>, deletes nothing", async () => {
	for (const bad of [xmlReply(403, s3Error("AccessDenied")), xmlReply(200, s3Error("InternalError")), { status: 200, body: "" }]) {
		const b = bucket({ "a.txt": 1 }, { copy: () => bad });
		const { call, requests } = start(b.reply);
		const e = await call("moveItem", { accountId: "acc", path: "a.txt", name: "b.txt" });
		assert.strictEqual(e.errorCode, "S3_COPY_FAILED", bad.body);
		assert.ok(!requests.some((r) => r.method === "DELETE" || r.method === "POST"), "no delete after a failed copy");
		assert.deepStrictEqual(b.keys(), ["a.txt"]);
	}
});

test("a delete that fails after the copy is S3_MOVE_INCOMPLETE", async () => {
	const b = bucket({ "a.txt": 1 }, { del: () => xmlReply(403, s3Error("AccessDenied")) });
	const e = await start(b.reply).call("moveItem", { accountId: "acc", path: "a.txt", name: "b.txt" });
	assert.deepStrictEqual([e.errorCode, e.status], ["S3_MOVE_INCOMPLETE", 403]);
	assert.match(e.errorText, /copied to b\.txt but the original could not be deleted/);
	assert.deepStrictEqual(b.keys(), ["a.txt", "b.txt"]);
});

test("moving a file onto an existing key, a missing key, or one over 5 GB is refused untouched", async () => {
	const b = bucket({ "a.txt": 1, "b.txt": 2 });
	const { call, requests } = start(b.reply);
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "a.txt", name: "b.txt" })).errorCode, "S3_DESTINATION_EXISTS");
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "nope.txt", name: "c.txt" })).errorCode, "S3_NOT_FOUND");
	assert.ok(requests.every(isList));
	// sizes from the listing: 5 GB copies, one byte more does not
	const big = (size) => xmlReply(200, listXml([{ key: "big.iso", size }]));
	for (const [size, want] of [[5 * 1024 ** 3 + 1, "S3_TOO_LARGE_TO_COPY"], [5 * 1024 ** 3, true]]) {
		const store = bucket({ "big.iso": 1 });
		const t = start((req) => (isList(req) ? (queryOf(req).prefix === "big.iso" ? big(size) : xmlReply(200, listXml([]))) : store.reply(req)));
		const r = await t.call("moveItem", { accountId: "acc", path: "big.iso", toPath: "x/" });
		assert.strictEqual(r.errorCode || r.returnValue, want);
		if (want !== true) { assert.ok(t.requests.every(isList)); }
	}
});

test("moving a file to where it already is changes nothing", async () => {
	const b = bucket({ "Docs/a.txt": 1 });
	const { call, requests } = start(b.reply);
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "Docs/a.txt", toPath: "Docs/", name: "a.txt" })).entry.path, "Docs/a.txt");
	assert.ok(requests.every(isList));
	assert.deepStrictEqual(b.keys(), ["Docs/a.txt"]);
});

test("moving a folder pages through its keys, copies them all, then deletes the originals in one batch", async () => {
	const b = bucket({ "A/": 0, "A/1.txt": 1, "A/sub/2.txt": 2, "A/sub/<3>.txt": 3, "AB/x": 9 }, { page: 2 });
	const { call, requests } = start(b.reply);
	const r = await call("moveItem", { accountId: "acc", path: "A/", toPath: "Dest/", name: "B" });
	assert.deepStrictEqual(r.entry, { id: "Dest/B/", type: "folder", name: "B", size: 0, modified: 0, path: "Dest/B/", mimeType: "application/x-directory" });
	const lists = requests.filter((q) => isList(q) && queryOf(q).prefix === "A/");
	assert.strictEqual(lists.length, 2, "two pages");
	assert.strictEqual(queryOf(lists[1])["continuation-token"], "2");
	assert.strictEqual(queryOf(lists[0]).delimiter, undefined, "the whole subtree, not one level");
	assert.strictEqual(queryOf(lists[0])["max-keys"], "26", "one past the bound");
	const writes = requests.filter((q) => !isList(q));
	assert.deepStrictEqual(writes.map(describeReq), ["PUT Dest/B/", "PUT Dest/B/1.txt", "PUT Dest/B/sub/2.txt", "PUT Dest/B/sub/<3>.txt", "POST "]);
	const post = writes[4];
	assert.strictEqual(post.url, "https://s3.example.test/bkt/?delete=");
	assert.strictEqual(post.headers["content-md5"], crypto.createHash("md5").update(post.body).digest("base64"));
	assert.strictEqual(post.headers["x-amz-content-sha256"], sha(post.body));
	assert.strictEqual(post.headers["content-length"], String(Buffer.byteLength(post.body)));
	assert.strictEqual(post.headers["content-type"], "application/xml");
	assert.match(post.body, /<Quiet>true<\/Quiet>/);
	assert.match(post.body, /<Key>A\/sub\/&lt;3&gt;\.txt<\/Key>/);
	assert.deepStrictEqual(verifySig(post), ["content-length", "content-md5", "content-type", "host", "x-amz-content-sha256", "x-amz-date"]);
	assert.deepStrictEqual(b.keys(), ["AB/x", "Dest/B/", "Dest/B/1.txt", "Dest/B/sub/2.txt", "Dest/B/sub/<3>.txt"]);
	// every copy came before the delete
	assert.ok(requests.findIndex((q) => q.method === "POST") > requests.map((q) => q.method).lastIndexOf("PUT"));
});

test("renaming a folder in place, and moving it under the root keeping its name", async () => {
	const b = bucket({ "P/A/": 0, "P/A/f": 1 });
	const { call } = start(b.reply);
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "P/A/", name: "C" })).entry.path, "P/C/");
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "P/C/", toRoot: true })).entry.path, "C/");
	assert.deepStrictEqual(b.keys(), ["C/", "C/f"]);
});

test("a folder copy failing part-way keeps every original and removes the copies made", async () => {
	const b = bucket({ "A/1": 1, "A/2": 2, "A/3": 3 }, { copy: (req, src) => (src === "A/3" ? xmlReply(200, s3Error("SlowDown")) : null) });
	const { call, requests } = start(b.reply);
	const e = await call("moveItem", { accountId: "acc", path: "A/", toPath: "B/" });
	assert.strictEqual(e.errorCode, "S3_COPY_FAILED");
	assert.match(e.errorText, /SlowDown.*2 of 3 copied, the copies were removed/);
	const posts = requests.filter((r) => r.method === "POST");
	assert.strictEqual(posts.length, 1);
	assert.ok(!/<Key>A\//.test(posts[0].body), "no original is in the cleanup batch");
	assert.deepStrictEqual(b.keys(), ["A/1", "A/2", "A/3"]);
	// a cleanup that fails too says so
	const b2 = bucket({ "A/1": 1, "A/2": 2 }, { copy: (req, src) => (src === "A/2" ? xmlReply(500, s3Error("InternalError")) : null),
		multi: () => xmlReply(500, s3Error("InternalError")) });
	const e2 = await start(b2.reply).call("moveItem", { accountId: "acc", path: "A/", toPath: "B/" });
	assert.deepStrictEqual([e2.errorCode, e2.status], ["S3_COPY_FAILED", 500]);
	assert.match(e2.errorText, /1 of 2 copied, the copies could not all be removed/);
});

test("moving a folder: over the bound, onto an existing folder, into itself, a missing one or the root is refused untouched", async () => {
	const many = {};
	for (let i = 0; i < 26; i++) { many["A/" + i] = 1; }
	let t = start(bucket(many, { page: 10 }).reply);
	const e = await t.call("moveItem", { accountId: "acc", path: "A/", toPath: "B/" });
	assert.strictEqual(e.errorCode, "S3_TOO_MANY_KEYS");
	assert.match(e.errorText, /more than 25 objects under A\//);
	assert.ok(t.requests.every(isList));
	assert.strictEqual(queryOf(t.requests[0])["max-keys"], "26", "asks for one past the bound, no more");
	delete many["A/25"];
	t = start(bucket(many, { page: 10 }).reply);
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", path: "A/", toPath: "B/" })).entry.path, "B/A/");

	t = start(bucket({ "A/1": 1, "B/A/x": 1 }).reply);
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", path: "A/", toPath: "B/" })).errorCode, "S3_DESTINATION_EXISTS");
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", path: "A/", toPath: "A/in/" })).errorCode, "S3_MOVE_INTO_SELF");
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", path: "Z/", toPath: "B/" })).errorCode, "S3_NOT_FOUND");
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", path: "root", toPath: "B/" })).errorCode, "BAD_ARGS");
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", path: "A/", name: ".." })).errorCode, "MISSING_ARGS");
	assert.ok(t.requests.every(isList));
});

test("originals a DeleteObjects batch could not remove are reported after a folder move", async () => {
	const b = bucket({ "A/1": 1, "A/2": 2 }, { multi: (req, keys) => (keys.includes("A/2") ? xmlReply(200,
		"<DeleteResult><Error><Key>A/2</Key><Code>AccessDenied</Code><Message>no</Message></Error></DeleteResult>") : null) });
	const e = await start(b.reply).call("moveItem", { accountId: "acc", path: "A/", toPath: "B/" });
	assert.strictEqual(e.errorCode, "S3_MOVE_INCOMPLETE");
	assert.match(e.errorText, /1 original\(s\) could not be deleted: A\/2$/);
});

test("deleteItem on a key is one signed DELETE; errors; the root is refused before any request", async () => {
	const b = bucket({ "a.txt": 1 });
	const { call, requests } = start(b.reply);
	assert.deepStrictEqual(await call("deleteItem", { accountId: "acc", path: "a.txt" }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(requests.map(describeReq), ["DELETE a.txt"]);
	assert.strictEqual(requests[0].body, undefined);
	verifySig(requests[0]);
	for (const root of ["root", "/"]) { assert.strictEqual((await call("deleteItem", { accountId: "acc", path: root })).errorCode, "BAD_ARGS"); }
	assert.strictEqual((await call("deleteItem", { accountId: "acc", path: "" })).errorCode, "MISSING_ARGS");
	assert.strictEqual(requests.length, 1);
	const denied = start(() => xmlReply(403, s3Error("AccessDenied")));
	assert.strictEqual((await denied.call("deleteItem", { accountId: "acc", path: "a.txt" })).errorCode, "S3_DELETE_FAILED");
});

test("deleteItem on a folder lists every page and deletes all of it, marker included, in batches", async () => {
	const b = bucket({ "A/": 0, "A/1": 1, "A/s/2": 2, "A/s/3": 3, "A/s/4": 4, "AB": 5 }, { page: 2 });
	const { call, requests, adapter } = start(b.reply);
	adapter.DELETE_BATCH_KEYS = 3;
	assert.strictEqual((await call("deleteItem", { accountId: "acc", path: "A/" })).returnValue, true);
	assert.strictEqual(requests.filter(isList).length, 3);
	const posts = requests.filter((r) => r.method === "POST");
	assert.strictEqual(posts.length, 2);
	assert.match(posts[0].body, /<Key>A\/<\/Key>/);
	posts.forEach((p) => verifySig(p));
	assert.deepStrictEqual(b.keys(), ["AB"]);
});

test("deleteItem on a folder: the bound, per-key errors and a rejected batch fail it; an empty prefix is gone already", async () => {
	const many = {};
	for (let i = 0; i < 1001; i++) { many["A/" + i] = 1; }
	let t = start(bucket(many).reply);
	assert.strictEqual((await t.call("deleteItem", { accountId: "acc", path: "A/" })).errorCode, "S3_TOO_MANY_KEYS");
	assert.ok(t.requests.every(isList));

	t = start(bucket({ "A/1": 1, "A/2": 1 }, { multi: () => xmlReply(200,
		"<DeleteResult><Error><Key>A/1</Key><Code>AccessDenied</Code><Message>no</Message></Error></DeleteResult>") }).reply);
	let e = await t.call("deleteItem", { accountId: "acc", path: "A/" });
	assert.strictEqual(e.errorCode, "S3_DELETE_FAILED");
	assert.match(e.errorText, /1 object\(s\) could not be deleted \(AccessDenied\): A\/1$/);

	t = start(bucket({ "A/1": 1 }, { multi: () => xmlReply(200, s3Error("MalformedXML")) }).reply);
	e = await t.call("deleteItem", { accountId: "acc", path: "A/" });
	assert.strictEqual(e.errorCode, "S3_DELETE_FAILED");
	assert.match(e.errorText, /MalformedXML/);
	t = start(bucket({ "A/1": 1 }, { multi: () => ({ status: 200, body: "" }) }).reply);
	assert.strictEqual((await t.call("deleteItem", { accountId: "acc", path: "A/" })).errorCode, "S3_DELETE_FAILED", "a 200 with no DeleteResult");

	t = start(bucket().reply);
	assert.strictEqual((await t.call("deleteItem", { accountId: "acc", path: "Gone/" })).returnValue, true);
	assert.ok(!t.requests.some((r) => r.method === "POST"));
});

test("login: validates with a signed zero-key listing and returns the credentials Accounts stores", async () => {
	const { call, requests, handle } = start(bucket().reply);
	const r = await call("login", { endpoint: " https://s3.eu-central-1.amazonaws.com/ ", region: "eu-central-1", bucket: "/bkt/",
		accessKeyId: "AKIDUNITTEST", secretAccessKey: SECRET, pathStyle: true }, { appId: "com.palm.app.accounts 12" });
	assert.deepStrictEqual(r, { returnValue: true, username: "bkt@s3.eu-central-1.amazonaws.com", alias: "bkt", credentials: { common: {
		accessToken: "AKIDUNITTEST", secretAccessKey: SECRET, endpoint: "s3.eu-central-1.amazonaws.com", region: "eu-central-1",
		bucket: "bkt", pathStyle: true } } });
	assert.strictEqual(requests[0].url, "https://s3.eu-central-1.amazonaws.com/bkt/?list-type=2&max-keys=0");
	assert.match(requests[0].headers.Authorization, /Credential=AKIDUNITTEST\/\d{8}\/eu-central-1\/s3\/aws4_request/);
	verifySig(requests[0]);
	assert.strictEqual(handle.calls.length, 0, "no Accounts call");
});

test("login keeps http only for an endpoint given as http://, and the host:port either way", async () => {
	const { call, requests } = start(bucket().reply);
	const login = (endpoint, more = {}) => call("login", Object.assign({ endpoint, bucket: "b", accessKey: "k", secretKey: SECRET }, more), {});
	const seen = [];
	for (const e of [" http://127.0.0.1:3900/ ", "HTTP://nas.local:9000", "https://s3.eu-central-1.amazonaws.com", "s3.us-west-1.idrivee2.com"]) {
		const c = (await login(e)).credentials.common;
		seen.push([c.endpoint, c.scheme, c.region, c.pathStyle]);
	}
	assert.deepStrictEqual(seen, [["127.0.0.1:3900", "http", "us-east-1", true], ["nas.local:9000", "http", "us-east-1", true],
		["s3.eu-central-1.amazonaws.com", undefined, "us-east-1", true], ["s3.us-west-1.idrivee2.com", undefined, "us-east-1", true]]);
	assert.deepStrictEqual(requests.map((q) => urlOf(q).origin), ["http://127.0.0.1:3900", "http://nas.local:9000",
		"https://s3.eu-central-1.amazonaws.com", "https://s3.us-west-1.idrivee2.com"]);
	requests.forEach((q) => verifySig(q));
	const vh = await login("s3.example.test", { pathStyle: "false" });
	assert.strictEqual(vh.credentials.common.pathStyle, false);
	assert.strictEqual(urlOf(requests[4]).host, "b.s3.example.test");
});

test("login: missing fields are MISSING_CREDENTIALS with no request; a refused bucket is S3_AUTH_FAILED", async () => {
	const { call, requests } = start(() => xmlReply(403, s3Error("SignatureDoesNotMatch")));
	for (const drop of ["endpoint", "bucket", "accessKeyId", "secretAccessKey"]) {
		const p = { endpoint: "e.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s" };
		delete p[drop];
		assert.strictEqual((await call("login", p, {})).errorCode, "MISSING_CREDENTIALS", drop);
	}
	assert.strictEqual((await call("login", { endpoint: "http://", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }, {})).errorCode, "MISSING_CREDENTIALS");
	assert.strictEqual(requests.length, 0);
	const r = await call("login", { endpoint: "e.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }, {});
	assert.deepStrictEqual([r.errorCode, r.status], ["S3_AUTH_FAILED", 403]);
	assert.match(r.errorText, /^could not access the bucket - check the endpoint, region, keys and bucket name \(.*SignatureDoesNotMatch/);
	assert.doesNotMatch(JSON.stringify(r), /"s"|secret/i);
	const down = start(() => { throw new Error("refused"); });
	assert.strictEqual((await down.call("login", { endpoint: "e.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }, {})).errorCode, "S3_AUTH_FAILED");
});

test("checkCredentials: the zero-key listing with the given keys; a refused key is S3_AUTH_FAILED", async () => {
	const { call, requests } = start((req) => (req.headers.Authorization.includes("Credential=good/") ? bucket().reply(req) : xmlReply(403, s3Error("InvalidAccessKeyId"))));
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: Object.assign({}, CREDS, { accessToken: "good" }) } }, ACCOUNTS),
		{ returnValue: true, renewedCredentials: null, username: "bkt@s3.example.test", displayName: "bkt" });
	assert.strictEqual(requests[0].url, "https://s3.example.test/bkt/?list-type=2&max-keys=0");
	const bad = await call("checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS);
	assert.deepStrictEqual([bad.errorCode, bad.status], ["S3_AUTH_FAILED", 403]);
	assert.strictEqual(requests.length, 2, "no retry: S3 keys do not refresh");
	assert.strictEqual((await call("checkCredentials", {}, ACCOUNTS)).errorCode, "401_UNAUTHORIZED");
});

test("listAlbums: one album, Camera Uploads, counting its images; none there, or not listable, is 0 images", async () => {
	const b = bucket({ "Camera Uploads/": 0, "Camera Uploads/a.jpg": 1, "Camera Uploads/b.HEIC": 1, "Camera Uploads/n.txt": 1,
		"Camera Uploads/sub/c.jpg": 1 });
	const { call, requests } = start(b.reply);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS),
		{ returnValue: true, albums: [{ aid: "Camera Uploads", name: "Camera Uploads", size: { images: 2 } }] });
	assert.deepStrictEqual(requests.map((q) => [queryOf(q).prefix, queryOf(q)["max-keys"], queryOf(q).delimiter]),
		[["Camera Uploads/", "1", undefined], ["Camera Uploads/", "1000", "/"]]);
	const empty = start(bucket({ "x.jpg": 1 }).reply);
	assert.deepStrictEqual((await empty.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums,
		[{ aid: "Camera Uploads", name: "Camera Uploads", size: { images: 0 } }]);
	assert.strictEqual(empty.requests.length, 1);
	const denied = start(() => xmlReply(403, s3Error("AccessDenied")));
	assert.deepStrictEqual((await denied.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums[0].size, { images: 0 });
	assert.strictEqual((await start(b.reply, { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: one presigned GET link per image, made without a request; no aid is no photos", async () => {
	const b = bucket({ "Camera Uploads/a b.jpg": 1, "Camera Uploads/n.txt": 1, "Camera Uploads/c.png": 1 });
	const { call, requests } = start(b.reply);
	const r = await call("listPhotos", { accountId: "acc", aid: "Camera Uploads" }, PHOTOS);
	assert.deepStrictEqual(r.photos.map((p) => [p.pid, p.caption, p.fileName, p.type, p.src_big === p.src_small]),
		[["Camera Uploads/a b.jpg", "a b.jpg", "a b.jpg", "image", true], ["Camera Uploads/c.png", "c.png", "c.png", "image", true]]);
	assert.strictEqual(requests.length, 1);
	const u = new URL(r.photos[0].src_big);
	assert.strictEqual(u.origin + u.pathname, "https://s3.example.test/bkt/Camera%20Uploads/a%20b.jpg");
	const q = verifyPresigned(r.photos[0].src_big);
	assert.strictEqual(q["X-Amz-Expires"], "3600");
	assert.match(q["X-Amz-Credential"], /^AKIDUNITTEST\/\d{8}\/eu-test-1\/s3\/aws4_request$/);
	assert.deepStrictEqual((await call("listPhotos", { accountId: "acc" }, PHOTOS)).photos, []);
	assert.strictEqual(requests.length, 1);
	// over http with a port: the link keeps both
	const h = start(b.reply, { stored: Object.assign({}, CREDS, { endpoint: "127.0.0.1:3900", scheme: "http" }) });
	const link = (await h.call("listPhotos", { accountId: "acc", aid: "Camera Uploads/" }, PHOTOS)).photos[0].src_big;
	assert.strictEqual(new URL(link).origin, "http://127.0.0.1:3900");
	verifyPresigned(link);
	// the host signed is the one the URL carries: capitals and a default port normalised
	const n = start(b.reply, { stored: Object.assign({}, CREDS, { endpoint: "S3.Example.test:443" }) });
	const nl = (await n.call("listPhotos", { accountId: "acc", aid: "Camera Uploads" }, PHOTOS)).photos[0].src_big;
	assert.strictEqual(new URL(nl).origin, "https://s3.example.test");
	verifyPresigned(nl);
	const denied = start(() => xmlReply(500, s3Error("InternalError")));
	assert.strictEqual((await denied.call("listPhotos", { accountId: "acc", aid: "x" }, PHOTOS)).errorCode, "S3_LIST_FAILED");
});

test("upload (Photos): into the album given, or the Camera Uploads/ marker made first; pid is the key", async () => {
	const b = bucket();
	const { call, requests } = start(b.reply);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: "Camera Uploads", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "Camera Uploads/local.bin", name: "local.bin", size: 5000 });
	await call("upload", { accountId: "acc", path: LOCAL, name: "p.jpg", mimeType: "image/jpeg" }, PHOTOS);
	assert.deepStrictEqual(requests.map(describeReq), ["PUT Camera Uploads/local.bin", "PUT Camera Uploads/", "PUT Camera Uploads/p.jpg"]);
	assert.strictEqual(requests[1].headers["x-amz-content-sha256"], EMPTY_SHA);
	assert.strictEqual(requests[2].headers["content-type"], "image/jpeg");
	requests.forEach((q) => verifySig(q));
});

test("deletePhoto: a DELETE of the key", async () => {
	const b = bucket({ "Camera Uploads/a.jpg": 1 });
	const { call, requests } = start(b.reply);
	assert.deepStrictEqual(await call("deletePhoto", { accountId: "acc", pid: "Camera Uploads/a.jpg" }, PHOTOS), { returnValue: true, pid: "Camera Uploads/a.jpg" });
	assert.deepStrictEqual(requests.map(describeReq), ["DELETE Camera Uploads/a.jpg"]);
	assert.deepStrictEqual(b.keys(), []);
});

test("the XML reader: entities, sizes, prefixes, truncation, errors", () => {
	const A = require(path.join(SVC, "adapter.js"));
	const p = A.parseList("<ListBucketResult><Contents><Key>a &amp;lt; &lt;b&gt; &#233;&#x1F4C4;.txt</Key><Size>12</Size>" +
		"<LastModified>2026-01-01T00:00:00Z</LastModified></Contents><CommonPrefixes><Prefix>d/</Prefix></CommonPrefixes>" +
		"<IsTruncated>true</IsTruncated><NextContinuationToken>t+/=</NextContinuationToken></ListBucketResult>");
	assert.deepStrictEqual(json(p), { files: [{ key: "a &lt; <b> é\u{1F4C4}.txt", size: 12, modified: "2026-01-01T00:00:00Z", etag: null }],
		prefixes: ["d/"], truncated: true, nextToken: "t+/=" });
	assert.deepStrictEqual(A.parseError(s3Error("NoSuchKey")), { code: "NoSuchKey", message: "NoSuchKey happened" });
	assert.strictEqual(A.parseError("<ListBucketResult/>"), null);
	assert.strictEqual(A.decode("&#0;&#99999999;"), "&#0;&#99999999;");
	assert.strictEqual(A.xmlEscape("<a&'\"\u0001>"), "&lt;a&amp;&apos;&quot;&#1;&gt;");
});

test("a listing that repeats its continuation token fails instead of looping", async () => {
	const { call, requests } = start(() => xmlReply(200, listXml([{ key: "a", size: 1 }], "same")));
	assert.strictEqual((await call("listFolder", { accountId: "acc" })).errorCode, "S3_LIST_FAILED");
	assert.strictEqual(requests.length, 2);
});

// --- every request failing, in turn ----------------------------------------------------------

// How the failing request fails.
const MODES = {
	"a 500 reply": () => xmlReply(500, s3Error("InternalError")),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a refused signature": () => xmlReply(403, s3Error("SignatureDoesNotMatch")),
	"a 200 that is not S3's XML": (q) => (q.method === "GET" && !isList(q) ? new Response("<html>", { status: 200 }) : { status: 200, body: "<html>" }),
};

// What the bucket holds for the runs.
const FIXTURE = () => ({ "x/a.jpg": 3, "x/b.jpg": 3, "dir/": 0, "dir/1.jpg": 1, "Camera Uploads/": 0, "Camera Uploads/p.jpg": 1 });

// [method, payload, caller, { minSteps, tolerated(k, mode) -> true when request k failing that way is absorbed }]
// A request whose reply body is not read (GET object, PUT, DELETE) takes any 200.
const bodyless = (...steps) => (k, mode) => mode === "a 200 that is not S3's XML" && steps.includes(k);
const OPS = [
	["listFolder", { accountId: "acc", path: "x" }, DOCS, { minSteps: 2 }],
	["downloadFile", () => ({ accountId: "acc", fileId: "x/a.jpg", localPath: dl() }), DOCS, { tolerated: bodyless(1) }],
	["uploadFile", { accountId: "acc", path: "x", localPath: LOCAL }, DOCS, { tolerated: bodyless(1) }],
	["uploadFile (replace)", { accountId: "acc", fileId: "x/a.jpg", localPath: LOCAL, replace: true }, DOCS, { tolerated: bodyless(1) }],
	["createFolder", { accountId: "acc", path: "x", name: "n" }, DOCS, { tolerated: bodyless(1) }],
	["moveItem (a file)", { accountId: "acc", path: "x/a.jpg", toPath: "d/" }, DOCS, { minSteps: 4, tolerated: bodyless(4) }],
	["moveItem (a folder)", { accountId: "acc", path: "dir/", toPath: "d2/" }, DOCS, { minSteps: 5 }],
	["deleteItem (a file)", { accountId: "acc", path: "x/a.jpg" }, DOCS, { tolerated: bodyless(1) }],
	["deleteItem (a folder)", { accountId: "acc", path: "dir/" }, DOCS, { minSteps: 2 }],
	["checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS],
	["login", { endpoint: "s3.example.test", bucket: "bkt", accessKeyId: "k", secretAccessKey: SECRET }, {}],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS, { minSteps: 2, tolerated: bodyless(1, 2) }],
	["deletePhoto", { accountId: "acc", pid: "x/a.jpg" }, PHOTOS, { tolerated: bodyless(1) }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: "Camera Uploads" }, PHOTOS],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`s3 ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 12; k++) {
				let n = 0;
				const b = bucket(FIXTURE(), { page: 1 });
				const { call } = start((q) => (++n === k ? fail(q) : b.reply(q)), { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
				const r = await call(method, typeof payload === "function" ? payload() : payload, caller);   // exactly one reply, or ask() throws
				if (n < k) {
					assert.strictEqual(r.returnValue, true, `the run with nothing failing failed: ${JSON.stringify(r)}`);
					break;
				}
				reached = k;
				if (!(opts.tolerated && opts.tolerated(k, mode))) {
					assert.strictEqual(r.returnValue, false, `request ${k} failing: the method succeeded`);
					assert.ok(r.errorCode && r.errorCode !== "CONNECTOR_EXCEPTION", `request ${k} failing: ${JSON.stringify(r)}`);
					assert.ok(typeof r.errorText === "string" && r.errorText, "an errorText");
				}
			}
			assert.ok(reached >= (opts.minSteps || 1), `only ${reached} of ${opts.minSteps || 1} steps were failed`);
		});
	}
}

test("the Accounts service failing or not answering is one error reply", async () => {
	const denied = start(bucket().reply, { onCall: () => ({ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" }) });
	assert.deepStrictEqual(await denied.call("listFolder", { accountId: "acc" }),
		{ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" });
	const broken = start(bucket().reply, { onCall: () => "not json" });
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", path: "a" })).errorCode, "BUS_BAD_REPLY");
});
