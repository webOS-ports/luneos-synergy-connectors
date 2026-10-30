// node --test tests/unit
// The WebDAV connector (cloud/webdav/service/com.palm.service.webdav) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch that plays a WebDAV server
// (PROPFIND Depth 0/1, GET, PUT, MKCOL, MOVE, DELETE, Basic auth, and Nextcloud's principals)
// and records every request. Each method is called over the bus as its real caller would call
// it, and checked for the requests it makes, its reply and its errors. The server answers in the
// namespace styles real ones use: Nextcloud's "d:", Apache's "D:"/"lp1:", a default xmlns.
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
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../cloud/webdav/service/com.palm.service.webdav");
const service = require(SVC);   // through package.json "main", as the launcher does
const dav = require(path.join(SVC, "adapter.js"));
const Config = require(path.join(SVC, "config.js")).Config;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "webdav-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
const LOCAL_BYTES = crypto.randomBytes(5000);
fs.writeFileSync(LOCAL, LOCAL_BYTES);
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");
Config.PHOTO_TMP_DIR = path.join(TMP, "photos");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const ACCOUNTS = { service: "com.palm.service.accounts" };
const PASSWORD = "unit-test-pässword:not-a-credential";
const HOST = "dav.example.test";
const ORIGIN = "https://" + HOST;
const BASE = "/remote.php/dav/files/alice/";
const CREDS = { accessToken: PASSWORD, username: "alice", server: ORIGIN + BASE, flavor: "nextcloud" };
const BASIC = "Basic " + Buffer.from("alice:" + PASSWORD, "utf8").toString("base64");

// --- a WebDAV server -------------------------------------------------------------------------

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const asFolder = (p) => (p.endsWith("/") ? p : p + "/");
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const STYLES = {
	// Nextcloud / ownCloud (Sabre)
	d: { open: "<d:multistatus xmlns:d=\"DAV:\" xmlns:s=\"http://sabredav.org/ns\" xmlns:oc=\"http://owncloud.org/ns\">", close: "</d:multistatus>",
		el: (n) => "d:" + n, prop: (n) => "d:" + n },
	// Apache mod_dav: D: for the structure, lp1: for the live properties
	apache: { open: "<D:multistatus xmlns:D=\"DAV:\" xmlns:ns0=\"DAV:\">", close: "</D:multistatus>",
		el: (n) => "D:" + n, prop: (n) => (n === "resourcetype" || n === "collection" || n === "getcontenttype" ? "D:" : "lp1:") + n,
		extra: " xmlns:lp1=\"DAV:\"" },
	// a default namespace, no prefix
	plain: { open: "<multistatus xmlns=\"DAV:\">", close: "</multistatus>", el: (n) => n, prop: (n) => n },
};

