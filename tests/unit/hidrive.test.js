// node --test tests/unit
// The HiDrive connector (cloud/hidrive/service/com.palm.service.hidrive) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (endpoint, method, headers, body), its reply, and its errors; the Accounts
// service is answered by the stand-in bus.
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

const SVC = path.join(__dirname, "../../cloud/hidrive/service/com.palm.service.hidrive");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const API = "https://api.hidrive.strato.com/2.1";
const TOKEN_URL = "https://my.hidrive.com/oauth2/token";
const USER_ME = `${API}/user/me?fields=account,alias,email,descr,home,home_id`;
const enc = encodeURIComponent;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hidrive-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const STORED = { accessToken: "tok", refreshToken: "ref", expiresAt: 1 };
const ME = { account: "me", alias: "Me Myself", email: "me@example.test", home: "/users/me" };

const DIR_META = { name: "New%20Folder", path: "/users/me/New%20Folder", type: "dir", mtime: 1700000000,
	id: "d0.d1", ctime: 1700000000, has_dirs: false, readable: true, writable: true };
const DIR_ENTRY = { id: "/users/me/New Folder", type: "folder", name: "New Folder", size: 0,
	modified: 1700000000000, path: "/users/me/New Folder", mimeType: "application/x-directory" };
const FILE_META = (p) => ({ name: enc(p.split("/").pop()), path: p.split("/").map(enc).join("/"), type: "file", size: 7, mtime: 9, id: "d0.f1" });
const fileEntry = (p) => ({ id: p, type: "file", name: p.split("/").pop(), size: 7, modified: 9000, path: p, mimeType: "application/pdf" });
const listUrl = (p, offset = 0) => `${API}/dir?path=${enc(p)}&members=all&fields=members.name,members.type,members.size,members.mtime,members.path,members.id&limit=${offset},5000`;
const metaUrl = (p) => `${API}/meta?path=${enc(p)}&fields=type`;

// The service on a stand-in bus. Accounts: readCredentials gives `stored`, writeCredentials is
// recorded. -> { s, handle, requests, written, lines(), call(method, payload, caller) }
function start(routes, { stored = STORED, onCall, timeouts } = {}) {
	const f = fakeFetch(routes);
	const written = [];
	const pb = fakePalmbus({ onCall: onCall || ((uri, args) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: Object.assign({}, stored) } : { returnValue: true }; }
		if (/writeCredentials$/.test(uri)) { written.push(args); return { returnValue: true }; }
		return { returnValue: false, errorCode: -1, errorText: "Unknown service" };
	}) });
	const s = service.start({ palmbus: pb, fetch: f.fetch, idleMs: 0, exit: () => {}, log: { log() {}, error() {} }, timeouts });
	const handle = pb.handles[0];
	return { s, handle, requests: f.requests, written,
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
		return next[1];
	};
	return { routes: ["GET", "POST", "PUT", "DELETE"].map((m) => [m, /./, answer]), left: queue };
}
const ok = (body, status = 200) => ({ status, body });

// Run with a client secret, as a build with HIDRIVE_CLIENT_SECRET has it.
async function withSecret(fn) {
	const was = Config.CLIENT_SECRET;
	Config.CLIENT_SECRET = "test-secret";
	try { return await fn(); } finally { Config.CLIENT_SECRET = was; }
}

test("the service: its bus name, every method the old services.json had (plus quit, info); a node package", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.hidrive");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "moveItem", "quit",
		"upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const old of ["services.json", "sources.json", "commands"]) { assert.ok(!fs.existsSync(path.join(SVC, old)), old); }
});

test("caller rules: file methods for the FILE_APP_IDS, auth and photo methods open", async () => {
	const { call } = start([["GET", /./, () => ok({ members: [], home: "/users/me" })]]);
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.cloud-auth" }, PHOTOS, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", path: "/a", name: "b", localPath: LOCAL, fileId: "/a" }, who);
			assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m + " " + JSON.stringify(who));
		}
	}
	for (const who of [DOCS, { appId: "org.webosports.app.documents-77" }, { service: "com.palm.stark.files.service" }]) {
		assert.strictEqual((await call("listFolder", { accountId: "acc" }, who)).returnValue, true, JSON.stringify(who));
	}
	assert.strictEqual((await call("getAuthorizeUrl", {}, {})).returnValue, true);
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: "%2Fusers%2Fme" }, {})).returnValue, true);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: STORED } }, { service: "com.palm.service.accounts" })).returnValue, true);
});

