// node --test tests/unit
// The PiGallery2 connector (cloud/pigallery2/service/com.palm.service.pigallery2) as the launcher
// runs it: service.js started on a stand-in palmbus, with a stand-in fetch that records every
// request. Each method is called over the bus as its real caller would call it, and checked for
// the requests it makes (endpoint, headers, body), its reply, and its errors; the Accounts service
// is answered by the stand-in bus.
//
// The reply shapes are PiGallery2's as a 3.5.2 server gave them: every reply { error, result };
// /user/me without a session a 401 with { error:{ code:1 } } (an open gallery: 200, the user);
// /user/login a 200 either way, { result: user } and the two session cookies, or { error:{ code:5 } };
// /gallery/content/<dir> { result:{ directory:{ name, path, directories:[{ name, path }], media:[{ n,
// m:{ d, s, t, a? } }] } } } (a video's m has bitRate and duration), an unknown folder a 404.
//
// The last part fails every request of every method in turn, in each way a request can fail,
// and checks the method still answers exactly once.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/pigallery2/service/com.palm.service.pigallery2");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const login = require(path.join(SVC, "login.js"));
const adapter = require(path.join(SVC, "adapter.js"));
const photos = require(path.join(SVC, "photos.js"));

const PHOTOS = { service: "com.palm.service.photos" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const SIGN_IN = { appId: "com.palm.app.accounts 3" };
const SERVER = "https://gallery.example.test";
const API = SERVER + "/pgapi";
const PASSWORD = "pass word+&=1";
const SESS = "eyJjb250ZXh0Ijp7InVzZXIiOnsiaWQiOjF9fX0=";
const SIG = "K4TMVFS1Amy02GuJ6KP5P3pzDr8";
const COOKIE = "pigallery2-session=" + SESS + "; pigallery2-session.sig=" + SIG;
const USER = { id: 1, name: "jane", role: 4, projectionKey: "26b85f16832ca3a27b70f5af28c98534" };
const STORED = { server: SERVER, username: "jane", password: PASSWORD, open: false, name: "jane" };
const OPEN = { server: SERVER, open: true, name: "gallery.example.test" };

const ok = (result, headers) => ({ status: 200, body: { error: null, result }, headers });
const pgError = (status, code, message) => ({ status, body: { error: { code, message, request: { method: "", url: "" } }, result: null } });
const SET_COOKIES = [["Set-Cookie", "pigallery2-session=" + SESS + "; path=/; expires=Thu, 11 Nov 2027 15:24:00 GMT; httponly"],
	["Set-Cookie", "pigallery2-session.sig=" + SIG + "; path=/; expires=Thu, 11 Nov 2027 15:24:00 GMT; httponly"]];

// A media entry as a listing packs it; a video has bitRate and duration.
const jpg = (n, extra) => ({ n, m: Object.assign({ d: [2560, 1600], s: 480748, t: 1430318011.5 }, extra) });
const video = (n) => ({ n, m: { d: [320, 240], s: 7613, t: 1793805832, bitRate: 21000, duration: 1000 } });
// The gallery: folder path -> { dirs: [names], media: [entries] }
const TREE = {
	"": { dirs: ["Empty", "Family", "Holidays"], media: [jpg("top.jpg")] },
	"Empty": { dirs: ["Deeper"], media: [] },
	"Empty/Deeper": { dirs: [], media: [video("only.mp4")] },
	"Family": { dirs: [], media: [jpg("a.jpg", { a: "Grandma" }), jpg("b.JPG")] },
	"Holidays": { dirs: ["2025 Italy", "2026 Alps"], media: [] },
	"Holidays/2025 Italy": { dirs: ["Rome"], media: [jpg("beach.jpg"), video("sea.mp4"), jpg("clip.mov"), video("talk.mxf")] },
	"Holidays/2025 Italy/Rome": { dirs: [], media: [jpg("colosseum #1.jpg"), jpg("scan.tiff"), jpg("raw.HEIC", { t: 0 })] },
	"Holidays/2026 Alps": { dirs: [], media: [jpg("peak.png")] },
};

// A folder's listing as PiGallery2 sends it: its sub-folders with path "<dir>/" ("./" at the top).
function listing(tree, dir) {
	const f = tree[dir];
	const parentPath = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "./" : p.slice(0, i) + "/"; };
	const name = dir === "" ? "." : dir.split("/").pop();
	return { map: { camera: ["Nokia\u00002", "N9"] }, directory: { name, path: dir === "" ? "./" : parentPath(dir),
		lastModified: 1793805832594, isPartial: false, media: f.media,
		directories: f.dirs.map((d) => ({ name: d, path: dir === "" ? "./" : dir + "/", lastModified: 1793805832579, isPartial: true,
			cache: { mediaCount: (tree[dir ? dir + "/" + d : d] || { media: [] }).media.length } })) } };
}
const dirOf = (q) => decodeURIComponent(new URL(q.url).pathname.replace(/^\/pgapi\/gallery\/content\/?/, "")).replace(/\/$/, "");
const hasSession = (q) => q.headers.Cookie === COOKIE;

