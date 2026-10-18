// Telegram account custom-validator UI (webOS Synergy / Accounts customUI).
//
// Loaded as a cross-app IFRAME by the Accounts framework (entry-add.js ->
// Accounts.crossAppUI -> CrossAppUI). It is an Enyo 0.10 app that returns the
// account to the caller via enyo.CrossAppResult.sendResult(...):
//
//     { returnValue:true, username, credentials, config, template, templateId }
//
// The framework then calls palm://com.palm.service.accounts/createAccount. On
// creation the MESSAGING/IM capability's onEnabled fires -> imlibpurpletransport
// logs the account in via prpl-telegram.
//
// --- WHY THIS IS PHONE-ONLY (and NOT an Atlas web flow) ----------------------
// Unlike Teams (browser OAuth2, where Atlas "simple" mode renders the Microsoft
// login PAGE the legacy webview can't), Telegram has NO web login. Its auth is an
// in-band MTProto handshake the prpl runs itself: phone number -> server sends a
// login CODE (Telegram app / SMS) -> optional 2FA password. So there is no URL for
// Atlas to render; a native scene collects the phone number and that's all the
// setup app can do up front (the code does not exist until the prpl connects).
//
// --- HOW THE LOGIN CODE REACHES THE PRPL (the important part) ----------------
// imlibpurpletransport implements NO libpurple request-ops (no request_input /
// request_fields), so telegram-purple's purple_request_input("Login code") returns
// FALSE. telegram-purple ALREADY handles that: its "compat-verification" fallback
// (tgp-request.c request_code) opens an IM conversation with a buddy named
// "Telegram" and writes the prompt there; the user's reply IM is intercepted in the
// send path (telegram-purple.c:622, gc_get_data(gc)->request_code_data) and fed to
// the login callback. So NO new channel is needed for the code — it just works on
// imlibpurple. We force compat-verification=1 in the build so it's deterministic.
//   * code (SMS/app)        -> reply to the "Telegram" chat in the Messaging app.
//   * 2FA password (if set) -> same channel, AFTER a small prpl patch adds the compat
//                              fallback to request_password (see PORT-PLAN sec.4).
// So after this app creates the account, the user finishes login IN THE MESSAGING
// APP by replying to the "Telegram" chat with the code (then the 2FA password).
//
// The password we store is a non-empty sentinel ("logincode"): imlibpurpletransport
// (getCredentialsResult) rejects an EMPTY password as AcctMgr_Credentials_Not_Found
// and aborts before ever calling login, so it must be non-empty. The patched
// telegram-purple treats this sentinel as "interactive login pending" and drives the
// IM-channel code handshake above.

