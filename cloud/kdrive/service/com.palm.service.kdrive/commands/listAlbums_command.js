/*global Adapter, AccountCreds, PhotoLib, console */
/* listAlbums - Photos-aggregator contract. args: { accountId }
 * Surfaces the single configured kDrive folder (Config.PHOTO_ALBUM_NAME, directly under the
 * writable private-space root) as one album:
 *   { returnValue:true, albums:[ { aid, name, size:{images:N} } ] }
 * aid is the folder's (string) id, or "" when the folder doesn't exist yet; it is handed to
 * listPhotos verbatim.
 */
function ListAlbumsCommandAssistant() {}

ListAlbumsCommandAssistant.prototype = {
	// NO allowedAppIds: the stock Photos aggregator calls provider services over the private bus
	// with NO bus identity (applicationID/senderServiceName both empty), so listAlbums/listPhotos
	// stay open (guarded by the LS2 private-bus role), matching the stock facebook/photobucket
	// providers. listFolder/uploadFile/downloadFile stay ACL-gated - those are called by APPS.

	run: function (future) {
		var self = this, args = this.controller.args || {};
		var name = PhotoLib.albumName();

		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var af = Adapter.findAlbumFolder(creds, name, function (nc) { renewed = nc; });
			af.then(self, function () {
				var folderId = null;
				try { folderId = af.result; }
				catch (e2) { folderId = null; }
				// Folder absent -> still surface the (empty) album so the source shows in Photos
				// rather than silently vanishing; it populates once the user creates the folder.
				if (folderId == null) {
					future.result = { returnValue: true,
						albums: [{ aid: "", name: name, size: { images: 0 } }] };
					return;
				}
				var lf = Adapter.listFolder(creds, folderId, function (nc) { renewed = nc; });
				lf.then(self, function () {
					var entries;
					try { entries = (lf.result && lf.result.entries) || []; }
					catch (e3) { entries = []; }
					if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
					var count = 0;
					entries.forEach(function (e) { if (PhotoLib.isImage(e)) { count++; } });
					future.result = { returnValue: true,
						albums: [{ aid: String(folderId), name: name, size: { images: count } }] };
				});
			});
		});
	}
};