// The routes of a server that wants a sign-in (open: one that does not).
function routes({ tree = TREE, open = false, password = PASSWORD } = {}) {
	return [
		["GET", /\/pgapi\/user\/me$/, (q) => (open || hasSession(q) ? ok(USER) : pgError(401, 1, "Not authenticated"))],
		["POST", /\/pgapi\/user\/login$/, (q) => {
			if (open) { return { status: 404, body: "Not Found" }; }
			const c = JSON.parse(q.body).loginCredential;
			return c.username === "jane" && c.password === password ? ok(USER, SET_COOKIES) : pgError(200, 5, "credentials not found during login");
		}],
		["GET", /\/pgapi\/gallery\/content\//, (q) => {
			if (!open && !hasSession(q)) { return pgError(401, 11, "Not authenticated sharing"); }
			const dir = dirOf(q);
			return tree[dir] ? ok(listing(tree, dir)) : { status: 404, body: "<pre>Cannot GET</pre>" };
		}],
	];
}

// The service on a stand-in bus. fetch's init is recorded too (redirect). Accounts:
// readCredentials gives `stored`. -> { handle, requests, inits, call(method, payload, caller) }
function start(rts, { stored = STORED, timeouts, now, logs } = {}) {
	const f = fakeFetch(rts);
	const inits = [];
	const fetch = (url, init = {}) => { inits.push(init); return f.fetch(url, init); };
	const pb = fakePalmbus({ onCall: (uri) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: Object.assign({}, stored) } : { returnValue: true }; }
		return { returnValue: false, errorCode: -1, errorText: "Unknown service" };
	} });
	const log = { log: (m) => { if (logs) { logs.push(String(m)); } }, error: (m) => { if (logs) { logs.push(String(m)); } } };
	const s = service.start({ palmbus: pb, fetch, idleMs: 0, exit: () => {}, log, timeouts, now });
	const handle = pb.handles[0];
	return { s, handle, requests: f.requests, inits, call: (method, payload, caller = {}) => ask(handle, method, payload, caller) };
}

const pathOf = (q) => { const u = new URL(q.url); return u.origin + u.pathname; };
const logins = (requests) => requests.filter((q) => q.method === "POST" && /\/user\/login$/.test(q.url));
const leaks = (r, secrets) => secrets.filter((s) => JSON.stringify(r).includes(s) || JSON.stringify(r).includes(encodeURIComponent(s)));

// --- the service --------------------------------------------------------------------------------

test("the service: its bus name and methods", () => {
	const { handle } = start([]);
	assert.strictEqual(handle.name, "com.palm.service.pigallery2");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "info", "listAlbums", "listPhotos", "login", "quit"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
});

