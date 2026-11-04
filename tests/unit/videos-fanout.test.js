// node --test tests/unit
// Emby (video/emby/provider, Jellyfin's provider with Emby's differences), and the methods that
// ask every source at once: continueWatching and searchAll. The service runs as the launcher runs
// it, on a stand-in palmbus whose Accounts service holds a Jellyfin, an Emby and a PeerTube
// account, with a stand-in fetch that plays Jellyfin 12.4, Emby 4.10.2 and PeerTube 7.3 (shapes
// taken from the live servers on 2026-11-03 and 2026-11-04).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../video/_core/service/org.webosports.service.videos");
const service = require(SVC);
const C = require(path.join(SVC, "contract.js"));
const jellyfin = require("../../video/jellyfin/provider");
const emby = require("../../video/emby/provider");
const plex = require("../../video/plex/provider");
const upnp = require("../../video/upnp/provider");

const VIDEOS = { appId: "org.webosports.app.videoplayer 1234" };
const AUTH = { appId: "org.webosports.app.videoauth 999" };
const STRANGER = { appId: "com.example.evil 1" };

const JF = "http://jf.example.test:8096";
const EM = "http://emby.example.test:8096";
const PT = "https://pt.example.test";
const TOKEN = "tok-unit-test-not-a-credential";

const ACCOUNTS = [
	{ _id: "acc-jf", templateId: "org.webosports.video.jellyfin", username: "alice@jf", alias: "Jellyfin – Home" },
	{ _id: "acc-em", templateId: "org.webosports.video.emby", username: "alice@emby", alias: "Emby – Den" },
	{ _id: "acc-pt", templateId: "org.webosports.video.peertube", username: "pt.example.test", alias: "Tube" },
];
const CREDS = {
	"acc-jf": { accessToken: TOKEN, server: JF, userId: "u1", deviceId: "luneos-abc", serverId: "s1", serverName: "Home", username: "alice" },
	"acc-em": { accessToken: TOKEN, server: EM, userId: "eu1", deviceId: "luneos-def", serverId: "es1", serverName: "Den", username: "alice" },
	"acc-pt": { server: PT, name: "Tube" },
};

function item(o) {
	return Object.assign({ ImageTags: { Primary: "tag-" + o.Id }, BackdropImageTags: [], UserData: { PlaybackPositionTicks: 0, Played: false } }, o);
}
const played = (ticks, at) => ({ PlaybackPositionTicks: ticks, Played: false, PlayCount: 1, LastPlayedDate: at });

// Jellyfin: watched an episode at 18:00 and a film at 16:00.
const JF_EP = item({ Id: "je1", Name: "Pilot", Type: "Episode", SeriesId: "jsh", SeriesName: "Test Show", ParentIndexNumber: 1, IndexNumber: 1,
	RunTimeTicks: 600000000, UserData: played(150000000, "2026-11-04T18:00:00.0000000Z") });
const JF_MOVIE = item({ Id: "jm1", Name: "Night Train", Type: "Movie", RunTimeTicks: 900000000, UserData: played(300000000, "2026-11-04T16:00:00.0000000Z") });
// Emby: a film at 17:00, and one with no time (as a server that never says).
const EM_MOVIE = item({ Id: "10", Name: "Harbour Lights", Type: "Movie", RunTimeTicks: 600000000, ServerId: "es1",
	UserData: played(150000000, "2026-11-04T17:00:00.0000000Z") });
const EM_UNDATED = item({ Id: "11", Name: "Old Reel", Type: "Movie", RunTimeTicks: 600000000, UserData: { PlaybackPositionTicks: 100000000, Played: false } });

