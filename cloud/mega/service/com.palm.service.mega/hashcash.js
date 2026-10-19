/* hashcash.js - the proof of work MEGA's API can ask for before it answers.
 *
 * MEGA answers a request (seen for the `us` login command) with HTTP 402 and a header
 *
 *   X-Hashcash: 1:<easiness>:<timestamp>:<token>
 *
 * and expects the same request again, under the same id, with
 *
 *   X-Hashcash: 1:<token>:<prefix>
 *
 * where <prefix> is 4 bytes such that SHA-256(prefix || token x 262144) starts with a big-endian
 * uint32 no larger than the threshold the easiness encodes. Token and prefix are MEGA base64; the
 * token decodes to 48 bytes. This is megajs 1.3.10's generateHashcashToken, which also counts the
 * prefix up little-endian from zero, so both find the same answer.
 *
 * Each try hashes 12 MiB. The hashing is WebCrypto's (crypto.subtle.digest), which runs on
 * libuv's thread pool: the event loop only waits for it, so other requests and the method's own
 * deadline keep running. The search gives up after maxMs (90 s, inside the login's 120 s).
 *
 *   await solve(challenge, { digest, now, maxMs })  -> "1:<token>:<prefix>", or MEGA_HASHCASH
 */
"use strict";

const { webcrypto } = require("node:crypto");

const COPIES = 262144;
const MAX_MS = 90000;
const YIELD_EVERY = 8;   // a macrotask turn now and then, even for a digest that settles at once

// (easiness) -> the largest acceptable first word. At most 127 << 24, so JavaScript's signed <<
// does not wrap it.
function threshold(easiness) {
	const base = ((easiness & 63) << 1) + 1;
	const shifts = (easiness >> 6) * 7 + 3;
	return (base << shifts) >>> 0;
}

// "1:<easiness>:<timestamp>:<token>" -> { easiness, tokenStr, token } or null.
function parse(challenge) {
	const parts = String(challenge || "").split(":");
	if (parts.length !== 4 || parts[0] !== "1") { return null; }
	const easiness = Number(parts[1]);
	if (!Number.isInteger(easiness) || easiness < 0 || easiness > 255 || parts[1] === "") { return null; }
	const token = Buffer.from(parts[3], "base64");
	if (token.length !== 48) { return null; }
	return { easiness, tokenStr: parts[3], token };
}

// An error the core replies as { errorCode: "MEGA_HASHCASH", errorText } (errors.js toReply takes
// any object with an errorCode), without this file needing to find _cloudcore.
function failed(text) { return Object.assign(new Error(text), { errorCode: "MEGA_HASHCASH", errorText: text }); }

const sha256 = async (buf) => Buffer.from(await webcrypto.subtle.digest("SHA-256", buf));

async function solve(challenge, { digest = sha256, now = Date.now, maxMs = MAX_MS } = {}) {
	const c = parse(challenge);
	if (!c) { throw failed("unrecognised hashcash challenge"); }
	const limit = threshold(c.easiness);
	const buf = Buffer.alloc(4 + COPIES * 48);
	for (let i = 0; i < COPIES; i++) { c.token.copy(buf, 4 + i * 48); }
	const started = now();
	for (let tries = 1; ; tries++) {
		const h = await digest(buf);
		if (h.readUInt32BE(0) <= limit) {
			return "1:" + c.tokenStr + ":" + buf.subarray(0, 4).toString("base64url");
		}
		let j = 0;
		for (; j < 4; j++) { buf[j] = (buf[j] + 1) & 0xff; if (buf[j]) { break; } }
		if (j === 4) { throw failed("no hashcash prefix found"); }
		if (now() - started > maxMs) { throw failed("hashcash gave up after " + maxMs + " ms"); }
		if (tries % YIELD_EVERY === 0) { await new Promise((r) => setImmediate(r)); }
	}
}

module.exports = { solve, threshold, parse, COPIES, MAX_MS };
