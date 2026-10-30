// node --test tests/unit
// The SmugMug connector (cloud/smugmug/service/com.palm.service.smugmug) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (endpoint, query, OAuth 1.0a signature), its reply, and its errors; the
// Accounts service is answered by the stand-in bus. The signer is cloud/flickr's, so it is
// checked here against the same published vectors (OAuth Core 1.0a Appendix A.5).
//
// The reply shapes are SmugMug's as API v2 gave them for a real account: { Code, Message,
// Response: { ..., Pages } } with the _expand'ed objects in Expansions beside Response, and the
// OAuth failure whose Message carries the signature base string.
//
// The last part fails every request of every method in turn, in each way a request can fail,
// and checks the method still answers exactly once: an error lost on the way would show here as
// no reply (ask() throws on none, or on two).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/smugmug/service/com.palm.service.smugmug");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const oauth1 = require(path.join(SVC, "oauth1.js"));
const adapter = require(path.join(SVC, "adapter.js"));
const API = "https://api.smugmug.com";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "smugmug-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "photo.jpg");

const PHOTOS = { service: "com.palm.service.photos" };
const PHOTOS_APP = { appId: "org.webosports.app.photos 1234" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const STORED = { oauthToken: "tok-1", oauthTokenSecret: "tsec-1", userId: "nick", username: "nick", fullname: "N Ick" };
const NOW = 1191242096000;
const NONCE = "ab".repeat(16);

// The service on a stand-in bus, with a fixed nonce and clock. Accounts: readCredentials gives
// `stored`. -> { handle, requests, call(method, payload, caller) }
function start(routes, { stored = STORED, onCall, timeouts } = {}) {
	const f = fakeFetch(routes);
	const pb = fakePalmbus({ onCall: onCall || ((uri) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: Object.assign({}, stored) } : { returnValue: true }; }
		return { returnValue: false, errorCode: -1, errorText: "Unknown service" };
	}) });
	const s = service.start({ palmbus: pb, fetch: f.fetch, idleMs: 0, exit: () => {}, log: { log() {}, error() {} },
		random: (n) => Buffer.alloc(n, 0xab), now: () => NOW, timeouts });
	const handle = pb.handles[0];
	return { s, handle, requests: f.requests, call: (method, payload, caller = {}) => ask(handle, method, payload, caller) };
}

// --- an independent check of a signed URL ---------------------------------------------------
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const queryPairs = (url) => new URL(url).search.slice(1).split("&").map((kv) => kv.split("=").map(decodeURIComponent));
const query = (url) => Object.fromEntries(queryPairs(url));
function expectedSignature(url, consumerSecret, tokenSecret) {
	const u = new URL(url);
	const pairs = queryPairs(url).filter(([k]) => k !== "oauth_signature").map(([k, v]) => [enc(k), enc(v)])
		.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));
	const base = "GET&" + enc(u.origin + u.pathname) + "&" + enc(pairs.map((p) => p.join("=")).join("&"));
	return crypto.createHmac("sha1", enc(consumerSecret) + "&" + enc(tokenSecret || "")).update(base).digest("base64");
}
function assertSigned(q, tokenSecret, token) {
	assert.strictEqual(q.method, "GET");
	assert.strictEqual(q.body, undefined);
	assert.strictEqual(q.headers.Authorization, undefined);
	assert.match(new URL(q.url).search.slice(1), /^[A-Za-z0-9\-._~%=&]*$/, "the query is RFC 3986 encoded");
	const p = query(q.url);
	assert.strictEqual(p.oauth_consumer_key, Config.CONSUMER_KEY);
	assert.strictEqual(p.oauth_nonce, NONCE);
	assert.strictEqual(p.oauth_timestamp, String(NOW / 1000));
	assert.strictEqual(p.oauth_signature_method, "HMAC-SHA1");
	assert.strictEqual(p.oauth_version, "1.0");
	assert.strictEqual(p.oauth_token, token);
	assert.strictEqual(p.oauth_signature, expectedSignature(q.url, Config.CONSUMER_SECRET, tokenSecret), "the signature");
	return p;
}
const OAUTH_KEYS = ["oauth_consumer_key", "oauth_nonce", "oauth_signature_method", "oauth_timestamp", "oauth_version"];
const apiParams = (q) => Object.fromEntries(Object.entries(query(q.url)).filter(([k]) => !k.startsWith("oauth_")));
const apiPath = (q) => { const u = new URL(q.url); return u.origin === API ? u.pathname : null; };

