"use strict";

// node --test tests/unit
// The Mediathek provider (video/mediathek/provider) through the service, against a stand-in for
// MediathekViewWeb's /api/query, /api/entries and /api/channels. The entries are made up for the
// tests; their link shapes are those mediathekviewweb.de gave on 2026-11-04.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../video/_core/service/org.webosports.service.videos");
const service = require(SVC);
const mediathek = require("../../video/mediathek/provider");
const upnpLib = require("../../video/upnp/provider");

const VIDEOS = { appId: "org.webosports.app.videoplayer 1234" };
const AUTH = { appId: "org.webosports.app.videoauth 999" };
const T = mediathek._test;

const ARD_SUB = "https://api.ardmediathek.de/player-service/subtitle/ebutt/urn:ard:subtitle:0123456789abcdef";
const ctv = (where, name) => ["640x360-50p-1200kbit", "1280x720-50p-3200kbit", "1920x1080-50p-5000kbit"]
	.map((q) => "https://ctv-videos.daserste.de/" + where + "/2026/11/04/" + name + "/" + name + "_sendeton_" + q + ".mp4");
const zdf = (where, ch, name) => ["808k_p11v17", "3360k_p36v17", "6660k_p37v17"]
	.map((q) => "https://nrodlzdf-a.akamaihd.net/" + where + "/" + ch + "/26/11/" + name + "/1/" + name + "_" + q + ".mp4");
const wdr = (where, id) => ["360", "720", "1080"].map((q) => "https://wdr-progressive.ard-mcdn.de/media/p/public/" + where + "/2026/10/28/" + id + "/" + id + "_AVC-" + q + ".mp4");

function E(id, channel, topic, title, ts, duration, urls, more) {
	return Object.assign({ id, channel, topic, title, description: "About " + title, timestamp: ts, duration, size: 1000,
		url_website: "https://www.example-broadcaster.test/" + id, url_subtitle: "",
		url_video_low: urls[0], url_video: urls[1], url_video_hd: urls[2], filmlisteTimestamp: 1793800000 }, more || {});
}

const ENTRIES = [
	E("ard-1", "ARD", "Tatort", "Der Fall", 1793900000, 5400, ctv("int", "ARDSM1"), { url_subtitle: ARD_SUB }),
	E("alpha-1", "ARD-alpha", "alpha-retro", "Damals", 1793890000, 1800, ctv("int", "ALPHA1")),
	E("ard-geo", "ARD", "Brisant", "Nur hier", 1793880000, 2400, ctv("de", "ARDSM2")),
	E("zdf-1", "ZDF", "auslandsjournal", "Teurer leben in New York", 1793870000, 407, zdf("none", "zdf", "261028_ajo")),
	E("3sat-geo", "3Sat", "nano", "nano vom 4. November", 1793860000, 1800, zdf("dach", "3sat", "261104_nano")),
	E("wdr-1", "WDR", "Lokalzeit", "Lokalzeit", 1793850000, 1500, wdr("weltweit", "aaaa"), { url_subtitle: "https://subs.example.test/wdr/aaaa.vtt" }),
	E("orf-1", "ORF", "ZIB", "ZIB 1", 1793840000, 1200, ["620000", "4165000", "6100000"].map((b) =>
		"https://apasfiis.sf.apa.at/ipad/cms-austria/2026/11/04/zib_QXA.mp4/chunklist_b" + b + ".m3u8"),
	{ url_subtitle: "https://api-tvthek.orf.at/assets/subtitles/0194/89/abc.ttml" }),
	E("rb-1", "rbtv", "buten un binnen", "Regionalmagazin", 1793830000, 1700, ["", "https://rb.example.test/rb1.mp4", ""]),
	E("rb-2", "Radio Bremen TV", "buten un binnen", "Spätausgabe", 1793820000, 900, ["", "https://rb.example.test/rb2.mp4", ""]),
	E("other-1", "Some Other TV", "Show", "Not a public broadcaster here", 1793810000, 600, ["", "https://other.example.test/x.mp4", ""]),
	E("nolink-1", "ARD", "Tatort", "No link", 1793800000, 600, ["", "rtmp://old.example.test/x", ""]),
	E("arte-1", "ARTE.DE", "Kino", "Ein Film", 1793790000, 6000,
		["", "https://manifest-arte.akamaized.net/api/manifest/v1/Generate/uuid/de/XQ+KS+CHEV1/120361-000-A.m3u8", ""]),
	E("same-1", "NDR", "Panorama", "Panorama", 1793780000, 1800, ["https://ndr-progressive.ard-mcdn.de/progressive/2026/1101/TV-1.ln.mp4",
		"https://ndr-progressive.ard-mcdn.de/progressive/2026/1101/TV-1.hd.mp4", "https://ndr-progressive.ard-mcdn.de/progressive/2026/1101/TV-1.1080.mp4"]),
	E("sr-1", "SR", "Livestream: Saarlandpokal", "Ein altes Spiel", 1507672800, 8862, ["", "http://media.example.test/sr.mp4", ""]),
	E("live-zdf", "ZDF", "Livestream", "ZDF Livestream", 0, 0, ["", "http://zdf-hls-15.akamaized.net/hls/live/2016498/de/high/master.m3u8", ""]),
	E("live-3sat", "3Sat", "Livestream", "3Sat Livestream", 0, 0, ["", "https://zdf-hls-18.akamaized.net/hls/live/2016501/dach/high/master.m3u8", ""]),
	E("live-ard", "ARD", "Livestream", "ARD Livestream", 0, 0, ["", "https://daserste-live.ard-mcdn.de/daserste/live/hls/de/master.m3u8", ""]),
	E("live-alpha", "ARD", "Livestream", "ARD Alpha Livestream", 0, 0, ["", "https://mcdn.br.de/br/fs/ard_alpha/hls/de/master.m3u8", ""]),
];

