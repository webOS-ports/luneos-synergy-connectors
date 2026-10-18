/*global FlickrApi, AccountCreds, PhotoLib, Acl, console */
/* listAlbums - Photos-aggregator contract. args: { accountId }
 * Returns every Flickr photoset as an album, PLUS one synthetic "All Photos" album:
 *   { returnValue:true, albums:[ { aid, name, size:{images:N} } ] }
 * aid is the photoset id (or FlickrApi.ALL_PHOTOS_AID for the synthetic album); it is
 * handed back to listPhotos verbatim.
 *
 * NO allowedAppIds: the stock Photos aggregator calls provider services over the private
 * bus with NO bus identity, indistinguishable from any private-bus caller - so, like the
 * stock facebook/photobucket providers (and our Dropbox/OneDrive connectors), listAlbums/
 * listPhotos are left open and rely on the LS2 private-bus role for access control.
 */
function ListAlbumsCommandAssistant() {}

ListAlbumsCommandAssistant.prototype = {
	run: function (future) {
		var self = this, args = this.controller.args || {};
		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }

			var albums = [];
			var setsF = FlickrApi.listPhotosets(creds);
			setsF.then(self, function () {
				var data;
				try { data = setsF.result; }
				catch (e2) {
					// No sets / call failed - still surface the "All Photos" album below so the
					// source shows up in Photos rather than silently vanishing.
					console.log("flickr: listAlbums - photosets unavailable: " +
						(e2 && (e2.message || e2.status)));
					data = {};
				}
				var sets = (data.photosets && data.photosets.photoset) || [];
				sets.forEach(function (s) {
					albums.push({
						aid:  s.id,
						name: (s.title && s.title._content !== undefined) ? s.title._content : String(s.id),
						size: { images: parseInt(s.photos, 10) || 0 }
					});
				});

				// Synthetic "All Photos" album: one lightweight call to read the total count.
				var allF = FlickrApi.allPhotos(creds, "1");
				allF.then(self, function () {
					var total = 0;
					try {
						var ad = allF.result;
						total = (ad.photos && parseInt(ad.photos.total, 10)) || 0;
					} catch (e3) { total = 0; }
					albums.unshift({
						aid:  FlickrApi.ALL_PHOTOS_AID,
						name: FlickrApi.ALL_PHOTOS_NAME,
						size: { images: total }
					});
					future.result = { returnValue: true, albums: albums };
				});
			});
		});
	}
};
