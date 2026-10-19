/* photos.js - pCloud as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js), and downloads the photos itself from the
 * links listPhotos gives. It calls with no app id, so both are open, as the stock providers'
 * are; the bus role decides who reaches the service. upload and deletePhoto are the generic
 * ones (_cloudcore/node/commands.js).
 *
 * pCloud has no photo or album API, so one folder is one album, to bound how much is
 * downloaded into /media/internal: ALBUM_FOLDER (the folderid, 0 = the root), named ALBUM_NAME.
 *   listAlbums { accountId }      -> { albums:[{ aid:0, name:"pCloud", size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 * pid is the numeric fileid, which deletePhoto hands to deletefile. src_big/src_small are
 * getfilelink URLs (no token, short-lived), asked for one after the other; fileName keeps the
 * real name and extension, which the link does not have. A folder that cannot be listed is 0
 * images and no photos, as before; credentials that cannot be found are still an error.
 */
"use strict";

const ALBUM_FOLDER = 0;
const ALBUM_NAME = "pCloud";
const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const TIMEOUT_MS = 300000;

// A RAW listfolder entry that is an image: not a folder, and an image/* contenttype or name.
function isImage(e) {
	if (!e || e.isfolder) { return false; }
	if (e.contenttype && /^image\//i.test(e.contenttype)) { return true; }
	return IMAGE_RE.test(e.name || "");
}

const contentsOf = (data) => ((data && data.metadata && Array.isArray(data.metadata.contents)) ? data.metadata.contents : []);
const why = (e) => (e && (e.result || e.status || e.errorCode)) || e;

function photoMethods({ adapter, withAccount, log = console }) {
	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const album = { aid: ALBUM_FOLDER, name: ALBUM_NAME, size: { images: 0 } };
			const { out } = await withAccount(p, async (s) => {
				try { return await adapter.listFolderRaw(s, ALBUM_FOLDER); }
				catch (e) { log.log("pcloud: listAlbums - folder " + ALBUM_FOLDER + " unavailable: " + why(e)); return null; }
			});
			if (out) { album.size.images = contentsOf(out).filter(isImage).length; }
			return { albums: [album] };
		} },

		// A photo whose link cannot be had is left out.
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const aid = (p.aid !== undefined && p.aid !== null) ? p.aid : ALBUM_FOLDER;
			const { out } = await withAccount(p, async (s) => {
				let data;
				try { data = await adapter.listFolderRaw(s, aid); }
				catch (e) { log.log("pcloud: listPhotos - folder " + aid + " unavailable: " + why(e)); return []; }
				const photos = [];
				for (const e of contentsOf(data).filter(isImage)) {
					let link = null;
					try { link = ((await adapter.getFileLink(s, e.fileid)) || {}).url || null; }
					catch (err) { link = null; }
					if (!link) { log.log("pcloud: listPhotos - no link for fileid " + e.fileid); continue; }
					photos.push({ pid: e.fileid, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name });
				}
				return photos;
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { ALBUM_FOLDER, ALBUM_NAME, IMAGE_RE, isImage });
