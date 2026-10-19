// node --test tests/unit
// Every adapter entry point, and the Photos/auth commands, must answer when a request fails.
//
// Foundations' Future (frameworks/foundations/.../control/future.js) keeps an exception thrown
// inside X.then(scope, fn) on X itself. A callback registered on any Future other than the one
// handed back to the caller - reading a failed request's .result, a parse helper, a TypeError on
// a malformed reply - therefore used to lose the error: the returned Future never settled and
// the luna command hung until its timeout. Here each entry point of each adapter is driven with
// a stand-in HttpCurl whose N-th request fails (a Future carrying an exception, and separately a
// 500 reply), for N = 1, 2, ... until the operation needs fewer requests, so the later steps of
// multi-step operations (MEGA's tree then command...)
// fail as well as the first one. The Future the entry point returns must settle with an error.
//
// multi-step operations (MEGA's tree then command...)
// fail as well as the first one. The Future the entry point returns must settle with an error.
//
// Dropbox, Box, Flickr, kDrive, Koofr, pCloud and S3 are not here: they run on _cloudcore/node (async/await, no Futures), and
// dropbox.test.js, box.test.js, flickr.test.js, kdrive.test.js, koofr.test.js, pcloud.test.js and s3.test.js do the same to them over the bus.
//
// The stand-in Future follows future.js on the point that matters: a throw inside a then()
// callback stays on that Future. Set FOUNDATIONS_FUTURE to the path of Foundations'
// control/future.js to run the same tests against the real one.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const CLOUD = path.join(__dirname, "../../cloud");
const CORE = path.join(CLOUD, "_core/service/_cloudcore");

// --- Future ----------------------------------------------------------------------------------
// As future.js: then() callbacks run in turn once the Future is set, each seeing the current
// outcome; a value a callback (or now()'s function) returns is taken over, a Future nested; an
// exception nobody read is passed on to the next callback; a throw in a callback becomes THIS
// Future's exception; assigning a Future to .result stores the Future itself.
class Fut {
	constructor() { this._then = []; this._r = { isset: false }; this._busy = false; }
	get result() { this._r.wasread = true; if (this._r.exception) throw this._r.exception; return this._r.result; }
	set result(v) { this._r = { result: v, isset: true }; this._dispatch(); }
	setException(e) { this._r = { exception: e, isset: true }; this._dispatch(); }
	get exception() { this._r.wasread = true; return this._r.exception; }
	_ret(v) { if (v !== undefined) { if (v && typeof v.then === "function") this.nest(v); else this.result = v; } }
	now(scope, fn) {
		try { this._ret(fn.call(scope, this)); } catch (e) { this._r = { exception: e, isset: true }; }
		this._dispatch(); return this;
	}
	then(scope, fn) { this._then.push([scope, fn]); this._dispatch(); return this; }
	nest(inner) {
		inner.then(null, () => { try { this.result = inner.result; } catch (e) { this.setException(e); } });
		return this;
	}
	_dispatch() {
		if (this._busy) return;
		this._busy = true;
		while (this._then.length && this._r.isset) {
			const [scope, fn] = this._then.shift();
			this._r.isset = false;
			try {
				this._ret(fn.call(scope, this));
				if (this._r.exception && !this._r.wasread) this._r.isset = true;
			} catch (e) { this._r = { exception: e, isset: true }; }
		}
		this._busy = false;
	}
}

function futureClass() {
	if (!process.env.FOUNDATIONS_FUTURE) { return Fut; }
	const ctx = { exports: { Control: {} }, console: { error() {} },
		Assert: { requireObject() {}, requireFunction() {} } };
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(process.env.FOUNDATIONS_FUTURE, "utf8"), ctx);
	return ctx.exports.Control.Future;
}
const Future = futureClass();
const settledF = (v) => { const f = new Future(); f.result = v; return f; };
const later = (fn) => setImmediate(fn);

// How the failing request fails: its Future carries an exception (curl got no answer), it
// answers 500, or HttpCurl.request throws there and then (as it could before it caught its own
// errors; a throw inside another Future's callback is the case that gets lost).
const MODES = {
	"no answer": (f) => f.setException({ returnValue: false, errorCode: "CURL_FAILED", detail: "stand-in" }),
	"a 500 reply": (f) => { f.result = { status: 500, responseText: "{}" }; },
	"a request that throws": null,
};

