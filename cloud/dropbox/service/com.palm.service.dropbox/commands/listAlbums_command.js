/*global Adapter, AccountCreds, PhotoLib, Acl, console */
/* listAlbums - Photos-aggregator contract. args: { accountId }
 * Returns the single configured Dropbox folder as one album:
 *   { returnValue:true, albums:[ { aid, name, size:{images:N} } ] }
 * aid is the Dropbox path; it is handed back to listPhotos verbatim.
 */
function ListAlbumsCommandAssistant() {}

ListAlbumsCommandAssistant.prototype = {
	// NO allowedAppIds: the stock Photos aggregator calls provider services (facebook/
	// photobucket) over the private bus with NO bus identity (applicationID/senderServiceName
	// both empty), so it is indistinguishable from any private-bus caller - the stock
	// providers therefore leave listAlbums/listPhotos open and rely on the LS2 private-bus
	// role for access control. We match that. (listFolder/uploadFile/downloadFile stay ACL-
	// gated because those are called by APPS, which DO carry an appId.)

	run: function (future) {
		var self = this, args = this.controller.args || {};
		var album = { aid: PhotoLib.ALBUM_PATH, name: PhotoLib.ALBUM_NAME, size: { images: 0 } };

		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var call = Adapter.listFolderRaw(creds, PhotoLib.ALBUM_PATH, function (nc) { renewed = nc; });
			call.then(self, function () {
				var data;
				try { data = call.result; }
				catch (e2) {
					// Folder missing/empty (e.g. path/not_found) - still surface the album
					// (0 images) so the source shows up in Photos rather than silently vanishing.
					console.log("dropbox: listAlbums - " + PhotoLib.ALBUM_PATH + " unavailable: " +
						(e2 && e2.status));
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
