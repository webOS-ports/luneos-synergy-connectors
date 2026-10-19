/* service.js - com.palm.service.mega: MEGA on _cloudcore/node.
 *
 * The launcher (run-js-service -> jsservicelauncher/bootstrap-node.js) requires this directory,
 * as it has a package.json, and calls run(). The methods are _cloudcore's generic ones
 * (checkCredentials, listFolder, downloadFile, uploadFile, createFolder, moveItem, deleteItem,
 * upload, deletePhoto) on adapter.js, plus login from login.js (MEGA has no OAuth: the core's
 * getAuthorizeUrl and exchangeCode answer NOT_SUPPORTED) and listAlbums and listPhotos from
 * photos.js. The endpoint is in config.js.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// On the device _cloudcore is installed next to the services (synergy-cloudcore); in the
// repository it is cloud/_core/service/_cloudcore.
const installed = path.join(__dirname, "../_cloudcore/node");
const core = require(fs.existsSync(installed) ? installed : path.join(__dirname, "../../../_core/service/_cloudcore/node"));

const adapter = require("./adapter.js");
const loginMethods = require("./login.js");
const photoMethods = require("./photos.js");

const service = core.connector({
	config: require("./config.js").Config,
	errorCode: adapter.ERROR,
	describe: adapter.describe,
	oauth: false,
	adapter,
	methods: (deps) => Object.assign({}, loginMethods(deps), photoMethods(deps)),
});

module.exports = service;

if (require.main === module) { service.run(); }
