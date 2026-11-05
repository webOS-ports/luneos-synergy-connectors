// Matrix account custom-validator UI (webOS Synergy / Accounts customUI).
//
// Loaded as a cross-app IFRAME by the Accounts framework. Enyo 0.10 app that returns the
// account via enyo.CrossAppResult.sendResult:
//     { returnValue:true, username, credentials, config, template, templateId }
// The framework then calls palm://com.palm.service.accounts/createAccount; the MESSAGING/IM
// capability's onEnabled fires -> imlibpurpletransport logs the account in via the combined
// plugin's Matrix prpl ("prpl-matrix", mautrix-go with end-to-end encryption).
//
// --- AUTHENTICATION ----------------------------------------------------------
// The account username is the Matrix ID (@user:server). The password is optional:
//   * with a password, the prpl logs in with it, on servers that still accept passwords;
//   * without one, it signs in through the browser: on servers with OAuth 2.0 (such as
//     matrix.org) the "Matrix" chat in Messaging shows a link and a code to approve.
// imlibpurpletransport rejects an EMPTY password (AcctMgr_Credentials_Not_Found), so "no
// password" is stored as the sentinel BROWSER_SIGN_IN, which the prpl recognises.
//
// After signing in, the "Matrix" chat also asks to verify the device: reply with the recovery
// key, or VERIFY to compare emoji with another session.
//
// We do NOT verify credentials in this UI; the prpl performs the authoritative login on
// connect and any failure surfaces in the Messaging app.

var BROWSER_SIGN_IN = "browser-sign-in";

