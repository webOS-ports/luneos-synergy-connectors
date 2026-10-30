// node --test tests/unit
// The Immich connector (cloud/immich/service/com.palm.service.immich) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (endpoint, headers, body), its reply, and its errors; the Accounts service is
// answered by the stand-in bus.
//
// The reply shapes are Immich's as a 3.3.5 server gave them: /server/version
// { major, minor, patch }, /users/me, /albums [{ id, albumName, assetCount }], /search/metadata
// { assets:{ items, nextPage, nextCursor } } in both request shapes, errors
// { message, error, statusCode } and a validation failure's { message, errors:[{ message }] }.
//
// The last part fails every request of every method in turn, in each way a request can fail,
// and checks the method still answers exactly once.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/immich/service/com.palm.service.immich");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const login = require(path.join(SVC, "login.js"));
const adapter = require(path.join(SVC, "adapter.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "immich-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "photo.jpg");

const PHOTOS = { service: "com.palm.service.photos" };
const PHOTOS_APP = { appId: "org.webosports.app.photos 1234" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const SERVER = "https://photos.example.test";
const KEY = "key+1/2=";   // characters a URL must encode
const STORED = { server: SERVER, apiKey: KEY, userId: "u-1", email: "jane@example.test", name: "Jane" };

const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const V3_3 = { major: 3, minor: 3, patch: 5 };
const V1 = { major: 1, minor: 132, patch: 3 };

// The service on a stand-in bus. fetch's init is recorded too (redirect). Accounts:
// readCredentials gives `stored`. -> { handle, requests, inits, call(method, payload, caller) }
function start(routes, { stored = STORED, timeouts } = {}) {
	const f = fakeFetch(routes);
	const inits = [];
	const fetch = (url, init = {}) => { inits.push(init); return f.fetch(url, init); };
	const pb = fakePalmbus({ onCall: (uri) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: Object.assign({}, stored) } : { returnValue: true }; }
		return { returnValue: false, errorCode: -1, errorText: "Unknown service" };
	} });
	const s = service.start({ palmbus: pb, fetch, idleMs: 0, exit: () => {}, log: { log() {}, error() {} }, timeouts });
	const handle = pb.handles[0];
	return { s, handle, requests: f.requests, inits, call: (method, payload, caller = {}) => ask(handle, method, payload, caller) };
}

const pathOf = (q) => { const u = new URL(q.url); return u.origin + u.pathname; };
const bodyOf = (q) => JSON.parse(q.body);
const asset = (n, extra) => Object.assign({ id: uuid(n), type: "IMAGE", originalMimeType: "image/jpeg", originalFileName: "IMG_" + n + ".JPG",
	isTrashed: false, visibility: "timeline", fileCreatedAt: "2025-04-30T00:13:05.000Z", checksum: "x" }, extra);
const page = (items, { nextPage = null, nextCursor = null } = {}) => ({ status: 200, body: { assets: { total: items.length, count: items.length,
	items, facets: [], nextPage, nextCursor } } });

// --- the service --------------------------------------------------------------------------------

test("the service: its bus name and methods", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.immich");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "downloadFile", "info", "listAlbums",
		"listPhotos", "login", "quit"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
});

test("the server address: a scheme added, slashes and /api dropped, anything but http(s) refused", () => {
	const n = login.normalizeServer;
	assert.strictEqual(n("photos.example.org"), "https://photos.example.org");
	assert.strictEqual(n(" https://photos.example.org/ "), "https://photos.example.org");
	assert.strictEqual(n("http://192.168.1.5:2283/api/"), "http://192.168.1.5:2283");
	assert.strictEqual(n("https://example.org/immich/api"), "https://example.org/immich");
	assert.strictEqual(n("https://example.org/immich?x=1#y"), "https://example.org/immich");
	assert.strictEqual(n("HTTPS://Example.ORG"), "https://example.org");
	for (const bad of ["", "   ", "ftp://example.org", "https://user:pw@example.org", "javascript:alert(1)", "https://", null]) {
		assert.strictEqual(n(bad), null, String(bad));
	}
	assert.strictEqual(login.redirectedServer("http://a.test", "https://a.test/api/server/version", Config), "https://a.test");
	assert.strictEqual(login.redirectedServer("http://a.test", "/sub/api/server/version", Config), "http://a.test/sub");
	assert.strictEqual(login.redirectedServer("http://a.test", "https://a.test/login", Config), null);
});