// SmugMug's replies. Response.Uri echoes the signed query, as the real one does.
const reply = (resp, extra = {}) => ({ status: 200, body: Object.assign({ Code: 200, Message: "Ok",
	Response: Object.assign({ Uri: "/api/v2?oauth_token=tok-1&oauth_signature=SIG" }, resp) }, extra) });
const USER = { User: { NickName: "nick", Name: "N Ick", Uri: "/api/v2/user/nick" } };
const OAUTH_401 = { status: 401, body: { Code: 401,
	Message: "oauth_problem=signature_invalid&debug_sbs=GET&https%3A%2F%2Fapi.smugmug.com%2Fapi%2Fv2%21authuser&oauth_token%3Dtok-1" } };

// --- the service --------------------------------------------------------------------------------

test("the service: its bus name and methods (Flickr's, plus quit, info)", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.smugmug");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "downloadFile", "exchangeCode",
		"getAuthorizeUrl", "info", "listAlbums", "listPhotos", "quit"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
});

test("config.js: the consumer key and secret are the placeholders the recipe fills", () => {
	assert.strictEqual(Config.CONSUMER_KEY, "PLACEHOLDER_SMUGMUG_CLIENT_ID");
	assert.strictEqual(Config.CONSUMER_SECRET, "PLACEHOLDER_SMUGMUG_CLIENT_SECRET");
	assert.strictEqual(Config.ACCESS, "Full");
	assert.strictEqual(Config.PERMISSIONS, "Read");
});