test("getAuthorizeUrl: HiDrive's consent URL, the localhost:8888 redirect, scope user,rw", async () => {
	const { call } = start([]);
	const r = await call("getAuthorizeUrl", {}, {});
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://my.hidrive.com/client/authorize");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: Config.CLIENT_ID,
		redirect_uri: "http://localhost:8888/hidrive/oauth2callback", scope: "user,rw",
		code_challenge: crypto.createHash("sha256").update(r.codeVerifier).digest("base64url"), code_challenge_method: "S256",
		state: "hidrive" });
});

test("exchangeCode: the token request with the client secret, then /user/me for the username", () => withSecret(async () => {
	const { call, requests, lines } = start([
		["POST", /oauth2\/token$/, () => ok({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" })],
		["GET", /\/user\/me/, () => ok(ME)],
	]);
	const r = await call("exchangeCode", { code: "CODE", codeVerifier: "VERIFIER" }, { service: "com.palm.service.accounts" });
	assert.deepStrictEqual(lines(), ["POST " + TOKEN_URL, "GET " + USER_ME]);
	assert.deepStrictEqual(form(requests[0]), { client_id: Config.CLIENT_ID, client_secret: "test-secret",
		grant_type: "authorization_code", code: "CODE", redirect_uri: Config.REDIRECT_URI, code_verifier: "VERIFIER" });
	assert.strictEqual(requests[1].headers.Authorization, "Bearer AT");
	assert.strictEqual(r.username, "me@example.test");
	assert.strictEqual(r.alias, "Me Myself");
	assert.strictEqual(r.credentials.common.accessToken, "AT");
	assert.strictEqual(r.credentials.common.refreshToken, "RT");
}));

test("checkCredentials: /user/me with the given token; email or account, alias or descr", async () => {
	const { call } = start([["GET", /\/user\/me/, (q) => (q.headers.Authorization === "Bearer good"
		? ok({ account: "acct", descr: "Descr", home: "/users/acct" }) : { status: 401, body: { code: "401", msg: "Unauthorized" } })]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "good" } } }, {}),
		{ returnValue: true, renewedCredentials: null, username: "acct", displayName: "Descr" });
	const bad = await call("checkCredentials", { credentials: { common: { accessToken: "bogus" } } }, {});
	assert.deepStrictEqual(bad, { returnValue: false, errorCode: "HIDRIVE_API_ERROR", errorText: "HiDrive answered HTTP 401: Unauthorized", status: 401 });
});

test("listFolder: GET /dir with the members fields; names and paths decoded, mtime in ms, a mime type", async () => {
	const { call, lines, requests } = start(scripted([[`GET ${listUrl("/users/me/Docs")}`,
		ok({ members: [DIR_META, { name: "a%20b.jpg", path: "/users/me/Docs/a%20b.jpg", type: "file", size: 12, mtime: 5 }] })]]).routes);
	const r = await call("listFolder", { accountId: "acc", path: "/users/me/Docs" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entries: [DIR_ENTRY,
		{ id: "/users/me/Docs/a b.jpg", type: "file", name: "a b.jpg", size: 12, modified: 5000,
			path: "/users/me/Docs/a b.jpg", mimeType: "image/jpeg" }] });
	assert.strictEqual(lines().length, 1);
	assert.strictEqual(requests[0].headers.Authorization, "Bearer tok");
});

test("listFolder: the root is the home from /user/me, asked once per token", async () => {
	const { call, lines } = start([["GET", /\/user\/me/, () => ok(ME)], ["GET", /\/dir\?/, () => ok({ members: [] })]]);
	for (const root of [{}, { folderId: "home" }, { path: "" }]) {
		assert.strictEqual((await call("listFolder", Object.assign({ accountId: "acc" }, root))).returnValue, true);
	}
	assert.deepStrictEqual(lines(), ["GET " + USER_ME, "GET " + listUrl("/users/me"), "GET " + listUrl("/users/me"), "GET " + listUrl("/users/me")]);
});

