/*global console */
/* photolib.js - helpers for the Photos-app provider role of the Dropbox service.
 *
 * The stock Photos aggregator (com.palm.service.photos) treats this service as a
 * cloud photo provider: it calls listAlbums/listPhotos, then downloads the bytes to
 * local storage itself (see the curl patch in that service's Sync-Manager.js). The
 * account template's PHOTO.UPLOAD capabilityProvider + the templateId->serviceName
 * switch in the aggregator's Utils.js route "com.palm.dropbox" here.
 *
 * Per the user's choice, ONE Dropbox folder is surfaced as ONE album (default
 * "/Camera Uploads") to bound how much gets auto-downloaded into /media/internal.
 * To point at a different folder, change ALBUM_PATH/ALBUM_NAME below.
 */
var PhotoLib = {
	ALBUM_PATH: "/Camera Uploads",   // the single Dropbox folder shown as an album
	ALBUM_NAME: "Camera Uploads",
	IMAGE_RE: /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i,

	// NB: operates on RAW Dropbox list_folder entries (keyed on ".tag"/path_lower),
	// because listAlbums/listPhotos call Adapter.listFolderRaw in-process - NOT the
	// normalized {type,path} shape the listFolder *command* returns to apps.
	isImage: function (entry) {
		return !!(entry && entry[".tag"] === "file" && PhotoLib.IMAGE_RE.test(entry.name || ""));
	}
};

if (typeof exports !== "undefined") { exports.PhotoLib = PhotoLib; }
