/* adapter.js - Microsoft Graph (OneDrive) for _cloudcore/node (commands.js there has the interface).
 *
 * Graph is REST and id based. The drive tree is reached by URL segments: the root's children
 * are /me/drive/root/children, a folder's /me/drive/items/{id}/children, a file's bytes
 * /me/drive/items/{id}/content (a 302 to a pre-signed host; fetch follows it and drops the
 * Authorization header on the cross-origin hop, as curl -L did). The locator is the item id,
 * which listFolder hands out as each entry's id and path; the root is "root".
 *
 * A children listing without $select carries each item's folder/file facet, size,
 * lastModifiedDateTime and @microsoft.graph.downloadUrl (a short-lived pre-signed URL, which
 * the Photos service fetches with no token). Listings follow @odata.nextLink to the end.
 *
 * Every call runs through the session (s.authorized), which refreshes the token once on a 401
 * and retries. Microsoft rotates the refresh token on every use; creds.js keeps the new one and
 * the service saves it to the account. Every failure rejects: a reply outside 2xx is
 * GRAPH_API_ERROR with its status and body (errorText names Graph's code, e.g. nameAlreadyExists).
 */
"use strict";

const ERROR = "GRAPH_API_ERROR";
// Graph special folders that are folder locators too (/me/drive/special/{name}): the Photos
// album (photos.js) is the Camera Roll, and its aid is the special folder's name.
const SPECIAL = ["cameraroll"];

// One Graph driveItem -> the listFolder entry.
function entry(e) {
	return { id: e.id, type: e.folder ? "folder" : "file", name: e.name, size: e.size,
		modified: e.lastModifiedDateTime, path: e.id, mimeType: e.file && e.file.mimeType,
		downloadUrl: e["@microsoft.graph.downloadUrl"] };
}

// The errorText of a Graph error reply: { error:{ code, message } }.
function describe(status, body) {
	let why = "";
	try {
		const e = (JSON.parse(body) || {}).error || {};
		why = [typeof e.code === "string" ? e.code : "", typeof e.message === "string" && e.message ? "(" + e.message + ")" : ""]
			.filter(Boolean).join(" ");
	} catch (x) {
		why = String(body || "");
	}
	why = why.replace(/\s+/g, " ").trim().slice(0, 200);
	return "OneDrive answered HTTP " + status + (why ? ": " + why : "");
}

function createAdapter({ config, http, errors }) {
	const API = config.API_BASE;
	const ROOT = config.ROOT_FOLDER || "root";
	const isRoot = (id) => !id || id === ROOT;
	const itemPath = (id) => "/me/drive/items/" + encodeURIComponent(id);
	// The children collection of a folder locator; falsy/"root" is the drive root.
	const childrenPath = (id) => (isRoot(id) ? "/me/drive/root/children" : itemPath(id) + "/children");

	const call = (s, method, url, body) => s.authorized((token) => http.json(
		body === undefined ? { method, url, bearer: token } : { method, url, bearer: token, json: body }));
	const put = (s, url, localPath) => s.authorized((token) => http.json({ method: "PUT", url, bearer: token,
		file: localPath, headers: { "Content-Type": "application/octet-stream" } }));

	// Every page of a children listing -> the raw { value:[driveItem] }. A next link is only
	// followed on Graph itself: the token goes nowhere else.
	async function children(s, p) {
		let page = (await call(s, "GET", API + p + "?$top=1000")) || {};
		const value = (page.value || []).slice();
		while (page["@odata.nextLink"]) {
			const next = String(page["@odata.nextLink"]);
			if (next.indexOf(API + "/") !== 0) { throw new errors.CloudError(ERROR, "Graph's next page is not on " + API); }
			page = (await call(s, "GET", next)) || {};
			value.push(...(page.value || []));
		}
		return { value };
	}

	const adapter = {
		// GET /me -> { user:{ emailAddress, displayName } }. A personal account's mail may be
		// null: the userPrincipalName then.
		async getAccountInfo(s) {
			const u = (await call(s, "GET", API + "/me?$select=id,displayName,userPrincipalName,mail")) || {};
			return { user: { emailAddress: u.mail || u.userPrincipalName, displayName: u.displayName } };
		},

		// The raw children of a special folder ("cameraroll"), for photos.js.
		listSpecialChildren(s, special) {
			return children(s, "/me/drive/special/" + encodeURIComponent(special) + "/children");
		},

		async listFolder(s, folderId) {
			const data = await children(s, childrenPath(folderId));
			return { entries: data.value.map(entry) };
		},

		// GET content -> 302 -> the bytes to disk. exportMime is not Graph's.
		async downloadFile(s, fileId, localDest) {
			await s.authorized((token) => http.request({ method: "GET", url: API + itemPath(fileId) + "/content",
				bearer: token, toFile: localDest }));
			return { path: localDest };
		},

		// PUT simple upload (the file as the body) to {folder}:/{name}:/content; files up to
		// ~250 MB (larger needs an upload session, not done). An existing name is replaced, as
		// before. The folder is an item id, the root, or a special folder (the Photos album).
		async uploadFile(s, folderId, localPath, name, mimeType) {
			const folder = isRoot(folderId) ? "/me/drive/root"
				: (SPECIAL.indexOf(folderId) >= 0 ? "/me/drive/special/" + folderId : itemPath(folderId));
			const r = (await put(s, API + folder + ":/" + encodeURIComponent(name) + ":/content", localPath)) || {};
			return { id: r.id, name: r.name, size: r.size };
		},

		// New content for an existing item, in place (a save-back). mimeType is not used.
		async uploadReplace(s, fileId, localPath) {
			const r = (await put(s, API + itemPath(fileId) + "/content", localPath)) || {};
			return { id: r.id, name: r.name, size: r.size };
		},

		// POST {parent}/children with a folder facet. conflictBehavior fail: an existing name is
		// a 409, never a silently renamed "New Folder 1".
		async createFolder(s, parent, name) {
			const r = await call(s, "POST", API + childrenPath(parent),
				{ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
			return { entry: entry(r || {}) };
		},

		// PATCH the item's name and/or parentReference. Graph refuses parentReference {id:"root"},
		// so a move to the root looks up the root's real id first.
		async moveItem(s, item, toFolder, name) {
			let parentId = toFolder || null;
			if (toFolder === ROOT) {
				parentId = ((await call(s, "GET", API + "/me/drive/root?$select=id")) || {}).id;
				if (!parentId) { throw new errors.CloudError(ERROR, "Graph gave no id for the drive root"); }
			}
			const body = {};
			if (name !== null && name !== undefined) { body.name = name; }
			if (parentId) { body.parentReference = { id: parentId }; }
			const r = await call(s, "PATCH", API + itemPath(item), body);
			return { entry: entry(r || {}) };
		},

		// DELETE the item: Graph moves it to the recycle bin (204 No Content).
		async deleteItem(s, item) {
			await call(s, "DELETE", API + itemPath(item));
			return {};
		},

		// The Photos delete button: pid is the driveItem id listPhotos gave. To the recycle bin too.
		async deletePhoto(s, fileId) {
			await call(s, "DELETE", API + itemPath(fileId));
			return { deleted: true };
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, SPECIAL, describe, entry });