test("signing: OAuth Core 1.0a Appendix A.5 (photos.example.net) signature", () => {
	const params = { file: "vacation.jpg", size: "original", oauth_consumer_key: "dpf43f3p2l4k3l03", oauth_token: "nnch734d00sl2jdk",
		oauth_signature_method: "HMAC-SHA1", oauth_timestamp: "1191242096", oauth_nonce: "kllo9940pd9333jh", oauth_version: "1.0" };
	assert.strictEqual(oauth1.sign("GET", "http://photos.example.net/photos", params, "kd94hf93k423kf44", "pfkkdhi9sl3r4s00"),
		"tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
});

// --- OAuth legs -----------------------------------------------------------------------------------

test("getAuthorizeUrl: a signed getRequestToken with oauth_callback, then the consent URL with Access and Permissions", async () => {
	const { call, requests } = start([["GET", /oauth\/1\.0a\/getRequestToken\?/, () => ({ status: 200,
		body: "oauth_token=req-1&oauth_token_secret=reqsec%2B1&oauth_callback_confirmed=true" })]]);
	const r = await call("getAuthorizeUrl", {}, {});
	assert.deepStrictEqual(r, { returnValue: true,
		url: "https://api.smugmug.com/services/oauth/1.0a/authorize?oauth_token=req-1&Access=Full&Permissions=Read",
		requestToken: "req-1", requestTokenSecret: "reqsec+1" });
	assert.strictEqual(requests.length, 1);
	const u = new URL(requests[0].url);
	assert.strictEqual(u.origin + u.pathname, Config.REQUEST_TOKEN_URL);
	const p = assertSigned(requests[0], "", undefined);
	assert.deepStrictEqual(Object.keys(p).sort(), OAUTH_KEYS.concat(["oauth_callback", "oauth_signature"]).sort());
	assert.strictEqual(p.oauth_callback, "http://localhost/smugmug/oauth1callback");
});

test("getAuthorizeUrl: a refused or malformed reply is an error that does not echo the reply", async () => {
	const r = await start([["GET", /getRequestToken/, () => ({ status: 401, body: "oauth_problem=signature_invalid&debug_sbs=SECRETISH" })]])
		.call("getAuthorizeUrl", {});
	assert.deepStrictEqual(r, { returnValue: false, errorCode: "OAUTH_REQUEST_TOKEN_FAILED",
		errorText: "SmugMug's getRequestToken endpoint answered HTTP 401", status: 401 });
	const m = await start([["GET", /getRequestToken/, () => ({ status: 200, body: "oauth_token=half-a-token" })]]).call("getAuthorizeUrl", {});
	assert.strictEqual(m.errorCode, "OAUTH_REQUEST_TOKEN_MALFORMED");
	assert.doesNotMatch(m.errorText, /half-a-token/);
});

test("exchangeCode: getAccessToken signed with the request secret, then !authuser with the new token; the NickName is the user", async () => {
	const { call, requests } = start([
		["GET", /oauth\/1\.0a\/getAccessToken\?/, () => ({ status: 200, body: "oauth_token=acc-1&oauth_token_secret=accsec" })],
		["GET", /\/api\/v2!authuser\?/, () => reply(USER)]]);
	const r = await call("exchangeCode", { oauth_verifier: "227166", requestToken: "req-1", requestTokenSecret: "reqsec" }, ACCOUNTS);
	assert.deepStrictEqual(r, { returnValue: true, username: "nick", alias: "N Ick", credentials: { common: {
		oauthToken: "acc-1", oauthTokenSecret: "accsec", userId: "nick", username: "nick", fullname: "N Ick" } } });
	assert.strictEqual(requests.length, 2);
	const p = assertSigned(requests[0], "reqsec", "req-1");
	assert.deepStrictEqual(Object.keys(p).sort(), OAUTH_KEYS.concat(["oauth_token", "oauth_verifier", "oauth_signature"]).sort());
	assert.strictEqual(p.oauth_verifier, "227166");
	assertSigned(requests[1], "accsec", "acc-1");
	assert.strictEqual(apiPath(requests[1]), "/api/v2!authuser");
	assert.strictEqual(requests[1].headers.Accept, "application/json");
});

test("exchangeCode: no NickName is SMUGMUG_NO_USER; no Name leaves no alias; missing arguments are MISSING_VERIFIER", async () => {
	let user = { User: {} };
	const { call, requests } = start([["GET", /getAccessToken/, () => ({ status: 200, body: "oauth_token=a&oauth_token_secret=b" })],
		["GET", /authuser/, () => reply(user)]]);
	const ok = { oauthVerifier: "v", oauth_token: "rt", requestTokenSecret: "rs" };
	assert.strictEqual((await call("exchangeCode", ok)).errorCode, "SMUGMUG_NO_USER");
	user = { User: { NickName: "only" } };
	const r = await call("exchangeCode", ok);
	assert.strictEqual(r.username, "only");
	assert.strictEqual(r.alias, undefined);
	assert.strictEqual(r.credentials.common.fullname, null);
	const before = requests.length;
	for (const a of [{}, { requestToken: "t", requestTokenSecret: "s" }, { oauth_verifier: "v", requestTokenSecret: "s" }, { oauth_verifier: "v", requestToken: "t" }]) {
		assert.strictEqual((await call("exchangeCode", a)).errorCode, "MISSING_VERIFIER", JSON.stringify(a));
	}
	assert.strictEqual(requests.length, before);
});

// --- the API ----------------------------------------------------------------------------------------

test("checkCredentials: !authuser with the account's token; the NickName, else the stored username", async () => {
	let user = USER;
	const { call, requests } = start([["GET", /authuser/, () => reply(user)]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: STORED } }, ACCOUNTS), { returnValue: true, username: "nick" });
	assertSigned(requests[0], "tsec-1", "tok-1");
	user = { User: {} };
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: STORED } }), { returnValue: true, username: "nick" });
	for (const a of [{}, { credentials: {} }, { credentials: { common: { accessToken: "oauth2-shape" } } }]) {
		assert.strictEqual((await call("checkCredentials", a)).errorCode, "401_UNAUTHORIZED", JSON.stringify(a));
	}
	assert.strictEqual(requests.length, 2);
});