// --- login ----------------------------------------------------------------------------------------

test("login: the version without the key and no redirect followed, then /users/me with it; the email is the user", async () => {
	const { call, requests, inits } = start([
		["GET", /\/api\/server\/version$/, () => ({ status: 200, body: V3_3 })],
		["GET", /\/api\/users\/me$/, () => ({ status: 200, body: { id: "u-1", email: "jane@example.test", name: "Jane" } })]]);
	const r = await call("login", { server: "photos.example.test/", apiKey: " " + KEY + " " }, { appId: "com.palm.app.accounts 12" });
	assert.deepStrictEqual(r, { returnValue: true, username: "jane@example.test", alias: "Jane",
		credentials: { common: { server: SERVER, apiKey: KEY, userId: "u-1", email: "jane@example.test", name: "Jane" } } });
	assert.deepStrictEqual(requests.map((q) => [q.method, pathOf(q)]), [["GET", SERVER + "/api/server/version"], ["GET", SERVER + "/api/users/me"]]);
	assert.strictEqual(requests[0].headers["x-api-key"], undefined, "the version is asked without the key");
	assert.strictEqual(requests[1].headers["x-api-key"], KEY);
	assert.strictEqual(requests[1].headers.Accept, "application/json");
	assert.deepStrictEqual(inits.map((i) => i.redirect), ["manual", "manual"]);
});

test("login: a redirect of the version is followed once, before the key is sent; anything else that redirects is refused", async () => {
	const hits = start([
		["GET", /^http:\/\/photos\.example\.test\/api\/server\/version$/, () => ({ status: 301, headers: { Location: "https://photos.example.test/api/server/version" } })],
		["GET", /^https:\/\/photos\.example\.test\/api\/server\/version$/, () => ({ status: 200, body: V3_3 })],
		["GET", /users\/me$/, () => ({ status: 200, body: { email: "e@x" } })]]);
	const r = await hits.call("login", { server: "http://photos.example.test", apiKey: KEY });
	assert.strictEqual(r.credentials.common.server, SERVER);
	assert.deepStrictEqual(hits.requests.map((q) => q.url), ["http://photos.example.test/api/server/version", SERVER + "/api/server/version", SERVER + "/api/users/me"]);
	assert.ok(hits.requests.slice(0, 2).every((q) => q.headers["x-api-key"] === undefined));
	const loop = start([["GET", /version$/, (q) => ({ status: 302, headers: { Location: q.url.replace("https://", "https://x.") } })]]);
	const again = await loop.call("login", { server: SERVER, apiKey: KEY });
	assert.strictEqual(again.errorCode, "IMMICH_NOT_FOUND");
	assert.match(again.errorText, /redirects again/);
	assert.strictEqual(loop.requests.length, 2);
	const away = start([["GET", /version$/, () => ({ status: 302, headers: { Location: "https://sso.example.test/login" } })]]);
	assert.strictEqual((await away.call("login", { server: SERVER, apiKey: KEY })).errorCode, "IMMICH_NOT_FOUND");
	assert.strictEqual(away.requests.length, 1);
});

