/*global enyo, console, window */
/*
 * FlickrAuth - customUI account validator for the Flickr Synergy connector.
 *
 * MIRRORS THE DROPBOX/TEAMS PATTERN. The legacy webOS system webview is WebKit ~2009 on
 * OpenSSL 0.9.8k and CANNOT render the Flickr OAuth consent page (no TLS 1.2/1.3). So this
 * app does NO HTTPS itself. Instead:
 *   1. it asks com.palm.service.flickr/getAuthorizeUrl, which runs OAuth 1.0a leg 1
 *      (request_token, signed+fetched via the modern curl) and returns { url,
 *      requestToken, requestTokenSecret };
 *   2. it launches Atlas ("simple" mode = WPE + modern OpenSSL/TLS 1.3) at that authorize
 *      URL; Atlas renders the login, intercepts navigation to our redirectPrefix and writes
 *      the captured redirect URL into a com.palm.systemservice preference (oauthResultKey);
 *   3. we POLL getPreferences for that key until the value carries "oauth_verifier="
 *      (subscribe-push proved unreliable on device - see Teams/Dropbox notes);
 *   4. we close the Atlas card, then hand oauth_verifier (+ the request token/secret we held
 *      across the login) to com.palm.service.flickr/exchangeCode, which runs OAuth 1.0a leg 3
 *      (access_token) over the modern curl and returns the stored credentials;
 *   5. we return { returnValue, credentials, template } to Accounts via
 *      enyo.CrossAppResult.sendResult(). Empty {} = cancelled.
 *
 * KEY DIFFERENCE vs Dropbox: OAuth 1.0a captures `oauth_verifier` (not `code`), and the
 * secret carried across the web login is the REQUEST TOKEN SECRET (not a PKCE verifier).
 */

enyo.kind({
	name: "FlickrServiceCall",
	kind: "PalmService",
	service: "palm://com.palm.service.flickr/"
});

