// node --test tests/unit
// The Yandex Disk connector (cloud/yandex/service/com.palm.service.yandexdisk) as the launcher
// runs it: service.js started on a stand-in palmbus, with a stand-in fetch that records every
// request. Each method is called over the bus as its real caller would call it, and checked for
// the requests it makes (endpoint, method, headers, body), its reply, and its errors; the
// Accounts service is answered by the stand-in bus. The poll delay of asynchronous operations is
// the adapter's sleep(), replaced here so nothing really waits.
//
// The last part fails every request of every method in turn, in each way a request can fail,
// and checks the method still answers exactly once, with an error (see dropbox.test.js).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/yandex/service/com.palm.service.yandexdisk");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const API = "https://cloud-api.yandex.net/v1/disk";
const TOKEN_URL = "https://oauth.yandex.com/token";
const INFO = "https://login.yandex.ru/info?format=json";
const OP = API + "/operations?id=op1";
const DL = "https://downloader.disk.yandex.ru/disk/abc?sig=1";
const UP = "https://uploader1.disk.yandex.net:443/upload-target/xyz";
const enc = encodeURIComponent;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yandex-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const STORED = { accessToken: "tok", refreshToken: "ref", expiresAt: 1 };

const link = (href, method = "GET") => ({ href, method, templated: false });
const res = (p, type, extra) => Object.assign({ path: p, name: p.split("/").pop(), type, created: "2026-10-19T10:00:00+00:00",
	modified: "2026-10-19T10:00:00+00:00", resource_id: "1:abc" }, type === "file" ? { size: 7, mime_type: "application/pdf" } : {}, extra || {});
const entry = (p, type) => Object.assign({ id: p, type: type === "dir" ? "folder" : "file", name: p.split("/").pop() },
	type === "file" ? { size: 7 } : {}, { modified: "2026-10-19T10:00:00+00:00", path: p }, type === "file" ? { mimeType: "application/pdf" } : {});
const get = (p) => `GET ${API}/resources?path=${enc(p)}&limit=0`;
const list = (p, offset) => `GET ${API}/resources?path=${enc(p)}&limit=200` + (offset ? "&offset=" + offset : "");
const move = (from, to) => `POST ${API}/resources/move?from=${enc(from)}&path=${enc(to)}&overwrite=false`;
const ok = (body, status = 200) => ({ status, body });

// The service on a stand-in bus, the poll delay recorded instead of slept.
// -> { s, handle, requests, written, delays, lines(), call(method, payload, caller) }
function start(routes, { stored = STORED, onCall, timeouts } = {}) {
	const f = fakeFetch(routes);
	const written = [], delays = [];
	const pb = fakePalmbus({ onCall: onCall || ((uri, args) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: Object.assign({}, stored) } : { returnValue: true }; }
		if (/writeCredentials$/.test(uri)) { written.push(args); return { returnValue: true }; }
		return { returnValue: false, errorCode: -1, errorText: "Unknown service" };
	}) });
	const s = service.start({ palmbus: pb, fetch: f.fetch, idleMs: 0, exit: () => {}, log: { log() {}, error() {} }, timeouts });
	s.adapter.sleep = async (ms) => { delays.push(ms); };
	const handle = pb.handles[0];
	return { s, handle, requests: f.requests, written, delays,
		lines: () => f.requests.map((q) => q.method + " " + q.url),
		call: (method, payload, caller = DOCS) => ask(handle, method, payload, caller) };
}
const form = (q) => Object.fromEntries(new URLSearchParams(q.body));

// A route table answering exactly `script` ([["METHOD url", reply]...]) in order.
function scripted(script) {
	const queue = script.slice();
	const answer = (q) => {
		const next = queue.shift();
		if (!next) { return { status: 598, body: "unexpected " + q.method + " " + q.url }; }
		if (next[0] !== q.method + " " + q.url) { return { status: 597, body: "expected " + next[0] + ", got " + q.method + " " + q.url }; }
		return typeof next[1] === "function" ? next[1](q) : next[1];
	};
	return { routes: ["GET", "POST", "PUT", "DELETE"].map((m) => [m, /./, answer]), left: queue };
}

test("the service: its bus name, every method the old services.json had (plus quit, info); a node package", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.yandexdisk");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "moveItem", "quit",
		"upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const old of ["services.json", "sources.json", "commands"]) { assert.ok(!fs.existsSync(path.join(SVC, old)), old); }
});

test("caller rules: file methods for the FILE_APP_IDS, auth and photo methods open", async () => {
	const { call } = start([["GET", /./, () => ok({ _embedded: { items: [] } })]]);
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.cloud-auth" }, PHOTOS, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", path: "disk:/a", name: "b", localPath: LOCAL, fileId: "disk:/a" }, who);
			assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m + " " + JSON.stringify(who));
		}
	}
	for (const who of [DOCS, { appId: "org.webosports.app.documents-77" }, { service: "com.palm.stark.files.service" }]) {
		assert.strictEqual((await call("listFolder", { accountId: "acc" }, who)).returnValue, true, JSON.stringify(who));
	}
	assert.strictEqual((await call("getAuthorizeUrl", {}, {})).returnValue, true);
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: "Pictures" }, {})).returnValue, true);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: STORED } }, { service: "com.palm.service.accounts" })).returnValue, true);
});

