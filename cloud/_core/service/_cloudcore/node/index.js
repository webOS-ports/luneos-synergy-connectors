/* _cloudcore/node - the shared runtime of the cloud connectors on LuneOS's node (22).
 *
 * A ported connector's service directory holds package.json (main: service.js), config.js,
 * adapter.js and whatever provider-only methods it has (photos.js for Dropbox); service.js
 * requires this as ../_cloudcore/node (installed next to the services by synergy-cloudcore)
 * and hands connector() its parts. See cloud/dropbox/service/com.palm.service.dropbox/ for the
 * reference, and the head of each file here for its API.
 *
 * The mojoservice files one level up (../*.js, ../commands/) are for the connectors not yet
 * ported; nothing here uses them.
 */
"use strict";

module.exports = Object.assign({},
	require("./errors.js"),
	require("./bus.js"),
	require("./http.js"),
	require("./oauth.js"),
	require("./creds.js"),
	require("./commands.js"),
	require("./connector.js"));
