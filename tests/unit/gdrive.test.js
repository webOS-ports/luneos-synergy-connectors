// node --test tests/unit
// The Google Drive connector (cloud/google/service/com.palm.service.gdrive) as the launcher runs
// it: service.js started on a stand-in palmbus, with a stand-in fetch that records every
// request. Each method is called over the bus as its real caller would call it, and checked for
// the requests it makes (endpoint, method, headers, body), its reply, and its errors; the
// Accounts service is answered by the stand-in bus.
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

const SVC = path.join(__dirname, "../../cloud/google/service/com.palm.service.gdrive");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id%2Cname%2CmimeType%2Csize%2CmodifiedTime";
const LIST_FIELDS = "&fields=" + encodeURIComponent("files(id,name,mimeType,size,modifiedTime),nextPageToken") + "&pageSize=1000&orderBy=folder,name";
const listUrl = (id) => API + "/files?q=" + encodeURIComponent("'" + id + "' in parents and trashed = false") + LIST_FIELDS;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const STORED = { accessToken: "tok", refreshToken: "ref", expiresAt: 1 };
const AUTH = { Authorization: "Bearer tok" };
const JSONH = { "Content-Type": "application/json", Authorization: "Bearer tok" };

const folderRes = { id: "F9", name: "New", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-10-19T10:00:00Z" };
const fileRes = { id: "A1", name: "b.txt", mimeType: "text/plain", size: "12", modifiedTime: "2026-10-19T11:00:00Z" };
const docRes = { id: "D1", name: "Plan", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-19T12:00:00Z" };
const fileEntry = { id: "A1", type: "file", name: "b.txt", size: "12", modified: "2026-10-19T11:00:00Z", path: "A1", mimeType: "text/plain", googleDoc: false };
const folderEntry = { id: "F9", type: "folder", name: "New", modified: "2026-10-19T10:00:00Z", path: "F9",
	mimeType: "application/vnd.google-apps.folder", googleDoc: false };
const docEntry = { id: "D1", type: "file", name: "Plan", modified: "2026-10-19T12:00:00Z", path: "D1",
	mimeType: "application/vnd.google-apps.document", googleDoc: true };

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
const form = (r) => Object.fromEntries(new URLSearchParams(r.body));
const line = (r) => r.method + " " + r.url;

test("the service: its bus name, and the methods of the old services.json (plus quit, info, and two that refuse)", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.gdrive");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listFolder", "moveItem", "quit", "upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const f of ["services.json", "sources.json", "commands"]) { assert.ok(!fs.existsSync(path.join(SVC, f)), f); }
});

test("upload and deletePhoto: DOCUMENTS only, NOT_SUPPORTED without a request", async () => {
	const { call, requests, handle } = start([["POST", /./, () => ({ status: 200, body: { id: "X" } })]]);
	assert.strictEqual((await call("upload", { accountId: "acc", path: LOCAL }, {})).errorCode, "NOT_SUPPORTED");
	assert.strictEqual((await call("deletePhoto", { accountId: "acc", pid: "X" }, {})).errorCode, "NOT_SUPPORTED");
	assert.strictEqual(requests.length, 0);
	assert.strictEqual(handle.calls.length, 0);
});

test("caller rules: file methods for the FILE_APP_IDS, auth methods open", async () => {
	const { call } = start([["GET", /./, () => ({ status: 200, body: { files: [], user: { emailAddress: "e" } } })]]);
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.cloud-auth" }, { service: "com.palm.service.photos" }, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", path: "A", name: "b", localPath: LOCAL, fileId: "A" }, who);
			assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m + " " + JSON.stringify(who));
		}
	}
	for (const who of [DOCS, { appId: "org.webosports.app.documents-77" }, { service: "com.palm.stark.files.service" }]) {
		assert.strictEqual((await call("listFolder", { accountId: "acc" }, who)).returnValue, true, JSON.stringify(who));
	}
	assert.strictEqual((await call("getAuthorizeUrl", {}, {})).returnValue, true);
	assert.strictEqual((await call("getAuthorizeUrl", {}, { appId: "com.palm.app.accounts 99" })).returnValue, true);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: STORED } }, ACCOUNTS)).returnValue, true);
});

