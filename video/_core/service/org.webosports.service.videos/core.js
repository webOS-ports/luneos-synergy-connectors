/* core.js - _cloudcore/node, found where it is installed or in the repository.
 *
 * On the device _cloudcore sits next to the services (synergy-cloudcore puts it in
 * /usr/palm/services/_cloudcore); in the repository it is cloud/_core/service/_cloudcore. The video
 * service takes its bus, HTTP, errors and credential store from it, as the cloud connectors do.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const installed = path.join(__dirname, "../_cloudcore/node");
module.exports = require(fs.existsSync(installed) ? installed
	: path.join(__dirname, "../../../../cloud/_core/service/_cloudcore/node"));
