/* adapter.js - Infomaniak kDrive REST API for _cloudcore/node (commands.js there has the interface).
 *
 * kDrive is REST and addressed by numeric ids, per drive: /{version}/drive/{driveId}/files/{id}.
 * The versions differ per endpoint (https://developer.infomaniak.com/docs/api): listing, file
 * info, new folders, moves and uploads are v3; the drive list, the profile, download, rename and
 * delete are v2. Replies are an envelope, { result:"success", data, cursor?, has_more? }, or
 * { result:"error", error:{ code, description } } (with a 4xx/5xx status as a rule).
 *
 * The drive root (id 1, ROOT_FOLDER) is a container that cannot be written to; the user's files
 * live in the private space under it (visibility "is_private_space"), which is what this adapter
 * treats as the root: "", "root", "/" and 1 all mean the private space. The ids handed out are
 * strings (Documents and QuickOffice do string operations on them).
 *
 * The credentials (common) carry, next to the token, what was found from it: accountId, driveId
 * and rootFolderId. verifyToken / exchangeCode fill them in at account-add; credentials without
 * them (an inline token, an older account) find them on first use, and the session then reports
 * and saves them like a renewed token. A refresh (an OAuth account, on a 401) keeps them, as
 * creds.js's renewedFrom keeps every other field.
 *
 * Every failure rejects: a reply outside 2xx is KDRIVE_HTTP_ERROR with its status and body
 * (KDRIVE_DOWNLOAD_FAILED for a download, KDRIVE_DELETE_FAILED for deletePhoto, as before);
 * an error envelope on a 2xx is KDRIVE_API_ERROR.
 */
"use strict";

const fsp = require("node:fs/promises");

const ERROR = "KDRIVE_HTTP_ERROR";
const API_ERROR = "KDRIVE_API_ERROR";
const PAGE = 1000;   // the listing's largest page (limit 5..1000, default 10)
const IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp)$/i;

// The errorText of a kDrive error reply: its error code and description where it has them.
function describe(status, body) {
	let why = "";
	try {
		const e = (JSON.parse(body) || {}).error || {};
		why = [e.code, e.description].filter((x) => typeof x === "string" && x).join(": ");
	} catch (x) { why = String(body || "").replace(/\s+/g, " ").trim().slice(0, 200); }
	return "kDrive answered HTTP " + status + (why ? ": " + why : "");
}

// One kDrive file object -> the listFolder entry. last_modified_at is in Unix seconds; the
// consumers want an ISO string (QuickOffice's File.parseUtcDate splits it at "T").
function entry(e, type) {
	const isFolder = type ? (type === "folder") : (e.type === "dir");
	return { id: String(e.id), type: isFolder ? "folder" : "file", name: e.name, size: e.size,
		modified: (typeof e.last_modified_at === "number" && isFinite(e.last_modified_at))
			? new Date(e.last_modified_at * 1000).toISOString() : undefined,
		path: String(e.id), mimeType: e.mime_type };
}

// A listFolder entry that is an image: by its mime type or its name.
function isImage(e) {
	return !!(e && e.type === "file" &&
		((typeof e.mimeType === "string" && e.mimeType.indexOf("image/") === 0) || IMAGE_RE.test(e.name || "")));
}

