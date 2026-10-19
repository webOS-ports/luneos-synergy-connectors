// node --test tests/unit
// The Flickr connector (cloud/flickr/service/com.palm.service.flickr) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that records every request.
// Each method is called over the bus as its real caller would call it, and checked for the
// requests it makes (endpoint, query, OAuth 1.0a signature), its reply, and its errors; the
// Accounts service is answered by the stand-in bus. The signer is checked against the published
// vectors (OAuth Core 1.0a Appendix A.5, RFC 5849 3.4.1.1).
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

const SVC = path.join(__dirname, "../../cloud/flickr/service/com.palm.service.flickr");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const oauth1 = require(path.join(SVC, "oauth1.js"));
const REST = "https://api.flickr.com/services/rest/";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flickr-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "photo.jpg");

const PHOTOS = { service: "com.palm.service.photos" };
const PHOTOS_APP = { appId: "com.palm.app.photos 1234" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const STORED = { oauthToken: "tok-1", oauthTokenSecret: "tsec-1", userId: "12@N01", username: "uname", fullname: "U Ser" };
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
// The query exactly as sent: [[key, value]] decoded, in order.
const queryPairs = (url) => new URL(url).search.slice(1).split("&").map((kv) => kv.split("=").map(decodeURIComponent));
const query = (url) => Object.fromEntries(queryPairs(url));
function expectedSignature(url, consumerSecret, tokenSecret) {
	const u = new URL(url);
	const pairs = queryPairs(url).filter(([k]) => k !== "oauth_signature").map(([k, v]) => [enc(k), enc(v)])
		.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));
	const base = "GET&" + enc(u.origin + u.pathname) + "&" + enc(pairs.map((p) => p.join("=")).join("&"));
	return crypto.createHmac("sha1", enc(consumerSecret) + "&" + enc(tokenSecret || "")).update(base).digest("base64");
}
// The oauth_* a request carries, the signature checked, and nothing outside RFC 3986 in the query.
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
const withoutOAuth = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("oauth_")));
const restParams = (q) => withoutOAuth(query(q.url));

// --- the service --------------------------------------------------------------------------------

test("the service: its bus name, and every method the old services.json had (plus quit, info)", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.flickr");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "downloadFile", "exchangeCode",
		"getAuthorizeUrl", "info", "listAlbums", "listPhotos", "quit"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	for (const gone of ["services.json", "sources.json", "httpcurl.js", "acl.js", "creds.js", "flickrapi.js", "commands"]) {
		assert.ok(!fs.existsSync(path.join(SVC, gone)), gone);
	}
});

test("config.js: the same keys, the consumer key and secret still placeholders", () => {
	assert.deepStrictEqual(Object.keys(Config), ["CURL", "CURL_LD_LIBRARY_PATH", "CURL_CAINFO", "CONSUMER_KEY", "CONSUMER_SECRET",
		"CALLBACK_URL", "REQUEST_TOKEN_URL", "AUTHORIZE_URL", "ACCESS_TOKEN_URL", "REST_URL", "PERMS"]);
	assert.strictEqual(Config.CONSUMER_KEY, "PUT_YOUR_FLICKR_API_KEY_HERE");
	assert.strictEqual(Config.CONSUMER_SECRET, "PUT_YOUR_FLICKR_API_SECRET_HERE");
});

// --- signing --------------------------------------------------------------------------------------

