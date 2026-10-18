/*global IMPORTS, Config, HttpCurl, S3Sig, S3Xml, console */
/* adapter.js - generic S3-compatible provider ADAPTER for _cloudcore. S3 is a flat key/value
 * store; "folders" are emulated with key PREFIXES and the "/" delimiter, so a locator here is a
 * key/prefix string (the bucket root is the empty prefix ""). Every request is SigV4-signed with
 * the account's access key / secret (s3sig.js) and shelled through the modern curl (HttpCurl).
 * There is no token refresh - the keys are static - so _req is a straight sign+send.
 *
 * Credentials (creds): { accessToken:<accessKeyId>, secretAccessKey, endpoint(host), region,
 * bucket, pathStyle }. Exposes the uniform _cloudcore adapter interface plus the PHOTO.UPLOAD
 * helpers; getTemporaryLink returns a PRESIGNED GET URL, which the Photos aggregator's curl can
 * fetch with no auth header (a natural fit for S3).
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var Adapter = {
	_leaf: function (p) {
		var s = String(p == null ? "" : p).replace(/\/+$/, "");
		var i = s.lastIndexOf("/");
		return (i >= 0) ? s.substring(i + 1) : s;
	},
	_mime: function (name, isFolder) {
		if (isFolder) { return "application/x-directory"; }
		var m = /\.([a-z0-9]+)$/i.exec(name || "");
		var ext = m ? m[1].toLowerCase() : "";
		var map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
			bmp: "image/bmp", heic: "image/heic", webp: "image/webp", tif: "image/tiff",
			tiff: "image/tiff", pdf: "application/pdf", txt: "text/plain",
			doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
		return map[ext] || "application/octet-stream";
	},

	// endpoint host + canonical resource path for a key, honouring path-style vs virtual-host.
	_target: function (creds, key) {
		key = key || "";
		if (creds.pathStyle === false) {
			return { host: creds.bucket + "." + creds.endpoint, path: key };
		}
		return { host: creds.endpoint, path: creds.bucket + "/" + key };
	},

	// Sign + send one S3 request. opts: { method, key, query, headers, payloadHash, outFile,
	// dataFile }. Resolves to the raw HttpCurl result { status, responseText }.
	_req: function (creds, opts) {
		var f = new Future();
		var t = this._target(creds, opts.key);
		var signed = S3Sig.signRequest({
			method: opts.method || "GET",
			host: t.host, path: t.path, query: opts.query || {},
			headers: opts.headers || {},
			payloadHash: opts.payloadHash,
			region: creds.region || Config.DEFAULT_REGION, service: "s3",
			accessKeyId: creds.accessToken, secretAccessKey: creds.secretAccessKey
		});
		var reqOpts = { method: opts.method || "GET", url: signed.url, headers: signed.headers };
		if (opts.outFile) { reqOpts.outFile = opts.outFile; reqOpts.follow = true; }
		if (opts.dataFile) { reqOpts.dataFile = opts.dataFile; }
		var call = HttpCurl.request(reqOpts);
		f.now(this, function () { return call; });
		f.then(this, function () { f.result = call.result; });
		return f;
	},

	_check: function (r, code) {
		if (!r || r.status < 200 || r.status >= 300) {
			var err = (r && r.responseText) ? S3Xml.parseError(r.responseText) : null;
			throw { returnValue: false, errorCode: code || "S3_API_ERROR",
				status: r && r.status, s3Code: err && err.code, detail: err && err.message };
		}
		return r;
	},

	// GET the account identity - S3 has no user endpoint, so this VALIDATES the credentials with a
	// zero-key ListObjectsV2 (proves signing works + bucket is reachable) and reports a friendly
	// identity built from the bucket/endpoint.
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var call = this._req(creds, { method: "GET", key: "",
			query: { "list-type": "2", "max-keys": "0" } });
		call.then(this, function () {
			try { self._check(call.result, "S3_AUTH_FAILED"); }
			catch (e) { f.setException(e); return; }
			f.result = { user: {
				emailAddress: creds.bucket + "@" + creds.endpoint,
				displayName:  creds.bucket
			} };
		});
		return f;
	},

	// List a prefix's direct children (delimiter "/"), paging until IsTruncated=false.
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var prefix = (folderId === "root" || folderId == null) ? "" : folderId;
		if (prefix && prefix.charAt(prefix.length - 1) !== "/") { prefix += "/"; }
		var entries = [];
		function page(token) {
			var q = { "list-type": "2", prefix: prefix, delimiter: "/",
				"max-keys": String(Config.LIST_LIMIT || 1000) };
			if (token) { q["continuation-token"] = token; }
			var call = self._req(creds, { method: "GET", key: "", query: q });
			call.then(self, function () {
				var parsed;
				try { self._check(call.result, "S3_LIST_FAILED"); parsed = S3Xml.parseList(call.result.responseText); }
				catch (e) { f.setException(e); return; }
				parsed.prefixes.forEach(function (p) {
					entries.push({ id: p, type: "folder", name: self._leaf(p), size: 0,
						modified: 0, path: p, mimeType: self._mime(null, true) });
				});
				parsed.files.forEach(function (o) {
					if (o.key === prefix) { return; }   // the folder's own placeholder object
					entries.push({ id: o.key, type: "file", name: self._leaf(o.key),
						size: o.size, modified: o.modified ? Date.parse(o.modified) : 0,
						path: o.key, mimeType: self._mime(o.key, false) });
				});
				if (parsed.truncated && parsed.nextToken) { page(parsed.nextToken); }
				else { f.result = { entries: entries }; }
			});
		}
		page(null);
		return f;
	},

	// GET an object straight to disk (exportMime ignored).
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		var self = this, f = new Future();
		var call = this._req(creds, { method: "GET", key: fileId, outFile: localDest });
		call.then(this, function () {
			try { self._check(call.result, "S3_DOWNLOAD_FAILED"); }
			catch (e) { f.setException(e); return; }
			f.result = { path: localDest };
		});
		return f;
	},

	// PUT a local file into a prefix as prefix+name.
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var prefix = (folderId === "root" || folderId == null) ? "" : folderId;
		if (prefix && prefix.charAt(prefix.length - 1) !== "/") { prefix += "/"; }
		return this._put(creds, prefix + name, localPath, mimeType);
	},
	// Overwrite an existing object by key (QuickOffice save-back). S3 PUT overwrites in place.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		return this._put(creds, fileId, localPath, mimeType);
	},
	_put: function (creds, key, localPath, mimeType) {
		var self = this, f = new Future();
		var fs = IMPORTS.require ? IMPORTS.require("fs") : (typeof require !== "undefined" ? require("fs") : null);
		var size = 0;
		try { if (fs) { size = fs.statSync(localPath).size; } } catch (e) {}
		var headers = {};
		if (mimeType) { headers["content-type"] = mimeType; }
		var call = this._req(creds, { method: "PUT", key: key, dataFile: localPath,
			payloadHash: "UNSIGNED-PAYLOAD", headers: headers });
		call.then(this, function () {
			try { self._check(call.result, "S3_UPLOAD_FAILED"); }
			catch (e) { f.setException(e); return; }
			f.result = { id: key, path: key, name: self._leaf(key), size: size };
		});
		return f;
	},

	// --- PHOTO.UPLOAD helpers ------------------------------------------------------------
	// Surface one prefix ("Camera Uploads/") as one album. Reports exists=true if anything is
	// already under it.
	resolvePhotoAlbum: function (creds, cb) {
		var self = this, f = new Future();
		var name = Config.PHOTO_ALBUM_NAME || "Camera Uploads";
		var prefix = name + "/";
		var call = this._req(creds, { method: "GET", key: "",
			query: { "list-type": "2", prefix: prefix, "max-keys": "1" } });
		call.then(this, function () {
			var exists = false;
			try { self._check(call.result, "S3_LIST_FAILED");
				var p = S3Xml.parseList(call.result.responseText);
				exists = (p.files.length > 0 || p.prefixes.length > 0);
			} catch (e) { exists = false; }
			f.result = { path: prefix, name: name, exists: exists };
		});
		return f;
	},
	// "Create" a folder = PUT a zero-byte marker object "<name>/".
	ensureAlbumFolder: function (creds, name, cb) {
		var self = this, f = new Future();
		var prefix = String(name).replace(/\/+$/, "") + "/";
		var call = this._req(creds, { method: "PUT", key: prefix, body: "",
			payloadHash: S3Sig.sha256Hex("") });
		call.then(this, function () {
			try { self._check(call.result, "S3_MKDIR_FAILED"); }
			catch (e) { f.setException(e); return; }
			f.result = prefix;
		});
		return f;
	},
	// A presigned GET URL the Photos aggregator's curl can fetch header-less.
	getTemporaryLink: function (creds, fileId, cb) {
		var t = this._target(creds, fileId);
		var url = S3Sig.presignUrl({ method: "GET", host: t.host, path: t.path,
			expires: 3600, region: creds.region || Config.DEFAULT_REGION, service: "s3",
			accessKeyId: creds.accessToken, secretAccessKey: creds.secretAccessKey });
		var f = new Future();
		f.result = { link: url, method: "GET" };
		return f;
	},
	// DELETE an object.
	deletePhoto: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var call = this._req(creds, { method: "DELETE", key: fileId });
		call.then(this, function () {
			try {
				var r = call.result;
				// S3 returns 204 for a delete (and 204 even if the key was absent).
				if (r && (r.status === 204 || (r.status >= 200 && r.status < 300))) { f.result = { deleted: true }; }
				else { self._check(r, "S3_DELETE_FAILED"); }
			} catch (e) { f.setException(e); }
		});
		return f;
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
