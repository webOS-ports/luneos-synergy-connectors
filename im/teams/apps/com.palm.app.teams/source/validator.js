// Microsoft Teams account custom-validator UI (webOS Synergy / Accounts customUI).
//
// This is loaded as a cross-app IFRAME by the Accounts framework (entry-add.js ->
// Accounts.crossAppUI -> CrossAppUI). It must be an Enyo 0.10 app and return the
// validated account to the caller via enyo.CrossAppResult.sendResult(...):
//
//     { returnValue:true, username, credentials, config, template, templateId }
//
// The framework then shows its standard "Create Account" confirmation view and
// calls palm://com.palm.service.accounts/createAccount. On creation the
// MESSAGING/IM capability's onEnabled fires -> imlibpurpletransport logs the
// account in via prpl-teams (libteams).
//
// --- TWO WAYS TO AUTHENTICATE ------------------------------------------------
// 1. BROWSER SIGN-IN (default): the Microsoft OAuth2 login page is rendered INLINE
//    here in an embedded Atlas WebView (enyo.BasicWebView with its plugin mime swapped
//    to application/x-atlas-browser -> BrowserServer-atlas = WPE + modern WebKit + TLS
//    1.3). The 2011-era system webview can't run Microsoft's modern login JS, and WPE
//    can't load the msauth.* native redirect scheme, so the backend intercepts the
//    post-login navigation to that scheme and fires actionData("oauthRedirect", url);
//    we capture the ?code= there and hand the raw URL to the plugin as a "webauth:"
//    credential -- the plugin does the TLS 1.3 code->token exchange and persists the
//    refresh_token. (Replaces the old flow: launch Atlas as a SEPARATE card + poll a
//    com.palm.systemservice pref for the captured redirect.)
// 2. DEVICE CODE (fallback): create the account with a "devicecode" sentinel password;
//    teams_login() runs the OAuth2 device-code flow and messages the one-time code +
//    https://microsoft.com/devicelogin link into the Messaging app.

