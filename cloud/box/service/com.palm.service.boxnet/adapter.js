/*global IMPORTS, Config, OAuth2, HttpCurl, console */
/* adapter.js - Box API v2 provider ADAPTER for _cloudcore. Box is RESTful and ID-addressed:
 * GET /folders/{id}/items, GET /files/{id}/content, root folder id "0". Box ROTATES the
 * refresh token on every use, so the refreshed token is persisted. All HTTPS runs through
 * _cloudcore/httpcurl (device node is 0.9.8k).
 *
 * Uniform _cloudcore adapter interface (normalised shapes):
 *   listFolder(creds, folderId, cb) -> { entries:[{id,type,name,size,modified,path}] }
 *   downloadFile(creds, fileId, localDest, exportMime, cb) -> { path }   (exportMime ignored)
 *   uploadFile(creds, folderId, localPath, name, mimeType, cb) -> { entries:[fileObj] }
 *   uploadReplace(creds, fileId, localPath, mimeType, cb)      -> { entries:[fileObj] }
 *   getAccountInfo(creds, cb) -> { user:{ displayName, emailAddress } }
 * Plus contentUrl() used by the per-provider Photos commands (listAlbums/listPhotos).
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
			if (base.multipart){ o.multipart = base.multipart; }
			if (toFile)        { o.follow = true; o.outFile = base.outFile; }
			return HttpCurl.request(o);
		}
		f.now(this, function () { return fire(creds); });
		f.then(this, function () {
			var r = f.result;
			if (r && r.status === 401 && creds.refreshToken) {
				var rf = OAuth2.refresh(creds.refreshToken);
				rf.then(self, function () {
					var t = rf.result;
					var nc = { accessToken: t.accessToken,
						refreshToken: t.refreshToken || creds.refreshToken,   // Box rotates -> keep new
						expiresAt: Date.now() + (t.expiresIn * 1000) };
					if (onRenewed) { onRenewed(nc); }
					var retry = fire(nc);
					retry.then(self, function () { f.result = self._parse(retry.result, toFile, base); });
				});
				return;
			}
			f.result = self._parse(r, toFile, base);
		});
		return f;
	},

	_parse: function (r, toFile, base) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "BOX_API_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		if (toFile) { return { path: base.outFile }; }
		return r.responseText ? JSON.parse(r.responseText) : {};
	},

	// GET /users/me -> normalise to { user:{ displayName, emailAddress } }.
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this.get("/users/me?fields=id,name,login", creds, cb);
		call.then(this, function () {
			var u = call.result || {};
			f.result = { user: { emailAddress: u.login, displayName: u.name } };
		});
		return f;
	},

	// GET /folders/{id}/items -> normalised entries. Box items carry type("folder"|"file"),
	// id, name, size, modified_at. The locator is the item id (Box is ID-based).
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var id = folderId || Config.ROOT_FOLDER;
		var call = this.get("/folders/" + encodeURIComponent(id) +
			"/items?limit=1000&fields=id,type,name,size,modified_at", creds, cb);
		call.then(this, function () {
			var data = call.result || {};
			f.result = { entries: (data.entries || []).map(function (e) {
				// modified normalised to ISO-8601 UTC (…Z). Box returns modified_at as RFC-3339
				// with a timezone OFFSET (e.g. 2012-12-12T10:53:43-08:00); QuickOffice's
				// File.parseUtcDate only strips a trailing "Z" and splits the time on ":", so the
				// "-08:00" offset makes seconds NaN -> the date is dropped and the row collapses to
				// one line (misaligning the icon). new Date(...).toISOString() yields a clean …Z.
				return { id: e.id, type: (e.type === "folder" ? "folder" : "file"),
					name: e.name, size: e.size,
					modified: (e.modified_at ?
						new Date(e.modified_at).toISOString() : undefined),
					path: e.id };
			}) };
		});
		return f;
	},

	// GET /files/{id}/content -> 302 to dl.boxcloud.com (curl -L follows) -> bytes to disk.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		return this._req({ method: "GET",
			url: Config.API_BASE + "/files/" + encodeURIComponent(fileId) + "/content",
			outFile: localDest }, creds, cb, true);
	},

	// POST upload.box.com .../files/content (multipart: attributes JSON + file bytes). Creates
	// a NEW file; Box 409s if the name already exists - use uploadReplace to overwrite.
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var attrs = JSON.stringify({ name: name, parent: { id: folderId || Config.ROOT_FOLDER } });
		return this._req({ method: "POST", url: Config.UPLOAD_BASE + "/files/content",
			multipart: [ { name: "attributes", value: attrs }, { name: "file", file: localPath } ]
		}, creds, cb, false);
	},

	// POST .../files/{fileId}/content - upload a NEW VERSION of an existing file (Box overwrite,
	// e.g. QuickOffice save-back). Same response shape as uploadFile ({ entries:[fileObj] }).
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		return this._req({ method: "POST",
			url: Config.UPLOAD_BASE + "/files/" + encodeURIComponent(fileId) + "/content",
			multipart: [ { name: "file", file: localPath } ]
		}, creds, cb, false);
	},

	// Photos: a token-in-query content URL the aggregator's curl can fetch with no header.
	contentUrl: function (creds, fileId) {
		return Config.API_BASE + "/files/" + encodeURIComponent(fileId) +
			"/content?access_token=" + encodeURIComponent(creds.accessToken);
	},

	// DELETE /files/{id} -> remove a photo (Photos delete button). pid is the Box file id.
	// Box returns 204 No Content; _req/_parse treats any 2xx as OK and rejects otherwise.
	deletePhoto: function (creds, fileId, cb) {
		return this._req({ method: "DELETE",
			url: Config.API_BASE + "/files/" + encodeURIComponent(fileId) }, creds, cb, false);
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
