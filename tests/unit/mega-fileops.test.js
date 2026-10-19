// node --test tests/unit
// cloud/mega's createFolder, moveItem and deleteItem (adapter.js) with the real megacrypto.js,
// megaapi.js and adapter.js loaded as sources.json loads them, against a stand-in HttpCurl that
// records the cs POST bodies and answers with canned replies. Also the attribute crypto
// (encryptAttr/decryptAttr) against vectors made with megajs 1.3.10's own code.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const MEGA = path.join(__dirname, "../../cloud/mega/service/com.palm.service.mega");

// Foundations' Future as these files use it (see megahashcash.test.js): now() waits on the
// future its function returns before the next then(); nest() takes over another future's
// outcome; assigning a future to .result does not.
class FakeFuture {
	constructor() { this.cbs = []; this.done = false; }
	set result(v) { this._r = v; this.done = true; this.cbs.splice(0).forEach((cb) => cb(this)); }
	get result() { if (this._e) throw this._e; return this._r; }
	setException(e) { this._e = e; this.done = true; this.cbs.splice(0).forEach((cb) => cb(this)); }
	then(scope, fn) { const cb = () => fn.call(scope, this); if (this.done) cb(); else this.cbs.push(cb); return this; }
}
class ChainFuture extends FakeFuture {
	now(scope, fn) { this._wait = fn.call(scope, this); return this; }
	then(scope, fn) {
		const w = this._wait;
		if (w instanceof FakeFuture) { this._wait = null; w.then(null, () => fn.call(scope, this)); return this; }
		return super.then(scope, fn);
	}
	nest(inner) {
		inner.then(null, () => { try { this.result = inner.result; } catch (e) { this.setException(e); } });
		return this;
	}
}
const settled = (v) => { const f = new ChainFuture(); f.result = v; return f; };
const plain = (o) => JSON.parse(JSON.stringify(o));

// The real files in one context, in sources.json order.
function load(extra = {}) {
	const ctx = {
		IMPORTS: { foundations: { Control: { Future: ChainFuture } } },
		Config: { API_BASE: "https://g.api.mega.co.nz/cs", ROOT_FOLDER: "root" },
		Buffer, require, Date, setTimeout, MegaHashcash: {}, ...extra,
	};
	vm.createContext(ctx);
	for (const file of ["megacrypto.js", "megaapi.js", "adapter.js"]) {
		const p = path.join(MEGA, file);
		vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: p });
	}
	return ctx;
}
const { MegaCrypto: MC } = load();

// --- independent crypto (node's OpenSSL), for checking what the adapter sends -----------------
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const d64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const a32buf = (a) => { const b = Buffer.alloc(a.length * 4); a.forEach((w, i) => b.writeUInt32BE(w >>> 0, i * 4)); return b; };
const ecbDec = (key, data) => { const d = crypto.createDecipheriv("aes-128-ecb", key, null).setAutoPadding(false); return Buffer.concat([d.update(data), d.final()]); };
const cbcDec = (key, data) => { const d = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16)).setAutoPadding(false); return Buffer.concat([d.update(data), d.final()]); };
// "MEGA" + JSON, zero padded, as megajs's File.unpackAttributes reads it.
const openAttr = (key, at) => {
	const pt = cbcDec(key, d64(at));
	const end = pt.indexOf(0) < 0 ? pt.length : pt.indexOf(0);
	assert.ok(pt.length % 16 === 0 && pt.slice(end).every((x) => x === 0), "zero padded to 16");
	const s = pt.slice(0, end).toString("utf8");
	assert.strictEqual(s.slice(0, 6), 'MEGA{"');
	return JSON.parse(s.slice(4));
};

// --- attribute crypto ---------------------------------------------------------------------------
// Made with megajs 1.3.10's MutableFile.packAttributes + getCipher(key).encryptCBC + e64, lifted
// from dist/main.node-cjs.js (lines 134-186, 280-291, 377-384, 2011-2017) and run unchanged.
const VECTORS = [
	{ key: "00112233445566778899aabbccddeeff", attrs: { n: "Résumé – 2026 ✓" },
		at: "zwwzn6zvBiGzO8MMSEa7Zgv4dlThbWNybjsFsOpc4NboPQ7XZ2J-P1wwkoSOgQDg" },
	{ key: "0f1e2d3c4b5a69788796a5b4c3d2e1f00123456789abcdeffedcba9876543210",
		attrs: { n: "photo.jpg", c: "AbCdEfGhIjKlMnOpQrStUvWxYz0", lbl: 3, fav: 1 },
		at: "RkwXwK-KASZBp3NakJyYTP_y5c3S9gWg3xQ0CWMe71HRX-op3fqnjMWt6oBNSL9bGwdvXbrS_qUSK8TFEwJju7N-s_YdFYvvIn5AMOyf_fY" },
];
const aesKeyOf = (hex) => {   // a folder key as is; a file key xor-folded (megacrypto's unpackFileKey)
	const a = MC.bytesToA32([...Buffer.from(hex, "hex")]);
	return a.length === 8 ? MC.unpackFileKey(a).aesKeyA32 : a;
};

