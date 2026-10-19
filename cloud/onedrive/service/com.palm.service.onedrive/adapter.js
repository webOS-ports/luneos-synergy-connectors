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
 *   createFolder(creds, parent, name, cb)               -> { entry }   (listFolder-shaped)
 *   moveItem(creds, item, toFolder|null, name|null, cb) -> { entry }
 *   deleteItem(creds, item, cb)                         -> {}          (to the recycle bin)
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
			if (base.body)     { o.body = base.body; }           // JSON body (file ops)
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
							refreshToken: t.refreshToken || creds.refreshToken,  // MS rotates -> keep new
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
			throw { returnValue: false, errorCode: "GRAPH_API_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		if (toFile) { return { path: base.outFile }; }
		return r.responseText ? JSON.parse(r.responseText) : {};
	},

	// GET /me -> normalise to { user:{ displayName, emailAddress } }. Personal accounts carry
	// `mail` sometimes null -> fall back to userPrincipalName.
	getAccountInfo: function (creds, cb) {
		// _map, not call.then(): a failed call read inside call's callback would stay on call.
		return this._map(this.get("/me?$select=id,displayName,userPrincipalName,mail", creds, cb), function (u) {
			u = u || {};
			return { user: { emailAddress: u.mail || u.userPrincipalName,
				displayName: u.displayName } };
		});
	},

	// RAW children of a drive item -> Graph { value:[driveItem] }. NO $select, so the folder/
	// file facets + @microsoft.graph.downloadUrl come through. itemId falsy/"root" = drive root.
	_children: function (creds, itemId, cb) {
		return this.get(this._childrenPath(itemId) + "?$top=1000", creds, cb);
	},

	// The children collection of a folder locator; falsy/"root" = the drive root.
	_childrenPath: function (itemId) {
		return (!itemId || itemId === Config.ROOT_FOLDER)
			? "/me/drive/root/children"
			: "/me/drive/items/" + encodeURIComponent(itemId) + "/children";
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
		return this._map(this._children(creds, folderId, cb), function (data) {
			data = data || {};
			return { entries: (data.value || []).map(function (e) { return this._entry(e); }, this) };
		});
	},

	// One Graph driveItem -> the NORMALISED entry listFolder hands out.
	_entry: function (e) {
		var isFolder = !!e.folder;
		return { id: e.id, type: (isFolder ? "folder" : "file"),
			name: e.name, size: e.size, modified: e.lastModifiedDateTime,
			path: e.id, mimeType: (e.file && e.file.mimeType),
			downloadUrl: e["@microsoft.graph.downloadUrl"] };
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

	// A JSON request against API_BASE.
	_json: function (method, path, body, creds, onRenewed) {
		return this._req({ method: method, url: Config.API_BASE + path,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body) }, creds, onRenewed, false);
	},

	// POST {parent}/children with a folder facet. conflictBehavior "fail": an existing name is
	// a 409, not a silently renamed "New Folder 1". -> { entry }
	createFolder: function (creds, parent, name, cb) {
		var call = this._json("POST", this._childrenPath(parent),
			{ name: name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }, creds, cb);
		return this._map(call, function (r) { return { entry: this._entry(r) }; });
	},

	// PATCH the item's name and/or parentReference. Graph refuses parentReference {id:"root"},
	// so a move to the root looks up the root's real id first. -> { entry }
	moveItem: function (creds, item, toFolder, name, cb) {
		var self = this, f = new Future();
		var renewed = null;
		function onR(nc) { renewed = nc; if (cb) { cb(nc); } }
		function patch(parentId) {
			var body = {};
			if (name !== null && name !== undefined) { body.name = name; }
			if (parentId) { body.parentReference = { id: parentId }; }
			var p = self._map(self._json("PATCH", "/me/drive/items/" + encodeURIComponent(item),
				body, renewed || creds, onR), function (r) { return { entry: this._entry(r) }; });
			p.then(self, function () {
				try { f.result = p.result; }
				catch (e) { f.setException(e); }
			});
		}
		if (toFolder !== Config.ROOT_FOLDER) { patch(toFolder || null); return f; }
		var rootF = this.get("/me/drive/root?$select=id", creds, onR);
		rootF.then(this, function () {
			// patch() in the try as well: rootF is not f, so a throw here would stay on rootF.
			try { patch(rootF.result.id); }
			catch (e) { f.setException(e); }
		});
		return f;
	},

	// DELETE the item: Graph moves it to the recycle bin (204 No Content). -> {}
	deleteItem: function (creds, item, cb) {
		var call = this._req({ method: "DELETE",
			url: Config.API_BASE + "/me/drive/items/" + encodeURIComponent(item) },
			creds, cb, false);
		return this._map(call, function () { return {}; });
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
