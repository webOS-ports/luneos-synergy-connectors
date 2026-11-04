// node --test tests/unit
// The Internet Archive provider (video/archive), through the service on a stand-in bus and fetch:
// the collections and search as advancedsearch is asked, an item's files as titles, the MP4 and
// subtitles resolve picks, and what archive.org only lends left out. The shapes are archive.org's
// as answered on 2026-11-04 (his_girl_friday, theloneranger_201705, Sita_Sings_the_Blues), cut
// down.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../video/_core/service/org.webosports.service.videos");
const service = require(SVC);
const archive = require("../../video/archive/provider");
const upnpLib = require("../../video/upnp/provider");
const T = archive._test;

const VIDEOS = { appId: "org.webosports.app.videoplayer 1234" };
const AUTH = { appId: "org.webosports.app.videoauth 999" };
const IA = "https://archive.org";
const TEMPLATE = "org.webosports.video.archive";

const ACCOUNTS = [{ _id: "acc-ia", templateId: TEMPLATE, username: "archive.org", alias: "Internet Archive",
	icon: { loc_48x48: "/usr/palm/public/accounts/org.webosports.video.archive/images/archive-48x48.png" } }];

const DOCS = [
	{ identifier: "his_girl_friday", title: "His Girl Friday", creator: ["Howard Hawks", "Columbia"], year: 1940, date: "1940-01-01T00:00:00Z",
		runtime: "1:31:44", description: "<p>Hilarious &amp; romantic comedy<br/>with Cary Grant &#38; Rosalind Russell.</p>&bogus; &#xD800;" },
	{ identifier: "theloneranger_201705", title: "The Lone Ranger TV Show", date: "2017-05-08" },
	{ identifier: "JungleBook", title: ["Jungle Book", "Rudyard Kipling's Jungle Book"], runtime: "108 min", year: "1942" },
	{ identifier: "short", title: "Short", runtime: "12", year: "0001" },
	{ identifier: "bad/id", title: "Not an identifier" },
	{ identifier: "", title: "No identifier" },
];

const f = (name, format, extra = {}) => Object.assign({ name, format, source: "derivative" }, extra);

