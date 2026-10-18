/*global console */
/* photolib.js - helpers for the Photos-app provider role of the Box service (mirrors the
 * Dropbox one). ONE Box folder is surfaced as ONE album to bound how much auto-downloads
 * to /media/internal. Box is ID-based, so ALBUM_FOLDER is a Box folder ID: default root
 * "0" scans everything - set it to a specific photos folder's ID to bound the download.
 */
var PhotoLib = {
	ALBUM_FOLDER: "0",         // Box folder id shown as the album (root "0" = whole account)
	ALBUM_NAME:   "Box Photos",
	IMAGE_RE: /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i,

	// operates on RAW Box /folders/{id}/items entries: { type:"file"|"folder", id, name }
	isImage: function (entry) {
		return !!(entry && entry.type === "file" && PhotoLib.IMAGE_RE.test(entry.name || ""));
	}
};

if (typeof exports !== "undefined") { exports.PhotoLib = PhotoLib; }