// A field matches a query as OpenSearch's words do: every word of the query is a word of the field
// ("ard" is a word of "ARD-alpha"; "zdf" is not one of "ZDFneo").
const words = (s) => String(s).toLowerCase().split(/[^a-z0-9.äöüß]+/).filter(Boolean);
function matches(e, q) {
	const have = q.fields.flatMap((f) => words(e[f]));
	return words(q.query).every((w) => have.includes(w));
}

// MediathekViewWeb's /api/query, as server/SearchEngine.ts answers: queries on the same fields are
// either-or, on different fields all of them; sorted newest first; offset and size.
function mvw(over = {}) {
	return (req) => {
		if (over.query) { const r = over.query(req); if (r) { return r; } }
		const q = JSON.parse(req.body);
		const groups = new Map();
		for (const x of q.queries || []) {
			const k = x.fields.slice().sort().join(",");
			groups.set(k, (groups.get(k) || []).concat([x]));
		}
		let list = ENTRIES.filter((e) => Array.from(groups.values()).every((g) => g.some((x) => matches(e, x))));
		if (q.sortBy === "timestamp") { list = list.slice().sort((a, b) => b.timestamp - a.timestamp); }
		const out = list.slice(q.offset || 0, (q.offset || 0) + (q.size || 15));
		return { body: { result: { results: out.map((e) => Object.assign({}, e)), queryInfo: { totalResults: list.length } }, err: null } };
	};
}

function routes(over = {}) {
	return [
		["POST", /^https:\/\/mediathekviewweb\.de\/api\/query$/, mvw(over)],
		["POST", /^https:\/\/mediathekviewweb\.de\/api\/entries$/, (req) => {
			if (over.entries) { return over.entries(req); }
			const ids = JSON.parse(req.body);
			// /api/entries answers the entries' fields without their id.
			const found = ENTRIES.filter((e) => ids.includes(e.id)).map((e) => { const c = Object.assign({}, e); delete c.id; return c; });
			return { body: { result: { results: found }, err: null } };
		}],
		["GET", /^https:\/\/mediathekviewweb\.de\/api\/channels$/, () => (over.channels ? over.channels() : { body: { error: null, channels: ["ARD", "ZDF"] } })],
	];
}

const ACCOUNTS = [{ _id: "acc-mt", templateId: "org.webosports.video.mediathek", username: "mediathekviewweb.de", alias: "Mediathek",
	icon: { loc_48x48: "/usr/palm/public/accounts/org.webosports.video.mediathek/images/mediathek-48x48.png" } }];

