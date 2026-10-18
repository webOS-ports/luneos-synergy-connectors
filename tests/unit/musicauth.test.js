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
	const win = {
		navigator: { mimeTypes: plugin ? { "application/x-palm-browser": {} } : {} },
		open(url, name) {
			const p = { closed: false, location: { href: url }, close() { p.closed = true; } };
			opened.push({ url, name });
			popups.push(p);
			return p;
		},
		addEventListener() {},
		removeEventListener() {},
		setInterval(fn) { timers.push(fn); return timers.length; },
		clearInterval() {},
		setTimeout() { return 0; },
		clearTimeout() {},
	};
	let proto = null;
	const enyo = {
		kind(def) { proto = def; },
		bind: (self, fn) => fn.bind(self),
		log() {},
		BasicWebView: { prototype: { create() {} } },
	};
	win.window = win;
	win.enyo = enyo;
	win.console = { log() {} };
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
	return { card, opened, popups, tick, proto };
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

test("no plugin: reaching /auth/callback closes the window and checks the session", () => {
	const { card, popups, tick } = load({ plugin: false });
	card.mode = "spotify";
	let checked = 0;
	card.attemptFinish = () => { checked++; };
	card.openWeb("http://127.0.0.1:8730/login");
	tick();
	assert.strictEqual(checked, 0);
	popups[0].location.href = "http://127.0.0.1:8730/auth/callback?code=x&state=y";
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
