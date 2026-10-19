// node --test tests/unit
// The kDrive connector (cloud/kdrive/service/com.palm.service.kdrive) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (endpoint, method, headers, body), its reply, and its errors; the Accounts
// service is answered by the stand-in bus.
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

const SVC = path.join(__dirname, "../../cloud/kdrive/service/com.palm.service.kdrive");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const API = "https://api.infomaniak.com";
const D = API + "/3/drive/42";
const D2 = API + "/2/drive/42";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kdrive-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const AUTHAPP = { appId: "com.palm.app.accounts 812" };
// What verifyToken stores (a personal API token), and what an OAuth sign-in would.
const TOKEN = { accessToken: "tok", accountId: 7, driveId: 42, rootFolderId: 5 };
const OAUTH = { accessToken: "tok", refreshToken: "ref", expiresAt: 1, accountId: 7, driveId: 42, rootFolderId: 5 };

const ok = (data, extra) => ({ status: 200, body: Object.assign({ result: "success", data }, extra || {}) });
const fail = (status, code, description) => ({ status, body: { result: "error", error: { code, description } } });

const PROFILE = { email: "u@example.test", display_name: "U Ser", preferences: { account: { current_account_id: 7 } } };
const ROOT_KIDS = [{ id: 3, type: "dir", name: "Common documents", visibility: "is_in_team_space" },
	{ id: 5, type: "dir", name: "Private", visibility: "is_private_space" }];
const FILE = { id: 99, type: "file", name: "Report.PDF", size: 1234, last_modified_at: 1790000000, parent_id: 5, mime_type: "application/pdf" };
const FILE_ENTRY = { id: "99", type: "file", name: "Report.PDF", size: 1234, modified: "2026-09-21T14:13:20.000Z", path: "99", mimeType: "application/pdf" };
const DIR = { id: 77, type: "dir", name: "Sub", last_modified_at: 1790000000, parent_id: 5 };
const DIR_ENTRY = { id: "77", type: "folder", name: "Sub", modified: "2026-09-21T14:13:20.000Z", path: "77" };

// Discovery from a bare token: profile, drives, the drive root's children.
const DISCOVERY = [
	["GET", /\/2\/profile$/, () => ok(PROFILE)],
	["GET", /\/2\/drive\?account_id=7$/, () => ok([{ id: 42, name: "kDrive" }])],
	["GET", /\/3\/drive\/42\/files\/1\/files\?limit=1000$/, () => ok(ROOT_KIDS)],
];
const DISCOVERY_URLS = [API + "/2/profile", API + "/2/drive?account_id=7", D + "/files/1/files?limit=1000"];

// The service on a stand-in bus. Accounts: readCredentials gives `stored`, writeCredentials is
// recorded. -> { handle, requests, written, call(method, payload, caller) }
function start(routes, { stored = TOKEN, onCall, timeouts } = {}) {
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
const body = (r) => JSON.parse(r.body);
const urls = (requests) => requests.map((q) => q.method + " " + q.url);

test("the service: its bus name, the old methods plus file ops and OAuth (and quit, info); the mojoservice files are gone", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.kdrive");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "moveItem", "quit",
		"upload", "uploadFile", "verifyToken"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const gone of ["commands", "services.json", "sources.json"]) { assert.ok(!fs.existsSync(path.join(SVC, gone)), gone); }
});

test("caller rules: file methods for the FILE_APP_IDS; sign-in, checkCredentials and photo methods open", async () => {
	const { call } = start([["GET", /./, () => ok([])], ["POST", /./, () => ok({ id: 1 })], ["DELETE", /./, () => ok({})]]);
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.kdrive-auth" }, PHOTOS, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", fileId: "99", name: "b", localPath: LOCAL }, who);
			assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m + " " + JSON.stringify(who));
		}
	}
	for (const who of [DOCS, { appId: "org.webosports.app.documents-77" }, { service: "com.palm.stark.files.service" }]) {
		assert.strictEqual((await call("listFolder", { accountId: "acc" }, who)).returnValue, true, JSON.stringify(who));
	}
	assert.strictEqual((await call("getAuthorizeUrl", {}, AUTHAPP)).returnValue, true);
	assert.strictEqual((await call("verifyToken", {}, AUTHAPP)).errorCode, "MISSING_TOKEN", "reached the handler");
	assert.strictEqual((await call("exchangeCode", {}, {})).errorCode, "MISSING_CODE", "reached the handler");
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("listPhotos", { accountId: "acc" }, {})).returnValue, true);
	assert.notStrictEqual((await call("checkCredentials", { credentials: { common: TOKEN } }, ACCOUNTS)).errorCode, "PERMISSION_DENIED");
});

// --- sign-in ---------------------------------------------------------------------------------

