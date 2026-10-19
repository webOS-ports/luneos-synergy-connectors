// node --test tests/unit
// The Box connector (cloud/box/service/com.palm.service.boxnet) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (endpoint, method, headers, body), its reply, and its errors; the Accounts
// service is answered by the stand-in bus. One download goes through node's own fetch to two
// local servers, to see the redirect to the content host followed.
//
// The last part fails every request of every method in turn, in each way a request can fail,
// and checks the method still answers exactly once, with an error: an error lost on the way
// (the Futures class of hangs, see lost-errors.test.js) would show here as no reply.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { fakePalmbus, fakeFetch, ask, json } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/box/service/com.palm.service.boxnet");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const API = "https://api.box.com/2.0";
const UPLOAD = "https://upload.box.com/api/2.0";
const FIELDS = "fields=id,type,name,size,modified_at";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "box-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const STORED = { accessToken: "tok", refreshToken: "ref", expiresAt: 1 };

const BOX_FILE = { type: "file", id: "111", name: "Report.pdf", size: 1234, modified_at: "2026-10-01T03:00:00-07:00" };
const FILE_ENTRY = { id: "111", type: "file", name: "Report.pdf", size: 1234, modified: "2026-10-01T10:00:00.000Z", path: "111" };
const BOX_FOLDER = { type: "folder", id: "222", name: "Sub", size: 0, modified_at: "2026-10-02T12:00:00Z" };
const FOLDER_ENTRY = { id: "222", type: "folder", name: "Sub", size: 0, modified: "2026-10-02T12:00:00.000Z", path: "222" };
const JPG = { type: "file", id: "301", name: "IMG_1.JPG", size: 10 };
const notFound = () => ({ status: 404, body: { type: "error", status: 404, code: "not_found", message: "Not Found" } });
const page = (entries, total, offset = 0) => ({ status: 200, body: { total_count: total === undefined ? entries.length : total, entries, offset, limit: 1000 } });
const uploadedReply = (f) => ({ status: 201, body: { total_count: 1, entries: [Object.assign({ type: "file" }, f)] } });

// The probes that tell a file id from a folder id.
const isFile = (id) => [["GET", new RegExp("/files/" + id + "\\?fields=id,type$"), () => ({ status: 200, body: { type: "file", id } })]];
const isFolder = (id) => [["GET", new RegExp("/files/" + id + "\\?fields=id,type$"), notFound],
	["GET", new RegExp("/folders/" + id + "\\?fields=id,type$"), () => ({ status: 200, body: { type: "folder", id } })]];

// The service on a stand-in bus. Accounts: readCredentials gives `stored`, writeCredentials is
// recorded. -> { handle, requests, written, call(method, payload, caller) }
function start(routes, { stored = STORED, onCall, timeouts, fetch } = {}) {
	const f = fakeFetch(routes);
	const written = [];
	const pb = fakePalmbus({ onCall: onCall || ((uri, args) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: Object.assign({}, stored) } : { returnValue: true }; }
		if (/writeCredentials$/.test(uri)) { written.push(args); return { returnValue: true }; }
		return { returnValue: false, errorCode: -1, errorText: "Unknown service" };
	}) });
	const s = service.start({ palmbus: pb, fetch: fetch || f.fetch, idleMs: 0, exit: () => {}, log: { log() {}, error() {} }, timeouts });
	const handle = pb.handles[0];
	return { s, handle, requests: f.requests, written,
		call: (method, payload, caller = DOCS) => ask(handle, method, payload, caller) };
}
const body = (r) => JSON.parse(r.body);
const line = (q) => q.method + " " + q.url;
const form = (q) => Object.fromEntries(new URLSearchParams(q.body));

test("the service: its bus name, every method the old services.json had (plus quit, info), the package layout", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.boxnet");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "moveItem", "quit",
		"upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const gone of ["services.json", "sources.json", "commands"]) { assert.ok(!fs.existsSync(path.join(SVC, gone)), gone); }
});

test("caller rules: file methods for the FILE_APP_IDS, auth and photo methods open", async () => {
	const { call } = start([["GET", /./, () => page([])]]);
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.cloud-auth" }, PHOTOS, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", path: "1", name: "b", localPath: LOCAL, fileId: "1" }, who);
			assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m + " " + JSON.stringify(who));
		}
	}
	for (const who of [DOCS, { appId: "org.webosports.app.documents-77" }, { service: "com.palm.stark.files.service" }]) {
		assert.strictEqual((await call("listFolder", { accountId: "acc" }, who)).returnValue, true, JSON.stringify(who));
	}
	assert.strictEqual((await call("getAuthorizeUrl", {}, {})).returnValue, true);
	assert.strictEqual((await call("getAuthorizeUrl", {}, { appId: "com.palm.app.accounts 99" })).returnValue, true);
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("listPhotos", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: STORED } }, { service: "com.palm.service.accounts" })).returnValue, true);
});

