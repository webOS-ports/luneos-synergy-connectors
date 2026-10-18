// Signal account custom-validator UI (webOS Synergy / Accounts customUI).
//
// Backend: hoehermann/purple-presage (prpl-hehoe-presage) — a native Rust Signal plugin
// (NO JVM). On connect, presage generates a device-link provisioning URI ("sgnl://linkdevice…")
// and raises it via purple_request_fields (field "qr_string"), which imlibpurpletransport
// forwards to its QR AuthChannel (publishQRChallenge) — the SAME path WhatsApp/Discord use.
//
// --- INLINE QR SIGN-IN (create-after-confirm) --------------------------------
//   1. tap Sign In -> com.palm.imlibpurple/startQRLogin {serviceName:type_signal, username}
//      spins up a PENDING prpl-hehoe-presage login purely to obtain the device-link URI.
//   2. POLL com.palm.imlibpurple/getAuthChallenge; presage sends the URI as resp.urlString.
//      presage does NOT render an image on this device (no qrencode), so we render the QR
//      HERE from the URI with qrcode-generator (source/qrcode.js).
//   3. the user opens Signal > Settings > Linked Devices > Link New Device and scans it.
//   4. presage links, reports the account UUID; the transport surfaces it as resp.token and
//      getAuthChallenge returns state="confirmed". ONLY THEN do we sendResult(), creating the
//      account with the UUID as the username (Signal identifies accounts by UUID, not phone).

