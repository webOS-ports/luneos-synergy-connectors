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
			f.result = { entries: contents.map(function (e) { return self._entry(e); }) };
		});
		return f;
	},

	// One listFolder entry from a pCloud metadata object.
	_entry: function (e) {
		var id = e.isfolder ? e.folderid : e.fileid;
		return { id: id, type: (e.isfolder ? "folder" : "file"),
			name: e.name, size: e.size, modified: e.modified,
			path: id, mimeType: e.contenttype };
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
				// pCloud names a multipart upload after the part, not the filename parameter.
				multipart: [{ name: "file", file: localPath, filename: name }] });
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
	},

	// --- File manager: createFolder / moveItem / deleteItem (commands/fileOps_commands.js) ----
	// Locators are listFolder's: a bare numeric folderid or fileid. pCloud numbers folders and
	// files separately, so a bare number does not say which it is; pCloud's own typed ids
	// ("d123" folder, "f456" file, metadata.id) are accepted too. A bare number is looked up as
	// both (checksumfile?fileid / listfolder?folderid&nofiles) and refused when it names both,
	// so a file's id can never delete or move a folder, or the other way round.

	// A Future settled by fn(result of g): fn's return value, a Future it returns (nested), or
	// what it (or reading g's result) throws.
	_after: function (g, fn) {
		var self = this, f = new Future();
		g.then(this, function () {
			var v;
			try { v = fn.call(self, g.result); } catch (e) { f.setException(e); return; }
			if (v && typeof v.then === "function") { f.nest(v); } else { f.result = v; }
		});
		return f;
	},
	_err: function (code, text) { return { returnValue: false, errorCode: code, errorText: text }; },
	_fail: function (code, text) {
		var f = new Future();
		f.setException(this._err(code, text));
		return f;
	},
	// "123" / 123 -> { id:"123", kind:null }; "d123" -> folder; "f456" -> file; else null.
	_loc: function (x) {
		// The root as the commands may name it when given no folder.
		if (x === "root" || x === "" || x === "/") { x = "d" + Config.ROOT_FOLDER; }
		var m = /^([df]?)(\d+)$/.exec(String(x == null ? "" : x));
		if (!m) { return null; }
		return { id: m[2], kind: (m[1] === "d") ? "folder" : (m[1] === "f") ? "file" : null };
	},
	// _get, resolving to null instead of failing on the one "does not exist" result code.
	_getOrNull: function (creds, method, params, missing) {
		var f = new Future(), g = this._get(creds, method, params);
		g.then(this, function () {
			try { f.result = g.result; }
			catch (e) {
				if (e && e.errorCode === "PCLOUD_API_ERROR" && e.result === missing) { f.result = null; }
				else { f.setException(e); }
			}
		});
		return f;
	},
	// What a locator names -> { kind:"file"|"folder", meta } (pCloud metadata).
	_resolve: function (creds, loc) {
		var self = this;
		var asFile = (loc.kind === "folder") ? null :
			this._getOrNull(creds, "checksumfile", { fileid: loc.id }, 2009);   // 2009 File not found
		var asFolder = function () {
			return (loc.kind === "file") ? null :
				self._getOrNull(creds, "listfolder", { folderid: loc.id, nofiles: 1 }, 2005);   // 2005 Directory does not exist
		};
		function pick(fileReply, folderReply) {
			var file = fileReply && fileReply.metadata, folder = folderReply && folderReply.metadata;
			if (file && folder) {
				throw self._err("PCLOUD_AMBIGUOUS_ID", "id " + loc.id + " is both a file and a folder; use f" +
					loc.id + " or d" + loc.id);
			}
			if (file) { return { kind: "file", meta: file }; }
			if (folder) { return { kind: "folder", meta: folder }; }
			throw self._err("PCLOUD_NOT_FOUND", "no file or folder " + loc.id);
		}
		if (!asFile) { return this._after(asFolder(), function (d) { return pick(null, d); }); }
		return this._after(asFile, function (fr) {
			var fd = asFolder();
			return fd ? this._after(fd, function (d) { return pick(fr, d); }) : pick(fr, null);
		});
	},

	// GET /createfolder?folderid=<parent>&name=<name> -> { metadata } (2004 if it exists).
	createFolder: function (creds, parent, name, cb) {
		var p = this._loc(parent);
		if (!p || p.kind === "file") { return this._fail("BAD_ARGS", "parent must be a folder id"); }
		return this._after(this._get(creds, "createfolder", { folderid: p.id, name: name }),
			function (d) { return { entry: this._entry(d.metadata || {}) }; });
	},

	// GET /renamefolder or /renamefile ?<id>&tofolderid=&toname= (either or both). renamefolder
	// fails with 2004 on an existing name; renamefile instead REPLACES an existing file of that
	// name (docs.pcloud.com/methods/file/renamefile.html), so for a file the destination folder
	// is listed first and an existing name refused (PCLOUD_EXISTS) - a file manager's move must
	// not overwrite. A change of case only of the item itself is let through.
	moveItem: function (creds, item, toFolder, name, cb) {
		var it = this._loc(item);
		if (!it) { return this._fail("BAD_ARGS", "item must be a file or folder id"); }
		var to = null;
		if (toFolder != null) {
			to = this._loc(toFolder);
			if (!to || to.kind === "file") { return this._fail("BAD_ARGS", "toFolder must be a folder id"); }
		}
		var params = { tofolderid: to ? to.id : null, toname: (name == null) ? null : name };
		return this._after(this._resolve(creds, it), function (r) {
			if (r.kind === "folder") {
				if (String(r.meta.folderid) === String(Config.ROOT_FOLDER)) {
					throw this._err("BAD_ARGS", "the root folder cannot be moved");
				}
				params.folderid = it.id;
				return this._after(this._get(creds, "renamefolder", params),
					function (d) { return { entry: this._entry(d.metadata || {}) }; });
			}
			var destId = to ? to.id : r.meta.parentfolderid;
			var newName = (name == null) ? r.meta.name : name;
			var listing = this._get(creds, "listfolder", { folderid: destId });
			return this._after(listing, function (l) {
				var contents = (l.metadata && l.metadata.contents) || [];
				var lower = String(newName).toLowerCase();
				contents.forEach(function (c) {
					var self_ = !c.isfolder && String(c.fileid) === String(it.id);
					if (!self_ && String(c.name).toLowerCase() === lower) {
						throw this._err("PCLOUD_EXISTS", "an item named " + newName + " already exists there");
					}
				}, this);
				params.fileid = it.id;
				return this._after(this._get(creds, "renamefile", params),
					function (d) { return { entry: this._entry(d.metadata || {}) }; });
			});
		});
	},

	// GET /deletefile?fileid= or /deletefolderrecursive?folderid= - both land in pCloud's Trash.
	deleteItem: function (creds, item, cb) {
		var it = this._loc(item);
		if (!it) { return this._fail("BAD_ARGS", "item must be a file or folder id"); }
		if (it.kind !== "file" && it.id === String(Config.ROOT_FOLDER)) {
			return this._fail("BAD_ARGS", "the root folder cannot be deleted");
		}
		return this._after(this._resolve(creds, it), function (r) {
			var call = (r.kind === "folder") ?
				this._get(creds, "deletefolderrecursive", { folderid: it.id }) :
				this._get(creds, "deletefile", { fileid: it.id });
			return this._after(call, function () { return {}; });
		});
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
