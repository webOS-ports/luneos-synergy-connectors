// node --test tests/unit
// The pCloud connector (cloud/pcloud/service/com.palm.service.pcloud) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (region host, pCloud method, query parameters, body), its reply, and its
// errors; the Accounts service is answered by the stand-in bus. The file-operation cases are
// those of the old pcloud-fileops.test.js (the file/folder probe, PCLOUD_AMBIGUOUS_ID,
// PCLOUD_NOT_FOUND, PCLOUD_EXISTS, typed ids, the root as 0), now through the bus.
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

const SVC = path.join(__dirname, "../../cloud/pcloud/service/com.palm.service.pcloud");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pcloud-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "tmp-123.bin");
const LOCAL_BYTES = crypto.randomBytes(2000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const TOKEN = "TOKEN-a1b2c3";
const STORED = { accessToken: TOKEN, apiHost: "eapi.pcloud.com", locationid: 2, uid: 77 };

const FOLDER = { isfolder: true, folderid: 55, parentfolderid: 5, id: "d55", name: "New", modified: "Mon, 19 Oct 2026 10:00:00 +0000", created: "x" };
const FILE = { isfolder: false, fileid: 7, parentfolderid: 5, id: "f7", name: "a.txt", size: 42, contenttype: "text/plain", modified: "Mon, 19 Oct 2026 10:00:01 +0000" };
const FOLDER_ENTRY = { id: 55, type: "folder", name: "New", modified: FOLDER.modified, path: 55 };
const FILE_ENTRY = { id: 7, type: "file", name: "a.txt", size: 42, modified: FILE.modified, path: 7, mimeType: "text/plain" };
const ok = (obj) => ({ status: 200, body: Object.assign({ result: 0 }, obj) });
const apiErr = (result, error) => ({ status: 200, body: { result, error } });
const notFile = apiErr(2009, "File not found.");
const notFolder = apiErr(2005, "Directory does not exist.");

// The service on a stand-in bus. Accounts: readCredentials gives `stored`, writeCredentials is
// recorded. routes: fakeFetch's, or a function (req) -> reply for every request.
function start(routes, { stored = STORED, onCall, timeouts } = {}) {
	if (typeof routes === "function") { routes = ["GET", "POST"].map((m) => [m, /./, routes]); }
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
// A script: one reply per request, in order; none left is a 599.
function script(replies) { return () => (replies.length ? replies.shift() : { status: 599, body: "unexpected" }); }
// What was asked: [pCloud method, query without the token].
const asked = (requests) => requests.map((r) => {
	const u = new URL(r.url), p = Object.fromEntries(u.searchParams);
	delete p.access_token;
	return [u.pathname.slice(1), p];
});
const hosts = (requests) => requests.map((r) => new URL(r.url).host);
const tokens = (requests) => requests.map((r) => new URL(r.url).searchParams.get("access_token"));

test("the service: its bus name, and every method the old services.json had (plus quit, info)", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.pcloud");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "moveItem", "quit",
		"upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const gone of ["services.json", "sources.json", "commands"]) { assert.ok(!fs.existsSync(path.join(SVC, gone)), gone); }
});

test("caller rules: file methods for the FILE_APP_IDS, auth and photo methods open", async () => {
	const { call } = start(() => ok({ metadata: { contents: [] }, email: "e" }));
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.cloud-auth" }, PHOTOS, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", fileId: "7", name: "b", localPath: LOCAL, folderId: "5" }, who);
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

test("getAuthorizeUrl: my.pcloud.com's consent URL, no PKCE, no verifier", async () => {
	const { call, requests } = start([]);
	const r = await call("getAuthorizeUrl", {}, {});
	assert.deepStrictEqual(Object.keys(r).sort(), ["returnValue", "url"]);
	const u = new URL(r.url);
	assert.strictEqual(u.origin + u.pathname, "https://my.pcloud.com/oauth2/authorize");
	assert.deepStrictEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: Config.CLIENT_ID,
		redirect_uri: "http://localhost/pcloud/oauth2callback", state: "pcloud" });
	assert.strictEqual(new URL((await call("getAuthorizeUrl", { state: "s 1" }, {})).url).searchParams.get("state"), "s 1");
	assert.strictEqual(requests.length, 0);
});