test("errors: an OAuth 401 keeps only the oauth_problem; no reply body, token or base string reaches the errorText", async () => {
	const creds = { credentials: { common: STORED } };
	const r = await start([["GET", /authuser/, () => OAUTH_401]]).call("checkCredentials", creds);
	assert.deepStrictEqual(r, { returnValue: false, errorCode: "SMUGMUG_HTTP_ERROR", errorText: "SmugMug answered HTTP 401: oauth_problem=signature_invalid", status: 401 });
	const nf = await start([["GET", /authuser/, () => ({ status: 404, body: { Code: 404, Message: "Not Found", Response: { Uri: "/x?oauth_token=tok-1" } } })]]).call("checkCredentials", creds);
	assert.strictEqual(nf.errorText, "SmugMug answered HTTP 404: Not Found");
	const odd = await start([["GET", /authuser/, () => ({ status: 400, body: { Message: "bad oauth_token=tok-1" } })]]).call("checkCredentials", creds);
	assert.strictEqual(odd.errorText, "SmugMug answered HTTP 400");
	const html = await start([["GET", /authuser/, () => ({ status: 503, body: "<html>oauth_token=tok-1</html>" })]]).call("checkCredentials", creds);
	assert.strictEqual(html.errorText, "SmugMug answered HTTP 503");
	const notJson = await start([["GET", /authuser/, () => ({ status: 200, body: "<html>" })]]).call("checkCredentials", creds);
	assert.strictEqual(notJson.errorCode, "SMUGMUG_BAD_JSON");
	const noResp = await start([["GET", /authuser/, () => ({ status: 200, body: { Code: 200 } })]]).call("checkCredentials", creds);
	assert.strictEqual(noResp.errorCode, "SMUGMUG_BAD_JSON");
	for (const x of [r, nf, odd, html, notJson, noResp]) { assert.doesNotMatch(JSON.stringify(x), /tok-1|tsec-1|debug_sbs|oauth_token/); }
	assert.strictEqual(adapter.messageOf("not json"), "");
});

// --- downloadFile ---------------------------------------------------------------------------------

test("downloadFile: only the Photos app; the URL fetched as is, unsigned; the bytes to localPath", async () => {
	const BYTES = crypto.randomBytes(70000);
	const URL_ = "https://photos.smugmug.com/photos/i-Xy7zQwe/0/KEY/D/i-Xy7zQwe-D.png";
	const { call, requests } = start([["GET", /photos\.smugmug\.com/, () => new Response(BYTES, { status: 200 })]]);
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

const ALBUM = (key, name, n) => ({ AlbumKey: key, Name: name, ImageCount: n, Uri: "/api/v2/album/" + key });
const IMG = (key, extra) => Object.assign({ ImageKey: key, FileName: key + ".jpg", Title: "", Caption: "", IsVideo: false, Processing: false,
	ArchivedUri: "https://photos.smugmug.com/photos/i-" + key + "/0/K/D/i-" + key + "-D.jpg",
	ThumbnailUrl: "https://photos.smugmug.com/photos/i-" + key + "/0/K/Th/i-" + key + "-Th.jpg",
	Uris: { LargestImage: { Uri: "/api/v2/image/" + key + "-0!largestimage" } } }, extra);
const largest = (key) => ({ ["/api/v2/image/" + key + "-0!largestimage"]: { LargestImage: { Url: "https://photos.smugmug.com/" + key + "-XL.png" } } });

test("listAlbums: user/<NickName>!albums, page after page; name, else Title, else the key", async () => {
	const { call, requests, handle } = start([["GET", /!albums\?/, (q) => (query(q.url).start === "1"
		? reply({ Album: [ALBUM("A1", "Holiday", 12), ALBUM("A2", "", "3")], Pages: { Total: 3, Start: 1, Count: 2, NextPage: "/next" } })
		: reply({ Album: [{ AlbumKey: "A3", Title: "T3" }, { Name: "no key" }], Pages: { Total: 3, Start: 3, Count: 1 } }))]]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc-1" }, PHOTOS), { returnValue: true, albums: [
		{ aid: "A1", name: "Holiday", size: { images: 12 } },
		{ aid: "A2", name: "A2", size: { images: 3 } },
		{ aid: "A3", name: "T3", size: { images: 0 } }] });
	assert.deepStrictEqual(handle.calls, [{ uri: "luna://com.palm.service.accounts/readCredentials", args: { accountId: "acc-1", name: "common" } }]);
	assert.strictEqual(requests.length, 2);
	for (const q of requests) { assertSigned(q, "tsec-1", "tok-1"); assert.strictEqual(apiPath(q), "/api/v2/user/nick!albums"); }
	assert.deepStrictEqual(apiParams(requests[0]), { start: "1", count: "100" });
	assert.deepStrictEqual(apiParams(requests[1]), { start: "3", count: "100" });
});