test("getAuthorizeUrl: Yandex's consent URL with PKCE and force_confirm", async () => {
	const { call } = start([]);
	const r = await call("getAuthorizeUrl", {}, {});
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://oauth.yandex.com/authorize");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: Config.CLIENT_ID,
		redirect_uri: "http://localhost/yandex/oauth2callback", scope: Config.SCOPE,
		code_challenge: crypto.createHash("sha256").update(r.codeVerifier).digest("base64url"), code_challenge_method: "S256",
		force_confirm: "yes", state: "yandex" });
});

test("exchangeCode: the token request (the secret only when the build set one), then login info for the username", async () => {
	const routes = () => [
		["POST", /oauth\.yandex\.com\/token$/, () => ok({ access_token: "AT", refresh_token: "RT", expires_in: 31536000, token_type: "bearer" })],
		["GET", /login\.yandex\.ru\/info/, () => ok({ login: "ivan", default_email: "ivan@example.test", display_name: "Ivan" })],
	];
	let { call, requests, lines } = start(routes());
	const r = await call("exchangeCode", { code: "CODE", codeVerifier: "VERIFIER" }, { service: "com.palm.service.accounts" });
	assert.deepStrictEqual(lines(), ["POST " + TOKEN_URL, "GET " + INFO]);
	assert.deepStrictEqual(form(requests[0]), { client_id: Config.CLIENT_ID, grant_type: "authorization_code", code: "CODE",
		redirect_uri: Config.REDIRECT_URI, code_verifier: "VERIFIER" });
	assert.strictEqual(requests[1].headers.Authorization, "OAuth AT");
	assert.strictEqual(r.username, "ivan@example.test");
	assert.strictEqual(r.alias, "Ivan");
	assert.strictEqual(r.credentials.common.refreshToken, "RT");
	const was = Config.CLIENT_SECRET;
	Config.CLIENT_SECRET = "test-secret";
	try {
		({ call, requests } = start(routes()));
		await call("exchangeCode", { code: "CODE", codeVerifier: "V" }, {});
		assert.strictEqual(form(requests[0]).client_secret, "test-secret");
	} finally { Config.CLIENT_SECRET = was; }
});

test("checkCredentials: login info with the given token; login and real_name as fallbacks", async () => {
	const { call } = start([["GET", /login\.yandex\.ru\/info/, (q) => (q.headers.Authorization === "OAuth good"
		? ok({ login: "ivan", real_name: "Ivan P" }) : ok({ error: "UnauthorizedError", description: "Unauthorized" }, 401))]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "good" } } }, {}),
		{ returnValue: true, renewedCredentials: null, username: "ivan", displayName: "Ivan P" });
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "bad" } } }, {}),
		{ returnValue: false, errorCode: "YANDEX_API_ERROR", errorText: "Yandex Disk answered HTTP 401: UnauthorizedError: Unauthorized", status: 401 });
});

test("listFolder: GET /resources with limit, the OAuth header, entries normalised; every root form is disk:/", async () => {
	const { call, lines, requests } = start([["GET", /\/resources\?/, () => ok({ _embedded: { items: [res("disk:/Docs/Sub", "dir"), res("disk:/Docs/a.pdf", "file")], total: 2, limit: 200, offset: 0 } })]]);
	assert.deepStrictEqual(await call("listFolder", { accountId: "acc", path: "disk:/Docs" }),
		{ returnValue: true, renewedCredentials: null, entries: [entry("disk:/Docs/Sub", "dir"), entry("disk:/Docs/a.pdf", "file")] });
	assert.deepStrictEqual(requests[0].headers, { Authorization: "OAuth tok" });
	for (const root of [{}, { path: "" }, { path: "/" }, { folderId: "root" }, { folderId: "disk:/" }]) {
		await call("listFolder", Object.assign({ accountId: "acc" }, root));
	}
	await call("listFolder", { accountId: "acc", path: "/Docs" });
	await call("listFolder", { accountId: "acc", path: "app:/x" });
	assert.deepStrictEqual(lines(), [list("disk:/Docs"), list("disk:/"), list("disk:/"), list("disk:/"), list("disk:/"), list("disk:/"),
		list("disk:/Docs"), list("app:/x")]);
});

test("listFolder: a folder larger than one page is read in full (&offset=) up to its total", async () => {
	const items = (from, n) => Array.from({ length: n }, (x, i) => res("disk:/Big/f" + (from + i), "file"));
	const t = scripted([
		[list("disk:/Big"), ok({ _embedded: { items: items(0, 200), total: 401, limit: 200, offset: 0 } })],
		[list("disk:/Big", 200), ok({ _embedded: { items: items(200, 200), total: 401, limit: 200, offset: 200 } })],
		[list("disk:/Big", 400), ok({ _embedded: { items: items(400, 1), total: 401, limit: 200, offset: 400 } })],
	]);
	const { call } = start(t.routes);
	const r = await call("listFolder", { accountId: "acc", path: "disk:/Big" });
	assert.strictEqual(r.entries.length, 401);
	assert.strictEqual(r.entries[400].id, "disk:/Big/f400");
	assert.strictEqual(t.left.length, 0);
});

