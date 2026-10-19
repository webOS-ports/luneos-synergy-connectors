/* service.js - com.palm.service.gdrive: Google Drive on _cloudcore/node.
 *
 * The launcher (run-js-service -> jsservicelauncher/bootstrap-node.js) requires this directory,
 * as it has a package.json, and calls run(). The methods are _cloudcore's generic ones
 * (getAuthorizeUrl, exchangeCode, checkCredentials, listFolder, downloadFile, uploadFile,
 * createFolder, moveItem, deleteItem) on adapter.js; the OAuth app and endpoints are in config.js.
 *
 * Google Drive is DOCUMENTS only (Google Photos is not reachable headlessly), and the old
 * service had no Photos methods. The core always adds upload and deletePhoto; here they answer
 * NOT_SUPPORTED, so a call fails as it did before instead of uploading into My Drive.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// On the device _cloudcore is installed next to the services (synergy-cloudcore); in the
// repository it is cloud/_core/service/_cloudcore.
const installed = path.join(__dirname, "../_cloudcore/node");
const core = require(fs.existsSync(installed) ? installed : path.join(__dirname, "../../../_core/service/_cloudcore/node"));

const adapter = require("./adapter.js");

const notForDrive = (m) => ({ handler: async () => { throw core.notSupported("Google Drive has no " + m + " (DOCUMENTS only)"); } });

const service = core.connector({
	config: require("./config.js").Config,
	errorCode: adapter.ERROR,
	describe: adapter.describe,
	adapter,
	methods: () => ({ upload: notForDrive("upload"), deletePhoto: notForDrive("deletePhoto") }),
});

module.exports = service;

if (require.main === module) { service.run(); }
