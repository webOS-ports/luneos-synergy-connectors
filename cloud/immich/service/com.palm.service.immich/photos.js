/* photos.js - Immich as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (the
 * service name derived from the templateId), and downloads the photos itself from the URLs
 * listPhotos gives. It calls with no app id, so both are open, as the stock providers' are;
 * the bus role decides who reaches the service.
 *
 * The albums are the user's Immich albums, their own and those shared with them (GET /albums):
 *   listAlbums { accountId }      -> { albums:[{ aid, name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName, createdTime }] }
 * aid and pid are Immich's ids. src_big is the original (/assets/<id>/original) where it is a
 * type the Photos app shows (Config.ORIGINAL_MIME_TYPES), else Immich's preview; src_small the
 * preview. The Photos service fetches URLs as they are, with no header, so these carry the API
 * key as ?apiKey= (Immich takes it there as from x-api-key); it keeps no URL, only the file.
 * size:{ images } counts videos too: Immich's assetCount does not tell them apart. Videos,
 * trashed assets and hidden ones (the video halves of live photos) are left out.
 *
 * Failures are absorbed as Flickr's are, so the source stays in Photos: albums that cannot be
 * listed are none, and an album that cannot be listed has no photos. Credentials that cannot be
 * found are an error.
 */
"use strict";

const TIMEOUT_MS = 300000;
const ID = /^[0-9a-f-]{8,64}$/i;

const why = (e) => (e && (e.status || e.errorCode || e.message)) || e;
const str = (v) => (typeof v === "string" ? v : "");

function assetUrl(config, creds, id, kind) {
	const key = "apiKey=" + encodeURIComponent(creds.apiKey);
	return creds.server + config.API_PATH + "/assets/" + id + (kind === "original" ? "/original?" + key : "/thumbnail?size=preview&" + key);
}

const isImage = (a) => !!a && typeof a === "object" && a.type === "IMAGE" && a.isTrashed !== true &&
	a.visibility !== "hidden" && a.visibility !== "locked";

// An Immich asset -> the Photos service's entry; null without a usable id.
function toPhotoEntry(config, creds, a) {
	if (!ID.test(str(a.id))) { return null; }
	const original = config.ORIGINAL_MIME_TYPES.includes(str(a.originalMimeType).toLowerCase());
	const preview = assetUrl(config, creds, a.id, "preview");
	let fileName = str(a.originalFileName) || a.id;
	if (!original) { fileName = fileName.replace(/\.[^./]*$/, "") + ".jpg"; }
	const entry = { pid: a.id, src_big: original ? assetUrl(config, creds, a.id, "original") : preview, src_small: preview,
		caption: str(a.exifInfo && a.exifInfo.description) || str(a.description), type: "image", fileName };
	const t = Date.parse(str(a.fileCreatedAt));
	if (Number.isFinite(t)) { entry.createdTime = Math.floor(t / 1000); }
	return entry;
}

function photoMethods({ config, api, resolve, log = console }) {
	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const creds = await resolve(p);
			let list = [];
			try { list = await api.albums(creds); }
			catch (e) { log.log("immich: listAlbums - albums unavailable: " + why(e)); }
			const seen = new Set();
			const albums = [];
			for (const a of list) {
				if (!ID.test(str(a.id)) || seen.has(a.id)) { continue; }
				seen.add(a.id);
				albums.push({ aid: a.id, name: str(a.albumName) || a.id, size: { images: parseInt(a.assetCount, 10) || 0 } });
			}
			return { albums };
		} },

		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const creds = await resolve(p);
			let raw;
			try { raw = await api.albumAssets(creds, p.aid); }
			catch (e) { log.log("immich: listPhotos - album '" + p.aid + "' unavailable: " + why(e)); return { photos: [] }; }
			return { photos: raw.filter(isImage).map((a) => toPhotoEntry(config, creds, a)).filter(Boolean) };
		} },
	};
}

module.exports = Object.assign(photoMethods, { assetUrl, isImage, toPhotoEntry });
