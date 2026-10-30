// node --test tests/unit
// OAuthWindow (cloud-auth's, and the copies musicauth and Teams carry) against a stand-in window: the
// redirect is caught from the popup's location, also when WAM has swapped in its load-error
// page because nothing serves the redirect_uri (Box's http://localhost/...).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const COPIES = [
	"../../cloud/_core/apps/com.palm.app.cloud-auth/source/oauthWindow.js",
	"../../music/_core/apps/org.webosports.app.musicauth/source/oauthWindow.js",
	"../../im/teams/apps/com.palm.app.teams/source/oauthWindow.js",
].map((p) => path.join(__dirname, p));

function load(file) {
	const popups = [];
	const timers = [];
	const listeners = {};
	const win = {
		navigator: { mimeTypes: {} },
		open(url, name, features) {
			const p = { closed: false, location: { href: url }, features, close() { p.closed = true; } };
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
	win.window = win;
	vm.createContext(win);
	vm.runInContext(fs.readFileSync(file, "utf8"), win, { filename: file });
	// What WAM does: run script in this page that dispatches a webOSOAuthWindow event.
	const wam = (state, url = "") => (listeners.webOSOAuthWindow || []).slice()
		.forEach((fn) => fn({ detail: { state, url } }));
	return { OAuthWindow: win.OAuthWindow, popups, win, wam, listeners,
		tick: () => timers.slice().forEach((fn) => fn()) };
}

const REDIRECT = "http://localhost/boxnet/oauth2callback";
const ERROR_PAGE = "file:///usr/share/localization/wam/loaderror.html?errorCode=-102&failedUrl=" +
	encodeURIComponent(REDIRECT + "?state=cloud&code=cP3R");

test("musicauth and Teams carry the same oauthWindow.js as cloud-auth", () => {
	for (const copy of COPIES.slice(1)) {
		assert.strictEqual(fs.readFileSync(copy, "utf8"), fs.readFileSync(COPIES[0], "utf8"), copy);
	}
});

for (const file of COPIES) {
	const name = path.basename(path.dirname(path.dirname(file)));

	test(`${name}: a redirect behind WAM's load-error page is caught`, () => {
		const { OAuthWindow, popups, tick } = load(file);
		const got = [];
		OAuthWindow.open({ url: "https://account.box.com/api/oauth2/authorize", redirectPrefix: REDIRECT,
			onRedirect: (u) => got.push(u), onError: (m) => got.push("error: " + m) });
		tick();
		assert.deepStrictEqual(got, []);
		popups[0].location.href = ERROR_PAGE;
		tick();
		assert.deepStrictEqual(got, [REDIRECT + "?state=cloud&code=cP3R"]);
		assert.strictEqual(popups[0].closed, true);
	});

	test(`${name}: a load error on some other page is not a redirect`, () => {
		const { OAuthWindow, popups, tick } = load(file);
		const got = [];
		OAuthWindow.open({ url: "https://account.box.com/api/oauth2/authorize", redirectPrefix: REDIRECT,
			onRedirect: (u) => got.push(u) });
		popups[0].location.href = "file:///usr/share/localization/wam/loaderror.html?errorCode=-105&failedUrl=" +
			encodeURIComponent("https://account.box.com/login");
		tick();
		assert.deepStrictEqual(got, []);
		assert.strictEqual(popups[0].closed, false);
	});

	test(`${name}: unwrapLoadError leaves other URLs alone`, () => {
		const { OAuthWindow } = load(file);
		assert.strictEqual(OAuthWindow.unwrapLoadError("https://x.example/?failedUrl=y"), "https://x.example/?failedUrl=y");
		assert.strictEqual(OAuthWindow.unwrapLoadError(null), null);
		assert.strictEqual(OAuthWindow.unwrapLoadError(ERROR_PAGE), REDIRECT + "?state=cloud&code=cP3R");
	});
}

for (const file of COPIES) {
	const name = path.basename(path.dirname(path.dirname(file)));
	test(`${name}: the window gets no size unless the caller asks for one`, () => {
		const watch = 'attributes={"redirectPrefix":"' + REDIRECT + '"}';
		let r = load(file);
		r.OAuthWindow.open({ url: "https://example.com/a", redirectPrefix: REDIRECT });
		assert.strictEqual(r.popups[0].features, watch);
		r = load(file);
		r.OAuthWindow.open({ url: "https://example.com/a", redirectPrefix: REDIRECT, features: "height=300" });
		assert.strictEqual(r.popups[0].features, "height=300," + watch);
	});

	test(`${name}: an http(s) prefix with a host, or an app's own scheme, asks WAM to watch`, () => {
		for (const [prefix, asked] of [
			["https://tidal.com/login/auth", true], ["http://localhost/koofr/oauth2callback", true],
			["msauth.com.microsoft.teams://auth", true], ["https:///x", false], [undefined, false],
			["msauth.x://", false], ["msauth.x:///auth", false], ["1app://auth", false],
			["javascript://x", false], ["FILE://x/y", false], ["data://x", false], ["https://", false],
		]) {
			const r = load(file);
			r.OAuthWindow.open({ url: "https://example.com/a", redirectPrefix: prefix });
			assert.strictEqual(r.popups[0].features.includes("attributes="), asked, String(prefix));
		}
	});

	test(`${name}: WAM's "redirect" is the hit, also after COOP made the window look closed`, () => {
		const r = load(file);
		const got = [];
		r.OAuthWindow.open({ url: "https://login.tidal.com/authorize", redirectPrefix: "https://tidal.com/login/auth",
			onRedirect: (u) => got.push(u), onError: (m) => got.push("error: " + m) });
		r.wam("watching");
		r.popups[0].closed = true; // Cross-Origin-Opener-Policy cut the handle off
		r.popups[0].location = null;
		r.tick();
		assert.deepStrictEqual(got, []);
		r.wam("redirect", "https://tidal.com/login/auth?code=AbC");
		assert.deepStrictEqual(got, ["https://tidal.com/login/auth?code=AbC"]);
		r.wam("redirect", "https://tidal.com/login/auth?code=again");
		r.wam("closed");
		assert.strictEqual(got.length, 1);
		assert.deepStrictEqual(r.listeners.webOSOAuthWindow, []);
	});

	test(`${name}: Teams' native-scheme redirect comes from WAM's watch`, () => {
		// The login page runs in a renderer of its own, so neither the window's location nor a
		// webOSExternalProtocol event reaches this page; WAM's "redirect" does.
		const prefix = "msauth.com.microsoft.teams://auth";
		const r = load(file);
		const got = [];
		r.OAuthWindow.open({ url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
			redirectPrefix: prefix, onRedirect: (u) => got.push(u), onError: (m) => got.push("error: " + m) });
		assert.strictEqual(r.popups[0].features, 'attributes={"redirectPrefix":"' + prefix + '"}');
		r.wam("watching");
		r.tick();
		assert.deepStrictEqual(got, []);
		r.wam("redirect", prefix + "/?code=M.C5_Ab");
		assert.deepStrictEqual(got, [prefix + "/?code=M.C5_Ab"]);
	});

	test(`${name}: a caller's own attributes are not added to`, () => {
		// A second attributes= would replace the caller's: WAM takes the last one.
		const r = load(file);
		r.OAuthWindow.open({ url: "https://example.com/a", redirectPrefix: REDIRECT, features: 'attributes={"window":"card"}' });
		assert.strictEqual(r.popups[0].features, 'attributes={"window":"card"}');
	});

	test(`${name}: WAM's "closed" cancels`, () => {
		const r = load(file);
		const got = [];
		r.OAuthWindow.open({ url: "https://app.koofr.net/oauth2/auth", redirectPrefix: "http://localhost/koofr/oauth2callback",
			onRedirect: (u) => got.push(u), onError: (m) => got.push("error: " + m) });
		r.wam("watching");
		r.wam("closed");
		assert.deepStrictEqual(got, ["error: Sign-in was cancelled."]);
	});

	test(`${name}: a missed "redirect" event is picked up from window.webOSOAuthRedirectUrl`, () => {
		const r = load(file);
		const got = [];
		r.win.webOSOAuthRedirectUrl = "http://localhost/koofr/oauth2callback?code=stale";
		r.OAuthWindow.open({ url: "https://app.koofr.net/oauth2/auth", redirectPrefix: "http://localhost/koofr/oauth2callback",
			onRedirect: (u) => got.push(u) });
		r.wam("watching");
		r.tick();
		assert.deepStrictEqual(got, [], "a URL left from an earlier sign-in counts");
		r.win.webOSOAuthRedirectUrl = "http://localhost/koofr/oauth2callback?code=new";
		r.tick();
		assert.deepStrictEqual(got, ["http://localhost/koofr/oauth2callback?code=new"]);
	});

	test(`${name}: without "watching" (older WAM) a closed window still cancels`, () => {
		const r = load(file);
		const got = [];
		r.OAuthWindow.open({ url: "https://account.box.com/api/oauth2/authorize", redirectPrefix: REDIRECT,
			onError: (m) => got.push(m) });
		r.popups[0].closed = true;
		r.tick();
		assert.deepStrictEqual(got, ["Sign-in was cancelled."]);
	});
}
