/*global console */
/* photolib.js - helpers for the Photos-app provider role of the generic S3 service. The stock
 * Photos aggregator calls listAlbums/listPhotos, then downloads the bytes itself. isImage runs on
 * the NORMALIZED listFolder entry shape ({type,name,mimeType}); the adapter guesses a mimeType
 * from the key extension, with the name regex as fallback.
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
