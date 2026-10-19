// node --test tests/unit
// _cloudcore/node/commands.js against a stand-in adapter, credential store and OAuth: what each
// method hands the adapter, what it replies, who may call it, renewed credentials, NOT_SUPPORTED.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const NODE = path.join(__dirname, "../../cloud/_core/service/_cloudcore/node");
const { createCommands, cloudRoot } = require(path.join(NODE, "commands.js"));
const { CloudError } = require(path.join(NODE, "errors.js"));

const FILE_APP_IDS = ["org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service"];

function setup(adapter, { config = {}, stored = { accessToken: "tok", refreshToken: "rt" }, oauth } = {}) {
	const saved = [], resolved = [];
	const store = {
		resolve: async (args) => {
			resolved.push(args);
			if (args.credentials && args.credentials.common && args.credentials.common.accessToken) { return args.credentials.common; }
			if (!args.accountId) { throw new CloudError("NO_CREDENTIALS", "pass credentials or accountId"); }
			return Object.assign({}, stored);
		},
		save: async (id, c) => { saved.push([id, c]); return true; },
	};
	const o = oauth === undefined ? {
		authorizeUrl: (state) => ({ url: "https://auth/?state=" + state, codeVerifier: "V" }),
		exchangeCode: async (code, v) => ({ accessToken: "AT:" + code + ":" + v, refreshToken: "RT", expiresIn: 60 }),
		refresh: async () => ({ accessToken: "fresh", expiresIn: 60 }),
	} : oauth;
	const methods = createCommands({ config: Object.assign({ FILE_APP_IDS, ROOT_FOLDER: "root", DISPLAY_NAME: "Test", STATE: "test" }, config),
		adapter, store, oauth: o });
	const run = (m, p) => methods[m].handler(p || {}, { caller: "x" });
	return { methods, run, saved, resolved };
}
const plain = (o) => JSON.parse(JSON.stringify(o));
const code = (p) => p.then(() => null, (e) => e.errorCode);

test("caller rules: the file methods take FILE_APP_IDS, the others are open", () => {
	const { methods } = setup({});
	const gated = Object.keys(methods).filter((m) => methods[m].allow && methods[m].allow.length).sort();
	assert.deepStrictEqual(gated, ["createFolder", "deleteItem", "downloadFile", "listFolder", "moveItem", "uploadFile"]);
	for (const m of gated) { assert.deepStrictEqual(methods[m].allow, FILE_APP_IDS, m); }
	assert.deepStrictEqual(Object.keys(methods).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto", "downloadFile",
		"exchangeCode", "getAuthorizeUrl", "listFolder", "moveItem", "upload", "uploadFile"]);
	for (const m of Object.keys(methods)) { assert.ok(methods[m].timeoutMs >= 30000, m); }
});

test("getAuthorizeUrl: the state given, else Config.STATE", async () => {
	const { run } = setup({});
	assert.deepStrictEqual(await run("getAuthorizeUrl", {}), { url: "https://auth/?state=test", codeVerifier: "V" });
	assert.strictEqual((await run("getAuthorizeUrl", { state: "s" })).url, "https://auth/?state=s");
	assert.strictEqual(await code(setup({}, { oauth: null }).run("getAuthorizeUrl", {})), "NOT_SUPPORTED");
});

test("exchangeCode: the credentials and username; an identity that fails gives the fallback name", async () => {
	const { run } = setup({ getAccountInfo: async (s) => ({ user: { emailAddress: "u@x.test", displayName: "U " + s.accessToken } }) });
	const t0 = Date.now();
	const r = await run("exchangeCode", { code: "C", codeVerifier: "CV" });
	assert.strictEqual(r.username, "u@x.test");
	assert.strictEqual(r.alias, "U AT:C:CV");
	assert.deepStrictEqual(Object.keys(r.credentials.common), ["accessToken", "refreshToken", "expiresAt"]);
	assert.strictEqual(r.credentials.common.accessToken, "AT:C:CV");
	assert.ok(r.credentials.common.expiresAt >= t0 + 60000);
	assert.strictEqual(await code(run("exchangeCode", {})), "MISSING_CODE");
	const failing = setup({ getAccountInfo: async () => { throw new CloudError("X_API_ERROR", "no"); } });
	assert.deepStrictEqual(plain(await failing.run("exchangeCode", { code: "C" })).username, "Test");
	const noName = setup({ getAccountInfo: async () => ({}) }, { config: { DISPLAY_NAME: undefined } });
	assert.strictEqual((await noName.run("exchangeCode", { code: "C" })).username, "Cloud account");
});