function jellyfinRoutes(over = {}) {
	const o = JF.replace(/[.]/g, "\\.");
	return [
		["GET", new RegExp("^" + o + "/System/Info/Public$"), () => ({ body: { Id: "s1", ServerName: "Home", ProductName: "Jellyfin Server", Version: "12.4.0" } })],
		["POST", new RegExp("^" + o + "/Users/AuthenticateByName$"), () => ({ body: { AccessToken: "jf-token", User: { Id: "u9" } } })],
		["GET", new RegExp("^" + o + "/UserItems/Resume\\?"), () => over.resume ? over.resume() : ({ body: { Items: [JF_EP, JF_MOVIE], TotalRecordCount: 2 } })],
		["GET", new RegExp("^" + o + "/Items\\?"), (r) => over.search ? over.search(r) : ({ body: { Items: [JF_MOVIE], TotalRecordCount: 1 } })],
	];
}

// What Emby 4.10.2 answers; the calls Jellyfin has at the top level are 404 here, as there.
function embyRoutes(over = {}) {
	const o = EM.replace(/[.]/g, "\\.");
	const items = { 10: EM_MOVIE, 11: EM_UNDATED };
	return [
		["GET", new RegExp("^" + o + "/System/Info/Public$"), () => over.info || ({ body: { Id: "es1", ServerName: "Den", Version: "4.10.2.0", LocalAddresses: [], RemoteAddresses: [] } })],
		["POST", new RegExp("^" + o + "/Users/AuthenticateByName$"), (r) => JSON.parse(r.body).Pw === "right"
			? { body: { AccessToken: "emby-token", User: { Id: "eu9" }, ServerId: "es1" } } : { status: 401, body: "" }],
		["GET", new RegExp("^" + o + "/Users/eu1/Views\\?"), () => ({ body: { Items: [{ Id: "3", Name: "Movies", CollectionType: "movies" },
			{ Id: "5", Name: "Shows", CollectionType: "tvshows" }] } })],
		["GET", new RegExp("^" + o + "/Users/eu1/Items/Resume\\?"), (r) => over.resume ? over.resume(r) : ({ body: { Items: [EM_UNDATED, EM_MOVIE], TotalRecordCount: 2 } })],
		["GET", new RegExp("^" + o + "/Users/eu1/Items/Latest\\?"), () => ({ body: [EM_MOVIE] })],
		["GET", new RegExp("^" + o + "/Users/eu1/Items/(\\w+)\\?"), (r) => {
			const id = /\/Items\/(\w+)\?/.exec(r.url)[1];
			return items[id] ? { body: items[id] } : { status: 404, body: "" };
		}],
		["POST", new RegExp("^" + o + "/Items/10/PlaybackInfo\\?"), () => over.playback ? over.playback() : ({ body: { PlaySessionId: "eps1", MediaSources: [{
			Id: "mediasource_10", SupportsDirectPlay: true, SupportsDirectStream: true, MediaStreams: [
				{ Type: "Subtitle", Language: "eng", DeliveryMethod: "External", DeliveryUrl: "/Videos/10/mediasource_10/Subtitles/2/0/Stream.srt?api_key=" + TOKEN }] }] } })],
		["GET", new RegExp("^" + o + "/Items\\?"), (r) => over.search ? over.search(r) : ({ body: { Items: [EM_MOVIE], TotalRecordCount: 1 } })],
		["GET", new RegExp("^" + o + "/Shows/NextUp\\?"), () => ({ body: { Items: [], TotalRecordCount: 0 } })],
		["POST", new RegExp("^" + o + "/Sessions/Playing(/Progress|/Stopped)?$"), (r) => over.started && !/Progress|Stopped/.test(r.url) ? over.started(r)
			: (JSON.parse(r.body).PlaySessionId ? { status: 204 } : { status: 400, body: "Value cannot be null. (Parameter 'key')" })],
		// Jellyfin's top-level calls: not on Emby.
		["GET", new RegExp("^" + o + "/(UserViews|UserItems/Resume|Items/Latest|Items/\\w+)\\?"), () => ({ status: 404, body: "" })],
	];
}

const PT_VIDEO = { uuid: "uu-1", shortUUID: "s1", name: "Harbour Lights", duration: 60, isLive: false, nsfw: false,
	thumbnailPath: "/t.jpg", previewPath: "/p.jpg", url: PT + "/videos/watch/uu-1", channel: { displayName: "Main" } };