test("getAuthorizeUrl: Box's consent URL with PKCE, no extra parameters, state box", async () => {
	const { call } = start([]);
	const r = await call("getAuthorizeUrl", {}, {});
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://account.box.com/api/oauth2/authorize");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: Config.CLIENT_ID,
		redirect_uri: "http://localhost/boxnet/oauth2callback", scope: "root_readwrite",
		code_challenge: crypto.createHash("sha256").update(r.codeVerifier).digest("base64url"), code_challenge_method: "S256",
		state: "box" });
	assert.match(r.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
});

test("exchangeCode: the token request, then GET /users/me for the username (login) and alias (name)", async () => {
	const { call, requests } = start([
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "bearer" } })],
		["GET", /\/users\/me\?/, () => ({ status: 200, body: { type: "user", id: "9", login: "u@example.test", name: "U Ser" } })],
	]);
	const r = await call("exchangeCode", { code: "CODE", codeVerifier: "VERIFIER" }, { service: "com.palm.service.accounts" });
	assert.deepStrictEqual(requests.map(line), ["POST " + Config.TOKEN_URL, "GET " + API + "/users/me?fields=id,name,login"]);
	assert.strictEqual(Config.TOKEN_URL, "https://api.box.com/oauth2/token");
	// The placeholder secret (a build without BOX_CLIENT_SECRET) is not sent.
	assert.deepStrictEqual(form(requests[0]), { client_id: Config.CLIENT_ID,
		grant_type: "authorization_code", code: "CODE", redirect_uri: Config.REDIRECT_URI, code_verifier: "VERIFIER" });
	assert.deepStrictEqual(requests[1].headers, { Authorization: "Bearer AT" });
	assert.strictEqual(r.username, "u@example.test");
	assert.strictEqual(r.alias, "U Ser");
	assert.deepStrictEqual(Object.keys(r.credentials.common), ["accessToken", "refreshToken", "expiresAt"]);
	assert.strictEqual(r.credentials.common.refreshToken, "RT");
});

test("exchangeCode and refresh: a secret the build filled in is sent with the token calls", async () => {
	const saved = Config.CLIENT_SECRET;
	Config.CLIENT_SECRET = "unit-test-not-a-secret";
	try {
		const { call, requests } = start([
			["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } })],
			["GET", /\/users\/me\?/, () => ({ status: 200, body: { login: "u@example.test" } })],
			["GET", /\/folders\/0\/items/, (q) => (q.headers.Authorization === "Bearer AT" ? page([]) : { status: 401 })],
		]);
		await call("exchangeCode", { code: "C", codeVerifier: "V" }, {});
		await call("listFolder", { accountId: "acc" });
		const tokenCalls = requests.filter((q) => q.url === Config.TOKEN_URL).map(form);
		assert.strictEqual(tokenCalls.length, 2);
		for (const f of tokenCalls) { assert.strictEqual(f.client_secret, "unit-test-not-a-secret"); }
		assert.strictEqual(tokenCalls[1].grant_type, "refresh_token");
	} finally { Config.CLIENT_SECRET = saved; }
});

test("checkCredentials: /users/me with the given token; a rejected token is an error", async () => {
	const { call, requests } = start([["GET", /\/users\/me\?/, (q) => (q.headers.Authorization === "Bearer good"
		? { status: 200, body: { login: "u@example.test", name: "U" } } : { status: 401, body: { type: "error", code: "unauthorized" } })]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "good" } } }, {}),
		{ returnValue: true, renewedCredentials: null, username: "u@example.test", displayName: "U" });
	const bad = await call("checkCredentials", { credentials: { common: { accessToken: "bogus", refreshToken: "bogus", expiresAt: 1 } } }, {});
	assert.strictEqual(bad.errorCode, "OAUTH_TOKEN_FAILED");   // the 401, then the refresh refused (no route: 599)
	assert.strictEqual(requests.length, 3);
	assert.strictEqual((await call("checkCredentials", {}, {})).errorCode, "401_UNAUTHORIZED");
});

test("listFolder: GET /folders/{id}/items with the fields; entries normalised (dates to UTC Z); the root is \"0\"", async () => {
	const { call, requests } = start([["GET", /\/folders\/[^/]+\/items\?/, () => page([BOX_FILE, BOX_FOLDER, { type: "web_link", id: "5", name: "L", modified_at: "garbage" }])]]);
	const r = await call("listFolder", { accountId: "acc", folderId: "333" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entries: [FILE_ENTRY, FOLDER_ENTRY,
		{ id: "5", type: "file", name: "L", path: "5" }] });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/folders/333/items?limit=1000&" + FIELDS]);
	assert.deepStrictEqual(requests[0].headers, { Authorization: "Bearer tok" });
	assert.strictEqual(requests[0].body, undefined);
	for (const root of [{}, { path: "" }, { folderId: "0" }]) {
		await call("listFolder", Object.assign({ accountId: "acc" }, root));
		assert.strictEqual(requests[requests.length - 1].url, API + "/folders/0/items?limit=1000&" + FIELDS, JSON.stringify(root));
	}
	await call("listFolder", { accountId: "acc", path: "a b/c" });
	assert.strictEqual(requests[requests.length - 1].url, API + "/folders/a%20b%2Fc/items?limit=1000&" + FIELDS);
});