enyo.kind({
    name: "Validator",
    kind: enyo.VFlexBox,
    className: "enyo-bg",

    components: [
        { kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
            { kind: "Image", src: "images/header-icon.png" },
            { kind: "Control", name: "title", content: "Sign In"}
        ]},
        { className: "accounts-header-shadow" },
        { kind: "Scroller", flex: 1, components: [
            { className: "box-center", components: [
                { kind: "RowGroup", caption: "DISPLAY NAME (OPTIONAL)", className: "accounts-group", components: [
                    { kind: "Input", name: "displayName", hint: "e.g. My Telegram", spellcheck: false,
                      autocorrect: false, autoWordComplete: false }
                ]},
                { kind: "RowGroup", caption: "PHONE NUMBER", className: "accounts-group", components: [
                    { kind: "Input", name: "username", hint: "+15551234567", spellcheck: false,
                      autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase",
                      oninput: "validateInput", onkeydown: "checkForEnter" }
                ]},
                { name: "errorBox", kind: "HFlexBox", showing: false, align: "center", className: "error-box", components: [
                    { name: "errorMessage", className: "enyo-text-error", flex: 1 }
                ]},
                { className: "accounts-body-text", style: "padding: 12px 16px; line-height: 1.4;", allowHtml: true,
                  content: "Enter your phone number in <b>international format</b> (with country code, e.g. +15551234567). After you tap <b>Sign In</b>, Telegram sends a login code to your Telegram app or by SMS." },
                { className: "accounts-body-text", style: "padding: 4px 16px 12px; line-height: 1.4; opacity: 0.7;", allowHtml: true,
                  content: "Finish signing in from the <b>Messaging</b> app: reply to the <b>Telegram</b> chat with the code (and your 2-step password, if you use one)." },
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
        if (params.template && params.template.templateId === "com.palm.telegram") {
            this.template = params.template;
        } else if (params.allTemplates) {
            for (var i = 0; i < params.allTemplates.length; i++) {
                if (params.allTemplates[i].templateId === "com.palm.telegram") {
                    this.template = params.allTemplates[i];
                    break;
                }
            }
        }
        // Re-auth of an existing account also offers Remove (this flow bypasses the framework
        // account-detail view, the only other place with a Remove button).
        this.accountId = (params.account && (params.account._id || params.account.id)) || params.accountId || null;
        // Editing an existing account -> offer the standard Remove Account button (with keep-data option).
        // No capability passed => the whole account is deleted (not just one capability).
        if (this.accountId && params.account) {
            this.$.removeAccountButton.init(params.account);
            this.$.removeAccountButton.show();
        }
        if (params.account && params.account.username) {
            this.$.username.setValue(params.account.username);
            this.$.username.setDisabled(true);
            if (params.account.alias && params.account.alias !== params.account.username) {
                this.$.displayName.setValue(params.account.alias);
            }
        }
        this.validateInput();
    },

    getAlias: function(phone) {
        var n = (this.$.displayName.getValue() || "").replace(/^\s+|\s+$/g, "");
        return n || phone;
    },

    // Accept a leading + and 6-15 digits (E.164-ish). We keep it permissive; the
    // prpl does the authoritative validation on connect.
    normalizePhone: function(v) {
        v = (v || "").replace(/[^\d+]/g, "");
        if (v.indexOf("+") > 0) { v = "+" + v.replace(/\+/g, ""); }
        return v;
    },

    validateInput: function() {
        var v = this.normalizePhone(this.$.username.getValue());
        var ok = /^\+?\d{6,15}$/.test(v);
        this.$.signInButton.setDisabled(!ok);
    },

    checkForEnter: function(inSender, e) {
        if (e && e.keyCode === 13 && !this.$.signInButton.getDisabled()) {
            this.$.username.forceBlur();
            this.performSignIn();
        }
    },

    showError: function(msg) {
        this.$.errorMessage.setContent(msg || "");
        if (msg) { this.$.errorBox.show(); } else { this.$.errorBox.hide(); }
    },

    performSignIn: function() {
        var phone = this.normalizePhone(this.$.username.getValue());
        if (!phone) { return; }
        this.showError("");
        this.$.signInButton.setActive(true);
        this.$.signInButton.setDisabled(true);
        // Store the "logincode" sentinel as the password (must be non-empty; see header).
        // The patched telegram-purple treats it as "interactive login pending" and drives
        // the code handshake over the IM channel.
        var result = {
            returnValue: true,
            username: phone,
            alias: this.getAlias(phone),
            credentials: { common: { password: "logincode" } },
            config: {},
            template: this.template || { templateId: "com.palm.telegram" },
            templateId: "com.palm.telegram"
        };
        this.$.crossAppResult.sendResult(result);
    },

    // Fired by Accounts.RemoveAccount (onAccountsRemove_Done) once the framework has handled the confirm
    // dialog (incl. the keep-data option) and the deleteAccount call. Return to the Accounts app.
    removeDone: function() {
        this.$.crossAppResult.sendResult({ returnValue: false });
    },
    cancel: function() {
        this.$.crossAppResult.sendResult({ returnValue: false });
    }
});
