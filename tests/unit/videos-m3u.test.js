"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../video/_core/service/org.webosports.service.videos");
const service = require(SVC);
const m3u = require("../../video/m3u/provider");
const upnpLib = require("../../video/upnp/provider");

const VIDEOS = { appId: "org.webosports.app.videoplayer 1234" };
const AUTH = { appId: "org.webosports.app.videoauth 999" };

// An IPTV service's list: its user name and password in the query (get.php) and in the stream
// paths, as Xtream-style services hand them out.
const SECRET = "hunter2-not-a-real-password";
const LIST_URL = "http://iptv.example:8080/get.php?username=bob&password=" + SECRET + "&type=m3u_plus";
const PATH_URL = "https://tv.example/bob/" + SECRET + "/playlist.m3u";

const PLAYLIST = [
	"﻿#EXTM3U x-tvg-url=\"https://tv.example/epg.xml\"",
	"#EXTINF:-1 tvg-id=\"one.uk\" tvg-name=\"One HD\" tvg-logo=\"https://tv.example/logos/one.png\" group-title=\"News\",Channel One",
	"#EXTVLCOPT:http-user-agent=Mozilla",
	"http://iptv.example:8080/live/bob/" + SECRET + "/1.m3u8",
	"",
	"#EXTINF:-1 tvg-logo=\"not a link\" group-title=\"Sport\",Sport, \"Extra\" Live",
	"http://iptv.example:8080/live/bob/" + SECRET + "/2.ts",
	"#EXTINF:0,Radio Café",
	"#EXTGRP:Radio",
	"stream/radio.mp3",
	"#EXTINF:5400 group-title=\"Films\",A Film",
	"https://vod.example/film.mp4?sig=abc",
	"#EXTINF:-1 group-title=\"News\",Unplayable",
	"rtmp://old.example/live/x",
	"#EXTINF:-1 group-title=\"News\",Channel One",
	"http://iptv.example:8080/live/bob/" + SECRET + "/1.m3u8",
	"#EXTINF:-1 group-title=\"News\",Dash News",
	"https://dash.example/news/manifest.mpd",
	"http://plain.example/no-info/Some%20Show.ts",
	"#EXTINF:-1 group-title=\"Sport\" tvg-name=\"Bare\",",
	"https://iptv.example/bare.m3u8",
].join("\r\n");

const ACCOUNTS = [
	{ _id: "acc-m3", templateId: "org.webosports.video.m3u", username: "iptv.example:8080 · get.php", alias: "M3U – iptv.example:8080 · get.php",
		icon: { loc_48x48: "/usr/palm/public/accounts/org.webosports.video.m3u/images/m3u-48x48.png" } },
	{ _id: "acc-m4", templateId: "org.webosports.video.m3u", username: "flat.example · flat.m3u", alias: "Flat" },
];
const CREDS = {
	"acc-m3": { url: LIST_URL, name: "" },
	"acc-m4": { url: "https://flat.example/flat.m3u", name: "Flat" },
};