// files: { "/a/b.txt": size | Buffer, "/dir/": null (a folder) }. The root is always there, and
// so is every folder a path names. opts: style, absoluteHrefs, base (the account folder's path),
// principal (Nextcloud's user id; null: no current-user-principal), hook(req, rel) to answer instead.
function server(files = {}, { style = "d", absoluteHrefs = false, base = BASE, principal = "alice", hook, password = PASSWORD, user = "alice" } = {}) {
	const store = new Map([["/", null]]);
	const add = (p, v) => {
		const segs = p.split("/").filter(Boolean);
		for (let i = 1; i < segs.length; i++) { store.set("/" + segs.slice(0, i).join("/") + "/", null); }
		store.set(p, v === null ? null : (Buffer.isBuffer(v) ? v : Buffer.alloc(v, 7)));
	};
	for (const [p, v] of Object.entries(files)) { add(p, v); }
	const S = STYLES[style];
	const okAuth = (req) => req.headers.Authorization === "Basic " + Buffer.from(user + ":" + password, "utf8").toString("base64");
	const sabreError = (msg) => "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:error xmlns:d=\"DAV:\" xmlns:s=\"http://sabredav.org/ns\">" +
		"<s:exception>Sabre\\DAV\\Exception</s:exception><s:message>" + xmlEsc(msg) + "</s:message></d:error>";
	const err = (status, msg) => ({ status, body: sabreError(msg), headers: { "content-type": "application/xml" } });
	const href = (rel) => (absoluteHrefs ? ORIGIN : "") + enc(base + rel.slice(1));
	function entry(rel) {
		const v = store.get(rel);
		const folder = v === null;
		const props = folder
			? `<${S.prop("resourcetype")}><${S.prop("collection")}/></${S.prop("resourcetype")}>`
			: `<${S.prop("resourcetype")}/><${S.prop("getcontentlength")}>${v.length}</${S.prop("getcontentlength")}>` +
				`<${S.prop("getcontenttype")}>${/\.jpg$/.test(rel) ? "image/jpeg" : "application/octet-stream"}</${S.prop("getcontenttype")}>`;
		return `<${S.el("response")}${S.extra || ""}><${S.el("href")}>${href(rel)}</${S.el("href")}>` +
			`<${S.el("propstat")}><${S.el("prop")}>${props}<${S.prop("getlastmodified")}>Thu, 01 Oct 2026 10:00:00 GMT</${S.prop("getlastmodified")}>` +
			`</${S.el("prop")}><${S.el("status")}>HTTP/1.1 200 OK</${S.el("status")}></${S.el("propstat")}>` +
			// what a server does not have it lists under 404, which must not count
			`<${S.el("propstat")}><${S.el("prop")}><${S.prop("getcontentlength")}>999999</${S.prop("getcontentlength")}></${S.el("prop")}>` +
			`<${S.el("status")}>HTTP/1.1 404 Not Found</${S.el("status")}></${S.el("propstat")}></${S.el("response")}>`;
	}
	const multi = (rels) => ({ status: 207, headers: { "content-type": "application/xml; charset=utf-8" },
		body: "<?xml version=\"1.0\" encoding=\"utf-8\"?>" + S.open + rels.map(entry).join("") + S.close });
	const relOf = (u) => {
		const p = decodeURIComponent(new URL(u).pathname);
		return p.startsWith(base) ? "/" + p.slice(base.length) : (asFolder(p) === base ? "/" : null);
	};
	const find = (rel) => [rel, rel.replace(/\/+$/, ""), asFolder(rel)].find((k) => k && store.has(k)) || null;
	const children = (folder) => [...store.keys()].filter((k) => k !== folder && k.startsWith(folder) &&
		!k.slice(folder.length).replace(/\/$/, "").includes("/")).sort();

	function reply(req) {
		const u = new URL(req.url);
		const rel0 = relOf(req.url);
		if (hook) { const r = hook(req, rel0); if (r) { return r; } }
		if (u.pathname === "/remote.php/dav/" && req.method === "PROPFIND") {
			if (!req.headers.Authorization) { return err(401, "No 'Authorization: Basic' header found"); }
			if (!okAuth(req)) { return err(401, "Username or password was incorrect"); }
			return { status: 207, headers: { "content-type": "application/xml" }, body: "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">" +
				"<d:response><d:href>/remote.php/dav/</d:href><d:propstat><d:prop>" +
				(principal ? `<d:current-user-principal><d:href>/remote.php/dav/principals/users/${encodeURIComponent(principal)}/</d:href></d:current-user-principal>` : "") +
				"</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>" };
		}
		if (!req.headers.Authorization) { return err(401, "No 'Authorization: Basic' header found"); }
		if (!okAuth(req)) { return err(401, "Username or password was incorrect"); }
		if (rel0 === null) { return { status: 404, body: "<html>not here</html>" }; }
		const rel = rel0;
		if (req.method === "PROPFIND") {
			const at = find(rel);
			if (!at) { return err(404, "File with name " + rel + " could not be located"); }
			if (req.headers.Depth === "0" || store.get(at) !== null) { return multi([at]); }
			return multi([at, ...children(at)]);
		}
		if (req.method === "GET") {
			const v = store.get(rel);
			return v ? new Response(v, { status: 200 }) : err(404, "File with name " + rel + " could not be located");
		}
		if (req.method === "PUT") {
			if (!store.has(asFolder(rel.slice(0, rel.lastIndexOf("/") + 1)))) { return err(409, "Parent folder missing"); }
			const b = req.body;
			const existed = store.has(rel);
			store.set(rel, b && b.blob !== undefined ? Buffer.alloc(b.blob) : Buffer.from(b || ""));
			return { status: existed ? 204 : 201 };
		}
		if (req.method === "MKCOL") {
			if (find(rel)) { return err(405, "The resource you tried to create already exists"); }
			const parent = rel.replace(/[^/]+\/$/, "");
			if (!store.has(parent)) { return err(409, "Parent node does not exist"); }
			store.set(rel, null);
			return { status: 201 };
		}
		if (req.method === "MOVE") {
			const at = find(rel);
			if (!at) { return err(404, "not found"); }
			const to = relOf(req.headers.Destination);
			if (to === null) { return err(502, "bad gateway"); }
			const dest = store.get(at) === null ? asFolder(to) : to;
			if (find(dest)) { if (req.headers.Overwrite === "F") { return err(412, "Destination exists"); } }
			const folder = store.get(at) === null;
			for (const k of [...store.keys()].filter((x) => x === at || (folder && x.startsWith(at)))) {
				store.set(dest + k.slice(at.length), store.get(k));
				store.delete(k);
			}
			return { status: 201 };
		}
		if (req.method === "DELETE") {
			const at = find(rel);
			if (!at) { return err(404, "not found"); }
			const folder = store.get(at) === null;
			for (const k of [...store.keys()]) { if (k === at || (folder && k.startsWith(at))) { store.delete(k); } }
			return { status: 204 };
		}
		return { status: 599, body: "unexpected " + req.method + " " + req.url };
	}
	return { store, reply, keys: () => [...store.keys()].sort() };
}

const METHODS = ["GET", "PUT", "DELETE", "PROPFIND", "MKCOL", "MOVE"];
const routesFor = (reply) => METHODS.map((m) => [m, /./, reply]);

// The service on a stand-in bus. Accounts: readCredentials gives `stored`. Every fetch's
// redirect mode is recorded too.
function start(reply, { stored = CREDS, timeouts, logs } = {}) {
	const f = fakeFetch(routesFor(reply));
	const redirects = [];
	const fetch = (url, init = {}) => { redirects.push(init.redirect); return f.fetch(url, init); };
	const pb = fakePalmbus({ onCall: (uri) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: { common: Object.assign({}, stored) } } : { returnValue: true }; }
		if (/writeCredentials$/.test(uri)) { return { returnValue: true }; }
		return { returnValue: false, errorCode: -1, errorText: "Unknown service" };
	} });
	const log = { log: (m) => { if (logs) { logs.push(String(m)); } }, error: (m) => { if (logs) { logs.push(String(m)); } } };
	const s = service.start({ palmbus: pb, fetch, idleMs: 0, exit: () => {}, log, timeouts });
	const handle = pb.handles[0];
	return { s, handle, requests: f.requests, redirects,
		call: (method, payload, caller = DOCS) => ask(handle, method, payload, caller) };
}
const urlPath = (r) => decodeURIComponent(new URL(r.url).pathname);

// --- the XML ---------------------------------------------------------------------------------

test("webdav parseMultistatus: every namespace style, only 2xx propstats, folders by resourcetype", () => {
	for (const style of Object.keys(STYLES)) {
		const srv = server({ "/a b/": null, "/x.jpg": 12 }, { style });
		const r = srv.reply({ method: "PROPFIND", url: ORIGIN + BASE, headers: { Authorization: BASIC, Depth: "1" } });
		const items = dav.parseMultistatus(r.body);
		assert.deepStrictEqual(items.map((i) => [decodeURIComponent(i.href), i.collection, i.size]),
			[[BASE, true, 0], [BASE + "a b/", true, 0], [BASE + "x.jpg", false, 12]], style);
		assert.ok(dav.isMultistatus(r.body), style);
	}
	// a response with no 2xx propstat is left out; CDATA and entities are read
	const xml = "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/gone</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>" +
		"<d:response><d:href><![CDATA[/a&b]]></d:href><d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength></d:prop>" +
		"<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" +
		"<d:response><d:href>/c&amp;d</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>";
	assert.deepStrictEqual(dav.parseMultistatus(xml).map((i) => [i.href, i.size]), [["/a&b", 3], ["/c&d", 0]]);
});