const FILMS = {
	his_girl_friday: {
		metadata: { identifier: "his_girl_friday", title: "His Girl Friday", year: "1940", runtime: "1:31:44", collection: ["Comedy_Films", "feature_films"] },
		files: [
			f("__ia_thumb.jpg", "Item Tile", { source: "original" }),
			f("his_girl_friday.mpeg", "MPEG2", { source: "original", height: "480", length: "5504.14" }),
			f("his_girl_friday.mp4", "h.264", { original: "his_girl_friday.mpeg", height: "480", length: "5504.57" }),
			f("his_girl_friday_512kb.mp4", "512Kb MPEG4", { original: "his_girl_friday.mpeg", height: "240", length: "5504.52" }),
			f("his_girl_friday.ogv", "Ogg Video", { original: "his_girl_friday.mpeg", height: "304", length: "5504.08" }),
			f("his_girl_friday.asr.srt", "SubRip", { source: "original" }),
			f("his_girl_friday.asr.js", "ASR", { source: "original" }),
			f("his_girl_friday.thumbs/his_girl_friday_000001.jpg", "Thumbnail", { original: "his_girl_friday.mpeg" }),
		],
	},
	theloneranger_201705: {
		metadata: { identifier: "theloneranger_201705", title: "The Lone Ranger TV Show", collection: ["classic_tv_1940s", "classic_tv"] },
		files: [
			f("s01e02_TheLoneRangerFightsOn.mp4", "MPEG4", { source: "original", height: "360", length: "1454.59" }),
			f("s01e02_TheLoneRangerFightsOn.ogv", "Ogg Video", { original: "s01e02_TheLoneRangerFightsOn.mp4", length: "1454.59" }),
			f("s01e01_EntertheLoneRanger.mp4", "MPEG4", { source: "original", height: "360", length: "1519.65" }),
			f("theloneranger_201705.thumbs/s01e01_EntertheLoneRanger_000160.jpg", "Thumbnail", { original: "s01e01_EntertheLoneRanger.mp4" }),
			f("theloneranger_201705.thumbs/s01e01_EntertheLoneRanger_000001.jpg", "Thumbnail", { original: "s01e01_EntertheLoneRanger.mp4" }),
			f("theloneranger_201705.thumbs/s01e01_EntertheLoneRanger_000244.jpg", "Thumbnail", { original: "s01e01_EntertheLoneRanger.mp4" }),
			f("s01e10_Highheels.mp4", "MPEG4", { source: "original", height: "360", length: "1296.09" }),
			f("s01e10_Highheels.en.vtt", "Web Video Text Tracks", { source: "original" }),
			f("s01e01_EntertheLoneRanger.srt", "SubRip", { source: "original" }),
		],
	},
	// Renditions of one film, a disc image's several videos, one in a folder with spaces.
	Sita_Sings_the_Blues: {
		metadata: { identifier: "Sita_Sings_the_Blues", title: "Sita Sings the Blues", year: "2008" },
		files: [
			f("Sita_Sings_the_Blues_1080p.mp4", "h.264 MPEG4", { source: "original", height: "1080", length: "4891.24" }),
			f("Sita_Sings_the_Blues_720p.mp4", "h.264 MPEG4", { source: "original", height: "720", length: "4891.24" }),
			f("Sita_Sings_the_Blues_480p_2150kbps.mp4", "h.264 MPEG4", { source: "original", height: "480", length: "4891.24" }),
			f("Sita_Sings_the_Blues_720p.asr.srt", "SubRip", { source: "original" }),
			f("Sita_Sings_the_Blues_1080p.asr.srt", "SubRip", { source: "original" }),
			f("DVD.img", "ISO Image", { source: "original" }),
			f("DVD.mp4", "h.264", { original: "DVD.img", height: "360", length: "4894.77" }),
			f("DVD1.mp4", "h.264", { original: "DVD.img", height: "360", length: "105.26" }),
			f("extras/The Trailer.mp4", "h.264", { source: "original", height: "", length: "120", title: "Trailer" }),
			f("hidden.mp4", "h.264", { source: "original", height: "360", length: "33", private: "true" }),
			f("0_intro.mp4", "h.264", { source: "original", height: "360", length: "30" }),
			f("0_intro.srt", "SubRip", { source: "original", private: "true" }),
			f("0_notes.mp4", "Metadata", { source: "original", length: "77" }),
		],
	},
	lent: { metadata: { identifier: "lent", title: "Lent", "access-restricted-item": "true" }, files: [f("lent.mp4", "h.264", { source: "original" })] },
	library: { metadata: { identifier: "library", title: "Lib", collection: ["inlibrary", "movies"] }, files: [f("lib.mp4", "h.264", { source: "original" })] },
	dark: { is_dark: true, server: "ia600000.us.archive.org" },
	noplay: { metadata: { identifier: "noplay", title: "Only Ogg", runtime: "10:00" }, files: [f("noplay.ogv", "Ogg Video", { source: "original", length: "600" })] },
};

function searchReply(req, over) {
	const u = new URL(req.url);
	const rows = Number(u.searchParams.get("rows")), page = Number(u.searchParams.get("page"));
	if (over) { return over(u); }
	return { body: { responseHeader: { status: 0 }, response: { numFound: 12, start: (page - 1) * rows, docs: DOCS.slice(0, rows) } } };
}

function routes(o = {}) {
	return [
		["GET", /^https:\/\/archive\.org\/advancedsearch\.php\?/, (req) => searchReply(req, o.search)],
		["GET", /^https:\/\/archive\.org\/metadata\/missing$/, () => ({ status: 404, body: "no" })],
		["GET", /^https:\/\/archive\.org\/metadata\/empty$/, () => ({ body: {} })],
		["GET", /^https:\/\/archive\.org\/metadata\/([^/?]+)$/, (req) => {
			const id = decodeURIComponent(/metadata\/([^/?]+)$/.exec(req.url)[1]);
			return FILMS[id] ? { body: FILMS[id] } : { body: {} };
		}],
	];
}

function start({ rts = routes(), accounts = ACCOUNTS } = {}) {
	archive._test.reset();
	upnpLib._test.dir._set([]);
	const pb = fakePalmbus({ onCall: (uri) => {
		if (uri.endsWith("/listAccounts")) { return { returnValue: true, results: accounts }; }
		if (uri.endsWith("/readCredentials")) { return { returnValue: true, credentials: { common: { kind: "archive" } } }; }
		return { returnValue: true };
	} });
	const { fetch, requests } = fakeFetch(rts);
	const logs = [];
	const log = { log: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)), warn: (s) => logs.push(String(s)) };
	const s = service.start({ palmbus: pb, fetch, ssdp: { search: async () => [] }, idleMs: 0, exit: () => {}, log,
		timeouts: { timeoutMs: 2000, idleTimeoutMs: 2000 } });
	const handle = pb.handles[0];
	return { call: (m, p, who = VIDEOS) => ask(handle, m, p, who), requests, logs, stop: () => s.bus.stop() };
}

