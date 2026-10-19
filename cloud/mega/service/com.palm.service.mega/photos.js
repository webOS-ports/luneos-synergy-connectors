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
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 *     MEGA's download URLs serve ciphertext, so each image is downloaded and decrypted to
 *     PHOTO_TMP_DIR (default /media/internal/.mega-photos) first, and the links are file://
 *     paths; one already there with the right size is not fetched again. An image that cannot
 *     be had is left out; the listing failing fails the call. No aid: no photos.
 */
"use strict";

const path = require("node:path");

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

function photoMethods({ config, adapter, withAccount, log = console }) {
	const albumName = () => config.PHOTO_ALBUM_NAME || "Camera Uploads";
	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const { out } = await withAccount(p, async (s) => {
				try { return await adapter.photoAlbums(s); }
				catch (e) { log.log("mega: listAlbums - tree unavailable: " + ((e && (e.errorCode || e.status)) || e)); return []; }
			});
			const albums = (out || []).map((a) => ({ aid: a.aid, name: a.name, size: { images: a.images || 0 } }));
			return { albums: albums.length ? albums : [{ aid: "", name: albumName(), size: { images: 0 } }] };
		} },

		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			if (p.aid === undefined || p.aid === null || p.aid === "") { return { photos: [] }; }
			const dir = config.PHOTO_TMP_DIR || PHOTO_DIR;
			const { out } = await withAccount(p, async (s) => {
				const entries = ((await adapter.listFolder(s, p.aid)) || {}).entries || [];
				const photos = [];
				for (const e of entries.filter(isImage)) {
					const dest = path.join(dir, localName(e));
					try { await adapter.photoToLocal(s, e.id, dest); }
					catch (err) { log.log("mega: listPhotos - could not fetch/decrypt " + e.id + ": " + ((err && err.errorCode) || err)); continue; }
					const link = "file://" + dest;
					photos.push({ pid: e.id, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name });
				}
				return photos;
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { IMAGE_RE, isImage, localName, PHOTO_DIR });