test("signing: OAuth Core 1.0a Appendix A.5 (photos.example.net) base string and signature", () => {
	const params = { file: "vacation.jpg", size: "original", oauth_consumer_key: "dpf43f3p2l4k3l03", oauth_token: "nnch734d00sl2jdk",
		oauth_signature_method: "HMAC-SHA1", oauth_timestamp: "1191242096", oauth_nonce: "kllo9940pd9333jh", oauth_version: "1.0" };
	assert.strictEqual(oauth1.buildBaseString("GET", "http://photos.example.net/photos", params),
		"GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal");
	assert.strictEqual(oauth1.sign("GET", "http://photos.example.net/photos", params, "kd94hf93k423kf44", "pfkkdhi9sl3r4s00"),
		"tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
});

test("signing: RFC 5849 3.4.1.1 base string (encoded twice, sorted by key then value, a key twice)", () => {
	const pairs = [["b5", "=%3D"], ["a3", "a"], ["c@", ""], ["a2", "r b"], ["oauth_consumer_key", "9djdj82h48djs9d2"],
		["oauth_token", "kkk9d7dh3k39sjv7"], ["oauth_signature_method", "HMAC-SHA1"], ["oauth_timestamp", "137131201"],
		["oauth_nonce", "7d8f3e4a"], ["c2", ""], ["a3", "2 q"]];
	assert.strictEqual(oauth1.buildBaseString("post", "http://example.com/request", pairs),
		"POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7");
});

test("signing: RFC 3986 percent-encoding, the key's trailing &, null parameters left out", () => {
	assert.strictEqual(oauth1.percentEncode("AZaz09-._~"), "AZaz09-._~");
	assert.strictEqual(oauth1.percentEncode("!*'() +/=&%"), "%21%2A%27%28%29%20%2B%2F%3D%26%25");
	assert.strictEqual(oauth1.percentEncode("é\u{1F4F7}"), "%C3%A9%F0%9F%93%B7");
	assert.strictEqual(oauth1.percentEncode(5), "5");
	assert.strictEqual(oauth1.signingKey("c s", ""), "c%20s&");
	assert.strictEqual(oauth1.signingKey("cs", "t&s"), "cs&t%26s");
	assert.strictEqual(oauth1.buildBaseString("GET", "https://x/", { a: "1", b: null, c: undefined }), "GET&https%3A%2F%2Fx%2F&a%3D1");
	assert.throws(() => oauth1.percentEncode("\ud800"), (e) => e.errorCode === "BAD_ARGS");
});

// --- OAuth legs -----------------------------------------------------------------------------------

test("getAuthorizeUrl: a signed request_token GET with oauth_callback, then the consent URL and the token to carry", async () => {
	const { call, requests } = start([["GET", /services\/oauth\/request_token\?/, () => ({ status: 200,
		body: "oauth_callback_confirmed=true&oauth_token=72157-req&oauth_token_secret=reqsec%2B1" })]]);
	const r = await call("getAuthorizeUrl", {}, {});
	assert.deepStrictEqual(r, { returnValue: true, url: "https://www.flickr.com/services/oauth/authorize?oauth_token=72157-req&perms=read",
		requestToken: "72157-req", requestTokenSecret: "reqsec+1" });
	assert.strictEqual(requests.length, 1);
	const u = new URL(requests[0].url);
	assert.strictEqual(u.origin + u.pathname, Config.REQUEST_TOKEN_URL);
	const p = assertSigned(requests[0], "", undefined);
	assert.deepStrictEqual(Object.keys(p).sort(), OAUTH_KEYS.concat(["oauth_callback", "oauth_signature"]).sort());
	assert.strictEqual(p.oauth_callback, "http://localhost/flickr/oauth1callback");
	assert.match(requests[0].url, /oauth_callback=http%3A%2F%2Flocalhost%2Fflickr%2Foauth1callback/);
});

test("getAuthorizeUrl: open to any caller, as its command never checked its allowedAppIds", async () => {
	const { call } = start([["GET", /request_token/, () => ({ status: 200, body: "oauth_token=t&oauth_token_secret=s" })]]);
	for (const who of [{}, { appId: "com.palm.app.flickr-auth" }, { appId: "com.palm.app.accounts 99" }, PHOTOS]) {
		assert.strictEqual((await call("getAuthorizeUrl", {}, who)).returnValue, true, JSON.stringify(who));
	}
});

test("getAuthorizeUrl: a refused or malformed request_token reply is an error that does not echo the reply", async () => {
	const refused = start([["GET", /request_token/, () => ({ status: 401, body: "oauth_problem=signature_invalid&debug_sbs=SECRETISH" })]]);
	const r = await refused.call("getAuthorizeUrl", {});
	assert.deepStrictEqual(r, { returnValue: false, errorCode: "OAUTH_REQUEST_TOKEN_FAILED",
		errorText: "Flickr's request_token endpoint answered HTTP 401", status: 401 });
	const nonStd = start([["GET", /request_token/, () => ({ status: 201, body: "oauth_token=t&oauth_token_secret=s" })]]);
	assert.strictEqual((await nonStd.call("getAuthorizeUrl", {})).errorCode, "OAUTH_REQUEST_TOKEN_FAILED");
	for (const bad of ["oauth_token=half-a-token", "oauth_token=t&oauth_token_secret=%E0%A4%A", ""]) {
		const m = await start([["GET", /request_token/, () => ({ status: 200, body: bad })]]).call("getAuthorizeUrl", {});
		assert.strictEqual(m.errorCode, "OAUTH_REQUEST_TOKEN_MALFORMED", bad);
		assert.doesNotMatch(m.errorText, /half-a-token/);
	}
});

test("exchangeCode: a signed access_token GET with the request token and verifier, signed with the request secret", async () => {
	const { call, requests } = start([["GET", /services\/oauth\/access_token\?/, () => ({ status: 200,
		body: "fullname=Jamal%20Fanaian&oauth_token=72157-acc&oauth_token_secret=accsec&user_nsid=21207597%40N07&username=jamalfanaian" })]]);
	const r = await call("exchangeCode", { oauth_verifier: "ver-1", requestToken: "72157-req", requestTokenSecret: "reqsec" }, ACCOUNTS);
	assert.deepStrictEqual(r, { returnValue: true, username: "jamalfanaian", alias: "Jamal Fanaian", credentials: { common: {
		oauthToken: "72157-acc", oauthTokenSecret: "accsec", userId: "21207597@N07", username: "jamalfanaian", fullname: "Jamal Fanaian" } } });
	assert.strictEqual(requests.length, 1);
	const u = new URL(requests[0].url);
	assert.strictEqual(u.origin + u.pathname, Config.ACCESS_TOKEN_URL);
	const p = assertSigned(requests[0], "reqsec", "72157-req");
	assert.deepStrictEqual(Object.keys(p).sort(), OAUTH_KEYS.concat(["oauth_token", "oauth_verifier", "oauth_signature"]).sort());
	assert.strictEqual(p.oauth_verifier, "ver-1");
});

test("exchangeCode: the other argument spellings; the username falls back to the nsid, then \"Flickr\"", async () => {
	let reply = "oauth_token=a&oauth_token_secret=b&user_nsid=N1";
	const { call, requests } = start([["GET", /access_token/, () => ({ status: 200, body: reply })]]);
	const r = await call("exchangeCode", { oauthVerifier: "v2", oauth_token: "rt2", requestTokenSecret: "rs2" });
	assert.strictEqual(r.username, "N1");
	assert.strictEqual(r.alias, undefined);
	assert.deepStrictEqual(r.credentials.common, { oauthToken: "a", oauthTokenSecret: "b", userId: "N1", username: null, fullname: null });
	assert.strictEqual(query(requests[0].url).oauth_verifier, "v2");
	assert.strictEqual(query(requests[0].url).oauth_token, "rt2");
	reply = "oauth_token=a&oauth_token_secret=b";
	assert.strictEqual((await call("exchangeCode", { verifier: "v3", requestToken: "rt", requestTokenSecret: "rs" })).username, "Flickr");
	assert.strictEqual(query(requests[1].url).oauth_verifier, "v3");
});

test("exchangeCode: no verifier, token or secret is MISSING_VERIFIER before any request; a refused exchange is an error", async () => {
	const { call, requests } = start([["GET", /access_token/, () => ({ status: 401, body: "oauth_problem=token_rejected" })]]);
	for (const a of [{}, { requestToken: "t", requestTokenSecret: "s" }, { oauth_verifier: "v", requestTokenSecret: "s" }, { oauth_verifier: "v", requestToken: "t" }]) {
		assert.strictEqual((await call("exchangeCode", a)).errorCode, "MISSING_VERIFIER", JSON.stringify(a));
	}
	assert.strictEqual(requests.length, 0);
	const r = await call("exchangeCode", { oauth_verifier: "v", requestToken: "t", requestTokenSecret: "s" });
	assert.deepStrictEqual(r, { returnValue: false, errorCode: "OAUTH_ACCESS_TOKEN_FAILED", errorText: "Flickr's access_token endpoint answered HTTP 401", status: 401 });
	const m = await start([["GET", /access_token/, () => ({ status: 200, body: "oauth_token=only" })]])
		.call("exchangeCode", { oauth_verifier: "v", requestToken: "t", requestTokenSecret: "s" });
	assert.strictEqual(m.errorCode, "OAUTH_ACCESS_TOKEN_MALFORMED");
});

// --- REST -----------------------------------------------------------------------------------------

test("checkCredentials: flickr.test.login signed with the account's token; the user's name", async () => {
	const { call, requests } = start([["GET", /services\/rest\/\?/, () => ({ status: 200,
		body: { user: { id: "12@N01", username: { _content: "flickr-name" } }, stat: "ok" } })]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: STORED } }, ACCOUNTS), { returnValue: true, username: "flickr-name" });
	const u = new URL(requests[0].url);
	assert.strictEqual(u.origin + u.pathname, REST);
	assertSigned(requests[0], "tsec-1", "tok-1");
	assert.deepStrictEqual(restParams(requests[0]), { method: "flickr.test.login", api_key: Config.CONSUMER_KEY, format: "json", nojsoncallback: "1" });
});

