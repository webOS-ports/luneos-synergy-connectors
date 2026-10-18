/*global IMPORTS, Config, HttpCurl, console */
/* adapter.js - Infomaniak kDrive REST provider ADAPTER for _cloudcore. kDrive is RESTful and
 * numeric-ID addressed (drive root dir id = 1) with two traits baked in here:
 *   1. TOKEN AUTH. A personal API token is sent as a Bearer header (creds.accessToken). The
 *      per-account drive id rides in creds.driveId (discovered at account-add). There is NO
 *      refresh flow - the token is long-lived - so the cb/onRenewed arg is accepted only for
 *      call-site symmetry and never invoked.
 *   2. RESULT ENVELOPE + MIXED VERSIONS. Responses are HTTP 200 with { result, data } (a
 *      nonzero/"error" result -> exception via _parse). files list/metadata + upload use the
 *      v3 path; drive list + download use v2. _url(version, path) builds each explicitly.
 * All HTTPS runs through _cloudcore/httpcurl because the device node is OpenSSL 0.9.8k.
 *
 * Uniform _cloudcore adapter interface (normalised shapes):
 *   listFolder(creds, folderId, cb) -> { entries:[{id,type,name,size,modified,path,mimeType}] }
 *   downloadFile(creds, fileId, localDest, exportMime, cb) -> { path }   (exportMime ignored)
 *   uploadFile(creds, folderId, localPath, name, mimeType, cb) -> kDrive file object
 *   uploadReplace(creds, fileId, localPath, mimeType, cb)      -> kDrive file object
 *   getAccountInfo(creds, cb) -> { user:{ displayName, emailAddress } }
 * Plus listDrives()/getProfile() used by the token-verify command to auto-discover the drive.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

// Local fs, used only to size uploads (kDrive requires total_size up front). require() is
// available in the service context, same as _cloudcore/httpcurl; fall back to IMPORTS.require.
var _fs = (function () {
	try {
		var r = (typeof require !== "undefined") ? require : (IMPORTS.require || null);
		return r ? r("fs") : null;
	} catch (e) { return null; }
})();

var Adapter = {
	_url: function (version, path) {
		return Config.API_HOST + "/" + version + path;
	},

	// GET a JSON endpoint with the Bearer token. version = "2" | "3".
	_get: function (creds, version, path) {
		var self = this, f = new Future();
		f.now(this, function () {
			return HttpCurl.request({ method: "GET", url: self._url(version, path),
				bearer: creds.accessToken });
		});
		f.then(this, function () { f.result = self._parse(f.result); });
		return f;
	},

	// Validate transport status + kDrive's { result } envelope; return the `data` payload.
	_parse: function (r) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "KDRIVE_HTTP_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		var j = r.responseText ? JSON.parse(r.responseText) : {};
		if (j.result && j.result !== "success") {
			throw { returnValue: false, errorCode: "KDRIVE_API_ERROR",
				error: j.error, body: r.responseText };
		}
		return (j.data !== undefined) ? j.data : j;
	},

	// GET /2/profile -> the logged-in user; also carries preferences.account.current_account_id.
	getProfile: function (creds, cb) {
		return this._get(creds, "2", "/profile");
	},

	// GET /2/drive?account_id={id} -> [ drive ] the account can reach.
	listDrives: function (creds, accountId, cb) {
		return this._get(creds, "2", "/drive?account_id=" + encodeURIComponent(accountId));
	},

	// Auto-discover account_id + drive_id (+ identity) from JUST the token. The verifyToken
	// validator calls this to enrich the stored credentials, so the user never types an id.
	// Picks the FIRST drive the account owns.
	// Resolves to { accountId, driveId, email, displayName }.
	discoverAccount: function (creds, cb) {
		var self = this, f = new Future();
		var pf = this.getProfile(creds, cb);
		f.now(this, function () { return pf; });
		f.then(this, function () {
			var p;
			try { p = pf.result || {}; }
			catch (e) { f.setException(e); return; }
			var accountId = (p.preferences && p.preferences.account &&
				p.preferences.account.current_account_id) || null;
			if (!accountId) {
				f.setException({ returnValue: false, errorCode: "KDRIVE_NO_ACCOUNT", detail: p });
				return;
			}
			var dr = self.listDrives(creds, accountId, cb);
			dr.then(self, function () {
				var drives;
				try { drives = dr.result || []; }
				catch (e2) { f.setException(e2); return; }
				if (!drives.length) {
					f.setException({ returnValue: false, errorCode: "KDRIVE_NO_DRIVE",
						detail: accountId });
					return;
				}
				var driveId = drives[0].id;
					// Discover the writable private-space root now so it is stored in the
					// credentials and later file ops skip the extra lookup.
					var pr = self.findPrivateRoot({ accessToken: creds.accessToken, driveId: driveId });
					pr.then(self, function () {
						f.result = { accountId: accountId, driveId: driveId,
							rootFolderId: pr.result, email: p.email, displayName: p.display_name };
					});
			});
		});
		return f;
	},

	// Find the account's WRITABLE root. kDrive's drive-root (id 1) is a non-writable container
	// (visibility "is_root", capabilities.can_write=false); user files live one level down in the
	// private space (visibility "is_private_space"). List the root children and pick it. Resolves
	// to a numeric folder id (falls back to the drive root if none is found).
	// True for the "account root" locators QuickOffice/commands pass (null, "", "root", or the
	// configured ROOT_FOLDER=1 default) - all of which must resolve to the writable private root,
	// since the kDrive drive-root itself (id 1) refuses listing-as-target / uploads.
	_isRootTarget: function (folderId) {
		return folderId == null || folderId === "" || folderId === "root" ||
			String(folderId) === String(Config.ROOT_FOLDER);
	},

	findPrivateRoot: function (creds, cb) {
		var self = this, f = new Future();
		var call = this._get(creds, "3", "/drive/" + creds.driveId + "/files/1/files");
		call.then(this, function () {
			var kids = call.result || [], priv = null, i;
			for (i = 0; i < kids.length; i++) {
				if (kids[i] && kids[i].visibility === "is_private_space") { priv = kids[i]; break; }
			}
			if (!priv) {   // no explicit private space -> first directory child
				for (i = 0; i < kids.length; i++) {
					if (kids[i] && kids[i].type === "dir") { priv = kids[i]; break; }
				}
			}
			f.result = priv ? priv.id : Config.ROOT_FOLDER;
		});
		return f;
	},

	// Resolve the writable root folder id, preferring the value discovered at account-add
	// (creds.rootFolderId), else discovering once and caching it on the creds object for the
	// rest of this request. Always resolves to a numeric id.
	_resolveRoot: function (creds) {
		var self = this, f = new Future();
		if (creds.rootFolderId) { f.result = creds.rootFolderId; return f; }
		var d = this.findPrivateRoot(creds);
		f.now(this, function () { return d; });
		f.then(this, function () { creds.rootFolderId = d.result; f.result = d.result; });
		return f;
	},

	// --- Photos-provider helpers (PHOTO.UPLOAD role) ------------------------------------
	// Resolve the numeric id of a named child folder directly under the writable private root
	// (the configured photo album). Resolves to the folder id, or null if no such folder exists.
	findAlbumFolder: function (creds, name, cb) {
		var self = this, f = new Future();
		var rootF = this._resolveRoot(creds);
		f.now(this, function () { return rootF; });
		f.then(this, function () {
			var lf = self.listFolder(creds, rootF.result, cb);
			lf.then(self, function () {
				var entries = (lf.result && lf.result.entries) || [], hit = null,
					want = String(name).toLowerCase(), i;
				for (i = 0; i < entries.length; i++) {
					if (entries[i].type === "folder" &&
						String(entries[i].name).toLowerCase() === want) { hit = entries[i].id; break; }
				}
				f.result = hit;
			});
		});
		return f;
	},

	// Find the named album folder under the private root, creating it if it does not yet exist.
	// Only used when the aggregator supplies no albumId (e.g. an as-yet-empty "Pictures" album);
	// the normal path uploads straight into the album id surfaced by listAlbums. Resolves to a
	// numeric folder id.
	ensureAlbumFolder: function (creds, name, cb) {
		var self = this, f = new Future();
		var findF = this.findAlbumFolder(creds, name, cb);
		f.now(this, function () { return findF; });
		f.then(this, function () {
			var hit;
			try { hit = findF.result; }
			catch (e) { f.setException(e); return; }
			if (hit) { f.result = hit; return; }
			// Not there - create it under the writable private root.
			var rootF = self._resolveRoot(creds);
			var g = new Future();
			g.now(self, function () { return rootF; });
			g.then(self, function () {
				var create = HttpCurl.request({ method: "POST",
					url: self._url("3", "/drive/" + creds.driveId + "/files/" +
						encodeURIComponent(rootF.result) + "/directory"),
					bearer: creds.accessToken,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: name }) });
				create.then(self, function () {
					var d = self._parse(create.result) || {};
					f.result = (d.id != null) ? d.id : rootF.result;
				});
			});
		});
		return f;
	},

	// Full-res photo URL that self-authenticates via ?access_token= (the Photos aggregator fetch
	// sends NO Authorization header). 302 -> pre-signed host; curl -L follows across the redirect.
	photoDownloadUrl: function (creds, fileId) {
		return Config.API_HOST + "/2/drive/" + creds.driveId + "/files/" +
			encodeURIComponent(fileId) + "/download?access_token=" +
			encodeURIComponent(creds.accessToken);
	},

	// Thumbnail URL (direct 200 bytes) for the grid small image; same headerless ?access_token=.
	photoThumbUrl: function (creds, fileId) {
		return Config.API_HOST + "/2/drive/" + creds.driveId + "/files/" +
			encodeURIComponent(fileId) + "/thumbnail?access_token=" +
			encodeURIComponent(creds.accessToken);
	},

	// GET /2/profile -> normalise to { user:{ displayName, emailAddress } } (generic
	// checkCredentials contract). Verifies the token is still valid as a side effect.
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this.getProfile(creds, cb);
		call.then(this, function () {
			var u = call.result || {};
			f.result = { user: { emailAddress: u.email, displayName: u.display_name } };
		});
		return f;
	},

	// GET /3/drive/{drive}/files/{id}/files -> normalised children. kDrive items carry
	// type("dir"|"file"), id, name, size, last_modified_at, parent_id; the locator is the
	// numeric id, handed back as the next folderId/fileId.
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var isRoot = self._isRootTarget(folderId);
		var go = function (id) {
			var call = self._get(creds, "3",
				"/drive/" + creds.driveId + "/files/" + encodeURIComponent(id) + "/files");
			call.then(self, function () {
				var data = call.result || [];
				f.result = { entries: data.map(function (e) {
					// Locators are STRINGS: kDrive ids are numeric, but QuickOffice/consumers do
					// string ops on id/path (e.g. .replace()), so a raw number breaks them.
					// modified is an ISO-8601 UTC string: kDrive gives last_modified_at as UNIX
					// SECONDS, but consumers (QuickOffice's File.parseUtcDate) expect an ISO string
					// and .split("T") a number -> the date is dropped and the file row collapses to
					// one line (misaligning the row icon). Convert seconds -> ISO here.
					return { id: String(e.id), type: (e.type === "dir" ? "folder" : "file"),
						name: e.name, size: e.size,
						modified: (e.last_modified_at ?
							new Date(e.last_modified_at * 1000).toISOString() : undefined),
						path: String(e.id), mimeType: e.mime_type };
				}) };
			});
		};
		if (isRoot) {
			var rootF = this._resolveRoot(creds);
			f.now(this, function () { return rootF; });
			f.then(this, function () { go(rootF.result); });
		} else {
			go(folderId);
		}
		return f;
	},

	// GET /2/drive/{drive}/files/{id}/download -> 302 to a pre-signed download host (curl -L
	// follows and drops the Authorization header on the cross-host redirect) -> bytes to disk.
	// exportMime ignored (kDrive serves native bytes).
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		var self = this, f = new Future();
		f.now(this, function () {
			return HttpCurl.request({ method: "GET",
				url: self._url("2", "/drive/" + creds.driveId + "/files/" +
					encodeURIComponent(fileId) + "/download"),
				bearer: creds.accessToken, follow: true, outFile: localDest });
		});
		f.then(this, function () {
			var r = f.result;
			if (!r || r.status < 200 || r.status >= 300) {
				f.setException({ returnValue: false, errorCode: "KDRIVE_DOWNLOAD_FAILED",
					status: r && r.status });
				return;
			}
			f.result = { path: localDest };
		});
		return f;
	},

	// POST /3/drive/{drive}/upload?directory_id={folder}&file_name={name}&conflict=version
	// with the raw file bytes as the body. folderId falsy -> root. `conflict=version` makes a
	// same-name upload create a new VERSION (create-or-overwrite), matching Dropbox/OneDrive.
	// Returns the kDrive file object (data).
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var self = this, f = new Future();
		// kDrive requires total_size up front, and refuses uploads into the drive root (id 1) -
		// a folder id (falsy -> the private-space root) must be given. conflict=version makes a
		// same-name upload a new VERSION (create-or-overwrite), matching Dropbox/OneDrive.
		var send = function (dir) {
			var total = 0;
			try { if (_fs) { total = _fs.statSync(localPath).size; } } catch (e) {}
			var q = "?directory_id=" + encodeURIComponent(dir) +
				"&file_name=" + encodeURIComponent(name) +
				"&conflict=version&total_size=" + total;
			var up = HttpCurl.request({ method: "POST",
				url: self._url("3", "/drive/" + creds.driveId + "/upload" + q),
				bearer: creds.accessToken,
				headers: { "Content-Type": "application/octet-stream" },
				dataFile: localPath });
			up.then(self, function () {
				var d = self._parse(up.result);
				if (d && d.id != null) { d.id = String(d.id); }   // string locator (see listFolder)
				f.result = d;
			});
		};
		if (self._isRootTarget(folderId)) {
			var rootF = this._resolveRoot(creds);
			f.now(this, function () { return rootF; });
			f.then(this, function () { send(rootF.result); });
		} else {
			send(folderId);
		}
		return f;
	},

	// Overwrite an EXISTING file by id (QuickOffice save-back). Look up its name + parent dir,
	// then upload the same name into the same folder with conflict=version (kDrive has no
	// upload-by-file-id; a new version is keyed on directory_id + file_name). mimeType ignored.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		var self = this, f = new Future();
		var info = this._get(creds, "3",
			"/drive/" + creds.driveId + "/files/" + encodeURIComponent(fileId));
		f.now(this, function () { return info; });
		f.then(this, function () {
			var meta;
			try { meta = info.result || {}; }
			catch (e) { f.setException(e); return; }
			if (meta.name == null || meta.parent_id == null) {
				f.setException({ returnValue: false, errorCode: "KDRIVE_NO_FILEINFO", detail: meta });
				return;
			}
			var up = self.uploadFile(creds, meta.parent_id, localPath, meta.name, mimeType, cb);
			up.then(self, function () {
				try { f.result = up.result; }
				catch (e2) { f.setException(e2); }
			});
		});
		return f;
	},

	// DELETE /2/drive/{driveId}/files/{id} -> remove a photo (Photos delete button). pid is the
	// kDrive numeric file id. kDrive tokens are long-lived (no OAuth refresh); any 2xx = success,
	// reject otherwise so the aggregator keeps the local copy.
	deletePhoto: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var del = HttpCurl.request({ method: "DELETE",
			url: self._url("2", "/drive/" + creds.driveId + "/files/" + encodeURIComponent(fileId)),
			bearer: creds.accessToken });
		del.then(this, function () {
			var r = del.result;
			if (r && r.status >= 200 && r.status < 300) { f.result = { deleted: true }; }
			else { f.setException({ returnValue: false, errorCode: "KDRIVE_DELETE_FAILED",
				status: r && r.status, body: r && r.responseText }); }
		});
		return f;
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
