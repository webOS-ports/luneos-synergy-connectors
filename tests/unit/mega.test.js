// node --test tests/unit
// The MEGA connector (cloud/mega/service/com.palm.service.mega) as the launcher runs it:
// service.js started on a stand-in palmbus, with a stand-in fetch playing MEGA: the cs API, a
// download URL and an upload URL. Each method is called over the bus as its real caller would
// call it, and checked for the cs commands it sends (the exact bodies), the bytes it moves, its
// reply and its errors. The account in the stand-in is made with node's OpenSSL directly and the
// megajs vectors (lib/mega-vectors.js), not with the connector's own crypto.
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
const V = require("./lib/mega-vectors.js");

const SVC = path.join(__dirname, "../../cloud/mega/service/com.palm.service.mega");
const service = require(SVC);   // through package.json "main", as the launcher does
const Config = require(path.join(SVC, "config.js")).Config;
const { timing } = require(path.join(SVC, "megaapi.js"));
timing.retryMs = 1;   // EAGAIN backoff, so the tests do not wait seconds

const DL = "https://dl.example.test/";
const UL = "https://ul.example.test/up";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mega-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"), "sub", "file.bin");
Config.PHOTO_TMP_DIR = path.join(TMP, "photos");

const DOCS = { appId: "org.webosports.app.documents 2345" };
const PHOTOS = { service: "com.palm.service.photos" };
const ACCOUNTS = { service: "com.palm.service.accounts" };

// --- independent crypto: node's OpenSSL, nothing from cloud/mega -------------------------------
const e64 = (b) => Buffer.from(b).toString("base64url");
const d64 = (s) => Buffer.from(s, "base64url");
const run = (mode, decrypt, key, data, iv = null) => {
	const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)("aes-128-" + mode, key, iv).setAutoPadding(false);
	return Buffer.concat([c.update(data), c.final()]);
};
const ecb = (key, data) => run("ecb", false, key, data);
const unecb = (key, data) => run("ecb", true, key, data);
const cbc = (key, data) => run("cbc", false, key, data, Buffer.alloc(16));
const uncbc = (key, data) => run("cbc", true, key, data, Buffer.alloc(16));
const ctr = (key, nonce, data) => run("ctr", false, key, data, Buffer.concat([nonce, Buffer.alloc(8)]));
const attr = (key, obj) => { const t = Buffer.from("MEGA" + JSON.stringify(obj)); const p = Buffer.alloc(Math.ceil(t.length / 16) * 16); t.copy(p); return e64(cbc(key, p)); };
const openAttr = (key, at) => {
	const pt = uncbc(key, d64(at));
	const end = pt.indexOf(0) < 0 ? pt.length : pt.indexOf(0);
	assert.ok(pt.subarray(end).every((x) => x === 0), "zero padded to 16");
	const s = pt.subarray(0, end).toString("utf8");
	assert.strictEqual(s.slice(0, 6), "MEGA{\"");
	return JSON.parse(s.slice(4));
};
const fold = (k32) => { const a = Buffer.alloc(16); for (let i = 0; i < 16; i++) { a[i] = k32[i] ^ k32[16 + i]; } return a; };

// --- the account ---------------------------------------------------------------------------------
// Cloud Drive R: Docs D { a.txt F, Sub E, pic.jpg P (300000 bytes, real content) }, Shared S
// (an outgoing share) { inner.txt Z, keyed only by the share key }, notes.txt N, Camera Uploads C,
// Broken X (attributes that do not decrypt); Rubbish Bin B: old.txt T; Inbox I.
const MASTER = Buffer.from("0f0e0d0c0b0a09080706050403020100", "hex");
const V1 = V.v1[0], V2 = V.v2[0];               // the same password, as v1 and as v2 accounts
const EMAIL = V1.email;
const SID = V.rsa.sid;
const USER = "UsErHaNdLe0";
const PIC = V.mac.find((m) => m.size === 300000);
const PIC_BYTES = V.det(300000, "data-300000");
const PIC_KEY = d64(PIC.fullKey);               // megajs's full key: AES key xor (nonce, mac), nonce, mac
const SHARE_KEY = Buffer.from("aabbccddeeff00112233445566778899", "hex");

function account() {
	const keys = {}, raw = [];
	const wrap = (k) => e64(ecb(MASTER, k));
	const folder = (h, p, name, k = crypto.randomBytes(16)) => { keys[h] = k; raw.push({ h, p, t: 1, a: attr(k, { n: name }), k: `${USER}:${wrap(k)}`, ts: 1700000000 }); };
	const file = (h, p, attrs, s, k = crypto.randomBytes(32), kField) => {
		keys[h] = k;
		raw.push({ h, p, t: 0, a: attr(fold(k), attrs), k: kField || `${USER}:${wrap(k)}`, s, ts: 1700000100 });
	};
	raw.push({ h: "RRRRRRRR", t: 2, p: "" }, { h: "IIIIIIII", t: 3, p: "" }, { h: "BBBBBBBB", t: 4, p: "" });
	folder("DDDDDDDD", "RRRRRRRR", "Docs");
	file("FFFFFFFF", "DDDDDDDD", { n: "a.txt", c: "fingerprint", lbl: 2 }, 12);
	folder("EEEEEEEE", "DDDDDDDD", "Sub");
	file("PPPPPPPP", "DDDDDDDD", { n: "pic.jpg" }, PIC_BYTES.length, PIC_KEY);
	folder("SSSSSSSS", "RRRRRRRR", "Shared", SHARE_KEY);
	// A node whose first key pair is someone else's (it does not open), the second under the share key.
	const zk = crypto.randomBytes(32);
	file("ZZZZZZZZ", "SSSSSSSS", { n: "inner.txt" }, 4, zk, `OtHeRuSeR00:${e64(crypto.randomBytes(32))}/SSSSSSSS:${e64(ecb(SHARE_KEY, zk))}`);
	file("NNNNNNNN", "RRRRRRRR", { n: "notes ü.txt" }, 3);
	folder("CCCCCCCC", "RRRRRRRR", "Camera Uploads");
	raw.push({ h: "XXXXXXXX", p: "RRRRRRRR", t: 0, a: e64(crypto.randomBytes(32)), k: `${USER}:${wrap(crypto.randomBytes(32))}`, s: 1, ts: 1 });
	file("TTTTTTTT", "BBBBBBBB", { n: "old.txt" }, 5);
	const ok = [{ h: "SSSSSSSS", ha: e64(ecb(MASTER, Buffer.from("SSSSSSSSSSSSSSSS"))), k: e64(ecb(MASTER, SHARE_KEY)) }];
	return { keys, tree: { f: raw, ok } };
}

// The RSA private key as MEGA keeps it: the MPIs, under the master key.
const PRIVK = e64(ecb(MASTER, Buffer.from(V.rsa.privk, "hex")));
const CREDS = { accessToken: SID, mk: e64(MASTER), email: EMAIL, u: USER };

