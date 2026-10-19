// node --test tests/unit
// The Dropbox connector (cloud/dropbox/service/com.palm.service.dropbox) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (endpoint, method, headers, body), its reply, and its errors; the Accounts
// service is answered by the stand-in bus.
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
const crypto = require("node:crypto");
const { fakePalmbus, fakeFetch, ask, json } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/dropbox/service/com.palm.service.dropbox");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dropbox-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const STORED = { accessToken: "tok", refreshToken: "ref", expiresAt: 1 };

const FILE = { ".tag": "file", name: "Report.PDF", id: "id:F1", path_lower: "/docs/report.pdf",
	path_display: "/Docs/Report.PDF", size: 1234, server_modified: "2026-10-01T10:00:00Z" };
const FILE_ENTRY = { id: "id:F1", type: "file", name: "Report.PDF", size: 1234,
	modified: "2026-10-01T10:00:00Z", path: "/docs/report.pdf" };
const JPG = { ".tag": "file", name: "IMG_1.JPG", id: "id:P1", path_lower: "/camera uploads/img_1.jpg" };
const CONFLICT = { error_summary: "path/conflict/folder/..", error: { ".tag": "path",
	path: { ".tag": "conflict", conflict: { ".tag": "folder" } } } };

// The service on a stand-in bus. Accounts: readCredentials gives `stored`, writeCredentials is
// recorded. -> { handle, requests, written, call(method, payload, caller) }
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
		call: (method, payload, caller = DOCS) => ask(handle, method, payload, caller) };
}
const body = (r) => JSON.parse(r.body);
const arg = (r) => JSON.parse(r.headers["Dropbox-API-Arg"]);

test("the service: its bus name, and every method the old services.json had (plus quit, info)", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.dropbox");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "moveItem", "quit",
		"upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
});

test("caller rules: file methods for the FILE_APP_IDS, auth and photo methods open", async () => {
	const { call } = start([["POST", /./, () => ({ status: 200, body: { entries: [], email: "e" } })]]);
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
	assert.strictEqual((await call("listPhotos", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: STORED } }, { service: "com.palm.service.accounts" })).returnValue, true);
});

test("getAuthorizeUrl: Dropbox's consent URL with PKCE and token_access_type=offline", async () => {
	const { call } = start([]);
	const r = await call("getAuthorizeUrl", {}, {});
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://www.dropbox.com/oauth2/authorize");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: Config.CLIENT_ID,
		redirect_uri: "http://localhost/dropbox/oauth2callback", scope: Config.SCOPE,
		code_challenge: crypto.createHash("sha256").update(r.codeVerifier).digest("base64url"), code_challenge_method: "S256",
		token_access_type: "offline", state: "dropbox" });
	assert.match(r.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
});

test("exchangeCode: the token request (no secret: a public client), then the account for the username", async () => {
	const { call, requests } = start([
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 14400, token_type: "bearer" } })],
		["POST", /users\/get_current_account$/, () => ({ status: 200, body: { email: "u@example.test", name: { display_name: "U Ser" } } })],
	]);
	const r = await call("exchangeCode", { code: "CODE", codeVerifier: "VERIFIER" }, { service: "com.palm.service.accounts" });
	assert.deepStrictEqual(requests.map((q) => q.method + " " + q.url), ["POST " + Config.TOKEN_URL, "POST " + API + "/users/get_current_account"]);
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[0].body)), { client_id: Config.CLIENT_ID,
		grant_type: "authorization_code", code: "CODE", redirect_uri: Config.REDIRECT_URI, code_verifier: "VERIFIER" });
	assert.strictEqual(requests[1].headers.Authorization, "Bearer AT");
	assert.strictEqual(requests[1].headers["Content-Type"], "application/json");
	assert.strictEqual(requests[1].body, "{}");
	assert.strictEqual(r.username, "u@example.test");
	assert.strictEqual(r.alias, "U Ser");
	assert.deepStrictEqual(Object.keys(r.credentials.common), ["accessToken", "refreshToken", "expiresAt"]);
	assert.strictEqual(r.credentials.common.accessToken, "AT");
});

