/* config.js - the video service's wiring. A plain file read with require() by service.js and the
 * tests. */
"use strict";

var Config = {
	SERVICE_NAME: "org.webosports.service.videos",
	// The Synergy capability video accounts declare (subtype STREAMING), as music's declare "Music".
	CAPABILITY: "Video",
	// Who may browse and play: the Videos app. Its QML LunaService calls as its app id.
	APP_IDS: ["org.webosports.app.videoplayer", "org.webosports.app.videoplayer-*"],
	// The providers, by the folder they are installed in (providers/<name>.js on the device,
	// video/<name>/provider/ in the repository).
	PROVIDERS: ["jellyfin", "upnp", "peertube", "plex"],
	// How Jellyfin and Plex hear of this client.
	CLIENT_NAME: "LuneOS Videos",
	CLIENT_VERSION: "1.0.0",
};

if (typeof exports !== "undefined") { exports.Config = Config; }
