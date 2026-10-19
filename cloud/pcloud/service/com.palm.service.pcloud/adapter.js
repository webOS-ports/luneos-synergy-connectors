/* adapter.js - pCloud REST for _cloudcore/node (commands.js there has the interface).
 *
 * pCloud is numeric-ID addressed (folder = folderid, root = 0; file = fileid), with two quirks:
 *   1. REGION HOST. Every call goes to the account's data-region host (api.pcloud.com US /
 *      eapi.pcloud.com EU), carried in creds.apiHost (the US one when it is missing). The token
 *      is sent as an access_token QUERY parameter, not a Bearer header; http.js never puts a
 *      query into an error.
 *   2. RESULT ENVELOPE. pCloud answers HTTP 200 to logical errors too, flagged by a nonzero
 *      top-level `result` (0 = success): that is PCLOUD_API_ERROR, with the result number in
 *      the errorText (and on the error, as `result`). A reply outside 2xx is PCLOUD_HTTP_ERROR.
 * There is no refresh (pCloud tokens are long-lived, with no refresh flow), so a session never
 * renews anything.
 *
 *   listFolder(s, folderId)  -> { entries:[{ id, type, name, size, modified, path, mimeType }] }
 *   downloadFile / uploadFile / uploadReplace / getAccountInfo / createFolder / moveItem /
 *   deleteItem / deletePhoto as commands.js has them, plus listFolderRaw() and getFileLink() for
 *   photos.js, which works on the RAW listfolder entries (isfolder/fileid/contenttype).
 *
 * File manager locators are listFolder's: a bare numeric folderid or fileid. pCloud numbers
 * folders and files separately, so a bare number does not say which it is; pCloud's own typed
 * ids ("d123" folder, "f456" file, metadata.id) are accepted too. A bare number is looked up as
 * both (checksumfile?fileid / listfolder?folderid&nofiles) and refused when it names both
 * (PCLOUD_AMBIGUOUS_ID) or neither (PCLOUD_NOT_FOUND), so a file's id can never delete or move a
 * folder, or the other way round.
 */
"use strict";

const ERROR = "PCLOUD_HTTP_ERROR";
const API_ERROR = "PCLOUD_API_ERROR";

const isRootName = (x) => x === undefined || x === null || x === "" || x === "root" || x === "/";

// One listFolder entry from a pCloud metadata object.
function entry(e) {
	const id = e.isfolder ? e.folderid : e.fileid;
	return { id, type: e.isfolder ? "folder" : "file", name: e.name, size: e.size, modified: e.modified,
		path: id, mimeType: e.contenttype };
}

// "123" / 123 -> { id:"123", kind:null }; "d123" -> folder; "f456" -> file; the root names
// ("root", "", "/") -> d<root>; anything else null.
function loc(x, root = 0) {
	if (x === "root" || x === "" || x === "/") { x = "d" + root; }
	const m = /^([df]?)(\d+)$/.exec(String(x === undefined || x === null ? "" : x));
	if (!m) { return null; }
	return { id: m[2], kind: (m[1] === "d") ? "folder" : (m[1] === "f") ? "file" : null };
}

function describe(status, body) {
	const b = String(body || "").replace(/\s+/g, " ").trim().slice(0, 200);
	return "pCloud answered HTTP " + status + (b ? ": " + b : "");
}