test("getAuthorizeUrl: Google's consent URL with PKCE, access_type=offline and prompt=consent", async () => {
	const { call } = start([]);
	const r = await call("getAuthorizeUrl", {}, {});
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: Config.CLIENT_ID,
		redirect_uri: "http://localhost/gdrive/oauth2callback", scope: "https://www.googleapis.com/auth/drive",
		code_challenge: crypto.createHash("sha256").update(r.codeVerifier).digest("base64url"), code_challenge_method: "S256",
		access_type: "offline", prompt: "consent", state: "gdrive" });
	assert.match(r.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
});

test("exchangeCode: the token request (no scope; the placeholder secret is not sent), then /about for the username", async () => {
	const { call, requests } = start([
		["POST", /oauth2\.googleapis\.com\/token$/, () => ({ status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 3599, token_type: "Bearer" } })],
		["GET", /\/about\?fields=user$/, () => ({ status: 200, body: { user: { emailAddress: "u@example.test", displayName: "U Ser", kind: "drive#user" } } })],
	]);
	const t0 = Date.now();
	const r = await call("exchangeCode", { code: "CODE", codeVerifier: "VERIFIER" }, ACCOUNTS);
	assert.deepStrictEqual(requests.map(line), ["POST " + Config.TOKEN_URL, "GET " + API + "/about?fields=user"]);
	assert.deepStrictEqual(form(requests[0]), { client_id: Config.CLIENT_ID,
		grant_type: "authorization_code", code: "CODE", redirect_uri: Config.REDIRECT_URI, code_verifier: "VERIFIER" });
	assert.deepStrictEqual(requests[1].headers, { Authorization: "Bearer AT" });
	assert.strictEqual(r.username, "u@example.test");
	assert.strictEqual(r.alias, "U Ser");
	assert.deepStrictEqual(Object.keys(r.credentials.common), ["accessToken", "refreshToken", "expiresAt"]);
	assert.strictEqual(r.credentials.common.refreshToken, "RT");
	assert.ok(r.credentials.common.expiresAt >= t0 + 3599e3);
});

test("exchangeCode and refresh: a secret the build filled in is sent (a Google Desktop client needs it)", async () => {
	const old = Config.CLIENT_SECRET;
	Config.CLIENT_SECRET = "unit-test-value";
	try {
		const { call, requests } = start([
			["POST", /token$/, () => ({ status: 200, body: { access_token: "AT", expires_in: 60 } })],
			["GET", /about/, () => ({ status: 200, body: { user: {} } })],
			["GET", /\/files\?/, () => ({ status: 401 }), { once: true }],
			["GET", /\/files\?/, () => ({ status: 200, body: { files: [] } })],
		]);
		const r = await call("exchangeCode", { code: "C", codeVerifier: "V" }, ACCOUNTS);
		assert.strictEqual(r.username, "Google Drive", "no email: the DISPLAY_NAME fallback");
		assert.strictEqual(form(requests[0]).client_secret, "unit-test-value");
		await call("listFolder", { accountId: "acc" });
		assert.strictEqual(form(requests[3]).client_secret, "unit-test-value");
		assert.strictEqual(form(requests[3]).grant_type, "refresh_token");
	} finally { Config.CLIENT_SECRET = old; }
});

