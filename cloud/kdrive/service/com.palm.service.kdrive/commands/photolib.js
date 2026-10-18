/*global Config, console */
/* photolib.js - helpers for the Photos-app provider role of the kDrive service.
 *
 * The stock Photos aggregator (com.palm.service.photos) treats this service as a cloud photo
 * provider: it calls listAlbums/listPhotos, then downloads the bytes to local storage itself
 * (its curl-patched Sync-Manager fetches each src_big). The account template's PHOTO.UPLOAD
 * capabilityProvider + the templateId->serviceName switch in the aggregator's Utils.js route
 * "com.palm.kdrive" here.
 *
 * ONE kDrive folder is surfaced as ONE album to bound how much gets auto-downloaded into
 * /media/internal: the folder named Config.PHOTO_ALBUM_NAME ("Pictures") directly under the
 * writable private-space root. Change PHOTO_ALBUM_NAME in config.js to point elsewhere.
 */
var PhotoLib = {
	albumName: function () {
		return (typeof Config !== "undefined" && Config.PHOTO_ALBUM_NAME) || "Pictures";
	},
	IMAGE_RE: /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i,

	// Operates on NORMALIZED adapter.listFolder entries: { type:"file"|"folder", name, mimeType }.
	// An image is a file whose mime is image/* or whose name has a known image extension.
	isImage: function (e) {
		return !!(e && e.type === "file" &&
			((e.mimeType && e.mimeType.indexOf("image/") === 0) ||
			 PhotoLib.IMAGE_RE.test(e.name || "")));
	}
};

if (typeof exports !== "undefined") { exports.PhotoLib = PhotoLib; }
