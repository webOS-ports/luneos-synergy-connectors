/*global IMPORTS, Config, OAuth2, HttpCurl, console */
/* adapter.js - Yandex Disk provider ADAPTER for _cloudcore. Yandex Disk is PATH-based
 * (like Dropbox): a resource is addressed by "disk:/Folder/file.docx", so a locator handed
 * to consumers IS a real path. Every request sends "Authorization: OAuth <token>" (NOT the
 * Bearer scheme), passed via the headers map. download/upload are TWO-STEP: the API returns
 * a short-lived signed href fetched with a second, UNAUTHENTICATED curl. All HTTPS runs
 * through _cloudcore/httpcurl (device node is 0.9.8k).
 *
 * Exposes the uniform _cloudcore adapter interface (normalised shapes):
 *   listFolder(creds, folderId, cb) -> { entries:[{id,type,name,size,modified,path,mimeType}] }
 *   downloadFile(creds, fileId, localDest, exportMime, cb) -> { path }   (exportMime ignored)
 *   uploadFile(creds, folderId, localPath, name, mimeType, cb) -> { id, name, size }
 *   uploadReplace(creds, fileId, localPath, mimeType, cb)      -> { id, name, size }
 *   getAccountInfo(creds, cb) -> { user:{ displayName, emailAddress } }
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var Adapter = {
	_hdr: function (c) { return { "Authorization": "OAuth " + c.accessToken }; },

	// Normalise a locator to the Disk namespace. "", "/", "root", ROOT_FOLDER -> root; a bare
	// "/Foo/bar" -> "disk:/Foo/bar"; an already-qualified "disk:/..", "app:/..", "trash:/.." is
	// passed through unchanged (that is what listFolder hands back as each entry.path).
	_normPath: function (p) {
		var root = Config.ROOT_FOLDER || Config.ROOT_PATH || "disk:/";
		if (!p || p === "/" || p === "root" || p === root || p === Config.ROOT_PATH) { return root; }
		if (p.indexOf("disk:/") === 0 || p.indexOf("app:/") === 0 || p.indexOf("trash:/") === 0) {
			return p;
		}
		return "disk:/" + p.replace(/^\/+/, "");
	},

	_join: function (folder, name) {
		var base = this._normPath(folder);
		if (base.charAt(base.length - 1) !== "/") { base += "/"; }
		return base + name.replace(/^\/+/, "");
	},

	// Authenticated request with transparent refresh-on-401. Resolves to the raw HttpCurl
	// result { status, responseText }.
	_req: function (base, creds, onRenewed) {
		var self = this, f = new Future();
		function fire(c) {
			var o = { method: base.method || "GET", url: base.url, headers: self._hdr(c) };
			if (base.headers) {
				Object.keys(base.headers).forEach(function (k) { o.headers[k] = base.headers[k]; });
			}
			return HttpCurl.request(o);
		}
		f.now(this, function () { return fire(creds); });
		f.then(this, function () {
			var r = f.result;
			if (r && r.status === 401 && creds.refreshToken) {
				var rf = OAuth2.refresh(creds.refreshToken);
				rf.then(self, function () {
					var t = null, tErr = null;
						try { t = rf.result; } catch (e) { tErr = e; }
						if (tErr) { f.setException(tErr); return; }
					var nc = { accessToken: t.accessToken,
						refreshToken: t.refreshToken || creds.refreshToken,
						expiresAt: Date.now() + (t.expiresIn * 1000) };
					if (onRenewed) { onRenewed(nc); }
					var retry = fire(nc);
					retry.then(self, function () { f.result = retry.result; });
				});
				return;
			}
			f.result = r;
		});
		return f;
	},

	_parse: function (r) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "YANDEX_API_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		return r.responseText ? JSON.parse(r.responseText) : {};
	},

	// GET https://login.yandex.ru/info -> normalise to { user:{ displayName, emailAddress } }.
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this._req({ method: "GET", url: Config.LOGIN_INFO_URL }, creds, cb);
		call.then(this, function () {
			try {
				var u = self._parse(call.result) || {};
				f.result = { user: {
					emailAddress: u.default_email || u.login,
					displayName:  u.display_name || u.real_name
				} };
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// GET /resources?path=..&limit=.. -> normalised entries. Yandex items carry type
	// ("dir"|"file"), name, size, modified, path (the "disk:/.." locator), mime_type.
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var p = this._normPath(folderId);
		var url = Config.API_BASE + "/resources?path=" + encodeURIComponent(p) +
			"&limit=" + Config.LIST_LIMIT;
		var call = this._req({ method: "GET", url: url }, creds, cb);
		call.then(this, function () {
			try {
				var res = self._parse(call.result) || {};
				var items = (res._embedded && res._embedded.items) || [];
				f.result = { entries: items.map(function (e) {
					var isFolder = (e.type === "dir");
					return { id: e.path, type: (isFolder ? "folder" : "file"),
						name: e.name, size: e.size, modified: e.modified, path: e.path,
						mimeType: e.mime_type };
				}) };
			} catch (e) { f.setException(e); }   // reject, don't hang, on non-2xx / parse error
		});
		return f;
	},

	// Two-step download: GET /resources/download?path=.. -> { href, method }; then GET the
	// signed href to disk (no auth header - the href is self-authenticating). exportMime unused.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		var self = this, f = new Future();
		var p = this._normPath(fileId);
		var url = Config.API_BASE + "/resources/download?path=" + encodeURIComponent(p);
		var call = this._req({ method: "GET", url: url }, creds, cb);
		f.now(this, function () { return call; });
		f.then(this, function () {
			try {
				var link = self._parse(call.result);
				if (!link.href) {
					throw { returnValue: false, errorCode: "YANDEX_NO_DOWNLOAD_HREF",
						body: call.result && call.result.responseText };
				}
				var dl = HttpCurl.request({ method: link.method || "GET", url: link.href,
					follow: true, outFile: localDest });
				dl.then(self, function () {
					try {
						var r = dl.result;
						if (!r || r.status < 200 || r.status >= 300) {
							throw { returnValue: false, errorCode: "YANDEX_DOWNLOAD_FAILED",
								status: r && r.status, body: r && r.responseText };
						}
						f.result = { path: localDest };
					} catch (e2) { f.setException(e2); }
				});
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// Create a new file: two-step upload to folderId/name (overwrite=false).
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		return this._putUpload(creds, this._join(folderId, name), localPath, false, cb);
	},

	// Overwrite the file at fileId (QuickOffice save-back). Path-based => upload overwrite=true.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		return this._putUpload(creds, this._normPath(fileId), localPath, true, cb);
	},

	// Shared two-step PUT: GET /resources/upload?path=..&overwrite=.. -> { href, method:PUT };
	// then PUT the local bytes to the signed href (no auth header needed).
	_putUpload: function (creds, destPath, localPath, overwrite, cb) {
		var self = this, f = new Future();
		var ow = overwrite ? "true" : "false";
		var url = Config.API_BASE + "/resources/upload?path=" + encodeURIComponent(destPath) +
			"&overwrite=" + ow;
		var call = this._req({ method: "GET", url: url }, creds, cb);
		f.now(this, function () { return call; });
		f.then(this, function () {
			try {
				var link = self._parse(call.result);
				if (!link.href) {
					throw { returnValue: false, errorCode: "YANDEX_NO_UPLOAD_HREF",
						body: call.result && call.result.responseText };
				}
				var up = HttpCurl.request({ method: link.method || "PUT", url: link.href,
					follow: true, dataFile: localPath });
				up.then(self, function () {
					try {
						var r = up.result;
						if (!r || r.status < 200 || r.status >= 300) {
							throw { returnValue: false, errorCode: "YANDEX_UPLOAD_FAILED",
								status: r && r.status, body: r && r.responseText };
						}
						f.result = { id: destPath, path: destPath, name: destPath.split("/").pop() };
					} catch (e2) { f.setException(e2); }
				});
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// --- Photos-provider helpers (PHOTO.UPLOAD role) ------------------------------------
	// Yandex is the Dropbox-shaped photo case: no self-authenticating per-item URL (unlike
	// kDrive's ?access_token=), so listPhotos resolves a short-lived signed href PER photo
	// via getTemporaryLink - exactly Dropbox's get_temporary_link pattern.

	// Last path segment, URL-decoded, for a human album name ("disk:/Фотокамера/" -> "Фотокамера").
	_leaf: function (p) {
		var s = String(p).replace(/\/+$/, "");
		var i = s.lastIndexOf("/");
		var seg = (i >= 0) ? s.substring(i + 1) : s;
		try { return decodeURIComponent(seg); } catch (e) { return seg; }
	},

	// GET /resources/download?path=.. -> { href } - the same self-authenticating signed link
	// downloadFile uses, surfaced for listPhotos as src_big/src_small (fetched header-less by
	// the Photos aggregator's curl). Resolves to { link, method }.
	getTemporaryLink: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var url = Config.API_BASE + "/resources/download?path=" +
			encodeURIComponent(this._normPath(fileId));
		var call = this._req({ method: "GET", url: url }, creds, cb);
		call.then(this, function () {
			try {
				var link = self._parse(call.result) || {};
				f.result = { link: link.href, method: link.method || "GET" };
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// GET /v1/disk?fields=system_folders -> the server-localized system-folder map
	// (photostream = camera-uploads, downloads, screenshots, ...). Resolves to that object.
	getSystemFolders: function (creds, cb) {
		var self = this, f = new Future();
		var url = Config.API_BASE + "?fields=" + encodeURIComponent("system_folders");
		var call = this._req({ method: "GET", url: url }, creds, cb);
		call.then(this, function () {
			// A non-2xx here (e.g. disk.info scope not granted) must NOT hang photo listing -
			// resolve to an empty map so resolvePhotoAlbum cleanly falls back to Pictures.
			var d;
			try { d = self._parse(call.result) || {}; } catch (e) { d = {}; }
			f.result = d.system_folders || {};
		});
		return f;
	},

	// Pick the photo album: prefer Yandex's own camera-uploads folder (system_folders.photostream,
	// e.g. "disk:/Фотокамера/", localized by the server), but only if it actually exists; else
	// fall back to Config.PHOTO_ALBUM_NAME ("Pictures"). Resolves to { path, name, exists }.
	resolvePhotoAlbum: function (creds, cb) {
		var self = this, f = new Future();
		var fbName = Config.PHOTO_ALBUM_NAME || "Pictures";
		var fallback = { path: "disk:/" + fbName, name: fbName, exists: false };
		var sf = this.getSystemFolders(creds, cb);
		f.now(this, function () { return sf; });
		f.then(this, function () {
			var folders;
			try { folders = sf.result || {}; } catch (e) { folders = {}; }
			var ps = folders.photostream;
			if (!ps) { f.result = fallback; return; }
			var ppath = String(ps).replace(/\/+$/, "");
			// photostream is listed even before first camera upload; probe with a RAW request
			// (limit=0) and check the HTTP status directly. A 404 is EXPECTED (folder absent) -
			// use a raw _req (which always resolves to {status,...}) rather than listFolder, so a
			// missing folder never throws/hangs; on non-2xx we fall back to Pictures.
			var purl = Config.API_BASE + "/resources?path=" + encodeURIComponent(ppath) + "&limit=0";
			var probe = self._req({ method: "GET", url: purl }, creds, cb);
			probe.then(self, function () {
				var ok = false;
				try { var r = probe.result; ok = !!(r && r.status >= 200 && r.status < 300); }
				catch (e2) { ok = false; }
				f.result = ok ? { path: ppath, name: self._leaf(ppath), exists: true } : fallback;
			});
		});
		return f;
	},

	// PUT /resources?path=disk:/NAME -> create the album folder (device->cloud photo upload
	// target when the aggregator supplies no albumId). 201 Created and 409 (already exists) are
	// both success. Resolves to the folder path.
	ensureAlbumFolder: function (creds, name, cb) {
		var self = this, f = new Future();
		var path = this._normPath(name);
		var url = Config.API_BASE + "/resources?path=" + encodeURIComponent(path);
		var call = this._req({ method: "PUT", url: url }, creds, cb);
		call.then(this, function () {
			try {
				var r = call.result;
				if (r && (r.status === 409 || (r.status >= 200 && r.status < 300))) {
					f.result = path;
				} else {
					throw { returnValue: false, errorCode: "YANDEX_MKDIR_FAILED",
						status: r && r.status, body: r && r.responseText };
				}
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// DELETE /resources?path=..&permanently=true -> remove a photo (Photos delete button).
	// pid is the "disk:/.." locator listPhotos handed back. 204 (deleted) / 202 (async delete
	// scheduled) / any 2xx = success; reject otherwise so the aggregator keeps the local copy.
	deletePhoto: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var url = Config.API_BASE + "/resources?path=" +
			encodeURIComponent(this._normPath(fileId)) + "&permanently=true";
		var call = this._req({ method: "DELETE", url: url }, creds, cb);
		call.then(this, function () {
			try {
				var r = call.result;
				if (r && (r.status === 204 || r.status === 202 ||
					(r.status >= 200 && r.status < 300))) {
					f.result = { deleted: true };
				} else {
					throw { returnValue: false, errorCode: "YANDEX_DELETE_FAILED",
						status: r && r.status, body: r && r.responseText };
				}
			} catch (e) { f.setException(e); }
		});
		return f;
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
