// node --test tests/unit
// Loads the real musicauth sign-in card (oauthWindow.js, then musicAuth.js, as depends.js
// orders them) into a sandbox with a stand-in enyo and window, and checks where the sign-in
// page goes: a window.open()ed WAM window when there is no NPAPI plugin (LuneOS), the
// embedded Atlas WebView when there is (legacy webOS).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP = path.join(__dirname, "../../music/_core/apps/org.webosports.app.musicauth");

function control() {
	const c = { showing: null, content: null, created: [] };
	c.setShowing = (v) => { c.showing = v; };
	c.setContent = (v) => { c.content = v; };
	c.setActive = () => {};
	c.setDisabled = () => {};
	c.render = () => {};
	c.createComponent = (spec) => { c.created.push(spec); };
	return c;
}

function load({ plugin }) {
	const opened = [];
	const popups = [];
	const timers = [];
	const listeners = {};
	const logs = [];
	const win = {
		navigator: { mimeTypes: plugin ? { "application/x-palm-browser": {} } : {} },
		open(url, name, features) {
			const p = { closed: false, location: { href: url }, close() { p.closed = true; } };
			opened.push({ url, name, features });
			popups.push(p);
			return p;
		},
		addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
		removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
		setInterval(fn) { timers.push(fn); return timers.length; },
		clearInterval() {},
		setTimeout() { return 0; },
		clearTimeout() {},
	};
	let proto = null;
	const enyo = {
		kind(def) { proto = def; },
		bind: (self, fn) => fn.bind(self),
		log(m) { logs.push(String(m)); },
		BasicWebView: { prototype: { create() {} } },
	};
	win.window = win;
	win.enyo = enyo;
	win.console = { log(m) { logs.push(String(m)); } };
	vm.createContext(win);
	for (const f of ["source/oauthWindow.js", "source/musicAuth.js"]) {
		vm.runInContext(fs.readFileSync(path.join(APP, f), "utf8"), win, { filename: f });
	}
	const card = Object.create(proto);
	card.$ = {};
	for (const n of ["bodyText", "codeBox", "codeWrap", "codeStatus", "codeRetry", "oauthBox",
		"kbButton", "errorBox", "errorMessage", "signInButton"]) card.$[n] = control();
	card.$.crossAppResult = { sent: [], sendResult(r) { this.sent.push(r); } };
	const tick = () => timers.slice().forEach((fn) => fn());
	// What WAM does for a watched window: a webOSOAuthWindow event in this page.
	const fire = (state, url) => (listeners.webOSOAuthWindow || []).slice()
		.forEach((fn) => fn({ detail: { state, url } }));
	return { card, opened, popups, tick, proto, fire, logs };
}

test("depends.js loads oauthWindow.js before musicAuth.js", () => {
	const d = fs.readFileSync(path.join(APP, "depends.js"), "utf8");
	const a = d.indexOf("source/oauthWindow.js"), b = d.indexOf("source/musicAuth.js");
	assert.ok(a >= 0 && b > a);
});

test("no plugin: the Spotify page opens in a window, not the Atlas object", () => {
	const { card, opened } = load({ plugin: false });
	card.mode = "spotify";
	card.openWeb("http://127.0.0.1:8730/login");
	assert.deepStrictEqual(opened.map((o) => o.url), ["http://127.0.0.1:8730/login"]);
	assert.strictEqual(card.$.oauthBox.created.length, 0);
});

test("no plugin: reaching /auth/done closes the window and checks the session", () => {
	const { card, popups, tick } = load({ plugin: false });
	card.mode = "spotify";
	let checked = 0;
	card.attemptFinish = () => { checked++; };
	card.openWeb("http://127.0.0.1:8730/login");
	tick();
	assert.strictEqual(checked, 0);
	// /auth/callback is only halfway: librespot signs in next, in the same window
	popups[0].location.href = "http://127.0.0.1:8730/auth/callback?code=x&state=y";
	tick();
	assert.strictEqual(popups[0].closed, false);
	assert.strictEqual(checked, 0);
	popups[0].location.href = "http://127.0.0.1:8730/auth/done";
	tick();
	assert.strictEqual(popups[0].closed, true);
	assert.strictEqual(checked, 1);
});