const searchesOf = (t) => t.requests.filter((r) => r.url.includes("/advancedsearch.php")).map((r) => new URL(r.url));

test("login adds the account with nothing typed; the source is named Internet Archive", async () => {
	const t = start();
	const r = await t.call("login", { templateId: TEMPLATE }, AUTH);
	assert.deepStrictEqual([r.returnValue, r.username, r.alias, r.credentials], [true, "archive.org", "Internet Archive", { common: { kind: "archive" } }]);
	assert.strictEqual(t.requests.length, 0);
	const s = await t.call("listSources", {});
	assert.deepStrictEqual(s.sources.map((x) => [x.sourceId, x.provider, x.name, x.label, x.features]),
		[["acc-ia", "archive", "Internet Archive", "Internet Archive", { search: true, progress: false, continueWatching: false, live: false }]]);
	t.stop();
});

test("sections: the collections, three rows and the rest libraries", async () => {
	const t = start();
	const r = await t.call("listSections", { sourceId: "acc-ia" });
	assert.deepStrictEqual(r.sections.map((s) => [s.id, s.layout]), [
		["feature_films", "row"], ["classic_tv", "row"], ["animationandcartoons", "row"], ["silent_films", "grid"], ["SciFi_Horror", "grid"],
		["Film_Noir", "grid"], ["Comedy_Films", "grid"], ["short_films", "grid"], ["prelinger", "grid"], ["newsandpublicaffairs", "grid"]]);
	assert.strictEqual(r.sections[2].title, "Animation & Cartoons");
	assert.strictEqual(t.requests.length, 0);
	const no = await t.call("listItems", { sourceId: "acc-ia", sectionId: "nope" });
	assert.strictEqual(no.errorCode, "NOT_FOUND");
	t.stop();
});

test("a section asks advancedsearch for its collection's playable films, most downloaded first, as archive.org's client", async () => {
	const t = start();
	const r = await t.call("listItems", { sourceId: "acc-ia", sectionId: "feature_films", limit: 6 });
	const [u] = searchesOf(t);
	assert.strictEqual(u.origin + u.pathname, IA + "/advancedsearch.php");
	assert.strictEqual(u.searchParams.get("q"), "collection:feature_films AND mediatype:movies AND -access-restricted-item:true AND " +
		"-collection:(inlibrary OR printdisabled OR lendinglibrary OR stream_only) AND " +
		"format:(\"h.264\" OR \"h.264 IA\" OR \"512Kb MPEG4\" OR \"h.264 MPEG4\" OR \"h.264 HD\" OR \"MPEG4\" OR \"HiRes MPEG4\")");
	assert.deepStrictEqual(u.searchParams.getAll("fl[]"), ["identifier", "title", "creator", "year", "date", "runtime", "description"]);
	assert.deepStrictEqual([u.searchParams.get("sort[]"), u.searchParams.get("rows"), u.searchParams.get("page"), u.searchParams.get("output")],
		["downloads desc", "6", "1", "json"]);
	assert.deepStrictEqual(t.requests[0].headers, { Accept: "application/json", "User-Agent": "LuneOS-Videos/1.0" });
	assert.deepStrictEqual(r.items.map((i) => [i.id, i.kind, i.playable, i.hasChildren, i.durationMs, i.year]), [
		["his_girl_friday", "movie", true, false, 5504000, 1940],
		["theloneranger_201705", "collection", false, true, undefined, 2017],
		["JungleBook", "movie", true, false, 108 * 60000, 1942],
		["short", "movie", true, false, 12 * 60000, undefined],
	]);
	const hgf = r.items[0];
	assert.deepStrictEqual([hgf.title, hgf.subtitle, hgf.webUrl], ["His Girl Friday", "Howard Hawks", IA + "/details/his_girl_friday"]);
	assert.deepStrictEqual(hgf.artwork, { poster: IA + "/services/img/his_girl_friday", thumb: IA + "/services/img/his_girl_friday" });
	assert.strictEqual(hgf.description, "Hilarious & romantic comedy\nwith Cary Grant & Rosalind Russell.\n&bogus;");
	assert.strictEqual(r.items[2].title, "Jungle Book");
	assert.strictEqual(r.nextCursor, "2:6");
	t.stop();
});

