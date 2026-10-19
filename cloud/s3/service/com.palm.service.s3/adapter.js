/* adapter.js - S3 (and S3-compatible storage) for _cloudcore/node (commands.js there has the
 * interface).
 *
 * S3 is a flat key/value store. Folders are key prefixes with the "/" delimiter, so a locator is
 * a key ("Docs/a.pdf") or a prefix ending in "/" ("Docs/"); the bucket root is "" ("root" too).
 * Every request is signed with the account's keys (SigV4, s3sig.js); there is no token and no
 * refresh, so the Session is only where the credentials come from:
 *   credentials.common = { accessToken: <access key id>, secretAccessKey, endpoint ("host[:port]"),
 *                          region, bucket, pathStyle, scheme? ("http" for a plain http endpoint) }
 *
 * Every failure rejects. A reply outside 2xx is the operation's own errorCode (S3_LIST_FAILED,
 * S3_UPLOAD_FAILED, ...) with its status, and S3's <Error><Code> in the errorText (describe).
 *
 * Uploads stream the file from disk. Over https the payload is UNSIGNED-PAYLOAD, as it always was:
 * TLS already protects the body, and hashing first would read a large file twice on the phone.
 * Over plain http nothing else protects it, so its SHA-256 is computed first and signed; S3
 * refuses a body that does not match (XAmzContentSHA256Mismatch), e.g. a file changed meanwhile.
 *
 * S3 has no folders and no rename: createFolder PUTs a zero-byte "<prefix>/" marker (the S3
 * console's convention); a move or rename is CopyObject to the new key and then a delete of the
 * old one, only after the copy answered a real <CopyObjectResult>; a folder move or delete walks
 * every key under the prefix, within the bounds below.
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const sig = require("./s3sig.js");

const ERROR = "S3_API_ERROR";

// --- the XML S3 answers: flat and predictable, so a reader for its few shapes ----------------

const codePoint = (m, n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
function decode(s) {
	if (s === null || s === undefined) { return s; }
	return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'").replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (m, n) => codePoint(m, Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (m, n) => codePoint(m, parseInt(n, 16)))
		.replace(/&amp;/g, "&");
}
const tagRe = (name, flags) => new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", flags);
function tag(xml, name) { const m = tagRe(name).exec(xml || ""); return m ? decode(m[1]) : null; }
function blocks(xml, name) { return Array.from(String(xml || "").matchAll(tagRe(name, "g")), (m) => m[1]); }

// ListObjectsV2 -> { files:[{ key, size, modified, etag }], prefixes:[key], truncated, nextToken }
function parseList(xml) {
	return {
		files: blocks(xml, "Contents").map((b) => ({ key: tag(b, "Key"), size: parseInt(tag(b, "Size") || "0", 10),
			modified: tag(b, "LastModified"), etag: tag(b, "ETag") })),
		prefixes: blocks(xml, "CommonPrefixes").map((b) => tag(b, "Prefix")),
		truncated: tag(xml, "IsTruncated") === "true",
		nextToken: tag(xml, "NextContinuationToken"),
	};
}

// <Error><Code>..</Code><Message>..</Message></Error> -> { code, message }, or null.
function parseError(xml) {
	if (!xml || String(xml).indexOf("<Error") < 0) { return null; }
	return { code: tag(xml, "Code"), message: tag(xml, "Message") };
}

const oneLine = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; };

// The errorText of an S3 error reply: its <Code> and <Message> where it has them.
function describe(status, body) {
	const e = parseError(body);
	const what = e && e.code ? e.code + (e.message ? " (" + oneLine(e.message, 160) + ")" : "") : "";
	return "S3 answered HTTP " + status + (what ? ": " + what : "");
}

// --- locators --------------------------------------------------------------------------------

const isRoot = (loc) => loc === undefined || loc === null || loc === "" || loc === "root";
const isFolder = (loc) => String(loc).endsWith("/");
function leaf(p) { const s = String(p === null || p === undefined ? "" : p).replace(/\/+$/, ""); return s.slice(s.lastIndexOf("/") + 1); }
function prefixOf(folderId) { const p = isRoot(folderId) ? "" : String(folderId); return (p && !p.endsWith("/")) ? p + "/" : p; }
// "a/b/c.txt" -> "a/b/", "a/b/" -> "a/", "c.txt" -> "".
function parentOf(loc) { const s = String(loc).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return i >= 0 ? s.slice(0, i + 1) : ""; }
const badName = (name) => typeof name !== "string" || !name || name === "." || name === ".." || /[/\u0000]/.test(name);

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp",
	heic: "image/heic", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", pdf: "application/pdf",
	txt: "text/plain", doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
function mimeOf(name, folder) {
	if (folder) { return "application/x-directory"; }
	const m = /\.([a-z0-9]+)$/i.exec(name || "");
	return (m && MIME[m[1].toLowerCase()]) || "application/octet-stream";
}

// listFolder's entries: a common prefix is a folder, an object a file.
const folderEntry = (p) => ({ id: p, type: "folder", name: leaf(p), size: 0, modified: 0, path: p, mimeType: mimeOf(null, true) });
const fileEntry = (o) => ({ id: o.key, type: "file", name: leaf(o.key), size: o.size,
	modified: o.modified ? Date.parse(o.modified) : 0, path: o.key, mimeType: mimeOf(o.key, false) });

function xmlEscape(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&apos;")
		.replace(/[\u0000-\u001f]/g, (c) => "&#" + c.charCodeAt(0) + ";");
}

function createAdapter({ config, http, errors }) {
	const fail = (code, text, extra) => new errors.CloudError(code, text, extra);
	const listLimit = () => config.LIST_LIMIT || 1000;

	// The account's S3 credentials, checked before anything is signed with them.
	function account(s) {
		const c = (s && s.creds) || {};
		if (!c.accessToken || !c.secretAccessKey || !c.endpoint || !c.bucket) {
			throw fail("MISSING_CREDENTIALS", "the account has no endpoint, bucket, access key or secret");
		}
		try { sig.hostOf(c.endpoint, c.scheme); }
		catch (e) { throw fail("BAD_ARGS", "the endpoint is not a host[:port]"); }
		return c;
	}

	// Host and resource path for a key: path style (endpoint/bucket/key, the default, which most
	// S3-compatible servers need) or virtual-host style (bucket.endpoint/key).
	function target(c, key) {
		return c.pathStyle === false ? { host: c.bucket + "." + c.endpoint, path: key || "" }
			: { host: c.endpoint, path: c.bucket + "/" + (key || "") };
	}

	// Sign and send one request. -> http.request's { status, headers, text } (or, toFile, path).
	function send(s, { method = "GET", key = "", query = {}, headers = {}, payloadHash, body, file, toFile, errorCode }) {
		const c = account(s);
		const t = target(c, key);
		const signed = sig.signRequest({ method, host: t.host, path: t.path, query, headers, payloadHash,
			region: c.region || config.DEFAULT_REGION, service: "s3", accessKeyId: c.accessToken,
			secretAccessKey: c.secretAccessKey, scheme: c.scheme });
		return http.request({ method, url: signed.url, headers: signed.headers, body, file, toFile,
			errorCode: errorCode || ERROR });
	}

	// One ListObjectsV2 page. A 200 that is not a ListBucketResult is an error, not an empty folder.
	async function listPage(s, query, code) {
		const r = await send(s, { query: Object.assign({ "list-type": "2" }, query), errorCode: code });
		if (!/<ListBucketResult[\s>]/.test(r.text || "")) {
			throw fail(code, "the reply to a listing is not a ListBucketResult", { status: r.status });
		}
		return parseList(r.text);
	}

	// Every page: onPage(parsed) for each, while IsTruncated with a new continuation token.
	async function listPages(s, query, code, onPage) {
		let token = null;
		for (;;) {
			const q = Object.assign({}, query(), token ? { "continuation-token": token } : {});
			const page = await listPage(s, q, code);
			onPage(page);
			if (!page.truncated || !page.nextToken) { return; }
			if (page.nextToken === token) { throw fail(code, "the listing repeats its continuation token"); }
			token = page.nextToken;
		}
	}

	// The first object at or under `prefix` (max-keys 1), or null. Keys list in UTF-8 binary
	// order, so for an exact key that first object is the key itself when it exists.
	async function first(s, prefix) {
		const files = (await listPage(s, { prefix, "max-keys": "1" }, "S3_LIST_FAILED")).files;
		return files.length ? files[0] : null;
	}
	async function stat(s, key) { const f = await first(s, key); return f && f.key === key ? f : null; }

	// Every object under `prefix` (no delimiter: the whole subtree, a marker included). More than
	// `max` fails S3_TOO_MANY_KEYS before anything is changed.
	async function listTree(s, prefix, max) {
		const keys = [];
		await listPages(s, () => ({ prefix, "max-keys": String(Math.min(listLimit(), max + 1 - keys.length)) }), "S3_LIST_FAILED", (page) => {
			keys.push(...page.files);
			if (keys.length > max) { throw fail("S3_TOO_MANY_KEYS", "more than " + max + " objects under " + prefix, { limit: max }); }
		});
		return keys;
	}

	// SHA-256 of a local file, for a signed upload payload.
	async function sha256File(p) {
		const h = crypto.createHash("sha256");
		try { await pipeline(fs.createReadStream(p), h); }
		catch (e) { throw fail("LOCAL_FILE_ERROR", "cannot read " + p + ": " + ((e && (e.code || e.message)) || e), { cause: e }); }
		return h.digest("hex");
	}

	async function put(s, key, localPath, mimeType) {
		let st;
		try {
			st = await fsp.stat(localPath);
			if (!st.isFile()) { throw Object.assign(new Error("not a file"), { code: "EISDIR" }); }
		} catch (e) { throw fail("LOCAL_FILE_ERROR", "cannot read " + localPath + ": " + ((e && (e.code || e.message)) || e), { cause: e }); }
		const c = account(s);
		const payloadHash = c.scheme === "http" ? await sha256File(localPath) : sig.UNSIGNED;
		const headers = { "content-length": String(st.size) };
		if (mimeType) { headers["content-type"] = mimeType; }
		await send(s, { method: "PUT", key, file: localPath, headers, payloadHash, errorCode: "S3_UPLOAD_FAILED" });
		return { id: key, path: key, name: leaf(key), size: st.size };
	}

	// A zero-byte object (a folder marker), with no body.
	function putEmpty(s, key, code) {
		return send(s, { method: "PUT", key, headers: { "content-length": "0" }, payloadHash: sig.EMPTY_SHA256, errorCode: code });
	}

	// CopyObject: PUT the destination with x-amz-copy-source "<bucket>/<key>" (encoded, signed like
	// every header). A 200 can still carry an <Error> when the copy failed part-way, so only a body
	// holding <CopyObjectResult> and no <Error> counts as copied.
	async function copy(s, fromKey, toKey) {
		const c = account(s);
		const r = await send(s, { method: "PUT", key: toKey, errorCode: "S3_COPY_FAILED",
			headers: { "x-amz-copy-source": sig.uriEncode(c.bucket + "/" + fromKey, false), "content-length": "0" } });
		const text = r.text || "", err = parseError(text);
		if (err || text.indexOf("<CopyObjectResult") < 0) {
			throw fail("S3_COPY_FAILED", "copying " + fromKey + ": " + (err ? describe(r.status, text) : "no CopyObjectResult in the reply"),
				{ status: r.status, s3Code: err && err.code });
		}
		return { modified: tag(text, "LastModified") };
	}

	// DeleteObject: 204, also for a key that was not there.
	function deleteKey(s, key) { return send(s, { method: "DELETE", key, errorCode: "S3_DELETE_FAILED" }); }

	// DeleteObjects (POST /?delete, quiet, Content-MD5), DELETE_BATCH_KEYS keys per request.
	// -> { failed:[{ key, code, message }] } for the per-key errors; a batch refused as a whole
	// fails, and the later batches are not sent.
	async function deleteKeys(s, keys) {
		const failed = [];
		for (let i = 0; i < keys.length; i += adapter.DELETE_BATCH_KEYS) {
			const body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
				"<Delete xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Quiet>true</Quiet>" +
				keys.slice(i, i + adapter.DELETE_BATCH_KEYS).map((k) => "<Object><Key>" + xmlEscape(k) + "</Key></Object>").join("") +
				"</Delete>";
			const r = await send(s, { method: "POST", query: { delete: "" }, body, payloadHash: sig.sha256Hex(body),
				errorCode: "S3_DELETE_FAILED", headers: { "content-type": "application/xml", "content-md5": sig.md5Base64(body),
					"content-length": String(Buffer.byteLength(body)) } });
			const text = r.text || "";
			if (text.indexOf("<DeleteResult") < 0) {
				const err = parseError(text);
				throw fail("S3_DELETE_FAILED", err ? describe(r.status, text) : "no DeleteResult in the reply",
					{ status: r.status, s3Code: err && err.code });
			}
			for (const b of blocks(text, "Error")) { failed.push({ key: tag(b, "Key"), code: tag(b, "Code"), message: tag(b, "Message") }); }
		}
		return { failed };
	}

	const listOf = (keys) => keys.slice(0, 5).join(", ") + (keys.length > 5 ? ", ..." : "");

	async function moveFile(s, item, dest) {
		const src = await stat(s, item);
		if (!src) { throw fail("S3_NOT_FOUND", "no object " + item); }
		if (dest === item) { return { entry: fileEntry(src) }; }
		if (src.size > adapter.MAX_COPY_BYTES) {
			throw fail("S3_TOO_LARGE_TO_COPY", item + " is over 5 GB and needs a multipart copy", { size: src.size });
		}
		if (await stat(s, dest)) { throw fail("S3_DESTINATION_EXISTS", dest + " already exists"); }
		const c = await copy(s, item, dest);
		const entry = fileEntry({ key: dest, size: src.size, modified: c.modified || src.modified });
		try { await deleteKey(s, item); }
		catch (e) {
			throw fail("S3_MOVE_INCOMPLETE", "copied to " + dest + " but the original could not be deleted: " +
				((e && (e.errorText || e.message)) || e), { status: e && e.status, entry, cause: e });
		}
		return { entry };
	}

	async function moveFolder(s, item, dest) {
		if (dest === item) { return { entry: folderEntry(item) }; }
		if (dest.startsWith(item)) { throw fail("S3_MOVE_INTO_SELF", "a folder cannot move into itself"); }
		const files = await listTree(s, item, adapter.MAX_MOVE_KEYS);
		if (!files.length) { throw fail("S3_NOT_FOUND", "no objects under " + item); }
		const big = files.find((o) => o.size > adapter.MAX_COPY_BYTES);
		if (big) { throw fail("S3_TOO_LARGE_TO_COPY", big.key + " is over 5 GB and needs a multipart copy", { size: big.size }); }
		if (await first(s, dest)) { throw fail("S3_DESTINATION_EXISTS", dest + " already has objects"); }

		const copied = [];
		try {
			for (const o of files) {
				const to = dest + o.key.slice(item.length);
				await copy(s, o.key, to);
				copied.push(to);
			}
		} catch (cause) {
			// Remove the copies made so far; the originals were not touched.
			let cleaned = true;
			if (copied.length) {
				try { cleaned = (await deleteKeys(s, copied)).failed.length === 0; } catch (e) { cleaned = false; }
			}
			throw fail((cause && cause.errorCode) || "S3_COPY_FAILED",
				((cause && (cause.errorText || cause.message)) || String(cause)) + "; " + copied.length + " of " + files.length +
				" copied, " + (cleaned ? "the copies were removed" : "the copies could not all be removed"),
				{ status: cause && cause.status, copied: copied.length, total: files.length, cleanedUp: cleaned, cause });
		}
		const r = await deleteKeys(s, files.map((o) => o.key));
		if (r.failed.length) {
			const keys = r.failed.map((x) => x.key);
			throw fail("S3_MOVE_INCOMPLETE", "copied to " + dest + " but " + keys.length + " original(s) could not be deleted: " + listOf(keys),
				{ entry: folderEntry(dest), notDeleted: keys });
		}
		return { entry: folderEntry(dest) };
	}

	const adapter = {
		// Bounds. Folder moves copy one key per request, serially, within moveItem's deadline;
		// a folder delete is one listing page and one DeleteObjects batch per 1000 keys. Bigger
		// trees are refused up front, untouched.
		MAX_COPY_BYTES: 5 * 1024 * 1024 * 1024,   // CopyObject copies at most 5 GB in one request
		MAX_MOVE_KEYS: 25,
		MAX_DELETE_KEYS: 1000,
		DELETE_BATCH_KEYS: 1000,                  // DeleteObjects' per-request limit

		// S3 has no user endpoint: a zero-key ListObjectsV2 proves the keys, the signing and the
		// bucket, and the identity is made from the bucket and endpoint.
		async getAccountInfo(s) {
			const c = account(s);
			await listPage(s, { "max-keys": "0" }, "S3_AUTH_FAILED");
			return { user: { emailAddress: c.bucket + "@" + c.endpoint, displayName: c.bucket } };
		},

		// A prefix's direct children (delimiter "/"), every page. The folder's own marker object
		// is left out.
		async listFolder(s, folderId) {
			const prefix = prefixOf(folderId);
			const entries = [];
			await listPages(s, () => ({ prefix, delimiter: "/", "max-keys": String(listLimit()) }), "S3_LIST_FAILED", (page) => {
				for (const p of page.prefixes) { entries.push(folderEntry(p)); }
				for (const o of page.files) { if (o.key !== prefix) { entries.push(fileEntry(o)); } }
			});
			return { entries };
		},

		// GET the object to localDest (exportMime is not S3's).
		async downloadFile(s, fileId, localDest) {
			await send(s, { key: String(fileId), toFile: localDest, errorCode: "S3_DOWNLOAD_FAILED" });
			return { path: localDest };
		},

		// PUT a local file as <folder>/<name>.
		uploadFile(s, folderId, localPath, name, mimeType) { return put(s, prefixOf(folderId) + name, localPath, mimeType); },

		// Overwrite the object at fileId (a save-back): a PUT replaces it in place.
		uploadReplace(s, fileId, localPath, mimeType) { return put(s, String(fileId), localPath, mimeType); },

		// "<parent><name>/" as a zero-byte marker. A PUT overwrites in place, so an existing
		// folder of that name stays as it is.
		async createFolder(s, parent, name) {
			if (badName(name)) { throw fail("BAD_ARGS", "name: one path component"); }
			const key = prefixOf(parent) + name + "/";
			await putEmpty(s, key, "S3_MKDIR_FAILED");
			return { entry: folderEntry(key) };
		},

		// Rename (name), move (toFolder) or both. A file is copied, then the original deleted once
		// the copy succeeded. A folder is copied key by key, then the originals deleted once every
		// copy succeeded; if one fails, the copies made so far are removed again. An existing
		// destination is refused rather than overwritten or merged into.
		async moveItem(s, item, toFolder, name) {
			if (isRoot(item)) { throw fail("BAD_ARGS", "the root folder cannot be moved"); }
			item = String(item);
			const folder = isFolder(item);
			const newName = (name === null || name === undefined) ? leaf(item) : name;
			if (badName(newName)) { throw fail("BAD_ARGS", "name: one path component"); }
			const dest = (toFolder === null || toFolder === undefined ? parentOf(item) : prefixOf(toFolder)) + newName + (folder ? "/" : "");
			return folder ? moveFolder(s, item, dest) : moveFile(s, item, dest);
		},

		// DeleteObject for a key; for a folder every object under the prefix (the marker too)
		// with DeleteObjects. S3 has no trash: this is permanent unless the bucket is versioned.
		async deleteItem(s, item) {
			if (isRoot(item)) { throw fail("BAD_ARGS", "the root folder cannot be deleted"); }
			item = String(item);
			if (!isFolder(item)) { await deleteKey(s, item); return {}; }
			const files = await listTree(s, item, adapter.MAX_DELETE_KEYS);
			if (!files.length) { return {}; }
			const r = await deleteKeys(s, files.map((o) => o.key));
			if (r.failed.length) {
				const keys = r.failed.map((x) => x.key);
				throw fail("S3_DELETE_FAILED", keys.length + " object(s) could not be deleted (" + (r.failed[0].code || "?") + "): " + listOf(keys),
					{ notDeleted: keys, s3Code: r.failed[0].code });
			}
			return {};
		},

		// --- Photos ------------------------------------------------------------------------
		// The album prefix ("Camera Uploads/") and whether anything is under it. A listing that
		// fails counts as nothing there.
		async resolvePhotoAlbum(s, log = console) {
			const name = config.PHOTO_ALBUM_NAME || "Camera Uploads";
			const prefix = name + "/";
			let exists = false;
			try {
				const p = await listPage(s, { prefix, "max-keys": "1" }, "S3_LIST_FAILED");
				exists = p.files.length > 0 || p.prefixes.length > 0;
			} catch (e) { log.log("s3: the album " + prefix + " cannot be listed: " + ((e && (e.errorText || e.message)) || e)); }
			return { path: prefix, name, exists };
		},

		// The upload's album folder: its marker made (or left as it is). -> the prefix
		async ensureAlbumFolder(s, name) {
			const prefix = String(name).replace(/\/+$/, "") + "/";
			await putEmpty(s, prefix, "S3_MKDIR_FAILED");
			return prefix;
		},

		// A presigned GET URL (an hour) the Photos service can fetch with no header.
		getTemporaryLink(s, fileId) {
			const c = account(s);
			const t = target(c, String(fileId));
			return { link: sig.presignUrl({ method: "GET", host: t.host, path: t.path, expires: 3600,
				region: c.region || config.DEFAULT_REGION, service: "s3", accessKeyId: c.accessToken,
				secretAccessKey: c.secretAccessKey, scheme: c.scheme }), method: "GET" };
		},

		async deletePhoto(s, fileId) {
			await deleteKey(s, String(fileId));
			return { deleted: true };
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, describe, parseList, parseError, tag, decode, xmlEscape,
	prefixOf, parentOf, leaf, mimeOf, folderEntry, fileEntry });
