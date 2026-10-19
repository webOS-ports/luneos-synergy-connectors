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
	const win = {
		navigator: { mimeTypes: {} },
		open(url) {
			const p = { closed: false, location: { href: url }, close() { p.closed = true; } };
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
	win.window = win;
	vm.createContext(win);
	vm.runInContext(fs.readFileSync(file, "utf8"), win, { filename: file });
	return { OAuthWindow: win.OAuthWindow, popups, tick: () => timers.slice().forEach((fn) => fn()) };
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