test("the server address: a scheme added, slashes, the app's pages and /pgapi cut, anything but http(s) refused", () => {
	const n = login.normalizeServer;
	assert.strictEqual(n("gallery.example.org"), "https://gallery.example.org");
	assert.strictEqual(n(" https://gallery.example.org/ "), "https://gallery.example.org");
	assert.strictEqual(n("http://192.168.1.5:3000/pgapi"), "http://192.168.1.5:3000");
	assert.strictEqual(n("https://gallery.example.org/gallery/Holidays/2025%20Italy"), "https://gallery.example.org");
	assert.strictEqual(n("https://gallery.example.org/search/%7B%22type%22%3A100%7D"), "https://gallery.example.org");
	assert.strictEqual(n("https://example.org/pg/login"), "https://example.org/pg");
	assert.strictEqual(n("https://example.org/pg?x=1#y"), "https://example.org/pg");
	assert.strictEqual(n("https://example.org/my-gallery-photos"), "https://example.org/my-gallery-photos", "a page name inside a word is no page");
	assert.strictEqual(n("HTTPS://Example.ORG"), "https://example.org");
	for (const bad of ["", "   ", "ftp://example.org", "https://user:pw@example.org", "javascript:alert(1)", "https://", null]) {
		assert.strictEqual(n(bad), null, String(bad));
	}
	assert.strictEqual(login.redirectedServer("http://a.test", "https://a.test/pgapi/user/me", Config), "https://a.test");
	assert.strictEqual(login.redirectedServer("http://a.test", "/sub/pgapi/user/me", Config), "http://a.test/sub");
	assert.strictEqual(login.redirectedServer("http://a.test", "https://a.test/login", Config), null);
	assert.strictEqual(login.redirectedServer("http://a.test", "https://b.test/pgapi/user/me", Config), null);
});

test("gallery paths: joined from a listing, encoded part by part; aids checked", () => {
	assert.strictEqual(photos.joinPath("./", "Family"), "Family");
	assert.strictEqual(photos.joinPath("Holidays/", "2025 Italy"), "Holidays/2025 Italy");
	assert.strictEqual(photos.joinPath("Holidays/2025 Italy/", "Rome"), "Holidays/2025 Italy/Rome");
	assert.strictEqual(photos.joinPath("./", ".."), null);
	assert.strictEqual(photos.joinPath("a/../", "b"), null);
	assert.strictEqual(adapter.encodePath("Holidays/2025 Italy/colosseum #1.jpg"), "Holidays/2025%20Italy/colosseum%20%231.jpg");
	assert.strictEqual(adapter.encodePath("a?b/c&d%"), "a%3Fb/c%26d%25");
	assert.strictEqual(adapter.encodePath(""), "");
	assert.strictEqual(photos.folderOf("/"), "");
	assert.strictEqual(photos.folderOf("Holidays/2025 Italy"), "Holidays/2025 Italy");
	for (const bad of ["", "/Holidays", "Holidays/", "a//b", "a/../b", "..", ".", "./a", null, 5, {}]) {
		assert.strictEqual(photos.folderOf(bad), null, JSON.stringify(bad));
	}
});

test("the session cookies: both or none, nothing else taken", () => {
	const h = (lines) => new Headers(lines);
	assert.strictEqual(adapter.sessionCookie(h(SET_COOKIES)), COOKIE);
	assert.strictEqual(adapter.sessionCookie(h(SET_COOKIES.concat([["Set-Cookie", "tracker=1; path=/"]]))), COOKIE);
	assert.strictEqual(adapter.sessionCookie(h([SET_COOKIES[0]])), "", "no signature: no session");
	assert.strictEqual(adapter.sessionCookie(h([])), "");
	assert.strictEqual(adapter.sessionCookie(null), "");
});

// --- login ----------------------------------------------------------------------------------------

test("login: asks who it is without a session, signs in, lists the top folder with the session", async () => {
	const logs = [];
	const { call, requests, inits } = start(routes(), { logs });
	const r = await call("login", { server: "gallery.example.test/gallery/Holidays", username: " jane ", password: PASSWORD }, SIGN_IN);
	assert.deepStrictEqual(r, { returnValue: true, username: "jane@gallery.example.test", alias: "jane",
		credentials: { common: STORED } });
	assert.deepStrictEqual(requests.map((q) => q.method + " " + pathOf(q)),
		["GET " + API + "/user/me", "POST " + API + "/user/login", "GET " + API + "/gallery/content/"]);
	assert.strictEqual(requests[0].headers.Cookie, undefined, "nothing secret before the address is settled");
	assert.deepStrictEqual(JSON.parse(requests[1].body), { loginCredential: { username: "jane", password: PASSWORD, rememberMe: true } });
	assert.strictEqual(requests[2].headers.Cookie, COOKIE);
	assert.ok(inits.every((i) => i.redirect === "manual"), "no request follows a redirect");
	assert.deepStrictEqual(leaks(logs, [PASSWORD, SESS, SIG]), [], "neither the password nor the session in the log");
});

