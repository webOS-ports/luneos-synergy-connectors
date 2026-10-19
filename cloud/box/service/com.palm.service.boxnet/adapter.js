/* adapter.js - Box API v2 for _cloudcore/node (commands.js there has the interface).
 *
 * Box is REST and id based: GET /folders/{id}/items, GET /files/{id}/content, the root folder is
 * "0". Every item is addressed by its id, which listFolder hands out as each entry's id and path
 * (a folder id to descend into, a file id to fetch). File bytes go up to UPLOAD_BASE
 * (upload.box.com) as multipart (an "attributes" JSON part, then the file); a download is a
 * 302 from api.box.com to a pre-signed dl.boxcloud.com URL, which fetch follows.
 *
 * Every call runs through the session (s.authorized), which refreshes the token once on a 401
 * and retries, and keeps the renewed credentials for the calls after it in the same request:
 * Box rotates the refresh token on every refresh, so a later step refreshing with the old one
 * would be refused. Every failure rejects: a reply outside 2xx is BOX_API_ERROR with its status
 * and Box's error code in the text (a 409 item_name_in_use, a 404 not_found).
 */
"use strict";

const ERROR = "BOX_API_ERROR";

// The fields listFolder asks for; the file operations ask for the same ones.
const ENTRY_FIELDS = "id,type,name,size,modified_at";
const PAGE = 1000;
// Box refuses offset paging past this offset; a folder with more items is listed up to it.
const MAX_OFFSET = 10000;

const enc = encodeURIComponent;