enyo.kind({
    name: "Validator",
    kind: enyo.VFlexBox,
    className: "enyo-bg",

    SERVICE_NAME: "type_signal",
    QR_POLL_MS: 2000,
    // Match the transport's QR-preview connect grace (QR_CONNECT_TIMEOUT_SECONDS=300); the user
    // needs time to open Signal on their phone and scan.
    QR_TIMEOUT_MS: 300000,

    components: [
        { kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
            { kind: "Image", src: "images/header-icon.png", style: "width:32px; height:32px; vertical-align:middle; margin-right:6px;" },
            { kind: "Control", name: "title", content: "Sign In"}
        ]},
        { className: "accounts-header-shadow" },

        { name: "startQR", kind: "PalmService", service: "palm://com.palm.imlibpurple/",
          method: "startQRLogin", onSuccess: "qrStarted", onFailure: "qrStartFailed" },
        { name: "getChallenge", kind: "PalmService", service: "palm://com.palm.imlibpurple/",
          method: "getAuthChallenge", onSuccess: "gotChallenge", onFailure: "challengeError" },
        { name: "submitAuth", kind: "PalmService", service: "palm://com.palm.imlibpurple/",
          method: "submitAuthInput" },

        { kind: "Scroller", flex: 1, components: [
            // -------- Phone entry --------
            { name: "entryBox", className: "box-center", components: [
                { kind: "RowGroup", caption: "DISPLAY NAME (OPTIONAL)", className: "accounts-group", components: [
                    { kind: "Input", name: "displayName", hint: "e.g. My Signal", spellcheck: false,
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
                  content: "Enter your phone number in <b>international format</b> (e.g. +15551234567) and tap <b>Sign In</b>. A QR code appears here — open <b>Signal → Settings → Linked Devices → Link New Device</b> and scan it." },
                { kind: "ActivityButton", name: "signInButton", caption: "Sign In", disabled: true, active: false,
                  className: "enyo-button-dark accounts-btn", onclick: "performSignIn" },

                // Standard framework Remove Account (with keep-data option); shown only when editing an
                // existing account; sits directly below Sign In. init() with no capability => full delete.
                { name: "removeAccountButton", kind: "Accounts.RemoveAccount", className: "accounts-btn",
                  showing: false, style: "padding-top:6px;", onAccountsRemove_Done: "removeDone" }
            ]},

            // -------- Inline QR view --------
            { name: "qrBox", showing: false, className: "box-center", style: "text-align:center;", components: [
                { name: "qrTitle", className: "accounts-body-text", style: "padding:14px 16px 4px; font-size:20px;",
                  content: "Link Signal" },
                { name: "qrStatus", className: "accounts-body-text", style: "padding:2px 16px 10px; opacity:0.8; line-height:1.4;",
                  content: "Preparing your QR code…" },
                { name: "qrImageWrap", showing: false, style: "background:#fff; padding:14px; border-radius:10px; width:250px; height:250px; margin:10px auto; text-align:center;",
                  components: [
                    { name: "qrImg", kind: "Image", style: "display:block; width:250px; height:250px; margin:0 auto; image-rendering:pixelated; -ms-interpolation-mode:nearest-neighbor;" }
                ]},
                { className: "accounts-body-text", style: "padding:8px 24px; opacity:0.6; line-height:1.4;",
                  content: "On your phone: Signal → Settings → Linked Devices → Link New Device, then point it here." },
                { name: "qrRefreshButton", showing: false, kind: "Button", caption: "Get a new code",
                  className: "accounts-btn", onclick: "refreshQR" }
            ]}
        ]},

        { kind: "Toolbar", className: "enyo-toolbar-light", components: [
            { kind: "Button", name: "cancelButton", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
        ]},
        { kind: "CrossAppResult" }
    ],

    create: function() {
        this.inherited(arguments);
        this._qrActive = false;
        this._lastUri = null;
        this.handleLaunch(enyo.windowParams || {});
    },

    handleLaunch: function(params) {
        this.params = params || {};
        this.template = null;
        if (params.template && params.template.templateId === "com.palm.signal") {
            this.template = params.template;
        } else if (params.allTemplates) {
            for (var i = 0; i < params.allTemplates.length; i++) {
                if (params.allTemplates[i].templateId === "com.palm.signal") { this.template = params.allTemplates[i]; break; }
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
            if (params.account.alias && params.account.alias !== params.account.username) {
                this.$.displayName.setValue(params.account.alias);
            }
        }
        this.validateInput();
    },

    log: function(m) { try { enyo.log(m); } catch (e) {} },
    trim: function(v) { return (v || "").replace(/^\s+|\s+$/g, ""); },

    getAlias: function(phone) {
        var n = this.trim(this.$.displayName.getValue());
        return n || String(phone || "");
    },

    normalizePhone: function(v) {
        v = (v || "").replace(/[^\d+]/g, "");
        if (v.indexOf("+") > 0) { v = "+" + v.replace(/\+/g, ""); }
        return v;
    },

    validateInput: function() {
        var v = this.normalizePhone(this.$.username.getValue());
        this.$.signInButton.setDisabled(!/^\+?\d{6,15}$/.test(v));
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
        this.startQRSignIn(phone);
    },

    // ---- create-after-confirm QR flow ---------------------------------------

    startQRSignIn: function(phone) {
        this._qrUser = phone;
        this._qrActive = true;
        this._qrPollCount = 0;
        this._lastUri = null;
        this.$.entryBox.hide();
        this.$.qrBox.show();
        this.$.qrImageWrap.hide();
        this.$.qrRefreshButton.hide();
        this.$.qrStatus.setContent("Preparing your QR code…");
        this.$.startQR.call({ serviceName: this.SERVICE_NAME, username: phone });
    },

    qrStarted: function() { if (this._qrActive) { this.startQRPoll(); } },

    qrStartFailed: function(inSender, err) {
        this.log("signal: startQRLogin failed: " + enyo.json.stringify(err));
        this.abortQR("Couldn't start Signal sign-in. Please try again.");
    },

    startQRPoll: function() {
        this.stopQRPoll();
        var self = this;
        this._qrPoll = window.setInterval(function () { self.pollChallenge(); }, this.QR_POLL_MS);
        this.pollChallenge();
    },

    stopQRPoll: function() {
        if (this._qrPoll) { window.clearInterval(this._qrPoll); this._qrPoll = null; }
    },

    pollChallenge: function() {
        if (!this._qrActive) { this.stopQRPoll(); return; }
        this._qrPollCount++;
        if (this._qrPollCount * this.QR_POLL_MS > this.QR_TIMEOUT_MS) { this.qrExpired("Sign-in timed out."); return; }
        this.$.getChallenge.call({ serviceName: this.SERVICE_NAME, username: this._qrUser });
    },

    // Render the device-link URI into a QR image client-side (presage sends only the URI string).
    renderQR: function(uri) {
        if (!uri || uri === this._lastUri) { return; }
        this._lastUri = uri;
        try {
            var qr = qrcode(0, "L");   // type 0 = auto-size, error-correction L (max capacity)
            qr.addData(uri);
            qr.make();
            var url = qr.createDataURL(5, 10);  // cellSize, margin(px)
            this.$.qrImg.setSrc(url);
            this.$.qrImageWrap.show();
            this.$.qrStatus.setContent("Scan this code in Signal → Linked Devices.");
        } catch (e) {
            this.log("signal: QR render failed: " + e);
            this.$.qrStatus.setContent("Could not render the QR code.");
        }
    },

    gotChallenge: function(inSender, resp) {
        if (!this._qrActive) { return; }
        if (resp && resp.urlString) { this.renderQR(resp.urlString); }
        switch (resp && resp.state) {
            case "waiting":
                if (!this._lastUri) { this.$.qrStatus.setContent("Preparing your QR code…"); }
                break;
            case "scanned":
                this.$.qrStatus.setContent("Scanned — linking your device…");
                break;
            case "confirmed":
                this.stopQRPoll();
                this._qrActive = false;
                this.$.qrStatus.setContent("Linked! Finishing setup…");
                // Create the account with the SAME username used for linking (the phone number),
                // not the UUID: presage keys its session store by username (presage/<username>.db),
                // so the linked session lives under the phone. Creating the account with the UUID
                // instead opens a DIFFERENT, empty store and presage re-links (stuck "signing in").
                // presage tolerates the phone!=uuid mismatch (see qrcode.c presage_handle_uuid).
                this.finishWithResult(this._qrUser);
                break;
            case "expired":
                this.qrExpired("That code expired.");
                break;
            case "failed":
                this.abortQR((resp && resp.message) || "Signal sign-in failed.");
                break;
            default:
                break;   // keep polling
        }
    },

    challengeError: function(inSender, err) {
        this.log("signal: getAuthChallenge error: " + enyo.json.stringify(err));
    },

    refreshQR: function() {
        if (!this._qrUser) { return; }
        this.$.qrRefreshButton.hide();
        this._lastUri = null;
        this.$.qrImageWrap.hide();
        this.$.qrStatus.setContent("Getting a new code…");
        this.$.submitAuth.call({ serviceName: this.SERVICE_NAME, username: this._qrUser, action: "refresh" });
        this._qrActive = true; this._qrPollCount = 0; this.startQRPoll();
    },

    qrExpired: function(msg) {
        this.stopQRPoll();
        this._qrActive = false;
        this.$.qrStatus.setContent(msg + " Tap below for a new one.");
        this.$.qrImageWrap.hide();
        this.$.qrRefreshButton.show();
    },

    abortQR: function(msg) {
        this.stopQRPoll();
        this._qrActive = false;
        this.$.submitAuth.call({ serviceName: this.SERVICE_NAME, username: this._qrUser, action: "cancel" });
        this.$.qrBox.hide();
        this.$.entryBox.show();
        this.$.signInButton.setActive(false);
        this.$.signInButton.setDisabled(false);
        this.showError(msg || "Sign-in failed.");
    },

    finishWithResult: function(username) {
        var result = {
            returnValue: true,
            username: username,
            alias: this.getAlias(username),
            credentials: { common: { password: "signal-link-pending" } },
            config: {},
            template: this.template || { templateId: "com.palm.signal" },
            templateId: "com.palm.signal"
        };
        this.$.crossAppResult.sendResult(result);
    },

    // Fired by Accounts.RemoveAccount (onAccountsRemove_Done) once the framework handled the confirm
    // dialog (incl. the keep-data option) and the deleteAccount call. Return to the Accounts app.
    removeDone: function() {
        this.$.crossAppResult.sendResult({ returnValue: false });
    },
    cancel: function() {
        if (this._qrActive && this._qrUser) {
            this.$.submitAuth.call({ serviceName: this.SERVICE_NAME, username: this._qrUser, action: "cancel" });
        }
        this.stopQRPoll();
        this.$.crossAppResult.sendResult({ returnValue: false });
    }
});
