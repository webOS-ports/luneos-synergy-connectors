/*global enyo, console */
/*
 * KdriveAuth - customUI account validator for the kDrive connector. TOKEN-ONLY: the user pastes
 * a personal Infomaniak API token (manager.infomaniak.com -> Profile -> API tokens, "Drive"
 * scope) and taps Connect. The service's verifyToken validates the token and, from it alone,
 * auto-discovers the account_id + drive_id, returning
 *   { returnValue, credentials:{common:{accessToken, accountId, driveId}}, username, template }
 * to Accounts.
 *
 * There is deliberately NO OAuth path: Infomaniak's OAuth/OIDC login only grants identity scopes
 * (openid/profile/email/phone) and rejects the `drive` scope (invalid_scope, verified), so an
 * OAuth token cannot reach the kDrive API. The personal API token is the only credential that
 * works - hence a single-field screen rather than the dual-mode chooser.
 */
enyo.kind({
	name: "KdriveAuth",
	kind: enyo.VFlexBox,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Control", name: "title", content: "kDrive Account" }
		]},
		// svc.service is set at runtime from the template (see create()).
		{ name: "svc", kind: "PalmService", onFailure: "svcFailure" },
		{ name: "appLaunch", kind: "PalmService", service: "palm://com.palm.applicationManager/",
			method: "launch" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", style: "padding:16px;", components: [
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:6px;",
					content: "To connect kDrive you need a personal API token:" },
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:4px;",
					content: "1. On a computer, open manager.infomaniak.com and go to Profile → API tokens (manager.infomaniak.com/v3/ng/profile/user/token/list)." },
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:4px;",
					content: "2. Create a token, choose the scope “Drive”, and copy it." },
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:10px;",
					content: "3. Paste the token below and tap Connect — your kDrive is found automatically." },
				{ name: "getTokenButton", kind: "Button", caption: "Open token page in browser",
					className: "accounts-toolbar-btn", style: "margin-bottom:10px;", onclick: "openTokenPage" },
				{ kind: "Input", name: "tokenField", hint: "Paste API token", style: "width:100%;" },
				{ name: "status", className: "accounts-body-text", style: "padding-top:10px; color:#b00000;" }
			]}
		]},
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ name: "connectButton", kind: "Button", caption: "Connect",
				className: "enyo-button-dark accounts-btn", onclick: "verifyTokenTap" },
			{ kind: "Button", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
		]},
		{ name: "xresult", kind: "enyo.CrossAppResult" }
	],

	create: function () {
		this.inherited(arguments);
		this.done = false;
		this.params = enyo.windowParams || {};
		var tmpl = this.params.template || {};
		// Service URI from the template validator address ("palm://com.palm.service.kdrive/verifyToken").
		var addr = (tmpl.validator && tmpl.validator.address) || "";
		this.serviceUri = addr.replace(/verifyToken\/*$/, "");
		if (this.serviceUri && this.serviceUri.charAt(this.serviceUri.length - 1) !== "/") {
			this.serviceUri += "/";
		}
		if (this.serviceUri) { this.$.svc.setService(this.serviceUri); }
		if (tmpl.loc_name) { this.$.title.setContent(tmpl.loc_name); }
		this.log("kdrive-auth: launch params " + enyo.json.stringify(this.params));
		if (!this.serviceUri) { this.log("kdrive-auth: no service in template.validator.address"); }
	},

	// Open the Infomaniak API-token page in the device browser, so the user can create the
	// token and copy it there, then paste it into the field below (avoids typing 80+ chars).
	openTokenPage: function () {
		this.$.appLaunch.call({
			id: "com.palm.app.browser",
			params: { target: "https://manager.infomaniak.com/v3/ng/profile/user/token/list" }
		});
	},

	verifyTokenTap: function () {
		if (this.done) { return; }
		var token = (this.$.tokenField.getValue() || "").replace(/^\s+|\s+$/g, "");
		if (!token) { this.$.status.setContent("Please paste your API token."); return; }
		if (!this.serviceUri) { this.finish({ returnValue: false, errorCode: "NO_SERVICE" }); return; }
		this.$.status.setContent("");
		this.$.connectButton.setDisabled(true);
		this.$.svc.call({ token: token }, {
			method: "verifyToken",
			onSuccess: "authSuccess",
			onFailure: "tokenFailed"
		});
	},

	tokenFailed: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		this.$.status.setContent("That token didn't work — check it has the ‘Drive’ scope and try again.");
		this.log("kdrive-auth: verifyToken failed " + enyo.json.stringify(inResponse));
	},

	// verifyToken succeeded -> return credentials to Accounts (tag with template on create).
	authSuccess: function (inSender, inResponse) {
		if (this.params && this.params.template) {
			inResponse.templateId = this.params.template.templateId;
			inResponse.template   = this.params.template;
		}
		this.finish(inResponse);
	},

	svcFailure: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.connectButton.setDisabled(false);
		this.finish({ returnValue: false, errorCode: "SERVICE_UNAVAILABLE", detail: inResponse });
	},

	cancel: function () {
		if (this.done) { return; }
		this.finish({});   // empty result => cancelled
	},

	finish: function (result) {
		this.done = true;
		this.log("kdrive-auth: sending result " + enyo.json.stringify(result));
		this.$.xresult.sendResult(result);
	}
});