test("checkCredentials: get_current_account with the given token; a rejected token is an error", async () => {
	const { call, requests } = start([["POST", /get_current_account$/, (q) => (q.headers.Authorization === "Bearer good"
		? { status: 200, body: { email: "u@example.test", name: { display_name: "U" } } } : { status: 401, body: { error_summary: "invalid_access_token/" } })]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "good" } } }, {}),
		{ returnValue: true, renewedCredentials: null, username: "u@example.test", displayName: "U" });
	const bad = await call("checkCredentials", { credentials: { common: { accessToken: "bogus", refreshToken: "bogus", expiresAt: 1 } } }, {});
	assert.strictEqual(bad.returnValue, false);
	assert.strictEqual(bad.errorCode, "OAUTH_TOKEN_FAILED");   // the 401, then the refresh refused (no route: 599)
	assert.strictEqual(requests.length, 3);
	assert.strictEqual((await call("checkCredentials", {}, {})).errorCode, "401_UNAUTHORIZED");
});

test("listFolder: list_folder with the path, every page, entries normalised; the root is \"\"", async () => {
	const { call, requests } = start([
		["POST", /\/files\/list_folder$/, () => ({ status: 200, body: { entries: [FILE], cursor: "C1", has_more: true } })],
		["POST", /\/files\/list_folder\/continue$/, () => ({ status: 200, body: { entries: [{ ".tag": "folder", name: "Sub", id: "id:D1", path_lower: "/docs/sub" }], cursor: "C2", has_more: false } })],
	]);
	const r = await call("listFolder", { accountId: "acc", path: "/docs" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entries: [FILE_ENTRY,
		{ id: "id:D1", type: "folder", name: "Sub", path: "/docs/sub" }] });
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/files/list_folder", API + "/files/list_folder/continue"]);
	assert.deepStrictEqual(body(requests[0]), { path: "/docs" });
	assert.deepStrictEqual(body(requests[1]), { cursor: "C1" });
	for (const q of requests) {
		assert.strictEqual(q.method, "POST");
		assert.deepStrictEqual(q.headers, { "Content-Type": "application/json", Authorization: "Bearer tok" });
	}
	for (const root of [{}, { path: "" }, { path: "/" }, { folderId: "root" }]) {
		await call("listFolder", Object.assign({ accountId: "acc" }, root));
		assert.deepStrictEqual(body(requests[requests.length - 2]), { path: "" }, JSON.stringify(root));
	}
});

test("listFolder: inline credentials, without the Accounts service", async () => {
	const { call, requests, handle } = start([["POST", /list_folder$/, () => ({ status: 200, body: { entries: [] } })]]);
	await call("listFolder", { credentials: { common: { accessToken: "inline" } } });
	assert.strictEqual(requests[0].headers.Authorization, "Bearer inline");
	assert.strictEqual(handle.calls.length, 0);
});

test("credentials by accountId: readCredentials name common; none stored is NO_STORED_CREDENTIALS", async () => {
	const { call, handle } = start([["POST", /list_folder$/, () => ({ status: 200, body: { entries: [] } })]]);
	await call("listFolder", { accountId: "acc-1" });
	assert.deepStrictEqual(handle.calls, [{ uri: "luna://com.palm.service.accounts/readCredentials", args: { accountId: "acc-1", name: "common" } }]);
	const none = start([], { stored: null });
	assert.strictEqual((await none.call("listFolder", { accountId: "acc" })).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await none.call("listFolder", {})).errorCode, "NO_CREDENTIALS");
});

test("a 401: refresh with the refresh token, retry with the new one, save it to the account, report it", async () => {
	const { call, requests, written } = start([
		["POST", /list_folder$/, () => ({ status: 401, body: { error_summary: "expired_access_token/" } }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 3600, token_type: "bearer" } })],
		["POST", /list_folder$/, (q) => (q.headers.Authorization === "Bearer tok2" ? { status: 200, body: { entries: [FILE] } } : { status: 401 })],
	]);
	const t0 = Date.now();
	const r = await call("listFolder", { accountId: "acc", path: "/docs" });
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/files/list_folder", Config.TOKEN_URL, API + "/files/list_folder"]);
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[1].body)), { client_id: Config.CLIENT_ID, grant_type: "refresh_token", refresh_token: "ref" });
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.entries.length, 1);
	assert.strictEqual(r.renewedCredentials.accessToken, "tok2");
	assert.strictEqual(r.renewedCredentials.refreshToken, "ref");
	assert.ok(r.renewedCredentials.expiresAt >= t0 + 3600e3);
	assert.deepStrictEqual(written, [{ accountId: "acc", name: "common", credentials: r.renewedCredentials }]);
});