test("a 401: refresh, retry with the new token, save and report it", async () => {
	const { call, requests, written, lines } = start([
		["GET", /\/resources\?/, () => ({ status: 401 }), { once: true }],
		["POST", /\/token$/, () => ok({ access_token: "tok2", expires_in: 3600 })],
		["GET", /\/resources\?/, (q) => (q.headers.Authorization === "OAuth tok2" ? ok({ _embedded: { items: [] } }) : { status: 401 })],
	]);
	const r = await call("listFolder", { accountId: "acc" });
	assert.deepStrictEqual(lines(), [list("disk:/"), "POST " + TOKEN_URL, list("disk:/")]);
	assert.deepStrictEqual(form(requests[1]), { client_id: Config.CLIENT_ID, grant_type: "refresh_token", refresh_token: "ref" });
	assert.strictEqual(r.renewedCredentials.accessToken, "tok2");
	assert.strictEqual(r.renewedCredentials.refreshToken, "ref");
	assert.deepStrictEqual(written, [{ accountId: "acc", name: "common", credentials: r.renewedCredentials }]);
});

test("downloadFile: the download href with the token, then its bytes without it", async () => {
	const BYTES = crypto.randomBytes(70000);
	const t = scripted([
		[`GET ${API}/resources/download?path=${enc("disk:/Docs/Отчёт 100%.pdf")}`, ok(link(DL))],
		[`GET ${DL}`, () => new Response(BYTES, { status: 200 })],
	]);
	const { call, requests } = start(t.routes);
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { accountId: "acc", fileId: "disk:/Docs/Отчёт 100%.pdf", localPath: dest }),
		{ returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(requests[0].headers.Authorization, "OAuth tok");
	assert.strictEqual(requests[1].headers.Authorization, undefined, "the signed href gets no token");
	assert.strictEqual(t.left.length, 0);
});

test("downloadFile: no href is YANDEX_NO_DOWNLOAD_HREF; the href failing is YANDEX_DOWNLOAD_FAILED, no file", async () => {
	let s = start([["GET", /\/resources\/download\?/, () => ok({})]]);
	assert.strictEqual((await s.call("downloadFile", { accountId: "acc", path: "disk:/a", localPath: dl() })).errorCode, "YANDEX_NO_DOWNLOAD_HREF");
	assert.strictEqual(s.requests.length, 1);
	s = start([["GET", /\/resources\/download\?/, () => ok(link(DL))], ["GET", /downloader/, () => ok("gone", 410)]]);
	const dest = dl();
	const r = await s.call("downloadFile", { accountId: "acc", path: "disk:/a", localPath: dest });
	assert.strictEqual(r.errorCode, "YANDEX_DOWNLOAD_FAILED");
	assert.strictEqual(r.status, 410);
	assert.ok(!fs.existsSync(dest));
	s = start([["GET", /\/resources\/download\?/, () => ok({ error: "DiskNotFoundError" }, 404)]]);
	const nf = await s.call("downloadFile", { accountId: "acc", path: "disk:/a", localPath: dl() });
	assert.strictEqual(nf.errorCode, "YANDEX_API_ERROR");
	assert.strictEqual(nf.status, 404);
});

test("uploadFile: the upload href (overwrite=false) with the token, then the file PUT to it without", async () => {
	const t = scripted([
		[`GET ${API}/resources/upload?path=${enc("disk:/Docs/Заметки.txt")}&overwrite=false`, ok(link(UP, "PUT"))],
		[`PUT ${UP}`, ok("", 201)],
	]);
	const { call, requests } = start(t.routes);
	assert.deepStrictEqual(await call("uploadFile", { accountId: "acc", path: "disk:/Docs", localPath: LOCAL, name: "Заметки.txt", mimeType: "text/plain" }),
		{ returnValue: true, renewedCredentials: null, name: "Заметки.txt", id: "disk:/Docs/Заметки.txt" });
	assert.strictEqual(requests[0].headers.Authorization, "OAuth tok");
	assert.strictEqual(requests[1].headers.Authorization, undefined);
	assert.strictEqual(requests[1].body.blob, LOCAL_BYTES.length, "a Blob of the file, streamed by fetch");
	assert.strictEqual(t.left.length, 0);
});

