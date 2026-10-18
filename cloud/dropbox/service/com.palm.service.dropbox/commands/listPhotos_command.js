/*global Adapter, AccountCreds, PhotoLib, Acl, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the Dropbox folder path from listAlbums. Returns one entry per image file:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 * src_big/src_small are pre-signed temporary https links; the aggregator's (curl-patched)
 * downloader fetches them to local storage. fileName carries the real name+extension so
 * the aggregator stores a properly-named local file (the temp-link URL has no filename).
 * Temporary links are resolved sequentially to avoid a burst of curl processes.
 */
function ListPhotosCommandAssistant() {}

ListPhotosCommandAssistant.prototype = {
	// NO allowedAppIds - see listAlbums_command.js: the Photos aggregator calls with no bus
	// identity, matching the stock open-provider model (guarded by the private-bus role).

	run: function (future) {
		var self = this, args = this.controller.args || {};
		var aid = args.aid || PhotoLib.ALBUM_PATH;

		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var lf = Adapter.listFolderRaw(creds, aid, function (nc) { renewed = nc; });
			lf.then(self, function () {
				var data;
				try { data = lf.result; }
				catch (e2) { future.setException(e2); return; }
				var images = (data.entries || []).filter(PhotoLib.isImage);
				var photos = [];
				var i = 0;

				function finish() {
					if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
					future.result = { returnValue: true, photos: photos };
				}
				function next() {
					if (i >= images.length) { finish(); return; }
					var e = images[i++];   // raw Dropbox entry: name, id, path_lower, path_display
					var tl = Adapter.getTemporaryLink(creds, e.path_lower, function (nc) { renewed = nc; });
					tl.then(self, function () {
						var link = null;
						try { link = tl.result && tl.result.link; }
						catch (er) { link = null; }
						if (link) {
							photos.push({
								pid: e.id,             // stable Dropbox file id
								src_big: link,
								src_small: link,       // aggregator regenerates thumbnails locally
								caption: e.name,
								type: "image",
								fileName: e.name       // preserve real name+ext for local storage
							});
						} else {
							console.log("dropbox: listPhotos - no temp link for " + e.path);
						}
						next();
					});
				}
				next();
			});
		});
	}
};
