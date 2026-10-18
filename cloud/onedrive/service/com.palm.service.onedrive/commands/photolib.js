/*global console */
/* photolib.js - helpers for the Photos-app provider role of the OneDrive service (mirrors
 * the Dropbox/Box ones). OneDrive has no album model, so we surface the Camera Roll special
 * folder as ONE album - the natural "my photos" source and a bound on how much auto-
 * downloads to /media/internal. ALBUM_FOLDER is a Graph SPECIAL-folder name, not an id.
 */
var PhotoLib = {
	ALBUM_FOLDER: "cameraroll",     // Graph /me/drive/special/{name} - the phone Camera Roll
	ALBUM_NAME:   "Camera Roll",
	IMAGE_RE: /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i,

	// operates on RAW Graph driveItems: a file has a `file` facet (folders have `folder`).
	isImage: function (entry) {
		return !!(entry && entry.file && PhotoLib.IMAGE_RE.test(entry.name || ""));
	}
};

if (typeof exports !== "undefined") { exports.PhotoLib = PhotoLib; }