// --- Atlas engine embed (inline OAuth2 sign-in) ------------------------------
// enyo 0.10 ships enyo.BasicWebView (an NPAPI-plugin control). Swapping its plugin mime
// to application/x-atlas-browser routes it to OUR BrowserServer-atlas (WPE, modern WebKit).
// We embed such a WebView INLINE in the validator (no separate card) to host the Microsoft
// sign-in page. The engine intercepts the msauth.* redirect (WPE can't load that scheme) and
// fires actionData("oauthRedirect", url) on the WebView instance; we walk the owner chain to
// the Validator's engineOAuthRedirect and redeem the ?code= there. (Same embed + atlas-simple
// viewport the Discord captcha uses; reusable across every OAuth2 account UI.)
// This only means anything where the NPAPI plugin exists (legacy webOS). LuneOS has no plugin to
// re-point, and hosts the sign-in page in a window.open()ed WAM window instead — see
// oauthWindow.js and performBrowserSignIn() below.
(function () {
    function patch() {
        if (window.OAuthWindow && !window.OAuthWindow.hasPluginWebView()) { return true; }
        if (!(window.enyo && enyo.BasicWebView && enyo.BasicWebView.prototype)) { return false; }
        if (enyo.BasicWebView.prototype.__atlasPatched) { return true; }
        enyo.BasicWebView.prototype.__atlasPatched = true;
        var origCreate = enyo.BasicWebView.prototype.create;
        enyo.BasicWebView.prototype.create = function () {
            origCreate.apply(this, arguments);
            this.domAttributes.type = "application/x-atlas-browser";
        };
        enyo.BasicWebView.prototype.actionData = function (dataType, data) {
            if (dataType === "oauthRedirect" && data) {
                var c = this, n = 0;
                while (c && n < 12) {
                    if (typeof c.engineOAuthRedirect === "function") { c.engineOAuthRedirect(data); break; }
                    c = c.owner || c.parent || c.container; n++;
                }
            }
        };
        return true;
    }
    if (!patch() && window.enyo) {
        var t = setInterval(function () { if (patch()) { clearInterval(t); } }, 50);
    }
})();

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
        // Entry form (email + buttons). Hidden while the inline OAuth webview is showing.
        { name: "entryView", kind: "Scroller", flex: 1, components: [
            { className: "box-center", components: [
                { kind: "RowGroup", caption: "DISPLAY NAME (OPTIONAL)", className: "accounts-group", components: [
                    { kind: "Input", name: "displayName", hint: "e.g. LuneOS Test", spellcheck: false,
                      autocorrect: false, autoWordComplete: false }
                ]},
                { kind: "RowGroup", caption: "EMAIL ADDRESS", className: "accounts-group", components: [
                    { kind: "Input", name: "username", hint: "you@example.com", spellcheck: false,
                      autocorrect: false, autoCapitalize: "lowercase", autoWordComplete: false,
                      oninput: "validateInput", onkeydown: "checkForEnter" }
                ]},
                { name: "errorBox", kind: "HFlexBox", showing: false, align: "center", className: "error-box", components: [
                    { name: "errorMessage", className: "enyo-text-error", flex: 1 }
                ]},
                { className: "accounts-body-text", style: "padding: 12px 16px; line-height: 1.4;", allowHtml: true,
                  content: "Tap <b>Sign In</b> to sign in to Microsoft right here. After you approve, you'll be returned automatically." },
                { kind: "ActivityButton", name: "signInButton", caption: "Sign In", disabled: true, active: false,
                  className: "enyo-button-dark accounts-btn", onclick: "performBrowserSignIn" },
                { className: "accounts-body-text", style: "padding: 4px 16px 12px; line-height: 1.4; opacity: 0.7;", allowHtml: true,
                  content: "Trouble signing in? Use a <b>one-time device code</b> instead — Teams will message it to you in the Messaging app." },
                { kind: "Button", name: "deviceCodeButton", caption: "Use device code instead", disabled: true,
                  className: "accounts-btn", onclick: "performSignIn" },

                // Standard framework Remove Account (with keep-data option); shown only when editing an
                // existing account; sits directly below Sign In. init() with no capability => full delete.
                { name: "removeAccountButton", kind: "Accounts.RemoveAccount", className: "accounts-btn",
                  showing: false, style: "padding-top:6px;", onAccountsRemove_Done: "removeDone" }
            ]}
        ]},
        // Inline OAuth2 sign-in view. The Atlas-routed WebView is created lazily in
        // performBrowserSignIn() so we don't spin up a WPE WebProcess unless it's used.
        { name: "oauthBox", kind: "VFlexBox", flex: 1, showing: false, components: [
            // Thin page-load progress bar (like the Atlas browser's), driven by onLoadProgress.
            { name: "oauthProgressWrap", style: "height:3px; background:transparent;", components: [
                { name: "oauthProgress", style: "height:3px; width:0%; background:#3b82f6; -webkit-transition:width 0.25s ease-out;" }
            ]},
            { name: "oauthStatus", className: "accounts-body-text", style: "padding: 8px 16px; line-height: 1.3;",
              content: "Loading Microsoft sign-in…" }
        ]},
        { kind: "Toolbar", className: "enyo-toolbar-light", components: [
            { kind: "Button", name: "cancelButton", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
        ]},
        { kind: "CrossAppResult" }
    ],

    create: function() {
        this.inherited(arguments);
        this.log("teams: params=" + enyo.json.stringify(enyo.windowParams));
        this.handleLaunch(enyo.windowParams || {});
    },

    // Resolve the Teams template out of the launch params and pre-fill the email
    // when we're re-entering an existing (broken-credentials) account.
    handleLaunch: function(params) {
        this.params = params || {};
        this.template = null;
        if (params.template && params.template.templateId === "com.palm.teams") {
            this.template = params.template;
        } else if (params.allTemplates) {
            for (var i = 0; i < params.allTemplates.length; i++) {
                if (params.allTemplates[i].templateId === "com.palm.teams") {
                    this.template = params.allTemplates[i];
                    break;
                }
            }
        }
        // Re-auth of an existing account also offers Remove (this flow bypasses the framework
        // account-detail view, the only other place with a Remove button).
        this.accountId = (params.account && (params.account._id || params.account.id)) || params.accountId || null;
        // Editing an existing account -> offer the standard Remove Account button (with keep-data option).
        if (this.accountId && params.account) {
            this.$.removeAccountButton.init(params.account);
            this.$.removeAccountButton.show();
        }
        if (params.account && params.account.username) {
            this.$.username.setValue(params.account.username);
            this.$.username.setDisabled(true);
            // Re-auth of an existing account: keep its display name (unless it's just the email).
            if (params.account.alias && params.account.alias !== params.account.username) {
                this.$.displayName.setValue(params.account.alias);
            }
        }
        this.validateInput();
    },

    // The display-name field is optional; fall back to the email so the account
    // is never nameless. The Accounts app shows alias on the first line and
    // username (email) on the second.
    getAlias: function(email) {
        var n = (this.$.displayName.getValue() || "").replace(/^\s+|\s+$/g, "");
        return n || email;
    },

    validateInput: function() {
        var v = this.$.username.getValue();
        var empty = !v || v.length === 0;
        this.$.signInButton.setDisabled(empty);
        this.$.deviceCodeButton.setDisabled(empty);
    },

    checkForEnter: function(inSender, e) {
        if (e && e.keyCode === 13 && !this.$.signInButton.getDisabled()) {
            this.$.username.forceBlur();
            this.performBrowserSignIn();
        }
    },

    showError: function(msg) {
        this.$.errorMessage.setContent(msg || "");
        if (msg) { this.$.errorBox.show(); } else { this.$.errorBox.hide(); }
    },

    // --- Device-code fallback -------------------------------------------------
    performSignIn: function() {
        var email = (this.$.username.getValue() || "").replace(/^\s+|\s+$/g, "");
        if (!email) { return; }
        this.showError("");
        this.$.deviceCodeButton.setDisabled(true);

        // Store the "devicecode" sentinel as the password. It MUST be non-empty:
        // imlibpurpletransport (getCredentialsResult) rejects an empty password as
        // "AcctMgr_Credentials_Not_Found" and aborts before ever calling login. Our
        // patched teams_login() treats this sentinel (or empty) as "run the OAuth2
        // device-code flow" instead of as a refresh_token. The code + devicelogin
        // link then arrive as a Messaging chat from the "TeamsLogin" buddy.
        this.finishWithCredential("devicecode", email);
    },

    // --- Browser sign-in OAuth2 constants ------------------------------------
    //
    // These OAuth constants MUST match the deployed purple-teams plugin flavor so the
    // authorization code we capture is redeemable by its teams_oauth_with_code(). The
    // current device build is the PERSONAL flavor (-DENABLE_TEAMS_PERSONAL): consumer
    // tenant + personal client_id + mt.readwrite scope, v2.0 endpoint (matching the
    // plugin's v2.0 /token exchange). When the work/personal dropdown lands, switch
    // these by the selection. See teams_login.c TEAMS_OAUTH_* and libteams.c tenant.
    OAUTH_TENANT:     "9188040d-6c67-4c5b-b112-36a304b66dad",
    OAUTH_CLIENT_ID:  "8ec6bc83-69c8-4392-8f08-b3c986009232",
    OAUTH_REDIRECT:   "msauth.com.microsoft.teams://auth",
    OAUTH_SCOPE:      "https://mtsvc.fl.teams.microsoft.com/teams.mt.readwrite openid profile offline_access",

    buildAuthorizeUrl: function(email) {
        // Personal/MSA accounts REQUIRE the v2.0 protocol: v1 /oauth2/authorize renders the login but
        // fails at token issuance with AADSTS500201 ("unable to issue tokens from this API version for
        // a Microsoft account — use version 2.0"). And v2.0 for this Teams client only accepts the
        // NATIVE redirect msauth.com.microsoft.teams://auth — every web redirect (nativeclient,
        // live.com/oauth20_desktop.srf) gets invalid_request (curl-verified against MS). WPE can't load
        // that custom scheme, so the backend intercepts the post-login navigation to it and hands the
        // code back via actionData("oauthRedirect"). teams_oauth_with_code redeems at /oauth2/v2.0/
        // token with the SAME redirect_uri (TEAMS_OAUTH_REDIRECT_URI, personal build = msauth...).
        var u = "https://login.microsoftonline.com/" + encodeURIComponent(this.OAUTH_TENANT) +
            "/oauth2/v2.0/authorize" +
            "?client_id=" + encodeURIComponent(this.OAUTH_CLIENT_ID) +
            "&response_type=code" +
            "&redirect_uri=" + encodeURIComponent(this.OAUTH_REDIRECT) +
            "&scope=" + encodeURIComponent(this.OAUTH_SCOPE);
        // SMOOTH LOGIN: the Accounts app already collected the email, so pass it as login_hint and do NOT
        // force prompt=select_account. select_account shows MS's "pick an account" screen, which IGNORES
        // login_hint and makes the user retype the email. With login_hint alone (and no cached MS session
        // in the fresh WPE webview) MSA pre-fills the address and jumps straight to the password page.
        // Fall back to select_account only when we somehow have no email to hint.
        if (email) {
            u += "&login_hint=" + encodeURIComponent(email);
        } else {
            u += "&prompt=select_account";
        }
        return u;
    },

    // --- Inline embedded-WebView browser sign-in ------------------------------
    performBrowserSignIn: function() {
        var email = (this.$.username.getValue() || "").replace(/^\s+|\s+$/g, "");
        if (!email) { return; }
        this.oauthEmail = email;
        this.oauthDone = false;
        this._oauthLoaded = false;
        this._authUrl = this.buildAuthorizeUrl(email);
        this.showError("");
        this.$.signInButton.setActive(true);
        this.$.signInButton.setDisabled(true);

        // Switch to the inline OAuth webview.
        this.$.entryView.hide();
        this.$.oauthBox.show();
        this.$.oauthStatus.setContent("Loading Microsoft sign-in…");

        // No NPAPI plugin (LuneOS): host the sign-in page in its own WAM window. The redirect is
        // msauth.com.microsoft.teams://auth?code=..., a scheme the engine can't load — it aborts
        // that navigation, and WAM hands us the URL as a 'webOSExternalProtocol' event, which
        // OAuthWindow turns back into the same engineOAuthRedirect() call the Atlas embed makes.
        if (window.OAuthWindow && !window.OAuthWindow.hasPluginWebView()) {
            this.$.oauthStatus.setContent("Sign in to Microsoft in the window that just opened. " +
                "You'll be returned here automatically.");
            var lune = this;
            this._oauthWindow = window.OAuthWindow.open({
                url: this._authUrl,
                name: "teamsSignIn",
                // Match on the native redirect so an intermediate navigation can't be mistaken
                // for the result.
                redirectPrefix: this.OAUTH_REDIRECT,
                timeoutMs: 240000,
                onRedirect: function (url) {
                    // engineOAuthRedirect() only acts on a URL carrying code=, which is right for
                    // the Atlas embed (it keeps getting intermediate navigations). Here the window
                    // is already gone by the time we're called, so a denial would just hang —
                    // report it instead.
                    if (url.indexOf("code=") < 0) {
                        lune.abortOAuth("Microsoft didn't return an authorization code. " +
                            "Please try again, or use 'Use device code instead'.");
                        return;
                    }
                    lune.engineOAuthRedirect(url);
                },
                onError: function (msg) { lune.abortOAuth(msg); }
            });
            return;
        }

        if (!this.$.oauthWeb) {
            this.$.oauthBox.createComponent({
                name: "oauthWeb", kind: "WebView", width: "100%", height: "600px",
                // atlas-simple (MODE-2) viewport: a screen-sized render buffer -> correct tap coordinates,
                // legible layout, AND fast load (no 1024x3072 tall-buffer full readback). Requires the
                // BrowserServer-atlas fix that makes setWindowSize's width-change path respect m_simpleMode
                // (else the buffer desyncs -> onFrame drops -> white). Seed the URL with the marker so the
                // FIRST ensureWebView builds the mult=1 viewport.
                url: "atlas-simple:about:blank",
                onConnected: "oauthConnected", onError: "oauthWebError",
                onLoadStarted: "oauthLoadStarted", onLoadProgress: "oauthLoadProgress",
                onLoadComplete: "oauthLoadDone", onLoadStopped: "oauthLoadDone"
            }, { owner: this });
            this.$.oauthBox.render();
        } else {
            this.oauthConnected();
        }
        // Fallback: the Atlas-routed adapter may not fire onConnected the way the stock plugin does.
        // (enyo 0.10 has no startJob/stopJob — use plain window timers.)
        this.clearOAuthLoadTimer();
        var self = this;
        this._oauthLoadTimer = window.setTimeout(function () { self.oauthConnected(); }, 3000);
        // Wall-clock timeout for the whole flow (~4 min).
        if (this._oauthDeadline) { window.clearTimeout(this._oauthDeadline); }
        this._oauthDeadline = window.setTimeout(function () { self.oauthTimeout(); }, 240000);
    },

    clearOAuthLoadTimer: function() {
        if (this._oauthLoadTimer) { window.clearTimeout(this._oauthLoadTimer); this._oauthLoadTimer = null; }
    },

    clearOAuthTimers: function() {
        this.clearOAuthLoadTimer();
        if (this._oauthDeadline) { window.clearTimeout(this._oauthDeadline); this._oauthDeadline = null; }
    },

    // Adapter connected -> enter atlas-simple viewport then navigate to the authorize URL. Guarded so
    // onConnected + the 3s fallback don't double-navigate.
    oauthConnected: function() {
        if (this._oauthLoaded || !this._authUrl || !this.$.oauthWeb) { return; }
        this._oauthLoaded = true;
        this.clearOAuthLoadTimer();
        try {
            this.$.oauthWeb.callBrowserAdapter("openURL", ["atlas-simple:" + this._authUrl]);
        } catch (e) {
            this.log("teams: openURL failed: " + e);
            this._oauthLoaded = false;
            this.oauthWebError();
        }
    },

    // ---- page-load progress bar --------------------------------------------
    setProgress: function(pct) {
        if (this.$.oauthProgress) { this.$.oauthProgress.applyStyle("width", pct + "%"); }
    },
    oauthLoadStarted: function() {
        if (this.oauthDone) { return; }
        this.setProgress(8);
        if (this.$.oauthStatus) { this.$.oauthStatus.setContent(""); }
    },
    oauthLoadProgress: function(inSender, inProgress) {
        if (this.oauthDone) { return; }
        var p = (inProgress <= 1) ? inProgress * 100 : inProgress;   // normalize 0-1 or 0-100
        if (p < 8) { p = 8; } if (p > 100) { p = 100; }
        this.setProgress(p);
    },
    oauthLoadDone: function() {
        this.setProgress(100);
        var self = this;
        window.setTimeout(function() { self.setProgress(0); }, 350);
    },

    // Atlas engine captured the msauth.* redirect carrying ?code=... . We hand the raw URL to the
    // plugin as a "webauth:" credential — the plugin does the TLS 1.3 token exchange (this legacy
    // webview can't) and persists the resulting refresh_token itself.
    engineOAuthRedirect: function(url) {
        if (this.oauthDone || !url) { return; }
        if (url.indexOf("code=") < 0) { return; }   // ignore intermediate navigations
        this.oauthDone = true;
        this.clearOAuthTimers();
        this.log("teams: captured OAuth redirect, creating account");
        // DEFER teardown OUT of the WebView's own nav/actionData callback: destroying the plugin
        // synchronously from inside its event dispatch re-enters the dying webview and crashes the
        // host (LunaSysMgr restart). setTimeout(0) runs it on a fresh stack after the event unwinds.
        var self = this;
        window.setTimeout(function () {
            self.destroyOAuthWeb();
            self.finishWithCredential("webauth:" + url, self.oauthEmail);
        }, 0);
    },

    oauthWebError: function() {
        if (this.oauthDone) { return; }
        this.log("teams: oauth webview error");
        this.abortOAuth("Could not open the sign-in page. Try 'Use device code instead'.");
    },

    oauthTimeout: function() {
        if (this.oauthDone) { return; }
        this.abortOAuth("Sign-in timed out — please try again.");
    },

    // Return to the entry form (on error/timeout) and release the webview.
    abortOAuth: function(msg) {
        this.clearOAuthTimers();
        this.destroyOAuthWeb();
        this.$.oauthBox.hide();
        this.$.entryView.show();
        this.$.signInButton.setActive(false);
        this.validateInput();
        this.showError(msg || "");
    },

    destroyOAuthWeb: function() {
        this.clearOAuthLoadTimer();
        this._oauthLoaded = false;
        // LuneOS path: drop the sign-in window and its listeners/timers. Safe to call twice —
        // OAuthWindow already tore itself down if it was the one that captured the redirect.
        if (this._oauthWindow) {
            try { this._oauthWindow.close(); } catch (e0) {}
            this._oauthWindow = null;
        }
        if (this.$.oauthWeb) {
            // Release the WPE WebProcess so it doesn't leak past the validator's short life.
            try { this.$.oauthWeb.callBrowserAdapter("disconnectBrowserServer", []); } catch (e) {}
            try { this.$.oauthWeb.destroy(); } catch (e2) {}
            this.$.oauthWeb = null;
        }
    },

    finishWithCredential: function(password, email) {
        var result = {
            returnValue: true,
            username: email,
            alias: this.getAlias(email),
            credentials: { common: { password: password } },
            config: {},
            template: this.template || { templateId: "com.palm.teams" },
            templateId: "com.palm.teams"
        };
        this.$.crossAppResult.sendResult(result);
    },

    // Fired by Accounts.RemoveAccount (onAccountsRemove_Done) once the framework handled the confirm
    // dialog (incl. the keep-data option) and the deleteAccount call. Return to the Accounts app.
    removeDone: function() {
        this.$.crossAppResult.sendResult({ returnValue: false });
    },
    cancel: function() {
        this.clearOAuthTimers();
        this.destroyOAuthWeb();
        // returnValue:false -> Accounts framework returns to the "Add Account" list.
        this.$.crossAppResult.sendResult({ returnValue: false });
    }
});