test("verifyToken: profile, drives, root listing; the private space is the root; credentials as before", async () => {
	const { call, requests, handle } = start(DISCOVERY.slice());
	const r = await call("verifyToken", { token: "PASTED" }, AUTHAPP);
	assert.deepStrictEqual(r, { returnValue: true, username: "u@example.test", alias: "U Ser",
		credentials: { common: { accessToken: "PASTED", accountId: 7, driveId: 42, rootFolderId: 5 } } });
	assert.deepStrictEqual(urls(requests), DISCOVERY_URLS.map((u) => "GET " + u));
	for (const q of requests) { assert.deepStrictEqual(q.headers, { Authorization: "Bearer PASTED" }); assert.strictEqual(q.body, undefined); }
	assert.strictEqual(handle.calls.length, 0, "no Accounts call");
	// accessToken is taken too; a profile without a name gives the fallbacks
	const { call: c2 } = start([["GET", /\/2\/profile$/, () => ok({ preferences: { account: { current_account_id: 7 } } })], ...DISCOVERY.slice(1)]);
	const r2 = await c2("verifyToken", { accessToken: "T2" }, AUTHAPP);
	assert.strictEqual(r2.username, "kDrive");
	assert.strictEqual(r2.alias, undefined);
	assert.strictEqual(r2.credentials.common.accessToken, "T2");
});

test("verifyToken: no private space is the first folder; no folder at all is the drive root", async () => {
	for (const [kids, want] of [[[{ id: 8, type: "file" }, { id: 9, type: "dir" }], 9], [[{ id: 8, type: "file" }], 1], [[], 1]]) {
		const { call } = start([DISCOVERY[0], DISCOVERY[1], ["GET", /files\/1\/files/, () => ok(kids)]]);
		assert.strictEqual((await call("verifyToken", { token: "t" }, AUTHAPP)).credentials.common.rootFolderId, want, JSON.stringify(kids));
	}
});

test("verifyToken: the drive root's children over every page", async () => {
	const { call, requests } = start([DISCOVERY[0], DISCOVERY[1],
		["GET", /files\/1\/files\?limit=1000$/, () => ok([ROOT_KIDS[0]], { cursor: "C 1", has_more: true })],
		["GET", /files\/1\/files\?limit=1000&cursor=C%201$/, () => ok([ROOT_KIDS[1]], { has_more: false })]]);
	assert.strictEqual((await call("verifyToken", { token: "t" }, AUTHAPP)).credentials.common.rootFolderId, 5);
	assert.strictEqual(requests.length, 4);
});

test("verifyToken: a refused token, no account, no drive are KDRIVE_TOKEN_INVALID; no network is CURL_FAILED", async () => {
	const refused = await start([["GET", /profile$/, () => fail(401, "not_authorized", "Unauthorized")]]).call("verifyToken", { token: "bad" }, AUTHAPP);
	assert.deepStrictEqual(refused, { returnValue: false, errorCode: "KDRIVE_TOKEN_INVALID",
		errorText: "kDrive did not accept the token: kDrive answered HTTP 401: not_authorized: Unauthorized", status: 401 });
	const noAccount = await start([["GET", /profile$/, () => ok({ email: "e" })]]).call("verifyToken", { token: "t" }, AUTHAPP);
	assert.strictEqual(noAccount.errorCode, "KDRIVE_TOKEN_INVALID");
	assert.match(noAccount.errorText, /names no account/);
	const noDrive = await start([DISCOVERY[0], ["GET", /\/2\/drive/, () => ok([])]]).call("verifyToken", { token: "t" }, AUTHAPP);
	assert.strictEqual(noDrive.errorCode, "KDRIVE_TOKEN_INVALID");
	assert.match(noDrive.errorText, /has no kDrive/);
	const net = await start([["GET", /./, () => { throw new Error("down"); }]]).call("verifyToken", { token: "t" }, AUTHAPP);
	assert.strictEqual(net.errorCode, "CURL_FAILED");
	assert.strictEqual((await start([]).call("verifyToken", { token: 5 }, AUTHAPP)).errorCode, "MISSING_TOKEN");
});

test("getAuthorizeUrl: Infomaniak's authorize URL with PKCE, scope drive and the registered redirect", async () => {
	const { call } = start([]);
	const r = await call("getAuthorizeUrl", {}, AUTHAPP);
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://login.infomaniak.com/authorize");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: "PLACEHOLDER_KDRIVE_CLIENT_ID",
		redirect_uri: "http://localhost/kdrive/oauth2callback", scope: "drive",
		code_challenge: crypto.createHash("sha256").update(r.codeVerifier).digest("base64url"), code_challenge_method: "S256",
		state: "kdrive" });
	assert.match(r.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
});

