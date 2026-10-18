/*global Adapter, AccountCreds, PhotoLib, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the album folder HANDLE from listAlbums. Returns one entry per image:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 *
 * UNLIKE every other connector, Mega's per-file `g` URL serves CIPHERTEXT (zero-knowledge), so
 * we cannot hand the aggregator a raw URL - it would store an encrypted blob. Instead we
 * download+DECRYPT each image to a local temp file (Adapter.getPhotoLocalPath) and return its
 * file:// path as src_big; the aggregator's curl then just copies the already-plaintext file.
 * Images are processed sequentially to bound memory/curl fan-out. This means the crypto+network
 * work happens here at list time (see [[mega-connector]] - a noted trade-off of E2E storage).
 */
function ListPhotosCommandAssistant() {}

ListPhotosCommandAssistant.prototype = {
	// NO allowedAppIds - see listAlbums_command.js.

	run: function (future) {
		var self = this, args = this.controller.args || {};
		var aid = args.aid;
		if (aid == null || aid === "") { future.result = { returnValue: true, photos: [] }; return; }

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
					var pf = Adapter.getPhotoLocalPath(creds, e.id, e.name, function (nc) { renewed = nc; });
					pf.then(self, function () {
						var link = null;
						try { link = pf.result && pf.result.link; } catch (er) { link = null; }
						if (link) {
							photos.push({ pid: e.id, src_big: link, src_small: link,
								caption: e.name, type: "image", fileName: e.name });
						} else {
							console.log("mega: listPhotos - could not fetch/decrypt " + e.id);
						}
						next();
					});
				}
				next();
			});
		});
	}
};
