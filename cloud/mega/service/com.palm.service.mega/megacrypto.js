/*global IMPORTS, require, exports, Buffer, BigInteger, console */
/* megacrypto.js - the client-side crypto for the Mega (mega.nz) connector.
 *
 * Mega is zero-knowledge: every filename and file byte is AES-encrypted under keys derived
 * from the account password, and the login session-id arrives RSA-encrypted. None of that can
 * be delegated to the server (that is the whole point), so it is implemented here in ES5.
 *
 * WHAT USES WHICH ENGINE (device node = OpenSSL 0.9.8k, no privateDecrypt, no SHA512-pbkdf2):
 *   - AES-128 for KEY-SIZED data (key unwrap, attribute CBC, password key-derivation, the
 *     chunk CBC-MAC seed) -> a small pure-JS AES here. One-time / tiny data.
 *   - AES-128-CTR for BULK FILE bytes -> native node `crypto` (createDecipheriv/Cipheriv),
 *     streaming from/to disk. Must be native for speed.
 *   - RSA session-id decrypt -> pure-JS bignum modPow ([[bignum.js]]). Once per sign-in.
 *   - PBKDF2-HMAC-SHA512 (v2-account password key) -> pure-JS SHA-512 here. Once per sign-in
 *     (slow on the TouchPad - see README; v1 accounts use the AES prepare_key path instead).
 *
 * Number model matches Mega's own webclient: keys/blocks are "a32" = arrays of unsigned 32-bit
 * big-endian words. Helpers convert to/from byte strings and the Mega base64 variant (URL-safe
 * alphabet, '=' padding stripped).
 */