// --- the stand-in MEGA ------------------------------------------------------------------------
// opts: version (1|2), mfa (the code an account with 2FA wants), on(cmd, ctx) -> a reply that
// replaces the default for that command (undefined: the default).
function mega(opts = {}) {
	const acct = account();
	const st = { cmds: [], chunks: [], downloads: 0, acct, uploaded: null };
	const PIC_CT = ctr(fold(PIC_KEY), PIC_KEY.subarray(16, 24), PIC_BYTES);
	function command(c, ctx) {
		const o = opts.on && opts.on(c, ctx);
		if (o !== undefined) { return o; }
		switch (c.a) {
		case "us0": return opts.version === 2 ? { v: 2, s: V2.salt } : { v: 1 };
		case "us": {
			const want = opts.version === 2 ? V2 : V1;
			if (c.user !== EMAIL || c.uh !== want.uh) { return -9; }
			if (opts.mfa && c.mfa !== opts.mfa) { return -26; }
			return { k: e64(ecb(Buffer.from(want.pwKey, "hex"), MASTER)), privk: PRIVK, csid: V.rsa.csid, u: USER };
		}
		case "ug": return ctx.sid === SID ? { u: USER, email: EMAIL, name: "U Ser" } : -15;
		case "f": return ctx.sid === SID ? acct.tree : -15;
		case "g": return { g: DL + c.n, s: c.n === "PPPPPPPP" ? PIC_BYTES.length : 12, at: "x" };
		case "u": st.expect = c.s; return { p: UL };
		case "p": {
			// As MEGA: the new node is in the tree from now on.
			const h = c.n[0].t === 1 ? "NEWFOLDR" : "NEWFILE1";
			acct.tree.f.push({ h, p: c.t, t: c.n[0].t, a: c.n[0].a, k: USER + ":" + c.n[0].k, ts: 1760000000 });
			return { f: [{ h, t: c.n[0].t, ts: 1760000000 }] };
		}
		default: return 0;
		}
	}
	function cs(q) {
		const u = new URL(q.url);
		const ctx = { id: u.searchParams.get("id"), sid: u.searchParams.get("sid"), hashcash: q.headers["X-Hashcash"] };
		const body = JSON.parse(q.body);
		st.cmds.push(Object.assign({ body }, ctx));
		const r = body.map((c) => command(c, ctx));
		if (r.length === 1 && r[0] && r[0].bare !== undefined) { return { status: 200, body: JSON.stringify(r[0].bare) }; }
		if (r.length === 1 && r[0] && r[0].http) { return r[0].http; }
		return { status: 200, body: JSON.stringify(r) };
	}
	function down(q) {
		st.downloads++;
		const h = q.url.slice(DL.length);
		const body = h === "PPPPPPPP" ? (opts.tamper ? opts.tamper(PIC_CT) : PIC_CT) : crypto.randomBytes(12);
		return new Response(body, { status: 200 });
	}
	function up(q) {
		const off = Number(q.url.slice(UL.length + 1));
		st.chunks.push({ off, body: Buffer.from(q.body), headers: q.headers });
		if (opts.onChunk) { const r = opts.onChunk(off, q); if (r !== undefined) { return r; } }
		// The chunk that ends the file (the size `u` asked for) answers the completion handle.
		if (off + q.body.length >= st.expect) { return new Response(Buffer.from(TOKEN), { status: 200 }); }
		return { status: 200, body: "" };
	}
	const routes = [
		["POST", /^https:\/\/g\.api\.mega\.co\.nz\/cs\?/, cs],
		["GET", /^https:\/\/dl\.example\.test\//, down],
		["POST", /^https:\/\/ul\.example\.test\/up\/\d+$/, up],
	];
	return { st, routes, command, cs, down, up };
}
const TOKEN = Buffer.concat([crypto.createHash("sha256").update("token").digest(), Buffer.from("tail")]);   // 36 bytes

// The service on a stand-in bus with `m` (mega()) as MEGA. Accounts' readCredentials gives
// `stored`. -> { m, handle, requests, call(method, payload, caller) }
function start(m = mega(), { stored = CREDS, onCall, timeouts, routes } = {}) {
	const f = fakeFetch(routes || m.routes);
	const pb = fakePalmbus({ onCall: onCall || ((uri) => {
		if (/readCredentials$/.test(uri)) { return stored ? { returnValue: true, credentials: Object.assign({}, stored) } : { returnValue: true }; }
		return { returnValue: true };
	}) });
	const s = service.start({ palmbus: pb, fetch: f.fetch, idleMs: 0, exit: () => {}, log: { log() {}, error() {} }, timeouts });
	const handle = pb.handles[0];
	return { m, st: m.st, s, handle, requests: f.requests,
		call: (method, payload, caller = DOCS) => ask(handle, method, payload, caller) };
}
const cmdsOf = (st, a) => st.cmds.filter((c) => c.body[0].a === a);
const bodies = (st) => st.cmds.map((c) => c.body);
const bodiesNoTree = (st) => bodies(st).filter((b) => b[0].a !== "f");

// --- the service ----------------------------------------------------------------------------------
test("the service: its bus name, the old services.json methods (plus the core's and quit, info), the package", () => {
	const { handle } = start();
	assert.strictEqual(handle.name, "com.palm.service.mega");
	assert.deepStrictEqual(handle.methods.map((m) => m.slice(1)).sort(), ["checkCredentials", "createFolder", "deleteItem", "deletePhoto",
		"downloadFile", "exchangeCode", "getAuthorizeUrl", "info", "listAlbums", "listFolder", "listPhotos", "login", "moveItem", "quit",
		"upload", "uploadFile"]);
	assert.strictEqual(require(path.join(SVC, "package.json")).main, "service.js");
	assert.deepStrictEqual(fs.readdirSync(SVC).sort(), ["adapter.js", "config.js", "hashcash.js", "login.js", "megaapi.js", "megacrypto.js",
		"package.json", "photos.js", "service.js"]);
});

test("caller rules: file methods for the FILE_APP_IDS; login, checkCredentials and photo methods open", async () => {
	const { call } = start();
	for (const m of ["listFolder", "downloadFile", "uploadFile", "createFolder", "moveItem", "deleteItem"]) {
		for (const who of [{}, { appId: "com.palm.app.mega-auth" }, PHOTOS, { appId: "org.webosports.app.documentsX" }]) {
			const r = await call(m, { accountId: "acc", fileId: "FFFFFFFF", name: "b", localPath: "/x" }, who);
			assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m + " " + JSON.stringify(who));
		}
	}
	for (const who of [DOCS, { appId: "org.webosports.app.documents-77" }, { service: "com.palm.stark.files.service" }]) {
		assert.strictEqual((await call("listFolder", { accountId: "acc" }, who)).returnValue, true, JSON.stringify(who));
	}
	for (const who of [{}, { appId: "com.palm.app.mega-auth 12" }, { appId: "com.palm.app.accounts-3 4" }]) {
		assert.notStrictEqual((await call("login", { email: EMAIL, password: V1.password }, who)).errorCode, "PERMISSION_DENIED");
	}
	assert.strictEqual((await call("checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS)).returnValue, true);
	assert.strictEqual((await call("listAlbums", { accountId: "acc" }, {})).returnValue, true);
	assert.strictEqual((await call("listPhotos", { accountId: "acc" }, {})).returnValue, true);
});

test("getAuthorizeUrl and exchangeCode: NOT_SUPPORTED, MEGA signs in with login", async () => {
	const { call, requests } = start();
	assert.strictEqual((await call("getAuthorizeUrl", {}, {})).errorCode, "NOT_SUPPORTED");
	assert.strictEqual((await call("exchangeCode", { code: "c" }, {})).errorCode, "NOT_SUPPORTED");
	assert.strictEqual(requests.length, 0);
});

// --- login -----------------------------------------------------------------------------------------
async function signIn(opts, payload) {
	const t = start(mega(opts));
	const r = await t.call("login", payload || { email: EMAIL, password: V1.password }, {});
	return Object.assign(t, { r });
}

function assertNoSecrets(requests) {
	const pw = V1.password;
	for (const q of requests) {
		const all = q.url + " " + JSON.stringify(q.headers) + " " + (typeof q.body === "string" ? q.body : "");
		assert.ok(!all.includes(pw), "the password is never sent");
		assert.ok(!all.includes(e64(MASTER)), "nor the master key");
		assert.ok(!all.includes(V1.pwKey) && !all.includes(e64(Buffer.from(V1.pwKey, "hex"))), "nor the password key");
	}
}

test("login (v1): us0, us with megajs's uh, ug; the session id from the csid, the master key from k", async () => {
	const { r, st, requests } = await signIn();
	assert.deepStrictEqual(r, { returnValue: true, username: EMAIL, alias: "U Ser",
		credentials: { common: { accessToken: SID, mk: e64(MASTER), email: EMAIL, u: USER, name: "U Ser" } } });
	assert.deepStrictEqual(bodies(st), [[{ a: "us0", user: EMAIL }], [{ a: "us", user: EMAIL, uh: V1.uh }], [{ a: "ug" }]]);
	assert.deepStrictEqual(st.cmds.map((c) => c.sid), [null, null, SID]);
	const ids = st.cmds.map((c) => Number(c.id));
	assert.ok(ids.every((id, i) => Number.isInteger(id) && (i === 0 || id === ids[i - 1] + 1)), "?id= counts up: " + ids);
	for (const q of requests) {
		assert.strictEqual(q.method, "POST");
		assert.deepStrictEqual(q.headers, { "Content-Type": "application/json" });
	}
	assertNoSecrets(requests);
});

test("login (v2): PBKDF2-SHA512 with us0's salt; the email is lowercased", async () => {
	const { r, st, requests } = await signIn({ version: 2 }, { username: EMAIL.toUpperCase(), password: V2.password });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.credentials.common.accessToken, SID);
	assert.deepStrictEqual(bodies(st).slice(0, 2), [[{ a: "us0", user: EMAIL }], [{ a: "us", user: EMAIL, uh: V2.uh }]]);
	assertNoSecrets(requests);
});

test("login: two-factor accounts answer MEGA_MFA_REQUIRED until the code comes, sent as a string", async () => {
	const t = start(mega({ mfa: "123456" }));
	const first = await t.call("login", { email: EMAIL, password: V1.password }, {});
	assert.strictEqual(first.errorCode, "MEGA_MFA_REQUIRED");
	const ok = await t.call("login", { email: EMAIL, password: V1.password, mfa: 123456 }, {});
	assert.strictEqual(ok.returnValue, true);
	assert.deepStrictEqual(cmdsOf(t.st, "us").map((c) => c.body[0]), [{ a: "us", user: EMAIL, uh: V1.uh },
		{ a: "us", user: EMAIL, uh: V1.uh, mfa: "123456" }]);
});

test("login: a wrong password, a missing one, an incomplete or undecryptable reply", async () => {
	assert.strictEqual((await signIn({}, { email: EMAIL, password: "wrong" })).r.errorCode, "MEGA_BAD_CREDENTIALS");
	assert.strictEqual((await signIn({ on: (c) => (c.a === "us" ? -2 : undefined) })).r.errorCode, "MEGA_BAD_CREDENTIALS");
	for (const p of [{ email: EMAIL }, { password: "x" }, {}, { email: EMAIL, password: 5 }]) {
		const { r, requests } = await signIn({}, p);
		assert.deepStrictEqual(r, { returnValue: false, errorCode: "MISSING_CREDENTIALS", errorText: "need email and password" });
		assert.strictEqual(requests.length, 0);
	}
	assert.strictEqual((await signIn({ on: (c) => (c.a === "us" ? { k: "x" } : undefined) })).r.errorCode, "MEGA_LOGIN_INCOMPLETE");
	const junk = await signIn({ on: (c) => (c.a === "us" ? { k: e64(crypto.randomBytes(16)), privk: e64(crypto.randomBytes(64)), csid: "AAAA" } : undefined) });
	assert.strictEqual(junk.r.errorCode, "MEGA_CRYPTO_FAILED");
	assert.strictEqual((await signIn({ on: (c) => (c.a === "us" ? -16 : undefined) })).r.errorCode, "MEGA_EBLOCKED");
});

test("login: ug failing still signs in, named by the email", async () => {
	const { r } = await signIn({ on: (c) => (c.a === "ug" ? -15 : undefined) });
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.username, EMAIL);
	assert.strictEqual(r.alias, undefined);
	assert.deepStrictEqual(Object.keys(r.credentials.common).sort(), ["accessToken", "email", "mk", "u"]);
});

test("login: a 402 proof of work is solved and us sent again under the same id with X-Hashcash", async () => {
	const token = crypto.randomBytes(48);
	let asked = 0;
	const m = mega({ on: (c, ctx) => {
		if (c.a === "us" && !ctx.hashcash) { asked++; return { http: { status: 402, body: "", headers: { "X-Hashcash": `1:240:1792400357:${e64(token)}` } } }; }
		return undefined;
	} });
	const t = start(m);
	const r = await t.call("login", { email: EMAIL, password: V1.password }, {});
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	const us = cmdsOf(t.st, "us");
	assert.strictEqual(asked, 1);
	assert.strictEqual(us.length, 2);
	assert.strictEqual(us[0].id, us[1].id, "the same ?id=");
	const [v, tok, prefix] = us[1].hashcash.split(":");
	assert.deepStrictEqual([v, tok], ["1", e64(token)]);
	// Independently: SHA-256(prefix || token x 262144) starts with a word <= the threshold.
	const h = crypto.createHash("sha256").update(Buffer.concat([d64(prefix), Buffer.concat(Array(262144).fill(token))])).digest();
	assert.ok(h.readUInt32BE(0) <= ((((240 & 63) << 1) + 1) << ((240 >> 6) * 7 + 3)) >>> 0);
	assert.deepStrictEqual(us[1].body, us[0].body);
});

test("a 402 without a challenge, or past four rounds, is MEGA_EHTTP_402", async () => {
	const none = await signIn({ on: (c) => (c.a === "us" ? { http: { status: 402, body: "" } } : undefined) });
	assert.strictEqual(none.r.errorCode, "MEGA_EHTTP_402");
	assert.strictEqual(none.r.status, 402);
	const token = crypto.randomBytes(48);
	const busy = await signIn({ on: (c) => (c.a === "us" ? { http: { status: 402, body: "", headers: { "X-Hashcash": `1:255:1:${e64(token)}` } } } : undefined) });
	assert.strictEqual(busy.r.errorCode, "MEGA_EHTTP_402");
	assert.strictEqual(cmdsOf(busy.st, "us").length, 5, "the first try and four answers");
	const bad = await signIn({ on: (c) => (c.a === "us" ? { http: { status: 402, body: "", headers: { "X-Hashcash": "2:1:1:x" } } } : undefined) });
	assert.strictEqual(bad.r.errorCode, "MEGA_HASHCASH");
});

// --- the cs request -----------------------------------------------------------------------------------
test("EAGAIN (-3), bare or as the result, is sent again under a new id; four times, then MEGA_EAGAIN", async () => {
	let n = 0;
	const t = start(mega({ on: (c) => (c.a === "f" && n++ < 2 ? (n === 1 ? { bare: -3 } : -3) : undefined) }));
	const r = await t.call("listFolder", { accountId: "acc" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	const f = cmdsOf(t.st, "f");
	assert.strictEqual(f.length, 3);
	assert.strictEqual(new Set(f.map((c) => c.id)).size, 3, "a new id each time");
	const busy = start(mega({ on: (c) => (c.a === "f" ? -3 : undefined) }));
	assert.strictEqual((await busy.call("listFolder", { accountId: "acc" })).errorCode, "MEGA_EAGAIN");
	assert.strictEqual(cmdsOf(busy.st, "f").length, 5);
});

test("errors: per command and bare negatives are MEGA_<name>; HTTP errors MEGA_EHTTP_<status>; junk MEGA_EPARSE", async () => {
	const code = async (on, method = "listFolder") => (await start(mega({ on })).call(method, { accountId: "acc" }));
	assert.deepStrictEqual(await code((c) => (c.a === "f" ? -15 : undefined)),
		{ returnValue: false, errorCode: "MEGA_ESID", errorText: "MEGA f: ESID (-15), the session has expired, sign in again" });
	assert.strictEqual((await code((c) => (c.a === "f" ? { bare: -16 } : undefined))).errorCode, "MEGA_EBLOCKED");
	assert.strictEqual((await code((c) => (c.a === "f" ? -19 : undefined))).errorCode, "MEGA_ETOOMANYCONNECTIONS");
	assert.strictEqual((await code((c) => (c.a === "f" ? -99 : undefined))).errorCode, "MEGA_E-99");
	const h = await code((c) => (c.a === "f" ? { http: { status: 500, body: "Server Too Busy" } } : undefined));
	assert.deepStrictEqual(h, { returnValue: false, errorCode: "MEGA_EHTTP_500", errorText: "MEGA answered HTTP 500", status: 500 });
	assert.strictEqual((await code((c) => (c.a === "f" ? { http: { status: 200, body: "<html>" } } : undefined))).errorCode, "MEGA_EPARSE");
	assert.strictEqual((await code((c) => (c.a === "f" ? { http: { status: 200, body: "\"str\"" } } : undefined))).errorCode, "MEGA_EPARSE");
	assert.strictEqual((await code((c) => (c.a === "f" ? { http: { status: 200, body: "[]" } } : undefined))).errorCode, "MEGA_BAD_REPLY");
});

test("credentials without a master key are MEGA_NO_SESSION before any request", async () => {
	for (const stored of [{ accessToken: SID }, { accessToken: SID, mk: "short" }]) {
		const t = start(mega(), { stored });
		for (const [m, p] of [["listFolder", {}], ["downloadFile", { fileId: "FFFFFFFF", localPath: dl() }], ["createFolder", { name: "x" }],
			["moveItem", { fileId: "FFFFFFFF", name: "y" }], ["deleteItem", { fileId: "FFFFFFFF" }]]) {
			assert.strictEqual((await t.call(m, Object.assign({ accountId: "acc" }, p))).errorCode, "MEGA_NO_SESSION", m);
		}
		assert.strictEqual(t.requests.length, 0);
	}
});

// --- checkCredentials -----------------------------------------------------------------------------
test("checkCredentials: ug with the session; an expired one is MEGA_ESID; none is 401_UNAUTHORIZED", async () => {
	const t = start();
	assert.deepStrictEqual(await t.call("checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS),
		{ returnValue: true, renewedCredentials: null, username: EMAIL, displayName: "U Ser" });
	assert.deepStrictEqual(bodies(t.st), [[{ a: "ug" }]]);
	assert.strictEqual(t.st.cmds[0].sid, SID);
	assert.strictEqual((await t.call("checkCredentials", { credentials: { common: { accessToken: "old" } } }, ACCOUNTS)).errorCode, "MEGA_ESID");
	assert.strictEqual((await t.call("checkCredentials", {}, ACCOUNTS)).errorCode, "401_UNAUTHORIZED");
});

// --- listFolder ---------------------------------------------------------------------------------------
test("listFolder: the tree (f c:1 r:1), names decrypted, entries in the old shape; the root sentinel", async () => {
	const t = start();
	const r = await t.call("listFolder", { accountId: "acc", folderId: "DDDDDDDD" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entries: [
		{ id: "FFFFFFFF", type: "file", name: "a.txt", size: 12, modified: 1700000100000, path: "FFFFFFFF", mimeType: null },
		{ id: "EEEEEEEE", type: "folder", name: "Sub", size: 0, modified: 1700000000000, path: "EEEEEEEE", mimeType: "application/vnd.mega.folder" },
		{ id: "PPPPPPPP", type: "file", name: "pic.jpg", size: 300000, modified: 1700000100000, path: "PPPPPPPP", mimeType: "image/jpeg" },
	] });
	assert.deepStrictEqual(bodies(t.st), [[{ a: "f", c: 1, r: 1 }]]);
	assert.strictEqual(t.st.cmds[0].sid, SID);
	for (const root of [{}, { folderId: "root" }, { path: "root" }]) {
		const top = await t.call("listFolder", Object.assign({ accountId: "acc" }, root));
		assert.deepStrictEqual(top.entries.map((e) => e.name), ["Docs", "Shared", "notes ü.txt", "Camera Uploads", "XXXXXXXX"], JSON.stringify(root));
	}
	assert.strictEqual(cmdsOf(t.st, "f").length, 1, "the tree is kept within a burst");
	assert.deepStrictEqual((await t.call("listFolder", { accountId: "acc", folderId: "nothere1" })).entries, []);
});

test("listFolder: a node keyed by a share key (its first pair not ours) is opened through `ok`", async () => {
	const t = start();
	const r = await t.call("listFolder", { accountId: "acc", folderId: "SSSSSSSS" });
	assert.deepStrictEqual(r.entries.map((e) => e.name), ["inner.txt"]);
	// A forged share-key proof (ha) is not trusted: the node stays closed.
	const m = mega();
	m.st.acct.tree.ok[0].ha = e64(crypto.randomBytes(16));
	const f = start(m);
	assert.deepStrictEqual((await f.call("listFolder", { accountId: "acc", folderId: "SSSSSSSS" })).entries.map((e) => e.name), ["ZZZZZZZZ"]);
});

test("the tree is fetched again after a change, and for another session", async () => {
	const t = start();
	await t.call("listFolder", { accountId: "acc" });
	await t.call("deleteItem", { accountId: "acc", fileId: "NNNNNNNN" });
	await t.call("listFolder", { accountId: "acc" });
	assert.strictEqual(cmdsOf(t.st, "f").length, 2);
	await t.call("listFolder", { credentials: { common: Object.assign({}, CREDS, { accessToken: "other" }) } });
	assert.strictEqual(cmdsOf(t.st, "f").length, 3);
});

// --- downloadFile -------------------------------------------------------------------------------------
test("downloadFile: g for the URL, the ciphertext streamed, decrypted and MAC-checked into localPath", async () => {
	const t = start();
	const dest = dl();
	const r = await t.call("downloadFile", { accountId: "acc", fileId: "PPPPPPPP", localPath: dest });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, path: dest });
	assert.ok(fs.readFileSync(dest).equals(PIC_BYTES));
	assert.deepStrictEqual(bodiesNoTree(t.st), [[{ a: "g", g: 1, ssl: 2, n: "PPPPPPPP" }]]);
	assert.strictEqual(t.requests[t.requests.length - 1].url, DL + "PPPPPPPP");
	assert.strictEqual(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
	assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o644);
	assert.deepStrictEqual(fs.readdirSync(path.dirname(dest)), ["file.bin"], "no .mzenc or .part left");
});

test("downloadFile: altered bytes fail the MAC and leave no file; a short body; a 509; an unknown node", async () => {
	const altered = start(mega({ tamper: (ct) => { const b = Buffer.from(ct); b[200000] ^= 1; return b; } }));
	const dest = dl();
	const r = await altered.call("downloadFile", { accountId: "acc", fileId: "PPPPPPPP", localPath: dest });
	assert.strictEqual(r.errorCode, "MEGA_MAC_MISMATCH");
	assert.deepStrictEqual(fs.readdirSync(path.dirname(dest)), []);
	const short = start(mega({ tamper: (ct) => ct.subarray(0, 1000) }));
	assert.strictEqual((await short.call("downloadFile", { accountId: "acc", fileId: "PPPPPPPP", localPath: dl() })).errorCode, "MEGA_DOWNLOAD_FAILED");
	const m = mega();
	const limit = start(m, { routes: [m.routes[0], ["GET", /dl\.example/, () => ({ status: 509, body: "" })]] });
	const lr = await limit.call("downloadFile", { accountId: "acc", fileId: "PPPPPPPP", localPath: dl() });
	assert.deepStrictEqual([lr.errorCode, lr.status], ["MEGA_DOWNLOAD_FAILED", 509]);
	const t = start();
	for (const id of ["nothere1", "DDDDDDDD", "XXXXXXXX"]) {
		assert.strictEqual((await t.call("downloadFile", { accountId: "acc", fileId: id, localPath: dl() })).errorCode, "MEGA_NODE_NOT_FOUND", id);
	}
	assert.strictEqual(cmdsOf(t.st, "g").length, 0);
	const nog = start(mega({ on: (c) => (c.a === "g" ? { e: -18 } : undefined) }));
	assert.strictEqual((await nog.call("downloadFile", { accountId: "acc", fileId: "PPPPPPPP", localPath: dl() })).errorCode, "MEGA_NO_DOWNLOAD_URL");
});

// --- uploadFile -----------------------------------------------------------------------------------------
const LOCAL = path.join(TMP, "pic-local.jpg");
fs.writeFileSync(LOCAL, PIC_BYTES);

// Run fn with crypto.randomBytes(24) giving the vectors' file key, so the upload's MAC and key are
// megajs's (lib/mega-vectors.js).
async function withFileKey(fn) {
	const real = crypto.randomBytes;
	crypto.randomBytes = (n, ...rest) => (n === 24 ? Buffer.from(V.fileKey24, "hex") : real(n, ...rest));
	try { return await fn(); } finally { crypto.randomBytes = real; }
}

test("uploadFile: u, the file encrypted in MEGA's chunks to <url>/<offset>, then p with megajs's key and the name", async () => {
	const t = start(mega());
	const r = await withFileKey(() => t.call("uploadFile", { accountId: "acc", folderId: "DDDDDDDD", localPath: LOCAL, name: "Café ü.jpg" }));
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, name: "Café ü.jpg", id: "NEWFILE1", size: 300000 });
	const [u, p] = bodiesNoTree(t.st);
	assert.deepStrictEqual(u, [{ a: "u", ssl: 2, s: 300000, ms: 0, r: 0, e: 0, v: 2 }]);
	assert.deepStrictEqual(t.st.chunks.map((c) => [c.off, c.body.length]), [[0, 131072], [131072, 168928]]);
	assert.ok(t.st.chunks.every((c) => Object.keys(c.headers).length === 0), "the bytes as they are, as megajs sends them");
	const n = p[0].n[0];
	assert.deepStrictEqual(Object.keys(p[0]), ["a", "t", "n"]);
	assert.deepStrictEqual([p[0].a, p[0].t, n.h, n.t], ["p", "DDDDDDDD", e64(TOKEN), 0]);
	const full = unecb(MASTER, d64(n.k));
	assert.strictEqual(e64(full), PIC.fullKey, "the key with megajs's MAC, wrapped with the master key");
	assert.deepStrictEqual(openAttr(fold(full), n.a), { n: "Café ü.jpg" });
	const sent = Buffer.concat(t.st.chunks.map((c) => c.body));
	assert.ok(ctr(fold(full), full.subarray(16, 24), sent).equals(PIC_BYTES), "the chunks decrypt to the file");
	assert.deepStrictEqual(t.st.cmds.filter((c) => c.body[0].a !== "f").map((c) => c.sid), [SID, SID]);
});

