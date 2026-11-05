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
// The sign-in happens here, in Accounts (matrixAuth.js):
//   * without a password, on servers with OAuth 2.0 (such as matrix.org), the server's sign-in
//     page opens in a window (OAuthWindow); the code it returns is exchanged for tokens here;
//   * with a password, it logs in with it here, so a wrong one is reported on this screen.
// Either way the account's stored "password" is the resulting session ("mxoauth:..."), which
// the prpl takes over (matrix_seed.go); the password itself is not stored. When that session
// ends, the prpl reports bad credentials and Accounts brings this screen back to sign in again.
//
// "Sign in with a code instead" keeps the older route: the account stores BROWSER_SIGN_IN
// (the transport refuses an empty password) and the prpl shows a link and code in the "Matrix"
// chat in Messaging.
//
// The optional recovery key travels with the session; the prpl verifies the new device with it
// once, so encrypted chats and the key backup open without a step in Messaging.

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
                    { kind: "PasswordInput", name: "password", hint: "Leave empty to sign in in a browser window",
                      spellcheck: false, autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase",
                      oninput: "validateInput", onkeydown: "checkForEnter" }
                ]},
                { kind: "RowGroup", caption: "RECOVERY KEY (OPTIONAL)", className: "accounts-group", components: [
                    { kind: "PasswordInput", name: "recoveryKey", hint: "To read encrypted chats right away",
                      spellcheck: false, autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase",
                      onkeydown: "checkForEnter" }
                ]},
                { name: "errorBox", kind: "HFlexBox", showing: false, align: "center", className: "error-box", components: [
                    { name: "errorMessage", className: "enyo-text-error", flex: 1 }
                ]},
                { name: "status", className: "accounts-body-text", showing: false,
                  style: "padding: 8px 16px; line-height: 1.4;" },
                { name: "intro", className: "accounts-body-text", style: "padding: 12px 16px; line-height: 1.4;", allowHtml: true,
                  content: "Enter your <b>Matrix ID</b>, such as <b>@you:matrix.org</b>, then tap <b>Sign In</b>. " +
                           "Without a password, your server's sign-in page opens in a window." },
                { className: "accounts-body-text", style: "padding: 4px 16px 12px; line-height: 1.4; opacity: 0.7;", allowHtml: true,
                  content: "With your <b>recovery key</b> (or passphrase), this device can read your encrypted chats " +
                           "straight away. Without it, the <b>Matrix</b> chat in Messaging asks for it, or lets you " +
                           "compare emoji with another of your sessions." },
                { kind: "ActivityButton", name: "signInButton", caption: "Sign In", disabled: true, active: false,
                  className: "enyo-button-dark accounts-btn", onclick: "performSignIn" },
                { kind: "Button", name: "codeButton", caption: "Sign in with a code instead", disabled: true,
                  className: "accounts-btn", style: "margin-top: 6px;", onclick: "performCodeSignIn" },

                // Standard framework Remove Account (with keep-data option); shown only when editing an
                // existing account; sits directly below the sign-in buttons. init() with no capability
                // => full delete.
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
        // Re-auth of an existing account: lock the Matrix ID, sign in again, and offer "Remove
        // Account" (this re-auth flow otherwise has no path to delete the account).
        this.accountId = (params.account && (params.account._id || params.account.id)) || params.accountId || null;
        if (params.account && params.account.username) {
            this.$.username.setValue(params.account.username);
            this.$.username.setDisabled(true);
            if (params.account.alias && params.account.alias !== params.account.username) {
                this.$.displayName.setValue(params.account.alias);
            }
            this.$.intro.setContent("Sign in to <b>" + this.escapeHtml(params.account.username) +
                "</b> again. Without a password, your server's sign-in page opens in a window.");
            if (this.accountId) {
                this.$.removeAccountButton.init(params.account);
                this.$.removeAccountButton.show();
            }
        }
        this.validateInput();
    },

    escapeHtml: function(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

    validateInput: function() {
        var ok = MatrixAuth.isMatrixId(this.normalizeUser(this.$.username.getValue())) && !this.busy;
        this.$.signInButton.setDisabled(!ok);
        this.$.codeButton.setDisabled(!ok);
    },

    checkForEnter: function(inSender, e) {
        if (e && e.keyCode === 13 && !this.$.signInButton.getDisabled()) {
            this.$.username.forceBlur();
            this.$.password.forceBlur();
            this.$.recoveryKey.forceBlur();
            this.performSignIn();
        }
    },

    showError: function(msg) {
        this.$.errorMessage.setContent(msg || "");
        if (msg) { this.$.errorBox.show(); } else { this.$.errorBox.hide(); }
    },

    showStatus: function(msg) {
        this.$.status.setContent(msg || "");
        if (msg) { this.$.status.show(); } else { this.$.status.hide(); }
    },

    setBusy: function(busy) {
        this.busy = busy;
        this.$.signInButton.setActive(busy);
        this.validateInput();
    },

    // Back to the form after a failed attempt.
    failed: function(msg) {
        if (this._oauthWindow) {
            try { this._oauthWindow.close(); } catch (e) {}
            this._oauthWindow = null;
        }
        this.setBusy(false);
        this.showStatus("");
        this.showError(msg || "Sign-in failed.");
    },

    recoveryKeyValue: function() {
        return (this.$.recoveryKey.getValue() || "").replace(/^\s+|\s+$/g, "");
    },

    performSignIn: function() {
        var user = this.normalizeUser(this.$.username.getValue());
        if (!MatrixAuth.isMatrixId(user)) {
            this.showError("That is not a Matrix ID. It looks like @you:matrix.org.");
            return;
        }
        var pass = this.$.password.getValue() || "", rk = this.recoveryKeyValue(), self = this;
        this.showError("");
        this.setBusy(true);

        if (pass) {
            this.showStatus("Signing in…");
            MatrixAuth.passwordLogin(user, pass, rk).then(function (stored) {
                self.finishWithCredential(user, stored);
            }, function (e) { self.failed(e.message); });
            return;
        }

        this.showStatus("Contacting " + MatrixAuth.serverOf(user) + "…");
        MatrixAuth.prepare(user).then(function (prep) {
            if (!prep.oauth) {
                return MatrixAuth.hasPasswordLogin(prep.homeserver).then(function (has) {
                    self.failed(has ?
                        MatrixAuth.serverOf(user) + " has no browser sign-in. Enter your password." :
                        MatrixAuth.serverOf(user) + " offers neither browser sign-in nor passwords.");
                });
            }
            self.openSignInWindow(user, prep, rk);
        }).catch(function (e) {
            self.failed("Could not reach " + MatrixAuth.serverOf(user) + ": " + e.message);
        });
    },

    openSignInWindow: function(user, prep, rk) {
        var self = this;
        if (!window.OAuthWindow || window.OAuthWindow.hasPluginWebView()) {
            this.failed("This device cannot open a sign-in window. Use \"Sign in with a code instead\".");
            return;
        }
        this.showStatus("Sign in in the window that just opened. You'll come back here automatically.");
        this._oauthWindow = window.OAuthWindow.open({
            url: prep.url,
            name: "matrixSignIn",
            redirectPrefix: MatrixAuth.REDIRECT,
            timeoutMs: 600000,
            onRedirect: function (url) {
                self._oauthWindow = null;
                self.showStatus("Finishing sign-in…");
                MatrixAuth.finish(prep, url, user, rk).then(function (stored) {
                    self.finishWithCredential(user, stored);
                }, function (e) { self.failed(e.message); });
            },
            onError: function (msg) {
                self._oauthWindow = null;
                self.failed(msg);
            }
        });
    },

    // The older route: the prpl shows a link and a code in the "Matrix" chat in Messaging.
    performCodeSignIn: function() {
        var user = this.normalizeUser(this.$.username.getValue());
        if (!MatrixAuth.isMatrixId(user)) {
            this.showError("That is not a Matrix ID. It looks like @you:matrix.org.");
            return;
        }
        this.finishWithCredential(user, BROWSER_SIGN_IN);
    },

    finishWithCredential: function(user, stored) {
        this.showStatus("");
        this.$.crossAppResult.sendResult({
            returnValue: true,
            username: user,
            alias: this.getAlias(user),
            credentials: { common: { password: stored } },
            config: {},
            template: this.template || { templateId: "com.palm.matrix" },
            templateId: "com.palm.matrix"
        });
    },

    cancel: function() {
        if (this._oauthWindow) {
            try { this._oauthWindow.close(); } catch (e) {}
            this._oauthWindow = null;
        }
        this.$.crossAppResult.sendResult({ returnValue: false });
    }
});
