/*global Config, console, Adapter, Future */
/* cloudservice.js - generic main service assistant for a cloud connector.
 *
 * This file (and the rest of _cloudcore) is IDENTICAL for every connector and is loaded
 * via "../_cloudcore/..." entries in each service's sources.json. All provider-specific
 * behaviour lives in exactly two per-service files:
 *   - config.js  : endpoints, client id/secret, app-id allow-lists, auth header scheme
 *   - adapter.js : the REST mapping (var Adapter = {...}) - listFolder/downloadFile/
 *                  uploadFile/uploadReplace/getAccountInfo, and createFolder/moveItem/deleteItem
 *                  (commands/fileOps_commands.js), each returning a normalised shape
 *
 * services.json references this assistant by name ("assistant": "CloudService").
 */

/* Adapter calls are made from inside Future callbacks. A synchronous throw there (a
 * credential field missing, a provider reply of an unexpected shape) is caught by
 * Foundations and parked on that inner Future, which nothing reads again: the command
 * never replies and the caller waits out its whole timeout. Wrap the adapter's entry
 * points once, here, so such a throw comes back as a failed Future instead - the shape
 * every command already turns into an error reply. sources.json loads adapter.js before
 * this file in every _cloudcore connector.
 *
 * Only the entry points of the adapter interface are wrapped, the methods the commands
 * call and that return a Future by contract. Adapters' own helpers (_parse, _check, URL
 * builders...) throw on purpose for their caller to catch; turning those throws into a
 * returned Future made _get store it as a successful result, so a rejected token passed
 * checkCredentials.
 */
var CloudGuard = {
	// The photo helpers too: the per-service Photos commands call them from credF's callback,
	// where a throw would be lost the same way.
	ENTRY_POINTS: ["listFolder", "downloadFile", "uploadFile", "uploadReplace",
		"getAccountInfo", "deletePhoto", "ensureAlbumFolder",
		"createFolder", "moveItem", "deleteItem",
		"listFolderRaw", "listSpecialChildren", "getTemporaryLink", "getFileLink",
		"photoAlbums", "resolvePhotoAlbum", "getPhotoLocalPath"],

	wrap: function (adapter) {
		var i, name;
		if (!adapter || adapter.__cloudGuarded) { return; }
		for (i = 0; i < CloudGuard.ENTRY_POINTS.length; i++) {
			name = CloudGuard.ENTRY_POINTS[i];
			if (adapter.hasOwnProperty(name) && typeof adapter[name] === "function") {
				adapter[name] = CloudGuard._guard(name, adapter[name]);
			}
		}
		adapter.__cloudGuarded = true;
	},

	_guard: function (name, fn) {
		return function () {
			try {
				return fn.apply(this, arguments);
			} catch (e) {
				var svc = (typeof Config !== "undefined" && Config.SERVICE_NAME) || "cloud";
				console.log(svc + ": Adapter." + name + " threw: " + ((e && e.stack) || e));
				var f = new Future();
				f.setException(CloudGuard.toError(e));
				return f;
			}
		};
	},

	// Exceptions the adapters raise on purpose are already {returnValue:false, errorCode};
	// anything else (TypeError and friends) becomes CONNECTOR_EXCEPTION.
	toError: function (e) {
		if (e && e.errorCode) { return e; }
		return { returnValue: false, errorCode: "CONNECTOR_EXCEPTION",
			errorText: String((e && e.message) || e) };
	}
};

if (typeof Adapter !== "undefined") { CloudGuard.wrap(Adapter); }

/* The provider's root folder locator, for a command given no folder. Config.ROOT_FOLDER may be
 * falsy and still be the root (pCloud's is the number 0), so it is taken whenever it is set. */
function cloudRoot() {
	var r = (typeof Config !== "undefined") ? Config.ROOT_FOLDER : undefined;
	return (r === undefined || r === null || r === "") ? "root" : r;
}

function CloudService() {}
CloudService.prototype = {
	setup: function () {
		var n = (typeof Config !== "undefined" && Config.SERVICE_NAME) ? Config.SERVICE_NAME : "?";
		console.log("CloudService (_cloudcore) setup: " + n);
		return;
	}
};
