/* photos.js - kDrive as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js), and downloads the photos itself from the
 * URLs listPhotos gives. It calls with no app id, so both are open, as the stock providers'
 * are; the bus role decides who reaches the service. upload and deletePhoto are the generic
 * ones (_cloudcore/node/commands.js; upload finds or makes the album folder with
 * adapter.ensureAlbumFolder).
 *
 * One kDrive folder is one album, to bound how much is downloaded into /media/internal: the
 * folder Config.PHOTO_ALBUM_NAME ("Pictures") directly under the private space.
 *   listAlbums { accountId }      -> { albums:[{ aid:"<folder id>"|"", name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 * aid is "" while the folder does not exist, so the source still shows. src_big is the download
 * URL and src_small the thumbnail, both with ?access_token= (the Photos service sends no
 * Authorization header); fileName keeps the real name and extension.
 */
"use strict";

const { isImage } = require("./adapter.js");

const TIMEOUT_MS = 300000;

function photoMethods({ config, adapter, withAccount, log = console }) {
	const albumName = () => config.PHOTO_ALBUM_NAME || "Pictures";
	return {
		// The album is always there: a folder that is missing or cannot be listed shows as 0
		// images. Credentials that cannot be found are still an error.
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const name = albumName();
			const { out } = await withAccount(p, async (s) => {
				let aid = null;
				try { aid = await adapter.findAlbumFolder(s, name); }
				catch (e) { log.log("kdrive: listAlbums - no album folder: " + ((e && (e.status || e.errorCode)) || e)); aid = null; }
				if (!aid) { return { aid: "", images: 0 }; }
				try { return { aid, images: (await adapter.listFolder(s, aid)).entries.filter(isImage).length }; }
				catch (e) { log.log("kdrive: listAlbums - " + aid + " unavailable: " + ((e && (e.status || e.errorCode)) || e)); return { aid, images: 0 }; }
			});
			return { albums: [{ aid: out.aid, name, size: { images: out.images } }] };
		} },

		// No album folder (aid "") is no photos, without a request; the listing failing fails it.
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const aid = p.aid;
			if (aid === undefined || aid === null || aid === "") { return { photos: [] }; }
			const { out } = await withAccount(p, async (s) => {
				const entries = (await adapter.listFolder(s, aid)).entries.filter(isImage);
				return entries.map((e) => ({ pid: e.id, src_big: adapter.photoUrl(s, e.id, "download"),
					src_small: adapter.photoUrl(s, e.id, "thumbnail"), caption: e.name, type: "image", fileName: e.name }));
			});
			return { photos: out };
		} },
	};
}

module.exports = Object.assign(photoMethods, { TIMEOUT_MS });
