/* photos.js - OneDrive as a source for the Photos service (com.palm.service.photos).
 *
 * The Photos service finds PHOTO.UPLOAD accounts, calls listAlbums and listPhotos here (by the
 * templateId -> service name switch in its Utils.js), and downloads the photos itself from the
 * links listPhotos gives. It calls with no app id, so both are open, as the stock providers'
 * are; the bus role decides who reaches the service. upload and deletePhoto are the generic
 * ones (_cloudcore/node/commands.js).
 *
 * Graph has no album model, so the Camera Roll special folder is the one album (and a bound on
 * how much is downloaded into /media/internal):
 *   listAlbums { accountId }      -> { albums:[{ aid:"cameraroll", name:"Camera Roll", size:{ images } }] }
 *   listPhotos { accountId, aid } -> { photos:[{ pid, src_big, src_small, caption, type:"image", fileName }] }
 * aid is the special folder's name; pid is the driveItem id, which deletePhoto deletes. src_big
 * and src_small are the items' @microsoft.graph.downloadUrl (pre-signed, no token needed),
 * which the listing carries, so there is no request per photo. An account without a Camera Roll
 * (one that never used the mobile app) has an empty album, not an error, for both methods;
 * credentials that cannot be found are still an error.
 */
"use strict";

const ALBUM_FOLDER = "cameraroll";
const ALBUM_NAME = "Camera Roll";
const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;
const TIMEOUT_MS = 300000;

// A raw driveItem that is an image file (a file facet, an image name).
function isImage(e) {
	return !!(e && e.file && IMAGE_RE.test(e.name || ""));
}

function photoMethods({ adapter, withAccount, log = console }) {
	// The album's raw items, or null when Graph cannot list it.
	const items = (s, special, what) => adapter.listSpecialChildren(s, special).then((d) => (d && d.value) || [], (e) => {
		log.log("onedrive: " + what + " - Camera Roll unavailable: " + ((e && (e.status || e.errorCode)) || e));
		return null;
	});

	return {
		listAlbums: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const album = { aid: ALBUM_FOLDER, name: ALBUM_NAME, size: { images: 0 } };
			const { out } = await withAccount(p, (s) => items(s, ALBUM_FOLDER, "listAlbums"));
			if (out) { album.size.images = out.filter(isImage).length; }
			return { albums: [album] };
		} },

		// An image without a download URL is left out.
		listPhotos: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const { out } = await withAccount(p, (s) => items(s, p.aid || ALBUM_FOLDER, "listPhotos"));
			const photos = (out || []).filter(isImage).map((e) => {
				const url = e["@microsoft.graph.downloadUrl"];
				return { pid: e.id, src_big: url, src_small: url, caption: e.name, type: "image", fileName: e.name };
			}).filter((ph) => !!ph.src_big);
			return { photos };
		} },
	};
}

module.exports = Object.assign(photoMethods, { ALBUM_FOLDER, ALBUM_NAME, IMAGE_RE, isImage });