test("listFolder: a full page asks for the next one (limit=offset,count) until a short page", async () => {
	const member = (i) => ({ name: "f" + i, path: "/users/me/f" + i, type: "file", size: 1, mtime: 1 });
	const page = (from, n) => ({ members: Array.from({ length: n }, (x, i) => member(from + i)) });
	const { call, lines } = start(scripted([
		[`GET ${listUrl("/users/me/Big")}`, ok(page(0, 5000))],
		[`GET ${listUrl("/users/me/Big", 5000)}`, ok(page(5000, 3))],
	]).routes);
	const r = await call("listFolder", { accountId: "acc", path: "/users/me/Big" });
	assert.strictEqual(r.entries.length, 5003);
	assert.strictEqual(r.entries[5002].id, "/users/me/f5002");
	assert.strictEqual(lines().length, 2);
});

test("a 401: refresh with the refresh token and the client secret, retry, save and report the new token", () => withSecret(async () => {
	const { call, requests, written, lines } = start([
		["POST", /\/dir\?/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ok({ access_token: "tok2", refresh_token: "ref2", expires_in: 3600 })],
		["POST", /\/dir\?/, (q) => (q.headers.Authorization === "Bearer tok2" ? ok({ name: "X", path: "/users/me/X", type: "dir" }, 201) : { status: 401 })],
	]);
	const r = await call("createFolder", { accountId: "acc", path: "/users/me", name: "X" });
	assert.strictEqual(r.entry.path, "/users/me/X");
	assert.deepStrictEqual(lines(), [`POST ${API}/dir?path=${enc("/users/me/X")}`, "POST " + TOKEN_URL, `POST ${API}/dir?path=${enc("/users/me/X")}`]);
	assert.deepStrictEqual(form(requests[1]), { client_id: Config.CLIENT_ID, client_secret: "test-secret", grant_type: "refresh_token", refresh_token: "ref" });
	assert.deepStrictEqual(requests.filter((q) => q.url.startsWith(API)).map((q) => q.headers.Authorization), ["Bearer tok", "Bearer tok2"]);
	assert.strictEqual(r.renewedCredentials.accessToken, "tok2");
	assert.deepStrictEqual(written, [{ accountId: "acc", name: "common", credentials: r.renewedCredentials }]);
}));

test("createFolder in the home: /user/me, then POST /dir with the full path", async () => {
	const t = scripted([["GET " + USER_ME, ok(ME)], [`POST ${API}/dir?path=${enc("/users/me/New Folder")}`, ok(DIR_META, 201)]]);
	const { call, requests } = start(t.routes);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", name: "New Folder" }), { returnValue: true, renewedCredentials: null, entry: DIR_ENTRY });
	assert.deepStrictEqual(requests.map((q) => q.headers.Authorization), ["Bearer tok", "Bearer tok"]);
	assert.strictEqual(t.left.length, 0);
});

test("createFolder in a path parent goes straight to POST /dir; a reply without name/path falls back", async () => {
	const { call } = start(scripted([[`POST ${API}/dir?path=${enc("/users/me/Docs/Sub")}`, ok({ type: "dir", mtime: 2 }, 201)]]).routes);
	assert.deepStrictEqual((await call("createFolder", { accountId: "acc", path: "/users/me/Docs/", name: "Sub" })).entry,
		{ id: "/users/me/Docs/Sub", type: "folder", name: "Sub", size: 0, modified: 2000, path: "/users/me/Docs/Sub", mimeType: "application/x-directory" });
});

test("createFolder: 409 (exists) is a failure, with HiDrive's message", async () => {
	const { call } = start(scripted([[`POST ${API}/dir?path=${enc("/users/me/X")}`, ok({ code: "409", msg: "Conflict: exists" }, 409)]]).routes);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", path: "/users/me", name: "X" }),
		{ returnValue: false, errorCode: "HIDRIVE_API_ERROR", errorText: "HiDrive answered HTTP 409: Conflict: exists", status: 409 });
});