test("uploadFile: the root and the local name by default, a leading slash dropped; replace:true overwrites in place", async () => {
	const { call, lines } = start([["GET", /\/resources\/upload\?/, () => ok(link(UP, "PUT"))], ["PUT", /uploader/, () => ok("", 201)]]);
	await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	await call("uploadFile", { accountId: "acc", folderId: "/Docs/", localPath: LOCAL, name: "/c.txt" });
	const r = await call("uploadFile", { accountId: "acc", fileId: "disk:/Docs/r.docx", localPath: LOCAL, replace: true });
	assert.strictEqual(r.id, "disk:/Docs/r.docx");
	assert.deepStrictEqual(lines().filter((l) => l.startsWith("GET")), [
		`GET ${API}/resources/upload?path=${enc("disk:/local.bin")}&overwrite=false`,
		`GET ${API}/resources/upload?path=${enc("disk:/Docs/c.txt")}&overwrite=false`,
		`GET ${API}/resources/upload?path=${enc("disk:/Docs/r.docx")}&overwrite=true`]);
});

test("uploadFile: a taken name is the 409; no href is YANDEX_NO_UPLOAD_HREF; the PUT failing is YANDEX_UPLOAD_FAILED", async () => {
	let s = start([["GET", /\/resources\/upload\?/, () => ok({ error: "DiskResourceAlreadyExistsError" }, 409)]]);
	let r = await s.call("uploadFile", { accountId: "acc", localPath: LOCAL });
	assert.strictEqual(r.errorCode, "YANDEX_API_ERROR");
	assert.strictEqual(r.status, 409);
	s = start([["GET", /\/resources\/upload\?/, () => ok({ method: "PUT" })]]);
	assert.strictEqual((await s.call("uploadFile", { accountId: "acc", localPath: LOCAL })).errorCode, "YANDEX_NO_UPLOAD_HREF");
	s = start([["GET", /\/resources\/upload\?/, () => ok(link(UP, "PUT"))], ["PUT", /uploader/, () => ok("", 507)]]);
	r = await s.call("uploadFile", { accountId: "acc", localPath: LOCAL });
	assert.strictEqual(r.errorCode, "YANDEX_UPLOAD_FAILED");
	assert.strictEqual(r.status, 507);
});

test("createFolder at the root: PUT /resources, then the new folder read back", async () => {
	const t = scripted([
		[`PUT ${API}/resources?path=${enc("disk:/Новая папка")}`, ok(link(`${API}/resources?path=disk%3A%2F`), 201)],
		[get("disk:/Новая папка"), ok(res("disk:/Новая папка", "dir"))],
	]);
	const { call, requests } = start(t.routes);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", name: "Новая папка" }),
		{ returnValue: true, renewedCredentials: null, entry: entry("disk:/Новая папка", "dir") });
	assert.deepStrictEqual(requests.map((r) => r.headers.Authorization), ["OAuth tok", "OAuth tok"]);
	assert.strictEqual(t.left.length, 0);
});

test("createFolder in a sub-folder; 409 (exists) is a failure and nothing is read back", async () => {
	let s = start(scripted([[`PUT ${API}/resources?path=${enc("disk:/Docs/X")}`, ok(link("x"), 201)], [get("disk:/Docs/X"), ok(res("disk:/Docs/X", "dir"))]]).routes);
	assert.strictEqual((await s.call("createFolder", { accountId: "acc", path: "disk:/Docs", name: "X" })).entry.path, "disk:/Docs/X");
	s = start(scripted([[`PUT ${API}/resources?path=${enc("disk:/Docs/X")}`, ok({ error: "DiskPathPointsToExistentDirectoryError" }, 409)]]).routes);
	const r = await s.call("createFolder", { accountId: "acc", path: "disk:/Docs", name: "X" });
	assert.strictEqual(r.errorCode, "YANDEX_API_ERROR");
	assert.strictEqual(r.returnValue, false);
	assert.strictEqual(r.status, 409);
	assert.strictEqual(s.requests.length, 1);
});

test("createFolder 202: the operation is polled before the folder is read back", async () => {
	const t = scripted([
		[`PUT ${API}/resources?path=${enc("disk:/A")}`, ok(link(OP), 202)],
		[`GET ${OP}`, ok({ status: "success" })],
		[get("disk:/A"), ok(res("disk:/A", "dir"))],
	]);
	const s = start(t.routes);
	assert.strictEqual((await s.call("createFolder", { accountId: "acc", name: "A" })).entry.path, "disk:/A");
	assert.deepStrictEqual(s.delays, []);
	assert.strictEqual(t.left.length, 0);
});

test("moveItem rename only: the new path is in the item's own folder", async () => {
	const t = scripted([
		[move("disk:/Docs/a.pdf", "disk:/Docs/b 100%.pdf"), ok(link("x"), 201)],
		[get("disk:/Docs/b 100%.pdf"), ok(res("disk:/Docs/b 100%.pdf", "file"))],
	]);
	const { call } = start(t.routes);
	assert.deepStrictEqual((await call("moveItem", { accountId: "acc", path: "disk:/Docs/a.pdf", name: "b 100%.pdf" })).entry, entry("disk:/Docs/b 100%.pdf", "file"));
	assert.strictEqual(t.left.length, 0);
});