test("encryptAttr gives megajs's bytes, decryptAttr reads them (UTF-8, folder and file key)", () => {
	for (const v of VECTORS) {
		assert.strictEqual(MC.encryptAttr(v.attrs, aesKeyOf(v.key)), v.at, v.key);
		assert.deepStrictEqual(plain(MC.decryptAttr(v.at, aesKeyOf(v.key))), v.attrs);
	}
});

test("encryptAttr/decryptAttr round trip, at and around the 16-byte block edge", () => {
	const key = MC.bytesToA32([...crypto.randomBytes(16)]);
	for (const n of ["", "a", "abcdefghijk", "abcdefghijkl", "€uro", "日本語のファイル名.txt", "x".repeat(300)]) {
		const at = MC.encryptAttr({ n, c: "fp" }, key);
		const len = Buffer.byteLength('MEGA{"n":' + JSON.stringify(n) + ',"c":"fp"}');
		assert.strictEqual(d64(at).length, Math.ceil(len / 16) * 16, "padded as megajs's packAttributes");
		assert.deepStrictEqual(plain(MC.decryptAttr(at, key)), { n, c: "fp" });
		assert.deepStrictEqual(openAttr(a32buf(key), at), { n, c: "fp" }, "OpenSSL reads it as well");
	}
	assert.strictEqual(MC.decryptAttr(MC.encryptAttr({ n: "x" }, key), [1, 2, 3, 4]), null, "wrong key");
});

// --- a small account ------------------------------------------------------------------------
// Cloud Drive R: Docs(D){ a.txt(F), Sub(E) }, Shared(S, outgoing share), notes.txt(N);
// Rubbish Bin B: old.txt(T); Inbox I.
function account() {
	const master = MC.bytesToA32([...crypto.randomBytes(16)]);
	const keys = {}, raw = [];
	const wrap = (k) => MC.a32ToB64(MC.ecbEncryptA32(master, k));
	const folder = (h, p, name) => {
		const k = MC.bytesToA32([...crypto.randomBytes(16)]); keys[h] = k;
		raw.push({ h, p, t: 1, a: MC.encryptAttr({ n: name }, k), k: `u:${wrap(k)}`, ts: 1700000000 });
	};
	const file = (h, p, attrs, s) => {
		const k8 = MC.bytesToA32([...crypto.randomBytes(32)]); keys[h] = k8;
		raw.push({ h, p, t: 0, a: MC.encryptAttr(attrs, MC.unpackFileKey(k8).aesKeyA32), k: `u:${wrap(k8)}`, s, ts: 1700000100 });
	};
	raw.push({ h: "RRRRRRRR", t: 2, p: "" }, { h: "IIIIIIII", t: 3, p: "" }, { h: "BBBBBBBB", t: 4, p: "" });
	folder("DDDDDDDD", "RRRRRRRR", "Docs");
	file("FFFFFFFF", "DDDDDDDD", { n: "a.txt", c: "fingerprint", lbl: 2 }, 12);
	folder("EEEEEEEE", "DDDDDDDD", "Sub");
	folder("SSSSSSSS", "RRRRRRRR", "Shared");
	file("NNNNNNNN", "RRRRRRRR", { n: "notes.txt" }, 3);
	file("TTTTTTTT", "BBBBBBBB", { n: "old.txt" }, 5);
	return { master, keys, creds: { accessToken: "SID", mk: MC.a32ToB64(master) },
		tree: { f: raw, ok: [{ h: "SSSSSSSS", ha: "x", k: "y" }] } };
}

