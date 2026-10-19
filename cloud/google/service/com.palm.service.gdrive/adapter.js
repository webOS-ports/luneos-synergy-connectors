/* adapter.js - Google Drive API v3 for _cloudcore/node (commands.js there has the interface).
 *
 * Drive is a query store, not a folder tree:
 *   - a folder's children are found by query (files?q='{parentId}' in parents), a folder is
 *     mimeType application/vnd.google-apps.folder, and the root's alias id is "root";
 *   - Google-native documents (application/vnd.google-apps.*) have no bytes: they are exported
 *     (GET /files/{id}/export?mimeType=..., the caller's exportMime); every other file is
 *     GET /files/{id}?alt=media. Listed entries carry mimeType and a googleDoc flag for that;
 *   - a simple media upload cannot set the name or the parent, so uploadFile is two requests:
 *     POST the bytes, then PATCH the name and the parent.
 * Items are addressed by id, which listFolder hands out as each entry's id and path.
 *
 * Every call runs through the session (s.authorized), which refreshes the token once on a 401
 * and retries; Google leaves the refresh token out of a refresh, so the old one is kept
 * (creds.js renewedFrom). Every failure rejects: a reply outside 2xx is GDRIVE_API_ERROR with
 * its status and body (errorText names Google's reason, e.g. insufficientFilePermissions).
 */
"use strict";

const ERROR = "GDRIVE_API_ERROR";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC = "application/vnd.google-apps.";
// The metadata every entry needs; listFolder asks for files(FIELDS), the file ops for FIELDS.
const FIELDS = "id,name,mimeType,size,modifiedTime";

// One Drive file resource -> the listFolder entry. size is Drive's (an int64 as a string).
function entry(e) {
	const isFolder = e.mimeType === FOLDER_MIME;
	const isGoogleDoc = !isFolder && typeof e.mimeType === "string" && e.mimeType.indexOf(GOOGLE_DOC) === 0;
	return { id: e.id, type: isFolder ? "folder" : "file", name: e.name, size: e.size,
		modified: e.modifiedTime, path: e.id, mimeType: e.mimeType, googleDoc: isGoogleDoc };
}

