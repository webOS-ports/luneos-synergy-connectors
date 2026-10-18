/*global IMPORTS, Config, OAuth2, HttpCurl, console */
/* adapter.js - STRATO HiDrive provider ADAPTER for _cloudcore. HiDrive is PATH-BASED: a node is
 * addressed by an absolute path under the account HOME ("/users/<user>/Folder/file.docx"), so a
 * locator handed to consumers IS a path; the ROOT_FOLDER sentinel "home" maps to the account home
 * discovered from /user/me. Every request sends "Authorization: Bearer <token>" with transparent
 * refresh-on-401 (HiDrive access tokens live 1h; the native-app refresh token renews them). All
 * HTTPS runs through the modern curl (device node is 0.9.8k).
 *
 * Exposes the uniform _cloudcore adapter interface (normalised shapes) plus the PHOTO.UPLOAD
 * helpers. getTemporaryLink hands back a "/file?path=..&access_token=.." URL for the Photos
 * aggregator's curl (see the note on that method).
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var Adapter = {
	_homeByToken: {},

	_enc: function (p) { return encodeURIComponent(p); },
	// HiDrive returns member name/path URL-ENCODED (spaces as %20 etc). Decode on the way in so
	// display names are clean and _enc re-encodes exactly once when the path is used as a locator.
	_dec: function (p) { try { return decodeURIComponent(String(p == null ? "" : p)); } catch (e) { return p; } },
	_leaf: function (p) {
		var s = String(p == null ? "" : p).replace(/\/+$/, "");
		var i = s.lastIndexOf("/"); return (i >= 0) ? s.substring(i + 1) : s;
	},
	_dirOf: function (p) {
		var s = String(p).replace(/\/+$/, ""); var i = s.lastIndexOf("/");
		return (i > 0) ? s.substring(0, i) : "/";
	},
	_mime: function (name, isFolder) {
		if (isFolder) { return "application/x-directory"; }
		var m = /\.([a-z0-9]+)$/i.exec(name || ""); var ext = m ? m[1].toLowerCase() : "";
		var map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
			bmp: "image/bmp", heic: "image/heic", webp: "image/webp", pdf: "application/pdf" };
		return map[ext] || null;
	},

	// Authenticated HttpCurl call with transparent refresh-on-401. opts: { method, url, headers,
	// outFile, dataFile }. Resolves to the raw HttpCurl result { status, responseText }.
	_authCall: function (creds, opts, onRenewed) {
		var self = this, f = new Future();
		function fire(c) {
			var o = { method: opts.method || "GET", url: opts.url,
				headers: { "Authorization": "Bearer " + c.accessToken } };
			if (opts.headers) { Object.keys(opts.headers).forEach(function (k) { o.headers[k] = opts.headers[k]; }); }
			if (opts.outFile) { o.outFile = opts.outFile; o.follow = true; }
			if (opts.dataFile) { o.dataFile = opts.dataFile; }
			return HttpCurl.request(o);
		}
		var call = fire(creds);
		f.now(this, function () { return call; });
		f.then(this, function () {
			var r = call.result;
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
			throw { returnValue: false, errorCode: "HIDRIVE_API_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		return r.responseText ? JSON.parse(r.responseText) : {};
	},

	// GET /user/me -> identity + home path (cached per token for path resolution).
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this._authCall(creds, { method: "GET", url: Config.API_BASE + Config.USER_INFO_PATH }, cb);
		call.then(this, function () {
			try {
				var u = self._parse(call.result) || {};
				if (u.home) { self._homeByToken[creds.accessToken] = u.home; }
				f.result = { user: {
					emailAddress: u.email || u.account,
					displayName:  u.alias || u.descr || u.email
				} };
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// Resolve the account home path (root sentinel target). Cached; else fetched via /user/me.
	_ensureHome: function (creds, cb) {
		var self = this, f = new Future();
		var cached = this._homeByToken[creds.accessToken];
		if (cached) { f.result = cached; return f; }
		var info = this.getAccountInfo(creds, cb);
		f.now(this, function () { return info; });
		f.then(this, function () {
			try { info.result; } catch (e) { f.setException(e); return; }
			f.result = self._homeByToken[creds.accessToken] || "/";
		});
		return f;
	},

	_resolve: function (creds, folderId, cb) {
		var self = this, f = new Future();
		if (folderId && folderId !== "home" && folderId !== Config.ROOT_FOLDER) { f.result = folderId; return f; }
		var h = this._ensureHome(creds, cb);
		f.now(this, function () { return h; });
		f.then(this, function () { try { f.result = h.result; } catch (e) { f.setException(e); } });
		return f;
	},

	// GET /dir?path=..&members=all&fields=.. -> normalised entries.
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var pf = this._resolve(creds, folderId, cb);
		f.now(this, function () { return pf; });
		f.then(this, function () {
			var pathVal;
			try { pathVal = pf.result; } catch (e0) { f.setException(e0); return; }
			// NB: HiDrive `fields` describes the DIRECTORY itself; child rows come from the
			// `members.<field>` namespace (a plain `fields=name,type,..` list returns only the
			// folder's own metadata with no members[] at all). Ask for members + their fields.
			var url = Config.API_BASE + "/dir?path=" + self._enc(pathVal) +
				"&members=all&fields=members.name,members.type,members.size,members.mtime,members.path,members.id" +
				"&limit=0," + (Config.LIST_LIMIT || 5000);
			var call = self._authCall(creds, { method: "GET", url: url }, cb);
			call.then(self, function () {
				try {
					var res = self._parse(call.result) || {};
					var members = res.members || [];
					f.result = { entries: members.map(function (m) {
						var isFolder = (m.type === "dir");
						var name = self._dec(m.name), path = self._dec(m.path);
						return { id: path, type: (isFolder ? "folder" : "file"),
							name: name, size: m.size || 0,
							modified: m.mtime ? (m.mtime * 1000) : 0, path: path,
							mimeType: self._mime(name, isFolder) };
					}) };
				} catch (e) { f.setException(e); }
			});
		});
		return f;
	},

	// GET /file?path=.. -> bytes to disk.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		var self = this, f = new Future();
		var url = Config.API_BASE + "/file?path=" + this._enc(fileId);
		var call = this._authCall(creds, { method: "GET", url: url, outFile: localDest }, cb);
		call.then(this, function () {
			try {
				var r = call.result;
				if (!r || r.status < 200 || r.status >= 300) {
					throw { returnValue: false, errorCode: "HIDRIVE_DOWNLOAD_FAILED", status: r && r.status };
				}
				f.result = { path: localDest };
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// PUT /file?dir=..&name=.. -> create-or-overwrite the file with the local bytes.
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var self = this, f = new Future();
		var pf = this._resolve(creds, folderId, cb);
		f.now(this, function () { return pf; });
		f.then(this, function () {
			var dir;
			try { dir = pf.result; } catch (e0) { f.setException(e0); return; }
			f.result = self._put(creds, dir, name, localPath, cb);
		});
		return f;
	},
	// Overwrite an existing file by path (QuickOffice save-back) - split into dir + name.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		return this._put(creds, this._dirOf(fileId), this._leaf(fileId), localPath, cb);
	},
	_put: function (creds, dir, name, localPath, cb) {
		var self = this, f = new Future();
		var url = Config.API_BASE + "/file?dir=" + this._enc(dir) + "&name=" + this._enc(name);
		var call = this._authCall(creds, { method: "PUT", url: url, dataFile: localPath,
			headers: { "Content-Type": "application/octet-stream" } }, cb);
		call.then(this, function () {
			try {
				var meta = self._parse(call.result) || {};
				f.result = { id: meta.path || (dir + "/" + name), path: meta.path || (dir + "/" + name),
					name: meta.name || name, size: meta.size };
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// --- PHOTO.UPLOAD helpers ------------------------------------------------------------
	// Enumerate BROWSABLE photo albums: the account HOME (its direct image children - people keep
	// photos at the top level, as this account does) plus every immediate sub-folder that holds at
	// least one image. aid = the absolute path (listPhotos lists it directly). This replaces the
	// old "only Camera Uploads" view so real photos actually show up in Photos & Videos.
	_isImg: function (e) {
		var m = this._mime(e && e.name, false);
		return e && e.type === "file" && m && m.indexOf("image/") === 0;
	},
	photoAlbums: function (creds, cb) {
		var self = this, f = new Future();
		var hf = this._ensureHome(creds, cb);
		f.now(this, function () { return hf; });
		f.then(this, function () {
			var home;
			try { home = hf.result; } catch (e) { f.setException(e); return; }
			var lf = self.listFolder(creds, home, cb);
			lf.then(self, function () {
				var entries;
				try { entries = (lf.result && lf.result.entries) || []; } catch (e2) { entries = []; }
				var albums = [], homeImgs = 0, folders = [];
				entries.forEach(function (e) {
					if (self._isImg(e)) { homeImgs++; }
					else if (e.type === "folder") { folders.push(e); }
				});
				if (homeImgs) { albums.push({ aid: home, name: "HiDrive", images: homeImgs }); }
				// Probe each immediate sub-folder for images (bounded to one level).
				var i = 0;
				function nextFolder() {
					if (i >= folders.length) { f.result = { albums: albums }; return; }
					var fld = folders[i++];
					var sf = self.listFolder(creds, fld.id, cb);
					sf.then(self, function () {
						var se;
						try { se = (sf.result && sf.result.entries) || []; } catch (e3) { se = []; }
						var c = 0;
						se.forEach(function (x) { if (self._isImg(x)) { c++; } });
						if (c) { albums.push({ aid: fld.id, name: fld.name, images: c }); }
						nextFolder();
					});
				}
				nextFolder();
			});
		});
		return f;
	},

	resolvePhotoAlbum: function (creds, cb) {
		var self = this, f = new Future();
		var name = Config.PHOTO_ALBUM_NAME || "Camera Uploads";
		var hf = this._ensureHome(creds, cb);
		f.now(this, function () { return hf; });
		f.then(this, function () {
			var home;
			try { home = hf.result; } catch (e) { f.result = { path: "", name: name, exists: false }; return; }
			var path = home + "/" + name;
			var probe = self._authCall(creds, { method: "GET",
				url: Config.API_BASE + "/dir?path=" + self._enc(path) + "&members=none" }, cb);
			probe.then(self, function () {
				var ok = false;
				try { var r = probe.result; ok = !!(r && r.status >= 200 && r.status < 300); } catch (e2) { ok = false; }
				f.result = { path: path, name: name, exists: ok };
			});
		});
		return f;
	},
	ensureAlbumFolder: function (creds, name, cb) {
		var self = this, f = new Future();
		var hf = this._ensureHome(creds, cb);
		f.now(this, function () { return hf; });
		f.then(this, function () {
			var home;
			try { home = hf.result; } catch (e) { f.setException(e); return; }
			var path = home + "/" + String(name).replace(/^\/+|\/+$/g, "");
			var call = self._authCall(creds, { method: "POST",
				url: Config.API_BASE + "/dir?path=" + self._enc(path) }, cb);
			call.then(self, function () {
				var r = call.result;
				// 201 Created or 409 (exists) are both success.
				if (r && (r.status === 409 || (r.status >= 200 && r.status < 300))) { f.result = path; }
				else { f.setException({ returnValue: false, errorCode: "HIDRIVE_MKDIR_FAILED", status: r && r.status }); }
			});
		});
		return f;
	},
	// A "/file?path=..&access_token=.." URL the Photos aggregator's curl can fetch header-less.
	// NOTE: relies on HiDrive accepting the token as a query param (common for Bearer APIs);
	// if a device test shows it does not, switch listPhotos to a download-to-temp file:// scheme
	// (as the Mega connector does). See ../README.md.
	getTemporaryLink: function (creds, fileId, cb) {
		var f = new Future();
		f.result = { link: Config.API_BASE + "/file?path=" + this._enc(fileId) +
			"&access_token=" + encodeURIComponent(creds.accessToken), method: "GET" };
		return f;
	},
	// DELETE /file?path=..
	deletePhoto: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var call = this._authCall(creds, { method: "DELETE",
			url: Config.API_BASE + "/file?path=" + this._enc(fileId) }, cb);
		call.then(this, function () {
			var r = call.result;
			if (r && (r.status === 204 || (r.status >= 200 && r.status < 300))) { f.result = { deleted: true }; }
			else { f.setException({ returnValue: false, errorCode: "HIDRIVE_DELETE_FAILED", status: r && r.status }); }
		});
		return f;
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