test("exchangeCode: the token on the region host the redirect named, stored as apiHost; the email as username", async () => {
	const { call, requests } = start([
		["POST", /\/oauth2_token$/, () => ok({ access_token: "AT", token_type: "bearer", userid: 99, locationid: 2 })],
		["GET", /\/userinfo\?/, () => ok({ email: "u@example.test" })],
	]);
	const r = await call("exchangeCode", { code: "CODE", hostname: "eapi.pcloud.com", locationid: "2" }, { service: "com.palm.service.accounts" });
	assert.deepStrictEqual(r, { returnValue: true, username: "u@example.test",
		credentials: { common: { accessToken: "AT", apiHost: "eapi.pcloud.com", locationid: 2, uid: 99 } } });
	assert.deepStrictEqual(requests.map((x) => x.method + " " + x.url.replace(/\?.*/, "")), ["POST https://eapi.pcloud.com/oauth2_token", "GET https://eapi.pcloud.com/userinfo"]);
	assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[0].body)), { client_id: Config.CLIENT_ID, client_secret: Config.CLIENT_SECRET, code: "CODE" });
	assert.strictEqual(new URL(requests[1].url).searchParams.get("access_token"), "AT");
});

test("exchangeCode: the host - a pCloud hostname wins, else the locationid's, else the US one; a foreign hostname is ignored", async () => {
	for (const [args, host] of [[{ hostname: "eapi.pcloud.com" }, "eapi.pcloud.com"], [{ locationid: 2 }, "eapi.pcloud.com"], [{ locationid: "1" }, "api.pcloud.com"],
		[{}, "api.pcloud.com"], [{ hostname: "evil.example.test", locationid: "2" }, "eapi.pcloud.com"], [{ hostname: "pcloud.com.evil.test" }, "api.pcloud.com"],
		[{ hostname: "api.pcloud.com", locationid: "2" }, "api.pcloud.com"]]) {
		const { call, requests } = start([["POST", /oauth2_token$/, () => ok({ access_token: "AT" })], ["GET", /userinfo/, () => ok({ email: "e" })]]);
		const r = await call("exchangeCode", Object.assign({ code: "C" }, args), {});
		assert.deepStrictEqual(hosts(requests), [host, host], JSON.stringify(args));
		assert.strictEqual(r.credentials.common.apiHost, host);
		if (args.locationid !== undefined) { assert.strictEqual(r.credentials.common.locationid, args.locationid, "the redirect's locationid when the token has none"); }
	}
});

test("exchangeCode: a token refused in any way is OAUTH_TOKEN_FAILED; userinfo failing still makes the account", async () => {
	for (const reply of [{ status: 400, body: { error: "invalid_grant" } }, apiErr(2012, "Invalid 'code' provided."), ok({}), { status: 200, body: "<html>" }, { status: 201, body: { access_token: "AT" } }]) {
		const { call, requests } = start([["POST", /oauth2_token$/, () => reply]]);
		const r = await call("exchangeCode", { code: "C" }, {});
		assert.strictEqual(r.errorCode, "OAUTH_TOKEN_FAILED", JSON.stringify(reply));
		assert.strictEqual(requests.length, 1);
	}
	const { call } = start([["POST", /oauth2_token$/, () => ok({ access_token: "AT" })], ["GET", /userinfo/, () => apiErr(2000, "Log in failed.")]]);
	const r = await call("exchangeCode", { code: "C" }, {});
	assert.strictEqual(r.username, "pCloud");
	assert.strictEqual(r.credentials.common.accessToken, "AT");
	assert.strictEqual((await call("exchangeCode", {}, {})).errorCode, "MISSING_CODE");
});

test("checkCredentials: userinfo on the account's host; a rejected token is PCLOUD_API_ERROR; nothing is ever refreshed", async () => {
	const { call, requests } = start([["GET", /userinfo/, (r) => (new URL(r.url).searchParams.get("access_token") === "good" ? ok({ email: "u@example.test" }) : apiErr(2000, "Log in failed."))]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: { accessToken: "good", apiHost: "eapi.pcloud.com" } } }, {}),
		{ returnValue: true, renewedCredentials: null, username: "u@example.test", displayName: "u@example.test" });
	assert.strictEqual(hosts(requests)[0], "eapi.pcloud.com");
	const bad = await call("checkCredentials", { credentials: { common: { accessToken: "bogus", refreshToken: "r" } } }, {});
	assert.deepStrictEqual([bad.errorCode, bad.errorText], ["PCLOUD_API_ERROR", "pCloud userinfo: error 2000: Log in failed."]);
	assert.strictEqual(hosts(requests)[1], "api.pcloud.com", "no apiHost: the US host");
	const h401 = start([["GET", /./, () => ({ status: 401, body: "" })]]);
	const e = await h401.call("checkCredentials", { credentials: { common: { accessToken: "x", refreshToken: "r" } } }, {});
	assert.deepStrictEqual([e.errorCode, e.status], ["PCLOUD_HTTP_ERROR", 401]);
	assert.strictEqual(h401.requests.length, 1);
	assert.strictEqual(requests.length, 2);
});