// A string literal in a Drive query: ' and \ escaped with a backslash.
function quote(s) { return "'" + String(s).replace(/[\\']/g, "\\$&") + "'"; }

// The errorText of a Drive error reply: { error:{ code, message, errors:[{ reason }] } }.
function describe(status, body) {
	let why = "";
	try {
		const e = (JSON.parse(body) || {}).error || {};
		const reason = (Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason) || e.status || "";
		const msg = typeof e.message === "string" ? e.message : "";
		why = [reason, msg && "(" + msg + ")"].filter(Boolean).join(" ");
	} catch (x) {
		why = String(body || "");
	}
	why = why.replace(/\s+/g, " ").trim().slice(0, 200);
	return "Google Drive answered HTTP " + status + (why ? ": " + why : "");
}

function createAdapter({ config, http, errors }) {
	const ROOT = config.ROOT_FOLDER || "root";
	const fileUrl = (id) => config.API_BASE + "/files/" + encodeURIComponent(id);

	const get = (s, url) => s.authorized((token) => http.json({ method: "GET", url, bearer: token }));
	const send = (s, method, url, body) => s.authorized((token) => http.json({ method, url, bearer: token, json: body }));
	// The file's bytes as the body, streamed from disk (sent again in full on a retry).
	const media = (s, method, url, localPath, mimeType) => s.authorized((token) => http.json({ method, url, bearer: token,
		file: localPath, headers: { "Content-Type": mimeType || "application/octet-stream" } }));

	const adapter = {
		// GET /about?fields=user -> { user:{ emailAddress, displayName } }
		async getAccountInfo(s) {
			const u = ((await get(s, config.API_BASE + "/about?fields=user")) || {}).user || {};
			return { user: { emailAddress: u.emailAddress, displayName: u.displayName } };
		},

		// The children of a folder, not trashed, folders first, every page (nextPageToken).
		async listFolder(s, folderId) {
			const q = quote(folderId || ROOT) + " in parents and trashed = false";
			const base = config.API_BASE + "/files?q=" + encodeURIComponent(q) +
				"&fields=" + encodeURIComponent("files(" + FIELDS + "),nextPageToken") +
				"&pageSize=1000&orderBy=folder,name";
			const files = [];
			let token = null;
			do {
				const page = (await get(s, base + (token ? "&pageToken=" + encodeURIComponent(token) : ""))) || {};
				files.push(...(page.files || []));
				token = page.nextPageToken || null;
			} while (token);
			return { entries: files.map(entry) };
		},

		// exportMime set: export a Google-native document as that type; else the raw bytes.
		async downloadFile(s, fileId, localDest, exportMime) {
			const url = exportMime
				? fileUrl(fileId) + "/export?mimeType=" + encodeURIComponent(exportMime)
				: fileUrl(fileId) + "?alt=media";
			await s.authorized((token) => http.request({ method: "GET", url, bearer: token, toFile: localDest }));
			return { path: localDest };
		},

		// (1) POST the bytes (an "Untitled" file in My Drive), then (2) PATCH the name and, for a
		// folder other than the root, move it there. -> the final { id, name, size }.
		async uploadFile(s, folderId, localPath, name, mimeType) {
			const created = (await media(s, "POST", config.UPLOAD_BASE + "/files?uploadType=media&fields=id", localPath, mimeType)) || {};
			if (!created.id) { throw new errors.CloudError(ERROR, "the upload gave no file id"); }
			const parent = folderId || ROOT;
			let url = fileUrl(created.id) + "?fields=id,name,size";
			if (parent !== ROOT) { url += "&addParents=" + encodeURIComponent(parent) + "&removeParents=" + encodeURIComponent(ROOT); }
			return send(s, "PATCH", url, { name });
		},

		// New content for an existing file, in place (a save-back). -> { id, name, size }
		uploadReplace(s, fileId, localPath, mimeType) {
			return media(s, "PATCH", config.UPLOAD_BASE + "/files/" + encodeURIComponent(fileId) +
				"?uploadType=media&fields=id,name,size", localPath, mimeType);
		},

		// files.create with the folder mimeType; parent is a listFolder locator (an id or "root").
		async createFolder(s, parent, name) {
			const r = await send(s, "POST", config.API_BASE + "/files?fields=" + encodeURIComponent(FIELDS),
				{ name, mimeType: FOLDER_MIME, parents: [parent || ROOT] });
			return { entry: entry(r || {}) };
		},

		// Rename and/or move: files.update. A move reads the current parents first (to remove
		// them) and, for the "root" alias, the root's real id, since files.get reports parents by
		// real id and the same folder must not be added and removed at once.
		async moveItem(s, item, toFolder, name) {
			const body = (name === null || name === undefined) ? {} : { name };
			let query = "";
			if (toFolder) {
				const parents = ((await get(s, fileUrl(item) + "?fields=parents")) || {}).parents || [];
				const target = toFolder === ROOT ? ((await get(s, fileUrl(ROOT) + "?fields=id")) || {}).id : toFolder;
				if (!target) { throw new errors.CloudError(ERROR, "Drive gave no id for the root folder"); }
				const others = parents.filter((p) => p !== target);
				if (parents.indexOf(target) < 0) { query += "addParents=" + encodeURIComponent(target) + "&"; }
				if (others.length) { query += "removeParents=" + encodeURIComponent(others.join(",")) + "&"; }
			}
			const r = await send(s, "PATCH", fileUrl(item) + "?" + query + "fields=" + encodeURIComponent(FIELDS), body);
			return { entry: entry(r || {}) };
		},

		// To the Drive trash (files.update trashed:true), not files.delete, so it can be restored.
		// Only the owner can trash a file; anyone else gets 403 insufficientFilePermissions.
		async deleteItem(s, item) {
			await send(s, "PATCH", fileUrl(item) + "?fields=id", { trashed: true });
			return {};
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, FIELDS, FOLDER_MIME, describe, entry, quote });
