/* adapter.js - Dropbox API v2 for _cloudcore/node (commands.js there has the interface).
 *
 * Dropbox is RPC style and path based. Metadata calls POST JSON to API_BASE; file bytes go to
 * CONTENT_BASE with the arguments in a Dropbox-API-Arg header and the bytes as the body. Items
 * are addressed by path_lower (or an "id:..." selector), which listFolder hands out as each
 * entry's path; the root is "" ("root" and "/" mean it too).
 *
 * Every call runs through the session (s.authorized), which refreshes the token once on a 401
 * and retries. Every failure rejects: a reply outside 2xx is DROPBOX_API_ERROR with its status
 * and body (a 409 carries Dropbox's error_summary, e.g. path/conflict/folder/..).
 */
"use strict";

const ERROR = "DROPBOX_API_ERROR";

function normPath(p) { return (!p || p === "root" || p === "/") ? "" : p; }

// folder + "/" + name, the root ("", "/", "root") giving "/name".
function join(folder, name) {
	const base = normPath(folder);
	return (base.endsWith("/") ? base : base + "/") + String(name).replace(/^\/+/, "");
}

// The folder a path lives in ("" for an item in the root).
function parentOf(p) { return p.substring(0, p.lastIndexOf("/")); }

// One Dropbox Metadata object -> the listFolder entry. `type` overrides ".tag" for results
// declared as FolderMetadata (create_folder_v2), which Dropbox sends without a ".tag".
function entry(e, type) {
	const isFolder = type ? (type === "folder") : (e[".tag"] === "folder");
	return { id: e.id || e.path_lower, type: isFolder ? "folder" : "file",
		name: e.name, size: e.size, modified: e.server_modified, path: e.path_lower };
}

// The Dropbox-API-Arg header is JSON in ASCII: anything else is sent \u-escaped, as Dropbox asks
// (an HTTP header cannot carry "Café.pdf" as it is).
function apiArg(obj) {
	return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// The errorText of a Dropbox error reply: its error_summary where it has one.
function describe(status, body) {
	let summary = "";
	try { const j = JSON.parse(body); summary = (j && typeof j.error_summary === "string") ? j.error_summary : ""; }
	catch (e) { summary = String(body || "").replace(/\s+/g, " ").trim().slice(0, 200); }
	return "Dropbox answered HTTP " + status + (summary ? ": " + summary : "");
}

function createAdapter({ config, http, errors }) {
	// POST JSON to API_BASE. A route without arguments gets "{}", as it always has.
	const rpc = (s, route, arg) => s.authorized((token) => http.json({ method: "POST", url: config.API_BASE + route,
		bearer: token, headers: { "Content-Type": "application/json" }, body: JSON.stringify(arg || {}) }));

	// Mode overwrite, autorename off, as before: uploadFile has no "never overwrite" rule for
	// Dropbox (Documents picks a free name before it uploads a new file).
	const upload = (s, dropboxPath, localPath) => s.authorized((token) => http.json({ method: "POST",
		url: config.CONTENT_BASE + "/files/upload", bearer: token, file: localPath,
		headers: { "Dropbox-API-Arg": apiArg({ path: dropboxPath, mode: "overwrite", autorename: false, mute: false }),
			"Content-Type": "application/octet-stream" } }));

	const adapter = {
		// POST /users/get_current_account -> { user:{ emailAddress, displayName } }
		async getAccountInfo(s) {
			const a = (await rpc(s, "/users/get_current_account", null)) || {};
			return { user: { emailAddress: a.email, displayName: (a.name && a.name.display_name) || undefined } };
		},

		// The raw list_folder reply (".tag", path_lower, ...), every page of it
		// (/files/list_folder/continue while has_more). The Photos methods use it.
		async listFolderRaw(s, folder) {
			let page = await rpc(s, "/files/list_folder", { path: normPath(folder) });
			const entries = (page.entries || []).slice();
			while (page.has_more && page.cursor) {
				page = await rpc(s, "/files/list_folder/continue", { cursor: page.cursor });
				entries.push(...(page.entries || []));
			}
			return Object.assign({}, page, { entries, has_more: false });
		},

		async listFolder(s, folderId) {
			const data = await adapter.listFolderRaw(s, folderId);
			return { entries: data.entries.map((e) => entry(e)) };
		},

		// POST /files/get_temporary_link -> { metadata, link }: a URL that needs no token, ~4 h.
		getTemporaryLink(s, p) { return rpc(s, "/files/get_temporary_link", { path: p }); },

		// POST content /files/download; fileId is the Dropbox path. exportMime is not Dropbox's.
		async downloadFile(s, fileId, localDest) {
			await s.authorized((token) => http.request({ method: "POST", url: config.CONTENT_BASE + "/files/download",
				bearer: token, headers: { "Dropbox-API-Arg": apiArg({ path: fileId }) }, toFile: localDest }));
			return { path: localDest };
		},

		// A new file at folder/name.
		uploadFile(s, folderId, localPath, name) { return upload(s, join(folderId, name), localPath); },

		// Overwrite the file at fileId (a save-back): path based, so the same upload.
		uploadReplace(s, fileId, localPath) { return upload(s, fileId, localPath); },

		// POST /files/create_folder_v2 { path, autorename:false }: an existing name is a 409
		// path/conflict, never a silently renamed copy.
		async createFolder(s, parent, name) {
			const r = await rpc(s, "/files/create_folder_v2", { path: join(parent, name), autorename: false });
			return { entry: entry((r && r.metadata) || {}, "folder") };
		},

		// POST /files/move_v2 { from_path, to_path, autorename:false }. Locators are path_lower, so
		// the item's own name is only known lowercased: when the name is kept (a move only), or the
		// item is not a path, POST /files/get_metadata first for the cased name and the parent.
		async moveItem(s, item, toFolder, name) {
			const given = (v) => v !== null && v !== undefined;
			let parent = toFolder, leaf = name;
			if (given(name) && String(item).charAt(0) === "/") {
				if (!given(parent)) { parent = parentOf(item); }
			} else {
				const m = (await rpc(s, "/files/get_metadata", { path: item })) || {};
				if (!given(parent)) { parent = parentOf(m.path_lower || ""); }
				if (!given(leaf)) { leaf = m.name; }
				if (typeof leaf !== "string" || !leaf) { throw new errors.CloudError(ERROR, "get_metadata gave no name for " + item); }
			}
			const r = await rpc(s, "/files/move_v2", { from_path: item, to_path: join(parent, leaf), autorename: false });
			return { entry: entry((r && r.metadata) || {}) };
		},

		// POST /files/delete_v2 { path }. Dropbox keeps deleted items restorable for the plan's
		// history window; permanently_delete is the irreversible one, not used.
		async deleteItem(s, item) {
			await rpc(s, "/files/delete_v2", { path: item });
			return {};
		},

		// The Photos delete button: pid is listPhotos' "id:..." selector, which delete_v2 takes.
		async deletePhoto(s, fileId) {
			await rpc(s, "/files/delete_v2", { path: fileId });
			return { deleted: true };
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, describe, apiArg, join, normPath, entry });
