/* megaapi.js - MEGA's "cs" API: the command requests, the login handshake, the node tree.
 *
 *   const api = createApi({ config, http, errors });
 *   await api.cmd({ a: "ug" }, sid)              -> the command's result
 *   await api.login(email, password, mfa)        -> { accessToken (the sid), mk, email, u }
 *   await api.fetchTree(creds)                   -> { nodes, byHandle, rootHandle, rubbishHandle, .. }
 *
 * A request POSTs a JSON array of commands to Config.API_BASE?id=<n>[&sid=<session>] and reads
 * back a JSON array of results, or a bare negative number for an error of the whole request.
 * A negative number in the array is that command's error. Both become MEGA_<name> errors
 * (ERR below: the names of MEGA's SDK, megaapi.h API_E*, and megajs's ERRORS table).
 *
 *   EAGAIN (-3), bare or as the command's result: sent again, under a new id, after 0.5, 1,
 *     1.5 and 2 s (timing.retryMs); then it is MEGA_EAGAIN.
 *   HTTP 402 with X-Hashcash: the proof of work (hashcash.js), then the same request again under
 *     the same id with the answer; up to four rounds, then MEGA_EHTTP_402.
 *   Another HTTP status outside 2xx: MEGA_EHTTP_<status>, with status. A reply that is not JSON:
 *     MEGA_EPARSE. No reply: the core's CURL_FAILED.
 *
 * LOGIN: us0 says the account version (v1: AES prepare_key; v2: PBKDF2-SHA512 with the salt it
 * gives), megacrypto.deriveLogin makes the password key and the login hash, us answers the master
 * key (under the password key), the RSA private key (under the master key) and the session id
 * challenge (under the RSA key). Only the session id and the master key are kept; the password
 * goes no further than deriveLogin.
 */
"use strict";

const crypto = require("node:crypto");
const MC = require("./megacrypto.js");
const hashcash = require("./hashcash.js");

const ERR = {
	"-1": "EINTERNAL", "-2": "EARGS", "-3": "EAGAIN", "-4": "ERATELIMIT", "-5": "EFAILED",
	"-6": "ETOOMANY", "-7": "ERANGE", "-8": "EEXPIRED", "-9": "ENOENT", "-10": "ECIRCULAR",
	"-11": "EACCESS", "-12": "EEXIST", "-13": "EINCOMPLETE", "-14": "EKEY", "-15": "ESID",
	"-16": "EBLOCKED", "-17": "EOVERQUOTA", "-18": "ETEMPUNAVAIL", "-19": "ETOOMANYCONNECTIONS",
	"-24": "EGOINGOVERQUOTA", "-25": "EROLLEDBACK", "-26": "EMFAREQUIRED", "-27": "EMASTERONLY",
	"-28": "EBUSINESSPASTDUE", "-29": "EPAYWALL", "-400": "ETOOERR", "-401": "ESHAREROVERQUOTA",
};

// What the errorText says for the ones a user may meet.
const ERR_TEXT = {
	"-2": "invalid arguments", "-3": "the server is busy, try again", "-4": "too many requests, wait a little",
	"-9": "not found", "-10": "that would put a folder inside itself", "-11": "access denied",
	"-12": "the name is taken", "-14": "the item cannot be decrypted", "-15": "the session has expired, sign in again",
	"-16": "the account is blocked", "-17": "the account is over its storage quota",
	"-18": "temporarily unavailable, try again later", "-26": "a two-factor code is needed",
};

// Retries, the proof of work's limits. Tests shorten retryMs.
const timing = { retryMs: 500, retries: 4, hashcashRounds: 4, hashcashMaxMs: hashcash.MAX_MS };