test("moveItem rename only: GET /meta for the type, then POST /file/rename", async () => {
	const t = scripted([
		["GET " + metaUrl("/users/me/Docs/a.pdf"), ok({ type: "file" })],
		[`POST ${API}/file/rename?path=${enc("/users/me/Docs/a.pdf")}&name=${enc("b c.pdf")}`, ok(FILE_META("/users/me/Docs/b c.pdf"), 201)],
	]);
	const { call } = start(t.routes);
	assert.deepStrictEqual(await call("moveItem", { accountId: "acc", path: "/users/me/Docs/a.pdf", name: "b c.pdf" }),
		{ returnValue: true, renewedCredentials: null, entry: fileEntry("/users/me/Docs/b c.pdf") });
	assert.strictEqual(t.left.length, 0);
});

test("moveItem rename only of a directory uses /dir/rename", async () => {
	const t = scripted([
		["GET " + metaUrl("/users/me/Old"), ok({ type: "dir" })],
		[`POST ${API}/dir/rename?path=${enc("/users/me/Old")}&name=New%20Folder`, ok(DIR_META)],
	]);
	const { call } = start(t.routes);
	assert.deepStrictEqual((await call("moveItem", { accountId: "acc", fileId: "/users/me/Old", name: "New Folder" })).entry, DIR_ENTRY);
	assert.strictEqual(t.left.length, 0);
});

test("moveItem move only of a directory to the root: dst is the home path plus the old leaf", async () => {
	const t = scripted([
		["GET " + metaUrl("/users/me/Docs/New Folder"), ok({ type: "dir" })],
		["GET " + USER_ME, ok(ME)],
		[`POST ${API}/dir/move?src=${enc("/users/me/Docs/New Folder")}&dst=${enc("/users/me/New Folder")}`, ok(DIR_META)],
	]);
	const { call } = start(t.routes);
	assert.deepStrictEqual((await call("moveItem", { accountId: "acc", path: "/users/me/Docs/New Folder", toRoot: true })).entry, DIR_ENTRY);
	assert.strictEqual(t.left.length, 0);
});

test("moveItem move and rename at once: one POST /file/move to the new full path", async () => {
	const t = scripted([
		["GET " + metaUrl("/users/me/a.pdf"), ok({ type: "file" })],
		[`POST ${API}/file/move?src=${enc("/users/me/a.pdf")}&dst=${enc("/users/me/Docs/z.pdf")}`, ok(FILE_META("/users/me/Docs/z.pdf"))],
	]);
	const { call } = start(t.routes);
	assert.deepStrictEqual((await call("moveItem", { accountId: "acc", path: "/users/me/a.pdf", toPath: "/users/me/Docs", name: "z.pdf" })).entry,
		fileEntry("/users/me/Docs/z.pdf"));
	assert.strictEqual(t.left.length, 0);
});

test("moveItem: a failed type lookup or a 409 on the move is the failure; nothing more is sent", async () => {
	let t = start(scripted([["GET " + metaUrl("/users/me/gone"), ok({ code: "404" }, 404)]]).routes);
	let r = await t.call("moveItem", { accountId: "acc", path: "/users/me/gone", name: "x" });
	assert.strictEqual(r.errorCode, "HIDRIVE_API_ERROR");
	assert.strictEqual(r.status, 404);
	assert.strictEqual(t.requests.length, 1);
	t = start(scripted([
		["GET " + metaUrl("/users/me/a"), ok({ type: "file" })],
		[`POST ${API}/file/move?src=${enc("/users/me/a")}&dst=${enc("/users/me/D/a")}`, ok({ code: "409" }, 409)],
	]).routes);
	r = await t.call("moveItem", { accountId: "acc", path: "/users/me/a", toPath: "/users/me/D" });
	assert.strictEqual(r.status, 409);
	assert.strictEqual(r.errorCode, "HIDRIVE_API_ERROR");
});

test("moveItem: after a refresh on the type lookup the move goes out with the new token, refreshed once", async () => {
	const { call, requests, written } = start([
		["GET", /\/meta\?/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ok({ access_token: "tok2", expires_in: 3600 })],
		["GET", /\/meta\?/, () => ok({ type: "file" })],
		["POST", /\/file\/rename\?/, () => ok({ name: "b", path: "/users/me/b", type: "file" }, 201)],
	]);
	const r = await call("moveItem", { accountId: "acc", path: "/users/me/a", name: "b" });
	assert.strictEqual(r.entry.path, "/users/me/b");
	assert.deepStrictEqual(requests.filter((q) => q.url.startsWith(API)).map((q) => q.headers.Authorization), ["Bearer tok", "Bearer tok2", "Bearer tok2"]);
	assert.strictEqual(requests.filter((q) => /oauth2\/token$/.test(q.url)).length, 1);
	assert.strictEqual(written.length, 1);
});

