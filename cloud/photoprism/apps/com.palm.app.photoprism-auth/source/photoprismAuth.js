/*global enyo */
/*
 * PhotoPrismAuth - customUI account validator for the PhotoPrism connector. Collects the server's
 * address, the user name and the password (or an app password made in PhotoPrism), and calls
 * com.palm.service.photoprism/login, which signs in and stores an app password of its own, never
 * the password. No OAuth, no webview: the same shape as cloud/immich's form.
 */
enyo.kind({
	name: "PhotoPrismAuth",
	kind: enyo.VFlexBox,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Image", name: "headerIcon", className: "accounts-header-icon", showing: false },
			{ kind: "Control", name: "title", content: "PhotoPrism" }
		]},
		{ name: "svc", kind: "PalmService", onFailure: "svcFailure" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", style: "padding:16px;", components: [
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:10px;",
					content: "Connect your PhotoPrism server: its albums and folders show up in Photos. " +
						"Your password is used once to make an app password for this device, which is all that is kept. " +
						"With two-factor sign-in, make an app password in PhotoPrism (Settings → Account → Apps and Devices) and enter that instead." },
				{ kind: "Input", name: "serverField", hint: "Server (e.g. photos.example.org, or http://192.168.1.5:2342)",
					spellcheck: false, autoCapitalize: "lowercase", style: "width:100%;" },
				{ kind: "Input", name: "userField", hint: "User name",
					spellcheck: false, autoCapitalize: "lowercase", style: "width:100%; margin-top:8px;" },
				{ kind: "PasswordInput", name: "passwordField", hint: "Password or app password",
					spellcheck: false, style: "width:100%; margin-top:8px;" },
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
			this.serviceUri = "palm://com.palm.service.photoprism/";
		}
		if (this.serviceUri && this.serviceUri.charAt(this.serviceUri.length - 1) !== "/") { this.serviceUri += "/"; }
		if (this.serviceUri) { this.$.svc.setService(this.serviceUri); }
		if (tmpl.loc_name) { this.$.title.setContent(tmpl.loc_name); }
		var iconPath = tmpl.icon && (tmpl.icon.loc_48x48 || tmpl.icon.loc_32x32);
		if (iconPath) { this.$.headerIcon.setSrc(iconPath); this.$.headerIcon.setShowing(true); }
	},

	connectTap: function () {
		if (this.done) { return; }
		var trim = function (s) { return (s || "").replace(/^\s+|\s+$/g, ""); };
		var payload = {
			server:   trim(this.$.serverField.getValue()),
			username: trim(this.$.userField.getValue()),
			password: this.$.passwordField.getValue() || ""
		};
		if (!payload.server || !payload.username || !payload.password) {
			this.$.status.setContent("Please fill in the server, user name and password."); return;
		}
		if (!this.serviceUri) { this.finish({ returnValue: false, errorCode: "NO_SERVICE" }); return; }
		this.$.status.setContent("Connecting…");
		this.$.connectButton.setDisabled(true);
		this.$.svc.call(payload, { method: "login", onSuccess: "authSuccess", onFailure: "authFailed" });
	},

	// The service's errorText says what is wrong (no server there, the password refused, two-factor
	// sign-in on); it holds no password.
	authFailed: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		var why = (inResponse && (inResponse.errorText || inResponse.errorCode)) || "";
		this.$.status.setContent("Could not connect" + (why ? ": " + why : " — check the server, user name and password."));
		this.log("photoprism-auth: login failed " + (inResponse && inResponse.errorCode));
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
		// The result holds the app password: log only how it ended.
		this.log("photoprism-auth: sending result returnValue=" + (result && result.returnValue) +
			(result && result.errorCode ? " errorCode=" + result.errorCode : ""));
		this.$.xresult.sendResult(result);
	}
});