test("listFolder: a folder of more than one page is listed in full, by offset, up to Box's offset limit", async () => {
	const many = (n, from) => Array.from({ length: n }, (_, i) => ({ type: "file", id: String(from + i), name: "f" + (from + i) }));
	const { call, requests } = start([["GET", /\/folders\/7\/items\?/, (q) => {
		const off = Number(new URL(q.url).searchParams.get("offset") || 0);
		return page(many(Math.min(1000, 2500 - off), off), 2500, off);
	}]]);
	const r = await call("listFolder", { accountId: "acc", folderId: "7" });
	assert.strictEqual(r.entries.length, 2500);
	assert.strictEqual(r.entries[2499].id, "2499");
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/folders/7/items?limit=1000&" + FIELDS,
		API + "/folders/7/items?limit=1000&offset=1000&" + FIELDS, API + "/folders/7/items?limit=1000&offset=2000&" + FIELDS]);

	const huge = start([["GET", /\/items\?/, (q) => page(many(1000, Number(new URL(q.url).searchParams.get("offset") || 0)), 50000)]]);
	assert.strictEqual((await huge.call("listFolder", { accountId: "acc" })).entries.length, 10000);
	assert.strictEqual(huge.requests.length, 10);

	const short = start([["GET", /\/items\?/, () => page([], 5)]]);   // total_count says more, the page is empty
	assert.deepStrictEqual((await short.call("listFolder", { accountId: "acc" })).entries, []);
	assert.strictEqual(short.requests.length, 1);
});

test("listFolder: inline credentials, without the Accounts service", async () => {
	const { call, requests, handle } = start([["GET", /items/, () => page([])]]);
	await call("listFolder", { credentials: { common: { accessToken: "inline" } } });
	assert.strictEqual(requests[0].headers.Authorization, "Bearer inline");
	assert.strictEqual(handle.calls.length, 0);
});

test("credentials by accountId: readCredentials name common; none stored is NO_STORED_CREDENTIALS", async () => {
	const { call, handle } = start([["GET", /items/, () => page([])]]);
	await call("listFolder", { accountId: "acc-1" });
	assert.deepStrictEqual(handle.calls, [{ uri: "luna://com.palm.service.accounts/readCredentials", args: { accountId: "acc-1", name: "common" } }]);
	const none = start([], { stored: null });
	assert.strictEqual((await none.call("listFolder", { accountId: "acc" })).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await none.call("listFolder", {})).errorCode, "NO_CREDENTIALS");
});

test("a 401: refresh, retry with the new token, and save the ROTATED refresh token to the account", async () => {
	const { call, requests, written } = start([
		["GET", /items/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 3600 } })],
		["GET", /items/, (q) => (q.headers.Authorization === "Bearer tok2" ? page([BOX_FILE]) : { status: 401 })],
	]);
	const t0 = Date.now();
	const r = await call("listFolder", { accountId: "acc" });
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/folders/0/items?limit=1000&" + FIELDS, Config.TOKEN_URL,
		API + "/folders/0/items?limit=1000&" + FIELDS]);
	assert.deepStrictEqual(form(requests[1]), { client_id: Config.CLIENT_ID, grant_type: "refresh_token", refresh_token: "ref" });
	assert.strictEqual(r.entries.length, 1);
	assert.strictEqual(r.renewedCredentials.accessToken, "tok2");
	assert.strictEqual(r.renewedCredentials.refreshToken, "ref2");
	assert.ok(r.renewedCredentials.expiresAt >= t0 + 3600e3);
	assert.deepStrictEqual(written, [{ accountId: "acc", name: "common", credentials: r.renewedCredentials }]);
});

test("a 401 whose refresh fails: the refresh's error, nothing saved, no retry", async () => {
	const { call, requests, written } = start([
		["GET", /items/, () => ({ status: 401 })],
		["POST", /oauth2\/token$/, () => ({ status: 400, body: { error: "invalid_grant" } })],
	]);
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.errorCode, "OAUTH_TOKEN_FAILED");
	assert.match(r.errorText, /invalid_grant/);
	assert.strictEqual(requests.length, 2);
	assert.deepStrictEqual(written, []);
});