test("moveItem rename only of a top-level item stays at the root", async () => {
	const { call } = start(scripted([[move("disk:/a.pdf", "disk:/b.pdf"), ok(link("x"), 201)], [get("disk:/b.pdf"), ok(res("disk:/b.pdf", "file"))]]).routes);
	assert.strictEqual((await call("moveItem", { accountId: "acc", fileId: "disk:/a.pdf", name: "b.pdf" })).entry.path, "disk:/b.pdf");
});

test("moveItem move only keeps the name (even one with a %); to the root; move and rename is one request", async () => {
	let t = scripted([[move("disk:/Docs/50%25.pdf", "disk:/50%25.pdf"), ok(link("x"), 201)], [get("disk:/50%25.pdf"), ok(res("disk:/50%25.pdf", "file"))]]);
	let s = start(t.routes);
	assert.strictEqual((await s.call("moveItem", { accountId: "acc", path: "disk:/Docs/50%25.pdf", toRoot: true })).entry.path, "disk:/50%25.pdf");
	assert.strictEqual(t.left.length, 0);
	t = scripted([[move("disk:/a.pdf", "disk:/Docs/z.pdf"), ok(link("x"), 201)], [get("disk:/Docs/z.pdf"), ok(res("disk:/Docs/z.pdf", "file"))]]);
	s = start(t.routes);
	assert.deepStrictEqual((await s.call("moveItem", { accountId: "acc", path: "disk:/a.pdf", toPath: "disk:/Docs", name: "z.pdf" })).entry,
		entry("disk:/Docs/z.pdf", "file"));
	assert.strictEqual(t.left.length, 0);
});

test("moveItem: 409 (target exists) is a failure", async () => {
	const s = start(scripted([[move("disk:/a", "disk:/D/a"), ok({ error: "DiskResourceAlreadyExistsError" }, 409)]]).routes);
	const r = await s.call("moveItem", { accountId: "acc", path: "disk:/a", toPath: "disk:/D" });
	assert.strictEqual(r.errorCode, "YANDEX_API_ERROR");
	assert.strictEqual(r.status, 409);
	assert.strictEqual(s.requests.length, 1);
});

test("moveItem 202: the operation is polled until success, a delay apart, then the entry is read", async () => {
	const t = scripted([
		[move("disk:/Big", "disk:/Docs/Big"), ok(link(OP), 202)],
		[`GET ${OP}`, ok({ status: "in-progress" })],
		[`GET ${OP}`, ok({ status: "in-progress" })],
		[`GET ${OP}`, ok({ status: "success" })],
		[get("disk:/Docs/Big"), ok(res("disk:/Docs/Big", "dir"))],
	]);
	const s = start(t.routes);
	assert.deepStrictEqual((await s.call("moveItem", { accountId: "acc", path: "disk:/Big", toPath: "disk:/Docs" })).entry, entry("disk:/Docs/Big", "dir"));
	assert.deepStrictEqual(s.delays, [1000, 1000]);
	assert.ok(s.requests.every((r) => r.headers.Authorization === "OAuth tok"));
	assert.strictEqual(t.left.length, 0);
});

test("moveItem 202: a failed operation is a failure and nothing is read back", async () => {
	const s = start(scripted([[move("disk:/Big", "disk:/Docs/Big"), ok(link(OP), 202)], [`GET ${OP}`, ok({ status: "failed" })]]).routes);
	const r = await s.call("moveItem", { accountId: "acc", path: "disk:/Big", toPath: "disk:/Docs" });
	assert.strictEqual(r.errorCode, "YANDEX_OPERATION_FAILED");
	assert.strictEqual(s.requests.length, 2);
});

test("moveItem 202: polling stops after POLL_TRIES polls", async () => {
	const n = 30;
	const script = [[move("disk:/Big", "disk:/B2"), ok(link(OP), 202)]];
	for (let i = 0; i < n; i++) { script.push([`GET ${OP}`, ok({ status: "in-progress" })]); }
	const t = scripted(script);
	const s = start(t.routes);
	assert.strictEqual(s.s.adapter.POLL_TRIES, n);
	const r = await s.call("moveItem", { accountId: "acc", path: "disk:/Big", name: "B2" });
	assert.strictEqual(r.errorCode, "YANDEX_OPERATION_TIMEOUT");
	assert.strictEqual(s.requests.length, 1 + n);
	assert.strictEqual(s.delays.length, n - 1);
	assert.strictEqual(t.left.length, 0);
});

test("the poll delay really waits by default (POLL_DELAY_MS, a timer)", async () => {
	const { s } = start([]);
	assert.strictEqual(s.adapter.POLL_DELAY_MS, 1000);
	const fresh = require(path.join(SVC, "adapter.js"))({ config: Config, http: {}, errors: require("../../cloud/_core/service/_cloudcore/node/errors.js") });
	const t0 = Date.now();
	await fresh.sleep(30);
	assert.ok(Date.now() - t0 >= 25);
});

