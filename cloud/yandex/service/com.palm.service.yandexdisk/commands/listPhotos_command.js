/*global Adapter, AccountCreds, PhotoLib, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the album folder path from listAlbums. Returns one entry per image file:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 * Yandex has no self-authenticating per-item URL (unlike kDrive), so - exactly like Dropbox -
 * we resolve a short-lived signed download href PER image via Adapter.getTemporaryLink; that
 * href is fetched header-less by the aggregator's curl. Links are resolved sequentially to
 * avoid a burst of curl processes. src_small = src_big (the aggregator regenerates thumbnails).
 * fileName carries the real name+extension so the aggregator stores a properly-named file.
 */
function ListPhotosCommandAssistant() {}

ListPhotosCommandAssistant.prototype = {
	// NO allowedAppIds - see listAlbums_command.js (aggregator calls with no bus identity).

	run: function (future) {
		var self = this, args = this.controller.args || {};
		var aid = args.aid;
		if (aid == null || aid === "") {
			future.result = { returnValue: true, photos: [] };
			return;
		}

		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var lf = Adapter.listFolder(creds, aid, function (nc) { renewed = nc; });
			lf.then(self, function () {
				var entries;
				try { entries = (lf.result && lf.result.entries) || []; }
				catch (e2) { future.setException(e2); return; }
				var images = entries.filter(PhotoLib.isImage);
				var photos = [];
				var i = 0;

				function finish() {
					if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
					future.result = { returnValue: true, photos: photos };
				}
				function next() {
					if (i >= images.length) { finish(); return; }
					var e = images[i++];
					var tl = Adapter.getTemporaryLink(creds, e.path, function (nc) { renewed = nc; });
					tl.then(self, function () {
						var link = null;
						try { link = tl.result && tl.result.link; }
						catch (er) { link = null; }
						if (link) {
							photos.push({
								pid:       e.path,      // stable "disk:/.." locator
								src_big:   link,
								src_small: link,        // aggregator regenerates thumbnails locally
								caption:   e.name,
								type:      "image",
								fileName:  e.name       // preserve real name+ext for local storage
							});
						} else {
							console.log("yandex: listPhotos - no temp link for " + e.path);
						}
						next();
					});
				}
				next();
			});
		});
	}
};
