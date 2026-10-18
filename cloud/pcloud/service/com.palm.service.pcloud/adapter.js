/*global IMPORTS, Config, HttpCurl, console */
/* adapter.js - pCloud REST provider ADAPTER for _cloudcore. pCloud is RESTful and numeric-ID
 * addressed (folder = folderid, root = 0; file = fileid) with TWO quirks baked in here:
 *   1. REGION HOST. Every call goes to the account's data-region host (api.pcloud.com US /
 *      eapi.pcloud.com EU), carried in creds.apiHost; _host() resolves it per call. The auth
 *      token is sent as an access_token QUERY param, not a Bearer header.
 *   2. RESULT ENVELOPE. pCloud returns HTTP 200 even on logical errors, flagged by a nonzero
 *      top-level `result` (0 = success); _parse() turns a nonzero result into an exception.
 * There is NO refresh-on-401 (pCloud tokens are long-lived and have no refresh flow), so the
 * cb/onRenewed argument is accepted only for call-site symmetry and is never invoked. All HTTPS
 * runs through _cloudcore/httpcurl because the device node is OpenSSL 0.9.8k.
 *
 * Uniform _cloudcore adapter interface (normalised shapes):
 *   listFolder(creds, folderId, cb) -> { entries:[{id,type,name,size,modified,path,mimeType}] }
 *   downloadFile(creds, fileId, localDest, exportMime, cb) -> { path }   (exportMime ignored)
 *   uploadFile(creds, folderId, localPath, name, mimeType, cb) -> raw pCloud {fileids,metadata}
 *   uploadReplace(creds, fileId, localPath, mimeType, cb)      -> raw pCloud {fileids,metadata}
 *   getAccountInfo(creds, cb) -> { user:{ displayName, emailAddress } }
 * Plus listFolderRaw() + getFileLink() used by the per-provider Photos commands, which need the
 * RAW pCloud listfolder entries (isfolder/fileid/contenttype), NOT the normalised shape.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var Adapter = {
	// Resolve the account's region API host (defaults to the US host).
	_host: function (creds) {
		return (creds && creds.apiHost) || Config.DEFAULT_API_HOST;
	},

	// Build a full method URL on the region host with the access_token + params as query.
	_url: function (creds, method, params) {
		var qs = ["access_token=" + encodeURIComponent(creds.accessToken)];
		if (params) {
			Object.keys(params).forEach(function (k) {
				if (params[k] != null) {
					qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
				}
			});
		}
		return "https://" + this._host(creds) + "/" + method + "?" + qs.join("&");
	},

	// GET a pCloud JSON method with the access_token in the query string.
	_get: function (creds, method, params) {
		var self = this, f = new Future();
		f.now(this, function () {
			return HttpCurl.request({ method: "GET", url: self._url(creds, method, params) });
		});
		f.then(this, function () { f.result = self._parse(f.result); });
		return f;
	},

	// Validate transport status + pCloud's `result` envelope; return the parsed JSON.
	_parse: function (r) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "PCLOUD_HTTP_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		var j = r.responseText ? JSON.parse(r.responseText) : {};
		if (j.result && j.result !== 0) {
			throw { returnValue: false, errorCode: "PCLOUD_API_ERROR",
				result: j.result, error: j.error };
		}
		return j;
	},

	// GET /userinfo -> normalise to { user:{ displayName, emailAddress } } (pCloud has no
	// separate display name, so the email doubles as the alias).
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this._get(creds, "userinfo", null);
		call.then(this, function () {
			var u = call.result || {};
			f.result = { user: { emailAddress: u.email, displayName: u.email } };
		});
		return f;
	},

	// RAW /listfolder?folderid={id} -> pCloud { metadata:{ contents:[ item ] } }. Photos need
	// the raw isfolder/fileid/contenttype shape. folderId falsy/""/"root" -> root (folderid 0).
	listFolderRaw: function (creds, folderId, cb) {
		var id = (folderId == null || folderId === "" || folderId === "root") ? Config.ROOT_FOLDER : folderId;
		return this._get(creds, "listfolder", { folderid: id });
	},

	// Normalised list for the generic listFolder command. pCloud items carry isfolder(bool),
	// folderid|fileid, name, size, modified, contenttype; the locator is the numeric id (a
	// folderid for folders, a fileid for files), handed back as the next folderId/fileId.
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var call = this.listFolderRaw(creds, folderId, cb);
		call.then(this, function () {
			var data = call.result || {};
			var contents = (data.metadata && data.metadata.contents) || [];
			f.result = { entries: contents.map(function (e) {
				var id = e.isfolder ? e.folderid : e.fileid;
				return { id: id, type: (e.isfolder ? "folder" : "file"),
					name: e.name, size: e.size, modified: e.modified,
					path: id, mimeType: e.contenttype };
			}) };
		});
		return f;
	},

	// GET /getfilelink?fileid={id} -> { hosts, path }; fetch https://<host><path> to localDest
	// (the path carries an auth hash, so no token/header needed). exportMime ignored.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		var self = this, f = new Future();
		var link = this._get(creds, "getfilelink", { fileid: fileId });
		f.now(this, function () { return link; });
		f.then(this, function () {
			var d;
			try { d = link.result; }
			catch (e) { f.setException(e); return; }
			var hosts = d && d.hosts;
			if (!hosts || !hosts.length || !d.path) {
				f.setException({ returnValue: false, errorCode: "PCLOUD_NO_LINK", detail: d });
				return;
			}
			var url = "https://" + hosts[0] + d.path;
			var dl = HttpCurl.request({ method: "GET", url: url, follow: true, outFile: localDest });
			dl.then(self, function () {
				var r = dl.result;
				if (!r || r.status < 200 || r.status >= 300) {
					f.setException({ returnValue: false, errorCode: "PCLOUD_DOWNLOAD_FAILED",
						status: r && r.status });
					return;
				}
				f.result = { path: localDest };
			});
		});
		return f;
	},

	// GET /getfilelink -> resolve a temporary content URL as a STRING (no download). Used by the
	// Photos provider (listPhotos): the aggregator's curl fetches it to local storage. The link
	// is short-lived and its path carries an auth hash, so no token/header is needed.
	getFileLink: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var link = this._get(creds, "getfilelink", { fileid: fileId });
		f.now(this, function () { return link; });
		f.then(this, function () {
			var d;
			try { d = link.result; }
			catch (e) { f.setException(e); return; }
			var hosts = d && d.hosts;
			if (!hosts || !hosts.length || !d.path) {
				f.setException({ returnValue: false, errorCode: "PCLOUD_NO_LINK", detail: d });
				return;
			}
			f.result = { url: "https://" + hosts[0] + d.path };
		});
		return f;
	},

	// POST /uploadfile?folderid={id}&filename={name}&nopartial=1 with the bytes as a multipart
	// file part. folderId falsy/"" -> root. pCloud overwrites a same-named file in the target
	// folder (old copy kept as a revision), so a plain upload is create-or-overwrite. Returns
	// raw pCloud { fileids, metadata }. mimeType ignored (pCloud infers it).
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var id = (folderId == null || folderId === "") ? Config.ROOT_FOLDER : folderId;
		var url = this._url(creds, "uploadfile", { folderid: id, filename: name, nopartial: 1 });
		var self = this, f = new Future();
		f.now(this, function () {
			return HttpCurl.request({ method: "POST", url: url,
				multipart: [{ name: "file", file: localPath }] });
		});
		f.then(this, function () { f.result = self._parse(f.result); });
		return f;
	},

	// GET /checksumfile?fileid={id} -> { metadata:{ name, parentfolderid } }. Used by
	// uploadReplace to discover where an existing file lives so it can be overwritten in place.
	getFileInfo: function (creds, fileId, cb) {
		return this._get(creds, "checksumfile", { fileid: fileId });
	},

	// Overwrite an EXISTING file by fileid (QuickOffice save-back). pCloud has no upload-by-
	// fileid: look up the file's name + parent folder, then re-upload the local bytes there
	// (same filename + same folder, no renameifexists => overwrite). mimeType ignored.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		var self = this, f = new Future();
		var info = this.getFileInfo(creds, fileId);
		f.now(this, function () { return info; });
		f.then(this, function () {
			var meta;
			try { meta = (info.result && info.result.metadata) || {}; }
			catch (e) { f.setException(e); return; }
			if (meta.name == null || meta.parentfolderid == null) {
				f.setException({ returnValue: false, errorCode: "PCLOUD_NO_FILEINFO", detail: meta });
				return;
			}
			var up = self.uploadFile(creds, meta.parentfolderid, localPath, meta.name, mimeType, cb);
			up.then(self, function () {
				try { f.result = up.result; }
				catch (e2) { f.setException(e2); }
			});
		});
		return f;
	},

	// GET /deletefile?fileid=<id> -> remove a photo (Photos delete button). pid is the pCloud
	// numeric fileid. pCloud signals success with result:0 in the JSON body (non-zero = error).
	deletePhoto: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var g = this._get(creds, "deletefile", { fileid: fileId });
		g.then(this, function () {
			var d;
			try { d = g.result || {}; }
			catch (e) { f.setException(e); return; }
			if (d.result === 0) { f.result = { deleted: true }; }
			else { f.setException({ returnValue: false, errorCode: "PCLOUD_DELETE_FAILED", detail: d }); }
		});
		return f;
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