test("paging: the cursor keeps its rows; the last page has no cursor; a cursor not made here starts over", async () => {
	const t = start({ rts: routes({ search: (u) => ({ body: { response: { numFound: 12,
		docs: DOCS.slice(0, Number(u.searchParams.get("rows"))) } } }) }) });
	const two = await t.call("listItems", { sourceId: "acc-ia", sectionId: "classic_tv", cursor: "2:4", limit: 50 });
	assert.strictEqual(two.nextCursor, "3:4");
	const last = await t.call("listItems", { sourceId: "acc-ia", sectionId: "classic_tv", cursor: "3:4", limit: 50 });
	assert.strictEqual(last.nextCursor, null);
	await t.call("listItems", { sourceId: "acc-ia", sectionId: "classic_tv", cursor: "0:4", limit: 3 });
	await t.call("listItems", { sourceId: "acc-ia", sectionId: "classic_tv", cursor: "2:101", limit: 3 });
	await t.call("listItems", { sourceId: "acc-ia", sectionId: "classic_tv", cursor: "x", limit: 500 });
	assert.deepStrictEqual(searchesOf(t).map((u) => [u.searchParams.get("page"), u.searchParams.get("rows")]),
		[["2", "4"], ["3", "4"], ["1", "3"], ["1", "3"], ["1", "100"]]);
	t.stop();
});

test("an empty page ends the list, whatever numFound says", async () => {
	const t = start({ rts: routes({ search: () => ({ body: { response: { numFound: 99, docs: [] } } }) }) });
	const r = await t.call("listItems", { sourceId: "acc-ia", sectionId: "prelinger" });
	assert.deepStrictEqual([r.items, r.nextCursor], [[], null]);
	t.stop();
});

test("advancedsearch's own error, or no list, is a server error", async () => {
	for (const body of [{ error: "Invalid query" }, { error: "Invalid query", response: { numFound: 0, docs: [] } }, { response: {} }, "[]"]) {
		const t = start({ rts: routes({ search: () => ({ body }) }) });
		const r = await t.call("listItems", { sourceId: "acc-ia", sectionId: "feature_films" });
		assert.deepStrictEqual([r.errorCode, r.errorText], ["SERVER_ERROR", "The Internet Archive could not answer that list."], JSON.stringify(body));
		t.stop();
	}
});

test("search: the words in title, creator or subject, over the playable films; query syntax and and/or/not dropped", async () => {
	const t = start();
	const r = await t.call("search", { sourceId: "acc-ia", query: "AC/DC & rock'n'roll - \"live\" (1979) OR 'Señor' not", limit: 3 });
	assert.strictEqual(r.items.length, 3);
	const [u] = searchesOf(t);
	const w = "(AC DC rock'n'roll live 1979 Señor)";
	assert.strictEqual(u.searchParams.get("q"), "(title:" + w + " OR creator:" + w + " OR subject:" + w + ") AND " + T.PLAYABLE);
	assert.strictEqual(u.searchParams.get("sort[]"), "downloads desc");
	const none = await t.call("search", { sourceId: "acc-ia", query: "&& || !" });
	assert.deepStrictEqual([none.items, none.nextCursor], [[], null]);
	assert.strictEqual(searchesOf(t).length, 1, "nothing left to ask for: not asked");
	const all = await t.call("searchAll", { query: "chaplin" });
	assert.deepStrictEqual(all.results.map((x) => x.sourceId), ["acc-ia"]);
	t.stop();
});

test("words: at most twelve, apostrophes only inside words", () => {
	assert.deepStrictEqual(T.words("'quoted' it's AND Or NOT notable"), ["quoted", "it's", "notable"]);
	assert.strictEqual(T.words("a b c d e f g h i j k l m n").length, 12);
	assert.deepStrictEqual(T.words(undefined), []);
});