test("exchangeCode: the token request, then discovery with the new token; the drive goes into the credentials", async () => {
	const { call, requests } = start([
		["POST", /login\.infomaniak\.com\/token$/, () => ({ status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 7200, token_type: "Bearer" } })],
		...DISCOVERY,
	]);
	const t0 = Date.now();
	const r = await call("exchangeCode", { code: "CODE", codeVerifier: "VERIFIER" }, ACCOUNTS);
	assert.deepStrictEqual(urls(requests), ["POST https://login.infomaniak.com/token"].concat(DISCOVERY_URLS.map((u) => "GET " + u)));
	// no client_secret: the build has not filled it in here (oauth.js leaves a placeholder out)
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[0].body)), { client_id: "PLACEHOLDER_KDRIVE_CLIENT_ID",
		grant_type: "authorization_code", code: "CODE", redirect_uri: Config.REDIRECT_URI, code_verifier: "VERIFIER" });
	for (const q of requests.slice(1)) { assert.strictEqual(q.headers.Authorization, "Bearer AT"); }
	assert.strictEqual(r.username, "u@example.test");
	assert.strictEqual(r.alias, "U Ser");
	const c = r.credentials.common;
	assert.deepStrictEqual(Object.keys(c), ["accessToken", "refreshToken", "expiresAt", "accountId", "driveId", "rootFolderId"]);
	assert.deepStrictEqual([c.accessToken, c.refreshToken, c.accountId, c.driveId, c.rootFolderId], ["AT", "RT", 7, 42, 5]);
	assert.ok(c.expiresAt >= t0 + 7200e3 && c.expiresAt <= Date.now() + 7200e3);
});

test("exchangeCode: a token without the drive scope (403) makes no account; a refused code is OAUTH_TOKEN_FAILED", async () => {
	const noScope = await start([
		["POST", /\/token$/, () => ({ status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 7200 } })],
		["GET", /profile$/, () => fail(403, "forbidden_error", "require scope \"drive\"")],
	]).call("exchangeCode", { code: "C" }, ACCOUNTS);
	assert.strictEqual(noScope.returnValue, false);
	assert.strictEqual(noScope.errorCode, "KDRIVE_HTTP_ERROR");
	assert.strictEqual(noScope.status, 403);
	assert.strictEqual(noScope.credentials, undefined);
	const refused = await start([["POST", /\/token$/, () => ({ status: 400, body: { error: "invalid_grant" } })]]).call("exchangeCode", { code: "C" }, ACCOUNTS);
	assert.strictEqual(refused.errorCode, "OAUTH_TOKEN_FAILED");
	assert.match(refused.errorText, /invalid_grant/);
});

test("checkCredentials: the profile with the given token; a refused API token is the 401, with no refresh", async () => {
	const { call, requests } = start([["GET", /\/2\/profile$/, (q) => (q.headers.Authorization === "Bearer good" ? ok(PROFILE) : fail(401, "not_authorized", "x"))]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: Object.assign({}, TOKEN, { accessToken: "good" }) } }, ACCOUNTS),
		{ returnValue: true, renewedCredentials: null, username: "u@example.test", displayName: "U Ser" });
	assert.deepStrictEqual(urls(requests), ["GET " + API + "/2/profile"]);
	const bad = await call("checkCredentials", { credentials: { common: Object.assign({}, TOKEN, { accessToken: "bogus" }) } }, ACCOUNTS);
	assert.strictEqual(bad.errorCode, "KDRIVE_HTTP_ERROR");
	assert.strictEqual(bad.status, 401);
	assert.strictEqual(requests.length, 2, "no refresh without a refresh token");
	assert.strictEqual((await call("checkCredentials", {}, ACCOUNTS)).errorCode, "401_UNAUTHORIZED");
});

// --- credentials ---------------------------------------------------------------------------

test("credentials by accountId: readCredentials name common; none stored is NO_STORED_CREDENTIALS", async () => {
	const { call, handle } = start([["GET", /files\/5\/files/, () => ok([])]]);
	await call("listFolder", { accountId: "acc-1" });
	assert.deepStrictEqual(handle.calls, [{ uri: "luna://com.palm.service.accounts/readCredentials", args: { accountId: "acc-1", name: "common" } }]);
	const none = start([], { stored: null });
	assert.strictEqual((await none.call("listFolder", { accountId: "acc" })).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await none.call("listFolder", {})).errorCode, "NO_CREDENTIALS");
});

test("a bare token (inline, no drive): found first, reported; by accountId it is saved too", async () => {
	const { call, requests, handle } = start([...DISCOVERY, ["GET", /files\/5\/files\?limit=1000$/, () => ok([FILE])]]);
	const r = await call("listFolder", { credentials: { common: { accessToken: "bare" } } });
	assert.deepStrictEqual(urls(requests), DISCOVERY_URLS.concat([D + "/files/5/files?limit=1000"]).map((u) => "GET " + u));
	assert.deepStrictEqual(r.renewedCredentials, { accessToken: "bare", accountId: 7, driveId: 42, rootFolderId: 5 });
	assert.deepStrictEqual(r.entries, [FILE_ENTRY]);
	assert.strictEqual(handle.calls.length, 0);
	const stored = start([...DISCOVERY, ["GET", /files\/5\/files/, () => ok([])]], { stored: { accessToken: "old" } });
	await stored.call("listFolder", { accountId: "acc" });
	assert.deepStrictEqual(stored.written, [{ accountId: "acc", name: "common", credentials: { accessToken: "old", accountId: 7, driveId: 42, rootFolderId: 5 } }]);
});

