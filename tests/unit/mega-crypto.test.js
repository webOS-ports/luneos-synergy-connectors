// node --test tests/unit
// cloud/mega's crypto (megacrypto.js) and proof of work (hashcash.js) against values made with
// megajs 1.3.10's own functions (lib/mega-vectors.js), node's OpenSSL used directly, and an
// independent check of the hashcash answer.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const V = require("./lib/mega-vectors.js");

const SVC = path.join(__dirname, "../../cloud/mega/service/com.palm.service.mega");
const MC = require(path.join(SVC, "megacrypto.js"));
const H = require(path.join(SVC, "hashcash.js"));

const hex = (b) => Buffer.from(b).toString("hex");
const d64 = (s) => Buffer.from(s, "base64url");
const FK = Buffer.from(V.fileKey24, "hex");   // the vectors' file key: AES key (16) + nonce (8)

// --- base64 ----------------------------------------------------------------------------------
test("MEGA base64: URL-safe, unpadded, and either alphabet read back", () => {
	const b = Buffer.from([0xfb, 0xff, 0xbf, 0x00, 0x01]);
	assert.strictEqual(MC.e64(b), "-_-_AAE");
	assert.deepStrictEqual(MC.d64("-_-_AAE"), b);
	assert.deepStrictEqual(MC.d64("+/+/AAE="), b);
	assert.deepStrictEqual(MC.d64(undefined), Buffer.alloc(0));
});

// --- AES against OpenSSL ----------------------------------------------------------------------
test("ECB and CBC are OpenSSL's AES-128, without padding, a zero IV for CBC", () => {
	const key = crypto.randomBytes(16), data = crypto.randomBytes(64);
	const ref = (mode, iv) => { const c = crypto.createCipheriv("aes-128-" + mode, key, iv).setAutoPadding(false); return Buffer.concat([c.update(data), c.final()]); };
	assert.deepStrictEqual(MC.ecbEncrypt(key, data), ref("ecb", null));
	assert.deepStrictEqual(MC.cbcEncrypt(key, data), ref("cbc", Buffer.alloc(16)));
	assert.deepStrictEqual(MC.ecbDecrypt(key, MC.ecbEncrypt(key, data)), data);
	assert.deepStrictEqual(MC.cbcDecrypt(key, MC.cbcEncrypt(key, data)), data);
	assert.throws(() => MC.ecbEncrypt(key, Buffer.alloc(15)));
});

test("CTR is node's aes-128-ctr with IV nonce + 64-bit counter 0, and megajs's CTR", () => {
	for (const v of V.mac) {
		const data = V.det(v.size, "data-" + v.size);
		const c = MC.ctrCipher(FK.subarray(0, 16), FK.subarray(16));
		// In pieces that are not block multiples: the counter must carry across.
		const parts = [];
		for (let o = 0; o < data.length; o += 99999) { parts.push(c.update(data.subarray(o, o + 99999))); }
		const ct = Buffer.concat(parts.concat([c.final()]));
		const ref = crypto.createCipheriv("aes-128-ctr", FK.subarray(0, 16), Buffer.concat([FK.subarray(16), Buffer.alloc(8)]));
		assert.deepStrictEqual(ct, Buffer.concat([ref.update(data), ref.final()]), String(v.size));
		assert.strictEqual(crypto.createHash("sha256").update(ct).digest("hex"), v.ctSha256, "megajs CTR, " + v.size);
	}
});

// --- key derivation ---------------------------------------------------------------------------
test("v1: prepare_key and the login hash are megajs's (UTF-8 password and email, empty, 16 bytes)", async () => {
	for (const v of V.v1) {
		const pk = MC.prepareKey(Buffer.from(v.password));
		assert.strictEqual(hex(pk), v.pwKey, v.password);
		assert.strictEqual(MC.e64(MC.stringHash(v.email, pk)), v.uh, v.email);
		const d = await MC.deriveLogin(v.email, v.password, { v: 1 });
		assert.deepStrictEqual({ version: d.version, pwKey: hex(d.pwKey), uh: d.uh }, { version: 1, pwKey: v.pwKey, uh: v.uh });
	}
	const noVersion = await MC.deriveLogin(V.v1[0].email, V.v1[0].password, {});
	assert.strictEqual(noVersion.uh, V.v1[0].uh, "an us0 without v is v1, as before");
});

