"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../video/_core/service/org.webosports.service.videos");
const service = require(SVC);
const owncast = require("../../video/owncast/provider");
const upnpLib = require("../../video/upnp/provider");

const VIDEOS = { appId: "org.webosports.app.videoplayer 1234" };
const AUTH = { appId: "org.webosports.app.videoauth 999" };
const T = owncast._test;
const TPL = "org.webosports.video.owncast";
const DIR = "https://directory.owncast.online";

// The shapes Owncast 0.2.4 answered with (watch.vapor.fm, 2026-11-04), cut down.
const STATUS_ON = { serverTime: "2026-11-04T20:35:37.816753942Z", lastConnectTime: "2026-11-04T00:00:34Z", lastDisconnectTime: null,
	versionNumber: "0.2.4", streamTitle: "Friday <Funk>", viewerCount: 18, online: true };
const STATUS_OFF = { serverTime: "2026-11-04T20:35:37Z", lastConnectTime: null, lastDisconnectTime: "2026-11-04T10:00:00Z",
	versionNumber: "0.2.4", streamTitle: "", viewerCount: 0, online: false };
const CONFIG = { name: "Funk Radio", summary: "<p>Only the finest &amp; funkiest</p>", logo: "/logo",
	version: "Owncast v0.2.4-linux-64bit (7929580b98a6a84806b62f97c04306c17217ba38)", offlineMessage: "<p>Off</p>",
	tags: ["radio", "music"], hideViewerCount: false, nsfw: false };

// The directory's /api/home (directory.owncast.online, 2026-11-04), cut down: one live section
// and the offline one.
function entry(o) {
	return Object.assign({ id: 1, name: "X", description: "", streamTitle: "", url: "https://x.example", logo: "/logo", tags: [],
		nsfw: false, lastSeen: "2026-11-04T20:32:45Z", streamingSince: "2026-11-04T19:44:44Z" }, o);
}
const MUSIC = { name: "Music", slug: "music", description: "People playing music.", image: "/images/categories/music.svg", color: "blue" };
const TECH = { name: "Tech", slug: "tech", description: "Live coding.", image: "/images/categories/technology.svg", color: "violet" };
const GAMES = { name: "Video Games", slug: "video-games", image: "/images/categories/games.svg", color: "red" };
const HOME = { sections: [
	{ name: "What's Streaming Now", description: "", online: true, instances: [
		entry({ id: 3506, name: "Le Meowncast", streamTitle: "Le Meowcredi ! Soirée", url: "https://owncast.meowcate.space",
			description: "Du streaming de qualité.", tags: [{ name: "film", slug: "film" }, { name: "cinéma", slug: "cinema" }] }),
		entry({ id: 2964, name: "24/7 Vapor Funk Radio", url: "https://watch.vapor.fm/", tags: [MUSIC, { name: "radio", slug: "radio" }] }),
		entry({ id: 77, name: "Grown-ups only", url: "https://nsfw.example", nsfw: true, tags: [MUSIC] }),
		entry({ id: 78, name: "No flag", url: "https://noflag.example", nsfw: undefined }),
		entry({ id: 79, name: "Shouting", url: "HTTPS://LOUD.EXAMPLE", streamTitle: "Coding live", tags: [TECH] }),
		entry({ id: 80, name: "Twice", url: "https://watch.vapor.fm" }),
		entry({ id: 81, name: "Bad link", url: "javascript:alert(1)" }),
		entry({ id: "x/../1", name: "Odd id", url: "http://plain.example:9080", tags: null }),
	] },
	{ name: "More Owncast Instances", description: "", online: false, instances: [
		entry({ id: 5, name: "Asleep", url: "https://asleep.example", tags: [MUSIC] }),
	] },
], featured: entry({ id: 2963, name: "24/7 Chiptune Radio", url: "https://watch.chiptune.fm" }) };

const ACCOUNTS = [
	{ _id: "acc-oc", templateId: TPL, username: "live.example", alias: "Funk Radio (live.example)" },
	{ _id: "acc-dir", templateId: TPL, username: "directory.owncast.online", alias: "Owncast Directory" },
];
const CREDS = { "acc-oc": { server: "https://live.example", name: "Funk Radio" }, "acc-dir": { directory: true } };