function start({ rts = routes(), logs = [] } = {}) {
	T.reset();
	upnpLib._test.dir._set([]);
	const pb = fakePalmbus({ onCall: (uri, args) => {
		if (uri.endsWith("/listAccounts")) { return { returnValue: true, results: ACCOUNTS }; }
		if (uri.endsWith("/readCredentials")) {
			return args.accountId === "acc-mt" ? { returnValue: true, credentials: { common: { service: "mediathekviewweb" } } } : { returnValue: false };
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

const queries = (t) => t.requests.filter((r) => r.url.endsWith("/api/query"));
const ids = (r) => r.items.map((i) => i.id);

test("login asks the film list once and needs nothing typed; a list that is down says so", async () => {
	const t = start();
	const r = await t.call("login", { templateId: "org.webosports.video.mediathek" }, AUTH);
	assert.deepStrictEqual([r.returnValue, r.username, r.alias, r.credentials], [true, "mediathekviewweb.de", "Mediathek",
		{ common: { service: "mediathekviewweb" } }]);
	assert.strictEqual(t.requests.length, 1);
	assert.strictEqual(t.requests[0].headers["User-Agent"], "LuneOS-Videos/1.0");
	t.stop();
	for (const channels of [() => ({ status: 503, body: "indexing" }), () => ({ body: { error: "x", channels: null } }), () => ({ body: {} })]) {
		const d = start({ rts: routes({ channels }) });
		const e = await d.call("login", { templateId: "org.webosports.video.mediathek" }, AUTH);
		assert.strictEqual(e.errorCode, "SERVER_ERROR", JSON.stringify(e));
		d.stop();
	}
	const gone = start({ rts: routes({ channels: () => { throw new Error("refused"); } }) });
	assert.strictEqual((await gone.call("login", { templateId: "org.webosports.video.mediathek" }, AUTH)).errorCode, "SERVER_UNREACHABLE");
	gone.stop();
});

test("listSources: search and live, no progress; the account's own icon", async () => {
	const t = start();
	const r = await t.call("listSources", {});
	const s = r.sources.find((x) => x.sourceId === "acc-mt");
	assert.deepStrictEqual(s.features, { search: true, progress: false, continueWatching: false, live: true });
	assert.deepStrictEqual([s.provider, s.name, s.label], ["mediathek", "Mediathek", "Mediathek"]);
	assert.match(s.icon, /mediathek-48x48\.png$/);
	t.stop();
});

test("sections: New and Live TV first, then a section per channel; no request needed", async () => {
	const t = start();
	const r = await t.call("listSections", { sourceId: "acc-mt" });
	assert.deepStrictEqual(r.sections.slice(0, 6), [
		{ id: "new", title: "New", layout: "row" }, { id: "live", title: "Live TV", layout: "row" },
		{ id: "ch:ard", title: "ARD", layout: "grid" }, { id: "ch:zdf", title: "ZDF", layout: "grid" },
		{ id: "ch:arte", title: "Arte", layout: "grid" }, { id: "ch:3sat", title: "3sat", layout: "grid" }]);
	assert.strictEqual(new Set(r.sections.map((s) => s.id)).size, r.sections.length);
	assert.strictEqual(r.sections.length, T.CHANNELS.length + 2);
	assert.strictEqual(t.requests.length, 0);
	t.stop();
});

test("New: every known channel, newest first, as MediathekViewWeb is asked (text/plain JSON, no future items)", async () => {
	const t = start();
	const r = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 50 });
	assert.deepStrictEqual(ids(r), ["ard-1", "alpha-1", "ard-geo", "zdf-1", "3sat-geo", "wdr-1", "orf-1", "rb-1", "rb-2", "arte-1", "same-1", "sr-1"],
		"no other channel, no entry without a link, no livestream");
	assert.strictEqual(r.nextCursor, null);
	const q = queries(t)[0];
	assert.strictEqual(q.headers["Content-Type"], "text/plain");
	assert.strictEqual(q.headers["User-Agent"], "LuneOS-Videos/1.0");
	assert.deepStrictEqual(JSON.parse(q.body), { queries: [], sortBy: "timestamp", sortOrder: "desc", future: false, offset: 0, size: 50 });
	t.stop();
});

test("an item: channel and topic under the title, length, year, the broadcaster's page; no art", async () => {
	const t = start();
	const r = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 50 });
	const by = (id) => r.items.find((i) => i.id === id);
	assert.deepStrictEqual(by("ard-1"), { id: "ard-1", kind: "video", title: "Der Fall", subtitle: "ARD · Tatort", description: "About Der Fall",
		artwork: {}, durationMs: 5400000, year: 2026, playable: true, hasChildren: false, webUrl: "https://www.example-broadcaster.test/ard-1" });
	assert.strictEqual(by("same-1").subtitle, "NDR", "a topic that is the title is said once");
	assert.strictEqual(by("rb-1").subtitle, "Radio Bremen · buten un binnen");
	assert.strictEqual(by("rb-2").subtitle, "Radio Bremen · buten un binnen", "Radio Bremen by each of its names");
	assert.strictEqual(by("sr-1").kind, "video", "a topic that only begins with Livestream is no livestream");
	assert.strictEqual(by("sr-1").year, 2017);
	t.stop();
});

test("links marked for Germany, DACH or Austria say so; worldwide ones do not", async () => {
	const t = start();
	const r = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 50 });
	const geo = r.items.filter((i) => / · Only in its own country$/.test(i.subtitle)).map((i) => i.id);
	assert.deepStrictEqual(geo, ["ard-geo", "3sat-geo", "orf-1"]);
	t.stop();
	const yes = [
		"https://ctv-videos.daserste.de/de/2026/10/13/X/X_1280x720.mp4", "https://ctv-videos.daserste.de/dach/2024/01/18/x.mp4",
		"https://rodlzdf-a.akamaihd.net/dach/3sat/26/11/x.mp4", "http://tvdlzdf-a.akamaihd.net/de/tivi/25/09/x.mp4",
		"http://zdf-hls-15.akamaized.net/hls/live/2016498/de/high/master.m3u8",
		"https://cdn-storage.br.de/geo/b7/2026-08/24/x_X.mp4", "https://kika-progressive.ard-mcdn.de/kika_de-prod/geo/mp4dyn/3/x.mp4",
		"https://hr-progressive.ard-mcdn.de/odinson/geoavailability_D/x/y.mp4", "https://hr-progressive.ard-mcdn.de/odinson/geoavailability_DACH/x.mp4",
		"https://ndr-progressive.ard-mcdn.de/progressive_geo/2026/1103/x.hd.mp4", "https://ndr-progressive.ard-mcdn.de/progressive_geo_dach/2025/x.hq.mp4",
		"https://rbb-progressive.ard-mcdn.de/content-de/eb/56/x_hd1080-avc720.mp4",
		"https://wdr-progressive.ard-mcdn.de/media/p/public/de/2026/10/15/x_AVC-360.mp4", "https://wdrmedien-a.akamaihd.net/medp/ondemand/de/fsk0/222/x.mp4",
		"https://apasfiis.sf.apa.at/ipad/cms-austria/2026/x.mp4/chunklist_b620000.m3u8", "https://apasfiis.sf.apa.at/ipad/cms-austria_episodes/x.mp4/c.m3u8",
	];
	const no = [
		"https://ctv-videos.daserste.de/int/2026/11/04/x.mp4", "https://nrodlzdf-a.akamaihd.net/none/zdf/26/10/x.mp4",
		"https://cdn-storage.br.de/b7/2026-11/04/x_X.mp4", "https://kika-progressive.ard-mcdn.de/kika_de-prod/online/mp4dyn/a/x.mp4",
		"https://hr-progressive.ard-mcdn.de/odinson/hessenschau/x.mp4", "https://ndr-progressive.ard-mcdn.de/progressive/2026/1101/x.hd.mp4",
		"https://rbb-progressive.ard-mcdn.de/content/03/f9/x_hd1080-avc720.mp4", "https://wdr-progressive.ard-mcdn.de/media/p/public/weltweit/2026/x.mp4",
		"https://apasfiis.sf.apa.at/ipad/cms-worldwide/2026/x.mp4/c.m3u8",
		// Arte's /de/ is the language, and the link plays everywhere.
		"https://manifest-arte.akamaized.net/api/manifest/v1/Generate/uuid/de/XQ+KS+CHEV1/120361-000-A.m3u8",
		// A mark on another CDN's host is not that CDN's mark.
		"https://elsewhere.example.test/de/x.mp4", "https://cdn.example.test/geo/x.mp4", "not a link",
	];
	assert.deepStrictEqual(yes.filter((u) => !T.geoOf(u)), []);
	assert.deepStrictEqual(no.filter((u) => T.geoOf(u)), []);
});

