/*global console */
/* photolib.js - helpers for the Photos-app provider role of the pCloud service (mirrors the
 * Dropbox/Box/OneDrive ones).
 *
 * The stock Photos aggregator (com.palm.service.photos) treats this service as a cloud photo
 * provider: it calls listAlbums/listPhotos, then downloads the bytes to local storage itself
 * (see the curl patch in that service's Sync-Manager.js). The account template's PHOTO.UPLOAD
 * capabilityProvider + the templateId->serviceName switch in the aggregator's Utils.js route
 * "com.palm.pcloud" here.
 *
 * pCloud has NO photo/album API, so - like Dropbox - ONE pCloud folder is surfaced as ONE
 * album to bound how much gets auto-downloaded into /media/internal. pCloud is ID-based, so
 * the album is identified by a numeric folderid (default 0 = the pCloud root). To point at a
 * different folder, change ALBUM_FOLDER/ALBUM_NAME below to that folder's id/name.
 */
var PhotoLib = {
	ALBUM_FOLDER: 0,          // the single pCloud folderid shown as an album (0 = root)
	ALBUM_NAME:   "pCloud",
	IMAGE_RE: /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i,

	// NB: operates on RAW pCloud listfolder entries (keyed on isfolder/name), because
	// listAlbums/listPhotos call Adapter.listFolderRaw in-process - NOT the normalized
	// {type,path} shape the listFolder *command* returns to apps. A file is an image if it is
	// not a folder and either its contenttype is image/* or its name has an image extension.
	isImage: function (entry) {
		if (!entry || entry.isfolder) { return false; }
		if (entry.contenttype && /^image\//i.test(entry.contenttype)) { return true; }
		return PhotoLib.IMAGE_RE.test(entry.name || "");
	}
};

if (typeof exports !== "undefined") { exports.PhotoLib = PhotoLib; }
