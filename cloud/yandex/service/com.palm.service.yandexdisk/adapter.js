/* adapter.js - Yandex Disk REST v1 for _cloudcore/node (commands.js there has the interface).
 *
 * Yandex Disk is path based: a resource is "disk:/Folder/file.docx", which listFolder hands out
 * as each entry's id and path. The root is "disk:/" ("", "/" and "root" mean it too); a bare
 * "Folder/x" or "/Folder/x" is taken as "disk:/Folder/x", and "app:/", "trash:/" paths pass as
 * they are. Every API request sends "Authorization: OAuth <token>" (not Bearer) through the
 * session (s.authorized: one refresh and retry on a 401). Downloads and uploads are two steps:
 * the API gives a short-lived signed href, which is fetched without the token.
 *
 * A reply outside 2xx is YANDEX_API_ERROR with its status and body; the steps that had their
 * own codes keep them: YANDEX_NO_DOWNLOAD_HREF / YANDEX_DOWNLOAD_FAILED,
 * YANDEX_NO_UPLOAD_HREF / YANDEX_UPLOAD_FAILED, YANDEX_MKDIR_FAILED (the album folder),
 * YANDEX_DELETE_FAILED (deletePhoto), and for operations YANDEX_BAD_OPERATION,
 * YANDEX_OPERATION_FAILED and YANDEX_OPERATION_TIMEOUT.
 *
 * The file operations (https://yandex.com/dev/disk-api/doc/en/reference/):
 *   PUT    /resources?path=                                 create a folder (201, a Link)
 *   POST   /resources/move?from=&path=&overwrite=false      move and/or rename, path = the NEW
 *          full path; never over an existing item (409)
 *   DELETE /resources?path=                                 to the Trash (no permanently=true)
 * Any of them may answer 202 with a Link to an asynchronous operation (a large folder): it is
 * polled - on the API host only, as it gets the token - until "success" or "failed", at most
 * adapter.POLL_TRIES times, adapter.sleep(POLL_DELAY_MS) apart (tests replace sleep). create and
 * move answer only a Link, so the new entry is read back with GET /resources?path=&limit=0.
 */
"use strict";

const ERROR = "YANDEX_API_ERROR";
const POLL_TRIES = 30;
const POLL_DELAY_MS = 1000;
const MAX_PAGES = 100;   // listFolder: at most this many LIST_LIMIT pages

const enc = (p) => encodeURIComponent(p);

// The parent folder of "disk:/a/b" ("disk:/a"; "disk:/" for a top-level item).
function parentOf(p) {
	const s = String(p).replace(/\/+$/, "");
	const i = s.lastIndexOf("/");
	const d = i >= 0 ? s.substring(0, i) : "";
	return (!d || d.charAt(d.length - 1) === ":") ? d + "/" : d;
}

// The last path component, as it is (Disk paths are not URL-encoded).
function base(p) {
	const s = String(p).replace(/\/+$/, "");
	return s.substring(s.lastIndexOf("/") + 1);
}

// The last component, URL-decoded, as a human album name ("disk:/Фотокамера/" -> "Фотокамера").
function leafName(p) {
	const seg = base(p);
	try { return decodeURIComponent(seg); } catch (e) { return seg; }
}

// One Yandex Resource -> the listFolder entry (id = path).
function entry(e) {
	return { id: e.path, type: e.type === "dir" ? "folder" : "file", name: e.name, size: e.size,
		modified: e.modified, path: e.path, mimeType: e.mime_type };
}

// The errorText of a Yandex error reply ({ message, description, error }).
function describe(status, body) {
	let why = "";
	try {
		const j = JSON.parse(body);
		if (j && typeof j === "object") { why = [j.error, j.description || j.message].filter((x) => typeof x === "string" && x).join(": "); }
	} catch (e) { why = String(body || "").replace(/\s+/g, " ").trim(); }
	return "Yandex Disk answered HTTP " + status + (why ? ": " + why.slice(0, 200) : "");
}

