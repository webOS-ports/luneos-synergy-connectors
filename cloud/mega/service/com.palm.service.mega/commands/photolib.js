/*global console */
/* photolib.js - helpers for the Photos-app provider role of the Mega service. Mirrors the other
 * connectors: the stock Photos aggregator (com.palm.service.photos) calls listAlbums/listPhotos
 * and stores the bytes itself. isImage runs on the NORMALISED listFolder entry shape
 * ({type,name,mimeType}); Mega attributes give us the real filename, so the name regex is the
 * primary signal (adapter also fills a coarse mimeType for common image types).
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