function routes(over = {}) {
	const or = (k, dflt) => () => (over[k] ? over[k]() : dflt);
	return [
		["GET", /^https:\/\/live\.example\/api\/status$/, or("status", { body: STATUS_ON })],
		["GET", /^https:\/\/live\.example\/api\/config$/, or("config", { body: CONFIG })],
		["GET", /^https:\/\/directory\.owncast\.online\/api\/home$/, or("home", { body: HOME })],
		["GET", /^https:\/\/directory\.owncast\.online\/api\/tags$/, or("tags", { body: [MUSIC, { name: "Chatting", slug: "chatting" }, TECH, GAMES] })],
		["GET", /^https:\/\/watch\.vapor\.fm\/api\/status$/, or("vapor", { body: STATUS_ON })],
		["GET", /^https:\/\/owncast\.meowcate\.space\/api\/status$/, () => ({ body: STATUS_OFF })],
		// A bare host: https refused, http answers on port 80.
		["GET", /^https:\/\/home\.example\//, () => { throw new Error("refused"); }],
		["GET", /^http:\/\/home\.example\/api\/status$/, () => ({ body: STATUS_OFF })],
		["GET", /^http:\/\/home\.example\/api\/config$/, () => ({ body: Object.assign({}, CONFIG, { name: "" }) })],
		// Owncast on its own port only.
		["GET", /^https?:\/\/port\.example\//, () => { throw new Error("refused"); }],
		["GET", /^http:\/\/port\.example:8080\/api\/status$/, () => ({ body: STATUS_ON })],
		["GET", /^http:\/\/port\.example:8080\/api\/config$/, () => ({ body: CONFIG })],
		// Half an Owncast: the status without the version, or a config that is not Owncast's.
		["GET", /^https:\/\/half\.example\/api\/status$/, () => ({ body: { online: "yes", versionNumber: 2 } })],
		["GET", /^https:\/\/half\.example\/api\/config$/, () => ({ body: CONFIG })],
		["GET", /^https:\/\/fake\.example\/api\/status$/, () => ({ body: STATUS_ON })],
		["GET", /^https:\/\/fake\.example\/api\/config$/, () => ({ body: { name: "Fake", version: "Jellyfin 10.9" } })],
		// Some other web server, answering JSON or a page.
		["GET", /^https:\/\/jelly\.example\/api\/status$/, () => ({ body: { Id: "x", ServerName: "Jelly" } })],
		["GET", /^https:\/\/jelly\.example\/api\/config$/, () => ({ body: { version: "10.9" } })],
		["GET", /^https:\/\/page\.example\//, () => ({ body: "<!doctype html><html></html>" })],
		["GET", /^https?:\/\/(page\.example|gone\.example)/, () => { throw new Error("refused"); }],
		["GET", /^https:\/\/missing\.example\//, () => ({ status: 404, body: "no" })],
		["GET", /^http:\/\/missing\.example/, () => { throw new Error("refused"); }],
	];
}

function start({ rts = routes(), accounts = ACCOUNTS, creds = CREDS, logs = [] } = {}) {
	owncast._test.reset();
	upnpLib._test.dir._set([]);
	const store = JSON.parse(JSON.stringify(creds));
	const pb = fakePalmbus({ onCall: (uri, args) => {
		if (uri.endsWith("/listAccounts")) { return { returnValue: true, results: accounts }; }
		if (uri.endsWith("/readCredentials")) {
			return store[args.accountId] ? { returnValue: true, credentials: { common: store[args.accountId] } } : { returnValue: false, errorCode: "NOT_FOUND" };
		}
		return { returnValue: true };
	} });
	const { fetch, requests } = fakeFetch(rts);
	const log = { log: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)), warn: (s) => logs.push(String(s)) };
	const s = service.start({ palmbus: pb, fetch, ssdp: { search: async () => [] }, idleMs: 0, exit: () => {}, log,
		timeouts: { timeoutMs: 2000, idleTimeoutMs: 2000 }, random: (n) => Buffer.alloc(n, 7) });
	const handle = pb.handles[0];
	return { call: (m, p, who = VIDEOS) => ask(handle, m, p, who), requests, logs, stop: () => s.bus.stop() };
}

const hits = (t, re) => t.requests.filter((q) => re.test(q.url)).length;

test("addresses: a bare host is tried on https, http and Owncast's port; a typed one as it is, without its path", () => {
	assert.deepStrictEqual(T.originsOf(" live.example "), ["https://live.example", "http://live.example", "http://live.example:8080"]);
	assert.deepStrictEqual(T.originsOf("192.168.1.10:8080"), ["https://192.168.1.10:8080", "http://192.168.1.10:8080"]);
	assert.deepStrictEqual(T.originsOf("http://Live.Example:8080/embed/video?x=1"), ["http://live.example:8080"]);
	for (const bad of ["", "   ", "ftp://live.example", "https://bob:pw@live.example", "http://", "javascript:alert(1)"]) {
		assert.deepStrictEqual(T.originsOf(bad), [], bad);
	}
	assert.strictEqual(T.originOf("HTTPS://ZAM.CCAP.SITE"), "https://zam.ccap.site");
	assert.strictEqual(T.originOf("https://watch.vapor.fm/"), "https://watch.vapor.fm");
	for (const bad of [undefined, 5, "", "rtmp://x.example/live", "https://u:p@x.example", "/relative", "https://" + "a".repeat(300) + ".example"]) {
		assert.strictEqual(T.originOf(bad), null, String(bad));
	}
});

test("text from a server loses its markup; pictures are links on the server or full links", () => {
	assert.strictEqual(T.plainText("<p>Only the finest &amp; <b>funkiest</b></p>\n\n"), "Only the finest & funkiest");
	assert.strictEqual(T.plainText("&lt;3 &quot;x&quot; &#39;y&#39;&nbsp;z"), "<3 \"x\" 'y' z");
	assert.strictEqual(T.plainText(undefined), undefined);
	assert.strictEqual(T.linkOn("https://a.example", "/logo"), "https://a.example/logo");
	assert.strictEqual(T.linkOn("https://a.example", "https://cdn.example/l.png"), "https://cdn.example/l.png");
	for (const bad of ["//evil.example/x", "/\\evil.example", "logo", "javascript:x", null]) {
		assert.strictEqual(T.linkOn("https://a.example", bad), undefined, String(bad));
	}
});

test("login: a server is checked with /api/config and /api/status, as LuneOS-Videos/1.0", async () => {
	const t = start();
	const r = await t.call("login", { templateId: TPL, server: "https://live.example/" }, AUTH);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual([r.username, r.alias], ["live.example", "Funk Radio (live.example)"]);
	assert.deepStrictEqual(r.credentials, { common: { server: "https://live.example", name: "Funk Radio" } });
	assert.deepStrictEqual(t.requests.map((q) => q.url).sort(), ["https://live.example/api/config", "https://live.example/api/status"]);
	for (const q of t.requests) {
		assert.strictEqual(q.headers["User-Agent"], "LuneOS-Videos/1.0");
		assert.strictEqual(q.headers.Accept, "application/json");
	}
	t.stop();
});

test("login: a bare host falls back to http, then to port 8080; a server without a name is named by its host", async () => {
	const t = start();
	const home = await t.call("login", { templateId: TPL, server: "home.example" }, AUTH);
	assert.strictEqual(home.returnValue, true, JSON.stringify(home));
	assert.deepStrictEqual([home.alias, home.credentials.common], ["Owncast – home.example", { server: "http://home.example", name: "home.example" }]);
	assert.strictEqual(hits(t, /home\.example:8080/), 0, "no more tries once one answers");
	const port = await t.call("login", { templateId: TPL, server: "port.example" }, AUTH);
	assert.strictEqual(port.returnValue, true, JSON.stringify(port));
	assert.deepStrictEqual([port.username, port.credentials.common.server], ["port.example:8080", "http://port.example:8080"]);
	t.stop();
});

test("login refusals say why", async () => {
	const t = start();
	const cases = {
		"": ["MISSING_ARGS", /Enter the Owncast server/],
		"ftp://live.example": ["MISSING_ARGS", /Enter the Owncast server/],
		"https://jelly.example": ["BAD_ARGS", /no Owncast server/],
		"https://half.example": ["BAD_ARGS", /no Owncast server/],
		"https://fake.example": ["BAD_ARGS", /no Owncast server/],
		"https://page.example": ["BAD_ARGS", /no Owncast server/],
		"missing.example": ["BAD_ARGS", /no Owncast server/],
		"gone.example": ["SERVER_UNREACHABLE", /does not answer/],
	};
	for (const [server, [code, text]] of Object.entries(cases)) {
		const r = await t.call("login", { templateId: TPL, server }, AUTH);
		assert.strictEqual(r.returnValue, false, server);
		assert.strictEqual(r.errorCode, code, server + " " + r.errorText);
		assert.match(r.errorText, text, server);
	}
	t.stop();
});

test("login: the directory needs nothing typed, and is checked to answer", async () => {
	const t = start();
	const r = await t.call("login", { templateId: TPL, directory: true, server: "ignored.example" }, AUTH);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual([r.username, r.alias, r.credentials], ["directory.owncast.online", "Owncast Directory", { common: { directory: true } }]);
	assert.deepStrictEqual(t.requests.map((q) => q.url), [DIR + "/api/home"]);
	t.stop();
	const down = start({ rts: routes({ home: () => { throw new Error("refused"); } }) });
	const d = await down.call("login", { templateId: TPL, directory: true }, AUTH);
	assert.deepStrictEqual([d.returnValue, d.errorCode], [false, "SERVER_UNREACHABLE"]);
	const truthy = await down.call("login", { templateId: TPL, directory: "yes" }, AUTH);
	assert.strictEqual(truthy.errorCode, "MISSING_ARGS", "only true is the directory");
	down.stop();
});

test("sources: a server cannot be searched, the directory can; both are live", async () => {
	const t = start();
	const r = await t.call("listSources", {});
	assert.deepStrictEqual(r.sources.map((s) => [s.sourceId, s.name, s.label, s.provider, s.features]), [
		["acc-oc", "Funk Radio (live.example)", "Funk Radio", "owncast", { search: false, progress: false, continueWatching: false, live: true }],
		["acc-dir", "Owncast Directory", "Owncast Directory", "owncast", { search: true, progress: false, continueWatching: false, live: true }],
	]);
	assert.strictEqual(t.requests.length, 0, "listing the sources asks no server");
	assert.strictEqual((await t.call("search", { sourceId: "acc-oc", query: "funk" })).errorCode, "NOT_SUPPORTED");
	t.stop();
});

test("a server that is live: one row with the stream, its title, name, viewers and pictures", async () => {
	const t = start();
	const s = await t.call("listSections", { sourceId: "acc-oc" });
	assert.deepStrictEqual(s.sections, [{ id: "live", title: "Live Now", layout: "row" }]);
	const r = await t.call("listItems", { sourceId: "acc-oc", sectionId: "live" });
	assert.strictEqual(r.items.length, 1);
	const it = r.items[0];
	assert.deepStrictEqual([it.id, it.kind, it.title, it.subtitle, it.description, it.playable, it.hasChildren, it.webUrl, it.durationMs, it.progress],
		["live", "live", "Friday <Funk>", "Funk Radio · 18 watching", "Only the finest & funkiest", true, false, "https://live.example", undefined, undefined]);
	assert.match(it.artwork.thumb, /^https:\/\/live\.example\/thumbnail\.jpg\?t=\d+$/);
	assert.strictEqual(it.artwork.backdrop, it.artwork.thumb);
	assert.strictEqual(it.artwork.poster, "https://live.example/logo");
	assert.strictEqual(r.nextCursor, null);
	const g = await t.call("getItem", { sourceId: "acc-oc", itemId: "live" });
	assert.strictEqual(g.item.title, "Friday <Funk>");
	assert.strictEqual((await t.call("getItem", { sourceId: "acc-oc", itemId: "other" })).errorCode, "NOT_FOUND");
	assert.strictEqual((await t.call("listItems", { sourceId: "acc-oc", sectionId: "nope" })).errorCode, "NOT_FOUND");
	t.stop();
});

test("resolve: the server's HLS playlist, once its status says it is on", async () => {
	const t = start();
	const r = await t.call("resolve", { sourceId: "acc-oc", itemId: "live" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(r.stream, { url: "https://live.example/hls/stream.m3u8", protocol: "hls", mime: "application/x-mpegURL",
		subtitles: [], drm: null });
	assert.strictEqual((await t.call("resolve", { sourceId: "acc-oc", itemId: "https://evil.example" })).errorCode, "NOT_FOUND");
	t.stop();
});

test("a server that hides its viewers, or has no stream title", async () => {
	const t = start({ rts: routes({ config: () => ({ body: Object.assign({}, CONFIG, { hideViewerCount: true, logo: "https://cdn.example/l.png" }) }),
		status: () => ({ body: Object.assign({}, STATUS_ON, { streamTitle: "", viewerCount: 1 }) }) }) });
	const it = (await t.call("listItems", { sourceId: "acc-oc", sectionId: "live" })).items[0];
	assert.deepStrictEqual([it.title, it.subtitle, it.artwork.poster], ["Funk Radio", undefined, "https://cdn.example/l.png"]);
	t.stop();
	const one = start({ rts: routes({ status: () => ({ body: Object.assign({}, STATUS_ON, { streamTitle: "", viewerCount: 1 }) }) }) });
	assert.strictEqual((await one.call("listItems", { sourceId: "acc-oc", sectionId: "live" })).items[0].subtitle, "1 watching");
	one.stop();
});

test("a server whose config cannot be read still shows its stream, by the stored name", async () => {
	const t = start({ rts: routes({ config: () => ({ status: 500, body: "x" }) }) });
	const r = await t.call("listItems", { sourceId: "acc-oc", sectionId: "live" });
	assert.deepStrictEqual([r.items[0].title, r.items[0].subtitle, r.items[0].artwork.poster], ["Friday <Funk>", "Funk Radio · 18 watching", "https://live.example/logo"]);
	assert.ok(t.logs.some((l) => /owncast: no config/.test(l)));
	t.stop();
});

test("a server that is off: an empty section that says so, not an error; it cannot be played", async () => {
	const t = start({ rts: routes({ status: () => ({ body: STATUS_OFF }) }) });
	const s = await t.call("listSections", { sourceId: "acc-oc" });
	assert.deepStrictEqual(s.sections, [{ id: "live", title: "Not Live Right Now", layout: "grid" }]);
	const r = await t.call("listItems", { sourceId: "acc-oc", sectionId: "live" });
	assert.deepStrictEqual([r.returnValue, r.items, r.nextCursor], [true, [], null]);
	const p = await t.call("resolve", { sourceId: "acc-oc", itemId: "live" });
	assert.deepStrictEqual([p.errorCode, p.errorText], ["NOT_FOUND", "Funk Radio is not live right now."]);
	assert.strictEqual((await t.call("getItem", { sourceId: "acc-oc", itemId: "live" })).errorCode, "NOT_FOUND");
	assert.strictEqual(hits(t, /\/api\/config$/), 0, "nothing more is asked of a server that is off");
	t.stop();
});

test("only online: true is on", async () => {
	const t = start({ rts: routes({ status: () => ({ body: Object.assign({}, STATUS_ON, { online: "true" }) }) }) });
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-oc" })).sections[0].title, "Not Live Right Now");
	t.stop();
});

test("search on a server, asked of the provider itself, finds nothing and asks nothing", async () => {
	let asked = 0;
	const http = { json: async () => { asked++; return HOME; } };
	const r = await owncast.search({ creds: { server: "https://live.example" }, http, log: console }, { query: "funk", cursor: null, limit: 10 });
	assert.deepStrictEqual([r.items, r.nextCursor, asked], [[], null, 0]);
});

test("a server that does not answer is unreachable; one with no address must be added again", async () => {
	const t = start({ rts: routes({ status: () => { throw new Error("refused"); } }),
		creds: Object.assign({}, CREDS, { "acc-dir": { server: "not a link" } }) });
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-oc" })).errorCode, "SERVER_UNREACHABLE");
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-dir" })).errorCode, "AUTH_EXPIRED");
	assert.strictEqual((await t.call("resolve", { sourceId: "acc-dir", itemId: "live" })).errorCode, "NOT_FOUND");
	t.stop();
});

test("a server's status is asked at most every 20 seconds", async (c) => {
	const keep = Object.assign({}, T.TIMES);
	c.after(() => Object.assign(T.TIMES, keep));
	const t = start();
	await t.call("listSections", { sourceId: "acc-oc" });
	await t.call("listItems", { sourceId: "acc-oc", sectionId: "live" });
	await t.call("resolve", { sourceId: "acc-oc", itemId: "live" });
	assert.strictEqual(hits(t, /live\.example\/api\/status$/), 1);
	assert.strictEqual(T.TIMES.statusMs, 20000);
	T.TIMES.statusMs = 0;
	await t.call("resolve", { sourceId: "acc-oc", itemId: "live" });
	assert.strictEqual(hits(t, /live\.example\/api\/status$/), 2);
	t.stop();
});

test("directory: entries that are live, not NSFW, with a link; each server once", () => {
	const list = HOME.sections[0].instances.map(T.directoryEntry).filter(Boolean);
	assert.deepStrictEqual(list.map((e) => [e.origin, e.id]), [
		["https://owncast.meowcate.space", "3506"], ["https://watch.vapor.fm", "2964"], ["https://loud.example", "79"],
		["https://watch.vapor.fm", "80"], ["http://plain.example:9080", null]]);
	assert.deepStrictEqual(list[4].tags, [], "no tags is none");
});

test("directory sections: Live Now, the categories with something live, All Live Streams", async () => {
	const t = start();
	const s = await t.call("listSections", { sourceId: "acc-dir" });
	assert.deepStrictEqual(s.sections.map((x) => [x.id, x.title, x.layout]), [
		["live", "Live Now", "row"], ["tag:music", "Music", "grid"], ["tag:tech", "Tech", "grid"], ["all", "All Live Streams", "grid"]]);
	t.stop();
	const notags = start({ rts: routes({ tags: () => ({ status: 503, body: "x" }) }) });
	const n = await notags.call("listSections", { sourceId: "acc-dir" });
	assert.deepStrictEqual(n.sections.map((x) => x.id), ["live", "all"], "without the categories, the rest still");
	await notags.call("listSections", { sourceId: "acc-dir" });
	assert.strictEqual(hits(notags, /\/api\/tags$/), 2, "a failed read of the categories is not kept");
	notags.stop();
});

test("directory items: live, the stream title over the server's name, the directory's pictures; paging", async () => {
	const t = start();
	const r = await t.call("listItems", { sourceId: "acc-dir", sectionId: "all", limit: 2 });
	assert.deepStrictEqual(r.items.map((i) => [i.id, i.kind, i.title, i.subtitle]), [
		["https://owncast.meowcate.space", "live", "Le Meowcredi ! Soirée", "Le Meowncast"],
		["https://watch.vapor.fm", "live", "24/7 Vapor Funk Radio", "Music, radio"]]);
	assert.match(r.items[0].artwork.thumb, /^https:\/\/directory\.owncast\.online\/api\/image\/thumb\/3506\?t=\d+$/);
	assert.strictEqual(r.items[0].artwork.poster, DIR + "/api/image/logo/3506");
	assert.deepStrictEqual([r.items[0].webUrl, r.items[0].description, r.items[0].playable], ["https://owncast.meowcate.space", "Du streaming de qualité.", true]);
	assert.strictEqual(r.nextCursor, "2");
	const rest = await t.call("listItems", { sourceId: "acc-dir", sectionId: "all", cursor: "2", limit: 10 });
	assert.deepStrictEqual(rest.items.map((i) => [i.title, i.subtitle]), [["Coding live", "Shouting"], ["Odd id", undefined]]);
	assert.deepStrictEqual(rest.items[1].artwork, {}, "no picture without the directory's id");
	assert.strictEqual(rest.nextCursor, null);
	const row = await t.call("listItems", { sourceId: "acc-dir", sectionId: "live", limit: 50 });
	assert.strictEqual(row.items.length, 4);
	const music = await t.call("listItems", { sourceId: "acc-dir", sectionId: "tag:music", limit: 50 });
	assert.deepStrictEqual(music.items.map((i) => i.id), ["https://watch.vapor.fm"], "not the NSFW one nor the offline one");
	assert.strictEqual((await t.call("listItems", { sourceId: "acc-dir", sectionId: "nope" })).errorCode, "NOT_FOUND");
	const g = await t.call("getItem", { sourceId: "acc-dir", itemId: "https://loud.example" });
	assert.strictEqual(g.item.title, "Coding live");
	assert.strictEqual((await t.call("getItem", { sourceId: "acc-dir", itemId: "https://asleep.example" })).errorCode, "NOT_FOUND");
	assert.strictEqual(hits(t, /\/api\/home$/), 1, "the directory is read once for all of it");
	t.stop();
});

test("the directory is read again after two minutes", async (c) => {
	const keep = Object.assign({}, T.TIMES);
	c.after(() => Object.assign(T.TIMES, keep));
	const t = start();
	await t.call("listSections", { sourceId: "acc-dir" });
	await t.call("listSections", { sourceId: "acc-dir" });
	assert.deepStrictEqual([hits(t, /\/api\/home$/), hits(t, /\/api\/tags$/)], [1, 1]);
	assert.deepStrictEqual([T.TIMES.directoryMs, T.TIMES.tagsMs], [120000, 3600000]);
	T.TIMES.directoryMs = 0;
	T.TIMES.tagsMs = 0;
	await t.call("listSections", { sourceId: "acc-dir" });
	assert.deepStrictEqual([hits(t, /\/api\/home$/), hits(t, /\/api\/tags$/)], [2, 2]);
	t.stop();
});

test("directory search: every word, over names, titles, descriptions and tags, case and accents aside", async () => {
	const t = start();
	const q = async (query) => (await t.call("search", { sourceId: "acc-dir", query })).items.map((i) => i.id);
	assert.deepStrictEqual(await q("CINEMA"), ["https://owncast.meowcate.space"], "a tag, without its accent");
	assert.deepStrictEqual(await q("qualite streaming"), ["https://owncast.meowcate.space"]);
	assert.deepStrictEqual(await q("vapor radio"), ["https://watch.vapor.fm"]);
	assert.deepStrictEqual(await q("coding"), ["https://loud.example"]);
	assert.deepStrictEqual(await q("grown-ups"), [], "not the NSFW one");
	assert.deepStrictEqual(await q("vapor zzz"), []);
	const all = await t.call("searchAll", { query: "funk" });
	assert.deepStrictEqual(all.results.map((r) => [r.sourceId, r.items.map((i) => i.id)]), [["acc-dir", ["https://watch.vapor.fm"]]]);
	assert.deepStrictEqual(all.failed, []);
	t.stop();
});

test("directory resolve: only a server listed live, and only once it says it is on", async () => {
	const t = start();
	const r = await t.call("resolve", { sourceId: "acc-dir", itemId: "https://watch.vapor.fm" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual([r.stream.url, r.stream.protocol, r.stream.drm], ["https://watch.vapor.fm/hls/stream.m3u8", "hls", null]);
	const off = await t.call("resolve", { sourceId: "acc-dir", itemId: "https://owncast.meowcate.space" });
	assert.deepStrictEqual([off.errorCode, off.errorText], ["NOT_FOUND", "Le Meowncast is not live right now."]);
	for (const id of ["https://evil.example", "https://nsfw.example", "https://asleep.example", "javascript:alert(1)"]) {
		const x = await t.call("resolve", { sourceId: "acc-dir", itemId: id });
		assert.deepStrictEqual([x.errorCode, x.errorText], ["NOT_FOUND", "That stream is no longer live in the Owncast Directory."], id);
	}
	assert.deepStrictEqual(t.requests.map((q) => new URL(q.url).host).sort(),
		["directory.owncast.online", "owncast.meowcate.space", "watch.vapor.fm"], "no other server is asked");
	t.stop();
});

test("the directory down is unreachable; a reply that is no directory is empty", async () => {
	const t = start({ rts: routes({ home: () => { throw new Error("refused"); } }) });
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-dir" })).errorCode, "SERVER_UNREACHABLE");
	t.stop();
	const odd = start({ rts: routes({ home: () => ({ body: { sections: [{ name: "Else", instances: [entry({})] }, null] } }) }) });
	assert.deepStrictEqual((await odd.call("listItems", { sourceId: "acc-dir", sectionId: "all" })).items, []);
	odd.stop();
	const named = start({ rts: routes({ home: () => ({ body: { sections: [{ name: "What's Streaming Now", instances: [entry({ url: "https://y.example" })] }] } }) }) });
	assert.deepStrictEqual((await named.call("listItems", { sourceId: "acc-dir", sectionId: "all" })).items.map((i) => i.id), ["https://y.example"],
		"the live section by its name when it has no online flag");
	named.stop();
});