test("uploadFile: a fresh key each time; the root; the local name by default; an empty file is one empty chunk", async () => {
	const t = start(mega());
	await t.call("uploadFile", { accountId: "acc", localPath: LOCAL });
	await t.call("uploadFile", { accountId: "acc", localPath: LOCAL });
	const ps = cmdsOf(t.st, "p").map((c) => c.body[0]);
	assert.deepStrictEqual(ps.map((p) => p.t), ["RRRRRRRR", "RRRRRRRR"]);
	assert.notStrictEqual(ps[0].n[0].k, ps[1].n[0].k);
	assert.deepStrictEqual(openAttr(fold(unecb(MASTER, d64(ps[0].n[0].k))), ps[0].n[0].a), { n: "pic-local.jpg" });
	const empty = path.join(TMP, "empty.txt");
	fs.writeFileSync(empty, "");
	const e = start(mega());
	const r = await e.call("uploadFile", { accountId: "acc", localPath: empty, folderId: "EEEEEEEE" });
	assert.strictEqual(r.size, 0);
	assert.deepStrictEqual(e.st.chunks.map((c) => [c.off, c.body.length]), [[0, 0]]);
	assert.strictEqual(cmdsOf(e.st, "u")[0].body[0].s, 0);
});

test("uploadFile replace:true: a new file of the same name in the old one's folder", async () => {
	const t = start(mega());
	const r = await t.call("uploadFile", { accountId: "acc", fileId: "FFFFFFFF", localPath: LOCAL, replace: true });
	assert.strictEqual(r.name, "a.txt");
	const p = cmdsOf(t.st, "p")[0].body[0];
	assert.strictEqual(p.t, "DDDDDDDD");
	assert.deepStrictEqual(openAttr(fold(unecb(MASTER, d64(p.n[0].k))), p.n[0].a), { n: "a.txt" });
	assert.strictEqual((await t.call("uploadFile", { accountId: "acc", fileId: "nothere1", localPath: LOCAL, replace: true })).errorCode, "MEGA_NODE_NOT_FOUND");
});

