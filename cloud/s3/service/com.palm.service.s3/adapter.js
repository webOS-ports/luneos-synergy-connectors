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
		var f = new Future(), t, signed;
		// A request that cannot be signed (a credential field missing) fails f rather than
		// throwing: _req is called from other Futures' callbacks, where a throw would be lost.
		try {
			t = this._target(creds, opts.key);
			signed = S3Sig.signRequest({
				method: opts.method || "GET",
				host: t.host, path: t.path, query: opts.query || {},
				headers: opts.headers || {},
				payloadHash: opts.payloadHash,
				region: creds.region || Config.DEFAULT_REGION, service: "s3",
				accessKeyId: creds.accessToken, secretAccessKey: creds.secretAccessKey
			});
		} catch (e) { f.setException(e); return f; }
		var reqOpts = { method: opts.method || "GET", url: signed.url, headers: signed.headers };
		if (opts.outFile) { reqOpts.outFile = opts.outFile; reqOpts.follow = true; }
		if (opts.dataFile) { reqOpts.dataFile = opts.dataFile; }
		else if (opts.body) { reqOpts.body = opts.body; }
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

	// listFolder's entry shapes: a common prefix ("a/b/") is a folder, an object key a file.
	_folderEntry: function (p) {
		return { id: p, type: "folder", name: this._leaf(p), size: 0,
			modified: 0, path: p, mimeType: this._mime(null, true) };
	},
	_fileEntry: function (o) {
		return { id: o.key, type: "file", name: this._leaf(o.key),
			size: o.size, modified: o.modified ? Date.parse(o.modified) : 0,
			path: o.key, mimeType: this._mime(o.key, false) };
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
			// All of it in the try: call is not f, so a throw here would stay on call.
			call.then(self, function () {
				try {
					self._check(call.result, "S3_LIST_FAILED");
					var parsed = S3Xml.parseList(call.result.responseText);
					parsed.prefixes.forEach(function (p) { entries.push(self._folderEntry(p)); });
					parsed.files.forEach(function (o) {
						if (o.key === prefix) { return; }   // the folder's own placeholder object
						entries.push(self._fileEntry(o));
					});
					if (parsed.truncated && parsed.nextToken) { page(parsed.nextToken); }
					else { f.result = { entries: entries }; }
				} catch (e) { f.setException(e); }
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

	// --- createFolder / moveItem / deleteItem ------------------------------------------------
	// S3 has no folders and no rename. A folder is a key prefix, made visible by a zero-byte
	// "<prefix>/" marker object (the S3 console's convention); a move or rename is CopyObject to the
	// new key and then DeleteObject of the old one; a folder move or delete walks every key under
	// the prefix. A locator ending in "/" is a folder (listFolder hands out common prefixes that
	// way), anything else an object key; "root"/""/null is the bucket root.
	MAX_COPY_BYTES:     5 * 1024 * 1024 * 1024,   // CopyObject copies at most 5 GB in one request
	// Bounds. moveItem/deleteItem run under the service's 30 s commandTimeout and every S3 request
	// is its own curl process + TLS handshake, so a folder move (one CopyObject per key, serially)
	// is held to MAX_MOVE_KEYS; a folder delete is one listing page + one DeleteObjects batch per
	// 1000 keys, so it can take MAX_DELETE_KEYS. Bigger trees are refused up front, untouched.
	MAX_MOVE_KEYS:      25,
	MAX_DELETE_KEYS:    1000,
	DELETE_BATCH_KEYS:  1000,          // DeleteObjects' per-request limit
	DELETE_BATCH_BYTES: 96 * 1024,     // the XML goes to curl in argv: stay under 128 KiB per string

	_err: function (code, detail, extra) {
		var e = { returnValue: false, errorCode: code, detail: detail };
		Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
		return e;
	},
	_isRoot: function (loc) { return loc == null || loc === "" || loc === "root"; },
	_isFolder: function (loc) { return String(loc).charAt(String(loc).length - 1) === "/"; },
	_prefixOf: function (folderId) {
		var prefix = this._isRoot(folderId) ? "" : String(folderId);
		if (prefix && prefix.charAt(prefix.length - 1) !== "/") { prefix += "/"; }
		return prefix;
	},
	// "a/b/c.txt" -> "a/b/", "a/b/" -> "a/", "c.txt" -> "".
	_parentOf: function (loc) {
		var s = String(loc).replace(/\/+$/, "");
		var i = s.lastIndexOf("/");
		return (i >= 0) ? s.substring(0, i + 1) : "";
	},
	_badName: function (name) {
		return typeof name !== "string" || !name || name === "." || name === ".." || /[\/\u0000]/.test(name);
	},
	// Run fn(result) once `call` settles; a failed call or a throw in fn fails `f`.
	_after: function (call, f, fn) {
		var self = this;
		call.then(this, function () {
			var r;
			try { r = call.result; } catch (e) { f.setException(e); return; }
			try { fn.call(self, r); } catch (e2) { f.setException(e2); }
		});
	},

	// The first object at or under `prefix` (ListObjectsV2, max-keys 1), or null. Keys list in
	// UTF-8 binary order, so for an exact key that first object is the key itself when it exists.
	_first: function (creds, prefix) {
		var f = new Future();
		var call = this._req(creds, { method: "GET", key: "",
			query: { "list-type": "2", prefix: prefix, "max-keys": "1" } });
		this._after(call, f, function (r) {
			this._check(r, "S3_LIST_FAILED");
			var files = S3Xml.parseList(r.responseText).files;
			f.result = { file: files.length ? files[0] : null };
		});
		return f;
	},
	_stat: function (creds, key) {
		var f = new Future(), call = this._first(creds, key);
		this._after(call, f, function (r) {
			f.result = { file: (r.file && r.file.key === key) ? r.file : null };
		});
		return f;
	},
	// Every object under `prefix` (no delimiter, so the whole subtree including a marker), paged
	// with continuation tokens. More than `max` fails S3_TOO_MANY_KEYS before anything is changed.
	_listTree: function (creds, prefix, max) {
		var self = this, f = new Future(), keys = [];
		function page(token) {
			var q = { "list-type": "2", prefix: prefix,
				"max-keys": String(Math.min(Config.LIST_LIMIT || 1000, max + 1 - keys.length)) };
			if (token) { q["continuation-token"] = token; }
			self._after(self._req(creds, { method: "GET", key: "", query: q }), f, function (r) {
				this._check(r, "S3_LIST_FAILED");
				var parsed = S3Xml.parseList(r.responseText);
				parsed.files.forEach(function (o) { keys.push(o); });
				if (keys.length > max) {
					throw this._err("S3_TOO_MANY_KEYS", "more than " + max + " objects under " + prefix, { limit: max });
				}
				if (parsed.truncated && parsed.nextToken) { page(parsed.nextToken); }
				else { f.result = { files: keys }; }
			});
		}
		page(null);
		return f;
	},
	// CopyObject: PUT the destination with x-amz-copy-source "<bucket>/<key>" (URL-encoded, signed
	// like any other header). A 200 can still carry an <Error> when the copy failed part-way, so
	// only a body holding <CopyObjectResult> and no <Error> counts as copied.
	_copy: function (creds, fromKey, toKey) {
		var f = new Future();
		var call = this._req(creds, { method: "PUT", key: toKey,
			headers: { "x-amz-copy-source": S3Sig.uriEncode(creds.bucket + "/" + fromKey, false),
				"content-length": "0" } });
		this._after(call, f, function (r) {
			this._check(r, "S3_COPY_FAILED");
			var text = r.responseText || "", err = S3Xml.parseError(text);
			if (err || text.indexOf("<CopyObjectResult") < 0) {
				throw this._err("S3_COPY_FAILED", (err && err.message) || "no CopyObjectResult in the reply",
					{ status: r.status, s3Code: err && err.code });
			}
			f.result = { modified: S3Xml.tag(text, "LastModified") };
		});
		return f;
	},
	_deleteKey: function (creds, key) {
		var f = new Future();
		this._after(this._req(creds, { method: "DELETE", key: key }), f, function (r) {
			this._check(r, "S3_DELETE_FAILED");   // 204, also for a key that was not there
			f.result = {};
		});
		return f;
	},
	_xmlEscape: function (s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&apos;")
			.replace(/[\u0000-\u001f]/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
	},
	// DeleteObjects (POST /?delete, quiet mode, Content-MD5) in batches. Resolves to
	// { failed: [{key, code, message}] } for per-key errors; a batch the server rejects outright
	// fails the Future (later batches are not sent).
	_deleteKeys: function (creds, keys) {
		var self = this, f = new Future(), failed = [], batches = [], cur = [], bytes = 0;
		keys.forEach(function (k) {
			var obj = "<Object><Key>" + self._xmlEscape(k) + "</Key></Object>";
			var n = unescape(encodeURIComponent(obj)).length;
			if (cur.length && (cur.length >= self.DELETE_BATCH_KEYS || bytes + n > self.DELETE_BATCH_BYTES)) {
				batches.push(cur); cur = []; bytes = 0;
			}
			cur.push(obj); bytes += n;
		});
		if (cur.length) { batches.push(cur); }
		function next(i) {
			if (i >= batches.length) { f.result = { failed: failed }; return; }
			var body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
				"<Delete xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Quiet>true</Quiet>" +
				batches[i].join("") + "</Delete>";
			var call = self._req(creds, { method: "POST", key: "", query: { "delete": "" }, body: body,
				payloadHash: S3Sig.sha256Hex(body),
				headers: { "content-type": "application/xml", "content-md5": S3Sig.md5Base64(body) } });
			self._after(call, f, function (r) {
				this._check(r, "S3_DELETE_FAILED");
				var text = r.responseText || "";
				if (text.indexOf("<DeleteResult") < 0) {
					var err = S3Xml.parseError(text);
					throw this._err("S3_DELETE_FAILED", (err && err.message) || "no DeleteResult in the reply",
						{ status: r.status, s3Code: err && err.code });
				}
				var re = /<Error>([\s\S]*?)<\/Error>/g, m;
				while ((m = re.exec(text)) !== null) {
					failed.push({ key: S3Xml.tag(m[1], "Key"), code: S3Xml.tag(m[1], "Code"),
						message: S3Xml.tag(m[1], "Message") });
				}
				next(i + 1);
			});
		}
		next(0);
		return f;
	},

	// Make "<parent><name>/" as a zero-byte marker. S3 overwrites in place, so an existing folder
	// of that name stays as it is.
	createFolder: function (creds, parent, name, onRenew) {
		var f = new Future();
		if (this._badName(name)) { f.setException(this._err("BAD_ARGS", "name: one path component")); return f; }
		var key = this._prefixOf(parent) + name + "/";
		var call = this._req(creds, { method: "PUT", key: key, headers: { "content-length": "0" },
			payloadHash: S3Sig.sha256Hex("") });
		this._after(call, f, function (r) {
			this._check(r, "S3_MKDIR_FAILED");
			f.result = { entry: this._folderEntry(key) };
		});
		return f;
	},

	// Rename (name), move (toFolder) or both. A file is copied, then the original deleted only
	// once the copy succeeded. A folder is copied key by key, then the originals deleted only once
	// every copy succeeded; if one fails, the copies made so far are removed again. An existing
	// destination is refused rather than overwritten or merged into.
	moveItem: function (creds, item, toFolder, name, onRenew) {
		var self = this, f = new Future();
		if (this._isRoot(item)) { f.setException(this._err("BAD_ARGS", "the root folder cannot be moved")); return f; }
		item = String(item);
		var folder = this._isFolder(item);
		var newName = (name == null) ? this._leaf(item) : name;
		if (this._badName(newName)) { f.setException(this._err("BAD_ARGS", "name: one path component")); return f; }
		var dest = ((toFolder == null) ? this._parentOf(item) : this._prefixOf(toFolder)) +
			newName + (folder ? "/" : "");

		if (!folder) {
			this._after(this._stat(creds, item), f, function (s) {
				var src = s.file;
				if (!src) { throw this._err("S3_NOT_FOUND", "no object " + item); }
				if (dest === item) { f.result = { entry: this._fileEntry(src) }; return; }
				if (src.size > this.MAX_COPY_BYTES) {
					throw this._err("S3_TOO_LARGE_TO_COPY", "objects over 5 GB need a multipart copy", { size: src.size });
				}
				this._after(this._stat(creds, dest), f, function (d) {
					if (d.file) { throw this._err("S3_DESTINATION_EXISTS", dest + " already exists"); }
					this._after(this._copy(creds, item, dest), f, function (c) {
						var entry = this._fileEntry({ key: dest, size: src.size, modified: c.modified || src.modified });
						var del = this._deleteKey(creds, item);
						del.then(this, function () {
							try { del.result; } catch (e) {
								f.setException(this._err("S3_MOVE_INCOMPLETE", "copied to " + dest +
									" but the original could not be deleted", { entry: entry, cause: e }));
								return;
							}
							f.result = { entry: entry };
						});
					});
				});
			});
			return f;
		}

		if (dest === item) { f.result = { entry: this._folderEntry(item) }; return f; }
		if (dest.indexOf(item) === 0) {
			f.setException(this._err("S3_MOVE_INTO_SELF", "a folder cannot move into itself")); return f;
		}
		this._after(this._listTree(creds, item, this.MAX_MOVE_KEYS), f, function (t) {
			var files = t.files;
			if (!files.length) { throw this._err("S3_NOT_FOUND", "no objects under " + item); }
			files.forEach(function (o) {
				if (o.size > self.MAX_COPY_BYTES) {
					throw self._err("S3_TOO_LARGE_TO_COPY", o.key + " is over 5 GB and needs a multipart copy", { size: o.size });
				}
			});
			this._after(this._first(creds, dest), f, function (d) {
				if (d.file) { throw this._err("S3_DESTINATION_EXISTS", dest + " already has objects"); }
				var copied = [];
				function copyNext(i) {
					if (i >= files.length) { return deleteOriginals(); }
					var to = dest + files[i].key.substring(item.length);
					var c = self._copy(creds, files[i].key, to);
					c.then(self, function () {
						try { c.result; } catch (e) { return undo(e); }
						copied.push(to);
						// The next copy (or the deletes) in a try: c is not f, so a throw would stay on c.
						try { copyNext(i + 1); } catch (e2) { undo(e2); }
					});
				}
				function undo(cause) {
					var u = copied.length ? self._deleteKeys(creds, copied) : null;
					function fail(cleaned) {
						var e = self._err(cause.errorCode || "S3_COPY_FAILED", cause.detail,
							{ status: cause.status, s3Code: cause.s3Code, copied: copied.length,
								total: files.length, cleanedUp: cleaned });
						f.setException(e);
					}
					if (!u) { fail(true); return; }
					u.then(self, function () {
						var ok = false;
						try { ok = u.result.failed.length === 0; } catch (e) { ok = false; }
						try { fail(ok); } catch (e3) { f.setException(cause); }
					});
				}
				function deleteOriginals() {
					self._after(self._deleteKeys(creds, files.map(function (o) { return o.key; })), f, function (r) {
						if (r.failed.length) {
							throw this._err("S3_MOVE_INCOMPLETE", "copied to " + dest + " but " + r.failed.length +
								" original(s) could not be deleted", { entry: this._folderEntry(dest),
									notDeleted: r.failed.map(function (x) { return x.key; }) });
						}
						f.result = { entry: this._folderEntry(dest) };
					});
				}
				copyNext(0);
			});
		});
		return f;
	},

	// DeleteObject for a key; for a folder, every object under the prefix (marker included) via
	// DeleteObjects. S3 has no trash: this is permanent unless the bucket is versioned.
	deleteItem: function (creds, item, onRenew) {
		var f = new Future();
		if (this._isRoot(item)) { f.setException(this._err("BAD_ARGS", "the root folder cannot be deleted")); return f; }
		item = String(item);
		if (!this._isFolder(item)) {
			this._after(this._deleteKey(creds, item), f, function () { f.result = {}; });
			return f;
		}
		this._after(this._listTree(creds, item, this.MAX_DELETE_KEYS), f, function (t) {
			if (!t.files.length) { f.result = {}; return; }
			this._after(this._deleteKeys(creds, t.files.map(function (o) { return o.key; })), f, function (r) {
				if (r.failed.length) {
					throw this._err("S3_DELETE_FAILED", r.failed.length + " object(s) could not be deleted",
						{ notDeleted: r.failed.map(function (x) { return x.key; }), s3Code: r.failed[0].code });
				}
				f.result = {};
			});
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