test("webdav describe: the status said in words, Sabre's message, never an HTML body", () => {
	assert.strictEqual(dav.describe(404, "<d:error xmlns:d=\"DAV:\" xmlns:s=\"http://sabredav.org/ns\"><s:message>File with name /x could not be located</s:message></d:error>"),
		"the WebDAV server answered HTTP 404 (there is nothing there): File with name /x could not be located");
	assert.strictEqual(dav.describe(500, "<html><body>secret stack trace</body></html>"), "the WebDAV server answered HTTP 500 (the server failed)");
	assert.match(dav.describe(301, ""), /redirects elsewhere: sign in again/);
	assert.strictEqual(dav.describe(418, ""), "the WebDAV server answered HTTP 418");
});

test("webdav norm: locators", () => {
	assert.strictEqual(dav.norm("root"), "/");
	assert.strictEqual(dav.norm(""), "/");
	assert.strictEqual(dav.norm(undefined), "/");
	assert.strictEqual(dav.norm("a//b/"), "/a/b/");
	assert.strictEqual(dav.norm("/a/b.txt"), "/a/b.txt");
	assert.strictEqual(dav.norm("/a/../b"), null);
	assert.strictEqual(dav.norm("/a/./b"), null);
	assert.strictEqual(dav.norm(42), null);
	assert.strictEqual(dav.parentOf("/a/b/c.txt"), "/a/b/");
	assert.strictEqual(dav.parentOf("/a/"), "/");
	assert.strictEqual(dav.leaf("/a/b/"), "b");
});

// --- login ----------------------------------------------------------------------------------

const NC = { flavor: "nextcloud", server: HOST, username: "alice", password: PASSWORD };

test("webdav login (Nextcloud): the address settled, the user id asked, the folder checked", async () => {
	const srv = server({ "/Photos/": null });
	const { call, requests, redirects } = start(srv.reply);
	const r = await call("login", NC, {});
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.username, "alice@" + HOST);
	assert.strictEqual(r.alias, "Nextcloud " + HOST);
	assert.deepStrictEqual(r.credentials.common, { accessToken: PASSWORD, username: "alice", server: ORIGIN + BASE, flavor: "nextcloud" });
	assert.deepStrictEqual(requests.map((q) => q.method + " " + urlPath(q) + " " + (q.headers.Authorization ? "auth" : "-")),
		["PROPFIND /remote.php/dav/ -", "PROPFIND /remote.php/dav/ auth", "PROPFIND " + BASE + " auth"]);
	assert.ok(requests.every((q) => !q.headers.Authorization || q.headers.Authorization === BASIC));
	assert.ok(redirects.every((m) => m === "manual"), "no request follows a redirect");
	assert.match(requests[1].body, /current-user-principal/);
	assert.strictEqual(requests[2].headers.Depth, "0");
});

test("webdav login (Nextcloud): signing in with an email finds the files under the user id", async () => {
	const srv = server({}, { user: "alice@example.test", principal: "alice", base: "/remote.php/dav/files/alice/" });
	const { call, requests } = start(srv.reply);
	const r = await call("login", Object.assign({}, NC, { username: "alice@example.test" }), {});
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.credentials.common.server, ORIGIN + "/remote.php/dav/files/alice/");
	assert.strictEqual(r.credentials.common.username, "alice@example.test");
	assert.strictEqual(r.username, "alice@example.test@" + HOST);
	assert.strictEqual(urlPath(requests[2]), "/remote.php/dav/files/alice/");
});

test("webdav login (Nextcloud): an id with odd characters is encoded; no principal falls back to the user name", async () => {
	let srv = server({}, { principal: "a b+c", base: "/remote.php/dav/files/a b+c/" });
	let r = await start(srv.reply).call("login", NC, {});
	assert.strictEqual(r.credentials.common.server, ORIGIN + "/remote.php/dav/files/a%20b%2Bc/");
	srv = server({}, { principal: null });
	r = await start(srv.reply).call("login", NC, {});
	assert.strictEqual(r.credentials.common.server, ORIGIN + BASE);
});

test("webdav login: the address as typed", async () => {
	const L = require(path.join(SVC, "login.js"));
	assert.strictEqual(L.normalizeServer("cloud.example.org", "nextcloud"), "https://cloud.example.org");
	assert.strictEqual(L.normalizeServer("http://10.0.0.5:8080/nextcloud/", "nextcloud"), "http://10.0.0.5:8080/nextcloud");
	assert.strictEqual(L.normalizeServer("https://c.example.org/nc/remote.php/dav/files/alice/", "nextcloud"), "https://c.example.org/nc");
	assert.strictEqual(L.normalizeServer("https://c.example.org/remote.php/webdav", "owncloud"), "https://c.example.org");
	assert.strictEqual(L.normalizeServer("https://c.example.org/index.php/apps/files", "nextcloud"), "https://c.example.org");
	assert.strictEqual(L.normalizeServer("nas.local:5006/webdav", "webdav"), "https://nas.local:5006/webdav/");
	assert.strictEqual(L.normalizeServer("https://nas.local/remote.php/dav/files/x", "webdav"), "https://nas.local/remote.php/dav/files/x/");
	assert.strictEqual(L.normalizeServer("https://u:p@nas.local/", "webdav"), null);
	assert.strictEqual(L.normalizeServer("ftp://nas.local/", "webdav"), null);
	assert.strictEqual(L.normalizeServer("  ", "webdav"), null);
	assert.strictEqual(L.principalUser("/remote.php/dav/principals/users/al%20ice/"), "al ice");
	assert.strictEqual(L.principalUser("/something/else"), null);
});