test("login: no server there, not Immich, the key refused or short of permissions: each its own error, none with the key", async () => {
	const at = (version, me) => start([["GET", /version$/, version], ["GET", /users\/me$/, me || (() => ({ status: 200, body: {} }))]]);
	const cases = [
		[at(() => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); }), "IMMICH_UNREACHABLE"],
		[at(() => ({ status: 404, body: "<html>Not Found</html>" })), "IMMICH_UNREACHABLE"],
		[at(() => ({ status: 200, body: "<html>a web page</html>" })), "IMMICH_NOT_FOUND"],
		[at(() => ({ status: 200, body: { version: "3" } })), "IMMICH_NOT_FOUND"],
		[at(() => ({ status: 200, body: V3_3 }), () => ({ status: 401, body: { message: "Invalid API key", error: "Unauthorized", statusCode: 401 } })), "IMMICH_AUTH_FAILED"],
		[at(() => ({ status: 200, body: V3_3 }), () => ({ status: 403, body: { message: "Missing required permission: user.read" } })), "IMMICH_KEY_SCOPE"],
		[at(() => ({ status: 200, body: V3_3 }), () => ({ status: 500, body: { message: "boom" } })), "IMMICH_HTTP_ERROR"],
	];
	for (const [s, code] of cases) {
		const r = await s.call("login", { server: SERVER, apiKey: KEY });
		assert.strictEqual(r.errorCode, code, JSON.stringify(r));
		assert.ok(r.errorText);
		assert.ok(!JSON.stringify(r).includes(KEY) && !JSON.stringify(r).includes(encodeURIComponent(KEY)), "no key in " + code);
	}
	const { call, requests } = start([]);
	for (const a of [{}, { server: SERVER }, { apiKey: KEY }, { server: SERVER, apiKey: "  " }]) {
		assert.strictEqual((await call("login", a)).errorCode, "MISSING_CREDENTIALS", JSON.stringify(a));
	}
	assert.strictEqual((await call("login", { server: "ftp://x", apiKey: KEY })).errorCode, "BAD_SERVER");
	assert.strictEqual(requests.length, 0);
	const noName = start([["GET", /version$/, () => ({ status: 200, body: V3_3 })], ["GET", /users\/me$/, () => ({ status: 200, body: {} })]]);
	const r = await noName.call("login", { server: SERVER, apiKey: KEY });
	assert.strictEqual(r.username, "photos.example.test");
	assert.strictEqual(r.alias, undefined);
});

// --- checkCredentials, errors ---------------------------------------------------------------------

test("checkCredentials: /users/me with the stored key; the email, else the stored one; no key is 401_UNAUTHORIZED", async () => {
	let me = { email: "new@example.test" };
	const { call, requests } = start([["GET", /users\/me$/, () => ({ status: 200, body: me })]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: STORED } }, ACCOUNTS), { returnValue: true, username: "new@example.test" });
	assert.strictEqual(requests[0].headers["x-api-key"], KEY);
	me = {};
	assert.strictEqual((await call("checkCredentials", { credentials: { common: STORED } })).username, "jane@example.test");
	for (const a of [{}, { credentials: {} }, { credentials: { common: { apiKey: KEY } } }, { credentials: { common: { server: SERVER } } }]) {
		assert.strictEqual((await call("checkCredentials", a)).errorCode, "401_UNAUTHORIZED", JSON.stringify(a));
	}
	assert.strictEqual(requests.length, 2);
});

test("errors: Immich's message (a list, a validation's errors); a keyed request is never redirected", async () => {
	const creds = { credentials: { common: STORED } };
	const one = async (reply) => start([["GET", /users\/me$/, () => reply]]).call("checkCredentials", creds);
	assert.strictEqual((await one({ status: 400, body: { message: ["a", "b"], statusCode: 400 } })).errorText, "Immich answered HTTP 400: a; b");
	assert.strictEqual((await one({ status: 400, body: { message: "Validation failed", errors: [{ message: "page cannot be combined" }] } })).errorText,
		"Immich answered HTTP 400: Validation failed: page cannot be combined");
	assert.strictEqual((await one({ status: 502, body: "<html>bad gateway</html>" })).errorText, "Immich answered HTTP 502");
	assert.strictEqual((await one({ status: 200, body: "<html>" })).errorCode, "IMMICH_BAD_JSON");
	const moved = await one({ status: 302, headers: { Location: "https://elsewhere.test/api/users/me" } });
	assert.strictEqual(moved.errorCode, "IMMICH_HTTP_ERROR");
	assert.strictEqual(moved.status, 302);
	assert.match(moved.errorText, /redirect/);
	assert.strictEqual(adapter.messageOf("not json"), "");
});

// --- downloadFile ---------------------------------------------------------------------------------