test("a 401 whose refresh fails: the refresh's error, nothing saved, no retry", async () => {
	const { call, requests, written } = start([
		["POST", /list_folder$/, () => ({ status: 401 })],
		["POST", /oauth2\/token$/, () => ({ status: 400, body: { error: "invalid_grant" } })],
	]);
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.errorCode, "OAUTH_TOKEN_FAILED");
	assert.match(r.errorText, /invalid_grant/);
	assert.strictEqual(requests.length, 2);
	assert.deepStrictEqual(written, []);
});

test("an API error: DROPBOX_API_ERROR with the status and Dropbox's error_summary", async () => {
	const { call } = start([["POST", /create_folder_v2$/, () => ({ status: 409, body: CONFLICT })]]);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", path: "/docs", name: "New" }),
		{ returnValue: false, errorCode: "DROPBOX_API_ERROR", errorText: "Dropbox answered HTTP 409: path/conflict/folder/..", status: 409 });
});

test("downloadFile: content /files/download, the path in Dropbox-API-Arg, the bytes to localPath (folders 0755)", async () => {
	const BYTES = crypto.randomBytes(70000);
	const { call, requests } = start([["POST", /content\.dropboxapi\.com\/2\/files\/download$/, () => new Response(BYTES, { status: 200 })]]);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", fileId: "/Docs/Café ünï \u{1F4C4}.pdf", localPath: dest });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.strictEqual(requests[0].url, CONTENT + "/files/download");
	assert.strictEqual(requests[0].method, "POST");
	assert.strictEqual(requests[0].headers.Authorization, "Bearer tok");
	assert.strictEqual(requests[0].headers["Dropbox-API-Arg"], "{\"path\":\"/Docs/Caf\\u00e9 \\u00fcn\\u00ef \\ud83d\\udcc4.pdf\"}", "ASCII only, \\u-escaped");
	assert.deepStrictEqual(arg(requests[0]), { path: "/Docs/Café ünï \u{1F4C4}.pdf" });
	assert.strictEqual(requests[0].body, undefined);
	assert.strictEqual(requests[0].headers["Content-Type"], undefined);
});

test("downloadFile: a 409 not_found writes no file; MISSING_ARGS without localPath", async () => {
	const { call } = start([["POST", /files\/download$/, () => ({ status: 409, body: { error_summary: "path/not_found/.." } })]]);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", path: "/gone.pdf", localPath: dest });
	assert.strictEqual(r.errorCode, "DROPBOX_API_ERROR");
	assert.strictEqual(r.status, 409);
	assert.ok(!fs.existsSync(dest));
	assert.strictEqual((await call("downloadFile", { accountId: "acc", path: "/a" })).errorCode, "MISSING_ARGS");
});

test("uploadFile: content /files/upload to folder/name, overwrite, autorename off; the file is the body", async () => {
	const { call, requests } = start([["POST", /files\/upload$/, () => ({ status: 200, body: { id: "id:U1", name: "Notes é.txt", size: 5000, path_lower: "/docs/notes é.txt" } })]]);
	const r = await call("uploadFile", { accountId: "acc", path: "/docs", localPath: LOCAL, name: "Notes é.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Notes é.txt", id: "id:U1", size: 5000 });
	const q = requests[0];
	assert.strictEqual(q.url, CONTENT + "/files/upload");
	assert.strictEqual(q.headers["Content-Type"], "application/octet-stream");
	assert.strictEqual(q.headers.Authorization, "Bearer tok");
	assert.deepStrictEqual(arg(q), { path: "/docs/Notes é.txt", mode: "overwrite", autorename: false, mute: false });
	assert.doesNotMatch(q.headers["Dropbox-API-Arg"], /[^\x20-\x7e]/);
	assert.strictEqual(q.body.blob, LOCAL_BYTES.length, "a Blob of the file, streamed by fetch");
	assert.ok(Buffer.from(q.body.text, "latin1").length > 0);
});

