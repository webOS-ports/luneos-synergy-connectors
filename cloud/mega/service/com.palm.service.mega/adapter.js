/*global IMPORTS, Config, HttpCurl, MegaCrypto, MegaApi, console */
/* adapter.js - Mega (mega.nz) provider ADAPTER for _cloudcore. Mega is ID-BASED (like Box):
 * a node is addressed by an opaque 8-char handle, so a locator handed to consumers IS a handle
 * (and the ROOT_FOLDER sentinel "root" maps to the account's Cloud Drive root handle). Unlike
 * every other connector, the payload is END-TO-END ENCRYPTED: filenames arrive in AES-CBC
 * attribute blocks and file bytes in AES-CTR, all under keys derived from the password (see
 * megacrypto.js / megaapi.js). Credentials are { accessToken: <session id>, mk: <b64 master
 * key>, email } - the session id doubles as _cloudcore's accessToken so AccountCreds/the generic
 * commands work unchanged.
 *
 * Exposes the uniform _cloudcore adapter interface (normalised shapes):
 *   listFolder(creds, folderId, cb) -> { entries:[{id,type,name,size,modified,path,mimeType}] }
 *   downloadFile(creds, fileId, localDest, exportMime, cb) -> { path }   (exportMime ignored)
 *   uploadFile(creds, folderId, localPath, name, mimeType, cb) -> { id, name, size }
 *   uploadReplace(creds, fileId, localPath, mimeType, cb)      -> { id, name, size }
 *   getAccountInfo(creds, cb) -> { user:{ displayName, emailAddress } }
 * plus the PHOTO.UPLOAD helpers (resolvePhotoAlbum/ensureAlbumFolder/deletePhoto and
 * getPhotoLocalPath, since Mega's download URL serves ciphertext - see commands/listPhotos).
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;
var MC = MegaCrypto;

var Adapter = {
	// Best-effort in-memory tree cache (the service is often idle-killed between calls, so this
	// only helps within a burst, e.g. listFolder -> downloadFile). TTL 20s, keyed by session id.
	_tree: null,

	_now: function () { return (new Date()).getTime(); },

	// Read `words` 32-bit words of randomness. MUST use /dev/urandom (non-blocking) via plain
	// byte access: on the device node 0.4.12 crypto.randomBytes BLOCKS on /dev/random entropy
	// (hanging upload), and Buffer.readUInt32BE doesn't exist. So read raw bytes and pack manually.
	_rand: function (words) {
		var out = [], i, j, n = words * 4, bytes = null;
		if (MC._fs) {
			try {
				var fd = MC._fs.openSync("/dev/urandom", "r"), buf = new Buffer(n);
				MC._fs.readSync(fd, buf, 0, n, null); MC._fs.closeSync(fd);
				bytes = buf;
			} catch (e) { bytes = null; }
		}
		if (!bytes && MC._nc && MC._nc.randomBytes) { try { bytes = MC._nc.randomBytes(n); } catch (e2) { bytes = null; } }
		if (!bytes) { throw { returnValue: false, errorCode: "NO_RANDOM" }; }
		for (i = 0; i < words; i++) {
			j = i * 4;
			out.push((((bytes[j] & 0xff) << 24) | ((bytes[j + 1] & 0xff) << 16) |
				((bytes[j + 2] & 0xff) << 8) | (bytes[j + 3] & 0xff)) >>> 0);
		}
		return out;
	},

	_invalidate: function () { this._tree = null; },

	// Resolve + cache the decrypted node tree.
	_fetchTree: function (creds, cb) {
		var self = this, f = new Future();
		if (this._tree && this._tree.sid === creds.accessToken &&
			(this._now() - this._tree.at) < 20000) {
			f.result = this._tree.tree; return f;
		}
		var tf = MegaApi.fetchNodes(creds);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var t;
			try { t = tf.result; } catch (e) { f.setException(e); return; }
			self._tree = { sid: creds.accessToken, at: self._now(), tree: t };
			f.result = t;
		});
		return f;
	},

	_folderHandle: function (tree, folderId) {
		if (!folderId || folderId === "root" || folderId === Config.ROOT_FOLDER) { return tree.rootHandle; }
		return folderId;
	},

	// Guess a coarse mime for an entry name (photolib keys off the name regex, so this is a bonus).
	_mime: function (name, isFolder) {
		if (isFolder) { return "application/vnd.mega.folder"; }
		var m = /\.([a-z0-9]+)$/i.exec(name || "");
		var ext = m ? m[1].toLowerCase() : "";
		var map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
			bmp: "image/bmp", heic: "image/heic", webp: "image/webp", pdf: "application/pdf" };
		return map[ext] || null;
	},

	// GET user (validates the session, ESID if expired). Returns normalised identity.
	getAccountInfo: function (creds, cb) {
		var self = this, f = new Future();
		var uf = MegaApi.getUser(creds);
		uf.then(this, function () {
			var u;
			try { u = uf.result || {}; } catch (e) { f.setException(e); return; }
			f.result = { user: {
				emailAddress: u.email || creds.email,
				displayName:  u.name || u.email || creds.email
			} };
		});
		return f;
	},

	// List a folder's direct children.
	listFolder: function (creds, folderId, cb) {
		var self = this, f = new Future();
		var tf = this._fetchTree(creds, cb);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var tree;
			try { tree = tf.result; } catch (e) { f.setException(e); return; }
			var parent = self._folderHandle(tree, folderId);
			var entries = [];
			for (var i = 0; i < tree.nodes.length; i++) {
				var n = tree.nodes[i];
				if (n.p !== parent) { continue; }
				if (n.t !== 0 && n.t !== 1) { continue; }   // files + folders only
				var isFolder = (n.t === 1);
				entries.push({
					id: n.h, type: (isFolder ? "folder" : "file"),
					name: n.name || n.h, size: n.size || 0,
					modified: n.ts ? (n.ts * 1000) : 0, path: n.h,
					mimeType: self._mime(n.name, isFolder)
				});
			}
			f.result = { entries: entries };
		});
		return f;
	},

	// Two-step download: resolve the node key from the tree, `g` for a temp URL, curl the
	// ciphertext to a temp file, AES-CTR-decrypt to localDest.
	downloadFile: function (creds, fileId, localDest, exportMime, cb) {
		var self = this, f = new Future();
		var tf = this._fetchTree(creds, cb);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var tree;
			try { tree = tf.result; } catch (e) { f.setException(e); return; }
			var node = tree.byHandle[fileId];
			if (!node || node.t !== 0 || !node.aesKeyA32) {
				f.setException({ returnValue: false, errorCode: "MEGA_NODE_NOT_FOUND", detail: fileId });
				return;
			}
			var gf = MegaApi.cmd({ a: "g", g: 1, ssl: 2, n: fileId }, creds.accessToken);
			gf.then(self, function () {
				var g;
				try { g = gf.result; } catch (e2) { f.setException(e2); return; }
				if (!g || !g.g) {
					f.setException({ returnValue: false, errorCode: "MEGA_NO_DOWNLOAD_URL", detail: g });
					return;
				}
				var cipherPath = localDest + ".mzenc";
				var dl = HttpCurl.request({ method: "GET", url: g.g, follow: true, outFile: cipherPath });
				dl.then(self, function () {
					try {
						var r = dl.result;
						if (!r || r.status < 200 || r.status >= 300) {
							throw { returnValue: false, errorCode: "MEGA_DOWNLOAD_FAILED",
								status: r && r.status };
						}
					} catch (e3) { f.setException(e3); return; }
					MC.ctrFile(cipherPath, localDest, MC.a32ToBytes(node.aesKeyA32), node.nonce, function (err) {
						try { if (MC._fs) { MC._fs.unlinkSync(cipherPath); } } catch (eu) {}
						if (err) { f.setException(err); return; }
						f.result = { path: localDest };
					});
				});
			});
		});
		return f;
	},

	// Encrypt + upload a NEW file into folderId. Generates a fresh file key, CTR-encrypts to a
	// temp file, computes the meta_mac, POSTs the ciphertext to the upload URL, then `p` to
	// attach the node (with master-key-wrapped key + encrypted name) under the parent.
	uploadFile: function (creds, folderId, localPath, name, mimeType, cb) {
		var self = this, f = new Future();
		if (!MC._fs) { f.setException({ returnValue: false, errorCode: "NO_FS" }); return f; }
		var master = MC.b64ToA32(creds.mk);
		var size;
		try { size = MC._fs.statSync(localPath).size; }
		catch (e) { f.setException({ returnValue: false, errorCode: "MEGA_LOCAL_STAT_FAILED", detail: String(e) }); return f; }

		// Random 8-word file key -> aesKey + nonce (meta_mac filled in after encryption).
		var k8 = this._rand(8);
		var uk = MC.unpackFileKey(k8);
		var cipherPath = localPath + ".mzenc";

		// Resolve the target parent handle first (root sentinel -> real root).
		var tf = this._fetchTree(creds, cb);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var tree, parent;
			try { tree = tf.result; parent = self._folderHandle(tree, folderId); }
			catch (e0) { f.setException(e0); return; }

			MC.ctrFile(localPath, cipherPath, MC.a32ToBytes(uk.aesKeyA32), uk.nonce, function (encErr) {
				if (encErr) { f.setException(encErr); return; }
				MC.metaMacFile(localPath, uk.aesKeyA32, uk.nonce, function (macErr, metaMac) {
					if (macErr) { try { MC._fs.unlinkSync(cipherPath); } catch (e) {} f.setException(macErr); return; }
					// `u`: request an upload URL for `size` cipher bytes.
					var uf = MegaApi.cmd({ a: "u", s: size, ssl: 2 }, creds.accessToken);
					uf.then(self, function () {
						var uu;
						try { uu = uf.result; } catch (e1) { try { MC._fs.unlinkSync(cipherPath); } catch (e) {} f.setException(e1); return; }
						if (!uu || !uu.p) { try { MC._fs.unlinkSync(cipherPath); } catch (e) {}
							f.setException({ returnValue: false, errorCode: "MEGA_NO_UPLOAD_URL", detail: uu }); return; }
						// POST the whole ciphertext at offset 0 -> completion token (base64 string).
						var up = HttpCurl.request({ method: "POST", url: uu.p + "/0",
							follow: true, dataFile: cipherPath });
						up.then(self, function () {
							try { MC._fs.unlinkSync(cipherPath); } catch (e) {}
							var token;
							try {
								var r = up.result;
								if (!r || r.status < 200 || r.status >= 300) {
									throw { returnValue: false, errorCode: "MEGA_UPLOAD_FAILED", status: r && r.status };
								}
								token = (r.responseText || "").replace(/^\s+|\s+$/g, "");
								// The completion token may come back JSON-wrapped or bare.
								if (token.charAt(0) === "[" || token.charAt(0) === "\"") {
									try { var pj = JSON.parse(token); token = (pj && pj.length) ? pj[0] : pj; } catch (ej) {}
								}
							} catch (e2) { f.setException(e2); return; }
							// Repack the key with the computed meta_mac, wrap with the master key.
							var fullKey = MC.packFileKey(uk.aesKeyA32, uk.nonce, metaMac);
							var wrapped = MC.a32ToB64(MC.ecbEncryptA32(master, fullKey));
							var attr = MC.encryptAttr({ n: name }, uk.aesKeyA32);
							var pf = MegaApi.cmd({ a: "p", t: parent,
								n: [{ h: token, t: 0, a: attr, k: wrapped }] }, creds.accessToken);
							pf.then(self, function () {
								var pr;
								try { pr = pf.result; } catch (e3) { f.setException(e3); return; }
								self._invalidate();
								var newNode = (pr && pr.f && pr.f[0]) || (pr && pr[0]) || {};
								f.result = { id: newNode.h || token, name: name, size: size };
							});
						});
					});
				});
			});
		});
		return f;
	},

	// Mega has no in-place content overwrite; upload a new version with the same name into the
	// existing file's parent folder (QuickOffice save-back). Returns the new node.
	uploadReplace: function (creds, fileId, localPath, mimeType, cb) {
		var self = this, f = new Future();
		var tf = this._fetchTree(creds, cb);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var tree, node;
			try { tree = tf.result; node = tree.byHandle[fileId]; } catch (e) { f.setException(e); return; }
			if (!node) { f.setException({ returnValue: false, errorCode: "MEGA_NODE_NOT_FOUND", detail: fileId }); return; }
			var up = self.uploadFile(creds, node.p, localPath, node.name || "file", mimeType, cb);
			up.then(self, function () {
				try { f.result = up.result; } catch (e2) { f.setException(e2); }
			});
		});
		return f;
	},

	// --- PHOTO.UPLOAD helpers ------------------------------------------------------------
	// Find the "Camera Uploads" folder handle (surfaced as the one album); does NOT create it.
	resolvePhotoAlbum: function (creds, cb) {
		var self = this, f = new Future();
		var name = Config.PHOTO_ALBUM_NAME || "Camera Uploads";
		var tf = this._fetchTree(creds, cb);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var tree;
			try { tree = tf.result; } catch (e) { f.result = { path: "", name: name, exists: false }; return; }
			for (var i = 0; i < tree.nodes.length; i++) {
				var n = tree.nodes[i];
				if (n.t === 1 && n.p === tree.rootHandle && n.name === name) {
					f.result = { path: n.h, name: name, exists: true }; return;
				}
			}
			f.result = { path: "", name: name, exists: false };
		});
		return f;
	},

	// Enumerate BROWSABLE photo albums from the decrypted tree: the Cloud Drive ROOT (its direct
	// image children - many people keep photos at the top level, as this account does) followed by
	// every folder that directly holds at least one image. aid is the node HANDLE (the root album
	// uses the root handle, which listFolder/_folderHandle resolves back to the root's children).
	// This replaces the old "only Camera Uploads" view so real photos actually show up in Photos.
	photoAlbums: function (creds, cb) {
		var self = this, f = new Future();
		var tf = this._fetchTree(creds, cb);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var tree, counts = {}, i, n, mime;
			try { tree = tf.result; } catch (e) { f.setException(e); return; }
			for (i = 0; i < tree.nodes.length; i++) {
				n = tree.nodes[i];
				if (n.t !== 0) { continue; }               // files only
				mime = self._mime(n.name, false);
				if (mime && mime.indexOf("image/") === 0) { counts[n.p] = (counts[n.p] || 0) + 1; }
			}
			var albums = [];
			if (counts[tree.rootHandle]) {
				albums.push({ aid: tree.rootHandle, name: "Cloud Drive", images: counts[tree.rootHandle] });
			}
			for (i = 0; i < tree.nodes.length; i++) {
				n = tree.nodes[i];
				if (n.t === 1 && counts[n.h]) { albums.push({ aid: n.h, name: n.name || n.h, images: counts[n.h] }); }
			}
			f.result = { albums: albums };
		});
		return f;
	},

	// Create (or find) a folder by name under the Cloud Drive root; returns its handle.
	ensureAlbumFolder: function (creds, name, cb) {
		var self = this, f = new Future();
		var master = MC.b64ToA32(creds.mk);
		var tf = this._fetchTree(creds, cb);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var tree;
			try { tree = tf.result; } catch (e) { f.setException(e); return; }
			for (var i = 0; i < tree.nodes.length; i++) {
				var n = tree.nodes[i];
				if (n.t === 1 && n.p === tree.rootHandle && n.name === name) { f.result = n.h; return; }
			}
			var fkey = self._rand(4);
			var attr = MC.encryptAttr({ n: name }, fkey);
			var wrapped = MC.a32ToB64(MC.ecbEncryptA32(master, fkey));
			var pf = MegaApi.cmd({ a: "p", t: tree.rootHandle,
				n: [{ h: "xxxxxxxx", t: 1, a: attr, k: wrapped }] }, creds.accessToken);
			pf.then(self, function () {
				var pr;
				try { pr = pf.result; } catch (e2) { f.setException(e2); return; }
				self._invalidate();
				var nn = (pr && pr.f && pr.f[0]) || (pr && pr[0]) || {};
				f.result = nn.h;
			});
		});
		return f;
	},

	// Download + DECRYPT one image to a local temp file, returning its file:// path. Needed
	// because Mega's `g` URL serves ciphertext, so (unlike Dropbox/Yandex) we cannot hand the
	// Photos aggregator a raw URL - it would store an encrypted blob. See commands/listPhotos.
	getPhotoLocalPath: function (creds, fileId, fileName, cb) {
		var self = this, f = new Future();
		var dir = (Config.PHOTO_TMP_DIR || "/media/internal/.mega-photos");
		try { if (MC._fs && !MC._fs.existsSync(dir)) { MC._fs.mkdirSync(dir); } } catch (e) {}
		var dest = dir + "/" + fileId + "-" + (fileName || "photo.jpg").replace(/[^A-Za-z0-9._-]/g, "_");
		var df = this.downloadFile(creds, fileId, dest, null, cb);
		df.then(this, function () {
			try { df.result; } catch (e2) { f.setException(e2); return; }
			f.result = { link: "file://" + dest, path: dest };
		});
		return f;
	},

	// DELETE a node (Photos delete button / file manager). `d` returns 0 on success.
	deletePhoto: function (creds, fileId, cb) {
		var self = this, f = new Future();
		var dfc = MegaApi.cmd({ a: "d", n: fileId }, creds.accessToken);
		dfc.then(this, function () {
			try { dfc.result; } catch (e) { f.setException(e); return; }
			self._invalidate();
			f.result = { deleted: true };
		});
		return f;
	}
};

if (typeof exports !== "undefined") { exports.Adapter = Adapter; }
