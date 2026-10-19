// node --test tests/unit
// The Koofr connector (cloud/koofr/service/com.palm.service.koofr) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (endpoint, method, headers, body), its reply, and its errors; the Accounts
// service is answered by the stand-in bus. The file-operation cases are those of the old
// koofr-fileops.test.js (rename vs move, the KOOFR_EXISTS probe, the mount id kept on renewed
// credentials), now through the bus.
//
// The last part fails every request of every method in turn, in each way a request can fail,
// and checks the method still answers exactly once, with an error (or with what the method
// makes of the failure, where it absorbs one).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/koofr/service/com.palm.service.koofr");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const API = "https://app.koofr.net/api/v2";
const CONTENT = "https://app.koofr.net/content/api/v2";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koofr-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(3000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const STORED = { accessToken: "tok1", refreshToken: "ref1", expiresAt: 1, mountId: "m1" };
const NO_MOUNT = { accessToken: "tok1", refreshToken: "ref1", expiresAt: 1 };
const q = encodeURIComponent;
const files = (op, p, mid = "m1") => `${API}/mounts/${mid}/files/${op}?path=${q(p)}`;

const DIR = { name: "New", type: "dir", modified: 1700000000000, size: 0, contentType: "" };
const FILE = { name: "b.txt", type: "file", modified: 1700000000001, size: 42, contentType: "text/plain" };
const DIR_ENTRY = (p) => ({ id: p, type: "folder", name: path.posix.basename(p), size: 0, modified: 1700000000000, path: p, mimeType: "application/x-directory" });
const FILE_ENTRY = (p) => ({ id: p, type: "file", name: path.posix.basename(p), size: 42, modified: 1700000000001, path: p, mimeType: "text/plain" });
const MOUNTS = { status: 200, body: { mounts: [{ id: "other" }, { id: "prim", isPrimary: true }] } };

// The service on a stand-in bus. Accounts: readCredentials gives `stored`, writeCredentials is
// recorded. routes: fakeFetch's, or a function (req) -> reply for every request.
function start(routes, { stored = STORED, onCall, timeouts } = {}) {
	if (typeof routes === "function") { routes = ["GET", "POST", "PUT", "DELETE"].map((m) => [m, /./, routes]); }
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
		call: (method, payload, caller = DOCS) => ask(handle, method, payload, caller) };
}
// A script: one reply per request, in order (each { status, body }); none left is a 599.
function script(replies) { return () => (replies.length ? replies.shift() : { status: 599, body: "unexpected" }); }
const ok = (body) => ({ status: 200, body: body === undefined ? "" : body });
const status = (s) => ({ status: s, body: "" });
const urls = (requests) => requests.map((r) => r.method + " " + r.url);

test("the service: its bus name, and every method the old services.json had (plus quit, info)", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.koofr");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "moveItem", "quit",
		"upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const gone of ["services.json", "sources.json", "commands"]) { assert.ok(!fs.existsSync(path.join(SVC, gone)), gone); }
});

test("caller rules: file methods for the FILE_APP_IDS, auth and photo methods open", async () => {
	const { call } = start(() => ok({ files: [], email: "e" }));
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
	assert.strictEqual((await call("getAuthorizeUrl", {}, { appId: "com.palm.app.accounts 99" })).returnValue, true);
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: "%2F" }, {})).returnValue, true);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: STORED } }, { service: "com.palm.service.accounts" })).returnValue, true);
});

test("getAuthorizeUrl: Koofr's consent URL with PKCE, scope public, state koofr", async () => {
	const { call } = start([]);
	const r = await call("getAuthorizeUrl", {}, {});
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://app.koofr.net/oauth2/auth");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: Config.CLIENT_ID,
		redirect_uri: "http://localhost/koofr/oauth2callback", scope: "public",
		code_challenge: crypto.createHash("sha256").update(r.codeVerifier).digest("base64url"), code_challenge_method: "S256",
		state: "koofr" });
	assert.match(r.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
});

