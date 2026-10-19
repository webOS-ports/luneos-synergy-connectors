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
 *   createFolder(creds, parent, name, cb)            -> { entry }   (files/create_folder_v2)
 *   moveItem(creds, item, toFolder|null, name|null, cb) -> { entry } (files/move_v2)
 *   deleteItem(creds, item, cb)                      -> {}          (files/delete_v2)
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
			f.result = { entries: (data.entries || []).map(function (e) { return self._entry(e); }) };
		});
		return f;
	},

	// One Dropbox Metadata object -> the normalised listFolder entry. `type` overrides ".tag"
	// for results whose metadata is declared as FolderMetadata (create_folder_v2), which
	// Dropbox serialises without a ".tag".
	_entry: function (e, type) {
		var isFolder = type ? (type === "folder") : (e[".tag"] === "folder");
		return { id: e.id || e.path_lower, type: (isFolder ? "folder" : "file"),
			name: e.name, size: e.size, modified: e.server_modified,
			path: e.path_lower };
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
		return this._upload(creds, this._join(folderId, name), localPath, cb);
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
	},

	// folder + "/" + name, root ("", "/", "root") giving "/name".
	_join: function (folder, name) {
		var base = this._normPath(folder);
		return (base.charAt(base.length - 1) === "/" ? base : base + "/") + name.replace(/^\/+/, "");
	},

	// The folder a path lives in ("" for an item in the root).
	_parentOf: function (p) {
		return p.substring(0, p.lastIndexOf("/"));
	},

	// rpc() for a call made after another one: a token renewed by an earlier step is used,
	// and reported, from then on.
	_session: function (creds, onRenewed) {
		var s = { creds: creds };
		s.renew = function (nc) {
			var merged = {}, k;
			for (k in s.creds) { if (s.creds.hasOwnProperty(k)) { merged[k] = s.creds[k]; } }
			for (k in nc) { if (nc.hasOwnProperty(k)) { merged[k] = nc[k]; } }
			s.creds = merged;
			if (onRenewed) { onRenewed(nc); }
		};
		return s;
	},

	// Settle `f` from `call`: map(result) on success, the call's exception otherwise.
	_settle: function (f, call, map) {
		call.then(this, function () {
			var v;
			try { v = map(call.result); }
			catch (e) { f.setException(e); return; }
			f.result = v;
		});
	},

	// POST /files/create_folder_v2 { path, autorename:false } -> { metadata:FolderMetadata }.
	// An existing name is a 409 (path/conflict), never a silently renamed copy.
	createFolder: function (creds, parent, name, cb) {
		var self = this, f = new Future();
		this._settle(f, this.rpc("/files/create_folder_v2",
			{ path: this._join(parent, name), autorename: false }, creds, cb),
			function (r) { return { entry: self._entry((r && r.metadata) || {}, "folder") }; });
		return f;
	},

	// POST /files/move_v2 { from_path, to_path, autorename:false } -> { metadata }.
	// Locators are path_lower, so the item's own name is only known lowercased: when the name
	// is kept (move only) - or the item is not a path - POST /files/get_metadata first for the
	// cased name and the parent, so a move does not lowercase the file name.
	moveItem: function (creds, item, toFolder, name, cb) {
		var self = this, f = new Future();
		var s = this._session(creds, cb);
		function move(parent, leaf) {
			self._settle(f, self.rpc("/files/move_v2",
				{ from_path: item, to_path: self._join(parent, leaf), autorename: false },
				s.creds, s.renew),
				function (r) { return { entry: self._entry((r && r.metadata) || {}) }; });
		}
		if (name !== null && name !== undefined && item.charAt(0) === "/") {
			move(toFolder !== null && toFolder !== undefined ? toFolder : this._parentOf(item), name);
			return f;
		}
		var meta = this.rpc("/files/get_metadata", { path: item }, s.creds, s.renew);
		meta.then(this, function () {
			var m;
			try { m = meta.result || {}; }
			catch (e) { f.setException(e); return; }
			move(toFolder !== null && toFolder !== undefined ? toFolder : self._parentOf(m.path_lower || ""),
				(name !== null && name !== undefined) ? name : m.name);
		});
		return f;
	},

	// POST /files/delete_v2 { path }. Dropbox keeps deleted files and folders restorable
	// (Deleted files, per plan's history window); permanently_delete is the irreversible one.
	deleteItem: function (creds, item, cb) {
		var f = new Future();
		this._settle(f, this.rpc("/files/delete_v2", { path: item }, creds, cb),
			function () { return {}; });
		return f;
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