test("an API error: BOX_API_ERROR with the status and Box's error code and message", async () => {
	const { call } = start([["POST", /\/folders\?/, () => ({ status: 409, body: { type: "error", status: 409, code: "item_name_in_use", message: "Item with the same name already exists" } })]]);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", folderId: "0", name: "Sub" }),
		{ returnValue: false, errorCode: "BOX_API_ERROR", errorText: "Box answered HTTP 409: item_name_in_use (Item with the same name already exists)", status: 409 });
	const plain = start([["GET", /./, () => ({ status: 502, body: "Bad\n gateway" })]]);
	assert.deepStrictEqual(await plain.call("listFolder", { accountId: "acc" }),
		{ returnValue: false, errorCode: "BOX_API_ERROR", errorText: "Box answered HTTP 502: Bad gateway", status: 502 });
});

test("downloadFile: GET /files/{id}/content with the token, the bytes to localPath (folders 0755)", async () => {
	const BYTES = crypto.randomBytes(70000);
	const { call, requests } = start([["GET", /\/files\/111\/content$/, () => new Response(BYTES, { status: 200 })]]);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", fileId: "111", localPath: dest });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/files/111/content"]);
	assert.deepStrictEqual(requests[0].headers, { Authorization: "Bearer tok" });
	await call("downloadFile", { accountId: "acc", path: "112", localPath: dl() });
	assert.strictEqual(requests.length, 2, "path is the file id too");
});

test("downloadFile: a 404 writes no file; MISSING_ARGS without localPath", async () => {
	const { call } = start([["GET", /content$/, notFound]]);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", fileId: "999", localPath: dest });
	assert.strictEqual(r.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.status, 404);
	assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + ".part"));
	assert.strictEqual((await call("downloadFile", { accountId: "acc", fileId: "1" })).errorCode, "MISSING_ARGS");
});

test("downloadFile: the 302 to the content host is followed (node's own fetch, two local servers)", async () => {
	const BYTES = crypto.randomBytes(20000);
	const seen = { api: [], dl: [] };
	const listen = (h) => new Promise((res) => { const srv = http.createServer(h); srv.listen(0, "127.0.0.1", () => res(srv)); });
	const dlSrv = await listen((req, res) => { seen.dl.push({ url: req.url, auth: req.headers.authorization }); res.end(BYTES); });
	const apiSrv = await listen((req, res) => {
		seen.api.push({ method: req.method, url: req.url, auth: req.headers.authorization });
		res.writeHead(302, { Location: "http://127.0.0.1:" + dlSrv.address().port + "/d/1/signed" });
		res.end();
	});
	try {
		const local = (u, init) => globalThis.fetch(String(u).replace("https://api.box.com", "http://127.0.0.1:" + apiSrv.address().port), init);
		const { call } = start([], { fetch: local });
		const dest = dl();
		const r = await call("downloadFile", { accountId: "acc", fileId: "111", localPath: dest });
		assert.strictEqual(r.returnValue, true, JSON.stringify(r));
		assert.ok(fs.readFileSync(dest).equals(BYTES));
		assert.deepStrictEqual(seen.api, [{ method: "GET", url: "/2.0/files/111/content", auth: "Bearer tok" }]);
		assert.strictEqual(seen.dl.length, 1);
		assert.strictEqual(seen.dl[0].url, "/d/1/signed");
		assert.strictEqual(seen.dl[0].auth, undefined, "the token is not sent on to another host");
	} finally { apiSrv.close(); dlSrv.close(); }
});

test("uploadFile: multipart to upload.box.com /files/content, attributes first, then the file named by name", async () => {
	const { call, requests } = start([["POST", /upload\.box\.com\/api\/2\.0\/files\/content$/, () => uploadedReply({ id: "U1", name: "Notes é.txt", size: 5000 })]]);
	const r = await call("uploadFile", { accountId: "acc", folderId: "333", localPath: LOCAL, name: "Notes é.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Notes é.txt", id: "U1", size: 5000 });
	const q = requests[0];
	assert.strictEqual(line(q), "POST " + UPLOAD + "/files/content");
	assert.deepStrictEqual(q.headers, { Authorization: "Bearer tok" });
	assert.deepStrictEqual(q.body.form.map(([k]) => k), ["attributes", "file"]);
	assert.deepStrictEqual(JSON.parse(q.body.form[0][1]), { name: "Notes é.txt", parent: { id: "333" } });
	assert.strictEqual(q.body.form[1][1].name, "Notes é.txt");
	assert.strictEqual(q.body.form[1][1].size, LOCAL_BYTES.length);
});

test("uploadFile: the root \"0\" by default, path as the folder, the local name by default", async () => {
	const { call, requests } = start([["POST", /files\/content$/, () => uploadedReply({ id: "U" })]]);
	await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	await call("uploadFile", { accountId: "acc", path: "444", localPath: LOCAL, name: "c.txt" });
	assert.deepStrictEqual(requests.map((q) => JSON.parse(q.body.form[0][1])),
		[{ name: "local.bin", parent: { id: "0" } }, { name: "c.txt", parent: { id: "444" } }]);
});

