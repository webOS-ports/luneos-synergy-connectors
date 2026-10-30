/* photos.js - PhotoPrism as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (the
 * service name derived from the templateId), and downloads the photos itself from the URLs
 * listPhotos gives. It calls with no app id, so both are open, as the stock providers' are;
 * the bus role decides who reaches the service.
 *
 * The albums are PhotoPrism's albums, then its folders (Config.ALBUM_TYPES):
 *   listAlbums { accountId }      -> { albums:[{ aid, name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName, createdTime }] }
 * aid and pid are PhotoPrism's uids. A folder's count is not kept by PhotoPrism, so a folder's
 * photos are counted (and an empty folder left out). src_big is the original (/dl/<hash>) where
 * it is a type the Photos app shows (Config.ORIGINAL_MIME_TYPES), else the 1920 px thumbnail;
 * src_small the 720 px one. The Photos service fetches URLs as they are, with no header: these
 * carry the server's download or preview token (from /config, asked on every listing, so a token
 * the admin renewed is picked up), never the account's app password. Videos are left out.
 *
 * Failures are absorbed as Immich's are, so the source stays in Photos: albums that cannot be
 * listed are none, and an album that cannot be listed has no photos. Credentials that cannot be
 * found are an error.
 */
"use strict";

const TIMEOUT_MS = 300000;
const HASH = /^[0-9a-f]{40,64}$/i;
const UID = /^[a-z0-9]{8,32}$/;
const IMAGE_TYPES = ["image", "raw", "live", "animated", "vector"];

const why = (e) => (e && (e.status || e.errorCode || e.message)) || e;
const str = (v) => (typeof v === "string" ? v : "");

// PhotoPrism (Go) writes "not deleted" as the zero time, 0001-01-01T00:00:00Z, not null.
const deleted = (t) => { const ms = Date.parse(str(t)); return Number.isFinite(ms) && new Date(ms).getUTCFullYear() > 1; };

const isImage = (p) => !!p && typeof p === "object" && IMAGE_TYPES.includes(str(p.Type)) && HASH.test(str(p.Hash)) && UID.test(str(p.UID));

// The primary file of a merged photo (its Hash is the photo's), or the first.
function primaryFile(p) {
	const files = Array.isArray(p.Files) ? p.Files.filter((f) => f && typeof f === "object") : [];
	return files.find((f) => f.Primary === true) || files.find((f) => str(f.Hash) === str(p.Hash)) || files[0] || {};
}

// A PhotoPrism photo -> the Photos service's entry; null when it is not an image with a hash.
function toPhotoEntry(config, server, tokens, p) {
	if (!isImage(p)) { return null; }
	const f = primaryFile(p);
	const mime = str(f.Mime).toLowerCase();
	const api = server + config.API_PATH;
	const thumb = (size) => api + "/t/" + p.Hash + "/" + encodeURIComponent(tokens.preview) + "/" + size;
	const original = config.ORIGINAL_MIME_TYPES.includes(mime);
	let fileName = (str(p.OriginalName) || str(f.Name) || str(p.FileName) || p.UID).split("/").pop();
	if (!original) { fileName = fileName.replace(/\.[^./]*$/, "") + ".jpg"; }
	const entry = { pid: p.UID,
		src_big: original ? api + "/dl/" + p.Hash + "?t=" + encodeURIComponent(tokens.download) : thumb(config.THUMB_BIG),
		src_small: thumb(config.THUMB_SMALL), caption: str(p.Caption), type: "image", fileName };
	const t = Date.parse(str(p.TakenAt));
	if (Number.isFinite(t)) { entry.createdTime = Math.floor(t / 1000); }
	return entry;
}

function photoMethods({ config, api, resolve, log = console }) {
	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const creds = await resolve(p);
			const albums = [], seen = new Set();
			for (const type of config.ALBUM_TYPES) {
				let list = [];
				try { list = await api.albums(creds, type); }
				catch (e) { log.log("photoprism: listAlbums - " + type + "s unavailable: " + why(e)); continue; }
				for (const a of list) {
					if (!UID.test(str(a.UID)) || seen.has(a.UID) || deleted(a.DeletedAt)) { continue; }
					seen.add(a.UID);
					let images = parseInt(a.PhotoCount, 10) || 0;
					if (type === "folder") {
						try { images = (await api.albumPhotos(creds, a.UID)).filter(isImage).length; }
						catch (e) { log.log("photoprism: listAlbums - folder unavailable: " + why(e)); continue; }
						if (!images) { continue; }
					}
					albums.push({ aid: a.UID, name: str(a.Title) || str(a.Path) || a.UID, size: { images } });
				}
			}
			return { albums };
		} },

		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const creds = await resolve(p);
			let raw, cfg;
			try {
				cfg = (await api.config(creds)) || {};
				raw = await api.albumPhotos(creds, p.aid);
			} catch (e) { log.log("photoprism: listPhotos - album unavailable: " + why(e)); return { photos: [] }; }
			const tokens = { download: str(cfg.downloadToken), preview: str(cfg.previewToken) };
			if (!tokens.download || !tokens.preview) { log.log("photoprism: listPhotos - the server gives no download/preview token"); return { photos: [] }; }
			return { photos: raw.map((x) => toPhotoEntry(config, creds.server, tokens, x)).filter(Boolean) };
		} },
	};
}

module.exports = Object.assign(photoMethods, { isImage, primaryFile, toPhotoEntry, deleted });