test("no plugin: closing the window stops the Spotify sign-in with an error", () => {
	const { card, popups, tick } = load({ plugin: false });
	card.mode = "spotify";
	card.openWeb("http://127.0.0.1:8730/login");
	popups[0].closed = true;
	tick();
	assert.strictEqual(card.$.errorBox.showing, true);
	assert.match(card.$.errorMessage.content, /cancelled/);
});

test("no plugin: a Tidal redirect with a code is exchanged, one without is an error", () => {
	let r = load({ plugin: false });
	let codes = [];
	r.card.mode = "tidal";
	r.card.exchangeTidal = function (c) { this._tidalExchanging = true; codes.push(c); };
	r.card.openWeb("https://login.tidal.com/authorize?x");
	r.popups[0].location.href = "https://tidal.com/login/auth?code=abc";
	r.tick();
	assert.deepStrictEqual(codes, ["abc"]);

	r = load({ plugin: false });
	r.card.mode = "tidal";
	r.card.openWeb("https://login.tidal.com/authorize?x");
	r.popups[0].location.href = "https://tidal.com/login/auth?error=access_denied";
	r.tick();
	assert.strictEqual(r.card.$.codeRetry.showing, true);
	assert.match(r.card.$.codeStatus.content, /refused/);
});

test("finishing the card closes an open sign-in window", () => {
	const { card, popups } = load({ plugin: false });
	card.mode = "apple";
	card.openWeb("http://127.0.0.1:8730/appleauth/login");
	card.cancel();
	assert.strictEqual(popups[0].closed, true);
});

test("plugin present (legacy webOS): the embedded Atlas WebView is used", () => {
	const { card, opened } = load({ plugin: true });
	card.mode = "spotify";
	card.openWeb("http://127.0.0.1:8730/login");
	assert.strictEqual(opened.length, 0);
	assert.strictEqual(card.$.oauthBox.created.length, 1);
	assert.strictEqual(card.$.oauthBox.created[0].kind, "WebView");
});

test("the two-minute Spotify poll cap does not close a sign-in window still in use", () => {
	const { card, popups } = load({ plugin: false });
	card.mode = "spotify";
	card.attemptFinish = () => {};
	card.openWeb("http://127.0.0.1:8730/login");
	for (let i = 0; i < 70; i++) card.spotifyPollOnce();
	assert.strictEqual(popups[0].closed, false);
	assert.notStrictEqual(card.$.errorBox.showing, true);
});

test("polling does not finish the account while the sign-in window is still open", () => {
	const { card, popups } = load({ plugin: false });
	card.mode = "spotify";
	let checked = 0;
	card.attemptFinish = () => { checked++; };
	card.openWeb("http://127.0.0.1:8730/login");
	card.spotifyPollOnce();
	assert.strictEqual(checked, 0);
	assert.strictEqual(popups[0].closed, false);
});

test("a Web API session without librespot's sign-in does not finish the account", () => {
	const statuses = [
		[{ authenticated: true, librespot: false }, false],
		[{ authenticated: true, librespot: true }, true],
		[{ authenticated: true }, true], // a backend from before librespot signed in apart
		[{ authenticated: false, librespot: true }, false],
	];
	for (const [status, finishes] of statuses) {
		const { card } = load({ plugin: false });
		card.mode = "spotify";
		let finished = 0, login = 0;
		card.get = (url, cb) => cb(true, status);
		card.fetchTokenAndFinish = () => { finished++; };
		card.startLogin = () => { login++; };
		card.attemptFinish(true);
		assert.strictEqual(finished, finishes ? 1 : 0, JSON.stringify(status));
		assert.strictEqual(login, finishes ? 0 : 1, JSON.stringify(status));
	}
});

function radioCard(listValue) {
	const { card } = load({ plugin: false });
	for (const n of ["listGroup", "serverGroup", "userGroup", "passwordGroup", "emailGroup", "arlGroup", "headerIcon", "title"]) card.$[n] = control();
	card.$.list = { getValue: () => listValue };
	card.$.headerIcon.setSrc = () => {};
	card.$.signInButton.setCaption = (v) => { card.$.signInButton.caption = v; };
	card.stopPoll = () => {};
	card.handleLaunch({ template: { templateId: "org.webosports.app.music.radio", loc_name: "Internet Radio" } });
	return card;
}