test("deleteItem: a file through DELETE /file, a directory recursively through DELETE /dir; never the root", async () => {
	let t = scripted([["GET " + metaUrl("/users/me/a b.pdf"), ok({ type: "file" })], [`DELETE ${API}/file?path=${enc("/users/me/a b.pdf")}`, { status: 204 }]]);
	let s = start(t.routes);
	assert.deepStrictEqual(await s.call("deleteItem", { accountId: "acc", path: "/users/me/a b.pdf" }), { returnValue: true, renewedCredentials: null });
	assert.strictEqual(t.left.length, 0);
	t = scripted([["GET " + metaUrl("/users/me/D"), ok({ type: "dir" })], [`DELETE ${API}/dir?path=${enc("/users/me/D")}&recursive=true`, { status: 204 }]]);
	s = start(t.routes);
	assert.strictEqual((await s.call("deleteItem", { accountId: "acc", fileId: "/users/me/D" })).returnValue, true);
	assert.strictEqual(t.left.length, 0);
	for (const root of ["home", "/", "root"]) { assert.strictEqual((await s.call("deleteItem", { accountId: "acc", path: root })).errorCode, "BAD_ARGS"); }
	assert.strictEqual(s.requests.length, 2);
});

test("deleteItem: a refused delete is a failure", async () => {
	const { call } = start(scripted([["GET " + metaUrl("/users/me/D"), ok({ type: "dir" })],
		[`DELETE ${API}/dir?path=${enc("/users/me/D")}&recursive=true`, ok({ code: "403", msg: "Forbidden" }, 403)]]).routes);
	const r = await call("deleteItem", { accountId: "acc", path: "/users/me/D" });
	assert.strictEqual(r.errorCode, "HIDRIVE_API_ERROR");
	assert.strictEqual(r.status, 403);
});

test("downloadFile: GET /file?path= with the token, the bytes to localPath (folders 0755)", async () => {
	const BYTES = crypto.randomBytes(70000);
	const { call, lines, requests } = start([["GET", /\/file\?/, () => new Response(BYTES, { status: 200 })]]);
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { accountId: "acc", fileId: "/users/me/Café 100%.pdf", localPath: dest }),
		{ returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.deepStrictEqual(lines(), [`GET ${API}/file?path=${enc("/users/me/Café 100%.pdf")}`]);
	assert.strictEqual(requests[0].headers.Authorization, "Bearer tok");
});

test("downloadFile: a 404 is HIDRIVE_DOWNLOAD_FAILED and writes no file", async () => {
	const { call } = start([["GET", /\/file\?/, () => ok({ code: "404", msg: "Not Found" }, 404)]]);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", path: "/users/me/gone", localPath: dest });
	assert.strictEqual(r.errorCode, "HIDRIVE_DOWNLOAD_FAILED");
	assert.strictEqual(r.status, 404);
	assert.ok(!fs.existsSync(dest));
	assert.ok(!fs.existsSync(dest + ".part"));
});