test("202 with an operation link off the API host: the token is not sent there", async () => {
	const s = start(scripted([[move("disk:/Big", "disk:/B2"), ok(link("https://evil.example/v1/disk/operations?id=1"), 202)]]).routes);
	assert.strictEqual((await s.call("moveItem", { accountId: "acc", path: "disk:/Big", name: "B2" })).errorCode, "YANDEX_BAD_OPERATION");
	assert.strictEqual(s.requests.length, 1);
	const t = start(scripted([[move("disk:/Big", "disk:/B2"), ok({}, 202)]]).routes);
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", path: "disk:/Big", name: "B2" })).errorCode, "YANDEX_BAD_OPERATION");
});

test("moveItem: 401 refreshes once and the read-back uses the new token", async () => {
	const t = scripted([
		[move("disk:/a", "disk:/b"), { status: 401 }],
		["POST " + TOKEN_URL, ok({ access_token: "tok2", refresh_token: "ref2", expires_in: 3600 })],
		[move("disk:/a", "disk:/b"), ok(link("x"), 201)],
		[get("disk:/b"), ok(res("disk:/b", "file"))],
	]);
	const s = start(t.routes);
	assert.strictEqual((await s.call("moveItem", { accountId: "acc", path: "disk:/a", name: "b" })).entry.path, "disk:/b");
	assert.deepStrictEqual(s.requests.filter((q) => q.url.startsWith(API)).map((r) => r.headers.Authorization), ["OAuth tok", "OAuth tok2", "OAuth tok2"]);
	assert.strictEqual(s.written.length, 1);
	assert.strictEqual(t.left.length, 0);
});

test("deleteItem: DELETE without permanently (to the Trash); 204 is done; never the root", async () => {
	const s = start(scripted([[`DELETE ${API}/resources?path=${enc("disk:/Docs/a b.pdf")}`, { status: 204 }]]).routes);
	assert.deepStrictEqual(await s.call("deleteItem", { accountId: "acc", path: "disk:/Docs/a b.pdf" }), { returnValue: true, renewedCredentials: null });
	assert.ok(!s.requests[0].url.includes("permanently"));
	for (const root of ["disk:/", "/", "root"]) { assert.strictEqual((await s.call("deleteItem", { accountId: "acc", path: root })).errorCode, "BAD_ARGS"); }
	assert.strictEqual(s.requests.length, 1);
});

test("deleteItem 202: polled to success; a refused delete or a failed poll is a failure", async () => {
	let t = scripted([
		[`DELETE ${API}/resources?path=${enc("disk:/Big")}`, ok(link(OP), 202)],
		[`GET ${OP}`, ok({ status: "in-progress" })],
		[`GET ${OP}`, ok({ status: "success" })],
	]);
	let s = start(t.routes);
	assert.strictEqual((await s.call("deleteItem", { accountId: "acc", path: "disk:/Big" })).returnValue, true);
	assert.strictEqual(t.left.length, 0);
	s = start(scripted([[`DELETE ${API}/resources?path=${enc("disk:/gone")}`, ok({ error: "DiskNotFoundError" }, 404)]]).routes);
	let r = await s.call("deleteItem", { accountId: "acc", path: "disk:/gone" });
	assert.strictEqual(r.errorCode, "YANDEX_API_ERROR");
	assert.strictEqual(r.status, 404);
	t = scripted([[`DELETE ${API}/resources?path=${enc("disk:/Big")}`, ok(link(OP), 202)], [`GET ${OP}`, ok({ error: "x" }, 500)]]);
	s = start(t.routes);
	r = await s.call("deleteItem", { accountId: "acc", path: "disk:/Big" });
	assert.strictEqual(r.status, 500);
});

// --- Photos ----------------------------------------------------------------------------------

const SYS = `GET ${API}?fields=system_folders`;
const jpg = (p) => res(p, "file", { mime_type: "image/jpeg" });

test("listAlbums: the camera-uploads folder when it is there; aid without disk:/ and the trailing slash", async () => {
	const t = scripted([
		[SYS, ok({ system_folders: { photostream: "disk:/Фотокамера/", downloads: "disk:/Загрузки/" } })],
		[get("disk:/Фотокамера"), ok(res("disk:/Фотокамера", "dir"))],
		[list("disk:/Фотокамера"), ok({ _embedded: { items: [jpg("disk:/Фотокамера/1.jpg"), res("disk:/Фотокамера/x.heic", "file", { mime_type: undefined }), res("disk:/Фотокамера/n.pdf", "file")], total: 3 } })],
	]);
	const { call } = start(t.routes);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS),
		{ returnValue: true, albums: [{ aid: "Фотокамера", name: "Фотокамера", size: { images: 2 } }] });
	assert.strictEqual(t.left.length, 0);
});

