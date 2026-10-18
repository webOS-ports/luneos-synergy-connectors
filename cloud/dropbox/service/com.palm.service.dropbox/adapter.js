/*global IMPORTS, Config, OAuth2, HttpCurl, console */
/* adapter.js - Dropbox API v2 provider ADAPTER for _cloudcore. Dropbox is RPC-style
 * (every endpoint POST) and PATH-based: metadata calls POST JSON to API_BASE; file bytes
 * go to CONTENT_BASE with the args in a Dropbox-API-Arg header. Transparent refresh-on-401.
 * All HTTPS runs through _cloudcore/httpcurl (device node is 0.9.8k).
 *
 * Uniform _cloudcore adapter interface (normalised shapes):
 *   listFolder(creds, folderId, cb) -> { entries:[{id,type,name,size,modified,path}] }
 *   downloadFile(creds, fileId, localDest, exportMime, cb) -> { path }   (fileId = dropbox path)
 *   uploadFile(creds, folderId, localPath, name, mimeType, cb) -> metadata
 *   uploadReplace(creds, fileId, localPath, mimeType, cb)      -> metadata
 *   getAccountInfo(creds, cb) -> { user:{ displayName, emailAddress } }
 * Plus listFolderRaw() + getTemporaryLink() used by the per-provider Photos commands, which
 * need the RAW Dropbox entry shape (".tag"/path_lower), NOT the normalised one.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var Adapter = {
	// rpc("/files/list_folder", {path:""}, creds, cb) - POST JSON, refresh-on-401.
	rpc: function (path, argObj, creds, onRenewed) {
		var self = this, url = Config.API_BASE + path;
		var f = new Future();
		function fire(c) {
			return HttpCurl.request({ method: "POST", url: url, bearer: c.accessToken,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(argObj || {}) });
		}
		f.now(this, function () { return fire(creds); });
		f.then(this, function () {
			var r = f.result;
			if (r && r.status === 401 && creds.refreshToken) {
				var rf = OAuth2.refresh(creds.refreshToken);
				rf.then(self, function () {
					var t = rf.result;
					var nc = { accessToken: t.accessToken,
						refreshToken: t.refreshToken || creds.refreshToken,
						expiresAt: Date.now() + (t.expiresIn * 1000) };
					if (onRenewed) { onRenewed(nc); }
					var retry = fire(nc);
					retry.then(self, function () { f.result = self._parse(retry.result); });
				});
				return;
			}
			f.result = self._parse(r);
		});
		return f;
	},

	_parse: function (r) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "DROPBOX_API_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		return r.responseText ? JSON.parse(r.responseText) : {};
	},

	// Root is the empty string ""; "root"/"/"/undefined all normalise to it.
	_normPath: function (p) {
		return (!p || p === "root" || p === "/") ? "" : p;
	},

	// POST /users/get_current_account -> normalise to { user:{ displayName, emailAddress } }.
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this.rpc("/users/get_current_account", null, creds, cb);
		call.then(this, function () {
			var a = call.result || {};
			f.result = { user: {
				emailAddress: a.email,
				displayName:  (a.name && a.name.display_name) || undefined
			} };
		});
		return f;
	},

	// RAW list_folder (Photos commands need ".tag"/path_lower). root = "".
	listFolderRaw: function (creds, path, cb) {
		return this.rpc("/files/list_folder", { path: this._normPath(path) }, creds, cb);
	},

	// Normalised list for the generic listFolder command. Dropbox entries carry ".tag"
	// ("folder"|"file"), name, size, server_modified, path_lower/path_display; the locator is
	// the path (path_lower), handed back as the next folderId (browse) or fileId (download).
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var call = this.listFolderRaw(creds, folderId, cb);
		call.then(this, function () {
			var data = call.result || {};
			f.result = { entries: (data.entries || []).map(function (e) {
				var isFolder = (e[".tag"] === "folder");
				return { id: e.id || e.path_lower, type: (isFolder ? "folder" : "file"),
					name: e.name, size: e.size, modified: e.server_modified,
					path: e.path_lower };
			}) };
		});
		return f;
	},

	// POST /files/get_temporary_link -> { metadata, link } (no-auth ~4h URL). Photos use this.
	getTemporaryLink: function (creds, path, cb) {
		return this.rpc("/files/get_temporary_link", { path: path }, creds, cb);
	},

	// Content endpoints (content.dropboxapi.com): API args in a Dropbox-API-Arg header, HTTP
	// body is the bytes. Same refresh-on-401 as rpc().
	content: function (path, apiArg, opts, creds, onRenewed) {
		var self = this, url = Config.CONTENT_BASE + path;
		var f = new Future();
		function fire(c) {
			var headers = { "Dropbox-API-Arg": JSON.stringify(apiArg) };
			if (opts.dataFile) { headers["Content-Type"] = "application/octet-stream"; }
			return HttpCurl.request({ method: "POST", url: url, bearer: c.accessToken,
				headers: headers, dataFile: opts.dataFile, outFile: opts.outFile });
		}
		f.now(this, function () { return fire(creds); });
		f.then(this, function () {
			var r = f.result;
			if (r && r.status === 401 && creds.refreshToken) {
				var rf = OAuth2.refresh(creds.refreshToken);
				rf.then(self, function () {
					var t = rf.result;
					var nc = { accessToken: t.accessToken,
						refreshToken: t.refreshToken || creds.refreshToken,
						expiresAt: Date.now() + (t.expiresIn * 1000) };
					if (onRenewed) { onRenewed(nc); }
					var retry = fire(nc);
					retry.then(self, function () { f.result = self._parseContent(retry.result, opts); });
				});
				return;
			}
			f.result = self._parseContent(r, opts);
		});
		return f;
	},

	_parseContent: function (r, opts) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "DROPBOX_API_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		if (opts.outFile) { return { path: opts.outFile }; }
		return r.responseText ? JSON.parse(r.responseText) : {};
	},

	// POST /files/download (fileId = dropbox path). exportMime ignored.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		return this.content("/files/download", { path: fileId },
			{ outFile: localDest }, creds, cb);
	},

	// Create a new file at folderId/name (mode overwrite; autorename off).
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var base = this._normPath(folderId);
		var dest = (base.charAt(base.length - 1) === "/" ? base : base + "/") + name.replace(/^\/+/, "");
		return this._upload(creds, dest, localPath, cb);
	},

	// Overwrite the file at fileId (QuickOffice save-back); path-based => upload overwrite.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		return this._upload(creds, fileId, localPath, cb);
	},

	_upload: function (creds, dropboxPath, localPath, cb) {
		return this.content("/files/upload",
			{ path: dropboxPath, mode: "overwrite", autorename: false, mute: false },
			{ dataFile: localPath }, creds, cb);
	},

	// POST /files/delete_v2 { path } -> remove a photo (Photos delete button). listPhotos stored
	// pid as Dropbox's "id:<fileid>" path selector, which delete_v2 accepts directly. rpc rejects
	// (via _parse) on a non-2xx, so the aggregator keeps the local copy on failure.
	deletePhoto: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var call = this.rpc("/files/delete_v2", { path: fileId }, creds, cb);
		call.then(this, function () {
			try { call.result; f.result = { deleted: true }; }
			catch (e) { f.setException(e); }
		});
		return f;
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