test("listAlbums: no stored NickName asks !authuser; albums that cannot be listed are none; credentials are needed", async () => {
	const { call, requests } = start([["GET", /authuser/, () => reply(USER)], ["GET", /!albums/, () => reply({ Album: [ALBUM("A", "a", 1)] })]],
		{ stored: { oauthToken: "tok-1", oauthTokenSecret: "tsec-1" } });
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, PHOTOS)).albums.length, 1);
	assert.deepStrictEqual(requests.map(apiPath), ["/api/v2!authuser", "/api/v2/user/nick!albums"]);
	const down = start([["GET", /!albums/, () => OAUTH_401]]);
	assert.deepStrictEqual(await down.call("listAlbums", { accountId: "acc" }, PHOTOS), { returnValue: true, albums: [] });
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await start([]).call("listAlbums", {}, PHOTOS)).errorCode, "NO_CREDENTIALS");
});

test("listPhotos: album/<key>!images with LargestImage expanded; the original first, the largest size else; videos and processing left out", async () => {
	const raw = [IMG("i1", { Caption: "Sunset", FileName: "sunset.PNG" }),
		IMG("i2", { ArchivedUri: undefined, Title: "Beach" }),
		IMG("i3", { ArchivedUri: "", FileName: "" }),
		IMG("i4", { IsVideo: true }),
		IMG("i5", { Processing: true }),
		IMG("i6", { ArchivedUri: null, Uris: {} }),
		IMG("", {}),
		null];
	const { call, requests } = start([["GET", /!images\?/, () => reply({ AlbumImage: raw, Pages: { Total: 8 } },
		{ Expansions: Object.assign({}, largest("i2"), largest("i3")) })]]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "Ab3CdE" }, PHOTOS), { returnValue: true, photos: [
		{ pid: "i1", src_big: raw[0].ArchivedUri, src_small: raw[0].ThumbnailUrl, caption: "Sunset", type: "image", fileName: "sunset.PNG" },
		{ pid: "i2", src_big: "https://photos.smugmug.com/i2-XL.png", src_small: raw[1].ThumbnailUrl, caption: "Beach", type: "image", fileName: "i2.jpg" },
		{ pid: "i3", src_big: "https://photos.smugmug.com/i3-XL.png", src_small: raw[2].ThumbnailUrl, caption: "", type: "image", fileName: "i3.png" }] });
	assertSigned(requests[0], "tsec-1", "tok-1");
	assert.strictEqual(apiPath(requests[0]), "/api/v2/album/Ab3CdE!images");
	assert.deepStrictEqual(apiParams(requests[0]), { _expand: "LargestImage", start: "1", count: "100" });
});

