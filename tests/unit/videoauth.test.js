// node --test tests/unit
// The video sign-in card's M3U form (videoAuth.js), in a sandbox with a stand-in enyo: the Free TV
// list picked by the phone's region, the address fields only for "My own playlist", and what login
// is asked with.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The sandbox has its own Object and Array: compared as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

const APP = path.join(__dirname, "../../video/_core/apps/org.webosports.app.videoauth");

function control(value) {
	const c = { showing: false, content: "", value: value === undefined ? "" : value, items: null, calls: [] };
	c.setShowing = (v) => { c.showing = !!v; };
	c.show = () => { c.showing = true; };
	c.hide = () => { c.showing = false; };
	c.setContent = (v) => { c.content = v; };
	c.setCaption = () => {};
	c.setActive = () => {};
	c.setDisabled = () => {};
	c.setHint = () => {};
	c.setSrc = (v) => { c.src = v; };
	c.getValue = () => c.value;
	c.setItems = (v) => { c.items = v; };
	// As enyo's ListSelector: a value not among the items is not taken.
	c.setValue = (v) => { if (!c.items || c.items.some((i) => i.value === v)) { c.value = v; } };
	c.call = (params, opts) => { c.calls.push({ params, opts }); };
	return c;
}

function load(windowParams) {
	let proto = null;
	const win = { setTimeout() { return 0; }, clearTimeout() {} };
	const enyo = { kind(def) { proto = def; }, bind: (self, fn) => fn.bind(self), VFlexBox: {}, windowParams, log() {} };
	win.window = win;
	win.enyo = enyo;
	vm.createContext(win);
	vm.runInContext(fs.readFileSync(path.join(APP, "source/videoAuth.js"), "utf8"), win, { filename: "videoAuth.js" });
	const card = Object.create(proto);
	card.inherited = () => {};
	card.log = () => {};
	card.$ = {};
	for (const n of ["title", "headerIcon", "bodyText", "primaryButton", "serverGroup", "usernameGroup", "passwordGroup", "urlGroup",
		"nameGroup", "tokenGroup", "addressLink", "pinBox", "errorBox", "errorText", "removeAccountButton", "instanceGroup",
		"catalogGroup", "catalogNote", "server", "username", "password", "url", "listName", "token", "svc", "dir", "catalogs", "prefs",
		"crossAppResult"]) {
		card.$[n] = control();
	}
	card.$.catalogPicker = control("own");
	card.showError = function (s) { this.lastError = s; };
	card.create();
	return card;
}

const M3U = { template: { templateId: "org.webosports.video.m3u", loc_name: "M3U Playlist" } };
const CATALOGS = { catalogs: [
	{ id: "freetv:germany", name: "Germany", region: "DE", topic: false },
	{ id: "freetv:netherlands", name: "Netherlands", region: "NL", topic: false },
	{ id: "freetv:zz_movies", name: "Films", region: "", topic: true },
	{ id: "freetv:all", name: "All countries", region: "", topic: false }],
source: { name: "Free-TV", link: "https://github.com/Free-TV/IPTV" } };

test("the M3U form asks for the lists and the phone's region, and waits for both", () => {
	const card = load(M3U);
	assert.strictEqual(card.$.catalogGroup.showing, true);
	assert.deepStrictEqual(plain(card.$.catalogs.calls.map((c) => c.params)), [{}]);
	assert.deepStrictEqual(plain(card.$.prefs.calls.map((c) => c.params)), [{ keys: ["region", "locale"] }]);
	card.gotCatalogs(null, CATALOGS);
	assert.strictEqual(card.$.catalogPicker.items, null, "not before the region");
	card.gotRegion(null, { region: { countryCode: "nl" }, locale: { countryCode: "us" } });
	assert.deepStrictEqual(plain(card.$.catalogPicker.items.map((i) => i.value)),
		["freetv:germany", "freetv:netherlands", "freetv:zz_movies", "freetv:all", "own"]);
	assert.strictEqual(card.$.catalogPicker.items[1].caption, "Free TV – Netherlands");
	assert.strictEqual(card.$.catalogPicker.value, "freetv:netherlands", "the region, not the language's country");
	assert.strictEqual(card.$.urlGroup.showing, false);
	assert.strictEqual(card.$.nameGroup.showing, false);
	assert.match(card.$.catalogNote.content, /Free-TV lists \(github\.com\/Free-TV\/IPTV\)/);
});

