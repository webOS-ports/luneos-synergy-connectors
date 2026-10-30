/* photos.js - MEGA as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js) and copies the photos from the links
 * listPhotos gives. It calls with no app id, so both are open, as the stock providers' are; the
 * bus role decides who reaches the service. upload and deletePhoto are the generic ones
 * (_cloudcore/node/commands.js), with ensureAlbumFolder making Config.PHOTO_ALBUM_NAME.
 *
 *   listAlbums { accountId }      -> { albums:[{ aid:<folder handle>, name, size:{ images } }] }
 *     The Cloud Drive root when it holds images ("Cloud Drive"), then every folder that directly
 *     holds one. With none at all (or a tree that cannot be read), one empty album named
 *     PHOTO_ALBUM_NAME with aid "", so the source still shows in Photos.
 *   listPhotos { accountId, aid, have? } -> { photos:[{ pid, src_big, src_small, caption, type:"image",
 *                                           fileName, temporary }] }
 *     MEGA's download URLs serve ciphertext, so each image is downloaded and decrypted to
 *     PHOTO_TMP_DIR/<aid>/ (default /media/internal/.mega-photos) first, and the links are
 *     file:// paths; one already there with the right size is not fetched again. These copies
 *     are only there to be fetched once: each is temporary:true, which tells the Photos service
 *     to remove it once it has its own. `have` lists the pids the caller has already: those are
 *     not downloaded, their copy is removed, and their link names a file that is not there.
 *     Copies of images the album no longer has go too, and listAlbums removes the folders of
 *     albums that are gone. An image that cannot be had is left out; the listing failing fails
 *     the call. No aid: no photos.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const fsp = fs.promises;

const TIMEOUT_MS = 300000;
const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const PHOTO_DIR = "/media/internal/.mega-photos";

// A listFolder entry that is an image file.
function isImage(e) {
	if (!e || e.type !== "file") { return false; }
	if (e.mimeType && /^image\//i.test(e.mimeType)) { return true; }
	return IMAGE_RE.test(e.name || "");
}

// The local copy's name: the handle (unique) and the name, made safe for a file system.
const localName = (e) => e.id + "-" + String(e.name || "photo.jpg").replace(/[^A-Za-z0-9._-]/g, "_");
// An album's folder of copies, named by its handle (base64url, but made safe all the same).
const albumDir = (dir, aid) => path.join(dir, String(aid).replace(/[^A-Za-z0-9_-]/g, "_"));

// Removes what is in `dir` and not in `keep` (names); a missing folder is fine. Errors are
// logged, never thrown: a copy left over is not worth failing a listing for.
async function prune(dir, keep, log, recursive) {
	let names;
	try { names = await fsp.readdir(dir); } catch (e) { return; }
	for (const name of names) {
		if (keep.has(name)) { continue; }
		try { await fsp.rm(path.join(dir, name), { recursive: !!recursive, force: true }); }
		catch (e) { log.log("mega: could not remove " + path.join(dir, name) + ": " + (e && e.code || e)); }
	}
}

function photoMethods({ config, adapter, withAccount, log = console }) {
	const albumName = () => config.PHOTO_ALBUM_NAME || "Camera Uploads";
	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const { out } = await withAccount(p, async (s) => {
				try { return await adapter.photoAlbums(s); }
				catch (e) { log.log("mega: listAlbums - tree unavailable: " + ((e && (e.errorCode || e.status)) || e)); return null; }
			});
			// Only a tree that could be read says which albums are gone. That removes the
			// copies of every other album, and the ones an older version kept in the top folder.
			if (out) {
				const dir = config.PHOTO_TMP_DIR || PHOTO_DIR;
				await prune(dir, new Set(out.map((a) => path.basename(albumDir(dir, a.aid)))), log, true);
			}
			const albums = (out || []).map((a) => ({ aid: a.aid, name: a.name, size: { images: a.images || 0 } }));
			return { albums: albums.length ? albums : [{ aid: "", name: albumName(), size: { images: 0 } }] };
		} },

		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			if (p.aid === undefined || p.aid === null || p.aid === "") { return { photos: [] }; }
			const dir = albumDir(config.PHOTO_TMP_DIR || PHOTO_DIR, p.aid);
			const have = new Set(Array.isArray(p.have) ? p.have.map(String) : []);
			const { out } = await withAccount(p, async (s) => {
				const entries = ((await adapter.listFolder(s, p.aid)) || {}).entries || [];
				const photos = [], keep = new Set();
				for (const e of entries.filter(isImage)) {
					const dest = path.join(dir, localName(e));
					const link = "file://" + dest;
					const photo = { pid: e.id, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name };
					if (have.has(String(e.id))) { photos.push(photo); continue; }
					try {
						await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
						await adapter.photoToLocal(s, e.id, dest);
					} catch (err) { log.log("mega: listPhotos - could not fetch/decrypt " + e.id + ": " + ((err && err.errorCode) || err)); continue; }
					keep.add(path.basename(dest));
					photos.push(Object.assign(photo, { temporary: true }));
				}
				// What the caller has, the cloud no longer has, and what a download left
				await prune(dir, keep, log, false);
				return photos;
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { IMAGE_RE, isImage, localName, albumDir, PHOTO_DIR });