test("a film: one title; resolve plays its h.264 MP4 no taller than asked, with its captions", async () => {
	const t = start();
	const it = await t.call("getItem", { sourceId: "acc-ia", itemId: "his_girl_friday" });
	assert.deepStrictEqual([it.item.kind, it.item.playable, it.item.hasChildren, it.item.children, it.item.durationMs],
		["movie", true, false, undefined, 5504570]);
	const r = await t.call("resolve", { sourceId: "acc-ia", itemId: "his_girl_friday" });
	assert.deepStrictEqual(r.stream, { url: IA + "/download/his_girl_friday/his_girl_friday.mp4", protocol: "progressive", mime: "video/mp4",
		subtitles: [{ url: IA + "/download/his_girl_friday/his_girl_friday.asr.srt", format: "srt", default: false, label: "Automatic captions" }],
		drm: null });
	const low = await t.call("resolve", { sourceId: "acc-ia", itemId: "his_girl_friday", prefer: { maxHeight: 360 } });
	assert.strictEqual(low.stream.url, IA + "/download/his_girl_friday/his_girl_friday_512kb.mp4");
	const tiny = await t.call("resolve", { sourceId: "acc-ia", itemId: "his_girl_friday", prefer: { maxHeight: 100 } });
	assert.strictEqual(tiny.stream.url, IA + "/download/his_girl_friday/his_girl_friday_512kb.mp4", "none fits: the smallest");
	assert.strictEqual(t.requests.filter((x) => x.url.includes("/metadata/")).length, 1, "the metadata is asked once");
	assert.deepStrictEqual(t.requests[0].headers, { Accept: "application/json", "User-Agent": "LuneOS-Videos/1.0" });
	t.stop();
});

test("a series: its episodes as children, named, numbered and with their own thumbnails, each playable", async () => {
	const t = start();
	const it = await t.call("getItem", { sourceId: "acc-ia", itemId: "theloneranger_201705" });
	assert.deepStrictEqual([it.item.kind, it.item.playable, it.item.hasChildren], ["collection", false, true]);
	assert.deepStrictEqual(it.item.children.map((c) => [c.id, c.kind, c.title, c.seriesTitle, c.season, c.episode, c.durationMs]), [
		["theloneranger_201705/s01e01_EntertheLoneRanger.mp4", "episode", "Enterthe Lone Ranger", "The Lone Ranger TV Show", 1, 1, 1519650],
		["theloneranger_201705/s01e02_TheLoneRangerFightsOn.mp4", "episode", "The Lone Ranger Fights On", "The Lone Ranger TV Show", 1, 2, 1454590],
		["theloneranger_201705/s01e10_Highheels.mp4", "episode", "Highheels", "The Lone Ranger TV Show", 1, 10, 1296090],
	]);
	assert.deepStrictEqual(it.item.children[0].artwork, {
		thumb: IA + "/download/theloneranger_201705/theloneranger_201705.thumbs/s01e01_EntertheLoneRanger_000160.jpg",
		poster: IA + "/services/img/theloneranger_201705" });
	assert.strictEqual(it.item.children[1].artwork.thumb, IA + "/services/img/theloneranger_201705", "no thumbnail of its own");
	const list = await t.call("listItems", { sourceId: "acc-ia", parentId: "theloneranger_201705" });
	assert.deepStrictEqual([list.items.map((c) => c.id), list.nextCursor], [it.item.children.map((c) => c.id), null]);
	const one = await t.call("getItem", { sourceId: "acc-ia", itemId: "theloneranger_201705/s01e10_Highheels.mp4" });
	assert.deepStrictEqual([one.item.title, one.item.episode, one.item.playable], ["Highheels", 10, true]);
	const ep = await t.call("resolve", { sourceId: "acc-ia", itemId: "theloneranger_201705/s01e10_Highheels.mp4" });
	assert.deepStrictEqual(ep.stream.url, IA + "/download/theloneranger_201705/s01e10_Highheels.mp4");
	assert.deepStrictEqual(ep.stream.subtitles, [{ url: IA + "/download/theloneranger_201705/s01e10_Highheels.en.vtt", format: "vtt",
		default: false, label: "EN", lang: "en" }], "only its own: not another episode's");
	const ep1 = await t.call("resolve", { sourceId: "acc-ia", itemId: "theloneranger_201705/s01e01_EntertheLoneRanger.mp4" });
	assert.deepStrictEqual(ep1.stream.subtitles.map((s) => [s.label, s.format, s.lang]), [["s01e01_EntertheLoneRanger", "srt", undefined]]);
	const gone = await t.call("resolve", { sourceId: "acc-ia", itemId: "theloneranger_201705/s09e09.mp4" });
	assert.strictEqual(gone.errorCode, "NOT_FOUND");
	const gone2 = await t.call("getItem", { sourceId: "acc-ia", itemId: "theloneranger_201705/s09e09.mp4" });
	assert.strictEqual(gone2.errorCode, "NOT_FOUND");
	// The playable item itself: the longest title.
	const whole = await t.call("resolve", { sourceId: "acc-ia", itemId: "theloneranger_201705" });
	assert.strictEqual(whole.stream.url, IA + "/download/theloneranger_201705/s01e01_EntertheLoneRanger.mp4");
	t.stop();
});