test("login: an open gallery keeps nothing secret and signs nobody in", async () => {
	const { call, requests } = start(routes({ open: true }));
	for (const creds of [{ username: "", password: "" }, { username: "jane", password: PASSWORD }]) {
		requests.length = 0;
		const r = await call("login", Object.assign({ server: SERVER }, creds), SIGN_IN);
		assert.deepStrictEqual(r, { returnValue: true, username: "gallery.example.test", alias: "gallery.example.test",
			credentials: { common: OPEN } });
		assert.deepStrictEqual(logins(requests), []);
		assert.deepStrictEqual(leaks(r, [PASSWORD]), []);
	}
});

test("login: a wrong password, no sign-in for a gallery that wants one, no gallery there", async () => {
	let { call } = start(routes());
	let r = await call("login", { server: SERVER, username: "jane", password: "wrong" }, SIGN_IN);
	assert.strictEqual(r.errorCode, "PIGALLERY2_AUTH_FAILED");
	assert.strictEqual(r.status, 401);
	r = await call("login", { server: SERVER, username: "", password: "" }, SIGN_IN);
	assert.strictEqual(r.errorCode, "PIGALLERY2_SIGN_IN_NEEDED");
	r = await call("login", { server: SERVER, username: "jane" }, SIGN_IN);
	assert.strictEqual(r.errorCode, "PIGALLERY2_SIGN_IN_NEEDED");
	assert.strictEqual((await call("login", { username: "jane", password: PASSWORD }, SIGN_IN)).errorCode, "MISSING_CREDENTIALS");
	assert.strictEqual((await call("login", { server: "ftp://x.test", username: "jane", password: PASSWORD }, SIGN_IN)).errorCode, "BAD_SERVER");

	for (const [label, reply] of [["a web page", { status: 200, body: "<html>hello</html>" }], ["a 404", { status: 404, body: "Not Found" }],
		["some other JSON", { status: 200, body: { status: "ok" } }], ["a 403", { status: 403, body: "no" }]]) {
		({ call } = start([["GET", /./, () => reply]]));
		r = await call("login", { server: SERVER, username: "jane", password: PASSWORD }, SIGN_IN);
		assert.strictEqual(r.errorCode, "PIGALLERY2_NOT_FOUND", label + ": " + JSON.stringify(r));
	}
	({ call } = start([["GET", /./, () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }]]));
	r = await call("login", { server: SERVER, username: "jane", password: PASSWORD }, SIGN_IN);
	assert.strictEqual(r.errorCode, "PIGALLERY2_UNREACHABLE");
	({ call } = start([["GET", /./, () => { throw Object.assign(new Error("SSL routines:ssl3_get_record:wrong version number"), { code: "EPROTO" }); }]]));
	r = await call("login", { server: SERVER, username: "jane", password: PASSWORD }, SIGN_IN);
	assert.match(r.errorText, /http:\/\//, "a hint to try plain http");
});

test("login: a session without its signature, or a user who may see no folder, is refused", async () => {
	let rts = routes();
	rts[1] = ["POST", /\/user\/login$/, () => ok(USER, [SET_COOKIES[0]])];
	let { call } = start(rts);
	assert.strictEqual((await call("login", { server: SERVER, username: "jane", password: PASSWORD }, SIGN_IN)).errorCode, "PIGALLERY2_NO_SESSION");
	rts = routes({ tree: {} });
	({ call } = start(rts));
	assert.strictEqual((await call("login", { server: SERVER, username: "jane", password: PASSWORD }, SIGN_IN)).errorCode, "PIGALLERY2_NO_ACCESS");
	({ call } = start(routes({ tree: {}, open: true })));
	assert.strictEqual((await call("login", { server: SERVER }, SIGN_IN)).errorCode, "PIGALLERY2_NO_ACCESS");
});

