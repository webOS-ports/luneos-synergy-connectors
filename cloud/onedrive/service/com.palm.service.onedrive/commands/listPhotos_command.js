/*global Adapter, AccountCreds, PhotoLib, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the special-folder name from listAlbums ("cameraroll"). Returns one entry per image:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 * src_big is each item's `@microsoft.graph.downloadUrl` - a short-lived PRE-SIGNED URL the
 * aggregator's curl (-L) fetches with NO auth header (Graph returns it inline when children
 * are listed without $select, so no per-file API call is needed). A missing Camera Roll
 * degrades to an empty list rather than erroring the aggregator.
 */
function ListPhotosCommandAssistant() {}

ListPhotosCommandAssistant.prototype = {
	run: function (future) {
		var self = this, args = this.controller.args || {};
		var special = args.aid || PhotoLib.ALBUM_FOLDER;
		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var lf = Adapter.listSpecialChildren(creds, special, function (nc) { renewed = nc; });
			lf.then(self, function () {
				var data;
				try { data = lf.result; }
				catch (e2) {
					console.log("onedrive: listPhotos - Camera Roll unavailable: " + (e2 && e2.status));
					future.result = { returnValue: true, photos: [] };
					return;
				}
				var photos = (data.value || []).filter(PhotoLib.isImage).map(function (e) {
					var url = e["@microsoft.graph.downloadUrl"];   // pre-signed, no header needed
					return { pid: e.id, src_big: url, src_small: url,
						caption: e.name, type: "image", fileName: e.name };
				}).filter(function (p) { return !!p.src_big; });
				if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
				future.result = { returnValue: true, photos: photos };
			});
		});
	}
};