test("a channel's section asks for each of its names and keeps only them (\"ard\" also finds ARD-alpha)", async () => {
	const t = start();
	const r = await t.call("listItems", { sourceId: "acc-mt", sectionId: "ch:ard", limit: 50 });
	assert.deepStrictEqual(ids(r), ["ard-1", "ard-geo"], "no ARD-alpha, no livestream, no entry without a link");
	assert.deepStrictEqual(JSON.parse(queries(t)[0].body).queries, [{ fields: ["channel"], query: "ard" }]);
	const rb = await t.call("listItems", { sourceId: "acc-mt", sectionId: "ch:radiobremen", limit: 50 });
	assert.deepStrictEqual(ids(rb), ["rb-1", "rb-2"]);
	assert.deepStrictEqual(JSON.parse(queries(t)[1].body).queries.map((q) => q.query), ["radio bremen tv", "rbtv"], "each name once");
	const second = await t.call("listItems", { sourceId: "acc-mt", sectionId: "ch:ard", limit: 1, cursor: "1" });
	assert.deepStrictEqual([ids(second), JSON.parse(queries(t).pop().body).offset], [[], 1], "the second is ARD-alpha's, left out");
	const third = await t.call("listItems", { sourceId: "acc-mt", sectionId: "ch:ard", limit: 1, cursor: "2" });
	assert.deepStrictEqual([ids(third), third.nextCursor], [["ard-geo"], "3"]);
	const alpha = await t.call("listItems", { sourceId: "acc-mt", sectionId: "ch:ardalpha", limit: 50 });
	assert.deepStrictEqual(ids(alpha), ["alpha-1"]);
	const none = await t.call("listItems", { sourceId: "acc-mt", sectionId: "ch:nosuch" });
	assert.strictEqual(none.errorCode, "NOT_FOUND");
	const bad = await t.call("listItems", { sourceId: "acc-mt", sectionId: "zdf" });
	assert.strictEqual(bad.errorCode, "NOT_FOUND");
	t.stop();
});

