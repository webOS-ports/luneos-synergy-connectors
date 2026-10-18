/* bignum.js - a trimmed jsbn BigInteger (Tom Wu, BSD).
 *
 * WHY vendored: the Mega login handshake RSA-decrypts the session-id challenge (csid) with the
 * account's private key, i.e. one modular exponentiation m = c^d mod n on ~2048-bit integers.
 * The device node is OpenSSL-0.9.8k-era and has NO crypto.privateDecrypt and NO BigInt, so the
 * bignum math must be pure JS. This runs exactly ONCE per sign-in.
 *
 * Source: jsbn.js / jsbn2.js by Tom Wu (http://www-cs-students.stanford.edu/~tjw/jsbn/),
 * BSD-licensed. Reduced to the pieces this connector needs: construction from a hex string,
 * modPow (Barrett/Montgomery reduction, as upstream), multiply/divide, toString(16) and
 * fromRadix. Kept byte-for-byte faithful to upstream algorithms so behaviour is well understood.
 */
(function () {
	// Bits per digit. jsbn auto-detects; 28 is safe everywhere (incl. old V8).
	var dbits = 28;
	var BI_FP = 52;

	function BigInteger(a, b) {
		if (a != null) {
			if (typeof a === "number") { this.fromNumber(a, b); }
			else if (b == null && typeof a !== "string") { this.fromString(a, 256); }
			else { this.fromString(a, b); }
		}
	}
	function nbi() { return new BigInteger(null); }

	var proto = BigInteger.prototype;

	proto.am = function (i, x, w, j, c, n) {
		var xl = x & 0x3fff, xh = x >> 14;
		while (--n >= 0) {
			var l = this[i] & 0x3fff;
			var h = this[i++] >> 14;
			var m = xh * l + h * xl;
			l = xl * l + ((m & 0x3fff) << 14) + w[j] + c;
			c = (l >> 28) + (m >> 14) + xh * h;
			w[j++] = l & 0xfffffff;
		}
		return c;
	};
	var DB = dbits;
	var DM = (1 << dbits) - 1;
	var DV = 1 << dbits;
	var FV = Math.pow(2, BI_FP);
	var F1 = BI_FP - dbits;
	var F2 = 2 * dbits - BI_FP;

	var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
	var BI_RC = [];
	var rr, vv;
	rr = "0".charCodeAt(0);
	for (vv = 0; vv <= 9; ++vv) { BI_RC[rr++] = vv; }
	rr = "a".charCodeAt(0);
	for (vv = 10; vv < 36; ++vv) { BI_RC[rr++] = vv; }
	rr = "A".charCodeAt(0);
	for (vv = 10; vv < 36; ++vv) { BI_RC[rr++] = vv; }

	function int2char(n) { return BI_RM.charAt(n); }
	function intAt(s, i) {
		var c = BI_RC[s.charCodeAt(i)];
		return (c == null) ? -1 : c;
	}

	proto.copyTo = function (r) {
		for (var i = this.t - 1; i >= 0; --i) { r[i] = this[i]; }
		r.t = this.t; r.s = this.s;
	};
	proto.fromInt = function (x) {
		this.t = 1; this.s = (x < 0) ? -1 : 0;
		if (x > 0) { this[0] = x; }
		else if (x < -1) { this[0] = x + DV; }
		else { this.t = 0; }
	};
	proto.fromString = function (s, b) {
		var k;
		if (b === 16) { k = 4; }
		else if (b === 8) { k = 3; }
		else if (b === 256) { k = 8; }
		else if (b === 2) { k = 1; }
		else if (b === 32) { k = 5; }
		else if (b === 4) { k = 2; }
		else { this.fromRadix(s, b); return; }
		this.t = 0; this.s = 0;
		var i = s.length, mi = false, sh = 0;
		while (--i >= 0) {
			var x = (k === 8) ? (s[i] & 0xff) : intAt(s, i);
			if (x < 0) {
				if (s.charAt(i) === "-") { mi = true; }
				continue;
			}
			mi = false;
			if (sh === 0) { this[this.t++] = x; }
			else if (sh + k > DB) {
				this[this.t - 1] |= (x & ((1 << (DB - sh)) - 1)) << sh;
				this[this.t++] = (x >> (DB - sh));
			} else {
				this[this.t - 1] |= x << sh;
			}
			sh += k;
			if (sh >= DB) { sh -= DB; }
		}
		if (k === 8 && (s[0] & 0x80) !== 0) {
			this.s = -1;
			if (sh > 0) { this[this.t - 1] |= ((1 << (DB - sh)) - 1) << sh; }
		}
		this.clamp();
		if (mi) { BigInteger.ZERO.subTo(this, this); }
	};
	proto.clamp = function () {
		var c = this.s & DM;
		while (this.t > 0 && this[this.t - 1] === c) { --this.t; }
	};
	proto.dlShiftTo = function (n, r) {
		var i;
		for (i = this.t - 1; i >= 0; --i) { r[i + n] = this[i]; }
		for (i = n - 1; i >= 0; --i) { r[i] = 0; }
		r.t = this.t + n; r.s = this.s;
	};
	proto.drShiftTo = function (n, r) {
		for (var i = n; i < this.t; ++i) { r[i - n] = this[i]; }
		r.t = Math.max(this.t - n, 0); r.s = this.s;
	};
	proto.lShiftTo = function (n, r) {
		var bs = n % DB, cbs = DB - bs, bm = (1 << cbs) - 1;
		var ds = Math.floor(n / DB), c = (this.s << bs) & DM, i;
		for (i = this.t - 1; i >= 0; --i) {
			r[i + ds + 1] = (this[i] >> cbs) | c;
			c = (this[i] & bm) << bs;
		}
		for (i = ds - 1; i >= 0; --i) { r[i] = 0; }
		r[ds] = c; r.t = this.t + ds + 1; r.s = this.s; r.clamp();
	};
	proto.rShiftTo = function (n, r) {
		r.s = this.s;
		var ds = Math.floor(n / DB);
		if (ds >= this.t) { r.t = 0; return; }
		var bs = n % DB, cbs = DB - bs, bm = (1 << bs) - 1;
		r[0] = this[ds] >> bs;
		for (var i = ds + 1; i < this.t; ++i) {
			r[i - ds - 1] |= (this[i] & bm) << cbs;
			r[i - ds] = this[i] >> bs;
		}
		if (bs > 0) { r[this.t - ds - 1] |= (this.s & bm) << cbs; }
		r.t = this.t - ds; r.clamp();
	};
	proto.subTo = function (a, r) {
		var i = 0, c = 0, m = Math.min(a.t, this.t);
		while (i < m) {
			c += this[i] - a[i];
			r[i++] = c & DM; c >>= DB;
		}
		if (a.t < this.t) {
			c -= a.s;
			while (i < this.t) { c += this[i]; r[i++] = c & DM; c >>= DB; }
			c += this.s;
		} else {
			c += this.s;
			while (i < a.t) { c -= a[i]; r[i++] = c & DM; c >>= DB; }
			c -= a.s;
		}
		r.s = (c < 0) ? -1 : 0;
		if (c < -1) { r[i++] = DV + c; }
		else if (c > 0) { r[i++] = c; }
		r.t = i; r.clamp();
	};
	proto.multiplyTo = function (a, r) {
		var x = this.abs(), y = a.abs(), i = x.t;
		r.t = i + y.t;
		while (--i >= 0) { r[i] = 0; }
		for (i = 0; i < y.t; ++i) { r[i + x.t] = x.am(0, y[i], r, i, 0, x.t); }
		r.s = 0; r.clamp();
		if (this.s !== a.s) { BigInteger.ZERO.subTo(r, r); }
	};
	proto.squareTo = function (r) {
		var x = this.abs(), i = r.t = 2 * x.t;
		while (--i >= 0) { r[i] = 0; }
		for (i = 0; i < x.t - 1; ++i) {
			var c = x.am(i, x[i], r, 2 * i, 0, 1);
			if ((r[i + x.t] += x.am(i + 1, 2 * x[i], r, 2 * i + 1, c, x.t - i - 1)) >= DV) {
				r[i + x.t] -= DV; r[i + x.t + 1] = 1;
			}
		}
		if (r.t > 0) { r[r.t - 1] += x.am(i, x[i], r, 2 * i, 0, 1); }
		r.s = 0; r.clamp();
	};
	proto.divRemTo = function (m, q, r) {
		var pm = m.abs();
		if (pm.t <= 0) { return; }
		var pt = this.abs();
		if (pt.t < pm.t) {
			if (q != null) { q.fromInt(0); }
			if (r != null) { this.copyTo(r); }
			return;
		}
		if (r == null) { r = nbi(); }
		var y = nbi(), ts = this.s, ms = m.s;
		var nsh = DB - nbits(pm[pm.t - 1]);
		if (nsh > 0) { pm.lShiftTo(nsh, y); pt.lShiftTo(nsh, r); }
		else { pm.copyTo(y); pt.copyTo(r); }
		var ys = y.t;
		var y0 = y[ys - 1];
		if (y0 === 0) { return; }
		var yt = y0 * (1 << F1) + ((ys > 1) ? y[ys - 2] >> F2 : 0);
		var d1 = FV / yt, d2 = (1 << F1) / yt, e = 1 << F2;
		var i = r.t, j = i - ys, t = (q == null) ? nbi() : q;
		y.dlShiftTo(j, t);
		if (r.compareTo(t) >= 0) { r[r.t++] = 1; r.subTo(t, r); }
		BigInteger.ONE.dlShiftTo(ys, t);
		t.subTo(y, y);
		while (y.t < ys) { y[y.t++] = 0; }
		while (--j >= 0) {
			var qd = (r[--i] === y0) ? DM : Math.floor(r[i] * d1 + (r[i - 1] + e) * d2);
			if ((r[i] += y.am(0, qd, r, j, 0, ys)) < qd) {
				y.dlShiftTo(j, t);
				r.subTo(t, r);
				while (r[i] < --qd) { r.subTo(t, r); }
			}
		}
		if (q != null) {
			r.drShiftTo(ys, q);
			if (ts !== ms) { BigInteger.ZERO.subTo(q, q); }
		}
		r.t = ys; r.clamp();
		if (nsh > 0) { r.rShiftTo(nsh, r); }
		if (ts < 0) { BigInteger.ZERO.subTo(r, r); }
	};
	proto.invDigit = function () {
		if (this.t < 1) { return 0; }
		var x = this[0];
		if ((x & 1) === 0) { return 0; }
		var y = x & 3;
		y = (y * (2 - (x & 0xf) * y)) & 0xf;
		y = (y * (2 - (x & 0xff) * y)) & 0xff;
		y = (y * (2 - (((x & 0xffff) * y) & 0xffff))) & 0xffff;
		y = (y * (2 - x * y % DV)) % DV;
		return (y > 0) ? DV - y : -y;
	};
	proto.isEven = function () { return ((this.t > 0) ? (this[0] & 1) : this.s) === 0; };
	proto.exp = function (e, z) {
		if (e > 0xffffffff || e < 1) { return BigInteger.ONE; }
		var r = nbi(), r2 = nbi(), g = z.convert(this), i = nbits(e) - 1;
		g.copyTo(r);
		while (--i >= 0) {
			z.sqrTo(r, r2);
			if ((e & (1 << i)) > 0) { z.mulTo(r2, g, r); }
			else { var t = r; r = r2; r2 = t; }
		}
		return z.revert(r);
	};
	proto.modPow = function (e, m) {
		var i = e.bitLength(), k, r = nbiv(1), z;
		if (i <= 0) { return r; }
		else if (i < 18) { k = 1; }
		else if (i < 48) { k = 3; }
		else if (i < 144) { k = 4; }
		else if (i < 768) { k = 5; }
		else { k = 6; }
		if (i < 8) { z = new Classic(m); }
		else if (m.isEven()) { z = new Barrett(m); }
		else { z = new Montgomery(m); }
		var g = [], n = 3, k1 = k - 1, km = (1 << k) - 1;
		g[1] = z.convert(this);
		if (k > 1) {
			var g2 = nbi();
			z.sqrTo(g[1], g2);
			while (n <= km) { g[n] = nbi(); z.mulTo(g2, g[n - 2], g[n]); n += 2; }
		}
		var j = e.t - 1, w, is1 = true, r2 = nbi(), t;
		i = nbits(e[j]) - 1;
		while (j >= 0) {
			if (i >= k1) { w = (e[j] >> (i - k1)) & km; }
			else {
				w = (e[j] & ((1 << (i + 1)) - 1)) << (k1 - i);
				if (j > 0) { w |= e[j - 1] >> (DB + i - k1); }
			}
			n = k;
			while ((w & 1) === 0) { w >>= 1; --n; }
			if ((i -= n) < 0) { i += DB; --j; }
			if (is1) { g[w].copyTo(r); is1 = false; }
			else {
				while (n > 1) { z.sqrTo(r, r2); z.sqrTo(r2, r); n -= 2; }
				if (n > 0) { z.sqrTo(r, r2); } else { t = r; r = r2; r2 = t; }
				z.mulTo(r2, g[w], r);
			}
			while (j >= 0 && (e[j] & (1 << i)) === 0) {
				z.sqrTo(r, r2); t = r; r = r2; r2 = t;
				if (--i < 0) { i = DB - 1; --j; }
			}
		}
		return z.revert(r);
	};
	proto.abs = function () { return (this.s < 0) ? this.negate() : this; };
	proto.negate = function () { var r = nbi(); BigInteger.ZERO.subTo(this, r); return r; };
	proto.compareTo = function (a) {
		var r = this.s - a.s;
		if (r !== 0) { return r; }
		var i = this.t;
		r = i - a.t;
		if (r !== 0) { return (this.s < 0) ? -r : r; }
		while (--i >= 0) { if ((r = this[i] - a[i]) !== 0) { return r; } }
		return 0;
	};
	proto.bitLength = function () {
		if (this.t <= 0) { return 0; }
		return DB * (this.t - 1) + nbits(this[this.t - 1] ^ (this.s & DM));
	};
	proto.mod = function (a) {
		var r = nbi();
		this.abs().divRemTo(a, null, r);
		if (this.s < 0 && r.compareTo(BigInteger.ZERO) > 0) { a.subTo(r, r); }
		return r;
	};
	proto.equals = function (a) { return this.compareTo(a) === 0; };
	proto.toString = function (b) {
		if (this.s < 0) { return "-" + this.negate().toString(b); }
		var k;
		if (b === 16) { k = 4; }
		else if (b === 8) { k = 3; }
		else if (b === 2) { k = 1; }
		else if (b === 32) { k = 5; }
		else if (b === 4) { k = 2; }
		else { return this.toRadix(b); }
		var km = (1 << k) - 1, d, m = false, r = "", i = this.t;
		var p = DB - (i * DB) % k;
		if (i-- > 0) {
			if (p < DB && (d = this[i] >> p) > 0) { m = true; r = int2char(d); }
			while (i >= 0) {
				if (p < k) { d = (this[i] & ((1 << p) - 1)) << (k - p); d |= this[--i] >> (p += DB - k); }
				else { d = (this[i] >> (p -= k)) & km; if (p <= 0) { p += DB; --i; } }
				if (d > 0) { m = true; }
				if (m) { r += int2char(d); }
			}
		}
		return m ? r : "0";
	};
	proto.toByteArray = function () {
		var i = this.t, r = [];
		r[0] = this.s;
		var p = DB - (i * DB) % 8, d, k = 0;
		if (i-- > 0) {
			if (p < DB && (d = this[i] >> p) !== (this.s & DM) >> p) { r[k++] = d | (this.s << (DB - p)); }
			while (i >= 0) {
				if (p < 8) { d = (this[i] & ((1 << p) - 1)) << (8 - p); d |= this[--i] >> (p += DB - 8); }
				else { d = (this[i] >> (p -= 8)) & 0xff; if (p <= 0) { p += DB; --i; } }
				if ((d & 0x80) !== 0) { d |= -256; }
				if (k === 0 && (this.s & 0x80) !== (d & 0x80)) { ++k; }
				if (k > 0 || d !== this.s) { r[k++] = d; }
			}
		}
		return r;
	};
	proto.fromRadix = function (s, b) {
		this.fromInt(0);
		var cs = Math.floor(Math.log(b) / Math.log(2) * 0.5);
		var d = Math.pow(b, cs), mi = false, j = 0, w = 0;
		for (var i = 0; i < s.length; ++i) {
			var x = intAt(s, i);
			if (x < 0) { if (s.charAt(i) === "-" && this.signum() === 0) { mi = true; } continue; }
			w = b * w + x;
			if (++j >= cs) { this.dMultiply(d); this.dAddOffset(w, 0); j = 0; w = 0; }
		}
		if (j > 0) { this.dMultiply(Math.pow(b, j)); this.dAddOffset(w, 0); }
		if (mi) { BigInteger.ZERO.subTo(this, this); }
	};
	proto.fromNumber = function (a) { this.fromInt(a); };
	proto.signum = function () {
		if (this.s < 0) { return -1; }
		if (this.t <= 0 || (this.t === 1 && this[0] <= 0)) { return 0; }
		return 1;
	};
	proto.dMultiply = function (n) { this[this.t] = this.am(0, n - 1, this, 0, 0, this.t); ++this.t; this.clamp(); };
	proto.dAddOffset = function (n, w) {
		if (n === 0) { return; }
		while (this.t <= w) { this[this.t++] = 0; }
		this[w] += n;
		while (this[w] >= DV) { this[w] -= DV; if (++w >= this.t) { this[this.t++] = 0; } ++this[w]; }
	};
	proto.toRadix = function (b) {
		b = b || 10;
		if (this.signum() === 0) { return "0"; }
		var cs = Math.floor(Math.log(b) / Math.log(2) * 0.5);
		var a = Math.pow(b, cs), d = nbv(a), y = nbi(), z = nbi(), r = "";
		this.divRemTo(d, y, z);
		while (y.signum() > 0) {
			r = (a + z.intValue()).toString(b).substr(1) + r;
			y.divRemTo(d, y, z);
		}
		return z.intValue().toString(b) + r;
	};
	proto.intValue = function () {
		if (this.s < 0) {
			if (this.t === 1) { return this[0] - DV; }
			else if (this.t === 0) { return -1; }
		} else if (this.t === 1) { return this[0]; }
		else if (this.t === 0) { return 0; }
		return ((this[1] & ((1 << (32 - DB)) - 1)) << DB) | this[0];
	};

	function nbits(x) {
		var r = 1, t;
		if ((t = x >>> 16) !== 0) { x = t; r += 16; }
		if ((t = x >> 8) !== 0) { x = t; r += 8; }
		if ((t = x >> 4) !== 0) { x = t; r += 4; }
		if ((t = x >> 2) !== 0) { x = t; r += 2; }
		if ((t = x >> 1) !== 0) { x = t; r += 1; }
		return r;
	}
	function nbv(i) { var r = nbi(); r.fromInt(i); return r; }
	function nbiv(i) { var r = nbi(); r.fromInt(i); return r; }

	// Reduction contexts (Classic / Montgomery / Barrett), verbatim from jsbn.
	function Classic(m) { this.m = m; }
	Classic.prototype.convert = function (x) { return (x.s < 0 || x.compareTo(this.m) >= 0) ? x.mod(this.m) : x; };
	Classic.prototype.revert = function (x) { return x; };
	Classic.prototype.reduce = function (x) { x.divRemTo(this.m, null, x); };
	Classic.prototype.mulTo = function (x, y, r) { x.multiplyTo(y, r); this.reduce(r); };
	Classic.prototype.sqrTo = function (x, r) { x.squareTo(r); this.reduce(r); };

	function Montgomery(m) {
		this.m = m;
		this.mp = m.invDigit();
		this.mpl = this.mp & 0x7fff;
		this.mph = this.mp >> 15;
		this.um = (1 << (DB - 15)) - 1;
		this.mt2 = 2 * m.t;
	}
	Montgomery.prototype.convert = function (x) {
		var r = nbi();
		x.abs().dlShiftTo(this.m.t, r);
		r.divRemTo(this.m, null, r);
		if (x.s < 0 && r.compareTo(BigInteger.ZERO) > 0) { this.m.subTo(r, r); }
		return r;
	};
	Montgomery.prototype.revert = function (x) {
		var r = nbi(); x.copyTo(r); this.reduce(r); return r;
	};
	Montgomery.prototype.reduce = function (x) {
		while (x.t <= this.mt2) { x[x.t++] = 0; }
		for (var i = 0; i < this.m.t; ++i) {
			var j = x[i] & 0x7fff;
			var u0 = (j * this.mpl + (((j * this.mph + (x[i] >> 15) * this.mpl) & this.um) << 15)) & DM;
			j = i + this.m.t;
			x[j] += this.m.am(0, u0, x, i, 0, this.m.t);
			while (x[j] >= DV) { x[j] -= DV; x[++j]++; }
		}
		x.clamp();
		x.drShiftTo(this.m.t, x);
		if (x.compareTo(this.m) >= 0) { x.subTo(this.m, x); }
	};
	Montgomery.prototype.mulTo = function (x, y, r) { x.multiplyTo(y, r); this.reduce(r); };
	Montgomery.prototype.sqrTo = function (x, r) { x.squareTo(r); this.reduce(r); };

	// Barrett is only selected by modPow for an EVEN modulus. RSA here always has an ODD
	// modulus (n = p*q, p/q prime) so Montgomery is used and this path is never taken. Rather
	// than ship a subtle hand-rolled Barrett, delegate to correct (if slower) classic reduction
	// so an even-modulus modPow would still be correct.
	function Barrett(m) { this.m = m; }
	Barrett.prototype.convert = function (x) { return (x.s < 0 || x.compareTo(this.m) >= 0) ? x.mod(this.m) : x; };
	Barrett.prototype.revert = function (x) { return x; };
	Barrett.prototype.reduce = function (x) { x.divRemTo(this.m, null, x); };
	Barrett.prototype.mulTo = function (x, y, r) { x.multiplyTo(y, r); this.reduce(r); };
	Barrett.prototype.sqrTo = function (x, r) { x.squareTo(r); this.reduce(r); };

	proto.divide = function (a) { var q = nbi(); this.abs().divRemTo(a, q, null); return q; };
	proto.multiply = function (a) { var r = nbi(); this.multiplyTo(a, r); return r; };

	BigInteger.ZERO = nbv(0);
	BigInteger.ONE = nbv(1);

	if (typeof exports !== "undefined") { exports.BigInteger = BigInteger; }
	if (typeof IMPORTS === "undefined" && typeof window === "undefined" && typeof global !== "undefined") { global.BigInteger = BigInteger; }
	// webOS service global (no module system there).
	this.BigInteger = BigInteger;
}).call(typeof global !== "undefined" ? global : this);