test("uploadFile: the root and a name with a leading slash; the local name by default", async () => {
	const { call, requests } = start([["POST", /files\/upload$/, () => ({ status: 200, body: {} })]]);
	await call("uploadFile", { accountId: "acc", folderId: "root", localPath: LOCAL, name: "/b.txt" });
	await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	await call("uploadFile", { accountId: "acc", path: "/docs/", localPath: LOCAL, name: "c.txt" });
	assert.deepStrictEqual(requests.map((q) => arg(q).path), ["/b.txt", "/local.bin", "/docs/c.txt"]);
});

test("uploadFile replace:true: the same upload, at the file's own path", async () => {
	const { call, requests } = start([["POST", /files\/upload$/, () => ({ status: 200, body: { id: "id:F1", name: "Report.PDF", size: 9 } })]]);
	const r = await call("uploadFile", { accountId: "acc", fileId: "/docs/report.pdf", localPath: LOCAL, replace: true });
	assert.strictEqual(r.id, "id:F1");
	assert.deepStrictEqual(arg(requests[0]), { path: "/docs/report.pdf", mode: "overwrite", autorename: false, mute: false });
});

test("uploadFile: a 401 on the upload refreshes and sends the file again", async () => {
	const { call, requests } = start([
		["POST", /files\/upload$/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 60 } })],
		["POST", /files\/upload$/, () => ({ status: 200, body: { id: "id:U" } })],
	]);
	const r = await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	assert.strictEqual(r.id, "id:U");
	assert.strictEqual(requests[2].headers.Authorization, "Bearer tok2");
	assert.strictEqual(requests[2].body.blob, LOCAL_BYTES.length);
});