// Resolve with what `f` settled with, or { pending: true } if it did not within `ms`. The
// callback goes on `f` itself, the returned Future, so reading it here loses nothing.
function outcome(f, ms = 400) {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve({ pending: true }), ms);
		f.then(null, (fut) => {
			clearTimeout(t);
			try { resolve({ result: fut.result }); } catch (e) { resolve({ error: e }); }
		});
	});
}

const ok = (body, status) => ({ status: status || 200, responseText: body === undefined ? "{}" :
	(typeof body === "string" ? body : JSON.stringify(body)) });

// --- loading ----------------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lost-errors-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCAL = path.join(TMP, "local.bin");
fs.writeFileSync(LOCAL, crypto.randomBytes(100));

function serviceDir(name) {
	const svc = fs.readdirSync(path.join(CLOUD, name, "service")).find((d) => d.startsWith("com.palm.service."));
	return path.join(CLOUD, name, "service", svc);
}

// The connector's files in one context, in sources.json order, with a stand-in HttpCurl:
// request number `failAt` fails as `mode`, every other one gets reply(opts) - asynchronously,
// as curl's replies arrive.
function load(spec, failAt, mode) {
	const dir = serviceDir(spec.dir);
	let n = 0;
	const reply = spec.reply ? spec.reply() : () => ok();
	const ctx = {
		IMPORTS: { foundations: { Control: { Future } } }, Future, require, JSON, Date, Math, Buffer,
		setTimeout, console: { log() {}, error() {} }, MegaHashcash: {},
		HttpCurl: {
			request(opts) {
				const k = ++n, f = new Future();
				if (k === failAt && !MODES[mode]) { throw new TypeError("stand-in HttpCurl.request threw"); }
				later(() => { if (k === failAt) { MODES[mode](f); } else { f.result = reply(opts); } });
				return f;
			},
		},
		OAuth2: { refresh: () => { const f = new Future(); f.setException({ errorCode: "NO_REFRESH_HERE" }); return f; } },
	};
	vm.createContext(ctx);
	const files = [path.join(dir, "config.js")].concat((spec.files || []).map((f) => path.join(dir, f)),
		[path.join(dir, "adapter.js"), path.join(CORE, "cloudservice.js")]);
	for (const f of files) { vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f }); }
	if (spec.setup) { spec.setup(ctx); }
	return { Adapter: ctx.Adapter, sent: () => n };
}

// --- the connectors ---------------------------------------------------------------------------
const OAUTH = { accessToken: "tok", refreshToken: "rt", expiresAt: Date.now() + 3600e3 };
const dl = () => path.join(TMP, "dl-" + crypto.randomBytes(4).toString("hex"));
const urlOf = (o) => new URL(o.url);

// A MEGA account, as in mega-fileops.test.js: Cloud Drive R { Docs D { a.txt F, Sub E }, notes N }.
function megaAccount() {
	const ctx = { IMPORTS: { foundations: { Control: { Future } } }, Buffer, require, Date };
	vm.createContext(ctx);
	const mc = path.join(serviceDir("mega"), "megacrypto.js");
	vm.runInContext(fs.readFileSync(mc, "utf8"), ctx, { filename: mc });
	const MC = ctx.MegaCrypto;
	const master = MC.bytesToA32([...crypto.randomBytes(16)]);
	const wrap = (k) => MC.a32ToB64(MC.ecbEncryptA32(master, k));
	const raw = [{ h: "RRRRRRRR", t: 2, p: "" }, { h: "BBBBBBBB", t: 4, p: "" }];
	const folder = (h, p, n) => { const k = MC.bytesToA32([...crypto.randomBytes(16)]);
		raw.push({ h, p, t: 1, a: MC.encryptAttr({ n }, k), k: `u:${wrap(k)}`, ts: 1700000000 }); };
	const file = (h, p, n) => { const k = MC.bytesToA32([...crypto.randomBytes(32)]);
		raw.push({ h, p, t: 0, a: MC.encryptAttr({ n }, MC.unpackFileKey(k).aesKeyA32), k: `u:${wrap(k)}`, s: 3, ts: 1700000100 }); };
	folder("DDDDDDDD", "RRRRRRRR", "Docs");
	file("FFFFFFFF", "DDDDDDDD", "a.jpg");
	folder("EEEEEEEE", "DDDDDDDD", "Sub");
	file("NNNNNNNN", "RRRRRRRR", "notes.txt");
	return { creds: { accessToken: "SID", mk: MC.a32ToB64(master), email: "u@example.test" }, tree: { f: raw, ok: [] } };
}
const MEGA = megaAccount();


