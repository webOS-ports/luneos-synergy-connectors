/*global IMPORTS, require, setTimeout */
/* hashcash.js - the proof of work Mega's API can ask for before it answers.
 *
 * Mega answers a request (seen for the `us` login command) with HTTP 402 and a header
 *
 *   X-Hashcash: 1:<easiness>:<timestamp>:<token>
 *
 * and expects the request again with
 *
 *   X-Hashcash: 1:<token>:<prefix>
 *
 * where <prefix> is 4 bytes such that SHA-256(prefix || token x 262144) starts with a big-endian
 * uint32 no larger than the threshold the easiness encodes. Token and prefix are Mega base64
 * (URL-safe, unpadded); the token decodes to 48 bytes. This is megajs 1.3.10's
 * generateHashcashToken. The threshold is at most 127 << 24, so JavaScript's signed << cannot
 * wrap it; >>> 0 only makes it the unsigned number readUInt32BE is compared with.
 *
 * Each try hashes 12 MiB (~25 ms with node's OpenSSL SHA-256 on a MindPhone; easiness 192 needs
 * ~256 tries on average). Tries run in batches with the event loop let through in between, and
 * the search gives up after MAX_MS.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var MegaHashcash = (function () {
	var reqf = (typeof require !== "undefined") ? require : (IMPORTS.require || null);
	var crypto = reqf ? reqf("crypto") : null;

	var COPIES = 262144;
	var BATCH = 8;          // tries between yields (~200 ms on the phone)
	var MAX_MS = 90000;     // inside the login command's 120 s

	function threshold(easiness) {
		var base = ((easiness & 63) << 1) + 1;
		var shifts = (easiness >> 6) * 7 + 3;
		return (base << shifts) >>> 0;
	}

	// "1:<easiness>:<timestamp>:<token>" -> { easiness, tokenStr, token(Buffer) } or null.
	function parse(challenge) {
		var parts = String(challenge || "").split(":");
		if (parts.length !== 4 || parts[0] !== "1") { return null; }
		var easiness = Number(parts[1]);
		if (!(easiness >= 0 && easiness <= 255 && Math.floor(easiness) === easiness)) { return null; }
		var token = Buffer.from(parts[3], "base64");   // node's base64 also takes the URL-safe alphabet
		if (token.length !== 48) { return null; }
		return { easiness: easiness, tokenStr: parts[3], token: token };
	}

	function e64(buf) {
		return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
	}

	// The 4-byte prefix counts up little-endian from zero, as megajs's does.
	function increment(buf) {
		for (var j = 0; j < 4; j++) {
			buf[j] = (buf[j] + 1) & 0xff;
			if (buf[j]) { return true; }
		}
		return false;   // wrapped: every prefix tried
	}

	// Future resolving to the X-Hashcash value to send back, or failing with MEGA_HASHCASH.
	// opts.now / opts.later / opts.hash replace Date.now, setTimeout and SHA-256 in tests.
	function solve(challenge, opts) {
		opts = opts || {};
		var f = new Future();
		var c = parse(challenge);
		var fail = function (why) {
			f.setException({ returnValue: false, errorCode: "MEGA_HASHCASH", detail: why });
		};
		if (!c) { fail("unrecognised challenge"); return f; }
		var hash = opts.hash || (crypto && function (b) { return crypto.createHash("sha256").update(b).digest(); });
		if (!hash) { fail("no crypto module"); return f; }
		var now = opts.now || Date.now;
		var later = opts.later || function (fn) { setTimeout(fn, 0); };

		var limit = threshold(c.easiness);
		var buf = Buffer.alloc(4 + COPIES * 48);
		for (var i = 0; i < COPIES; i++) { c.token.copy(buf, 4 + i * 48); }
		var started = now();

		function batch() {
			for (var n = 0; n < BATCH; n++) {
				if (hash(buf).readUInt32BE(0) <= limit) {
					f.result = "1:" + c.tokenStr + ":" + e64(buf.slice(0, 4));
					return;
				}
				if (!increment(buf)) { fail("no prefix found"); return; }
			}
			if (now() - started > MAX_MS) { fail("gave up after " + MAX_MS + " ms"); return; }
			later(batch);
		}
		batch();
		return f;
	}

	return { solve: solve, threshold: threshold, parse: parse };
}());

if (typeof exports !== "undefined") { exports.MegaHashcash = MegaHashcash; }
