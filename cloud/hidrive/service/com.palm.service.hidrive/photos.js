/* photos.js - HiDrive as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here, and
 * downloads the photos itself from the links listPhotos gives. It calls with no app id, so both
 * are open; the bus role decides who reaches the service. upload and deletePhoto are the
 * generic ones (_cloudcore/node/commands.js; the album folder is adapter.ensureAlbumFolder).
 *
 *   listAlbums { accountId }      -> { albums:[{ aid, name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 *
 * The albums are the account home (its own images, named "HiDrive") and each immediate
 * sub-folder that holds images. aid is the folder's path URL-encoded, so it has no "/": the
 * Photos service makes a local folder "<aid>-<name>" with a non-recursive mkdir. With no images
 * anywhere there is still one empty album (aid "", Config.PHOTO_ALBUM_NAME), so the source shows;
 * an upload into it makes that folder. pid is the photo's path, src_big/src_small a
 * "/file?path=..&access_token=.." URL (adapter.getTemporaryLink).
 */
"use strict";

const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const TIMEOUT_MS = 300000;

// A listFolder entry that is an image file.
function isImage(e) {
	if (!e || e.type !== "file") { return false; }
	if (e.mimeType && /^image\//i.test(e.mimeType)) { return true; }
	return IMAGE_RE.test(e.name || "");
}

function photoMethods({ config, adapter, withAccount, log = console }) {
	return {
		// Credentials that cannot be found are an error; anything after that shows as no albums.
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const { out } = await withAccount(p, async (s) => {
				try { return await adapter.photoAlbums(s, isImage); }
				catch (e) { log.log("hidrive: listAlbums - " + ((e && (e.status || e.errorCode)) || e)); return []; }
			});
			let albums = (out || []).map((a) => ({ aid: encodeURIComponent(a.aid), name: a.name, size: { images: a.images || 0 } }));
			if (!albums.length) { albums = [{ aid: "", name: config.PHOTO_ALBUM_NAME || "Camera Uploads", size: { images: 0 } }]; }
			return { albums };
		} },

		// No aid (the empty album) is no photos. The listing failing fails the call.
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			if (p.aid === undefined || p.aid === null || p.aid === "") { return { photos: [] }; }
			let aid = String(p.aid);
			try { aid = decodeURIComponent(aid); } catch (e) { /* a plain path already */ }
			const { out } = await withAccount(p, async (s) => {
				const { entries } = await adapter.listFolder(s, aid);
				const photos = [];
				for (const e of (entries || []).filter(isImage)) {
					const { link } = adapter.getTemporaryLink(s, e.id);
					photos.push({ pid: e.id, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name });
				}
				return photos;
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { IMAGE_RE, isImage });