test("paging: the offset is the cursor; a full page has a next one, up to the 10000 the server answers", async () => {
	const t = start();
	const one = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 3 });
	assert.deepStrictEqual([ids(one), one.nextCursor], [["ard-1", "alpha-1", "ard-geo"], "3"]);
	const two = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 3, cursor: "3" });
	assert.deepStrictEqual([ids(two), two.nextCursor], [["zdf-1", "3sat-geo", "wdr-1"], "6"]);
	assert.deepStrictEqual(JSON.parse(queries(t)[1].body).offset, 3);
	// A page the server filled is not cut short by what the provider leaves out.
	const four = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 3, cursor: "9" });
	assert.deepStrictEqual([ids(four), four.nextCursor], [["arte-1"], "12"]);
	const last = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 50, cursor: "12" });
	assert.strictEqual(last.nextCursor, null);
	const near = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 50, cursor: "9990" });
	assert.strictEqual(JSON.parse(queries(t).pop().body).size, 10, "not past the server's window");
	assert.strictEqual(near.nextCursor, null);
	const n = queries(t).length;
	const past = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 50, cursor: "10000" });
	assert.deepStrictEqual([past.items, past.nextCursor, queries(t).length], [[], null, n]);
	const big = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 200 });
	assert.strictEqual(JSON.parse(queries(t).pop().body).size, 200);
	assert.strictEqual(big.nextCursor, null);
	t.stop();
	// A full page that reaches the window has no next one.
	const full = start({ rts: routes({ query: (req) => (JSON.parse(req.body).offset === 9990
		? { body: { result: { results: ENTRIES.slice(0, 10).map((e) => Object.assign({}, e)) }, err: null } } : null) }) });
	const edge = await full.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 10, cursor: "9990" });
	assert.deepStrictEqual([edge.items.length > 0, edge.nextCursor], [true, null]);
	full.stop();
});

test("Live TV: the channels' livestreams in channel order, as live items; one page", async () => {
	const t = start();
	const r = await t.call("listItems", { sourceId: "acc-mt", sectionId: "live", limit: 50 });
	assert.deepStrictEqual(ids(r), ["live-alpha", "live-ard", "live-zdf", "live-3sat"]);
	assert.deepStrictEqual(r.items.map((i) => [i.kind, i.subtitle, i.durationMs, i.year]), [
		["live", "ARD", undefined, undefined], ["live", "ARD", undefined, undefined],
		["live", "ZDF · Only in its own country", undefined, undefined], ["live", "3sat · Only in its own country", undefined, undefined]]);
	assert.strictEqual(r.nextCursor, null);
	assert.deepStrictEqual(JSON.parse(queries(t)[0].body), { queries: [{ fields: ["topic"], query: "livestream" }], future: true, offset: 0, size: 200 });
	const more = await t.call("listItems", { sourceId: "acc-mt", sectionId: "live", cursor: "50" });
	assert.deepStrictEqual(more.items, []);
	t.stop();
});

test("search: titles and topics, newest first, paged as a section", async () => {
	const t = start();
	const r = await t.call("search", { sourceId: "acc-mt", query: "tatort", limit: 10 });
	assert.deepStrictEqual(ids(r), ["ard-1"]);
	assert.deepStrictEqual(JSON.parse(queries(t)[0].body), { queries: [{ fields: ["title", "topic"], query: "tatort" }],
		sortBy: "timestamp", sortOrder: "desc", future: false, offset: 0, size: 10 });
	const all = await t.call("searchAll", { query: "buten" });
	assert.deepStrictEqual(all.results.map((x) => [x.sourceId, ids(x)]), [["acc-mt", ["rb-1", "rb-2"]]]);
	t.stop();
});