test("checkCredentials: /about with the given token; a rejected token is an error", async () => {
	const { call, requests } = start([["GET", /\/about\?fields=user$/, (q) => (q.headers.Authorization === "Bearer good"
		? { status: 200, body: { user: { emailAddress: "u@example.test", displayName: "U" } } } : { status: 401, body: { error: { code: 401 } } })]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "good" } } }, {}),
		{ returnValue: true, renewedCredentials: null, username: "u@example.test", displayName: "U" });
	const bad = await call("checkCredentials", { credentials: { common: { accessToken: "bogus", refreshToken: "bogus", expiresAt: 1 } } }, {});
	assert.strictEqual(bad.errorCode, "OAUTH_TOKEN_FAILED");   // the 401, then the refresh refused (no route: 599)
	assert.strictEqual(requests.length, 3);
	assert.strictEqual((await call("checkCredentials", {}, {})).errorCode, "401_UNAUTHORIZED");
});

test("listFolder: the children query with the same fields, entries normalised (googleDoc), every page", async () => {
	const { call, requests } = start([
		["GET", /pageToken=/, () => ({ status: 200, body: { files: [docRes] } })],
		["GET", /\/files\?q=/, () => ({ status: 200, body: { files: [folderRes, fileRes], nextPageToken: "P 2" } })],
	]);
	const r = await call("listFolder", { accountId: "acc", folderId: "X1" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entries: [folderEntry, fileEntry, docEntry] });
	assert.deepStrictEqual(requests.map(line), ["GET " + listUrl("X1"), "GET " + listUrl("X1") + "&pageToken=P%202"]);
	for (const q of requests) { assert.deepStrictEqual(q.headers, AUTH); assert.strictEqual(q.body, undefined); }
	for (const root of [{}, { path: "" }, { folderId: "root" }, { path: "root" }]) {
		await call("listFolder", Object.assign({ accountId: "acc" }, root));
		assert.strictEqual(requests[requests.length - 2].url, listUrl("root"), JSON.stringify(root));
	}
});

test("listFolder: a ' or \\ in the folder id cannot leave the query's string", async () => {
	const { call, requests } = start([["GET", /./, () => ({ status: 200, body: { files: [] } })]]);
	await call("listFolder", { accountId: "acc", folderId: "a' or 'x' in parents or '\\" });
	assert.strictEqual(new URL(requests[0].url).searchParams.get("q"), "'a\\' or \\'x\\' in parents or \\'\\\\' in parents and trashed = false");
});

test("listFolder: inline credentials, without the Accounts service", async () => {
	const { call, requests, handle } = start([["GET", /./, () => ({ status: 200, body: { files: [] } })]]);
	await call("listFolder", { credentials: { common: { accessToken: "inline" } } });
	assert.strictEqual(requests[0].headers.Authorization, "Bearer inline");
	assert.strictEqual(handle.calls.length, 0);
	const none = start([], { stored: null });
	assert.strictEqual((await none.call("listFolder", { accountId: "acc" })).errorCode, "NO_STORED_CREDENTIALS");
});

test("a 401: refresh (no scope sent), retry with the new token, keep the old refresh token, save and report", async () => {
	const { call, requests, written } = start([
		["POST", /\/files\?fields=/, () => ({ status: 401, body: {} }), { once: true }],
		["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 3600, token_type: "Bearer" } })],
		["POST", /\/files\?fields=/, (q) => (q.headers.Authorization === "Bearer tok2" ? { status: 200, body: folderRes } : { status: 401 })],
	]);
	const t0 = Date.now();
	const r = await call("createFolder", { accountId: "acc", folderId: "P1", name: "New" });
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/files?fields=" + FIELDS, Config.TOKEN_URL, API + "/files?fields=" + FIELDS]);
	assert.deepStrictEqual(form(requests[1]), { client_id: Config.CLIENT_ID, grant_type: "refresh_token", refresh_token: "ref" });
	assert.strictEqual(requests[2].body, requests[0].body, "the retry sends the same body");
	assert.strictEqual(r.entry.id, "F9");
	assert.strictEqual(r.renewedCredentials.accessToken, "tok2");
	assert.strictEqual(r.renewedCredentials.refreshToken, "ref", "Google keeps the old one");
	assert.ok(r.renewedCredentials.expiresAt >= t0 + 3600e3);
	assert.deepStrictEqual(written, [{ accountId: "acc", name: "common", credentials: r.renewedCredentials }]);
});

test("a 401 whose retry is refused or gets no answer: that error, one reply", async () => {
	for (const [retry, code] of [[() => ({ status: 500, body: "{}" }), "GDRIVE_API_ERROR"],
		[() => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); }, "CURL_FAILED"]]) {
		const { call, requests } = start([
			["GET", /\/files\?q=/, () => ({ status: 401 }), { once: true }],
			["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
			["GET", /\/files\?q=/, retry],
		]);
		assert.strictEqual((await call("listFolder", { accountId: "acc" })).errorCode, code);
		assert.strictEqual(requests.length, 3);
	}
});