test("listPhotos: an album that cannot be listed, or a bad aid, has no photos (not an error); no credentials is an error", async () => {
	const { call, requests } = start([["GET", /!images/, () => ({ status: 404, body: { Code: 404, Message: "Not Found" } })]]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "NOPE00" }, PHOTOS), { returnValue: true, photos: [] });
	for (const aid of [undefined, "", 5]) {
		assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid }, PHOTOS), { returnValue: true, photos: [] }, String(aid));
	}
	await call("listPhotos", { accountId: "acc", aid: "../user/x" }, PHOTOS);
	assert.strictEqual(apiPath(requests[1]), "/api/v2/album/..%2Fuser%2Fx!images", "the aid stays one path segment");
	assert.strictEqual(requests.length, 2);
	assert.strictEqual((await start([], { stored: null }).call("listPhotos", { accountId: "acc", aid: "A" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("paging stops at MAX_ITEMS, and on a page with no items even when SmugMug says there are more", async () => {
	let pages = 0;
	const many = start([["GET", /!images/, (q) => { pages++; const s = +query(q.url).start;
		return reply({ AlbumImage: Array.from({ length: 100 }, (_, i) => IMG("k" + (s + i))), Pages: { Total: 99999, NextPage: "/n" } }); }]]);
	assert.strictEqual((await many.call("listPhotos", { accountId: "acc", aid: "A" }, PHOTOS)).photos.length, adapter.MAX_ITEMS);
	assert.strictEqual(pages, adapter.MAX_ITEMS / adapter.PAGE);
	const empty = start([["GET", /!images/, () => reply({ AlbumImage: [], Pages: { Total: 50, NextPage: "/n" } })]]);
	assert.deepStrictEqual((await empty.call("listPhotos", { accountId: "acc", aid: "A" }, PHOTOS)).photos, []);
	assert.strictEqual(empty.requests.length, 1);
});

// --- every request failing, in turn ----------------------------------------------------------

function happy(q) {
	const u = q.url;
	if (/getRequestToken\?/.test(u)) { return { status: 200, body: "oauth_token=rt&oauth_token_secret=rs" }; }
	if (/getAccessToken\?/.test(u)) { return { status: 200, body: "oauth_token=at&oauth_token_secret=as" }; }
	if (/photos\.smugmug\.com/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	if (/authuser/.test(u)) { return reply(USER); }
	if (/!albums/.test(u)) { return reply({ Album: [ALBUM("A1", "a", 1)] }); }
	return reply({ AlbumImage: [IMG("i1")] });
}

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"an OAuth 401": () => OAUTH_401,
	"a reply that is not JSON (or not a token form)": () => ({ status: 200, body: "<html>" }),
};
const BYTES_OK = new Set(["a reply that is not JSON (or not a token form)"]);

const OPS = [
	["getAuthorizeUrl", {}, {}],
	["exchangeCode", { oauth_verifier: "v", requestToken: "rt", requestTokenSecret: "rs" }, ACCOUNTS, { minSteps: 2 }],
	["checkCredentials", { credentials: { common: STORED } }, ACCOUNTS],
	["downloadFile", () => ({ url: "https://photos.smugmug.com/x-D.jpg", localPath: dl() }), PHOTOS_APP,
		{ tolerated: (k, mode) => BYTES_OK.has(mode) }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: "A1" }, PHOTOS, { tolerated: () => true }],
];

for (const [method, payload, caller, opts = {}] of OPS) {
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`smugmug ${method}: any request failing (${mode}) is one reply${opts.tolerated ? "" : ", an error"}`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const { call } = start([["GET", /./, (q) => { n++; return n === k ? fail(q) : happy(q); }]],
					{ timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
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
				assert.doesNotMatch(JSON.stringify(r), /tok-1|tsec-1|oauth_signature|debug_sbs/, "no token in the reply");
			}
			assert.ok(reached >= (opts.minSteps || 1), `only ${reached} of ${opts.minSteps || 1} steps were failed`);
		});
	}
}

test("a payload that is not a JSON object is BAD_ARGS; an unknown method NOT_SUPPORTED", async () => {
	const { call } = start([]);
	assert.strictEqual((await call("listAlbums", "[]", PHOTOS)).errorCode, "BAD_ARGS");
	assert.strictEqual((await call("listFolder", {}, PHOTOS)).errorCode, "NOT_SUPPORTED");
});