test("uploadFile: a name in use is the 409; a reply naming no file is an error, not id undefined", async () => {
	const { call } = start([["POST", /files\/content$/, () => ({ status: 409, body: { type: "error", code: "item_name_in_use" } })]]);
	const r = await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	assert.strictEqual(r.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.status, 409);
	for (const reply of [{}, { entries: [] }, { entries: [{ name: "x" }] }]) {
		const odd = start([["POST", /files\/content$/, () => ({ status: 201, body: reply })]]);
		const o = await odd.call("uploadFile", { accountId: "acc", localPath: LOCAL });
		assert.strictEqual(o.errorCode, "BOX_API_ERROR", JSON.stringify(reply));
	}
});

test("uploadFile replace:true: a new version at /files/{id}/content, the file only", async () => {
	const { call, requests } = start([["POST", /files\/111\/content$/, () => uploadedReply({ id: "111", name: "Report.pdf", size: 5000 })]]);
	const r = await call("uploadFile", { accountId: "acc", fileId: "111", localPath: LOCAL, replace: true });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Report.pdf", id: "111", size: 5000 });
	assert.strictEqual(line(requests[0]), "POST " + UPLOAD + "/files/111/content");
	assert.deepStrictEqual(requests[0].headers, { Authorization: "Bearer tok" });
	assert.deepStrictEqual(requests[0].body.form.map(([k]) => k), ["file"]);
	assert.strictEqual(requests[0].body.form[0][1].size, LOCAL_BYTES.length);
});

test("uploadFile: a 401 on the upload refreshes and sends the file again", async () => {
	const { call, requests } = start([
		["POST", /files\/content$/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
		["POST", /files\/content$/, () => uploadedReply({ id: "U" })],
	]);
	const r = await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	assert.strictEqual(r.id, "U");
	assert.strictEqual(requests[2].headers.Authorization, "Bearer tok2");
	assert.strictEqual(requests[2].body.form[1][1].size, LOCAL_BYTES.length);
	assert.strictEqual(r.renewedCredentials.refreshToken, "ref2");
});

test("uploadFile: a local file that is not there is LOCAL_FILE_ERROR, and nothing is sent", async () => {
	const { call, requests } = start([["POST", /./, () => uploadedReply({ id: "U" })]]);
	const r = await call("uploadFile", { accountId: "acc", localPath: path.join(TMP, "nope.bin") });
	assert.strictEqual(r.errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual(requests.length, 0);
});

test("createFolder: POST /folders { name, parent:{id} } as JSON; the entry is listFolder-shaped; the root is \"0\"", async () => {
	const { call, requests } = start([["POST", /\/folders\?/, () => ({ status: 201, body: BOX_FOLDER })]]);
	const r = await call("createFolder", { accountId: "acc", folderId: "333", name: "Sub" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: FOLDER_ENTRY });
	assert.deepStrictEqual(requests.map(line), ["POST " + API + "/folders?" + FIELDS]);
	assert.deepStrictEqual(requests[0].headers, { "Content-Type": "application/json", Authorization: "Bearer tok" });
	assert.deepStrictEqual(body(requests[0]), { name: "Sub", parent: { id: "333" } });
	await call("createFolder", { accountId: "acc", name: "Top" });
	assert.deepStrictEqual(body(requests[1]).parent, { id: "0" });
	assert.strictEqual((await call("createFolder", { accountId: "acc", name: "a/b" })).errorCode, "MISSING_ARGS");
	assert.strictEqual(requests.length, 2);
});

test("createFolder: a 401 refreshes, retries with the new token and the same body, saves the rotated token", async () => {
	const { call, requests, written } = start([
		["POST", /\/folders\?/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 3600 } })],
		["POST", /\/folders\?/, () => ({ status: 201, body: BOX_FOLDER })],
	]);
	const r = await call("createFolder", { accountId: "acc", name: "Sub" });
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/folders?" + FIELDS, Config.TOKEN_URL, API + "/folders?" + FIELDS]);
	assert.strictEqual(requests[2].headers.Authorization, "Bearer tok2");
	assert.strictEqual(requests[2].body, requests[0].body);
	assert.strictEqual(written[0].credentials.refreshToken, "ref2");
	assert.deepStrictEqual(r.entry, FOLDER_ENTRY);
});

test("moveItem on a file: probe GET /files/{id}, then PUT /files/{id}; a rename sends just name", async () => {
	const { call, requests } = start([...isFile("111"), ["PUT", /\/files\/111\?/, () => ({ status: 200, body: Object.assign({}, BOX_FILE, { name: "Final.pdf" }) })]]);
	const r = await call("moveItem", { accountId: "acc", fileId: "111", name: "Final.pdf" });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/files/111?fields=id,type", "PUT " + API + "/files/111?" + FIELDS]);
	assert.deepStrictEqual(requests[0].headers, { Authorization: "Bearer tok" });
	assert.deepStrictEqual(requests[1].headers, { "Content-Type": "application/json", Authorization: "Bearer tok" });
	assert.deepStrictEqual(body(requests[1]), { name: "Final.pdf" });
	assert.deepStrictEqual(r.entry, Object.assign({}, FILE_ENTRY, { name: "Final.pdf" }));
});