test("renditions of one length are one title; a disc image's videos and a folder's file are their own; private files are not", async () => {
	const t = start();
	const it = await t.call("getItem", { sourceId: "acc-ia", itemId: "Sita_Sings_the_Blues" });
	assert.deepStrictEqual(it.item.children.map((c) => [c.id, c.title, c.kind, c.durationMs]), [
		["Sita_Sings_the_Blues/0_intro.mp4", "0 intro", "video", 30000],
		["Sita_Sings_the_Blues/DVD.mp4", "DVD", "video", 4894770],
		["Sita_Sings_the_Blues/DVD1.mp4", "DVD1", "video", 105260],
		["Sita_Sings_the_Blues/extras/The Trailer.mp4", "Trailer", "video", 120000],
		["Sita_Sings_the_Blues/Sita_Sings_the_Blues_480p_2150kbps.mp4", "Sita Sings the Blues 480p 2150kbps", "video", 4891240],
	]);
	const main = await t.call("resolve", { sourceId: "acc-ia", itemId: "Sita_Sings_the_Blues/Sita_Sings_the_Blues_480p_2150kbps.mp4" });
	assert.strictEqual(main.stream.url, IA + "/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_720p.mp4", "720 of 1080/720/480");
	assert.deepStrictEqual(main.stream.subtitles.map((s) => s.url), [IA + "/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_720p.asr.srt"],
		"the renditions' copies of the same captions once: those of the file played");
	const big = await t.call("resolve", { sourceId: "acc-ia", itemId: "Sita_Sings_the_Blues/Sita_Sings_the_Blues_480p_2150kbps.mp4", prefer: { maxHeight: 1080 } });
	assert.deepStrictEqual([big.stream.url, big.stream.subtitles.map((s) => s.url)], [IA + "/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_1080p.mp4",
		[IA + "/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_1080p.asr.srt"]]);
	const full = await t.call("resolve", { sourceId: "acc-ia", itemId: "Sita_Sings_the_Blues", prefer: { maxHeight: 1080 } });
	assert.strictEqual(full.stream.url, IA + "/download/Sita_Sings_the_Blues/DVD.mp4", "the longest title");
	const trailer = await t.call("resolve", { sourceId: "acc-ia", itemId: "Sita_Sings_the_Blues/extras/The Trailer.mp4" });
	assert.strictEqual(trailer.stream.url, IA + "/download/Sita_Sings_the_Blues/extras/The%20Trailer.mp4");
	const intro = await t.call("resolve", { sourceId: "acc-ia", itemId: "Sita_Sings_the_Blues/0_intro.mp4" });
	assert.deepStrictEqual([intro.stream.url, intro.stream.subtitles], [IA + "/download/Sita_Sings_the_Blues/0_intro.mp4", []], "a private subtitle file is not offered");
	const notes = await t.call("resolve", { sourceId: "acc-ia", itemId: "Sita_Sings_the_Blues/0_notes.mp4" });
	assert.strictEqual(notes.errorCode, "NOT_FOUND", "an .mp4 of no video format is no title");
	const hidden = await t.call("resolve", { sourceId: "acc-ia", itemId: "Sita_Sings_the_Blues/hidden.mp4" });
	assert.strictEqual(hidden.errorCode, "NOT_FOUND");
	t.stop();
});

test("what archive.org only lends, keeps dark or has no MP4 of is not played", async () => {
	const t = start();
	for (const [id, code, text] of [
		["lent", "SERVER_ERROR", "The Internet Archive only lends this item; it cannot be played here."],
		["library", "SERVER_ERROR", "The Internet Archive only lends this item; it cannot be played here."],
		["dark", "NOT_FOUND", "The Internet Archive does not have this item any more."],
		["empty", "NOT_FOUND", "The Internet Archive does not have this item any more."],
		["noplay", "SERVER_ERROR", "The Internet Archive has no MP4 of this item to play."],
	]) {
		const r = await t.call("resolve", { sourceId: "acc-ia", itemId: id });
		assert.deepStrictEqual([r.errorCode, r.errorText], [code, text], id);
	}
	for (const id of ["lent", "library", "dark"]) {
		assert.strictEqual((await t.call("listItems", { sourceId: "acc-ia", parentId: id })).errorCode, id === "dark" ? "NOT_FOUND" : "SERVER_ERROR", id);
	}
	assert.strictEqual((await t.call("getItem", { sourceId: "acc-ia", itemId: "noplay" })).errorCode, "NOT_FOUND");
	const missing = await t.call("resolve", { sourceId: "acc-ia", itemId: "missing" });
	assert.strictEqual(missing.errorCode, "NOT_FOUND");
	const before = t.requests.length;
	for (const id of ["../etc", "a b", "-lead", "x".repeat(101)]) {
		assert.strictEqual((await t.call("resolve", { sourceId: "acc-ia", itemId: id })).errorCode, "NOT_FOUND", id);
	}
	assert.strictEqual(t.requests.length, before, "no identifier: nothing asked");
	t.stop();
});