test("uploadFile: refusals before sending; the upload URL's errors; a missing local file", async () => {
	const t = start(mega());
	for (const [folderId, code] of [["SSSSSSSS", "MEGA_SHARE_UNSUPPORTED"], ["BBBBBBBB", "MEGA_EARGS"], ["FFFFFFFF", "MEGA_EARGS"], ["nothere1", "MEGA_ENOENT"]]) {
		assert.strictEqual((await t.call("uploadFile", { accountId: "acc", folderId, localPath: LOCAL })).errorCode, code, folderId);
	}
	assert.strictEqual((await t.call("uploadFile", { accountId: "acc", localPath: path.join(TMP, "nope.bin") })).errorCode, "LOCAL_FILE_ERROR");
	assert.strictEqual((await t.call("uploadFile", { accountId: "acc", localPath: TMP })).errorCode, "LOCAL_FILE_ERROR");
	assert.deepStrictEqual(bodiesNoTree(t.st), []);
	assert.strictEqual(t.st.chunks.length, 0);
	const quota = start(mega({ onChunk: () => ({ status: 200, body: "-17" }) }));
	assert.strictEqual((await quota.call("uploadFile", { accountId: "acc", localPath: LOCAL })).errorCode, "MEGA_EOVERQUOTA");
	assert.strictEqual(cmdsOf(quota.st, "p").length, 0);
	const odd = start(mega({ onChunk: (off) => (off ? { status: 200, body: "<html>" } : undefined) }));
	assert.strictEqual((await odd.call("uploadFile", { accountId: "acc", localPath: LOCAL })).errorCode, "MEGA_UPLOAD_FAILED");
	const early = start(mega({ onChunk: (off) => (off === 0 ? { status: 200, body: "-3" } : undefined) }));
	assert.strictEqual((await early.call("uploadFile", { accountId: "acc", localPath: LOCAL })).errorCode, "MEGA_EAGAIN");
	const http = start(mega({ onChunk: () => ({ status: 503, body: "" }) }));
	const h = await http.call("uploadFile", { accountId: "acc", localPath: LOCAL });
	assert.deepStrictEqual([h.errorCode, h.status], ["MEGA_UPLOAD_FAILED", 503]);
	const nourl = start(mega({ on: (c) => (c.a === "u" ? {} : undefined) }));
	assert.strictEqual((await nourl.call("uploadFile", { accountId: "acc", localPath: LOCAL })).errorCode, "MEGA_NO_UPLOAD_URL");
	const nonode = start(mega({ on: (c) => (c.a === "p" ? {} : undefined) }));
	assert.strictEqual((await nonode.call("uploadFile", { accountId: "acc", localPath: LOCAL })).errorCode, "MEGA_BAD_REPLY");
});

