// node --test tests/unit
// The PhotoPrism connector (cloud/photoprism/service/com.palm.service.photoprism) as the launcher
// runs it: service.js started on a stand-in palmbus, with a stand-in fetch that records every
// request. Each method is called over the bus as its real caller would call it, and checked for
// the requests it makes (endpoint, headers, body), its reply, and its errors; the Accounts service
// is answered by the stand-in bus.
//
// The reply shapes are PhotoPrism's as a 261029 server gave them: /status { status }, /session
// { access_token, user:{ UID, Name, DisplayName } }, /oauth/token { access_token }, /config
// { downloadToken, previewToken }, /albums [{ UID, Title, PhotoCount, DeletedAt }], /photos
// [{ UID, Type, Hash, TakenAt, Files:[{ Hash, Name, Mime, Primary }] }], errors { code, error,
// message } - "not deleted" as Go's zero time.
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

const SVC = path.join(__dirname, "../../cloud/photoprism/service/com.palm.service.photoprism");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const login = require(path.join(SVC, "login.js"));
const adapter = require(path.join(SVC, "adapter.js"));
const photos = require(path.join(SVC, "photos.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "photoprism-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "photo.jpg");

const PHOTOS = { service: "com.palm.service.photos" };
const PHOTOS_APP = { appId: "org.webosports.app.photos 1234" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const SERVER = "https://photos.example.test";
const API = SERVER + "/api/v1";
const PASSWORD = "pass word+&=1";
const SESS = "sess0123456789abcdef";
const TOKEN = "Tk3nAa-Bb1Cc2-Dd3Ee4-Ff5Gg6";   // an app password: login keeps it
const APP_PW = "Us3rAp-pPassw-0rdXyz-9Q8w7e";  // one the user made
const DL = "dltok+/=";                          // characters a URL must encode
const PV = "pvtok+/=";
const USER = { UID: "usr0abc123def456", Name: "jane", DisplayName: "Jane Doe" };
const STORED = { server: SERVER, token: TOKEN, userId: USER.UID, username: "jane", name: "Jane Doe" };
const ZERO = "0001-01-01T00:00:00Z";

const uid = (c, n) => c + String(n).padStart(15, "0");      // "a000000000000001": PhotoPrism's 16-char uids
const hash = (n) => crypto.createHash("sha1").update(String(n)).digest("hex");

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
const photo = (n, extra, file) => Object.assign({ UID: uid("p", n), Type: "image", Hash: hash(n), TakenAt: "2026-07-01T10:00:0" + (n % 10) + "Z",
	OriginalName: "IMG_" + n + ".JPG", Caption: "", Files: [Object.assign({ Hash: hash(n), Name: "2026/07/IMG_" + n + ".jpg", Mime: "image/jpeg", Primary: true }, file)] }, extra);
const album = (n, extra) => Object.assign({ UID: uid("a", n), Title: "Album " + n, PhotoCount: n, DeletedAt: ZERO }, extra);
const leaks = (r, secrets) => secrets.filter((s) => JSON.stringify(r).includes(s) || JSON.stringify(r).includes(encodeURIComponent(s)));

const STATUS = ["GET", /\/api\/v1\/status$/, () => ({ status: 200, body: { status: "operational" } })];
const CONFIG = ["GET", /\/api\/v1\/config$/, () => ({ status: 200, body: { downloadToken: DL, previewToken: PV, siteTitle: "PhotoPrism" } })];

// --- the service --------------------------------------------------------------------------------

test("the service: its bus name and methods", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.photoprism");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "downloadFile", "info", "listAlbums",
		"listPhotos", "login", "quit"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
});

test("the server address: a scheme added, slashes, /library and /api cut, anything but http(s) refused", () => {
	const n = login.normalizeServer;
	assert.strictEqual(n("photos.example.org"), "https://photos.example.org");
	assert.strictEqual(n(" https://photos.example.org/ "), "https://photos.example.org");
	assert.strictEqual(n("http://192.168.1.5:2342/api/v1"), "http://192.168.1.5:2342");
	assert.strictEqual(n("https://photos.example.org/library/browse?view=cards"), "https://photos.example.org");
	assert.strictEqual(n("https://example.org/pp/library/albums"), "https://example.org/pp");
	assert.strictEqual(n("https://example.org/pp?x=1#y"), "https://example.org/pp");
	assert.strictEqual(n("HTTPS://Example.ORG"), "https://example.org");
	for (const bad of ["", "   ", "ftp://example.org", "https://user:pw@example.org", "javascript:alert(1)", "https://", null]) {
		assert.strictEqual(n(bad), null, String(bad));
	}
	assert.strictEqual(login.redirectedServer("http://a.test", "https://a.test/api/v1/status", Config), "https://a.test");
	assert.strictEqual(login.redirectedServer("http://a.test", "/sub/api/v1/status", Config), "http://a.test/sub");
	assert.strictEqual(login.redirectedServer("http://a.test", "https://a.test/library/login", Config), null);
	assert.strictEqual(login.redirectedServer("http://a.test", "https://b.test/api/v1/status", Config), null);
	assert.ok(login.APP_PASSWORD.test(TOKEN) && login.APP_PASSWORD.test(APP_PW));
	for (const pw of [PASSWORD, "abcdef-abcdef-abcdef", "abcdef-abcdef-abcdef-abcdef-", "abcdé1-abcdef-abcdef-abcdef"]) { assert.ok(!login.APP_PASSWORD.test(pw), pw); }
});

// --- login ----------------------------------------------------------------------------------------

function signIn(extra = []) {
	return start(extra.concat([STATUS,
		["POST", /\/api\/v1\/session$/, () => ({ status: 200, body: { access_token: SESS, user: USER, config: {} } })],
		["POST", /\/api\/v1\/oauth\/token$/, () => ({ status: 200, body: { access_token: TOKEN, token_type: "Bearer", scope: Config.SCOPE } })],
		["DELETE", /\/api\/v1\/session$/, () => ({ status: 200, body: { status: "ok" } })],
		["GET", /\/api\/v1\/session$/, () => ({ status: 403, body: { error: "Permission denied" } })],
		CONFIG]));
}

test("login with the password: status (nothing secret), a session, an app password made in it, the session closed, the config read with the app password", async () => {
	const { call, requests, inits } = signIn();
	const r = await call("login", { server: "photos.example.test/library/", username: " jane ", password: PASSWORD }, { appId: "com.palm.app.accounts 12" });
	assert.deepStrictEqual(r, { returnValue: true, username: "jane@photos.example.test", alias: "Jane Doe",
		credentials: { common: { server: SERVER, token: TOKEN, userId: USER.UID, username: "jane", name: "Jane Doe" } } });
	assert.deepStrictEqual(requests.map((q) => [q.method, pathOf(q), q.headers.Authorization]), [
		["GET", API + "/status", undefined], ["POST", API + "/session", undefined], ["POST", API + "/oauth/token", "Bearer " + SESS],
		["DELETE", API + "/session", "Bearer " + SESS], ["GET", API + "/config", "Bearer " + TOKEN]]);
	assert.deepStrictEqual(bodyOf(requests[1]), { username: "jane", password: PASSWORD });
	assert.deepStrictEqual(bodyOf(requests[2]), { grant_type: "password", client_name: "LuneOS", scope: "albums config photos", lifetime: 0,
		username: "jane", password: PASSWORD });
	assert.ok(requests.every((q) => !q.url.includes(PASSWORD) && !q.url.includes(encodeURIComponent(PASSWORD))), "the password is in no URL");
	assert.ok([0, 3, 4].every((i) => !JSON.stringify(requests[i].body || "").includes(PASSWORD)), "the password goes only to /session and /oauth/token");
	assert.ok(requests.every((q) => q.headers.Accept === "application/json"));
	assert.ok(inits.every((i) => i.redirect === "manual"));
	assert.deepStrictEqual(leaks(r, [PASSWORD, SESS]), []);
});

test("login with an app password: kept as it is, no session made; the user from /session when the token may read it", async () => {
	const scoped = signIn();
	const r = await scoped.call("login", { server: SERVER, username: "jane", password: APP_PW });
	assert.deepStrictEqual(r.credentials.common, { server: SERVER, token: APP_PW, userId: null, username: "jane", name: "jane" });
	assert.strictEqual(r.username, "jane@photos.example.test");
	assert.deepStrictEqual(scoped.requests.map((q) => [q.method, pathOf(q), q.headers.Authorization]), [
		["GET", API + "/status", undefined], ["GET", API + "/session", "Bearer " + APP_PW], ["GET", API + "/config", "Bearer " + APP_PW]]);
	const full = signIn([["GET", /\/api\/v1\/session$/, () => ({ status: 200, body: { user: USER } })]]);
	const f = await full.call("login", { server: SERVER, username: "whoever", password: APP_PW });
	assert.deepStrictEqual(f.credentials.common, { server: SERVER, token: APP_PW, userId: USER.UID, username: "jane", name: "Jane Doe" });
	const refused = signIn([["GET", /\/api\/v1\/session$/, () => ({ status: 401, body: { error: "Unauthorized" } })]]);
	const x = await refused.call("login", { server: SERVER, username: "jane", password: APP_PW });
	assert.strictEqual(x.errorCode, "PHOTOPRISM_AUTH_FAILED");
	assert.match(x.errorText, /app password/);
	assert.deepStrictEqual(leaks(x, [APP_PW]), []);
});

test("login: a redirect of the status is followed once, before anything secret is sent; anything else that redirects is refused", async () => {
	const hits = signIn([["GET", /^http:\/\/photos\.example\.test\/api\/v1\/status$/, () => ({ status: 301, headers: { Location: SERVER + "/api/v1/status" } })]]);
	const r = await hits.call("login", { server: "http://photos.example.test", username: "jane", password: PASSWORD });
	assert.strictEqual(r.credentials.common.server, SERVER);
	assert.deepStrictEqual(hits.requests.slice(0, 3).map((q) => q.url), ["http://photos.example.test/api/v1/status", API + "/status", API + "/session"]);
	const loop = start([["GET", /status$/, (q) => ({ status: 302, headers: { Location: q.url.replace("/api/v1/status", "/x/api/v1/status") } })]]);
	const again = await loop.call("login", { server: SERVER, username: "jane", password: PASSWORD });
	assert.strictEqual(again.errorCode, "PHOTOPRISM_NOT_FOUND");
	assert.match(again.errorText, /redirects again/);
	assert.strictEqual(loop.requests.length, 2);
	const away = start([["GET", /status$/, () => ({ status: 302, headers: { Location: "https://sso.example.test/api/v1/status" } })]]);
	assert.strictEqual((await away.call("login", { server: SERVER, username: "jane", password: PASSWORD })).errorCode, "PHOTOPRISM_NOT_FOUND");
	assert.strictEqual(away.requests.length, 1);
	assert.ok(loop.requests.concat(away.requests).every((q) => !q.body && !q.headers.Authorization));
});

test("login: no server there, not PhotoPrism, the password refused, two-factor, no app password, no config: each its own error, none with a secret", async () => {
	const tls = Object.assign(new Error("write EPROTO SSL routines:ssl3_get_record:wrong version number"), { code: "EPROTO" });
	const cases = [
		[[["GET", /status$/, () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); }]], "PHOTOPRISM_UNREACHABLE"],
		[[["GET", /status$/, () => { throw tls; }]], "PHOTOPRISM_UNREACHABLE", /plain http/],
		[[["GET", /status$/, () => ({ status: 404, body: "<html>Not Found</html>" })]], "PHOTOPRISM_UNREACHABLE"],
		[[["GET", /status$/, () => ({ status: 200, body: "<html>a web page</html>" })]], "PHOTOPRISM_NOT_FOUND"],
		[[["GET", /status$/, () => ({ status: 200, body: { status: "starting" } })]], "PHOTOPRISM_NOT_FOUND"],
		[[["POST", /session$/, () => ({ status: 401, body: { code: 401, error: "Invalid credentials" } })]], "PHOTOPRISM_AUTH_FAILED"],
		[[["POST", /session$/, () => ({ status: 400, body: { error: "Invalid request" } })]], "PHOTOPRISM_AUTH_FAILED"],
		[[["POST", /session$/, () => ({ status: 401, body: { code: 32, message: "Enter verification code" } })]], "PHOTOPRISM_2FA", /app password/],
		[[["POST", /session$/, () => ({ status: 200, body: { user: USER } })]], "PHOTOPRISM_AUTH_FAILED"],
		[[["POST", /session$/, () => ({ status: 500, body: { error: "boom" } })]], "PHOTOPRISM_HTTP_ERROR"],
		[[["POST", /oauth\/token$/, () => ({ status: 403, body: { error: "Permission denied" } })]], "PHOTOPRISM_NO_APP_PASSWORD", /Apps and Devices/],
		[[["POST", /oauth\/token$/, () => ({ status: 200, body: {} })]], "PHOTOPRISM_NO_APP_PASSWORD"],
		[[["GET", /config$/, () => ({ status: 403, body: { error: "Permission denied" } })]], "PHOTOPRISM_KEY_SCOPE"],
		[[["GET", /config$/, () => ({ status: 401, body: { error: "Unauthorized" } })]], "PHOTOPRISM_AUTH_FAILED"],
		[[["GET", /config$/, () => ({ status: 200, body: { downloadToken: DL } })]], "PHOTOPRISM_NO_DOWNLOADS"],
		[[["GET", /config$/, () => ({ status: 500, body: {} })]], "PHOTOPRISM_HTTP_ERROR"],
	];
	for (const [routes, code, text] of cases) {
		const s = signIn(routes);
		const r = await s.call("login", { server: SERVER, username: "jane", password: PASSWORD });
		assert.strictEqual(r.errorCode, code, JSON.stringify(r));
		assert.ok(r.errorText);
		if (text) { assert.match(r.errorText, text); }
		assert.deepStrictEqual(leaks(r, [PASSWORD, SESS, TOKEN]), [], code);
		// A session that was opened is closed, whatever came after; one that was not is not.
		const opened = /oauth|config/.test(routes[0][1].source);
		assert.strictEqual(s.requests.filter((q) => q.method === "DELETE").length, opened ? 1 : 0, "the session closed for " + code);
	}
	const { call, requests } = start([]);
	for (const a of [{}, { server: SERVER }, { server: SERVER, username: "jane" }, { server: SERVER, username: "  ", password: PASSWORD },
		{ server: SERVER, username: "jane", password: 5 }]) {
		assert.strictEqual((await call("login", a)).errorCode, "MISSING_CREDENTIALS", JSON.stringify(a));
	}
	assert.strictEqual((await call("login", { server: "ftp://x", username: "jane", password: PASSWORD })).errorCode, "BAD_SERVER");
	assert.strictEqual(requests.length, 0);
});