// modified_at as ISO-8601 UTC ("...Z"). Box sends RFC 3339 with an offset (2012-12-12T10:53:43
// -08:00); QuickOffice's File.parseUtcDate only strips a trailing "Z" and splits the time on ":",
// so the offset made its seconds NaN and dropped the date. A date that does not parse is left out.
function isoDate(v) {
	if (!v) { return undefined; }
	const d = new Date(v);
	return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// One Box item -> the listFolder entry. The locator (path) is the item's id.
function entry(e) {
	e = e || {};
	return { id: e.id, type: (e.type === "folder" ? "folder" : "file"),
		name: e.name, size: e.size, modified: isoDate(e.modified_at), path: e.id };
}

// The errorText of a Box error reply ({ type:"error", status, code, message }): its code and
// message where it has them.
function describe(status, body) {
	let why = "";
	try {
		const j = JSON.parse(body);
		if (j && typeof j === "object") {
			const code = typeof j.code === "string" ? j.code : "";
			const msg = typeof j.message === "string" ? j.message : "";
			why = code + (code && msg ? " (" + msg + ")" : msg);
		}
	} catch (e) { why = String(body || ""); }
	why = why.replace(/\s+/g, " ").trim().slice(0, 200);
	return "Box answered HTTP " + status + (why ? ": " + why : "");
}

function createAdapter({ config, http, errors }) {
	const root = () => config.ROOT_FOLDER || "0";

	const get = (s, p) => s.authorized((token) => http.json({ method: "GET", url: config.API_BASE + p, bearer: token }));

	// A JSON request to API_BASE: POST/PUT with a body, or DELETE without one.
	const send = (s, method, p, obj) => s.authorized((token) => http.json(Object.assign(
		{ method, url: config.API_BASE + p, bearer: token }, obj ? { json: obj } : {})));

	// An upload's reply is { total_count, entries:[file] }: the file, or an error rather than a
	// reply naming no file (the Photos service would keep "undefined" as the photo's id).
	function uploaded(r) {
		const f = r && Array.isArray(r.entries) ? r.entries[0] : null;
		if (!f || f.id === undefined || f.id === null || f.id === "") {
			throw new errors.CloudError(ERROR, "Box's upload reply names no file");
		}
		return { id: f.id, name: f.name, size: f.size };
	}

	// A Box locator is a bare id, and file and folder ids are separate kinds, so find out which
	// this one is before changing anything: GET /files/{id}, and on a 404 GET /folders/{id}.
	// Read-only probes mean a mutating request only ever goes to an endpoint whose object was
	// just seen, and a 404/409 from the PUT or DELETE itself (missing destination, name in use)
	// is reported as it is instead of being retried against the other kind.
	async function kindOf(s, id) {
		const q = "/" + enc(id) + "?fields=id,type";
		try { await get(s, "/files" + q); return "files"; }
		catch (e) { if (!e || e.status !== 404) { throw e; } }
		await get(s, "/folders" + q);
		return "folders";
	}

	const adapter = {
		// GET /users/me -> { user:{ emailAddress, displayName } }
		async getAccountInfo(s) {
			const u = (await get(s, "/users/me?fields=id,name,login")) || {};
			return { user: { emailAddress: u.login, displayName: u.name } };
		},

		// GET /folders/{id}/items, every page of it (offset paging, PAGE items each).
		async listFolder(s, folderId) {
			const id = folderId || root();
			const entries = [];
			let offset = 0;
			for (;;) {
				const page = (await get(s, "/folders/" + enc(id) + "/items?limit=" + PAGE +
					(offset ? "&offset=" + offset : "") + "&fields=" + ENTRY_FIELDS)) || {};
				const got = Array.isArray(page.entries) ? page.entries : [];
				entries.push(...got);
				offset += got.length;
				const total = typeof page.total_count === "number" ? page.total_count : 0;
				if (!got.length || offset >= total || offset >= MAX_OFFSET) { break; }
			}
			return { entries: entries.map(entry) };
		},

		// GET /files/{id}/content -> 302 to dl.boxcloud.com, followed -> the bytes to localDest.
		// exportMime is not Box's.
		async downloadFile(s, fileId, localDest) {
			await s.authorized((token) => http.request({ method: "GET",
				url: config.API_BASE + "/files/" + enc(fileId) + "/content", bearer: token,
				redirect: "follow", toFile: localDest }));
			return { path: localDest };
		},

		// POST upload.box.com /files/content: attributes { name, parent:{id} }, then the file.
		// Creates a NEW file; Box answers 409 item_name_in_use when the name is taken (uploadFile
		// replace:true -> uploadReplace overwrites).
		async uploadFile(s, folderId, localPath, name) {
			const attrs = JSON.stringify({ name, parent: { id: String(folderId || root()) } });
			const r = await s.authorized((token) => http.json({ method: "POST", url: config.UPLOAD_BASE + "/files/content",
				bearer: token, multipart: [{ name: "attributes", value: attrs }, { name: "file", file: localPath, filename: name }] }));
			return uploaded(r);
		},

		// POST upload.box.com /files/{id}/content: a new version of the file (a save-back), its
		// name kept.
		async uploadReplace(s, fileId, localPath) {
			const r = await s.authorized((token) => http.json({ method: "POST",
				url: config.UPLOAD_BASE + "/files/" + enc(fileId) + "/content",
				bearer: token, multipart: [{ name: "file", file: localPath }] }));
			return uploaded(r);
		},

		// Photos: a token-in-query content URL the Photos service can fetch with no header (Box has
		// no pre-signed link that needs no token).
		contentUrl(s, fileId) {
			return config.API_BASE + "/files/" + enc(fileId) + "/content?access_token=" + enc(s.accessToken);
		},

		// DELETE /files/{id} (to the trash): the Photos delete button; pid is the Box file id.
		async deletePhoto(s, fileId) {
			await send(s, "DELETE", "/files/" + enc(fileId), null);
			return { deleted: true };
		},

		// POST /folders { name, parent:{id} } -> 201 the folder. A name already in the parent is a
		// 409 item_name_in_use; Box never renames.
		async createFolder(s, parent, name) {
			const r = await send(s, "POST", "/folders?fields=" + ENTRY_FIELDS, { name, parent: { id: String(parent || root()) } });
			return { entry: entry(r) };
		},

		// PUT /files/{id} or /folders/{id} { name?, parent:{id}? } -> the item where it now is.
		async moveItem(s, item, toFolder, name) {
			const body = {};
			if (name !== null && name !== undefined) { body.name = name; }
			if (toFolder !== null && toFolder !== undefined) { body.parent = { id: String(toFolder) }; }
			const kind = await kindOf(s, item);
			const r = await send(s, "PUT", "/" + kind + "/" + enc(item) + "?fields=" + ENTRY_FIELDS, body);
			return { entry: entry(r) };
		},

		// DELETE /files/{id} or /folders/{id}?recursive=true -> 204. Both move the item to the Box
		// trash (restorable for the enterprise's retention, 30 days by default).
		async deleteItem(s, item) {
			const kind = await kindOf(s, item);
			await send(s, "DELETE", "/" + kind + "/" + enc(item) + (kind === "folders" ? "?recursive=true" : ""), null);
			return {};
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, ENTRY_FIELDS, PAGE, MAX_OFFSET, describe, entry, isoDate });