test("uploadFile: PUT /file?dir=&name= with the file as the body; the reply's path and name decoded, as listFolder's", async () => {
	const { call, lines, requests } = start([["PUT", /\/file\?/, () => ok({ name: "a%20b.txt", path: "/users/me/Docs/a%20b.txt", size: 3 }, 201)]]);
	const r = await call("uploadFile", { accountId: "acc", path: "/users/me/Docs", localPath: LOCAL, name: "a b.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "a b.txt", id: "/users/me/Docs/a b.txt", size: 3 });
	assert.deepStrictEqual(lines(), [`PUT ${API}/file?dir=${enc("/users/me/Docs")}&name=${enc("a b.txt")}`]);
	assert.strictEqual(requests[0].headers["Content-Type"], "application/octet-stream");
	assert.strictEqual(requests[0].headers.Authorization, "Bearer tok");
	assert.strictEqual(requests[0].body.blob, LOCAL_BYTES.length, "a Blob of the file, streamed by fetch");
});

test("uploadFile: the home by default, the local name by default, a leading slash dropped; a reply without a path", async () => {
	const { call, lines } = start([["GET", /\/user\/me/, () => ok(ME)], ["PUT", /\/file\?/, () => ok({}, 201)]]);
	assert.deepStrictEqual(await call("uploadFile", { accountId: "acc", localPath: LOCAL }),
		{ returnValue: true, renewedCredentials: null, name: "local.bin", id: "/users/me/local.bin" });
	await call("uploadFile", { accountId: "acc", path: "/users/me/Docs/", localPath: LOCAL, name: "/c.txt" });
	assert.deepStrictEqual(lines(), ["GET " + USER_ME, `PUT ${API}/file?dir=${enc("/users/me")}&name=local.bin`,
		`PUT ${API}/file?dir=${enc("/users/me/Docs/")}&name=c.txt`]);
});

test("uploadFile replace:true: the file's own folder and name", async () => {
	const { call, lines } = start([["PUT", /\/file\?/, () => ok({ name: "r.pdf", path: "/users/me/Docs/r.pdf", size: 9 })]]);
	const r = await call("uploadFile", { accountId: "acc", fileId: "/users/me/Docs/r.pdf", localPath: LOCAL, replace: true });
	assert.strictEqual(r.id, "/users/me/Docs/r.pdf");
	await call("uploadFile", { accountId: "acc", path: "/top.pdf", localPath: LOCAL, replace: true });
	assert.deepStrictEqual(lines(), [`PUT ${API}/file?dir=${enc("/users/me/Docs")}&name=r.pdf`, `PUT ${API}/file?dir=${enc("/")}&name=top.pdf`]);
});

test("uploadFile: a local file that is not there is LOCAL_FILE_ERROR, and nothing is sent", async () => {
	const { call, requests } = start([["PUT", /./, () => ok({})]]);
	const r = await call("uploadFile", { accountId: "acc", path: "/users/me", localPath: path.join(TMP, "nope.bin") });
	assert.strictEqual(r.errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual(requests.length, 0);
});

// --- Photos ----------------------------------------------------------------------------------

const img = (p) => ({ name: enc(p.split("/").pop()), path: p.split("/").map(enc).join("/"), type: "file", size: 5, mtime: 1 });
const dir = (p) => ({ name: enc(p.split("/").pop()), path: p.split("/").map(enc).join("/"), type: "dir", mtime: 1 });

test("listAlbums: the home's images and each sub-folder with images, aid the encoded path", async () => {
	const listing = {
		"/users/me": [img("/users/me/a.jpg"), img("/users/me/b.TIFF"), img("/users/me/doc.pdf"), dir("/users/me/Holiday 2026"), dir("/users/me/Empty"), dir("/users/me/Broken")],
		"/users/me/Holiday 2026": [img("/users/me/Holiday 2026/x.png")],
		"/users/me/Empty": [img("/users/me/Empty/notes.txt")],
	};
	const { call, lines } = start([["GET", /\/user\/me/, () => ok(ME)], ["GET", /\/dir\?/, (q) => {
		const p = new URL(q.url).searchParams.get("path");
		return listing[p] ? ok({ members: listing[p] }) : ok({ code: "403" }, 403);
	}]]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS), { returnValue: true, albums: [
		{ aid: "%2Fusers%2Fme", name: "HiDrive", size: { images: 2 } },
		{ aid: enc("/users/me/Holiday 2026"), name: "Holiday 2026", size: { images: 1 } }] });
	assert.deepStrictEqual(lines(), ["GET " + USER_ME, "GET " + listUrl("/users/me"), "GET " + listUrl("/users/me/Holiday 2026"),
		"GET " + listUrl("/users/me/Empty"), "GET " + listUrl("/users/me/Broken")]);
});

test("listAlbums: no images anywhere, or the home not found, is one empty album; no credentials is an error", async () => {
	let s = start([["GET", /\/user\/me/, () => ok(ME)], ["GET", /\/dir\?/, () => ok({ members: [] })]]);
	const empty = { returnValue: true, albums: [{ aid: "", name: "Camera Uploads", size: { images: 0 } }] };
	assert.deepStrictEqual(await s.call("listAlbums", { accountId: "acc" }, PHOTOS), empty);
	s = start([["GET", /\/user\/me/, () => ok({}, 500)]]);
	assert.deepStrictEqual(await s.call("listAlbums", { accountId: "acc" }, PHOTOS), empty);
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: the decoded aid listed; one token link per image, no request for it", async () => {
	const { call, lines } = start([["GET", /\/dir\?/, () => ok({ members: [img("/users/me/Hol/a b.jpg"), img("/users/me/Hol/n.txt"), dir("/users/me/Hol/s.jpg")] })]]);
	const r = await call("listPhotos", { accountId: "acc", aid: enc("/users/me/Hol") }, PHOTOS);
	const link = `${API}/file?path=${enc("/users/me/Hol/a b.jpg")}&access_token=tok`;
	assert.deepStrictEqual(r, { returnValue: true, photos: [{ pid: "/users/me/Hol/a b.jpg", src_big: link, src_small: link,
		caption: "a b.jpg", type: "image", fileName: "a b.jpg" }] });
	assert.deepStrictEqual(lines(), ["GET " + listUrl("/users/me/Hol")]);
});

test("listPhotos: no aid is no photos and no request; the listing failing fails the call", async () => {
	const { call, requests } = start([["GET", /\/dir\?/, () => ok({}, 500)]]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "" }, PHOTOS), { returnValue: true, photos: [] });
	assert.strictEqual(requests.length, 0);
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: "%2Fx" }, PHOTOS)).errorCode, "HIDRIVE_API_ERROR");
});