enyo.kind({
	name: "FlickrAuth",
	kind: enyo.VFlexBox,

	// Must match Config.CALLBACK_URL in the service, and the systemservice key Atlas
	// writes the captured redirect into.
	redirectPrefix: "http://localhost/flickr/oauth1callback",
	oauthResultKey: "x_flickr_oauth_result",

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light accounts-header", pack: "center", components: [
			{ kind: "Control", name: "title", content: "Flickr" }
		]},
		{ name: "svc",        kind: "FlickrServiceCall", onFailure: "svcFailure" },
		{ name: "prefsGet",   kind: "PalmService", service: "palm://com.palm.systemservice/",
			method: "getPreferences", onSuccess: "gotOAuthResult", onFailure: "pollError" },
		{ name: "prefsSet",   kind: "PalmService", service: "palm://com.palm.systemservice/",
			method: "setPreferences" },
		{ name: "appLaunch",  kind: "PalmService", service: "palm://com.palm.applicationManager/",
			method: "launch", onFailure: "atlasLaunchFailed" },
		{ name: "appRunning", kind: "PalmService", service: "palm://com.palm.applicationManager/",
			method: "running", onSuccess: "gotRunningApps", onFailure: "gotRunningApps" },
		{ name: "appRunningPre", kind: "PalmService", service: "palm://com.palm.applicationManager/",
			method: "running", onSuccess: "atlasClosedThenLaunch", onFailure: "atlasClosedThenLaunch" },
		{ name: "appClose",   kind: "PalmService", service: "palm://com.palm.applicationManager/",
			method: "close" },
		{ kind: "Scroller", flex: 1, components: [
			{ className: "box-center", components: [
				{ name: "status", className: "accounts-body-text", style: "padding:16px; line-height:1.4;",
					content: "Tap Sign In to open the Flickr sign-in page. After you approve access, you'll be returned here automatically." }
			]}
		]},
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ name: "signInButton", kind: "Button", caption: "Sign In", className: "enyo-button-dark accounts-btn", onclick: "performSignIn" },
			{ kind: "Button", caption: "Cancel", className: "accounts-toolbar-btn", onclick: "cancel" }
		]},
		{ name: "xresult", kind: "enyo.CrossAppResult" }
	],

	create: function () {
		this.inherited(arguments);
		this.done = false;
		this.params = enyo.windowParams || {};
		this.log("flickr-auth: launch params " + enyo.json.stringify(this.params));
	},

	setStatus: function (t) { this.$.status.setContent(t); },

	// Step 1-3: get the authorize URL (+ request token/secret) from the service, launch
	// Atlas, start polling.
	performSignIn: function () {
		if (this.done) { return; }
		this.$.signInButton.setDisabled(true);
		this.setStatus("Opening Flickr sign-in…");
		this.$.svc.call({}, {
			method: "getAuthorizeUrl",
			onSuccess: "launchAtlas",
			onFailure: "svcFailure"
		});
	},

	launchAtlas: function (inSender, inResponse) {
		if (!inResponse || !inResponse.url) { this.svcFailure(inSender, inResponse); return; }
		// Clear any stale captured result so a previous add can't be replayed.
		var clear = {}; clear[this.oauthResultKey] = "";
		this.$.prefsSet.call(clear);

		this.oauthDone = false;
		this._authUrl = inResponse.url;
		// Hold the OAuth 1.0a request token + secret here across the whole web login: the
		// service that made them gets idle-killed during sign-in, so exchangeCode must be
		// given them explicitly (analogous to the Dropbox PKCE verifier).
		this._requestToken       = inResponse.requestToken;
		this._requestTokenSecret = inResponse.requestTokenSecret;
		// Atlas MUST cold-launch (a reused simple card does not re-navigate to our URL, so
		// the redirect is never captured). Close any running Atlas first, then launch fresh.
		this.log("flickr-auth: probing for a running Atlas to close before launch");
		this.$.appRunningPre.call({});
	},

	// Close any pre-existing Atlas card, then cold-launch a fresh one.
	atlasClosedThenLaunch: function (inSender, resp) {
		var apps = (resp && resp.running) || [];
		var closed = false;
		for (var i = 0; i < apps.length; i++) {
			if (apps[i].id === "org.webosports.app.atlas" && apps[i].processid) {
				this.log("flickr-auth: closing stale Atlas pid " + apps[i].processid);
				this.$.appClose.call({ processId: apps[i].processid });
				closed = true;
			}
		}
		var self = this;
		window.setTimeout(function () { self.doLaunchAtlas(); }, closed ? 1300 : 0);
	},

	doLaunchAtlas: function () {
		if (this.done) { return; }
		this.log("flickr-auth: launching Atlas simple-mode (cold)");
		this.$.appLaunch.call({
			id: "org.webosports.app.atlas",
			params: {
				mode: "simple",
				url: this._authUrl,
				oauthRedirectPrefix: this.redirectPrefix,
				oauthResultKey: this.oauthResultKey
			}
		});
		// Poll systemservice for the captured redirect (subscribe-push unreliable).
		this._pollCount = 0;
		this.stopPoll();
		var self = this;
		this._poll = window.setInterval(function () { self.pollResult(); }, 1500);
	},

	pollResult: function () {
		if (this.oauthDone || this.done) { this.stopPoll(); return; }
		this._pollCount = (this._pollCount || 0) + 1;
		if (this._pollCount > 160) {   // ~4 min
			this.stopPoll();
			this.$.signInButton.setDisabled(false);
			this.setStatus("Sign-in timed out — please try again.");
			return;
		}
		this.$.prefsGet.call({ keys: [this.oauthResultKey] });
	},

	stopPoll: function () {
		if (this._poll) { window.clearInterval(this._poll); this._poll = null; }
	},

	// getPreferences returns values at the TOP LEVEL (resp[key]), NOT under resp.preferences.
	// The captured redirect is CALLBACK_URL?oauth_token=<reqToken>&oauth_verifier=<v>.
	gotOAuthResult: function (inSender, resp) {
		if (this.oauthDone || this.done) { return; }
		var url = resp && resp[this.oauthResultKey];
		if (!url || url.indexOf("oauth_verifier=") < 0) { return; }   // not captured yet
		this.oauthDone = true;
		this.stopPoll();
		// Consume the one-time result so a later add can't replay it.
		var clear = {}; clear[this.oauthResultKey] = "";
		this.$.prefsSet.call(clear);

		var err = this.queryParam(url, "error") || this.queryParam(url, "oauth_problem");
		if (err) { this.finish({ returnValue: false, errorCode: "OAUTH_DENIED", detail: err }); return; }
		this.capturedVerifier = this.queryParam(url, "oauth_verifier");
		// Flickr echoes the request token back in the redirect; prefer it, fall back to
		// the one we held from getAuthorizeUrl.
		this.capturedToken = this.queryParam(url, "oauth_token") || this._requestToken;
		// Close the Atlas card, then exchange (in gotRunningApps).
		this.$.appRunning.call({});
	},

	// Close the Atlas sign-in card by pid (a card can't close itself), then exchange.
	gotRunningApps: function (inSender, resp) {
		var apps = (resp && resp.running) || [];
		for (var i = 0; i < apps.length; i++) {
			if (apps[i].id === "org.webosports.app.atlas" && apps[i].processid) {
				this.$.appClose.call({ processId: apps[i].processid });
			}
		}
		this.exchange();
	},

	// Step 4: oauth_verifier + request token/secret -> access token, via the service
	// (which signs + fetches over the modern curl).
	exchange: function () {
		if (!this.capturedVerifier) { this.finish({ returnValue: false, errorCode: "NO_VERIFIER" }); return; }
		this.setStatus("Signing in…");
		this.$.svc.call({
			oauth_verifier:     this.capturedVerifier,
			requestToken:       this.capturedToken,
			requestTokenSecret: this._requestTokenSecret
		}, {
			method: "exchangeCode",
			onSuccess: "exchangeSuccess",
			onFailure: "exchangeFailure"
		});
	},

	// Step 5: return credentials to Accounts (tag with template on create, like Skype/Teams).
	exchangeSuccess: function (inSender, inResponse) {
		if (this.params && this.params.template) {
			inResponse.templateId = this.params.template.templateId;
			inResponse.template   = this.params.template;
		}
		this.finish(inResponse);
	},

	exchangeFailure: function (inSender, inResponse) {
		this.finish({ returnValue: false, errorCode: "EXCHANGE_FAILED", detail: inResponse });
	},

	atlasLaunchFailed: function (inSender, inResponse) {
		this.stopPoll();
		this.finish({ returnValue: false, errorCode: "ATLAS_LAUNCH_FAILED", detail: inResponse });
	},

	pollError: function () { /* transient; keep polling until timeout */ },

	svcFailure: function (inSender, inResponse) {
		if (this.done) { return; }
		this.finish({ returnValue: false, errorCode: "SERVICE_UNAVAILABLE", detail: inResponse });
	},

	cancel: function () {
		if (this.done) { return; }
		this.stopPoll();
		this.finish({});   // empty result => cancelled
	},

	finish: function (result) {
		this.done = true;
		this.stopPoll();
		this.log("flickr-auth: sending result " + enyo.json.stringify(result));
		this.$.xresult.sendResult(result);
	},

	// --- helpers ---------------------------------------------------------------
	queryParam: function (url, key) {
		var m = url.match(new RegExp("[?&]" + key + "=([^&#]*)"));
		return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
	}
});