test("webdav login (generic): the address is the folder; a photo folder is kept", async () => {
	const srv = server({}, { base: "/webdav/" });
	const { call, requests } = start(srv.reply);
	const r = await call("login", { flavor: "webdav", server: "https://" + HOST + "/webdav", username: "alice", password: PASSWORD, photoFolder: " Pictures/2026 " }, {});
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(r.credentials.common, { accessToken: PASSWORD, username: "alice", server: ORIGIN + "/webdav/", flavor: "webdav",
		photoFolder: "/Pictures/2026/" });
	assert.strictEqual(r.alias, "WebDAV " + HOST);
	assert.deepStrictEqual(requests.map((q) => q.method + " " + urlPath(q) + " " + (q.headers.Authorization ? "auth" : "-")),
		["PROPFIND /webdav/ -", "PROPFIND /webdav/ auth"]);
});

test("webdav login: a redirect is followed once, on the same host, before the password is sent", async () => {
	const srv = server({}, { base: "/dav/", hook: (q) => (/\/old\/$/.test(new URL(q.url).pathname)
		? { status: 301, headers: { location: "https://" + HOST + "/dav/" } } : null) });
	const { call, requests } = start(srv.reply);
	const r = await call("login", { flavor: "webdav", server: "https://" + HOST + "/old/", username: "alice", password: PASSWORD }, {});
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.credentials.common.server, ORIGIN + "/dav/");
	assert.deepStrictEqual(requests.map((q) => urlPath(q) + " " + (q.headers.Authorization ? "auth" : "-")),
		["/old/ -", "/dav/ -", "/dav/ auth"]);
});

test("webdav login (Nextcloud): http -> https is followed; a redirect elsewhere on the server is not", async () => {
	const srv = server({}, { hook: (q) => (q.url.startsWith("http:") ? { status: 301, headers: { location: q.url.replace("http:", "https:") } } : null) });
	const { call, requests } = start(srv.reply);
	const r = await call("login", Object.assign({}, NC, { server: "http://" + HOST }), {});
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.credentials.common.server, ORIGIN + BASE);
	assert.ok(requests.filter((q) => q.url.startsWith("http:")).every((q) => !q.headers.Authorization), "no password over http");

	const odd = server({}, { hook: () => ({ status: 302, headers: { location: ORIGIN + "/login" } }) });
	const r2 = await start(odd.reply).call("login", NC, {});
	assert.strictEqual(r2.errorCode, "WEBDAV_NOT_FOUND");
	assert.match(r2.errorText, /not this kind of server/);
});

test("webdav login: a redirect to another host, out of http(s), or a second one, is refused", async () => {
	for (const [location, re] of [["https://other.example.test/dav/", /redirects to other\.example\.test/],
		["ftp://" + HOST + "/x/", /no http\(s\) address/], ["https://u:p@" + HOST + "/x/", /no http\(s\) address/]]) {
		const srv = server({}, { hook: () => ({ status: 301, headers: { location } }) });
		const { call, requests } = start(srv.reply);
		const r = await call("login", { flavor: "webdav", server: ORIGIN + "/x/", username: "alice", password: PASSWORD }, {});
		assert.strictEqual(r.errorCode, "WEBDAV_NOT_FOUND", location);
		assert.match(r.errorText, re);
		assert.ok(requests.every((q) => !q.headers.Authorization), "the password was sent");
	}
	const loop = server({}, { hook: (q) => ({ status: 301, headers: { location: urlPath(q) === "/a/" ? "/b/" : "/a/" } }) });
	const { call, requests } = start(loop.reply);
	const r = await call("login", { flavor: "webdav", server: ORIGIN + "/a/", username: "alice", password: PASSWORD }, {});
	assert.strictEqual(r.errorCode, "WEBDAV_NOT_FOUND");
	assert.match(r.errorText, /redirects again/);
	assert.strictEqual(requests.length, 2);
});

test("webdav login: the errors say what is wrong, and never hold the password", async () => {
	const logs = [];
	const cases = [
		[server({}, { password: "other" }), NC, "WEBDAV_AUTH_FAILED", /refused the user name or password.*app password/],
		[server({}, { base: "/elsewhere/" }), NC, "WEBDAV_NOT_FOUND", /no WebDAV folder at/],
		[server({}, { hook: (q) => (q.headers.Authorization && urlPath(q) === BASE ? { status: 200, body: "<html>login</html>" } : null) }), NC,
			"WEBDAV_NOT_FOUND", /no WebDAV folder/],
		[server({}, { hook: (q) => (q.headers.Authorization && urlPath(q) === BASE ? { status: 405, body: "" } : null) }),
			Object.assign({}, NC, { flavor: "webdav", server: ORIGIN + BASE }), "WEBDAV_NOT_FOUND", /often on its own port/],
		[server({}, { hook: () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } }), NC, "WEBDAV_UNREACHABLE", /no server answers/],
		[server({}, { hook: () => { throw Object.assign(new Error("x"), { code: "ERR_SSL_PACKET_LENGTH_TOO_LONG" }); } }), NC,
			"WEBDAV_UNREACHABLE", /with http:\/\//],
		[server({}), Object.assign({}, NC, { flavor: "ftp" }), "BAD_ARGS", /flavor/],
		[server({}), Object.assign({}, NC, { flavor: "toString" }), "BAD_ARGS", /flavor/],
		[server({}), Object.assign({}, NC, { password: "" }), "MISSING_CREDENTIALS", /need server/],
		[server({}), Object.assign({}, NC, { server: "" }), "MISSING_CREDENTIALS", /need server/],
		[server({}), Object.assign({}, NC, { username: "a:b" }), "BAD_ARGS", /Basic/],
		[server({}), Object.assign({}, NC, { server: "ftp://x" }), "BAD_ARGS", /http\(s\)/],
		[server({}), Object.assign({}, NC, { photoFolder: "a/../b" }), "BAD_ARGS", /photoFolder/],
	];
	for (const [srv, payload, code, re] of cases) {
		const r = await start(srv.reply, { logs }).call("login", payload, {});
		assert.strictEqual(r.returnValue, false, code);
		assert.strictEqual(r.errorCode, code, JSON.stringify(r));
		assert.match(r.errorText, re);
		assert.ok(!JSON.stringify(r).includes(PASSWORD), "the password is in the reply");
	}
	assert.ok(logs.length > 0);
	assert.ok(!logs.join("\n").includes(PASSWORD), "the password is in the log");
	assert.ok(!logs.join("\n").includes(BASIC.slice(6)), "the Basic header is in the log");
});

