/*global enyo */
/*
 * PiGallery2Auth - customUI account validator for the PiGallery2 connector. Collects the server's
 * address, the user name and the password, and calls com.palm.service.pigallery2/login, which
 * checks them and returns the account. PiGallery2 has no tokens of its own, so the account keeps
 * the password, as WebDAV's does. A gallery that needs no sign-in takes an empty user name and
 * password. No OAuth, no webview: the same shape as cloud/photoprism's form.
 */
enyo.kind({
	name: "PiGallery2Auth",
	kind: enyo.VFlexBox,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Image", name: "headerIcon", className: "accounts-header-icon", showing: false },
			{ kind: "Control", name: "title", content: "PiGallery2" }
		]},
		{ name: "svc", kind: "PalmService", onFailure: "svcFailure" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", style: "padding:16px;", components: [
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:10px;",
					content: "Connect your PiGallery2 server: its folders, and the folders in them, show up in Photos as albums. " +
						"The password is kept with the account on this device. " +
						"Leave the user name and password empty for a gallery that needs no sign-in." },
				{ kind: "Input", name: "serverField", hint: "Server (e.g. gallery.example.org, or http://192.168.1.5)",
					spellcheck: false, autoCapitalize: "lowercase", style: "width:100%;" },
				{ kind: "Input", name: "userField", hint: "User name",
					spellcheck: false, autoCapitalize: "lowercase", style: "width:100%; margin-top:8px;" },
				{ kind: "PasswordInput", name: "passwordField", hint: "Password",
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
			this.serviceUri = "palm://com.palm.service.pigallery2/";
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
		if (!payload.server) {
			this.$.status.setContent("Please fill in the server."); return;
		}
		if (!payload.username !== !payload.password) {
			this.$.status.setContent("Please fill in both the user name and the password, or neither."); return;
		}
		if (!this.serviceUri) { this.finish({ returnValue: false, errorCode: "NO_SERVICE" }); return; }
		this.$.status.setContent("Connecting…");
		this.$.connectButton.setDisabled(true);
		this.$.svc.call(payload, { method: "login", onSuccess: "authSuccess", onFailure: "authFailed" });
	},

	// The service's errorText says what is wrong (no gallery there, the password refused, a
	// gallery that wants a sign-in); it holds no password.
	authFailed: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		var why = (inResponse && (inResponse.errorText || inResponse.errorCode)) || "";
		this.$.status.setContent("Could not connect" + (why ? ": " + why : " — check the server, user name and password."));
		this.log("pigallery2-auth: login failed " + (inResponse && inResponse.errorCode));
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
		this.log("pigallery2-auth: sending result returnValue=" + (result && result.returnValue) +
			(result && result.errorCode ? " errorCode=" + result.errorCode : ""));
		this.$.xresult.sendResult(result);
	}
});
