/* adapter.js - WebDAV (Nextcloud, ownCloud, a NAS, any RFC 4918 server) for _cloudcore/node
 * (commands.js there has the interface).
 *
 * A locator is a path under the account's WebDAV folder, as it reads (not percent-encoded):
 * "/" is that folder, "/Docs/" a folder in it (a folder's always ends in "/"), "/Docs/a.pdf" a
 * file. "root" and "" are the root too. The URL of a locator is the account's server (its
 * WebDAV folder, ending in "/") with each path segment percent-encoded.
 *
 *   credentials.common = { accessToken (the password), username, server, flavor, photoFolder }
 *
 * Every request carries HTTP Basic auth, and follows no redirect: fetch would carry the
 * Authorization header along to wherever one points. login.js follows one, once, before the
 * password is sent; a server that moves later answers an error asking to sign in again.
 *
 *   listFolder    PROPFIND Depth 1, the folder itself left out
 *   downloadFile  GET, streamed to the file
 *   uploadFile    PUT, streamed from the file; an existing file of that name is replaced, as
 *                 the other connectors' uploads replace one
 *   createFolder  MKCOL; one that is there already (405) is taken when it is a folder
 *   moveItem      MOVE with Overwrite: F, so an existing destination is refused, not replaced
 *   deleteItem    DELETE (a folder with everything in it; Nextcloud keeps it in its trash bin)
 *
 * Every failure rejects. A reply outside 2xx is the operation's own errorCode (WEBDAV_LIST_FAILED,
 * WEBDAV_UPLOAD_FAILED, ...) with its status; the errorText says what the status means and,
 * where the server gave one (Nextcloud/ownCloud's Sabre does), its <s:message>. No reply body
 * goes into an errorText otherwise, and never the password.
 */
"use strict";

const fsp = require("node:fs/promises");

const ERROR = "WEBDAV_API_ERROR";

// --- the XML WebDAV answers -------------------------------------------------------------------
// A 207 Multi-Status is <multistatus><response><href/><propstat><prop>..</prop><status/></propstat>
// ..</response>..</multistatus>, with whatever namespace prefix the server picks for DAV: ("d:",
// "D:", "lp1:", or none with a default xmlns). Elements are matched by local name.

