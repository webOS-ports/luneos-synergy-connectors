// Discord account custom-validator UI (webOS Synergy / Accounts customUI).
//
// Loaded as a cross-app IFRAME by the Accounts framework (entry-add.js ->
// Accounts.crossAppUI -> CrossAppUI). Enyo 0.10 app that returns the account via
// enyo.CrossAppResult.sendResult({returnValue, username, credentials, config,
// template, templateId}); the framework then calls createAccount, and on the
// MESSAGING/IM capability's onEnabled imlibpurpletransport logs in via prpl-discord.
//
// --- WHY A CUSTOM UI (not the generic checkCredentials validator) ------------
// The stock 2011 imaccountvalidator has a hardcoded template whitelist and rejects
// templateId "com.palm.discord" with "Invalid templateId in payload" (error 22) ->
// the accounts UI shows "Unknown error" before Discord is ever contacted. Teams and
// Telegram sidestep the stock validator with a customUI; Discord does the same here.
//
// --- TWO WAYS TO AUTHENTICATE ------------------------------------------------
// 1. AUTH TOKEN (advanced): user pastes their Discord web auth token; it becomes the
//    account password and patched libdiscord.c logs in with it directly (no captcha).
// 2. QR CODE (default, "create-after-confirm"): user leaves the token blank and taps
//    Sign In. Instead of creating the account immediately, we ask the transport to run
//    a PENDING prpl-discord remote-auth login (com.palm.imlibpurple/startQRLogin) purely
//    to obtain a token. The transport surfaces the QR image over getAuthChallenge; we
//    render it INLINE here and poll until Discord reports the phone approved the scan.
//    ONLY THEN do we sendResult(), creating the account already holding the real token
//    (credentials.password), so later logins never need the QR again. This replaces the
//    old flow (plugin wrote a PNG to Photos + shell-launched a separate full-screen
//    com.palm.app.discordqr card, with no completion signal).
//
// --- TRANSPORT LUNA CONTRACT (com.palm.imlibpurple) --------------------------
//   startQRLogin   {serviceName, username}                -> {returnValue}
//   getAuthChallenge {serviceName, username}              -> {returnValue, state,
//                       qrImage?/*data-URI*/, urlString?, message?, token?/*confirmed*/}
//                    state in: waiting | scanned | confirmed | expired | failed
//   submitAuthInput {serviceName, username, action}       action in: refresh | cancel
// We POLL getAuthChallenge (not subscribe-push): luna subscription push is unreliable
// inside the accounts customUI iframe (see the Teams validator's OAuth poll for the same
// lesson). The transport method still supports subscribe for other clients.
// NOTE (device integration): com.palm.imlibpurple is registered on the PRIVATE bus
// (ls2/roles/prv/com.palm.imlibpurple.json); these methods must be exposed so this app
// (public bus) may call them. That role/permission wiring lands with the transport build.