test("listFolder: listfolder by folderid on the region host, the token in the query; entries keep pCloud's numeric ids", async () => {
	const { call, requests, written } = start([["GET", /listfolder/, () => ok({ metadata: { folderid: 5, contents: [FOLDER, FILE] } })]]);
	assert.deepStrictEqual(await call("listFolder", { accountId: "acc", folderId: "5" }), { returnValue: true, renewedCredentials: null, entries: [FOLDER_ENTRY, FILE_ENTRY] });
	assert.deepStrictEqual(asked(requests), [["listfolder", { folderid: "5" }]]);
	assert.deepStrictEqual([requests[0].method, hosts(requests)[0], tokens(requests)[0]], ["GET", "eapi.pcloud.com", TOKEN]);
	assert.deepStrictEqual(requests[0].headers, {}, "no Authorization header");
	for (const root of [{}, { path: "" }, { path: "/" }, { folderId: "root" }, { folderId: 0 }, { folderId: "0" }]) {
		await call("listFolder", Object.assign({ accountId: "acc" }, root));
		assert.deepStrictEqual(asked(requests).pop(), ["listfolder", { folderid: "0" }], JSON.stringify(root));
	}
	assert.deepStrictEqual(written, []);
});

test("downloadFile: getfilelink, then the link's bytes (no token) to localPath; no link, or a failed fetch, writes nothing", async () => {
	const BYTES = crypto.randomBytes(40000);
	const { call, requests } = start([
		["GET", /getfilelink\?.*fileid=7/, () => ok({ hosts: ["c1.pcloud.example.test", "c2"], path: "/cBZ/a.txt" })],
		["GET", /getfilelink\?.*fileid=8/, () => ok({ hosts: [], path: "/x" })],
		["GET", /getfilelink\?.*fileid=9/, () => ok({ hosts: ["c1.pcloud.example.test"], path: "/gone" })],
		["GET", /c1\.pcloud\.example\.test\/cBZ/, () => new Response(BYTES, { status: 200 })],
		["GET", /c1\.pcloud\.example\.test\/gone/, () => ({ status: 410, body: "" })],
	]);
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { accountId: "acc", fileId: 7, localPath: dest }), { returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.deepStrictEqual(asked(requests)[0], ["getfilelink", { fileid: "7" }]);
	assert.strictEqual(requests[1].url, "https://c1.pcloud.example.test/cBZ/a.txt");
	assert.strictEqual(requests[1].headers.Authorization, undefined);
	for (const [id, code] of [[8, "PCLOUD_NO_LINK"], [9, "PCLOUD_DOWNLOAD_FAILED"]]) {
		const d = dl();
		assert.strictEqual((await call("downloadFile", { accountId: "acc", fileId: id, localPath: d })).errorCode, code);
		assert.ok(!fs.existsSync(d));
	}
});

test("uploadFile: uploadfile with folderid, filename, nopartial; the multipart part is named as the file is to be", async () => {
	const { call, requests } = start([["POST", /uploadfile/, () => ok({ fileids: [70], metadata: [Object.assign({}, FILE, { fileid: 70, name: "note.txt", size: 2000 })] })]]);
	const r = await call("uploadFile", { accountId: "acc", folderId: 5, localPath: LOCAL, name: "note.txt", mimeType: "text/plain" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "note.txt", id: 70, size: 2000 });
	assert.deepStrictEqual(asked(requests), [["uploadfile", { folderid: "5", filename: "note.txt", nopartial: "1" }]]);
	assert.deepStrictEqual([requests[0].method, hosts(requests)[0], tokens(requests)[0]], ["POST", "eapi.pcloud.com", TOKEN]);
	assert.deepStrictEqual(requests[0].body.form.map(([k, v]) => [k, v.name, v.size]), [["file", "note.txt", LOCAL_BYTES.length]]);
	for (const root of [{}, { folderId: "root" }, { path: "/" }]) {
		await call("uploadFile", Object.assign({ accountId: "acc", localPath: LOCAL }, root));
		assert.deepStrictEqual(asked(requests).pop(), ["uploadfile", { folderid: "0", filename: "tmp-123.bin", nopartial: "1" }], JSON.stringify(root));
	}
});