const codePoint = (m, n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
function decode(s) {
	if (s === null || s === undefined) { return s; }
	return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'").replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (m, n) => codePoint(m, Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (m, n) => codePoint(m, parseInt(n, 16)))
		.replace(/&amp;/g, "&");
}
const PFX = "(?:[A-Za-z_][\\w.-]*:)?";
const elRe = (name, flags) => new RegExp("<" + PFX + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + PFX + name + "\\s*>", flags);
function blocks(xml, name) { return Array.from(String(xml || "").matchAll(elRe(name, "g")), (m) => m[1]); }
function text(xml, name) { const m = elRe(name).exec(xml || ""); return m ? decode(m[1]).trim() : null; }
// An element that is there, empty (<d:collection/>) or not.
function present(xml, name) { return new RegExp("<" + PFX + name + "(?:\\s[^>]*)?/?>").test(xml || ""); }
const isMultistatus = (xml) => new RegExp("<" + PFX + "multistatus[\\s>]").test(xml || "");

// A 207's responses -> [{ href, collection, size, modified, contentType, etag }]. Only the props
// in a propstat whose status is 2xx count (a server lists the ones it does not have under 404);
// a response with none (a bare <status>404</status>) is left out.
function parseMultistatus(xml) {
	const out = [];
	for (const r of blocks(xml, "response")) {
		const href = text(r, "href");
		if (!href) { continue; }
		const props = blocks(r, "propstat").filter((ps) => /\s2\d\d(\s|$)/.test(text(ps, "status") || "")).map((ps) => text0(ps, "prop"));
		if (!props.length) { continue; }
		const p = props.join("");
		const rt = blocks(p, "resourcetype")[0];
		const size = parseInt(text(p, "getcontentlength") || "", 10);
		out.push({
			href,
			collection: rt !== undefined ? present(rt, "collection") : present(p, "collection"),
			size: Number.isFinite(size) && size >= 0 ? size : 0,
			modified: text(p, "getlastmodified"),
			contentType: text(p, "getcontenttype"),
			etag: text(p, "getetag"),
		});
	}
	return out;
}
// An element's inner XML, undecoded (it holds elements).
function text0(xml, name) { const m = elRe(name).exec(xml || ""); return m ? m[1] : ""; }

// Sabre (Nextcloud, ownCloud) answers errors as <d:error><s:exception/><s:message/></d:error>.
function serverMessage(body) {
	if (!body || !/<\s*[\w.-]*:?error[\s>]/.test(body)) { return null; }
	const m = text(body, "message");
	if (!m) { return null; }
	const one = m.replace(/\s+/g, " ").trim();
	return one.length > 160 ? one.slice(0, 160) + "..." : one;
}

const STATUS_TEXT = {
	400: "the request was refused as malformed",
	401: "the server refused the user name or password",
	403: "the server does not allow this",
	404: "there is nothing there",
	405: "the server does not allow this here",
	409: "a folder on the way is missing",
	412: "something is there already",
	413: "the file is too large for the server",
	415: "the server does not take this",
	423: "it is locked",
	500: "the server failed",
	502: "the server is not reachable behind its proxy",
	503: "the server is unavailable (maintenance?)",
	507: "the server has no space left",
};

// The errorText of a WebDAV error reply.
function describe(status, body) {
	let what;
	if (status >= 300 && status < 400) { what = "the server redirects elsewhere: sign in again with its new address"; }
	else { what = STATUS_TEXT[status] || null; }
	const msg = serverMessage(body);
	return "the WebDAV server answered HTTP " + status + (what ? " (" + what + ")" : "") + (msg ? ": " + msg : "");
}

// --- locators --------------------------------------------------------------------------------

const isRoot = (loc) => loc === undefined || loc === null || loc === "" || loc === "/" || loc === "root";
const badName = (name) => typeof name !== "string" || !name || name === "." || name === ".." || /[/\u0000]/.test(name);

// A locator as "/a/b" or "/a/b/": a leading "/", no empty, "." or ".." segment, no NUL.
// -> null when it is no such thing.
function norm(loc) {
	if (isRoot(loc)) { return "/"; }
	if (typeof loc !== "string") { return null; }
	const folder = loc.endsWith("/");
	const segs = loc.split("/").filter((x) => x !== "");
	if (!segs.length) { return "/"; }
	if (segs.some((x) => x === "." || x === ".." || x.indexOf("\u0000") >= 0)) { return null; }
	return "/" + segs.join("/") + (folder ? "/" : "");
}
const isFolder = (loc) => loc.endsWith("/");
const asFolder = (loc) => (loc.endsWith("/") ? loc : loc + "/");
function leaf(loc) { const s = String(loc).replace(/\/+$/, ""); return s.slice(s.lastIndexOf("/") + 1); }
// "/a/b/c.txt" -> "/a/b/", "/a/b/" -> "/a/", "/c.txt" -> "/".
function parentOf(loc) { const s = String(loc).replace(/\/+$/, ""); return s.slice(0, s.lastIndexOf("/") + 1) || "/"; }
const encodePath = (loc) => loc.split("/").map(encodeURIComponent).join("/");

function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp",
	heic: "image/heic", heif: "image/heif", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", pdf: "application/pdf",
	txt: "text/plain", doc: "application/msword", odt: "application/vnd.oasis.opendocument.text",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
function mimeOf(name) {
	const m = /\.([a-z0-9]+)$/i.exec(name || "");
	return (m && MIME[m[1].toLowerCase()]) || "application/octet-stream";
}

// listFolder's entries.
const folderEntry = (loc, it) => ({ id: loc, type: "folder", name: leaf(loc), size: 0,
	modified: (it && it.modified && Date.parse(it.modified)) || 0, path: loc, mimeType: "application/x-directory" });
const fileEntry = (loc, it) => {
	const t = it && it.contentType && /^[\w.+-]+\/[\w.+-]+/.exec(it.contentType);
	return { id: loc, type: "file", name: leaf(loc), size: (it && it.size) || 0,
		modified: (it && it.modified && Date.parse(it.modified)) || 0, path: loc,
		mimeType: (t && t[0].toLowerCase() !== "application/octet-stream") ? t[0].toLowerCase() : mimeOf(leaf(loc)) };
};

const PROPFIND_BODY = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
	"<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/>" +
	"<d:getcontenttype/><d:getetag/></d:prop></d:propfind>";

const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
function isImage(e) {
	if (!e || e.type !== "file") { return false; }
	if (e.mimeType && /^image\//i.test(e.mimeType)) { return true; }
	return IMAGE_RE.test(e.name || "");
}

// "Basic <base64(user:password)>", UTF-8 (RFC 7617's charset="UTF-8"; Sabre and Apache read it so).
const basic = (user, password) => "Basic " + Buffer.from(user + ":" + password, "utf8").toString("base64");

function createAdapter({ config, http, errors }) {
	const fail = (code, text_, extra) => new errors.CloudError(code, text_, extra);

	// The account's server and sign-in, checked before anything is sent with them.
	function account(s) {
		const c = (s && s.creds) || {};
		if (!c.accessToken || !c.username || !c.server) {
			throw fail("MISSING_CREDENTIALS", "the account has no server, user name or password");
		}
		let u;
		try { u = new URL(c.server); } catch (e) { u = null; }
		if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) {
			throw fail("BAD_ARGS", "the account's server is not an http(s) address");
		}
		return { c, base: u.href.endsWith("/") ? u.href : u.href + "/", basePath: safeDecode(asFolder(u.pathname)) };
	}

	function locOf(loc) {
		const n = norm(loc);
		if (n === null) { throw fail("BAD_ARGS", "not a path in the account: " + String(loc)); }
		return n;
	}
	const urlOf = (a, loc) => a.base + encodePath(loc.slice(1));

	// The locator a response's href names, or null when it is outside the account's folder.
	function hrefLoc(a, href, collection) {
		let u;
		try { u = new URL(href, a.base); } catch (e) { return null; }
		const p = safeDecode(u.pathname);
		if (p === null || a.basePath === null) { return null; }
		const mine = p.startsWith(a.basePath) ? p : (asFolder(p) === a.basePath ? a.basePath : null);
		if (mine === null) { return null; }
		const loc = norm("/" + mine.slice(a.basePath.length));
		if (loc === null) { return null; }
		return collection ? asFolder(loc) : loc.replace(/\/+$/, "") || "/";
	}

	// One request with the account's Basic auth, following no redirect.
	function send(s, { method = "GET", loc, url, headers = {}, body, file, toFile, accept, errorCode, timeoutMs }) {
		const a = account(s);
		return http.request({ method, url: url || urlOf(a, loc), redirect: "manual", accept, body, file, toFile, timeoutMs,
			headers: Object.assign({ Authorization: basic(a.c.username, a.c.accessToken) }, headers),
			errorCode: errorCode || ERROR, describe });
	}

	// PROPFIND -> [{ loc, item }] with every href turned into a locator. A reply that is not a
	// Multi-Status (a login page a proxy answers 200 with, say) fails as one.
	async function propfind(s, loc, depth, code) {
		const a = account(s);
		const r = await send(s, { method: "PROPFIND", loc, body: PROPFIND_BODY, errorCode: code,
			headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" } });
		if (r.status !== 207 || !isMultistatus(r.text)) {
			throw fail(code, "the reply to PROPFIND is not a WebDAV Multi-Status (HTTP " + r.status + ")", { status: r.status });
		}
		const out = [];
		for (const it of parseMultistatus(r.text)) {
			const l = hrefLoc(a, it.href, it.collection);
			if (l !== null) { out.push({ loc: l, item: it }); }
		}
		return out;
	}

	// The one item at loc (Depth 0), or null when there is none (404).
	async function stat(s, loc, code) {
		try {
			const items = await propfind(s, loc, 0, code);
			return items.length ? items[0] : null;
		} catch (e) {
			if (e && e.status === 404) { return null; }
			throw e;
		}
	}
	const entryOf = (loc, it) => (it && it.collection ? folderEntry(asFolder(loc), it) : fileEntry(loc, it));

	async function put(s, loc, localPath, mimeType) {
		if (isFolder(loc)) { throw fail("BAD_ARGS", "a file's path does not end in /"); }
		let st;
		try {
			st = await fsp.stat(localPath);
			if (!st.isFile()) { throw Object.assign(new Error("not a file"), { code: "EISDIR" }); }
		} catch (e) { throw fail("LOCAL_FILE_ERROR", "cannot read " + localPath + ": " + ((e && (e.code || e.message)) || e), { cause: e }); }
		await send(s, { method: "PUT", loc, file: localPath, errorCode: "WEBDAV_UPLOAD_FAILED",
			headers: { "Content-Type": mimeType || mimeOf(leaf(loc)) } });
		return { id: loc, path: loc, name: leaf(loc), size: st.size };
	}

	// MKCOL; a 405 (there is something there) is taken when it is a folder. -> its locator
	async function mkcol(s, loc) {
		try {
			await send(s, { method: "MKCOL", loc, errorCode: "WEBDAV_MKDIR_FAILED" });
		} catch (e) {
			if (!e || e.status !== 405) { throw e; }
			const there = await stat(s, loc, "WEBDAV_MKDIR_FAILED");
			if (!there || !there.item.collection) { throw fail("WEBDAV_EXISTS", leaf(loc) + " is there already and is not a folder", { status: 405 }); }
		}
		return loc;
	}

	const adapter = {
		// A Depth 0 PROPFIND of the account's folder proves the server, the sign-in and the
		// folder; the identity is the user name at the server's host.
		async getAccountInfo(s) {
			const a = account(s);
			const root = await stat(s, "/", "WEBDAV_AUTH_FAILED");
			if (!root) { throw fail("WEBDAV_NOT_FOUND", "there is no folder at " + http_safe(a.base), { status: 404 }); }
			if (!root.item.collection) { throw fail("WEBDAV_NOT_FOUND", http_safe(a.base) + " is not a folder"); }
			return { user: { emailAddress: a.c.username + "@" + new URL(a.base).host, displayName: a.c.username } };
		},

		// A folder's children (Depth 1). A locator that turns out to be a file is refused.
		async listFolder(s, folderId) {
			const loc = asFolder(locOf(folderId));
			const items = await propfind(s, loc, 1, "WEBDAV_LIST_FAILED");
			const self = items.find((x) => asFolder(x.loc) === loc);
			if (self && !self.item.collection) { throw fail("BAD_ARGS", loc + " is a file, not a folder"); }
			const entries = items.filter((x) => x !== self && asFolder(x.loc) !== loc).map((x) => entryOf(x.loc, x.item));
			return { entries };
		},

		// GET to localDest (exportMime is not WebDAV's).
		async downloadFile(s, fileId, localDest) {
			const loc = locOf(fileId);
			if (isFolder(loc)) { throw fail("BAD_ARGS", "a folder cannot be downloaded"); }
			await send(s, { loc, toFile: localDest, errorCode: "WEBDAV_DOWNLOAD_FAILED" });
			return { path: localDest };
		},

		uploadFile(s, folderId, localPath, name, mimeType) {
			if (badName(name)) { throw fail("BAD_ARGS", "name: one path component"); }
			return put(s, asFolder(locOf(folderId)) + name, localPath, mimeType);
		},

		// Overwrite the file at fileId (a save-back).
		uploadReplace(s, fileId, localPath, mimeType) { return put(s, locOf(fileId), localPath, mimeType); },

		async createFolder(s, parent, name) {
			if (badName(name)) { throw fail("BAD_ARGS", "name: one path component"); }
			const loc = await mkcol(s, asFolder(locOf(parent)) + name + "/");
			return { entry: folderEntry(loc) };
		},

		// Rename (name), move (toFolder) or both, in one MOVE. An existing destination is refused.
		async moveItem(s, item, toFolder, name) {
			const a = account(s);
			const loc = locOf(item);
			if (loc === "/") { throw fail("BAD_ARGS", "the root folder cannot be moved"); }
			const folder = isFolder(loc);
			const newName = (name === null || name === undefined) ? leaf(loc) : name;
			if (badName(newName)) { throw fail("BAD_ARGS", "name: one path component"); }
			const dest = (toFolder === null || toFolder === undefined ? parentOf(loc) : asFolder(locOf(toFolder))) + newName + (folder ? "/" : "");
			if (dest !== loc) {
				if (folder && dest.startsWith(loc)) { throw fail("BAD_ARGS", "a folder cannot move into itself"); }
				try {
					await send(s, { method: "MOVE", loc, errorCode: "WEBDAV_MOVE_FAILED",
						headers: { Destination: urlOf(a, dest), Overwrite: "F" } });
				} catch (e) {
					if (e && e.status === 412) { throw fail("WEBDAV_DESTINATION_EXISTS", dest + " already exists", { status: 412 }); }
					throw e;
				}
			}
			// The moved item's own properties, for its entry; the move is done whatever they say.
			let there = null;
			try { there = await stat(s, dest, "WEBDAV_LIST_FAILED"); } catch (e) { there = null; }
			return { entry: there ? entryOf(dest, there.item) : (folder ? folderEntry(dest) : fileEntry(dest)) };
		},

		// DELETE; a folder goes with everything in it. One that is not there is deleted already.
		async deleteItem(s, item) {
			const loc = locOf(item);
			if (loc === "/") { throw fail("BAD_ARGS", "the root folder cannot be deleted"); }
			await send(s, { method: "DELETE", loc, accept: [404], errorCode: "WEBDAV_DELETE_FAILED" });
			return {};
		},

		// --- Photos ------------------------------------------------------------------------
		// The folder Photos reads ("/Photos/" unless the account names another).
		photoFolder(s) {
			const c = account(s).c;
			const f = norm(c.photoFolder || ("/" + (config.PHOTO_FOLDER || "Photos") + "/"));
			return f === null ? "/" : asFolder(f);
		},

		// The albums: the photo folder itself when it holds images, then each folder in it that
		// does (sorted by name, at most PHOTO_MAX_ALBUMS looked at). -> [{ aid, name, images }]
		// A photo folder that is not there is no albums; one album that cannot be listed is left out.
		async photoAlbums(s, log = console) {
			const top = adapter.photoFolder(s);
			let entries;
			try { entries = (await adapter.listFolder(s, top)).entries; }
			catch (e) { if (e && e.status === 404) { return []; } throw e; }
			const albums = [];
			const here = entries.filter(isImage).length;
			if (here) { albums.push({ aid: top, name: top === "/" ? (config.DISPLAY_NAME || "WebDAV") : leaf(top), images: here }); }
			const folders = entries.filter((e) => e.type === "folder").sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
				.slice(0, config.PHOTO_MAX_ALBUMS || 50);
			for (const f of folders) {
				try {
					const n = (await adapter.listFolder(s, f.id)).entries.filter(isImage).length;
					if (n) { albums.push({ aid: f.id, name: f.name, images: n }); }
				} catch (e) { log.log("webdav: album " + f.id + " unavailable: " + ((e && (e.status || e.errorCode)) || e)); }
			}
			return albums;
		},

		// The upload's album folder, "<photo folder><name>/", made (with the photo folder) if need be.
		async ensureAlbumFolder(s, name) {
			if (badName(name)) { throw fail("BAD_ARGS", "name: one path component"); }
			const top = adapter.photoFolder(s);
			if (top !== "/") { await mkcol(s, top); }
			return mkcol(s, top + name + "/");
		},

		// A photo to a local file, for listPhotos' file:// links.
		async photoToLocal(s, fileId, localDest) { return adapter.downloadFile(s, fileId, localDest); },

		async deletePhoto(s, fileId) {
			const loc = locOf(fileId);
			if (isFolder(loc)) { throw fail("BAD_ARGS", "a photo is a file"); }
			await adapter.deleteItem(s, loc);
			return { deleted: true };
		},
	};
	return adapter;
}

// An address as it may appear in an error: no query (none is ever sent, but all the same).
function http_safe(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return "?"; } }

module.exports = Object.assign(createAdapter, { ERROR, describe, parseMultistatus, isMultistatus, serverMessage, decode,
	norm, leaf, parentOf, encodePath, mimeOf, isImage, basic, PROPFIND_BODY, IMAGE_RE });
