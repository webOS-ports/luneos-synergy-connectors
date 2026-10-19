/* megacrypto.js - MEGA's client-side crypto, on node's own crypto (OpenSSL) and BigInt.
 *
 * MEGA is zero-knowledge: names and file bytes are AES-encrypted under keys derived from the
 * account password, and the session id arrives RSA-encrypted. All of it is done here as megajs
 * 1.3.10 (MIT, the maintained reference client) does it; the vectors in
 * tests/unit/mega-crypto.test.js were made with megajs's own functions.
 *
 *   keys and blocks     Buffers. A folder key is 16 bytes; a file key 32: the AES key xor'ed
 *                       with nonce (8) + meta-MAC (8), followed by those 16 bytes.
 *   base64              MEGA's: the URL-safe alphabet without padding (node's "base64url").
 *   key wrapping        AES-128-ECB, no padding, under the master key or a share key.
 *   attributes          "MEGA" + JSON, UTF-8, zero-padded to 16, AES-128-CBC with a zero IV.
 *   file bytes          AES-128-CTR, IV = nonce (8) + a 64-bit block counter from 0.
 *   file MAC            a CBC-MAC per chunk (128 KiB, 256 KiB, .. 1 MiB, 1 MiB, ..) seeded
 *                       nonce+nonce, chained through ECB and folded to 8 bytes.
 *   v1 password key     prepare_key: 65536 rounds of AES-ECB over a fixed seed, keyed by the
 *                       password's UTF-8 bytes in 16-byte pieces; login hash: stringhash.
 *   v2 password key     PBKDF2-HMAC-SHA512(password UTF-8, salt, 100000, 32): the first 16
 *                       bytes the key, the last 16 the login hash.
 *   session id          the csid MPI to the power d mod pq (CRT, as megajs), first 43 bytes.
 */
"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const pbkdf2 = promisify(crypto.pbkdf2);

const e64 = (buf) => Buffer.from(buf).toString("base64url");
// node's base64 decoder takes both alphabets, padded or not.
const d64 = (s) => Buffer.from(String(s || ""), "base64");

// --- AES-128 ---------------------------------------------------------------------------------
// No padding anywhere: MEGA's data is whole blocks. A length that is not throws.
function aes(mode, key, data, decrypt, iv) {
	const make = decrypt ? crypto.createDecipheriv : crypto.createCipheriv;
	const c = make("aes-128-" + mode, key, iv === undefined ? null : iv).setAutoPadding(false);
	return Buffer.concat([c.update(data), c.final()]);
}
const ecbEncrypt = (key, data) => aes("ecb", key, data, false);
const ecbDecrypt = (key, data) => aes("ecb", key, data, true);
const ZERO_IV = Buffer.alloc(16);
const cbcEncrypt = (key, data) => aes("cbc", key, data, false, ZERO_IV);
const cbcDecrypt = (key, data) => aes("cbc", key, data, true, ZERO_IV);

// --- password keys ---------------------------------------------------------------------------
const PREPARE_SEED = Buffer.from("93c467e37db0c7a4d1be3f810152cb56", "hex");

// prepare_key (v1): one ECB cipher per 16-byte piece of the password, reused: an ECB update of
// one block returns that block, so 65536 rounds are 65536 updates per piece, not new ciphers.
function prepareKey(password) {
	const pw = Buffer.isBuffer(password) ? password : Buffer.from(String(password), "utf8");
	const ciphers = [];
	for (let j = 0; j < pw.length; j += 16) {
		const key = Buffer.alloc(16);
		pw.copy(key, 0, j, Math.min(j + 16, pw.length));
		ciphers.push(crypto.createCipheriv("aes-128-ecb", key, null).setAutoPadding(false));
	}
	let pkey = Buffer.from(PREPARE_SEED);
	for (let r = 0; r < 65536; r++) {
		for (const c of ciphers) { pkey = c.update(pkey); }
	}
	return pkey;
}

// stringhash (v1 login hash): the email's bytes xor'ed into 16 (zero-padded big-endian words),
// 16384 rounds of ECB under the password key, words 0 and 2 of the result.
function stringHash(text, key) {
	const s = Buffer.isBuffer(text) ? text : Buffer.from(String(text), "utf8");
	let h = Buffer.alloc(16);
	for (let i = 0; i < s.length; i++) { h[i & 15] ^= s[i]; }
	const c = crypto.createCipheriv("aes-128-ecb", key, null).setAutoPadding(false);
	for (let i = 0; i < 16384; i++) { h = c.update(h); }
	return Buffer.concat([h.subarray(0, 4), h.subarray(8, 12)]);
}

