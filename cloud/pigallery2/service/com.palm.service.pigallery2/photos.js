/* photos.js - PiGallery2 as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (the
 * service name derived from the templateId), and downloads the photos itself from the URLs
 * listPhotos gives. It calls with no app id, so both are open, as the stock providers' are;
 * the bus role decides who reaches the service.
 *
 * PiGallery2 is folders. Every folder with photos in it, or in a folder below it, is an album;
 * the folder it is in is its parent:
 *   listAlbums { accountId }      -> { albums:[{ aid, name, size:{ images }, parentAid? }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image",
 *                                     fileName, createdTime }], headers?:{ Cookie } }
 * aid is the folder's path in the gallery ("Holidays/2025 Italy"), and "/" for the gallery's
 * top folder, which is an album (Config.ROOT_ALBUM_NAME) only when it has photos itself; the
 * folders in it are top-level albums, not its sub-albums. An album's count is its own photos;
 * one with none of its own is there for its sub-albums. pid is the photo's path.
 *
 * src_big is the original where it is a type the Photos app shows (Config.ORIGINAL_EXTENSIONS),
 * else PiGallery2's Config.THUMB_BIG px thumbnail; src_small its Config.THUMB_SMALL one. The links
 * need the session: listPhotos hands its cookie over as `headers`, which the Photos service sends
 * with this listing's downloads and keeps nowhere. Videos are left out.
 *
 * A folder that cannot be read fails the call, so the Photos service keeps what it has rather
 * than taking an unread folder as emptied; a folder that is gone (404) is just not there.
 */
"use strict";

const TIMEOUT_MS = 300000;

const str = (v) => (typeof v === "string" ? v : "");
const extOf = (name) => { const m = /\.([^./]+)$/.exec(name); return m ? m[1].toLowerCase() : ""; };

// "./" + "Family" -> "Family"; "Holidays/" + "2025 Italy" -> "Holidays/2025 Italy".
function joinPath(dirPath, name) {
	const parts = (str(dirPath) + "/" + str(name)).split("/").filter((s) => s && s !== ".");
	return parts.includes("..") ? null : parts.join("/");
}

// An aid as listAlbums gave it -> the folder's path ("" for the top); null when it is no aid.
function folderOf(aid) {
	if (aid === "/") { return ""; }
	if (typeof aid !== "string" || !aid || aid.startsWith("/") || aid.endsWith("/")) { return null; }
	const parts = aid.split("/");
	return parts.some((s) => !s || s === "." || s === "..") ? null : aid;
}

// A listing's media entry that is a photo: a name, and not a video by its metadata or extension.
function isPhoto(config, m) {
	if (!m || typeof m !== "object" || !str(m.n) || m.n.includes("/")) { return false; }
	const meta = m.m && typeof m.m === "object" ? m.m : {};
	if (meta.bitRate !== undefined || meta.duration !== undefined) { return false; }
	return !config.VIDEO_EXTENSIONS.includes(extOf(m.n));
}

// A photo of folder `dir` -> the Photos service's entry.
function toPhotoEntry(config, adapter, server, dir, m) {
	const name = m.n;
	const file = dir ? dir + "/" + name : name;
	const original = config.ORIGINAL_EXTENSIONS.includes(extOf(name));
	const meta = m.m && typeof m.m === "object" ? m.m : {};
	const entry = { pid: file,
		src_big: adapter.fileUrl(server, file, original ? null : config.THUMB_BIG),
		src_small: adapter.fileUrl(server, file, config.THUMB_SMALL),
		caption: str(meta.a), type: "image",
		fileName: original ? name : name.replace(/\.[^./]*$/, "") + ".jpg" };
	if (Number.isFinite(meta.t) && meta.t > 0) { entry.createdTime = Math.floor(meta.t); }
	return entry;
}

function photoMethods({ config, adapter, resolve, CloudError, log = console }) {
	// Every folder from the top, Config.CONCURRENCY at a time, at most Config.MAX_ALBUMS:
	// Map path -> { name, parent, images (its own photos), children:[path] }.
	async function folderTree(creds) {
		return adapter.withSession(creds, async (cookie) => {
			const folders = new Map();
			let capped = false;
			const queue = [{ path: "", parent: null, name: "" }];
			let active = 0, failure = null;
			await new Promise((resolveAll) => {
				const pump = () => {
					if (failure) { if (!active) { resolveAll(); } return; }
					while (queue.length && active < config.CONCURRENCY) {
						if (folders.size >= config.MAX_ALBUMS) { capped = true; queue.length = 0; break; }
						const f = queue.shift();
						folders.set(f.path, { name: f.name, parent: f.parent, images: 0, children: [] });
						active++;
						adapter.directory(creds.server, cookie, f.path).then((d) => {
							const me = folders.get(f.path);
							if (!d) { folders.delete(f.path); return; }   // gone since its parent was listed
							me.images = (Array.isArray(d.media) ? d.media : []).filter((m) => isPhoto(config, m)).length;
							for (const sub of Array.isArray(d.directories) ? d.directories : []) {
								const p = sub && joinPath(sub.path, sub.name);
								if (!p || p === f.path || folders.has(p) || queue.some((q) => q.path === p)) { continue; }
								me.children.push(p);
								queue.push({ path: p, parent: f.path, name: str(sub.name) || p.split("/").pop() });
							}
						}, (e) => { failure = failure || e; }).finally(() => { active--; pump(); });
					}
					if (!active && !queue.length) { resolveAll(); }
				};
				pump();
			});
			if (failure) { throw failure; }
			if (!folders.has("")) {
				throw new Error("the gallery's top folder is not there");
			}
			if (capped) { log.log("pigallery2: listAlbums - more than " + config.MAX_ALBUMS + " folders, the rest left out"); }
			return folders;
		});
	}

	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const creds = await resolve(p);
			const folders = await folderTree(creds);
			// Photos in a folder or below it: a folder with none is left out, and so are its sub-folders.
			const total = new Map();
			const count = (path) => {
				if (total.has(path)) { return total.get(path); }
				total.set(path, 0);   // a loop counts nothing twice
				const f = folders.get(path);
				const n = f.images + f.children.filter((c) => folders.has(c)).reduce((s, c) => s + count(c), 0);
				total.set(path, n);
				return n;
			};
			const albums = [];
			const top = folders.get("");
			if (top.images > 0) { albums.push({ aid: "/", name: config.ROOT_ALBUM_NAME, size: { images: top.images } }); }
			for (const [path, f] of folders) {
				if (path === "" || count(path) === 0) { continue; }
				const a = { aid: path, name: f.name || path.split("/").pop(), size: { images: f.images } };
				if (f.parent) { a.parentAid = f.parent; }
				albums.push(a);
			}
			return { albums };
		} },

		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const dir = folderOf(p.aid);
			if (dir === null) { throw new CloudError("BAD_ARGS", "aid: a PiGallery2 folder"); }
			const creds = await resolve(p);
			return adapter.withSession(creds, async (cookie) => {
				const d = await adapter.directory(creds.server, cookie, dir);
				if (!d) { log.log("pigallery2: listPhotos - the folder is gone"); return { photos: [] }; }
				const photos = (Array.isArray(d.media) ? d.media : []).filter((m) => isPhoto(config, m))
					.map((m) => toPhotoEntry(config, adapter, creds.server, dir, m));
				return cookie ? { photos, headers: { Cookie: cookie } } : { photos };
			});
		} },
	};
}

module.exports = Object.assign(photoMethods, { isPhoto, toPhotoEntry, joinPath, folderOf, extOf });