test("login: one redirect on the same host is followed before the password goes anywhere; others are refused", async () => {
	const moved = (to) => ["GET", /^http:\/\/gallery\.example\.test\/pgapi\/user\/me$/, () => ({ status: 301, headers: { Location: to } })];
	let { call, requests } = start([moved(API + "/user/me")].concat(routes()));
	let r = await call("login", { server: "http://gallery.example.test", username: "jane", password: PASSWORD }, SIGN_IN);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.credentials.common.server, SERVER, "the address it leads to is kept");
	assert.ok(requests.slice(1).every((q) => q.url.startsWith(SERVER + "/")), "everything after it goes there");

	({ call, requests } = start([moved("https://elsewhere.test/pgapi/user/me")].concat(routes())));
	r = await call("login", { server: "http://gallery.example.test", username: "jane", password: PASSWORD }, SIGN_IN);
	assert.strictEqual(r.errorCode, "PIGALLERY2_NOT_FOUND");
	assert.deepStrictEqual(logins(requests), [], "no password sent");

	({ call, requests } = start([["GET", /\/user\/me$/, () => ({ status: 302, headers: { Location: API + "/user/me" } })]]));
	r = await call("login", { server: "http://gallery.example.test", username: "jane", password: PASSWORD }, SIGN_IN);
	assert.strictEqual(r.errorCode, "PIGALLERY2_NOT_FOUND", "it redirects again");
	assert.deepStrictEqual(logins(requests), []);
});

// --- checkCredentials -----------------------------------------------------------------------------

test("checkCredentials: the stored sign-in opens a session; an open gallery still lets anyone in", async () => {
	let { call, requests } = start(routes());
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: STORED } }, ACCOUNTS), { returnValue: true, username: "jane" });
	assert.strictEqual(logins(requests).length, 1);
	const r = await call("checkCredentials", { credentials: { common: Object.assign({}, STORED, { password: "changed" }) } }, ACCOUNTS);
	assert.strictEqual(r.returnValue, false);
	assert.strictEqual(r.status, 401);
	assert.strictEqual((await call("checkCredentials", { credentials: { common: { server: SERVER } } }, ACCOUNTS)).errorCode, "401_UNAUTHORIZED");
	({ call, requests } = start(routes({ open: true })));
	assert.deepStrictEqual(await call("checkCredentials", { credentials: { common: OPEN } }, ACCOUNTS), { returnValue: true, username: "gallery.example.test" });
	assert.deepStrictEqual(logins(requests), []);
});

// --- listAlbums -----------------------------------------------------------------------------------

test("listAlbums: every folder with photos in or below it, the folder it is in as parentAid", async () => {
	const { call, requests } = start(routes());
	const r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	const byAid = new Map(r.albums.map((a) => [a.aid, a]));
	assert.deepStrictEqual([...byAid.keys()].sort(), ["/", "Family", "Holidays", "Holidays/2025 Italy", "Holidays/2025 Italy/Rome", "Holidays/2026 Alps"]);
	assert.deepStrictEqual(byAid.get("/"), { aid: "/", name: Config.ROOT_ALBUM_NAME, size: { images: 1 } }, "the top folder: its own photos, no children");
	assert.deepStrictEqual(byAid.get("Family"), { aid: "Family", name: "Family", size: { images: 2 } }, "top level: no parentAid");
	assert.deepStrictEqual(byAid.get("Holidays"), { aid: "Holidays", name: "Holidays", size: { images: 0 } }, "only sub-albums");
	assert.deepStrictEqual(byAid.get("Holidays/2025 Italy"), { aid: "Holidays/2025 Italy", name: "2025 Italy", size: { images: 1 }, parentAid: "Holidays" },
		"videos, by their metadata or name, not counted");
	assert.deepStrictEqual(byAid.get("Holidays/2025 Italy/Rome"), { aid: "Holidays/2025 Italy/Rome", name: "Rome", size: { images: 3 }, parentAid: "Holidays/2025 Italy" });
	assert.ok(!byAid.has("Empty") && !byAid.has("Empty/Deeper"), "no photos in or below: left out");
	assert.deepStrictEqual(logins(requests).length, 1, "one session for the whole walk");
	assert.ok(requests.filter((q) => /gallery\/content/.test(q.url)).every(hasSession));
	assert.strictEqual(requests.filter((q) => /gallery\/content/.test(q.url)).length, Object.keys(TREE).length, "each folder read once");
});

