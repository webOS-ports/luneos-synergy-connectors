/* photos.js - SmugMug as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (the
 * service name derived from the templateId), and downloads the photos itself from the URLs
 * listPhotos gives. It calls with no app id, so both are open, as the stock providers' are;
 * the bus role decides who reaches the service.
 *
 * Every SmugMug image is in exactly one album (gallery), so the albums are the user's albums
 * (user/<NickName>!albums), with no synthetic "All Photos":
 *   listAlbums { accountId }      -> { albums:[{ aid, name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 * aid is the AlbumKey, pid the ImageKey. src_big is the original (ArchivedUri), else the largest
 * size SmugMug renders (LargestImage); src_small the thumbnail. These photos.smugmug.com URLs
 * need no token - the key in their path is the capability, a private gallery's included - and
 * the original is byte for byte the uploaded file (ArchivedMD5). fileName is the uploaded file's
 * name. Videos, and images SmugMug is still processing, are left out.
 *
 * Failures are absorbed as Flickr's are, so the source stays in Photos: albums that cannot be
 * listed are none, and an album that cannot be listed has no photos. Credentials that cannot be
 * found are an error.
 */
"use strict";

const TIMEOUT_MS = 300000;

const why = (e) => (e && (e.status || e.errorCode || e.message)) || e;
const str = (v) => (typeof v === "string" ? v : "");

// The original, else the largest rendered size; null with neither.
function resolveDownloadUrl(img) {
	return str(img.ArchivedUri) || str(img.LargestImageUrl) || null;
}

const isImage = (img) => !!img && typeof img === "object" && img.IsVideo !== true && img.Processing !== true;

// A SmugMug AlbumImage -> the Photos service's entry; null without a URL to download.
function toPhotoEntry(img) {
	const url = resolveDownloadUrl(img);
	if (!url || !str(img.ImageKey)) { return null; }
	const ext = (url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/) || [])[1];
	return { pid: img.ImageKey, src_big: url, src_small: str(img.ThumbnailUrl) || url,
		caption: str(img.Caption) || str(img.Title), type: "image",
		fileName: str(img.FileName) || (img.ImageKey + "." + (ext ? ext.toLowerCase() : "jpg")) };
}

// The NickName the albums are under: stored at sign-in, else asked for.
async function nickOf(api, creds) {
	if (str(creds.userId)) { return creds.userId; }
	return str((await api.authUser(creds)).NickName);
}

function photoMethods({ api, resolve, log = console }) {
	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const creds = await resolve(p);
			let list = [];
			try { list = await api.albums(creds, await nickOf(api, creds)); }
			catch (e) { log.log("smugmug: listAlbums - albums unavailable: " + why(e)); }
			const albums = list.filter((a) => str(a.AlbumKey)).map((a) => ({
				aid: a.AlbumKey,
				name: str(a.Name) || str(a.Title) || a.AlbumKey,
				size: { images: parseInt(a.ImageCount, 10) || 0 },
			}));
			return { albums };
		} },

		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const creds = await resolve(p);
			let raw;
			try { raw = await api.albumImages(creds, p.aid); }
			catch (e) { log.log("smugmug: listPhotos - album '" + p.aid + "' unavailable: " + why(e)); return { photos: [] }; }
			return { photos: raw.filter(isImage).map(toPhotoEntry).filter(Boolean) };
		} },
	};
}

module.exports = Object.assign(photoMethods, { resolveDownloadUrl, isImage, toPhotoEntry });
