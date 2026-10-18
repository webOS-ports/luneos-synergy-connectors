/*global FlickrApi, console */
/* photolib.js - helpers for the Photos-app provider role of the Flickr service (mirrors
 * the Dropbox/OneDrive ones).
 *
 * The stock Photos aggregator (com.palm.service.photos) treats this service as a cloud
 * photo provider: it calls listAlbums/listPhotos, then downloads the bytes to local
 * storage itself (the curl-patched Sync-Manager in that service). The account template's
 * PHOTO.UPLOAD capabilityProvider + the templateId->serviceName switch in the aggregator's
 * Utils.js route "com.palm.flickr" here.
 *
 * Unlike Dropbox/OneDrive (which surface ONE synthetic folder), Flickr has real albums
 * (photosets), so listAlbums returns every photoset plus one synthetic "All Photos"
 * album. photolib just normalises a raw Flickr photo entry into the aggregator's photo
 * shape; album enumeration lives in flickrapi.js.
 */
var PhotoLib = {
	// Normalise a raw Flickr photo object (from photosets.getPhotos / people.getPhotos)
	// into the aggregator's photo entry, or null if it has no downloadable URL.
	//   { pid, src_big, src_small, caption, type:"image", fileName }
	// src_big/src_small are plain https static URLs; the aggregator's curl fetches them
	// with no auth header. fileName carries a real name+ext for local storage.
	toPhotoEntry: function (p) {
		var url = FlickrApi.resolveDownloadUrl(p);
		if (!url) { return null; }
		return {
			pid:       p.id,
			src_big:   url,
			src_small: url,                         // aggregator regenerates thumbnails locally
			caption:   (p.title && p.title._content !== undefined) ? p.title._content : (p.title || ""),
			type:      "image",
			fileName:  FlickrApi.fileNameFor(p, url)
		};
	},

	// Flickr's photo lists may include videos (media:"video") when extras=media is set.
	// The Photos app only wants stills, so drop anything explicitly flagged as video.
	isImage: function (p) {
		return !!p && p.media !== "video";
	}
};

if (typeof exports !== "undefined") { exports.PhotoLib = PhotoLib; }
