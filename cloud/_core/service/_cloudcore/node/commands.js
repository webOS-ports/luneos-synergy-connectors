/* commands.js - the luna methods every connector has, on top of the provider's adapter.
 *
 *   const methods = createCommands({ config, adapter, store, oauth });
 *   // { getAuthorizeUrl, exchangeCode, checkCredentials, listFolder, downloadFile, uploadFile,
 *   //   createFolder, moveItem, deleteItem, upload, deletePhoto }: { handler, allow, timeoutMs }
 *
 * The arguments, replies and caller rules are those of the mojoservice commands in
 * ../commands/*.js, which the not yet ported connectors still run:
 *
 *   getAuthorizeUrl  { state? }                      -> { url, codeVerifier }               open
 *   exchangeCode     { code, codeVerifier }          -> { username, alias, credentials:{common} } open
 *   checkCredentials { credentials:{common} }        -> { renewedCredentials, username, displayName } open
 *   listFolder       { accountId|credentials, folderId|path }        -> { renewedCredentials, entries }
 *   downloadFile     { .., fileId|path|dropboxPath, localPath, exportMime? } -> { renewedCredentials, path }
 *   uploadFile       { .., folderId|path, localPath, name?, mimeType? }
 *                    { .., fileId|path|dropboxPath, localPath, replace:true } -> { renewedCredentials, name, id, size }
 *   createFolder     { .., folderId|path (parent), name }           -> { renewedCredentials, entry }
 *   moveItem         { .., fileId|path, toFolderId|toPath|toRoot:true, name } -> { renewedCredentials, entry }
 *   deleteItem       { .., fileId|path }                              -> { renewedCredentials }
 *   upload           { accountId, albumId|folderId, path|localPath, name?, mimeType? } -> { pid, name, size }  open
 *   deletePhoto      { accountId, pid|photoId|fileId }                -> { pid }                 open
 *
 * The file methods take callers from Config.FILE_APP_IDS. getAuthorizeUrl is open, as it was:
 * its command declared AUTH_APP_IDS but never checked it, and the sign-in app's calls arrive as
 * com.palm.app.accounts-<pid> (it runs as an iframe in Accounts), which AUTH_APP_IDS does not
 * name. Accounts calls exchangeCode/checkCredentials, and the Photos service upload/deletePhoto,
 * with no app id, so those are open too; the bus role decides who reaches the service at all.
 *
 * The adapter's methods are async and take a Session (creds.js) first:
 *   listFolder(s, folderId) -> { entries:[{ id, type:"folder"|"file", name, size, modified, path, .. }] }
 *   downloadFile(s, fileId, localPath, exportMime) -> { path }
 *   uploadFile(s, folderId, localPath, name, mimeType) -> { id, name, size }
 *   uploadReplace(s, fileId, localPath, mimeType)      -> { id, name, size }
 *   getAccountInfo(s) -> { user:{ emailAddress, displayName } }
 *   createFolder(s, parent, name) -> { entry };  moveItem(s, item, toFolder|null, name|null) -> { entry }
 *   deleteItem(s, item) -> {};  deletePhoto(s, pid);  ensureAlbumFolder(s, albumName) -> folder locator
 * A method the adapter does not have answers NOT_SUPPORTED.
 */
"use strict";

const { CloudError, missingArgs, badArgs, notSupported } = require("./errors.js");
const { Session } = require("./creds.js");

const SECOND = 1000;
const TIMEOUTS = { auth: 30 * SECOND, account: 60 * SECOND, list: 120 * SECOND, edit: 120 * SECOND,
	transfer: 600 * SECOND, photos: 300 * SECOND };

// The provider's root folder locator, for a command given no folder. ROOT_FOLDER may be falsy and
// still be the root (pCloud's is the number 0), so it is taken whenever it is set.
function cloudRoot(config) {
	const r = config.ROOT_FOLDER;
	return (r === undefined || r === null || r === "") ? "root" : r;
}

// A name for a file or folder: one path component.
function badName(name) {
	return typeof name !== "string" || !name || name === "." || name === ".." || /[/\u0000]/.test(name);
}

