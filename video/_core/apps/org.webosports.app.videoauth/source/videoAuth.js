/*global enyo */
/*
 * VideoAuth - customUI validator for the video account types (org.webosports.video.*), which
 * org.webosports.service.videos serves to Videos. What it asks for depends on the template:
 *
 *   jellyfin  server address, user name, password
 *   peertube  an instance: typed, or picked from the healthy, non-NSFW instances the directory
 *             (instances.joinpeertube.org) lists, searchable by name
 *   upnp      nothing: one tap adds the media servers on the local network
 *   plex      a code from plex.tv (plexPin), entered at plex.tv/link on any device; the app asks
 *             login until the code is linked or runs out. Or, for a server that lets the network
 *             in without signing in, its address and, if wanted, a token.
 *   m3u       Free TV: one of Free-TV/IPTV's lists (m3uCatalogs), the phone's country picked to
 *             begin with; or "My own playlist": its web address (an IPTV service's list holds its
 *             password: shown as typed, never logged) and, if wanted, a name for it
 *
 * Every kind calls org.webosports.service.videos/login with the templateId and what was typed; the
 * service checks it against the server and answers the account (username, alias, credentials),
 * which goes back to Accounts through CrossAppResult. Nothing typed here is logged.
 */
// enyo 0.10 sets content as HTML: escape what a server or the directory sent.
function esc(s) {
	return String(s === undefined || s === null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

enyo.kind({
	name: "VideoAuth",
	kind: enyo.VFlexBox,
	className: "enyo-bg",

	kinds: {
		jellyfin: {
			fields: ["server", "username", "password"],
			text: "Watch your Jellyfin server's films and series in Videos. Enter the address you open Jellyfin at " +
				"(for example jellyfin.example.org or 192.168.1.10:8096) and your Jellyfin user.",
			button: "Sign In"
		},
		peertube: {
			fields: ["server"],
			instances: true,
			text: "Watch a PeerTube instance's public videos in Videos. Pick an instance below or type its address.",
			button: "Add"
		},
		upnp: {
			fields: [],
			text: "Videos will show every UPnP/DLNA media server on this network (MiniDLNA, a NAS, Plex or Jellyfin " +
				"with DLNA on, ...). There is nothing to sign in to.",
			button: "Add"
		},
		m3u: {
			fields: ["url", "name"],
			catalogs: true,
			text: "Watch TV channels in Videos: the free channels of a country from Free TV, or your own M3U " +
				"playlist - the list an IPTV service gives you, or any playlist of streams on the web.",
			ownText: "Enter the playlist's address as the service gives it.",
			button: "Add"
		},
		plex: {
			fields: [],
			pin: true,
			text: "Watch the films and series of your Plex servers, and of the servers shared with you, in Videos. " +
				"Tap Get a Code, then go to plex.tv/link on a computer or another phone, sign in to Plex and enter the code.",
			button: "Get a Code"
		}
	},
	// How often to ask whether the Plex code was entered.
	pinPollMs: 3000,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ name: "headerIcon", kind: "Image", style: "width:32px; height:32px; vertical-align:middle; margin-right:6px;" },
			{ kind: "Control", name: "title", content: "Video Account" }
		]},
		{ className: "accounts-header-shadow" },
		{ name: "svc", kind: "PalmService", service: "palm://org.webosports.service.videos/", onFailure: "svcFailure" },
		{ name: "catalogs", kind: "PalmService", service: "palm://org.webosports.service.videos/", method: "m3uCatalogs",
			onSuccess: "gotCatalogs", onFailure: "noCatalogs" },
		{ name: "prefs", kind: "PalmService", service: "palm://com.palm.systemservice/", method: "getPreferences",
			onSuccess: "gotRegion", onFailure: "noRegion" },
		{ name: "dir", kind: "PalmService", service: "palm://org.webosports.service.videos/", method: "searchPeerTubeInstances",
			onSuccess: "gotInstances", onFailure: "noInstances" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", components: [
				{ name: "bodyText", className: "accounts-body-text videoauth-note" },
				{ name: "serverGroup", kind: "RowGroup", caption: "SERVER", className: "accounts-group", showing: false, components: [
					{ kind: "Input", name: "server", spellcheck: false, autocorrect: false, autoWordComplete: false,
						autoCapitalize: "lowercase", hint: "Address" }
				]},
				{ name: "catalogGroup", kind: "RowGroup", caption: "CHANNELS", className: "accounts-group", showing: false, components: [
					{ kind: "ListSelector", name: "catalogPicker", value: "own", onChange: "catalogChanged",
						items: [{ caption: "My own playlist", value: "own" }] }
				]},
				{ name: "catalogNote", showing: false, className: "videoauth-note", content: "" },
				{ name: "urlGroup", kind: "RowGroup", caption: "PLAYLIST ADDRESS", className: "accounts-group", showing: false, components: [
					{ kind: "Input", name: "url", spellcheck: false, autocorrect: false, autoWordComplete: false,
						autoCapitalize: "none", hint: "http://iptv.example.com/playlist.m3u" }
				]},
				{ name: "nameGroup", kind: "RowGroup", caption: "NAME (OPTIONAL)", className: "accounts-group", showing: false, components: [
					{ kind: "Input", name: "listName", autoWordComplete: false, hint: "My TV" }
				]},
				{ name: "usernameGroup", kind: "RowGroup", caption: "USER NAME", className: "accounts-group", showing: false, components: [
					{ kind: "Input", name: "username", spellcheck: false, autocorrect: false, autoWordComplete: false,
						autoCapitalize: "lowercase", hint: "User name" }
				]},
				{ name: "passwordGroup", kind: "RowGroup", caption: "PASSWORD", className: "accounts-group", showing: false, components: [
					{ kind: "PasswordInput", name: "password", autoWordComplete: false, hint: "Password (may be empty)" }
				]},
				{ name: "tokenGroup", kind: "RowGroup", caption: "TOKEN (OPTIONAL)", className: "accounts-group", showing: false, components: [
					{ kind: "PasswordInput", name: "token", autoWordComplete: false, hint: "Only if the server asks for one" }
				]},
				{ name: "pinBox", showing: false, className: "videoauth-pin", components: [
					{ name: "pinCode", className: "videoauth-pin-code" },
					{ name: "pinText", className: "videoauth-note" }
				]},
				{ name: "errorBox", showing: false, style: "padding:8px 16px;", components: [
					{ name: "errorMessage", className: "enyo-text-error" }
				]},
				{ name: "primaryButton", kind: "ActivityButton", caption: "Sign In", className: "enyo-button-dark accounts-btn",
					onclick: "primaryTap" },
				{ name: "addressLink", showing: false, className: "videoauth-link", content: "Enter a server address instead",
					onclick: "addressTap" },
				{ name: "removeAccountButton", kind: "Accounts.RemoveAccount", className: "accounts-btn", showing: false,
					style: "padding-top:6px;", onAccountsRemove_Done: "removeDone" },
				{ name: "instanceGroup", kind: "RowGroup", caption: "PEERTUBE INSTANCES", className: "accounts-group", showing: false, components: [
					{ kind: "Input", name: "instanceSearch", hint: "Search instances", spellcheck: false, autocorrect: false,
						autoWordComplete: false, changeOnInput: true, onchange: "instanceSearchChanged" },
					{ name: "instanceStatus", className: "videoauth-instance-info", style: "padding:6px 4px;" },
					{ name: "instanceList", kind: "VirtualRepeater", onSetupRow: "setupInstance", components: [
						{ kind: "Item", className: "videoauth-instance", onclick: "instanceTap", components: [
							{ name: "instanceName", className: "videoauth-instance-name" },
							{ name: "instanceInfo", className: "videoauth-instance-info" }
						]}
					]}
				]}
			]}
		]},
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ kind: "Button", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
		]},
		{ kind: "CrossAppResult" }
	],

	create: function () {
		this.inherited(arguments);
		this.done = false;
		this.instances = [];
		var p = enyo.windowParams || {};
		this.template = p.template || null;
		this.templateId = (this.template && this.template.templateId) || p.templateId || "org.webosports.video.upnp";
		this.kindId = this.templateId.split(".").pop();
		var k = this.kinds[this.kindId] || this.kinds.upnp;
		this.k = k;
		this.$.title.setContent((this.template && this.template.loc_name) || "Video Account");
		this.$.headerIcon.setSrc("images/connectors/" + (this.kinds[this.kindId] ? this.kindId : "upnp") + ".png");
		this.$.bodyText.setContent(k.text);
		this.$.primaryButton.setCaption(k.button);
		this.$.serverGroup.setShowing(k.fields.indexOf("server") >= 0);
		this.$.usernameGroup.setShowing(k.fields.indexOf("username") >= 0);
		this.$.passwordGroup.setShowing(k.fields.indexOf("password") >= 0);
		this.$.urlGroup.setShowing(k.fields.indexOf("url") >= 0);
		this.$.nameGroup.setShowing(k.fields.indexOf("name") >= 0);
		if (this.kindId === "peertube") { this.$.server.setHint("peertube.example.org"); }
		if (this.kindId === "jellyfin") { this.$.server.setHint("jellyfin.example.org or 192.168.1.10:8096"); }
		if (this.kindId === "plex") { this.$.server.setHint("192.168.1.10 or plex.example.org:32400"); }
		this.$.addressLink.setShowing(!!k.pin);
		this.addressMode = false;
		var account = p.account;
		if (account && (account._id || account.id)) {
			try { this.$.removeAccountButton.init(account); this.$.removeAccountButton.show(); } catch (e) { this.log("videoauth: no remove button: " + e); }
		}
		if (k.instances) {
			this.$.instanceGroup.show();
			this.loadInstances("");
		}
		if (k.catalogs) {
			// The address fields until the lists and the phone's country are in.
			this.catalogList = null;
			this.region = undefined;
			this.$.catalogGroup.show();
			this.$.catalogs.call({});
			this.$.prefs.call({ keys: ["region", "locale"] });
		}
	},

	// --- M3U: Free TV's lists, or the user's own ---
	gotCatalogs: function (inSender, r) {
		this.catalogList = (r && r.catalogs) || [];
		this.catalogSource = (r && r.source) || null;
		this.showCatalogs();
	},
	noCatalogs: function () {
		this.catalogList = [];
		this.showCatalogs();
	},
	// The region the phone is set to ("nl"), else the locale's country.
	gotRegion: function (inSender, r) {
		var c = (r && r.region && r.region.countryCode) || (r && r.locale && r.locale.countryCode) || "";
		this.region = String(c).toUpperCase();
		this.showCatalogs();
	},
	noRegion: function () {
		this.region = "";
		this.showCatalogs();
	},
	showCatalogs: function () {
		if (this.catalogList === null || this.region === undefined) { return; }
		var items = this.catalogList.map(function (c) { return { caption: "Free TV – " + c.name, value: c.id }; });
		items.push({ caption: "My own playlist", value: "own" });
		this.$.catalogPicker.setItems(items);
		var mine = null, all = null;
		for (var i = 0; i < this.catalogList.length; i++) {
			var c = this.catalogList[i];
			if (this.region && c.region === this.region) { mine = c.id; }
			if (c.id === "freetv:all") { all = c.id; }
		}
		this.$.catalogPicker.setValue(mine || all || "own");
		this.catalogChanged();
	},
	catalogChanged: function () {
		var own = this.$.catalogPicker.getValue() === "own";
		this.$.urlGroup.setShowing(own);
		this.$.nameGroup.setShowing(own);
		var src = this.catalogSource;
		this.$.catalogNote.setContent(own ? esc(this.k.ownText)
			: "Channels that are free to watch in their country, from the " + esc(src ? src.name : "Free-TV") +
				" lists (" + esc(src ? src.link.replace(/^https?:\/\//, "") : "github.com/Free-TV/IPTV") + "). " +
				"Some play only in their own country.");
		this.$.catalogNote.show();
		this.showError("");
	},

	// --- PeerTube instances ---
	loadInstances: function (query) {
		this.$.instanceStatus.setContent("Looking for instances…");
		this.$.dir.call({ query: query || "" });
	},
	instanceSearchChanged: function () {
		if (this.searchTimer) { window.clearTimeout(this.searchTimer); }
		var q = this.$.instanceSearch.getValue();
		this.searchTimer = window.setTimeout(enyo.bind(this, function () { this.loadInstances(q); }), 500);
	},
	gotInstances: function (inSender, r) {
		this.instances = (r && r.instances) || [];
		this.$.instanceStatus.setContent(this.instances.length ? "" : "No instances found. You can still type an address above.");
		this.$.instanceList.render();
	},
	noInstances: function () {
		this.instances = [];
		this.$.instanceStatus.setContent("The instance list cannot be reached now. You can still type an address above.");
		this.$.instanceList.render();
	},
	setupInstance: function (inSender, i) {
		var it = this.instances[i];
		if (!it) { return false; }
		this.$.instanceName.setContent(esc(it.name) + " – " + esc(it.host));
		this.$.instanceInfo.setContent(esc((it.description || "") + (it.videos ? " (" + it.videos + " videos)" : "")));
		return true;
	},
	instanceTap: function (inSender, inEvent) {
		var it = this.instances[inEvent.rowIndex];
		if (it) { this.$.server.setValue(it.host); this.primaryTap(); }
	},

	// --- Plex: a code from plex.tv, or an address ---
	addressTap: function () {
		if (this.busy || this.done) { return; }
		this.stopPin();
		this.addressMode = true;
		this.$.addressLink.hide();
		this.$.pinBox.hide();
		this.$.serverGroup.show();
		this.$.tokenGroup.show();
		this.$.bodyText.setContent("For a Plex server that lets this network in without signing in " +
			"(Settings, Network, \"allowed without auth\"). Enter its address, and a token only if it needs one.");
		this.$.primaryButton.setCaption("Add");
		this.showError("");
	},
	getPin: function () {
		this.stopPin();
		this.busy = true;
		this.$.primaryButton.setActive(true);
		this.$.primaryButton.setDisabled(true);
		this.showError("");
		this.$.svc.call({}, { method: "plexPin", onSuccess: "gotPin", onFailure: "pinFailure" });
	},
	gotPin: function (inSender, r) {
		if (this.done) { return; }
		this.busy = false;
		this.$.primaryButton.setActive(false);
		this.$.primaryButton.setDisabled(false);
		this.$.primaryButton.setCaption("Get a New Code");
		this.pin = { pinId: r.pinId, clientId: r.clientId, until: Date.now() + (r.expiresIn || 900) * 1000 };
		this.$.pinCode.setContent(esc(r.code));
		this.$.pinText.setContent("Go to " + esc(r.linkUrl || "plex.tv/link") + ", sign in to Plex and enter this code. " +
			"This screen goes on by itself once you have.");
		this.$.pinBox.show();
		this.schedulePinCheck();
	},
	pinFailure: function (inSender, r) {
		this.busy = false;
		this.$.primaryButton.setActive(false);
		this.$.primaryButton.setDisabled(false);
		this.showError((r && r.errorText) || "plex.tv cannot be reached. Check the network.");
	},
	schedulePinCheck: function () {
		this.pinTimer = window.setTimeout(enyo.bind(this, "checkPin"), this.pinPollMs);
	},
	checkPin: function () {
		this.pinTimer = null;
		if (this.done || !this.pin) { return; }
		if (Date.now() > this.pin.until) {
			this.stopPin();
			this.$.pinBox.hide();
			this.$.primaryButton.setCaption("Get a Code");
			this.showError("The code ran out before it was entered. Get a new one.");
			return;
		}
		this.$.svc.call({ templateId: this.templateId, pinId: this.pin.pinId, clientId: this.pin.clientId },
			{ method: "login", onSuccess: "pinLinked", onFailure: "pinNotYet" });
	},
	pinLinked: function (inSender, r) {
		this.stopPin();
		this.loginSuccess(inSender, r);
	},
	// Not entered yet, or a network hiccup while waiting: keep asking. Anything else is the answer.
	pinNotYet: function (inSender, r) {
		if (this.done || !this.pin) { return; }
		if (!r || r.errorCode === "NOT_LINKED" || r.errorCode === "SERVER_UNREACHABLE" || r.errorCode === "TIMEOUT") {
			this.schedulePinCheck();
			return;
		}
		this.stopPin();
		this.showError(r.errorText || "Plex did not sign you in.");
		this.log("videoauth: plex login failed " + r.errorCode);
	},
	stopPin: function () {
		if (this.pinTimer) { window.clearTimeout(this.pinTimer); }
		this.pinTimer = null;
		this.pin = null;
	},

	// --- sign-in ---
	primaryTap: function () {
		if (this.done || this.busy) { return; }
		if (this.k.pin && !this.addressMode) { this.getPin(); return; }
		var trim = function (s) { return (s || "").replace(/^\s+|\s+$/g, ""); };
		var payload = { templateId: this.templateId };
		var f = this.k.fields;
		if (this.k.catalogs && this.$.catalogPicker.getValue() !== "own") {
			payload.catalog = this.$.catalogPicker.getValue();
			f = [];
		}
		if (f.indexOf("server") >= 0) { payload.server = trim(this.$.server.getValue()); }
		if (f.indexOf("username") >= 0) { payload.username = trim(this.$.username.getValue()); }
		if (f.indexOf("password") >= 0) { payload.password = this.$.password.getValue() || ""; }
		if (f.indexOf("url") >= 0) { payload.url = trim(this.$.url.getValue()); }
		if (f.indexOf("name") >= 0) { payload.name = trim(this.$.listName.getValue()); }
		if (this.addressMode) {
			f = ["server"];
			payload.server = trim(this.$.server.getValue());
			payload.token = trim(this.$.token.getValue());
		}
		if (f.indexOf("url") >= 0 && !payload.url) {
			this.showError("Enter the playlist's address.");
			return;
		}
		if ((f.indexOf("server") >= 0 && !payload.server) || (f.indexOf("username") >= 0 && !payload.username)) {
			this.showError(f.indexOf("username") >= 0 ? "Enter the server's address and your user name." : "Enter the address.");
			return;
		}
		this.showError("");
		this.busy = true;
		this.$.primaryButton.setActive(true);
		this.$.primaryButton.setDisabled(true);
		this.$.svc.call(payload, { method: "login", onSuccess: "loginSuccess", onFailure: "loginFailure" });
	},
	loginSuccess: function (inSender, r) {
		this.busy = false;
		this.finish({ returnValue: true, templateId: this.templateId, template: this.template,
			username: r.username, alias: r.alias, config: r.config || {}, credentials: r.credentials });
	},
	// The service's errorText says what is wrong; it holds no password.
	loginFailure: function (inSender, r) {
		this.busy = false;
		this.$.primaryButton.setActive(false);
		this.$.primaryButton.setDisabled(false);
		this.showError((r && r.errorText) || "Could not connect. Check the address and the network.");
		this.log("videoauth: login failed " + (r && r.errorCode));
	},
	svcFailure: function () {
		this.busy = false;
		this.$.primaryButton.setActive(false);
		this.$.primaryButton.setDisabled(false);
		this.showError("The video service does not answer.");
	},
	showError: function (s) {
		this.$.errorMessage.setContent(s ? esc(s) : "");
		this.$.errorBox.setShowing(!!s);
	},

	removeDone: function () { this.$.crossAppResult.sendResult({ returnValue: false }); },
	cancel: function () { this.finish({ returnValue: false }); },
	finish: function (result) {
		if (this.done) { return; }
		this.done = true;
		this.stopPin();
		// The result holds credentials: log only how it ended.
		this.log("videoauth: result returnValue=" + (result && result.returnValue));
		try { this.$.crossAppResult.sendResult(result); } catch (e) { this.log("videoauth: sendResult threw " + e); }
	}
});