test("a drive without a root folder id: one root listing, then kept", async () => {
	const { call, requests, written } = start([["GET", /files\/1\/files/, () => ok(ROOT_KIDS)], ["GET", /files\/5\/files/, () => ok([])]],
		{ stored: { accessToken: "tok", accountId: 7, driveId: 42 } });
	const r = await call("listFolder", { accountId: "acc" });
	assert.deepStrictEqual(urls(requests), ["GET " + D + "/files/1/files?limit=1000", "GET " + D + "/files/5/files?limit=1000"]);
	assert.strictEqual(r.renewedCredentials.rootFolderId, 5);
	assert.strictEqual(written.length, 1);
});

test("OAuth credentials: a 401 refreshes, retries with the new token, and keeps the drive fields", async () => {
	const { call, requests, written } = start([
		["GET", /files\/77\/files/, () => fail(401, "not_authorized", "expired"), { once: true }],
		["POST", /login\.infomaniak\.com\/token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 3600 } })],
		["GET", /files\/77\/files/, (q) => (q.headers.Authorization === "Bearer tok2" ? ok([FILE]) : fail(401, "x", "y"))],
	], { stored: OAUTH });
	const t0 = Date.now();
	const r = await call("listFolder", { accountId: "acc", folderId: "77" });
	assert.deepStrictEqual(urls(requests), ["GET " + D + "/files/77/files?limit=1000", "POST " + Config.TOKEN_URL, "GET " + D + "/files/77/files?limit=1000"]);
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[1].body)), { client_id: Config.CLIENT_ID, grant_type: "refresh_token", refresh_token: "ref" });
	assert.strictEqual(r.returnValue, true);
	const n = r.renewedCredentials;
	assert.deepStrictEqual([n.accessToken, n.refreshToken, n.accountId, n.driveId, n.rootFolderId], ["tok2", "ref", 7, 42, 5]);
	assert.ok(n.expiresAt >= t0 + 3600e3);
	assert.deepStrictEqual(written, [{ accountId: "acc", name: "common", credentials: n }]);
});

test("a 401 whose refresh fails: the refresh's error, nothing saved, no retry", async () => {
	const { call, requests, written } = start([
		["GET", /files/, () => ({ status: 401 })],
		["POST", /\/token$/, () => ({ status: 400, body: { error: "invalid_grant" } })],
	], { stored: OAUTH });
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.errorCode, "OAUTH_TOKEN_FAILED");
	assert.strictEqual(requests.length, 2);
	assert.deepStrictEqual(written, []);
});

test("API errors: an error status is KDRIVE_HTTP_ERROR with kDrive's code; an error envelope on a 200 is KDRIVE_API_ERROR", async () => {
	const { call } = start([
		["POST", /directory$/, () => fail(403, "forbidden_error", "Forbidden")],
		["GET", /files\/77\/files/, () => ({ status: 200, body: { result: "error", error: { code: "object_not_found", description: "Gone" } } })],
	]);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", name: "New" }),
		{ returnValue: false, errorCode: "KDRIVE_HTTP_ERROR", errorText: "kDrive answered HTTP 403: forbidden_error: Forbidden", status: 403 });
	assert.deepStrictEqual(await call("listFolder", { accountId: "acc", folderId: "77" }),
		{ returnValue: false, errorCode: "KDRIVE_API_ERROR", errorText: "kDrive: object_not_found: Gone" });
});

// --- files -----------------------------------------------------------------------------------

test("listFolder: v3 files of the folder, every page, entries normalised (string ids, ISO dates)", async () => {
	const { call, requests } = start([
		["GET", /files\/77\/files\?limit=1000$/, () => ok([FILE], { cursor: "c/1", has_more: true })],
		["GET", /files\/77\/files\?limit=1000&cursor=c%2F1$/, () => ok([DIR], { cursor: "c2", has_more: false })],
	]);
	const r = await call("listFolder", { accountId: "acc", folderId: "77" });
	assert.deepStrictEqual(json(r), { returnValue: true, renewedCredentials: null, entries: [FILE_ENTRY, DIR_ENTRY] });
	assert.deepStrictEqual(urls(requests), ["GET " + D + "/files/77/files?limit=1000", "GET " + D + "/files/77/files?limit=1000&cursor=c%2F1"]);
	for (const q of requests) { assert.deepStrictEqual(q.headers, { Authorization: "Bearer tok" }); }
});

test("listFolder: every root locator is the private space, never the drive root", async () => {
	const { call, requests } = start([["GET", /files\/5\/files/, () => ok([])]]);
	for (const root of [{}, { path: "" }, { path: "/" }, { folderId: "root" }, { folderId: "1" }, { folderId: 1 }]) {
		assert.strictEqual((await call("listFolder", Object.assign({ accountId: "acc" }, root))).returnValue, true, JSON.stringify(root));
		assert.strictEqual(requests[requests.length - 1].url, D + "/files/5/files?limit=1000", JSON.stringify(root));
	}
	assert.strictEqual(requests.length, 6);
});