test("v2: PBKDF2-HMAC-SHA512, 100000 rounds; the key and uh are megajs's (prepareKeyV2)", async () => {
	for (const v of V.v2) {
		const d = await MC.deriveLogin("ignored@example.test", v.password, { v: 2, s: v.salt });
		assert.deepStrictEqual({ version: d.version, pwKey: hex(d.pwKey), uh: d.uh }, { version: 2, pwKey: v.pwKey, uh: v.uh });
	}
});

// --- RSA ----------------------------------------------------------------------------------------
test("the session id: the csid decrypted with the privk MPIs, first 43 bytes (megajs's)", () => {
	const priv = MC.decodePrivKey(Buffer.from(V.rsa.privk, "hex"));
	assert.strictEqual(priv.length, 4);
	assert.strictEqual(MC.sessionId(V.rsa.csid, priv), V.rsa.sid);
	assert.strictEqual(V.rsa.sid.length, 58, "43 bytes in MEGA base64");
	// Without the CRT: c^d mod pq is the same number.
	const [p, q, d] = priv;
	const [c] = MC.readMpis(d64(V.rsa.csid), 1);
	assert.strictEqual(MC.rsaDecrypt(c, priv), MC.modPow(c, d, p * q));
	assert.strictEqual((p * q).toString(16), V.rsa.n);
	// A privk that is cut short is refused, not read past its end.
	assert.throws(() => MC.decodePrivKey(Buffer.from(V.rsa.privk, "hex").subarray(0, 300)), /cut off/);
	assert.throws(() => MC.decodePrivKey(Buffer.alloc(32)), /not an RSA private key|cut off/);
});

test("modPow agrees with node's own RSA (no padding) on the same key", () => {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
	const j = privateKey.export({ format: "jwk" });
	const big = (s) => BigInt("0x" + d64(s).toString("hex"));
	const m = crypto.randomBytes(127);
	const c = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_NO_PADDING }, Buffer.concat([Buffer.alloc(1), m]));
	// MEGA's order: p, q with u = p^-1 mod q, which is JWK's (q, p, qi).
	const out = MC.rsaDecrypt(MC.toBig(c), [big(j.q), big(j.p), big(j.d), big(j.qi)]);
	assert.deepStrictEqual(MC.fromBig(out), m[0] ? m : MC.fromBig(MC.toBig(m)));
});

// --- attributes ---------------------------------------------------------------------------------
test("attributes: encryptAttr gives megajs's bytes, decryptAttr reads them (UTF-8, folder and file key)", () => {
	for (const v of V.attrs) {
		let key = Buffer.from(v.key, "hex");
		if (key.length === 32) { key = MC.unpackFileKey(key).aesKey; }
		assert.strictEqual(MC.encryptAttr(v.attrs, key), v.at, JSON.stringify(v.attrs));
		assert.deepStrictEqual(MC.decryptAttr(v.at, key), v.attrs);
	}
});

test("attributes: round trip at and around the 16-byte edge; a wrong key or junk is null", () => {
	const key = crypto.randomBytes(16);
	for (const n of ["", "a", "abcdefghijk", "abcdefghijkl", "€uro", "日本語のファイル名.txt", "x".repeat(300), "\u{1F4C4} doc"]) {
		const at = MC.encryptAttr({ n, c: "fp" }, key);
		const len = Buffer.byteLength("MEGA" + JSON.stringify({ n, c: "fp" }));
		assert.strictEqual(d64(at).length, Math.ceil(len / 16) * 16, "zero padded as megajs's packAttributes");
		assert.deepStrictEqual(MC.decryptAttr(at, key), { n, c: "fp" });
	}
	assert.strictEqual(MC.decryptAttr(MC.encryptAttr({ n: "x" }, key), crypto.randomBytes(16)), null);
	assert.strictEqual(MC.decryptAttr("AAAA", key), null, "not a block multiple");
	assert.strictEqual(MC.decryptAttr("", key), null);
	assert.strictEqual(MC.decryptAttr(MC.e64(MC.cbcEncrypt(key, Buffer.from("MEGA[1,2,3]\0\0\0\0\0"))), key), null, "not an object");
});