test("exchangeCode: the token exchange failing is the error", async () => {
	const { run } = setup({}, { oauth: { exchangeCode: async () => { throw new CloudError("OAUTH_TOKEN_FAILED", "400"); } } });
	assert.strictEqual(await code(run("exchangeCode", { code: "C" })), "OAUTH_TOKEN_FAILED");
});

test("checkCredentials: inline only; 401_UNAUTHORIZED without a token; a renewed token reported, not saved", async () => {
	const { run, saved } = setup({ getAccountInfo: (s) => s.authorized(async (tok) => {
		if (tok === "stale") { const e = new CloudError("X", "401"); e.status = 401; throw e; }
		return { user: { emailAddress: "u@x.test", displayName: "U" } };
	}) });
	assert.strictEqual(await code(run("checkCredentials", { accountId: "a" })), "401_UNAUTHORIZED");
	assert.deepStrictEqual(await run("checkCredentials", { credentials: { common: { accessToken: "ok" } } }),
		{ renewedCredentials: null, username: "u@x.test", displayName: "U" });
	const r = await run("checkCredentials", { accountId: "a", credentials: { common: { accessToken: "stale", refreshToken: "rt" } } });
	assert.strictEqual(r.renewedCredentials.accessToken, "fresh");
	assert.deepStrictEqual(saved, []);
});

test("listFolder: folderId, else path, else the root; renewed credentials saved and reported", async () => {
	const calls = [];
	const { run, saved } = setup({ listFolder: (s, id) => s.authorized(async (tok) => {
		calls.push([tok, id]);
		if (tok === "tok") { const e = new CloudError("X", "401"); e.status = 401; throw e; }
		return { entries: [{ id: "1" }] };
	}) });
	const r = await run("listFolder", { accountId: "acc", path: "/Docs" });
	assert.deepStrictEqual(calls, [["tok", "/Docs"], ["fresh", "/Docs"]]);
	assert.deepStrictEqual(r.entries, [{ id: "1" }]);
	assert.strictEqual(r.renewedCredentials.accessToken, "fresh");
	assert.deepStrictEqual(saved.map(([id, c]) => [id, c.accessToken, c.refreshToken]), [["acc", "fresh", "rt"]]);
	await run("listFolder", { accountId: "acc", folderId: "F", path: "/ignored" });
	await run("listFolder", { accountId: "acc" });
	assert.deepStrictEqual(calls.filter((c) => c[0] === "fresh").map((c) => c[1]), ["/Docs", "F", "root"]);
});

test("inline credentials renewed are reported but not saved (no accountId)", async () => {
	const { run, saved } = setup({ listFolder: (s) => s.authorized(async (tok) => {
		if (tok === "old") { const e = new CloudError("X", "401"); e.status = 401; throw e; }
		return {};
	}) });
	const r = await run("listFolder", { credentials: { common: { accessToken: "old", refreshToken: "r" } } });
	assert.deepStrictEqual(r.entries, []);
	assert.strictEqual(r.renewedCredentials.accessToken, "fresh");
	assert.deepStrictEqual(saved, []);
});

test("downloadFile: fileId | path | dropboxPath, localPath, exportMime", async () => {
	const calls = [];
	const { run } = setup({ downloadFile: async (s, id, local, mime) => { calls.push([id, local, mime]); return { path: local }; } });
	assert.deepStrictEqual(await run("downloadFile", { accountId: "a", fileId: "F", localPath: "/l/f" }), { renewedCredentials: null, path: "/l/f" });
	await run("downloadFile", { accountId: "a", path: "/p", localPath: "/l/p", exportMime: "application/pdf" });
	await run("downloadFile", { accountId: "a", dropboxPath: "/d", localPath: "/l/d" });
	assert.deepStrictEqual(calls, [["F", "/l/f", null], ["/p", "/l/p", "application/pdf"], ["/d", "/l/d", null]]);
	assert.strictEqual(await code(run("downloadFile", { accountId: "a", fileId: "F" })), "MISSING_ARGS");
	assert.strictEqual(await code(run("downloadFile", { accountId: "a", localPath: "/x" })), "MISSING_ARGS");
	assert.strictEqual(calls.length, 3);
});