test("login: a session that cannot be closed does not fail the sign-in; a user with no names is the name typed", async () => {
	const s = signIn([["DELETE", /session$/, () => ({ status: 500, body: {} })], ["POST", /\/session$/, () => ({ status: 200, body: { access_token: SESS } })]]);
	const r = await s.call("login", { server: SERVER, username: "jane", password: PASSWORD });
	assert.deepStrictEqual(r.credentials.common, { server: SERVER, token: TOKEN, userId: null, username: "jane", name: "jane" });
	assert.strictEqual(r.alias, "jane");
});

// --- checkCredentials, errors ---------------------------------------------------------------------

test("checkCredentials: /config with the stored app password; no server or token is 401_UNAUTHORIZED", async () => {
	const { call, requests } = start([CONFIG]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: STORED } }, ACCOUNTS), { returnValue: true, username: "jane" });
	assert.deepStrictEqual(requests.map((q) => [q.method, q.url, q.headers.Authorization]), [["GET", API + "/config", "Bearer " + TOKEN]]);
	for (const a of [{}, { credentials: {} }, { credentials: { common: { token: TOKEN } } }, { credentials: { common: { server: SERVER } } }]) {
		assert.strictEqual((await call("checkCredentials", a)).errorCode, "401_UNAUTHORIZED", JSON.stringify(a));
	}
	assert.strictEqual(requests.length, 1);
	const gone = await start([["GET", /config$/, () => ({ status: 401, body: { error: "Unauthorized" } })]]).call("checkCredentials", { credentials: { common: STORED } });
	assert.strictEqual(gone.status, 401);
	assert.deepStrictEqual(leaks(gone, [TOKEN]), []);
});