test("uploadFile replace:true: checksumfile for the name and folder, then the upload there under that name", async () => {
	const { call, requests } = start(script([ok({ metadata: FILE }), ok({ metadata: [Object.assign({}, FILE, { size: 2000 })] })]));
	const r = await call("uploadFile", { accountId: "acc", fileId: "7", localPath: LOCAL, replace: true });
	assert.deepStrictEqual([r.id, r.name, r.size], [7, "a.txt", 2000]);
	assert.deepStrictEqual(asked(requests), [["checksumfile", { fileid: "7" }], ["uploadfile", { folderid: "5", filename: "a.txt", nopartial: "1" }]]);
	assert.strictEqual(requests[1].body.form[0][1].name, "a.txt");
	const k = start(script([ok({ metadata: { name: "a.txt" } })]));
	assert.strictEqual((await k.call("uploadFile", { accountId: "acc", fileId: "7", localPath: LOCAL, replace: true })).errorCode, "PCLOUD_NO_FILEINFO");
	assert.strictEqual(k.requests.length, 1);
});

test("createFolder asks createfolder on the account's region host and answers listFolder's entry", async () => {
	const { call, requests } = start(script([ok({ metadata: FOLDER })]));
	const r = await call("createFolder", { accountId: "acc", folderId: 5, name: "New" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: FOLDER_ENTRY });
	assert.deepStrictEqual(asked(requests), [["createfolder", { folderid: "5", name: "New" }]]);
	assert.deepStrictEqual([requests[0].method, hosts(requests)[0], tokens(requests)[0]], ["GET", "eapi.pcloud.com", TOKEN]);
	const lf = start([["GET", /listfolder/, () => ok({ metadata: { folderid: 5, contents: [FOLDER] } })]]);
	assert.deepStrictEqual((await lf.call("listFolder", { accountId: "acc", folderId: 5 })).entries[0], r.entry);
});

test("createFolder: the root by every name, a typed folder id, the US host by default; a file id is refused unsent", async () => {
	for (const root of [{}, { folderId: "root" }, { path: "" }, { path: "/" }, { folderId: 0 }, { folderId: "0" }, { folderId: "d0" }]) {
		const { call, requests } = start(script([ok({ metadata: FOLDER })]));
		await call("createFolder", Object.assign({ accountId: "acc", name: "New & Co" }, root));
		assert.deepStrictEqual(asked(requests), [["createfolder", { folderid: "0", name: "New & Co" }]], JSON.stringify(root));
	}
	let k = start(script([ok({ metadata: FOLDER })]), { stored: { accessToken: "tok" } });
	await k.call("createFolder", { accountId: "acc", folderId: "d5", name: "New" });
	assert.deepStrictEqual(asked(k.requests), [["createfolder", { folderid: "5", name: "New" }]]);
	assert.strictEqual(hosts(k.requests)[0], "api.pcloud.com");
	for (const bad of ["f5", "/Docs", "abc"]) {
		k = start(script([]));
		assert.strictEqual((await k.call("createFolder", { accountId: "acc", folderId: bad, name: "New" })).errorCode, "BAD_ARGS", bad);
		assert.strictEqual(k.requests.length, 0);
	}
});

test("a nonzero result in an HTTP 200 fails with it, and so does an HTTP error", async () => {
	let k = start(script([apiErr(2004, "File or folder alredy exists.")]));
	assert.deepStrictEqual(await k.call("createFolder", { accountId: "acc", folderId: 5, name: "New" }),
		{ returnValue: false, errorCode: "PCLOUD_API_ERROR", errorText: "pCloud createfolder: error 2004: File or folder alredy exists." });
	k = start(script([{ status: 502, body: "Bad gateway" }]));
	assert.deepStrictEqual(await k.call("createFolder", { accountId: "acc", folderId: 5, name: "New" }),
		{ returnValue: false, errorCode: "PCLOUD_HTTP_ERROR", errorText: "pCloud answered HTTP 502: Bad gateway", status: 502 });
});

test("moveItem renames a file in place after checking its folder", async () => {
	const { call, requests } = start(script([ok({ metadata: FILE }), notFolder,
		ok({ metadata: { folderid: 5, contents: [FILE, Object.assign({}, FOLDER, { name: "other" })] } }), ok({ metadata: Object.assign({}, FILE, { name: "b.txt" }) })]));
	const r = await call("moveItem", { accountId: "acc", fileId: 7, name: "b.txt" });
	assert.deepStrictEqual(r.entry, Object.assign({}, FILE_ENTRY, { name: "b.txt" }));
	assert.deepStrictEqual(asked(requests), [
		["checksumfile", { fileid: "7" }],
		["listfolder", { folderid: "7", nofiles: "1" }],
		["listfolder", { folderid: "5" }],
		["renamefile", { fileid: "7", toname: "b.txt" }],
	]);
	assert.ok(hosts(requests).every((h) => h === "eapi.pcloud.com"));
});