test("a 401 whose refresh fails: the refresh's error, nothing saved, no retry", async () => {
	const { call, requests, written } = start([
		["GET", /\/files\?/, () => ({ status: 401 })],
		["POST", /token$/, () => ({ status: 400, body: { error: "invalid_grant" } })],
	]);
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.errorCode, "OAUTH_TOKEN_FAILED");
	assert.match(r.errorText, /invalid_grant/);
	assert.strictEqual(requests.length, 2);
	assert.deepStrictEqual(written, []);
});

test("an API error: GDRIVE_API_ERROR with the status and Google's reason", async () => {
	const { call } = start([["POST", /\/files\?fields=/, () => ({ status: 403,
		body: { error: { code: 403, message: "Insufficient permissions.", errors: [{ reason: "insufficientFilePermissions" }] } } })]]);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", folderId: "P1", name: "New" }),
		{ returnValue: false, errorCode: "GDRIVE_API_ERROR", errorText: "Google Drive answered HTTP 403: insufficientFilePermissions (Insufficient permissions.)", status: 403 });
});

test("downloadFile: ?alt=media, the bytes to localPath (folders 0755); exportMime exports a Google doc", async () => {
	const BYTES = crypto.randomBytes(70000);
	const { call, requests } = start([["GET", /\/files\/[^/?]+(\/export)?\?/, () => new Response(BYTES, { status: 200 })]]);
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { accountId: "acc", fileId: "A 1", localPath: dest }),
		{ returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.strictEqual(line(requests[0]), "GET " + API + "/files/A%201?alt=media");
	assert.deepStrictEqual(requests[0].headers, AUTH);
	const doc = dl();
	await call("downloadFile", { accountId: "acc", path: "D1", localPath: doc,
		exportMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
	assert.strictEqual(requests[1].url, API + "/files/D1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document");
	assert.ok(fs.readFileSync(doc).equals(BYTES));
});

test("downloadFile: a 403 (a Google doc without exportMime) writes no file; MISSING_ARGS without localPath", async () => {
	const { call } = start([["GET", /alt=media/, () => ({ status: 403, body: { error: { errors: [{ reason: "fileNotDownloadable" }] } } })]]);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", fileId: "D1", localPath: dest });
	assert.strictEqual(r.errorCode, "GDRIVE_API_ERROR");
	assert.strictEqual(r.status, 403);
	assert.match(r.errorText, /fileNotDownloadable/);
	assert.ok(!fs.existsSync(dest));
	assert.ok(!fs.existsSync(dest + ".part"));
	assert.strictEqual((await call("downloadFile", { accountId: "acc", fileId: "A" })).errorCode, "MISSING_ARGS");
});

test("uploadFile: the bytes (POST uploadType=media), then PATCH the name and move it into the folder", async () => {
	const { call, requests } = start([
		["POST", /\/upload\/drive\/v3\/files\?uploadType=media&fields=id$/, () => ({ status: 200, body: { id: "NEW" } })],
		["PATCH", /\/files\/NEW\?/, () => ({ status: 200, body: { id: "NEW", name: "Notes é.txt", size: "5000" } })],
	]);
	const r = await call("uploadFile", { accountId: "acc", folderId: "P1", localPath: LOCAL, name: "Notes é.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Notes é.txt", id: "NEW", size: "5000" });
	assert.deepStrictEqual(requests.map(line), ["POST " + UPLOAD + "/files?uploadType=media&fields=id",
		"PATCH " + API + "/files/NEW?fields=id,name,size&addParents=P1&removeParents=root"]);
	assert.deepStrictEqual(requests[0].headers, { "Content-Type": "text/plain", Authorization: "Bearer tok" });
	assert.strictEqual(requests[0].body.blob, LOCAL_BYTES.length, "a Blob of the file, streamed by fetch");
	assert.deepStrictEqual(requests[1].headers, JSONH);
	assert.deepStrictEqual(body(requests[1]), { name: "Notes é.txt" });
});

test("uploadFile: into the root no parents change; octet-stream and the local name by default", async () => {
	const { call, requests } = start([
		["POST", /uploadType=media/, () => ({ status: 200, body: { id: "N" } })],
		["PATCH", /\/files\/N\?/, () => ({ status: 200, body: { id: "N" } })],
	]);
	await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	await call("uploadFile", { accountId: "acc", folderId: "root", localPath: LOCAL, name: "x" });
	assert.strictEqual(requests[0].headers["Content-Type"], "application/octet-stream");
	assert.strictEqual(requests[1].url, API + "/files/N?fields=id,name,size");
	assert.deepStrictEqual(body(requests[1]), { name: "local.bin" });
	assert.strictEqual(requests[3].url, API + "/files/N?fields=id,name,size");
});

test("uploadFile: a token renewed on the bytes is used for the PATCH; an upload without an id fails before it", async () => {
	const { call, requests, written } = start([
		["POST", /uploadType=media/, () => ({ status: 401 }), { once: true }],
		["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 60 } })],
		["POST", /uploadType=media/, () => ({ status: 200, body: { id: "N" } })],
		["PATCH", /\/files\/N\?/, (q) => (q.headers.Authorization === "Bearer tok2" ? { status: 200, body: { id: "N" } } : { status: 401 })],
	]);
	assert.strictEqual((await call("uploadFile", { accountId: "acc", localPath: LOCAL })).id, "N");
	assert.strictEqual(requests[2].body.blob, LOCAL_BYTES.length, "the retry sends the file again");
	assert.strictEqual(written.length, 1);
	const noId = start([["POST", /uploadType=media/, () => ({ status: 200, body: {} })], ["PATCH", /./, () => ({ status: 200, body: {} })]]);
	assert.strictEqual((await noId.call("uploadFile", { accountId: "acc", localPath: LOCAL })).errorCode, "GDRIVE_API_ERROR");
	assert.strictEqual(noId.requests.length, 1);
});

test("uploadFile: a local file that is not there is LOCAL_FILE_ERROR, and nothing is sent", async () => {
	const { call, requests } = start([["POST", /./, () => ({ status: 200, body: { id: "N" } })]]);
	assert.strictEqual((await call("uploadFile", { accountId: "acc", localPath: path.join(TMP, "nope.bin") })).errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual(requests.length, 0);
});

test("uploadFile replace:true: PATCH the new bytes onto the file by id", async () => {
	const { call, requests } = start([["PATCH", /./, () => ({ status: 200, body: { id: "A1", name: "b.txt", size: "5000" } })]]);
	const r = await call("uploadFile", { accountId: "acc", fileId: "A1", localPath: LOCAL, replace: true, mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "b.txt", id: "A1", size: "5000" });
	assert.strictEqual(line(requests[0]), "PATCH " + UPLOAD + "/files/A1?uploadType=media&fields=id,name,size");
	assert.deepStrictEqual(requests[0].headers, { "Content-Type": "text/plain", Authorization: "Bearer tok" });
	assert.strictEqual(requests[0].body.blob, LOCAL_BYTES.length);
});

test("createFolder: files.create with the folder mimeType and the parent; the entry is listFolder's", async () => {
	const { call, requests } = start([
		["POST", /\/files\?fields=/, () => ({ status: 200, body: folderRes })],
		["GET", /\/files\?q=/, () => ({ status: 200, body: { files: [folderRes] } })],
	]);
	const r = await call("createFolder", { accountId: "acc", folderId: "P1", name: "New" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: folderEntry });
	assert.strictEqual(line(requests[0]), "POST " + API + "/files?fields=" + FIELDS);
	assert.deepStrictEqual(requests[0].headers, JSONH);
	assert.deepStrictEqual(body(requests[0]), { name: "New", mimeType: "application/vnd.google-apps.folder", parents: ["P1"] });
	assert.deepStrictEqual(json(r.entry), (await call("listFolder", { accountId: "acc", folderId: "P1" })).entries[0]);
	for (const root of [{}, { folderId: "root" }]) {
		await call("createFolder", Object.assign({ accountId: "acc", name: "Top" }, root));
		assert.deepStrictEqual(body(requests[requests.length - 1]).parents, ["root"], JSON.stringify(root));
	}
	assert.strictEqual((await call("createFolder", { accountId: "acc", name: "a/b" })).errorCode, "MISSING_ARGS");
});

test("moveItem rename only: one PATCH with the name, no parents lookup", async () => {
	const { call, requests } = start([["PATCH", /./, () => ({ status: 200, body: fileRes })]]);
	const r = await call("moveItem", { accountId: "acc", fileId: "A1", name: "b.txt" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: fileEntry });
	assert.deepStrictEqual(requests.map(line), ["PATCH " + API + "/files/A1?fields=" + FIELDS]);
	assert.deepStrictEqual(requests[0].headers, JSONH);
	assert.deepStrictEqual(body(requests[0]), { name: "b.txt" });
});

test("moveItem move only: the current parents first, then add the new one and remove them", async () => {
	const { call, requests } = start([
		["GET", /\?fields=parents$/, () => ({ status: 200, body: { parents: ["OLD"] } })],
		["PATCH", /./, () => ({ status: 200, body: fileRes })],
	]);
	const r = await call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "NEW" });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/files/A1?fields=parents",
		"PATCH " + API + "/files/A1?addParents=NEW&removeParents=OLD&fields=" + FIELDS]);
	assert.deepStrictEqual(requests[0].headers, AUTH);
	assert.deepStrictEqual(body(requests[1]), {});
	assert.deepStrictEqual(r.entry, fileEntry);
});

