/* adapter.js - Koofr REST v2 for _cloudcore/node (commands.js there has the interface).
 *
 * Koofr is MOUNT + PATH based: files live under a mount (the user's primary personal storage),
 * addressed by (mountId, absolute path). The primary mount id is resolved with GET /mounts the
 * first time a session needs it and kept on the session's credentials (creds.mountId), so it
 * is also on the credentials a token refresh renews and saves. A locator is the absolute path
 * within that mount; the root is "/" ("", "root" mean it too). Metadata calls go to API_BASE,
 * file bytes to CONTENT_BASE (same host, "/content/api/v2"); every call carries
 * "X-Koofr-Version" and the Bearer token.
 *
 * Every call runs through the session (s.authorized), which refreshes the token once on a 401
 * and retries. Every failure rejects: a reply outside 2xx is KOOFR_API_ERROR with its status
 * (KOOFR_DOWNLOAD_FAILED, KOOFR_MKDIR_FAILED, KOOFR_DELETE_FAILED for a download, the album
 * folder and a photo's delete, as before).
 *
 * Credentials: { accessToken, refreshToken, expiresAt, mountId? }.
 */
"use strict";

const ERROR = "KOOFR_API_ERROR";

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
	bmp: "image/bmp", heic: "image/heic", webp: "image/webp", pdf: "application/pdf" };

// A locator as an absolute path ("/" for the mount root).
function norm(p) {
	if (p === undefined || p === null || p === "" || p === "root" || p === "/") { return "/"; }
	p = String(p);
	return (p.charAt(0) === "/") ? p : ("/" + p);
}

// norm without a trailing slash ("/" for the mount root, "//" included).
function bare(p) { return norm(String(p === undefined || p === null ? "" : p).replace(/\/+$/, "")); }

function join(folder, name) {
	const base = (folder === "/") ? "" : String(folder).replace(/\/+$/, "");
	return base + "/" + name;
}

function leaf(p) { const s = String(p).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return i >= 0 ? s.substring(i + 1) : s; }
function dirOf(p) { const s = String(p).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return i > 0 ? s.substring(0, i) : "/"; }

function mimeOf(name, isFolder, contentType) {
	if (contentType) { return contentType; }
	if (isFolder) { return "application/x-directory"; }
	const m = /\.([a-z0-9]+)$/i.exec(name || "");
	return MIME[m ? m[1].toLowerCase() : ""] || null;
}

// One listFolder entry from a Koofr file object (files/list item or files/info reply) that lives
// in folderPath. Koofr gives basenames; the full path is the entry's id and path.
function entry(folderPath, o) {
	const isFolder = (o.type === "dir");
	const full = join(folderPath, o.name);
	return { id: full, type: isFolder ? "folder" : "file", name: o.name,
		size: o.size || 0, modified: o.modified || 0, path: full, mimeType: mimeOf(o.name, isFolder, o.contentType) };
}

// The errorText of a Koofr error reply: its error message where it has one.
function describe(status, body) {
	let why = "";
	try {
		const j = JSON.parse(body);
		const e = (j && j.error) || j;
		why = (e && typeof e.message === "string") ? e.message : ((e && typeof e.code === "string") ? e.code : "");
	} catch (x) { why = String(body || "").replace(/\s+/g, " ").trim().slice(0, 200); }
	return "Koofr answered HTTP " + status + (why ? ": " + why : "");
}

