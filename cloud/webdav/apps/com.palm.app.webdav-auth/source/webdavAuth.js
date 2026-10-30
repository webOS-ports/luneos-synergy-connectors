/*global enyo */
/*
 * WebDAVAuth - customUI account validator for the WebDAV connector. Collects the kind of server
 * (WebDAV, Nextcloud, ownCloud), its address, the user name and password (an app password for
 * Nextcloud/ownCloud with two-factor sign-in) and, optionally, the folder Photos reads, and calls
 * com.palm.service.webdav/login, which checks them before Accounts stores the account. No OAuth,
 * no webview: the same shape as cloud/s3's form.
 */
enyo.kind({
	name: "WebDAVAuth",
	kind: enyo.VFlexBox,

	// Per server type: what the address field asks for, and what to say about the password.
	flavors: {
		webdav: {
			server: "WebDAV address (e.g. https://nas.local:5006/, or https://example.org/webdav/)",
			password: "Password",
			note: "Enter the address of the WebDAV folder itself."
		},
		nextcloud: {
			server: "Nextcloud server (e.g. cloud.example.org)",
			password: "App password",
			note: "Make an app password in Nextcloud under Settings → Security → Devices & sessions; " +
				"with two-factor sign-in your own password will not work here. Use the user name, not the email address, with an app password."
		},
		owncloud: {
			server: "ownCloud server (e.g. owncloud.example.org)",
			password: "App password",
			note: "Make an app password in ownCloud under Settings → Security; " +
				"with two-factor sign-in your own password will not work here."
		}
	},

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Image", name: "headerIcon", className: "accounts-header-icon", showing: false },
			{ kind: "Control", name: "title", content: "WebDAV" }
		]},
		{ name: "svc", kind: "PalmService", onFailure: "svcFailure" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", style: "padding:16px;", components: [
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:10px;",
					content: "Connect a Nextcloud, ownCloud or any WebDAV server (a NAS, Apache, rclone…). " +
						"Its files show up in Documents and Explorer, its photos in Photos." },
				{ kind: "ListSelector", name: "flavorPicker", value: "nextcloud", onChange: "flavorChanged", items: [
					{ caption: "Nextcloud", value: "nextcloud" },
					{ caption: "ownCloud", value: "owncloud" },
					{ caption: "Other WebDAV server", value: "webdav" }
				]},
				{ kind: "Input", name: "serverField", spellcheck: false, autoCapitalize: "lowercase",
					style: "width:100%; margin-top:8px;" },
				{ kind: "Input", name: "userField", hint: "User name", spellcheck: false, autoCapitalize: "lowercase",
					style: "width:100%; margin-top:8px;" },
				{ kind: "PasswordInput", name: "passwordField", spellcheck: false, style: "width:100%; margin-top:8px;" },
				{ kind: "Input", name: "photoField", hint: "Photos folder (optional, default: Photos)", spellcheck: false,
					style: "width:100%; margin-top:8px;" },
				{ name: "note", className: "accounts-body-text", style: "line-height:1.5; padding-top:10px; font-size:14px;" },
				{ name: "status", className: "accounts-body-text", style: "padding-top:10px; color:#b00000;" }
			]}
		]},
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ name: "connectButton", kind: "Button", caption: "Connect",
				className: "enyo-button-dark accounts-btn", onclick: "connectTap" },
			{ kind: "Button", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
		]},
		{ name: "xresult", kind: "enyo.CrossAppResult" }
	],

	create: function () {
		this.inherited(arguments);
		this.done = false;
		this.params = enyo.windowParams || {};
		var tmpl = this.params.template || {};
		var addr = (tmpl.validator && tmpl.validator.address) || "";
		this.serviceUri = addr.replace(/login\/*$/, "");
		if (!this.serviceUri && this.params.account && this.params.account.capabilityProviders) {
			this.serviceUri = "palm://com.palm.service.webdav/";
		}
		if (this.serviceUri && this.serviceUri.charAt(this.serviceUri.length - 1) !== "/") { this.serviceUri += "/"; }
		if (this.serviceUri) { this.$.svc.setService(this.serviceUri); }
		if (tmpl.loc_name) { this.$.title.setContent(tmpl.loc_name); }
		var iconPath = tmpl.icon && (tmpl.icon.loc_48x48 || tmpl.icon.loc_32x32);
		if (iconPath) { this.$.headerIcon.setSrc(iconPath); this.$.headerIcon.setShowing(true); }
		this.flavorChanged();
	},

	flavorChanged: function () {
		var f = this.flavors[this.$.flavorPicker.getValue()] || this.flavors.webdav;
		this.$.serverField.setHint(f.server);
		this.$.passwordField.setHint(f.password);
		this.$.note.setContent(f.note);
	},

	connectTap: function () {
		if (this.done) { return; }
		var trim = function (s) { return (s || "").replace(/^\s+|\s+$/g, ""); };
		var payload = {
			flavor:      this.$.flavorPicker.getValue(),
			server:      trim(this.$.serverField.getValue()),
			username:    trim(this.$.userField.getValue()),
			password:    this.$.passwordField.getValue() || "",
			photoFolder: trim(this.$.photoField.getValue())
		};
		if (!payload.server || !payload.username || !payload.password) {
			this.$.status.setContent("Please fill in the server, user name and password."); return;
		}
		if (!payload.photoFolder) { delete payload.photoFolder; }
		if (!this.serviceUri) { this.finish({ returnValue: false, errorCode: "NO_SERVICE" }); return; }
		this.$.status.setContent("Connecting…");
		this.$.connectButton.setDisabled(true);
		this.$.svc.call(payload, { method: "login", onSuccess: "authSuccess", onFailure: "authFailed" });
	},

	// The service's errorText says what is wrong (no server there, the password refused, no
	// WebDAV folder at that address); it holds no password.
	authFailed: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		var why = (inResponse && (inResponse.errorText || inResponse.errorCode)) || "";
		this.$.status.setContent("Could not connect" + (why ? ": " + why : " — check the server, user name and password."));
		this.log("webdav-auth: login failed " + (inResponse && inResponse.errorCode));
	},

	authSuccess: function (inSender, inResponse) {
		if (this.params && this.params.template) {
			inResponse.templateId = this.params.template.templateId;
			inResponse.template   = this.params.template;
		}
		this.finish(inResponse);
	},

	svcFailure: function () {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		this.finish({ returnValue: false, errorCode: "SERVICE_UNAVAILABLE" });
	},

	cancel: function () {
		if (this.done) { return; }
		this.finish({});
	},

	finish: function (result) {
		this.done = true;
		// The result holds the password: log only how it ended.
		this.log("webdav-auth: sending result returnValue=" + (result && result.returnValue) +
			(result && result.errorCode ? " errorCode=" + result.errorCode : ""));
		this.$.xresult.sendResult(result);
	}
});