test("the metadata kept: for ten minutes, at most forty items, only the files used", async (c) => {
	const p = T.createProvider();
	let calls = 0;
	const http = { json: async (o) => { calls++; const id = o.url.split("/").pop(); return FILMS[id] || { metadata: { identifier: id }, files: [] }; } };
	const ctx = { http };
	await p.getItem(ctx, { itemId: "his_girl_friday" }).catch(() => null);
	await p.resolve(ctx, { itemId: "his_girl_friday", prefer: { maxHeight: 720 } });
	assert.strictEqual(calls, 1);
	assert.deepStrictEqual(p._test.cache.get("his_girl_friday").meta.files.map((x) => x.name), [
		"his_girl_friday.mpeg", "his_girl_friday.mp4", "his_girl_friday_512kb.mp4", "his_girl_friday.asr.srt",
		"his_girl_friday.thumbs/his_girl_friday_000001.jpg"]);
	const now = Date.now();
	c.mock.method(Date, "now", () => now + 10 * 60 * 1000 + 1);
	await p.resolve(ctx, { itemId: "his_girl_friday", prefer: { maxHeight: 720 } });
	assert.strictEqual(calls, 2, "asked again after ten minutes");
	for (let i = 0; i < 45; i++) { await p.getItem(ctx, { itemId: "item" + i }); }
	assert.strictEqual(p._test.cache.size, 40);
	assert.ok(!p._test.cache.has("his_girl_friday") && p._test.cache.has("item44"), "the oldest goes first");
	p._test.reset();
	assert.strictEqual(p._test.cache.size, 0);
});

test("lengthMs, plain, str, nameOf", () => {
	assert.deepStrictEqual(["1:31:44", "01:14:43", "20:33", "91:44", "108 min", "1 hr 20 min", "2h", "approx. 90 minutes", "5504.57", "", "n/a", "00:00"]
		.map((s) => T.lengthMs(s)), [5504000, 4483000, 1233000, 5504000, 6480000, 4800000, 7200000, 5400000, 5504570, 0, 0, 0]);
	assert.strictEqual(T.lengthMs("90", 60000), 5400000);
	assert.strictEqual(T.plain("a<script>x</script>&lt;b&gt; &#65;&#x42; &NBSP;&quot;"), "ax<b> AB \"");
	assert.strictEqual(T.plain("<div>one</div><div>two</div>\n\n\n\nthree"), "one\ntwo\n\nthree");
	assert.deepStrictEqual([T.str(["a", 1, null, {}]), T.str(7), T.str(null), T.str({})], ["a, 1", "7", "", ""]);
	assert.deepStrictEqual(["S01E03.mp4", "Night.Of.The.Living.Dead.mp4", "McLintock_1963.mp4", "dir/s2e5 - Pilot.mp4", "s01e1000.mp4"].map(T.nameOf),
		["S01E03", "Night Of The Living Dead", "McLintock 1963", "Pilot", "s01e1000"]);
	assert.strictEqual(T.downloadUrl("id", "a dir/b#c?.mp4"), IA + "/download/id/a%20dir/b%23c%3F.mp4");
});

test("refusal: dark, no metadata, restricted, any lending collection", () => {
	assert.deepStrictEqual([null, {}, { is_dark: true, metadata: {} }].map(T.refusal), ["gone", "gone", "gone"]);
	assert.strictEqual(T.refusal({ metadata: { "access-restricted-item": true } }), "lent");
	for (const c of T.LENDING) { assert.strictEqual(T.refusal({ metadata: { collection: c } }), "lent", c); }
	assert.strictEqual(T.refusal({ metadata: { collection: ["feature_films"], "access-restricted-item": "false" } }), "");
});

