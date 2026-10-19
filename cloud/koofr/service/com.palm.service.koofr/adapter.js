/*global IMPORTS, Config, OAuth2, HttpCurl, console */
/* adapter.js - Koofr provider ADAPTER for _cloudcore. Koofr is MOUNT + PATH based: files live
 * under a mount (the user's primary personal storage), addressed by (mountId, absolute path). The
 * primary mount id is resolved lazily (GET /mounts) and cached in the credentials; a locator is
 * the absolute path within that mount (the ROOT_FOLDER sentinel "/" is the mount root). Auth is
 * OAuth2 Bearer with transparent refresh-on-401 (access tokens expire; the refresh token renews
 * them). All HTTPS runs through the modern curl. The content host is the same host with a
 * "/content/api/v2" path prefix.
 *
 * Credentials (creds): { accessToken, refreshToken, expiresAt, mountId? }.
 *
 * Exposes the uniform _cloudcore adapter interface (normalised shapes) plus the PHOTO.UPLOAD
 * helpers. getTemporaryLink hands back Koofr's files/download URL for the Photos aggregator.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var Adapter = {
	_hdr: function (c) {
		return { "Authorization": "Bearer " + c.accessToken,
			"X-Koofr-Version": Config.KOOFR_VERSION || "2.1" };
	},
	_enc: function (p) { return encodeURIComponent(p); },
	_norm: function (p) {
		if (!p || p === "root" || p === "" || p === Config.ROOT_FOLDER) { return "/"; }
		return (p.charAt(0) === "/") ? p : ("/" + p);
	},
	_join: function (folder, name) {
		var base = (folder === "/") ? "" : String(folder).replace(/\/+$/, "");
		return base + "/" + name;
	},
	_leaf: function (p) { var s = String(p).replace(/\/+$/, ""); var i = s.lastIndexOf("/"); return i >= 0 ? s.substring(i + 1) : s; },
	_dirOf: function (p) { var s = String(p).replace(/\/+$/, ""); var i = s.lastIndexOf("/"); return i > 0 ? s.substring(0, i) : "/"; },
	_mime: function (name, isFolder, contentType) {
		if (contentType) { return contentType; }
		if (isFolder) { return "application/x-directory"; }
		var m = /\.([a-z0-9]+)$/i.exec(name || ""); var ext = m ? m[1].toLowerCase() : "";
		var map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
			bmp: "image/bmp", heic: "image/heic", webp: "image/webp", pdf: "application/pdf" };
		return map[ext] || null;
	},

	// Bearer HttpCurl call with transparent refresh-on-401. opts: { method, url, headers, outFile,
	// dataFile, multipart, body }. Resolves to { status, responseText }.
	_req: function (creds, opts, onRenewed) {
		var self = this, f = new Future();
		function fire(c) {
			var o = { method: opts.method || "GET", url: opts.url, headers: self._hdr(c) };
			if (opts.headers) { Object.keys(opts.headers).forEach(function (k) { o.headers[k] = opts.headers[k]; }); }
			if (opts.outFile) { o.outFile = opts.outFile; o.follow = true; }
			if (opts.dataFile) { o.dataFile = opts.dataFile; }
			if (opts.multipart) { o.multipart = opts.multipart; }
			if (opts.body != null) { o.body = opts.body; }
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
						expiresAt: Date.now() + (t.expiresIn * 1000),
						mountId: creds.mountId };
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
		this._ok(r);
		return r.responseText ? JSON.parse(r.responseText) : {};
	},
	// Throw unless the reply is a 2xx; for calls whose body is not needed.
	_ok: function (r) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "KOOFR_API_ERROR", status: r && r.status, body: r && r.responseText };
		}
	},

	// GET /mounts -> the primary personal mount id (isPrimary==true), else the first mount.
	resolveMount: function (creds, cb) {
		var self = this, f = new Future();
		var call = this._req(creds, { method: "GET", url: Config.API_BASE + "/mounts" }, cb);
		call.then(this, function () {
			try {
				var d = self._parse(call.result) || {}; var mounts = d.mounts || [];
				var primary = null;
				for (var i = 0; i < mounts.length; i++) { if (mounts[i].isPrimary) { primary = mounts[i]; break; } }
				if (!primary && mounts.length) { primary = mounts[0]; }
				if (!primary) { throw { returnValue: false, errorCode: "KOOFR_NO_MOUNT" }; }
				f.result = primary.id;
			} catch (e) { f.setException(e); }
		});
		return f;
	},
	// mountId from creds, or resolve it (and remember on creds for the rest of this call chain).
	_mount: function (creds, cb) {
		var self = this, f = new Future();
		if (creds.mountId) { f.result = creds.mountId; return f; }
		var rm = this.resolveMount(creds, cb);
		f.now(this, function () { return rm; });
		f.then(this, function () { try { creds.mountId = rm.result; f.result = creds.mountId; } catch (e) { f.setException(e); } });
		return f;
	},

	// GET /user -> identity (validates the token).
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this._req(creds, { method: "GET", url: Config.API_BASE + "/user" }, cb);
		call.then(this, function () {
			try {
				var u = self._parse(call.result) || {};
				var name = ((u.firstName || "") + " " + (u.lastName || "")).replace(/^\s+|\s+$/g, "");
				f.result = { user: { emailAddress: u.email, displayName: name || u.email } };
			} catch (e) { f.setException(e); }
		});
		return f;
	},

	// GET /mounts/{mid}/files/list?path=.. -> normalised entries (Koofr returns basenames, so the
	// full path is composed from the folder path + name).
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var folderPath = this._norm(folderId);
		var mf = this._mount(creds, cb);
		f.now(this, function () { return mf; });
		f.then(this, function () {
			var mid;
			try { mid = mf.result; } catch (e0) { f.setException(e0); return; }
			var url = Config.API_BASE + "/mounts/" + mid + "/files/list?path=" + self._enc(folderPath);
			var call = self._req(creds, { method: "GET", url: url }, cb);
			call.then(self, function () {
				try {
					var d = self._parse(call.result) || {}; var files = d.files || [];
					f.result = { entries: files.map(function (o) { return self._entry(folderPath, o); }) };
				} catch (e) { f.setException(e); }
			});
		});
		return f;
	},

	// One listFolder entry from a Koofr file object (files/list item or files/info reply) that
	// lives in folderPath.
	_entry: function (folderPath, o) {
		var isFolder = (o.type === "dir");
		var full = this._join(folderPath, o.name);
		return { id: full, type: (isFolder ? "folder" : "file"), name: o.name,
			size: o.size || 0, modified: o.modified || 0, path: full,
			mimeType: this._mime(o.name, isFolder, o.contentType) };
	},

	// GET content/mounts/{mid}/files/get?path=.. -> bytes to disk.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		var self = this, f = new Future();
		var mf = this._mount(creds, cb);
		f.now(this, function () { return mf; });
		f.then(this, function () {
			var mid;
			try { mid = mf.result; } catch (e0) { f.setException(e0); return; }
			var url = Config.CONTENT_BASE + "/mounts/" + mid + "/files/get?path=" + self._enc(self._norm(fileId));
			var call = self._req(creds, { method: "GET", url: url, outFile: localDest }, cb);
			call.then(self, function () {
				try {
					var r = call.result;
					if (!r || r.status < 200 || r.status >= 300) {
						throw { returnValue: false, errorCode: "KOOFR_DOWNLOAD_FAILED", status: r && r.status };
					}
					f.result = { path: localDest };
				} catch (e) { f.setException(e); }
			});
		});
		return f;
	},

	// POST content/mounts/{mid}/files/put?path=<folder>&filename=<name> (multipart "file").
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		return this._put(creds, this._norm(folderId), name, localPath, cb);
	},
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		return this._put(creds, this._dirOf(this._norm(fileId)), this._leaf(fileId), localPath, cb);
	},
	_put: function (creds, folderPath, name, localPath, cb) {
		var self = this, f = new Future();
		var mf = this._mount(creds, cb);
		f.now(this, function () { return mf; });
		f.then(this, function () {
			var mid;
			try { mid = mf.result; } catch (e0) { f.setException(e0); return; }
			var url = Config.CONTENT_BASE + "/mounts/" + mid + "/files/put?path=" + self._enc(folderPath) +
				"&filename=" + self._enc(name) + "&info=true&overwrite=true";
			var call = self._req(creds, { method: "POST", url: url,
				multipart: [{ name: "file", file: localPath, filename: name }] }, cb);
			call.then(self, function () {
				try {
					var meta = self._parse(call.result) || {};
					var full = self._join(folderPath, meta.name || name);
					f.result = { id: full, path: full, name: meta.name || name, size: meta.size };
				} catch (e) { f.setException(e); }
			});
		});
		return f;
	},

	// --- PHOTO.UPLOAD helpers ------------------------------------------------------------
	// Is a listFolder entry an image file? (entries carry a computed mimeType.)
	_isImg: function (e) {
		if (!e || e.type !== "file") { return false; }
		var m = e.mimeType || this._mime(e.name, false, null);
		return !!(m && m.indexOf("image/") === 0);
	},
	// Enumerate BROWSABLE photo albums: the mount root's direct images plus every immediate
	// sub-folder that holds at least one image (one level deep). aid = the absolute path.
	// This replaces the old "only Camera Uploads" view (which 404'd when that folder didn't
	// exist and broke the whole account sync) so the user's real folders - e.g. Koofr's default
	// "My pictures" - actually show up in Photos & Videos.
	photoAlbums: function (creds, cb) {
		var self = this, f = new Future();
		var lf = self.listFolder(creds, Config.ROOT_FOLDER, cb);
		f.now(this, function () { return lf; });
		f.then(this, function () {
			var entries;
			try { entries = (lf.result && lf.result.entries) || []; } catch (e) { entries = []; }
			var albums = [], rootImgs = 0, folders = [];
			entries.forEach(function (e) {
				if (self._isImg(e)) { rootImgs++; }
				else if (e.type === "folder") { folders.push(e); }
			});
			if (rootImgs) { albums.push({ aid: "/", name: "Koofr", images: rootImgs }); }
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
		return f;
	},

	resolvePhotoAlbum: function (creds, cb) {
		var self = this, f = new Future();
		var name = Config.PHOTO_ALBUM_NAME || "Camera Uploads";
		var path = "/" + name;
		var mf = this._mount(creds, cb);
		f.now(this, function () { return mf; });
		f.then(this, function () {
			var mid;
			try { mid = mf.result; } catch (e) { f.result = { path: path, name: name, exists: false }; return; }
			var url = Config.API_BASE + "/mounts/" + mid + "/files/info?path=" + self._enc(path);
			var probe = self._req(creds, { method: "GET", url: url }, cb);
			probe.then(self, function () {
				var ok = false;
				try { var r = probe.result; ok = !!(r && r.status >= 200 && r.status < 300); } catch (e2) { ok = false; }
				f.result = { path: path, name: name, exists: ok };
			});
		});
		return f;
	},
	// POST /mounts/{mid}/files/folder?path=<parent> body {"name":..}.
	ensureAlbumFolder: function (creds, name, cb) {
		var self = this, f = new Future();
		var leaf = String(name).replace(/^\/+|\/+$/g, "");
		var mf = this._mount(creds, cb);
		f.now(this, function () { return mf; });
		f.then(this, function () {
			var mid;
			try { mid = mf.result; } catch (e0) { f.setException(e0); return; }
			var url = Config.API_BASE + "/mounts/" + mid + "/files/folder?path=" + self._enc("/");
			var call = self._req(creds, { method: "POST", url: url,
				headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: leaf }) }, cb);
			call.then(self, function () {
				var r = call.result;
				if (r && (r.status === 409 || (r.status >= 200 && r.status < 300))) { f.result = "/" + leaf; }
				else { f.setException({ returnValue: false, errorCode: "KOOFR_MKDIR_FAILED", status: r && r.status }); }
			});
		});
		return f;
	},
	// GET /mounts/{mid}/files/download?path=.. -> { link } (a ready-to-GET URL for the aggregator).
	getTemporaryLink: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var mf = this._mount(creds, cb);
		f.now(this, function () { return mf; });
		f.then(this, function () {
			var mid;
			try { mid = mf.result; } catch (e0) { f.setException(e0); return; }
			var url = Config.API_BASE + "/mounts/" + mid + "/files/download?path=" + self._enc(self._norm(fileId));
			var call = self._req(creds, { method: "GET", url: url }, cb);
			call.then(self, function () {
				try { var d = self._parse(call.result) || {}; f.result = { link: d.link, method: "GET" }; }
				catch (e) { f.setException(e); }
			});
		});
		return f;
	},
	// DELETE /mounts/{mid}/files/remove?path=..
	deletePhoto: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var mf = this._mount(creds, cb);
		f.now(this, function () { return mf; });
		f.then(this, function () {
			var mid;
			try { mid = mf.result; } catch (e0) { f.setException(e0); return; }
			var url = Config.API_BASE + "/mounts/" + mid + "/files/remove?path=" + self._enc(self._norm(fileId));
			var call = self._req(creds, { method: "DELETE", url: url }, cb);
			call.then(self, function () {
				var r = call.result;
				if (r && (r.status === 200 || r.status === 204 || (r.status >= 200 && r.status < 300))) { f.result = { deleted: true }; }
				else { f.setException({ returnValue: false, errorCode: "KOOFR_DELETE_FAILED", status: r && r.status }); }
			});
		});
		return f;
	},

	// --- File manager: createFolder / moveItem / deleteItem (commands/fileOps_commands.js) ----
	// Locators are listFolder's: absolute paths within the primary mount. Every step of a chain
	// reuses renewed credentials, so a refresh in one step is not repeated (with a refresh token
	// that has already been used) by the next.
	_session: function (creds, cb) {
		var s = { creds: creds };
		s.cb = function (nc) { s.creds = nc; if (cb) { cb(nc); } };
		return s;
	},
	// The mount id, kept on the session's current credentials (a refresh while the mount was
	// being resolved would otherwise leave the renewed ones without it).
	_sessionMount: function (s) {
		return this._after(this._mount(s.creds, s.cb), function (mid) { s.creds.mountId = mid; return mid; });
	},
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
	_fail: function (code, text) {
		var f = new Future();
		f.setException({ returnValue: false, errorCode: code, errorText: text });
		return f;
	},
	// A locator as an absolute path without a trailing slash ("/" for the mount root).
	_bare: function (p) { return this._norm(String(p == null ? "" : p).replace(/\/+$/, "")); },
	// {API_BASE}/mounts/{mid}/files/{op}?path=<p>
	_filesUrl: function (mid, op, p) {
		return Config.API_BASE + "/mounts/" + mid + "/files/" + op + "?path=" + this._enc(p);
	},
	_json: function (s, method, url, obj) {
		return this._req(s.creds, { method: method, url: url,
			headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }, s.cb);
	},
	// GET files/info?path=p -> { entry } in listFolder's shape.
	_infoEntry: function (s, mid, p) {
		return this._after(this._req(s.creds, { method: "GET", url: this._filesUrl(mid, "info", p) }, s.cb),
			function (r) {
				var o = this._parse(r) || {};
				if (!o.name) { o.name = this._leaf(p); }
				return { entry: this._entry(this._dirOf(p), o) };
			});
	},

	// POST files/folder?path=<parent> {"name"} (an existing name fails, 409), then files/info.
	createFolder: function (creds, parent, name, cb) {
		var s = this._session(creds, cb), parentPath = this._norm(parent);
		return this._after(this._sessionMount(s), function (mid) {
			return this._after(this._json(s, "POST", this._filesUrl(mid, "folder", parentPath), { name: name }),
				function (r) {
					this._ok(r);
					return this._infoEntry(s, mid, this._join(parentPath, name));
				});
		});
	},

	// Rename in place: PUT files/rename?path=<item> {"name"}. Anything else: PUT files/move?path=
	// <item> {"toMountId", "toPath"} with toPath the item's full new path, which moves and
	// renames in one call. Koofr does not document what a move onto an existing name does, so
	// an existing destination is refused here first (KOOFR_EXISTS) rather than overwritten or
	// auto-renamed; a change of case only is let through when the probe finds the item itself.
	moveItem: function (creds, item, toFolder, name, cb) {
		var s = this._session(creds, cb), src = this._bare(item);
		if (src === "/") { return this._fail("BAD_ARGS", "the root folder cannot be moved"); }
		var destDir = (toFolder == null) ? this._dirOf(src) : this._bare(toFolder);
		var dest = this._join(destDir, (name == null) ? this._leaf(src) : name);
		if (destDir === src || destDir.indexOf(src + "/") === 0) {
			return this._fail("BAD_ARGS", "a folder cannot be moved into itself");
		}
		return this._after(this._sessionMount(s), function (mid) {
			if (dest === src) { return this._infoEntry(s, mid, src); }
			var probe = this._req(s.creds, { method: "GET", url: this._filesUrl(mid, "info", dest) }, s.cb);
			return this._after(probe, function (pr) {
				if (!pr || pr.status !== 404) {
					var there = this._parse(pr) || {};
					// A change of case only: the probe may have found the item itself.
					if (dest.toLowerCase() !== src.toLowerCase() || there.name === this._leaf(dest)) {
						throw { returnValue: false, errorCode: "KOOFR_EXISTS", status: 409,
							errorText: "an item with that name already exists there" };
					}
				}
				var call = (destDir === this._dirOf(src)) ?
					this._json(s, "PUT", this._filesUrl(mid, "rename", src), { name: this._leaf(dest) }) :
					this._json(s, "PUT", this._filesUrl(mid, "move", src), { toMountId: mid, toPath: dest });
				return this._after(call, function (r) {
					this._ok(r);
					return this._infoEntry(s, mid, dest);
				});
			});
		});
	},

	// DELETE files/remove?path=<item> (a folder goes with its contents).
	deleteItem: function (creds, item, cb) {
		var s = this._session(creds, cb), src = this._bare(item);
		if (src === "/") { return this._fail("BAD_ARGS", "the root folder cannot be deleted"); }
		return this._after(this._sessionMount(s), function (mid) {
			return this._after(this._req(s.creds, { method: "DELETE", url: this._filesUrl(mid, "remove", src) }, s.cb),
				function (r) { this._ok(r); return {}; });
		});
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