test("checkCredentials: the stored username without one in the reply; no token is 401_UNAUTHORIZED, without a request", async () => {
	const { call, requests } = start([["GET", /rest/, () => ({ status: 200, body: { stat: "ok" } })]]);
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: STORED } }), { returnValue: true, username: "uname" });
	for (const a of [{}, { credentials: {} }, { credentials: { common: { accessToken: "oauth2-shape" } } }, { accountId: "acc" }]) {
		assert.strictEqual((await call("checkCredentials", a)).errorCode, "401_UNAUTHORIZED", JSON.stringify(a));
	}
	assert.strictEqual(requests.length, 1);
});

test("REST errors: stat:fail is FLICKR_API_FAIL with Flickr's code and message; HTTP and JSON errors keep the token out", async () => {
	const fail = start([["GET", /rest/, () => ({ status: 200, body: { stat: "fail", code: 98, message: "Invalid auth token" } })]]);
	assert.deepStrictEqual(await fail.call("checkCredentials", { credentials: { common: STORED } }),
		{ returnValue: false, errorCode: "FLICKR_API_FAIL", errorText: "Flickr flickr.test.login failed (code 98): Invalid auth token" });
	const http = await start([["GET", /rest/, () => ({ status: 503, body: "busy" })]]).call("checkCredentials", { credentials: { common: STORED } });
	assert.deepStrictEqual(http, { returnValue: false, errorCode: "FLICKR_HTTP_ERROR", errorText: "Flickr answered HTTP 503: busy", status: 503 });
	const bad = await start([["GET", /rest/, () => ({ status: 200, body: "<html>" })]]).call("checkCredentials", { credentials: { common: STORED } });
	assert.strictEqual(bad.errorCode, "FLICKR_BAD_JSON");
	const net = await start([["GET", /rest/, () => { throw new Error("down"); }]]).call("checkCredentials", { credentials: { common: STORED } });
	assert.strictEqual(net.errorCode, "CURL_FAILED");
	for (const r of [http, bad, net]) { assert.doesNotMatch(JSON.stringify(r), /tok-1|tsec-1|oauth_/); }
});