test("moveItem on a file: a move sends just parent.id; toRoot is \"0\"", async () => {
	const { call, requests } = start([...isFile("111"), ["PUT", /\/files\/111\?/, () => ({ status: 200, body: BOX_FILE })]]);
	await call("moveItem", { accountId: "acc", path: "111", toFolderId: "444" });
	assert.deepStrictEqual(body(requests[1]), { parent: { id: "444" } });
	await call("moveItem", { accountId: "acc", path: "111", toRoot: true });
	assert.deepStrictEqual(body(requests[3]), { parent: { id: "0" } });
});

test("moveItem on a folder: the file probe's 404 leads to GET then PUT /folders/{id}, both fields", async () => {
	const { call, requests } = start([...isFolder("222"), ["PUT", /\/folders\/222\?/, () => ({ status: 200, body: Object.assign({}, BOX_FOLDER, { name: "Old" }) })]]);
	const r = await call("moveItem", { accountId: "acc", fileId: "222", toPath: "0", name: "Old" });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/files/222?fields=id,type", "GET " + API + "/folders/222?fields=id,type",
		"PUT " + API + "/folders/222?" + FIELDS]);
	assert.deepStrictEqual(body(requests[2]), { name: "Old", parent: { id: "0" } });
	assert.deepStrictEqual(r.entry, Object.assign({}, FOLDER_ENTRY, { name: "Old" }));
});

test("moveItem: a 409 from the PUT is reported, not retried as the other kind", async () => {
	const { call, requests } = start([...isFile("111"), ["PUT", /./, () => ({ status: 409, body: { type: "error", code: "item_name_in_use" } })]]);
	const r = await call("moveItem", { accountId: "acc", fileId: "111", name: "Taken.pdf" });
	assert.strictEqual(r.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.status, 409);
	assert.match(r.errorText, /item_name_in_use/);
	assert.strictEqual(requests.length, 2);
});

test("moveItem: an id that is neither file nor folder fails with the 404 and changes nothing", async () => {
	const { call, requests } = start([["GET", /./, notFound], ["PUT", /./, () => ({ status: 200, body: BOX_FILE })]]);
	const r = await call("moveItem", { accountId: "acc", fileId: "999", toFolderId: "0" });
	assert.strictEqual(r.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.status, 404);
	assert.deepStrictEqual(requests.map((q) => q.method), ["GET", "GET"]);
});

test("moveItem: a probe failure other than 404 stops there (no folder probe, no PUT)", async () => {
	const { call, requests } = start([["GET", /./, () => ({ status: 403, body: { code: "access_denied_insufficient_permissions" } })]]);
	const r = await call("moveItem", { accountId: "acc", fileId: "111", toFolderId: "0" });
	assert.strictEqual(r.status, 403);
	assert.strictEqual(requests.length, 1);
});

