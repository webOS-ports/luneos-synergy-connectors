/*global Config, console, Adapter, Future */
/* cloudservice.js - generic main service assistant for a cloud connector.
 *
 * This file (and the rest of _cloudcore) is IDENTICAL for every connector and is loaded
 * via "../_cloudcore/..." entries in each service's sources.json. All provider-specific
 * behaviour lives in exactly two per-service files:
 *   - config.js  : endpoints, client id/secret, app-id allow-lists, auth header scheme
 *   - adapter.js : the REST mapping (var Adapter = {...}) - listFolder/downloadFile/
 *                  uploadFile/uploadReplace/getAccountInfo, each returning a normalised shape
 *
 * services.json references this assistant by name ("assistant": "CloudService").
 */

/* Adapter calls are made from inside Future callbacks. A synchronous throw there (a
 * credential field missing, a provider reply of an unexpected shape) is caught by
 * Foundations and parked on that inner Future, which nothing reads again: the command
 * never replies and the caller waits out its whole timeout. Wrap every Adapter method
 * once, here, so such a throw comes back as a failed Future instead - the shape every
 * command already turns into an error reply. sources.json loads adapter.js before this
 * file in every _cloudcore connector.
 */
var CloudGuard = {
	wrap: function (adapter) {
		var name;
		if (!adapter || adapter.__cloudGuarded) { return; }
		for (name in adapter) {
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

function CloudService() {}
CloudService.prototype = {
	setup: function () {
		var n = (typeof Config !== "undefined" && Config.SERVICE_NAME) ? Config.SERVICE_NAME : "?";
		console.log("CloudService (_cloudcore) setup: " + n);
		return;
	}
};