test("answers are kept a minute: the same page twice is asked once; another page is asked", async (c) => {
	const t = start();
	await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 5 });
	await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 5 });
	assert.strictEqual(queries(t).length, 1);
	await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 6 });
	assert.strictEqual(queries(t).length, 2);
	const now = Date.now();
	c.mock.method(Date, "now", () => now + 61 * 1000);
	await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 5 });
	assert.strictEqual(queries(t).length, 3, "asked again after a minute");
	// An entry seen is kept half an hour for getItem and resolve.
	await t.call("getItem", { sourceId: "acc-mt", itemId: "ard-1" });
	c.mock.method(Date, "now", () => now + 61 * 1000 + 29 * 60 * 1000);
	await t.call("getItem", { sourceId: "acc-mt", itemId: "ard-1" });
	const entries = () => t.requests.filter((r) => r.url.endsWith("/api/entries")).length;
	assert.strictEqual(entries(), 0);
	c.mock.method(Date, "now", () => now + 61 * 1000 + 30 * 60 * 1000);
	await t.call("getItem", { sourceId: "acc-mt", itemId: "ard-1" });
	assert.strictEqual(entries(), 1, "asked again after half an hour");
	t.stop();
});

test("the answers kept are cut to their number, the oldest first", async (c) => {
	const keep = Object.assign({}, T.LIMITS);
	c.after(() => Object.assign(T.LIMITS, keep));
	T.LIMITS.queries = 2;
	T.LIMITS.entries = 2;
	const t = start();
	for (const limit of [1, 2, 3]) { await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit }); }
	await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 3 });
	assert.strictEqual(queries(t).length, 3, "the newest is kept");
	await t.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 1 });
	assert.strictEqual(queries(t).length, 4, "the oldest is gone");
	// Entries: only the last two seen are kept, so the first is asked for again.
	await t.call("getItem", { sourceId: "acc-mt", itemId: "alpha-1" });
	assert.strictEqual(t.requests.filter((r) => r.url.endsWith("/api/entries")).length, 1, "alpha-1 was seen, and is gone");
	await t.call("getItem", { sourceId: "acc-mt", itemId: "ard-1" });
	assert.strictEqual(t.requests.filter((r) => r.url.endsWith("/api/entries")).length, 1, "ard-1 was seen last");
	t.stop();
	// An entry seen again is the newest again.
	T.LIMITS.queries = 50;
	const u = start();
	await u.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 2 });
	await u.call("search", { sourceId: "acc-mt", query: "fall" });
	await u.call("search", { sourceId: "acc-mt", query: "nano" });
	await u.call("getItem", { sourceId: "acc-mt", itemId: "ard-1" });
	assert.strictEqual(u.requests.filter((r) => r.url.endsWith("/api/entries")).length, 0, "alpha-1 went, not ard-1");
	u.stop();
});

test("getItem and resolve use the entries just listed; otherwise /api/entries, which answers without ids", async () => {
	const t = start();
	await t.call("listItems", { sourceId: "acc-mt", sectionId: "ch:ard", limit: 50 });
	const it = await t.call("getItem", { sourceId: "acc-mt", itemId: "ard-1" });
	assert.strictEqual(it.item.title, "Der Fall");
	await t.call("resolve", { sourceId: "acc-mt", itemId: "ard-1" });
	assert.strictEqual(t.requests.filter((r) => r.url.endsWith("/api/entries")).length, 0);
	const z = await t.call("getItem", { sourceId: "acc-mt", itemId: "zdf-1" });
	assert.deepStrictEqual([z.item.id, z.item.title, z.item.subtitle], ["zdf-1", "Teurer leben in New York", "ZDF · auslandsjournal"]);
	const e = t.requests.filter((r) => r.url.endsWith("/api/entries"));
	assert.deepStrictEqual([e.length, JSON.parse(e[0].body), e[0].headers["Content-Type"], e[0].headers["User-Agent"]],
		[1, ["zdf-1"], "application/json", "LuneOS-Videos/1.0"]);
	await t.call("resolve", { sourceId: "acc-mt", itemId: "zdf-1" });
	assert.strictEqual(t.requests.filter((r) => r.url.endsWith("/api/entries")).length, 1, "kept once fetched");
	const gone = await t.call("getItem", { sourceId: "acc-mt", itemId: "no-such" });
	assert.strictEqual(gone.errorCode, "NOT_FOUND");
	const r = await t.call("resolve", { sourceId: "acc-mt", itemId: "no-such" });
	assert.strictEqual(r.errorCode, "NOT_FOUND");
	const other = await t.call("resolve", { sourceId: "acc-mt", itemId: "other-1" });
	assert.strictEqual(other.errorCode, "NOT_FOUND", "a channel not offered is not played either");
	t.stop();
});

