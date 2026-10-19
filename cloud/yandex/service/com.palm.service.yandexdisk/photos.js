/* photos.js - Yandex Disk as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here, and
 * downloads the photos itself from the links listPhotos gives. It calls with no app id, so both
 * are open; the bus role decides who reaches the service. upload and deletePhoto are the
 * generic ones (_cloudcore/node/commands.js; the album folder is adapter.ensureAlbumFolder).
 *
 *   listAlbums { accountId }      -> { albums:[{ aid, name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 *
 * One folder is one album: Yandex's own camera-uploads folder (system_folders.photostream) when
 * it is there, else disk:/<Config.PHOTO_ALBUM_NAME> (adapter.resolvePhotoAlbum). aid is its path
 * without "disk:/" and without a "/" at the end: the Photos service makes a local folder
 * "<aid>-<name>" with a non-recursive mkdir; listPhotos and upload take it back as disk:/<aid>.
 * pid is the photo's "disk:/.." path; src_big/src_small its signed download href, asked for one
 * photo after the other; fileName keeps the real name and extension.
 */
"use strict";

const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const TIMEOUT_MS = 300000;

// A listFolder entry that is an image file (Yandex gives mime_type; the name otherwise).
function isImage(e) {
	if (!e || e.type !== "file") { return false; }
	if (e.mimeType && /^image\//i.test(e.mimeType)) { return true; }
	return IMAGE_RE.test(e.name || "");
}

function photoMethods({ adapter, withAccount, log = console }) {
	return {
		// The album is always there: a folder that is missing or cannot be listed shows as 0
		// images. Credentials that cannot be found are still an error.
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const { out } = await withAccount(p, async (s) => {
				const album = await adapter.resolvePhotoAlbum(s);
				let entries = [];
				try { entries = (await adapter.listFolder(s, album.path)).entries || []; }
				catch (e) { log.log("yandex: listAlbums - " + album.path + " unavailable: " + ((e && (e.status || e.errorCode)) || e)); }
				return { album, images: entries.filter(isImage).length };
			});
			const aid = String(out.album.path).replace(/^disk:\//, "").replace(/\/+$/, "");
			return { albums: [{ aid, name: out.album.name, size: { images: out.images } }] };
		} },

		// No aid is no photos. A photo whose link cannot be had is left out; the listing failing
		// fails the call.
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			if (p.aid === undefined || p.aid === null || p.aid === "") { return { photos: [] }; }
			const { out } = await withAccount(p, async (s) => {
				const { entries } = await adapter.listFolder(s, p.aid);
				const photos = [];
				for (const e of (entries || []).filter(isImage)) {
					let link = null;
					try { link = (await adapter.getTemporaryLink(s, e.path)).link || null; }
					catch (err) { link = null; }
					if (!link) { log.log("yandex: listPhotos - no temporary link for " + e.path); continue; }
					photos.push({ pid: e.path, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name });
				}
				return photos;
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { IMAGE_RE, isImage });
