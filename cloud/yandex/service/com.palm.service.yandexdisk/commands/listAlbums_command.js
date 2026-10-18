/*global Adapter, AccountCreds, PhotoLib, console */
/* listAlbums - Photos-aggregator contract. args: { accountId }
 * Surfaces ONE Yandex folder as one album:
 *   { returnValue:true, albums:[ { aid, name, size:{images:N} } ] }
 * The folder is Adapter.resolvePhotoAlbum's choice - Yandex's camera-uploads folder
 * (system_folders.photostream) when it exists, else "Pictures". aid is the "disk:/.." path,
 * handed to listPhotos verbatim.
 */
function ListAlbumsCommandAssistant() {}

ListAlbumsCommandAssistant.prototype = {
	// NO allowedAppIds: the stock Photos aggregator calls provider services over the private bus
	// with NO bus identity (applicationID/senderServiceName both empty), so listAlbums/listPhotos
	// stay open (guarded by the LS2 private-bus role), matching the stock facebook/photobucket
	// providers. listFolder/uploadFile/downloadFile stay ACL-gated - those are called by APPS.

	run: function (future) {
		var self = this, args = this.controller.args || {};

		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var albF = Adapter.resolvePhotoAlbum(creds, function (nc) { renewed = nc; });
			albF.then(self, function () {
				var album;
				try { album = albF.result; }
				catch (e2) { album = { path: "disk:/Pictures", name: "Pictures" }; }
				var lf = Adapter.listFolder(creds, album.path, function (nc) { renewed = nc; });
				lf.then(self, function () {
					var entries;
					// Folder missing/empty -> still surface the (empty) album so the source
					// shows in Photos rather than silently vanishing.
					try { entries = (lf.result && lf.result.entries) || []; }
					catch (e3) { entries = []; }
					if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
					var count = 0;
					entries.forEach(function (e) { if (PhotoLib.isImage(e)) { count++; } });
					// aid must be FILESYSTEM-SAFE: the Photos aggregator builds a local cache dir
					// "<aid>-<name>", so an internal "/" (from "disk:/Pictures") makes it a nested
					// path whose parent doesn't exist -> mkdir ENOENT -> sync aborts. Strip the
					// "disk:/" prefix to a bare single-segment token; listPhotos._normPath maps it
					// back ("Pictures" -> "disk:/Pictures").
					var aid = String(album.path).replace(/^disk:\//, "").replace(/\/+$/, "");
					future.result = { returnValue: true,
						albums: [{ aid: aid, name: album.name, size: { images: count } }] };
				});
			});
		});
	}
};