test("uploadFile: a new file into folderId|path|root named name|basename; replace:true overwrites by id", async () => {
	const calls = [];
	const { run } = setup({
		uploadFile: async (s, folder, local, name, mime) => { calls.push(["new", folder, local, name, mime]); return { id: "N", name, size: 3, extra: 1 }; },
		uploadReplace: async (s, id, local, mime) => { calls.push(["replace", id, local, mime]); return { id, name: "r", size: 4 }; },
	});
	assert.deepStrictEqual(plain(await run("uploadFile", { accountId: "a", folderId: "D", localPath: "/l/a.txt", mimeType: "text/plain" })),
		{ renewedCredentials: null, name: "a.txt", id: "N", size: 3 });
	await run("uploadFile", { accountId: "a", path: "/Docs", localPath: "/l/a.txt", name: "b.txt" });
	await run("uploadFile", { accountId: "a", localPath: "/l/c.txt" });
	await run("uploadFile", { accountId: "a", fileId: "F", localPath: "/l/a.txt", replace: true });
	await run("uploadFile", { accountId: "a", dropboxPath: "/x.txt", localPath: "/l/a.txt", replace: true });
	await run("uploadFile", { accountId: "a", localPath: "/l/a.txt", replace: true });   // nothing to replace: a new file
	assert.deepStrictEqual(calls, [["new", "D", "/l/a.txt", "a.txt", "text/plain"], ["new", "/Docs", "/l/a.txt", "b.txt", undefined],
		["new", "root", "/l/c.txt", "c.txt", undefined], ["replace", "F", "/l/a.txt", undefined], ["replace", "/x.txt", "/l/a.txt", undefined],
		["new", "root", "/l/a.txt", "a.txt", undefined]]);
	assert.strictEqual(await code(run("uploadFile", { accountId: "a" })), "MISSING_ARGS");
});

test("createFolder: parent and name; a name is one path component", async () => {
	const calls = [];
	const { run } = setup({ createFolder: async (s, parent, name) => { calls.push([parent, name]); return { entry: { id: "9", name } }; } });
	assert.deepStrictEqual(await run("createFolder", { accountId: "a", path: "/Docs", name: "New" }), { renewedCredentials: null, entry: { id: "9", name: "New" } });
	await run("createFolder", { accountId: "a", folderId: "P", name: "Top" });
	await run("createFolder", { accountId: "a", name: "Top" });
	assert.deepStrictEqual(calls, [["/Docs", "New"], ["P", "Top"], ["root", "Top"]]);
	for (const name of [undefined, "", ".", "..", "a/b", "a\u0000b", 5]) {
		assert.strictEqual(await code(run("createFolder", { accountId: "a", name })), "MISSING_ARGS", String(name));
	}
	assert.strictEqual(calls.length, 3);
});

test("moveItem: rename, move, or both; one of them is required", async () => {
	const calls = [];
	const { run } = setup({ moveItem: async (s, item, to, name) => { calls.push([item, to, name]); return { entry: { id: item } }; } });
	await run("moveItem", { accountId: "a", path: "/a.txt", name: "b.txt" });
	await run("moveItem", { accountId: "a", fileId: "id1", toFolderId: "id2" });
	await run("moveItem", { accountId: "a", path: "/a.txt", toPath: "/Dir", name: "c.txt" });
	await run("moveItem", { accountId: "a", fileId: "id3", toRoot: true });
	assert.deepStrictEqual(calls, [["/a.txt", null, "b.txt"], ["id1", "id2", null], ["/a.txt", "/Dir", "c.txt"], ["id3", "root", null]]);
	for (const p of [{ path: "/a.txt" }, { name: "x" }, { path: "/a", name: "x/y" }, { path: "/a", toRoot: "yes" }]) {
		assert.strictEqual(await code(run("moveItem", Object.assign({ accountId: "a" }, p))), "MISSING_ARGS", JSON.stringify(p));
	}
	assert.strictEqual(calls.length, 4);
});

test("deleteItem: the item reaches the adapter, the root never does", async () => {
	const calls = [];
	const { run } = setup({ deleteItem: async (s, item) => { calls.push(item); return {}; } }, { config: { ROOT_FOLDER: "0" } });
	assert.deepStrictEqual(await run("deleteItem", { accountId: "a", fileId: "42" }), { renewedCredentials: null });
	for (const item of ["0", "/", "root"]) { assert.strictEqual(await code(run("deleteItem", { accountId: "a", path: item })), "BAD_ARGS", item); }
	assert.strictEqual(await code(run("deleteItem", { accountId: "a" })), "MISSING_ARGS");
	assert.deepStrictEqual(calls, ["42"]);
});

