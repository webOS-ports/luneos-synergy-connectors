/* photos.js - S3 as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here, and
 * downloads the photos itself from the links listPhotos gives. It calls with no app id, so both
 * are open; the bus role decides who reaches the service. upload and deletePhoto are the generic
 * ones (_cloudcore/node/commands.js); upload with no album puts the photo under the album prefix
 * (ensureAlbumFolder).
 *
 * One prefix is one album, Config.PHOTO_ALBUM_NAME ("Camera Uploads/"):
 *   listAlbums { accountId }      -> { albums:[{ aid:"Camera Uploads", name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 * aid is the prefix without its slash (the Photos service builds a cache folder from it). pid
 * is the object key, which deletePhoto deletes. src_big/src_small are presigned GET URLs (an
 * hour), made locally without a request.
 */
"use strict";

const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const TIMEOUT_MS = 300000;

// A listFolder entry that is an image file (by its type, else its name).
function isImage(e) {
	if (!e || e.type !== "file") { return false; }
	if (e.mimeType && /^image\//i.test(e.mimeType)) { return true; }
	return IMAGE_RE.test(e.name || "");
}

function photoMethods({ adapter, withAccount, log = console }) {
	return {
		// The album is always there: a prefix with nothing under it, or one that cannot be
		// listed, shows as 0 images. Credentials that cannot be found are still an error.
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const { out } = await withAccount(p, async (s) => {
				const album = await adapter.resolvePhotoAlbum(s, log);
				const aid = String(album.path).replace(/\/+$/, "");
				let images = 0;
				if (album.exists) {
					try { images = ((await adapter.listFolder(s, album.path)).entries || []).filter(isImage).length; }
					catch (e) { log.log("s3: listAlbums - " + album.path + " unavailable: " + ((e && (e.status || e.errorCode)) || e)); }
				}
				return { aid, name: album.name, size: { images } };
			});
			return { albums: [out] };
		} },

		// No aid is no photos. The listing failing fails the call.
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			if (p.aid === undefined || p.aid === null || p.aid === "") { return { photos: [] }; }
			const prefix = String(p.aid).replace(/\/+$/, "") + "/";
			const { out } = await withAccount(p, async (s) => {
				const entries = (await adapter.listFolder(s, prefix)).entries || [];
				return entries.filter(isImage).map((e) => {
					const link = adapter.getTemporaryLink(s, e.id).link;
					return { pid: e.id, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name };
				});
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { IMAGE_RE, isImage });