test("exchangeCode: the token request (the secret once the build set it), then /user for the username", async () => {
	const { call, requests } = start([
		["POST", /oauth2\/token$/, () => ok({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "bearer" })],
		["GET", /\/user$/, () => ok({ email: "u@example.test", firstName: "U", lastName: "Ser" })],
	]);
	const r = await call("exchangeCode", { code: "CODE", codeVerifier: "VERIFIER" }, { service: "com.palm.service.accounts" });
	assert.deepStrictEqual(urls(requests), ["POST " + Config.TOKEN_URL, "GET " + API + "/user"]);
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[0].body)), { client_id: Config.CLIENT_ID,
		grant_type: "authorization_code", code: "CODE", redirect_uri: Config.REDIRECT_URI, code_verifier: "VERIFIER" },
		"a PLACEHOLDER secret is not sent");
	assert.strictEqual(requests[1].headers.Authorization, "Bearer AT");
	assert.strictEqual(requests[1].headers["X-Koofr-Version"], "2.1");
	assert.strictEqual(r.username, "u@example.test");
	assert.strictEqual(r.alias, "U Ser");
	assert.deepStrictEqual(Object.keys(r.credentials.common), ["accessToken", "refreshToken", "expiresAt"]);
	assert.strictEqual(r.credentials.common.accessToken, "AT");

	const saved = Config.CLIENT_SECRET;
	Config.CLIENT_SECRET = "built-in-value";   // as the build's sed leaves it
	try {
		const b = start([["POST", /oauth2\/token$/, () => ok({ access_token: "AT" })], ["GET", /\/user$/, () => ok({ email: "e" })]]);
		await b.call("exchangeCode", { code: "C", codeVerifier: "V" }, {});
		assert.strictEqual(new URLSearchParams(b.requests[0].body).get("client_secret"), "built-in-value");
	} finally { Config.CLIENT_SECRET = saved; }
});

test("checkCredentials: /user with the given token; the name, else the email, as displayName", async () => {
	const { call } = start([["GET", /\/user$/, (r) => (r.headers.Authorization === "Bearer good" ? ok({ email: "u@example.test" }) : status(401))]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "good" } } }, {}),
		{ returnValue: true, renewedCredentials: null, username: "u@example.test", displayName: "u@example.test" });
	const bad = await call("checkCredentials", { credentials: { common: { accessToken: "bogus" } } }, {});
	assert.deepStrictEqual([bad.errorCode, bad.status], ["KOOFR_API_ERROR", 401]);
});

test("listFolder: the primary mount first, then files/list; entries with full paths; X-Koofr-Version on every call", async () => {
	const { call, requests } = start([
		["GET", /\/mounts$/, () => MOUNTS],
		["GET", /files\/list/, () => ok({ files: [FILE, DIR, { name: "p.JPG", type: "file", size: 7, modified: 3 }] })],
	], { stored: NO_MOUNT });
	const r = await call("listFolder", { accountId: "acc", path: "/Docs" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entries: [FILE_ENTRY("/Docs/b.txt"), DIR_ENTRY("/Docs/New"),
		{ id: "/Docs/p.JPG", type: "file", name: "p.JPG", size: 7, modified: 3, path: "/Docs/p.JPG", mimeType: "image/jpeg" }] });
	assert.deepStrictEqual(urls(requests), ["GET " + API + "/mounts", "GET " + files("list", "/Docs", "prim")]);
	for (const x of requests) { assert.deepStrictEqual(x.headers, { "X-Koofr-Version": "2.1", Authorization: "Bearer tok1" }); }
});

test("listFolder: a known mount is not asked for; the root by nothing, '', '/', 'root'", async () => {
	const { call, requests } = start([["GET", /files\/list/, () => ok({ files: [] })]]);
	for (const root of [{}, { path: "" }, { path: "/" }, { folderId: "root" }]) {
		await call("listFolder", Object.assign({ accountId: "acc" }, root));
		assert.strictEqual(requests[requests.length - 1].url, files("list", "/"), JSON.stringify(root));
	}
	await call("listFolder", { accountId: "acc", folderId: "Docs" });
	assert.strictEqual(requests[requests.length - 1].url, files("list", "/Docs"));
	assert.strictEqual(requests.length, 5);
});

test("an account without mounts is KOOFR_NO_MOUNT", async () => {
	const { call } = start([["GET", /\/mounts$/, () => ok({ mounts: [] })]], { stored: NO_MOUNT });
	assert.strictEqual((await call("listFolder", { accountId: "acc" })).errorCode, "KOOFR_NO_MOUNT");
});

test("a 401 refreshes once, the rest of the chain uses the renewed token, saved with the mount id", async () => {
	const { call, requests, written } = start([
		["POST", /oauth2\/token$/, () => ok({ access_token: "tok2", refresh_token: "ref2", expires_in: 3600 })],
		["POST", /files\/folder/, () => status(401), { once: true }],
		["POST", /files\/folder/, () => ok()],
		["GET", /files\/info/, () => ok(DIR)],
	]);
	const r = await call("createFolder", { accountId: "acc", path: "/", name: "New" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(requests.map((x) => x.headers.Authorization || "token"), ["Bearer tok1", "token", "Bearer tok2", "Bearer tok2"]);
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[1].body)), { client_id: Config.CLIENT_ID, grant_type: "refresh_token", refresh_token: "ref1" });
	assert.strictEqual(r.renewedCredentials.accessToken, "tok2");
	assert.strictEqual(r.renewedCredentials.refreshToken, "ref2");
	assert.strictEqual(r.renewedCredentials.mountId, "m1");
	assert.deepStrictEqual(written, [{ accountId: "acc", name: "common", credentials: r.renewedCredentials }]);
});