function peertubeRoutes(over = {}) {
	return [
		["GET", /pt\.example\.test\/api\/v1\/search\/videos\?/, () => over.search ? over.search() : ({ body: { total: 1, data: [PT_VIDEO] } })],
	];
}

function start({ routes, accounts = ACCOUNTS, creds = CREDS, logs = [], fanOutMs = 300 } = {}) {
	const pb = fakePalmbus({ onCall: (uri, args) => {
		if (uri.endsWith("/listAccounts")) { return { returnValue: true, results: accounts }; }
		if (uri.endsWith("/readCredentials")) {
			return creds[args.accountId] ? { returnValue: true, credentials: creds[args.accountId] } : { returnValue: false, errorCode: "NOT_FOUND" };
		}
		return { returnValue: true };
	} });
	const { fetch, requests } = fakeFetch(routes || jellyfinRoutes().concat(embyRoutes(), peertubeRoutes()));
	const log = { log: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)), warn: (s) => logs.push(String(s)) };
	const s = service.start({ palmbus: pb, fetch, ssdp: { search: async () => [] }, idleMs: 0, exit: () => {}, log, fanOutMs,
		timeouts: { timeoutMs: 2000, idleTimeoutMs: 2000 }, random: (n) => Buffer.alloc(n, 7) });
	return { call: (m, p, who = VIDEOS) => ask(pb.handles[0], m, p, who), requests, logs, stop: () => s.bus.stop() };
}

// --- Emby ---------------------------------------------------------------------------------------

test("Emby: signs in at a server with no ProductName, and is listed as its own kind", async () => {
	const t = start();
	const r = await t.call("login", { templateId: "org.webosports.video.emby", server: EM, username: "alice", password: "right" }, AUTH);
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.strictEqual(r.alias, "Emby – Den");
	assert.strictEqual(r.username, "alice@emby.example.test:8096");
	assert.deepStrictEqual(r.credentials, { common: { accessToken: "emby-token", server: EM, userId: "eu9",
		deviceId: "luneos-" + "07".repeat(12), serverId: "es1", serverName: "Den", username: "alice" } });
	const wrong = await t.call("login", { templateId: "org.webosports.video.emby", server: EM, username: "alice", password: "no" }, AUTH);
	assert.strictEqual(wrong.errorCode, "BAD_ARGS");
	const src = (await t.call("listSources", {})).sources.find((s) => s.sourceId === "acc-em");
	assert.deepStrictEqual([src.provider, src.label, src.features], ["emby", "Den", { search: true, progress: true, continueWatching: true, live: false }]);
	t.stop();
});

test("Emby and Jellyfin each send the user to the other's account for the other's server", async () => {
	const t = start();
	const j = await t.call("login", { templateId: "org.webosports.video.jellyfin", server: EM, username: "a", password: "b" }, AUTH);
	assert.strictEqual(j.errorCode, "BAD_ARGS");
	assert.match(j.errorText, /Emby server.*Emby account/);
	const e = await t.call("login", { templateId: "org.webosports.video.emby", server: JF, username: "a", password: "b" }, AUTH);
	assert.strictEqual(e.errorCode, "BAD_ARGS");
	assert.match(e.errorText, /Jellyfin server.*Jellyfin account/);
	assert.strictEqual(t.requests.filter((x) => /Authenticate/.test(x.url)).length, 0, "no password went to the wrong kind");
	t.stop();
});

test("Emby: something that is neither is no server, and says nothing of either kind", async () => {
	const t = start({ routes: embyRoutes({ info: { body: { Id: "x", ProductName: "Some NAS" } } }) });
	const r = await t.call("login", { templateId: "org.webosports.video.emby", server: EM, username: "a", password: "b" }, AUTH);
	assert.strictEqual(r.errorCode, "BAD_ARGS");
	assert.strictEqual(r.errorText, "There is no Emby server at that address.");
	t.stop();
});