test("pickFile: tallest that fits, then the most compatible format; unknown heights before too tall ones", () => {
	const a = { name: "a.mp4", format: "MPEG4", height: "480" }, b = { name: "b.mp4", format: "h.264", height: "480" };
	const u = { name: "u.mp4", format: "512Kb MPEG4", height: "" }, big = { name: "big.mp4", format: "h.264", height: "1080" };
	assert.strictEqual(T.pickFile([a, b, big], 720), b);
	assert.strictEqual(T.pickFile([big, u], 720), u);
	assert.strictEqual(T.pickFile([big, { name: "c.mp4", format: "MPEG4", height: "2160" }], 720), big);
	assert.strictEqual(T.pickFile([], 720), null);
});

test("the template names the capability, the service and the sign-in app; the icons are there", () => {
	const dir = path.join(__dirname, "../../video/archive/account", TEMPLATE);
	const [t] = JSON.parse(fs.readFileSync(path.join(dir, TEMPLATE + ".json"), "utf8"));
	assert.strictEqual(t.templateId, TEMPLATE);
	assert.strictEqual(t.loc_name, "Internet Archive");
	assert.deepStrictEqual(t.validator, { customUI: { appId: "org.webosports.app.videoauth", name: "validator.html" },
		address: "palm://org.webosports.service.videos/login" });
	for (const k of ["readPermissions", "writePermissions"]) {
		assert.deepStrictEqual(t[k], ["org.webosports.service.videos", "org.webosports.app.videoauth"]);
	}
	const cp = t.capabilityProviders[0];
	assert.deepStrictEqual([cp.capability, cp.capabilitySubtype, cp.id], [service.Config.CAPABILITY, "STREAMING", TEMPLATE + ".streaming"]);
	for (const i of Object.values(t.icon).concat(Object.values(cp.icon))) { assert.ok(fs.existsSync(path.join(dir, i)), i); }
	assert.ok(fs.existsSync(path.join(__dirname, "../../video/_core/apps/org.webosports.app.videoauth/images/connectors/archive.png")));
	assert.ok(service.Config.PROVIDERS.includes("archive"));
	assert.strictEqual(archive.templateId, TEMPLATE);
});

test("the sign-in card: nothing to type, Add calls login with the template only", () => {
	let proto = null;
	const win = { setTimeout() { return 0; }, clearTimeout() {} };
	const enyo = { kind(def) { proto = def; }, bind: (self, fn) => fn.bind(self), VFlexBox: {}, windowParams: { template: { templateId: TEMPLATE, loc_name: "Internet Archive" } } };
	win.window = win;
	win.enyo = enyo;
	vm.createContext(win);
	vm.runInContext(fs.readFileSync(path.join(__dirname, "../../video/_core/apps/org.webosports.app.videoauth/source/videoAuth.js"), "utf8"), win);
	const card = Object.create(proto);
	card.inherited = () => {};
	card.log = () => {};
	card.$ = new Proxy({}, { get(o, k) {
		if (!o[k]) {
			const c = { showing: false, calls: [], value: "" };
			for (const m of ["setContent", "setCaption", "setActive", "setDisabled", "setHint", "setSrc", "setItems", "setValue", "init"]) {
				c[m] = (v) => { c[m.slice(3).toLowerCase() || m] = v; };
			}
			c.setShowing = (v) => { c.showing = !!v; };
			c.show = () => { c.showing = true; };
			c.hide = () => { c.showing = false; };
			c.getValue = () => c.value;
			c.call = (params, opts) => { c.calls.push({ params, opts }); };
			o[k] = c;
		}
		return o[k];
	} });
	card.showError = function (s) { this.lastError = s; };
	card.create();
	assert.strictEqual(card.kindId, "archive");
	assert.strictEqual(card.$.headerIcon.src, "images/connectors/archive.png");
	assert.match(card.$.bodyText.content, /nothing to sign in to/);
	assert.strictEqual(card.$.primaryButton.caption, "Add");
	for (const g of ["serverGroup", "usernameGroup", "passwordGroup", "urlGroup", "nameGroup", "instanceGroup", "catalogGroup"]) {
		assert.strictEqual(card.$[g].showing, false, g);
	}
	card.primaryTap();
	assert.deepStrictEqual(JSON.parse(JSON.stringify(card.$.svc.calls.map((c) => [c.params, c.opts.method]))), [[{ templateId: TEMPLATE }, "login"]]);
});
