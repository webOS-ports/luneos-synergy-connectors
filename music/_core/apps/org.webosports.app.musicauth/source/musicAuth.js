/* MusicAuth — customUI validator for the music account types (org.webosports.app.music.*).
 *
 * Styled like the Synergy IM validators (Google Chat / Signal / WhatsApp): an
 * enyo-bg card with an accounts-header (connector logo + title), a box-center
 * body of accounts-group RowGroups, an ActivityButton primary action, and a
 * bottom Toolbar with Cancel. Depends on $enyo-lib/accounts/css/accounts-list.css
 * for that styling.
 *
 * Per service (serviceId = last dotted segment of the templateId):
 *   spotify -> OAuth (backend /login web flow, poll /auth/status), through the
 *              user's own Spotify developer app: Spotify keeps an app in
 *              development mode to five users, so each user registers one and
 *              gives its client id here first (/auth/client-id).
 *   tidal   -> device-code, shown WhatsApp "link-code" style (code + instructions);
 *              polls /tidalauth/poll, then names the account with the real username.
 *   qobuz   -> email + password -> /qobuzauth/login.
 *   subsonic -> server + username + password -> /subsonicauth/login (Navidrome,
 *              Airsonic, Gonic... - any server that speaks the Subsonic API).
 *   deezer  -> email + password -> /dzauth/login (pulls the ARL for you); if Deezer
 *              blocks the login it reveals an ARL field -> /dzauth/save.
 *   radio   -> optionally the address of a station list (M3U or PLS) ->
 *              /radioauth/lists, which reads it before keeping it; Radio
 *              Browser's stations need nothing.
 *   youtube/soundcloud/jamendo/archive -> no credentials, just add.
 *
 * Returns the account via enyo.CrossAppResult.sendResult({returnValue, username,...}).
 */
var BACKEND = "http://127.0.0.1:8730";

function mlog(s) {
	try { enyo.log("MUSICAUTH: " + s); } catch (e) {}
	try { console.log("MUSICAUTH: " + s); } catch (e2) {}
}

// Route enyo.BasicWebView to the Atlas/WPE engine (once, at load) — the same patch
// spotifyView.js uses so the embedded WebView actually renders on legacy webOS. LuneOS has no
// NPAPI plugin to re-point and hosts the sign-in page in a window.open()ed WAM window instead —
// see oauthWindow.js and openWindow() below.
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
		return true;
	}
	if (!patch() && window.enyo) {
		var t = window.setInterval(function () { if (patch()) { window.clearInterval(t); } }, 50);
	}
})();