function createApi({ config, http, errors }) {
	const { CloudError } = errors;
	let seq = crypto.randomInt(1e9, 2e9);   // the ?id= counter, as megajs (random start, +1 per request)

	function apiError(code, ctx) {
		const name = ERR[String(code)] || ("E" + code);
		return new CloudError("MEGA_" + name, "MEGA " + ctx + ": " + name + " (" + code + ")" +
			(ERR_TEXT[String(code)] ? ", " + ERR_TEXT[String(code)] : ""), { megaCode: code, detail: ctx });
	}

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	// One POST of `commands`. -> the parsed reply. Never logs the URL with its sid: the core's
	// errors carry only the origin and path.
	async function send(commands, sid, id, answer) {
		const headers = { "Content-Type": "application/json" };
		if (answer) { headers["X-Hashcash"] = answer; }
		let r;
		try {
			r = await http.request({ method: "POST", url: config.API_BASE + "?id=" + id + (sid ? "&sid=" + encodeURIComponent(sid) : ""),
				headers, body: JSON.stringify(commands), accept: [402] });
		} catch (e) {
			if (e && typeof e.status === "number") {
				throw new CloudError("MEGA_EHTTP_" + e.status, "MEGA answered HTTP " + e.status, { status: e.status });
			}
			throw e;
		}
		if (r.status === 402) { return { challenge: r.headers.get("x-hashcash") || "" }; }
		try { return { reply: JSON.parse(r.text) }; }
		catch (e) { throw new CloudError("MEGA_EPARSE", "MEGA's reply to " + label(commands) + " is not JSON"); }
	}

	const label = (commands) => commands.map((c) => c && c.a).join(",");

	// -> the reply array (or a non-negative number); throws MEGA_<name> for a request error.
	async function post(commands, sid) {
		let id = seq++, answer = null, rounds = 0, again = 0;
		for (;;) {
			const r = await send(commands, sid, id, answer);
			if (r.challenge !== undefined) {
				if (!r.challenge || rounds >= timing.hashcashRounds) {
					throw new CloudError("MEGA_EHTTP_402", "MEGA answered HTTP 402" + (r.challenge ? " " + rounds + " times" : ""), { status: 402 });
				}
				rounds++;
				answer = await hashcash.solve(r.challenge, { maxMs: timing.hashcashMaxMs });
				continue;   // the same id, with the answer
			}
			const reply = r.reply;
			const first = (Array.isArray(reply) && commands.length === 1) ? reply[0] : reply;
			if (first === -3 && again < timing.retries) {
				again++;
				await sleep(timing.retryMs * again);
				id = seq++; answer = null; rounds = 0;
				continue;
			}
			if (typeof reply === "number" && reply < 0) { throw apiError(reply, label(commands)); }
			if (reply === null || (typeof reply !== "object" && typeof reply !== "number")) {
				throw new CloudError("MEGA_EPARSE", "MEGA's reply to " + label(commands) + " is not a result list");
			}
			return reply;
		}
	}

	// One command -> its result (an object, or 0 for many edits); a negative result throws.
	async function cmd(command, sid) {
		const reply = await post([command], sid);
		const res = Array.isArray(reply) ? reply[0] : reply;
		if (typeof res === "number" && res < 0) { throw apiError(res, command.a); }
		if (res === undefined) { throw new CloudError("MEGA_BAD_REPLY", "MEGA gave no result for " + command.a); }
		return res;
	}

	// The master key of stored credentials, or MEGA_NO_SESSION (a token from another provider, a
	// half-finished sign-in) before anything is sent.
	function masterKey(creds) {
		const mk = creds && typeof creds.accessToken === "string" && typeof creds.mk === "string" && creds.mk ? MC.d64(creds.mk) : null;
		if (!mk || mk.length !== 16) {
			throw new CloudError("MEGA_NO_SESSION", "no MEGA session in the account credentials; sign in again");
		}
		return mk;
	}

	async function login(email, password, mfa) {
		const user = String(email).trim().toLowerCase();
		const us0 = await cmd({ a: "us0", user });
		const d = await MC.deriveLogin(user, password, us0);
		const req = { a: "us", user, uh: d.uh };
		if (mfa) { req.mfa = String(mfa); }
		let us;
		try { us = await cmd(req); }
		catch (e) {
			if (e && (e.megaCode === -9 || e.megaCode === -2)) { throw new CloudError("MEGA_BAD_CREDENTIALS", "wrong email or password"); }
			if (e && e.megaCode === -26) { throw new CloudError("MEGA_MFA_REQUIRED", "two-factor code required"); }
			throw e;
		}
		if (!us || typeof us !== "object" || !us.k || !us.privk || !us.csid) {
			throw new CloudError("MEGA_LOGIN_INCOMPLETE", "MEGA's login reply lacks the keys (k, privk, csid)");
		}
		try {
			const master = MC.ecbDecrypt(d.pwKey, MC.d64(us.k).subarray(0, 16));
			const priv = MC.decodePrivKey(MC.ecbDecrypt(master, MC.d64(us.privk)));
			const sid = MC.sessionId(us.csid, priv);
			const out = { accessToken: sid, mk: MC.e64(master), email: user };
			if (typeof us.u === "string" && us.u) { out.u = us.u; }
			return out;
		} catch (e) {
			throw new CloudError("MEGA_CRYPTO_FAILED", "the login keys could not be decrypted: " + ((e && e.message) || e));
		}
	}

	// A node's key, from k = "<id>:<key>[/<id>:<key>..]": each wrapped key under the master key, or
	// under the share key its id names, until one opens the attributes (megajs's loadMetadata).
	// None that does: null, the node stays closed (no name, no download). Keys longer than 32 bytes
	// are RSA-wrapped (shared to us by someone else): not handled.
	function nodeKey(n, master, shareKeys) {
		for (const pair of String(n.k).split("/")) {
			const parts = pair.split(":");
			if (parts.length < 2) { continue; }
			const enc = MC.d64(parts[parts.length - 1]);
			if (enc.length !== (n.t === 0 ? 32 : 16)) { continue; }
			const wrap = shareKeys[parts[0]] || master;
			let raw;
			try { raw = MC.ecbDecrypt(wrap, enc); } catch (e) { continue; }
			const k = n.t === 0 ? Object.assign({ raw }, MC.unpackFileKey(raw)) : { raw, aesKey: raw };
			if (!n.a) { return { k, attrs: null }; }
			const attrs = MC.decryptAttr(n.a, k.aesKey);
			if (attrs) { return { k, attrs }; }
		}
		return null;
	}

	// The whole tree (`f`), every node's key and attributes decrypted. Nodes: { h, p, t, size, ts,
	// name, attrs, key, aesKey, nonce, metaMac }; name and attrs null where they cannot be opened.
	// shareHandles: our folders shared with others (`ok`), whose share keys open their nodes too.
	async function fetchTree(creds) {
		const master = masterKey(creds);
		const res = await cmd({ a: "f", c: 1, r: 1 }, creds.accessToken);
		if (!res || typeof res !== "object") { throw new CloudError("MEGA_BAD_REPLY", "MEGA's tree is not an object"); }
		const shareKeys = {}, shareHandles = {};
		for (const s of (Array.isArray(res.ok) ? res.ok : [])) {
			if (!s || !s.h) { continue; }
			shareHandles[s.h] = true;
			try {
				// ha proves the share key is ours: ECB(master, h + h).
				const ha = MC.ecbEncrypt(master, Buffer.from(s.h + s.h, "utf8"));
				const given = MC.d64(s.ha);
				if (given.length === ha.length && crypto.timingSafeEqual(given, ha)) {
					shareKeys[s.h] = MC.ecbDecrypt(master, MC.d64(s.k).subarray(0, 16));
				}
			} catch (e) { /* a share key we cannot use */ }
		}
		const nodes = [], byHandle = {};
		let rootHandle = null, rubbishHandle = null, inboxHandle = null;
		for (const n of (Array.isArray(res.f) ? res.f : [])) {
			if (!n || typeof n.h !== "string") { continue; }
			const node = { h: n.h, p: n.p, t: n.t, size: n.s, ts: n.ts, name: null, attrs: null };
			if (n.t === 2) { rootHandle = n.h; }
			if (n.t === 3) { inboxHandle = n.h; }
			if (n.t === 4) { rubbishHandle = n.h; }
			if ((n.t === 0 || n.t === 1) && n.k) {
				const got = nodeKey(n, master, shareKeys);
				if (got) {
					Object.assign(node, { key: got.k.raw, aesKey: got.k.aesKey, nonce: got.k.nonce, metaMac: got.k.metaMac });
					if (got.attrs) { node.attrs = got.attrs; node.name = typeof got.attrs.n === "string" ? got.attrs.n : null; }
				}
			}
			byHandle[n.h] = node;
			nodes.push(node);
		}
		return { nodes, byHandle, rootHandle, rubbishHandle, inboxHandle, shareHandles };
	}

	return { post, cmd, login, masterKey, fetchTree, apiError };
}

module.exports = { createApi, ERR, timing };