test("moveItem moves a file with tofolderid only, or with both; to the root with toRoot", async () => {
	let k = start(script([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 9, contents: [] } }), ok({ metadata: Object.assign({}, FILE, { parentfolderid: 9 }) })]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", fileId: "7", toFolderId: 9 })).entry.path, 7);
	assert.deepStrictEqual(asked(k.requests).slice(2), [["listfolder", { folderid: "9" }], ["renamefile", { fileid: "7", tofolderid: "9" }]]);
	k = start(script([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 9, contents: [] } }), ok({ metadata: Object.assign({}, FILE, { name: "b.txt" }) })]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", fileId: 7, toFolderId: "d9", name: "b.txt" })).entry.name, "b.txt");
	assert.deepStrictEqual(asked(k.requests).slice(2), [["listfolder", { folderid: "9" }], ["renamefile", { fileid: "7", tofolderid: "9", toname: "b.txt" }]]);
	k = start(script([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 0, contents: [] } }), ok({ metadata: FILE })]));
	await k.call("moveItem", { accountId: "acc", fileId: 7, toRoot: true });
	assert.deepStrictEqual(asked(k.requests).slice(2), [["listfolder", { folderid: "0" }], ["renamefile", { fileid: "7", tofolderid: "0" }]]);
});

test("moveItem refuses to replace a file or folder of that name (PCLOUD_EXISTS), but lets a file change its own case", async () => {
	for (const clash of [Object.assign({}, FILE, { fileid: 8, name: "B.TXT" }), Object.assign({}, FOLDER, { name: "b.txt" })]) {
		const k = start(script([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 9, contents: [clash] } })]));
		const e = await k.call("moveItem", { accountId: "acc", fileId: 7, toFolderId: 9, name: "b.txt" });
		assert.deepStrictEqual([e.returnValue, e.errorCode], [false, "PCLOUD_EXISTS"]);
		assert.strictEqual(k.requests.length, 3, "no renamefile");
	}
	const k = start(script([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 5, contents: [FILE] } }), ok({ metadata: Object.assign({}, FILE, { name: "A.txt" }) })]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", fileId: 7, name: "A.txt" })).entry.name, "A.txt");
	assert.deepStrictEqual(asked(k.requests)[3], ["renamefile", { fileid: "7", toname: "A.txt" }]);
});

test("moveItem renames and moves a folder with renamefolder, with no listing first", async () => {
	const moved = Object.assign({}, FOLDER, { parentfolderid: 9, name: "Renamed" });
	let k = start(script([notFile, ok({ metadata: Object.assign({}, FOLDER, { contents: [] }) }), ok({ metadata: moved })]));
	const r = await k.call("moveItem", { accountId: "acc", fileId: 55, toFolderId: 9, name: "Renamed" });
	assert.deepStrictEqual(r.entry, Object.assign({}, FOLDER_ENTRY, { name: "Renamed" }));
	assert.deepStrictEqual(asked(k.requests), [
		["checksumfile", { fileid: "55" }],
		["listfolder", { folderid: "55", nofiles: "1" }],
		["renamefolder", { tofolderid: "9", toname: "Renamed", folderid: "55" }],
	]);
	k = start(script([notFile, ok({ metadata: FOLDER }), ok({ metadata: moved })]));
	await k.call("moveItem", { accountId: "acc", fileId: 55, name: "Renamed" });
	assert.deepStrictEqual(asked(k.requests)[2], ["renamefolder", { toname: "Renamed", folderid: "55" }]);
	k = start(script([notFile, ok({ metadata: FOLDER }), ok({ metadata: moved })]));
	await k.call("moveItem", { accountId: "acc", fileId: 55, toFolderId: 9 });
	assert.deepStrictEqual(asked(k.requests)[2], ["renamefolder", { tofolderid: "9", folderid: "55" }]);
	k = start(script([notFile, ok({ metadata: FOLDER }), apiErr(2004, "File or folder alredy exists.")]));
	assert.match((await k.call("moveItem", { accountId: "acc", fileId: 55, toFolderId: 9 })).errorText, /error 2004/);
});

test("typed ids skip the other lookup", async () => {
	let k = start(script([ok({ metadata: FILE }), ok({ metadata: { folderid: 5, contents: [] } }), ok({ metadata: FILE })]));
	await k.call("moveItem", { accountId: "acc", fileId: "f7", name: "b.txt" });
	assert.deepStrictEqual(asked(k.requests), [["checksumfile", { fileid: "7" }], ["listfolder", { folderid: "5" }], ["renamefile", { fileid: "7", toname: "b.txt" }]]);
	k = start(script([ok({ metadata: FOLDER }), ok({})]));
	assert.strictEqual((await k.call("deleteItem", { accountId: "acc", fileId: "d55" })).returnValue, true);
	assert.deepStrictEqual(asked(k.requests), [["listfolder", { folderid: "55", nofiles: "1" }], ["deletefolderrecursive", { folderid: "55" }]]);
});

