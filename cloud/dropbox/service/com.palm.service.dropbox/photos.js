/* photos.js - Dropbox as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js), and downloads the photos itself from the
 * links listPhotos gives. It calls with no app id, so both are open, as the stock providers'
 * are; the bus role decides who reaches the service. upload and deletePhoto are the generic
 * ones (_cloudcore/node/commands.js).
 *
 * One Dropbox folder is one album, to bound how much is downloaded into /media/internal:
 *   listAlbums { accountId }      -> { albums:[{ aid:"/Camera Uploads", name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 * pid is the Dropbox file id ("id:..."), which deletePhoto hands to delete_v2. src_big/src_small
 * are temporary links (no token, ~4 h), asked for Config.CONCURRENCY at a time; fileName keeps the real
 * name and extension, which the link does not have.
 */
"use strict";

const ALBUM_PATH = "/Camera Uploads";
const ALBUM_NAME = "Camera Uploads";
const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const TIMEOUT_MS = 300000;

// A raw list_folder entry (".tag", name) that is an image file.
function isImage(e) {
	return !!(e && e[".tag"] === "file" && IMAGE_RE.test(e.name || ""));
}

function photoMethods({ config = {}, adapter, withAccount, mapLimit, log = console }) {
	return {
		// The album is always there: a folder that is missing (path/not_found) or cannot be listed
		// shows as 0 images, so the source still appears in Photos. Credentials that cannot be
		// found are still an error.
		listAlbums: { job: true, timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const album = { aid: ALBUM_PATH, name: ALBUM_NAME, size: { images: 0 } };
			const { out } = await withAccount(p, async (s) => {
				try { return await adapter.listFolderRaw(s, ALBUM_PATH); }
				catch (e) { log.log("dropbox: listAlbums - " + ALBUM_PATH + " unavailable: " + ((e && (e.status || e.errorCode)) || e)); return null; }
			});
			if (out) { album.size.images = (out.entries || []).filter(isImage).length; }
			return { albums: [album] };
		} },

		// A photo whose link cannot be had is left out; the listing failing fails the call.
		// The links, Config.CONCURRENCY at a time.
		listPhotos: { job: true, timeoutMs: TIMEOUT_MS, handler: async (p, ctx = {}) => {
			const aid = p.aid || ALBUM_PATH;
			const { out } = await withAccount(p, async (s) => {
				const data = await adapter.listFolderRaw(s, aid);
				const photos = await mapLimit((data.entries || []).filter(isImage), config.CONCURRENCY, async (e) => {
					let link = null;
					try { link = ((await adapter.getTemporaryLink(s, e.path_lower)) || {}).link || null; }
					catch (err) { link = null; }
					if (!link) { log.log("dropbox: listPhotos - no temporary link for " + e.path_lower); return null; }
					return { pid: e.id, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name };
				}, { signal: ctx.signal, progress: ctx.progress && ((n) => ctx.progress({ photos: n })) });
				return photos.filter(Boolean);
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { ALBUM_PATH, ALBUM_NAME, IMAGE_RE, isImage });