test("errors: PhotoPrism's message, else its error; a keyed request is never redirected", async () => {
	const creds = { credentials: { common: STORED } };
	const one = async (reply) => start([["GET", /config$/, () => reply]]).call("checkCredentials", creds);
	assert.strictEqual((await one({ status: 400, body: { code: 400, error: "Invalid request", message: "Something is off" } })).errorText,
		"PhotoPrism answered HTTP 400: Something is off");
	assert.strictEqual((await one({ status: 403, body: { error: "Permission denied" } })).errorText, "PhotoPrism answered HTTP 403: Permission denied");
	assert.strictEqual((await one({ status: 502, body: "<html>bad gateway</html>" })).errorText, "PhotoPrism answered HTTP 502");
	assert.strictEqual((await one({ status: 200, body: "<html>" })).errorCode, "PHOTOPRISM_BAD_JSON");
	const moved = await one({ status: 302, headers: { Location: "https://elsewhere.test/api/v1/config" } });
	assert.strictEqual(moved.errorCode, "PHOTOPRISM_HTTP_ERROR");
	assert.strictEqual(moved.status, 302);
	assert.match(moved.errorText, /redirect/);
	assert.strictEqual(adapter.messageOf("not json"), "");
	assert.strictEqual(adapter.messageOf(JSON.stringify({ error: "x".repeat(300) })).length, 203);
});