test("radio: Radio Browser needs nothing, the own list is offered", () => {
	const card = radioCard("");
	assert.strictEqual(card.mode, "radio");
	assert.strictEqual(card.$.listGroup.showing, true);
	assert.strictEqual(card.$.serverGroup.showing, null);
	assert.strictEqual(card.$.signInButton.caption, "Add Internet Radio");
	let posted = 0;
	card.post = () => { posted++; };
	card.performPrimary();
	assert.strictEqual(posted, 0);
	const r = card.$.crossAppResult.sent[0];
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.templateId, "org.webosports.app.music.radio");
});

test("radio: an own list is read by the service before the account is added", () => {
	const card = radioCard("  https://lists.example/my.m3u ");
	let asked = null;
	card.post = (url, body, cb) => { asked = { url, body }; cb(true, { ok: true, lists: [{ address: body.lists[0], stations: 3 }] }); };
	card.performPrimary();
	assert.strictEqual(asked.url, "http://127.0.0.1:8730/radioauth/lists");
	assert.deepStrictEqual(JSON.parse(JSON.stringify(asked.body)), { lists: ["https://lists.example/my.m3u"] });
	assert.strictEqual(card.$.crossAppResult.sent.length, 1);
	assert.strictEqual(card.$.crossAppResult.sent[0].returnValue, true);
});

test("radio: a list the service refuses keeps the card open with its reason", () => {
	const card = radioCard("https://lists.example/page.html");
	card.post = (url, body, cb) => cb(false, { error: "the playlist: it is a web page, not an M3U or PLS playlist" });
	card.performPrimary();
	assert.strictEqual(card.$.crossAppResult.sent.length, 0);
	assert.strictEqual(card.$.errorBox.showing, true);
	assert.match(card.$.errorMessage.content, /web page/);
	const other = radioCard("https://lists.example/x.m3u");
	other.post = (url, body, cb) => cb(false, null);
	other.performPrimary();
	assert.match(other.$.errorMessage.content, /could not be read/);
});

// Spotify: the user's own developer app (/auth/client-id), asked for before the sign-in.
function input(v) {
	const c = control();
	c.value = v || "";
	c.getValue = () => c.value;
	c.setValue = (x) => { c.value = x; };
	c.forceFocus = () => {};
	return c;
}

function spotifyCard({ app, status, plugin }) {
	const r = load({ plugin: !!plugin });
	const { card } = r;
	for (const n of ["spotifySetup", "changeAppButton", "headerIcon", "title", "removeAccountButton"]) card.$[n] = control();
	card.$.redirectUri = input();
	card.$.clientId = input();
	card.$.headerIcon.setSrc = () => {};
	card.$.signInButton.setCaption = (v) => { card.$.signInButton.caption = v; };
	card.$.signInButton.setDisabled = (v) => { card.$.signInButton.disabled = v; };
	r.calls = { finished: 0, login: 0, attempted: 0, posted: [] };
	card.get = (url, cb) => {
		if (url.endsWith("/auth/client-id")) return app ? cb(true, app) : cb(false, null);
		if (url.endsWith("/auth/status")) return cb(true, status || { authenticated: false, librespot: false });
		throw new Error("unexpected GET " + url);
	};
	card.fetchTokenAndFinish = () => { r.calls.finished++; };
	card.startLogin = () => { r.calls.login++; };
	const attempt = card.attemptFinish;
	card.attemptFinish = function (start) { r.calls.attempted++; return attempt.call(this, start); };
	card.handleLaunch({ template: { templateId: "org.webosports.app.music.spotify", loc_name: "Spotify" } });
	return r;
}

const REDIRECT = "http://127.0.0.1:8730/auth/callback";
const DASHBOARD = "https://developer.spotify.com/dashboard";
const ID = "0123456789abcdef0123456789abcdef";

test("spotify: no client id of the user's opens the setup, with the redirect URI to register", () => {
	const { card, calls } = spotifyCard({ app: { clientId: "", source: "", redirectUri: REDIRECT, dashboardUrl: DASHBOARD } });
	assert.strictEqual(card.$.spotifySetup.showing, true);
	assert.strictEqual(card.$.redirectUri.value, REDIRECT);
	assert.strictEqual(card.$.signInButton.caption, "Save and Connect");
	assert.strictEqual(card.$.signInButton.disabled, true);
	assert.strictEqual(calls.attempted, 0);
	// the field is for copying: an edit is put back
	card.$.redirectUri.value = "http://example.com/";
	card.keepRedirectUri();
	assert.strictEqual(card.$.redirectUri.value, REDIRECT);
});

