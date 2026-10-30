/* photos.js - a WebDAV folder as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js) and copies the photos from the links
 * listPhotos gives. It calls with no app id, so both are open, as the stock providers' are; the
 * bus role decides who reaches the service. upload and deletePhoto are the generic ones
 * (_cloudcore/node/commands.js), with ensureAlbumFolder making "<photo folder>/Camera Uploads/".
 *
 *   listAlbums { accountId }      -> { albums:[{ aid:<folder locator>, name, size:{ images } }] }
 *     The photo folder ("/Photos/" unless the account names another) when it holds images,
 *     then every folder in it that does (adapter.photoAlbums). With none at all (or a folder
 *     that cannot be read), one empty album named PHOTO_ALBUM_NAME with aid "", so the source
 *     still shows in Photos; the first upload makes it.
 *   listPhotos { accountId, aid, have? } -> { photos:[{ pid, src_big, src_small, caption, type:"image",
 *                                           fileName, temporary }] }
 *     The Photos service fetches photo URLs with no header, and WebDAV wants the password on
 *     every request (a URL with user:password@ in it is refused by fetch, and would put the
 *     password in the Photos service's hands). So each image is downloaded to
 *     PHOTO_TMP_DIR/<aid>/ first and the links are file:// paths, as cloud/mega's are; each is
 *     temporary:true, which tells the Photos service to remove it once it has its own copy.
 *     `have` lists the pids the caller has already: those are not downloaded, their copy is
 *     removed, and their link names a file that is not there. Copies of images the album no
 *     longer has go too, and listAlbums removes the folders of albums that are gone. An image
 *     that cannot be had is left out, and so is every one after PHOTO_FETCH_BUDGET_MS: the
 *     next sync fetches them. The listing failing fails the call. No aid: no photos.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const fsp = fs.promises;
const { isImage } = require("./adapter.js");

const TIMEOUT_MS = 300000;
const PHOTO_DIR = "/media/internal/.webdav-photos";
const BUDGET_MS = 240000;

// The local copy's name: a hash of the locator (unique, and no path in it) and the name, made
// safe for a file system.
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
const localName = (e) => hash(e.id) + "-" + String(e.name || "photo.jpg").replace(/[^A-Za-z0-9._-]/g, "_").slice(-100);
// An album's folder of copies, named by a hash of its locator.
const albumDir = (dir, aid) => path.join(dir, hash(aid));

// Removes what is in `dir` and not in `keep` (names); a missing folder is fine. Errors are
// logged, never thrown: a copy left over is not worth failing a listing for.
async function prune(dir, keep, log, recursive) {
	let names;
	try { names = await fsp.readdir(dir); } catch (e) { return; }
	for (const name of names) {
		if (keep.has(name)) { continue; }
		try { await fsp.rm(path.join(dir, name), { recursive: !!recursive, force: true }); }
		catch (e) { log.log("webdav: could not remove " + path.join(dir, name) + ": " + (e && e.code || e)); }
	}
}

function photoMethods({ config, adapter, withAccount, log = console, now = Date.now }) {
	const albumName = () => config.PHOTO_ALBUM_NAME || "Camera Uploads";
	const tmpDir = () => config.PHOTO_TMP_DIR || PHOTO_DIR;
	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const { out } = await withAccount(p, async (s) => {
				try { return await adapter.photoAlbums(s, log); }
				catch (e) { log.log("webdav: listAlbums - photo folder unavailable: " + ((e && (e.status || e.errorCode)) || e)); return null; }
			});
			// Only a folder that could be read says which albums are gone.
			if (out) { await prune(tmpDir(), new Set(out.map((a) => path.basename(albumDir(tmpDir(), a.aid)))), log, true); }
			const albums = (out || []).map((a) => ({ aid: a.aid, name: a.name, size: { images: a.images || 0 } }));
			return { albums: albums.length ? albums : [{ aid: "", name: albumName(), size: { images: 0 } }] };
		} },

		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			if (p.aid === undefined || p.aid === null || p.aid === "") { return { photos: [] }; }
			const dir = albumDir(tmpDir(), p.aid);
			const have = new Set(Array.isArray(p.have) ? p.have.map(String) : []);
			const until = now() + (config.PHOTO_FETCH_BUDGET_MS || BUDGET_MS);
			const { out } = await withAccount(p, async (s) => {
				const entries = (((await adapter.listFolder(s, p.aid)) || {}).entries || []).filter(isImage);
				const photos = [], keep = new Set();
				let late = 0;
				for (const e of entries) {
					const dest = path.join(dir, localName(e));
					const link = "file://" + dest;
					const photo = { pid: e.id, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name };
					if (have.has(String(e.id))) { photos.push(photo); continue; }
					if (now() > until) { late++; continue; }
					try {
						await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
						await adapter.photoToLocal(s, e.id, dest);
					} catch (err) { log.log("webdav: listPhotos - could not fetch a photo: " + ((err && (err.errorCode + " " + (err.status || ""))) || err)); continue; }
					keep.add(path.basename(dest));
					photos.push(Object.assign(photo, { temporary: true }));
				}
				if (late) { log.log("webdav: listPhotos - " + late + " photo(s) left for the next sync (out of time)"); }
				// What the caller has, the server no longer has, and what a download left
				await prune(dir, keep, log, false);
				return photos;
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { localName, albumDir, PHOTO_DIR });