test("downloadFile: only the Photos app; the URL fetched as is (the key in it); the bytes to localPath", async () => {
	const BYTES = crypto.randomBytes(70000);
	const URL_ = SERVER + "/api/assets/" + uuid(1) + "/original?apiKey=" + encodeURIComponent(KEY);
	const { call, requests } = start([["GET", /\/original\?/, () => new Response(BYTES, { status: 200 })]]);
	for (const who of [{}, PHOTOS, ACCOUNTS, { appId: "org.webosports.app.photosX" }]) {
		assert.strictEqual((await call("downloadFile", { url: URL_, localPath: dl() }, who)).errorCode, "PERMISSION_DENIED", JSON.stringify(who));
	}
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { url: URL_, localPath: dest }, PHOTOS_APP), { returnValue: true, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.deepStrictEqual(requests.map((q) => [q.method, q.url, q.headers]), [["GET", URL_, {}]]);
	for (const url of ["file:///etc/shadow", "not a url"]) {
		assert.strictEqual((await call("downloadFile", { url, localPath: dl() }, PHOTOS_APP)).errorCode, "BAD_ARGS", url);
	}
});

// --- photos ---------------------------------------------------------------------------------------

test("listAlbums: /albums with the key; each album once, its name and count; ids that are not Immich's left out", async () => {
	const { call, requests, handle } = start([["GET", /\/api\/albums$/, () => ({ status: 200, body: [
		{ id: uuid(1), albumName: "Holiday", assetCount: 500 }, { id: uuid(2), albumName: "", assetCount: "3" },
		{ id: uuid(1), albumName: "Holiday (shared)", assetCount: 500 }, { id: "../x", albumName: "bad" }, null, { albumName: "no id" }] })]]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc-1" }, PHOTOS), { returnValue: true, albums: [
		{ aid: uuid(1), name: "Holiday", size: { images: 500 } }, { aid: uuid(2), name: uuid(2), size: { images: 3 } }] });
	assert.deepStrictEqual(handle.calls, [{ uri: "luna://com.palm.service.accounts/readCredentials", args: { accountId: "acc-1", name: "common" } }]);
	assert.deepStrictEqual(requests.map((q) => [q.method, q.url, q.headers["x-api-key"]]), [["GET", SERVER + "/api/albums", KEY]]);
});

test("listAlbums: albums that cannot be listed are none; credentials are needed", async () => {
	const down = start([["GET", /albums/, () => ({ status: 500, body: {} })]]);
	assert.deepStrictEqual(await down.call("listAlbums", { accountId: "acc" }, PHOTOS), { returnValue: true, albums: [] });
	const odd = start([["GET", /albums/, () => ({ status: 200, body: { not: "a list" } })]]);
	assert.deepStrictEqual((await odd.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums, []);
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await start([], { stored: { apiKey: KEY } }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await start([]).call("listAlbums", {}, PHOTOS)).errorCode, "NO_CREDENTIALS");
});