function createAdapter({ config, http, errors }) {
	const { CloudError } = errors;
	const seg = (id) => encodeURIComponent(String(id));
	const url = (version, p) => config.API_HOST + "/" + version + p;
	const isRoot = (id) => id === undefined || id === null || id === "" || id === "root" || id === "/" ||
		String(id) === String(config.ROOT_FOLDER);

	// One JSON call with the session's token -> the whole envelope, once it says success. A move
	// or delete of a large folder may answer "asynchronous": accepted, it has been queued.
	async function call(s, method, version, p, opts) {
		const j = await s.authorized((token) => http.json(Object.assign({ method, url: url(version, p), bearer: token }, opts || {})));
		if (j && typeof j === "object" && j.result !== undefined && j.result !== "success" && j.result !== "asynchronous") {
			const e = (j.error && typeof j.error === "object") ? j.error : {};
			throw new CloudError(API_ERROR, "kDrive: " + ([e.code, e.description].filter(Boolean).join(": ") || String(j.result)));
		}
		return j || {};
	}
	const data = async (...a) => (await call(...a)).data;

	// Keep what was found from the token in the session's credentials, to be reported and saved.
	function remember(s, fields) {
		s.creds = Object.assign({}, s.creds, fields);
		s.renewed = s.creds;
	}

	// Every child of a folder (the listing is paged, cursor and has_more).
	async function children(s, driveId, folderId) {
		const base = "/drive/" + seg(driveId) + "/files/" + seg(folderId) + "/files?limit=" + PAGE;
		let j = await call(s, "GET", "3", base);
		const out = Array.isArray(j.data) ? j.data.slice() : [];
		while (j.has_more && j.cursor) {
			j = await call(s, "GET", "3", base + "&cursor=" + encodeURIComponent(j.cursor));
			if (Array.isArray(j.data)) { out.push(...j.data); }
		}
		return out;
	}

	const adapter = {
		// GET /2/profile -> account_id; GET /2/drive?account_id= -> the first drive; then the
		// private space under its root. -> { accountId, driveId, rootFolderId, email, displayName }
		async discoverAccount(s) {
			const p = (await data(s, "GET", "2", "/profile")) || {};
			const accountId = (p.preferences && p.preferences.account && p.preferences.account.current_account_id) || null;
			if (!accountId) { throw new CloudError("KDRIVE_NO_ACCOUNT", "the kDrive profile names no account"); }
			const drives = await data(s, "GET", "2", "/drive?account_id=" + encodeURIComponent(accountId));
			const drive = Array.isArray(drives) ? drives.find((d) => d && d.id !== undefined && d.id !== null) : null;
			if (!drive) { throw new CloudError("KDRIVE_NO_DRIVE", "account " + accountId + " has no kDrive"); }
			const rootFolderId = await adapter.findPrivateRoot(s, drive.id);
			return { accountId, driveId: drive.id, rootFolderId, email: p.email, displayName: p.display_name };
		},

		// The writable root: the private space among the drive root's children, else the first
		// folder there, else the drive root itself.
		async findPrivateRoot(s, driveId) {
			const kids = await children(s, driveId, config.ROOT_FOLDER);
			const priv = kids.find((k) => k && k.visibility === "is_private_space") || kids.find((k) => k && k.type === "dir");
			return priv ? priv.id : config.ROOT_FOLDER;
		},

		// The account's drive id, found from the token the first time.
		async drive(s) {
			if (s.creds.driveId) { return s.creds.driveId; }
			const a = await adapter.discoverAccount(s);
			remember(s, { accountId: a.accountId, driveId: a.driveId, rootFolderId: a.rootFolderId });
			return a.driveId;
		},

		// The private space's id.
		async root(s) {
			await adapter.drive(s);
			if (s.creds.rootFolderId) { return s.creds.rootFolderId; }
			const id = await adapter.findPrivateRoot(s, s.creds.driveId);
			remember(s, { rootFolderId: id });
			return id;
		},

		// A folder locator -> a folder id: the root ones are the private space.
		async folder(s, folderId) { return isRoot(folderId) ? adapter.root(s) : folderId; },

		async getAccountInfo(s) {
			const u = (await data(s, "GET", "2", "/profile")) || {};
			return { user: { emailAddress: u.email, displayName: u.display_name } };
		},

		// GET /3/drive/{d}/files/{id}/files, every page.
		async listFolder(s, folderId) {
			const d = await adapter.drive(s);
			const id = await adapter.folder(s, folderId);
			return { entries: (await children(s, d, id)).filter((e) => e && typeof e === "object").map((e) => entry(e)) };
		},

		// GET /2/drive/{d}/files/{id}/download: a 302 to a pre-signed host, which fetch follows
		// (without the Authorization header, as it does on any cross-origin redirect).
		async downloadFile(s, fileId, localDest) {
			const d = await adapter.drive(s);
			await s.authorized((token) => http.request({ method: "GET", url: url("2", "/drive/" + seg(d) + "/files/" + seg(fileId) + "/download"),
				bearer: token, toFile: localDest, errorCode: "KDRIVE_DOWNLOAD_FAILED" }));
			return { path: localDest };
		},

		// POST /3/drive/{d}/upload?directory_id&file_name&conflict=version&total_size, the file as
		// the body. total_size is required; conflict=version makes an upload over an existing name
		// a new version of that file (create or overwrite, as Dropbox's).
		async uploadTo(s, dir, localPath, name) {
			const d = await adapter.drive(s);
			let size;
			try { size = (await fsp.stat(localPath)).size; }
			catch (e) { throw new CloudError("LOCAL_FILE_ERROR", "cannot read " + localPath + ": " + ((e && e.code) || e)); }
			const q = "?directory_id=" + seg(dir) + "&file_name=" + encodeURIComponent(name) + "&conflict=version&total_size=" + size;
			const f = (await data(s, "POST", "3", "/drive/" + seg(d) + "/upload" + q,
				{ file: localPath, headers: { "Content-Type": "application/octet-stream" } })) || {};
			return Object.assign({}, f, { id: (f.id === undefined || f.id === null) ? undefined : String(f.id) });
		},

		async uploadFile(s, folderId, localPath, name) {
			await adapter.drive(s);
			return adapter.uploadTo(s, await adapter.folder(s, folderId), localPath, name);
		},

		// A save-back over the file fileId: its name and folder (GET /3/.../files/{id}), then the
		// same upload, which makes it a new version.
		async uploadReplace(s, fileId, localPath) {
			const meta = await adapter.info(s, fileId);
			if (meta.name === undefined || meta.name === null || meta.parent_id === undefined || meta.parent_id === null) {
				throw new CloudError("KDRIVE_NO_FILEINFO", "kDrive gave no name or folder for " + fileId);
			}
			return adapter.uploadTo(s, meta.parent_id, localPath, meta.name);
		},

		// GET /3/drive/{d}/files/{id} -> the file object.
		async info(s, fileId) {
			const d = await adapter.drive(s);
			const f = await data(s, "GET", "3", "/drive/" + seg(d) + "/files/" + seg(fileId));
			return (f && typeof f === "object") ? f : {};
		},

		// POST /3/drive/{d}/files/{parent}/directory { name }.
		async createFolder(s, parent, name) {
			const d = await adapter.drive(s);
			const dir = await adapter.folder(s, parent);
			const f = (await data(s, "POST", "3", "/drive/" + seg(d) + "/files/" + seg(dir) + "/directory", { json: { name } })) || {};
			return { entry: entry(f, "folder") };
		},

		// A move: POST /3/.../files/{id}/move/{to} { conflict:"error", name? }; a rename only:
		// POST /2/.../files/{id}/rename { name }. Both answer a cancel id, not the item, so the
		// entry comes from GET /3/.../files/{id} afterwards. The root is never moved.
		async moveItem(s, item, toFolder, name) {
			const d = await adapter.drive(s);
			await adapter.refuseRoot(s, item, "moved");
			const given = (v) => v !== null && v !== undefined;
			if (given(toFolder)) {
				const to = await adapter.folder(s, toFolder);
				const body = { conflict: "error" };
				if (given(name)) { body.name = name; }
				await call(s, "POST", "3", "/drive/" + seg(d) + "/files/" + seg(item) + "/move/" + seg(to), { json: body });
			} else {
				await call(s, "POST", "2", "/drive/" + seg(d) + "/files/" + seg(item) + "/rename", { json: { name } });
			}
			return { entry: entry(await adapter.info(s, item)) };
		},

		// DELETE /2/drive/{d}/files/{id}: into the trash, restorable from kDrive's web app.
		async deleteItem(s, item) {
			const d = await adapter.drive(s);
			await adapter.refuseRoot(s, item, "deleted");
			await call(s, "DELETE", "2", "/drive/" + seg(d) + "/files/" + seg(item));
			return {};
		},

		// The drive root and the private space are never moved or deleted.
		async refuseRoot(s, item, what) {
			if (isRoot(item) || String(item) === String(await adapter.root(s))) {
				throw new CloudError("BAD_ARGS", "the root folder cannot be " + what);
			}
		},

		// The Photos delete button: pid is the file id.
		async deletePhoto(s, fileId) {
			const d = await adapter.drive(s);
			await call(s, "DELETE", "2", "/drive/" + seg(d) + "/files/" + seg(fileId), { errorCode: "KDRIVE_DELETE_FAILED" });
			return { deleted: true };
		},

		// --- Photos (photos.js, and the generic upload) ---------------------------------------

		// The id (a string) of the folder called `name`, any case, directly under the private
		// space; null when there is none.
		async findAlbumFolder(s, name) {
			const r = await adapter.root(s);
			const want = String(name).toLowerCase();
			const hit = (await children(s, s.creds.driveId, r)).find((e) => e && e.type === "dir" && String(e.name).toLowerCase() === want);
			return hit ? String(hit.id) : null;
		},

		// The album folder, made under the private space when it is not there yet.
		async ensureAlbumFolder(s, name) {
			const hit = await adapter.findAlbumFolder(s, name);
			if (hit) { return hit; }
			const made = await adapter.createFolder(s, "root", name);
			return (made.entry && made.entry.id !== "undefined") ? made.entry.id : String(await adapter.root(s));
		},

		// A photo's bytes (download) or thumbnail, with the token in the query: the Photos service
		// fetches these with no Authorization header. The token goes stale with a short-lived
		// OAuth token (a personal API token does not expire).
		photoUrl(s, fileId, kind) {
			return config.API_HOST + "/2/drive/" + seg(s.creds.driveId) + "/files/" + seg(fileId) + "/" + kind +
				"?access_token=" + encodeURIComponent(s.creds.accessToken);
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, API_ERROR, PAGE, describe, entry, isImage, IMAGE_RE });
