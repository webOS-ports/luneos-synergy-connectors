// node --test tests/unit
// The OneDrive connector (cloud/onedrive/service/com.palm.service.onedrive) as the launcher runs
// it: service.js started on a stand-in palmbus, with a stand-in fetch that records every
// request. Each method is called over the bus as its real caller would call it, and checked for
// the requests it makes (endpoint, method, headers, body), its reply, and its errors; the
// Accounts service is answered by the stand-in bus.
//
// The last part fails every request of every method in turn, in each way a request can fail,
// and checks the method still answers exactly once, with an error (or, for the Photos
// listings, which absorb a provider failure, with an empty album).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fakePalmbus, fakeFetch, ask, json } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/onedrive/service/com.palm.service.onedrive");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const API = "https://graph.microsoft.com/v1.0";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "onedrive-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const STORED = { accessToken: "tok", refreshToken: "ref", expiresAt: 1 };
const AUTH = { Authorization: "Bearer tok" };
const JSONH = { "Content-Type": "application/json", Authorization: "Bearer tok" };
const PUTH = { "Content-Type": "application/octet-stream", Authorization: "Bearer tok" };

const folderItem = { id: "F9", name: "New", folder: { childCount: 0 }, size: 0, lastModifiedDateTime: "2026-10-19T10:00:00Z",
	parentReference: { id: "P1" } };
const fileItem = { id: "A1", name: "b.txt", file: { mimeType: "text/plain" }, size: 12, lastModifiedDateTime: "2026-10-19T11:00:00Z",
	"@microsoft.graph.downloadUrl": "https://dl.example.test/b" };
const fileEntry = { id: "A1", type: "file", name: "b.txt", size: 12, modified: "2026-10-19T11:00:00Z", path: "A1",
	mimeType: "text/plain", downloadUrl: "https://dl.example.test/b" };
const folderEntry = { id: "F9", type: "folder", name: "New", size: 0, modified: "2026-10-19T10:00:00Z", path: "F9" };
const jpg = (id, name, url) => ({ id, name, file: { mimeType: "image/jpeg" }, "@microsoft.graph.downloadUrl": url });

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

test("the service: its bus name, and every method the old services.json had (plus quit, info)", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.onedrive");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "moveItem", "quit",
		"upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const f of ["services.json", "sources.json", "commands"]) { assert.ok(!fs.existsSync(path.join(SVC, f)), f); }
});

test("caller rules: file methods for the FILE_APP_IDS, auth and photo methods open", async () => {
	const { call } = start([["GET", /./, () => ({ status: 200, body: { value: [], mail: "e" } })]]);
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.cloud-auth" }, PHOTOS, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", path: "A", name: "b", localPath: LOCAL, fileId: "A" }, who);
			assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m + " " + JSON.stringify(who));
		}
	}
	for (const who of [DOCS, { appId: "org.webosports.app.documents-77" }, { service: "com.palm.stark.files.service" }]) {
		assert.strictEqual((await call("listFolder", { accountId: "acc" }, who)).returnValue, true, JSON.stringify(who));
	}
	assert.strictEqual((await call("getAuthorizeUrl", {}, {})).returnValue, true);
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("listPhotos", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: STORED } }, ACCOUNTS)).returnValue, true);
});

test("getAuthorizeUrl: Microsoft's consent URL with PKCE, nothing extra", async () => {
	const { call } = start([]);
	const r = await call("getAuthorizeUrl", {}, {});
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: Config.CLIENT_ID,
		redirect_uri: "http://localhost/onedrive/oauth2callback", scope: "Files.ReadWrite offline_access User.Read",
		code_challenge: crypto.createHash("sha256").update(r.codeVerifier).digest("base64url"), code_challenge_method: "S256",
		state: "onedrive" });
});

