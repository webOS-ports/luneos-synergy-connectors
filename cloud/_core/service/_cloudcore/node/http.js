/* http.js - HTTPS for the connectors: Node's own fetch, with deadlines, streaming to and from
 * files, and one error type for every way a request can fail.
 *
 *   const http = createHttp({ errorCode: "DROPBOX_API_ERROR", describe });
 *   await http.json({ method: "POST", url, bearer, json: {...} })      -> parsed reply ({} if empty)
 *   await http.request({ method, url, headers, form | json | body | file | multipart, toFile })
 *        -> { status, headers, text }  or, with toFile, { status, headers, path, bytes }
 *
 * Bodies: json (an object, sent as application/json), form (an object, url-encoded), body (a
 * string, Buffer or Blob as is), file (a local path, streamed from disk with its length - never
 * read into memory), multipart ([{ name, value } | { name, file, filename?, type? }], the file
 * parts streamed too, filename defaulting to the local file's name).
 * toFile: the reply body is streamed to that local path, through "<path>.part" renamed into
 * place once complete, so a failed download leaves no half file and an error body is never
 * written as the file. Folders it needs are made 0755, the file is 0644: the apps that read
 * downloads run as another user than the service.
 *
 * Deadlines: timeoutMs until the reply's headers, then idleTimeoutMs between two chunks of its
 * body (a large file may take long, a stalled one may not).
 *
 * Errors, all CloudError (errors.js):
 *   HttpError  a reply outside 2xx (and not in opts.accept): errorCode is the provider's
 *              (createHttp's errorCode, or opts.errorCode), with status and the body (cut to
 *              BODY_MAX characters). errorText is describe(status, body) when given.
 *   CURL_FAILED the request got no reply: refused, unresolvable, reset, timed out. The name is
 *              historical (the transport used to be curl) and kept because the consumers key on
 *              it: Documents' CloudService.describeError and Topaz Explorer's cloudWhy.
 *   LOCAL_FILE_ERROR  the local file to send cannot be read, or the one to write cannot be made.
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { CloudError } = require("./errors.js");

const TRANSPORT_FAILED = "CURL_FAILED";
const LOCAL_FILE_ERROR = "LOCAL_FILE_ERROR";
const TIMEOUT_MS = 60000;
const IDLE_TIMEOUT_MS = 30000;
const BODY_MAX = 2000;

class HttpError extends CloudError {
	constructor(errorCode, errorText, { status, body, method, url }) {
		super(errorCode, errorText, { status, body, method, url });
		this.name = "HttpError";
	}
}

// The URL as it may appear in an error: no query (some providers carry tokens there).
function safeUrl(u) {
	try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return "?"; }
}

function oneLine(s, n) {
	const t = String(s || "").replace(/\s+/g, " ").trim();
	return t.length > n ? t.slice(0, n) + "..." : t;
}

// Make `dir` and any missing parent, each new one 0755 whatever the umask.
function makeDirs(dir) {
	const first = fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
	if (!first) { return; }
	let cur = path.resolve(dir);
	const created = [];
	while (cur.length >= first.length) { created.push(cur); if (cur === first) { break; } cur = path.dirname(cur); }
	for (const d of created) { fs.chmodSync(d, 0o755); }
}

function localError(what, p, e) {
	return new CloudError(LOCAL_FILE_ERROR, what + " " + p + ": " + ((e && (e.code || e.message)) || e), { cause: e });
}

function createHttp({ fetch = (...a) => globalThis.fetch(...a), errorCode = "HTTP_ERROR", describe = null,
	timeoutMs = TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {

	async function buildBody(opts, headers) {
		if (opts.json !== undefined) {
			if (!hasHeader(headers, "content-type")) { headers["Content-Type"] = "application/json"; }
			return JSON.stringify(opts.json);
		}
		if (opts.form) {
			const f = new URLSearchParams();
			for (const [k, v] of Object.entries(opts.form)) { if (v !== undefined && v !== null) { f.append(k, String(v)); } }
			return f;
		}
		if (opts.multipart) {
			const fd = new FormData();
			for (const p of opts.multipart) {
				if (p.file) {
					fd.append(p.name, await openBlob(p.file, p.type), p.filename || path.basename(p.file));
				} else {
					fd.append(p.name, String(p.value));
				}
			}
			return fd;
		}
		if (opts.file) { return openBlob(opts.file, opts.type); }
		return opts.body;
	}

	// A Blob backed by the file: fetch streams it, and knows its length. openAsBlob's own error for
	// a missing file is ERR_INVALID_ARG_VALUE, so the file is looked at first.
	async function openBlob(p, type) {
		try {
			const st = await fsp.stat(p);
			if (!st.isFile()) { throw Object.assign(new Error("not a file"), { code: "EISDIR" }); }
			return await fs.openAsBlob(p, type ? { type } : undefined);
		} catch (e) { throw localError("cannot read", p, e); }
	}

	// The request, up to a Response: transport failures and the header deadline become CURL_FAILED.
	async function send(opts) {
		const method = opts.method || "GET";
		const headers = Object.assign({}, opts.headers || {});
		if (opts.bearer) { headers.Authorization = "Bearer " + opts.bearer; }
		const body = await buildBody(opts, headers);
		for (const [k, v] of Object.entries(headers)) {
			if (/[\r\n\0]|[^\x00-\xff]/.test(String(v))) { throw new CloudError("BAD_ARGS", "header " + k + " holds characters HTTP cannot carry"); }
		}
		const ac = new AbortController();
		const where = method + " " + safeUrl(opts.url);
		const state = { where, timedOut: null, ac, timer: null };
		const headerMs = opts.timeoutMs || timeoutMs;
		state.timer = setTimeout(() => { state.timedOut = "timed out after " + Math.round(headerMs / 1000) + " s waiting for a reply"; ac.abort(); }, headerMs);
		let res;
		try {
			res = await fetch(opts.url, { method, headers, body, signal: ac.signal,
				redirect: opts.redirect || "follow", duplex: body && typeof body.pipe === "function" ? "half" : undefined });
		} catch (e) {
			clearTimeout(state.timer);
			throw transportError(state, e);
		}
		clearTimeout(state.timer);
		return { res, state, method };
	}

	function transportError(state, e) {
		if (e instanceof CloudError) { return e; }
		const c = e && e.cause;
		const why = state.timedOut || ("network error: " + ((c && (c.code || c.message)) || (e && e.message) || e));
		return new CloudError(TRANSPORT_FAILED, state.where + ": " + why, { cause: e });
	}

	// Iterate the body with the idle deadline armed between chunks.
	function idleGuard(state, ms) {
		const arm = () => {
			clearTimeout(state.timer);
			state.timer = setTimeout(() => { state.timedOut = "timed out after " + Math.round(ms / 1000) + " s without data"; state.ac.abort(); }, ms);
		};
		return { arm, stop: () => clearTimeout(state.timer) };
	}

	async function readText(res, state, ms) {
		if (!res.body) { return ""; }
		const g = idleGuard(state, ms);
		const chunks = [];
		g.arm();
		try {
			for await (const c of res.body) { chunks.push(Buffer.from(c)); g.arm(); }
		} catch (e) {
			throw transportError(state, e);
		} finally { g.stop(); }
		return Buffer.concat(chunks).toString("utf8");
	}

	async function toFile(res, state, ms, dest) {
		const part = dest + ".part";
		try { makeDirs(path.dirname(dest)); }
		catch (e) { await discard(res); throw localError("cannot make the folder for", dest, e); }
		const g = idleGuard(state, ms);
		let bytes = 0, local = null;
		const counter = new Transform({ transform(chunk, enc, cb) { bytes += chunk.length; g.arm(); cb(null, chunk); } });
		const out = fs.createWriteStream(part, { mode: 0o644 });
		out.on("error", (e) => { local = e; });
		g.arm();
		try {
			await pipeline(res.body ? Readable.fromWeb(res.body) : Readable.from([]), counter, out);
			fs.chmodSync(part, 0o644);
			fs.renameSync(part, dest);
		} catch (e) {
			await fsp.rm(part, { force: true }).catch(() => {});
			// The write stream fails with the source's error too; only a filesystem error is local.
			const fsErr = (local && local.syscall) ? local : ((e && e.syscall && !state.timedOut) ? e : null);
			if (fsErr) { throw localError("cannot write", dest, fsErr); }
			throw transportError(state, e);
		} finally { g.stop(); }
		return bytes;
	}

	async function discard(res) { try { if (res.body) { await res.body.cancel(); } } catch (e) { /* nothing to free */ } }

	async function request(opts) {
		const { res, state, method } = await send(opts);
		const ms = opts.idleTimeoutMs || idleTimeoutMs;
		const ok = (res.status >= 200 && res.status < 300) || (opts.accept || []).includes(res.status);
		if (ok && opts.toFile && res.status >= 200 && res.status < 300) {
			const bytes = await toFile(res, state, ms, opts.toFile);
			return { status: res.status, headers: res.headers, path: opts.toFile, bytes };
		}
		const text = await readText(res, state, ms);
		if (!ok) {
			const code = opts.errorCode || errorCode;
			const body = text.length > BODY_MAX ? text.slice(0, BODY_MAX) : text;
			const errorText = (opts.describe || describe || defaultDescribe)(res.status, body, state.where);
			throw new HttpError(code, errorText, { status: res.status, body, method, url: safeUrl(opts.url) });
		}
		return { status: res.status, headers: res.headers, text };
	}

	async function json(opts) {
		const r = await request(opts);
		if (!r.text) { return {}; }
		try { return JSON.parse(r.text); }
		catch (e) {
			throw new CloudError(opts.errorCode || errorCode, safeUrl(opts.url) + ": the reply is not JSON",
				{ status: r.status, body: r.text.slice(0, BODY_MAX) });
		}
	}

	return { request, json, errorCode };
}

function defaultDescribe(status, body, where) {
	const b = oneLine(body, 200);
	return where + " -> HTTP " + status + (b ? ": " + b : "");
}

function hasHeader(h, name) { return Object.keys(h).some((k) => k.toLowerCase() === name); }

module.exports = { createHttp, HttpError, makeDirs, safeUrl, TRANSPORT_FAILED, LOCAL_FILE_ERROR, BODY_MAX };
