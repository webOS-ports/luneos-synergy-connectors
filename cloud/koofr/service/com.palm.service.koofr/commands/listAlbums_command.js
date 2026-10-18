/*global Adapter, AccountCreds, PhotoLib, Config, console */
/* listAlbums - Photos-aggregator contract. args: { accountId }
 *   { returnValue:true, albums:[ { aid, name, size:{images:N} } ] }
 * aid is the album's absolute Koofr path (handed to listPhotos, URL-encoded so it is slash-free).
 * We surface the mount root's direct images plus every immediate sub-folder that holds images
 * (see Adapter.photoAlbums) - e.g. Koofr's default "My pictures". If there are no images anywhere
 * we still surface an empty "Camera Uploads" placeholder so the source appears in Photos (created
 * on first device->cloud upload).
 */
function ListAlbumsCommandAssistant() {}

ListAlbumsCommandAssistant.prototype = {
	// NO allowedAppIds: the Photos aggregator calls provider services over the private bus.
	run: function (future) {
		var self = this, args = this.controller.args || {};
		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; } catch (e) { future.setException(e); return; }
			var renewed = null;
			var af = Adapter.photoAlbums(creds, function (nc) { renewed = nc; });
			af.then(self, function () {
				var albums;
				try { albums = (af.result && af.result.albums) || []; } catch (e2) { albums = []; }
				if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
				// aid MUST be slash-free: the Photos aggregator builds a local album directory from
				// it (<aid>-<name>) with a NON-recursive mkdir, so a raw path aid like "/My pictures"
				// would try to create nested dirs and fail ENOENT. Encode the path (slashes -> %2F);
				// listPhotos decodes it back.
				var out = albums.map(function (a) {
					return { aid: encodeURIComponent(a.aid), name: a.name, size: { images: a.images || 0 } };
				});
				if (!out.length) {
					out = [{ aid: "", name: (Config.PHOTO_ALBUM_NAME || "Camera Uploads"), size: { images: 0 } }];
				}
				future.result = { returnValue: true, albums: out };
			});
		});
	}
};