test("exchangeCode: the token request with scope and no secret (a public client), then /me for the username", async () => {
	const { call, requests } = start([
		["POST", /oauth2\/v2\.0\/token$/, () => ({ status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" } })],
		["GET", /\/me\?/, () => ({ status: 200, body: { id: "1", displayName: "U Ser", userPrincipalName: "u@example.test", mail: null } })],
	]);
	const r = await call("exchangeCode", { code: "CODE", codeVerifier: "VERIFIER" }, ACCOUNTS);
	assert.deepStrictEqual(requests.map(line), ["POST " + Config.TOKEN_URL, "GET " + API + "/me?$select=id,displayName,userPrincipalName,mail"]);
	assert.deepStrictEqual(form(requests[0]), { client_id: Config.CLIENT_ID, scope: Config.SCOPE,
		grant_type: "authorization_code", code: "CODE", redirect_uri: Config.REDIRECT_URI, code_verifier: "VERIFIER" });
	assert.deepStrictEqual(requests[1].headers, { Authorization: "Bearer AT" });
	assert.strictEqual(r.username, "u@example.test", "no mail: the userPrincipalName");
	assert.strictEqual(r.alias, "U Ser");
	assert.strictEqual(r.credentials.common.refreshToken, "RT");
});

test("checkCredentials: /me with the given token, mail first; a rejected token is an error", async () => {
	const { call } = start([["GET", /\/me\?/, (q) => (q.headers.Authorization === "Bearer good"
		? { status: 200, body: { displayName: "U", userPrincipalName: "upn@example.test", mail: "m@example.test" } } : { status: 401 })]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "good" } } }, {}),
		{ returnValue: true, renewedCredentials: null, username: "m@example.test", displayName: "U" });
	assert.strictEqual((await call("checkCredentials", { credentials: { common: { accessToken: "bad" } } }, {})).errorCode, "GRAPH_API_ERROR");
});

test("listFolder: a folder's children, $top=1000, every page (@odata.nextLink); entries normalised", async () => {
	const NEXT = API + "/me/drive/items/P1/children?$top=1000&$skiptoken=X2";
	const { call, requests } = start([
		["GET", /skiptoken=X2$/, () => ({ status: 200, body: { value: [fileItem] } })],
		["GET", /\/children\?\$top=1000$/, () => ({ status: 200, body: { value: [folderItem], "@odata.nextLink": NEXT } })],
	]);
	const r = await call("listFolder", { accountId: "acc", folderId: "P1" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entries: [folderEntry, fileEntry] });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/me/drive/items/P1/children?$top=1000", "GET " + NEXT]);
	for (const q of requests) { assert.deepStrictEqual(q.headers, AUTH); }
	for (const root of [{}, { path: "" }, { folderId: "root" }]) {
		await call("listFolder", Object.assign({ accountId: "acc" }, root));
		assert.strictEqual(requests[requests.length - 2].url, API + "/me/drive/root/children?$top=1000", JSON.stringify(root));
	}
	await call("listFolder", { accountId: "acc", folderId: "a b!1" });
	assert.strictEqual(requests[requests.length - 2].url, API + "/me/drive/items/a%20b!1/children?$top=1000");
});

test("listFolder: a next page off Graph is not fetched with the token", async () => {
	const { call, requests } = start([["GET", /./, () => ({ status: 200, body: { value: [], "@odata.nextLink": "https://evil.example.test/v1.0/x" } })]]);
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.errorCode, "GRAPH_API_ERROR");
	assert.strictEqual(requests.length, 1);
});

