/* adapter.js - STRATO HiDrive REST 2.1 for _cloudcore/node (commands.js there has the interface).
 *
 * HiDrive is path based: a node is addressed by its absolute path under the account home
 * ("/users/<user>/Folder/file.docx"), which listFolder hands out as each entry's id and path.
 * The root locator "home" (Config.ROOT_FOLDER, and what the generic commands use when given no
 * folder) is the account home, read from GET /user/me and kept per access token. HiDrive
 * answers names and paths URL-encoded ("a%20b.pdf"); they are decoded on the way in, so a
 * locator is a plain path and is encoded exactly once when it goes into a URL.
 *
 * Every call runs through the session (s.authorized): "Authorization: Bearer <token>", one
 * refresh and retry on a 401 (the refresh sends Config.CLIENT_SECRET: HiDrive's native apps are
 * confidential clients). A reply outside 2xx is HIDRIVE_API_ERROR with its status and body,
 * except where the old adapter had its own code: HIDRIVE_DOWNLOAD_FAILED (GET /file),
 * HIDRIVE_MKDIR_FAILED (the album folder) and HIDRIVE_DELETE_FAILED (deletePhoto).
 *
 * The file operations (https://api.hidrive.strato.com/2.1/static/apidoc/api.json):
 *   POST /dir?path=                        create (201, the new dir's metadata)
 *   POST /file|dir/rename?path=&name=      rename in place
 *   POST /file|dir/move?src=&dst=          move, dst = the object's NEW full path
 *   DELETE /file?path= | /dir?path=&recursive=true
 * A path does not say whether it is a file or a directory and those endpoints are per type, so
 * moveItem and deleteItem ask GET /meta?path=&fields=type first. No on_exist is sent: a name
 * that is taken fails with 409 instead of overwriting or renaming. There is no trash in the 2.1
 * API: deleteItem deletes for good.
 */
"use strict";

const ERROR = "HIDRIVE_API_ERROR";
const HOME = "home";
const MAX_PAGES = 40;          // listFolder: at most this many LIST_LIMIT pages
const HOME_CACHE_MAX = 32;

const enc = (p) => encodeURIComponent(p);

// HiDrive's URL-encoded names and paths, decoded ("" for none; as is when not valid encoding).
function dec(p) {
	const s = String(p === undefined || p === null ? "" : p);
	try { return decodeURIComponent(s); } catch (e) { return s; }
}

function leaf(p) {
	const s = String(p === undefined || p === null ? "" : p).replace(/\/+$/, "");
	const i = s.lastIndexOf("/");
	return i >= 0 ? s.substring(i + 1) : s;
}

function dirOf(p) {
	const s = String(p).replace(/\/+$/, "");
	const i = s.lastIndexOf("/");
	return i > 0 ? s.substring(0, i) : "/";
}

// dir + "/" + name, without doubling a slash on either side.
function child(dir, name) { return String(dir).replace(/\/+$/, "") + "/" + String(name).replace(/^\/+/, ""); }

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
	bmp: "image/bmp", heic: "image/heic", webp: "image/webp", pdf: "application/pdf" };

function mimeOf(name, isFolder) {
	if (isFolder) { return "application/x-directory"; }
	const m = /\.([a-z0-9]+)$/i.exec(name || "");
	return MIME[m ? m[1].toLowerCase() : ""] || null;
}

// One HiDrive member/meta object -> the listFolder entry (id = the decoded path).
function entry(m) {
	const isFolder = m.type === "dir";
	const name = dec(m.name), p = dec(m.path);
	return { id: p, type: isFolder ? "folder" : "file", name, size: m.size || 0,
		modified: m.mtime ? m.mtime * 1000 : 0, path: p, mimeType: mimeOf(name, isFolder) };
}

// The entry of an operation's metadata reply; the path the call addressed where it has none.
function opEntry(m, p) {
	const e = entry(m || {});
	if (!m || !m.path) { e.id = e.path = p; }
	if (!m || !m.name) { e.name = leaf(e.path); e.mimeType = mimeOf(e.name, e.type === "folder"); }
	return { entry: e };
}