test("upload (Photos): into the album listAlbums named (its encoded aid), or home/Camera Uploads, made first", async () => {
	const { call, lines } = start([["GET", /\/user\/me/, () => ok(ME)],
		["POST", /\/dir\?/, () => ok({ code: "409" }, 409)],
		["PUT", /\/file\?/, (q) => ok({ name: "local.bin", path: new URL(q.url).searchParams.get("dir").split("/").map(enc).join("/") + "/local.bin", size: 5000 }, 201)]]);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: enc("/users/me/Holiday 2026"), path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "/users/me/Holiday 2026/local.bin", name: "local.bin", size: 5000 });
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: "", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "/users/me/Camera Uploads/local.bin", name: "local.bin", size: 5000 });
	assert.deepStrictEqual(lines(), [`PUT ${API}/file?dir=${enc("/users/me/Holiday 2026")}&name=local.bin`,
		"GET " + USER_ME, `POST ${API}/dir?path=${enc("/users/me/Camera Uploads")}`, `PUT ${API}/file?dir=${enc("/users/me/Camera Uploads")}&name=local.bin`]);
});

test("upload (Photos): an album folder that cannot be made is HIDRIVE_MKDIR_FAILED and nothing is uploaded", async () => {
	const { call, requests } = start([["GET", /\/user\/me/, () => ok(ME)], ["POST", /\/dir\?/, () => ok({}, 507)], ["PUT", /./, () => ok({})]]);
	const r = await call("upload", { accountId: "acc", path: LOCAL }, PHOTOS);
	assert.strictEqual(r.errorCode, "HIDRIVE_MKDIR_FAILED");
	assert.strictEqual(r.status, 507);
	assert.strictEqual(requests.length, 2);
});

test("deletePhoto: DELETE /file?path= with the pid; a refusal is HIDRIVE_DELETE_FAILED", async () => {
	let s = start([["DELETE", /\/file\?/, () => ({ status: 204 })]]);
	assert.deepStrictEqual(await s.call("deletePhoto", { accountId: "acc", pid: "/users/me/a b.jpg" }, PHOTOS), { returnValue: true, pid: "/users/me/a b.jpg" });
	assert.deepStrictEqual(s.lines(), [`DELETE ${API}/file?path=${enc("/users/me/a b.jpg")}`]);
	s = start([["DELETE", /\/file\?/, () => ok({}, 403)]]);
	const r = await s.call("deletePhoto", { accountId: "acc", pid: "/users/me/a.jpg" }, PHOTOS);
	assert.strictEqual(r.errorCode, "HIDRIVE_DELETE_FAILED");
	assert.strictEqual(r.status, 403);
});

// --- every request failing, in turn ----------------------------------------------------------