test("moveItem both: one PATCH moves and renames; ids are URL-encoded", async () => {
	const { call, requests } = start([
		["GET", /\?fields=parents$/, () => ({ status: 200, body: { parents: ["o/1", "o2"] } })],
		["PATCH", /./, () => ({ status: 200, body: fileRes })],
	]);
	await call("moveItem", { accountId: "acc", fileId: "a b", toFolderId: "n&1", name: "b.txt" });
	assert.strictEqual(requests[1].url, API + "/files/a%20b?addParents=n%261&removeParents=o%2F1%2Co2&fields=" + FIELDS);
	assert.deepStrictEqual(body(requests[1]), { name: "b.txt" });
});

test("moveItem to the root: the root alias is resolved to its id, and an item already there stays put", async () => {
	let parents = ["0ARoot"];
	const { call, requests } = start([
		["GET", /\/files\/A1\?fields=parents$/, () => ({ status: 200, body: { parents } })],
		["GET", /\/files\/root\?fields=id$/, () => ({ status: 200, body: { id: "0ARoot" } })],
		["PATCH", /./, () => ({ status: 200, body: fileRes })],
	]);
	await call("moveItem", { accountId: "acc", fileId: "A1", toRoot: true, name: "b.txt" });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/files/A1?fields=parents", "GET " + API + "/files/root?fields=id",
		"PATCH " + API + "/files/A1?fields=" + FIELDS]);
	parents = ["OLD"];
	await call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "root" });
	assert.strictEqual(requests[5].url, API + "/files/A1?addParents=0ARoot&removeParents=OLD&fields=" + FIELDS);
});

