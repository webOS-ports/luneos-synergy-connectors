/* service.js - com.palm.service.webdav: WebDAV (Nextcloud, ownCloud, a NAS, any WebDAV server)
 * on _cloudcore/node.
 *
 * The launcher (run-js-service -> jsservicelauncher/bootstrap-node.js) requires this directory,
 * as it has a package.json, and calls run(). The methods are _cloudcore's generic ones
 * (checkCredentials, listFolder, downloadFile, uploadFile, createFolder, moveItem, deleteItem,
 * upload, deletePhoto) on adapter.js, plus login (the account validator, login.js) and
 * listAlbums and listPhotos (photos.js). There is no OAuth: the core's getAuthorizeUrl and
 * exchangeCode answer NOT_SUPPORTED.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// On the device _cloudcore is installed next to the services (synergy-cloudcore); in the
// repository it is cloud/_core/service/_cloudcore.
const installed = path.join(__dirname, "../_cloudcore/node");
const core = require(fs.existsSync(installed) ? installed : path.join(__dirname, "../../../_core/service/_cloudcore/node"));

const adapter = require("./adapter.js");
const photos = require("./photos.js");
const login = require("./login.js");

const service = core.connector({
	config: require("./config.js").Config,
	errorCode: adapter.ERROR,
	describe: adapter.describe,
	oauth: false,
	adapter,
	methods: (deps) => Object.assign(photos(deps),
		login(Object.assign({ dav: adapter, Session: core.Session, CloudError: core.CloudError }, deps))),
});

module.exports = service;

if (require.main === module) { service.run(); }