// Each entry: [label, call(Adapter, creds) -> Future, { tolerant, endsFailed, minSteps }].
//   tolerant:   failures are meant to be absorbed (a fallback answer); it only has to settle.
//   endsFailed: the run with no failure still fails, past the last request (no real file to
//               decrypt in a stand-in download), so only "settles" is checked for it.
//   minSteps:   the number of requests the operation makes, so its later steps are known to be
//               failed too.
const CONNECTORS = {
	google: { dir: "google", creds: OAUTH, entries: [
		["listFolder", (A, c) => A.listFolder(c, "root", () => {})],
		["getAccountInfo", (A, c) => A.getAccountInfo(c, () => {})],
		["downloadFile", (A, c) => A.downloadFile(c, "F", dl(), null, () => {})],
		["uploadFile", (A, c) => A.uploadFile(c, "D", LOCAL, "n.bin", null, () => {}), { minSteps: 2 }],
		["uploadReplace", (A, c) => A.uploadReplace(c, "F", LOCAL, null, () => {})],
		["createFolder", (A, c) => A.createFolder(c, "root", "n", () => {})],
		["moveItem (rename)", (A, c) => A.moveItem(c, "F", null, "n", () => {})],
		["moveItem (to a folder)", (A, c) => A.moveItem(c, "F", "D", null, () => {}), { minSteps: 2 }],
		["moveItem (to the root)", (A, c) => A.moveItem(c, "F", "root", null, () => {}), { minSteps: 3 }],
		["deleteItem", (A, c) => A.deleteItem(c, "F", () => {})],
	] },
	onedrive: { dir: "onedrive", creds: OAUTH, entries: [
		["listFolder", (A, c) => A.listFolder(c, "root", () => {})],
		["listSpecialChildren", (A, c) => A.listSpecialChildren(c, "cameraroll", () => {})],
		["getAccountInfo", (A, c) => A.getAccountInfo(c, () => {})],
		["downloadFile", (A, c) => A.downloadFile(c, "F", dl(), null, () => {})],
		["uploadFile", (A, c) => A.uploadFile(c, "D", LOCAL, "n.bin", null, () => {})],
		["uploadReplace", (A, c) => A.uploadReplace(c, "F", LOCAL, null, () => {})],
		["deletePhoto", (A, c) => A.deletePhoto(c, "F", () => {})],
		["createFolder", (A, c) => A.createFolder(c, "root", "n", () => {})],
		["moveItem (to a folder)", (A, c) => A.moveItem(c, "F", "D", null, () => {})],
		["moveItem (to the root)", (A, c) => A.moveItem(c, "F", "root", null, () => {}), { minSteps: 2 }],
		["deleteItem", (A, c) => A.deleteItem(c, "F", () => {})],
	] },
	hidrive: { dir: "hidrive", creds: OAUTH,
		reply: () => (o) => {
			if (/\/user\/me/.test(o.url)) { return ok({ home: "/users/me", email: "u@example.test" }); }
			if (/\/meta\?/.test(o.url)) { return ok({ type: "file" }); }
			if (o.method === "POST" && /\/dir\?/.test(o.url)) { return ok({}, 201); }
			return ok();
		},
		entries: [
			["getAccountInfo", (A, c) => A.getAccountInfo(c, () => {})],
			["listFolder (home)", (A, c) => A.listFolder(c, "home", () => {}), { minSteps: 2 }],
			["listFolder (a path)", (A, c) => A.listFolder(c, "/users/me/x", () => {})],
			["downloadFile", (A, c) => A.downloadFile(c, "/users/me/a.jpg", dl(), null, () => {})],
			["uploadFile", (A, c) => A.uploadFile(c, "home", LOCAL, "n.bin", null, () => {}), { minSteps: 2 }],
			["uploadReplace", (A, c) => A.uploadReplace(c, "/users/me/a.jpg", LOCAL, null, () => {})],
			["createFolder", (A, c) => A.createFolder(c, "home", "n", () => {}), { minSteps: 2 }],
			["moveItem (rename)", (A, c) => A.moveItem(c, "/users/me/a.jpg", null, "b.jpg", () => {}), { minSteps: 2 }],
			["moveItem (move)", (A, c) => A.moveItem(c, "/users/me/a.jpg", "/users/me/d", null, () => {}), { minSteps: 2 }],
			["deleteItem", (A, c) => A.deleteItem(c, "/users/me/a.jpg", () => {}), { minSteps: 2 }],
			["deletePhoto", (A, c) => A.deletePhoto(c, "/users/me/a.jpg", () => {})],
			["ensureAlbumFolder", (A, c) => A.ensureAlbumFolder(c, "Album", () => {}), { minSteps: 2 }],
			["photoAlbums", (A, c) => A.photoAlbums(c, () => {}), { tolerant: true, minSteps: 2 }],
			["resolvePhotoAlbum", (A, c) => A.resolvePhotoAlbum(c, () => {}), { tolerant: true, minSteps: 2 }],
		] },
	yandex: { dir: "yandex", creds: OAUTH,
		reply: () => (o) => {
			if (/\/resources\/(download|upload)\?/.test(o.url)) {
				return ok({ href: "https://dl.example.test/x", method: /upload/.test(o.url) ? "PUT" : "GET" });
			}
			if (o.method === "PUT" && /\/resources\?path=disk%3A%2Fasync/.test(o.url)) {
				return ok({ href: "https://cloud-api.yandex.net/v1/disk/operations/1" }, 202);
			}
			if (/\/operations\//.test(o.url)) { return ok({ status: "success" }); }
			return ok({}, o.method === "DELETE" ? 204 : (o.method === "GET" ? 200 : 201));
		},
		entries: [
			["getAccountInfo", (A, c) => A.getAccountInfo(c, () => {})],
			["listFolder", (A, c) => A.listFolder(c, "disk:/", () => {})],
			["downloadFile", (A, c) => A.downloadFile(c, "disk:/a.jpg", dl(), null, () => {}), { minSteps: 2 }],
			["uploadFile", (A, c) => A.uploadFile(c, "disk:/", LOCAL, "n.bin", null, () => {}), { minSteps: 2 }],
			["uploadReplace", (A, c) => A.uploadReplace(c, "disk:/a.jpg", LOCAL, null, () => {}), { minSteps: 2 }],
			["createFolder", (A, c) => A.createFolder(c, "disk:/", "n", () => {}), { minSteps: 2 }],
			["createFolder (an operation to poll)", (A, c) => A.createFolder(c, "disk:/", "async", () => {}), { minSteps: 3 }],
			["moveItem", (A, c) => A.moveItem(c, "disk:/a.jpg", "disk:/d", null, () => {}), { minSteps: 2 }],
			["deleteItem", (A, c) => A.deleteItem(c, "disk:/a.jpg", () => {})],
			["deletePhoto", (A, c) => A.deletePhoto(c, "disk:/a.jpg", () => {})],
			["ensureAlbumFolder", (A, c) => A.ensureAlbumFolder(c, "Album", () => {})],
			["getTemporaryLink", (A, c) => A.getTemporaryLink(c, "disk:/a.jpg", () => {})],
			["resolvePhotoAlbum", (A, c) => A.resolvePhotoAlbum(c, () => {}), { tolerant: true }],
		] },
	mega: { dir: "mega", creds: MEGA.creds, files: ["megacrypto.js", "megaapi.js"],
		setup: (ctx) => { ctx.Config.PHOTO_TMP_DIR = TMP; },
		reply: () => (o) => {
			if (!/g\.api\.mega\.co\.nz\/cs/.test(o.url)) { return ok(o.method === "POST" ? "UPLOADTOKEN" : ""); }
			const a = JSON.parse(o.body)[0].a;
			const res = { f: MEGA.tree, ug: { email: "u@example.test", name: "U" }, g: { g: "https://dl.example.test/x" },
				u: { p: "https://up.example.test" }, p: { f: [{ h: "HHHHHHHH", ts: 1700000200 }] } }[a];
			return ok([res === undefined ? 0 : res]);
		},
		entries: [
			["getAccountInfo", (A, c) => A.getAccountInfo(c, () => {})],
			["listFolder", (A, c) => A.listFolder(c, "root", () => {})],
			["downloadFile", (A, c) => A.downloadFile(c, "FFFFFFFF", dl(), null, () => {}), { minSteps: 3, endsFailed: true }],
			["uploadFile", (A, c) => A.uploadFile(c, "root", LOCAL, "n.bin", null, () => {}), { minSteps: 4 }],
			["uploadReplace", (A, c) => A.uploadReplace(c, "FFFFFFFF", LOCAL, null, () => {}), { minSteps: 4 }],
			["createFolder", (A, c) => A.createFolder(c, "root", "New", () => {}), { minSteps: 2 }],
			["moveItem", (A, c) => A.moveItem(c, "FFFFFFFF", "EEEEEEEE", "b.jpg", () => {}), { minSteps: 3 }],
			["deleteItem", (A, c) => A.deleteItem(c, "NNNNNNNN", () => {}), { minSteps: 2 }],
			["deletePhoto", (A, c) => A.deletePhoto(c, "NNNNNNNN", () => {})],
			["ensureAlbumFolder", (A, c) => A.ensureAlbumFolder(c, "Album", () => {}), { minSteps: 2 }],
			["photoAlbums", (A, c) => A.photoAlbums(c, () => {})],
			["getPhotoLocalPath", (A, c) => A.getPhotoLocalPath(c, "FFFFFFFF", "a.jpg", () => {}), { minSteps: 3, endsFailed: true }],
			["resolvePhotoAlbum", (A, c) => A.resolvePhotoAlbum(c, () => {}), { tolerant: true }],
		] },
};

const MAX_STEPS = 12;

for (const [name, spec] of Object.entries(CONNECTORS)) {
	for (const [label, call, opts = {}] of spec.entries) {
		for (const mode of Object.keys(MODES)) {
			test(`${name} ${label}: every request failing (${mode}) fails the operation`, async () => {
				let reached = 0;
				for (let k = 1; k <= MAX_STEPS; k++) {
					const creds = JSON.parse(JSON.stringify(spec.creds));
					const { Adapter, sent } = load(spec, k, mode);
					const out = await outcome(call(Adapter, creds));
					assert.ok(!out.pending, `request ${k} failing: the operation never answered`);
					if (sent() < k) {
						// No request failed: the whole operation ran. It must have succeeded (so the
						// canned replies are right and every step was reached) unless documented not to.
						if (!opts.endsFailed) { assert.ok(!out.error, `the unfailed run failed: ${JSON.stringify(out.error)}`); }
						break;
					}
					reached = k;
					if (!opts.tolerant) {
						assert.ok(out.error, `request ${k} failing: the operation succeeded`);
						assert.ok(out.error.errorCode || out.error.message, `request ${k} failing: no error code`);
					}
				}
				assert.ok(reached >= (opts.minSteps || 1), `only ${reached} of ${opts.minSteps || 1} steps were failed`);
			});
		}
	}
}

// --- commands ---------------------------------------------------------------------------------
// The commands settle the luna `future` from callbacks on the adapter's Futures (and on
// AccountCreds'). A reply of an unexpected shape - here every adapter call answering null -
// used to throw a TypeError in such a callback and leave `future` pending forever.

// An object whose every method returns a Future that answers `value` later.
const answering = (value) => new Proxy({}, { get: (t, k) => (k === "then" ? undefined : () => {
	const f = new Future(); later(() => { f.result = value; }); return f; }) });

function command(files, ctor, args, extra = {}) {
	const ctx = {
		IMPORTS: { foundations: { Control: { Future } } }, Future, JSON, Date, Math, Buffer,
		console: { log() {}, error() {} },
		Config: { ROOT_FOLDER: "root", sanitizeHost: () => null, hostForLocation: () => null },
		Acl: { enforce: () => true }, cloudRoot: () => "root",
		AccountCreds: { resolve: () => settledF({ accessToken: "tok" }), save: () => settledF({}) },
		Adapter: answering(null), OAuth2: answering(null), MegaApi: answering(null),
		...extra,
	};
	vm.createContext(ctx);
	for (const f of files) { vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f }); }
	const a = new ctx[ctor]();
	a.controller = { args };
	const future = new Future();
	a.run(future);
	return future;
}

