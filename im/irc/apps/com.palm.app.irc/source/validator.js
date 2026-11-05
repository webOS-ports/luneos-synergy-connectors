// IRC account sign-in (webOS Synergy / Accounts customUI).
//
// Loaded by the Accounts framework as a cross-app frame. It returns the account through
// enyo.CrossAppResult.sendResult; the framework creates it, the template's onCreate hands the
// config to imlibpurpleservice, and onEnabled signs in with libpurple's prpl-irc. What the fields
// become is in ircForm.js.
//
// The config only reaches imlibpurpleservice when the account is created (the template's
// onCreate). Editing an account therefore changes the password only; another server, port or
// nick is another account.

enyo.kind({
	name: "Validator",
	kind: enyo.VFlexBox,
	className: "enyo-bg",

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Image", src: "images/header-icon.png" },
			{ kind: "Control", name: "title", content: "IRC" }
		]},
		{ className: "accounts-header-shadow" },
		{ kind: "Scroller", flex: 1, components: [
			{ name: "box", className: "box-center", components: [
				{ kind: "RowGroup", caption: "SERVER", className: "accounts-group", components: [
					{ kind: "Input", name: "server", hint: "irc.libera.chat", spellcheck: false, autocorrect: false,
						autoWordComplete: false, autoCapitalize: "lowercase", oninput: "validateInput" },
					{ kind: "Input", name: "port", hint: "6697", inputType: "number", spellcheck: false,
						autoWordComplete: false, oninput: "validateInput" }
				]},
				{ kind: "Control", style: "margin:4px 16px; display:flex; align-items:center;", components: [
					{ name: "tls", kind: "CheckBox", checked: true, onChange: "tlsChanged" },
					{ kind: "Control", className: "accounts-body-text", style: "margin-left:8px;",
						content: "TLS (port 6697 on most networks)" }
				]},
				{ kind: "RowGroup", caption: "NICK", className: "accounts-group", components: [
					{ kind: "Input", name: "nick", hint: "Your nick", spellcheck: false, autocorrect: false,
						autoWordComplete: false, autoCapitalize: "lowercase", oninput: "validateInput" }
				]},
				{ kind: "RowGroup", caption: "PASSWORD (OPTIONAL)", className: "accounts-group", components: [
					{ kind: "PasswordInput", name: "password", hint: "NickServ account or server password",
						spellcheck: false, autoWordComplete: false, oninput: "validateInput" }
				]},
				{ kind: "Control", name: "saslRow", style: "margin:4px 16px; display:flex; align-items:center;", components: [
					{ name: "sasl", kind: "CheckBox", checked: true, onChange: "validateInput" },
					{ kind: "Control", className: "accounts-body-text", style: "margin-left:8px;",
						content: "Log in to my network account with SASL (off: send it as the server password)" }
				]},
				{ kind: "RowGroup", caption: "MORE (OPTIONAL)", className: "accounts-group", components: [
					{ kind: "Input", name: "saslName", hint: "Account name, if not the nick", spellcheck: false,
						autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase" },
					{ kind: "Input", name: "realName", hint: "Real name", spellcheck: false, autoWordComplete: false },
					{ kind: "Input", name: "channels", hint: "Channels to join: #webos, #luneos", spellcheck: false,
						autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase" }
				]},
				{ name: "status", className: "accounts-body-text", style: "padding:8px 16px; color:#b00000;" },
				{ className: "accounts-body-text", style: "padding:8px 16px; line-height:1.4;", allowHtml: true,
					content: "Channels are joined and left from the Servers tab in Messaging afterwards.<br><br>" +
						"IRC only delivers what is said while you are connected. To keep up while the phone " +
						"sleeps or is offline, sign in through a bouncer (ZNC, soju) instead: its host name " +
						"and port here, and the user name and password it gave you." },
				{ kind: "ActivityButton", name: "signInButton", caption: "Sign In", disabled: true, active: false,
					className: "enyo-button-dark accounts-btn", onclick: "performSignIn" },
				{ name: "removeAccountButton", kind: "Accounts.RemoveAccount", className: "accounts-btn",
					showing: false, style: "padding-top:6px;", onAccountsRemove_Done: "removeDone" }
			]}
		]},
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ kind: "Button", name: "cancelButton", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
		]},
		{ kind: "CrossAppResult" }
	],

	create: function () {
		this.inherited(arguments);
		this.handleLaunch(enyo.windowParams || {});
	},

	handleLaunch: function (params) {
		this.params = params || {};
		this.template = null;
		if (params.template && params.template.templateId === "com.palm.irc") {
			this.template = params.template;
		} else if (params.allTemplates) {
			for (var i = 0; i < params.allTemplates.length; i++) {
				if (params.allTemplates[i].templateId === "com.palm.irc") { this.template = params.allTemplates[i]; break; }
			}
		}
		this.accountId = (params.account && (params.account._id || params.account.id)) || params.accountId || null;
		this.editing = !!(params.account && params.account.username);
		if (this.accountId && params.account) {
			this.$.removeAccountButton.init(params.account);
			this.$.removeAccountButton.show();
		}
		if (this.editing) {
			var parts = IrcForm.splitUsername(params.account.username);
			var config = params.account.config || {};
			this.$.server.setValue(parts.server);
			this.$.nick.setValue(parts.nick);
			if (config.port) { this.$.port.setValue(String(config.port)); }
			if (config.ssl !== undefined) { this.$.tls.setChecked(!!config.ssl); }
			if (config.sasl !== undefined) { this.$.sasl.setChecked(!!config.sasl); }
			if (config.saslname) { this.$.saslName.setValue(config.saslname); }
			if (config.realname) { this.$.realName.setValue(config.realname); }
			if (config.channels) { this.$.channels.setValue(config.channels); }
			var fixed = ["server", "port", "tls", "nick", "sasl", "saslName", "realName", "channels"];
			for (var j = 0; j < fixed.length; j++) { this.$[fixed[j]].setDisabled(true); }
			this.$.title.setContent("IRC: " + params.account.username);
		}
		this.validateInput();
	},

	fields: function () {
		return {
			server: this.$.server.getValue(),
			port: this.$.port.getValue(),
			tls: this.$.tls.getChecked(),
			nick: this.$.nick.getValue(),
			password: this.$.password.getValue(),
			sasl: this.$.sasl.getChecked(),
			saslName: this.$.saslName.getValue(),
			realName: this.$.realName.getValue(),
			channels: this.$.channels.getValue()
		};
	},

	tlsChanged: function () {
		this.$.port.setHint(this.$.tls.getChecked() ? String(IrcForm.TLS_PORT) : String(IrcForm.PLAIN_PORT));
		this.validateInput();
	},

	validateInput: function () {
		var f = this.fields();
		this.$.saslRow.setShowing(f.password.length > 0);
		var r = IrcForm.build(f);
		// Say what is wrong only once there is something in the fields it is about.
		var typed = r.ok || (r.field === "tls") || (String(f[r.field] || "").length > 0);
		this.$.status.setContent(!r.ok && typed ? r.error : "");
		this.$.signInButton.setDisabled(!r.ok);
		return r;
	},

	performSignIn: function () {
		var r = this.validateInput();
		if (!r.ok) {
			return;
		}
		this.$.signInButton.setActive(true);
		this.$.signInButton.setDisabled(true);
		this.$.crossAppResult.sendResult({
			returnValue: true,
			username: r.username,
			alias: r.username,
			credentials: { common: { password: r.password } },
			config: r.config,
			template: this.template || { templateId: "com.palm.irc" },
			templateId: "com.palm.irc"
		});
	},

	removeDone: function () {
		this.$.crossAppResult.sendResult({ returnValue: false });
	},
	cancel: function () {
		this.$.crossAppResult.sendResult({ returnValue: false });
	}
});
