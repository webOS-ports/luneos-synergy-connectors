/*global FlickrApi, AccountCreds, PhotoLib, Acl, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the album id from listAlbums: a photoset id, or FlickrApi.ALL_PHOTOS_AID for the
 * synthetic "All Photos" album. Returns one entry per image:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 * src_big/src_small are plain https static URLs (live.staticflickr.com) with the download
 * URLs inlined via extras, so NO per-photo API call is needed and the aggregator's curl
 * fetches them with no auth header. fileName carries a real name+ext for local storage.
 *
 * NO allowedAppIds - see listAlbums_command.js (Photos aggregator calls with no bus identity).
 */
function ListPhotosCommandAssistant() {}

ListPhotosCommandAssistant.prototype = {
	run: function (future) {
		var self = this, args = this.controller.args || {};
		var aid = args.aid || FlickrApi.ALL_PHOTOS_AID;

		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }

			var listF = (aid === FlickrApi.ALL_PHOTOS_AID)
				? FlickrApi.allPhotos(creds, "500")
				: FlickrApi.photosetPhotos(creds, aid);

			listF.then(self, function () {
				var data;
				try { data = listF.result; }
				catch (e2) {
					console.log("flickr: listPhotos - album '" + aid + "' unavailable: " +
						(e2 && (e2.message || e2.status)));
					future.result = { returnValue: true, photos: [] };
					return;
				}
				// people.getPhotos -> data.photos.photo[]; photosets.getPhotos -> data.photoset.photo[].
				var raw = (data.photos && data.photos.photo) ||
					(data.photoset && data.photoset.photo) || [];
				var photos = [];
				raw.forEach(function (p) {
					if (!PhotoLib.isImage(p)) { return; }
					var entry = PhotoLib.toPhotoEntry(p);
					if (entry) { photos.push(entry); }
				});
				future.result = { returnValue: true, photos: photos };
			});
		});
	}
};
