/*global Adapter, AccountCreds, PhotoLib, Config, console */
/* listAlbums - Photos-aggregator contract. args: { accountId }
 * Surfaces the account's photo folders as albums:
 *   { returnValue:true, albums:[ { aid, name, size:{images:N} } ] }
 * aid is the opaque node HANDLE (8 base64 chars - filesystem-safe, no "/"), handed to listPhotos
 * verbatim. We surface the Cloud Drive ROOT (photos kept at top level) plus every folder that
 * holds images (see Adapter.photoAlbums). If the account has no images at all we still surface an
 * empty "Camera Uploads" placeholder so the source appears in Photos (it is created on the first
 * device->cloud upload).
 */
function ListAlbumsCommandAssistant() {}

ListAlbumsCommandAssistant.prototype = {
	// NO allowedAppIds: the stock Photos aggregator calls provider services over the private bus
	// with no bus identity (see the other connectors' listAlbums).

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
				var out = albums.map(function (a) {
					return { aid: a.aid, name: a.name, size: { images: a.images || 0 } };
				});
				if (!out.length) {
					// No images anywhere yet - keep the source visible with an empty placeholder.
					out = [{ aid: "", name: (Config && Config.PHOTO_ALBUM_NAME) || "Camera Uploads",
						size: { images: 0 } }];
				}
				future.result = { returnValue: true, albums: out };
			});
		});
	}
};
