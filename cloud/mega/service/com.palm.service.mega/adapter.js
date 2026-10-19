/* adapter.js - MEGA (mega.nz) for _cloudcore/node (commands.js there has the interface).
 *
 * MEGA is id based: a node is addressed by its 8-character handle, which listFolder hands out
 * as each entry's id and path; the ROOT_FOLDER sentinel "root" is the Cloud Drive's own handle.
 * Unlike every other provider the content is end-to-end encrypted: names arrive in AES-CBC
 * attribute blocks and bytes in AES-CTR, under keys only the account's master key opens
 * (megacrypto.js, megaapi.js). The credentials are { accessToken: <session id>, mk: <master
 * key>, email, u? } (login.js makes them); the session id is the core's accessToken, so
 * readCredentials and checkCredentials work unchanged. There is no refresh: an expired session
 * is MEGA_ESID, and the account is signed in again.
 *
 * Every listing and edit starts from the whole tree (`f`), decrypted, kept 20 s per session so
 * a burst (listFolder, then downloadFile) fetches it once, and dropped after every change.
 * The edits are the cs commands megajs 1.3.10 sends (mkdir, upload, setAttributes/rename,
 * moveTo, delete), checked against the tree first, so the obvious mistakes fail with MEGA's own
 * error names before reaching the server (which would keep two nodes of one name).
 *
 * Downloads: `g` gives a URL serving the ciphertext; it is streamed to <dest>.mzenc (the core's
 * http, through .part), then decrypted and MAC-checked into <dest> (through <dest>.part).
 * Uploads: `u` gives a URL; the file is read, MAC'ed and encrypted one chunk at a time
 * (megacrypto.chunkSizes), and each chunk POSTed to <url>/<offset> as it is, with no headers
 * of its own, as megajs sends them; the last one answers the completion handle, which `p` turns
 * into a node with the wrapped key and the encrypted name.
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const MC = require("./megacrypto.js");
const { createApi } = require("./megaapi.js");

const ERROR = "MEGA_API_ERROR";
const TREE_TTL_MS = 20000;

function describe(status, body) {
	const b = String(body || "").replace(/\s+/g, " ").trim().slice(0, 200);
	return "MEGA answered HTTP " + status + (b ? ": " + b : "");
}

// A coarse MIME type from the name (the Photos methods key off the name too).
function mimeOf(name, isFolder) {
	if (isFolder) { return "application/vnd.mega.folder"; }
	const m = /\.([a-z0-9]+)$/i.exec(name || "");
	const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
		bmp: "image/bmp", heic: "image/heic", webp: "image/webp", pdf: "application/pdf" };
	return map[m ? m[1].toLowerCase() : ""] || null;
}

// One node as listFolder lists it (also the entry of createFolder and moveItem).
function entry(n) {
	const isFolder = n.t === 1;
	return { id: n.h, type: isFolder ? "folder" : "file", name: n.name || n.h, size: n.size || 0,
		modified: n.ts ? n.ts * 1000 : 0, path: n.h, mimeType: mimeOf(n.name, isFolder) };
}

function createAdapter({ config, http, errors }) {
	const { CloudError } = errors;
	const api = createApi({ config, http, errors });
	const fail = (code, ctx) => api.apiError(code, ctx);
	let cache = null;

	const sidOf = (s) => s.creds.accessToken;
	const invalidate = () => { cache = null; };

	async function tree(s) {
		const sid = sidOf(s);
		if (cache && cache.sid === sid && Date.now() - cache.at < TREE_TTL_MS) { return cache.tree; }
		const t = await api.fetchTree(s.creds);
		cache = { sid, at: Date.now(), tree: t };
		return t;
	}

	const folderHandle = (t, id) => ((!id || id === "root" || id === config.ROOT_FOLDER) ? t.rootHandle : id);

	// h and its ancestors, nearest first (stops at an unknown parent or a cycle).
	function chain(t, h) {
		const out = [], seen = new Set();
		while (h && !seen.has(h)) { seen.add(h); out.push(h); h = t.byHandle[h] ? t.byHandle[h].p : null; }
		return out;
	}
	const top = (t, h) => { const c = chain(t, h); return c[c.length - 1]; };

	// A file or folder (other than `except`) called `name` directly in `parent`.
	const sibling = (t, parent, name, except) => t.nodes.find((n) => n.p === parent && n.h !== except &&
		(n.t === 0 || n.t === 1) && n.name === name) || null;

	// Why new or moved nodes may not go into folder h, or null. Allowed: the Cloud Drive root and
	// the folders in it, but not under an outgoing share: megajs adds a `cr` share-key set there
	// so the sharees can decrypt the node, and this connector does not.
	function targetError(t, h) {
		const n = t.byHandle[h];
		if (!n) { return fail(-9, h); }
		if (n.t !== 1 && n.t !== 2) { return fail(-2, "not a folder: " + h); }
		const c = chain(t, h);
		if (c[c.length - 1] !== t.rootHandle) { return fail(-11, "outside the Cloud Drive: " + h); }
		if (c.some((x) => t.shareHandles[x])) {
			return new CloudError("MEGA_SHARE_UNSUPPORTED", "a folder shared with other users cannot be written to from here", { detail: h });
		}
		return null;
	}

	// Why the item may not be moved, renamed or deleted, or null: only own files and folders in the
	// Cloud Drive or the Rubbish Bin.
	function itemError(t, item) {
		const n = t.byHandle[item];
		if (!n) { return fail(-9, item); }
		if (n.t !== 0 && n.t !== 1) { return fail(-2, "not a file or folder: " + item); }
		const tp = top(t, item);
		if (tp !== t.rootHandle && tp !== t.rubbishHandle) { return fail(-11, item); }
		return null;
	}

	// `p` with one new folder node: a fresh 128-bit key, the attributes { n } under it, the key
	// wrapped with the master key. MEGA answers { f: [<the new node>] }.
	async function newFolder(s, master, parent, name) {
		const key = crypto.randomBytes(16);
		const r = await api.cmd({ a: "p", t: parent, n: [{ h: "xxxxxxxx", t: 1,
			a: MC.encryptAttr({ n: name }, key), k: MC.e64(MC.ecbEncrypt(master, key)) }] }, sidOf(s));
		const nn = r && Array.isArray(r.f) && r.f[0];
		if (!nn || typeof nn.h !== "string") { throw new CloudError("MEGA_BAD_REPLY", "MEGA's reply to p has no new node"); }
		invalidate();
		return nn;
	}

	// The completion handle a finished upload answers: 36 bytes, sent as MEGA base64. An error is a
	// negative number as text. (The older API answered the handle as base64 text; that is taken too.)
	function completion(bytes) {
		const text = bytes.toString("latin1");
		if (/^-\d+$/.test(text.trim())) { throw fail(Number(text.trim()), "upload"); }
		if (bytes.length === 36) { return MC.e64(bytes); }
		if (/^[A-Za-z0-9_-]{27,}$/.test(text)) { return text; }
		throw new CloudError("MEGA_UPLOAD_FAILED", "the upload did not answer a completion handle (" + bytes.length + " bytes)");
	}

	async function readFully(fh, buf, pos) {
		let got = 0;
		while (got < buf.length) {
			const { bytesRead } = await fh.read(buf, got, buf.length - got, pos + got);
			if (!bytesRead) { break; }
			got += bytesRead;
		}
		return got;
	}

	const localError = (what, p, e) => new CloudError("LOCAL_FILE_ERROR", what + " " + p + ": " + ((e && (e.code || e.message)) || e), { cause: e });

	// Encrypt and upload localPath as a new file `name` in folder `parent` (a handle).
	async function upload(s, master, parent, localPath, name) {
		let fh, size;
		try {
			const st = await fsp.stat(localPath);
			if (!st.isFile()) { throw Object.assign(new Error("not a file"), { code: "EISDIR" }); }
			size = st.size;
			fh = await fsp.open(localPath, "r");
		} catch (e) { throw localError("cannot read", localPath, e); }
		try {
			const fileKey = crypto.randomBytes(24);
			const aesKey = fileKey.subarray(0, 16), nonce = fileKey.subarray(16, 24);
			const u = await api.cmd({ a: "u", ssl: 2, s: size, ms: 0, r: 0, e: 0, v: 2 }, sidOf(s));
			if (!u || typeof u.p !== "string" || !/^https?:\/\//.test(u.p)) {
				throw new CloudError("MEGA_NO_UPLOAD_URL", "MEGA gave no upload URL");
			}
			const mac = new MC.FileMac(aesKey, nonce);
			const ctr = MC.ctrCipher(aesKey, nonce);
			const chunks = size ? MC.chunkSizes(size) : [[0, 0]];
			let token = null;
			for (let i = 0; i < chunks.length; i++) {
				const [pos, len] = chunks[i];
				const plain = Buffer.alloc(len);
				let got;
				try { got = await readFully(fh, plain, pos); } catch (e) { throw localError("cannot read", localPath, e); }
				if (got !== len) { throw localError("cannot read", localPath, new Error("the file changed while it was sent")); }
				mac.update(plain);
				const body = ctr.update(plain);
				const last = i === chunks.length - 1;
				const url = u.p + "/" + pos;
				if (!last) {
					const r = await http.request({ method: "POST", url, body, errorCode: "MEGA_UPLOAD_FAILED" });
					const text = String(r.text || "").trim();
					if (/^-\d+$/.test(text)) { throw fail(Number(text), "upload"); }
					if (text) { throw new CloudError("MEGA_UPLOAD_FAILED", "MEGA answered a chunk before the last one"); }
					continue;
				}
				// The handle is binary: the core reads replies as UTF-8 text, so it goes to a file.
				const resp = path.join(os.tmpdir(), "mega-upload-" + crypto.randomBytes(6).toString("hex"));
				try {
					await http.request({ method: "POST", url, body, errorCode: "MEGA_UPLOAD_FAILED", toFile: resp });
					token = completion(await fsp.readFile(resp));
				} finally { await fsp.rm(resp, { force: true }).catch(() => {}); }
			}
			const fullKey = MC.packFileKey(aesKey, nonce, mac.condense());
			const r = await api.cmd({ a: "p", t: parent, n: [{ h: token, t: 0,
				a: MC.encryptAttr({ n: name }, aesKey), k: MC.e64(MC.ecbEncrypt(master, fullKey)) }] }, sidOf(s));
			invalidate();
			const nn = r && Array.isArray(r.f) && r.f[0];
			if (!nn || typeof nn.h !== "string") { throw new CloudError("MEGA_BAD_REPLY", "MEGA's reply to p has no new node"); }
			return { id: nn.h, name, size };
		} finally { await fh.close().catch(() => {}); }
	}

	// The file node `fileId`, decrypted, to localDest.
	async function download(s, node, localDest) {
		const g = await api.cmd({ a: "g", g: 1, ssl: 2, n: node.h }, sidOf(s));
		if (!g || typeof g.g !== "string" || !/^https?:\/\//.test(g.g)) {
			throw new CloudError("MEGA_NO_DOWNLOAD_URL", "MEGA gave no download URL" + (g && g.e ? " (" + g.e + ")" : ""));
		}
		const size = typeof g.s === "number" ? g.s : node.size;
		const cipherPath = localDest + ".mzenc", part = localDest + ".part";
		try {
			await http.request({ method: "GET", url: g.g, toFile: cipherPath, errorCode: "MEGA_DOWNLOAD_FAILED" });
			const got = (await fsp.stat(cipherPath)).size;
			if (typeof size === "number" && got !== size) {
				throw new CloudError("MEGA_DOWNLOAD_FAILED", "the download has " + got + " of " + size + " bytes");
			}
			const ctr = MC.ctrCipher(node.aesKey, node.nonce);
			const mac = new MC.FileMac(node.aesKey, node.nonce);
			const decrypt = new Transform({
				transform(chunk, enc, cb) { const p = ctr.update(chunk); mac.update(p); cb(null, p); },
				flush(cb) { const p = ctr.final(); if (p.length) { mac.update(p); this.push(p); } cb(); },
			});
			try {
				await pipeline(fs.createReadStream(cipherPath), decrypt, fs.createWriteStream(part, { mode: 0o644 }));
			} catch (e) { throw localError("cannot write", localDest, e); }
			// An empty file has nothing to check, and clients disagree on its MAC.
			if (size !== 0 && !mac.matches(node.metaMac)) {
				throw new CloudError("MEGA_MAC_MISMATCH", "the downloaded file does not match its MAC: damaged or altered");
			}
			fs.chmodSync(part, 0o644);
			fs.renameSync(part, localDest);
		} finally {
			await fsp.rm(cipherPath, { force: true }).catch(() => {});
			await fsp.rm(part, { force: true }).catch(() => {});
		}
		return { path: localDest };
	}

	const fileNode = (t, fileId) => {
		const n = t.byHandle[fileId];
		if (!n || n.t !== 0 || !n.aesKey) { throw new CloudError("MEGA_NODE_NOT_FOUND", "no file " + fileId + " (or it cannot be decrypted)"); }
		return n;
	};

	const adapter = {
		// The sign-in (login.js): email + password (+ a two-factor code) -> the credentials.
		login(email, password, mfa) { return api.login(email, password, mfa); },

		// ug: checks the session (MEGA_ESID when it has expired) -> { user:{ emailAddress, displayName } }
		async getAccountInfo(s) {
			const u = (await api.cmd({ a: "ug" }, sidOf(s))) || {};
			return { user: { emailAddress: u.email || s.creds.email, displayName: u.name || u.email || s.creds.email } };
		},

		async listFolder(s, folderId) {
			const t = await tree(s);
			const parent = folderHandle(t, folderId);
			return { entries: t.nodes.filter((n) => n.p === parent && (n.t === 0 || n.t === 1)).map(entry) };
		},

		async downloadFile(s, fileId, localDest) {
			api.masterKey(s.creds);
			return download(s, fileNode(await tree(s), fileId), localDest);
		},

		async uploadFile(s, folderId, localPath, name) {
			const master = api.masterKey(s.creds);
			const t = await tree(s);
			const parent = folderHandle(t, folderId);
			const bad = targetError(t, parent);
			if (bad) { throw bad; }
			return upload(s, master, parent, localPath, name);
		},

		// MEGA has no overwrite in place: a new file of the same name goes into the old one's folder
		// (a save-back), as before.
		async uploadReplace(s, fileId, localPath) {
			const master = api.masterKey(s.creds);
			const t = await tree(s);
			const n = t.byHandle[fileId];
			if (!n || n.t !== 0) { throw new CloudError("MEGA_NODE_NOT_FOUND", "no file " + fileId); }
			const bad = targetError(t, n.p);
			if (bad) { throw bad; }
			return upload(s, master, n.p, localPath, n.name || "file");
		},

		async createFolder(s, parent, name) {
			const master = api.masterKey(s.creds);
			const t = await tree(s);
			const ph = folderHandle(t, parent);
			const bad = targetError(t, ph);
			if (bad) { throw bad; }
			if (sibling(t, ph, name)) { throw fail(-12, name); }
			const nn = await newFolder(s, master, ph, name);
			return { entry: entry({ h: nn.h, t: 1, name, size: 0, ts: nn.ts }) };
		},

		// `m` to the new parent (megajs moveTo) and/or `a` with the attributes encrypted again under
		// the node's own key, every other attribute kept (megajs setAttributes, which rename uses).
		// The move goes first: it is the step the server may still refuse. A rename that fails after
		// the move says so (moved: true).
		async moveItem(s, item, toFolder, name) {
			api.masterKey(s.creds);
			const t = await tree(s);
			const bad = itemError(t, item);
			if (bad) { throw bad; }
			const node = t.byHandle[item];
			let to = toFolder ? folderHandle(t, toFolder) : null;
			if (to === node.p) { to = null; }
			if (to) {
				const tb = targetError(t, to);
				if (tb) { throw tb; }
				if (chain(t, to).includes(item)) { throw fail(-10, to); }
			}
			if (name === undefined || name === node.name) { name = null; }
			const newName = name !== null ? name : node.name;
			if ((to || name !== null) && sibling(t, to || node.p, newName, item)) { throw fail(-12, newName); }
			let at = null;
			if (name !== null) {
				if (!node.attrs || !node.aesKey) { throw fail(-14, item); }
				at = MC.encryptAttr(Object.assign({}, node.attrs, { n: name }), node.aesKey);
			}
			if (to) {
				await api.cmd({ a: "m", n: item, t: to }, sidOf(s));
				invalidate();
			}
			if (at) {
				try { await api.cmd({ a: "a", n: item, at }, sidOf(s)); }
				catch (e) { if (to) { e.moved = true; } throw e; }
				invalidate();
			}
			return { entry: entry({ h: node.h, t: node.t, name: newName, size: node.size, ts: node.ts }) };
		},

		// To the Rubbish Bin (`m` to the t 4 root), from where any MEGA client can restore it; only
		// what is already in the Rubbish Bin is removed for good (`d`), as megajs's delete().
		async deleteItem(s, item) {
			api.masterKey(s.creds);
			const t = await tree(s);
			const bad = itemError(t, item);
			if (bad) { throw bad; }
			const inRubbish = top(t, item) === t.rubbishHandle;
			if (!inRubbish && !t.rubbishHandle) { throw new CloudError("MEGA_NO_RUBBISH_BIN", "the account has no Rubbish Bin", { detail: item }); }
			await api.cmd(inRubbish ? { a: "d", n: item } : { a: "m", n: item, t: t.rubbishHandle }, sidOf(s));
			invalidate();
			return {};
		},

		// The Photos delete button: `d`, for good, as before.
		async deletePhoto(s, fileId) {
			await api.cmd({ a: "d", n: fileId }, sidOf(s));
			invalidate();
			return { deleted: true };
		},

		// The folder `name` under the Cloud Drive root, made when missing -> its handle.
		async ensureAlbumFolder(s, name) {
			const master = api.masterKey(s.creds);
			const t = await tree(s);
			const found = t.nodes.find((n) => n.t === 1 && n.p === t.rootHandle && n.name === name);
			if (found) { return found.h; }
			return (await newFolder(s, master, t.rootHandle, name)).h;
		},

		// The Photos albums: the Cloud Drive root when it holds images, then every folder that
		// directly holds one. -> [{ aid, name, images }]
		async photoAlbums(s) {
			const t = await tree(s);
			const counts = {};
			for (const n of t.nodes) {
				const mime = n.t === 0 ? mimeOf(n.name, false) : null;
				if (mime && mime.indexOf("image/") === 0) { counts[n.p] = (counts[n.p] || 0) + 1; }
			}
			const albums = [];
			if (counts[t.rootHandle]) { albums.push({ aid: t.rootHandle, name: "Cloud Drive", images: counts[t.rootHandle] }); }
			for (const n of t.nodes) {
				if (n.t === 1 && counts[n.h]) { albums.push({ aid: n.h, name: n.name || n.h, images: counts[n.h] }); }
			}
			return albums;
		},

		// One image downloaded and decrypted to `dest` (MEGA's URLs serve ciphertext, so the Photos
		// service is given a local file). A copy already there with the node's size is kept.
		async photoToLocal(s, fileId, dest) {
			const n = fileNode(await tree(s), fileId);
			try { if (fs.statSync(dest).size === n.size) { return { path: dest, cached: true }; } } catch (e) { /* not there yet */ }
			return download(s, n, dest);
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, describe, entry, mimeOf, TREE_TTL_MS });