// What HiDrive answers when nothing fails.
function happy(q) {
	const u = q.url;
	if (/oauth2\/token$/.test(u)) { return ok({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }); }
	if (/\/user\/me\?/.test(u)) { return ok(ME); }
	if (/\/meta\?/.test(u)) { return ok({ type: "file" }); }
	if (q.method === "GET" && /\/dir\?/.test(u)) { return ok({ members: [img("/users/me/a.jpg"), dir("/users/me/Sub")] }); }
	if (q.method === "GET" && /\/file\?/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (q.method === "PUT") { return ok({ name: "n", path: "/users/me/n", size: 1 }, 201); }
	if (q.method === "DELETE") { return { status: 204 }; }
	return ok({ name: "m", path: "/users/me/m", type: "file" }, 201);
}

// How the failing request fails. "401" is an expired token whose refresh is refused too.
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
	["listFolder", { accountId: "acc" }, DOCS, { minSteps: 2 }],
	["listFolder (a path)", { accountId: "acc", path: "/users/me/x" }, DOCS],
	["downloadFile", () => ({ accountId: "acc", fileId: "/users/me/a.jpg", localPath: dl() }), DOCS, { tolerated: (k, m) => m === NOT_JSON }],
	["uploadFile", { accountId: "acc", localPath: LOCAL }, DOCS, { minSteps: 2 }],
	["uploadFile (replace)", { accountId: "acc", fileId: "/users/me/a.jpg", localPath: LOCAL, replace: true }, DOCS],
	["createFolder", { accountId: "acc", name: "n" }, DOCS, { minSteps: 2 }],
	["moveItem (rename)", { accountId: "acc", path: "/users/me/a.jpg", name: "b.jpg" }, DOCS, { minSteps: 2 }],
	["moveItem (move)", { accountId: "acc", path: "/users/me/a.jpg", toPath: "/users/me/d" }, DOCS, { minSteps: 2 }],
	["moveItem (to the root)", { accountId: "acc", path: "/users/me/d/a.jpg", toRoot: true }, DOCS, { minSteps: 3 }],
	["deleteItem", { accountId: "acc", path: "/users/me/a.jpg" }, DOCS, { minSteps: 2 }],
	["checkCredentials", { credentials: { common: { accessToken: "tok", refreshToken: "ref" } } }, {}],
	["exchangeCode", { code: "c", codeVerifier: "v" }, {}, { minSteps: 2, tolerated: (k) => k >= 2 }],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS, { minSteps: 3, tolerated: (k, m) => k === 2 && m === NOT_JSON }],
	["upload (an album)", { accountId: "acc", albumId: "%2Fusers%2Fme%2FSub", path: LOCAL }, PHOTOS],
	["deletePhoto", { accountId: "acc", pid: "/users/me/a.jpg" }, PHOTOS, { tolerated: (k, m) => m === NOT_JSON }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 3, tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: "%2Fusers%2Fme" }, PHOTOS],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`hidrive ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const refreshAfter401 = mode.startsWith("a 401");
				const answer = (q) => {
					n++;
					if (n === k) { return fail(q); }
					if (refreshAfter401 && n > k && /oauth2\/token$/.test(q.url)) { return { status: 400, body: { error: "invalid_grant" } }; }
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
	for (const [retry, code] of [[() => ({ status: 500, body: "{}" }), "HIDRIVE_API_ERROR"], [() => { throw new Error("reset"); }, "CURL_FAILED"]]) {
		const { call, written } = start([
			["GET", /\/dir\?/, () => ({ status: 401 }), { once: true }],
			["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 60 } })],
			["GET", /\/dir\?/, (q) => { assert.strictEqual(q.headers.Authorization, "Bearer tok2"); return retry(); }],
		]);
		const r = await call("listFolder", { accountId: "acc", path: "/users/me/x" });
		assert.strictEqual(r.errorCode, code);
		assert.deepStrictEqual(written.map((w) => [w.accountId, w.name, w.credentials.accessToken]), [["acc", "common", "tok2"]]);
	}
});

test("the Accounts service failing or not answering is one error reply", async () => {
	const denied = start([], { onCall: () => ({ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" }) });
	assert.deepStrictEqual(await denied.call("listFolder", { accountId: "acc" }),
		{ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" });
	const broken = start([], { onCall: () => "not json" });
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", path: "/users/me/a" })).errorCode, "BUS_BAD_REPLY");
});