test("Emby: libraries, resume list, latest and items come from under /Users/{id}/", async () => {
	const t = start();
	const s = await t.call("listSections", { sourceId: "acc-em" });
	assert.deepStrictEqual(s.sections.map((x) => x.id), ["continue", "nextup", "latest", "view:3:movies", "view:5:tvshows"]);
	const c = await t.call("listItems", { sourceId: "acc-em", sectionId: "continue" });
	assert.deepStrictEqual(c.items.map((x) => x.id), ["11", "10"]);
	const q = new URL(t.requests.find((x) => /Items\/Resume/.test(x.url)).url).searchParams;
	assert.strictEqual(q.get("MediaTypes"), "Video", "Emby lists nothing to resume without it");
	assert.match(q.get("Fields"), /(^|,)UserDataLastPlayedDate(,|$)/, "Emby leaves the time out unless asked");
	assert.deepStrictEqual((await t.call("listItems", { sourceId: "acc-em", sectionId: "latest" })).items.map((x) => x.id), ["10"]);
	const g = await t.call("getItem", { sourceId: "acc-em", itemId: "10" });
	assert.strictEqual(g.item.title, "Harbour Lights");
	assert.strictEqual(g.item.webUrl, EM + "/web/index.html#!/item?id=10&serverId=es1");
	assert.strictEqual(g.item.lastPlayedAt, "2026-11-04T17:00:00.000Z");
	assert.deepStrictEqual(g.item.progress, { positionMs: 15000, watched: false });
	assert.strictEqual(t.requests.filter((x) => /^\/(UserViews|UserItems|Items\/Latest)\b/.test(new URL(x.url).pathname)).length, 0);
	t.stop();
});

test("Emby: a direct link carries the token as api_key; the session goes back with the progress", async () => {
	const t = start();
	const r = await t.call("resolve", { sourceId: "acc-em", itemId: "10" });
	const u = new URL(r.stream.url);
	assert.strictEqual(u.origin + u.pathname, EM + "/Videos/10/stream");
	assert.strictEqual(u.searchParams.get("api_key"), TOKEN);
	assert.strictEqual(u.searchParams.get("ApiKey"), null, "Emby answers 401 to ApiKey");
	assert.strictEqual(r.stream.subtitles[0].url, EM + "/Videos/10/mediasource_10/Subtitles/2/0/Stream.vtt?api_key=" + TOKEN);
	assert.strictEqual(r.stream.startMs, 15000);
	const started = t.requests.filter((x) => /\/Sessions\/Playing$/.test(x.url));
	assert.strictEqual(started.length, 1, "Emby is told playback starts: it keeps no time last played otherwise");
	assert.deepStrictEqual(Object.fromEntries(Object.entries(JSON.parse(started[0].body)).filter(([k]) => ["ItemId", "PlaySessionId", "MediaSourceId", "PositionTicks"].includes(k))),
		{ ItemId: "10", PlaySessionId: "eps1", MediaSourceId: "mediasource_10", PositionTicks: 150000000 });
	const p = await t.call("reportProgress", { sourceId: "acc-em", itemId: "10", positionMs: 20000, state: "paused", session: r.stream.session });
	assert.strictEqual(p.returnValue, true, JSON.stringify(p));
	const body = JSON.parse(t.requests.find((x) => /Sessions\/Playing\/Progress/.test(x.url)).body);
	assert.deepStrictEqual([body.PlaySessionId, body.MediaSourceId, body.PositionTicks, body.IsPaused], ["eps1", "mediasource_10", 200000000, true]);
	t.stop();
});