// The password key and login hash (uh) of either account version. us0 is the reply to
// { a:"us0" }: v 2 with a salt s is PBKDF2 (on the thread pool, not the event loop); anything
// else is v1, as before.
async function deriveLogin(email, password, us0) {
	const pw = Buffer.from(String(password), "utf8");
	if (us0 && us0.v === 2 && us0.s) {
		const dk = await pbkdf2(pw, d64(us0.s), 100000, 32, "sha512");
		return { version: 2, pwKey: dk.subarray(0, 16), uh: e64(dk.subarray(16, 32)) };
	}
	const pwKey = prepareKey(pw);
	return { version: 1, pwKey, uh: e64(stringHash(Buffer.from(String(email), "utf8"), pwKey)) };
}

// --- RSA (the session id) --------------------------------------------------------------------
const toBig = (buf) => (buf.length ? BigInt("0x" + buf.toString("hex")) : 0n);
function fromBig(n) {
	if (n === 0n) { return Buffer.alloc(0); }
	let h = n.toString(16);
	if (h.length % 2) { h = "0" + h; }
	return Buffer.from(h, "hex");
}

// `count` MPIs (2-byte bit length, then the bytes) from the head of buf -> BigInts.
function readMpis(buf, count) {
	const out = [];
	let pos = 0;
	for (let i = 0; i < count; i++) {
		if (pos + 2 > buf.length) { throw new Error("MPI " + i + " is cut off"); }
		const len = (buf.readUInt16BE(pos) + 7) >> 3;
		if (pos + 2 + len > buf.length) { throw new Error("MPI " + i + " is cut off"); }
		out.push(toBig(buf.subarray(pos + 2, pos + 2 + len)));
		pos += 2 + len;
	}
	return out;
}

// The decrypted privk -> [p, q, d, u] (u = p^-1 mod q), as megajs's cryptoDecodePrivKey.
function decodePrivKey(privk) {
	const k = readMpis(privk, 4);
	if (k.some((x) => x < 2n)) { throw new Error("not an RSA private key"); }
	return k;
}

function modPow(b, e, m) {
	let r = 1n;
	b %= m;
	while (e > 0n) {
		if (e & 1n) { r = (r * b) % m; }
		b = (b * b) % m;
		e >>= 1n;
	}
	return r;
}

// c^d mod pq by the CRT (megajs's RSAdecrypt).
function rsaDecrypt(c, [p, q, d, u]) {
	const xp = modPow(c % p, d % (p - 1n), p);
	const xq = modPow(c % q, d % (q - 1n), q);
	const t = ((((xq - xp) % q) + q) % q) * u % q;
	return t * p + xp;
}

// csid (MEGA base64 of an MPI) -> the session id (MEGA base64 of the first 43 bytes).
function sessionId(csid, priv) {
	const [c] = readMpis(d64(csid), 1);
	return e64(fromBig(rsaDecrypt(c, priv)).subarray(0, 43));
}

// --- attributes -------------------------------------------------------------------------------
function encryptAttr(obj, key) {
	const text = Buffer.from("MEGA" + JSON.stringify(obj), "utf8");
	const padded = Buffer.alloc(Math.ceil(text.length / 16) * 16);
	text.copy(padded);
	return e64(cbcEncrypt(key, padded));
}

// The attribute object, or null when the key does not open it (or it is not MEGA's).
function decryptAttr(at, key) {
	const data = d64(at);
	if (!data.length || data.length % 16) { return null; }
	let pt;
	try { pt = cbcDecrypt(key, data); } catch (e) { return null; }
	const end = pt.indexOf(0);
	const s = pt.subarray(0, end < 0 ? pt.length : end).toString("utf8");
	if (s.slice(0, 6) !== "MEGA{\"") { return null; }
	try { return JSON.parse(s.slice(4)); } catch (e) { return null; }
}

// --- file keys --------------------------------------------------------------------------------
function unpackFileKey(k) {
	const aesKey = Buffer.alloc(16);
	for (let i = 0; i < 16; i++) { aesKey[i] = k[i] ^ k[16 + i]; }
	return { aesKey, nonce: Buffer.from(k.subarray(16, 24)), metaMac: Buffer.from(k.subarray(24, 32)) };
}

function packFileKey(aesKey, nonce, metaMac) {
	const k = Buffer.alloc(32);
	nonce.copy(k, 16);
	metaMac.copy(k, 24);
	for (let i = 0; i < 16; i++) { k[i] = aesKey[i] ^ k[16 + i]; }
	return k;
}

