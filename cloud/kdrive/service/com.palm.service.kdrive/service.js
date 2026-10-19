/* service.js - com.palm.service.kdrive: Infomaniak kDrive on _cloudcore/node.
 *
 * The launcher (run-js-service -> jsservicelauncher/bootstrap-node.js) requires this directory,
 * as it has a package.json, and calls run(). The methods are _cloudcore's generic ones
 * (getAuthorizeUrl, checkCredentials, listFolder, downloadFile, uploadFile, createFolder,
 * moveItem, deleteItem, upload, deletePhoto) on adapter.js; verifyToken (the token sign-in) and
 * kDrive's own exchangeCode from signin.js; listAlbums and listPhotos from photos.js. The
 * endpoints and the OAuth app are in config.js.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// On the device _cloudcore is installed next to the services (synergy-cloudcore); in the
// repository it is cloud/_core/service/_cloudcore.
const installed = path.join(__dirname, "../_cloudcore/node");
const core = require(fs.existsSync(installed) ? installed : path.join(__dirname, "../../../_core/service/_cloudcore/node"));

const adapter = require("./adapter.js");
const signin = require("./signin.js");
const photos = require("./photos.js");

const service = core.connector({
	config: require("./config.js").Config,
	errorCode: adapter.ERROR,
	describe: adapter.describe,
	adapter,
	methods: (deps) => Object.assign({}, signin(Object.assign({ core }, deps)), photos(deps)),
});

module.exports = service;

if (require.main === module) { service.run(); }