test("Emby: the start not taken still plays; Jellyfin is not told at resolve", async () => {
	const logs = [];
	const t = start({ logs, routes: jellyfinRoutes().concat(embyRoutes({ started: () => ({ status: 500, body: "no" }) })) });
	const r = await t.call("resolve", { sourceId: "acc-em", itemId: "10" });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.ok(logs.some((l) => /emby: playback start not taken: 500/.test(l)), logs.join("\n"));
	t.stop();
	const t2 = start({ routes: jellyfinRoutes().concat([
		["POST", /jf\.example\.test:8096\/Items\/jm1\/PlaybackInfo\?/, () => ({ body: { PlaySessionId: "jp", MediaSources: [{ Id: "jms", SupportsDirectStream: true }] } })],
		["GET", /jf\.example\.test:8096\/Items\/jm1\?/, () => ({ body: JF_MOVIE })],
		["POST", /jf\.example\.test:8096\/Sessions\/Playing$/, () => ({ status: 204 })]]) });
	const jr = await t2.call("resolve", { sourceId: "acc-jf", itemId: "jm1" });
	assert.strictEqual(jr.returnValue, true, JSON.stringify(jr));
	assert.strictEqual(t2.requests.filter((x) => /\/Sessions\/Playing$/.test(x.url)).length, 0);
	await t2.call("listItems", { sourceId: "acc-jf", sectionId: "continue" });
	const q = new URL(t2.requests.find((x) => /\/UserItems\/Resume\?/.test(x.url)).url).searchParams;
	assert.ok(/Overview/.test(q.get("Fields")), q.get("Fields"));
	assert.ok(!/UserDataLastPlayedDate/.test(q.get("Fields")), "Jellyfin is not asked for a field it does not have");
	t2.stop();
});

test("Emby: a transcode is Emby's own link under the server", async () => {
	const t = start({ routes: embyRoutes({ playback: () => ({ body: { PlaySessionId: "eps2", MediaSources: [{ Id: "mediasource_10",
		TranscodingUrl: "/videos/10/master.m3u8?DeviceId=d&MediaSourceId=mediasource_10&api_key=" + TOKEN, TranscodingSubProtocol: "hls" }] } }) }) });
	const r = await t.call("resolve", { sourceId: "acc-em", itemId: "10" });
	assert.strictEqual(r.stream.protocol, "hls");
	assert.strictEqual(r.stream.url, EM + "/videos/10/master.m3u8?DeviceId=d&MediaSourceId=mediasource_10&api_key=" + TOKEN);
	assert.strictEqual(r.stream.session.method, "Transcode");
	t.stop();
});

test("Emby and Jellyfin variants: what differs, and Jellyfin left as it was", () => {
	const { JELLYFIN, EMBY, toItem } = jellyfin._test;
	assert.strictEqual(jellyfin.id, "jellyfin");
	assert.strictEqual(emby.id, "emby");
	assert.strictEqual(emby.templateId, "org.webosports.video.emby");
	assert.strictEqual(JELLYFIN.item("u", "a/b"), "/Items/a%2Fb");
	assert.strictEqual(EMBY.item("u 1", "a/b"), "/Users/u%201/Items/a%2Fb");
	assert.strictEqual(EMBY.isServer({ Id: "x" }), true);
	assert.strictEqual(EMBY.isServer({ Id: "x", ProductName: "Jellyfin Server" }), false);
	assert.strictEqual(JELLYFIN.isServer({ Id: "x" }), false);
	assert.strictEqual(JELLYFIN.isServer({ Id: "x", ProductName: "Jellyfin Server" }), true);
	const ctx = { creds: { server: JF, serverId: "s1" } };
	assert.strictEqual(toItem(ctx, JF_MOVIE).webUrl, JF + "/web/#/details?id=jm1");
	assert.strictEqual(toItem(ctx, JF_MOVIE).lastPlayedAt, "2026-11-04T16:00:00.0000000Z");
	assert.strictEqual(toItem(ctx, JF_MOVIE, EMBY).webUrl, JF + "/web/index.html#!/item?id=jm1&serverId=s1");
});

// --- lastPlayedAt -------------------------------------------------------------------------------