test("listPhotos (3.2 and later): the filter shape, paged by cursor; originals of web types, previews of the rest; videos, trashed and hidden left out", async () => {
	const first = [asset(1, { exifInfo: { description: "Sunset" } }), asset(2, { originalMimeType: "image/heic", originalFileName: "IMG_2.HEIC" }),
		asset(3, { type: "VIDEO", originalMimeType: "video/mp4" }), asset(4, { isTrashed: true }), asset(5, { visibility: "hidden" })];
	const second = [asset(6, { originalMimeType: "image/png", originalFileName: "shot.png", fileCreatedAt: "nonsense" }),
		asset(7, { originalMimeType: "image/x-adobe-dng", originalFileName: "RAW" }), asset(8, { visibility: "locked" }), { id: "../../x", type: "IMAGE" }];
	const { call, requests } = start([["GET", /server\/version$/, () => ({ status: 200, body: V3_3 })],
		["POST", /search\/metadata$/, (q) => (bodyOf(q).cursor ? page(second) : page(first, { nextCursor: "eyJvZmZzZXQiOjV9" }))]]);
	const r = await call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS);
	const k = "apiKey=" + encodeURIComponent(KEY);
	const orig = (n) => SERVER + "/api/assets/" + uuid(n) + "/original?" + k;
	const prev = (n) => SERVER + "/api/assets/" + uuid(n) + "/thumbnail?size=preview&" + k;
	assert.deepStrictEqual(r, { returnValue: true, photos: [
		{ pid: uuid(1), src_big: orig(1), src_small: prev(1), caption: "Sunset", type: "image", fileName: "IMG_1.JPG", createdTime: 1745972000 - 15 },
		{ pid: uuid(2), src_big: prev(2), src_small: prev(2), caption: "", type: "image", fileName: "IMG_2.jpg", createdTime: 1745971985 },
		{ pid: uuid(6), src_big: orig(6), src_small: prev(6), caption: "", type: "image", fileName: "shot.png" },
		{ pid: uuid(7), src_big: prev(7), src_small: prev(7), caption: "", type: "image", fileName: "RAW.jpg", createdTime: 1745971985 }] });
	assert.deepStrictEqual(requests.map((q) => [q.method, pathOf(q)]), [["GET", SERVER + "/api/server/version"],
		["POST", SERVER + "/api/search/metadata"], ["POST", SERVER + "/api/search/metadata"]]);
	assert.deepStrictEqual(bodyOf(requests[1]), { filter: { albumIds: { any: [uuid(9)] } }, size: adapter.PAGE });
	assert.deepStrictEqual(bodyOf(requests[2]), { filter: { albumIds: { any: [uuid(9)] } }, size: adapter.PAGE, cursor: "eyJvZmZzZXQiOjV9" });
	assert.strictEqual(requests[1].headers["x-api-key"], KEY);
});

test("listPhotos (before 3.2): the flat shape, paged by page number; the version asked once per server", async () => {
	const { call, requests } = start([["GET", /server\/version$/, () => ({ status: 200, body: V1 })],
		["POST", /search\/metadata$/, (q) => (bodyOf(q).page === 1 ? page([asset(1)], { nextPage: "2" }) : page([asset(2)]))]]);
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS)).photos.length, 2);
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS)).photos.length, 2);
	const searches = requests.filter((q) => q.method === "POST");
	assert.deepStrictEqual(searches.slice(0, 2).map(bodyOf), [{ albumIds: [uuid(9)], size: adapter.PAGE, page: 1 }, { albumIds: [uuid(9)], size: adapter.PAGE, page: 2 }]);
	assert.strictEqual(requests.filter((q) => /version$/.test(q.url)).length, 1, "the version is asked once");
});

test("listPhotos: a server whose search takes no album lists the album itself; a version that cannot be read is asked again", async () => {
	let versionUp = false;
	const { call, requests } = start([["GET", /server\/version$/, () => (versionUp ? { status: 200, body: V1 } : { status: 503, body: "" })],
		["POST", /search\/metadata$/, () => ({ status: 400, body: { message: ["property albumIds should not exist"] } })],
		["GET", /\/api\/albums\/[0-9a-f-]+$/, () => ({ status: 200, body: { id: uuid(9), assets: [asset(1), asset(2, { type: "VIDEO" })] } })]]);
	assert.deepStrictEqual((await call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS)).photos.map((p) => p.pid), [uuid(1)]);
	versionUp = true;
	await call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS);
	assert.strictEqual(requests.filter((q) => /version$/.test(q.url)).length, 2);
	// On 3.2 and later a 400 is an error (absorbed as no photos), not a reason to fall back.
	const v3 = start([["GET", /version$/, () => ({ status: 200, body: V3_3 })], ["POST", /search/, () => ({ status: 400, body: {} })]]);
	assert.deepStrictEqual((await v3.call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS)).photos, []);
	assert.ok(!v3.requests.some((q) => /\/albums\//.test(q.url)));
});

