/* Emby, as a provider of org.webosports.service.videos (see videos.js there for the API).
 *
 * Emby and Jellyfin share their API (Jellyfin began as a fork of Emby), so this is Jellyfin's
 * provider with Emby's differences (EMBY in video/jellyfin/provider: the calls under
 * /Users/{userId}/, api_key in links, the web app's address, how the server says what it is).
 * Checked against Emby Server 4.10.2.0 (2026-11-04).
 *
 * Credentials (credentials.common): as Jellyfin's.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// providers/jellyfin.js beside this file on the device; video/jellyfin/provider in the repository.
const installed = path.join(__dirname, "jellyfin.js");
const jellyfin = require(fs.existsSync(installed) ? installed : path.join(__dirname, "../../jellyfin/provider"));

module.exports = jellyfin.createProvider(jellyfin.EMBY);
