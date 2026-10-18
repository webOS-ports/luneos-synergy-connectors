/*global Adapter, AccountCreds, PhotoLib, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the Box folder ID from listAlbums. Returns one entry per image file:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 * src_big is a Box /content?access_token= URL (302 -> dl.boxcloud.com) the aggregator's
 * curl (-L) fetches with no auth header. Unlike Dropbox, Box needs NO per-file API call to
 * build the URL - it is synchronous from the current access token.
 */
function ListPhotosCommandAssistant() {}

ListPhotosCommandAssistant.prototype = {
	run: function (future) {
		var self = this, args = this.controller.args || {};
		var aid = args.aid || PhotoLib.ALBUM_FOLDER;
		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var lf = Adapter.listFolder(creds, aid, function (nc) { renewed = nc; });
			lf.then(self, function () {
				var data;
				try { data = lf.result; }
				catch (e2) { future.setException(e2); return; }
				var useCreds = renewed || creds;   // build URLs with the freshest token
				var photos = (data.entries || []).filter(PhotoLib.isImage).map(function (e) {
					var url = Adapter.contentUrl(useCreds, e.id);
					return { pid: e.id, src_big: url, src_small: url,
						caption: e.name, type: "image", fileName: e.name };
				});
				if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
				future.result = { returnValue: true, photos: photos };
			});
		});
	}
};