test("downloadFile: v2 download of the file id, the bytes to localPath (folders 0755)", async () => {
	const BYTES = crypto.randomBytes(70000);
	const { call, requests } = start([["GET", /\/2\/drive\/42\/files\/99\/download$/, () => new Response(BYTES, { status: 200 })]]);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", fileId: "99", localPath: dest });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.deepStrictEqual(urls(requests), ["GET " + D2 + "/files/99/download"]);
	assert.deepStrictEqual(requests[0].headers, { Authorization: "Bearer tok" });
});

test("downloadFile: a 404 is KDRIVE_DOWNLOAD_FAILED and writes no file; MISSING_ARGS without localPath", async () => {
	const { call } = start([["GET", /download$/, () => fail(404, "object_not_found", "Not found")]]);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", fileId: "98", localPath: dest });
	assert.strictEqual(r.errorCode, "KDRIVE_DOWNLOAD_FAILED");
	assert.strictEqual(r.status, 404);
	assert.ok(!fs.existsSync(dest));
	assert.strictEqual((await call("downloadFile", { accountId: "acc", fileId: "98" })).errorCode, "MISSING_ARGS");
});

test("uploadFile: v3 upload into the folder, name, conflict=version, total_size; the file is the body", async () => {
	const { call, requests } = start([["POST", /\/3\/drive\/42\/upload\?/, () => ok({ id: 1001, name: "Notes é.txt", size: 5000, parent_id: 77 })]]);
	const r = await call("uploadFile", { accountId: "acc", folderId: "77", localPath: LOCAL, name: "Notes é.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Notes é.txt", id: "1001", size: 5000 });
	const q = requests[0];
	assert.strictEqual(q.url, D + "/upload?directory_id=77&file_name=Notes%20%C3%A9.txt&conflict=version&total_size=5000");
	assert.deepStrictEqual(q.headers, { "Content-Type": "application/octet-stream", Authorization: "Bearer tok" });
	assert.strictEqual(q.body.blob, LOCAL_BYTES.length, "a Blob of the file, streamed by fetch");
});

test("uploadFile: the root is the private space; the local name by default", async () => {
	const { call, requests } = start([["POST", /upload\?/, () => ok({ id: 1 })]]);
	await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	await call("uploadFile", { accountId: "acc", folderId: "root", localPath: LOCAL, name: "b.txt" });
	assert.deepStrictEqual(requests.map((q) => new URL(q.url).searchParams.get("directory_id") + "/" + new URL(q.url).searchParams.get("file_name")),
		["5/local.bin", "5/b.txt"]);
});

test("uploadFile replace:true: the file's name and folder, then a new version of it", async () => {
	const { call, requests } = start([
		["GET", /\/3\/drive\/42\/files\/99$/, () => ok(FILE)],
		["POST", /upload\?/, () => ok({ id: 99, name: "Report.PDF", size: 5000 })],
	]);
	const r = await call("uploadFile", { accountId: "acc", fileId: "99", localPath: LOCAL, replace: true });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Report.PDF", id: "99", size: 5000 });
	assert.deepStrictEqual(urls(requests), ["GET " + D + "/files/99",
		"POST " + D + "/upload?directory_id=5&file_name=Report.PDF&conflict=version&total_size=5000"]);
	const { call: c2, requests: r2 } = start([["GET", /files\/99$/, () => ok({ name: "x" })], ["POST", /./, () => ok({})]]);
	assert.strictEqual((await c2("uploadFile", { accountId: "acc", fileId: "99", localPath: LOCAL, replace: true })).errorCode, "KDRIVE_NO_FILEINFO");
	assert.strictEqual(r2.length, 1);
});