function createAdapter({ config, http, errors }) {
	const { CloudError } = errors;
	const enc = encodeURIComponent;
	const headers = (extra) => Object.assign({ "X-Koofr-Version": config.KOOFR_VERSION || "2.1" }, extra || {});

	// One request with the session's token: http.request's reply ({ status, text } or, with
	// toFile, { path }).
	const send = (s, opts) => s.authorized((token) => http.request(Object.assign({}, opts,
		{ bearer: token, headers: headers(opts.headers) })));

	// The reply as JSON ({} when empty); a reply that is not JSON is the call's errorCode.
	function parse(r, errorCode) {
		if (!r.text) { return {}; }
		try { return JSON.parse(r.text); }
		catch (e) { throw new CloudError(errorCode || ERROR, "Koofr: the reply is not JSON", { status: r.status }); }
	}
	const getJson = async (s, url) => parse(await send(s, { method: "GET", url }));
	const sendJson = async (s, method, url, obj) => parse(await send(s, { method, url,
		headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }));

	const filesUrl = (mid, op, p) => config.API_BASE + "/mounts/" + mid + "/files/" + op + "?path=" + enc(p);

	// The primary mount's id (isPrimary, else the first mount), kept on the session's current
	// credentials: those are the renewed ones when a refresh happened, so a renewed token is saved
	// with its mount.
	async function mount(s) {
		if (s.creds.mountId) { return s.creds.mountId; }
		const d = await getJson(s, config.API_BASE + "/mounts");
		const mounts = (d && Array.isArray(d.mounts)) ? d.mounts : [];
		const primary = mounts.find((m) => m && m.isPrimary) || mounts[0];
		if (!primary || !primary.id) { throw new CloudError("KOOFR_NO_MOUNT", "Koofr: the account has no mount"); }
		s.creds.mountId = primary.id;
		return primary.id;
	}

	// GET files/info?path=p -> { entry } in listFolder's shape.
	async function infoEntry(s, mid, p) {
		const o = (await getJson(s, filesUrl(mid, "info", p))) || {};
		if (!o.name) { o.name = leaf(p); }
		return { entry: entry(dirOf(p), o) };
	}

	// POST content files/put?path=<folder>&filename=<name>&info=true&overwrite=true, the file as
	// the multipart part "file", named as the file is to be.
	async function put(s, folderPath, name, localPath) {
		const mid = await mount(s);
		const url = config.CONTENT_BASE + "/mounts/" + mid + "/files/put?path=" + enc(folderPath) +
			"&filename=" + enc(name) + "&info=true&overwrite=true";
		const meta = parse(await send(s, { method: "POST", url,
			multipart: [{ name: "file", file: localPath, filename: name }] })) || {};
		const full = join(folderPath, meta.name || name);
		return { id: full, path: full, name: meta.name || name, size: meta.size };
	}

	const adapter = {
		// GET /user -> { user:{ emailAddress, displayName } }.
		async getAccountInfo(s) {
			const u = (await getJson(s, config.API_BASE + "/user")) || {};
			const name = ((u.firstName || "") + " " + (u.lastName || "")).trim();
			return { user: { emailAddress: u.email, displayName: name || u.email } };
		},

		resolveMount: mount,

		// GET /mounts/{mid}/files/list?path=..
		async listFolder(s, folderId) {
			const folderPath = norm(folderId);
			const mid = await mount(s);
			const d = (await getJson(s, filesUrl(mid, "list", folderPath))) || {};
			return { entries: (Array.isArray(d.files) ? d.files : []).map((o) => entry(folderPath, o)) };
		},

		// GET content/mounts/{mid}/files/get?path=.. -> the bytes to localDest.
		async downloadFile(s, fileId, localDest) {
			const mid = await mount(s);
			await send(s, { method: "GET", url: config.CONTENT_BASE + "/mounts/" + mid + "/files/get?path=" + enc(norm(fileId)),
				toFile: localDest, errorCode: "KOOFR_DOWNLOAD_FAILED" });
			return { path: localDest };
		},

		uploadFile(s, folderId, localPath, name) { return put(s, norm(folderId), name, localPath); },

		// Overwrite the file at fileId (a save-back): the same put, into its folder under its name.
		uploadReplace(s, fileId, localPath) { return put(s, dirOf(norm(fileId)), leaf(fileId), localPath); },

		// POST /mounts/{mid}/files/folder?path=/ {"name"}: the album folder at the mount root,
		// made if missing (an existing one answers 409, which is fine). -> its path.
		async ensureAlbumFolder(s, name) {
			const l = String(name).replace(/^\/+|\/+$/g, "");
			const mid = await mount(s);
			await send(s, { method: "POST", url: filesUrl(mid, "folder", "/"), headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: l }), accept: [409], errorCode: "KOOFR_MKDIR_FAILED" });
			return "/" + l;
		},

		// GET /mounts/{mid}/files/download?path=.. -> { link } (a ready-to-GET URL for Photos).
		async getTemporaryLink(s, fileId) {
			const mid = await mount(s);
			const d = (await getJson(s, filesUrl(mid, "download", norm(fileId)))) || {};
			return { link: d.link, method: "GET" };
		},

		// DELETE /mounts/{mid}/files/remove?path=..
		async deletePhoto(s, fileId) {
			const mid = await mount(s);
			await send(s, { method: "DELETE", url: filesUrl(mid, "remove", norm(fileId)), errorCode: "KOOFR_DELETE_FAILED" });
			return { deleted: true };
		},

		// POST files/folder?path=<parent> {"name"} (an existing name fails, 409), then files/info.
		async createFolder(s, parent, name) {
			const parentPath = norm(parent);
			const mid = await mount(s);
			await sendJson(s, "POST", filesUrl(mid, "folder", parentPath), { name });
			return infoEntry(s, mid, join(parentPath, name));
		},

		// Rename in place: PUT files/rename?path=<item> {"name"}. Anything else: PUT files/move?path=
		// <item> {"toMountId", "toPath"} with toPath the item's full new path, which moves and
		// renames in one call. Koofr does not document what a move onto an existing name does, so
		// an existing destination is refused here first (KOOFR_EXISTS) rather than overwritten or
		// auto-renamed; a change of case only is let through when the probe finds the item itself.
		async moveItem(s, item, toFolder, name) {
			const src = bare(item);
			if (src === "/") { throw errors.badArgs("the root folder cannot be moved"); }
			const destDir = (toFolder === null || toFolder === undefined) ? dirOf(src) : bare(toFolder);
			const dest = join(destDir, (name === null || name === undefined) ? leaf(src) : name);
			if (destDir === src || destDir.indexOf(src + "/") === 0) { throw errors.badArgs("a folder cannot be moved into itself"); }
			const mid = await mount(s);
			if (dest === src) { return infoEntry(s, mid, src); }
			const probe = await send(s, { method: "GET", url: filesUrl(mid, "info", dest), accept: [404] });
			if (probe.status !== 404) {
				const there = parse(probe) || {};
				// A change of case only: the probe may have found the item itself.
				if (dest.toLowerCase() !== src.toLowerCase() || there.name === leaf(dest)) {
					throw new CloudError("KOOFR_EXISTS", "an item with that name already exists there", { status: 409 });
				}
			}
			if (destDir === dirOf(src)) {
				await sendJson(s, "PUT", filesUrl(mid, "rename", src), { name: leaf(dest) });
			} else {
				await sendJson(s, "PUT", filesUrl(mid, "move", src), { toMountId: mid, toPath: dest });
			}
			return infoEntry(s, mid, dest);
		},

		// DELETE files/remove?path=<item> (a folder goes with its contents).
		async deleteItem(s, item) {
			const src = bare(item);
			if (src === "/") { throw errors.badArgs("the root folder cannot be deleted"); }
			const mid = await mount(s);
			await send(s, { method: "DELETE", url: filesUrl(mid, "remove", src) });
			return {};
		},
	};
	return adapter;
}

module.exports = Object.assign(createAdapter, { ERROR, describe, norm, bare, join, leaf, dirOf, entry, mimeOf });