function createAdapter({ config, http, errors }) {
	const { CloudError } = errors;
	const ROOT = config.ROOT_FOLDER;
	const host = (creds) => (creds && creds.apiHost) || config.DEFAULT_API_HOST;
	const folderParam = (x) => (isRootName(x) ? ROOT : x);
	const err = (code, text, extra) => new CloudError(code, text, extra);

	// A method URL on the account's region host, the token and params as the query.
	function url(token, creds, method, params) {
		const qs = ["access_token=" + encodeURIComponent(token)];
		for (const [k, v] of Object.entries(params || {})) {
			if (v !== undefined && v !== null) { qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); }
		}
		return "https://" + host(creds) + "/" + method + "?" + qs.join("&");
	}

	// The reply's JSON, its `result` checked.
	function check(j, method) {
		j = (j && typeof j === "object") ? j : {};
		if (j.result && j.result !== 0) {
			throw err(API_ERROR, "pCloud " + method + ": error " + j.result + (j.error ? ": " + String(j.error).slice(0, 200) : ""),
				{ result: j.result, error: j.error });
		}
		return j;
	}

	// GET a method with the session's token.
	const get = (s, method, params) => s.authorized(async (token, creds) =>
		check(await http.json({ method: "GET", url: url(token, creds, method, params) }), method));

	// get, but null for the one result code that means "does not exist".
	async function getOrNull(s, method, params, missing) {
		try { return await get(s, method, params); }
		catch (e) { if (e && e.errorCode === API_ERROR && e.result === missing) { return null; } throw e; }
	}

	// What a locator names -> { kind:"file"|"folder", meta } (pCloud metadata).
	async function resolve(s, l) {
		const fr = (l.kind === "folder") ? null : await getOrNull(s, "checksumfile", { fileid: l.id }, 2009);   // 2009 File not found
		const dr = (l.kind === "file") ? null : await getOrNull(s, "listfolder", { folderid: l.id, nofiles: 1 }, 2005);   // 2005 Directory does not exist
		const file = fr && fr.metadata, folder = dr && dr.metadata;
		if (file && folder) {
			throw err("PCLOUD_AMBIGUOUS_ID", "id " + l.id + " is both a file and a folder; use f" + l.id + " or d" + l.id);
		}
		if (file) { return { kind: "file", meta: file }; }
		if (folder) { return { kind: "folder", meta: folder }; }
		throw err("PCLOUD_NOT_FOUND", "no file or folder " + l.id);
	}

	const adapter = {
		// GET /userinfo -> { user:{ emailAddress, displayName } } (pCloud has no display name,
		// so the email is both).
		async getAccountInfo(s) {
			const u = (await get(s, "userinfo", null)) || {};
			return { user: { emailAddress: u.email, displayName: u.email } };
		},

		// RAW /listfolder?folderid={id} -> { metadata:{ contents:[ item ] } }; the root names -> 0.
		listFolderRaw(s, folderId) { return get(s, "listfolder", { folderid: folderParam(folderId) }); },

		async listFolder(s, folderId) {
			const data = (await adapter.listFolderRaw(s, folderId)) || {};
			const contents = (data.metadata && Array.isArray(data.metadata.contents)) ? data.metadata.contents : [];
			return { entries: contents.map(entry) };
		},

		// GET /getfilelink?fileid={id} -> { url }: https://<hosts[0]><path>, which needs no token
		// (its path carries an auth hash) and is short-lived.
		async getFileLink(s, fileId) {
			const d = (await get(s, "getfilelink", { fileid: fileId })) || {};
			if (!Array.isArray(d.hosts) || !d.hosts.length || !d.path) {
				throw err("PCLOUD_NO_LINK", "pCloud getfilelink gave no link for " + fileId);
			}
			return { url: "https://" + d.hosts[0] + d.path };
		},

		// The file link, then its bytes to localDest. exportMime is not pCloud's.
		async downloadFile(s, fileId, localDest) {
			const { url: link } = await adapter.getFileLink(s, fileId);
			await http.request({ method: "GET", url: link, toFile: localDest, errorCode: "PCLOUD_DOWNLOAD_FAILED" });
			return { path: localDest };
		},

		// POST /uploadfile?folderid={id}&filename={name}&nopartial=1, the bytes as the multipart
		// part "file", named as the file is to be: pCloud names an upload after the part, not the
		// filename parameter. A same-named file in the folder is overwritten (the old one kept as
		// a revision). -> { id (the fileid), name, size } of the stored file.
		async uploadFile(s, folderId, localPath, name) {
			const d = await s.authorized(async (token, creds) => check(await http.json({ method: "POST",
				url: url(token, creds, "uploadfile", { folderid: folderParam(folderId), filename: name, nopartial: 1 }),
				multipart: [{ name: "file", file: localPath, filename: name }] }), "uploadfile"));
			const m = (Array.isArray(d.metadata) ? d.metadata[0] : d.metadata) || {};
			const ids = Array.isArray(d.fileids) ? d.fileids : [];
			return { id: (m.fileid !== undefined && m.fileid !== null) ? m.fileid : ids[0], name: m.name || name, size: m.size };
		},

		// GET /checksumfile?fileid={id} -> { metadata:{ name, parentfolderid } }.
		getFileInfo(s, fileId) { return get(s, "checksumfile", { fileid: fileId }); },

		// Overwrite a file by id (a save-back): pCloud has no upload by fileid, so the file's name
		// and folder are looked up and the bytes uploaded there under that name.
		async uploadReplace(s, fileId, localPath, mimeType) {
			const meta = ((await adapter.getFileInfo(s, fileId)) || {}).metadata || {};
			if (meta.name === undefined || meta.name === null || meta.parentfolderid === undefined || meta.parentfolderid === null) {
				throw err("PCLOUD_NO_FILEINFO", "pCloud checksumfile gave no name or folder for " + fileId);
			}
			return adapter.uploadFile(s, meta.parentfolderid, localPath, meta.name, mimeType);
		},

		// GET /deletefile?fileid=<id>: the Photos delete button; pid is the numeric fileid.
		async deletePhoto(s, fileId) {
			const d = await get(s, "deletefile", { fileid: fileId });
			if (!d || d.result !== 0) { throw err("PCLOUD_DELETE_FAILED", "pCloud deletefile did not say result 0 for " + fileId); }
			return { deleted: true };
		},

		// GET /createfolder?folderid=<parent>&name=<name> -> { metadata } (2004 if it exists).
		async createFolder(s, parent, name) {
			const p = loc(parent, ROOT);
			if (!p || p.kind === "file") { throw errors.badArgs("parent must be a folder id"); }
			const d = await get(s, "createfolder", { folderid: p.id, name });
			return { entry: entry(d.metadata || {}) };
		},

		// GET /renamefolder or /renamefile ?<id>&tofolderid=&toname= (either or both). renamefolder
		// fails with 2004 on an existing name; renamefile instead REPLACES an existing file of that
		// name (docs.pcloud.com/methods/file/renamefile.html), so for a file the destination folder
		// is listed first and an existing name refused (PCLOUD_EXISTS) - a file manager's move must
		// not overwrite. A change of case only of the item itself is let through.
		async moveItem(s, item, toFolder, name) {
			const it = loc(item, ROOT);
			if (!it) { throw errors.badArgs("item must be a file or folder id"); }
			let to = null;
			if (toFolder !== null && toFolder !== undefined) {
				to = loc(toFolder, ROOT);
				if (!to || to.kind === "file") { throw errors.badArgs("toFolder must be a folder id"); }
			}
			const params = { tofolderid: to ? to.id : null, toname: (name === null || name === undefined) ? null : name };
			const r = await resolve(s, it);
			if (r.kind === "folder") {
				if (String(r.meta.folderid) === String(ROOT)) { throw errors.badArgs("the root folder cannot be moved"); }
				params.folderid = it.id;
				const d = await get(s, "renamefolder", params);
				return { entry: entry(d.metadata || {}) };
			}
			const destId = to ? to.id : r.meta.parentfolderid;
			const newName = (name === null || name === undefined) ? r.meta.name : name;
			const l = await get(s, "listfolder", { folderid: destId });
			const contents = (l.metadata && Array.isArray(l.metadata.contents)) ? l.metadata.contents : [];
			const lower = String(newName).toLowerCase();
			for (const c of contents) {
				const itself = !c.isfolder && String(c.fileid) === String(it.id);
				if (!itself && String(c.name).toLowerCase() === lower) {
					throw err("PCLOUD_EXISTS", "an item named " + newName + " already exists there");
				}
			}
			params.fileid = it.id;
			const d = await get(s, "renamefile", params);
			return { entry: entry(d.metadata || {}) };
		},

		// GET /deletefile?fileid= or /deletefolderrecursive?folderid= - both land in pCloud's Trash.
		async deleteItem(s, item) {
			const it = loc(item, ROOT);
			if (!it) { throw errors.badArgs("item must be a file or folder id"); }
			if (it.kind !== "file" && it.id === String(ROOT)) { throw errors.badArgs("the root folder cannot be deleted"); }
			const r = await resolve(s, it);
			if (r.kind === "folder") { await get(s, "deletefolderrecursive", { folderid: it.id }); }
			else { await get(s, "deletefile", { fileid: it.id }); }
			return {};
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, API_ERROR, describe, entry, loc });