test("resolve: the tallest link no taller than wanted, by the size the link names", async () => {
	const t = start();
	const at = async (itemId, maxHeight) => (await t.call("resolve", { sourceId: "acc-mt", itemId,
		prefer: maxHeight === undefined ? undefined : { maxHeight } })).stream;
	assert.match((await at("ard-1")).url, /_1280x720-50p-3200kbit\.mp4$/, "720 when Videos says nothing");
	assert.match((await at("ard-1", 1080)).url, /_1920x1080-/);
	assert.match((await at("ard-1", 2160)).url, /_1920x1080-/);
	assert.match((await at("ard-1", 480)).url, /_640x360-/);
	assert.match((await at("ard-1", 200)).url, /_640x360-/, "smaller than any: the smallest");
	assert.match((await at("wdr-1", 1080)).url, /_AVC-1080\.mp4$/);
	assert.match((await at("wdr-1", 719)).url, /_AVC-360\.mp4$/);
	// No size in ZDF's links: low, normal and HD are taken as 360, 540 and 1080.
	assert.match((await at("zdf-1", 720)).url, /_3360k_p36v17\.mp4$/);
	assert.match((await at("zdf-1", 1080)).url, /_6660k_p37v17\.mp4$/);
	assert.match((await at("zdf-1", 400)).url, /_808k_p11v17\.mp4$/);
	assert.match((await at("zdf-1", 600)).url, /_3360k_p36v17\.mp4$/, "normal is taken as 540");
	const L = "https://x.example.test/";
	assert.strictEqual(T.pickUrl({ url_video_low: L + "low.mp4", url_video: L + "n_AVC-400.mp4" }, 490), L + "n_AVC-400.mp4", "low is taken as 360");
	assert.strictEqual(T.pickUrl({ url_video_hd: L + "h_AVC-540.mp4", url_video: L + "n_AVC-720.mp4" }, 1080), L + "n_AVC-720.mp4",
		"by height, not by slot");
	assert.match((await at("same-1", 1080)).url, /\.1080\.mp4$/);
	const s = await at("ard-1");
	assert.deepStrictEqual([s.protocol, s.mime, s.drm], ["progressive", "video/mp4", null]);
	const orf = await at("orf-1", 720);
	assert.deepStrictEqual([orf.protocol, orf.mime], ["hls", "application/x-mpegURL"]);
	assert.match(orf.url, /chunklist_b4165000\.m3u8$/);
	const arte = await at("arte-1", 360);
	assert.deepStrictEqual([arte.protocol, /120361-000-A\.m3u8$/.test(arte.url)], ["hls", true], "the one link there is");
	const rb = await at("rb-1", 1080);
	assert.deepStrictEqual([rb.url, rb.protocol], ["https://rb.example.test/rb1.mp4", "progressive"]);
	t.stop();
});

test("subtitles: ARD's as WebVTT from its player service; WebVTT and SubRip as they are; TTML left out", async () => {
	const t = start();
	const sub = async (itemId) => (await t.call("resolve", { sourceId: "acc-mt", itemId })).stream.subtitles;
	assert.deepStrictEqual(await sub("ard-1"), [{ url: "https://api.ardmediathek.de/player-service/subtitle/webvtt/urn:ard:subtitle:0123456789abcdef.vtt",
		format: "vtt", default: false, label: "Deutsch", lang: "de" }]);
	assert.deepStrictEqual(await sub("wdr-1"), [{ url: "https://subs.example.test/wdr/aaaa.vtt", format: "vtt", default: false, label: "Deutsch", lang: "de" }]);
	assert.deepStrictEqual(await sub("orf-1"), []);
	assert.deepStrictEqual(await sub("zdf-1"), []);
	t.stop();
	assert.deepStrictEqual(T.subtitlesOf({ channel: "ARTE.FR", url_subtitle: "https://s.example.test/a/b.SRT" }),
		[{ url: "https://s.example.test/a/b.SRT", format: "srt", lang: "fr", label: "Français", default: false }]);
	assert.deepStrictEqual(T.subtitlesOf({ channel: "Nobody", url_subtitle: "https://s.example.test/b.vtt" }),
		[{ url: "https://s.example.test/b.vtt", format: "vtt", lang: undefined, label: "Subtitles", default: false }]);
	assert.deepStrictEqual(T.subtitlesOf({ channel: "ARD", url_subtitle: "https://api.ardmediathek.de/player-service/subtitle/ebutt/x/y" }), [],
		"not the player service's shape: an EBU-TT file Videos cannot show");
	assert.deepStrictEqual(T.subtitlesOf({ channel: "ARD", url_subtitle: "" }), []);
	assert.deepStrictEqual(T.subtitlesOf({ channel: "ARD", url_subtitle: "ftp://s.example.test/a.vtt" }), []);
});