var MegaCrypto = (function () {
	var _reqf = (typeof require !== "undefined") ? require
		: (typeof IMPORTS !== "undefined" && IMPORTS.require) || null;
	var _nc = _reqf ? _reqf("crypto") : null;
	var _fs = _reqf ? _reqf("fs") : null;
	var _BigInteger = (typeof BigInteger !== "undefined") ? BigInteger
		: (_reqf ? (function () { try { return _reqf("./bignum.js").BigInteger; } catch (e) { return null; } })() : null);

	// ---- byte / a32 / string helpers ---------------------------------------------------
	// a32 word arrays are big-endian; a "binary string" holds bytes as char codes 0..255.
	function strToA32(s) {
		var len = ((s.length + 3) >> 2);
		var a = new Array(len);
		for (var i = 0; i < len; i++) { a[i] = 0; }
		for (var j = 0; j < s.length; j++) {
			a[j >> 2] |= (s.charCodeAt(j) & 0xff) << (24 - (j & 3) * 8);
		}
		return a;
	}
	function a32ToStr(a) {
		var s = "";
		for (var i = 0; i < a.length * 4; i++) {
			s += String.fromCharCode((a[i >> 2] >>> (24 - (i & 3) * 8)) & 0xff);
		}
		return s;
	}
	function bytesToA32(bytes) {   // bytes: Array/Buffer of 0..255
		var len = (bytes.length + 3) >> 2, a = new Array(len);
		for (var i = 0; i < len; i++) { a[i] = 0; }
		for (var j = 0; j < bytes.length; j++) {
			a[j >> 2] |= (bytes[j] & 0xff) << (24 - (j & 3) * 8);
		}
		return a;
	}
	function a32ToBytes(a) {
		var out = [];
		for (var i = 0; i < a.length * 4; i++) {
			out.push((a[i >> 2] >>> (24 - (i & 3) * 8)) & 0xff);
		}
		return out;
	}

	// Mega base64: standard alphabet with +/ -> -_ and '=' stripped.
	var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	var B64INV = (function () { var m = {}; for (var i = 0; i < B64.length; i++) { m[B64.charAt(i)] = i; } return m; })();
	function bytesToB64(bytes) {
		var out = "", i;
		for (i = 0; i + 2 < bytes.length; i += 3) {
			var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
			out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) +
				B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
		}
		var rem = bytes.length - i;
		if (rem === 1) {
			out += B64.charAt((bytes[i] >> 2) & 63) + B64.charAt((bytes[i] << 4) & 63);
		} else if (rem === 2) {
			var m = (bytes[i] << 8) | bytes[i + 1];
			out += B64.charAt((m >> 10) & 63) + B64.charAt((m >> 4) & 63) + B64.charAt((m << 2) & 63);
		}
		return out;
	}
	function b64ToBytes(s) {
		var bytes = [], i, buf = 0, bits = 0;
		for (i = 0; i < s.length; i++) {
			var v = B64INV[s.charAt(i)];
			if (v == null) { continue; }
			buf = (buf << 6) | v; bits += 6;
			if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
		}
		return bytes;
	}
	function a32ToB64(a) { return bytesToB64(a32ToBytes(a)); }
	function b64ToA32(s) { return bytesToA32(b64ToBytes(s)); }

	// ---- AES-128 (pure JS, byte-oriented), used for key-sized data only -----------------
	var SBOX = [], INV_SBOX = [], RCON = [1];
	(function initAes() {
		var p = 1, q = 1, i;
		var s = new Array(256), inv = new Array(256);
		// Generate S-box via the standard GF(2^8) construction.
		do {
			p = p ^ ((p << 1) & 0xff) ^ (((p >> 7) & 1) ? 0x1b : 0);
			q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
			if (q & 0x80) { q ^= 0x09; }
			q &= 0xff;
			var x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^
				((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
			x = (x ^ 0x63) & 0xff;
			s[p] = x;
		} while (p !== 1);
		s[0] = 0x63;
		for (i = 0; i < 256; i++) { inv[s[i]] = i; SBOX[i] = s[i]; INV_SBOX[i] = inv[i]; }
		for (i = 0; i < 256; i++) { INV_SBOX[SBOX[i]] = i; }
		for (i = 1; i < 15; i++) { RCON[i] = ((RCON[i - 1] << 1) ^ (((RCON[i - 1] >> 7) & 1) ? 0x1b : 0)) & 0xff; }
	})();
	function xtime(a) { return ((a << 1) ^ (((a >> 7) & 1) ? 0x1b : 0)) & 0xff; }
	function mul(a, b) {
		var r = 0;
		while (b) { if (b & 1) { r ^= a; } a = xtime(a); b >>= 1; }
		return r & 0xff;
	}
	// Key schedule for AES-128 (16-byte key). Returns 176-byte expanded key (11 round keys).
	function expandKey(key) {
		var w = key.slice(0, 16), i = 16, rc = 0;
		while (i < 176) {
			var t = [w[i - 4], w[i - 3], w[i - 2], w[i - 1]];
			if (i % 16 === 0) {
				var tmp = t[0]; t[0] = SBOX[t[1]] ^ RCON[rc++]; t[1] = SBOX[t[2]];
				t[2] = SBOX[t[3]]; t[3] = SBOX[tmp];
			}
			for (var j = 0; j < 4; j++) { w[i] = w[i - 16] ^ t[j]; i++; }
		}
		return w;
	}
	function addRoundKey(st, w, off) { for (var i = 0; i < 16; i++) { st[i] ^= w[off + i]; } }
	function subBytes(st, box) { for (var i = 0; i < 16; i++) { st[i] = box[st[i]]; } }
	function shiftRows(st) {
		var t;
		t = st[1]; st[1] = st[5]; st[5] = st[9]; st[9] = st[13]; st[13] = t;
		t = st[2]; st[2] = st[10]; st[10] = t; t = st[6]; st[6] = st[14]; st[14] = t;
		t = st[15]; st[15] = st[11]; st[11] = st[7]; st[7] = st[3]; st[3] = t;
	}
	function invShiftRows(st) {
		var t;
		t = st[13]; st[13] = st[9]; st[9] = st[5]; st[5] = st[1]; st[1] = t;
		t = st[2]; st[2] = st[10]; st[10] = t; t = st[6]; st[6] = st[14]; st[14] = t;
		t = st[3]; st[3] = st[7]; st[7] = st[11]; st[11] = st[15]; st[15] = t;
	}
	function mixColumns(st) {
		for (var c = 0; c < 4; c++) {
			var i = c * 4, a0 = st[i], a1 = st[i + 1], a2 = st[i + 2], a3 = st[i + 3];
			st[i] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
			st[i + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
			st[i + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
			st[i + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
		}
	}
	function invMixColumns(st) {
		for (var c = 0; c < 4; c++) {
			var i = c * 4, a0 = st[i], a1 = st[i + 1], a2 = st[i + 2], a3 = st[i + 3];
			st[i] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
			st[i + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
			st[i + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
			st[i + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
		}
	}
	function encBlock(w, block) {
		var st = block.slice(0, 16), r;
		addRoundKey(st, w, 0);
		for (r = 1; r < 10; r++) { subBytes(st, SBOX); shiftRows(st); mixColumns(st); addRoundKey(st, w, r * 16); }
		subBytes(st, SBOX); shiftRows(st); addRoundKey(st, w, 160);
		return st;
	}
	function decBlock(w, block) {
		var st = block.slice(0, 16), r;
		addRoundKey(st, w, 160);
		for (r = 9; r >= 1; r--) { invShiftRows(st); subBytes(st, INV_SBOX); addRoundKey(st, w, r * 16); invMixColumns(st); }
		invShiftRows(st); subBytes(st, INV_SBOX); addRoundKey(st, w, 0);
		return st;
	}

	// AES-ECB over a32 (Mega key wrapping is ECB on 16-byte blocks with the same 128-bit key).
	function ecbEncryptA32(keyA32, dataA32) {
		var w = expandKey(a32ToBytes(keyA32.slice(0, 4))), out = [];
		var bytes = a32ToBytes(dataA32);
		for (var i = 0; i < bytes.length; i += 16) { out = out.concat(encBlock(w, bytes.slice(i, i + 16))); }
		return bytesToA32(out);
	}
	function ecbDecryptA32(keyA32, dataA32) {
		var w = expandKey(a32ToBytes(keyA32.slice(0, 4))), out = [];
		var bytes = a32ToBytes(dataA32);
		for (var i = 0; i < bytes.length; i += 16) { out = out.concat(decBlock(w, bytes.slice(i, i + 16))); }
		return bytesToA32(out);
	}
	// AES-CBC decrypt bytes with a 128-bit key and zero IV (Mega node attributes).
	function cbcDecryptBytes(keyA32, bytes) {
		var w = expandKey(a32ToBytes(keyA32.slice(0, 4))), out = [], prev = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
		for (var i = 0; i + 16 <= bytes.length; i += 16) {
			var ct = bytes.slice(i, i + 16), pt = decBlock(w, ct);
			for (var j = 0; j < 16; j++) { out.push(pt[j] ^ prev[j]); }
			prev = ct;
		}
		return out;
	}
	function cbcEncryptBytes(keyA32, bytes) {
		var w = expandKey(a32ToBytes(keyA32.slice(0, 4))), out = [], prev = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
		for (var i = 0; i + 16 <= bytes.length; i += 16) {
			var blk = bytes.slice(i, i + 16);
			for (var j = 0; j < 16; j++) { blk[j] ^= prev[j]; }
			prev = encBlock(w, blk); out = out.concat(prev);
		}
		return out;
	}

	// ---- Mega password key derivation (v1) ---------------------------------------------
	// ---- native AES-ECB engine (for the HOT key-derivation loops) -----------------------
	// prepare_key (65536 rounds) and stringhash (16384 rounds) are far too slow in pure-JS AES
	// on the device's ancient node (v0.4.12 interpreter) - a sign-in would spin for minutes.
	// OpenSSL via node `crypto` does the same AES in C. The device's 0.4.12 createCipheriv wants
	// BINARY-STRING key/iv (not Buffers, which it rejects) and has no setAutoPadding, but a reused
	// ECB cipher chains 16-byte blocks correctly (verified on-device: byte-identical to the pure-JS
	// AES). Modern node accepts Buffers - detect which and use it. NEVER call final() (that would
	// add padding on modern node); ECB update() returns each block immediately.
	var _cipherUsesBuf = null;
	function _detectCipherBuf() {
		if (_cipherUsesBuf !== null) { return _cipherUsesBuf; }
		_cipherUsesBuf = false;
		if (_nc && _nc.createCipheriv) {
			try { _nc.createCipheriv("aes-128-ecb", toBuffer(_zeros(16)), toBuffer(_zeros(16))); _cipherUsesBuf = true; }
			catch (e) { _cipherUsesBuf = false; }
		}
		return _cipherUsesBuf;
	}
	function _zeros(n) { var a = []; for (var i = 0; i < n; i++) { a.push(0); } return a; }
	function _binStr(bytes) { var s = "", i; for (i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i] & 0xff); } return s; }
	function _binToBytes(s) { var b = [], i; for (i = 0; i < s.length; i++) { b.push(s.charCodeAt(i) & 0xff); } return b; }
	// Make a reusable ECB cipher for a 16-byte key; returns an object with update(state)->state,
	// where `state` is a Buffer (modern) or binary string (device) held across the whole loop.
	function _ecbCipher(keyBytes) {
		var useBuf = _detectCipherBuf(), iv = _zeros(16), ci;
		if (useBuf) {
			ci = _nc.createCipheriv("aes-128-ecb", toBuffer(keyBytes), toBuffer(iv));
			if (ci.setAutoPadding) { ci.setAutoPadding(false); }
			return { buf: true, ci: ci, seed: function (b) { return toBuffer(b); },
				step: function (s) { return ci.update(s); }, out: function (s) { return [].slice.call(s); } };
		}
		ci = _nc.createCipheriv("aes-128-ecb", _binStr(keyBytes), _binStr(iv));
		if (ci.setAutoPadding) { ci.setAutoPadding(false); }
		return { buf: false, ci: ci, seed: function (b) { return _binStr(b); },
			step: function (s) { return ci.update(s, "binary", "binary"); }, out: function (s) { return _binToBytes(s); } };
	}

	// prepare_key: 65536 rounds of AES-encrypting a fixed seed, keyed by the password words.
	function prepareKeyJS(passwordStr) {
		var a = strToA32(passwordStr);
		if (a.length % 4) { a = a.concat([0,0,0].slice(0, 4 - (a.length % 4))); }
		var pkey = [0x93C467E3, 0x1A76B2A5, 0x3210A5A9, 0x2CBE6FB3];
		for (var r = 65536; r--; ) {
			for (var j = 0; j < a.length; j += 4) {
				var key = [a[j] || 0, a[j + 1] || 0, a[j + 2] || 0, a[j + 3] || 0];
				pkey = ecbEncryptA32(key, pkey);
			}
		}
		return pkey;
	}
	function prepareKeyNative(passwordStr) {
		var a = strToA32(passwordStr);
		if (a.length % 4) { a = a.concat([0,0,0].slice(0, 4 - (a.length % 4))); }
		var engines = [];
		for (var j = 0; j < a.length; j += 4) {
			engines.push(_ecbCipher(a32ToBytes([a[j] || 0, a[j + 1] || 0, a[j + 2] || 0, a[j + 3] || 0])));
		}
		var state = engines[0].seed(a32ToBytes([0x93C467E3, 0x1A76B2A5, 0x3210A5A9, 0x2CBE6FB3]));
		for (var r = 65536; r--; ) {
			for (var e = 0; e < engines.length; e++) { state = engines[e].step(state); }
		}
		return bytesToA32(engines[0].out(state));
	}
	function prepareKey(passwordStr) {
		if (_nc && _nc.createCipheriv) {
			try { return prepareKeyNative(passwordStr); } catch (e) { /* fall back */ }
		}
		return prepareKeyJS(passwordStr);
	}
	// stringhash: the v1 login user-hash (uh) from email + the password AES key.
	function stringHash(str, aesKeyA32) {
		var s32 = strToA32(str), h32 = [0, 0, 0, 0], i;
		for (i = 0; i < s32.length; i++) { h32[i % 4] ^= s32[i]; }
		if (_nc && _nc.createCipheriv) {
			try {
				var eng = _ecbCipher(a32ToBytes(aesKeyA32.slice(0, 4)));
				var st = eng.seed(a32ToBytes(h32));
				for (i = 16384; i--; ) { st = eng.step(st); }
				var w = bytesToA32(eng.out(st));
				return a32ToB64([w[0], w[2]]);
			} catch (e) { /* fall back */ }
		}
		for (i = 16384; i--; ) { h32 = ecbEncryptA32(aesKeyA32, h32); }
		return a32ToB64([h32[0], h32[2]]);
	}

	// ---- SHA-512 + HMAC + PBKDF2 (v2 password key) -------------------------------------
	// 64-bit words as [hi, lo] Int32 pairs. Compact, validated against native SHA-512.
	var K512 = [
		[0x428a2f98,0xd728ae22],[0x71374491,0x23ef65cd],[0xb5c0fbcf,0xec4d3b2f],[0xe9b5dba5,0x8189dbbc],
		[0x3956c25b,0xf348b538],[0x59f111f1,0xb605d019],[0x923f82a4,0xaf194f9b],[0xab1c5ed5,0xda6d8118],
		[0xd807aa98,0xa3030242],[0x12835b01,0x45706fbe],[0x243185be,0x4ee4b28c],[0x550c7dc3,0xd5ffb4e2],
		[0x72be5d74,0xf27b896f],[0x80deb1fe,0x3b1696b1],[0x9bdc06a7,0x25c71235],[0xc19bf174,0xcf692694],
		[0xe49b69c1,0x9ef14ad2],[0xefbe4786,0x384f25e3],[0x0fc19dc6,0x8b8cd5b5],[0x240ca1cc,0x77ac9c65],
		[0x2de92c6f,0x592b0275],[0x4a7484aa,0x6ea6e483],[0x5cb0a9dc,0xbd41fbd4],[0x76f988da,0x831153b5],
		[0x983e5152,0xee66dfab],[0xa831c66d,0x2db43210],[0xb00327c8,0x98fb213f],[0xbf597fc7,0xbeef0ee4],
		[0xc6e00bf3,0x3da88fc2],[0xd5a79147,0x930aa725],[0x06ca6351,0xe003826f],[0x14292967,0x0a0e6e70],
		[0x27b70a85,0x46d22ffc],[0x2e1b2138,0x5c26c926],[0x4d2c6dfc,0x5ac42aed],[0x53380d13,0x9d95b3df],
		[0x650a7354,0x8baf63de],[0x766a0abb,0x3c77b2a8],[0x81c2c92e,0x47edaee6],[0x92722c85,0x1482353b],
		[0xa2bfe8a1,0x4cf10364],[0xa81a664b,0xbc423001],[0xc24b8b70,0xd0f89791],[0xc76c51a3,0x0654be30],
		[0xd192e819,0xd6ef5218],[0xd6990624,0x5565a910],[0xf40e3585,0x5771202a],[0x106aa070,0x32bbd1b8],
		[0x19a4c116,0xb8d2d0c8],[0x1e376c08,0x5141ab53],[0x2748774c,0xdf8eeb99],[0x34b0bcb5,0xe19b48a8],
		[0x391c0cb3,0xc5c95a63],[0x4ed8aa4a,0xe3418acb],[0x5b9cca4f,0x7763e373],[0x682e6ff3,0xd6b2b8a3],
		[0x748f82ee,0x5defb2fc],[0x78a5636f,0x43172f60],[0x84c87814,0xa1f0ab72],[0x8cc70208,0x1a6439ec],
		[0x90befffa,0x23631e28],[0xa4506ceb,0xde82bde9],[0xbef9a3f7,0xb2c67915],[0xc67178f2,0xe372532b],
		[0xca273ece,0xea26619c],[0xd186b8c7,0x21c0c207],[0xeada7dd6,0xcde0eb1e],[0xf57d4f7f,0xee6ed178],
		[0x06f067aa,0x72176fba],[0x0a637dc5,0xa2c898a6],[0x113f9804,0xbef90dae],[0x1b710b35,0x131c471b],
		[0x28db77f5,0x23047d84],[0x32caab7b,0x40c72493],[0x3c9ebe0a,0x15c9bebc],[0x431d67c4,0x9c100d4c],
		[0x4cc5d4be,0xcb3e42b6],[0x597f299c,0xfc657e2a],[0x5fcb6fab,0x3ad6faec],[0x6c44198c,0x4a475817]
	];
	function sha512(bytes) {
		// H init (SHA-512)
		var H = [
			[0x6a09e667,0xf3bcc908],[0xbb67ae85,0x84caa73b],[0x3c6ef372,0xfe94f82b],[0xa54ff53a,0x5f1d36f1],
			[0x510e527f,0xade682d1],[0x9b05688c,0x2b3e6c1f],[0x1f83d9ab,0xfb41bd6b],[0x5be0cd19,0x137e2179]
		];
		var msg = bytes.slice(0);
		var bitLenHi = Math.floor(bytes.length / 0x20000000);
		var bitLenLo = (bytes.length * 8) >>> 0;
		msg.push(0x80);
		while (msg.length % 128 !== 112) { msg.push(0); }
		// 128-bit length: we only support < 2^32 bytes; high 64 bits are 0 except bitLenHi.
		for (var z = 0; z < 8; z++) { msg.push(0); }
		msg.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff);
		msg.push((bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff);

		function add64() {
			var lo = 0, hi = 0, i;
			for (i = 0; i < arguments.length; i++) { lo += arguments[i][1] & 0xffff; }
			var carry = lo >>> 16; lo &= 0xffff;
			var lo2 = carry;
			for (i = 0; i < arguments.length; i++) { lo2 += (arguments[i][1] >>> 16) & 0xffff; }
			carry = lo2 >>> 16; lo2 &= 0xffff;
			var loFull = (lo2 << 16) | lo;
			var h = carry;
			for (i = 0; i < arguments.length; i++) { h += arguments[i][0] & 0xffff; }
			carry = h >>> 16; h &= 0xffff;
			var h2 = carry;
			for (i = 0; i < arguments.length; i++) { h2 += (arguments[i][0] >>> 16) & 0xffff; }
			h2 &= 0xffff;
			hi = ((h2 << 16) | h) >>> 0;
			return [hi >>> 0, loFull >>> 0];
		}
		function ror(x, n) {   // rotate right 64-bit
			var hi = x[0] >>> 0, lo = x[1] >>> 0;
			if (n === 0) { return [hi, lo]; }
			if (n < 32) {
				return [((hi >>> n) | (lo << (32 - n))) >>> 0, ((lo >>> n) | (hi << (32 - n))) >>> 0];
			}
			n -= 32;
			return [((lo >>> n) | (hi << (32 - n))) >>> 0, ((hi >>> n) | (lo << (32 - n))) >>> 0];
		}
		function shr(x, n) {
			var hi = x[0] >>> 0, lo = x[1] >>> 0;
			if (n < 32) { return [(hi >>> n) >>> 0, ((lo >>> n) | (hi << (32 - n))) >>> 0]; }
			return [0, (hi >>> (n - 32)) >>> 0];
		}
		function xor(a, b) { return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0]; }

		var W = new Array(80), t;
		for (var off = 0; off < msg.length; off += 128) {
			for (t = 0; t < 16; t++) {
				var b = off + t * 8;
				W[t] = [
					((msg[b] << 24) | (msg[b + 1] << 16) | (msg[b + 2] << 8) | msg[b + 3]) >>> 0,
					((msg[b + 4] << 24) | (msg[b + 5] << 16) | (msg[b + 6] << 8) | msg[b + 7]) >>> 0
				];
			}
			for (t = 16; t < 80; t++) {
				var s0 = xor(xor(ror(W[t - 15], 1), ror(W[t - 15], 8)), shr(W[t - 15], 7));
				var s1 = xor(xor(ror(W[t - 2], 19), ror(W[t - 2], 61)), shr(W[t - 2], 6));
				W[t] = add64(W[t - 16], s0, W[t - 7], s1);
			}
			var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
			for (t = 0; t < 80; t++) {
				var S1 = xor(xor(ror(e, 14), ror(e, 18)), ror(e, 41));
				var ch = xor([e[0] & f[0], e[1] & f[1]], [(~e[0]) & g[0], (~e[1]) & g[1]]);
				var temp1 = add64(h, S1, ch, K512[t], W[t]);
				var S0 = xor(xor(ror(a, 28), ror(a, 34)), ror(a, 39));
				var maj = xor(xor([a[0] & bb[0], a[1] & bb[1]], [a[0] & c[0], a[1] & c[1]]), [bb[0] & c[0], bb[1] & c[1]]);
				var temp2 = add64(S0, maj);
				h = g; g = f; f = e; e = add64(d, temp1); d = c; c = bb; bb = a; a = add64(temp1, temp2);
			}
			H[0] = add64(H[0], a); H[1] = add64(H[1], bb); H[2] = add64(H[2], c); H[3] = add64(H[3], d);
			H[4] = add64(H[4], e); H[5] = add64(H[5], f); H[6] = add64(H[6], g); H[7] = add64(H[7], h);
		}
		var out = [];
		for (var i2 = 0; i2 < 8; i2++) {
			out.push((H[i2][0] >>> 24) & 0xff, (H[i2][0] >>> 16) & 0xff, (H[i2][0] >>> 8) & 0xff, H[i2][0] & 0xff);
			out.push((H[i2][1] >>> 24) & 0xff, (H[i2][1] >>> 16) & 0xff, (H[i2][1] >>> 8) & 0xff, H[i2][1] & 0xff);
		}
		return out;
	}
	function hmacSha512(keyBytes, msgBytes) {
		var block = 128, key = keyBytes.slice(0);
		if (key.length > block) { key = sha512(key); }
		while (key.length < block) { key.push(0); }
		var oKey = [], iKey = [];
		for (var i = 0; i < block; i++) { oKey.push(key[i] ^ 0x5c); iKey.push(key[i] ^ 0x36); }
		return sha512(oKey.concat(sha512(iKey.concat(msgBytes))));
	}
	// PBKDF2-HMAC-SHA512. v2 Mega accounts use 100000 iterations - pure-JS SHA-512 would take
	// many minutes on the device, so this drives NATIVE HMAC-SHA512 (one-time, at sign-in).
	//
	// CRITICAL: on the device's node 0.4.12, hmac.digest() with NO encoding returns a BINARY
	// STRING, not a Buffer (verified), and hmac.update(str) with no encoding treats the string as
	// UTF-8. Both silently corrupted an earlier Buffer-assuming version (wrong uh -> Mega 402 at
	// login). So this uses EXPLICIT "binary" encodings throughout - the same trick the AES path
	// uses: update(binStr,"binary"), digest("binary") -> a 64-char binary string that is fed
	// straight back into the next update with no conversion. `u` stays a binary string across the
	// loop; the running result `t` is a byte array XORed via charCodeAt. Correct on both 0.4.12
	// and modern node (where "binary"=="latin1"). Falls back to pure-JS if no node crypto.
	function pbkdf2Native(passwordBytes, saltBytes, iterations, dkLen) {
		var pw = toBuffer(passwordBytes);          // key as a Buffer (accepted on 0.4.12)
		function hmacBin(msgBin) {                 // msgBin: binary string -> binary string
			var h = _nc.createHmac("sha512", pw);
			h.update(msgBin, "binary");
			return h.digest("binary");
		}
		var saltBin = _binStr(saltBytes);
		var out = [], block = 1;
		while (out.length < dkLen) {
			var blBin = String.fromCharCode((block >>> 24) & 0xff, (block >>> 16) & 0xff,
				(block >>> 8) & 0xff, block & 0xff);
			var u = hmacBin(saltBin + blBin);      // binary string (64 chars)
			var t = [];
			for (var c = 0; c < u.length; c++) { t.push(u.charCodeAt(c) & 0xff); }
			for (var it = 1; it < iterations; it++) {
				u = hmacBin(u);                    // binary string in and out - no conversion
				for (var k = 0; k < t.length; k++) { t[k] ^= (u.charCodeAt(k) & 0xff); }
			}
			for (var m = 0; m < t.length; m++) { out.push(t[m]); }
			block++;
		}
		return out.slice(0, dkLen);
	}
	function pbkdf2Sha512(passwordBytes, saltBytes, iterations, dkLen) {
		if (_nc && _nc.createHmac) {
			try { return pbkdf2Native(passwordBytes, saltBytes, iterations, dkLen); } catch (e) { /* fall back */ }
		}
		var out = [], block = 1;
		while (out.length < dkLen) {
			var bl = [(block >>> 24) & 0xff, (block >>> 16) & 0xff, (block >>> 8) & 0xff, block & 0xff];
			var u = hmacSha512(passwordBytes, saltBytes.concat(bl));
			var t = u.slice(0);
			for (var it = 1; it < iterations; it++) {
				u = hmacSha512(passwordBytes, u);
				for (var k = 0; k < t.length; k++) { t[k] ^= u[k]; }
			}
			out = out.concat(t); block++;
		}
		return out.slice(0, dkLen);
	}

	// ---- RSA (session-id decrypt at login) ---------------------------------------------
	// privkA32 -> [p, q, d, u] BigIntegers, parsed from 4 concatenated MPIs.
	function parsePrivKey(privkA32) {
		var bytes = a32ToBytes(privkA32), pos = 0, out = [];
		for (var i = 0; i < 4; i++) {
			var bitlen = (bytes[pos] << 8) | bytes[pos + 1];
			var bytelen = (bitlen + 7) >> 3;
			pos += 2;
			var hex = "";
			for (var j = 0; j < bytelen; j++) {
				var h = (bytes[pos + j] & 0xff).toString(16);
				hex += (h.length === 1 ? "0" : "") + h;
			}
			out.push(new _BigInteger(hex.length ? hex : "0", 16));
			pos += bytelen;
		}
		return out;   // [p, q, d, u]
	}
	// csid (base64) -> session id (base64url). m = c^d mod n, first 43 bytes.
	function rsaDecryptSid(csidB64, priv) {
		var bytes = b64ToBytes(csidB64);
		var bitlen = (bytes[0] << 8) | bytes[1];
		var bytelen = (bitlen + 7) >> 3;
		var hex = "";
		for (var j = 0; j < bytelen; j++) {
			var h = (bytes[2 + j] & 0xff).toString(16);
			hex += (h.length === 1 ? "0" : "") + h;
		}
		var c = new _BigInteger(hex.length ? hex : "0", 16);
		var p = priv[0], q = priv[1], d = priv[2];
		var n = p.multiply(q);
		var m = c.modPow(d, n);
		var mhex = m.toString(16);
		if (mhex.length % 2) { mhex = "0" + mhex; }
		var mbytes = [];
		for (var k = 0; k < mhex.length; k += 2) { mbytes.push(parseInt(mhex.substr(k, 2), 16)); }
		return bytesToB64(mbytes.slice(0, 43));
	}

	// ---- attributes ---------------------------------------------------------------------
	// Decrypt a node's `a` attribute block (base64) with its 128-bit key. Returns the parsed
	// JSON object ({ n: "filename", ... }) or null.
	function decryptAttr(attrB64, keyA32) {
		var pt = cbcDecryptBytes(keyA32.slice(0, 4), b64ToBytes(attrB64));
		var s = "";
		for (var i = 0; i < pt.length && pt[i] !== 0; i++) { s += String.fromCharCode(pt[i]); }
		if (s.substr(0, 4) !== "MEGA") { return null; }
		try { return JSON.parse(s.substr(4)); } catch (e) { return null; }
	}
	// Encrypt attributes for upload: "MEGA" + JSON, zero-padded to 16 bytes, CBC(zero IV).
	function encryptAttr(obj, keyA32) {
		var s = "MEGA" + JSON.stringify(obj), bytes = [];
		for (var i = 0; i < s.length; i++) { bytes.push(s.charCodeAt(i) & 0xff); }
		while (bytes.length % 16 !== 0) { bytes.push(0); }
		return bytesToB64(cbcEncryptBytes(keyA32.slice(0, 4), bytes));
	}

	// ---- node keys ----------------------------------------------------------------------
	// A folder key is 4 words; a file key is 8 words condensed to 4 for the AES key + nonce +
	// meta_mac. Unwrap a node key (`k` = "<sharehandle>:<b64 encrypted key>") with a sharekey.
	function unwrapNodeKey(encKeyA32, sharekeyA32) { return ecbDecryptA32(sharekeyA32, encKeyA32); }
	// Split a raw 8-word file key into { aesKeyA32(4), nonceBytes(8), metaMac(2) }.
	function unpackFileKey(k8) {
		var aesKey = [(k8[0] ^ k8[4]) >>> 0, (k8[1] ^ k8[5]) >>> 0, (k8[2] ^ k8[6]) >>> 0, (k8[3] ^ k8[7]) >>> 0];
		return { aesKeyA32: aesKey, nonce: [k8[4] >>> 0, k8[5] >>> 0], metaMac: [k8[6] >>> 0, k8[7] >>> 0] };
	}
	// Recondense (aesKey, nonce, metaMac) -> the 8-word stored key (upload).
	function packFileKey(aesKeyA32, nonce, metaMac) {
		return [
			(aesKeyA32[0] ^ nonce[0]) >>> 0, (aesKeyA32[1] ^ nonce[1]) >>> 0,
			(aesKeyA32[2] ^ metaMac[0]) >>> 0, (aesKeyA32[3] ^ metaMac[1]) >>> 0,
			nonce[0] >>> 0, nonce[1] >>> 0, metaMac[0] >>> 0, metaMac[1] >>> 0
		];
	}

	function toBuffer(bytes) {   // helper: byte array -> Buffer (node)
		if (typeof Buffer !== "undefined" && Buffer.from) { return Buffer.from(bytes); }
		return new Buffer(bytes);   // old node
	}
	function ivFromNonce(nonce, counterHi, counterLo) {
		var iv = a32ToBytes([nonce[0], nonce[1], counterHi || 0, counterLo || 0]);
		return toBuffer(iv);
	}

	// ---- bulk file crypto (AES-128-CTR, streamed sync in bounded chunks) -----------------
	// CTR is symmetric, so this both ENCRYPTS and DECRYPTS. The device node (0.4.12) has NO
	// "aes-128-ctr" cipher ("Unknown cipher"), but native aes-128-ecb IS available - so we build
	// the CTR keystream ourselves: keystream block i = AES-ECB(counter_i) with
	// counter_i = nonce(8 bytes) || uint64_be(i), and plaintext = ciphertext XOR keystream. All
	// AES runs natively (fast); only the counter assembly + XOR are JS. Uses the string arg form
	// the 0.4.12 binding requires (it rejects Buffers) via _detectCipherBuf. Reads in 64 KB
	// slices (multiple of 16) so memory stays bounded. cb(err).
	function ctrFile(inPath, outPath, aesKeyBytes, nonce, cb) {
		if (!_nc || !_fs || !_nc.createCipheriv) { cb({ errorCode: "NO_NODE_CRYPTO" }); return; }
		try {
			var useBuf = _detectCipherBuf();
			var keyArg = useBuf ? toBuffer(aesKeyBytes) : _binStr(aesKeyBytes);
			var ivArg  = useBuf ? toBuffer(_zeros(16))  : _binStr(_zeros(16));
			var nb = a32ToBytes([nonce[0], nonce[1]]);   // 8-byte nonce
			// ECB ignores the IV, but node builds disagree on its form: modern node wants a NULL
			// iv, the device's 0.4.12 wants a 16-byte one. Detect which this build accepts.
			var ecbIv;
			try { _nc.createCipheriv("aes-128-ecb", keyArg, null); ecbIv = null; }
			catch (eiv) { ecbIv = ivArg; }
			var fin = _fs.openSync(inPath, "r");
			var fout = _fs.openSync(outPath, "w");
			var CHUNK = 65536, buf = new Buffer(CHUNK), blockIndex = 0, n;
			while ((n = _fs.readSync(fin, buf, 0, CHUNK, null)) > 0) {
				var nblocks = Math.floor((n + 15) / 16), ctr = [], b, idx;
				for (b = 0; b < nblocks; b++) {
					idx = blockIndex + b;   // counter = nonce(8) || 0(4) || uint32_be(idx)
					ctr.push(nb[0], nb[1], nb[2], nb[3], nb[4], nb[5], nb[6], nb[7],
						0, 0, 0, 0, (idx >>> 24) & 0xff, (idx >>> 16) & 0xff, (idx >>> 8) & 0xff, idx & 0xff);
				}
				var ecb = _nc.createCipheriv("aes-128-ecb", keyArg, ecbIv);
				if (ecb.setAutoPadding) { ecb.setAutoPadding(false); }
				var data = new Buffer(n), i;
				if (useBuf) {
					var ksB = ecb.update(toBuffer(ctr));
					for (i = 0; i < n; i++) { data[i] = buf[i] ^ ksB[i]; }
				} else {
					var ksS = ecb.update(_binStr(ctr), "binary", "binary");
					for (i = 0; i < n; i++) { data[i] = buf[i] ^ (ksS.charCodeAt(i) & 0xff); }
				}
				_fs.writeSync(fout, data, 0, n);
				blockIndex += nblocks;
			}
			_fs.closeSync(fin); _fs.closeSync(fout);
			cb(null);
		} catch (e) { cb({ errorCode: "CTR_FAILED", detail: String(e && e.message || e) }); }
	}

	// Mega chunk boundaries: the k-th chunk is min(k,8)*128 KB (128,256,...,1024,1024,...).
	function chunkSizes(size) {
		var chunks = [], p = 0, k = 1;
		while (p < size) {
			var sz = Math.min(k, 8) * 131072;
			if (p + sz > size) { sz = size - p; }
			chunks.push([p, sz]); p += sz; k++;
		}
		return chunks;
	}
	// Mega condensed-key meta_mac over the PLAINTEXT at inPath. Per chunk: a CBC-MAC seeded with
	// [n0,n1,n0,n1]; the per-chunk MACs are chained through one ECB block each; meta_mac =
	// [fileMac[0]^fileMac[1], fileMac[2]^fileMac[3]]. cb(err, metaMac[2]).
	function metaMacFile(inPath, aesKeyA32, nonce, cb) {
		if (!_nc || !_fs) { cb({ errorCode: "NO_NODE_CRYPTO" }); return; }
		try {
			// aes-128-cbc IS available on the device, but (like ecb/ctr) it rejects Buffer args -
			// use the string form there. keyArg = 16-byte file key; ivArg = the [n0,n1,n0,n1] seed.
			var useBuf = _detectCipherBuf();
			var keyBytes = a32ToBytes(aesKeyA32.slice(0, 4));
			var ivBytes = a32ToBytes([nonce[0], nonce[1], nonce[0], nonce[1]]);
			var keyArg = useBuf ? toBuffer(keyBytes) : _binStr(keyBytes);
			var ivArg = useBuf ? toBuffer(ivBytes) : _binStr(ivBytes);
			var stat = _fs.statSync(inPath), size = stat.size;
			var fin = _fs.openSync(inPath, "r");
			var fileMac = [0, 0, 0, 0];
			var chunks = chunkSizes(size);
			for (var ci = 0; ci < chunks.length; ci++) {
				var clen = chunks[ci][1];
				var data = new Buffer(clen);
				var got = 0;
				while (got < clen) {
					var r = _fs.readSync(fin, data, got, clen - got, null);
					if (r <= 0) { break; }
					got += r;
				}
				// zero-pad the final partial 16-byte block
				var padded = data;
				if (got % 16 !== 0) {
					padded = new Buffer(got + (16 - (got % 16)));
					data.copy(padded, 0, 0, got);
					for (var z = got; z < padded.length; z++) { padded[z] = 0; }
				} else if (got !== clen) {
					padded = data.slice(0, got);
				}
				var mac = _nc.createCipheriv("aes-128-cbc", keyArg, ivArg);
				if (mac.setAutoPadding) { mac.setAutoPadding(false); }
				// chunkMac = last 16 bytes of the CBC output (no padding -> update returns all blocks)
				var chunkMac;
				if (useBuf) {
					var enc = mac.update(padded);
					chunkMac = bytesToA32([].slice.call(enc.slice(enc.length - 16)));
				} else {
					var encS = mac.update(padded.toString("binary"), "binary", "binary");
					chunkMac = bytesToA32(_binToBytes(encS.substr(encS.length - 16)));
				}
				fileMac = ecbEncryptA32(aesKeyA32, [
					(fileMac[0] ^ chunkMac[0]) >>> 0, (fileMac[1] ^ chunkMac[1]) >>> 0,
					(fileMac[2] ^ chunkMac[2]) >>> 0, (fileMac[3] ^ chunkMac[3]) >>> 0
				]);
			}
			_fs.closeSync(fin);
			cb(null, [(fileMac[0] ^ fileMac[1]) >>> 0, (fileMac[2] ^ fileMac[3]) >>> 0]);
		} catch (e) { cb({ errorCode: "MAC_FAILED", detail: String(e && e.message || e) }); }
	}

	return {
		ctrFile: ctrFile, metaMacFile: metaMacFile, chunkSizes: chunkSizes,
		strToA32: strToA32, a32ToStr: a32ToStr, bytesToA32: bytesToA32, a32ToBytes: a32ToBytes,
		bytesToB64: bytesToB64, b64ToBytes: b64ToBytes, a32ToB64: a32ToB64, b64ToA32: b64ToA32,
		ecbEncryptA32: ecbEncryptA32, ecbDecryptA32: ecbDecryptA32,
		prepareKey: prepareKey, stringHash: stringHash,
		sha512: sha512, hmacSha512: hmacSha512, pbkdf2Sha512: pbkdf2Sha512,
		parsePrivKey: parsePrivKey, rsaDecryptSid: rsaDecryptSid,
		decryptAttr: decryptAttr, encryptAttr: encryptAttr,
		unwrapNodeKey: unwrapNodeKey, unpackFileKey: unpackFileKey, packFileKey: packFileKey,
		toBuffer: toBuffer, ivFromNonce: ivFromNonce,
		hasNodeCrypto: !!_nc, _nc: _nc, _fs: _fs, BigInteger: _BigInteger
	};
})();

if (typeof exports !== "undefined") { exports.MegaCrypto = MegaCrypto; }