// --- downloadFile ---------------------------------------------------------------------------------

test("downloadFile: only the Photos app; the URL fetched as is, unsigned; the bytes to localPath (folders 0755)", async () => {
	const BYTES = crypto.randomBytes(70000);
	const URL_ = "https://live.staticflickr.com/65535/123_abc_o.jpg";
	const { call, requests } = start([["GET", /live\.staticflickr\.com/, () => new Response(BYTES, { status: 200 })]]);
	for (const who of [{}, PHOTOS, ACCOUNTS, { appId: "org.webosports.app.photosX" }, { appId: "com.palm.app.photosX" }]) {
		assert.strictEqual((await call("downloadFile", { url: URL_, localPath: dl() }, who)).errorCode, "PERMISSION_DENIED", JSON.stringify(who));
	}
	assert.strictEqual(requests.length, 0);
	const dest = dl();
	assert.deepStrictEqual(await call("downloadFile", { url: URL_, localPath: dest }, PHOTOS_APP), { returnValue: true, path: dest });
	assert.ok(fs.readFileSync(dest).equals(BYTES));
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.deepStrictEqual(requests.map((q) => [q.method, q.url, q.headers]), [["GET", URL_, {}]]);
	for (const appId of ["org.webosports.app.photos 77", "org.webosports.app.photos-viewer"]) {
		assert.strictEqual((await call("downloadFile", { url: URL_, localPath: dl() }, { appId })).returnValue, true, appId);
	}
});