test("moveItem: a token renewed during the probe is used by the PUT, refreshed once, saved once (Box rotates)", async () => {
	const { call, requests, written } = start([
		["GET", /\/files\/111\?/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, (q) => (form(q).refresh_token === "ref"
			? { status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } } : { status: 400, body: { error: "invalid_grant" } })],
		...isFile("111"),
		["PUT", /\/files\/111\?/, (q) => (q.headers.Authorization === "Bearer tok2" ? { status: 200, body: BOX_FILE } : { status: 401 })],
	]);
	const r = await call("moveItem", { accountId: "acc", fileId: "111", toFolderId: "0" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(requests.length, 4);
	assert.strictEqual(requests[3].headers.Authorization, "Bearer tok2");
	assert.strictEqual(written.length, 1);
	assert.strictEqual(written[0].credentials.refreshToken, "ref2");
});

test("deleteItem on a file: DELETE /files/{id} (to the trash), no body; 204 is success", async () => {
	const { call, requests } = start([...isFile("111"), ["DELETE", /./, () => ({ status: 204 })]]);
	assert.deepStrictEqual(await call("deleteItem", { accountId: "acc", fileId: "111" }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/files/111?fields=id,type", "DELETE " + API + "/files/111"]);
	assert.deepStrictEqual(requests[1].headers, { Authorization: "Bearer tok" });
	assert.strictEqual(requests[1].body, undefined);
});

test("deleteItem on a folder: DELETE /folders/{id}?recursive=true", async () => {
	const { call, requests } = start([...isFolder("222"), ["DELETE", /./, () => ({ status: 204 })]]);
	assert.strictEqual((await call("deleteItem", { accountId: "acc", path: "222" })).returnValue, true);
	assert.deepStrictEqual(requests.map(line).slice(2), ["DELETE " + API + "/folders/222?recursive=true"]);
});

test("deleteItem: a 409 from the DELETE is the error; an unknown id is a 404 and nothing is deleted; never the root", async () => {
	const busy = start([...isFolder("222"), ["DELETE", /./, () => ({ status: 409, body: { code: "operation_blocked_temporary" } })]]);
	const r = await busy.call("deleteItem", { accountId: "acc", fileId: "222" });
	assert.strictEqual(r.errorCode, "BOX_API_ERROR");
	assert.strictEqual(r.status, 409);
	const gone = start([["GET", /./, notFound], ["DELETE", /./, () => ({ status: 204 })]]);
	assert.strictEqual((await gone.call("deleteItem", { accountId: "acc", fileId: "999" })).status, 404);
	assert.ok(gone.requests.every((q) => q.method === "GET"));
	const root = start([["GET", /./, () => ({ status: 200, body: {} })], ["DELETE", /./, () => ({ status: 204 })]]);
	for (const p of ["0", "/", "root"]) { assert.strictEqual((await root.call("deleteItem", { accountId: "acc", path: p })).errorCode, "BAD_ARGS", p); }
	assert.strictEqual(root.requests.length, 0);
});

test("listAlbums: one album, the root folder \"0\" as Box Photos, counting its image files", async () => {
	const { call, requests } = start([["GET", /\/folders\/0\/items\?/, () => page([JPG, BOX_FILE, { type: "folder", id: "9", name: "x.jpg" },
		Object.assign({}, JPG, { id: "302", name: "b.heic" })])]]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS),
		{ returnValue: true, albums: [{ aid: "0", name: "Box Photos", size: { images: 2 } }] });
	assert.strictEqual(requests[0].url, API + "/folders/0/items?limit=1000&" + FIELDS);
});

test("listAlbums: a folder that cannot be listed is the album with 0 images; no credentials is an error", async () => {
	const { call } = start([["GET", /items/, () => ({ status: 500, body: "" })]]);
	assert.deepStrictEqual((await call("listAlbums", { accountId: "acc" }, PHOTOS)).albums, [{ aid: "0", name: "Box Photos", size: { images: 0 } }]);
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: one token-in-query content URL per image, no call per photo; the aid is the folder", async () => {
	const { call, requests } = start([["GET", /\/folders\/55\/items\?/, () => page([JPG, BOX_FILE, Object.assign({}, JPG, { id: "302", name: "b.png" })])]]);
	const r = await call("listPhotos", { accountId: "acc", aid: "55" }, PHOTOS);
	const url = (id) => API + "/files/" + id + "/content?access_token=tok";
	assert.deepStrictEqual(r, { returnValue: true, photos: [
		{ pid: "301", src_big: url("301"), src_small: url("301"), caption: "IMG_1.JPG", type: "image", fileName: "IMG_1.JPG" },
		{ pid: "302", src_big: url("302"), src_small: url("302"), caption: "b.png", type: "image", fileName: "b.png" }] });
	assert.strictEqual(requests.length, 1);
	await call("listPhotos", { accountId: "acc" }, PHOTOS);
	assert.match(requests[1].url, /\/folders\/0\/items\?/);
});

test("listPhotos: the URLs carry the token a refresh renewed, which is saved", async () => {
	const { call, written } = start([
		["GET", /items/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok/2+", refresh_token: "ref2", expires_in: 60 } })],
		["GET", /items/, () => page([JPG])],
	]);
	const r = await call("listPhotos", { accountId: "acc" }, PHOTOS);
	assert.strictEqual(r.photos[0].src_big, API + "/files/301/content?access_token=tok%2F2%2B");
	assert.strictEqual(written[0].credentials.refreshToken, "ref2");
});

test("listPhotos: the listing failing fails the call", async () => {
	const { call } = start([["GET", /items/, () => ({ status: 500, body: "oops" })]]);
	assert.strictEqual((await call("listPhotos", { accountId: "acc" }, PHOTOS)).errorCode, "BOX_API_ERROR");
});

test("upload (Photos): the photo into the album folder, or the root; pid is the Box file id", async () => {
	const { call, requests } = start([["POST", /files\/content$/, () => uploadedReply({ id: "NEW", name: "local.bin", size: 5000 })]]);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: "55", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "NEW", name: "local.bin", size: 5000 });
	await call("upload", { accountId: "acc", path: LOCAL }, PHOTOS);
	assert.deepStrictEqual(requests.map((q) => JSON.parse(q.body.form[0][1]).parent.id), ["55", "0"]);
	assert.ok(requests.every((q) => q.url === UPLOAD + "/files/content"));
});

test("deletePhoto: DELETE /files/{pid}", async () => {
	const { call, requests } = start([["DELETE", /\/files\/301$/, () => ({ status: 204 })]]);
	assert.deepStrictEqual(await call("deletePhoto", { accountId: "acc", pid: "301" }, PHOTOS), { returnValue: true, pid: "301" });
	assert.deepStrictEqual(requests.map(line), ["DELETE " + API + "/files/301"]);
	assert.strictEqual(requests[0].body, undefined);
	const gone = start([["DELETE", /./, notFound]]);
	assert.strictEqual((await gone.call("deletePhoto", { accountId: "acc", pid: "301" }, PHOTOS)).status, 404);
});

// --- every request failing, in turn ----------------------------------------------------------

// What Box answers when nothing fails. Folder ids start with "D" (the file probe is a 404 for
// them); a folder's items come in two pages.
function happy(q) {
	const u = q.url;
	if (/oauth2\/token$/.test(u)) { return { status: 200, body: { access_token: "AT2", refresh_token: "RT2", expires_in: 3600 } }; }
	if (/\/users\/me\?/.test(u)) { return { status: 200, body: { login: "u@example.test", name: "U" } }; }
	if (/\/items\?/.test(u)) {
		return /offset=1&/.test(u) ? page([Object.assign({}, JPG, { id: "302", name: "2.jpg" })], 2, 1) : page([JPG], 2, 0);
	}
	if (q.method === "GET" && /\/files\/D[^/?]*\?fields=id,type$/.test(u)) { return notFound(); }
	if (q.method === "GET" && /\?fields=id,type$/.test(u)) { return { status: 200, body: { type: "x", id: "1" } }; }
	if (q.method === "GET" && /\/content$/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (/upload\.box\.com/.test(u)) { return uploadedReply({ id: "U", name: "n", size: 1 }); }
	if (q.method === "DELETE") { return { status: 204 }; }
	return { status: 200, body: BOX_FILE };
}

// How the failing request fails. "401" is an expired token whose refresh is refused too.
const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401 and a refused refresh": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": (q) => (q.method === "GET" && /\/content$/.test(q.url) ? { status: 200, body: "ok" } : { status: 200, body: "<html>" }),
};

// [label, payload, caller, { minSteps, tolerated(k) -> true when request k failing is absorbed }]
const OPS = [
	["listFolder", { accountId: "acc", folderId: "D1" }, DOCS, { minSteps: 2 }],
	["downloadFile", () => ({ accountId: "acc", fileId: "F1", localPath: dl() }), DOCS, { notJsonOk: true }],
	["uploadFile", { accountId: "acc", folderId: "D1", localPath: LOCAL }, DOCS],
	["uploadFile (replace)", { accountId: "acc", fileId: "F1", localPath: LOCAL, replace: true }, DOCS],
	["createFolder", { accountId: "acc", folderId: "D1", name: "n" }, DOCS],
	["moveItem (file)", { accountId: "acc", fileId: "F1", name: "b.jpg" }, DOCS, { minSteps: 2 }],
	["moveItem (folder)", { accountId: "acc", fileId: "D2", toFolderId: "D1" }, DOCS, { minSteps: 3 }],
	["deleteItem (file)", { accountId: "acc", fileId: "F1" }, DOCS, { minSteps: 2 }],
	["deleteItem (folder)", { accountId: "acc", fileId: "D2" }, DOCS, { minSteps: 3 }],
	["checkCredentials", { credentials: { common: { accessToken: "tok", refreshToken: "ref" } } }, {}],
	["exchangeCode", { code: "c", codeVerifier: "v" }, {}, { minSteps: 2, tolerated: (k) => k >= 2 }],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS],
	["deletePhoto", { accountId: "acc", pid: "301" }, PHOTOS],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
	["listPhotos", { accountId: "acc" }, PHOTOS, { minSteps: 2 }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`box ${label}: any request failing (${mode}) is one error reply`, async () => {
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
				const { call } = start(["GET", "POST", "PUT", "DELETE"].map((m) => [m, /./, answer]),
					{ timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
				const r = await call(method, typeof payload === "function" ? payload() : payload, caller);   // exactly one reply, or ask() throws
				if (n < k) {
					assert.strictEqual(r.returnValue, true, `the run with nothing failing failed: ${JSON.stringify(r)}`);
					break;
				}
				reached = k;
				const absorbed = (opts.tolerated && opts.tolerated(k)) || (opts.notJsonOk && mode === "a reply that is not JSON");
				if (!absorbed) {
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
	const denied = start([], { onCall: () => ({ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" }) });
	assert.deepStrictEqual(await denied.call("listFolder", { accountId: "acc" }),
		{ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" });
	const broken = start([], { onCall: () => "not json" });
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", fileId: "1" })).errorCode, "BUS_BAD_REPLY");
});

test("a renewed token that cannot be saved does not stop the reply", async () => {
	const { call } = start([
		["GET", /items/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
		["GET", /items/, () => page([])],
	], { onCall: (uri) => (/readCredentials$/.test(uri) ? { returnValue: true, credentials: STORED } : { returnValue: false, errorCode: -1, errorText: "bus down" }) });
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(json(r).renewedCredentials.refreshToken, "ref2");
});