test("uploadFile: a local file that is not there is LOCAL_FILE_ERROR, and nothing is sent", async () => {
	const { call, requests } = start([["POST", /./, () => ({ status: 200, body: {} })]]);
	const r = await call("uploadFile", { accountId: "acc", localPath: path.join(TMP, "nope.bin") });
	assert.strictEqual(r.errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual(requests.length, 0);
});

test("createFolder: create_folder_v2 { path, autorename:false }; the entry is a folder; the root gives /name", async () => {
	const { call, requests } = start([["POST", /\/files\/create_folder_v2$/, () => ({ status: 200,
		body: { metadata: { name: "New", id: "id:N1", path_lower: "/docs/new", path_display: "/Docs/New" } } })]]);
	const r = await call("createFolder", { accountId: "acc", path: "/docs", name: "New" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: { id: "id:N1", type: "folder", name: "New", path: "/docs/new" } });
	assert.strictEqual(requests[0].url, API + "/files/create_folder_v2");
	assert.deepStrictEqual(body(requests[0]), { path: "/docs/New", autorename: false });
	for (const root of [{}, { path: "/" }, { folderId: "root" }]) {
		await call("createFolder", Object.assign({ accountId: "acc", name: "Top" }, root));
		assert.strictEqual(body(requests[requests.length - 1]).path, "/Top", JSON.stringify(root));
	}
	assert.strictEqual((await call("createFolder", { accountId: "acc", name: "a/b" })).errorCode, "MISSING_ARGS");
});

test("moveItem: rename only keeps the parent, one move_v2 call", async () => {
	const { call, requests } = start([["POST", /\/files\/move_v2$/, () => ({ status: 200,
		body: { metadata: Object.assign({}, FILE, { name: "Final.pdf", path_lower: "/docs/final.pdf" }) } })]]);
	const r = await call("moveItem", { accountId: "acc", path: "/docs/report.pdf", name: "Final.pdf" });
	assert.strictEqual(requests.length, 1);
	assert.strictEqual(requests[0].url, API + "/files/move_v2");
	assert.deepStrictEqual(body(requests[0]), { from_path: "/docs/report.pdf", to_path: "/docs/Final.pdf", autorename: false });
	assert.deepStrictEqual(r.entry, Object.assign({}, FILE_ENTRY, { name: "Final.pdf", path: "/docs/final.pdf" }));
	await call("moveItem", { accountId: "acc", path: "/a.txt", name: "b.txt" });
	assert.strictEqual(body(requests[1]).to_path, "/b.txt");
});

test("moveItem: a move only reads the cased name with get_metadata first, then moves under it", async () => {
	const { call, requests } = start([
		["POST", /\/files\/get_metadata$/, () => ({ status: 200, body: FILE })],
		["POST", /\/files\/move_v2$/, () => ({ status: 200, body: { metadata: Object.assign({}, FILE, { path_lower: "/archive/report.pdf" }) } })],
	]);
	const r = await call("moveItem", { accountId: "acc", path: "/docs/report.pdf", toPath: "/archive" });
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/files/get_metadata", API + "/files/move_v2"]);
	assert.deepStrictEqual(body(requests[0]), { path: "/docs/report.pdf" });
	assert.deepStrictEqual(body(requests[1]), { from_path: "/docs/report.pdf", to_path: "/archive/Report.PDF", autorename: false });
	assert.strictEqual(r.entry.path, "/archive/report.pdf");
	assert.strictEqual(r.entry.type, "file");
	await call("moveItem", { accountId: "acc", path: "/docs/report.pdf", toRoot: true });
	assert.strictEqual(body(requests[3]).to_path, "/Report.PDF");
});

test("moveItem: an id item with a new name still asks get_metadata for its parent", async () => {
	const { call, requests } = start([
		["POST", /get_metadata$/, () => ({ status: 200, body: FILE })],
		["POST", /move_v2$/, () => ({ status: 200, body: { metadata: FILE } })],
	]);
	await call("moveItem", { accountId: "acc", fileId: "id:F1", name: "New.pdf" });
	assert.deepStrictEqual(body(requests[1]), { from_path: "id:F1", to_path: "/docs/New.pdf", autorename: false });
});

test("moveItem: move and rename at once is one move_v2 call", async () => {
	const { call, requests } = start([["POST", /move_v2$/, () => ({ status: 200,
		body: { metadata: { ".tag": "folder", name: "Old", id: "id:D9", path_lower: "/archive/old" } } })]]);
	const r = await call("moveItem", { accountId: "acc", path: "/docs/sub", toPath: "/archive", name: "Old" });
	assert.strictEqual(requests.length, 1);
	assert.deepStrictEqual(body(requests[0]), { from_path: "/docs/sub", to_path: "/archive/Old", autorename: false });
	assert.deepStrictEqual(r.entry, { id: "id:D9", type: "folder", name: "Old", path: "/archive/old" });
});

test("moveItem: a missing item (get_metadata 409) fails without moving; a conflict on move_v2 is the error", async () => {
	const { call, requests } = start([
		["POST", /get_metadata$/, () => ({ status: 409, body: { error_summary: "path/not_found/.." } })],
		["POST", /move_v2$/, () => ({ status: 409, body: { error_summary: "to/conflict/file/." } })],
	]);
	const r = await call("moveItem", { accountId: "acc", path: "/gone.txt", toPath: "/x" });
	assert.strictEqual(r.status, 409);
	assert.match(r.errorText, /path\/not_found/);
	assert.strictEqual(requests.length, 1);
	const c = await call("moveItem", { accountId: "acc", path: "/a.txt", name: "b.txt" });
	assert.strictEqual(c.errorCode, "DROPBOX_API_ERROR");
	assert.match(c.errorText, /to\/conflict/);
});

test("moveItem: get_metadata without a name is an error, never a move to \".../undefined\"", async () => {
	const { call, requests } = start([["POST", /get_metadata$/, () => ({ status: 200, body: {} })], ["POST", /move_v2$/, () => ({ status: 200, body: {} })]]);
	assert.strictEqual((await call("moveItem", { accountId: "acc", path: "/a", toPath: "/b" })).errorCode, "DROPBOX_API_ERROR");
	assert.strictEqual(requests.length, 1);
});

test("moveItem: a token renewed by get_metadata is used by move_v2, refreshed once, saved once", async () => {
	const { call, requests, written } = start([
		["POST", /get_metadata$/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
		["POST", /get_metadata$/, () => ({ status: 200, body: FILE })],
		["POST", /move_v2$/, (q) => (q.headers.Authorization === "Bearer tok2" ? { status: 200, body: { metadata: FILE } } : { status: 401 })],
	]);
	const r = await call("moveItem", { accountId: "acc", path: "/docs/report.pdf", toPath: "/x" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(requests.length, 4);
	assert.strictEqual(requests[3].headers.Authorization, "Bearer tok2");
	assert.strictEqual(written.length, 1);
	assert.strictEqual(written[0].credentials.refreshToken, "ref2");
});

test("deleteItem: delete_v2 { path }; the root is refused before any request", async () => {
	const { call, requests } = start([["POST", /\/files\/delete_v2$/, () => ({ status: 200, body: { metadata: FILE } })]]);
	assert.deepStrictEqual(await call("deleteItem", { accountId: "acc", path: "/docs/report.pdf" }), { returnValue: true, renewedCredentials: null });
	assert.strictEqual(requests[0].url, API + "/files/delete_v2");
	assert.deepStrictEqual(body(requests[0]), { path: "/docs/report.pdf" });
	for (const root of ["/", "root"]) { assert.strictEqual((await call("deleteItem", { accountId: "acc", path: root })).errorCode, "BAD_ARGS"); }
	assert.strictEqual((await call("deleteItem", { accountId: "acc", path: "" })).errorCode, "MISSING_ARGS");
	assert.strictEqual(requests.length, 1);
});

test("listAlbums: one album, /Camera Uploads, counting its images over every page", async () => {
	const { call, requests } = start([
		["POST", /list_folder$/, () => ({ status: 200, body: { entries: [JPG, FILE, { ".tag": "folder", name: "x.jpg" }], cursor: "c", has_more: true } })],
		["POST", /list_folder\/continue$/, () => ({ status: 200, body: { entries: [Object.assign({}, JPG, { name: "b.heic" })], has_more: false } })],
	]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS),
		{ returnValue: true, albums: [{ aid: "/Camera Uploads", name: "Camera Uploads", size: { images: 2 } }] });
	assert.deepStrictEqual(body(requests[0]), { path: "/Camera Uploads" });
});

test("listAlbums: a folder that cannot be listed is the album with 0 images; no credentials is an error", async () => {
	const { call } = start([["POST", /list_folder$/, () => ({ status: 409, body: { error_summary: "path/not_found/" } })]]);
	assert.deepStrictEqual((await call("listAlbums", { accountId: "acc" }, PHOTOS)).albums[0].size, { images: 0 });
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: one temporary link per image, in turn; an image without a link is left out", async () => {
	const { call, requests } = start([
		["POST", /list_folder$/, () => ({ status: 200, body: { entries: [JPG, FILE, Object.assign({}, JPG, { id: "id:P2", name: "b.png", path_lower: "/camera uploads/b.png" })] } })],
		["POST", /get_temporary_link$/, (q) => (body(q).path === "/camera uploads/b.png" ? { status: 409, body: {} } : { status: 200, body: { link: "https://dl.example.test/1" } })],
	]);
	const r = await call("listPhotos", { accountId: "acc", aid: "/Camera Uploads" }, PHOTOS);
	assert.deepStrictEqual(r, { returnValue: true, photos: [{ pid: "id:P1", src_big: "https://dl.example.test/1", src_small: "https://dl.example.test/1",
		caption: "IMG_1.JPG", type: "image", fileName: "IMG_1.JPG" }] });
	assert.deepStrictEqual(requests.map((q) => q.url.replace(API, "")), ["/files/list_folder", "/files/get_temporary_link", "/files/get_temporary_link"]);
	assert.deepStrictEqual(body(requests[1]), { path: "/camera uploads/img_1.jpg" });
});

test("listPhotos: the listing failing fails the call", async () => {
	const { call } = start([["POST", /list_folder$/, () => ({ status: 500, body: "oops" })]]);
	assert.strictEqual((await call("listPhotos", { accountId: "acc" }, PHOTOS)).errorCode, "DROPBOX_API_ERROR");
});

test("upload (Photos): the photo into the album folder, or the root; pid is the Dropbox id", async () => {
	const { call, requests } = start([["POST", /files\/upload$/, () => ({ status: 200, body: { id: "id:NEW", name: "p.jpg", size: 5000 } })]]);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: "/Camera Uploads", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "id:NEW", name: "p.jpg", size: 5000 });
	await call("upload", { accountId: "acc", path: LOCAL }, PHOTOS);
	assert.deepStrictEqual(requests.map((q) => arg(q).path), ["/Camera Uploads/local.bin", "/local.bin"]);
});

test("deletePhoto: delete_v2 with the id selector", async () => {
	const { call, requests } = start([["POST", /delete_v2$/, () => ({ status: 200, body: {} })]]);
	assert.deepStrictEqual(await call("deletePhoto", { accountId: "acc", pid: "id:P1" }, PHOTOS), { returnValue: true, pid: "id:P1" });
	assert.deepStrictEqual(body(requests[0]), { path: "id:P1" });
});

// --- every request failing, in turn ----------------------------------------------------------

// What Dropbox answers when nothing fails.
function happy(q) {
	const u = q.url;
	if (/oauth2\/token$/.test(u)) { return { status: 200, body: { access_token: "AT2", refresh_token: "RT2", expires_in: 3600 } }; }
	if (/get_current_account$/.test(u)) { return { status: 200, body: { email: "u@example.test", name: { display_name: "U" } } }; }
	if (/list_folder$/.test(u)) { return { status: 200, body: { entries: [JPG], cursor: "c", has_more: true } }; }
	if (/list_folder\/continue$/.test(u)) { return { status: 200, body: { entries: [Object.assign({}, JPG, { id: "id:P2", name: "2.jpg" })], has_more: false } }; }
	if (/get_temporary_link$/.test(u)) { return { status: 200, body: { link: "https://dl.example.test/x" } }; }
	if (/get_metadata$/.test(u)) { return { status: 200, body: { name: "a.jpg", path_lower: "/x/a.jpg" } }; }
	if (/files\/download$/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (/files\/upload$/.test(u)) { return { status: 200, body: { id: "id:U", name: "n", size: 1 } }; }
	return { status: 200, body: { metadata: { name: "m", path_lower: "/m" } } };
}

// How the failing request fails. "401" is an expired token whose refresh is refused too.
const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401 and a refused refresh": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": (q) => (/files\/download$/.test(q.url) ? { status: 200, body: "ok" } : { status: 200, body: "<html>" }),
};

// [method, payload, caller, { minSteps, tolerated(k) -> true when request k failing is absorbed }]
const OPS = [
	["listFolder", { accountId: "acc", path: "/x" }, DOCS, { minSteps: 2 }],
	["downloadFile", () => ({ accountId: "acc", fileId: "/x/a.jpg", localPath: dl() }), DOCS, { notJsonOk: true }],
	["uploadFile", { accountId: "acc", path: "/x", localPath: LOCAL }, DOCS],
	["uploadFile (replace)", { accountId: "acc", fileId: "/x/a.jpg", localPath: LOCAL, replace: true }, DOCS],
	["createFolder", { accountId: "acc", path: "/x", name: "n" }, DOCS],
	["moveItem (rename)", { accountId: "acc", path: "/x/a.jpg", name: "b.jpg" }, DOCS],
	["moveItem (move)", { accountId: "acc", path: "/x/a.jpg", toPath: "/d" }, DOCS, { minSteps: 2 }],
	["deleteItem", { accountId: "acc", path: "/x/a.jpg" }, DOCS],
	["checkCredentials", { credentials: { common: { accessToken: "tok", refreshToken: "ref" } } }, {}],
	["exchangeCode", { code: "c", codeVerifier: "v" }, {}, { minSteps: 2, tolerated: (k) => k >= 2 }],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS],
	["deletePhoto", { accountId: "acc", pid: "id:1" }, PHOTOS],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
	["listPhotos", { accountId: "acc" }, PHOTOS, { minSteps: 4, tolerated: (k) => k >= 3 }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`dropbox ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const refreshAfter401 = mode.startsWith("a 401");
				const { call } = start([["POST", /./, (q) => {
					n++;
					if (n === k) { return fail(q); }
					if (refreshAfter401 && n > k && /oauth2\/token$/.test(q.url)) { return { status: 400, body: { error: "invalid_grant" } }; }
					return happy(q);
				}]], { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
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
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", path: "/a" })).errorCode, "BUS_BAD_REPLY");
});

test("a renewed token that cannot be saved does not stop the reply", async () => {
	const { call } = start([
		["POST", /list_folder$/, () => ({ status: 401 }), { once: true }],
		["POST", /oauth2\/token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 60 } })],
		["POST", /list_folder$/, () => ({ status: 200, body: { entries: [] } })],
	], { onCall: (uri) => (/readCredentials$/.test(uri) ? { returnValue: true, credentials: STORED } : { returnValue: false, errorCode: -1, errorText: "bus down" }) });
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(json(r).renewedCredentials.accessToken, "tok2");
});