test("listAlbums: no photostream, or one not there, or no disk.info: disk:/Pictures; unlistable is 0 images", async () => {
	const pictures = { returnValue: true, albums: [{ aid: "Pictures", name: "Pictures", size: { images: 0 } }] };
	for (const sys of [ok({ system_folders: {} }), ok({}, 403)]) {
		const s = start(scripted([[SYS, sys], [list("disk:/Pictures"), ok({ _embedded: { items: [] } })]]).routes);
		assert.deepStrictEqual(await s.call("listAlbums", { accountId: "acc" }, PHOTOS), pictures);
	}
	const s = start(scripted([[SYS, ok({ system_folders: { photostream: "disk:/Camera/" } })], [get("disk:/Camera"), ok({}, 404)],
		[list("disk:/Pictures"), ok({ error: "DiskNotFoundError" }, 404)]]).routes);
	assert.deepStrictEqual(await s.call("listAlbums", { accountId: "acc" }, PHOTOS), pictures);
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: the aid as disk:/<aid>; one download href per image, in turn; an image without one is left out", async () => {
	const t = scripted([
		[list("disk:/Pictures"), ok({ _embedded: { items: [jpg("disk:/Pictures/a.jpg"), res("disk:/Pictures/d.pdf", "file"), jpg("disk:/Pictures/b.jpg")], total: 3 } })],
		[`GET ${API}/resources/download?path=${enc("disk:/Pictures/a.jpg")}`, ok(link(DL))],
		[`GET ${API}/resources/download?path=${enc("disk:/Pictures/b.jpg")}`, ok({ error: "x" }, 500)],
	]);
	const { call } = start(t.routes);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "Pictures" }, PHOTOS), { returnValue: true, photos: [
		{ pid: "disk:/Pictures/a.jpg", src_big: DL, src_small: DL, caption: "a.jpg", type: "image", fileName: "a.jpg" }] });
	assert.strictEqual(t.left.length, 0);
});

test("listPhotos: no aid is no photos and no request; the listing failing fails the call", async () => {
	const { call, requests } = start([["GET", /./, () => ok({}, 500)]]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc" }, PHOTOS), { returnValue: true, photos: [] });
	assert.strictEqual(requests.length, 0);
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: "Pictures" }, PHOTOS)).errorCode, "YANDEX_API_ERROR");
});

test("upload (Photos): into the album (aid), or disk:/Pictures made first (409 is fine); pid is the path", async () => {
	const { call, lines } = start([["PUT", /\/resources\?/, () => ok({ error: "DiskPathPointsToExistentDirectoryError" }, 409)],
		["GET", /\/resources\/upload\?/, () => ok(link(UP, "PUT"))], ["PUT", /uploader/, () => ok("", 201)]]);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: "Фотокамера", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "disk:/Фотокамера/local.bin", name: "local.bin" });
	assert.deepStrictEqual(await call("upload", { accountId: "acc", path: LOCAL, name: "p.jpg" }, PHOTOS),
		{ returnValue: true, pid: "disk:/Pictures/p.jpg", name: "p.jpg" });
	assert.deepStrictEqual(lines(), [`GET ${API}/resources/upload?path=${enc("disk:/Фотокамера/local.bin")}&overwrite=false`, `PUT ${UP}`,
		`PUT ${API}/resources?path=${enc("disk:/Pictures")}`, `GET ${API}/resources/upload?path=${enc("disk:/Pictures/p.jpg")}&overwrite=false`, `PUT ${UP}`]);
});

test("upload (Photos): an album folder that cannot be made is YANDEX_MKDIR_FAILED", async () => {
	const { call, requests } = start([["PUT", /\/resources\?/, () => ok({}, 507)]]);
	const r = await call("upload", { accountId: "acc", path: LOCAL }, PHOTOS);
	assert.strictEqual(r.errorCode, "YANDEX_MKDIR_FAILED");
	assert.strictEqual(requests.length, 1);
});

test("deletePhoto: DELETE permanently=true; 202 is done; a refusal is YANDEX_DELETE_FAILED", async () => {
	let s = start([["DELETE", /\/resources\?/, () => ok(link(OP), 202)]]);
	assert.deepStrictEqual(await s.call("deletePhoto", { accountId: "acc", pid: "disk:/Pictures/a.jpg" }, PHOTOS), { returnValue: true, pid: "disk:/Pictures/a.jpg" });
	assert.deepStrictEqual(s.lines(), [`DELETE ${API}/resources?path=${enc("disk:/Pictures/a.jpg")}&permanently=true`]);
	s = start([["DELETE", /\/resources\?/, () => ok({}, 403)]]);
	const r = await s.call("deletePhoto", { accountId: "acc", pid: "disk:/a.jpg" }, PHOTOS);
	assert.strictEqual(r.errorCode, "YANDEX_DELETE_FAILED");
	assert.strictEqual(r.status, 403);
});

// --- every request failing, in turn ----------------------------------------------------------

