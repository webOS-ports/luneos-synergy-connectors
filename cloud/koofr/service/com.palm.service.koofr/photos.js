/* photos.js - Koofr as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js), and downloads the photos itself from the
 * links listPhotos gives. It calls with no app id, so all of these are open, as the stock
 * providers' are; the bus role decides who reaches the service. deletePhoto is the generic one
 * (_cloudcore/node/commands.js); upload is the generic one with the album id decoded.
 *
 *   listAlbums { accountId }      -> { albums:[{ aid, name, size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 *
 * The albums are the mount root, when it holds images ("Koofr"), and every folder directly
 * under it that holds images. aid is the album's path URL-encoded ("%2FMy%20pictures"): the
 * Photos service makes a local folder "<aid>-<name>" with a non-recursive mkdir, so the aid
 * must have no slash. With no images anywhere there is one empty album (aid "", named
 * Config.PHOTO_ALBUM_NAME), so the source still shows in Photos. A folder that cannot be listed
 * counts as no images; credentials that cannot be found are still an error.
 *
 * pid is the photo's path, which deletePhoto takes; src_big/src_small are Koofr's files/download
 * links, asked for one after the other; fileName keeps the real name and extension.
 */
"use strict";

const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const TIMEOUT_MS = 300000;

// A listFolder entry that is an image file: its content type, else its name.
function isImage(e) {
	if (!e || e.type !== "file") { return false; }
	if (e.mimeType && /^image\//i.test(e.mimeType)) { return true; }
	return IMAGE_RE.test(e.name || "");
}

// listAlbums' aid -> the album's path ("%2FMy%20pictures" -> "/My pictures").
function aidPath(aid) {
	let p;
	try { p = decodeURIComponent(String(aid)); }
	catch (e) { p = "/" + String(aid).replace(/^\/+|\/+$/g, ""); }
	return (p.charAt(0) === "/") ? p : ("/" + p);
}

// deps: connector.js's, plus core (_cloudcore/node), for the generic upload.
function photoMethods({ core, config, adapter, store, oauth, withAccount, log = console }) {
	const generic = core.createCommands({ config, adapter, store, oauth });

	// A folder's entries, or none when it cannot be listed.
	async function entriesOr(s, folder) {
		try { return ((await adapter.listFolder(s, folder)) || {}).entries || []; }
		catch (e) { log.log("koofr: photos - " + folder + " unavailable: " + ((e && (e.status || e.errorCode)) || e)); return []; }
	}

	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const { out } = await withAccount(p, async (s) => {
				const albums = [];
				const top = await entriesOr(s, config.ROOT_FOLDER);
				const rootImages = top.filter(isImage).length;
				if (rootImages) { albums.push({ aid: "/", name: "Koofr", images: rootImages }); }
				for (const f of top.filter((e) => e && e.type === "folder")) {
					const n = (await entriesOr(s, f.id)).filter(isImage).length;
					if (n) { albums.push({ aid: f.id, name: f.name, images: n }); }
				}
				return albums;
			});
			const albums = out.map((a) => ({ aid: encodeURIComponent(a.aid), name: a.name, size: { images: a.images } }));
			if (!albums.length) { albums.push({ aid: "", name: config.PHOTO_ALBUM_NAME || "Camera Uploads", size: { images: 0 } }); }
			return { albums };
		} },

		// No aid (the empty album) is no photos, asked of nobody. A folder that cannot be listed
		// is no photos either; a photo whose link cannot be had is left out.
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			if (p.aid === undefined || p.aid === null || p.aid === "") { return { photos: [] }; }
			const album = aidPath(p.aid);
			const { out } = await withAccount(p, async (s) => {
				const photos = [];
				for (const e of (await entriesOr(s, album)).filter(isImage)) {
					let link = null;
					try { link = ((await adapter.getTemporaryLink(s, e.id)) || {}).link || null; }
					catch (err) { link = null; }
					if (!link) { log.log("koofr: listPhotos - no link for " + e.id); continue; }
					photos.push({ pid: e.id, src_big: link, src_small: link, caption: e.name, type: "image", fileName: e.name });
				}
				return photos;
			});
			return { photos: out };
		} },

		// The generic upload, into the album listAlbums named: its aid decoded back to the path.
		upload: Object.assign({}, generic.upload, { handler: (p) => {
			const aid = p.albumId || p.folderId;
			const q = Object.assign({}, p);
			if (aid) { delete q.folderId; q.albumId = /^%2F/i.test(String(aid)) ? aidPath(aid) : aid; }
			return generic.upload.handler(q);
		} }),
	};
}

module.exports = Object.assign(photoMethods, { IMAGE_RE, isImage, aidPath });