test("a 401: refresh with scope, retry, the rotated refresh token saved and reported", async () => {
	const { call, requests, written } = start([
		["POST", /\/children$/, () => ({ status: 401, body: {} }), { once: true }],
		["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 3600 } })],
		["POST", /\/children$/, (q) => (q.headers.Authorization === "Bearer tok2" ? { status: 201, body: folderItem } : { status: 401 })],
	]);
	const r = await call("createFolder", { accountId: "acc", folderId: "P1", name: "New" });
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/me/drive/items/P1/children", Config.TOKEN_URL, API + "/me/drive/items/P1/children"]);
	assert.deepStrictEqual(form(requests[1]), { client_id: Config.CLIENT_ID, scope: Config.SCOPE, grant_type: "refresh_token", refresh_token: "ref" });
	assert.strictEqual(requests[2].body, requests[0].body, "the retry sends the same body");
	assert.strictEqual(r.entry.id, "F9");
	assert.deepStrictEqual([r.renewedCredentials.accessToken, r.renewedCredentials.refreshToken], ["tok2", "ref2"], "Microsoft rotates");
	assert.deepStrictEqual(written, [{ accountId: "acc", name: "common", credentials: r.renewedCredentials }]);
});

test("a 401 whose retry is refused or gets no answer: that error, one reply", async () => {
	for (const [retry, code] of [[() => ({ status: 500, body: "{}" }), "GRAPH_API_ERROR"],
		[() => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); }, "CURL_FAILED"]]) {
		const { call, requests } = start([
			["GET", /children/, () => ({ status: 401 }), { once: true }],
			["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
			["GET", /children/, retry],
		]);
		assert.strictEqual((await call("listFolder", { accountId: "acc" })).errorCode, code);
		assert.strictEqual(requests.length, 3);
	}
});

test("a 401 whose refresh fails: the refresh's error, nothing saved, no retry", async () => {
	const { call, requests, written } = start([
		["GET", /children/, () => ({ status: 401 })],
		["POST", /token$/, () => ({ status: 400, body: { error: "invalid_grant" } })],
	]);
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.errorCode, "OAUTH_TOKEN_FAILED");
	assert.match(r.errorText, /invalid_grant/);
	assert.strictEqual(requests.length, 2);
	assert.deepStrictEqual(written, []);
});

test("an API error: GRAPH_API_ERROR with the status and Graph's code", async () => {
	const { call } = start([["POST", /children$/, () => ({ status: 409, body: { error: { code: "nameAlreadyExists", message: "Name already exists" } } })]]);
	assert.deepStrictEqual(await call("createFolder", { accountId: "acc", folderId: "P1", name: "New" }),
		{ returnValue: false, errorCode: "GRAPH_API_ERROR", errorText: "OneDrive answered HTTP 409: nameAlreadyExists (Name already exists)", status: 409 });
});

test("downloadFile: GET the item's /content, the bytes to localPath (folders 0755); a 404 writes no file", async () => {
	const BYTES = crypto.randomBytes(70000);
	const { call, requests } = start([
		["GET", /\/items\/GONE\/content$/, () => ({ status: 404, body: { error: { code: "itemNotFound" } } })],
		["GET", /\/content$/, () => new Response(BYTES, { status: 200 })],
	]);
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { accountId: "acc", fileId: "A 1", localPath: dest, exportMime: "application/pdf" }),
		{ returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.strictEqual(line(requests[0]), "GET " + API + "/me/drive/items/A%201/content", "exportMime is not Graph's");
	assert.deepStrictEqual(requests[0].headers, AUTH);
	const gone = dl();
	const r = await call("downloadFile", { accountId: "acc", fileId: "GONE", localPath: gone });
	assert.deepStrictEqual([r.errorCode, r.status], ["GRAPH_API_ERROR", 404]);
	assert.ok(!fs.existsSync(gone));
});