test("contract: lastPlayedAt is kept as ISO time; never-played markers and junk go", () => {
	const base = { id: "x", title: "X" };
	const at = (v) => C.item(Object.assign({ lastPlayedAt: v }, base)).lastPlayedAt;
	assert.strictEqual(at("2026-11-04T17:00:00.0000000Z"), "2026-11-04T17:00:00.000Z");
	assert.strictEqual(at(1793898000000), new Date(1793898000000).toISOString());
	assert.strictEqual(at("0001-01-01T00:00:00.0000000Z"), undefined);
	assert.strictEqual(at(0), undefined);
	assert.strictEqual(at("yesterday"), undefined);
	// Too long to be a time, though Date.parse takes it.
	const long = "Wed, 04 Nov 2026 17:00:00 GMT".padEnd(95, " ");
	assert.ok(isFinite(Date.parse(long)));
	assert.strictEqual(at(long), undefined);
	assert.strictEqual(at({}), undefined);
	assert.strictEqual(at(Infinity), undefined);
	assert.strictEqual(at(9e15), undefined);
	assert.ok(!("lastPlayedAt" in C.item(base)));
});

test("Plex: lastViewedAt (seconds) is the item's lastPlayedAt", () => {
	const s = { base: "http://192.168.1.10:32400", token: "", machineId: "m" };
	const m = { ratingKey: 5, type: "movie", title: "M", lastViewedAt: 1793898000 };
	assert.strictEqual(C.item(plex._test.toItem(s, m)).lastPlayedAt, new Date(1793898000 * 1000).toISOString());
	assert.strictEqual(C.item(plex._test.toItem(s, Object.assign({}, m, { lastViewedAt: undefined }))).lastPlayedAt, undefined);
});

// --- continueWatching ---------------------------------------------------------------------------

test("continueWatching: every source that keeps a place, the last watched first, each with its source", async () => {
	const t = start();
	const r = await t.call("continueWatching", {});
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(r.items.map((x) => [x.sourceId, x.id]), [["acc-jf", "je1"], ["acc-em", "10"], ["acc-jf", "jm1"], ["acc-em", "11"]]);
	assert.deepStrictEqual(r.failed, []);
	assert.strictEqual(r.items[0].lastPlayedAt, "2026-11-04T18:00:00.000Z");
	assert.strictEqual(r.items[3].lastPlayedAt, undefined, "no time: after those with one");
	assert.strictEqual(t.requests.filter((x) => /pt\.example\.test/.test(x.url)).length, 0, "PeerTube keeps no place: not asked");
	assert.deepStrictEqual((await t.call("continueWatching", { limit: 2 })).items.map((x) => x.id), ["je1", "10"]);
	t.stop();
});

test("continueWatching: only the sources asked for; one unknown is answered as failed", async () => {
	const t = start();
	const r = await t.call("continueWatching", { sourceIds: ["acc-em", "acc-nope", "acc-em", 7] });
	assert.deepStrictEqual(r.items.map((x) => x.id), ["10", "11"]);
	assert.deepStrictEqual(r.failed.map((f) => [f.sourceId, f.errorCode]), [["acc-nope", "NO_SOURCE"]]);
	assert.strictEqual(t.requests.filter((x) => x.url.startsWith(JF)).length, 0);
	t.stop();
});

test("continueWatching: a failing source and a slow one do not hold up the rest", async () => {
	let release;
	const slow = new Promise((resolve) => { release = resolve; });
	const t = start({ fanOutMs: 200, routes: jellyfinRoutes({ resume: () => slow })
		.concat(embyRoutes({ resume: () => ({ status: 500, body: "boom" }) }), peertubeRoutes()) });
	const t0 = Date.now();
	const r = await t.call("continueWatching", {});
	assert.ok(Date.now() - t0 < 1500, "answered within the time limit");
	assert.deepStrictEqual(r.items, []);
	assert.deepStrictEqual(r.failed.map((f) => [f.sourceId, f.errorCode]).sort(), [["acc-em", "SERVER_ERROR"], ["acc-jf", "SERVER_UNREACHABLE"]]);
	release({ body: { Items: [] } });
	t.stop();
});