test("uploadFile: the old base64 text form of the completion handle is taken as it is", async () => {
	const text = e64(TOKEN);
	const t = start(mega({ onChunk: (off) => (off ? { status: 200, body: text } : undefined) }));
	assert.strictEqual((await t.call("uploadFile", { accountId: "acc", localPath: LOCAL })).returnValue, true);
	assert.strictEqual(cmdsOf(t.st, "p")[0].body[0].n[0].h, text);
});

// --- createFolder / moveItem / deleteItem -------------------------------------------------------------
test("createFolder: one p with a new folder node, its key wrapped with the master key; the entry", async () => {
	const t = start();
	const r = await t.call("createFolder", { accountId: "acc", folderId: "DDDDDDDD", name: "Reports 2026 ✓" });
	assert.deepStrictEqual(r, { returnValue: true, renewedCredentials: null, entry: { id: "NEWFOLDR", type: "folder", name: "Reports 2026 ✓",
		size: 0, modified: 1760000000000, path: "NEWFOLDR", mimeType: "application/vnd.mega.folder" } });
	const [[p]] = bodiesNoTree(t.st);
	assert.deepStrictEqual(Object.keys(p), ["a", "t", "n"]);
	assert.deepStrictEqual([p.a, p.t, p.n.length, p.n[0].h, p.n[0].t], ["p", "DDDDDDDD", 1, "xxxxxxxx", 1]);
	assert.deepStrictEqual(Object.keys(p.n[0]), ["h", "t", "a", "k"]);
	const key = unecb(MASTER, d64(p.n[0].k));
	assert.strictEqual(key.length, 16);
	assert.deepStrictEqual(openAttr(key, p.n[0].a), { n: "Reports 2026 ✓" });
	await t.call("createFolder", { accountId: "acc", name: "Top" });
	assert.strictEqual(cmdsOf(t.st, "p")[1].body[0].t, "RRRRRRRR");
});

