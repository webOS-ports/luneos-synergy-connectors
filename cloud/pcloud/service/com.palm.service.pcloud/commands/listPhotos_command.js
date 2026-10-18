/*global Adapter, AccountCreds, PhotoLib, console */
/* listPhotos - Photos-aggregator contract. args: { accountId, aid }
 * aid is the pCloud folderid from listAlbums (default 0 = root). Returns one entry per image:
 *   { returnValue:true, photos:[ { pid, src_big, src_small, caption, type:"image", fileName } ] }
 * src_big/src_small are pre-signed temporary https links (getfilelink); the aggregator's
 * (curl-patched) downloader fetches them to local storage. fileName carries the real name+ext
 * so the aggregator stores a properly-named local file (the temp-link URL path has no name).
 * Temporary links are resolved sequentially to avoid a burst of curl processes.
 * NO allowedAppIds - see listAlbums_command.js.
 */
function ListPhotosCommandAssistant() {}

ListPhotosCommandAssistant.prototype = {
	run: function (future) {
		var self = this, args = this.controller.args || {};
		var aid = (args.aid != null) ? args.aid : PhotoLib.ALBUM_FOLDER;
		var credF = AccountCreds.resolve(args);
		credF.then(this, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var lf = Adapter.listFolderRaw(creds, aid, function () {});
			lf.then(self, function () {
				var data;
				try { data = lf.result; }
				catch (e2) {
					console.log("pcloud: listPhotos - folder " + aid + " unavailable: " +
						(e2 && (e2.result || e2.status)));
					future.result = { returnValue: true, photos: [] };
					return;
				}
				var contents = (data.metadata && data.metadata.contents) || [];
				var images = contents.filter(PhotoLib.isImage);
				var photos = [];
				var i = 0;

				function finish() { future.result = { returnValue: true, photos: photos }; }
				function next() {
					if (i >= images.length) { finish(); return; }
					var e = images[i++];   // raw pCloud entry: name, fileid, size, contenttype
					var gl = Adapter.getFileLink(creds, e.fileid, function () {});
					gl.then(self, function () {
						var link = null;
						try { link = gl.result && gl.result.url; }
						catch (er) { link = null; }
						if (link) {
							photos.push({
								pid:       e.fileid,   // stable pCloud file id
								src_big:   link,
								src_small: link,       // aggregator regenerates thumbnails locally
								caption:   e.name,
								type:      "image",
								fileName:  e.name      // preserve real name+ext for local storage
							});
						} else {
							console.log("pcloud: listPhotos - no link for fileid " + e.fileid);
						}
						next();
					});
				}
				next();
			});
		});
	}
};