test("continueWatching: a provider's own bug is a server error, with nothing of it answered or logged", async () => {
	const logs = [];
	const t = start({ logs, routes: jellyfinRoutes({ resume: () => ({ body: { Items: [{ Id: "x", Type: "Movie", Name: "N", get UserData() { throw new Error("secret " + TOKEN); } }] } }) })
		.concat(embyRoutes({ resume: () => ({ body: null }) }), peertubeRoutes()) });
	const r = await t.call("continueWatching", {});
	const em = r.failed.find((f) => f.sourceId === "acc-em");
	assert.deepStrictEqual(em, { sourceId: "acc-em", errorCode: "SERVER_ERROR", errorText: "" });
	assert.ok(!JSON.stringify(r).includes(TOKEN));
	assert.ok(!logs.join("\n").includes(TOKEN));
	assert.ok(logs.some((l) => /acc-em failed: TypeError/.test(l)), logs.join("\n"));
	t.stop();
});

test("continueWatching and searchAll are Videos' only", async () => {
	const t = start();
	for (const m of ["continueWatching", "searchAll"]) {
		const r = await t.call(m, { query: "x" }, STRANGER);
		assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m);
	}
	assert.strictEqual(t.requests.length, 0);
	t.stop();
});

// --- searchAll ----------------------------------------------------------------------------------

test("searchAll: each source that can search, in the order of the sources, with what it found", async () => {
	const t = start();
	const r = await t.call("searchAll", { query: "harbour", limit: 3 });
	assert.strictEqual(r.returnValue, true, JSON.stringify(r));
	assert.deepStrictEqual(r.results.map((x) => [x.sourceId, x.items.map((i) => i.title)]),
		[["acc-jf", ["Night Train"]], ["acc-em", ["Harbour Lights"]], ["acc-pt", ["Harbour Lights"]]]);
	assert.strictEqual(r.results[1].items[0].webUrl, EM + "/web/index.html#!/item?id=10&serverId=es1", "Emby's own web app");
	assert.deepStrictEqual(r.failed, []);
	for (const re of [/jf\.example\.test:8096\/Items\?/, /emby\.example\.test:8096\/Items\?/]) {
		const q = new URL(t.requests.find((x) => re.test(x.url)).url).searchParams;
		assert.deepStrictEqual([q.get("searchTerm"), q.get("Limit")], ["harbour", "3"]);
	}
	t.stop();
});

test("searchAll: needs a query; a source with nothing found is left out; one that fails is said", async () => {
	const t = start({ routes: jellyfinRoutes({ search: () => ({ body: { Items: [], TotalRecordCount: 0 } }) })
		.concat(embyRoutes({ search: () => ({ status: 401, body: "" }) }), peertubeRoutes()) });
	assert.strictEqual((await t.call("searchAll", { query: "  " })).errorCode, "MISSING_ARGS");
	assert.strictEqual((await t.call("searchAll", {})).errorCode, "MISSING_ARGS");
	const r = await t.call("searchAll", { query: "harbour" });
	assert.deepStrictEqual(r.results.map((x) => x.sourceId), ["acc-pt"]);
	assert.deepStrictEqual(r.failed.map((f) => [f.sourceId, f.errorCode]), [["acc-em", "AUTH_EXPIRED"]]);
	t.stop();
});

test("searchAll: a source that cannot search is not asked", async () => {
	// A media server found on the network that says it cannot search.
	const udn = "uuid:no-search";
	upnp._test.dir._set([{ udn, name: "Old DLNA", control: "http://192.168.50.21:8200/ctl/ContentDir", searchCaps: [] }]);
	const accounts = ACCOUNTS.concat([{ _id: "acc-up", templateId: "org.webosports.video.upnp", username: "local-network" }]);
	const t = start({ accounts, creds: Object.assign({ "acc-up": { kind: "upnp" } }, CREDS) });
	const r = await t.call("searchAll", { query: "harbour", sourceIds: ["acc-pt", "acc-up|" + udn] });
	assert.deepStrictEqual(r.results.map((x) => x.sourceId), ["acc-pt"]);
	assert.deepStrictEqual(r.failed, []);
	assert.strictEqual(t.requests.filter((x) => /192\.168\.50\.21/.test(x.url)).length, 0, "not asked at all");
	upnp._test.dir._set([]);
	t.stop();
});