test("downloadFile: a 404 is DOWNLOAD_FAILED and leaves no file; MISSING_ARGS; anything but http(s) is refused unfetched", async () => {
	const { call, requests } = start([["GET", /./, () => ({ status: 404, body: "<html>not found</html>" })]]);
	const dest = dl();
	const r = await call("downloadFile", { url: "https://live.staticflickr.com/x.jpg", localPath: dest }, PHOTOS_APP);
	assert.strictEqual(r.errorCode, "DOWNLOAD_FAILED");
	assert.strictEqual(r.status, 404);
	assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + ".part"));
	assert.strictEqual((await call("downloadFile", { url: "https://x.example.test/a" }, PHOTOS_APP)).errorCode, "MISSING_ARGS");
	assert.strictEqual((await call("downloadFile", { localPath: dest }, PHOTOS_APP)).errorCode, "MISSING_ARGS");
	for (const url of ["file:///etc/shadow", "not a url", "ftp://x.example.test/a"]) {
		assert.strictEqual((await call("downloadFile", { url, localPath: dl() }, PHOTOS_APP)).errorCode, "BAD_ARGS", url);
	}
	assert.strictEqual((await call("downloadFile", { url: ["https://x"], localPath: dl() }, PHOTOS_APP)).errorCode, "BAD_ARGS");
	assert.strictEqual(requests.length, 1);
});

// --- photos ---------------------------------------------------------------------------------------

const SETS = { photosets: { photoset: [{ id: "721", title: { _content: "Holiday" }, photos: "12" }, { id: "722", title: {}, photos: 3 },
	{ id: "723", photos: "x" }] }, stat: "ok" };

test("listAlbums: \"All Photos\" (people.getPhotos per_page=1 for the count), then every photoset", async () => {
	const { call, requests, handle } = start([["GET", /rest/, (q) => (query(q.url).method === "flickr.photosets.getList"
		? { status: 200, body: SETS } : { status: 200, body: { photos: { total: "345", photo: [{}] }, stat: "ok" } })]]);
	assert.deepStrictEqual(await call("listAlbums", { accountId: "acc-1" }, PHOTOS), { returnValue: true, albums: [
		{ aid: "__all__", name: "All Photos", size: { images: 345 } },
		{ aid: "721", name: "Holiday", size: { images: 12 } },
		{ aid: "722", name: "722", size: { images: 3 } },
		{ aid: "723", name: "723", size: { images: 0 } }] });
	assert.deepStrictEqual(handle.calls, [{ uri: "luna://com.palm.service.accounts/readCredentials", args: { accountId: "acc-1", name: "common" } }]);
	assert.strictEqual(requests.length, 2);
	for (const q of requests) { assertSigned(q, "tsec-1", "tok-1"); }
	const base = { api_key: Config.CONSUMER_KEY, format: "json", nojsoncallback: "1", user_id: "me" };
	assert.deepStrictEqual(restParams(requests[0]), Object.assign({ method: "flickr.photosets.getList" }, base));
	assert.deepStrictEqual(restParams(requests[1]), Object.assign({ method: "flickr.people.getPhotos",
		extras: "url_o,url_b,url_c,o_dims,original_format,media,last_update", per_page: "1" }, base));
});

