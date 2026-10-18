// WhatsApp account custom-validator UI (webOS Synergy / Accounts customUI).
//
// Loaded as a cross-app IFRAME by the Accounts framework. Enyo 0.10 app that returns
// the account via enyo.CrossAppResult.sendResult(...); the framework then calls
// createAccount and the MESSAGING/IM capability's onEnabled logs in via
// prpl-hehoe-whatsmeow (hoehermann/purple-gowhatsapp).
//
// --- INLINE QR SIGN-IN (create-after-confirm), like Discord -------------------
// WhatsApp multi-device auth is a QR device-link the prpl runs on connect: whatsmeow
// raises the QR via purple_request_fields (field "qr_image"), which imlibpurpletransport
// forwards to its AuthChannel (publishQRChallenge) — the SAME path Discord's QR uses.
// So instead of just collecting a phone number, we drive that channel here:
//   1. tap Sign In -> com.palm.imlibpurple/startQRLogin {serviceName:type_whatsapp, username:phone}
//      spins up a PENDING prpl-hehoe-whatsmeow login purely to obtain the QR.
//   2. we POLL com.palm.imlibpurple/getAuthChallenge and render the QR image INLINE here.
//   3. the user opens WhatsApp > Linked Devices > Link a Device and scans it.
//   4. whatsmeow persists its session under purple_user_dir/<phone> (keyed by phone, in the
//      shared purple config dir), and the login reaches CONNECTED -> getAuthChallenge returns
//      state="confirmed". ONLY THEN do we sendResult(), creating the account with the same
//      phone number, so the very next login reuses the saved session (no second QR).
// (No token/captcha path — WhatsApp is QR/pairing only. This is why we do NOT launch an
//  Atlas webview to web.whatsapp.com: the QR is rendered natively in this card.)