test("listAlbums: without photos of its own, the top folder is no album; an open gallery is walked without a session", async () => {
	const tree = Object.assign({}, TREE, { "": { dirs: ["Family"], media: [video("v.mp4")] } });
	const { call, requests } = start(routes({ tree, open: true }), { stored: OPEN });
	const r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.deepStrictEqual(r.albums, [{ aid: "Family", name: "Family", size: { images: 2 } }]);
	assert.deepStrictEqual(logins(requests), []);
	assert.ok(requests.every((q) => q.headers.Cookie === undefined));
});

test("listAlbums: at most CONCURRENCY folders at a time, at most MAX_ALBUMS folders", async () => {
	const tree = { "": { dirs: [], media: [] } };
	for (let i = 0; i < 30; i++) {
		tree[""].dirs.push("d" + i);
		tree["d" + i] = { dirs: ["sub"], media: [jpg("p.jpg")] };
		tree["d" + i + "/sub"] = { dirs: [], media: [jpg("q.jpg")] };
	}
	let active = 0, most = 0;
	const rts = routes({ tree });
	const list = rts[2][2];
	rts[2] = ["GET", /\/pgapi\/gallery\/content\//, async (q) => {
		active++; most = Math.max(most, active);
		await new Promise((r) => setTimeout(r, 2));
		active--;
		return list(q);
	}];
	let { call } = start(rts);
	let r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.strictEqual(r.albums.length, 60);
	assert.strictEqual(most, Config.CONCURRENCY, "folders read side by side, never more than CONCURRENCY");

	const max = Config.MAX_ALBUMS;
	Config.MAX_ALBUMS = 11;
	try {
		const logs = [];
		({ call } = start(routes({ tree }), { logs }));
		r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
		assert.strictEqual(r.returnValue, true);
		assert.strictEqual(r.albums.length, 10, "the top folder and ten more read");
		assert.ok(r.albums.every((a) => !a.parentAid || r.albums.some((b) => b.aid === a.parentAid)), "no album's parent is left out");
		assert.ok(logs.some((m) => /more than 11 folders/.test(m)));
	} finally { Config.MAX_ALBUMS = max; }
});

test("listAlbums: a folder gone since its parent was read is left out; one that cannot be read fails the call", async () => {
	const tree = Object.assign({}, TREE);
	delete tree["Holidays/2026 Alps"];
	let { call } = start(routes({ tree }));
	let r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.strictEqual(r.returnValue, true);
	assert.ok(!r.albums.some((a) => a.aid === "Holidays/2026 Alps"));
	assert.ok(r.albums.some((a) => a.aid === "Holidays"));

	const rts = routes();
	const list = rts[2][2];
	rts[2] = ["GET", /\/pgapi\/gallery\/content\//, (q) => (dirOf(q) === "Holidays/2025 Italy" ? { status: 500, body: "{}" } : list(q))];
	({ call } = start(rts));
	r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.strictEqual(r.returnValue, false, "an unread folder is not an emptied one");
	assert.strictEqual(r.status, 500);
	({ call } = start(routes({ tree: {} })));
	r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.strictEqual(r.returnValue, false, "no top folder");
});

test("listAlbums: a folder that lists itself, or one twice, is walked once", async () => {
	const tree = { "": { dirs: ["a", "a"], media: [] }, "a": { dirs: [], media: [jpg("p.jpg")] } };
	const rts = routes({ tree });
	const list = rts[2][2];
	rts[2] = ["GET", /\/pgapi\/gallery\/content\//, (q) => {
		const r = list(q);
		if (dirOf(q) === "a") { r.body.result.directory.directories = [{ name: "", path: "a/" }, { name: "..", path: "a/" }]; }
		return r;
	}];
	const { call, requests } = start(rts);
	const r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.deepStrictEqual(r.albums, [{ aid: "a", name: "a", size: { images: 1 } }]);
	assert.strictEqual(requests.filter((q) => /gallery\/content/.test(q.url)).length, 2);
});

// --- sessions ---------------------------------------------------------------------------------