test("moveItem into the folder it is in only renames; no parents means nothing to remove", async () => {
	let parents = { parents: ["P"] };
	const { call, requests } = start([
		["GET", /\?fields=parents$/, () => ({ status: 200, body: parents })],
		["PATCH", /./, () => ({ status: 200, body: fileRes })],
	]);
	await call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "P", name: "c.txt" });
	assert.strictEqual(requests[1].url, API + "/files/A1?fields=" + FIELDS);
	parents = {};
	await call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "P" });
	assert.strictEqual(requests[3].url, API + "/files/A1?addParents=P&fields=" + FIELDS);
});

test("moveItem: a failed parents lookup, root lookup or PATCH fails the move and stops there", async () => {
	let t = start([["GET", /./, () => ({ status: 404, body: { error: { errors: [{ reason: "notFound" }] } } })]]);
	let r = await t.call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "NEW" });
	assert.deepStrictEqual([r.errorCode, r.status, t.requests.length], ["GDRIVE_API_ERROR", 404, 1]);
	t = start([["GET", /./, () => ({ status: 200, body: { parents: ["OLD"] } })], ["PATCH", /./, () => ({ status: 403, body: {} })]]);
	r = await t.call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "NEW" });
	assert.strictEqual(r.status, 403);
	t = start([["GET", /parents/, () => ({ status: 200, body: { parents: ["OLD"] } })], ["GET", /root/, () => ({ status: 500, body: {} })],
		["PATCH", /./, () => ({ status: 200, body: fileRes })]]);
	r = await t.call("moveItem", { accountId: "acc", fileId: "A1", toRoot: true });
	assert.deepStrictEqual([r.status, t.requests.length], [500, 2]);
	t = start([["GET", /parents/, () => ({ status: 200, body: { parents: ["OLD"] } })], ["GET", /root/, () => ({ status: 200, body: {} })],
		["PATCH", /./, () => ({ status: 200, body: fileRes })]]);
	r = await t.call("moveItem", { accountId: "acc", fileId: "A1", toRoot: true });
	assert.deepStrictEqual([r.errorCode, t.requests.length], ["GDRIVE_API_ERROR", 2], "no root id: no PATCH with addParents=undefined");
});