// Run fn(session) with the request's credentials, and save the credentials back to the account
// when a refresh renewed them -> { out, renewed }. They are saved even when fn then fails:
// providers that rotate refresh tokens (Box, OneDrive) have already retired the stored one.
function createAccountRunner({ store, oauth }) {
	return async function withAccount(params, fn) {
		const creds = await store.resolve(params);
		const s = new Session(creds, { refresh: oauth ? oauth.refresh : null });
		const save = () => (s.renewed && params.accountId ? store.save(params.accountId, s.renewed) : null);
		let out;
		try {
			out = await fn(s);
		} catch (e) {
			try { await save(); } catch (_) { /* the request's own error is the one to report */ }
			throw e;
		}
		await save();
		return { out, renewed: s.renewed };
	};
}

function createCommands({ config, adapter, store, oauth }) {
	const withAccount = createAccountRunner({ store, oauth });
	const FILE = config.FILE_APP_IDS || [];
	const who = config.DISPLAY_NAME || "This service";
	const has = (m) => typeof adapter[m] === "function";
	const need = (m) => { if (!has(m)) { throw notSupported(who + " cannot " + m); } };
	const needOAuth = () => { if (!oauth) { throw notSupported(who + " does not sign in with OAuth"); } };

	const methods = {
		getAuthorizeUrl: { timeoutMs: TIMEOUTS.auth, handler: async (p) => {
			needOAuth();
			return oauth.authorizeUrl(p.state || config.STATE || "cloud");
		} },

		// The account validator: the code from the OAuth redirect -> the credentials Accounts stores,
		// and a username, without which Accounts does not create the account. The identity is only
		// a nicety once the tokens are there: without it the account is made with a fallback name.
		exchangeCode: { timeoutMs: TIMEOUTS.account, handler: async (p) => {
			needOAuth();
			if (!p.code) { throw new CloudError("MISSING_CODE", "need code"); }
			const t = await oauth.exchangeCode(p.code, p.codeVerifier);
			let common = { accessToken: t.accessToken, refreshToken: t.refreshToken,
				expiresAt: (typeof t.expiresIn === "number" && isFinite(t.expiresIn)) ? Date.now() + t.expiresIn * 1000 : null };
			let u = {};
			if (has("getAccountInfo")) {
				const s = new Session(common, { refresh: oauth.refresh });
				try { u = ((await adapter.getAccountInfo(s)) || {}).user || {}; } catch (e) { u = {}; }
				if (s.renewed) { common = s.renewed; }
			}
			return { username: u.emailAddress || config.DISPLAY_NAME || "Cloud account",
				alias: u.displayName || undefined, credentials: { common } };
		} },

		// Accounts' onCredentialsChanged: do the tokens still work. A token renewed here is reported,
		// not saved: saving changes the credentials, which would call this again.
		checkCredentials: { timeoutMs: TIMEOUTS.account, handler: async (p) => {
			const creds = p.credentials && p.credentials.common;
			if (!creds || !creds.accessToken) { throw new CloudError("401_UNAUTHORIZED", "no access token"); }
			need("getAccountInfo");
			const s = new Session(creds, { refresh: oauth ? oauth.refresh : null });
			const u = ((await adapter.getAccountInfo(s)) || {}).user || {};
			return { renewedCredentials: s.renewed, username: u.emailAddress, displayName: u.displayName };
		} },

		listFolder: { allow: FILE, timeoutMs: TIMEOUTS.list, handler: async (p) => {
			need("listFolder");
			const folderId = p.folderId || p.path || cloudRoot(config);
			const { out, renewed } = await withAccount(p, (s) => adapter.listFolder(s, folderId));
			return { renewedCredentials: renewed, entries: (out && out.entries) || [] };
		} },

		downloadFile: { allow: FILE, timeoutMs: TIMEOUTS.transfer, handler: async (p) => {
			need("downloadFile");
			const fileId = p.fileId || p.path || p.dropboxPath;
			if (!fileId || !p.localPath) { throw missingArgs("need fileId and localPath"); }
			const { out, renewed } = await withAccount(p, (s) => adapter.downloadFile(s, fileId, p.localPath, p.exportMime || null));
			return { renewedCredentials: renewed, path: out && out.path };
		} },

		// replace:true overwrites the file named by fileId|path|dropboxPath in place (a save-back);
		// otherwise a new file goes into folderId|path, named name or the local file's name.
		uploadFile: { allow: FILE, timeoutMs: TIMEOUTS.transfer, handler: async (p) => {
			if (!p.localPath) { throw missingArgs("need localPath"); }
			const replaceId = p.replace ? (p.fileId || p.path || p.dropboxPath) : null;
			const folderId = p.folderId || p.path || cloudRoot(config);
			const name = p.name || String(p.localPath).split("/").pop();
			need(replaceId ? "uploadReplace" : "uploadFile");
			const { out, renewed } = await withAccount(p, (s) => (replaceId
				? adapter.uploadReplace(s, replaceId, p.localPath, p.mimeType)
				: adapter.uploadFile(s, folderId, p.localPath, name, p.mimeType)));
			const meta = out || {};
			return { renewedCredentials: renewed, name: meta.name, id: meta.id, size: meta.size };
		} },

		createFolder: { allow: FILE, timeoutMs: TIMEOUTS.edit, handler: async (p) => {
			need("createFolder");
			if (badName(p.name)) { throw missingArgs("name: one path component"); }
			const parent = p.folderId || p.path || cloudRoot(config);
			const { out, renewed } = await withAccount(p, (s) => adapter.createFolder(s, parent, p.name));
			return { renewedCredentials: renewed, entry: (out && out.entry) || null };
		} },

		moveItem: { allow: FILE, timeoutMs: TIMEOUTS.edit, handler: async (p) => {
			need("moveItem");
			const item = p.fileId || p.path;
			const to = p.toFolderId || p.toPath || (p.toRoot === true ? cloudRoot(config) : null);
			const name = (p.name === undefined || p.name === null) ? null : p.name;
			if (!item) { throw missingArgs("fileId or path"); }
			if (to === null && name === null) { throw missingArgs("toFolderId, toPath or name"); }
			if (name !== null && badName(name)) { throw missingArgs("name: one path component"); }
			const { out, renewed } = await withAccount(p, (s) => adapter.moveItem(s, item, to, name));
			return { renewedCredentials: renewed, entry: (out && out.entry) || null };
		} },

		deleteItem: { allow: FILE, timeoutMs: TIMEOUTS.edit, handler: async (p) => {
			need("deleteItem");
			const item = p.fileId || p.path;
			if (!item) { throw missingArgs("fileId or path"); }
			// Never the root: a provider would delete or refuse the whole drive.
			if (String(item) === String(cloudRoot(config)) || item === "/" || item === "root") {
				throw badArgs("the root folder cannot be deleted");
			}
			const { renewed } = await withAccount(p, (s) => adapter.deleteItem(s, item));
			return { renewedCredentials: renewed };
		} },

		// The Photos service's upload: a local photo into the album folder (albumId, the aid
		// listAlbums gave), or - with none - into the provider's album folder (ensureAlbumFolder,
		// named Config.PHOTO_ALBUM_NAME), or the adapter's default (null) where it has no such thing.
		upload: { timeoutMs: TIMEOUTS.photos, handler: async (p) => {
			const localPath = p.path || p.localPath;
			if (!localPath) { throw missingArgs("need path"); }
			need("uploadFile");
			const name = p.name || String(localPath).split("/").pop();
			const albumId = p.albumId || p.folderId;
			const { out } = await withAccount(p, async (s) => {
				let folder = albumId || null;
				if (!folder && has("ensureAlbumFolder")) { folder = await adapter.ensureAlbumFolder(s, config.PHOTO_ALBUM_NAME || "Pictures"); }
				return adapter.uploadFile(s, folder, localPath, name, p.mimeType);
			});
			const meta = out || {};
			return { pid: String(meta.id), name: meta.name, size: meta.size };
		} },

		// The Photos service calls this before it drops its own copy, so a failure here keeps the
		// photo visible instead of orphaning the cloud file.
		deletePhoto: { timeoutMs: TIMEOUTS.photos, handler: async (p) => {
			const pid = p.pid || p.photoId || p.fileId;
			if (pid === undefined || pid === null || pid === "") { throw missingArgs("need pid"); }
			if (!has("deletePhoto")) { throw notSupported("this provider has no deletePhoto"); }
			await withAccount(p, (s) => adapter.deletePhoto(s, pid));
			return { pid: String(pid) };
		} },
	};
	return methods;
}

module.exports = { createCommands, createAccountRunner, cloudRoot, badName, TIMEOUTS };