// --- file keys and MAC --------------------------------------------------------------------------
test("file keys: pack is megajs's mergeKeyMac, unpack its inverse", () => {
	for (const v of V.mac) {
		const full = MC.packFileKey(FK.subarray(0, 16), FK.subarray(16), Buffer.from(v.mac, "hex"));
		assert.strictEqual(MC.e64(full), v.fullKey);
		const u = MC.unpackFileKey(full);
		assert.deepStrictEqual([u.aesKey, u.nonce, hex(u.metaMac)], [FK.subarray(0, 16), FK.subarray(16), v.mac]);
	}
});

test("chunk sizes: 128 KiB steps up to 1 MiB, the last one short", () => {
	const K = 131072;
	assert.deepStrictEqual(MC.chunkSizes(0), []);
	assert.deepStrictEqual(MC.chunkSizes(1), [[0, 1]]);
	assert.deepStrictEqual(MC.chunkSizes(300000), [[0, K], [K, 300000 - K]]);
	const big = MC.chunkSizes(50 * K);
	assert.deepStrictEqual(big.map((c) => c[1] / K), [1, 2, 3, 4, 5, 6, 7, 8, 8, 6]);
	assert.strictEqual(big.reduce((a, c) => a + c[1], 0), 50 * K);
	big.forEach(([pos], i) => { if (i) { assert.strictEqual(pos, big[i - 1][0] + big[i - 1][1]); } });
});

test("the meta-MAC is megajs's for every size, and the per-chunk one where megajs adds a block", () => {
	for (const v of V.mac) {
		const data = V.det(v.size, "data-" + v.size);
		for (const piece of [data.length || 1, 7, 65536, 77777]) {
			const m = new MC.FileMac(FK.subarray(0, 16), FK.subarray(16));
			for (let o = 0; o < data.length; o += piece) { m.update(data.subarray(o, o + piece)); }
			const sdk = V.sdkMac[v.size];
			const alt = m.condenseMegajs();
			if (alt) {
				assert.ok(sdk, v.size + ": megajs differs here, and the old connector's MAC is known");
				assert.strictEqual(hex(m.condense()), sdk, v.size + " (MEGA's)");
				assert.strictEqual(hex(alt), v.mac, v.size + " (megajs's)");
			} else {
				assert.strictEqual(hex(m.condense()), v.mac, v.size + " in pieces of " + piece);
				if (sdk) { assert.strictEqual(sdk, v.mac, "the old connector agreed with megajs here"); }
			}
			assert.ok(m.matches(Buffer.from(v.mac, "hex")), "accepts megajs's");
			if (sdk) { assert.ok(m.matches(Buffer.from(sdk, "hex")), "accepts MEGA's"); }
			const wrong = Buffer.from(v.mac, "hex"); wrong[7] ^= 1;
			assert.ok(!m.matches(wrong));
			assert.ok(!m.matches(Buffer.alloc(4)));
		}
	}
	const empty = new MC.FileMac(FK.subarray(0, 16), FK.subarray(16));
	assert.strictEqual(hex(empty.condense()), V.sdkMac[0]);
});

// --- hashcash -----------------------------------------------------------------------------------
const TOKEN = crypto.randomBytes(48);
const challengeOf = (e, t = TOKEN) => `1:${e}:1792400357:${t.toString("base64url")}`;

test("hashcash: the threshold follows the easiness encoding", () => {
	assert.strictEqual(H.threshold(192), 1 << 24);   // what MEGA sent on 2026-10-19
	assert.strictEqual(H.threshold(0), 8);
	assert.strictEqual(H.threshold(63), 127 << 3);
	assert.strictEqual(H.threshold(255), 127 * 2 ** 24);
	for (let e = 0; e < 256; e++) {
		// megajs: ((e & 63) << 1) + 1 << (e >> 6) * 7 + 3, unsigned.
		assert.strictEqual(H.threshold(e), ((((e & 63) << 1) + 1) << ((e >> 6) * 7 + 3)) >>> 0, String(e));
	}
});