// --- file bytes -------------------------------------------------------------------------------
// CTR is its own inverse: the same cipher encrypts and decrypts.
function ctrCipher(aesKey, nonce) {
	return crypto.createCipheriv("aes-128-ctr", aesKey, Buffer.concat([nonce, Buffer.alloc(8)]));
}

// [offset, length] of each MAC chunk, which are the upload chunks too: min(k, 8) * 128 KiB.
function chunkSizes(size) {
	const out = [];
	for (let pos = 0, k = 1; pos < size; k++) {
		const len = Math.min(Math.min(k, 8) * 131072, size - pos);
		out.push([pos, len]);
		pos += len;
	}
	return out;
}

// The file MAC over the plaintext, fed in pieces of any size. condense() is the 8-byte meta-MAC.
class FileMac {
	constructor(aesKey, nonce) {
		this.key = aesKey;
		this.seed = Buffer.concat([nonce, nonce]);
		this.macs = [];
		this.size = 0;
		this.chunkLen = 131072;   // the current chunk's length
		this.left = this.chunkLen; // and how much of it is still to come
		this.cbc = null;
		this.last = null;
		this.full = false;         // the last chunk closed, padded to 16, filled its length
	}

	update(data) {
		let off = 0;
		while (off < data.length) {
			if (!this.cbc) { this.cbc = crypto.createCipheriv("aes-128-cbc", this.key, this.seed).setAutoPadding(false); }
			const n = Math.min(this.left, data.length - off);
			this._feed(data.subarray(off, off + n));
			off += n;
			this.size += n;
			this.left -= n;
			if (this.left === 0) { this._close(); }
		}
	}

	_feed(piece) {
		const out = this.cbc.update(piece);
		if (out.length) { this.last = out.subarray(out.length - 16); }
	}

	// A chunk's MAC is the last block of its CBC; a short last chunk is zero-padded.
	_close() {
		const done = this.chunkLen - this.left;
		if (done % 16) { this._feed(Buffer.alloc(16 - (done % 16))); }
		this.full = Math.ceil(done / 16) * 16 === this.chunkLen;
		this.macs.push(Buffer.from(this.last));
		this.cbc = null;
		this.last = null;
		if (this.chunkLen < 1048576) { this.chunkLen += 131072; }
		this.left = this.chunkLen;
	}

	static fold(key, macs) {
		const c = crypto.createCipheriv("aes-128-ecb", key, null).setAutoPadding(false);
		let mac = Buffer.alloc(16);
		for (const m of macs) {
			const x = Buffer.alloc(16);
			for (let j = 0; j < 16; j++) { x[j] = mac[j] ^ m[j]; }
			mac = c.update(x);
		}
		const out = Buffer.alloc(8);
		for (let j = 0; j < 4; j++) { out[j] = mac[j] ^ mac[4 + j]; out[4 + j] = mac[8 + j] ^ mac[12 + j]; }
		return out;
	}

	// The meta-MAC as MEGA's SDK and web client compute it: one MAC per chunk.
	condense() {
		if (this.cbc) { this._close(); }
		return FileMac.fold(this.key, this.macs);
	}

	// What megajs 1.3.10 computes for an empty file or one whose size, rounded up to 16, ends on a
	// chunk boundary: one more, untouched nonce+nonce block (its MAC.condense pushes the state it
	// has just reset). null where the two agree.
	condenseMegajs() {
		this.condense();
		if (this.size !== 0 && !this.full) { return null; }
		return FileMac.fold(this.key, this.macs.concat([this.seed]));
	}

	// Whether metaMac (8 bytes, from the file key) is this file's: MEGA's, or megajs's for the
	// files it uploaded.
	matches(metaMac) {
		if (!Buffer.isBuffer(metaMac) || metaMac.length !== 8) { return false; }
		if (crypto.timingSafeEqual(this.condense(), metaMac)) { return true; }
		const alt = this.condenseMegajs();
		return !!alt && crypto.timingSafeEqual(alt, metaMac);
	}
}

module.exports = { e64, d64, ecbEncrypt, ecbDecrypt, cbcEncrypt, cbcDecrypt, prepareKey, stringHash,
	deriveLogin, readMpis, decodePrivKey, rsaDecrypt, modPow, sessionId, toBig, fromBig,
	encryptAttr, decryptAttr, unpackFileKey, packFileKey, ctrCipher, chunkSizes, FileMac };
