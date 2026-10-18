/*global Adapter, AccountCreds, PhotoLib, console */
/* listAlbums - Photos-aggregator contract. args: { accountId }
 * Surfaces the single configured pCloud folder as one album:
 *   { returnValue:true, albums:[ { aid, name, size:{images:N} } ] }
 * aid is the pCloud folderid (default 0 = root); it is handed back to listPhotos verbatim.
 * A missing/empty folder degrades to 0 images, not an error.
 * NOTE: no allowedAppIds - the Photos aggregator calls provider services with no bus identity
 * (see the Dropbox connector), matching the stock open-provider model.
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
			var call = Adapter.listFolderRaw(creds, PhotoLib.ALBUM_FOLDER, function () {});
			call.then(self, function () {
				var data;
				try { data = call.result; }
				catch (e2) {
					console.log("pcloud: listAlbums - folder " + PhotoLib.ALBUM_FOLDER +
						" unavailable: " + (e2 && (e2.result || e2.status)));
					future.result = { returnValue: true, albums: [album] };
					return;
				}
				var contents = (data.metadata && data.metadata.contents) || [];
				var count = 0;
				contents.forEach(function (e) { if (PhotoLib.isImage(e)) { count++; } });
				album.size.images = count;
				future.result = { returnValue: true, albums: [album] };
			});
		});
	}
};