test("createFolder refuses a taken name, a non-folder parent, a shared folder, the rubbish bin, locally", async () => {
	const t = start();
	for (const [folderId, name, code] of [["DDDDDDDD", "Sub", "MEGA_EEXIST"], ["DDDDDDDD", "a.txt", "MEGA_EEXIST"], ["FFFFFFFF", "X", "MEGA_EARGS"],
		["nothere1", "X", "MEGA_ENOENT"], ["SSSSSSSS", "X", "MEGA_SHARE_UNSUPPORTED"], ["BBBBBBBB", "X", "MEGA_EARGS"], ["IIIIIIII", "X", "MEGA_EARGS"]]) {
		assert.strictEqual((await t.call("createFolder", { accountId: "acc", folderId, name })).errorCode, code, folderId + " " + name);
	}
	assert.strictEqual((await t.call("createFolder", { accountId: "acc", name: "a/b" })).errorCode, "MISSING_ARGS");
	assert.deepStrictEqual(bodiesNoTree(t.st), []);
	assert.strictEqual((await start(mega({ on: (c) => (c.a === "p" ? -11 : undefined) })).call("createFolder", { accountId: "acc", name: "N" })).errorCode, "MEGA_EACCESS");
	assert.strictEqual((await start(mega({ on: (c) => (c.a === "p" ? {} : undefined) })).call("createFolder", { accountId: "acc", name: "N" })).errorCode, "MEGA_BAD_REPLY");
});

test("moveItem, move only: one m to the target; the entry is the item in its new place", async () => {
	const t = start();
	const r = await t.call("moveItem", { accountId: "acc", fileId: "FFFFFFFF", toFolderId: "EEEEEEEE" });
	assert.deepStrictEqual(r.entry, { id: "FFFFFFFF", type: "file", name: "a.txt", size: 12, modified: 1700000100000, path: "FFFFFFFF", mimeType: null });
	assert.deepStrictEqual(bodiesNoTree(t.st), [[{ a: "m", n: "FFFFFFFF", t: "EEEEEEEE" }]]);
	await t.call("moveItem", { accountId: "acc", fileId: "FFFFFFFF", toRoot: true });
	assert.deepStrictEqual(bodiesNoTree(t.st)[1], [{ a: "m", n: "FFFFFFFF", t: "RRRRRRRR" }]);
});