// The errorText of a HiDrive error reply ({ code, msg }): its msg where it has one.
function describe(status, body) {
	let msg = "";
	try { const j = JSON.parse(body); msg = (j && typeof j.msg === "string") ? j.msg : ""; }
	catch (e) { msg = String(body || "").replace(/\s+/g, " ").trim(); }
	return "HiDrive answered HTTP " + status + (msg ? ": " + msg.slice(0, 200) : "");
}

function createAdapter({ config, http }) {
	const API = config.API_BASE;
	const homes = new Map();   // access token -> home path

	// An authorized request whose reply is JSON ({} when empty).
	const api = (s, method, url, extra) => s.authorized((token) =>
		http.json(Object.assign({ method, url, bearer: token }, extra || {})));

	async function ensureHome(s) {
		const cached = homes.get(s.accessToken);
		if (cached) { return cached; }
		await adapter.getAccountInfo(s);
		return homes.get(s.accessToken) || "/";
	}

	// A folder locator -> its path: the root ("" or "home") is the home; a Photos album id
	// (listAlbums hands out the path URL-encoded, "%2Fusers%2F...") is decoded back.
	async function resolve(s, folderId) {
		if (!folderId || folderId === HOME || folderId === config.ROOT_FOLDER) { return ensureHome(s); }
		const f = String(folderId);
		return /^%2F/i.test(f) ? dec(f) : f;
	}

	// "dir" or "file" (a symlink is handled through the /file endpoints).
	async function kind(s, p) {
		const m = await api(s, "GET", API + "/meta?path=" + enc(p) + "&fields=type");
		return (m && m.type === "dir") ? "dir" : "file";
	}

	// PUT /file?dir=&name= creates or overwrites the file with the local bytes.
	async function put(s, dir, name, localPath) {
		const meta = (await api(s, "PUT", API + "/file?dir=" + enc(dir) + "&name=" + enc(name),
			{ file: localPath, headers: { "Content-Type": "application/octet-stream" } })) || {};
		const p = meta.path ? dec(meta.path) : child(dir, name);
		return { id: p, path: p, name: meta.name ? dec(meta.name) : name, size: meta.size };
	}

	const adapter = {
		// GET /user/me -> { user:{ emailAddress, displayName } }; the home path is kept.
		async getAccountInfo(s) {
			const u = (await api(s, "GET", API + config.USER_INFO_PATH)) || {};
			if (u.home) {
				if (homes.size >= HOME_CACHE_MAX) { homes.clear(); }
				homes.set(s.accessToken, String(u.home));
			}
			return { user: { emailAddress: u.email || u.account, displayName: u.alias || u.descr || u.email } };
		},

		ensureHome,

		// GET /dir?path=&members=all&fields=members.* -> entries, LIST_LIMIT at a time
		// (limit=offset,count), until a page comes back short. HiDrive's `fields` describe the
		// directory itself; its children's fields are the members.<field> ones.
		async listFolder(s, folderId) {
			const p = await resolve(s, folderId);
			const size = config.LIST_LIMIT || 5000;
			const entries = [];
			for (let page = 0; page < MAX_PAGES; page++) {
				const res = (await api(s, "GET", API + "/dir?path=" + enc(p) +
					"&members=all&fields=members.name,members.type,members.size,members.mtime,members.path,members.id" +
					"&limit=" + (page * size) + "," + size)) || {};
				const members = Array.isArray(res.members) ? res.members : [];
				entries.push(...members.map(entry));
				if (members.length < size) { break; }
			}
			return { entries };
		},

		// GET /file?path= -> the bytes to localDest. exportMime is not HiDrive's.
		async downloadFile(s, fileId, localDest) {
			await s.authorized((token) => http.request({ method: "GET", url: API + "/file?path=" + enc(fileId),
				bearer: token, toFile: localDest, errorCode: "HIDRIVE_DOWNLOAD_FAILED" }));
			return { path: localDest };
		},

		// A new file at folder/name (an existing one of that name is overwritten, as before).
		async uploadFile(s, folderId, localPath, name) {
			return put(s, await resolve(s, folderId), String(name).replace(/^\/+/, ""), localPath);
		},

		// Overwrite the file at fileId (a save-back): its folder and its name.
		uploadReplace(s, fileId, localPath) { return put(s, dirOf(fileId), leaf(fileId), localPath); },

		async createFolder(s, parent, name) {
			const p = child(await resolve(s, parent), name);
			return opEntry(await api(s, "POST", API + "/dir?path=" + enc(p)), p);
		},

		// toFolder null = rename in place; name null = keep the name; both = one move.
		async moveItem(s, item, toFolder, name) {
			const k = await kind(s, item);
			if (toFolder === null || toFolder === undefined || toFolder === "") {
				const m = await api(s, "POST", API + "/" + k + "/rename?path=" + enc(item) + "&name=" + enc(name));
				return opEntry(m, child(dirOf(item), name));
			}
			const dst = child(await resolve(s, toFolder), (name === null || name === undefined) ? leaf(item) : name);
			return opEntry(await api(s, "POST", API + "/" + k + "/move?src=" + enc(item) + "&dst=" + enc(dst)), dst);
		},

		// For good: a file through DELETE /file, a directory with its contents through DELETE /dir.
		async deleteItem(s, item) {
			const k = await kind(s, item);
			await api(s, "DELETE", API + "/" + k + "?path=" + enc(item) + (k === "dir" ? "&recursive=true" : ""));
			return {};
		},

		// --- Photos (photos.js, and the generic upload/deletePhoto) ----------------------------

		// The albums: the home's own images, then each immediate sub-folder holding images, as
		// [{ aid: path, name, images }]. A folder that cannot be listed counts as empty; only the
		// home itself not being found (GET /user/me failing) throws.
		async photoAlbums(s, isImage) {
			const home = await ensureHome(s);
			const list = async (p) => {
				try { return (await adapter.listFolder(s, p)).entries; } catch (e) { return []; }
			};
			const albums = [];
			const top = await list(home);
			const homeImages = top.filter(isImage).length;
			if (homeImages) { albums.push({ aid: home, name: "HiDrive", images: homeImages }); }
			for (const f of top.filter((e) => e.type === "folder")) {
				const n = (await list(f.id)).filter(isImage).length;
				if (n) { albums.push({ aid: f.id, name: f.name, images: n }); }
			}
			return albums;
		},

		// The upload folder when the Photos service names none: home/<name>, made when missing
		// (201, or 409 when it is there already).
		async ensureAlbumFolder(s, name) {
			const p = child(await ensureHome(s), String(name).replace(/^\/+|\/+$/g, ""));
			await s.authorized((token) => http.request({ method: "POST", url: API + "/dir?path=" + enc(p),
				bearer: token, accept: [409], errorCode: "HIDRIVE_MKDIR_FAILED" }));
			return p;
		},

		// A "/file?path=..&access_token=.." URL the Photos service can fetch without a header
		// (HiDrive takes the token as a query parameter; see ../README.md). No request.
		getTemporaryLink(s, fileId) {
			return { link: API + "/file?path=" + enc(fileId) + "&access_token=" + enc(s.accessToken), method: "GET" };
		},

		// DELETE /file?path= (the Photos delete button; pid is listPhotos' path).
		async deletePhoto(s, fileId) {
			await s.authorized((token) => http.request({ method: "DELETE", url: API + "/file?path=" + enc(fileId),
				bearer: token, errorCode: "HIDRIVE_DELETE_FAILED" }));
			return { deleted: true };
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, HOME, describe, entry, dec, leaf, dirOf, child, mimeOf, MAX_PAGES });