// The adapter over a recording HttpCurl: `f` gets the account's tree, every other command the
// next of `replies` (a JSON text). Each test gets fresh files, so no tree cache carries over.
function setup(replies = []) {
	const acct = account(), sent = [];
	const ctx = load({
		HttpCurl: {
			request: (o) => {
				const body = JSON.parse(o.body);
				if (body[0].a === "f") return settled({ status: 200, responseText: JSON.stringify([acct.tree]) });
				sent.push({ url: o.url, body });
				return settled({ status: 200, responseText: replies.shift() });
			},
		},
	});
	const randCalls = [];
	const fixedKey = [0x01020304, 0x05060708, 0x090a0b0c, 0x0d0e0f10];
	const realRand = ctx.Adapter._rand;
	ctx.Adapter._rand = function (w) { randCalls.push(w); realRand.call(this, w); return fixedKey.slice(0, w); };
	return { ...acct, Adapter: ctx.Adapter, sent, randCalls, fixedKey };
}
const failure = (f) => { assert.ok(f.done, "settled"); try { f.result; } catch (e) { return plain(e); } assert.fail("did not fail"); };

// --- createFolder ----------------------------------------------------------------------------
test("createFolder sends one `p` with a new folder node and returns a listFolder entry", () => {
	const s = setup([JSON.stringify([{ f: [{ h: "NEWHANDL", p: "DDDDDDDD", t: 1, a: "x", k: "u:y", ts: 1760000000 }] }])]);
	const f = s.Adapter.createFolder(s.creds, "DDDDDDDD", "Reports 2026", () => {});
	assert.deepStrictEqual(plain(f.result), { entry: { id: "NEWHANDL", type: "folder", name: "Reports 2026",
		size: 0, modified: 1760000000000, path: "NEWHANDL", mimeType: "application/vnd.mega.folder" } });
	assert.strictEqual(s.sent.length, 1);
	assert.match(s.sent[0].url, /^https:\/\/g\.api\.mega\.co\.nz\/cs\?id=\d+&sid=SID$/);
	const k = s.fixedKey;
	assert.deepStrictEqual(s.sent[0].body, [{ a: "p", t: "DDDDDDDD", n: [{ h: "xxxxxxxx", t: 1,
		a: MC.encryptAttr({ n: "Reports 2026" }, k), k: MC.a32ToB64(MC.ecbEncryptA32(s.master, k)) }] }]);
	assert.deepStrictEqual(s.randCalls, [4], "a fresh 128-bit key from _rand");
	// Checked with OpenSSL: k unwraps under the master key to the folder key, which opens a.
	const n = s.sent[0].body[0].n[0];
	const folderKey = ecbDec(a32buf(s.master), d64(n.k));
	assert.deepStrictEqual(folderKey, a32buf(k));
	assert.deepStrictEqual(openAttr(folderKey, n.a), { n: "Reports 2026" });
});

test("createFolder in the root sentinel goes to the Cloud Drive root handle", () => {
	const s = setup([JSON.stringify([{ f: [{ h: "NEWHANDL", t: 1 }] }])]);
	s.Adapter.createFolder(s.creds, "root", "Top", () => {}).result;
	assert.strictEqual(s.sent[0].body[0].t, "RRRRRRRR");
});

test("createFolder refuses a taken name, a non-folder parent, a shared folder, the rubbish bin", () => {
	const s = setup();
	assert.strictEqual(failure(s.Adapter.createFolder(s.creds, "DDDDDDDD", "Sub", () => {})).errorCode, "MEGA_EEXIST");
	assert.strictEqual(failure(s.Adapter.createFolder(s.creds, "DDDDDDDD", "a.txt", () => {})).megaCode, -12);
	assert.strictEqual(failure(s.Adapter.createFolder(s.creds, "FFFFFFFF", "X", () => {})).errorCode, "MEGA_EARGS");
	assert.strictEqual(failure(s.Adapter.createFolder(s.creds, "nothere1", "X", () => {})).errorCode, "MEGA_ENOENT");
	assert.strictEqual(failure(s.Adapter.createFolder(s.creds, "SSSSSSSS", "X", () => {})).errorCode, "MEGA_SHARE_UNSUPPORTED");
	assert.strictEqual(failure(s.Adapter.createFolder(s.creds, "BBBBBBBB", "X", () => {})).errorCode, "MEGA_EARGS");
	assert.strictEqual(s.sent.length, 0, "nothing reached the server");
});

test("server errors come back as apiError objects", () => {
	const s = setup(["[-11]"]);
	const e = failure(s.Adapter.createFolder(s.creds, "DDDDDDDD", "New", () => {}));
	assert.deepStrictEqual(e, { returnValue: false, errorCode: "MEGA_EACCESS", megaCode: -11, detail: "p" });
	const g = setup(["-15"]);
	assert.strictEqual(failure(g.Adapter.createFolder(g.creds, "DDDDDDDD", "New", () => {})).errorCode, "MEGA_ESID");
	const b = setup(["[{}]"]);
	assert.strictEqual(failure(b.Adapter.createFolder(b.creds, "DDDDDDDD", "New", () => {})).errorCode, "MEGA_BAD_REPLY");
});