test("uploadFile: PUT the file to {folder}:/{name}:/content; the root, the local name by default", async () => {
	const { call, requests } = start([["PUT", /:\/content$/, () => ({ status: 201, body: { id: "U1", name: "Notes é.txt", size: 5000, file: {} } })]]);
	const r = await call("uploadFile", { accountId: "acc", folderId: "P1", localPath: LOCAL, name: "Notes é.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Notes é.txt", id: "U1", size: 5000 });
	assert.strictEqual(line(requests[0]), "PUT " + API + "/me/drive/items/P1:/Notes%20%C3%A9.txt:/content");
	assert.deepStrictEqual(requests[0].headers, PUTH);
	assert.strictEqual(requests[0].body.blob, LOCAL_BYTES.length, "a Blob of the file, streamed by fetch");
	await call("uploadFile", { accountId: "acc", localPath: LOCAL });
	await call("uploadFile", { accountId: "acc", folderId: "root", localPath: LOCAL, name: "a&b" });
	assert.deepStrictEqual(requests.slice(1).map((q) => q.url), [API + "/me/drive/root:/local.bin:/content", API + "/me/drive/root:/a%26b:/content"]);
});

test("uploadFile replace:true: PUT the new bytes to the item's /content", async () => {
	const { call, requests } = start([["PUT", /./, () => ({ status: 200, body: { id: "A1", name: "b.txt", size: 5000 } })]]);
	const r = await call("uploadFile", { accountId: "acc", fileId: "A1", localPath: LOCAL, replace: true, mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "b.txt", id: "A1", size: 5000 });
	assert.strictEqual(line(requests[0]), "PUT " + API + "/me/drive/items/A1/content");
	assert.deepStrictEqual(requests[0].headers, PUTH);
});

test("uploadFile: a 401 refreshes and sends the file again; a missing local file sends nothing", async () => {
	const { call, requests } = start([
		["PUT", /./, () => ({ status: 401 }), { once: true }],
		["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
		["PUT", /./, () => ({ status: 201, body: { id: "U" } })],
	]);
	assert.strictEqual((await call("uploadFile", { accountId: "acc", localPath: LOCAL })).id, "U");
	assert.strictEqual(requests[2].headers.Authorization, "Bearer tok2");
	assert.strictEqual(requests[2].body.blob, LOCAL_BYTES.length);
	assert.strictEqual((await call("uploadFile", { accountId: "acc", localPath: path.join(TMP, "nope") })).errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual(requests.length, 3);
});

test("createFolder: POST the parent's children with a folder facet and conflictBehavior fail; the entry is listFolder's", async () => {
	const { call, requests } = start([
		["POST", /children$/, () => ({ status: 201, body: folderItem })],
		["GET", /children/, () => ({ status: 200, body: { value: [folderItem] } })],
	]);
	const r = await call("createFolder", { accountId: "acc", folderId: "P1", name: "New" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: folderEntry });
	assert.strictEqual(line(requests[0]), "POST " + API + "/me/drive/items/P1/children");
	assert.deepStrictEqual(requests[0].headers, JSONH);
	assert.deepStrictEqual(body(requests[0]), { name: "New", folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
	assert.deepStrictEqual(json(r.entry), (await call("listFolder", { accountId: "acc", folderId: "P1" })).entries[0]);
	for (const root of [{}, { folderId: "root" }]) {
		await call("createFolder", Object.assign({ accountId: "acc", name: "Top" }, root));
		assert.strictEqual(requests[requests.length - 1].url, API + "/me/drive/root/children", JSON.stringify(root));
	}
});

test("moveItem: rename only, move only, both - one PATCH with name and/or parentReference", async () => {
	const { call, requests } = start([["PATCH", /./, () => ({ status: 200, body: fileItem })]]);
	const r = await call("moveItem", { accountId: "acc", fileId: "A1", name: "b.txt" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: fileEntry });
	await call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "NEW" });
	await call("moveItem", { accountId: "acc", fileId: "A 1", toFolderId: "NEW", name: "b.txt" });
	assert.deepStrictEqual(requests.map((q) => [line(q), body(q)]), [
		["PATCH " + API + "/me/drive/items/A1", { name: "b.txt" }],
		["PATCH " + API + "/me/drive/items/A1", { parentReference: { id: "NEW" } }],
		["PATCH " + API + "/me/drive/items/A%201", { name: "b.txt", parentReference: { id: "NEW" } }],
	]);
	assert.deepStrictEqual(requests[0].headers, JSONH);
});

test("moveItem to the root: Graph refuses id \"root\", so the root's real id is looked up first", async () => {
	const { call, requests } = start([
		["GET", /\/me\/drive\/root\?\$select=id$/, () => ({ status: 200, body: { id: "ROOT!101" } })],
		["PATCH", /./, () => ({ status: 200, body: fileItem })],
	]);
	const r = await call("moveItem", { accountId: "acc", fileId: "A1", toRoot: true });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/me/drive/root?$select=id", "PATCH " + API + "/me/drive/items/A1"]);
	assert.deepStrictEqual(body(requests[1]), { parentReference: { id: "ROOT!101" } });
	assert.strictEqual(r.entry.id, "A1");
});

test("moveItem: a failed root lookup or PATCH fails the move", async () => {
	let t = start([["GET", /./, () => ({ status: 404, body: {} })], ["PATCH", /./, () => ({ status: 200, body: fileItem })]]);
	let r = await t.call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "root", name: "x" });
	assert.deepStrictEqual([r.errorCode, r.status, t.requests.length], ["GRAPH_API_ERROR", 404, 1]);
	t = start([["GET", /./, () => ({ status: 200, body: {} })], ["PATCH", /./, () => ({ status: 200, body: fileItem })]]);
	r = await t.call("moveItem", { accountId: "acc", fileId: "A1", toRoot: true });
	assert.deepStrictEqual([r.errorCode, t.requests.length], ["GRAPH_API_ERROR", 1], "no root id: no PATCH that would only rename");
	t = start([["PATCH", /./, () => ({ status: 409, body: { error: { code: "nameAlreadyExists" } } })]]);
	r = await t.call("moveItem", { accountId: "acc", fileId: "A1", toFolderId: "NEW", name: "x" });
	assert.strictEqual(r.status, 409);
});