test("sessions: kept across calls, renewed when refused or when older than SESSION_MAX_AGE_MS", async () => {
	let t = 1000000;
	const rts = routes();
	let refuse = false;
	const list = rts[2][2];
	rts[2] = ["GET", /\/pgapi\/gallery\/content\//, (q) => (refuse ? pgError(401, 1, "Not authenticated") : list(q))];
	const { call, requests } = start(rts, { now: () => t });
	await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS);
	await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS);
	assert.strictEqual(logins(requests).length, 1, "one session for both");
	t += Config.SESSION_MAX_AGE_MS;
	await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS);
	assert.strictEqual(logins(requests).length, 2, "an old one is not used");
	// Refused once (the server's secret changed, say): a new session, the call made again
	let once = true;
	rts[2] = ["GET", /\/pgapi\/gallery\/content\//, (q) => (once ? (once = false, pgError(401, 1, "Not authenticated")) : list(q))];
	const r = await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(logins(requests).length, 3);
	// Any other failure is no reason for a new session
	rts[2] = ["GET", /\/pgapi\/gallery\/content\//, () => ({ status: 500, body: "{}" })];
	assert.strictEqual((await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS)).status, 500);
	assert.strictEqual(logins(requests).length, 3);
	// Refused with a new one too: an error, and not a loop of sign-ins
	refuse = true;
	rts[2] = ["GET", /\/pgapi\/gallery\/content\//, () => pgError(401, 1, "Not authenticated")];
	const r2 = await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS);
	assert.strictEqual(r2.returnValue, false);
	assert.strictEqual(r2.status, 401);
	assert.strictEqual(logins(requests).length, 4);
});

// --- listPhotos -----------------------------------------------------------------------------------

test("listPhotos: a folder's photos, originals or thumbnails, and the session for their download", async () => {
	const { call } = start(routes());
	const r = await call("listPhotos", { accountId: "acc", aid: "Holidays/2025 Italy/Rome" }, PHOTOS);
	const base = API + "/gallery/content/Holidays/2025%20Italy/Rome/";
	assert.deepStrictEqual(r, { returnValue: true, headers: { Cookie: COOKIE }, photos: [
		{ pid: "Holidays/2025 Italy/Rome/colosseum #1.jpg", src_big: base + "colosseum%20%231.jpg", src_small: base + "colosseum%20%231.jpg/" + Config.THUMB_SMALL,
			caption: "", type: "image", fileName: "colosseum #1.jpg", createdTime: 1430318011 },
		{ pid: "Holidays/2025 Italy/Rome/scan.tiff", src_big: base + "scan.tiff/" + Config.THUMB_BIG, src_small: base + "scan.tiff/" + Config.THUMB_SMALL,
			caption: "", type: "image", fileName: "scan.jpg", createdTime: 1430318011 },
		{ pid: "Holidays/2025 Italy/Rome/raw.HEIC", src_big: base + "raw.HEIC/" + Config.THUMB_BIG, src_small: base + "raw.HEIC/" + Config.THUMB_SMALL,
			caption: "", type: "image", fileName: "raw.jpg" },
	] });
	const fam = await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS);
	assert.deepStrictEqual(fam.photos.map((p) => [p.fileName, p.caption, p.src_big.slice(API.length)]),
		[["a.jpg", "Grandma", "/gallery/content/Family/a.jpg"], ["b.JPG", "", "/gallery/content/Family/b.JPG"]], "an upper-case .JPG is an original too");
	const it = await call("listPhotos", { accountId: "acc", aid: "Holidays/2025 Italy" }, PHOTOS);
	assert.deepStrictEqual(it.photos.map((p) => p.pid), ["Holidays/2025 Italy/beach.jpg"], "no video");
	const top = await call("listPhotos", { accountId: "acc", aid: "/" }, PHOTOS);
	assert.deepStrictEqual(top.photos.map((p) => [p.pid, p.src_big]), [["top.jpg", API + "/gallery/content/top.jpg"]]);
});

test("listPhotos: an open gallery hands over no headers; a folder gone has no photos; a bad aid is BAD_ARGS", async () => {
	let { call, requests } = start(routes({ open: true }), { stored: OPEN });
	const r = await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS);
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.headers, undefined);
	assert.strictEqual(r.photos.length, 2);
	({ call, requests } = start(routes()));
	assert.deepStrictEqual(await call("listPhotos", { accountId: "acc", aid: "Gone/Away" }, PHOTOS), { returnValue: true, photos: [] });
	for (const aid of ["", "/etc", "a/../../x", "..", undefined, 7]) {
		requests.length = 0;
		const b = await call("listPhotos", { accountId: "acc", aid }, PHOTOS);
		assert.strictEqual(b.errorCode, "BAD_ARGS", JSON.stringify(aid));
		assert.deepStrictEqual(requests, [], "nothing asked");
	}
});