test("an id that is both a file and a folder (PCLOUD_AMBIGUOUS_ID), or neither (PCLOUD_NOT_FOUND), is refused before anything changes", async () => {
	let k = start(script([ok({ metadata: FILE }), ok({ metadata: Object.assign({}, FOLDER, { folderid: 7 }) })]));
	let e = await k.call("deleteItem", { accountId: "acc", fileId: 7 });
	assert.deepStrictEqual([e.returnValue, e.errorCode], [false, "PCLOUD_AMBIGUOUS_ID"]);
	assert.match(e.errorText, /use f7 or d7/);
	assert.strictEqual(k.requests.length, 2);
	k = start(script([ok({ metadata: FILE }), ok({ metadata: Object.assign({}, FOLDER, { folderid: 7 }) })]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", fileId: 7, toFolderId: 9 })).errorCode, "PCLOUD_AMBIGUOUS_ID");
	assert.strictEqual(k.requests.length, 2);
	k = start(script([notFile, notFolder]));
	assert.strictEqual((await k.call("deleteItem", { accountId: "acc", fileId: 7 })).errorCode, "PCLOUD_NOT_FOUND");
	assert.strictEqual(k.requests.length, 2);
});

test("a lookup that fails for another reason fails the call, in either lookup", async () => {
	let k = start(script([apiErr(2000, "Log in failed.")]));
	let e = await k.call("deleteItem", { accountId: "acc", fileId: 7 });
	assert.deepStrictEqual([e.errorCode, e.errorText], ["PCLOUD_API_ERROR", "pCloud checksumfile: error 2000: Log in failed."]);
	assert.strictEqual(k.requests.length, 1);
	k = start(script([notFile, apiErr(1000, "Log in required.")]));
	e = await k.call("moveItem", { accountId: "acc", fileId: 7, name: "b" });
	assert.deepStrictEqual([e.errorCode, e.errorText], ["PCLOUD_API_ERROR", "pCloud listfolder: error 1000: Log in required."]);
	assert.strictEqual(k.requests.length, 2);
});

test("deleteItem: deletefile for a file, deletefolderrecursive for a folder; errors fail", async () => {
	let k = start(script([ok({ metadata: FILE }), notFolder, ok({ metadata: Object.assign({}, FILE, { isdeleted: true }) })]));
	assert.deepStrictEqual(await k.call("deleteItem", { accountId: "acc", fileId: 7 }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(asked(k.requests)[2], ["deletefile", { fileid: "7" }]);
	k = start(script([notFile, ok({ metadata: FOLDER }), ok({ deletedfiles: 3, deletedfolders: 1 })]));
	assert.strictEqual((await k.call("deleteItem", { accountId: "acc", path: "55" })).returnValue, true);
	assert.deepStrictEqual(asked(k.requests)[2], ["deletefolderrecursive", { folderid: "55" }]);
	k = start(script([notFile, ok({ metadata: FOLDER }), apiErr(2028, "There are active shares or sharerequests for this folder.")]));
	const e = await k.call("deleteItem", { accountId: "acc", fileId: 55 });
	assert.deepStrictEqual([e.returnValue, e.errorCode], [false, "PCLOUD_API_ERROR"]);
	assert.match(e.errorText, /error 2028/);
});

test("the root folder is neither deleted nor moved; malformed ids are refused unsent", async () => {
	for (const [args, code] of [[{ path: "0" }, "BAD_ARGS"], [{ fileId: "d0" }, "BAD_ARGS"], [{ path: "/" }, "BAD_ARGS"], [{ path: "root" }, "BAD_ARGS"],
		[{ fileId: 0 }, "MISSING_ARGS"], [{ path: "" }, "MISSING_ARGS"], [{ fileId: "x7" }, "BAD_ARGS"], [{ path: "/a" }, "BAD_ARGS"]]) {
		const k = start(script([]));
		assert.strictEqual((await k.call("deleteItem", Object.assign({ accountId: "acc" }, args))).errorCode, code, JSON.stringify(args));
		assert.strictEqual(k.requests.length, 0);
	}
	let k = start(script([ok({ metadata: Object.assign({}, FOLDER, { folderid: 0 }) })]));
	assert.strictEqual((await k.call("moveItem", { accountId: "acc", fileId: "d0", name: "x" })).errorCode, "BAD_ARGS");
	assert.strictEqual(k.requests.length, 1);
	for (const args of [{ path: "/a", name: "b" }, { fileId: 7, toFolderId: "f9" }, { fileId: 7, toPath: "/Docs" }]) {
		k = start(script([]));
		assert.strictEqual((await k.call("moveItem", Object.assign({ accountId: "acc" }, args))).errorCode, "BAD_ARGS", JSON.stringify(args));
		assert.strictEqual(k.requests.length, 0);
	}
});

// --- Photos ----------------------------------------------------------------------------------

const JPG = { isfolder: false, fileid: 11, name: "IMG_1.JPG", contenttype: "image/jpeg" };
const HEIC = { isfolder: false, fileid: 12, name: "b.heic", contenttype: "application/octet-stream" };
const PNG = { isfolder: false, fileid: 13, name: "noext", contenttype: "image/png" };

test("listAlbums: the root (folderid 0) as one album, 'pCloud', counting its images; a failure is 0 images; no credentials is an error", async () => {
	const { call, requests } = start([["GET", /listfolder/, () => ok({ metadata: { folderid: 0, contents: [JPG, HEIC, PNG, FILE, Object.assign({}, FOLDER, { name: "x.jpg" })] } })]]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc" }, PHOTOS), { returnValue: true, albums: [{ aid: 0, name: "pCloud", size: { images: 3 } }] });
	assert.deepStrictEqual(asked(requests), [["listfolder", { folderid: "0" }]]);
	assert.strictEqual(hosts(requests)[0], "eapi.pcloud.com");
	assert.deepStrictEqual((await start(() => apiErr(2005, "x")).call("listAlbums", { accountId: "acc" }, PHOTOS)).albums, [{ aid: 0, name: "pCloud", size: { images: 0 } }]);
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listPhotos: one getfilelink per image, in turn, pid the fileid; one without a link is left out; a listing failure is no photos", async () => {
	const { call, requests } = start([
		["GET", /listfolder/, () => ok({ metadata: { contents: [JPG, FILE, HEIC, PNG] } })],
		["GET", /getfilelink/, (r) => (new URL(r.url).searchParams.get("fileid") === "12" ? apiErr(2009, "File not found.") : ok({ hosts: ["c.example.test"], path: "/p" + new URL(r.url).searchParams.get("fileid") }))],
	]);
	const r = await call("listPhotos", { accountId: "acc", aid: 0 }, PHOTOS);
	assert.deepStrictEqual(r, { returnValue: true, photos: [
		{ pid: 11, src_big: "https://c.example.test/p11", src_small: "https://c.example.test/p11", caption: "IMG_1.JPG", type: "image", fileName: "IMG_1.JPG" },
		{ pid: 13, src_big: "https://c.example.test/p13", src_small: "https://c.example.test/p13", caption: "noext", type: "image", fileName: "noext" },
	] });
	assert.deepStrictEqual(asked(requests), [["listfolder", { folderid: "0" }], ["getfilelink", { fileid: "11" }], ["getfilelink", { fileid: "12" }], ["getfilelink", { fileid: "13" }]]);
	await call("listPhotos", { accountId: "acc" }, PHOTOS);
	await call("listPhotos", { accountId: "acc", aid: "321" }, PHOTOS);
	assert.deepStrictEqual(asked(requests).filter((a) => a[0] === "listfolder").map((a) => a[1].folderid), ["0", "0", "321"]);
	assert.deepStrictEqual(await start(() => ({ status: 500, body: "" })).call("listPhotos", { accountId: "acc" }, PHOTOS), { returnValue: true, photos: [] });
});

test("upload (Photos): into the album's folder (the root for aid 0 or none); pid is the new fileid", async () => {
	const { call, requests } = start([["POST", /uploadfile/, () => ok({ fileids: [90], metadata: [{ fileid: 90, name: "tmp-123.bin", size: 2000 }] })]]);
	assert.deepStrictEqual(await call("upload", { accountId: "acc", albumId: 0, path: LOCAL }, PHOTOS), { returnValue: true, pid: "90", name: "tmp-123.bin", size: 2000 });
	await call("upload", { accountId: "acc", path: LOCAL, name: "p.jpg" }, PHOTOS);
	await call("upload", { accountId: "acc", albumId: "321", path: LOCAL }, PHOTOS);
	assert.deepStrictEqual(asked(requests).map((a) => [a[1].folderid, a[1].filename]), [["0", "tmp-123.bin"], ["0", "p.jpg"], ["321", "tmp-123.bin"]]);
	assert.strictEqual(requests[1].body.form[0][1].name, "p.jpg");
});

test("deletePhoto: deletefile with the fileid; a nonzero result is the error", async () => {
	const { call, requests } = start([["GET", /deletefile\?.*fileid=11/, () => ok({ metadata: JPG })], ["GET", /deletefile/, () => apiErr(2009, "File not found.")]]);
	assert.deepStrictEqual(await call("deletePhoto", { accountId: "acc", pid: 11 }, PHOTOS), { returnValue: true, pid: "11" });
	assert.deepStrictEqual(asked(requests), [["deletefile", { fileid: "11" }]]);
	assert.strictEqual((await call("deletePhoto", { accountId: "acc", pid: "12" }, PHOTOS)).errorCode, "PCLOUD_API_ERROR");
});

test("the token is never in an error reply", async () => {
	const replies = [];
	for (const fail of [() => ({ status: 500, body: "boom" }), () => { throw new Error("refused"); }, () => apiErr(2000, "Log in failed."), () => ({ status: 200, body: "<html>" })]) {
		const { call } = start(fail);
		for (const [m, args] of [["listFolder", {}], ["downloadFile", { fileId: 7, localPath: dl() }], ["uploadFile", { localPath: LOCAL }], ["deleteItem", { fileId: 7 }]]) {
			replies.push(await call(m, Object.assign({ accountId: "acc" }, args)));
		}
	}
	assert.ok(replies.every((r) => r.returnValue === false));
	assert.ok(!JSON.stringify(replies).includes(TOKEN), JSON.stringify(replies));
});

// --- every request failing, in turn ----------------------------------------------------------

// What pCloud answers when nothing fails. Id 5 is a file and not a folder; every other id a folder.
function happy(r) {
	const u = new URL(r.url), m = u.pathname.slice(1), p = u.searchParams;
	if (u.host === "c.example.test") { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (m === "oauth2_token") { return ok({ access_token: "AT", userid: 1 }); }
	if (m === "userinfo") { return ok({ email: "u@example.test" }); }
	if (m === "getfilelink") { return ok({ hosts: ["c.example.test"], path: "/p" }); }
	if (m === "checksumfile") { return ok({ metadata: { name: "a.jpg", parentfolderid: 0, fileid: 5 } }); }
	if (m === "listfolder" && p.get("nofiles")) {
		return p.get("folderid") === "5" ? notFolder : ok({ metadata: { folderid: Number(p.get("folderid")), isfolder: true, name: "d" } });
	}
	if (m === "listfolder") { return ok({ metadata: { contents: [JPG] } }); }
	if (m === "uploadfile") { return ok({ fileids: [9], metadata: [{ fileid: 9, name: "n", size: 1 }] }); }
	return ok({ metadata: { fileid: 5, name: "a.jpg" } });
}

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": () => ({ status: 200, body: "<html>" }),
	"a nonzero result": () => apiErr(2000, "Log in failed."),
};

// [method, payload, caller, { minSteps, tolerated(k, mode) }]
const OPS = [
	["listFolder", { accountId: "acc", folderId: 0 }, DOCS],
	["downloadFile", () => ({ accountId: "acc", fileId: "5", localPath: dl() }), DOCS, { minSteps: 2, tolerated: (k, mode) => k === 2 && /JSON|result/.test(mode) }],
	["uploadFile", { accountId: "acc", folderId: 0, localPath: LOCAL }, DOCS],
	["uploadFile (replace)", { accountId: "acc", fileId: "5", localPath: LOCAL, replace: true }, DOCS, { minSteps: 2 }],
	["createFolder", { accountId: "acc", folderId: "0", name: "n" }, DOCS],
	["moveItem (a file)", { accountId: "acc", fileId: "f5", toFolderId: "d0" }, DOCS, { minSteps: 3 }],
	["moveItem (a folder)", { accountId: "acc", fileId: "d7", toFolderId: "d0", name: "n" }, DOCS, { minSteps: 2 }],
	["deleteItem", { accountId: "acc", fileId: "5" }, DOCS, { minSteps: 3 }],
	["checkCredentials", { credentials: { common: { accessToken: "tok", apiHost: "eapi.pcloud.com" } } }, {}],
	["exchangeCode", { code: "c", locationid: "2" }, {}, { minSteps: 2, tolerated: (k) => k >= 2 }],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS],
	["deletePhoto", { accountId: "acc", pid: "5" }, PHOTOS],
	["listAlbums", { accountId: "acc" }, PHOTOS, { tolerated: () => true }],
	["listPhotos", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`pcloud ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const { call } = start((r) => { n++; return n === k ? fail(r) : happy(r); }, { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
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
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", fileId: "5" })).errorCode, "BUS_BAD_REPLY");
});