test("moveItem: a token refreshed on the root lookup is used for the PATCH, saved once", async () => {
	const { call, requests, written } = start([
		["GET", /root/, () => ({ status: 401 }), { once: true }],
		["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
		["GET", /root/, () => ({ status: 200, body: { id: "R" } })],
		["PATCH", /./, (q) => (q.headers.Authorization === "Bearer tok2" ? { status: 200, body: fileItem } : { status: 401 })],
	]);
	assert.strictEqual((await call("moveItem", { accountId: "acc", fileId: "A1", toRoot: true })).entry.id, "A1");
	assert.deepStrictEqual(requests.map((q) => q.headers.Authorization || "token"), ["Bearer tok", "token", "Bearer tok2", "Bearer tok2"]);
	assert.strictEqual(written.length, 1);
	assert.strictEqual(written[0].credentials.refreshToken, "ref2");
});

test("deleteItem: DELETE the item (to the recycle bin), 204 or any 2xx; the root is refused", async () => {
	const { call, requests } = start([
		["DELETE", /\/items\/A2$/, () => ({ status: 200, body: { id: "A2" } })],
		["DELETE", /./, () => ({ status: 204 })],
	]);
	assert.deepStrictEqual(await call("deleteItem", { accountId: "acc", fileId: "A1" }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(await call("deleteItem", { accountId: "acc", fileId: "A2" }), { returnValue: true, renewedCredentials: null });
	assert.strictEqual(line(requests[0]), "DELETE " + API + "/me/drive/items/A1");
	assert.deepStrictEqual(requests[0].headers, AUTH);
	assert.strictEqual(requests[0].body, undefined);
	assert.strictEqual((await call("deleteItem", { accountId: "acc", path: "root" })).errorCode, "BAD_ARGS");
	assert.strictEqual(requests.length, 2);
	const t = start([["DELETE", /./, () => ({ status: 404, body: { error: { code: "itemNotFound" } } })]]);
	const r = await t.call("deleteItem", { accountId: "acc", fileId: "A1" });
	assert.deepStrictEqual([r.returnValue, r.errorCode, r.status], [false, "GRAPH_API_ERROR", 404]);
});

test("listAlbums: one album, the Camera Roll special folder, counting its images over every page", async () => {
	const NEXT = API + "/me/drive/special/cameraroll/children?$skiptoken=2";
	const { call, requests } = start([
		["GET", /skiptoken=2$/, () => ({ status: 200, body: { value: [jpg("P2", "b.HEIC", "u")] } })],
		["GET", /special\/cameraroll\/children/, () => ({ status: 200, body: { value: [jpg("P1", "a.jpg", "u"), fileItem,
			{ id: "D", name: "x.jpg", folder: {} }], "@odata.nextLink": NEXT } })],
	]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS),
		{ returnValue: true, albums: [{ aid: "cameraroll", name: "Camera Roll", size: { images: 2 } }] });
	assert.deepStrictEqual(requests.map(line), ["GET " + API + "/me/drive/special/cameraroll/children?$top=1000", "GET " + NEXT]);
});

test("listAlbums: a Camera Roll that cannot be listed is the album with 0 images; no credentials is an error", async () => {
	const { call } = start([["GET", /./, () => ({ status: 404, body: { error: { code: "itemNotFound" } } })]]);
	assert.deepStrictEqual((await call("listAlbums", { accountId: "acc" }, PHOTOS)).albums[0].size, { images: 0 });
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: the images with their download URL, no request per photo; none without a URL", async () => {
	const { call, requests } = start([["GET", /special\/cameraroll\/children/, () => ({ status: 200, body: { value: [
		jpg("P1", "IMG_1.JPG", "https://dl.example.test/1"), fileItem, jpg("P2", "b.png", undefined)] } })]]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "cameraroll" }, PHOTOS), { returnValue: true, photos: [
		{ pid: "P1", src_big: "https://dl.example.test/1", src_small: "https://dl.example.test/1", caption: "IMG_1.JPG", type: "image", fileName: "IMG_1.JPG" }] });
	assert.strictEqual(requests.length, 1);
});