test("uploadFile: a local file that is not there is LOCAL_FILE_ERROR, and nothing is sent", async () => {
	const { call, requests } = start([["POST", /./, () => ok({})]]);
	assert.strictEqual((await call("uploadFile", { accountId: "acc", folderId: "77", localPath: path.join(TMP, "nope.bin") })).errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual(requests.length, 0);
});

test("createFolder: v3 directory { name } under the parent (the private space for the root); the entry is a folder", async () => {
	const { call, requests } = start([["POST", /\/directory$/, () => ok({ id: 500, name: "New", type: "file", last_modified_at: 1790000000, parent_id: 77 })]]);
	const r = await call("createFolder", { accountId: "acc", folderId: "77", name: "New" });
	assert.deepStrictEqual(json(r), { returnValue: true, renewedCredentials: null,
		entry: { id: "500", type: "folder", name: "New", modified: "2026-09-21T14:13:20.000Z", path: "500" } });
	assert.deepStrictEqual(urls(requests), ["POST " + D + "/files/77/directory"]);
	assert.deepStrictEqual(body(requests[0]), { name: "New" });
	assert.deepStrictEqual(requests[0].headers, { "Content-Type": "application/json", Authorization: "Bearer tok" });
	for (const root of [{}, { path: "/" }, { folderId: "root" }, { folderId: "1" }]) {
		await call("createFolder", Object.assign({ accountId: "acc", name: "Top" }, root));
		assert.strictEqual(requests[requests.length - 1].url, D + "/files/5/directory", JSON.stringify(root));
	}
	assert.strictEqual((await call("createFolder", { accountId: "acc", name: "a/b" })).errorCode, "MISSING_ARGS");
});

test("moveItem: a rename only is v2 rename { name }, then the item for the entry", async () => {
	const { call, requests } = start([
		["POST", /\/2\/drive\/42\/files\/99\/rename$/, () => ok({ cancel_id: "c", valid_until: 1 })],
		["GET", /\/3\/drive\/42\/files\/99$/, () => ok(Object.assign({}, FILE, { name: "Final.pdf" }))],
	]);
	const r = await call("moveItem", { accountId: "acc", fileId: "99", name: "Final.pdf" });
	assert.deepStrictEqual(urls(requests), ["POST " + D2 + "/files/99/rename", "GET " + D + "/files/99"]);
	assert.deepStrictEqual(body(requests[0]), { name: "Final.pdf" });
	assert.deepStrictEqual(json(r.entry), json(Object.assign({}, FILE_ENTRY, { name: "Final.pdf" })));
});

test("moveItem: a move is v3 move/{to} { conflict:error }, with the name for a move and rename; toRoot is the private space", async () => {
	const { call, requests } = start([
		["POST", /\/3\/drive\/42\/files\/99\/move\/\d+$/, () => ok({ cancel_id: "c" })],
		["GET", /\/3\/drive\/42\/files\/99$/, () => ok(Object.assign({}, FILE, { parent_id: 77 }))],
	]);
	const r = await call("moveItem", { accountId: "acc", fileId: "99", toFolderId: "77" });
	assert.deepStrictEqual(urls(requests), ["POST " + D + "/files/99/move/77", "GET " + D + "/files/99"]);
	assert.deepStrictEqual(body(requests[0]), { conflict: "error" });
	assert.strictEqual(r.entry.id, "99");
	await call("moveItem", { accountId: "acc", fileId: "99", toFolderId: "77", name: "Old.pdf" });
	assert.deepStrictEqual(body(requests[2]), { conflict: "error", name: "Old.pdf" });
	await call("moveItem", { accountId: "acc", fileId: "99", toRoot: true });
	assert.strictEqual(requests[4].url, D + "/files/99/move/5");
});

test("moveItem: a conflict is the error; the root and the private space are never moved", async () => {
	const { call, requests } = start([["POST", /move/, () => fail(409, "conflict_error", "exists")]]);
	const c = await call("moveItem", { accountId: "acc", fileId: "99", toFolderId: "77" });
	assert.strictEqual(c.errorCode, "KDRIVE_HTTP_ERROR");
	assert.strictEqual(c.status, 409);
	assert.strictEqual(requests.length, 1);
	for (const item of ["5", "1", "root"]) {
		assert.strictEqual((await call("moveItem", { accountId: "acc", fileId: item, toFolderId: "77" })).errorCode, "BAD_ARGS", item);
	}
	assert.strictEqual(requests.length, 1);
});

test("deleteItem: v2 DELETE of the id (to the trash); the drive root and the private space are refused before any request", async () => {
	const { call, requests } = start([["DELETE", /\/2\/drive\/42\/files\/99$/, () => ok({ cancel_id: "c" })]]);
	assert.deepStrictEqual(await call("deleteItem", { accountId: "acc", fileId: "99" }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(urls(requests), ["DELETE " + D2 + "/files/99"]);
	assert.deepStrictEqual(requests[0].headers, { Authorization: "Bearer tok" });
	for (const root of ["5", "1", "root", "/"]) { assert.strictEqual((await call("deleteItem", { accountId: "acc", fileId: root })).errorCode, "BAD_ARGS", root); }
	assert.strictEqual((await call("deleteItem", { accountId: "acc", fileId: "" })).errorCode, "MISSING_ARGS");
	assert.strictEqual(requests.length, 1);
	// a private space the credentials do not name yet is found first, and refused too
	const { call: c2, requests: r2 } = start([["GET", /files\/1\/files/, () => ok(ROOT_KIDS)], ["DELETE", /./, () => ok({})]],
		{ stored: { accessToken: "tok", accountId: 7, driveId: 42 } });
	assert.strictEqual((await c2("deleteItem", { accountId: "acc", fileId: "5" })).errorCode, "BAD_ARGS");
	assert.deepStrictEqual(urls(r2), ["GET " + D + "/files/1/files?limit=1000"]);
});

// --- photos ----------------------------------------------------------------------------------

const PIC = { id: 301, type: "file", name: "IMG_1.JPG", size: 10 };
const PIC2 = { id: 302, type: "file", name: "scan", mime_type: "image/png" };
const ALBUM_ROUTES = [
	["GET", /files\/5\/files/, () => ok([FILE, { id: 300, type: "dir", name: "pictures" }])],
	["GET", /files\/300\/files/, () => ok([PIC, PIC2, FILE, { id: 303, type: "dir", name: "x.jpg" }])],
];

test("listAlbums: the Pictures folder (any case) under the private space, counting its images", async () => {
	const { call, requests } = start(ALBUM_ROUTES.slice());
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS),
		{ returnValue: true, albums: [{ aid: "300", name: "Pictures", size: { images: 2 } }] });
	assert.deepStrictEqual(urls(requests), ["GET " + D + "/files/5/files?limit=1000", "GET " + D + "/files/300/files?limit=1000"]);
});

test("listAlbums: no album folder is aid \"\" with 0 images; one that cannot be listed is 0; no credentials is an error", async () => {
	assert.deepStrictEqual((await start([["GET", /files\/5\/files/, () => ok([FILE])]]).call("listAlbums", { accountId: "acc" }, PHOTOS)).albums,
		[{ aid: "", name: "Pictures", size: { images: 0 } }]);
	assert.deepStrictEqual((await start([ALBUM_ROUTES[0], ["GET", /300/, () => ({ status: 500 })]]).call("listAlbums", { accountId: "acc" }, PHOTOS)).albums,
		[{ aid: "300", name: "Pictures", size: { images: 0 } }]);
	assert.deepStrictEqual((await start([["GET", /./, () => ({ status: 500 })]]).call("listAlbums", { accountId: "acc" }, PHOTOS)).albums[0].aid, "");
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: one photo per image, download and thumbnail URLs carrying the token", async () => {
	const { call, requests } = start(ALBUM_ROUTES.slice(1));
	const r = await call("listPhotos", { accountId: "acc", aid: "300" }, PHOTOS);
	const url = (id, kind) => D2 + "/files/" + id + "/" + kind + "?access_token=tok";
	assert.deepStrictEqual(r, { returnValue: true, photos: [
		{ pid: "301", src_big: url(301, "download"), src_small: url(301, "thumbnail"), caption: "IMG_1.JPG", type: "image", fileName: "IMG_1.JPG" },
		{ pid: "302", src_big: url(302, "download"), src_small: url(302, "thumbnail"), caption: "scan", type: "image", fileName: "scan" }] });
	assert.strictEqual(requests.length, 1);
});

test("listPhotos: no album (aid \"\") is no photos and no request; the listing failing fails the call", async () => {
	const { call, requests, handle } = start([]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "" }, PHOTOS), { returnValue: true, photos: [] });
	assert.strictEqual(requests.length + handle.calls.length, 0);
	assert.strictEqual((await start([["GET", /./, () => ({ status: 500, body: "oops" })]]).call("listPhotos", { accountId: "acc", aid: "300" }, PHOTOS)).errorCode,
		"KDRIVE_HTTP_ERROR");
});

