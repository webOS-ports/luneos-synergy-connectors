/*global Adapter, AccountCreds, Acl, Config, Future, cloudRoot */
/* fileOps_commands.js - createFolder, moveItem and deleteItem: what a file manager needs besides
 * listFolder/downloadFile/uploadFile. GENERIC across all connectors; caller allow-list from
 * Config.FILE_APP_IDS, as for the other file commands.
 *
 * Items and folders are addressed by the locators listFolder hands out (entry.path, or entry.id
 * where a provider has no paths), so a consumer stays provider-generic. The root has no entry to
 * take a locator from: leaving the folder out means the root, and moveItem takes toRoot:true.
 *
 *   createFolder { accountId | credentials, folderId | path (parent; default the root), name }
 *     -> { returnValue, renewedCredentials, entry }        the new folder, listFolder-shaped
 *   moveItem     { accountId | credentials, fileId | path (the item),
 *                  toFolderId | toPath | toRoot:true (destination folder; omit to stay),
 *                  name (omit to keep) }
 *     -> { returnValue, renewedCredentials, entry }        the item where it now is
 *   deleteItem   { accountId | credentials, fileId | path }
 *     -> { returnValue, renewedCredentials }               to the provider's trash where it has one
 *
 * The adapter implements createFolder(creds, parent, name, onRenew),
 * moveItem(creds, item, toFolder|null, name|null, onRenew) and deleteItem(creds, item, onRenew),
 * each returning a Future. A connector whose adapter lacks one answers NOT_SUPPORTED.
 */
var CloudFileOp = {
	// Shared body of the three commands: ACL, arguments, credentials, the adapter call, the reply.
	// `prepare(args)` returns the adapter arguments after creds, or an error object to reply with.
	run: function (assistant, future, method, prepare, reply) {
		if (!Acl.enforce(assistant, future)) { return; }
		var args = assistant.controller.args || {};
		if (typeof Adapter === "undefined" || typeof Adapter[method] !== "function") {
			future.setException({ returnValue: false, errorCode: "NOT_SUPPORTED",
				errorText: ((Config && Config.DISPLAY_NAME) || "This service") + " cannot " + method });
			return;
		}
		var adapterArgs = prepare(args);
		if (!Array.isArray(adapterArgs)) { future.setException(adapterArgs); return; }
		var credF = AccountCreds.resolve(args);
		credF.then(assistant, function () {
			var creds;
			try { creds = credF.result; }
			catch (e) { future.setException(e); return; }
			var renewed = null;
			var call = Adapter[method].apply(Adapter,
				[creds].concat(adapterArgs, [function (nc) { renewed = nc; }]));
			call.then(assistant, function () {
				var data;
				try { data = call.result; }
				catch (e2) { future.setException(e2); return; }
				if (renewed && args.accountId) { AccountCreds.save(args.accountId, renewed); }
				var out = { returnValue: true, renewedCredentials: renewed };
				if (reply) { reply(out, data); }
				future.result = out;
			});
		});
	},

	missing: function (what) {
		return { returnValue: false, errorCode: "MISSING_ARGS", errorText: what };
	},

	// A name for a file or folder: one path component.
	badName: function (name) {
		return typeof name !== "string" || !name || name === "." || name === ".." ||
			/[\/\u0000]/.test(name);
	},

	withEntry: function (out, data) { out.entry = (data && data.entry) || null; }
};

function CreateFolderCommandAssistant() {}
CreateFolderCommandAssistant.prototype = {
	allowedAppIds: (typeof Config !== "undefined" && Config.FILE_APP_IDS) || [],
	run: function (future) {
		CloudFileOp.run(this, future, "createFolder", function (args) {
			if (CloudFileOp.badName(args.name)) { return CloudFileOp.missing("name: one path component"); }
			var parent = args.folderId || args.path || cloudRoot();
			return [parent, args.name];
		}, CloudFileOp.withEntry);
	}
};

function MoveItemCommandAssistant() {}
MoveItemCommandAssistant.prototype = {
	allowedAppIds: (typeof Config !== "undefined" && Config.FILE_APP_IDS) || [],
	run: function (future) {
		CloudFileOp.run(this, future, "moveItem", function (args) {
			var item = args.fileId || args.path;
			var to = args.toFolderId || args.toPath ||
				(args.toRoot === true ? cloudRoot() : null);
			var name = (args.name === undefined || args.name === null) ? null : args.name;
			if (!item) { return CloudFileOp.missing("fileId or path"); }
			if (to === null && name === null) { return CloudFileOp.missing("toFolderId, toPath or name"); }
			if (name !== null && CloudFileOp.badName(name)) { return CloudFileOp.missing("name: one path component"); }
			return [item, to, name];
		}, CloudFileOp.withEntry);
	}
};

function DeleteItemCommandAssistant() {}
DeleteItemCommandAssistant.prototype = {
	allowedAppIds: (typeof Config !== "undefined" && Config.FILE_APP_IDS) || [],
	run: function (future) {
		CloudFileOp.run(this, future, "deleteItem", function (args) {
			var item = args.fileId || args.path;
			if (!item) { return CloudFileOp.missing("fileId or path"); }
			// Never the root: a provider would delete or refuse the whole drive.
			var root = String(cloudRoot());
			if (String(item) === root || item === "/" || item === "root") {
				return { returnValue: false, errorCode: "BAD_ARGS", errorText: "the root folder cannot be deleted" };
			}
			return [item];
		});
	}
};