test("spotify: only a 32-hex client id enables saving, and it is posted as Spotify writes it", () => {
	const { card, calls } = spotifyCard({ app: { clientId: "", source: "", redirectUri: REDIRECT, dashboardUrl: DASHBOARD } });
	for (const bad of ["", "abc", ID + "0", ID.slice(1) + "g", "Client ID " + ID]) {
		card.$.clientId.value = bad;
		card.validateInput();
		assert.strictEqual(card.$.signInButton.disabled, true, bad);
	}
	card.$.clientId.value = "  " + ID.toUpperCase() + "\n";
	card.validateInput();
	assert.strictEqual(card.$.signInButton.disabled, false);
	card.post = (url, body, cb) => { calls.posted.push({ url, body }); cb(true, { clientId: ID, source: "device", redirectUri: REDIRECT }); };
	card.performPrimary();
	assert.strictEqual(calls.posted.length, 1);
	assert.strictEqual(calls.posted[0].url, "http://127.0.0.1:8730/auth/client-id");
	assert.strictEqual(calls.posted[0].body.clientId, ID);
	assert.strictEqual(card.$.spotifySetup.showing, false);
	assert.strictEqual(card.$.changeAppButton.showing, true);
	assert.strictEqual(calls.login, 1);
});

test("spotify: a client id the backend refuses keeps the setup open with its reason", () => {
	const { card, calls } = spotifyCard({ app: { clientId: "", source: "", redirectUri: REDIRECT } });
	card.$.clientId.value = ID;
	card.post = (url, body, cb) => cb(false, { error: "the service was started with -client-id" });
	card.performPrimary();
	assert.strictEqual(calls.login, 0);
	assert.strictEqual(card.$.spotifySetup.showing, true);
	assert.match(card.$.errorMessage.content, /-client-id/);
});

test("spotify: the user's own client id signs in straight away, and can be changed", () => {
	const { card, calls } = spotifyCard({ app: { clientId: ID, source: "device", redirectUri: REDIRECT },
		status: { authenticated: true, librespot: true } });
	assert.notStrictEqual(card.$.spotifySetup.showing, true);
	assert.strictEqual(card.$.changeAppButton.showing, true);
	assert.strictEqual(calls.finished, 1);
	card.changeSpotifyApp();
	assert.strictEqual(card.$.spotifySetup.showing, true);
	assert.strictEqual(card.$.clientId.value, ID);
});

test("spotify: an image's client id finishes a session made with it, and otherwise asks for the user's", () => {
	let r = spotifyCard({ app: { clientId: ID, source: "image", redirectUri: REDIRECT },
		status: { authenticated: true, librespot: true } });
	assert.strictEqual(r.calls.finished, 1);
	assert.notStrictEqual(r.card.$.spotifySetup.showing, true);
	r = spotifyCard({ app: { clientId: ID, source: "image", redirectUri: REDIRECT } });
	assert.strictEqual(r.calls.finished, 0);
	assert.strictEqual(r.card.$.spotifySetup.showing, true);
	assert.strictEqual(r.card.$.clientId.value, "", "the image's id is not the user's to keep");
});

test("spotify: a backend without /auth/client-id signs in as before", () => {
	const { card, calls } = spotifyCard({ app: null });
	assert.strictEqual(calls.attempted, 1);
	assert.notStrictEqual(card.$.spotifySetup.showing, true);
});

test("spotify: /auth/login without a client id goes back to the setup", () => {
	const { card, proto } = spotifyCard({ app: { clientId: ID, source: "device", redirectUri: REDIRECT } });
	card.startLogin = proto.startLogin;
	card.get = (url, cb) => cb(false, { error: "no Spotify client id" });
	card.startLogin();
	assert.strictEqual(card.$.spotifySetup.showing, true);
});

test("spotify: a cancelled sign-in names INVALID_CLIENT and the redirect URI for the user's app", () => {
	const { card } = spotifyCard({ app: { clientId: ID, source: "device", redirectUri: REDIRECT } });
	card.webWindowFailed("Sign-in was cancelled.");
	assert.match(card.$.errorMessage.content, /INVALID_CLIENT/);
	assert.ok(card.$.errorMessage.content.indexOf(REDIRECT) >= 0);
});