enyo.kind({
    name: "Validator",
    kind: enyo.VFlexBox,
    className: "enyo-bg",

    SERVICE_NAME: "type_whatsapp",
    QR_POLL_MS: 2000,
    // Must match the transport's QR-preview connect grace (QR_CONNECT_TIMEOUT_SECONDS=300).
    // The pairing-CODE flow (type an 8-char code on the phone) is much slower than a QR scan,
    // and at 130s the poll expired ~8s BEFORE the pair/confirm landed -> the confirmed state
    // was never caught and pairing restarted. 300s covers the code flow with margin.
    QR_TIMEOUT_MS: 300000,

    components: [
        { kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
            { kind: "Image", src: "images/header-icon.png", style: "width:32px; height:32px; vertical-align:middle; margin-right:6px;" },
            { kind: "Control", name: "title", content: "Sign In"}
        ]},
        { className: "accounts-header-shadow" },

        // Transport auth channel (QR). Polled, not subscribed (subscription push is unreliable here).
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
                    { kind: "Input", name: "displayName", hint: "e.g. My WhatsApp", spellcheck: false,
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
                  content: "Enter your phone number in <b>international format</b> (e.g. +15551234567) and tap <b>Sign In</b>. A QR code appears here — open <b>WhatsApp → Linked Devices → Link a Device</b> and scan it." },
                { kind: "ActivityButton", name: "signInButton", caption: "Sign In", disabled: true, active: false,
                  className: "enyo-button-dark accounts-btn", onclick: "performSignIn" },

                // Standard framework Remove Account (kind: Accounts.RemoveAccount) - the same button +
                // confirm dialog the Accounts app uses, so it carries the "keep this account's data on
                // this device" option. Shown only when editing an existing account; sits directly below
                // Sign In. init() with no capability => full-account deleteAccount.
                { name: "removeAccountButton", kind: "Accounts.RemoveAccount", className: "accounts-btn",
                  showing: false, style: "padding-top:6px;", onAccountsRemove_Done: "removeDone" }
            ]},

            // -------- Inline QR view --------
            { name: "qrBox", showing: false, className: "box-center", style: "text-align:center;", components: [
                { name: "qrTitle", className: "accounts-body-text", style: "padding:14px 16px 4px; font-size:20px;",
                  content: "Link WhatsApp" },
                { name: "qrStatus", className: "accounts-body-text", style: "padding:2px 16px 10px; opacity:0.8; line-height:1.4;",
                  content: "Preparing your QR code…" },
                // Pairing code (preferred on a small screen): the user picks "Link with phone
                // number instead" in WhatsApp and types this. Populated from resp.urlString.
                { name: "pairingWrap", showing: false, style: "margin:6px auto 2px; text-align:center;", components: [
                    { className: "accounts-body-text", style: "opacity:0.8;", content: "Enter this code in WhatsApp:" },
                    { name: "pairingCode", style: "font-size:30px; font-weight:bold; letter-spacing:4px; padding:6px 0 4px; font-family:monospace;", content: "" },
                    { className: "accounts-body-text", style: "opacity:0.6; font-size:13px;", content: "WhatsApp → Linked Devices → Link a Device → Link with phone number instead" },
                    { className: "accounts-body-text", style: "opacity:0.5; padding-top:8px;", content: "— or scan the QR code below —" }
                ]},
                { name: "qrImageWrap", showing: false, style: "background:#fff; padding:14px; border-radius:10px; width:230px; height:230px; margin:10px auto; text-align:center;",
                  components: [
                    { name: "qrImg", kind: "Image", style: "display:block; width:230px; height:230px; margin:0 auto; image-rendering:pixelated; -ms-interpolation-mode:nearest-neighbor;" }
                ]},
                { className: "accounts-body-text", style: "padding:8px 24px; opacity:0.6; line-height:1.4;",
                  content: "On your phone: WhatsApp → Settings → Linked Devices → Link a Device, then point it here. Each code expires after a few seconds and refreshes automatically." },
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
        this.handleLaunch(enyo.windowParams || {});
    },

    handleLaunch: function(params) {
        this.params = params || {};
        this.template = null;
        if (params.template && params.template.templateId === "com.palm.whatsapp") {
            this.template = params.template;
        } else if (params.allTemplates) {
            for (var i = 0; i < params.allTemplates.length; i++) {
                if (params.allTemplates[i].templateId === "com.palm.whatsapp") { this.template = params.allTemplates[i]; break; }
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

    log: function(m) { try { enyo.log(m); } catch (e) {} },
    trim: function(v) { return (v || "").replace(/^\s+|\s+$/g, ""); },

    getAlias: function(phone) {
        var n = this.trim(this.$.displayName.getValue());
        if (n) { return n; }
        // No custom display name: default to the phone number in readable +E.164 form (strip the
        // "@s.whatsapp.net" JID suffix, drop any existing '+', then prepend one) instead of the raw
        // digits/JID -- so the account reads like the Signal/Telegram ones (e.g. "+31652044684").
        var digits = String(phone || "").replace(/@s\.whatsapp\.net$/, "").replace(/^\+/, "");
        return digits ? ("+" + digits) : "";
    },

    normalizePhone: function(v) {
        // whatsmeow identifies the account by the bare number (its device ID is
        // e.g. "31652044684@s.whatsapp.net"); gowhatsapp errors ("username does not
        // match the main device's ID") if the account username carries a leading '+'.
        // So the username is DIGITS ONLY — no '+', no separators.
        return (v || "").replace(/[^\d]/g, "");
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
        // Store the webOS account username as +E.164 ("+31652044684") so it displays like the
        // Signal/Telegram accounts everywhere (Accounts, Contacts, Messaging). gowhatsapp still
        // needs whatsmeow's device-ID JID ("31652044684@s.whatsapp.net") as the *purple* account
        // username, but the transport now derives that from the +E.164 form (getPurpleUsername),
        // so the webOS side no longer has to carry the JID.
        this.startQRSignIn("+" + phone);
    },

    // ---- create-after-confirm QR flow ---------------------------------------

    startQRSignIn: function(phone) {
        this._qrUser = phone;
        this._qrActive = true;
        this._qrPollCount = 0;
        this._qrShownImage = false;
        this.$.entryBox.hide();
        this.$.qrBox.show();
        this.$.pairingWrap.hide();
        this.$.qrImageWrap.hide();
        this.$.qrRefreshButton.hide();
        this.$.qrStatus.setContent("Preparing your QR code…");
        this.$.startQR.call({ serviceName: this.SERVICE_NAME, username: phone });
    },

    qrStarted: function() { if (this._qrActive) { this.startQRPoll(); } },

    qrStartFailed: function(inSender, err) {
        this.log("whatsapp: startQRLogin failed: " + enyo.json.stringify(err));
        this.abortQR("Couldn't start QR sign-in. Please try again.");
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

    gotChallenge: function(inSender, resp) {
        if (!this._qrActive) { return; }
        // Pairing code (transport surfaces gowhatsapp's pairing_code as urlString).
        if (resp && resp.urlString) {
            this.$.pairingCode.setContent(resp.urlString);
            this.$.pairingWrap.show();
        }
        // whatsmeow rotates the QR every few seconds; always take the newest image.
        if (resp && resp.qrImage) {
            this.$.qrImg.setSrc(resp.qrImage);
            this.$.qrImageWrap.show();
            this._qrShownImage = true;
        }
        switch (resp && resp.state) {
            case "waiting":
                this.$.qrStatus.setContent(this._qrShownImage
                    ? "Scan this code with WhatsApp on your phone."
                    : "Preparing your QR code…");
                break;
            case "scanned":
                this.$.qrStatus.setContent("Scanned — linking your device…");
                break;
            case "confirmed":
                this.stopQRPoll();
                this._qrActive = false;
                this.$.qrStatus.setContent("Linked! Finishing setup…");
                // The confirmed credential is gowhatsapp's "deviceJID|registrationId"
                // (transport surfaces the paired account's password as resp.token). Store it
                // as the account password so future logins reuse the session — no re-pairing.
                this.finishWithResult(this._qrUser, (resp && resp.token) ? resp.token : "whatsapp-link-pending");
                break;
            case "expired":
                this.qrExpired("That code expired.");
                break;
            case "failed":
                this.abortQR((resp && resp.message) || "WhatsApp sign-in failed.");
                break;
            default:
                break;   // keep polling
        }
    },

    challengeError: function(inSender, err) {
        // transient luna errors while the pending login spins up — keep polling
        this.log("whatsapp: getAuthChallenge error: " + enyo.json.stringify(err));
    },

    refreshQR: function() {
        if (!this._qrUser) { return; }
        this.$.qrRefreshButton.hide();
        this._qrShownImage = false;
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
        // cancel the pending transport login, return to the entry form with the error.
        this.$.submitAuth.call({ serviceName: this.SERVICE_NAME, username: this._qrUser, action: "cancel" });
        this.$.qrBox.hide();
        this.$.entryBox.show();
        this.$.signInButton.setActive(false);
        this.$.signInButton.setDisabled(false);
        this.showError(msg || "Sign-in failed.");
    },

    finishWithResult: function(phone, credential) {
        var result = {
            returnValue: true,
            username: phone,
            alias: this.getAlias(phone),
            credentials: { common: { password: credential || "whatsapp-link-pending" } },
            config: {},
            template: this.template || { templateId: "com.palm.whatsapp" },
            templateId: "com.palm.whatsapp"
        };
        this.$.crossAppResult.sendResult(result);
    },

    // Fired by Accounts.RemoveAccount (onAccountsRemove_Done) once the framework has handled the
    // confirm dialog (incl. the keep-data option) and the deleteAccount call. Just return to the
    // Accounts app - the account is gone either way.
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