test("without a region the locale's country; with neither, all countries; without the lists, the user's own", () => {
	let card = load(M3U);
	card.gotRegion(null, { locale: { countryCode: "de" } });
	card.gotCatalogs(null, CATALOGS);
	assert.strictEqual(card.$.catalogPicker.value, "freetv:germany");
	card = load(M3U);
	card.gotCatalogs(null, CATALOGS);
	card.gotRegion(null, { region: { countryCode: "fj" } });
	assert.strictEqual(card.$.catalogPicker.value, "freetv:all");
	card = load(M3U);
	card.noRegion();
	card.gotCatalogs(null, CATALOGS);
	assert.strictEqual(card.$.catalogPicker.value, "freetv:all");
	card = load(M3U);
	card.noCatalogs();
	card.gotRegion(null, { region: { countryCode: "nl" } });
	assert.deepStrictEqual(plain(card.$.catalogPicker.items.map((i) => i.value)), ["own"]);
	assert.strictEqual(card.$.catalogPicker.value, "own");
	assert.strictEqual(card.$.urlGroup.showing, true);
	assert.strictEqual(card.$.nameGroup.showing, true);
});

test("a Free TV list signs in with its id only; the own playlist with its address and name", () => {
	const card = load(M3U);
	card.gotCatalogs(null, CATALOGS);
	card.gotRegion(null, { region: { countryCode: "nl" } });
	card.$.url.value = "http://ignored.example/x.m3u";
	card.primaryTap();
	assert.deepStrictEqual(plain(card.$.svc.calls.map((c) => [c.params, c.opts.method])),
		[[{ templateId: "org.webosports.video.m3u", catalog: "freetv:netherlands" }, "login"]]);

	const own = load(M3U);
	own.gotCatalogs(null, CATALOGS);
	own.gotRegion(null, { region: { countryCode: "nl" } });
	own.$.catalogPicker.setValue("own");
	own.catalogChanged();
	assert.strictEqual(own.$.urlGroup.showing, true);
	own.primaryTap();
	assert.strictEqual(own.$.svc.calls.length, 0, "no address, no login");
	assert.strictEqual(own.lastError, "Enter the playlist's address.");
	own.$.url.value = "  http://iptv.example/get.php?u=1  ";
	own.$.listName.value = " Mine ";
	own.primaryTap();
	assert.deepStrictEqual(plain(own.$.svc.calls[0].params), { templateId: "org.webosports.video.m3u", url: "http://iptv.example/get.php?u=1", name: "Mine" });
});

test("the source's name is shown as text, not markup", () => {
	const card = load(M3U);
	card.gotCatalogs(null, { catalogs: CATALOGS.catalogs, source: { name: "<b>x</b>", link: "https://a.example/<i>" } });
	card.gotRegion(null, {});
	assert.ok(!/<b>|<i>/.test(card.$.catalogNote.content), card.$.catalogNote.content);
});

test("other kinds have no lists to pick from", () => {
	const card = load({ template: { templateId: "org.webosports.video.jellyfin" } });
	assert.strictEqual(card.$.catalogGroup.showing, false);
	assert.strictEqual(card.$.catalogs.calls.length, 0);
	assert.strictEqual(card.$.prefs.calls.length, 0);
});

test("Emby asks for the server, user name and password, and signs in with its own templateId", () => {
	const card = load({ template: { templateId: "org.webosports.video.emby", loc_name: "Emby" } });
	assert.strictEqual(card.$.title.content, "Emby");
	assert.match(card.$.bodyText.content, /Emby server/);
	assert.deepStrictEqual([card.$.serverGroup.showing, card.$.usernameGroup.showing, card.$.passwordGroup.showing, card.$.urlGroup.showing],
		[true, true, true, false]);
	assert.strictEqual(card.$.headerIcon.src, "images/connectors/emby.png");
	assert.ok(fs.existsSync(path.join(__dirname, "../../video/_core/apps/org.webosports.app.videoauth", card.$.headerIcon.src)));
	for (const n of ["emby-32x32.png", "emby-48x48.png"]) {
		assert.ok(fs.existsSync(path.join(__dirname, "../../video/emby/account/org.webosports.video.emby/images", n)), n);
	}
	card.$.server.value = " emby.example.org ";
	card.$.username.value = "alice";
	card.$.password.value = "pw";
	card.primaryTap();
	assert.deepStrictEqual(JSON.parse(JSON.stringify(card.$.svc.calls.map((c) => [c.opts.method, c.params]))), [["login",
		{ templateId: "org.webosports.video.emby", server: "emby.example.org", username: "alice", password: "pw" }]]);
});