test("spotify: the dashboard opens in a window, which cancelling the card closes", () => {
	const r = spotifyCard({ app: { clientId: "", source: "", redirectUri: REDIRECT, dashboardUrl: DASHBOARD } });
	r.card.openDashboard();
	assert.deepStrictEqual(r.opened.map((o) => o.url), [DASHBOARD + "/create"]);
	r.card.cancel();
	assert.strictEqual(r.popups[0].closed, true);
});

test("spotify (legacy webOS): the app's dashboard page fills its client id in", () => {
	const { card, opened } = spotifyCard({ plugin: true, app: { clientId: "", source: "", redirectUri: REDIRECT, dashboardUrl: DASHBOARD } });
	card.openDashboard();
	assert.strictEqual(opened.length, 0);
	assert.strictEqual(card._webUrl, DASHBOARD + "/create");
	card.onWebLoad(null, DASHBOARD + "/create");
	assert.strictEqual(card.$.clientId.value, "");
	card.onWebLoad(null, DASHBOARD + "/" + ID.toUpperCase() + "/settings");
	assert.strictEqual(card.$.clientId.value, ID);
	assert.strictEqual(card.$.signInButton.disabled, false);
	// one typed in already is left alone
	card.onWebLoad(null, DASHBOARD + "/fedcba9876543210fedcba9876543210");
	assert.strictEqual(card.$.clientId.value, ID);
});

test("spotify: WAM is asked to watch for the app's page, whose client id then connects by itself", () => {
	const r = spotifyCard({ app: { clientId: "", source: "", redirectUri: REDIRECT, dashboardUrl: DASHBOARD } });
	r.card.openDashboard();
	// what window.open got: the watch, with the pattern as it goes to WAM
	const feat = r.opened[0].features;
	assert.strictEqual(feat, 'attributes={"redirectPattern":"https://developer[.]spotify[.]com/dashboard/([0-9a-f]{32})([/?#]|$)"}');
	r.calls.posted = [];
	r.card.post = (url, body, cb) => { r.calls.posted.push(body.clientId); cb(true, { clientId: body.clientId, source: "device", redirectUri: REDIRECT }); };
	// WAM: watching, then the redirect to the app's page
	r.fire("watching");
	r.fire("redirect", DASHBOARD + "/8441944613A24CA4874B640499FCA35E/settings");
	assert.deepStrictEqual(r.calls.posted, ["8441944613a24ca4874b640499fca35e"]);
	assert.strictEqual(r.calls.login, 1);
	assert.strictEqual(r.card.$.spotifySetup.showing, false);
});

test("spotify: an address that is no app's page connects nothing", () => {
	const { card, calls } = spotifyCard({ app: { clientId: "", source: "", redirectUri: REDIRECT, dashboardUrl: DASHBOARD } });
	card.post = () => { calls.posted.push(1); };
	for (const u of [DASHBOARD, DASHBOARD + "/create", DASHBOARD + "/" + ID + "0", "https://evil.example/" + DASHBOARD + "/" + ID]) {
		assert.strictEqual(card.takeDashboardApp(u, true), false, u);
	}
	assert.strictEqual(calls.posted.length, 0);
});

test("the result goes to the log without the credentials' values", () => {
	const r = load({ plugin: false });
	const result = { returnValue: true, templateId: "org.webosports.app.music.spotify", username: "me@example.com",
		credentials: { common: { accessToken: "AT-secret-value", refreshToken: "RT-secret-value", expiry: "2026-11-09T16:00:00Z" } } };
	const line = r.card.loggableResult(result);
	assert.doesNotMatch(line, /secret-value/);
	assert.match(line, /"accessToken","refreshToken","expiry"/);
	assert.match(line, /me@example\.com/);
	assert.ok(r.card.loggableResult({ returnValue: false }).indexOf("credentials") < 0);
	// and finish() logs that, while sending the credentials themselves
	r.card.finish(result);
	assert.strictEqual(r.card.$.crossAppResult.sent[0].credentials.common.refreshToken, "RT-secret-value");
	// mlog writes to enyo.log and console.log
	assert.ok(r.logs.some((l) => l.indexOf("sendResult") >= 0));
	for (const l of r.logs) assert.doesNotMatch(l, /secret-value/);
});