enyo.kind({
	name: "MusicAuth",
	kind: enyo.VFlexBox,
	className: "enyo-bg",

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ name: "headerIcon", kind: "Image", style: "width:32px; height:32px; vertical-align:middle; margin-right:6px;" },
			{ kind: "Control", name: "title", content: "Sign In" },
			// Manual VKB toggle. Embedded sign-in webviews that render the form in a cross-origin
			// iframe (Apple MusicKit) do not auto-raise the keyboard. Tap the field, then tap this to
			// force the VKB. A plain Control (not Button) so tapping it does NOT steal focus from the
			// webview input, so the typed keys still reach the focused field.
			{ name: "kbButton", kind: "Control", showing: false, content: "\u2328 Keyboard", onclick: "toggleKeyboard",
			  style: "margin-left:14px; padding:3px 10px; border:1px solid #888; border-radius:6px; font-size:14px; -webkit-user-select:none;" }
		]},
		{ className: "accounts-header-shadow" },

		{ kind: "Scroller", flex: 1, components: [
			// ------- credential / info entry -------
			{ name: "entryBox", className: "box-center", components: [
				// Spotify: the user's own developer app, asked for before the sign-in when the
				// backend has no client id of the user's (setupSpotifyApp).
				{ name: "spotifySetup", showing: false, components: [
					{ name: "setupText", className: "accounts-body-text", style: "padding: 12px 16px; line-height: 1.4;", allowHtml: true, content:
						"Spotify lets one developer app be used by five people only, so you sign in through an app of your own. " +
						"It is free and takes a minute, here or on a computer:" +
						"<ol style='margin:8px 0 0; padding-left:22px;'>" +
						"<li>Open the Spotify dashboard and log in with your Spotify account.</li>" +
						"<li><b>Create app</b>: any name and description, the redirect URI below, tick <b>Web API</b>, accept the terms and save.</li>" +
						"<li>Copy the app's <b>Client ID</b> into the box below.</li></ol>" },
					{ name: "dashboardButton", kind: "Button", caption: "Open Spotify Dashboard", className: "accounts-btn", onclick: "openDashboard" },
					{ kind: "RowGroup", caption: "REDIRECT URI", className: "accounts-group", components: [
						{ kind: "Input", name: "redirectUri", spellcheck: false, autocorrect: false,
						  autoWordComplete: false, autoCapitalize: "lowercase", onchange: "keepRedirectUri" }
					]},
					{ kind: "RowGroup", caption: "CLIENT ID", className: "accounts-group", components: [
						{ kind: "Input", name: "clientId", hint: "32 letters and digits", spellcheck: false,
						  autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase", oninput: "validateInput" }
					]}
				]},
				{ name: "serverGroup", showing: false, kind: "RowGroup", caption: "SERVER", className: "accounts-group", components: [
					{ kind: "Input", name: "server", hint: "nas.local:4533", spellcheck: false,
					  autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase", oninput: "validateInput" }
				]},
				{ name: "userGroup", showing: false, kind: "RowGroup", caption: "USERNAME", className: "accounts-group", components: [
					{ kind: "Input", name: "user", hint: "Username", spellcheck: false,
					  autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase", oninput: "validateInput" }
				]},
				{ name: "emailGroup", showing: false, kind: "RowGroup", caption: "EMAIL", className: "accounts-group", components: [
					{ kind: "Input", name: "email", hint: "you@example.com", spellcheck: false,
					  autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase", oninput: "validateInput" }
				]},
				{ name: "passwordGroup", showing: false, kind: "RowGroup", caption: "PASSWORD", className: "accounts-group", components: [
					// PasswordInput (not Input+type) so the DOM input is masked — it sets
					// the type="password" attribute itself (show-then-hide behaviour).
					{ kind: "PasswordInput", name: "password", hint: "Password", autoWordComplete: false, oninput: "validateInput" }
				]},
				{ name: "listGroup", showing: false, kind: "RowGroup", caption: "YOUR STATION LIST (OPTIONAL)", className: "accounts-group", components: [
					{ kind: "Input", name: "list", hint: "https://example.org/stations.m3u", spellcheck: false,
					  autocorrect: false, autoWordComplete: false, autoCapitalize: "lowercase", oninput: "validateInput" }
				]},
				{ name: "arlGroup", showing: false, kind: "RowGroup", caption: "ARL COOKIE", className: "accounts-group", components: [
					{ kind: "Input", name: "arl", hint: "Paste your deezer ARL", spellcheck: false,
					  autocorrect: false, autoWordComplete: false, autoCapitalize: "none", oninput: "validateInput" }
				]},
				{ name: "errorBox", kind: "HFlexBox", showing: false, align: "center", className: "error-box", style: "padding:8px 16px;", components: [
					{ name: "errorMessage", className: "enyo-text-error", flex: 1 }
				]},
				{ name: "bodyText", className: "accounts-body-text", style: "padding: 12px 16px; line-height: 1.4;", allowHtml: true, content: "" },
				{ name: "signInButton", kind: "ActivityButton", caption: "Sign In", disabled: false, active: false,
				  className: "enyo-button-dark accounts-btn", onclick: "performPrimary" },
				{ name: "changeAppButton", kind: "Button", caption: "Use a Different Spotify App", showing: false,
				  className: "accounts-btn", onclick: "changeSpotifyApp" },
				{ name: "removeAccountButton", kind: "Accounts.RemoveAccount", className: "accounts-btn",
				  showing: false, style: "padding-top:6px;", onAccountsRemove_Done: "removeDone" }
			]},

			// ------- Tidal device code (WhatsApp link-code style) -------
			{ name: "codeBox", showing: false, className: "box-center", style: "text-align:center;", components: [
				{ name: "codeTitle", className: "accounts-body-text", style: "padding:14px 16px 4px; font-size:20px;", content: "Link Tidal" },
				{ name: "codeStatus", className: "accounts-body-text", style: "padding:2px 16px 10px; opacity:0.8; line-height:1.4;", content: "Getting a code…" },
				{ name: "codeWrap", showing: false, style: "margin:6px auto 2px; text-align:center;", components: [
					{ className: "accounts-body-text", style: "opacity:0.8;", content: "Go to link.tidal.com and enter this code:" },
					{ name: "codeDigits", style: "font-size:34px; font-weight:bold; letter-spacing:6px; padding:8px 0 6px; font-family:monospace;", content: "" },
					{ className: "accounts-body-text", style: "opacity:0.6; font-size:13px;", content: "On your phone or computer: open link.tidal.com, sign in, and enter the code above." }
				]},
				{ name: "codeRetry", showing: false, kind: "Button", caption: "Try again", className: "accounts-btn", onclick: "retryCode" }
			]},

			// Spotify OAuth web view (hidden until needed)
			{ name: "oauthBox", flex: 1, showing: false }
		]},

		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ kind: "Button", name: "cancelButton", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
		]},
		{ kind: "CrossAppResult" }
	],

	create: function () {
		this.inherited(arguments);
		this.done = false;
		this.handleLaunch(enyo.windowParams || {});
	},

	handleLaunch: function (p) {
		p = p || {};
		this.templateObj = p.template || null;
		this.templateId = (this.templateObj && this.templateObj.templateId) || p.templateId || "org.webosports.app.music.spotify";
		this.serviceId = this.templateId.split(".").pop();
		this.serviceName = (this.templateObj && this.templateObj.loc_name) ||
			(this.serviceId.charAt(0).toUpperCase() + this.serviceId.slice(1));
		this.mode = this.modeFor(this.serviceId);
		this._deezerFallback = false;

		this.$.headerIcon.setSrc("images/connectors/" + this.serviceId + ".png");
		this.$.title.setContent(this.serviceName);
		mlog("launch service=" + this.serviceId + " mode=" + this.mode);

		// Editing an existing account -> offer the standard Remove Account button.
		this.accountId = (p.account && (p.account._id || p.account.id)) || p.accountId || null;
		if (this.accountId && p.account) {
			try { this.$.removeAccountButton.init(p.account); this.$.removeAccountButton.show(); } catch (e) {}
		}

		this.configureForMode();
	},

	modeFor: function (id) {
		if (id === "spotify") { return "spotify"; }
		if (id === "tidal") { return "tidal"; }
		if (id === "qobuz") { return "qobuz"; }
		if (id === "subsonic") { return "subsonic"; }
		if (id === "radio") { return "radio"; }
		if (id === "deezer") { return "deezer"; }
		if (id === "apple") { return "apple"; }
		return "noauth";
	},

	configureForMode: function () {
		switch (this.mode) {
			case "qobuz":
			case "deezer":
				this.$.emailGroup.setShowing(true);
				this.$.passwordGroup.setShowing(true);
				this.$.bodyText.setContent("Sign in to <b>" + this.serviceName + "</b> with your account email and password.");
				this.$.signInButton.setCaption("Sign In");
				this.$.signInButton.setDisabled(true);
				break;
			case "subsonic":
				this.$.serverGroup.setShowing(true);
				this.$.userGroup.setShowing(true);
				this.$.passwordGroup.setShowing(true);
				this.$.bodyText.setContent("Sign in to your music server: <b>Navidrome</b>, Airsonic, Gonic or any other that speaks the Subsonic API. The address is the one you open it at in a browser.");
				this.$.signInButton.setCaption("Sign In");
				this.$.signInButton.setDisabled(true);
				break;
			case "radio":
				this.$.listGroup.setShowing(true);
				this.$.bodyText.setContent("Listen to the stations of <b>Radio Browser</b>, a directory of tens of thousands of stations. You can also add a list of your own: the address of an M3U or PLS playlist.");
				this.$.signInButton.setCaption("Add " + this.serviceName);
				break;
			case "spotify":
				this.$.bodyText.setContent("Connect your <b>Spotify</b> account. A sign-in page opens if needed.");
				this.$.signInButton.setCaption("Connect Spotify");
				this.checkSpotifyApp();
				break;
			case "tidal":
				this.$.entryBox.setShowing(false);
				this.$.codeBox.setShowing(true);
				this.$.codeWrap.setShowing(false);
				this.$.codeTitle.setContent("Sign in to Tidal");
				this.$.codeStatus.setContent("Loading Tidal sign-in…");
				this.startTidalWeb();
				break;
			case "apple":
				this.$.entryBox.setShowing(false);
				this.$.codeBox.setShowing(true);
				this.$.codeWrap.setShowing(false);
				this.$.codeTitle.setContent("Sign in to Apple Music");
				this.$.codeStatus.setContent("Loading Apple sign-in…");
				this.startAppleWeb();
				break;
			default: // noauth
				this.$.bodyText.setContent("Add <b>" + this.serviceName + "</b> as a music source.");
				this.$.signInButton.setCaption("Add " + this.serviceName);
		}
	},

	trim: function (v) { return (v || "").replace(/^\s+|\s+$/g, ""); },

	validateInput: function () {
		if (this.mode === "qobuz" || this.mode === "deezer") {
			var ok;
			if (this._deezerFallback) {
				ok = this.trim(this.$.arl.getValue()).length > 0;
			} else {
				ok = this.trim(this.$.email.getValue()).length > 0 && this.trim(this.$.password.getValue()).length > 0;
			}
			this.$.signInButton.setDisabled(!ok);
		} else if (this.mode === "spotify" && this._spotifySetup) {
			this.$.signInButton.setDisabled(!this.clientIdOf(this.$.clientId.getValue()));
		} else if (this.mode === "subsonic") {
			// The password as typed: spaces in it are its own.
			this.$.signInButton.setDisabled(!(this.trim(this.$.server.getValue()) && this.trim(this.$.user.getValue()) &&
				this.$.password.getValue()));
		}
	},

	showError: function (msg) {
		if (msg) { this.$.errorMessage.setContent(msg); this.$.errorBox.setShowing(true); }
		else { this.$.errorBox.setShowing(false); }
	},

	busy: function (on) {
		this.$.signInButton.setActive(on);
		this.$.signInButton.setDisabled(on);
	},

	// --- primary button dispatch ---
	performPrimary: function () {
		this.showError("");
		switch (this.mode) {
			case "qobuz": this.doQobuz(); break;
			case "subsonic": this.doSubsonic(); break;
			case "radio": this.doRadio(); break;
			case "deezer": this._deezerFallback ? this.doDeezerArl() : this.doDeezer(); break;
			case "spotify": this._spotifySetup ? this.saveSpotifyApp() : this.attemptFinish(true); break;
			default: this.finishService(this.serviceName); // noauth
		}
		return true;
	},

	doQobuz: function () {
		var email = this.trim(this.$.email.getValue()), pw = this.trim(this.$.password.getValue());
		if (!email || !pw) { return; }
		this.busy(true);
		this.post(BACKEND + "/qobuzauth/login", { email: email, password: pw }, enyo.bind(this, function (ok, j) {
			this.busy(false);
			if (ok && j && j.ok) { this.finishService(j.username || email); }
			else { this.showError((j && j.error) || "Qobuz sign-in failed — check your credentials."); }
		}));
	},

	doSubsonic: function () {
		var server = this.trim(this.$.server.getValue()), user = this.trim(this.$.user.getValue()), pw = this.$.password.getValue();
		if (!server || !user || !pw) { return; }
		this.busy(true);
		this.post(BACKEND + "/subsonicauth/login", { server: server, username: user, password: pw }, enyo.bind(this, function (ok, j) {
			this.busy(false);
			if (ok && j && j.ok) { this.finishService(j.username || user); }
			else { this.showError((j && j.error) || "Could not sign in to the server - check its address, your username and password."); }
		}));
	},

	doRadio: function () {
		var list = this.trim(this.$.list.getValue());
		if (!list) { this.finishService(this.serviceName); return; }
		this.busy(true);
		this.post(BACKEND + "/radioauth/lists", { lists: [list] }, enyo.bind(this, function (ok, j) {
			this.busy(false);
			if (ok && j && j.ok) { this.finishService(this.serviceName); }
			else { this.showError((j && j.error) || "That list could not be read - check its address."); }
		}));
	},

	doDeezer: function () {
		var email = this.trim(this.$.email.getValue()), pw = this.trim(this.$.password.getValue());
		if (!email || !pw) { return; }
		this.busy(true);
		this.post(BACKEND + "/dzauth/login", { email: email, password: pw }, enyo.bind(this, function (ok, j) {
			this.busy(false);
			if (ok && j && j.ok) { this.finishService(j.username || email); return; }
			// Deezer blocked the login (captcha/rate-limit) -> offer the ARL fallback.
			var err = (j && j.error) || "Deezer sign-in failed.";
			this.showError(err + " You can paste your ARL cookie instead.");
			this._deezerFallback = true;
			this.$.passwordGroup.setShowing(false);
			this.$.emailGroup.setShowing(false);
			this.$.arlGroup.setShowing(true);
			this.$.bodyText.setContent("Paste your Deezer <b>ARL</b> cookie (from deezer.com in a desktop browser).");
			this.$.signInButton.setCaption("Save ARL");
			this.validateInput();
		}));
	},

	doDeezerArl: function () {
		var arl = this.trim(this.$.arl.getValue());
		if (!arl) { return; }
		this.busy(true);
		this.post(BACKEND + "/dzauth/save", { arl: arl }, enyo.bind(this, function (ok, j) {
			this.busy(false);
			if (ok && j && j.ok) { this.finishService("Deezer"); }
			else { this.showError((j && j.error) || "That ARL didn't work — please re-copy it."); }
		}));
	},

	// --- Tidal PKCE web login (webview) ---
	startTidalWeb: function () {
		this.$.codeRetry.setShowing(false);
		this.get(BACKEND + "/tidalauth/start", enyo.bind(this, function (ok, j) {
			if (!ok || !j || !j.authorize_url) {
				this.$.codeStatus.setContent("Couldn't reach Tidal. Try again.");
				this.$.codeRetry.setShowing(true);
				return;
			}
			this._tidalExchanging = false;
			this.$.codeBox.setShowing(false);
			this.openWeb(j.authorize_url);
		}));
	},
	// Called from onWebLoad when the login redirects to tidal.com/login/auth?code=…
	exchangeTidal: function (code) {
		if (this._tidalExchanging) { return; }
		this._tidalExchanging = true;
		this.teardownWeb();
		this.$.codeBox.setShowing(true);
		this.$.codeWrap.setShowing(false);
		this.$.codeStatus.setContent("Signing in to Tidal…");
		this.post(BACKEND + "/tidalauth/exchange", { code: code }, enyo.bind(this, function (ok, j) {
			if (ok && j && j.ok) { this.$.codeStatus.setContent("Tidal connected!"); this.finishService(j.username || "Tidal"); }
			else { this.$.codeStatus.setContent("Tidal sign-in failed: " + ((j && j.error) || "please retry")); this.$.codeRetry.setShowing(true); }
		}));
	},
	_extractParam: function (u, k) {
		var m = new RegExp("[?&]" + k + "=([^&#]+)").exec(u || "");
		return m ? decodeURIComponent(m[1]) : "";
	},

	// Mode-aware retry for the shared "Try again" button in the code/web box.
	retryCode: function () {
		if (this.mode === "apple") { this.startAppleWeb(); } else { this.startTidalWeb(); }
	},

	// --- Apple Music: MusicKit sign-in (webview) + poll for the saved token ---
	startAppleWeb: function () {
		this.$.codeRetry.setShowing(false);
		this.get(BACKEND + "/appleauth/status", enyo.bind(this, function (ok, j) {
			if (ok && j && j.hasCDM === false) {
				this.$.codeStatus.setContent("Put your device.wvd at /media/internal/device.wvd, then tap Try again.");
				this.$.codeRetry.setShowing(true);
				return;
			}
			this.$.codeBox.setShowing(false);
			this.openWeb(BACKEND + "/appleauth/login");
			this._applePollCount = 0;
			this.startPollFn("applePollOnce", 2000);
		}));
	},
	// See spotifyPollOnce's comment: cap the poll so a permanently-failing sign-in
	// (bad/missing config, MusicKit token issue, etc.) shows an error instead of
	// spinning forever with no feedback.
	applePollOnce: function () {
		this._applePollCount = (this._applePollCount || 0) + 1;
		if (this._applePollCount > 60 && !this._oauthWindow) {
			this.stopPoll();
			this.teardownWeb();
			this.$.codeBox.setShowing(true);
			this.$.codeStatus.setContent("Apple Music sign-in timed out. Please check the backend configuration and try again.");
			this.$.codeRetry.setShowing(true);
			return;
		}
		this.get(BACKEND + "/appleauth/status", enyo.bind(this, function (ok, j) {
			if (ok && j && j.authenticated) {
				this.stopPoll();
				this.teardownWeb();
				this.$.codeBox.setShowing(true);
				this.$.codeStatus.setContent("Apple Music connected!");
				this.finishService("Apple Music");
			}
		}));
	},

	// --- Spotify: the user's own developer app ---
	// A client id as Spotify gives it (32 hex digits), or "" for anything else.
	clientIdOf: function (v) {
		v = this.trim(v).toLowerCase();
		return /^[0-9a-f]{32}$/.test(v) ? v : "";
	},
	// The backend has a client id of the user's: sign in with it (a session it already
	// holds finishes at once). One built into the image serves Spotify's five users at
	// most, so without a session made with it the user sets up their own.
	checkSpotifyApp: function () {
		this.get(BACKEND + "/auth/client-id", enyo.bind(this, function (ok, j) {
			if (!ok || !j) {
				// A backend without /auth/client-id: as before.
				this.attemptFinish(false);
				return;
			}
			this._spotifyApp = j;
			if (j.clientId && j.source !== "image") {
				this.$.changeAppButton.setShowing(j.source === "device");
				this.attemptFinish(false);
				return;
			}
			this.get(BACKEND + "/auth/status", enyo.bind(this, function (sok, st) {
				if (sok && st && st.authenticated && st.librespot !== false) { this.fetchTokenAndFinish(); }
				else { this.setupSpotifyApp(); }
			}));
		}));
	},
	setupSpotifyApp: function () {
		var app = this._spotifyApp || {};
		this._spotifySetup = true;
		this.$.spotifySetup.setShowing(true);
		this.$.changeAppButton.setShowing(false);
		this.$.redirectUri.setValue(app.redirectUri || "");
		this.$.clientId.setValue(app.source === "device" ? (app.clientId || "") : "");
		this.$.bodyText.setContent("");
		this.$.signInButton.setCaption("Save and Connect");
		this.validateInput();
	},
	changeSpotifyApp: function () {
		this.showError("");
		this.setupSpotifyApp();
		return true;
	},
	// The field is there to be copied from; an edit to it changes nothing.
	keepRedirectUri: function () {
		this.$.redirectUri.setValue((this._spotifyApp && this._spotifyApp.redirectUri) || "");
	},
	// The dashboard in a window of its own (the sign-in's, on LuneOS) for as long as the
	// user needs; closing it brings them back here to paste the client id. No redirect
	// ends it: the dashboard changes page inside itself, out of WAM's sight.
	openDashboard: function () {
		var url = (this._spotifyApp && this._spotifyApp.dashboardUrl) || "https://developer.spotify.com/dashboard";
		this.showError("");
		if (window.OAuthWindow && !window.OAuthWindow.hasPluginWebView()) {
			if (this._dashboardWindow) { this._dashboardWindow.close(); }
			var self = this;
			this._dashboardWindow = window.OAuthWindow.open({
				url: url, name: "spotifyDashboard", redirectPrefix: "about:never", timeoutMs: 30 * 60000,
				onRedirect: function () { self._dashboardWindow = null; },
				onError: function () { self._dashboardWindow = null; try { self.$.clientId.forceFocus(); } catch (e) {} }
			});
			return true;
		}
		this.openWeb(url);
		return true;
	},
	saveSpotifyApp: function () {
		var id = this.clientIdOf(this.$.clientId.getValue());
		if (!id) { return; }
		this.busy(true);
		this.post(BACKEND + "/auth/client-id", { clientId: id }, enyo.bind(this, function (ok, j) {
			this.busy(false);
			if (!(ok && j)) {
				this.showError((j && j.error) || "The music backend did not keep the client id - try again.");
				return;
			}
			if (this._dashboardWindow) { this._dashboardWindow.close(); this._dashboardWindow = null; }
			this.teardownWeb();
			this._spotifyApp = j;
			this._spotifySetup = false;
			this.$.spotifySetup.setShowing(false);
			this.$.changeAppButton.setShowing(true);
			this.$.signInButton.setCaption("Connect Spotify");
			this.startLogin();
		}));
	},

	// --- Spotify OAuth ---
	attemptFinish: function (startLoginIfNeeded) {
		this.get(BACKEND + "/auth/status", enyo.bind(this, function (ok, j) {
			// librespot (playback) signs in apart from the Web API session (search); a backend
			// that does not report it predates that and plays with the Web API token.
			if (ok && j && j.authenticated && j.librespot !== false) { this.fetchTokenAndFinish(); }
			else if (startLoginIfNeeded) { this.startLogin(); }
			else { this.$.bodyText.setContent("Tap <b>Connect Spotify</b> to sign in."); }
		}));
	},
	startLogin: function () {
		this.busy(true);
		this.showError("");
		this._spotifyPollCount = 0;
		// Ask the backend first: without a Spotify client id it answers 412 here, and
		// the /login page that would say so does not render in every web view, which
		// left the card waiting on /auth/status for the full two-minute cap.
		this.get(BACKEND + "/auth/login", enyo.bind(this, function (ok, j) {
			if (!ok) {
				this.busy(false);
				if (j && j.error && this._spotifyApp) { this.setupSpotifyApp(); return; } // no client id
				this.showError("Spotify can't be signed in to on this device yet: " +
					((j && j.error) || "the music backend is not answering") + ".");
				return;
			}
			this.openWeb(BACKEND + "/login");
			this.startPollFn("spotifyPollOnce", 2000);
		}));
	},
	// Cap how long we'll silently spin: past ~2 minutes of not-yet-authenticated,
	// surface an error instead of leaving the sign-in button spinning forever with
	// no feedback (this is how "no client id configured" on the backend presents —
	// /login 412s, the embedded page shows an error, but polling /auth/status never
	// stops on its own since it never distinguishes "still signing in" from "never
	// going to succeed").
	spotifyPollOnce: function () {
		this._spotifyPollCount = (this._spotifyPollCount || 0) + 1;
		// A sign-in window has its own, longer deadline (OAuthWindow), and the user may still be
		// typing or solving a captcha in it, so the cap only applies to the embedded view.
		if (this._oauthWindow) {
			// /auth/status turns true at /auth/callback, before librespot's sign-in in the same
			// window; finishing then would close it halfway. Its redirect to /auth/done finishes.
			return;
		}
		if (this._spotifyPollCount > 60) {
			this.stopPoll();
			this.teardownWeb();
			this.busy(false);
			this.showError("Spotify sign-in timed out. " + this.spotifyAppHint());
			return;
		}
		this.attemptFinish(false);
	},

	// Spotify answers a sign-in to an app it does not know, or one that does not list the
	// redirect URI, with INVALID_CLIENT on its own page, which this app cannot see.
	spotifyAppHint: function () {
		var app = this._spotifyApp;
		if (!app || app.source !== "device") { return ""; }
		return "If Spotify said INVALID_CLIENT, check the client ID and that your app lists " +
			app.redirectUri + " as a redirect URI, or use a different Spotify app.";
	},

	// --- embedded Atlas/WPE WebView (same lifecycle as spotifyView.js) ---
	openWeb: function (url) {
		// No NPAPI plugin (LuneOS): the <object> below never paints and has no openURL, so the
		// sign-in page goes in its own WAM window, as in cloud-auth.
		if (window.OAuthWindow && !window.OAuthWindow.hasPluginWebView()) {
			this.openWindow(url);
			return;
		}
		if (this.$.kbButton) { this.$.kbButton.setShowing(true); }
		this._webUrl = url;
		this._webLoaded = false;
		this.$.oauthBox.setShowing(true);
		if (!this.$.oauthWeb) {
			this.$.oauthBox.createComponent({
				name: "oauthWeb", kind: "WebView", width: "100%", height: "560px",
				url: "atlas-simple:about:blank",
				onConnected: "webConnected", onError: "webError",
				onUrlRedirected: "webNav", onPageTitleChanged: "webTitleNav"
			}, { owner: this });
			this.$.oauthBox.render();
		} else {
			this.webConnected();
		}
		// onConnected is unreliable on enyo 0.10 — fall back to openURL after 3s.
		if (this._webTimer) { window.clearTimeout(this._webTimer); }
		var self = this;
		this._webTimer = window.setTimeout(function () { self.webConnected(); }, 3000);
	},
	webConnected: function () {
		if (this._webLoaded || !this._webUrl || !this.$.oauthWeb) { return; }
		this._webLoaded = true;
		if (this._webTimer) { window.clearTimeout(this._webTimer); this._webTimer = null; }
		mlog("openURL atlas-simple:" + this._webUrl);
		try { this.$.oauthWeb.callBrowserAdapter("openURL", ["atlas-simple:" + this._webUrl]); }
		catch (e) { this._webLoaded = false; mlog("openURL failed: " + e); }
	},
	openWindow: function (url) {
		if (this._oauthWindow) { this._oauthWindow.close(); }
		this.webStatus("Sign in in the window that just opened. You'll be returned here automatically.");
		var self = this;
		this._oauthWindow = window.OAuthWindow.open({
			url: url,
			name: "musicSignIn",
			redirectPrefix: this.redirectPrefix(),
			timeoutMs: 240000,
			onRedirect: function (u) {
				self._oauthWindow = null;
				self.onWebLoad(null, u);
				// The window passes /auth/callback (the Web API session) and librespot's own
				// sign-in before the backend sends it to /auth/done.
				if (self.mode === "spotify") { self.attemptFinish(false); }
				else if (self.mode === "tidal" && !self._tidalExchanging) { self.webWindowFailed("Tidal sign-in was refused."); }
			},
			onError: function (msg) { self._oauthWindow = null; self.webWindowFailed(msg); }
		});
	},
	// Where the provider sends the browser once signed in. Apple's page posts its token to the
	// backend itself, which applePollOnce notices, so its window is only closed from here.
	redirectPrefix: function () {
		if (this.mode === "spotify") { return BACKEND + "/auth/done"; }
		if (this.mode === "tidal") { return "https://tidal.com/login/auth"; }
		return "about:never";
	},
	webStatus: function (msg) {
		if (this.mode === "spotify") { this.$.bodyText.setContent(msg); return; }
		this.$.codeBox.setShowing(true);
		this.$.codeWrap.setShowing(false);
		this.$.codeStatus.setContent(msg);
	},
	webWindowFailed: function (msg) {
		if (this.done) { return; }
		this.stopPoll();
		if (this.mode === "spotify") {
			this.busy(false);
			this.$.bodyText.setContent("Tap <b>Connect Spotify</b> to sign in.");
			this.showError(msg + " " + this.spotifyAppHint());
			return;
		}
		this.webStatus(msg);
		this.$.codeRetry.setShowing(true);
	},
	webNav: function (s, u) { this.onWebLoad(s, u); },
	webTitleNav: function (s, t, u) { this.onWebLoad(s, u); },
	webError: function () { mlog("webview engine error"); },
	// Force-toggle the virtual keyboard for the embedded sign-in webview (see kbButton).
	// setManualKeyboardEnabled(true) is required before keyboardShow/Hide take effect.
	toggleKeyboard: function () {
		if (!window.PalmSystem) { return true; }
		try {
			PalmSystem.setManualKeyboardEnabled(true);
			if (this._kbShown) { PalmSystem.keyboardHide(); this._kbShown = false; }
			else { PalmSystem.keyboardShow(0); this._kbShown = true; }
		} catch (e) {}
		return true; // do not bubble / take focus
	},
	teardownWeb: function () {
		if (this._oauthWindow) { this._oauthWindow.close(); this._oauthWindow = null; }
		if (this._webTimer) { window.clearTimeout(this._webTimer); this._webTimer = null; }
		if (this.$.kbButton) { this.$.kbButton.setShowing(false); }
		try { if (window.PalmSystem) { PalmSystem.keyboardHide(); PalmSystem.setManualKeyboardEnabled(false); } } catch (e) {}
		this._kbShown = false;
		this.$.oauthBox.setShowing(false);
		if (this.$.oauthWeb) { this.$.oauthWeb.destroy(); this._webLoaded = false; }
	},

	onWebLoad: function (s, u) {
		if (u && u.indexOf("/auth/callback") !== -1) { this.$.codeStatus.setContent("Finishing…"); }
		// The embedded view (legacy webOS) sees the dashboard's pages: an app's own page is
		// /dashboard/<client id>, so its id fills itself in.
		var app = this._spotifySetup && /^https:\/\/developer\.spotify\.com\/dashboard\/([0-9a-f]{32})(?:[\/?#]|$)/i.exec(u || "");
		if (app && !this.clientIdOf(this.$.clientId.getValue())) {
			this.$.clientId.setValue(app[1].toLowerCase());
			this.validateInput();
		}
		// Tidal PKCE: the login redirects to tidal.com/login/auth?code=… — grab the code.
		if (this.mode === "tidal" && u && u.indexOf("tidal.com/login/auth") !== -1 && u.indexOf("code=") !== -1) {
			var code = this._extractParam(u, "code");
			if (code) { this.exchangeTidal(code); }
		}
		return true;
	},
	fetchTokenAndFinish: function () {
		this.get(BACKEND + "/auth/token", enyo.bind(this, function (ok, j) {
			if (!(ok && j && j.refreshToken)) { this.finish({ returnValue: false, errorCode: "NO_TOKEN" }); return; }
			var tok = j;
			this.get(BACKEND + "/me", enyo.bind(this, function (mok, me) {
				var name = (me && (me.email || me.displayName || me.id)) || this.serviceName;
				var alias = (me && (me.displayName || me.email)) || this.serviceName;
				this.finish({
					returnValue: true, templateId: this.templateId, template: this.templateObj,
					username: name, alias: alias, config: {},
					credentials: { common: { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiry: tok.expiry } }
				});
			}));
		}));
	},

	// --- shared poll timer ---
	startPollFn: function (method, ms) {
		if (this.pollId) { return; }
		this.pollId = window.setInterval(enyo.bind(this, method), ms);
	},
	stopPoll: function () { if (this.pollId) { window.clearInterval(this.pollId); this.pollId = null; } },

	// --- result ---
	finishService: function (username) {
		this.finish({
			returnValue: true, templateId: this.templateId, template: this.templateObj,
			username: username || this.serviceName, alias: this.serviceName, config: {},
			credentials: { common: { service: this.serviceId } }
		});
	},
	finish: function (result) {
		if (this.done) { return; }
		this.done = true;
		this.stopPoll();
		if (this._oauthWindow) { this._oauthWindow.close(); this._oauthWindow = null; }
		mlog("sendResult: " + JSON.stringify(result));
		try { this.$.crossAppResult.sendResult(result); } catch (e) { mlog("sendResult threw: " + e); }
	},
	removeDone: function () { this.$.crossAppResult.sendResult({ returnValue: false }); },
	cancel: function () {
		if (this._dashboardWindow) { this._dashboardWindow.close(); this._dashboardWindow = null; }
		this.finish({ returnValue: false });
	},

	// --- xhr helpers ---
	get: function (url, cb) {
		try {
			var x = new XMLHttpRequest();
			x.open("GET", url, true);
			x.onreadystatechange = function () { if (x.readyState !== 4) { return; } var j = null; try { j = JSON.parse(x.responseText); } catch (e) {} cb(x.status >= 200 && x.status < 300, j); };
			x.onerror = function () { cb(false, null); };
			x.send();
		} catch (e) { cb(false, null); }
	},
	post: function (url, obj, cb) {
		try {
			var x = new XMLHttpRequest();
			x.open("POST", url, true);
			x.setRequestHeader("Content-Type", "application/json");
			x.onreadystatechange = function () { if (x.readyState !== 4) { return; } var j = null; try { j = JSON.parse(x.responseText); } catch (e) {} cb(x.status >= 200 && x.status < 300, j, x.status); };
			x.onerror = function () { cb(false, null, 0); };
			x.send(JSON.stringify(obj || {}));
		} catch (e) { cb(false, null, 0); }
	}
});