test("credentials without a master key fail before any request", () => {
	const s = setup();
	const e = failure(s.Adapter.createFolder({ accessToken: "SID" }, "root", "X", () => {}));
	assert.strictEqual(e.errorCode, "MEGA_NO_SESSION");
	assert.strictEqual(s.sent.length, 0);
});

// --- moveItem --------------------------------------------------------------------------------
test("move only: one `m` to the target handle; the entry is the item in its new place", () => {
	const s = setup(["[0]"]);
	const f = s.Adapter.moveItem(s.creds, "FFFFFFFF", "EEEEEEEE", null, () => {});
	assert.deepStrictEqual(plain(f.result), { entry: { id: "FFFFFFFF", type: "file", name: "a.txt", size: 12,
		modified: 1700000100000, path: "FFFFFFFF", mimeType: null } });
	assert.deepStrictEqual(s.sent.map((x) => x.body), [[{ a: "m", n: "FFFFFFFF", t: "EEEEEEEE" }]]);
	const r = setup(["[0]"]);
	r.Adapter.moveItem(r.creds, "FFFFFFFF", "root", null, () => {}).result;
	assert.deepStrictEqual(r.sent[0].body, [{ a: "m", n: "FFFFFFFF", t: "RRRRRRRR" }]);
});

test("rename only: one `a` with every other attribute kept, under the file's xor-folded key", () => {
	const s = setup(["[0]"]);
	const f = s.Adapter.moveItem(s.creds, "FFFFFFFF", null, "b.jpg", () => {});
	assert.strictEqual(f.result.entry.name, "b.jpg");
	assert.strictEqual(f.result.entry.mimeType, "image/jpeg");
	assert.strictEqual(s.sent.length, 1);
	const cmd = s.sent[0].body[0];
	assert.deepStrictEqual(Object.keys(cmd), ["a", "n", "at"]);
	assert.strictEqual(cmd.a, "a");
	assert.strictEqual(cmd.n, "FFFFFFFF");
	const k8 = s.keys.FFFFFFFF, folded = a32buf(k8.slice(0, 4).map((w, i) => (w ^ k8[i + 4]) >>> 0));
	const attrs = openAttr(folded, cmd.at);
	assert.deepStrictEqual(attrs, { n: "b.jpg", c: "fingerprint", lbl: 2 });
	assert.deepStrictEqual(Object.keys(attrs), ["n", "c", "lbl"], "order kept");
});

test("rename of a folder uses its 4-word key", () => {
	const s = setup(["[0]"]);
	s.Adapter.moveItem(s.creds, "DDDDDDDD", null, "Documents", () => {}).result;
	assert.deepStrictEqual(openAttr(a32buf(s.keys.DDDDDDDD), s.sent[0].body[0].at), { n: "Documents" });
});

test("move and rename: `m` first, then `a`; a failed rename after the move says so", () => {
	const s = setup(["[0]", "[0]"]);
	const f = s.Adapter.moveItem(s.creds, "NNNNNNNN", "DDDDDDDD", "notes-2.txt", () => {});
	assert.strictEqual(f.result.entry.name, "notes-2.txt");
	assert.deepStrictEqual(s.sent.map((x) => x.body[0].a), ["m", "a"]);
	assert.deepStrictEqual(s.sent[0].body, [{ a: "m", n: "NNNNNNNN", t: "DDDDDDDD" }]);
	const b = setup(["[0]", "[-11]"]);
	const e = failure(b.Adapter.moveItem(b.creds, "NNNNNNNN", "DDDDDDDD", "notes-2.txt", () => {}));
	assert.strictEqual(e.errorCode, "MEGA_EACCESS");
	assert.strictEqual(e.moved, true);
	const m = setup(["[-11]"]);
	assert.strictEqual(failure(m.Adapter.moveItem(m.creds, "NNNNNNNN", "DDDDDDDD", "x", () => {})).errorCode, "MEGA_EACCESS");
	assert.strictEqual(m.sent.length, 1, "no rename after a failed move");
});