// What Yandex answers when nothing fails. A path with "async" in it moves through an operation.
function happy(q) {
	const u = q.url;
	if (/oauth\.yandex\.com\/token$/.test(u)) { return ok({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }); }
	if (/login\.yandex\.ru/.test(u)) { return ok({ default_email: "u@example.test", display_name: "U" }); }
	if (/\/resources\/download\?/.test(u)) { return ok(link(DL)); }
	if (/\/resources\/upload\?/.test(u)) { return ok(link(UP, "PUT")); }
	if (/downloader/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (/uploader/.test(u)) { return ok("", 201); }
	if (/\/operations\?/.test(u)) { return ok({ status: "success" }); }
	if (/fields=system_folders/.test(u)) { return ok({ system_folders: { photostream: "disk:/Camera/" } }); }
	if (/async/.test(u) && q.method !== "GET") { return ok(link(OP), 202); }
	if (q.method === "GET" && /&limit=0$/.test(u)) { return ok(res("disk:/m", "dir")); }
	if (q.method === "GET") { return ok({ _embedded: { items: [jpg("disk:/Camera/a.jpg"), jpg("disk:/Camera/b.jpg")], total: 2 } }); }
	if (q.method === "DELETE") { return { status: 204 }; }
	return ok(link(API + "/resources?path=x"), 201);
}

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401 and a refused refresh": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": () => ({ status: 200, body: "<html>" }),
};
const NOT_JSON = "a reply that is not JSON";

// [method, payload, caller, { minSteps, tolerated(k, mode) -> true when request k failing is absorbed }]
const OPS = [
	["listFolder", { accountId: "acc" }, DOCS],
	["downloadFile", () => ({ accountId: "acc", fileId: "disk:/a.jpg", localPath: dl() }), DOCS, { minSteps: 2, tolerated: (k, m) => k === 2 && m === NOT_JSON }],
	["uploadFile", { accountId: "acc", localPath: LOCAL }, DOCS, { minSteps: 2, tolerated: (k, m) => k === 2 && m === NOT_JSON }],
	["uploadFile (replace)", { accountId: "acc", fileId: "disk:/a.jpg", localPath: LOCAL, replace: true }, DOCS, { minSteps: 2, tolerated: (k, m) => k === 2 && m === NOT_JSON }],
	["createFolder", { accountId: "acc", name: "n" }, DOCS, { minSteps: 2 }],
	["createFolder (an operation)", { accountId: "acc", name: "async" }, DOCS, { minSteps: 3 }],
	["moveItem (rename)", { accountId: "acc", path: "disk:/a.jpg", name: "b.jpg" }, DOCS, { minSteps: 2 }],
	["moveItem (an operation)", { accountId: "acc", path: "disk:/async", toPath: "disk:/d" }, DOCS, { minSteps: 3 }],
	["deleteItem", { accountId: "acc", path: "disk:/a.jpg" }, DOCS],
	["deleteItem (an operation)", { accountId: "acc", path: "disk:/async" }, DOCS, { minSteps: 2 }],
	["checkCredentials", { credentials: { common: { accessToken: "tok", refreshToken: "ref" } } }, {}],
	["exchangeCode", { code: "c", codeVerifier: "v" }, {}, { minSteps: 2, tolerated: (k) => k >= 2 }],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS, { minSteps: 3, tolerated: (k, m) => (k === 1 || k === 3) && m === NOT_JSON }],
	["upload (an album)", { accountId: "acc", albumId: "Camera", path: LOCAL }, PHOTOS, { minSteps: 2, tolerated: (k, m) => k === 2 && m === NOT_JSON }],
	["deletePhoto", { accountId: "acc", pid: "disk:/a.jpg" }, PHOTOS, { tolerated: (k, m) => m === NOT_JSON }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 3, tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: "Camera" }, PHOTOS, { minSteps: 3, tolerated: (k) => k >= 2 }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`yandex ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const refreshAfter401 = mode.startsWith("a 401");
				const answer = (q) => {
					n++;
					if (n === k) { return fail(q); }
					if (refreshAfter401 && n > k && /\/token$/.test(q.url)) { return { status: 400, body: { error: "invalid_grant" } }; }
					return happy(q);
				};
				const { call } = start(["GET", "POST", "PUT", "DELETE"].map((m) => [m, /./, answer]), { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
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

test("a 401 refreshed, then a retry that is refused or gets no answer: that is the error; the new token is still saved", async () => {
	for (const [retry, code] of [[() => ({ status: 500, body: "{}" }), "YANDEX_API_ERROR"], [() => { throw new Error("reset"); }, "CURL_FAILED"]]) {
		const { call, written } = start([
			["GET", /\/resources\?/, () => ({ status: 401 }), { once: true }],
			["POST", /\/token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 60 } })],
			["GET", /\/resources\?/, (q) => { assert.strictEqual(q.headers.Authorization, "OAuth tok2"); return retry(); }],
		]);
		const r = await call("listFolder", { accountId: "acc", path: "disk:/x" });
		assert.strictEqual(r.errorCode, code);
		assert.deepStrictEqual(written.map((w) => [w.accountId, w.name, w.credentials.accessToken]), [["acc", "common", "tok2"]]);
	}
});

test("the Accounts service failing or not answering is one error reply", async () => {
	const denied = start([], { onCall: () => ({ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" }) });
	assert.deepStrictEqual(await denied.call("listFolder", { accountId: "acc" }),
		{ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" });
	const broken = start([], { onCall: () => "not json" });
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", path: "disk:/a" })).errorCode, "BUS_BAD_REPLY");
});