test("hashcash: challenges that are not version 1 with a 48-byte token are refused", async () => {
	assert.ok(H.parse(challengeOf(192)));
	for (const bad of ["", "2:192:1:" + TOKEN.toString("base64url"), challengeOf(256), challengeOf("x"), challengeOf(""),
		challengeOf(1.5), challengeOf(192, TOKEN.subarray(0, 40)), "1:192:" + TOKEN.toString("base64url")]) {
		assert.strictEqual(H.parse(bad), null, bad);
	}
	await assert.rejects(H.solve("garbage"), (e) => e.errorCode === "MEGA_HASHCASH" && /unrecognised/.test(e.errorText));
});

test("hashcash: the answer is megajs's for the same challenge", async () => {
	assert.strictEqual(await H.solve(V.hashcash.challenge), V.hashcash.answer);
});

test("hashcash: the answer satisfies the challenge, checked independently in Python", async () => {
	const tokenStr = TOKEN.toString("base64url");
	const answer = await H.solve(challengeOf(230));
	const [v, tok, prefix] = answer.split(":");
	assert.strictEqual(v, "1");
	assert.strictEqual(tok, tokenStr);
	const py = `
import base64, hashlib, sys
d = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
token, prefix = d(sys.argv[1]), d(sys.argv[2])
assert len(prefix) == 4 and len(token) == 48
h = hashlib.sha256(prefix + token * 262144).digest()
print(int.from_bytes(h[:4], "big"))`;
	const first = Number(execFileSync("python3", ["-I", "-c", py, tokenStr, prefix]).toString().trim());
	assert.ok(first <= H.threshold(230), `${first} > threshold`);
});

test("hashcash: the prefix counts up from zero, little-endian with carry", async () => {
	const seen = [];
	const digest = async (b) => { seen.push(b.readUInt32LE(0)); return Buffer.from(seen.length === 300 ? [0, 0, 0, 0] : [255, 255, 255, 255]); };
	const answer = await H.solve(challengeOf(192), { digest });
	assert.deepStrictEqual(seen.slice(0, 3), [0, 1, 2]);
	assert.strictEqual(seen[256], 256, "carried into the second byte");
	assert.strictEqual(answer.split(":")[2], Buffer.from([43, 1, 0, 0]).toString("base64url"), "try 299");
});

test("hashcash: it lets the event loop run and gives up after its time limit", async () => {
	let t = 0, ticks = 0;
	const timer = setInterval(() => { ticks++; }, 1);
	try {
		const digest = async () => { t += 1000; await new Promise((r) => setTimeout(r, 1)); return Buffer.from([255, 255, 255, 255]); };
		await assert.rejects(H.solve(challengeOf(192), { digest, now: () => t, maxMs: 30000 }),
			(e) => e.errorCode === "MEGA_HASHCASH" && /gave up after 30000 ms/.test(e.errorText));
		assert.ok(ticks > 5, "timers ran while it searched");
		// A digest that settles at once still gives other callbacks a turn now and then.
		let other = false, sawOther = false, n = 0;
		setImmediate(() => { other = true; });
		const instant = async () => { if (++n === 64) { sawOther = other; return Buffer.alloc(4); } return Buffer.from([255, 255, 255, 255]); };
		await H.solve(challengeOf(192), { digest: instant });
		assert.ok(sawOther, "a setImmediate queued before the search ran during it");
	} finally { clearInterval(timer); }
});

test("hashcash: the real digest runs off the event loop (WebCrypto)", async () => {
	let ticks = 0;
	const timer = setInterval(() => { ticks++; }, 1);
	try {
		// About 1 in 15 prefixes passes at easiness 200: some dozen 12 MiB digests.
		await H.solve(challengeOf(200));
		assert.ok(ticks >= 1, "the interval ran during the search");
	} finally { clearInterval(timer); }
});
