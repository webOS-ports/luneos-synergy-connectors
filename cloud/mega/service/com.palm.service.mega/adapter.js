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
 *   createFolder(creds, parent, name, cb)               -> { entry }   (listFolder-shaped)
 *   moveItem(creds, item, toFolder|null, name|null, cb) -> { entry }
 *   deleteItem(creds, item, cb)                         -> {}          (to the Rubbish Bin)
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

	// One node as listFolder lists it (also the `entry` of createFolder/moveItem).
	_entry: function (n) {
		var isFolder = (n.t === 1);
		return {
			id: n.h, type: (isFolder ? "folder" : "file"),
			name: n.name || n.h, size: n.size || 0,
			modified: n.ts ? (n.ts * 1000) : 0, path: n.h,
			mimeType: this._mime(n.name, isFolder)
		};
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
				entries.push(self._entry(n));
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
		var master = MegaApi.masterKey(creds);
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

	// --- createFolder / moveItem / deleteItem (commands/fileOps_commands.js) ---------------
	// The cs commands megajs 1.3.10 sends (MutableFile.mkdir, setAttributes/rename, moveTo,
	// delete). The cached tree is checked first, so the obvious mistakes fail with Mega's own
	// error names before reaching the server (which would happily keep two nodes of one name).
	_fail: function (f, code, ctx) { f.setException(MegaApi.apiError(code, ctx)); return f; },

	// h and its ancestors, nearest first (stops at an unknown parent or a cycle).
	_chain: function (tree, h) {
		var out = [], seen = {};
		while (h && !seen[h]) { seen[h] = true; out.push(h); h = tree.byHandle[h] ? tree.byHandle[h].p : null; }
		return out;
	},

	// The top of h's chain: the Cloud Drive root, the Rubbish Bin, or something else (inbox,
	// a share from another user).
	_top: function (tree, h) { var c = this._chain(tree, h); return c[c.length - 1]; },

	// A file or folder (other than `except`) called `name` directly in `parent`.
	_sibling: function (tree, parent, name, except) {
		for (var i = 0; i < tree.nodes.length; i++) {
			var n = tree.nodes[i];
			if (n.p === parent && n.h !== except && (n.t === 0 || n.t === 1) && n.name === name) { return n; }
		}
		return null;
	},

	// Why new or moved nodes may not go into folder h, or null. Allowed: the Cloud Drive root and
	// the folders in it, but not under an outgoing share: megajs adds a `cr` share-key set there
	// so the sharees can decrypt the node, and this connector does not keep the share keys.
	_targetError: function (tree, h) {
		var t = tree.byHandle[h];
		if (!t) { return MegaApi.apiError(-9, h); }
		if (t.t !== 1 && t.t !== 2) { return MegaApi.apiError(-2, "not a folder: " + h); }
		var chain = this._chain(tree, h);
		if (chain[chain.length - 1] !== tree.rootHandle) { return MegaApi.apiError(-11, "outside the Cloud Drive: " + h); }
		for (var i = 0; i < chain.length; i++) {
			if (tree.shareHandles && tree.shareHandles[chain[i]]) {
				return { returnValue: false, errorCode: "MEGA_SHARE_UNSUPPORTED",
					errorText: "a folder shared with other users cannot be written to from here", detail: h };
			}
		}
		return null;
	},

	// Why the item may not be moved, renamed or deleted, or null: only own files and folders in
	// the Cloud Drive or the Rubbish Bin.
	_itemError: function (tree, item) {
		var node = tree.byHandle[item];
		if (!node) { return MegaApi.apiError(-9, item); }
		if (node.t !== 0 && node.t !== 1) { return MegaApi.apiError(-2, "not a file or folder: " + item); }
		var top = this._top(tree, item);
		if (top !== tree.rootHandle && top !== tree.rubbishHandle) { return MegaApi.apiError(-11, item); }
		return null;
	},

	// f nests the Future fn(tree, master) returns once the tree is there.
	_withTree: function (creds, cb, fn) {
		var self = this, f = new Future(), master;
		try { master = MegaApi.masterKey(creds); } catch (e) { f.setException(e); return f; }
		var tf = this._fetchTree(creds, cb);
		f.now(this, function () { return tf; });
		f.then(this, function () {
			var tree, inner;
			try { tree = tf.result; inner = fn.call(self, tree, master); }
			catch (e1) { f.setException(e1); return; }
			f.nest(inner);
		});
		return f;
	},

	// `p` with one new folder node: a fresh random 4-word key, the attributes {n} under it, the
	// key wrapped with the master key (AES-ECB). Mega replies { f:[<the new node>] }.
	createFolder: function (creds, parent, name, cb) {
		return this._withTree(creds, cb, function (tree, master) {
			var f = new Future(), self = this;
			var ph = this._folderHandle(tree, parent);
			var bad = this._targetError(tree, ph);
			if (bad) { f.setException(bad); return f; }
			if (this._sibling(tree, ph, name)) { return this._fail(f, -12, name); }
			var fkey = this._rand(4);   // /dev/urandom (see _rand)
			var pf = MegaApi.cmd({ a: "p", t: ph, n: [{ h: "xxxxxxxx", t: 1,
				a: MC.encryptAttr({ n: name }, fkey), k: MC.a32ToB64(MC.ecbEncryptA32(master, fkey)) }] },
				creds.accessToken);
			pf.then(this, function () {
				var pr;
				try { pr = pf.result; } catch (e) { f.setException(e); return; }
				var nn = pr && pr.f && pr.f[0];
				if (!nn || !nn.h) { f.setException({ returnValue: false, errorCode: "MEGA_BAD_REPLY", detail: pr }); return; }
				self._invalidate();
				f.result = { entry: self._entry({ h: nn.h, t: 1, name: name, size: 0, ts: nn.ts }) };
			});
			return f;
		});
	},

	// `m` to the new parent (megajs moveTo) and/or `a` with the attributes re-encrypted under the
	// node's own key, every other attribute kept (megajs setAttributes, which rename uses). The
	// move goes first: it is the step the server may still refuse; the rename was checked here.
	moveItem: function (creds, item, toFolder, name, cb) {
		return this._withTree(creds, cb, function (tree) {
			var f = new Future(), self = this, i;
			var bad = this._itemError(tree, item);
			if (bad) { f.setException(bad); return f; }
			var node = tree.byHandle[item];
			var to = toFolder ? this._folderHandle(tree, toFolder) : null;
			if (to === node.p) { to = null; }
			if (to) {
				bad = this._targetError(tree, to);
				if (bad) { f.setException(bad); return f; }
				var chain = this._chain(tree, to);
				for (i = 0; i < chain.length; i++) { if (chain[i] === item) { return this._fail(f, -10, to); } }
			}
			if (name === undefined || name === node.name) { name = null; }
			var newName = (name !== null) ? name : node.name;
			if ((to || name !== null) && this._sibling(tree, to || node.p, newName, item)) { return this._fail(f, -12, newName); }
			var at = null;
			if (name !== null) {
				if (!node.attrs || !node.aesKeyA32) { return this._fail(f, -14, item); }
				var attrs = {}, k;
				for (k in node.attrs) { if (node.attrs.hasOwnProperty(k)) { attrs[k] = node.attrs[k]; } }
				attrs.n = name;
				at = MC.encryptAttr(attrs, node.aesKeyA32);
			}
			var done = function () {
				self._invalidate();
				f.result = { entry: self._entry({ h: node.h, t: node.t, name: newName, size: node.size, ts: node.ts }) };
			};
			var rename = function () {
				if (!at) { done(); return; }
				var af = MegaApi.cmd({ a: "a", n: item, at: at }, creds.accessToken);
				af.then(self, function () {
					try { af.result; }
					catch (e) { if (to) { e.moved = true; self._invalidate(); } f.setException(e); return; }
					done();
				});
			};
			if (!to) { rename(); return f; }
			var mf = MegaApi.cmd({ a: "m", n: item, t: to }, creds.accessToken);
			mf.then(this, function () {
				try { mf.result; } catch (e) { f.setException(e); return; }
				rename();
			});
			return f;
		});
	},

	// To the Rubbish Bin (`m` to the t===4 root), from where any MEGA client can restore it; only
	// what is already in the Rubbish Bin is removed for good (`d`). That is megajs's delete()
	// default (permanent when the parent is the trash), here for anything below the trash.
	deleteItem: function (creds, item, cb) {
		return this._withTree(creds, cb, function (tree) {
			var f = new Future(), self = this;
			var bad = this._itemError(tree, item);
			if (bad) { f.setException(bad); return f; }
			var inRubbish = (this._top(tree, item) === tree.rubbishHandle);
			if (!inRubbish && !tree.rubbishHandle) {
				f.setException({ returnValue: false, errorCode: "MEGA_NO_RUBBISH_BIN", detail: item }); return f;
			}
			var df = MegaApi.cmd(inRubbish ? { a: "d", n: item } : { a: "m", n: item, t: tree.rubbishHandle },
				creds.accessToken);
			df.then(this, function () {
				try { df.result; } catch (e) { f.setException(e); return; }
				self._invalidate();
				f.result = {};
			});
			return f;
		});
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
		var master = MegaApi.masterKey(creds);
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