test("listAlbums: photosets that cannot be listed leave All Photos, an unreadable count is 0; credentials are needed", async () => {
	const { call } = start([["GET", /rest/, (q) => (query(q.url).method === "flickr.photosets.getList"
		? { status: 500, body: "" } : { status: 200, body: { photos: { total: 7 }, stat: "ok" } })]]);
	assert.deepStrictEqual((await call("listAlbums", { accountId: "acc" }, PHOTOS)).albums, [{ aid: "__all__", name: "All Photos", size: { images: 7 } }]);
	const none = start([["GET", /rest/, () => ({ status: 200, body: { stat: "fail", code: 1, message: "no" } })]]);
	assert.deepStrictEqual((await none.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums, [{ aid: "__all__", name: "All Photos", size: { images: 0 } }]);
	const odd = start([["GET", /rest/, () => ({ status: 200, body: "null" })]]);
	assert.strictEqual((await odd.call("listAlbums", { accountId: "acc" }, PHOTOS)).albums.length, 1);
	assert.strictEqual((await start([], { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await start([], { stored: { accessToken: "oauth2" } }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await start([]).call("listAlbums", {}, PHOTOS)).errorCode, "NO_CREDENTIALS");
});

test("listAlbums/listPhotos: inline credentials, without the Accounts service; stored ones nested under common", async () => {
	const { call, requests, handle } = start([["GET", /rest/, () => ({ status: 200, body: { stat: "ok" } })]]);
	await call("listPhotos", { credentials: { common: { oauthToken: "inline", oauthTokenSecret: "isec" } } }, PHOTOS);
	assertSigned(requests[0], "isec", "inline");
	assert.strictEqual(handle.calls.length, 0);
	const nested = start([["GET", /rest/, () => ({ status: 200, body: { stat: "ok" } })]], { stored: { common: STORED } });
	assert.strictEqual((await nested.call("listPhotos", { accountId: "acc" }, PHOTOS)).returnValue, true);
	assertSigned(nested.requests[0], "tsec-1", "tok-1");
});

const RAW = [
	{ id: "1", title: "Sunset", url_o: "https://live.staticflickr.com/1/1_s_o.png", url_b: "https://live.staticflickr.com/1/1_s_b.jpg" },
	{ id: "2", title: { _content: "Beach" }, url_b: "https://live.staticflickr.com/2/2_s_b.jpg?zz=1" },
	{ id: "3", title: "", url_c: "https://live.staticflickr.com/3/3_s_c" },
	{ id: "4", server: "65535", secret: "abc" },
	{ id: "5", media: "video", url_o: "https://live.staticflickr.com/5/5_v.mp4" },
	{ id: "6", title: "no url" },
	null,
];
const ENTRIES = [
	{ pid: "1", src_big: RAW[0].url_o, src_small: RAW[0].url_o, caption: "Sunset", type: "image", fileName: "1.png" },
	{ pid: "2", src_big: RAW[1].url_b, src_small: RAW[1].url_b, caption: "Beach", type: "image", fileName: "2.jpg" },
	{ pid: "3", src_big: RAW[2].url_c, src_small: RAW[2].url_c, caption: "", type: "image", fileName: "3.jpg" },
	{ pid: "4", src_big: "https://live.staticflickr.com/65535/4_abc_b.jpg", src_small: "https://live.staticflickr.com/65535/4_abc_b.jpg",
		caption: "", type: "image", fileName: "4.jpg" },
];

test("listPhotos: All Photos is people.getPhotos per_page=500; the photos mapped, the best URL first, videos left out", async () => {
	const { call, requests } = start([["GET", /rest/, () => ({ status: 200, body: { photos: { photo: RAW }, stat: "ok" } })]]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc" }, PHOTOS), { returnValue: true, photos: ENTRIES });
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "__all__" }, PHOTOS), { returnValue: true, photos: ENTRIES });
	for (const q of requests) {
		assertSigned(q, "tsec-1", "tok-1");
		assert.deepStrictEqual(restParams(q), { method: "flickr.people.getPhotos", api_key: Config.CONSUMER_KEY, format: "json",
			nojsoncallback: "1", user_id: "me", extras: "url_o,url_b,url_c,o_dims,original_format,media,last_update", per_page: "500" });
	}
});

test("listPhotos: a photoset is photosets.getPhotos with its id, encoded and signed", async () => {
	const { call, requests } = start([["GET", /rest/, () => ({ status: 200, body: { photoset: { id: "721", photo: RAW.slice(0, 2) }, stat: "ok" } })]]);
	assert.deepStrictEqual((await call("listPhotos", { accountId: "acc", aid: "721" }, PHOTOS)).photos, ENTRIES.slice(0, 2));
	assert.deepStrictEqual(restParams(requests[0]), { method: "flickr.photosets.getPhotos", api_key: Config.CONSUMER_KEY, format: "json",
		nojsoncallback: "1", photoset_id: "721", user_id: "me", extras: "url_o,url_b,url_c,o_dims,original_format,media,last_update", per_page: "500" });
	await call("listPhotos", { accountId: "acc", aid: "Café (1)!*" }, PHOTOS);
	assert.match(requests[1].url, /photoset_id=Caf%C3%A9%20%281%29%21%2A&/);
	assertSigned(requests[1], "tsec-1", "tok-1");
	// An id that cannot be encoded fails the listing, which is absorbed like any other failure.
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "\ud800" }, PHOTOS), { returnValue: true, photos: [] });
	assert.strictEqual(requests.length, 2);
});