test("moveItem refuses cycles, taken names, shared targets, roots and unknown nodes locally", () => {
	const s = setup();
	const code = (f) => failure(f).errorCode;
	assert.strictEqual(code(s.Adapter.moveItem(s.creds, "DDDDDDDD", "EEEEEEEE", null, () => {})), "MEGA_ECIRCULAR");
	assert.strictEqual(code(s.Adapter.moveItem(s.creds, "DDDDDDDD", "DDDDDDDD", null, () => {})), "MEGA_ECIRCULAR");
	assert.strictEqual(code(s.Adapter.moveItem(s.creds, "FFFFFFFF", null, "Sub", () => {})), "MEGA_EEXIST");
	assert.strictEqual(code(s.Adapter.moveItem(s.creds, "NNNNNNNN", "DDDDDDDD", "a.txt", () => {})), "MEGA_EEXIST");
	assert.strictEqual(code(s.Adapter.moveItem(s.creds, "FFFFFFFF", "SSSSSSSS", null, () => {})), "MEGA_SHARE_UNSUPPORTED");
	assert.strictEqual(code(s.Adapter.moveItem(s.creds, "FFFFFFFF", "BBBBBBBB", null, () => {})), "MEGA_EARGS");
	assert.strictEqual(code(s.Adapter.moveItem(s.creds, "RRRRRRRR", null, "x", () => {})), "MEGA_EARGS");
	assert.strictEqual(code(s.Adapter.moveItem(s.creds, "nothere1", null, "x", () => {})), "MEGA_ENOENT");
	assert.strictEqual(s.sent.length, 0);
});

test("moveItem with nothing to change sends nothing", () => {
	const s = setup();
	assert.strictEqual(s.Adapter.moveItem(s.creds, "FFFFFFFF", "DDDDDDDD", "a.txt", () => {}).result.entry.name, "a.txt");
	assert.strictEqual(s.sent.length, 0);
});

// --- deleteItem -------------------------------------------------------------------------------
test("deleteItem moves to the Rubbish Bin; what is already there is deleted with `d`", () => {
	const s = setup(["[0]", "[0]"]);
	assert.deepStrictEqual(plain(s.Adapter.deleteItem(s.creds, "FFFFFFFF", () => {}).result), {});
	assert.deepStrictEqual(s.sent[0].body, [{ a: "m", n: "FFFFFFFF", t: "BBBBBBBB" }]);
	assert.deepStrictEqual(plain(s.Adapter.deleteItem(s.creds, "TTTTTTTT", () => {}).result), {});
	assert.deepStrictEqual(s.sent[1].body, [{ a: "d", n: "TTTTTTTT" }]);
});

test("deleteItem refuses the roots and unknown nodes, and maps server errors", () => {
	const s = setup(["[-9]"]);
	for (const h of ["RRRRRRRR", "BBBBBBBB", "IIIIIIII"]) {
		assert.strictEqual(failure(s.Adapter.deleteItem(s.creds, h, () => {})).errorCode, "MEGA_EARGS", h);
	}
	assert.strictEqual(failure(s.Adapter.deleteItem(s.creds, "nothere1", () => {})).errorCode, "MEGA_ENOENT");
	assert.strictEqual(s.sent.length, 0);
	const e = failure(s.Adapter.deleteItem(s.creds, "NNNNNNNN", () => {}));
	assert.deepStrictEqual(e, { returnValue: false, errorCode: "MEGA_ENOENT", megaCode: -9, detail: "m" });
});

// --- listFolder is unchanged by the shared normaliser --------------------------------------
test("listFolder entries keep their shape", () => {
	const s = setup();
	assert.deepStrictEqual(plain(s.Adapter.listFolder(s.creds, "DDDDDDDD", () => {}).result), { entries: [
		{ id: "FFFFFFFF", type: "file", name: "a.txt", size: 12, modified: 1700000100000, path: "FFFFFFFF", mimeType: null },
		{ id: "EEEEEEEE", type: "folder", name: "Sub", size: 0, modified: 1700000000000, path: "EEEEEEEE",
			mimeType: "application/vnd.mega.folder" },
	] });
	assert.deepStrictEqual(plain(s.Adapter.listFolder(s.creds, "root", () => {}).result).entries.map((e) => e.name),
		["Docs", "Shared", "notes.txt"]);
});

test("the tree is fetched again after a change", () => {
	let fetches = 0;
	const s = setup(["[0]"]);
	const tree = s.tree;
	const ctx = load({ HttpCurl: { request: (o) => {
		if (JSON.parse(o.body)[0].a === "f") { fetches++; return settled({ status: 200, responseText: JSON.stringify([tree]) }); }
		return settled({ status: 200, responseText: "[0]" });
	} } });
	ctx.Adapter.listFolder(s.creds, "root", () => {}).result;
	ctx.Adapter.listFolder(s.creds, "root", () => {}).result;
	assert.strictEqual(fetches, 1, "cached within a burst");
	ctx.Adapter.deleteItem(s.creds, "NNNNNNNN", () => {}).result;
	ctx.Adapter.listFolder(s.creds, "root", () => {}).result;
	assert.strictEqual(fetches, 2);
});