enyo.kind({
    name: "Validator",
    kind: enyo.VFlexBox,
    className: "enyo-bg",

    components: [
        { kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
            { kind: "Image", src: "images/header-icon.png" },
            { kind: "Control", name: "title", content: "Matrix" }
        ]},
        { className: "accounts-header-shadow" },
        { kind: "Scroller", flex: 1, components: [
            { className: "box-center", components: [
                { kind: "RowGroup", caption: "DISPLAY NAME (OPTIONAL)", className: "accounts-group", components: [
                    { kind: "Input", name: "displayName", hint: "e.g. My Matrix", spellcheck: false,
                      autocorrect: false, autoWordComplete: false }
                ]},
                { kind: "RowGroup", caption: "MATRIX ID", className: "accounts-group", components: [
                    { kind: "Input", name: "username", hint: "@you:matrix.org", spellcheck: false,
                      autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase",
                      oninput: "validateInput", onkeydown: "checkForEnter" }
                ]},
                { kind: "RowGroup", caption: "PASSWORD (OPTIONAL)", className: "accounts-group", components: [
                    { kind: "PasswordInput", name: "password", hint: "Leave empty to sign in with a browser",
                      spellcheck: false, autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase",
                      oninput: "validateInput", onkeydown: "checkForEnter" }
                ]},
                { name: "errorBox", kind: "HFlexBox", showing: false, align: "center", className: "error-box", components: [
                    { name: "errorMessage", className: "enyo-text-error", flex: 1 }
                ]},
                { className: "accounts-body-text", style: "padding: 12px 16px; line-height: 1.4;", allowHtml: true,
                  content: "Enter your <b>Matrix ID</b>, such as <b>@you:matrix.org</b>, then tap <b>Sign In</b>." },
                { className: "accounts-body-text", style: "padding: 4px 16px 12px; line-height: 1.4; opacity: 0.7;", allowHtml: true,
                  content: "Without a password, the <b>Matrix</b> chat in Messaging shows a link to approve the sign-in in a browser. " +
                           "Afterwards it asks for your <b>recovery key</b> (or to compare emoji with another session) so this device can read encrypted chats." },
                { kind: "ActivityButton", name: "signInButton", caption: "Sign In", disabled: true, active: false,
                  className: "enyo-button-dark accounts-btn", onclick: "performSignIn" },

                // Standard framework Remove Account (with keep-data option); shown only when editing an
                // existing account; sits directly below Sign In. init() with no capability => full delete.
                { name: "removeAccountButton", kind: "Accounts.RemoveAccount", className: "accounts-btn",
                  showing: false, style: "padding-top:6px;", onAccountsRemove_Done: "removeDone" }
            ]}
        ]},
        { kind: "Toolbar", className: "enyo-toolbar-light", components: [
            { kind: "Button", name: "cancelButton", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
        ]},
        { kind: "CrossAppResult" }
    ],

    create: function() {
        this.inherited(arguments);
        this.handleLaunch(enyo.windowParams || {});
    },

    handleLaunch: function(params) {
        this.params = params || {};
        this.template = null;
        if (params.template && params.template.templateId === "com.palm.matrix") {
            this.template = params.template;
        } else if (params.allTemplates) {
            for (var i = 0; i < params.allTemplates.length; i++) {
                if (params.allTemplates[i].templateId === "com.palm.matrix") {
                    this.template = params.allTemplates[i];
                    break;
                }
            }
        }
        // Re-auth of an existing account: lock the Matrix ID, ask for the password only, and
        // offer "Remove Account" (this re-auth flow otherwise has no path to delete the account).
        this.accountId = (params.account && (params.account._id || params.account.id)) || params.accountId || null;
        if (params.account && params.account.username) {
            this.$.username.setValue(params.account.username);
            this.$.username.setDisabled(true);
            if (params.account.alias && params.account.alias !== params.account.username) {
                this.$.displayName.setValue(params.account.alias);
            }
            if (this.accountId) {
                this.$.removeAccountButton.init(params.account);
                this.$.removeAccountButton.show();
            }
        }
        this.validateInput();
    },

    removeDone: function() {
        this.$.crossAppResult.sendResult({ returnValue: false });
    },

    getAlias: function(user) {
        var n = (this.$.displayName.getValue() || "").replace(/^\s+|\s+$/g, "");
        return n || user;
    },

    // "you:matrix.org" and "@you:matrix.org" are both accepted; the stored form has the "@".
    normalizeUser: function(v) {
        v = (v || "").replace(/\s+/g, "");
        if (v && v.charAt(0) !== "@") { v = "@" + v; }
        return v;
    },

    isMatrixId: function(v) {
        return /^@[^:@\s]+:[A-Za-z0-9.\-]+(:[0-9]+)?$/.test(v);
    },

    validateInput: function() {
        var user = this.normalizeUser(this.$.username.getValue());
        this.$.signInButton.setDisabled(!this.isMatrixId(user));
    },

    checkForEnter: function(inSender, e) {
        if (e && e.keyCode === 13 && !this.$.signInButton.getDisabled()) {
            this.$.username.forceBlur();
            this.$.password.forceBlur();
            this.performSignIn();
        }
    },

    showError: function(msg) {
        this.$.errorMessage.setContent(msg || "");
        if (msg) { this.$.errorBox.show(); } else { this.$.errorBox.hide(); }
    },

    performSignIn: function() {
        var user = this.normalizeUser(this.$.username.getValue());
        if (!this.isMatrixId(user)) {
            this.showError("That is not a Matrix ID. It looks like @you:matrix.org.");
            return;
        }
        var pass = this.$.password.getValue() || "";
        this.showError("");
        this.$.signInButton.setActive(true);
        this.$.signInButton.setDisabled(true);
        var result = {
            returnValue: true,
            username: user,
            alias: this.getAlias(user),
            credentials: { common: { password: pass || BROWSER_SIGN_IN } },
            config: {},
            template: this.template || { templateId: "com.palm.matrix" },
            templateId: "com.palm.matrix"
        };
        this.$.crossAppResult.sendResult(result);
    },

    cancel: function() {
        this.$.crossAppResult.sendResult({ returnValue: false });
    }
});
