/*global Adapter, AccountCreds, PhotoLib, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the album folder id from listAlbums. Returns one entry per image file:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 * src_big is the kDrive download URL and src_small the thumbnail URL, both self-authenticating via
 * ?access_token= so the aggregator's headerless curl fetch works - kDrive needs NO per-photo
 * temporary-link round-trip (unlike Dropbox). fileName carries the real name+extension so the
 * aggregator stores/renders a properly-named local file.
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
				if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
				var photos = entries.filter(PhotoLib.isImage).map(function (e) {
					return {
						pid:       e.id,                              // stable kDrive file id (string)
						src_big:   Adapter.photoDownloadUrl(creds, e.id),
						src_small: Adapter.photoThumbUrl(creds, e.id),
						caption:   e.name,
						type:      "image",
						fileName:  e.name                             // preserve real name+ext
					};
				});
				future.result = { returnValue: true, photos: photos };
			});
		});
	}
};
