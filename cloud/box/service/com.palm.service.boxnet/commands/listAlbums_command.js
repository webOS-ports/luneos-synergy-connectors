/*global Adapter, AccountCreds, PhotoLib, console */
/* listAlbums - Photos-aggregator contract. args: { accountId }
 * Surfaces the single configured Box folder as one album:
 *   { returnValue:true, albums:[ { aid, name, size:{images:N} } ] }
 * aid is the Box folder ID; it is handed back to listPhotos verbatim.
 * NOTE: no allowedAppIds - the Photos aggregator calls provider services with no bus
 * identity (see the Dropbox connector), so this matches the stock open-provider model.
 */
function ListAlbumsCommandAssistant() {}

ListAlbumsCommandAssistant.prototype = {
	run: function (future) {
		var self = this, args = this.controller.args || {};
		var album = { aid: PhotoLib.ALBUM_FOLDER, name: PhotoLib.ALBUM_NAME, size: { images: 0 } };
		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var call = Adapter.listFolder(creds, PhotoLib.ALBUM_FOLDER, function (nc) { renewed = nc; });
			call.then(self, function () {
				var data;
				try { data = call.result; }
				catch (e2) {
					console.log("boxnet: listAlbums - folder " + PhotoLib.ALBUM_FOLDER +
						" unavailable: " + (e2 && e2.status));
					future.result = { returnValue: true, albums: [album] };
					return;
				}
				if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
				var count = 0;
				(data.entries || []).forEach(function (e) { if (PhotoLib.isImage(e)) { count++; } });
				album.size.images = count;
				future.result = { returnValue: true, albums: [album] };
			});
		});
	}
};
