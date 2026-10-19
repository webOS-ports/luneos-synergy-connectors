/*global IMPORTS, Config, OAuth2, HttpCurl, console */
/* adapter.js - Google Drive (Drive API v3) provider ADAPTER for _cloudcore.
 *
 * This is the ONLY provider-specific service file besides config.js. It exposes the uniform
 * adapter interface the shared _cloudcore commands call - each returning a NORMALISED shape:
 *   listFolder(creds, folderId, cb)                 -> { entries:[{id,type,name,size,modified,path,mimeType,googleDoc}] }
 *   downloadFile(creds, fileId, localDest, exportMime, cb) -> { path }
 *   uploadFile(creds, folderId, localPath, name, mimeType, cb) -> { id, name, size }
 *   uploadReplace(creds, fileId, localPath, mimeType, cb)      -> { id, name, size }
 *   getAccountInfo(creds, cb)                        -> { user:{ displayName, emailAddress } }
 *   createFolder(creds, parent, name, cb)            -> { entry }   (listFolder-shaped)
 *   moveItem(creds, item, toFolder|null, name|null, cb) -> { entry }
 *   deleteItem(creds, item, cb)                      -> {}          (to the Drive trash)
 *
 * Drive quirks other providers don't have:
 *   - children are found by QUERY (files?q='{parentId}' in parents), not a path walk; a folder
 *     is mimeType application/vnd.google-apps.folder; the root alias id is "root".
 *   - Google-native docs (mimeType application/vnd.google-apps.*) aren't downloadable as bytes;
 *     they must be EXPORTED (GET /files/{id}/export?mimeType=...). Plain files use ?alt=media.
 *   - simple media upload can't set name+parent in one shot, so uploadFile is two steps.
 * Transparent refresh-on-401. All HTTPS runs through _cloudcore/httpcurl (device node is 0.9.8k).
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var Adapter = {
	get: function (path, creds, onRenewed) {
		return this._req({ method: "GET", url: Config.API_BASE + path }, creds, onRenewed, false);
	},

	// Core request with refresh-on-401. `toFile` opts (follow/outFile) stream to disk.
	_req: function (base, creds, onRenewed, toFile) {
		var self = this, f = new Future();
		function fire(c) {
			var o = { method: base.method, url: base.url, bearer: c.accessToken };
			if (base.headers)  { o.headers = base.headers; }
			if (base.dataFile) { o.dataFile = base.dataFile; }
			if (base.body)     { o.body = base.body; }
			if (toFile)        { o.follow = true; o.outFile = base.outFile; }
			return HttpCurl.request(o);
		}
		f.now(this, function () { return fire(creds); });
		f.then(this, function () {
			var r = f.result;
			if (r && r.status === 401 && creds.refreshToken) {
				var rf = OAuth2.refresh(creds.refreshToken);
				rf.then(self, function () {
					// A refresh that failed, or anything thrown here, fails f: thrown inside rf's or retry's
					// callback it would stay on that Future, and the request would never answer.
					try {
						var t = rf.result;
						var nc = { accessToken: t.accessToken,
							refreshToken: t.refreshToken || creds.refreshToken,  // Google keeps the old one
							expiresAt: Date.now() + (t.expiresIn * 1000) };
						if (onRenewed) { onRenewed(nc); }
						var retry = fire(nc);
						retry.then(self, function () {
							try { f.result = self._parse(retry.result, toFile, base); }
							catch (e2) { f.setException(e2); }
						});
					} catch (e) { f.setException(e); }
				});
				return;
			}
			f.result = self._parse(r, toFile, base);
		});
		return f;
	},

	_parse: function (r, toFile, base) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "GDRIVE_API_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		if (toFile) { return { path: base.outFile }; }
		return r.responseText ? JSON.parse(r.responseText) : {};
	},

	// -> { user:{ displayName, emailAddress } }  (already the normalised identity shape)
	getAccountInfo: function (creds, cb) {
		return this.get("/about?fields=user", creds, cb);
	},

	// The metadata every entry needs; listFolder asks for files(FIELDS), the file ops for FIELDS.
	FIELDS: "id,name,mimeType,size,modifiedTime",
	FOLDER_MIME: "application/vnd.google-apps.folder",

	// One Drive file resource -> the NORMALISED entry listFolder hands out.
	_entry: function (e) {
		var isFolder = (e.mimeType === "application/vnd.google-apps.folder");
		var isGoogleDoc = (!isFolder && e.mimeType &&
			e.mimeType.indexOf("application/vnd.google-apps.") === 0);
		return { id: e.id, type: (isFolder ? "folder" : "file"),
			name: e.name, size: e.size, modified: e.modifiedTime, path: e.id,
			mimeType: e.mimeType, googleDoc: isGoogleDoc };
	},

	// List a folder's children by query, returning NORMALISED entries.
	// NOTE: capped at pageSize 1000; folders with more are truncated (no pagination loop).
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var id = folderId || Config.ROOT_FOLDER;
		var q = "'" + id + "' in parents and trashed = false";
		var url = "/files?q=" + encodeURIComponent(q) +
			"&fields=" + encodeURIComponent("files(" + this.FIELDS + "),nextPageToken") +
			"&pageSize=1000&orderBy=folder,name";
		var call = this.get(url, creds, cb);
		f.now(this, function () { return call; });
		f.then(this, function () {
			var data = f.result || {};
			f.result = { entries: (data.files || []).map(function (e) { return self._entry(e); }) };
		});
		return f;
	},

	// Download a file to disk. exportMime set -> export a Google-native doc; else raw bytes.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		var url = exportMime
			? Config.API_BASE + "/files/" + encodeURIComponent(fileId) +
				"/export?mimeType=" + encodeURIComponent(exportMime)
			: Config.API_BASE + "/files/" + encodeURIComponent(fileId) + "?alt=media";
		return this._req({ method: "GET", url: url, outFile: localDest }, creds, cb, true);
	},

	// Two-step upload: (1) POST the bytes (creates an "Untitled" file in My Drive), then
	// (2) PATCH the name and move it into the target folder. Returns the final metadata.
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var self = this, f = new Future();
		var renewed = null;
		function onR(nc) { renewed = nc; if (cb) { cb(nc); } }

		var step1 = self._req({ method: "POST",
			url: Config.UPLOAD_BASE + "/files?uploadType=media&fields=id",
			headers: { "Content-Type": mimeType || "application/octet-stream" },
			dataFile: localPath }, creds, onR, false);

		f.now(this, function () { return step1; });
		f.then(this, function () {
			var created;
			try { created = step1.result; }
			catch (e) { f.setException(e); return; }
			var curCreds = renewed || creds;
			var parentId = folderId || Config.ROOT_FOLDER;
			var url = Config.API_BASE + "/files/" + encodeURIComponent(created.id) + "?fields=id,name,size";
			if (parentId !== Config.ROOT_FOLDER) {
				url += "&addParents=" + encodeURIComponent(parentId) + "&removeParents=root";
			}
			var step2 = self._req({ method: "PATCH", url: url,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name }) }, curCreds, onR, false);
			step2.then(self, function () {
				try { f.result = step2.result; }
				catch (e2) { f.setException(e2); }
			});
		});
		return f;
	},

	// Update an existing file's CONTENT in place (overwrite by id) - QuickOffice save-back.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		return this._req({ method: "PATCH",
			url: Config.UPLOAD_BASE + "/files/" + encodeURIComponent(fileId) +
				"?uploadType=media&fields=id,name,size",
			headers: { "Content-Type": mimeType || "application/octet-stream" },
			dataFile: localPath }, creds, cb, false);
	},

	// A Future that settles with fn(call's result), or with call's exception.
	_map: function (call, fn) {
		var self = this, f = new Future();
		call.then(this, function () {
			try { f.result = fn.call(self, call.result); }
			catch (e) { f.setException(e); }
		});
		return f;
	},

	// A JSON metadata request against API_BASE (path starts with "/files").
	_json: function (method, path, body, creds, onRenewed) {
		return this._req({ method: method, url: Config.API_BASE + path,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body) }, creds, onRenewed, false);
	},

	// files.create with the folder mimeType. parent is a listFolder locator (an id or "root").
	// -> { entry }
	createFolder: function (creds, parent, name, cb) {
		var call = this._json("POST", "/files?fields=" + encodeURIComponent(this.FIELDS),
			{ name: name, mimeType: this.FOLDER_MIME, parents: [parent || Config.ROOT_FOLDER] },
			creds, cb);
		return this._map(call, function (r) { return { entry: this._entry(r) }; });
	},

	// Rename and/or move: files.update. A move needs the current parents (removeParents) and,
	// for the "root" alias, the root's real id, since files.get reports parents by real id and
	// adding and removing the same folder must not happen. -> { entry }
	moveItem: function (creds, item, toFolder, name, cb) {
		var self = this, f = new Future();
		var renewed = null;
		function onR(nc) { renewed = nc; if (cb) { cb(nc); } }
		function cur() { return renewed || creds; }
		var fileUrl = "/files/" + encodeURIComponent(item);
		var body = (name === null || name === undefined) ? {} : { name: name };

		function patch(query) {
			var p = self._map(self._json("PATCH", fileUrl + "?" + query + "fields=" +
				encodeURIComponent(self.FIELDS), body, cur(), onR),
				function (r) { return { entry: this._entry(r) }; });
			p.then(self, function () {
				try { f.result = p.result; }
				catch (e) { f.setException(e); }
			});
		}

		if (!toFolder) { patch(""); return f; }

		var parentsF = self.get(fileUrl + "?fields=parents", creds, onR);
		parentsF.then(self, function () {
			var parents;
			try { parents = parentsF.result.parents || []; }
			catch (e) { f.setException(e); return; }
			function withTarget(targetId) {
				var stays = parents.indexOf(targetId) >= 0;
				var others = parents.filter(function (p) { return p !== targetId; });
				var q = "";
				if (!stays) { q += "addParents=" + encodeURIComponent(targetId) + "&"; }
				if (others.length) { q += "removeParents=" + encodeURIComponent(others.join(",")) + "&"; }
				patch(q);
			}
			// withTarget in the try as well: a throw in parentsF's or rootF's callback would stay
			// there and the move would never answer.
			if (toFolder !== Config.ROOT_FOLDER) {
				try { withTarget(toFolder); } catch (e1) { f.setException(e1); }
				return;
			}
			var rootF = self.get("/files/" + encodeURIComponent(Config.ROOT_FOLDER) + "?fields=id",
				cur(), onR);
			rootF.then(self, function () {
				try { withTarget(rootF.result.id); }
				catch (e2) { f.setException(e2); }
			});
		});
		return f;
	},

	// To the Drive trash (files.update trashed:true), not files.delete, so it can be restored.
	// Only the owner can trash a file; anyone else gets 403 insufficientFilePermissions. -> {}
	deleteItem: function (creds, item, cb) {
		var call = this._json("PATCH", "/files/" + encodeURIComponent(item) + "?fields=id",
			{ trashed: true }, creds, cb);
		return this._map(call, function () { return {}; });
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