test("upload (Photos): into the album id given; else the Pictures folder, made when missing; pid is the file id", async () => {
	const up = ["POST", /upload\?/, () => ok({ id: 9001, name: "local.bin", size: 5000 })];
	const { call, requests } = start([up, ...ALBUM_ROUTES]);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: "300", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "9001", name: "local.bin", size: 5000 });
	await call("upload", { accountId: "acc", path: LOCAL }, PHOTOS);
	assert.deepStrictEqual(urls(requests).map((u) => u.replace(/&.*/, "")), ["POST " + D + "/upload?directory_id=300",
		"GET " + D + "/files/5/files?limit=1000", "POST " + D + "/upload?directory_id=300"]);
	const fresh = start([up, ["GET", /files\/5\/files/, () => ok([])], ["POST", /directory$/, () => ok({ id: 400, name: "Pictures" })]]);
	await fresh.call("upload", { accountId: "acc", albumId: "", path: LOCAL }, PHOTOS);
	assert.deepStrictEqual(urls(fresh.requests).map((u) => u.replace(/&.*/, "")), ["GET " + D + "/files/5/files?limit=1000",
		"POST " + D + "/files/5/directory", "POST " + D + "/upload?directory_id=400"]);
	assert.deepStrictEqual(body(fresh.requests[1]), { name: "Pictures" });
});

test("deletePhoto: v2 DELETE of the pid; a refusal is KDRIVE_DELETE_FAILED", async () => {
	const { call, requests } = start([["DELETE", /files\/301$/, () => ok({})], ["DELETE", /files\/302$/, () => fail(403, "access_denied", "no")]]);
	assert.deepStrictEqual(await call("deletePhoto", { accountId: "acc", pid: "301" }, PHOTOS), { returnValue: true, pid: "301" });
	assert.deepStrictEqual(urls(requests), ["DELETE " + D2 + "/files/301"]);
	const r = await call("deletePhoto", { accountId: "acc", pid: "302" }, PHOTOS);
	assert.strictEqual(r.errorCode, "KDRIVE_DELETE_FAILED");
	assert.strictEqual(r.status, 403);
});

// --- every request failing, in turn ----------------------------------------------------------