test("listPhotos: a Camera Roll that cannot be listed is an empty list, as before; no credentials is an error", async () => {
	const { call } = start([["GET", /./, () => ({ status: 500, body: "oops" })]]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc" }, PHOTOS), { returnValue: true, photos: [] });
	assert.strictEqual((await start([], { stored: null }).call("listPhotos", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("upload (Photos): into the album (the Camera Roll special folder), or the root; pid is the item id", async () => {
	const { call, requests } = start([["PUT", /./, () => ({ status: 201, body: { id: "NEW", name: "p.jpg", size: 5000 } })]]);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: "cameraroll", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "NEW", name: "p.jpg", size: 5000 });
	await call("upload", { accountId: "acc", path: LOCAL }, PHOTOS);
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/me/drive/special/cameraroll:/local.bin:/content", API + "/me/drive/root:/local.bin:/content"]);
});

test("deletePhoto: DELETE the item", async () => {
	const { call, requests } = start([["DELETE", /./, () => ({ status: 204 })]]);
	assert.deepStrictEqual(await call("deletePhoto", { accountId: "acc", pid: "P1" }, PHOTOS), { returnValue: true, pid: "P1" });
	assert.strictEqual(line(requests[0]), "DELETE " + API + "/me/drive/items/P1");
});

// --- every request failing, in turn ----------------------------------------------------------

// What Graph answers when nothing fails.
function happy(q) {
	const u = q.url;
	if (/token$/.test(u)) { return { status: 200, body: { access_token: "AT2", refresh_token: "RT2", expires_in: 3600 } }; }
	if (/\/me\?/.test(u)) { return { status: 200, body: { mail: "u@example.test", displayName: "U" } }; }
	if (/skiptoken=2$/.test(u)) { return { status: 200, body: { value: [jpg("P2", "2.jpg", "https://dl.example.test/2")] } }; }
	if (q.method === "GET" && /\/children\?/.test(u)) {
		return { status: 200, body: { value: [jpg("P1", "1.jpg", "https://dl.example.test/1")], "@odata.nextLink": u.replace(/\?.*$/, "?$skiptoken=2") } };
	}
	if (/\/root\?\$select=id$/.test(u)) { return { status: 200, body: { id: "ROOT!1" } }; }
	if (q.method === "GET" && /\/content$/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (q.method === "DELETE") { return { status: 204 }; }
	if (q.method === "POST") { return { status: 201, body: folderItem }; }
	return { status: 200, body: fileItem };
}

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401 and a refused refresh": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": (q) => (q.method === "GET" && /\/content$/.test(q.url) ? { status: 200, body: "ok" } : { status: 200, body: "<html>" }),
};

// [label, payload, caller, { minSteps, tolerated(k), notJsonOk }]
const OPS = [
	["listFolder", { accountId: "acc", folderId: "X" }, DOCS, { minSteps: 2 }],
	["downloadFile", () => ({ accountId: "acc", fileId: "A1", localPath: dl() }), DOCS, { notJsonOk: true }],
	["uploadFile", { accountId: "acc", folderId: "P", localPath: LOCAL }, DOCS],
	["uploadFile (replace)", { accountId: "acc", fileId: "A1", localPath: LOCAL, replace: true }, DOCS],
	["createFolder", { accountId: "acc", folderId: "P", name: "n" }, DOCS],
	["moveItem (rename)", { accountId: "acc", fileId: "A1", name: "b.txt" }, DOCS],
	["moveItem (to a folder)", { accountId: "acc", fileId: "A1", toFolderId: "D" }, DOCS],
	["moveItem (to the root)", { accountId: "acc", fileId: "A1", toRoot: true }, DOCS, { minSteps: 2 }],
	["deleteItem", { accountId: "acc", fileId: "A1" }, DOCS],
	["checkCredentials", { credentials: { common: { accessToken: "tok", refreshToken: "ref" } } }, {}],
	["exchangeCode", { code: "c", codeVerifier: "v" }, {}, { minSteps: 2, tolerated: (k) => k >= 2 }],
	["upload", { accountId: "acc", albumId: "cameraroll", path: LOCAL }, PHOTOS],
	["deletePhoto", { accountId: "acc", pid: "P1" }, PHOTOS],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
	["listPhotos", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`onedrive ${label}: any request failing (${mode}) is one error reply`, async () => {
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
				const { call } = start(["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => [m, /./, answer]), { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
				const r = await call(method, typeof payload === "function" ? payload() : payload, caller);   // exactly one reply, or ask() throws
				if (n < k) {
					assert.strictEqual(r.returnValue, true, `the run with nothing failing failed: ${JSON.stringify(r)}`);
					break;
				}
				reached = k;
				const absorbed = (opts.tolerated && opts.tolerated(k)) || (opts.notJsonOk && mode === "a reply that is not JSON");
				if (absorbed) {
					assert.ok(r.returnValue === true || (r.errorCode && r.errorCode !== "CONNECTOR_EXCEPTION"), `request ${k} failing: ${JSON.stringify(r)}`);
				} else {
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
	assert.strictEqual((await broken.call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "BUS_BAD_REPLY");
});

test("a renewed token that cannot be saved does not stop the reply", async () => {
	const { call } = start([
		["GET", /children/, () => ({ status: 401 }), { once: true }],
		["POST", /token$/, () => ({ status: 200, body: { access_token: "tok2", refresh_token: "ref2", expires_in: 60 } })],
		["GET", /children/, () => ({ status: 200, body: { value: [] } })],
	], { onCall: (uri) => (/readCredentials$/.test(uri) ? { returnValue: true, credentials: STORED } : { returnValue: false, errorCode: -1, errorText: "bus down" }) });
	const r = await call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(json(r).renewedCredentials.refreshToken, "ref2");
});
