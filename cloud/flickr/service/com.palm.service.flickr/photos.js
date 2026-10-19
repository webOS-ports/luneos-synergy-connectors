/* photos.js - Flickr as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js), and downloads the photos itself from the
 * URLs listPhotos gives. It calls with no app id, so both are open, as the stock providers'
 * are; the bus role decides who reaches the service.
 *
 * Flickr has albums (photosets): listAlbums gives every photoset, after one synthetic
 * "All Photos" album (aid "__all__", flickr.people.getPhotos user_id=me):
 *   listAlbums { accountId }      -> { albums:[{ aid, name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 * src_big/src_small are live.staticflickr.com URLs that need no token (the id_secret pair is
 * the capability), from the extras the listing inlines; fileName is <id>.<ext>, as a Flickr
 * photo has no file name. Videos are left out.
 *
 * Failures are absorbed as before, so the source stays in Photos: photosets that cannot be
 * listed leave only "All Photos", a count that cannot be read is 0, and an album that cannot
 * be listed has no photos. Credentials that cannot be found are an error.
 */
"use strict";

const ALL_PHOTOS_AID = "__all__";
const ALL_PHOTOS_NAME = "All Photos";
const TIMEOUT_MS = 300000;

const why = (e) => (e && (e.status || e.errorCode || e.message)) || e;

// The original (url_o), else large (url_b), else medium 800 (url_c), else the _b static URL.
function resolveDownloadUrl(p) {
	if (p.url_o) { return p.url_o; }
	if (p.url_b) { return p.url_b; }
	if (p.url_c) { return p.url_c; }
	if (p.server && p.id && p.secret) { return "https://live.staticflickr.com/" + p.server + "/" + p.id + "_" + p.secret + "_b.jpg"; }
	return null;
}

// <id>.<the URL's extension>, else <id>.jpg.
function fileNameFor(p, url) {
	let ext = "jpg";
	const m = typeof url === "string" && url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
	if (m) { ext = m[1].toLowerCase(); }
	return p.id + "." + ext;
}

const isImage = (p) => !!p && typeof p === "object" && p.media !== "video";

// A raw Flickr photo -> the Photos service's entry; null without a URL to download.
function toPhotoEntry(p) {
	const url = resolveDownloadUrl(p);
	if (!url) { return null; }
	return { pid: p.id, src_big: url, src_small: url,
		caption: (p.title && p.title._content !== undefined) ? p.title._content : (p.title || ""),
		type: "image", fileName: fileNameFor(p, url) };
}

const list = (v) => (Array.isArray(v) ? v : []);

function photoMethods({ api, resolve, log = console }) {
	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const creds = await resolve(p);
			let data = {};
			try { data = (await api.listPhotosets(creds)) || {}; }
			catch (e) { log.log("flickr: listAlbums - photosets unavailable: " + why(e)); }
			const albums = list(data.photosets && data.photosets.photoset).filter((s) => s && typeof s === "object").map((s) => ({
				aid: s.id,
				name: (s.title && s.title._content !== undefined) ? s.title._content : String(s.id),
				size: { images: parseInt(s.photos, 10) || 0 },
			}));
			let total = 0;
			try { const ad = (await api.allPhotos(creds, "1")) || {}; total = (ad.photos && parseInt(ad.photos.total, 10)) || 0; }
			catch (e) { total = 0; }
			albums.unshift({ aid: ALL_PHOTOS_AID, name: ALL_PHOTOS_NAME, size: { images: total } });
			return { albums };
		} },

		// people.getPhotos answers data.photos.photo[], photosets.getPhotos data.photoset.photo[].
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const aid = p.aid || ALL_PHOTOS_AID;
			const creds = await resolve(p);
			let data;
			try { data = (await (aid === ALL_PHOTOS_AID ? api.allPhotos(creds, "500") : api.photosetPhotos(creds, aid))) || {}; }
			catch (e) { log.log("flickr: listPhotos - album '" + aid + "' unavailable: " + why(e)); return { photos: [] }; }
			const raw = list((data.photos && data.photos.photo) || (data.photoset && data.photoset.photo));
			return { photos: raw.filter(isImage).map(toPhotoEntry).filter(Boolean) };
		} },
	};
}

module.exports = Object.assign(photoMethods, { ALL_PHOTOS_AID, ALL_PHOTOS_NAME, resolveDownloadUrl, fileNameFor, isImage, toPhotoEntry });
