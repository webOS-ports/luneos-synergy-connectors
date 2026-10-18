/*global HttpCurl, Acl, console */
/* downloadFile - download a Flickr photo to a local path. args:
 *   { url, localPath }        (url = a live.staticflickr.com static URL from listPhotos)
 * Writes the bytes to localPath (curl streams to disk, --create-dirs makes parents).
 * Flickr static URLs are public - the id_secret pair is itself the capability - so NO
 * OAuth signing / auth header is needed for the fetch; only the modern TLS transport.
 *
 * In normal operation the stock Photos aggregator downloads photos itself (its curl-patched
 * Sync-Manager consumes the src_big URLs from listPhotos), so this command exists for
 * completeness / direct consumers. Restricted to the photos app via allowedAppIds.
 */
function DownloadFileCommandAssistant() {}

DownloadFileCommandAssistant.prototype = {
	allowedAppIds: ["com.palm.app.photos"],

	run: function (future) {
		if (!Acl.enforce(this, future)) { return; }
		var args = this.controller.args || {};
		if (!args.url || !args.localPath) {
			future.setException({ returnValue: false, errorCode: "MISSING_ARGS",
				detail: "need url and localPath" });
			return;
		}
		var call = HttpCurl.request({ method: "GET", url: args.url, outFile: args.localPath });
		call.then(this, function () {
			var r;
			try { r = call.result; }
			catch (e) { future.setException(e); return; }
			if (!r || r.status < 200 || r.status >= 300) {
				future.setException({ returnValue: false, errorCode: "DOWNLOAD_FAILED",
					status: r && r.status });
				return;
			}
			future.result = { returnValue: true, path: args.localPath };
		});
	}
};