test("listPhotos: an album that cannot be listed has no photos (not an error); no credentials is an error", async () => {
	const { call } = start([["GET", /rest/, () => ({ status: 200, body: { stat: "fail", code: 1, message: "Photoset not found" } })]]);
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "9" }, PHOTOS), { returnValue: true, photos: [] });
	const odd = start([["GET", /rest/, () => ({ status: 200, body: { photos: { photo: { not: "a list" } }, stat: "ok" } })]]);
	assert.deepStrictEqual(await odd.call("listPhotos", { accountId: "acc" }, PHOTOS), { returnValue: true, photos: [] });
	assert.strictEqual((await start([], { stored: null }).call("listPhotos", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

// --- every request failing, in turn ----------------------------------------------------------

// What Flickr answers when nothing fails.
function happy(q) {
	const u = q.url;
	if (/request_token\?/.test(u)) { return { status: 200, body: "oauth_token=rt&oauth_token_secret=rs" }; }
	if (/access_token\?/.test(u)) { return { status: 200, body: "oauth_token=at&oauth_token_secret=as&username=u" }; }
	if (/staticflickr/.test(u)) { return new Response(Buffer.from("bytes"), { status: 200 }); }
	const m = query(u).method;
	if (m === "flickr.test.login") { return { status: 200, body: { user: { username: { _content: "u" } }, stat: "ok" } }; }
	if (m === "flickr.photosets.getList") { return { status: 200, body: SETS }; }
	if (m === "flickr.photosets.getPhotos") { return { status: 200, body: { photoset: { photo: RAW }, stat: "ok" } }; }
	return { status: 200, body: { photos: { total: 3, photo: RAW }, stat: "ok" } };
}

// How the failing request fails. Flickr has no refresh, so a 401 is just the error.
const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401": () => ({ status: 401, body: "oauth_problem=token_rejected" }),
	"a reply that is not JSON (or not a token form)": () => ({ status: 200, body: "<html>" }),
	"stat:fail": () => ({ status: 200, body: { stat: "fail", code: 98, message: "Invalid auth token" } }),
};
const BYTES_OK = new Set(["a reply that is not JSON (or not a token form)", "stat:fail"]);

// [label, payload, caller, { minSteps, tolerated(k, mode) -> true when request k failing is absorbed }]
const OPS = [
	["getAuthorizeUrl", {}, {}],
	["exchangeCode", { oauth_verifier: "v", requestToken: "rt", requestTokenSecret: "rs" }, ACCOUNTS],
	["checkCredentials", { credentials: { common: STORED } }, ACCOUNTS],
	["downloadFile", () => ({ url: "https://live.staticflickr.com/1/1_s_o.jpg", localPath: dl() }), PHOTOS_APP,
		{ tolerated: (k, mode) => BYTES_OK.has(mode) }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
	["listPhotos", { accountId: "acc" }, PHOTOS, { tolerated: () => true }],
	["listPhotos (photoset)", { accountId: "acc", aid: "721" }, PHOTOS, { tolerated: () => true }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`flickr ${label}: any request failing (${mode}) is one reply${opts.tolerated ? "" : ", an error"}`, async () => {
			let reached = 0;
			for (let k = 1; k <= 10; k++) {
				let n = 0;
				const { call } = start([["GET", /./, (q) => { n++; return n === k ? fail(q) : happy(q); }]],
					{ timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
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
					assert.doesNotMatch(JSON.stringify(r), /tok-1|tsec-1|oauth_signature/, "no token in the error");
				} else {
					assert.notStrictEqual(r.errorCode, "CONNECTOR_EXCEPTION", JSON.stringify(r));
				}
			}
			assert.ok(reached >= (opts.minSteps || 1), `only ${reached} of ${opts.minSteps || 1} steps were failed`);
		});
	}
}

test("the Accounts service failing or not answering JSON is one error reply", async () => {
	const denied = start([], { onCall: () => ({ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" }) });
	assert.deepStrictEqual(await denied.call("listAlbums", { accountId: "acc" }, PHOTOS),
		{ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" });
	const broken = start([], { onCall: () => "not json" });
	assert.strictEqual((await broken.call("listPhotos", { accountId: "acc" }, PHOTOS)).errorCode, "BUS_BAD_REPLY");
});

test("a payload that is not a JSON object is BAD_ARGS; an unknown method NOT_SUPPORTED", async () => {
	const { call } = start([]);
	assert.strictEqual((await call("listAlbums", "[]", PHOTOS)).errorCode, "BAD_ARGS");
	assert.strictEqual((await call("listAlbums", "{", PHOTOS)).errorCode, "BAD_ARGS");
	assert.strictEqual((await call("listFolder", {}, PHOTOS)).errorCode, "NOT_SUPPORTED");
});
