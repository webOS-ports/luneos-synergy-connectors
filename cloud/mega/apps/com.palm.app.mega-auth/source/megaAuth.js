/*global enyo, console */
/*
 * MegaAuth - customUI account validator for the MEGA connector. EMAIL + PASSWORD: Mega has no
 * OAuth, so the user types their Mega email and password and taps Sign In. The service's `login`
 * command runs the us0/us handshake (all crypto on-device) and returns
 *   { returnValue, username, alias?, credentials:{common:{accessToken, mk, email}} }
 * to Accounts. The password is used only to derive keys locally and is never stored or sent in
 * the clear. If the account has two-factor auth, `login` replies MEGA_MFA_REQUIRED and we reveal
 * a 6-digit code field, then retry with it.
 */
enyo.kind({
	name: "MegaAuth",
	kind: enyo.VFlexBox,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Image", name: "headerIcon", className: "accounts-header-icon", showing: false },
			{ kind: "Control", name: "title", content: "MEGA Account" }
		]},
		{ name: "svc", kind: "PalmService", onFailure: "svcFailure" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", style: "padding:16px;", components: [
				{ className: "accounts-body-text", style: "line-height:1.5; padding-bottom:10px;",
					content: "Sign in with your MEGA email and password. Your password stays on the device — it is only used to unlock your encrypted files." },
				{ kind: "Input", name: "emailField", hint: "MEGA email address",
					type: "email", autoCapitalize: "lowercase", spellcheck: false, style: "width:100%;" },
				{ kind: "Input", name: "passwordField", hint: "Password",
					type: "password", spellcheck: false, style: "width:100%; margin-top:8px;" },
				{ name: "mfaRow", showing: false, components: [
					{ className: "accounts-body-text", style: "line-height:1.5; padding-top:10px;",
						content: "Enter the 6-digit code from your authenticator app:" },
					{ kind: "Input", name: "mfaField", hint: "2FA code",
						type: "tel", style: "width:100%; margin-top:4px;" }
				]},
				{ name: "status", className: "accounts-body-text", style: "padding-top:10px; color:#b00000;" }
			]}
		]},
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ name: "signInButton", kind: "Button", caption: "Sign In",
				className: "enyo-button-dark accounts-btn", onclick: "signInTap" },
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
		// Re-auth (mode:"modify") passes the account but no template; derive from the capability
		// provider implementation so re-signing-in a broken account still works.
		if (!this.serviceUri && this.params.account && this.params.account.capabilityProviders) {
			var cps = this.params.account.capabilityProviders;
			for (var i = 0; i < cps.length; i++) {
				if (cps[i] && cps[i].implementation) { this.serviceUri = cps[i].implementation; break; }
			}
		}
		if (this.serviceUri && this.serviceUri.charAt(this.serviceUri.length - 1) !== "/") {
			this.serviceUri += "/";
		}
		if (this.serviceUri) { this.$.svc.setService(this.serviceUri); }
		if (tmpl.loc_name) { this.$.title.setContent(tmpl.loc_name); }
		var iconPath = tmpl.icon && (tmpl.icon.loc_48x48 || tmpl.icon.loc_32x32);
		if (iconPath) { this.$.headerIcon.setSrc(iconPath); this.$.headerIcon.setShowing(true); }
		// A re-auth may prefill the known email.
		if (this.params.account && this.params.account.username) {
			this.$.emailField.setValue(this.params.account.username);
		}
		this.log("mega-auth: launch params " + enyo.json.stringify(this.params));
	},

	signInTap: function () {
		if (this.done) { return; }
		var email = (this.$.emailField.getValue() || "").replace(/^\s+|\s+$/g, "");
		var password = this.$.passwordField.getValue() || "";
		if (!email || !password) { this.$.status.setContent("Please enter your email and password."); return; }
		if (!this.serviceUri) { this.finish({ returnValue: false, errorCode: "NO_SERVICE" }); return; }
		var payload = { email: email, password: password };
		var mfa = this.$.mfaRow.getShowing() ? (this.$.mfaField.getValue() || "").replace(/\s+/g, "") : "";
		if (mfa) { payload.mfa = mfa; }
		this.$.status.setContent("Signing in…");
		this.$.signInButton.setDisabled(true);
		this.$.svc.call(payload, { method: "login", onSuccess: "authSuccess", onFailure: "authFailed" });
	},

	authFailed: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.signInButton.setDisabled(false);
		var code = inResponse && inResponse.errorCode;
		if (code === "MEGA_MFA_REQUIRED") {
			this.$.mfaRow.setShowing(true);
			this.$.status.setContent("This account has two-factor authentication — enter the code above.");
		} else if (code === "MEGA_BAD_CREDENTIALS") {
			this.$.status.setContent("Wrong email or password. Please try again.");
		} else {
			this.$.status.setContent("Sign-in failed. Please check your connection and try again.");
		}
		this.log("mega-auth: login failed " + enyo.json.stringify(inResponse));
	},

	// login succeeded -> return credentials to Accounts (tag with template on create).
	authSuccess: function (inSender, inResponse) {
		if (this.params && this.params.template) {
			inResponse.templateId = this.params.template.templateId;
			inResponse.template   = this.params.template;
		}
		this.finish(inResponse);
	},

	svcFailure: function (inSender, inResponse) {
		if (this.done) { return; }
		this.$.signInButton.setDisabled(false);
		this.finish({ returnValue: false, errorCode: "SERVICE_UNAVAILABLE", detail: inResponse });
	},

	cancel: function () {
		if (this.done) { return; }
		this.finish({});   // empty result => cancelled
	},

	finish: function (result) {
		this.done = true;
		this.log("mega-auth: sending result " + enyo.json.stringify(result));
		this.$.xresult.sendResult(result);
	}
});
