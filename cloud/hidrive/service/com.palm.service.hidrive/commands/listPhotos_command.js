/*global Adapter, AccountCreds, PhotoLib, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the album's absolute HiDrive path from listAlbums. Returns one entry per image:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 * src_big is a "/file?path=..&access_token=.." URL (Adapter.getTemporaryLink) the aggregator's
 * curl fetches header-less. Links are resolved sequentially to avoid a burst of curl processes.
 */
function ListPhotosCommandAssistant() {}

ListPhotosCommandAssistant.prototype = {
	// NO allowedAppIds - see listAlbums_command.js.
	run: function (future) {
		var self = this, args = this.controller.args || {};
		// listAlbums encodes the album path into a slash-free aid; decode it back to the path.
		var aid = args.aid;
		if (aid == null || aid === "") { future.result = { returnValue: true, photos: [] }; return; }
		try { aid = decodeURIComponent(aid); } catch (ed) { /* already a plain path */ }

		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; } catch (e) { future.setException(e); return; }
			var renewed = null;
			var lf = Adapter.listFolder(creds, aid, function (nc) { renewed = nc; });
			lf.then(self, function () {
				var entries;
				try { entries = (lf.result && lf.result.entries) || []; }
				catch (e2) { future.setException(e2); return; }
				var images = entries.filter(PhotoLib.isImage);
				var photos = [], i = 0;
				function finish() {
					if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
					future.result = { returnValue: true, photos: photos };
				}
				function next() {
					if (i >= images.length) { finish(); return; }
					var e = images[i++];
					var tl = Adapter.getTemporaryLink(creds, e.id, function (nc) { renewed = nc; });
					tl.then(self, function () {
						var link = null;
						try { link = tl.result && tl.result.link; } catch (er) { link = null; }
						if (link) {
							photos.push({ pid: e.id, src_big: link, src_small: link,
								caption: e.name, type: "image", fileName: e.name });
						}
						next();
					});
				}
				next();
			});
		});
	}
};
