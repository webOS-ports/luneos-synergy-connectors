/*global IMPORTS, Config, OAuth2, HttpCurl, console */
/* adapter.js - Microsoft Graph (OneDrive) provider ADAPTER for _cloudcore. Graph is RESTful
 * and ID-addressed like Box, but the drive tree is reached by URL segments rather than a
 * numeric id in the path (root children /me/drive/root/children; folder children
 * /me/drive/items/{id}/children; bytes /me/drive/items/{id}/content -> 302 pre-signed URL). A
 * children listing WITHOUT $select returns each item's folder/file facet, size,
 * lastModifiedDateTime AND `@microsoft.graph.downloadUrl` (a short-lived pre-signed URL the
 * Photos aggregator's curl can fetch with no auth header). Microsoft ROTATES the refresh token
 * on every use, so the refreshed token is persisted. All HTTPS runs through _cloudcore/httpcurl
 * (device node is 0.9.8k).
 *
 * Uniform _cloudcore adapter interface (normalised shapes):
 *   listFolder(creds, folderId, cb) -> { entries:[{id,type,name,size,modified,path,mimeType,downloadUrl}] }
 *   downloadFile(creds, fileId, localDest, exportMime, cb) -> { path }   (exportMime ignored)
 *   uploadFile(creds, folderId, localPath, name, mimeType, cb) -> driveItem
 *   uploadReplace(creds, fileId, localPath, mimeType, cb)      -> driveItem
 *   getAccountInfo(creds, cb) -> { user:{ displayName, emailAddress } }
 * Plus listSpecialChildren() (RAW Graph {value:[driveItem]}) used by the per-provider Photos
 * commands, which read `@microsoft.graph.downloadUrl` off the raw driveItems.
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
			if (base.dataFile) { o.dataFile = base.dataFile; }   // raw-body PUT upload
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
						refreshToken: t.refreshToken || creds.refreshToken,  // MS rotates -> keep new
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
			throw { returnValue: false, errorCode: "GRAPH_API_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		if (toFile) { return { path: base.outFile }; }
		return r.responseText ? JSON.parse(r.responseText) : {};
	},

	// GET /me -> normalise to { user:{ displayName, emailAddress } }. Personal accounts carry
	// `mail` sometimes null -> fall back to userPrincipalName.
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this.get("/me?$select=id,displayName,userPrincipalName,mail", creds, cb);
		call.then(this, function () {
			var u = call.result || {};
			f.result = { user: { emailAddress: u.mail || u.userPrincipalName,
				displayName: u.displayName } };
		});
		return f;
	},

	// RAW children of a drive item -> Graph { value:[driveItem] }. NO $select, so the folder/
	// file facets + @microsoft.graph.downloadUrl come through. itemId falsy/"root" = drive root.
	_children: function (creds, itemId, cb) {
		var seg = (!itemId || itemId === Config.ROOT_FOLDER)
			? "/me/drive/root/children"
			: "/me/drive/items/" + encodeURIComponent(itemId) + "/children";
		return this.get(seg + "?$top=1000", creds, cb);
	},

	// RAW children of a named special folder (e.g. "cameraroll") -> Graph { value:[...] }. Used
	// by the Photos commands, which read @microsoft.graph.downloadUrl off the raw items.
	listSpecialChildren: function (creds, special, cb) {
		return this.get("/me/drive/special/" + encodeURIComponent(special) +
			"/children?$top=1000", creds, cb);
	},

	// Normalised list for the generic listFolder command. Graph driveItems carry a `folder`
	// facet (=> folder) or `file` facet, id, name, size, lastModifiedDateTime; the locator is
	// the item id (OneDrive is ID-based), handed back as the next folderId/fileId.
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var call = this._children(creds, folderId, cb);
		call.then(this, function () {
			var data = call.result || {};
			f.result = { entries: (data.value || []).map(function (e) {
				var isFolder = !!e.folder;
				return { id: e.id, type: (isFolder ? "folder" : "file"),
					name: e.name, size: e.size, modified: e.lastModifiedDateTime,
					path: e.id, mimeType: (e.file && e.file.mimeType),
					downloadUrl: e["@microsoft.graph.downloadUrl"] };
			}) };
		});
		return f;
	},

	// GET /me/drive/items/{id}/content -> 302 to a pre-signed host (curl -L follows and strips
	// the Authorization header on the cross-host redirect) -> bytes to disk. exportMime ignored.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		return this._req({ method: "GET",
			url: Config.API_BASE + "/me/drive/items/" + encodeURIComponent(fileId) + "/content",
			outFile: localDest }, creds, cb, true);
	},

	// PUT simple upload (raw file body). folderId falsy/"root" -> drive root. Good for files up
	// to ~250 MB; larger needs an upload session (not implemented). Returns the driveItem.
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var seg = (!folderId || folderId === Config.ROOT_FOLDER)
			? "/me/drive/root:/" + encodeURIComponent(name) + ":/content"
			: "/me/drive/items/" + encodeURIComponent(folderId) + ":/" +
				encodeURIComponent(name) + ":/content";
		return this._req({ method: "PUT", url: Config.API_BASE + seg,
			headers: { "Content-Type": "application/octet-stream" },
			dataFile: localPath }, creds, cb, false);
	},

	// PUT new content to an EXISTING item by id (QuickOffice save-back). mimeType ignored.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		return this._req({ method: "PUT",
			url: Config.API_BASE + "/me/drive/items/" + encodeURIComponent(fileId) + "/content",
			headers: { "Content-Type": "application/octet-stream" },
			dataFile: localPath }, creds, cb, false);
	},

	// DELETE /me/drive/items/{id} -> remove a photo (Photos delete button). pid is the driveItem
	// id listPhotos handed back. Graph returns 204 No Content; _req/_parse treats any 2xx as OK
	// and rejects otherwise, so the aggregator keeps the local copy on failure.
	deletePhoto: function (creds, fileId, cb) {
		return this._req({ method: "DELETE",
			url: Config.API_BASE + "/me/drive/items/" + encodeURIComponent(fileId) },
			creds, cb, false);
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