test("a redirect is not followed: the call fails saying so", async () => {
	const rts = routes();
	rts[2] = ["GET", /\/pgapi\/gallery\/content\//, () => ({ status: 302, headers: { Location: "https://elsewhere.test/" } })];
	const { call, inits } = start(rts);
	const r = await call("listPhotos", { accountId: "acc", aid: "Family" }, PHOTOS);
	assert.strictEqual(r.errorCode, "PIGALLERY2_HTTP_ERROR");
	assert.strictEqual(r.status, 302);
	assert.match(r.errorText, /redirect/);
	assert.ok(inits.every((i) => i.redirect === "manual"));
});

test("credentials: an account without a stored sign-in is an error, before anything is asked", async () => {
	const { call, requests } = start(routes(), { stored: { server: SERVER, username: "jane" } });
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
	assert.strictEqual((await call("listAlbums", {}, PHOTOS)).errorCode, "NO_CREDENTIALS");
	assert.deepStrictEqual(requests, []);
});

// --- every request failing, in turn ----------------------------------------------------------

const happy = (() => { const rts = routes(); return (q) => rts.find(([m, re]) => m === q.method && re.test(q.url))[2](q); })();

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401": () => pgError(401, 1, "Not authenticated"),
	"a redirect": () => ({ status: 302, headers: { Location: "https://elsewhere.test/" } }),
	"a reply that is not JSON": () => ({ status: 200, body: "<html>" }),
	"an error in a 200": () => pgError(200, 31, "general error"),
};

const OPS = [
	// me, login, top folder; a 401 to the first is how a gallery says it wants a sign-in
	["login", { server: SERVER, username: "jane", password: PASSWORD }, SIGN_IN, { minSteps: 3, tolerated: (k, mode) => k === 1 && mode === "a 401" }],
	// login, me
	["checkCredentials", { credentials: { common: STORED } }, ACCOUNTS, { minSteps: 2 }],
	// login, then a folder at a time: every one of them fails the call
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 1 + Object.keys(TREE).length }],
	// login, the folder
	["listPhotos", { accountId: "acc", aid: "Holidays/2025 Italy/Rome" }, PHOTOS, { minSteps: 2 }],
];

for (const [method, payload, caller, opts] of OPS) {
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`pigallery2 ${method}: any request failing (${mode}) is one reply, an error`, async () => {
			let reached = 0;
			for (let k = 1; k <= 12; k++) {
				let n = 0;
				const each = (q) => { n++; return n === k ? fail(q) : happy(q); };
				const { call } = start([["GET", /./, each], ["POST", /./, each]], { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
				const r = await call(method, payload, caller);
				if (n < k) {
					assert.strictEqual(r.returnValue, true, `the run with nothing failing failed: ${JSON.stringify(r)}`);
					break;
				}
				reached = k;
				if (opts.tolerated && opts.tolerated(k, mode)) {
					assert.notStrictEqual(r.errorCode, "CONNECTOR_EXCEPTION", JSON.stringify(r));
					continue;
				}
				assert.strictEqual(r.returnValue, false, `request ${k} failing (${mode}): the method succeeded`);
				assert.ok(r.errorCode && r.errorCode !== "CONNECTOR_EXCEPTION", `request ${k} failing: ${JSON.stringify(r)}`);
				assert.ok(typeof r.errorText === "string" && r.errorText, "an errorText");
				assert.deepStrictEqual(leaks(r, [PASSWORD, SESS, SIG]), [], "no secret in the reply");
			}
			assert.ok(reached >= opts.minSteps, `only ${reached} of ${opts.minSteps} steps were failed`);
		});
	}
}

test("a payload that is not a JSON object is BAD_ARGS; an unknown method NOT_SUPPORTED", async () => {
	const { call } = start([]);
	assert.strictEqual((await call("listAlbums", "[]", PHOTOS)).errorCode, "BAD_ARGS");
	assert.strictEqual((await call("getAuthorizeUrl", {}, PHOTOS)).errorCode, "NOT_SUPPORTED");
});