// What kDrive answers when nothing fails. The drive root holds the private space (5); the
// private space holds a Pictures folder (300) and a file; everything else holds one image.
function happy(q) {
	const u = q.url;
	if (/login\.infomaniak\.com\/token$/.test(u)) { return { status: 200, body: { access_token: "AT2", refresh_token: "RT2", expires_in: 3600 } }; }
	if (/\/2\/profile$/.test(u)) { return ok(PROFILE); }
	if (/\/2\/drive\?/.test(u)) { return ok([{ id: 42 }]); }
	if (/files\/1\/files\?limit=1000$/.test(u)) { return ok(ROOT_KIDS); }
	if (/files\/5\/files\?limit=1000$/.test(u)) { return ok([{ id: 300, type: "dir", name: "Pictures" }], { cursor: "n", has_more: true }); }
	if (/files\/\d+\/files/.test(u)) { return ok([PIC]); }
	if (/download$/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (/upload\?/.test(u)) { return ok({ id: 9, name: "n", size: 1 }); }
	if (/directory$/.test(u)) { return ok({ id: 400, name: "Pictures" }); }
	if (/\/files\/\d+$/.test(u) && q.method === "GET") { return ok(FILE); }
	return ok({ cancel_id: "c" });
}

// How the failing request fails. "401" is an expired token whose refresh is refused too.
const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401 and a refused refresh": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": (q) => (/download$/.test(q.url) ? { status: 200, body: "ok" } : { status: 200, body: "<html>" }),
	"an error envelope": (q) => (/download$/.test(q.url) ? { status: 200, body: "ok" } : { status: 200, body: { result: "error", error: { code: "x" } } }),
};

const BARE = { credentials: { common: { accessToken: "tok", refreshToken: "ref" } } };

// [label, payload, caller, { minSteps, tolerated(k) -> true when request k failing is absorbed, stored }]
const OPS = [
	["verifyToken", { token: "t" }, AUTHAPP, { minSteps: 3 }],
	["exchangeCode", { code: "c", codeVerifier: "v" }, ACCOUNTS, { minSteps: 4 }],
	["checkCredentials", { credentials: { common: OAUTH } }, ACCOUNTS],
	["listFolder", { accountId: "acc", folderId: "77" }, DOCS],
	["listFolder (root, paged)", { accountId: "acc" }, DOCS, { minSteps: 2 }],
	["listFolder (bare token)", BARE, DOCS, { minSteps: 4 }],
	["downloadFile", () => ({ accountId: "acc", fileId: "99", localPath: dl() }), DOCS, { notJsonOk: true }],
	["uploadFile", { accountId: "acc", folderId: "77", localPath: LOCAL }, DOCS],
	["uploadFile (replace)", { accountId: "acc", fileId: "99", localPath: LOCAL, replace: true }, DOCS, { minSteps: 2 }],
	["createFolder", { accountId: "acc", folderId: "77", name: "n" }, DOCS],
	["moveItem (rename)", { accountId: "acc", fileId: "99", name: "b.pdf" }, DOCS, { minSteps: 2 }],
	["moveItem (move)", { accountId: "acc", fileId: "99", toFolderId: "77" }, DOCS, { minSteps: 2 }],
	["deleteItem", { accountId: "acc", fileId: "99" }, DOCS],
	["deleteItem (root unknown)", { accountId: "acc", fileId: "99" }, DOCS, { minSteps: 2, stored: { accessToken: "tok", refreshToken: "ref", driveId: 42 } }],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS, { minSteps: 2 }],
	["deletePhoto", { accountId: "acc", pid: "301" }, PHOTOS],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 3, tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: "300" }, PHOTOS],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, failWith] of Object.entries(MODES)) {
		test(`kdrive ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 12; k++) {
				let n = 0;
				const refreshAfter401 = mode.startsWith("a 401");
				const answer = (q) => {
					n++;
					if (n === k) { return failWith(q); }
					if (refreshAfter401 && n > k && /\/token$/.test(q.url)) { return { status: 400, body: { error: "invalid_grant" } }; }
					return happy(q);
				};
				const { call } = start([["GET", /./, answer], ["POST", /./, answer], ["DELETE", /./, answer]],
					{ stored: opts.stored || OAUTH, timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
				const r = await call(method, typeof payload === "function" ? payload() : payload, caller);   // exactly one reply, or ask() throws
				if (n < k) {
					assert.strictEqual(r.returnValue, true, `the run with nothing failing failed: ${JSON.stringify(r)}`);
					break;
				}
				reached = k;
				const absorbed = (opts.tolerated && opts.tolerated(k)) || (opts.notJsonOk && mode !== "a 500 reply" && mode !== "no answer (network)" &&
					mode !== "a stalled reply" && mode !== "a 401 and a refused refresh");
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
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", fileId: "99" })).errorCode, "BUS_BAD_REPLY");
});

test("found drive fields that cannot be saved do not stop the reply", async () => {
	const { call } = start([...DISCOVERY, ["GET", /files\/5\/files/, () => ok([])]],
		{ onCall: (uri) => (/readCredentials$/.test(uri) ? { returnValue: true, credentials: { accessToken: "old" } } : { returnValue: false, errorCode: -1, errorText: "bus down" }) });
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.renewedCredentials.driveId, 42);
});
