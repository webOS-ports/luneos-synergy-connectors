/* photos.js - Box as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js), and downloads the photos itself from the
 * URLs listPhotos gives. It calls with no app id, so both are open, as the stock providers'
 * are; the bus role decides who reaches the service. upload and deletePhoto are the generic
 * ones (_cloudcore/node/commands.js).
 *
 * One Box folder is one album, to bound how much is downloaded into /media/internal. Box is id
 * based, so the album is a folder id: the root "0" by default (every image in it):
 *   listAlbums { accountId }      -> { albums:[{ aid:"0", name:"Box Photos", size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 * pid is the Box file id, which deletePhoto hands to DELETE /files/{id}. src_big/src_small are
 * /files/{id}/content?access_token= URLs (302 to dl.boxcloud.com), built from the freshest
 * token: Box has no pre-signed link that needs no token, and needs no call per photo for them.
 */
"use strict";

const ALBUM_FOLDER = "0";
const ALBUM_NAME = "Box Photos";
const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const TIMEOUT_MS = 300000;

// A listFolder entry (type, name) that is an image file.
function isImage(e) {
	return !!(e && e.type === "file" && IMAGE_RE.test(e.name || ""));
}

function photoMethods({ adapter, withAccount, log = console }) {
	return {
		// The album is always there: a folder that cannot be listed shows as 0 images, so the
		// source still appears in Photos. Credentials that cannot be found are still an error.
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const album = { aid: ALBUM_FOLDER, name: ALBUM_NAME, size: { images: 0 } };
			const { out } = await withAccount(p, async (s) => {
				try { return await adapter.listFolder(s, ALBUM_FOLDER); }
				catch (e) { log.log("boxnet: listAlbums - folder " + ALBUM_FOLDER + " unavailable: " + ((e && (e.status || e.errorCode)) || e)); return null; }
			});
			if (out) { album.size.images = (out.entries || []).filter(isImage).length; }
			return { albums: [album] };
		} },

		// The listing failing fails the call.
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const aid = p.aid || ALBUM_FOLDER;
			const { out } = await withAccount(p, async (s) => {
				const data = await adapter.listFolder(s, aid);
				return (data.entries || []).filter(isImage).map((e) => {
					const url = adapter.contentUrl(s, e.id);
					return { pid: e.id, src_big: url, src_small: url, caption: e.name, type: "image", fileName: e.name };
				});
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { ALBUM_FOLDER, ALBUM_NAME, IMAGE_RE, isImage });