function createAdapter({ config, http, errors }) {
	const API = config.API_BASE;
	const ROOT = config.ROOT_FOLDER || config.ROOT_PATH || "disk:/";
	const ORIGIN = new URL(API).origin + "/";
	const fail = (code, text, extra) => new errors.CloudError(code, text, extra);

	function normPath(p) {
		if (!p || p === "/" || p === "root" || p === ROOT || p === config.ROOT_PATH) { return ROOT; }
		const s = String(p);
		if (s.indexOf("disk:/") === 0 || s.indexOf("app:/") === 0 || s.indexOf("trash:/") === 0) { return s; }
		return "disk:/" + s.replace(/^\/+/, "");
	}

	function join(folder, name) {
		const b = normPath(folder);
		return (b.endsWith("/") ? b : b + "/") + String(name).replace(/^\/+/, "");
	}

	// An API request with the token. -> { status, body } (body parsed, {} when empty).
	async function call(s, method, url, extra) {
		const r = await s.authorized((token) => http.request(Object.assign({ method, url,
			headers: { Authorization: "OAuth " + token } }, extra || {})));
		if (!r.text) { return { status: r.status, body: {} }; }
		try { return { status: r.status, body: JSON.parse(r.text) }; }
		catch (e) { throw fail(ERROR, method + " " + new URL(url).pathname + ": the reply is not JSON", { status: r.status }); }
	}

	// The href of a /resources/download or /resources/upload reply.
	async function href(s, step, p, query, noHref) {
		const { body } = await call(s, "GET", API + "/resources/" + step + "?path=" + enc(p) + (query || ""));
		if (!body || typeof body.href !== "string" || !body.href) { throw fail(noHref, "Yandex Disk gave no " + step + " link for " + p); }
		return body;
	}

	// A 202's operation, polled to its end; anything else is done already.
	async function settle(s, r) {
		if (r.status !== 202) { return; }
		const op = r.body && r.body.href;
		if (typeof op !== "string" || op.indexOf(ORIGIN) !== 0) {
			throw fail("YANDEX_BAD_OPERATION", "the operation link is not on " + ORIGIN);
		}
		for (let n = 0; ; n++) {
			const st = ((await call(s, "GET", op)).body || {}).status;
			if (st === "success") { return; }
			if (st === "failed") { throw fail("YANDEX_OPERATION_FAILED", "Yandex Disk could not finish the operation"); }
			if (n + 1 >= adapter.POLL_TRIES) {
				throw fail("YANDEX_OPERATION_TIMEOUT", "the operation was still " + String(st) + " after " + adapter.POLL_TRIES + " polls");
			}
			await adapter.sleep(adapter.POLL_DELAY_MS);
		}
	}

	async function entryAt(s, p) {
		const { body } = await call(s, "GET", API + "/resources?path=" + enc(p) + "&limit=0");
		return { entry: entry(body || {}) };
	}

	// Two steps: the upload href (overwrite true|false), then the file PUT to it without the token.
	async function upload(s, dest, localPath, overwrite) {
		const link = await href(s, "upload", dest, "&overwrite=" + (overwrite ? "true" : "false"), "YANDEX_NO_UPLOAD_HREF");
		await http.request({ method: link.method || "PUT", url: link.href, file: localPath,
			headers: { "Content-Type": "application/octet-stream" }, errorCode: "YANDEX_UPLOAD_FAILED" });
		return { id: dest, path: dest, name: base(dest) };
	}

	const adapter = {
		POLL_TRIES,
		POLL_DELAY_MS,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		normPath,
		join,

		// GET login.yandex.ru/info -> { user:{ emailAddress, displayName } }.
		async getAccountInfo(s) {
			const u = (await call(s, "GET", config.LOGIN_INFO_URL)).body || {};
			return { user: { emailAddress: u.default_email || u.login, displayName: u.display_name || u.real_name } };
		},

		// GET /resources?path=&limit= -> entries, every page (&offset=) up to _embedded.total.
		async listFolder(s, folderId) {
			const p = normPath(folderId);
			const size = config.LIST_LIMIT || 200;
			const entries = [];
			for (let page = 0; page < MAX_PAGES; page++) {
				const { body } = await call(s, "GET", API + "/resources?path=" + enc(p) + "&limit=" + size +
					(page ? "&offset=" + (page * size) : ""));
				const emb = (body && body._embedded) || {};
				const items = Array.isArray(emb.items) ? emb.items : [];
				entries.push(...items.map(entry));
				if (items.length < size || !(typeof emb.total === "number" && emb.total > entries.length)) { break; }
			}
			return { entries };
		},

		// The signed href of GET /resources/download, then its bytes to localDest.
		async downloadFile(s, fileId, localDest) {
			const link = await href(s, "download", normPath(fileId), "", "YANDEX_NO_DOWNLOAD_HREF");
			await http.request({ method: link.method || "GET", url: link.href, toFile: localDest, errorCode: "YANDEX_DOWNLOAD_FAILED" });
			return { path: localDest };
		},

		// A new file at folder/name, never over an existing one (overwrite=false: a 409).
		uploadFile(s, folderId, localPath, name) { return upload(s, join(folderId, name), localPath, false); },

		// Overwrite the file at fileId (a save-back).
		uploadReplace(s, fileId, localPath) { return upload(s, normPath(fileId), localPath, true); },

		async createFolder(s, parent, name) {
			const p = join(parent, name);
			await settle(s, await call(s, "PUT", API + "/resources?path=" + enc(p)));
			return entryAt(s, p);
		},

		// toFolder null = rename in place; name null = keep the name; both = one move.
		async moveItem(s, item, toFolder, name) {
			const from = normPath(item);
			const dst = join(toFolder ? toFolder : parentOf(from), (name === null || name === undefined) ? base(from) : name);
			await settle(s, await call(s, "POST", API + "/resources/move?from=" + enc(from) + "&path=" + enc(dst) + "&overwrite=false"));
			return entryAt(s, dst);
		},

		// To the Trash (deletePhoto is the one that deletes for good).
		async deleteItem(s, item) {
			await settle(s, await call(s, "DELETE", API + "/resources?path=" + enc(normPath(item))));
			return {};
		},

		// --- Photos (photos.js, and the generic upload/deletePhoto) ----------------------------

		// The signed download href of a photo, for the Photos service: { link, method }.
		async getTemporaryLink(s, fileId) {
			const link = await href(s, "download", normPath(fileId), "", "YANDEX_NO_DOWNLOAD_HREF");
			return { link: link.href, method: link.method || "GET" };
		},

		// GET /v1/disk?fields=system_folders -> the server's localised system folders
		// (photostream = camera uploads); {} when it cannot be had (disk.info not granted).
		async getSystemFolders(s) {
			try { return ((await call(s, "GET", API + "?fields=" + enc("system_folders"))).body || {}).system_folders || {}; }
			catch (e) { return {}; }
		},

		// The album: Yandex's own camera-uploads folder (system_folders.photostream) when it is
		// there, else disk:/<PHOTO_ALBUM_NAME>. Never fails. -> { path, name, exists }
		async resolvePhotoAlbum(s) {
			const fbName = config.PHOTO_ALBUM_NAME || "Pictures";
			const fallback = { path: "disk:/" + fbName, name: fbName, exists: false };
			const ps = (await adapter.getSystemFolders(s)).photostream;
			if (!ps) { return fallback; }
			const p = String(ps).replace(/\/+$/, "");
			try { await call(s, "GET", API + "/resources?path=" + enc(p) + "&limit=0"); }
			catch (e) { return fallback; }
			return { path: p, name: leafName(p), exists: true };
		},

		// PUT /resources?path=disk:/<name>: the upload folder when the Photos service names none.
		// 201, or 409 when it is there already.
		async ensureAlbumFolder(s, name) {
			const p = normPath(name);
			await s.authorized((token) => http.request({ method: "PUT", url: API + "/resources?path=" + enc(p),
				headers: { Authorization: "OAuth " + token }, accept: [409], errorCode: "YANDEX_MKDIR_FAILED" }));
			return p;
		},

		// DELETE /resources?path=&permanently=true (the Photos delete button); any 2xx, a 202
		// (scheduled) too, is done.
		async deletePhoto(s, fileId) {
			await s.authorized((token) => http.request({ method: "DELETE",
				url: API + "/resources?path=" + enc(normPath(fileId)) + "&permanently=true",
				headers: { Authorization: "OAuth " + token }, errorCode: "YANDEX_DELETE_FAILED" }));
			return { deleted: true };
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, POLL_TRIES, POLL_DELAY_MS, MAX_PAGES, describe, entry, parentOf, base, leafName });