const PHOTO_SERVICES = ["hidrive", "mega", "onedrive", "yandex"];
for (const svc of PHOTO_SERVICES) {
	const dir = serviceDir(svc);
	for (const [file, ctor] of [["listAlbums_command.js", "ListAlbumsCommandAssistant"],
		["listPhotos_command.js", "ListPhotosCommandAssistant"]]) {
		test(`${svc} ${file}: a reply of an unexpected shape still answers`, async () => {
			const out = await outcome(command([path.join(dir, "commands/photolib.js"), path.join(dir, "commands", file)],
				ctor, { accountId: "acc", aid: "album" }));
			assert.ok(!out.pending, "the command never answered");
		});
	}
}

const CORE_COMMANDS = [
	["listFolder_command.js", "ListFolderCommandAssistant", { accountId: "acc" }],
	["downloadFile_command.js", "DownloadFileCommandAssistant", { accountId: "acc", fileId: "F", localPath: "/x" }],
	["uploadFile_command.js", "UploadFileCommandAssistant", { accountId: "acc", localPath: "/x/a.jpg" }],
	["uploadPhoto_command.js", "UploadPhotoCommandAssistant", { accountId: "acc", path: "/x/a.jpg" }],
	["deletePhoto_command.js", "DeletePhotoCommandAssistant", { accountId: "acc", pid: "P" }],
	["checkCredentials_command.js", "CheckCredentialsCommandAssistant", { credentials: { common: { accessToken: "t" } } }],
	["exchangeCode_command.js", "ExchangeCodeCommandAssistant", { code: "c" }],
	["fileOps_commands.js", "CreateFolderCommandAssistant", { accountId: "acc", name: "n" }],
	["fileOps_commands.js", "MoveItemCommandAssistant", { accountId: "acc", fileId: "F", name: "n" }],
	["fileOps_commands.js", "DeleteItemCommandAssistant", { accountId: "acc", fileId: "F" }],
];
for (const [file, ctor, args] of CORE_COMMANDS) {
	test(`_cloudcore ${ctor}: a reply of an unexpected shape still answers`, async () => {
		const out = await outcome(command([path.join(CORE, "commands", file)], ctor, args));
		assert.ok(!out.pending, "the command never answered");
	});
}