test("a refresh while the mount is resolved leaves the mount id on the renewed credentials", async () => {
	const { call, requests, written } = start([
		["POST", /oauth2\/token$/, () => ok({ access_token: "tok2", expires_in: 3600 })],
		["GET", /\/mounts$/, () => status(401), { once: true }],
		["GET", /\/mounts$/, () => ok({ mounts: [{ id: "prim", isPrimary: true }] })],
		["POST", /files\/folder/, () => ok()],
		["GET", /files\/info/, () => ok(DIR)],
	], { stored: NO_MOUNT });
	const r = await call("createFolder", { accountId: "acc", name: "New" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(requests.map((x) => x.headers.Authorization || "token"), ["Bearer tok1", "token", "Bearer tok2", "Bearer tok2", "Bearer tok2"]);
	assert.strictEqual(requests[3].url, files("folder", "/", "prim"));
	assert.strictEqual(written.length, 1);
	assert.strictEqual(written[0].credentials.mountId, "prim");
	assert.strictEqual(written[0].credentials.refreshToken, "ref1");
});

test("a 401 whose refresh fails: the refresh's error, nothing saved, no retry", async () => {
	const { call, requests, written } = start([
		["GET", /files\/list/, () => status(401)],
		["POST", /oauth2\/token$/, () => ({ status: 400, body: { error: "invalid_grant" } })],
	]);
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.errorCode, "OAUTH_TOKEN_FAILED");
	assert.match(r.errorText, /invalid_grant/);
	assert.strictEqual(requests.length, 2);
	assert.deepStrictEqual(written, []);
});

test("downloadFile: content files/get with the path, the bytes to localPath; a failure is KOOFR_DOWNLOAD_FAILED and no file", async () => {
	const BYTES = crypto.randomBytes(50000);
	const { call, requests } = start([["GET", /content\/api\/v2\/mounts\/m1\/files\/get\?path=%2FDocs%2Fa%2Fgood/, () => new Response(BYTES, { status: 200 })],
		["GET", /files\/get/, () => ({ status: 404, body: { error: { code: "NotFound", message: "File not found" } } })]]);
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { accountId: "acc", fileId: "/Docs/a/good é.bin", localPath: dest }),
		{ returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.strictEqual(requests[0].url, `${CONTENT}/mounts/m1/files/get?path=${q("/Docs/a/good é.bin")}`);
	assert.strictEqual(requests[0].headers.Authorization, "Bearer tok1");
	const gone = dl();
	const r = await call("downloadFile", { accountId: "acc", path: "/gone", localPath: gone });
	assert.deepStrictEqual([r.errorCode, r.status, r.errorText], ["KOOFR_DOWNLOAD_FAILED", 404, "Koofr answered HTTP 404: File not found"]);
	assert.ok(!fs.existsSync(gone));
});

test("uploadFile: content files/put into the folder, overwrite; the name in the URL and the multipart part's filename", async () => {
	const { call, requests } = start([["POST", /files\/put/, () => ok({ name: "Notes é.txt", size: 3000 })]]);
	const r = await call("uploadFile", { accountId: "acc", path: "/Docs", localPath: LOCAL, name: "Notes é.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Notes é.txt", id: "/Docs/Notes é.txt", size: 3000 });
	const x = requests[0];
	assert.strictEqual(x.url, `${CONTENT}/mounts/m1/files/put?path=${q("/Docs")}&filename=${q("Notes é.txt")}&info=true&overwrite=true`);
	assert.strictEqual(x.headers.Authorization, "Bearer tok1");
	assert.strictEqual(x.headers["X-Koofr-Version"], "2.1");
	assert.deepStrictEqual(x.body.form.map(([k, v]) => [k, v.name, v.size]), [["file", "Notes é.txt", LOCAL_BYTES.length]]);
});

test("uploadFile: the root, the local name by default; replace:true puts into the file's folder under its name", async () => {
	const { call, requests } = start([["POST", /files\/put/, () => ok({})]]);
	await call("uploadFile", { accountId: "acc", folderId: "root", localPath: LOCAL, name: "b.txt" });
	await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	const r = await call("uploadFile", { accountId: "acc", fileId: "/Docs/Report.pdf", localPath: LOCAL, replace: true });
	assert.deepStrictEqual(requests.map((x) => { const u = new URL(x.url); return [u.searchParams.get("path"), u.searchParams.get("filename"), x.body.form[0][1].name]; }),
		[["/", "b.txt", "b.txt"], ["/", "local.bin", "local.bin"], ["/Docs", "Report.pdf", "Report.pdf"]]);
	assert.deepStrictEqual([r.id, r.name], ["/Docs/Report.pdf", "Report.pdf"]);
});

test("uploadFile: a local file that is not there is LOCAL_FILE_ERROR, and nothing is sent", async () => {
	const { call, requests } = start(() => ok({}));
	assert.strictEqual((await call("uploadFile", { accountId: "acc", localPath: path.join(TMP, "nope.bin") })).errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual(requests.length, 0);
});

test("createFolder posts the name to files/folder and answers with listFolder's entry", async () => {
	const { call, requests } = start(script([ok(), ok(DIR)]));
	const r = await call("createFolder", { accountId: "acc", path: "/Docs", name: "New" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: DIR_ENTRY("/Docs/New") });
	assert.deepStrictEqual(urls(requests), ["POST " + files("folder", "/Docs"), "GET " + files("info", "/Docs/New")]);
	assert.strictEqual(requests[0].body, JSON.stringify({ name: "New" }));
	assert.strictEqual(requests[0].headers["Content-Type"], "application/json");
	assert.strictEqual(requests[0].headers.Authorization, "Bearer tok1");
	assert.strictEqual(requests[0].headers["X-Koofr-Version"], "2.1");
	// The same object through listFolder gives the same entry.
	const lf = start([["GET", /files\/list/, () => ok({ files: [DIR] })]]);
	assert.deepStrictEqual((await lf.call("listFolder", { accountId: "acc", path: "/Docs" })).entries[0], r.entry);
});

test("createFolder at the mount root, by '/', 'root' or nothing; a bad name is refused unsent", async () => {
	for (const root of [{ path: "/" }, { folderId: "root" }, { path: "" }, {}]) {
		const { call, requests } = start(script([ok(), ok(DIR)]));
		const r = await call("createFolder", Object.assign({ accountId: "acc", name: "New" }, root));
		assert.strictEqual(r.entry.path, "/New", JSON.stringify(root));
		assert.deepStrictEqual(urls(requests), ["POST " + files("folder", "/"), "GET " + files("info", "/New")]);
	}
	const { call, requests } = start(script([]));
	assert.strictEqual((await call("createFolder", { accountId: "acc", name: "a/b" })).errorCode, "MISSING_ARGS");
	assert.strictEqual(requests.length, 0);
});

test("createFolder: a refused create fails with KOOFR_API_ERROR and asks nothing more", async () => {
	const { call, requests } = start(script([{ status: 409, body: { error: { code: "AlreadyExists", message: "Folder exists" } } }]));
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", path: "/Docs", name: "New" }),
		{ returnValue: false, errorCode: "KOOFR_API_ERROR", errorText: "Koofr answered HTTP 409: Folder exists", status: 409 });
	assert.strictEqual(requests.length, 1);
});

test("createFolder resolves the primary mount first when the credentials lack it", async () => {
	const { call, requests } = start(script([MOUNTS, ok(), ok(DIR)]), { stored: NO_MOUNT });
	assert.strictEqual((await call("createFolder", { accountId: "acc", name: "New" })).entry.path, "/New");
	assert.deepStrictEqual(urls(requests), ["GET " + API + "/mounts", "POST " + files("folder", "/", "prim"), "GET " + files("info", "/New", "prim")]);
});

test("moveItem with a name only renames in place, after a probe that finds nothing there", async () => {
	const { call, requests } = start(script([status(404), ok(), ok(FILE)]));
	const r = await call("moveItem", { accountId: "acc", path: "/Docs/a.txt", name: "b.txt" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: FILE_ENTRY("/Docs/b.txt") });
	assert.deepStrictEqual(urls(requests), ["GET " + files("info", "/Docs/b.txt"), "PUT " + files("rename", "/Docs/a.txt"), "GET " + files("info", "/Docs/b.txt")]);
	assert.strictEqual(requests[1].body, JSON.stringify({ name: "b.txt" }));
	assert.strictEqual(requests[1].headers["Content-Type"], "application/json");
});

test("moveItem to the folder it is in, with a name, is a rename too", async () => {
	const { call, requests } = start(script([status(404), ok(), ok(FILE)]));
	await call("moveItem", { accountId: "acc", path: "/Docs/a.txt", toPath: "/Docs/", name: "b.txt" });
	assert.strictEqual(requests[1].method + " " + requests[1].url, "PUT " + files("rename", "/Docs/a.txt"));
});

test("moveItem with a folder only moves under the same name; to the root with toRoot", async () => {
	let k = start(script([status(404), ok(), ok(Object.assign({}, FILE, { name: "a.txt" }))]));
	const r = await k.call("moveItem", { accountId: "acc", path: "/Docs/a.txt", toPath: "/Other" });
	assert.strictEqual(r.entry.path, "/Other/a.txt");
	assert.deepStrictEqual(urls(k.requests), ["GET " + files("info", "/Other/a.txt"), "PUT " + files("move", "/Docs/a.txt"), "GET " + files("info", "/Other/a.txt")]);
	assert.strictEqual(k.requests[1].body, JSON.stringify({ toMountId: "m1", toPath: "/Other/a.txt" }));
	k = start(script([status(404), ok(), ok(FILE)]));
	await k.call("moveItem", { accountId: "acc", path: "/Docs/a.txt", toRoot: true });
	assert.strictEqual(k.requests[1].body, JSON.stringify({ toMountId: "m1", toPath: "/a.txt" }));
});

test("moveItem with a folder and a name moves and renames in one move; a folder answers with a folder entry", async () => {
	let k = start(script([status(404), ok(), ok(FILE)]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", path: "/Docs/a.txt", toPath: "/", name: "b.txt" })).entry.path, "/b.txt");
	assert.strictEqual(k.requests.length, 3);
	assert.strictEqual(k.requests[1].url, files("move", "/Docs/a.txt"));
	assert.strictEqual(k.requests[1].body, JSON.stringify({ toMountId: "m1", toPath: "/b.txt" }));
	k = start(script([status(404), ok(), ok(DIR)]));
	const r = await k.call("moveItem", { accountId: "acc", path: "/Docs/Old", toPath: "/Other", name: "New" });
	assert.deepStrictEqual(r.entry, DIR_ENTRY("/Other/New"));
	assert.strictEqual(k.requests[1].body, JSON.stringify({ toMountId: "m1", toPath: "/Other/New" }));
});

test("moveItem refuses an existing destination (KOOFR_EXISTS, 409) and does not touch it", async () => {
	const { call, requests } = start(script([ok(FILE)]));
	const r = await call("moveItem", { accountId: "acc", path: "/Docs/a.txt", name: "b.txt" });
	assert.deepStrictEqual([r.returnValue, r.errorCode, r.status], [false, "KOOFR_EXISTS", 409]);
	assert.strictEqual(requests.length, 1);
});

test("moveItem lets a change of case through only when the probe finds the item itself", async () => {
	let k = start(script([ok(Object.assign({}, FILE, { name: "a.txt" })), ok(), ok(Object.assign({}, FILE, { name: "A.txt" }))]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", path: "/Docs/a.txt", name: "A.txt" })).entry.path, "/Docs/A.txt");
	assert.strictEqual(k.requests[1].url, files("rename", "/Docs/a.txt"));
	k = start(script([ok(Object.assign({}, FILE, { name: "A.txt" }))]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", path: "/Docs/a.txt", name: "A.txt" })).errorCode, "KOOFR_EXISTS");
	assert.strictEqual(k.requests.length, 1);
});

test("moveItem: a probe or move that fails is KOOFR_API_ERROR with the status", async () => {
	let k = start(script([status(500)]));
	assert.deepStrictEqual(((r) => [r.errorCode, r.status])(await k.call("moveItem", { accountId: "acc", path: "/a", name: "b" })), ["KOOFR_API_ERROR", 500]);
	assert.strictEqual(k.requests.length, 1);
	k = start(script([status(404), status(404)]));
	assert.deepStrictEqual(((r) => [r.errorCode, r.status])(await k.call("moveItem", { accountId: "acc", path: "/a", toPath: "/x" })), ["KOOFR_API_ERROR", 404]);
	assert.strictEqual(k.requests.length, 2);
});

test("moveItem onto itself only reads it back; root and into-itself are refused unsent", async () => {
	let k = start(script([ok(Object.assign({}, FILE, { name: "a.txt" }))]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", path: "/Docs/a.txt", toPath: "/Docs", name: "a.txt" })).entry.path, "/Docs/a.txt");
	assert.deepStrictEqual(urls(k.requests), ["GET " + files("info", "/Docs/a.txt")]);
	for (const [item, to] of [["/", "/x"], ["root", "/x"], ["//", "/x"], ["/Docs", "/Docs"], ["/Docs", "/Docs/Sub"], ["/Docs/", "/Docs/Sub/Deeper"]]) {
		k = start(script([]));
		const r = await k.call("moveItem", { accountId: "acc", path: item, toPath: to });
		assert.strictEqual(r.errorCode, "BAD_ARGS", item + " -> " + to);
		assert.strictEqual(k.requests.length, 0);
	}
	// A sibling whose name starts the same is not "inside".
	k = start(script([status(404), ok(), ok(DIR)]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", path: "/Docs", toPath: "/Docs2" })).returnValue, true);
});

test("deleteItem sends DELETE files/remove and answers; a failure is KOOFR_API_ERROR; the root is refused unsent", async () => {
	let k = start(script([ok()]));
	assert.deepStrictEqual(await k.call("deleteItem", { accountId: "acc", path: "/Docs/a b.txt" }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(urls(k.requests), ["DELETE " + files("remove", "/Docs/a b.txt")]);
	assert.match(k.requests[0].url, /path=%2FDocs%2Fa%20b\.txt$/);
	assert.strictEqual(k.requests[0].body, undefined);
	k = start(script([status(404)]));
	const e = await k.call("deleteItem", { accountId: "acc", path: "/gone" });
	assert.deepStrictEqual([e.returnValue, e.errorCode, e.status], [false, "KOOFR_API_ERROR", 404]);
	for (const [item, code] of [["/", "BAD_ARGS"], ["root", "BAD_ARGS"], ["//", "BAD_ARGS"], ["", "MISSING_ARGS"]]) {
		k = start(script([]));
		assert.strictEqual((await k.call("deleteItem", { accountId: "acc", path: item })).errorCode, code, item);
		assert.strictEqual(k.requests.length, 0);
	}
});

// --- Photos ----------------------------------------------------------------------------------

const JPG = { name: "IMG_1.JPG", type: "file", size: 9, modified: 1, contentType: "image/jpeg" };
const PNG_NO_TYPE = { name: "b.png", type: "file", size: 9, modified: 1 };
const TIFF = { name: "scan.tiff", type: "file", size: 9, modified: 1, contentType: "application/octet-stream" };

test("listAlbums: the root's images as 'Koofr', and each folder under it that holds images; aid the encoded path", async () => {
	const lists = { "/": [JPG, FILE, DIR, Object.assign({}, DIR, { name: "My pictures" }), Object.assign({}, DIR, { name: "Empty" })],
		"/New": [TIFF], "/My pictures": [PNG_NO_TYPE, JPG, FILE], "/Empty": [FILE] };
	const { call, requests } = start([["GET", /files\/list/, (r) => ok({ files: lists[new URL(r.url).searchParams.get("path")] })]]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS), { returnValue: true, albums: [
		{ aid: "%2F", name: "Koofr", size: { images: 1 } },
		{ aid: "%2FNew", name: "New", size: { images: 1 } },
		{ aid: "%2FMy%20pictures", name: "My pictures", size: { images: 2 } },
	] });
	assert.deepStrictEqual(requests.map((r) => new URL(r.url).searchParams.get("path")), ["/", "/New", "/My pictures", "/Empty"]);
});

test("listAlbums: no images anywhere, or nothing listable, is one empty album; no credentials is an error", async () => {
	const EMPTY = { returnValue: true, albums: [{ aid: "", name: "Camera Uploads", size: { images: 0 } }] };
	assert.deepStrictEqual(await start([["GET", /files\/list/, () => ok({ files: [FILE] })]]).call("listAlbums", { accountId: "acc" }, PHOTOS), EMPTY);
	assert.deepStrictEqual(await start(() => status(500), { stored: NO_MOUNT }).call("listAlbums", { accountId: "acc" }, PHOTOS), EMPTY);
	// A folder that cannot be listed counts as no images; the others still count.
	const k = start([["GET", /files\/list\?path=%2F$/, () => ok({ files: [DIR, Object.assign({}, DIR, { name: "B" })] })],
		["GET", /path=%2FNew$/, () => status(500)], ["GET", /path=%2FB$/, () => ok({ files: [JPG] })]]);
	assert.deepStrictEqual((await k.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums, [{ aid: "%2FB", name: "B", size: { images: 1 } }]);
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: the aid decoded to the folder, one files/download link per image in turn; one without a link is left out", async () => {
	const { call, requests } = start([
		["GET", /files\/list/, () => ok({ files: [JPG, FILE, PNG_NO_TYPE, DIR, TIFF] })],
		["GET", /files\/download/, (r) => (/b\.png$/.test(r.url) ? status(500) : ok({ link: "https://dl.example.test/" + q(new URL(r.url).searchParams.get("path")) }))],
	]);
	const r = await call("listPhotos", { accountId: "acc", aid: "%2FMy%20pictures" }, PHOTOS);
	const link = (p) => "https://dl.example.test/" + q(p);
	assert.deepStrictEqual(r, { returnValue: true, photos: [
		{ pid: "/My pictures/IMG_1.JPG", src_big: link("/My pictures/IMG_1.JPG"), src_small: link("/My pictures/IMG_1.JPG"), caption: "IMG_1.JPG", type: "image", fileName: "IMG_1.JPG" },
		{ pid: "/My pictures/scan.tiff", src_big: link("/My pictures/scan.tiff"), src_small: link("/My pictures/scan.tiff"), caption: "scan.tiff", type: "image", fileName: "scan.tiff" },
	] });
	assert.deepStrictEqual(urls(requests), ["GET " + files("list", "/My pictures"), "GET " + files("download", "/My pictures/IMG_1.JPG"),
		"GET " + files("download", "/My pictures/b.png"), "GET " + files("download", "/My pictures/scan.tiff")]);
});

test("listPhotos: no aid is no photos and asks nobody; a folder that cannot be listed is no photos; an undecodable aid is a path", async () => {
	const k = start(() => status(500));
	for (const aid of [undefined, null, ""]) {
		assert.deepStrictEqual(await k.call("listPhotos", { accountId: "acc", aid }, PHOTOS), { returnValue: true, photos: [] });
	}
	assert.strictEqual(k.handle.calls.length + k.requests.length, 0);
	assert.deepStrictEqual(await k.call("listPhotos", { accountId: "acc", aid: "%2FX" }, PHOTOS), { returnValue: true, photos: [] });
	const b = start([["GET", /files\/list/, () => ok({ files: [] })]]);
	await b.call("listPhotos", { accountId: "acc", aid: "100%/" }, PHOTOS);
	await b.call("listPhotos", { accountId: "acc", aid: "Plain" }, PHOTOS);
	assert.deepStrictEqual(b.requests.map((r) => new URL(r.url).searchParams.get("path")), ["/100%", "/Plain"]);
});

test("upload (Photos): into the album listAlbums named (its aid decoded); with none, into Camera Uploads made first", async () => {
	const { call, requests } = start([
		["POST", /files\/put/, () => ok({ name: "local.bin", size: 3000 })],
		["POST", /files\/folder/, () => status(409)],
	]);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: "%2FMy%20pictures", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "/My pictures/local.bin", name: "local.bin", size: 3000 });
	assert.strictEqual(new URL(requests[0].url).searchParams.get("path"), "/My pictures");
	await call("upload", { accountId: "acc", folderId: "/Plain path", path: LOCAL }, PHOTOS);
	assert.strictEqual(new URL(requests[1].url).searchParams.get("path"), "/Plain path");
	const r = await call("upload", { accountId: "acc", albumId: "", path: LOCAL, name: "p.jpg" }, PHOTOS);
	assert.strictEqual(r.pid, "/Camera Uploads/local.bin");
	assert.deepStrictEqual(urls(requests.slice(2)), ["POST " + files("folder", "/"), "POST " + `${CONTENT}/mounts/m1/files/put?path=${q("/Camera Uploads")}&filename=p.jpg&info=true&overwrite=true`]);
	assert.strictEqual(requests[2].body, JSON.stringify({ name: "Camera Uploads" }));
	assert.strictEqual(requests[3].body.form[0][1].name, "p.jpg");
});

test("upload (Photos): an album folder that cannot be made is KOOFR_MKDIR_FAILED and nothing is uploaded", async () => {
	const { call, requests } = start([["POST", /files\/folder/, () => status(403)], ["POST", /files\/put/, () => ok({})]]);
	const r = await call("upload", { accountId: "acc", path: LOCAL }, PHOTOS);
	assert.deepStrictEqual([r.errorCode, r.status], ["KOOFR_MKDIR_FAILED", 403]);
	assert.strictEqual(requests.length, 1);
});

test("deletePhoto: DELETE files/remove with the photo's path; a failure is KOOFR_DELETE_FAILED", async () => {
	const { call, requests } = start([["DELETE", /IMG_1/, () => ({ status: 204 })], ["DELETE", /./, () => status(404)]]);
	assert.deepStrictEqual(await call("deletePhoto", { accountId: "acc", pid: "/My pictures/IMG_1.JPG" }, PHOTOS), { returnValue: true, pid: "/My pictures/IMG_1.JPG" });
	assert.strictEqual(requests[0].url, files("remove", "/My pictures/IMG_1.JPG"));
	const r = await call("deletePhoto", { accountId: "acc", pid: "/gone.jpg" }, PHOTOS);
	assert.deepStrictEqual([r.errorCode, r.status], ["KOOFR_DELETE_FAILED", 404]);
});

// --- every request failing, in turn ----------------------------------------------------------

// What Koofr answers when nothing fails. GET files/info finds nothing until something was
// changed (a move's probe, then its read-back; createFolder's read-back).
function happy() {
	let changed = false;
	return (r) => {
		const u = r.url;
		if (/oauth2\/token$/.test(u)) { return ok({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }); }
		if (/\/mounts$/.test(u)) { return ok({ mounts: [{ id: "m1", isPrimary: true }] }); }
		if (/\/user$/.test(u)) { return ok({ email: "u@example.test", firstName: "U" }); }
		if (/files\/list/.test(u)) { return ok({ files: [JPG, Object.assign({}, DIR, { name: "Sub" })] }); }
		if (/files\/info/.test(u)) { return changed ? ok(FILE) : status(404); }
		if (/files\/download/.test(u)) { return ok({ link: "https://dl.example.test/x" }); }
		if (/files\/get/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
		if (/files\/put/.test(u)) { return ok({ name: "n", size: 1 }); }
		if (r.method !== "GET") { changed = true; }
		return ok();
	};
}

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401 and a refused refresh": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": () => ({ status: 200, body: "<html>" }),
};

// [method, payload, caller, { minSteps, tolerated(k, mode) -> true when request k failing that
// way is absorbed }]. Requests the method does not read the body of take "not JSON" as success.
const notJson = (...ks) => (k, mode) => mode === "a reply that is not JSON" && ks.includes(k);
const OPS = [
	["listFolder", { accountId: "acc", path: "/x" }, DOCS, { minSteps: 2 }],
	["downloadFile", () => ({ accountId: "acc", fileId: "/x/a.jpg", localPath: dl() }), DOCS, { minSteps: 2, tolerated: notJson(2) }],
	["uploadFile", { accountId: "acc", path: "/x", localPath: LOCAL }, DOCS, { minSteps: 2 }],
	["uploadFile (replace)", { accountId: "acc", fileId: "/x/a.jpg", localPath: LOCAL, replace: true }, DOCS, { minSteps: 2 }],
	["createFolder", { accountId: "acc", path: "/x", name: "n" }, DOCS, { minSteps: 3 }],
	["moveItem (rename)", { accountId: "acc", path: "/x/a.jpg", name: "b.jpg" }, DOCS, { minSteps: 4 }],
	["moveItem (move)", { accountId: "acc", path: "/x/a.jpg", toPath: "/d" }, DOCS, { minSteps: 4 }],
	["deleteItem", { accountId: "acc", path: "/x/a.jpg" }, DOCS, { minSteps: 2, tolerated: notJson(2) }],
	["checkCredentials", { credentials: { common: { accessToken: "tok", refreshToken: "ref" } } }, {}],
	["exchangeCode", { code: "c", codeVerifier: "v" }, {}, { minSteps: 2, tolerated: (k) => k >= 2 }],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS, { minSteps: 3, tolerated: notJson(2) }],
	["upload (album)", { accountId: "acc", albumId: "%2Fx", path: LOCAL }, PHOTOS, { minSteps: 2 }],
	["deletePhoto", { accountId: "acc", pid: "/x/a.jpg" }, PHOTOS, { minSteps: 2, tolerated: notJson(2) }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 3, tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: "%2Fx" }, PHOTOS, { minSteps: 3, tolerated: () => true }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`koofr ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 12; k++) {
				let n = 0;
				const answer = happy();
				const { call } = start((r) => {
					n++;
					if (n === k) { return fail(r); }
					if (mode.startsWith("a 401") && n > k && /oauth2\/token$/.test(r.url)) { return { status: 400, body: { error: "invalid_grant" } }; }
					return answer(r);
				}, { stored: NO_MOUNT, timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
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
				} else {
					assert.strictEqual(r.returnValue, true, `request ${k} failing should be absorbed: ${JSON.stringify(r)}`);
				}
			}
			assert.ok(reached >= (opts.minSteps || 1), `only ${reached} of ${opts.minSteps || 1} steps were failed`);
		});
	}
}

test("the Accounts service failing or not answering is one error reply", async () => {
	const denied = start([], { onCall: () => ({ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" }) });
	assert.deepStrictEqual(await denied.call("listFolder", { accountId: "acc" }),
		{ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" });
	const broken = start([], { onCall: () => "not json" });
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", path: "/a" })).errorCode, "BUS_BAD_REPLY");
});
