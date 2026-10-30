/*global enyo */
/*
 * ImmichAuth - customUI account validator for the Immich connector. Collects the server's
 * address and an API key the user made in Immich (Account Settings -> API Keys), and calls
 * com.palm.service.immich/login, which checks them before Accounts stores the account. No OAuth,
 * no webview: the same shape as cloud/s3's form.
 */
enyo.kind({
	name: "ImmichAuth",
	kind: enyo.VFlexBox,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Image", name: "headerIcon", className: "accounts-header-icon", showing: false },
			{ kind: "Control", name: "title", content: "Immich" }
		]},
		{ name: "svc", kind: "PalmService", onFailure: "svcFailure" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", style: "padding:16px;", components: [
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:10px;",
					content: "Connect your Immich server. Make an API key in Immich under Account Settings → API Keys " +
						"(it needs album.read, asset.read, asset.view, asset.download and user.read) and enter it here with the server's address." },
				{ kind: "Input", name: "serverField", hint: "Server (e.g. photos.example.org, or http://192.168.1.5:2283)",
					spellcheck: false, autoCapitalize: "lowercase", style: "width:100%;" },
				{ kind: "PasswordInput", name: "keyField", hint: "API key",
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
			this.serviceUri = "palm://com.palm.service.immich/";
		}
		if (this.serviceUri && this.serviceUri.charAt(this.serviceUri.length - 1) !== "/") { this.serviceUri += "/"; }
		if (this.serviceUri) { this.$.svc.setService(this.serviceUri); }
		if (tmpl.loc_name) { this.$.title.setContent(tmpl.loc_name); }
		var iconPath = tmpl.icon && (tmpl.icon.loc_48x48 || tmpl.icon.loc_32x32);
		if (iconPath) { this.$.headerIcon.setSrc(iconPath); this.$.headerIcon.setShowing(true); }
	},

	connectTap: function () {
		if (this.done) { return; }
		var payload = {
			server: (this.$.serverField.getValue() || "").replace(/^\s+|\s+$/g, ""),
			apiKey: (this.$.keyField.getValue() || "").replace(/^\s+|\s+$/g, "")
		};
		if (!payload.server || !payload.apiKey) {
			this.$.status.setContent("Please fill in the server and the API key."); return;
		}
		if (!this.serviceUri) { this.finish({ returnValue: false, errorCode: "NO_SERVICE" }); return; }
		this.$.status.setContent("Connecting…");
		this.$.connectButton.setDisabled(true);
		this.$.svc.call(payload, { method: "login", onSuccess: "authSuccess", onFailure: "authFailed" });
	},

	// The service's errorText says what is wrong (no server there, the key refused, the key's
	// permissions); it holds no key.
	authFailed: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		var why = (inResponse && (inResponse.errorText || inResponse.errorCode)) || "";
		this.$.status.setContent("Could not connect" + (why ? ": " + why : " — check the server and the API key."));
		this.log("immich-auth: login failed " + (inResponse && inResponse.errorCode));
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
		// The result holds the API key: log only how it ended.
		this.log("immich-auth: sending result returnValue=" + (result && result.returnValue) +
			(result && result.errorCode ? " errorCode=" + result.errorCode : ""));
		this.$.xresult.sendResult(result);
	}
});