// --- checkCredentials ------------------------------------------------------------------------

test("webdav checkCredentials: a PROPFIND of the folder; a changed password fails", async () => {
	let r = await start(server({}).reply).call("checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.username, "alice@" + HOST);
	r = await start(server({}, { password: "new" }).reply).call("checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS);
	assert.strictEqual(r.returnValue, false);
	assert.strictEqual(r.errorCode, "WEBDAV_AUTH_FAILED");
	assert.ok(!JSON.stringify(r).includes(PASSWORD));
	r = await start(server({}).reply).call("checkCredentials", { credentials: { common: { accessToken: "x" } } }, ACCOUNTS);
	assert.strictEqual(r.errorCode, "MISSING_CREDENTIALS");
});

// --- files -----------------------------------------------------------------------------------

test("webdav listFolder: the children, decoded, the folder itself left out, in every server style", async () => {
	for (const style of Object.keys(STYLES)) {
		for (const absoluteHrefs of [false, true]) {
			const srv = server({ "/Docs/ü & #1 %.txt": 5, "/Docs/sub/": null, "/Docs/p.jpg": 3, "/other.txt": 1 }, { style, absoluteHrefs });
			const { call, requests } = start(srv.reply);
			const r = await call("listFolder", { accountId: "acc", path: "/Docs/" });
			assert.strictEqual(r.returnValue, true, JSON.stringify(r));
			assert.deepStrictEqual(r.entries.map((e) => [e.id, e.type, e.name, e.size, e.mimeType]), [
				["/Docs/p.jpg", "file", "p.jpg", 3, "image/jpeg"],
				["/Docs/sub/", "folder", "sub", 0, "application/x-directory"],
				["/Docs/ü & #1 %.txt", "file", "ü & #1 %.txt", 5, "text/plain"],
			], style + " " + absoluteHrefs);
			assert.strictEqual(r.entries[0].modified, Date.parse("Thu, 01 Oct 2026 10:00:00 GMT"));
			assert.strictEqual(requests[0].method, "PROPFIND");
			assert.strictEqual(requests[0].headers.Depth, "1");
			assert.strictEqual(requests[0].headers.Authorization, BASIC);
			assert.strictEqual(new URL(requests[0].url).pathname, BASE + "Docs/");
		}
	}
});

test("webdav listFolder: the root by every name; a folder named without its slash", async () => {
	for (const p of [undefined, "", "root", "/"]) {
		const srv = server({ "/a/": null });
		const { call, requests } = start(srv.reply);
		const r = await call("listFolder", p === undefined ? { accountId: "acc" } : { accountId: "acc", path: p });
		assert.deepStrictEqual(r.entries.map((e) => e.id), ["/a/"], String(p));
		assert.strictEqual(new URL(requests[0].url).pathname, BASE);
	}
	const r = await start(server({ "/a/b/": null }).reply).call("listFolder", { accountId: "acc", folderId: "a" });
	assert.deepStrictEqual(r.entries.map((e) => e.id), ["/a/b/"]);
});

test("webdav listFolder: refusals - a file, a path out of the folder, a reply that is no Multi-Status, hrefs elsewhere", async () => {
	let r = await start(server({ "/a.txt": 1 }, { hook: (q) => (q.headers.Depth === "1" ? null : null) }).reply)
		.call("listFolder", { accountId: "acc", path: "/a.txt/" });
	assert.strictEqual(r.returnValue, false);
	r = await start(server({}).reply).call("listFolder", { accountId: "acc", path: "/a/../../etc/" });
	assert.strictEqual(r.errorCode, "BAD_ARGS");
	r = await start(server({}, { hook: () => ({ status: 200, body: "<html>login</html>" }) }).reply).call("listFolder", { accountId: "acc", path: "/" });
	assert.strictEqual(r.errorCode, "WEBDAV_LIST_FAILED");
	r = await start(server({}).reply).call("listFolder", { accountId: "acc", path: "/missing/" });
	assert.strictEqual(r.errorCode, "WEBDAV_LIST_FAILED");
	assert.match(r.errorText, /HTTP 404 \(there is nothing there\): File with name/);
	// a server that lists something outside the account's folder: left out
	const srv = server({ "/a/": null });
	const odd = (q) => {
		const x = srv.reply(q);
		return x.status === 207 ? Object.assign({}, x, { body: x.body.replace("</d:multistatus>",
			"<d:response><d:href>/remote.php/dav/files/bob/secret.txt</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>") }) : x;
	};
	r = await start(odd).call("listFolder", { accountId: "acc", path: "/" });
	assert.deepStrictEqual(r.entries.map((e) => e.id), ["/a/"]);
});

test("webdav downloadFile: GET to the file, byte for byte; a folder is refused", async () => {
	const bytes = crypto.randomBytes(3000);
	const srv = server({ "/d/a b.bin": bytes });
	const { call, requests } = start(srv.reply);
	const dest = dl();
	const r = await call("downloadFile", { accountId: "acc", fileId: "/d/a b.bin", localPath: dest });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.ok(fs.readFileSync(dest).equals(bytes));
	assert.strictEqual(requests[0].method, "GET");
	assert.strictEqual(new URL(requests[0].url).pathname, BASE + "d/a%20b.bin");
	const r2 = await call("downloadFile", { accountId: "acc", fileId: "/d/", localPath: dl() });
	assert.strictEqual(r2.errorCode, "BAD_ARGS");
	const r3 = await call("downloadFile", { accountId: "acc", fileId: "/d/none.bin", localPath: dl() });
	assert.strictEqual(r3.errorCode, "WEBDAV_DOWNLOAD_FAILED");
});

test("webdav uploadFile: PUT into the folder, the name encoded; replace PUTs over the file", async () => {
	const srv = server({ "/d/": null, "/d/old.txt": 2 });
	const { call, requests } = start(srv.reply);
	let r = await call("uploadFile", { accountId: "acc", path: "/d/", localPath: LOCAL, name: "n ü#.bin" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual([r.id, r.name, r.size], ["/d/n ü#.bin", "n ü#.bin", 5000]);
	assert.strictEqual(requests[0].method, "PUT");
	assert.strictEqual(new URL(requests[0].url).pathname, BASE + "d/n%20%C3%BC%23.bin");
	assert.strictEqual(requests[0].body.blob, 5000);
	assert.strictEqual(requests[0].headers["Content-Type"], "application/octet-stream");
	assert.strictEqual(srv.store.get("/d/n ü#.bin").length, 5000);
	r = await call("uploadFile", { accountId: "acc", fileId: "/d/old.txt", localPath: LOCAL, replace: true, mimeType: "text/plain" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(srv.store.get("/d/old.txt").length, 5000);
	assert.strictEqual(requests[1].headers["Content-Type"], "text/plain");
	r = await call("uploadFile", { accountId: "acc", path: "/d/", localPath: path.join(TMP, "nope") });
	assert.strictEqual(r.errorCode, "LOCAL_FILE_ERROR");
	r = await call("uploadFile", { accountId: "acc", path: "/missing/", localPath: LOCAL });
	assert.strictEqual(r.errorCode, "WEBDAV_UPLOAD_FAILED");
	assert.match(r.errorText, /409 \(a folder on the way is missing\)/);
});

test("webdav createFolder: MKCOL; a folder already there is taken, a file there is not", async () => {
	const srv = server({ "/d/": null, "/d/f": 1 });
	const { call, requests } = start(srv.reply);
	let r = await call("createFolder", { accountId: "acc", path: "/d/", name: "new ü" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual([r.entry.id, r.entry.type, r.entry.name], ["/d/new ü/", "folder", "new ü"]);
	assert.strictEqual(requests[0].method, "MKCOL");
	assert.strictEqual(new URL(requests[0].url).pathname, BASE + "d/new%20%C3%BC/");
	r = await call("createFolder", { accountId: "acc", path: "/d/", name: "new ü" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	r = await call("createFolder", { accountId: "acc", path: "/d/", name: "f" });
	assert.strictEqual(r.errorCode, "WEBDAV_EXISTS");
	r = await call("createFolder", { accountId: "acc", path: "/d/", name: "a/b" });
	assert.strictEqual(r.returnValue, false);
});

test("webdav moveItem: one MOVE, Destination a full URL, Overwrite F; an existing destination refused", async () => {
	const srv = server({ "/a/x.txt": 4, "/b/": null, "/b/taken.txt": 1, "/f/": null, "/f/in.txt": 2 });
	const { call, requests } = start(srv.reply);
	let r = await call("moveItem", { accountId: "acc", path: "/a/x.txt", toPath: "/b/", name: "y ü.txt" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual([r.entry.id, r.entry.type, r.entry.size], ["/b/y ü.txt", "file", 4]);
	assert.strictEqual(requests[0].method, "MOVE");
	assert.strictEqual(requests[0].headers.Destination, ORIGIN + BASE + "b/y%20%C3%BC.txt");
	assert.strictEqual(requests[0].headers.Overwrite, "F");
	assert.ok(srv.store.has("/b/y ü.txt") && !srv.store.has("/a/x.txt"));
	r = await call("moveItem", { accountId: "acc", path: "/b/y ü.txt", name: "taken.txt" });
	assert.strictEqual(r.errorCode, "WEBDAV_DESTINATION_EXISTS");
	assert.strictEqual(srv.store.get("/b/taken.txt").length, 1, "the destination was overwritten");
	r = await call("moveItem", { accountId: "acc", path: "/f/", toRoot: true, name: "g" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual([r.entry.id, r.entry.type], ["/g/", "folder"]);
	assert.ok(srv.store.has("/g/in.txt"));
	r = await call("moveItem", { accountId: "acc", path: "/g/", toPath: "/g/sub/" });
	assert.match(r.errorText, /into itself/);
	r = await call("moveItem", { accountId: "acc", path: "/", name: "x" });
	assert.strictEqual(r.errorCode, "BAD_ARGS");
});

test("webdav deleteItem: DELETE; one already gone is fine; the root never", async () => {
	const srv = server({ "/d/": null, "/d/x": 1 });
	const { call, requests } = start(srv.reply);
	let r = await call("deleteItem", { accountId: "acc", path: "/d/" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(requests[0].method, "DELETE");
	assert.ok(!srv.store.has("/d/x"));
	r = await call("deleteItem", { accountId: "acc", path: "/d/" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	for (const p of ["/", "root"]) {
		const n = requests.length;
		r = await call("deleteItem", { accountId: "acc", path: p });
		assert.strictEqual(r.returnValue, false, p);
		assert.strictEqual(requests.length, n, "a request was sent to delete the root");
	}
	r = await call("deleteItem", { accountId: "acc", path: "//" });
	assert.strictEqual(r.returnValue, false);
});

test("webdav file methods: only the file apps may call them; no request follows a redirect", async () => {
	const { call, redirects } = start(server({ "/a/": null }).reply);
	const r = await call("listFolder", { accountId: "acc", path: "/" }, { appId: "com.example.stranger" });
	assert.strictEqual(r.errorCode, "PERMISSION_DENIED");
	await call("listFolder", { accountId: "acc", path: "/" });
	assert.ok(redirects.length && redirects.every((m) => m === "manual"));
	const moved = server({}, { hook: () => ({ status: 301, headers: { location: "https://evil.example.test/" } }) });
	const r2 = await start(moved.reply).call("listFolder", { accountId: "acc", path: "/" });
	assert.strictEqual(r2.returnValue, false);
	assert.match(r2.errorText, /sign in again/);
});

// --- photos ----------------------------------------------------------------------------------

const JPG = (n) => crypto.randomBytes(n);

test("webdav listAlbums: the photo folder and each folder in it that holds images", async () => {
	const srv = server({ "/Photos/top.jpg": 3, "/Photos/notes.txt": 1, "/Photos/Trip/a.jpg": 2, "/Photos/Trip/b.png": 2,
		"/Photos/Empty/": null, "/Photos/Docs/x.pdf": 1, "/Other/z.jpg": 1 });
	const { call } = start(srv.reply);
	const r = await call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(r.albums, [{ aid: "/Photos/", name: "Photos", size: { images: 1 } },
		{ aid: "/Photos/Trip/", name: "Trip", size: { images: 2 } }]);
});

test("webdav listAlbums: an account's own photo folder; none at all is the empty upload album", async () => {
	let r = await start(server({ "/Pics/2026/a.jpg": 1 }).reply, { stored: Object.assign({}, CREDS, { photoFolder: "/Pics/" }) })
		.call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.deepStrictEqual(r.albums, [{ aid: "/Pics/2026/", name: "2026", size: { images: 1 } }]);
	r = await start(server({}).reply).call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.deepStrictEqual(r.albums, [{ aid: "", name: "Camera Uploads", size: { images: 0 } }]);
	r = await start(server({}, { hook: () => ({ status: 500, body: "" }) }).reply).call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.deepStrictEqual(r.albums, [{ aid: "", name: "Camera Uploads", size: { images: 0 } }]);
	// one album that cannot be listed is left out, not the others
	r = await start(server({ "/Photos/A/a.jpg": 1, "/Photos/B/b.jpg": 1 }, { hook: (q, rel) => (rel === "/Photos/A/" ? { status: 500, body: "" } : null) }).reply)
		.call("listAlbums", { accountId: "acc" }, PHOTOS);
	assert.deepStrictEqual(r.albums.map((a) => a.aid), ["/Photos/B/"]);
});

test("webdav listPhotos: each image copied to a local file, handed as a temporary file:// link", async () => {
	const a = JPG(1200), b = JPG(900);
	const srv = server({ "/Photos/Trip/a.jpg": a, "/Photos/Trip/b ü.png": b, "/Photos/Trip/c.txt": 1, "/Photos/Trip/sub/": null });
	const { call } = start(srv.reply);
	const r = await call("listPhotos", { accountId: "acc", aid: "/Photos/Trip/" }, PHOTOS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(r.photos.map((p) => [p.pid, p.caption, p.fileName, p.type, p.temporary]),
		[["/Photos/Trip/a.jpg", "a.jpg", "a.jpg", "image", true], ["/Photos/Trip/b ü.png", "b ü.png", "b ü.png", "image", true]]);
	for (const [p, bytes] of [[r.photos[0], a], [r.photos[1], b]]) {
		assert.ok(p.src_big.startsWith("file://" + Config.PHOTO_TMP_DIR + "/"));
		assert.strictEqual(p.src_big, p.src_small);
		assert.ok(fs.readFileSync(p.src_big.slice(7)).equals(bytes));
		assert.ok(!p.src_big.includes(PASSWORD));
		assert.ok(!/[ ü]/.test(path.basename(p.src_big)), "the local name is made safe");
	}
	// what the caller has is not fetched again, and its copy goes
	const { call: call2, requests } = start(srv.reply);
	const r2 = await call2("listPhotos", { accountId: "acc", aid: "/Photos/Trip/", have: ["/Photos/Trip/a.jpg"] }, PHOTOS);
	assert.deepStrictEqual(r2.photos.map((p) => [p.pid, !!p.temporary]), [["/Photos/Trip/a.jpg", false], ["/Photos/Trip/b ü.png", true]]);
	assert.deepStrictEqual(requests.filter((q) => q.method === "GET").map((q) => urlPath(q)), [BASE + "Photos/Trip/b ü.png"]);
	assert.ok(!fs.existsSync(r.photos[0].src_big.slice(7)), "the copy of a photo the caller has was kept");
	const r3 = await call2("listPhotos", { accountId: "acc" }, PHOTOS);
	assert.deepStrictEqual(r3.photos, []);
});

test("webdav listPhotos: a photo that cannot be had is left out; out of time leaves the rest for the next sync", async () => {
	const srv = server({ "/P/a.jpg": 1, "/P/b.jpg": 1 }, { hook: (q, rel) => (q.method === "GET" && rel === "/P/a.jpg" ? { status: 500, body: "" } : null) });
	let r = await start(srv.reply).call("listPhotos", { accountId: "acc", aid: "/P/" }, PHOTOS);
	assert.deepStrictEqual(r.photos.map((p) => p.pid), ["/P/b.jpg"]);
	const keep = Config.PHOTO_FETCH_BUDGET_MS;
	Config.PHOTO_FETCH_BUDGET_MS = -1;
	try {
		const { call, requests } = start(server({ "/P/a.jpg": 1, "/P/b.jpg": 1 }).reply);
		r = await call("listPhotos", { accountId: "acc", aid: "/P/", have: ["/P/b.jpg"] }, PHOTOS);
		assert.deepStrictEqual(r.photos.map((p) => p.pid), ["/P/b.jpg"]);
		assert.ok(!requests.some((q) => q.method === "GET"));
	} finally { Config.PHOTO_FETCH_BUDGET_MS = keep; }
	r = await start(server({}).reply).call("listPhotos", { accountId: "acc", aid: "/none/" }, PHOTOS);
	assert.strictEqual(r.returnValue, false);
});

test("webdav upload (Photos): into the album, or with none into <photo folder>/Camera Uploads, made as needed", async () => {
	const srv = server({});
	const { call, requests } = start(srv.reply);
	let r = await call("upload", { accountId: "acc", path: LOCAL, name: "shot.jpg" }, PHOTOS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(requests.map((q) => q.method + " " + urlPath(q)),
		["MKCOL " + BASE + "Photos/", "MKCOL " + BASE + "Photos/Camera Uploads/", "PUT " + BASE + "Photos/Camera Uploads/shot.jpg"]);
	assert.strictEqual(srv.store.get("/Photos/Camera Uploads/shot.jpg").length, 5000);
	r = await call("upload", { accountId: "acc", path: LOCAL, name: "two.jpg" }, PHOTOS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	r = await call("upload", { accountId: "acc", path: LOCAL, albumId: "/Photos/Trip/", name: "t.jpg" }, PHOTOS);
	assert.strictEqual(r.returnValue, false, "a missing album folder is an error (409)");
	srv.store.set("/Photos/Trip/", null);
	r = await call("upload", { accountId: "acc", path: LOCAL, albumId: "/Photos/Trip/", name: "t.jpg" }, PHOTOS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.ok(srv.store.has("/Photos/Trip/t.jpg"));
});

test("webdav deletePhoto: DELETE of the file; a folder is refused", async () => {
	const srv = server({ "/Photos/a.jpg": 1, "/Photos/x/": null });
	const { call } = start(srv.reply);
	let r = await call("deletePhoto", { accountId: "acc", pid: "/Photos/a.jpg" }, PHOTOS);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.ok(!srv.store.has("/Photos/a.jpg"));
	r = await call("deletePhoto", { accountId: "acc", pid: "/Photos/x/" }, PHOTOS);
	assert.strictEqual(r.errorCode, "BAD_ARGS");
	assert.ok(srv.store.has("/Photos/x/"));
});

test("webdav: the password is in no request but its Authorization header", async () => {
	const srv = server({ "/d/a.jpg": 1, "/Photos/b.jpg": 1 });
	const { call, requests } = start(srv.reply);
	await call("listFolder", { accountId: "acc", path: "/d/" });
	await call("uploadFile", { accountId: "acc", path: "/d/", localPath: LOCAL });
	await call("moveItem", { accountId: "acc", path: "/d/a.jpg", name: "c.jpg" });
	await call("listPhotos", { accountId: "acc", aid: "/Photos/" }, PHOTOS);
	assert.ok(requests.length >= 5);
	for (const q of requests) {
		const h = Object.assign({}, q.headers); delete h.Authorization;
		assert.ok(!(q.url + JSON.stringify(h) + JSON.stringify(q.body)).includes(PASSWORD), q.method + " " + q.url);
		assert.strictEqual(q.headers.Authorization, BASIC);
	}
});

// --- every request failing, in turn ----------------------------------------------------------

const MODES = {
	"a 500 reply": () => ({ status: 500, body: "<d:error xmlns:d=\"DAV:\" xmlns:s=\"http://sabredav.org/ns\"><s:message>boom</s:message></d:error>" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a refused password": () => ({ status: 401, body: "" }),
	"a 200 that is not WebDAV's XML": () => ({ status: 200, body: "<html>" }),
	"a redirect": () => ({ status: 302, headers: { location: "https://evil.example.test/" } }),
};

const FIXTURE = () => ({ "/x/a.jpg": 3, "/x/b.jpg": 3, "/dir/": null, "/dir/1.jpg": 1, "/Photos/p.jpg": 1, "/Photos/A/q.jpg": 1 });

// A request whose reply body is not read (GET, PUT, MKCOL, MOVE, DELETE) takes any 200.
const bodyless = (...steps) => (k, mode) => mode === "a 200 that is not WebDAV's XML" && steps.includes(k);
const OPS = [
	["listFolder", { accountId: "acc", path: "/x/" }, DOCS],
	["downloadFile", () => ({ accountId: "acc", fileId: "/x/a.jpg", localPath: dl() }), DOCS, { tolerated: bodyless(1) }],
	["uploadFile", { accountId: "acc", path: "/x/", localPath: LOCAL }, DOCS, { tolerated: bodyless(1) }],
	["uploadFile (replace)", { accountId: "acc", fileId: "/x/a.jpg", localPath: LOCAL, replace: true }, DOCS, { tolerated: bodyless(1) }],
	["createFolder", { accountId: "acc", path: "/x/", name: "n" }, DOCS, { tolerated: bodyless(1) }],
	// the entry's PROPFIND after the move is a nicety: the move is done whatever it answers
	["moveItem", { accountId: "acc", path: "/x/a.jpg", toPath: "/dir/" }, DOCS, { tolerated: (k, mode) => k === 2 || bodyless(1)(k, mode) }],
	["deleteItem", { accountId: "acc", path: "/dir/" }, DOCS, { tolerated: bodyless(1) }],
	["checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS],
	["login", NC, {}, { minSteps: 3, tolerated: (k, mode) => (k === 1 && mode !== "no answer (network)" && mode !== "a stalled reply" && mode !== "a redirect") ||
		(k === 2 && mode !== "no answer (network)" && mode !== "a stalled reply" && mode !== "a refused password") }],
	// /Photos/ is there: MKCOL answers 405, a PROPFIND sees it is a folder, then MKCOL and PUT
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS, { minSteps: 4, tolerated: bodyless(1, 3, 4) }],
	["deletePhoto", { accountId: "acc", pid: "/x/a.jpg" }, PHOTOS, { tolerated: bodyless(1) }],
	["listAlbums", { accountId: "acc" }, PHOTOS, { minSteps: 2, tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: "/Photos/" }, PHOTOS, { tolerated: (k) => k > 1 }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`webdav ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 12; k++) {
				let n = 0;
				const srv = server(FIXTURE());
				const { call } = start((q) => (++n === k ? fail(q) : srv.reply(q)), { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 } });
				const r = await call(method, typeof payload === "function" ? payload() : payload, caller);   // exactly one reply, or ask() throws
				if (n < k) {
					assert.strictEqual(r.returnValue, true, `the run with nothing failing failed: ${JSON.stringify(r)}`);
					break;
				}
				reached = k;
				if (r.returnValue === false) { assert.ok(!JSON.stringify(r).includes(PASSWORD), "the password is in an error reply: " + k); }
				if (!(opts.tolerated && opts.tolerated(k, mode))) {
					assert.strictEqual(r.returnValue, false, `request ${k} failing: the method succeeded`);
					assert.ok(r.errorCode && r.errorCode !== "CONNECTOR_EXCEPTION", `request ${k} failing: ${JSON.stringify(r)}`);
					assert.ok(typeof r.errorText === "string" && r.errorText, "an errorText");
				}
			}
			assert.ok(reached >= (opts.minSteps || 1), `only ${reached} of ${opts.minSteps || 1} steps were failed`);
		});
	}
}