test("heightOf: the size names links carry, and none for numbers that are not one", () => {
	const h = (p) => T.heightOf("https://x.example.test" + p);
	assert.deepStrictEqual([h("/a_640x360-50p.mp4"), h("/a_AVC-720.mp4"), h("/a.avc-1080.mp4"), h("/a.avc360.mp4"),
		h("/x_hd1080-avc540.mp4"), h("/TV-1.1080.mp4"), h("/TV-20261104-1800-4511.ln.mp4"), h("/2227110_56535625.mp4"),
		h("/a_AVC_960x540.mp4"), h("/a_9999x9999.mp4"), h("/a.720p.mp4"), h("/a_100.mp4"), h("/clip1720.mp4")],
	[360, 720, 1080, 360, 540, 1080, 0, 0, 540, 0, 720, 0, 0]);
	assert.strictEqual(T.heightOf("nope"), 0);
});

test("the film list's errors: its own (err), a 503 while it reads a new list, no reply", async () => {
	const t = start({ rts: routes({ query: () => ({ body: { result: null, err: ["cannot query while indexing"] } }) }) });
	const r = await t.call("listItems", { sourceId: "acc-mt", sectionId: "new" });
	assert.deepStrictEqual([r.errorCode, r.errorText], ["SERVER_ERROR", "MediathekViewWeb answered with an error: cannot query while indexing"]);
	t.stop();
	const odd = start({ rts: routes({ query: () => ({ body: { err: [] } }) }) });
	const o = await odd.call("search", { sourceId: "acc-mt", query: "x" });
	assert.deepStrictEqual([o.errorCode, o.errorText], ["SERVER_ERROR", "MediathekViewWeb answered with an error."]);
	odd.stop();
	const busy = start({ rts: routes({ query: () => ({ status: 503, body: { result: null, err: ["cannot query while indexing"] } }) }) });
	assert.strictEqual((await busy.call("listItems", { sourceId: "acc-mt", sectionId: "new" })).errorCode, "SERVER_ERROR");
	busy.stop();
	const down = start({ rts: routes({ query: () => { throw new Error("refused"); } }) });
	assert.strictEqual((await down.call("listItems", { sourceId: "acc-mt", sectionId: "new" })).errorCode, "SERVER_UNREACHABLE");
	down.stop();
	const empty = start({ rts: routes({ query: () => ({ body: { result: { results: [null, 3, { id: "x" }] }, err: null } }) }) });
	const e = await empty.call("listItems", { sourceId: "acc-mt", sectionId: "new" });
	assert.deepStrictEqual([e.items, e.nextCursor], [[], null]);
	empty.stop();
	const blank = start({ rts: routes({ query: () => ({ body: { result: null, err: null } }) }) });
	const b = await blank.call("listItems", { sourceId: "acc-mt", sectionId: "new" });
	assert.deepStrictEqual([b.items, b.nextCursor], [[], null]);
	blank.stop();
	const failed = start({ rts: routes({ entries: () => ({ body: { result: null, err: ["Document not found"] } }) }) });
	assert.strictEqual((await failed.call("getItem", { sourceId: "acc-mt", itemId: "zdf-1" })).errorCode, "SERVER_ERROR");
	failed.stop();
	// The answers that failed are not kept.
	let n = 0;
	const flaky = start({ rts: routes({ query: () => (n++ === 0 ? { status: 502, body: "bad" } : null) }) });
	await flaky.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 2 });
	const ok = await flaky.call("listItems", { sourceId: "acc-mt", sectionId: "new", limit: 2 });
	assert.deepStrictEqual(ids(ok), ["ard-1", "alpha-1"]);
	flaky.stop();
});

test("toItem leaves out what cannot be shown or played", () => {
	const ok = ENTRIES[0];
	assert.ok(T.toItem(ok));
	assert.strictEqual(T.toItem(null), null);
	assert.strictEqual(T.toItem(Object.assign({}, ok, { id: 5 })), null);
	assert.strictEqual(T.toItem(Object.assign({}, ok, { title: "" })), null);
	assert.strictEqual(T.toItem(Object.assign({}, ok, { url_video: "", url_video_low: "ftp://x.example.test/a.mp4", url_video_hd: undefined })), null);
	assert.deepStrictEqual(T.candidatesOf(Object.assign({}, ok, { url_video_low: ok.url_video })).map((c) => c.height), [1080, 720], "one link once");
	assert.strictEqual(T.toItem(Object.assign({}, ok, { timestamp: "1793900000", duration: -1 })).year, undefined);
	assert.strictEqual(T.toItem(Object.assign({}, ok, { duration: 0 })).durationMs, undefined);
	assert.strictEqual(T.toItem(Object.assign({}, ok, { url_website: "javascript:alert(1)" })).webUrl, undefined);
	assert.strictEqual(T.toItem(Object.assign({}, ok, { description: "" })).description, undefined);
	assert.strictEqual(T.pickUrl({}, 720), null);
	assert.deepStrictEqual([T.protocolOf("https://a.example.test/m.mpd"), T.protocolOf("https://a.example.test/x.M3U8?a=b")], ["dash", "hls"]);
});