test("moveItem: a token refreshed on the lookup is used for the PATCH, refreshed once, saved once", async () => {
	const { call, requests, written } = start([
		["GET", /parents/, () => ({ status: 401 }), { once: true }],
		["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", expires_in: 60 } })],
		["GET", /parents/, () => ({ status: 200, body: { parents: ["OLD"] } })],
		["PATCH", /./, (q) => (q.headers.Authorization === "Bearer tok2" ? { status: 200, body: fileRes } : { status: 401 })],
	]);
	const r = await call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "NEW" });
	assert.strictEqual(r.entry.id, "A1");
	assert.deepStrictEqual(requests.map((q) => q.headers.Authorization || "token"), ["Bearer tok", "token", "Bearer tok2", "Bearer tok2"]);
	assert.strictEqual(written.length, 1);
});

test("deleteItem: to the trash with files.update, never files.delete; the root is refused before any request", async () => {
	const { call, requests } = start([["PATCH", /./, () => ({ status: 200, body: { id: "A1" } })]]);
	assert.deepStrictEqual(await call("deleteItem", { accountId: "acc", fileId: "A1" }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(requests.map(line), ["PATCH " + API + "/files/A1?fields=id"]);
	assert.deepStrictEqual(requests[0].headers, JSONH);
	assert.deepStrictEqual(body(requests[0]), { trashed: true });
	for (const root of ["root", "/"]) { assert.strictEqual((await call("deleteItem", { accountId: "acc", path: root })).errorCode, "BAD_ARGS"); }
	assert.strictEqual(requests.length, 1);
});

test("deleteItem: a file the user does not own (403) is GDRIVE_API_ERROR", async () => {
	const { call } = start([["PATCH", /./, () => ({ status: 403, body: { error: { errors: [{ reason: "insufficientFilePermissions" }] } } })]]);
	const r = await call("deleteItem", { accountId: "acc", fileId: "A1" });
	assert.deepStrictEqual([r.returnValue, r.errorCode, r.status], [false, "GDRIVE_API_ERROR", 403]);
	assert.match(r.errorText, /insufficientFilePermissions/);
});

// --- every request failing, in turn ----------------------------------------------------------

// What Drive answers when nothing fails.
function happy(q) {
	const u = q.url;
	if (/token$/.test(u)) { return { status: 200, body: { access_token: "AT2", expires_in: 3600 } }; }
	if (/\/about\?/.test(u)) { return { status: 200, body: { user: { emailAddress: "u@example.test", displayName: "U" } } }; }
	if (/\/files\?q=.*pageToken=/.test(u)) { return { status: 200, body: { files: [fileRes] } }; }
	if (/\/files\?q=/.test(u)) { return { status: 200, body: { files: [folderRes], nextPageToken: "p2" } }; }
	if (/\?fields=parents$/.test(u)) { return { status: 200, body: { parents: ["OLD"] } }; }
	if (/\/files\/root\?fields=id$/.test(u)) { return { status: 200, body: { id: "0ARoot" } }; }
	if (/alt=media|\/export\?/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (/uploadType=media&fields=id$/.test(u)) { return { status: 200, body: { id: "NEW" } }; }
	return { status: 200, body: fileRes };
}

// How the failing request fails. "401" is an expired token whose refresh is refused too.
const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401 and a refused refresh": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": (q) => (/alt=media|\/export\?/.test(q.url) ? { status: 200, body: "ok" } : { status: 200, body: "<html>" }),
};

// [label, payload, caller, { minSteps, tolerated(k), notJsonOk }]
const OPS = [
	["listFolder", { accountId: "acc", folderId: "X" }, DOCS, { minSteps: 2 }],
	["downloadFile", () => ({ accountId: "acc", fileId: "A1", localPath: dl() }), DOCS, { notJsonOk: true }],
	["downloadFile (export)", () => ({ accountId: "acc", fileId: "D1", localPath: dl(), exportMime: "application/pdf" }), DOCS, { notJsonOk: true }],
	["uploadFile", { accountId: "acc", folderId: "P", localPath: LOCAL }, DOCS, { minSteps: 2 }],
	["uploadFile (replace)", { accountId: "acc", fileId: "A1", localPath: LOCAL, replace: true }, DOCS],
	["createFolder", { accountId: "acc", folderId: "P", name: "n" }, DOCS],
	["moveItem (rename)", { accountId: "acc", fileId: "A1", name: "b.txt" }, DOCS],
	["moveItem (move)", { accountId: "acc", fileId: "A1", toFolderId: "D" }, DOCS, { minSteps: 2 }],
	["moveItem (to the root)", { accountId: "acc", fileId: "A1", toRoot: true }, DOCS, { minSteps: 3 }],
	["deleteItem", { accountId: "acc", fileId: "A1" }, DOCS],
	["checkCredentials", { credentials: { common: { accessToken: "tok", refreshToken: "ref" } } }, {}],
	["exchangeCode", { code: "c", codeVerifier: "v" }, {}, { minSteps: 2, tolerated: (k) => k >= 2 }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`gdrive ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const refreshAfter401 = mode.startsWith("a 401");
				const answer = (q) => {
					n++;
					if (n === k) { return fail(q); }
					if (refreshAfter401 && n > k && /token$/.test(q.url)) { return { status: 400, body: { error: "invalid_grant" } }; }
					return happy(q);
				};
				const { call } = start(["GET", "POST", "PATCH"].map((m) => [m, /./, answer]), { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
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
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", fileId: "A1" })).errorCode, "BUS_BAD_REPLY");
});