test("listPhotos: no aid, an album that cannot be listed: no photos (not an error); no credentials is an error", async () => {
	const { call, requests } = start([["GET", /version$/, () => ({ status: 200, body: V3_3 })], ["POST", /search/, () => ({ status: 404, body: {} })]]);
	for (const aid of [undefined, "", 5]) {
		assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid }, PHOTOS), { returnValue: true, photos: [] }, String(aid));
	}
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS), { returnValue: true, photos: [] });
	assert.strictEqual(requests.filter((q) => q.method === "POST").length, 1);
	assert.strictEqual((await start([], { stored: null }).call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("paging stops at MAX_ITEMS, and on a page with no items even when there is a next one", async () => {
	let pages = 0;
	const many = start([["GET", /version$/, () => ({ status: 200, body: V3_3 })], ["POST", /search/, () => {
		pages++; return page(Array.from({ length: adapter.PAGE }, (_, i) => asset(pages * 1000 + i)), { nextCursor: "c" + pages }); }]]);
	assert.strictEqual((await many.call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS)).photos.length, adapter.MAX_ITEMS);
	assert.strictEqual(pages, adapter.MAX_ITEMS / adapter.PAGE);
	const empty = start([["GET", /version$/, () => ({ status: 200, body: V3_3 })], ["POST", /search/, () => page([], { nextCursor: "again" })]]);
	assert.deepStrictEqual((await empty.call("listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS)).photos, []);
	assert.strictEqual(empty.requests.filter((q) => q.method === "POST").length, 1);
});

// --- every request failing, in turn ----------------------------------------------------------

function happy(q) {
	if (/server\/version$/.test(q.url)) { return { status: 200, body: V3_3 }; }
	if (/users\/me$/.test(q.url)) { return { status: 200, body: { email: "e@x" } }; }
	if (/\/original\?|thumbnail\?/.test(q.url)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (/\/api\/albums$/.test(q.url)) { return { status: 200, body: [{ id: uuid(1), albumName: "a", assetCount: 1 }] }; }
	return page([asset(1)]);
}

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401": () => ({ status: 401, body: { message: "Invalid API key" } }),
	"a redirect": () => ({ status: 302, headers: { Location: "https://elsewhere.test/" } }),
	"a reply that is not JSON": () => ({ status: 200, body: "<html>" }),
};
const BYTES_OK = new Set(["a reply that is not JSON"]);

const OPS = [
	["login", { server: SERVER, apiKey: KEY }, { appId: "com.palm.app.accounts 3" }, { minSteps: 2 }],
	["checkCredentials", { credentials: { common: STORED } }, ACCOUNTS],
	["downloadFile", () => ({ url: SERVER + "/api/assets/" + uuid(1) + "/original?apiKey=k", localPath: dl() }), PHOTOS_APP,
		{ tolerated: (k, mode) => BYTES_OK.has(mode) || mode === "a redirect" }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: uuid(9) }, PHOTOS, { minSteps: 2, tolerated: () => true }],
];

for (const [method, payload, caller, opts = {}] of OPS) {
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`immich ${method}: any request failing (${mode}) is one reply${opts.tolerated ? "" : ", an error"}`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const { call } = start([["GET", /./, (q) => { n++; return n === k ? fail(q) : happy(q); }],
					["POST", /./, (q) => { n++; return n === k ? fail(q) : happy(q); }]], { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
				const r = await call(method, typeof payload === "function" ? payload() : payload, caller);
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
					assert.notStrictEqual(r.errorCode, "CONNECTOR_EXCEPTION", JSON.stringify(r));
				}
				if (method !== "listPhotos" || r.returnValue === false) {
					assert.ok(!JSON.stringify(r).includes(KEY) && !JSON.stringify(r).includes(encodeURIComponent(KEY)), "no key in the reply");
				}
			}
			assert.ok(reached >= (opts.minSteps || 1), `only ${reached} of ${opts.minSteps || 1} steps were failed`);
		});
	}
}

test("a payload that is not a JSON object is BAD_ARGS; an unknown method NOT_SUPPORTED", async () => {
	const { call } = start([]);
	assert.strictEqual((await call("listAlbums", "[]", PHOTOS)).errorCode, "BAD_ARGS");
	assert.strictEqual((await call("getAuthorizeUrl", {}, PHOTOS)).errorCode, "NOT_SUPPORTED");
});