function routes(over = {}) {
	return [
		["GET", /^http:\/\/iptv\.example:8080\/get\.php\?/, () => over.list ? over.list() : ({ body: PLAYLIST, headers: { "Content-Type": "audio/x-mpegurl" } })],
		["GET", /^https:\/\/tv\.example\/bob\//, () => over.path ? over.path() : ({ body: PLAYLIST })],
		["GET", /^https:\/\/flat\.example\/flat\.m3u$/, () => ({ body: "#EXTM3U\n#EXTINF:-1,Only One\nhttps://flat.example/one.m3u8\n" })],
		["GET", /^https:\/\/page\.example\//, () => ({ body: "<!DOCTYPE html><html>log in</html>" })],
		["GET", /^https:\/\/empty\.example\//, () => ({ body: "#EXTM3U\n# nothing here\n" })],
		["GET", /^https:\/\/old\.example\//, () => ({ body: "#EXTM3U\n#EXTINF:-1,X\nrtmp://old.example/x\nudp://@239.0.0.1:1234\n" })],
		["GET", /^https:\/\/gone\.example\//, () => { throw new Error("refused"); }],
		["GET", /^https:\/\/missing\.example\//, () => ({ status: 404, body: "no" })],
		["GET", /^https:\/\/locked\.example\//, () => ({ status: 403, body: "expired" })],
		["GET", /^https:\/\/broken\.example\//, () => ({ status: 502, body: "bad" })],
	];
}

function start({ rts = routes(), accounts = ACCOUNTS, creds = CREDS, logs = [] } = {}) {
	m3u._test.reset();
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

const T = m3u._test;

test("parse: names, groups, logos, lengths; only http(s) links; duplicates once; relative links resolved", () => {
	const { entries, skipped, cut } = T.parse(PLAYLIST, "https://tv.example/lists/main.m3u");
	assert.strictEqual(cut, false);
	assert.strictEqual(skipped, 1, "the rtmp link");
	assert.deepStrictEqual(entries.map((e) => [e.title, e.group, e.durationMs]), [
		["Channel One", "News", 0],
		["Sport, \"Extra\" Live", "Sport", 0],
		["Radio Café", "Radio", 0],
		["A Film", "Films", 5400000],
		["Dash News", "News", 0],
		["Some Show", null, 0],
		["Bare", "Sport", 0],
	]);
	assert.strictEqual(entries[0].logo, "https://tv.example/logos/one.png");
	assert.strictEqual(entries[1].logo, undefined, "a logo that is no link is dropped");
	assert.strictEqual(entries[2].url, "https://tv.example/lists/stream/radio.mp3");
	assert.strictEqual(new Set(entries.map((e) => e.id)).size, entries.length);
	assert.match(entries[0].id, /^[0-9a-f]{20}$/);
	assert.ok(!entries.some((e) => e.id.includes(SECRET)));
	// The same list read again gives the same ids: they are what Videos remembers.
	assert.deepStrictEqual(T.parse(PLAYLIST, "https://tv.example/lists/main.m3u").entries.map((e) => e.id), entries.map((e) => e.id));
});

test("a list past the size limit is refused; past the entry limit it is cut", async (c) => {
	const keep = Object.assign({}, T.LIMITS);
	c.after(() => Object.assign(T.LIMITS, keep));
	const cut = T.parse(PLAYLIST, "https://tv.example/");
	T.LIMITS.entries = 2;
	const two = T.parse(PLAYLIST, "https://tv.example/");
	assert.deepStrictEqual([two.entries.length, two.cut, cut.cut], [2, true, false]);
	T.LIMITS.chars = PLAYLIST.length - 1;
	const t = start();
	const r = await t.call("login", { templateId: "org.webosports.video.m3u", url: LIST_URL }, AUTH);
	assert.deepStrictEqual([r.errorCode, r.errorText], ["BAD_ARGS", "That playlist is too big for this device."]);
	t.stop();
});

test("parse: a list without #EXTM3U, Mac line ends, an entry with no #EXTINF", () => {
	const { entries } = T.parse("http://a.example/x.m3u8\r#EXTINF:12.5,Short\rhttp://a.example/y.mp4\r", "http://a.example/");
	assert.deepStrictEqual(entries.map((e) => [e.title, e.durationMs]), [["x", 0], ["Short", 12500]]);
});

test("parseExtinf: quotes keep commas, unquoted values, attribute names in any case", () => {
	assert.deepStrictEqual(T.parseExtinf("#EXTINF:-1 tvg-ID=one Group-Title=\"A, B\",Name, with comma"),
		{ duration: -1, attrs: { "tvg-id": "one", "group-title": "A, B" }, title: "Name, with comma" });
	assert.deepStrictEqual(T.parseExtinf("#EXTINF:abc"), { duration: -1, attrs: {}, title: "" });
});

test("playlist addresses and the account's name leave the secret parts out", () => {
	assert.strictEqual(T.playlistUrlOf("iptv.example/list.m3u").href, "http://iptv.example/list.m3u");
	assert.strictEqual(T.playlistUrlOf(" https://x.example/a.m3u#frag ").href, "https://x.example/a.m3u");
	for (const bad of ["", "  ", "ftp://x.example/a.m3u", "file:///media/internal/a.m3u", "http://"]) {
		assert.strictEqual(T.playlistUrlOf(bad), null, bad);
	}
	assert.strictEqual(T.nameOf(T.playlistUrlOf(LIST_URL)), "iptv.example:8080 · get.php");
	assert.strictEqual(T.nameOf(T.playlistUrlOf(PATH_URL)), "tv.example · playlist.m3u");
	assert.strictEqual(T.nameOf(T.playlistUrlOf("https://x.example/My%20List.m3u")), "x.example · My List.m3u");
	assert.strictEqual(T.nameOf(T.playlistUrlOf("https://x.example/100%.m3u")), "x.example · 100%.m3u");
	assert.strictEqual(T.nameOf(T.playlistUrlOf("https://x.example/")), "x.example");
});

test("protocols by the link's path, not its query", () => {
	assert.strictEqual(T.protocolOf("https://a.example/x/index.M3U8?token=1"), "hls");
	assert.strictEqual(T.protocolOf("https://a.example/manifest.mpd"), "dash");
	assert.strictEqual(T.protocolOf("https://a.example/1.ts?x=.m3u8"), "progressive");
});

test("search folds case and accents, every word must match, name or group", () => {
	assert.strictEqual(T.fold("Café ÉTÉ"), "cafe ete");
});

test("login: reads the list and keeps its address as a credential, never in the name", async () => {
	const t = start();
	const r = await t.call("login", { templateId: "org.webosports.video.m3u", url: " " + LIST_URL + " " }, AUTH);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.username, "iptv.example:8080 · get.php");
	assert.strictEqual(r.alias, "M3U – iptv.example:8080 · get.php");
	assert.deepStrictEqual(r.credentials, { common: { url: LIST_URL, name: "" } });
	assert.ok(!(r.username + r.alias).includes(SECRET));
	const named = await t.call("login", { templateId: "org.webosports.video.m3u", url: PATH_URL, name: "  My TV " }, AUTH);
	assert.strictEqual(named.alias, "My TV");
	assert.strictEqual(named.username, "tv.example · playlist.m3u");
	t.stop();
});

test("login refusals say why, and never the address", async () => {
	const t = start();
	const cases = {
		"": ["MISSING_ARGS", /Enter the playlist/],
		"ftp://x.example/a.m3u": ["MISSING_ARGS", /Enter the playlist/],
		["https://bob:" + SECRET + "@tv.example/a.m3u"]: ["BAD_ARGS", /not before the host/],
		"https://page.example/a.m3u": ["BAD_ARGS", /web page/],
		"https://empty.example/a.m3u": ["BAD_ARGS", /no streams/],
		"https://old.example/a.m3u": ["BAD_ARGS", /no web streams/],
		["https://gone.example/" + SECRET + "/a.m3u"]: ["SERVER_UNREACHABLE", /does not answer/],
		["https://missing.example/" + SECRET + "/a.m3u"]: ["NOT_FOUND", /no playlist/],
		["https://locked.example/" + SECRET + "/a.m3u"]: ["AUTH_EXPIRED", /refused it \(403\)/],
		["https://broken.example/" + SECRET + "/a.m3u"]: ["SERVER_ERROR", /error \(502\)/],
	};
	for (const [url, [code, text]] of Object.entries(cases)) {
		const r = await t.call("login", { templateId: "org.webosports.video.m3u", url }, AUTH);
		assert.strictEqual(r.returnValue, false, url);
		assert.strictEqual(r.errorCode, code, url + " " + r.errorText);
		assert.match(r.errorText, text, url);
		assert.ok(!JSON.stringify(r).includes(SECRET), url + ": " + JSON.stringify(r));
	}
	assert.ok(!t.logs.join("\n").includes(SECRET), t.logs.join("\n"));
	t.stop();
});

test("sections: All Channels, then each group in the list's order; a list without groups is one", async () => {
	const t = start();
	const r = await t.call("listSections", { sourceId: "acc-m3" });
	assert.deepStrictEqual(r.sections.map((s) => [s.id, s.title, s.layout]), [
		["all", "All Channels", "grid"], ["g:News", "News", "grid"], ["g:Sport", "Sport", "grid"],
		["g:Radio", "Radio", "grid"], ["g:Films", "Films", "grid"]]);
	const flat = await t.call("listSections", { sourceId: "acc-m4" });
	assert.deepStrictEqual(flat.sections.map((s) => [s.id, s.title]), [["all", "Channels"]]);
	assert.strictEqual(t.requests.filter((q) => q.url.startsWith("http://iptv.example:8080/get.php")).length, 1);
	t.stop();
});

test("a list with one group has no section for it, only All Channels", async () => {
	const t = start({ rts: routes({ list: () => ({ body: "#EXTM3U\n#EXTINF:-1 group-title=\"News\",A\nhttps://a.example/a.m3u8\n" }) }) });
	const r = await t.call("listSections", { sourceId: "acc-m3" });
	assert.deepStrictEqual(r.sections.map((s) => s.id), ["all"]);
	t.stop();
});

test("items: channels are live, a film has its length; groups filter; paging", async () => {
	const t = start();
	const all = await t.call("listItems", { sourceId: "acc-m3", sectionId: "all", limit: 3 });
	assert.deepStrictEqual(all.items.map((i) => [i.kind, i.title, i.subtitle]), [
		["live", "Channel One", "News"], ["live", "Sport, \"Extra\" Live", "Sport"], ["live", "Radio Café", "Radio"]]);
	assert.deepStrictEqual(all.items[0].artwork, { thumb: "https://tv.example/logos/one.png", poster: "https://tv.example/logos/one.png" });
	assert.deepStrictEqual(all.items[1].artwork, {});
	assert.strictEqual(all.items[0].playable, true);
	assert.strictEqual(all.items[0].hasChildren, false);
	assert.strictEqual(all.nextCursor, "3");
	const rest = await t.call("listItems", { sourceId: "acc-m3", sectionId: "all", cursor: all.nextCursor, limit: 10 });
	assert.deepStrictEqual(rest.items.map((i) => i.title), ["A Film", "Dash News", "Some Show", "Bare"]);
	assert.strictEqual(rest.nextCursor, null);
	const last = await t.call("listItems", { sourceId: "acc-m3", sectionId: "all", cursor: "3", limit: 4 });
	assert.deepStrictEqual([last.items.length, last.nextCursor], [4, null], "a page that ends at the list's end is the last");
	assert.deepStrictEqual([rest.items[0].kind, rest.items[0].durationMs], ["video", 5400000]);
	const news = await t.call("listItems", { sourceId: "acc-m3", sectionId: "g:News", limit: 10 });
	assert.deepStrictEqual(news.items.map((i) => i.title), ["Channel One", "Dash News"]);
	assert.strictEqual((await t.call("listItems", { sourceId: "acc-m3", sectionId: "nope", limit: 10 })).errorCode, "NOT_FOUND");
	assert.ok(!JSON.stringify([all, rest, news]).includes(SECRET), "no stream link in the catalogue");
	t.stop();
});

test("search: every word, name or group, case and accents aside", async () => {
	const t = start();
	const q = async (query) => (await t.call("search", { sourceId: "acc-m3", query })).items.map((i) => i.title);
	assert.deepStrictEqual(await q("cafe"), ["Radio Café"]);
	assert.deepStrictEqual(await q("NEWS one"), ["Channel One"]);
	assert.deepStrictEqual(await q("sport"), ["Sport, \"Extra\" Live", "Bare"]);
	assert.deepStrictEqual(await q("zzz"), []);
	t.stop();
});

test("resolve: the entry's link with its protocol; getItem; an entry gone from the list", async () => {
	const t = start();
	const items = (await t.call("listItems", { sourceId: "acc-m3", sectionId: "all", limit: 10 })).items;
	const byTitle = (s) => items.find((i) => i.title === s).id;
	const one = await t.call("resolve", { sourceId: "acc-m3", itemId: byTitle("Channel One") });
	assert.strictEqual(one.returnValue, true);
	assert.deepStrictEqual([one.stream.url, one.stream.protocol], ["http://iptv.example:8080/live/bob/" + SECRET + "/1.m3u8", "hls"]);
	assert.deepStrictEqual(one.stream.subtitles, []);
	assert.strictEqual((await t.call("resolve", { sourceId: "acc-m3", itemId: byTitle("Dash News") })).stream.protocol, "dash");
	assert.strictEqual((await t.call("resolve", { sourceId: "acc-m3", itemId: byTitle("Sport, \"Extra\" Live") })).stream.protocol, "progressive");
	const got = await t.call("getItem", { sourceId: "acc-m3", itemId: byTitle("A Film") });
	assert.strictEqual(got.item.title, "A Film");
	const gone = await t.call("resolve", { sourceId: "acc-m3", itemId: "0000" });
	assert.strictEqual(gone.errorCode, "NOT_FOUND");
	assert.strictEqual((await t.call("getItem", { sourceId: "acc-m3", itemId: "0000" })).returnValue, false);
	t.stop();
});

test("the list is fetched once while it is fresh, per account", async () => {
	const t = start();
	await t.call("listSections", { sourceId: "acc-m3" });
	await t.call("listItems", { sourceId: "acc-m3", sectionId: "all", limit: 5 });
	await t.call("search", { sourceId: "acc-m3", query: "one" });
	await t.call("listSections", { sourceId: "acc-m4" });
	assert.strictEqual(t.requests.filter((q) => q.url.includes("get.php")).length, 1);
	assert.strictEqual(t.requests.filter((q) => q.url.includes("flat.example")).length, 1);
	await t.call("listSections", { sourceId: "acc-m3" });
	assert.strictEqual(t.requests.filter((q) => q.url.includes("get.php")).length, 1, "each account keeps its own list");
	t.stop();
});

test("a list that fails later says so without its address", async () => {
	const t = start({ creds: { "acc-m3": { url: "https://locked.example/" + SECRET + "/a.m3u", name: "" } } });
	const r = await t.call("listSections", { sourceId: "acc-m3" });
	assert.strictEqual(r.errorCode, "AUTH_EXPIRED");
	assert.ok(!JSON.stringify(r).includes(SECRET));
	const none = start({ creds: { "acc-m3": { name: "" } } });
	assert.strictEqual((await none.call("listSections", { sourceId: "acc-m3" })).errorCode, "AUTH_EXPIRED");
	assert.ok(!t.logs.concat(none.logs).join("\n").includes(SECRET));
	t.stop();
	none.stop();
});

test("listSources shows the playlist with live and search, and no progress", async () => {
	const t = start();
	const r = await t.call("listSources", {});
	const s = r.sources.find((x) => x.sourceId === "acc-m3");
	assert.deepStrictEqual(s.features, { search: true, progress: false, continueWatching: false, live: true });
	assert.strictEqual(s.provider, "m3u");
	assert.strictEqual(s.label, "iptv.example:8080 · get.php");
	assert.strictEqual(r.sources.find((x) => x.sourceId === "acc-m4").label, "Flat");
	assert.match(s.icon, /m3u-48x48\.png$/);
	t.stop();
});

// --- Free TV and the lists of others ----------------------------------------------------------

const FTV_NL = "#EXTM3U\n#EXTINF:-1 tvg-name=\"NPO 1\" group-title=\"Netherlands\",NPO 1\nhttps://ftv.example/npo1.m3u8\n" +
	"#EXTINF:-1 group-title=\"Netherlands\",NPO News Ⓨ\nhttps://www.youtube.com/watch?v=abc\n" +
	"#EXTINF:-1 group-title=\"Netherlands\",Short Ⓨ\nhttps://youtu.be/abc\n";
const ftvRoutes = (seen) => routes().concat([
	["GET", /^https:\/\/raw\.githubusercontent\.com\/Free-TV\/IPTV\/master\/playlists\/playlist_netherlands\.m3u8$/, () => { seen.push("nl"); return { body: FTV_NL }; }],
	["GET", /^https:\/\/raw\.githubusercontent\.com\/Free-TV\/IPTV\/master\/playlist\.m3u8$/, () => { seen.push("all"); return { body: FTV_NL }; }],
	["GET", /^https:\/\/raw\.githubusercontent\.com\/Free-TV\/IPTV\/master\/playlists\/playlist_greece\.m3u8$/, () => ({ body: "#EXTM3U\n#EXTINF:-1,Y\nhttps://www.youtube.com/watch?v=x\n" })],
]);

test("YouTube pages are left out; several groups in one (iptv-org's \"A;B\") are each a group", () => {
	const { entries, skipped } = T.parse(FTV_NL + "#EXTINF:-1 group-title=\"Kids;Entertainment; Kids\",Both\nhttps://a.example/b.m3u8\n" +
		"#EXTINF:-1,Nocookie\nhttps://www.youtube-nocookie.com/embed/x\n", "https://ftv.example/");
	assert.deepStrictEqual(entries.map((e) => [e.title, e.groups]), [["NPO 1", ["Netherlands"]], ["Both", ["Kids", "Entertainment"]]]);
	assert.strictEqual(entries[1].group, "Kids");
	assert.strictEqual(skipped, 3);
	assert.deepStrictEqual(T.groupsOf(entries), ["Netherlands", "Kids", "Entertainment"]);
	assert.deepStrictEqual(T.parse("#EXTINF:-1 group-title=\";\",X\nhttps://a.example/x\n", "https://a.example/").entries[0].groups, []);
});

test("a channel in two groups is in both sections and found by either", async () => {
	const list = "#EXTM3U\n#EXTINF:-1 group-title=\"Kids;Music\",Sing\nhttps://a.example/s.m3u8\n#EXTINF:-1 group-title=\"News\",Late\nhttps://a.example/n.m3u8\n";
	const t = start({ rts: routes({ list: () => ({ body: list }) }) });
	const sections = (await t.call("listSections", { sourceId: "acc-m3" })).sections.map((s) => s.id);
	assert.deepStrictEqual(sections, ["all", "g:Kids", "g:Music", "g:News"]);
	for (const g of ["g:Kids", "g:Music"]) {
		assert.deepStrictEqual((await t.call("listItems", { sourceId: "acc-m3", sectionId: g, limit: 9 })).items.map((i) => i.title), ["Sing"], g);
	}
	assert.deepStrictEqual((await t.call("search", { sourceId: "acc-m3", query: "music" })).items.map((i) => i.title), ["Sing"]);
	t.stop();
});

test("m3uCatalogs: Free TV's countries by name, the topics, then all; anyone may ask", async () => {
	const t = start();
	const r = await t.call("m3uCatalogs", {}, { appId: "com.example.other 1" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	const c = r.catalogs;
	assert.strictEqual(c.length, T.FREE_TV.length + 1);
	const countries = c.filter((x) => x.region);
	const names = countries.map((x) => x.name);
	assert.deepStrictEqual(names, names.slice().sort((a, b) => a.localeCompare(b, "en")));
	assert.deepStrictEqual(c.slice(0, countries.length), countries, "countries first");
	assert.deepStrictEqual(c[c.length - 1], { id: "freetv:all", name: "All countries", region: "", topic: false });
	assert.ok(c.filter((x) => x.topic).length >= 5);
	assert.deepStrictEqual(c.find((x) => x.region === "NL"), { id: "freetv:netherlands", name: "Netherlands", region: "NL", topic: false });
	assert.strictEqual(c.find((x) => x.region === "GB").name, "United Kingdom");
	assert.strictEqual(new Set(c.map((x) => x.region).filter(Boolean)).size, countries.length, "one list per region");
	for (const x of c) {
		assert.ok(/^([A-Z]{2})?$/.test(x.region), x.id);
		assert.ok(T.catalogOf(x.id), x.id);
	}
	assert.deepStrictEqual(r.source, { name: "Free-TV", link: "https://github.com/Free-TV/IPTV" });
	t.stop();
});

test("login with a Free TV list: its address from the table, named by the country", async () => {
	const seen = [];
	const t = start({ rts: ftvRoutes(seen) });
	const r = await t.call("login", { templateId: "org.webosports.video.m3u", catalog: "freetv:netherlands" }, AUTH);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual([r.username, r.alias], ["Free TV · Netherlands", "Free TV – Netherlands"]);
	assert.deepStrictEqual(r.credentials, { common: { url: "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_netherlands.m3u8",
		name: "", catalog: "freetv:netherlands" } });
	const all = await t.call("login", { templateId: "org.webosports.video.m3u", catalog: "freetv:all", name: "Everything" }, AUTH);
	assert.deepStrictEqual([all.alias, all.credentials.common.url, all.credentials.common.name],
		["Everything", "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8", "Everything"]);
	assert.deepStrictEqual(seen, ["nl", "all"]);
	for (const bad of ["freetv:atlantis", "freetv:../../etc", "https://evil.example/x.m3u", "", "freetv:"]) {
		const n = t.requests.length;
		const b = await t.call("login", { templateId: "org.webosports.video.m3u", catalog: bad, url: "https://flat.example/flat.m3u" }, AUTH);
		assert.deepStrictEqual([b.returnValue, b.errorCode], [false, "BAD_ARGS"], bad);
		assert.strictEqual(t.requests.length, n, bad + ": nothing fetched");
	}
	const yt = await t.call("login", { templateId: "org.webosports.video.m3u", catalog: "freetv:greece" }, AUTH);
	assert.deepStrictEqual([yt.errorCode, yt.errorText], ["BAD_ARGS", "The playlist has no web streams that Videos can play."]);
	t.stop();
});

test("a Free TV account browses as any list, without the YouTube links", async () => {
	const t = start({ rts: ftvRoutes([]), accounts: [{ _id: "acc-ft", templateId: "org.webosports.video.m3u", username: "Free TV · Netherlands", alias: "Free TV – Netherlands" }],
		creds: { "acc-ft": { url: "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_netherlands.m3u8", name: "", catalog: "freetv:netherlands" } } });
	const s = (await t.call("listSources", {})).sources[0];
	assert.deepStrictEqual([s.name, s.label, s.provider], ["Free TV – Netherlands", "Free TV – Netherlands", "m3u"]);
	assert.deepStrictEqual((await t.call("listSections", { sourceId: "acc-ft" })).sections.map((x) => x.title), ["All Channels"]);
	const items = (await t.call("listItems", { sourceId: "acc-ft", sectionId: "all", limit: 9 })).items;
	assert.deepStrictEqual(items.map((i) => [i.kind, i.title]), [["live", "NPO 1"]]);
	t.stop();
});
