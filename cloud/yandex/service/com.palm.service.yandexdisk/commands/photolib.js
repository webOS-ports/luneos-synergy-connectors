/*global console */
/* photolib.js - helpers for the Photos-app provider role of the Yandex Disk service.
 *
 * The stock Photos aggregator (com.palm.service.photos) treats this service as a cloud
 * photo provider: it calls listAlbums/listPhotos, then downloads the bytes to local storage
 * itself (see the curl patch in that service's Sync-Manager.js). The account template's
 * PHOTO.UPLOAD capabilityProvider + the fall-through case in the aggregator's Utils.js route
 * "com.palm.yandexdisk" here.
 *
 * The surfaced album is resolved at call time by Adapter.resolvePhotoAlbum: Yandex's own
 * camera-uploads folder (system_folders.photostream, e.g. "disk:/Фотокамера/") when it exists,
 * else Config.PHOTO_ALBUM_NAME ("Pictures"). isImage runs on the NORMALIZED listFolder entry
 * shape ({type,name,mimeType}) - Yandex carries mime_type, so it is the primary signal.
 */
var PhotoLib = {
	IMAGE_RE: /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i,

	isImage: function (e) {
		if (!e || e.type !== "file") { return false; }
		if (e.mimeType && /^image\//i.test(e.mimeType)) { return true; }
		return PhotoLib.IMAGE_RE.test(e.name || "");
	}
};

if (typeof exports !== "undefined") { exports.PhotoLib = PhotoLib; }