// --- Atlas engine embed (inline hCaptcha) ------------------------------------
// The Accounts webview runs webOS 3.0.5's 2011-era WebKit, whose JS engine can't run
// hCaptcha's modern (ES6+) api.js -> the inline-DOM render failed ("Couldn't load
// verification"). enyo 0.10 DOES ship enyo.BasicWebView/WebView (an NPAPI-plugin control);
// swapping its plugin mime to application/x-atlas-browser routes it to OUR BrowserServer-atlas
// (WPE, modern WebKit). We embed such a WebView INLINE in the validator (no card) to render
// the captcha in a modern engine. The engine intercepts the solved-token redirect (a
// msauth*-prefixed sentinel -> the backend's existing oauthRedirect capture, no backend
// rebuild) and fires actionData("oauthRedirect", url) on the WebView instance; we walk the
// owner chain to the Validator's engineCaptchaRedirect and hand back the token.
(function () {
    function patch() {
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
                    if (typeof c.engineCaptchaRedirect === "function") { c.engineCaptchaRedirect(data); break; }
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

    SERVICE_NAME: "type_discord",
    QR_POLL_MS: 2000,
    QR_TIMEOUT_MS: 160000,   // ~2min QR TTL + grace

    components: [
        { kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
            { kind: "Image", src: "images/header-icon.png", style: "width:32px; height:32px; vertical-align:middle; margin-right:6px;" },
            { kind: "Control", name: "title", content: "Sign In"}
        ]},
        { className: "accounts-header-shadow" },

        // Transport auth channel (QR). Polled, not subscribed (see header note).
        { name: "startQR", kind: "PalmService", service: "palm://com.palm.imlibpurple/",
          method: "startQRLogin", onSuccess: "qrStarted", onFailure: "qrStartFailed" },
        { name: "getChallenge", kind: "PalmService", service: "palm://com.palm.imlibpurple/",
          method: "getAuthChallenge", onSuccess: "gotChallenge", onFailure: "challengeError" },
        { name: "submitAuth", kind: "PalmService", service: "palm://com.palm.imlibpurple/",
          method: "submitAuthInput" },

        { kind: "Scroller", flex: 1, components: [
            // -------- Credential entry (username + optional token) --------
            { name: "entryBox", className: "box-center", components: [
                { kind: "RowGroup", caption: "USERNAME (Discord handle or email)", className: "accounts-group", components: [
                    { kind: "Input", name: "username", hint: "e.g. myname", spellcheck: false,
                      autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase",
                      oninput: "validateInput", onkeydown: "checkForEnter" }
                ]},
                { kind: "RowGroup", caption: "AUTH TOKEN (optional — leave blank for QR)", className: "accounts-group", components: [
                    { kind: "Input", name: "token", hint: "leave blank to sign in with a QR code", spellcheck: false,
                      autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase",
                      oninput: "validateInput", onkeydown: "checkForEnter" }
                ]},
                { name: "errorBox", kind: "HFlexBox", showing: false, align: "center", className: "error-box", components: [
                    { name: "errorMessage", className: "enyo-text-error", flex: 1 }
                ]},
                { className: "accounts-body-text", style: "padding: 12px 16px; line-height: 1.4;", allowHtml: true,
                  content: "<b>Easiest: leave the token blank and tap Sign In.</b> A QR code will appear right here — on your phone open <b>Discord → Settings → Scan QR Code</b> and point it at this screen to approve. No password, no captcha." },
                { className: "accounts-body-text", style: "padding: 4px 16px 12px; line-height: 1.4; opacity: 0.7;", allowHtml: true,
                  content: "Advanced: to skip the phone step, paste your Discord web <b>auth token</b> (DevTools → Network → any request → <b>authorization</b> header). Keep it private — it grants full account access." },
                { kind: "ActivityButton", name: "signInButton", caption: "Sign In", disabled: true, active: false,
                  className: "enyo-button-dark accounts-btn", onclick: "performSignIn" },

                // Standard framework Remove Account (with keep-data option); shown only when editing an
                // existing account; sits directly below Sign In. init() with no capability => full delete.
                { name: "removeAccountButton", kind: "Accounts.RemoveAccount", className: "accounts-btn",
                  showing: false, style: "padding-top:6px;", onAccountsRemove_Done: "removeDone" }
            ]},

            // -------- Inline QR view (shown during QR sign-in) --------
            { name: "qrBox", showing: false, className: "box-center", style: "text-align:center;", components: [
                { name: "qrTitle", className: "accounts-body-text", style: "padding:14px 16px 4px; font-size:20px;",
                  content: "Sign in to Discord" },
                { name: "qrStatus", className: "accounts-body-text", style: "padding:2px 16px 10px; opacity:0.8; line-height:1.4;",
                  content: "Preparing your QR code…" },
                { name: "qrImageWrap", showing: false, style: "background:#fff; padding:14px; border-radius:10px; width:230px; height:230px; margin:10px auto; text-align:center;",
                  components: [
                    { name: "qrImg", kind: "Image", style: "display:block; width:230px; height:230px; margin:0 auto; image-rendering:pixelated; -ms-interpolation-mode:nearest-neighbor;" }
                ]},
                // -------- Inline hCaptcha in an embedded Atlas (WPE) WebView -----------
                // Host container; the WebView is created lazily (renderCaptcha) so we don't
                // spin up a WPE WebProcess unless Discord actually demands a captcha.
                { name: "captchaBox", showing: false, style: "margin:8px 0 0; width:100%; height:560px;" },
                { className: "accounts-body-text", style: "padding:8px 24px; opacity:0.6; line-height:1.4;",
                  content: "On your phone: Discord → Settings → Scan QR Code, then point it here. The code expires after about 2 minutes." },
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
        if (params.template && params.template.templateId === "com.palm.discord") {
            this.template = params.template;
        } else if (params.allTemplates) {
            for (var i = 0; i < params.allTemplates.length; i++) {
                if (params.allTemplates[i].templateId === "com.palm.discord") {
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
        }
        this.validateInput();
    },

    getAlias: function(username) {
        var n = (this.$.username.getValue() || "").replace(/^\s+|\s+$/g, "");
        return n || username;
    },

    trim: function(v) { return (v || "").replace(/^\s+|\s+$/g, ""); },

    validateInput: function() {
        // Username is the account key/label; token is OPTIONAL (blank => QR login).
        var user = this.trim(this.$.username.getValue());
        this.$.signInButton.setDisabled(user.length === 0);
    },

    checkForEnter: function(inSender, e) {
        if (e && e.keyCode === 13 && !this.$.signInButton.getDisabled()) {
            this.$.token.forceBlur();
            this.performSignIn();
        }
    },

    showError: function(msg) {
        this.$.errorMessage.setContent(msg || "");
        if (msg) { this.$.errorBox.show(); } else { this.$.errorBox.hide(); }
    },

    performSignIn: function() {
        var user = this.trim(this.$.username.getValue());
        var token = this.trim(this.$.token.getValue());
        if (!user) { return; }
        this.showError("");
        this.$.signInButton.setActive(true);
        this.$.signInButton.setDisabled(true);

        if (token) {
            // Advanced path: token entered -> it IS the credential; create immediately.
            this.finishWithCredential(user, token);
            return;
        }
        // Default path: no token -> inline QR sign-in via the transport.
        this.startQRSignIn(user);
    },

    // ---- create-after-confirm QR flow ---------------------------------------

    startQRSignIn: function(user) {
        this._qrUser = user;
        this._qrActive = true;
        this._qrPollCount = 0;
        this._qrShownImage = false;
        this._captchaRendered = false;
        this._captchaSubmitted = false;
        this.destroyCaptchaWeb();
        // Switch to the QR view.
        this.$.entryBox.hide();
        this.$.qrBox.show();
        this.$.qrImageWrap.hide();
        this.$.captchaBox.hide();
        this.$.qrRefreshButton.hide();
        this.$.qrStatus.setContent("Preparing your QR code…");
        // Ask the transport to spin up the pending remote-auth login.
        this.$.startQR.call({ serviceName: this.SERVICE_NAME, username: user });
    },

    qrStarted: function() {
        if (!this._qrActive) { return; }
        this.startQRPoll();
    },

    qrStartFailed: function(inSender, err) {
        this.log("discord: startQRLogin failed: " + enyo.json.stringify(err));
        this.abortQR("Couldn't start QR sign-in. Please try again.");
    },

    startQRPoll: function() {
        this.stopQRPoll();
        var self = this;
        this._qrPoll = window.setInterval(function () { self.pollChallenge(); }, this.QR_POLL_MS);
        this.pollChallenge();   // immediate first poll
    },

    stopQRPoll: function() {
        if (this._qrPoll) { window.clearInterval(this._qrPoll); this._qrPoll = null; }
    },

    pollChallenge: function() {
        if (!this._qrActive) { this.stopQRPoll(); return; }
        this._qrPollCount++;
        if (this._qrPollCount * this.QR_POLL_MS > this.QR_TIMEOUT_MS) {
            this.qrExpired("Sign-in timed out.");
            return;
        }
        this.$.getChallenge.call({ serviceName: this.SERVICE_NAME, username: this._qrUser });
    },

    gotChallenge: function(inSender, resp) {
        if (!this._qrActive) { return; }
        var state = resp && resp.state;
        var kind = resp && resp.kind;

        // Discord gated the ticket->token exchange behind an hCaptcha: swap the QR for an
        // inline hCaptcha widget. The solved token is fed back via submitAuthInput(captcha);
        // the transport re-POSTs remote-auth/login and (on success) reports state=confirmed.
        if (kind === "captcha") {
            this.$.qrImageWrap.hide();
            this.$.qrRefreshButton.hide();
            this.$.captchaBox.show();
            if (state === "waiting" && !this._captchaRendered && !this._captchaSubmitted) {
                this.$.qrTitle.setContent("Verify you're human");
                this.$.qrStatus.setContent("Discord needs one quick check. Complete the box below.");
                this.renderCaptcha(resp.captchaSitekey, resp.captchaRqData);
            }
            // still handle terminal states (confirmed/failed/expired) via the switch below
            if (state === "waiting" || state === "scanned") { return; }
        }

        if (resp && resp.qrImage && !this._qrShownImage) {
            this.$.qrImg.setSrc(resp.qrImage);
            this.$.qrImageWrap.show();
            this._qrShownImage = true;
        }
        switch (state) {
            case "waiting":
                this.$.qrStatus.setContent("Scan this code with the Discord app on your phone.");
                break;
            case "scanned":
                this.$.qrStatus.setContent("Scanned — now approve the sign-in on your phone…");
                break;
            case "confirmed":
                this.stopQRPoll();
                this._qrActive = false;
                this.destroyCaptchaWeb();
                this.$.captchaBox.hide();
                this.$.qrStatus.setContent("Signed in! Finishing setup…");
                // Prefer the real token the handshake produced; fall back to the QRLOGIN
                // sentinel (the transport re-runs remote-auth on next login) if the
                // transport did not (yet) surface a token.
                var secret = (resp && resp.token) ? resp.token : "QRLOGIN";
                this.finishWithCredential(this._qrUser, secret);
                break;
            case "expired":
                this.qrExpired("That code expired.");
                break;
            case "failed":
                this.abortQR((resp && resp.message) || "Discord sign-in failed.");
                break;
            default:
                // no challenge yet / unknown -> keep polling
                break;
        }
    },

    // ---- inline hCaptcha (Discord remote-auth captcha gate) -----------------
    // Render Discord's hCaptcha directly in this accounts webview. The solved response
    // token is handed back to the transport (submitAuthInput action=captcha), which
    // re-POSTs remote-auth/login. Runs in the accounts UI's own (old) WebKit; if it can't
    // reach hcaptcha.com the error path offers a refresh (and we can fall back to Atlas).
    renderCaptcha: function(sitekey, rqdata) {
        if (this._captchaRendered) { return; }
        this._captchaRendered = true;
        this._captchaSitekey = sitekey;
        this._captchaRqdata = rqdata || "";
        // Discord's hCaptcha rqdata is ORIGIN-BOUND to discord.com; a data:/null origin is
        // rejected as "invalid-data". Load the page via the adapter's setHTML, which calls
        // webkit_web_view_load_html(body, baseUri) — with baseUri "https://discord.com/" the
        // page's security origin becomes discord.com, so rqdata validates. setHTML must run
        // AFTER the adapter connects (onConnected), else the call is dropped.
        this._captchaHtml = this.buildCaptchaHtml(sitekey, this._captchaRqdata);
        this._captchaLoaded = false;
        if (!this.$.captchaWeb) {
            this.$.captchaBox.createComponent({
                name: "captchaWeb", kind: "WebView", width: "100%", height: "560px",
                // Seed the initial URL with the "atlas-simple:" marker so whatever triggers the
                // FIRST ensureWebView on the backend (a connect auto-load OR our explicit openURL)
                // builds the screen-sized mult=1 viewport, not the 1024x3072 tall pan buffer.
                url: "atlas-simple:about:blank",
                onConnected: "captchaConnected", onError: "captchaWebError"
            }, { owner: this });
            this.$.captchaBox.render();
        } else {
            this.captchaConnected();   // already connected -> load immediately
        }
        // Fallback: the Atlas-routed adapter may not fire onConnected the way the stock
        // plugin does. If captchaConnected hasn't loaded within 3s, force the load anyway
        // (callBrowserAdapter before connect is a silent no-op, so by 3s it should land).
        // NB: enyo 0.10 has no startJob/stopJob — use plain window timers (as QR poll does).
        this.clearCaptchaLoadTimer();
        var self = this;
        this._captchaLoadTimer = window.setTimeout(function () { self.captchaConnected(); }, 3000);
        this.$.qrStatus.setContent("Loading verification…");
    },

    clearCaptchaLoadTimer: function() {
        if (this._captchaLoadTimer) { window.clearTimeout(this._captchaLoadTimer); this._captchaLoadTimer = null; }
    },

    // Adapter connected -> load the captcha HTML with a discord.com security origin.
    // Guarded so a real onConnected and the 3s fallback don't double-load (which would
    // reset the hCaptcha widget mid-challenge).
    captchaConnected: function() {
        if (this._captchaLoaded || !this._captchaHtml || !this.$.captchaWeb) { return; }
        this._captchaLoaded = true;
        this.clearCaptchaLoadTimer();
        try {
            // Enter Atlas simple/MODE-2 viewport (screen-sized, mult=1) BEFORE setHTML so the page
            // lays out at display width (legible) instead of the 1024x3072 tall buffer. openURL with
            // the "atlas-simple:" marker sets m_simpleMode; ensureWebView locks the buffer at build
            // time, so this must run before the first content load. setHTML then reuses the view.
            // (Same viewport mode the Teams OAuth webview uses — reusable for the OAuth2 integration.)
            this.$.captchaWeb.callBrowserAdapter("openURL", ["atlas-simple:about:blank"]);
            this.$.captchaWeb.callBrowserAdapter("setHTML", ["https://discord.com/", this._captchaHtml]);
        }
        catch (e) { this.log("discord: setHTML failed: " + e); this._captchaLoaded = false; this.onCaptchaError(); }
    },

    // Self-contained hCaptcha page. On solve it navigates to a msauth*-prefixed sentinel
    // carrying the token — the Atlas engine intercepts that (existing oauthRedirect capture)
    // and fires actionData -> engineCaptchaRedirect. Loaded via setHTML (discord.com origin).
    buildCaptchaHtml: function(sitekey, rqdata) {
        var REDIR = "msauthdiscordcaptcha://done";
        // VERBOSE DIAGNOSTIC PAGE: an on-page append-only log surfaces every step (origin,
        // api-ready, render, wid, tap, execute, challenge open/error) since the embedded WPE
        // WebView has no reachable JS console. Once the flow is confirmed we trim this back.
        var html =
            '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
            '<style>html,body{margin:0;padding:0}body{font-family:sans-serif;padding:12px;text-align:center;background:#f7f7f9;color:#333}' +
            '#h{margin:4px 0 10px;font-size:16px}#cap{display:flex;justify-content:center;min-height:80px;margin-bottom:8px}' +
            '#s,#p{margin-top:8px;font-size:15px;line-height:1.35;color:#222;text-align:left;white-space:pre-wrap;word-wrap:break-word;' +
            'background:#fff;border:1px solid #ccc;border-radius:6px;padding:8px}#s{min-height:80px}#p{color:#063;min-height:56px}</style>' +
            '<script src="https://js.hcaptcha.com/1/api.js?render=explicit" async defer><\/script></head><body>' +
            '<div id="h">Verify you’re human</div>' +
            '<div id="t" style="background:#5865F2;color:#fff;padding:12px;border-radius:8px;margin-bottom:8px">TEST BAR — tap me</div>' +
            '<div id="cap"></div><div id="p"></div><div id="s"></div><script>' +
            'var SK=' + enyo.json.stringify(sitekey) + ',RQ=' + enyo.json.stringify(rqdata || "") + ',RD=' + enyo.json.stringify(REDIR) + ';' +
            'var L=document.getElementById("s"),N=0;' +
            // Live DOM probe: every 1.2s list all iframes (host, size, position, visibility). After a
            // checkbox tap we can see if hCaptcha injected a challenge iframe and whether it is merely
            // hidden/off-screen (CSS fix) vs never created (events not reaching the widget iframe).
            'var P=document.getElementById("p");' +
            'function probe(){try{var fs=document.getElementsByTagName("iframe"),o="iframes="+fs.length;' +
            'for(var i=0;i<fs.length;i++){var f=fs[i],r=f.getBoundingClientRect(),cs=window.getComputedStyle(f),' +
            'src=(f.src||"about:blank").replace(/^https?:\\/\\//,"").substr(0,22);' +
            'o+="\\n["+i+"] "+src+" "+Math.round(r.width)+"x"+Math.round(r.height)+" @"+Math.round(r.left)+","+Math.round(r.top)+' +
            '" v="+cs.visibility.substr(0,4)+" d="+cs.display.substr(0,5)+" op="+cs.opacity+" z="+cs.zIndex;}' +
            'P.textContent=o;}catch(e){P.textContent="probe err "+e;}}' +
            'setInterval(probe,1200);' +
            // TEST BAR confirms top-level taps still work in this layout; coordinate logging on the
            // document tells us WHERE the engine thinks each tap landed (vs the checkbox @x,y from
            // the probe). A tap on the checkbox that logs here = it did NOT enter the iframe; a tap
            // that logs coords far from where you touched = a hit-test/coordinate offset bug.
            'document.getElementById("t").onclick=function(){log("TEST BAR click");};' +
            'document.addEventListener("click",function(e){log("doc click @"+e.clientX+","+e.clientY);},true);' +
            'document.addEventListener("touchend",function(e){var t=e.changedTouches&&e.changedTouches[0];log("doc touchend @"+(t?t.clientX+","+t.clientY:"?"));},true);' +
            'function log(m){N++;L.textContent+=N+") "+m+"\\n";}' +
            'window.onerror=function(m,u,l){log("JSERR "+m+" @"+l);return false;};' +
            'function done(t){log("SOLVED len="+(t?t.length:0));location.href=RD+"?key="+encodeURIComponent(t);}' +
            'function err(m){log("ERR "+m);}' +
            // Viewport-scaling readout (explains the tap-coordinate offset) + per-host reachability
            // probes: the "network error" means hCaptcha cannot fetch its challenge; find which host
            // fails. newassets/js already proven reachable (checkbox rendered); hcaptcha.com + the
            // image CDN are the suspects. Image onload == reachable+served; onerror is ambiguous.
            'log("vp "+window.innerWidth+"x"+window.innerHeight+" dpr="+window.devicePixelRatio);' +
            'function img(h){var im=new Image();im.onload=function(){log("IMG ok "+h);};im.onerror=function(){log("IMG err "+h);};im.src="https://"+h+"/favicon.ico?x="+(new Date().getTime());}' +
            'img("hcaptcha.com");img("imgs.hcaptcha.com");img("newassets.hcaptcha.com");' +
            // VISIBLE checkbox flow: mount a normal hCaptcha widget (rqdata baked into render config,
            // valid now that the page origin is discord.com). User taps the checkbox directly; the
            // challenge opens as an in-page overlay from that tap (no gesture-triggered execute() to
            // be swallowed). Every callback logs so we can see open/solve/error.
            'log("origin="+location.origin);log("rqL="+(RQ?RQ.length:0)+" rq["+RQ.substr(0,6)+".."+RQ.substr(RQ.length-6)+"]");' +
            'function boot(){if(!(window.hcaptcha&&window.hcaptcha.render)){return setTimeout(boot,150);}' +
            'log("api ready — tap the checkbox");' +
            'try{var opt={sitekey:SK,callback:done,' +
            '"error-callback":function(e){err("cb "+e);},"open-callback":function(){log("challenge OPENED");},' +
            '"chalexpired-callback":function(){err("chalexpired");},"expired-callback":function(){err("expired");},' +
            '"close-callback":function(){log("closed");}};' +
            'if(RQ&&RQ.length){opt.rqdata=RQ;}' +
            'var wid=hcaptcha.render("cap",opt);log("rendered wid="+wid);}catch(e){err("render "+e);}}' +
            'boot();<\/script></body></html>';
        // Return RAW HTML — loaded via setHTML(baseUri) so the page gets a discord.com origin.
        return html;
    },

    // Atlas engine captured the solved-token redirect (msauth*...?key=TOKEN).
    engineCaptchaRedirect: function(url) {
        if (!this._qrActive || this._captchaSubmitted) { return; }
        var m = /[?&]key=([^&]+)/.exec(url || "");
        var token = m ? decodeURIComponent(m[1]) : "";
        if (!token) { this.log("discord: captcha redirect had no key: " + (url || "").substring(0, 60)); return; }
        this._captchaSubmitted = true;
        this.log("discord: captcha solved via Atlas webview, submitting");
        this.destroyCaptchaWeb();
        this.$.captchaBox.hide();
        this.$.qrStatus.setContent("Verifying…");
        this.$.submitAuth.call({ serviceName: this.SERVICE_NAME, username: this._qrUser,
                                 action: "captcha", value: token });
        // keep polling getAuthChallenge for state=confirmed
    },

    captchaWebError: function() {
        this.log("discord: captcha WebView error (Atlas engine unreachable?)");
        this.onCaptchaError();
    },

    destroyCaptchaWeb: function() {
        this.clearCaptchaLoadTimer();
        this._captchaLoaded = false;
        this._captchaHtml = null;
        if (this.$.captchaWeb) {
            // Release the WPE WebProcess so it doesn't leak past the validator's short life.
            try { this.$.captchaWeb.callBrowserAdapter("disconnectBrowserServer", []); } catch (e) {}
            try { this.$.captchaWeb.destroy(); } catch (e2) {}
        }
    },

    onCaptchaError: function() {
        this._captchaRendered = false;
        this.destroyCaptchaWeb();
        this.$.qrStatus.setContent("Couldn't load the verification. Check your connection, then get a new code.");
        this.$.captchaBox.hide();
        this.$.qrRefreshButton.show();
    },

    challengeError: function(inSender, err) {
        // Transient luna error -> keep polling; only surface if it persists past timeout.
        this.log("discord: getAuthChallenge error: " + enyo.json.stringify(err));
    },

    qrExpired: function(msg) {
        this.stopQRPoll();
        this.$.qrStatus.setContent(msg + " Get a fresh one to try again.");
        this.$.qrImageWrap.hide();
        this.$.qrRefreshButton.show();
    },

    refreshQR: function() {
        this.$.qrRefreshButton.hide();
        this.$.qrImageWrap.hide();
        this.destroyCaptchaWeb();
        this.$.captchaBox.hide();
        this.$.qrTitle.setContent("Sign in to Discord");
        this._qrShownImage = false;
        this._captchaRendered = false;
        this._captchaSubmitted = false;
        this._qrPollCount = 0;
        this._qrActive = true;
        this.$.qrStatus.setContent("Getting a new QR code…");
        this.$.submitAuth.call({ serviceName: this.SERVICE_NAME, username: this._qrUser, action: "refresh" });
        this.startQRPoll();
    },

    // Give up on the QR flow: tell the transport to tear down the pending login and
    // return to credential entry so the user can retry or paste a token.
    abortQR: function(msg) {
        this.stopQRPoll();
        this._qrActive = false;
        if (this._qrUser) {
            this.$.submitAuth.call({ serviceName: this.SERVICE_NAME, username: this._qrUser, action: "cancel" });
        }
        this.destroyCaptchaWeb();
        this.$.captchaBox.hide();
        this.$.qrBox.hide();
        this.$.entryBox.show();
        this.$.signInButton.setActive(false);
        this.validateInput();
        this.showError(msg);
    },

    finishWithCredential: function(user, secret) {
        var result = {
            returnValue: true,
            username: user,
            alias: this.getAlias(user),
            credentials: { common: { password: secret } },
            config: {},
            template: this.template || { templateId: "com.palm.discord" },
            templateId: "com.palm.discord"
        };
        this.$.crossAppResult.sendResult(result);
    },

    // Fired by Accounts.RemoveAccount (onAccountsRemove_Done) once the framework handled the confirm
    // dialog (incl. the keep-data option) and the deleteAccount call. Return to the Accounts app.
    removeDone: function() {
        this.$.crossAppResult.sendResult({ returnValue: false });
    },
    cancel: function() {
        this.stopQRPoll();
        this.destroyCaptchaWeb();
        if (this._qrActive && this._qrUser) {
            // Cancel the pending remote-auth login so it doesn't linger in the transport.
            this.$.submitAuth.call({ serviceName: this.SERVICE_NAME, username: this._qrUser, action: "cancel" });
        }
        this._qrActive = false;
        this.$.crossAppResult.sendResult({ returnValue: false });
    }
});