for (const [svc, file, ctor, args] of [
	["mega", "login_command.js", "LoginCommandAssistant", { email: "u@example.test", password: "p" }],
]) {
	test(`${svc} ${ctor}: a reply of an unexpected shape still answers`, async () => {
		const out = await outcome(command([path.join(serviceDir(svc), "commands", file)], ctor, args));
		assert.ok(!out.pending, "the command never answered");
	});
}

// HttpCurl.request answers with a failed Future instead of throwing when it cannot even start.
for (const file of [path.join(CORE, "httpcurl.js")]) {
	test(`${path.relative(CLOUD, file)}: a request that cannot start fails its Future, it does not throw`, () => {
		const ctx = { IMPORTS: { foundations: { Control: { Future } } }, Config: {}, process, console: { log() {} },
			require: (m) => (m === "child_process" ? { execFile() { throw new TypeError("bad argument"); } } : require(m)) };
		vm.createContext(ctx);
		vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
		let f;
		assert.doesNotThrow(() => { f = ctx.HttpCurl.request({ method: "GET", url: "https://x.example.test/" }); });
		assert.throws(() => f.result, (e) => e.errorCode === "CURL_FAILED");
	});
}

// AccountCreds.save runs in the adapter call's callback just before the reply; a PalmCall that
// throws there must not keep the reply from being sent.
test("_cloudcore creds.js: a renewed token that cannot be saved does not stop the reply", async () => {
	const ctx = {
		IMPORTS: { foundations: { Control: { Future }, Comms: { PalmCall: { call() { throw new Error("bus down"); } } } } },
		Future, JSON, Date, console: { log() {}, error() {} },
		Config: { ROOT_FOLDER: "root" }, Acl: { enforce: () => true }, cloudRoot: () => "root",
		Adapter: { listFolder: (c, id, onRenewed) => { onRenewed({ accessToken: "new" }); return settledF({ entries: [] }); } },
	};
	vm.createContext(ctx);
	for (const f of [path.join(CORE, "creds.js"), path.join(CORE, "commands/listFolder_command.js")]) {
		vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
	}
	const a = new ctx.ListFolderCommandAssistant();
	a.controller = { args: { accountId: "acc", credentials: { common: { accessToken: "old" } } } };
	const future = new Future();
	a.run(future);
	const out = await outcome(future);
	assert.ok(!out.pending, "the command never answered");
	assert.strictEqual(out.result.returnValue, true);
});