test("moveItem, rename only: one a with every other attribute kept, under the file's folded key", async () => {
	const t = start();
	const r = await t.call("moveItem", { accountId: "acc", fileId: "FFFFFFFF", name: "b.jpg" });
	assert.strictEqual(r.entry.name, "b.jpg");
	assert.strictEqual(r.entry.mimeType, "image/jpeg");
	const [[c]] = bodiesNoTree(t.st);
	assert.deepStrictEqual(Object.keys(c), ["a", "n", "at"]);
	assert.deepStrictEqual([c.a, c.n], ["a", "FFFFFFFF"]);
	const attrs = openAttr(fold(t.st.acct.keys.FFFFFFFF), c.at);
	assert.deepStrictEqual(attrs, { n: "b.jpg", c: "fingerprint", lbl: 2 });
	assert.deepStrictEqual(Object.keys(attrs), ["n", "c", "lbl"], "order kept");
	await t.call("moveItem", { accountId: "acc", fileId: "DDDDDDDD", name: "Documents" });
	assert.deepStrictEqual(openAttr(t.st.acct.keys.DDDDDDDD, bodiesNoTree(t.st)[1][0].at), { n: "Documents" }, "a folder's own 16-byte key");
});

test("moveItem, move and rename: m first, then a; a rename failing after the move is the error", async () => {
	const t = start();
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", fileId: "NNNNNNNN", toFolderId: "DDDDDDDD", name: "notes-2.txt" })).entry.name, "notes-2.txt");
	assert.deepStrictEqual(bodiesNoTree(t.st).map((b) => b[0].a), ["m", "a"]);
	const b = start(mega({ on: (c) => (c.a === "a" ? -11 : undefined) }));
	assert.strictEqual((await b.call("moveItem", { accountId: "acc", fileId: "NNNNNNNN", toFolderId: "DDDDDDDD", name: "x" })).errorCode, "MEGA_EACCESS");
	const m = start(mega({ on: (c) => (c.a === "m" ? -11 : undefined) }));
	assert.strictEqual((await m.call("moveItem", { accountId: "acc", fileId: "NNNNNNNN", toFolderId: "DDDDDDDD", name: "x" })).errorCode, "MEGA_EACCESS");
	assert.deepStrictEqual(bodiesNoTree(m.st).map((x) => x[0].a), ["m"], "no rename after a failed move");
});

test("moveItem refuses cycles, taken names, shared targets, roots, undecryptable and unknown nodes, locally", async () => {
	const t = start();
	for (const [p, code] of [
		[{ fileId: "DDDDDDDD", toFolderId: "EEEEEEEE" }, "MEGA_ECIRCULAR"], [{ fileId: "DDDDDDDD", toFolderId: "DDDDDDDD" }, "MEGA_ECIRCULAR"],
		[{ fileId: "FFFFFFFF", name: "Sub" }, "MEGA_EEXIST"], [{ fileId: "NNNNNNNN", toFolderId: "DDDDDDDD", name: "a.txt" }, "MEGA_EEXIST"],
		[{ fileId: "FFFFFFFF", toFolderId: "SSSSSSSS" }, "MEGA_SHARE_UNSUPPORTED"], [{ fileId: "FFFFFFFF", toFolderId: "BBBBBBBB" }, "MEGA_EARGS"], [{ fileId: "TTTTTTTT", toFolderId: "IIIIIIII" }, "MEGA_EARGS"],
		[{ fileId: "RRRRRRRR", name: "x" }, "MEGA_EARGS"], [{ fileId: "nothere1", name: "x" }, "MEGA_ENOENT"],
		[{ fileId: "XXXXXXXX", name: "x" }, "MEGA_EKEY"],
	]) {
		assert.strictEqual((await t.call("moveItem", Object.assign({ accountId: "acc" }, p))).errorCode, code, JSON.stringify(p));
	}
	assert.strictEqual((await t.call("moveItem", { accountId: "acc", fileId: "FFFFFFFF", toFolderId: "DDDDDDDD", name: "a.txt" })).entry.name, "a.txt");
	assert.deepStrictEqual(bodiesNoTree(t.st), [], "nothing to change sends nothing");
});