test("a root of 0 (pCloud) is the root, not \"root\"", async () => {
	const calls = [];
	const { run } = setup({
		createFolder: async (s, parent) => { calls.push(["create", parent]); return { entry: {} }; },
		moveItem: async (s, item, to) => { calls.push(["move", to]); return { entry: {} }; },
		deleteItem: async (s, item) => { calls.push(["delete", item]); return {}; },
	}, { config: { ROOT_FOLDER: 0 } });
	await run("createFolder", { accountId: "a", name: "x" });
	await run("moveItem", { accountId: "a", fileId: "5", toRoot: true });
	assert.strictEqual(await code(run("deleteItem", { accountId: "a", fileId: 0 })), "MISSING_ARGS");   // 0 is no item
	assert.strictEqual(await code(run("deleteItem", { accountId: "a", path: "0" })), "BAD_ARGS");
	assert.deepStrictEqual(calls, [["create", 0], ["move", 0]]);
	assert.strictEqual(cloudRoot({ ROOT_FOLDER: "" }), "root");
	assert.strictEqual(cloudRoot({}), "root");
});

test("an adapter without the method answers NOT_SUPPORTED, before anything else", async () => {
	const { run, resolved } = setup({});
	for (const [m, p] of [["listFolder", {}], ["downloadFile", { fileId: "f", localPath: "/l" }], ["uploadFile", { localPath: "/l" }],
		["uploadFile", { localPath: "/l", fileId: "f", replace: true }], ["createFolder", { name: "x" }], ["moveItem", { path: "/a", name: "b" }],
		["deleteItem", { path: "/a" }], ["upload", { path: "/l" }], ["deletePhoto", { pid: "p" }], ["checkCredentials", { credentials: { common: { accessToken: "t" } } }]]) {
		assert.strictEqual(await code(run(m, Object.assign({ accountId: "a" }, p))), "NOT_SUPPORTED", m);
	}
	assert.strictEqual(resolved.length, 0);
});

test("an adapter failure is the method's failure; credentials failing come first", async () => {
	let reached = 0;
	const { run } = setup({ deleteItem: async () => { reached++; throw new CloudError("BOX_API_ERROR", "x"); } });
	assert.strictEqual(await code(run("deleteItem", { accountId: "a", path: "/a" })), "BOX_API_ERROR");
	assert.strictEqual(await code(run("deleteItem", { path: "/a" })), "NO_CREDENTIALS");
	assert.strictEqual(reached, 1);
});

test("upload (Photos): albumId|folderId, else ensureAlbumFolder(PHOTO_ALBUM_NAME), else null; pid is the new id", async () => {
	const calls = [];
	const adapter = { uploadFile: async (s, folder, local, name, mime) => { calls.push([folder, local, name, mime]); return { id: 77, name, size: 5 }; } };
	const { run } = setup(adapter);
	assert.deepStrictEqual(await run("upload", { accountId: "a", albumId: "AL", path: "/m/p.jpg" }), { pid: "77", name: "p.jpg", size: 5 });
	await run("upload", { accountId: "a", folderId: "F", localPath: "/m/q.jpg", name: "r.jpg", mimeType: "image/jpeg" });
	await run("upload", { accountId: "a", path: "/m/s.jpg" });
	adapter.ensureAlbumFolder = async (s, name) => "ensured:" + name;
	await run("upload", { accountId: "a", path: "/m/t.jpg" });
	assert.deepStrictEqual(calls, [["AL", "/m/p.jpg", "p.jpg", undefined], ["F", "/m/q.jpg", "r.jpg", "image/jpeg"],
		[null, "/m/s.jpg", "s.jpg", undefined], ["ensured:Pictures", "/m/t.jpg", "t.jpg", undefined]]);
	assert.strictEqual(await code(run("upload", { accountId: "a" })), "MISSING_ARGS");
});

test("deletePhoto: pid | photoId | fileId", async () => {
	const calls = [];
	const { run } = setup({ deletePhoto: async (s, pid) => { calls.push(pid); return { deleted: true }; } });
	assert.deepStrictEqual(await run("deletePhoto", { accountId: "a", pid: "id:1" }), { pid: "id:1" });
	await run("deletePhoto", { accountId: "a", photoId: 5 });
	await run("deletePhoto", { accountId: "a", fileId: "f" });
	assert.deepStrictEqual(calls, ["id:1", 5, "f"]);
	assert.strictEqual(await code(run("deletePhoto", { accountId: "a" })), "MISSING_ARGS");
});