// --- downloadFile ---------------------------------------------------------------------------------

test("downloadFile: only the Photos app; the URL fetched as is (its token in it); the bytes to localPath", async () => {
	const BYTES = crypto.randomBytes(70000);
	const URL_ = API + "/dl/" + hash(1) + "?t=" + encodeURIComponent(DL);
	const { call, requests } = start([["GET", /\/dl\//, () => new Response(BYTES, { status: 200 })]]);
	for (const who of [{}, PHOTOS, ACCOUNTS, { appId: "org.webosports.app.photosX" }]) {
		assert.strictEqual((await call("downloadFile", { url: URL_, localPath: dl() }, who)).errorCode, "PERMISSION_DENIED", JSON.stringify(who));
	}
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { url: URL_, localPath: dest }, PHOTOS_APP), { returnValue: true, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.deepStrictEqual(requests.map((q) => [q.method, q.url, q.headers]), [["GET", URL_, {}]]);
	for (const url of ["file:///etc/shadow", "not a url", 5]) {
		assert.strictEqual((await call("downloadFile", { url, localPath: dl() }, PHOTOS_APP)).errorCode, "BAD_ARGS", String(url));
	}
	assert.strictEqual((await call("downloadFile", { url: URL_ }, PHOTOS_APP)).errorCode, "MISSING_ARGS");
});

// --- photos ---------------------------------------------------------------------------------------

test("listAlbums: albums by name, then folders with their photos counted; deleted, repeated, empty and odd ones left out", async () => {
	const { call, requests, handle } = start([
		["GET", /\/albums\?type=album&/, () => ({ status: 200, body: [album(1, { Title: "Holiday" }), album(2, { Title: "", PhotoCount: "3" }),
			album(3, { DeletedAt: "2026-08-01T12:00:00Z" }), album(1, { Title: "Holiday again" }), { UID: "../x", Title: "bad" }, null, { Title: "no uid" }] })],
		["GET", /\/albums\?type=folder&/, () => ({ status: 200, body: [album(4, { Title: "", Path: "2026/Trip", PhotoCount: 0 }), album(5, { Title: "Empty" }), album(1)] })],
		["GET", new RegExp("/photos\\?merged=true&s=" + uid("a", 4)), () => ({ status: 200, body: [photo(1), photo(2), photo(3, { Type: "video" })] })],
		["GET", new RegExp("/photos\\?merged=true&s=" + uid("a", 5)), () => ({ status: 200, body: [photo(4, { Type: "video" })] })]]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc-1" }, PHOTOS), { returnValue: true, albums: [
		{ aid: uid("a", 1), name: "Holiday", size: { images: 1 } }, { aid: uid("a", 2), name: uid("a", 2), size: { images: 3 } },
		{ aid: uid("a", 4), name: "2026/Trip", size: { images: 2 } }] });
	assert.deepStrictEqual(handle.calls, [{ uri: "luna://com.palm.service.accounts/readCredentials", args: { accountId: "acc-1", name: "common" } }]);
	assert.deepStrictEqual(requests.map((q) => q.url), [
		API + "/albums?type=album&order=name&count=500&offset=0", API + "/albums?type=folder&order=name&count=500&offset=0",
		API + "/photos?merged=true&s=" + uid("a", 4) + "&count=500&offset=0", API + "/photos?merged=true&s=" + uid("a", 5) + "&count=500&offset=0"]);
	assert.ok(requests.every((q) => q.headers.Authorization === "Bearer " + TOKEN));
});

test("listAlbums: albums or folders that cannot be listed are none; credentials are needed", async () => {
	const half = start([["GET", /type=album/, () => ({ status: 500, body: {} })], ["GET", /type=folder/, () => ({ status: 200, body: [album(4)] })],
		["GET", /photos/, () => ({ status: 200, body: [photo(1)] })]]);
	assert.deepStrictEqual((await half.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums.map((a) => a.aid), [uid("a", 4)]);
	const folderDown = start([["GET", /type=album/, () => ({ status: 200, body: [] })], ["GET", /type=folder/, () => ({ status: 200, body: [album(4), album(5)] })],
		["GET", new RegExp(uid("a", 4)), () => ({ status: 500, body: {} })], ["GET", /photos/, () => ({ status: 200, body: [photo(1)] })]]);
	assert.deepStrictEqual((await folderDown.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums.map((a) => a.aid), [uid("a", 5)]);
	const odd = start([["GET", /albums/, () => ({ status: 200, body: { not: "a list" } })]]);
	assert.deepStrictEqual((await odd.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums, []);
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await start([], { stored: { token: TOKEN } }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await start([]).call("listAlbums", {}, PHOTOS)).errorCode, "NO_CREDENTIALS");
	const inline = start([["GET", /albums/, () => ({ status: 200, body: [] })]]);
	assert.deepStrictEqual((await inline.call("listAlbums", { credentials: { common: STORED } }, PHOTOS)).albums, []);
	assert.deepStrictEqual(inline.handle.calls, []);
});

test("listPhotos: the config's tokens in the links, never the app password; originals of web types, 1920 px thumbnails of the rest; videos left out", async () => {
	const { call, requests } = start([CONFIG, ["GET", /\/photos\?/, () => ({ status: 200, body: [
		photo(1, { Caption: "Sunset" }),
		photo(2, { OriginalName: "" }, { Mime: "image/heic", Name: "2026/07/IMG_2.HEIC" }),
		photo(3, { Type: "video" }),
		photo(4, { Type: "raw", OriginalName: "DSC_4.NEF", TakenAt: "nonsense" }, { Mime: "image/x-nikon-nef" }),
		photo(5, { Files: [{ Hash: hash(55), Name: "a.mp4", Mime: "video/mp4" }, { Hash: hash(5), Name: "dir/live.png", Mime: "image/png" }], Type: "live", OriginalName: "" }),
		photo(6, { Hash: "not a hash" }), photo(7, { UID: "../../x" }), null, "x"] })]]);
	const r = await call("listPhotos", { accountId: "acc", aid: uid("a", 9) }, PHOTOS);
	const orig = (n) => API + "/dl/" + hash(n) + "?t=" + encodeURIComponent(DL);
	const thumb = (n, size) => API + "/t/" + hash(n) + "/" + encodeURIComponent(PV) + "/" + size;
	const t = (n) => Date.parse("2026-07-01T10:00:0" + n + "Z") / 1000;
	assert.deepStrictEqual(r, { returnValue: true, photos: [
		{ pid: uid("p", 1), src_big: orig(1), src_small: thumb(1, "fit_720"), caption: "Sunset", type: "image", fileName: "IMG_1.JPG", createdTime: t(1) },
		{ pid: uid("p", 2), src_big: thumb(2, "fit_1920"), src_small: thumb(2, "fit_720"), caption: "", type: "image", fileName: "IMG_2.jpg", createdTime: t(2) },
		{ pid: uid("p", 4), src_big: thumb(4, "fit_1920"), src_small: thumb(4, "fit_720"), caption: "", type: "image", fileName: "DSC_4.jpg" },
		{ pid: uid("p", 5), src_big: orig(5), src_small: thumb(5, "fit_720"), caption: "", type: "image", fileName: "live.png", createdTime: t(5) }] });
	assert.deepStrictEqual(requests.map((q) => q.url), [API + "/config", API + "/photos?merged=true&s=" + uid("a", 9) + "&count=500&offset=0"]);
	assert.deepStrictEqual(leaks(r, [TOKEN]), []);
});

test("listPhotos: no aid or a bad one, an album or config that cannot be read, no tokens: no photos (not an error); no credentials is an error", async () => {
	const { call, requests } = start([CONFIG, ["GET", /\/photos\?/, () => ({ status: 404, body: {} })]]);
	for (const aid of [undefined, "", 5, "../albums", "A0000000000000001"]) {
		assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid }, PHOTOS), { returnValue: true, photos: [] }, String(aid));
	}
	assert.ok(!requests.some((q) => /\/photos\?/.test(q.url)), "a bad aid is not asked for");
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: uid("a", 9) }, PHOTOS), { returnValue: true, photos: [] });
	const noCfg = start([["GET", /config$/, () => ({ status: 403, body: {} })], ["GET", /photos/, () => ({ status: 200, body: [photo(1)] })]]);
	assert.deepStrictEqual((await noCfg.call("listPhotos", { accountId: "acc", aid: uid("a", 9) }, PHOTOS)).photos, []);
	const noTok = start([["GET", /config$/, () => ({ status: 200, body: { downloadToken: DL, previewToken: "" } })], ["GET", /photos/, () => ({ status: 200, body: [photo(1)] })]]);
	assert.deepStrictEqual((await noTok.call("listPhotos", { accountId: "acc", aid: uid("a", 9) }, PHOTOS)).photos, []);
	assert.strictEqual((await start([], { stored: null }).call("listPhotos", { accountId: "acc", aid: uid("a", 9) }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("paging stops at MAX_ITEMS, and on a short page", async () => {
	let pages = 0;
	const many = start([CONFIG, ["GET", /photos/, (q) => {
		pages++;
		const off = Number(new URL(q.url).searchParams.get("offset"));
		return { status: 200, body: Array.from({ length: adapter.PAGE }, (_, i) => photo(off + i + 1)) }; }]]);
	assert.strictEqual((await many.call("listPhotos", { accountId: "acc", aid: uid("a", 9) }, PHOTOS)).photos.length, adapter.MAX_ITEMS);
	assert.strictEqual(pages, adapter.MAX_ITEMS / adapter.PAGE);
	assert.deepStrictEqual(many.requests.slice(1, 3).map((q) => new URL(q.url).searchParams.get("offset")), ["0", String(adapter.PAGE)]);
	const short = start([CONFIG, ["GET", /photos/, () => ({ status: 200, body: [photo(1)] })]]);
	assert.strictEqual((await short.call("listPhotos", { accountId: "acc", aid: uid("a", 9) }, PHOTOS)).photos.length, 1);
	assert.strictEqual(short.requests.length, 2);
	const albums = start([["GET", /type=album/, (q) => { const off = Number(new URL(q.url).searchParams.get("offset"));
		return { status: 200, body: Array.from({ length: adapter.PAGE }, (_, i) => album(off + i + 1)) }; }], ["GET", /type=folder/, () => ({ status: 200, body: [] })]]);
	assert.strictEqual((await albums.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums.length, Config.MAX_ALBUMS);
	assert.strictEqual(albums.requests.filter((q) => /type=album/.test(q.url)).length, 1);
});

test("photos.js: Go's zero time is not deleted; the primary file, else the one with the photo's hash, else the first", () => {
	assert.strictEqual(photos.deleted(ZERO), false);
	assert.strictEqual(photos.deleted(""), false);
	assert.strictEqual(photos.deleted(null), false);
	assert.strictEqual(photos.deleted("2026-01-01T00:00:00Z"), true);
	const a = { Hash: "h", Name: "a" }, b = { Hash: "x", Name: "b" }, c = { Hash: "y", Name: "c", Primary: true };
	assert.strictEqual(photos.primaryFile({ Hash: "h", Files: [b, a, c] }), c);
	assert.strictEqual(photos.primaryFile({ Hash: "h", Files: [b, a] }), a);
	assert.strictEqual(photos.primaryFile({ Hash: "h", Files: [b, null] }), b);
	assert.deepStrictEqual(photos.primaryFile({ Hash: "h" }), {});
	for (const type of ["image", "raw", "live", "animated", "vector"]) { assert.ok(photos.isImage(photo(1, { Type: type })), type); }
	for (const type of ["video", "", undefined]) { assert.ok(!photos.isImage(photo(1, { Type: type })), String(type)); }
});

// --- every request failing, in turn ----------------------------------------------------------

function happy(q) {
	const p = new URL(q.url).pathname;
	if (p.endsWith("/status")) { return { status: 200, body: { status: "operational" } }; }
	if (p.endsWith("/session") && q.method === "POST") { return { status: 200, body: { access_token: SESS, user: USER } }; }
	if (p.endsWith("/session") && q.method === "DELETE") { return { status: 200, body: {} }; }
	if (p.endsWith("/session")) { return { status: 200, body: { user: USER } }; }
	if (p.endsWith("/oauth/token")) { return { status: 200, body: { access_token: TOKEN } }; }
	if (p.endsWith("/config")) { return { status: 200, body: { downloadToken: DL, previewToken: PV } }; }
	if (/\/dl\//.test(p)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (p.endsWith("/albums")) { return { status: 200, body: [album(1)] }; }
	return { status: 200, body: [photo(1)] };
}

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401": () => ({ status: 401, body: { error: "Unauthorized" } }),
	"a redirect": () => ({ status: 302, headers: { Location: "https://elsewhere.test/" } }),
	"a reply that is not JSON": () => ({ status: 200, body: "<html>" }),
};
const BYTES_OK = new Set(["a reply that is not JSON"]);

const OPS = [
	// status, session, oauth/token, DELETE session (absorbed), config
	["login", { server: SERVER, username: "jane", password: PASSWORD }, { appId: "com.palm.app.accounts 3" },
		{ minSteps: 5, tolerated: (k, mode) => k === 4 || (k === 3 && mode === "a reply that is not JSON") }],
	// status, GET session (absorbed unless a 401), config
	["login", { server: SERVER, username: "jane", password: APP_PW }, { appId: "com.palm.app.accounts 3" },
		{ minSteps: 3, tolerated: (k, mode) => k === 2 && mode !== "a 401" }],
	["checkCredentials", { credentials: { common: STORED } }, ACCOUNTS],
	["downloadFile", () => ({ url: API + "/dl/" + hash(1) + "?t=" + DL, localPath: dl() }), PHOTOS_APP,
		{ tolerated: (k, mode) => BYTES_OK.has(mode) || mode === "a redirect" }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: uid("a", 9) }, PHOTOS, { minSteps: 2, tolerated: () => true }],
];

for (const [method, payload, caller, opts = {}] of OPS) {
	const label = method + (payload.password ? (payload.password === APP_PW ? " (app password)" : " (password)") : "");
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`photoprism ${label}: any request failing (${mode}) is one reply${opts.tolerated ? "" : ", an error"}`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const each = (q) => { n++; return n === k ? fail(q) : happy(q); };
				const { call } = start([["GET", /./, each], ["POST", /./, each], ["DELETE", /./, each]], { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
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
				assert.deepStrictEqual(leaks(r, [PASSWORD, SESS].concat(r.returnValue === false ? [TOKEN, APP_PW] : [])), [], "no secret in the reply");
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