test("deleteItem: to the Rubbish Bin with m; what is already there for good with d; roots refused", async () => {
	const t = start();
	assert.deepStrictEqual(await t.call("deleteItem", { accountId: "acc", fileId: "FFFFFFFF" }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(await t.call("deleteItem", { accountId: "acc", fileId: "TTTTTTTT" }), { returnValue: true, renewedCredentials: null });
	assert.deepStrictEqual(bodiesNoTree(t.st), [[{ a: "m", n: "FFFFFFFF", t: "BBBBBBBB" }], [{ a: "d", n: "TTTTTTTT" }]]);
	for (const h of ["RRRRRRRR", "BBBBBBBB", "IIIIIIII"]) {
		assert.strictEqual((await t.call("deleteItem", { accountId: "acc", fileId: h })).errorCode, "MEGA_EARGS", h);
	}
	assert.strictEqual((await t.call("deleteItem", { accountId: "acc", fileId: "nothere1" })).errorCode, "MEGA_ENOENT");
	assert.strictEqual((await t.call("deleteItem", { accountId: "acc", fileId: "root" })).errorCode, "BAD_ARGS");
	assert.strictEqual(bodiesNoTree(t.st).length, 2);
	const e = await start(mega({ on: (c) => (c.a === "m" ? -9 : undefined) })).call("deleteItem", { accountId: "acc", fileId: "NNNNNNNN" });
	assert.deepStrictEqual(e, { returnValue: false, errorCode: "MEGA_ENOENT", errorText: "MEGA m: ENOENT (-9), not found" });
});

// --- Photos ------------------------------------------------------------------------------------------
test("listAlbums: every folder with images; a placeholder when there are none or the tree fails", async () => {
	const t = start();
	assert.deepStrictEqual(await t.call("listAlbums", { accountId: "acc" }, PHOTOS),
		{ returnValue: true, albums: [{ aid: "DDDDDDDD", name: "Docs", size: { images: 1 } }] });
	const PLACEHOLDER = { returnValue: true, albums: [{ aid: "", name: "Camera Uploads", size: { images: 0 } }] };
	assert.deepStrictEqual(await start(mega({ on: (c) => (c.a === "f" ? -15 : undefined) })).call("listAlbums", { accountId: "acc" }, PHOTOS), PLACEHOLDER);
	const m = mega();
	m.st.acct.tree.f = m.st.acct.tree.f.filter((n) => n.h !== "PPPPPPPP");
	assert.deepStrictEqual(await start(m).call("listAlbums", { accountId: "acc" }, PHOTOS), PLACEHOLDER);
	assert.strictEqual((await start(mega(), { stored: null }).call("listAlbums", { accountId: "acc" }, PHOTOS)).errorCode, "NO_STORED_CREDENTIALS");
});

test("listAlbums: the Cloud Drive root is an album when it holds images itself", async () => {
	const m = mega();
	m.st.acct.tree.f.find((n) => n.h === "PPPPPPPP").p = "RRRRRRRR";
	assert.deepStrictEqual((await start(m).call("listAlbums", { accountId: "acc" }, PHOTOS)).albums,
		[{ aid: "RRRRRRRR", name: "Cloud Drive", size: { images: 1 } }]);
});

test("listPhotos: each image downloaded and decrypted to PHOTO_TMP_DIR, file:// links; kept for the next time", async () => {
	const t = start();
	const r = await t.call("listPhotos", { accountId: "acc", aid: "DDDDDDDD" }, PHOTOS);
	const local = path.join(Config.PHOTO_TMP_DIR, "PPPPPPPP-pic.jpg");
	assert.deepStrictEqual(r, { returnValue: true, photos: [{ pid: "PPPPPPPP", src_big: "file://" + local, src_small: "file://" + local,
		caption: "pic.jpg", type: "image", fileName: "pic.jpg" }] });
	assert.ok(fs.readFileSync(local).equals(PIC_BYTES));
	await t.call("listPhotos", { accountId: "acc", aid: "DDDDDDDD" }, PHOTOS);
	assert.strictEqual(cmdsOf(t.st, "g").length, 1, "a copy with the right size is not fetched again");
	assert.deepStrictEqual(await start().call("listPhotos", { accountId: "acc", aid: "" }, PHOTOS), { returnValue: true, photos: [] });
	assert.deepStrictEqual(await start().call("listPhotos", { accountId: "acc" }, PHOTOS), { returnValue: true, photos: [] });
});

test("listPhotos: an image that cannot be had is left out; the listing failing fails the call", async () => {
	fs.rmSync(Config.PHOTO_TMP_DIR, { recursive: true, force: true });
	const t = start(mega({ on: (c) => (c.a === "g" ? -9 : undefined) }));
	assert.deepStrictEqual(await t.call("listPhotos", { accountId: "acc", aid: "DDDDDDDD" }, PHOTOS), { returnValue: true, photos: [] });
	assert.strictEqual((await start(mega({ on: (c) => (c.a === "f" ? -15 : undefined) })).call("listPhotos", { accountId: "acc", aid: "DDDDDDDD" }, PHOTOS)).errorCode, "MEGA_ESID");
});

test("upload (Photos): into the album, or the existing Camera Uploads folder, or a new one; pid is the handle", async () => {
	const t = start();
	assert.deepStrictEqual(await t.call("upload", { accountId: "acc", albumId: "DDDDDDDD", path: LOCAL }, PHOTOS),
		{ returnValue: true, pid: "NEWFILE1", name: "pic-local.jpg", size: 300000 });
	await t.call("upload", { accountId: "acc", path: LOCAL }, PHOTOS);
	assert.deepStrictEqual(cmdsOf(t.st, "p").map((c) => c.body[0].t), ["DDDDDDDD", "CCCCCCCC"]);
	const m = mega();
	m.st.acct.tree.f = m.st.acct.tree.f.filter((n) => n.h !== "CCCCCCCC");
	const n = start(m);
	assert.strictEqual((await n.call("upload", { accountId: "acc", path: LOCAL }, PHOTOS)).pid, "NEWFILE1");
	const ps = cmdsOf(n.st, "p").map((c) => c.body[0]);
	assert.deepStrictEqual(ps.map((p) => [p.t, p.n[0].t]), [["RRRRRRRR", 1], ["NEWFOLDR", 0]]);
	assert.deepStrictEqual(openAttr(unecb(MASTER, d64(ps[0].n[0].k)), ps[0].n[0].a), { n: "Camera Uploads" });
});

test("deletePhoto: d with the handle", async () => {
	const t = start();
	assert.deepStrictEqual(await t.call("deletePhoto", { accountId: "acc", pid: "PPPPPPPP" }, PHOTOS), { returnValue: true, pid: "PPPPPPPP" });
	assert.deepStrictEqual(bodies(t.st), [[{ a: "d", n: "PPPPPPPP" }]]);
});

// --- every request failing, in turn ----------------------------------------------------------------
// How the failing request fails.
const MODES = {
	"a 500 reply": () => ({ status: 500, body: "{}" }),
	"no answer (network)": () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
	"a stalled reply": () => new Promise(() => {}),
	"a 401": () => ({ status: 401, body: "{}" }),
	"a reply that is not JSON": () => ({ status: 200, body: "<html>" }),
};

// [method, payload, caller, { minSteps, tolerated(k) -> true when request k failing is absorbed }]
const OPS = [
	["login", { email: EMAIL, password: V1.password }, {}, { minSteps: 3, tolerated: (k) => k >= 3 }],
	["checkCredentials", { credentials: { common: CREDS } }, ACCOUNTS],
	["listFolder", { accountId: "acc", folderId: "DDDDDDDD" }, DOCS],
	["downloadFile", () => ({ accountId: "acc", fileId: "PPPPPPPP", localPath: dl() }), DOCS, { minSteps: 3 }],
	["uploadFile", { accountId: "acc", folderId: "DDDDDDDD", localPath: LOCAL }, DOCS, { minSteps: 5 }],
	["uploadFile (replace)", { accountId: "acc", fileId: "FFFFFFFF", localPath: LOCAL, replace: true }, DOCS, { minSteps: 5 }],
	["createFolder", { accountId: "acc", folderId: "DDDDDDDD", name: "n" }, DOCS, { minSteps: 2 }],
	["moveItem (move and rename)", { accountId: "acc", fileId: "FFFFFFFF", toFolderId: "EEEEEEEE", name: "b.jpg" }, DOCS, { minSteps: 3 }],
	["deleteItem", { accountId: "acc", fileId: "NNNNNNNN" }, DOCS, { minSteps: 2 }],
	["upload", { accountId: "acc", path: LOCAL }, PHOTOS, { minSteps: 5 }],
	["deletePhoto", { accountId: "acc", pid: "PPPPPPPP" }, PHOTOS],
	["listAlbums", { accountId: "acc" }, PHOTOS, { tolerated: () => true }],
	["listPhotos", { accountId: "acc", aid: "DDDDDDDD" }, PHOTOS, { minSteps: 3, tolerated: (k) => k >= 2, fresh: true }],
];

for (const [label, payload, caller, opts = {}] of OPS) {
	const method = label.split(" ")[0];
	for (const [mode, fail] of Object.entries(MODES)) {
		test(`mega ${label}: any request failing (${mode}) is one error reply`, async () => {
			let reached = 0;
			for (let k = 1; k <= 12; k++) {
				if (opts.fresh) { fs.rmSync(Config.PHOTO_TMP_DIR, { recursive: true, force: true }); }
				let n = 0;
				const m = mega();
				const route = (handler) => (q) => { n++; return n === k ? fail(q) : handler(q); };
				const t = start(m, { timeouts: { timeoutMs: 40, idleTimeoutMs: 40 },
					routes: m.routes.map(([verb, re, h]) => [verb, re, route(h)]) });
				const r = await t.call(method, typeof payload === "function" ? payload() : payload, caller);   // exactly one reply, or ask() throws
				if (n < k) {
					assert.strictEqual(r.returnValue, true, `the run with nothing failing failed: ${JSON.stringify(r)}`);
					break;
				}
				reached = k;
				if (!(opts.tolerated && opts.tolerated(k))) {
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
	const denied = start(mega(), { onCall: () => ({ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" }) });
	assert.deepStrictEqual(await denied.call("listFolder", { accountId: "acc" }),
		{ returnValue: false, errorCode: -1, errorText: "Denied method call \"readCredentials\"" });
	const broken = start(mega(), { onCall: () => "not json" });
	assert.strictEqual((await broken.call("deleteItem", { accountId: "acc", fileId: "FFFFFFFF" })).errorCode, "BUS_BAD_REPLY");
});
