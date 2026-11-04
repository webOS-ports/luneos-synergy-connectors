// node --test tests/unit
// The Plex provider of org.webosports.service.videos, through the service as Videos calls it, on a
// stand-in palmbus and fetch. The server's answers have the shapes Plex Media Server 1.43.5 gave
// (plexinc/pms-docker, 2026-11-04); plex.tv's pin answer the shape plex.tv gave the same day. The
// /api/v2/user and /api/v2/resources shapes are not recorded (they need an account): they follow
// the fields the provider reads.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../video/_core/service/org.webosports.service.videos");
const service = require(SVC);
const plex = require("../../video/plex/provider");
const upnpLib = require("../../video/upnp/provider");

const VIDEOS = { appId: "org.webosports.app.videoplayer 1234" };
const AUTH = { appId: "org.webosports.app.videoauth 999" };

const TOKEN = "plex-unit-token-not-a-credential";
const SHARED_TOKEN = "plex-shared-token-not-a-credential";
const LAN = "https://192-168-1-20.abc.plex.direct:32400";
const WAN = "https://84-1-2-3.abc.plex.direct:32400";
const RELAY = "https://relay.abc.plex.direct:8443";
const OTHER = "https://10-0-0-5.def.plex.direct:32400";
const DIRECT = "http://192.168.1.20:32400";
const HOME_ID = "aaaa1111";
const FRIEND_ID = "bbbb2222";

const RESOURCES = [
	{ name: "Home", product: "Plex Media Server", provides: "server", clientIdentifier: HOME_ID, owned: true, accessToken: TOKEN,
		connections: [
			{ protocol: "https", uri: RELAY, local: false, relay: true },
			{ protocol: "https", uri: WAN, local: false, relay: false },
			{ protocol: "https", uri: LAN, local: true, relay: false }] },
	{ name: "Friend's", product: "Plex Media Server", provides: "server", clientIdentifier: FRIEND_ID, owned: false, accessToken: SHARED_TOKEN,
		connections: [{ protocol: "https", uri: OTHER, local: false, relay: false }] },
	{ name: "Phone", product: "Plex for Android", provides: "client,player", clientIdentifier: "cccc",
		connections: [{ protocol: "http", uri: "http://192.168.1.30:32500", local: true, relay: false }] },
];
const SERVERS = plex._test.serversOf(RESOURCES);

const ACCOUNTS = [
	{ _id: "acc-px", templateId: "org.webosports.video.plex", username: "alice", alias: "Plex – alice" },
	{ _id: "acc-pd", templateId: "org.webosports.video.plex", username: "plex@192.168.1.20:32400", alias: "Plex – Attic" },
];
const CREDS = {
	"acc-px": { mode: "plextv", accessToken: TOKEN, clientId: "luneos-c1", username: "alice", servers: SERVERS },
	"acc-pd": { mode: "direct", server: DIRECT, accessToken: "", clientId: "luneos-c2", machineId: "dddd", serverName: "Attic" },
};

// --- Plex Media Server, as recorded ----------------------------------------------------------

const MOVIE = { ratingKey: "2", key: "/library/metadata/2", type: "movie", title: "Night Train", year: 2024, duration: 90023,
	summary: "A train.", thumb: "/library/metadata/2/thumb/1", art: "/library/metadata/2/art/1", viewOffset: 30000,
	Media: [{ id: 2, height: 360, container: "mkv", videoCodec: "h264", audioCodec: "aac", Part: [{ id: 2,
		key: "/library/parts/2/1/file.mkv", container: "mkv", Stream: [
			{ id: 3, streamType: 1, codec: "h264" }, { id: 4, streamType: 2, codec: "aac" },
			{ id: 5, streamType: 3, codec: "srt", key: "/library/streams/5", languageCode: "eng", displayTitle: "English", default: true },
			{ id: 6, streamType: 3, codec: "ass", key: "/library/streams/6", languageCode: "ger" },
			{ id: 7, streamType: 3, codec: "pgs", languageCode: "fre" }] }] }] };
const TALL = Object.assign({}, MOVIE, { ratingKey: "9", title: "Tall", Media: [{ height: 2160, Part: [{ key: "/library/parts/9/1/file.mkv", Stream: [] }] }] });
const SHOW = { ratingKey: "3", type: "show", title: "Test Show", year: 2020, thumb: "/library/metadata/3/thumb/1", leafCount: 4, viewedLeafCount: 4, childCount: 2 };
const SEASON = { ratingKey: "4", type: "season", title: "Season 1", index: 1, parentTitle: "Test Show", parentThumb: "/library/metadata/3/thumb/1", leafCount: 3, viewedLeafCount: 1 };
const EPISODE = { ratingKey: "5", type: "episode", title: "Episode 1", index: 1, parentIndex: 1, grandparentTitle: "Test Show",
	grandparentThumb: "/library/metadata/3/thumb/1", thumb: "/library/metadata/5/thumb/1", duration: 40023, viewCount: 1 };
const ARTIST = { ratingKey: "8", type: "artist", title: "A band" };

const mc = (o) => ({ body: { MediaContainer: o } });

function serverRoutes(origin, over = {}) {
	const o = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const meta = { 2: MOVIE, 3: SHOW, 4: SEASON, 5: EPISODE, 9: TALL };
	return [
		["GET", new RegExp("^" + o + "/identity$"), () => over.identity ? over.identity() : mc({ machineIdentifier: "dddd", version: "1.43.5" })],
		["GET", new RegExp("^" + o + "/$"), () => over.root ? over.root() : mc({ friendlyName: "Attic" })],
		["GET", new RegExp("^" + o + "/library/sections$"), () => mc({ Directory: [
			{ key: "1", type: "movie", title: "Movies" }, { key: "2", type: "show", title: "Shows" }, { key: "3", type: "artist", title: "Music" }] })],
		["GET", new RegExp("^" + o + "/hubs/continueWatching/items\\?"), () => over.continue ? over.continue() : mc({ Metadata: [EPISODE, MOVIE] })],
		["GET", new RegExp("^" + o + "/library/onDeck\\?"), () => mc({ Metadata: [EPISODE] })],
		["GET", new RegExp("^" + o + "/library/recentlyAdded\\?"), () => mc({ Metadata: [MOVIE, SEASON, MOVIE] })],
		["GET", new RegExp("^" + o + "/library/sections/(\\d+)/all\\?"), (r) => {
			const u = new URL(r.url);
			const all = u.searchParams.get("type") === "2" ? [SHOW] : [MOVIE, Object.assign({}, MOVIE, { ratingKey: "22", title: "Harbour Lights" })];
			const from = Number(u.searchParams.get("X-Plex-Container-Start")), size = Number(u.searchParams.get("X-Plex-Container-Size"));
			return mc({ totalSize: all.length, Metadata: all.slice(from, from + size) });
		}],
		["GET", new RegExp("^" + o + "/library/metadata/3/children"), () => mc({ totalSize: 1, Metadata: [SEASON] })],
		["GET", new RegExp("^" + o + "/library/metadata/4/children"), () => mc({ totalSize: 1, Metadata: [EPISODE] })],
		["GET", new RegExp("^" + o + "/library/metadata/(\\d+)$"), (r) => {
			const m = meta[/metadata\/(\d+)$/.exec(r.url)[1]];
			return m ? mc({ Metadata: [m] }) : { status: 404, body: "" };
		}],
		["GET", new RegExp("^" + o + "/hubs/search\\?"), () => mc({ Hub: [
			{ type: "movie", Metadata: [MOVIE] }, { type: "artist", Metadata: [ARTIST] }, { type: "episode", Metadata: [EPISODE] }, { type: "show" }] })],
		["GET", new RegExp("^" + o + "/video/:/transcode/universal/decision\\?"), (r) => over.decision ? over.decision(r) : (() => {
			const direct = new URL(r.url).searchParams.get("directPlay") === "1";
			return mc({ generalDecisionCode: direct ? 1000 : 1001, Metadata: [{ Media: [{ Part: [direct
				? { decision: "directplay", key: "/library/parts/2/1/file.mkv" } : { decision: "transcode" }] }] }] });
		})()],
		["GET", new RegExp("^" + o + "/:/timeline\\?"), () => ({ status: 200, body: "" })],
		["GET", new RegExp("^" + o + "/:/scrobble\\?"), () => ({ status: 200, body: "" })],
		["GET", new RegExp("^" + o + "/video/:/transcode/universal/stop\\?"), () => over.stop ? over.stop() : ({ status: 200, body: "" })],
	];
}

function plexTvRoutes(over = {}) {
	return [
		["POST", /^https:\/\/plex\.tv\/api\/v2\/pins\?strong=false$/, () => ({ status: 201, body: { id: 4711, code: "AB12", expiresIn: 900, authToken: null } })],
		["GET", /^https:\/\/plex\.tv\/api\/v2\/pins\/4711$/, () => over.pin ? over.pin() : ({ body: { id: 4711, code: "AB12", authToken: TOKEN } })],
		["GET", /^https:\/\/plex\.tv\/api\/v2\/user$/, () => ({ body: { username: "alice", title: "Alice" } })],
		["GET", /^https:\/\/plex\.tv\/api\/v2\/resources\?/, () => over.resources ? over.resources() : ({ body: RESOURCES })],
	];
}

// The home server answers on its LAN address only; the friend's on its one address; plex.tv; and the
// server added by address.
const allRoutes = (o = {}) => plexTvRoutes(o.tv).concat(
	[["GET", new RegExp("^" + RELAY.replace(/\./g, "\\.") + "/"), () => { throw new Error("relay is down"); }],
		["GET", new RegExp("^" + WAN.replace(/\./g, "\\.") + "/"), () => { throw new Error("not reachable from here"); }]],
	serverRoutes(LAN, o.lan), serverRoutes(OTHER), serverRoutes(DIRECT, o.direct));

function start({ routes = allRoutes(), accounts = ACCOUNTS, creds = CREDS, logs = [] } = {}) {
	plex._test.reset();
	upnpLib._test.dir._set([]);
	const store = JSON.parse(JSON.stringify(creds));
	const writes = [];
	const pb = fakePalmbus({ onCall: (uri, args) => {
		if (uri.endsWith("/listAccounts")) { return { returnValue: true, results: accounts }; }
		if (uri.endsWith("/readCredentials")) {
			return store[args.accountId] ? { returnValue: true, credentials: store[args.accountId] } : { returnValue: false, errorCode: "NOT_FOUND" };
		}
		if (uri.endsWith("/writeCredentials")) { writes.push(args); store[args.accountId] = args.credentials; }
		return { returnValue: true };
	} });
	const { fetch, requests } = fakeFetch(routes);
	const log = { log: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)), warn: (s) => logs.push(String(s)) };
	const s = service.start({ palmbus: pb, fetch, ssdp: { search: async () => [] }, idleMs: 0, exit: () => {}, log,
		timeouts: { timeoutMs: 2000, idleTimeoutMs: 2000 }, random: (n) => Buffer.alloc(n, 7) });
	const handle = pb.handles[0];
	return { call: (m, p, who = VIDEOS) => ask(handle, m, p, who), requests, writes, store, logs, stop: () => s.bus.stop() };
}

const home = "acc-px|" + HOME_ID;
const PREFER = { maxHeight: 720, codecs: ["h264"], audioCodecs: ["aac", "mp3"] };

// --- signing in -------------------------------------------------------------------------------

test("plexPin asks plex.tv for a code under a new client id, and anyone may ask", async () => {
	const t = start();
	const r = await t.call("plexPin", {}, AUTH);
	assert.deepStrictEqual(r, { returnValue: true, pinId: "4711", code: "AB12", clientId: "luneos-070707070707070707070707", expiresIn: 900, linkUrl: "https://plex.tv/link" });
	const req = t.requests.find((q) => q.url.includes("/api/v2/pins"));
	assert.strictEqual(req.headers["X-Plex-Client-Identifier"], r.clientId);
	assert.strictEqual(req.headers["X-Plex-Product"], "LuneOS Videos");
	assert.strictEqual(req.headers["X-Plex-Token"], undefined);
	t.stop();
});

test("login with a pin: not linked yet says so; linked, it keeps the token and the servers", async () => {
	let linked = false;
	const t = start({ routes: allRoutes({ tv: { pin: () => ({ body: { id: 4711, authToken: linked ? TOKEN : null } }) } }) });
	const args = { templateId: "org.webosports.video.plex", pinId: "4711", clientId: "luneos-c1" };
	const before = await t.call("login", args, AUTH);
	assert.strictEqual(before.errorCode, "NOT_LINKED");
	assert.match(before.errorText, /plex\.tv\/link/);
	linked = true;
	const r = await t.call("login", args, AUTH);
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.username, "alice");
	assert.strictEqual(r.alias, "Plex – alice");
	const c = r.credentials.common;
	assert.strictEqual(c.mode, "plextv");
	assert.strictEqual(c.accessToken, TOKEN);
	assert.strictEqual(c.clientId, "luneos-c1");
	assert.deepStrictEqual(c.servers.map((s) => [s.id, s.name, s.owned, s.connections.length]), [[HOME_ID, "Home", true, 3], [FRIEND_ID, "Friend's", false, 1]]);
	const res = t.requests.find((q) => q.url.includes("/api/v2/resources"));
	assert.strictEqual(res.headers["X-Plex-Token"], TOKEN);
	t.stop();
});

test("login with a pin: bad arguments, and an account with no server", async () => {
	const t = start({ routes: allRoutes({ tv: { resources: () => ({ body: [RESOURCES[2]] }) } }) });
	assert.strictEqual((await t.call("login", { templateId: "org.webosports.video.plex", pinId: "47/../x", clientId: "c" }, AUTH)).errorCode, "BAD_ARGS");
	assert.strictEqual((await t.call("login", { templateId: "org.webosports.video.plex", pinId: "4711" }, AUTH)).errorCode, "BAD_ARGS");
	const r = await t.call("login", { templateId: "org.webosports.video.plex", pinId: "4711", clientId: "luneos-c1" }, AUTH);
	assert.strictEqual(r.errorCode, "BAD_ARGS");
	assert.match(r.errorText, /no media server/);
	t.stop();
});

test("login with an address: Plex's port is tried for a bare host, and a server that wants a sign-in says so", async () => {
	const t = start();
	const r = await t.call("login", { templateId: "org.webosports.video.plex", server: "http://192.168.1.20:32400/web/index.html" }, AUTH);
	assert.strictEqual(r.returnValue, true);
	assert.deepStrictEqual(r.credentials.common, { mode: "direct", server: DIRECT, accessToken: "", clientId: "luneos-070707070707070707070707", machineId: "dddd", serverName: "Attic" });
	assert.strictEqual(r.alias, "Plex – Attic");
	t.stop();
	const t2 = start({ routes: allRoutes({ direct: { root: () => ({ status: 401, body: "" }) } }) });
	const no = await t2.call("login", { templateId: "org.webosports.video.plex", server: "http://192.168.1.20:32400" }, AUTH);
	assert.strictEqual(no.errorCode, "BAD_ARGS");
	assert.match(no.errorText, /plex\.tv\/link/);
	const bad = await t2.call("login", { templateId: "org.webosports.video.plex", server: "http://192.168.1.20:32400", token: "wrong" }, AUTH);
	assert.match(bad.errorText, /does not accept that token/);
	assert.strictEqual((await t2.call("login", { templateId: "org.webosports.video.plex" }, AUTH)).errorCode, "MISSING_ARGS");
	t2.stop();
});

test("serverCandidates: a bare host gets Plex's port first; no user info, no other schemes", () => {
	const { serverCandidates } = plex._test;
	assert.deepStrictEqual(serverCandidates("nas.local"), ["https://nas.local:32400", "https://nas.local", "http://nas.local:32400", "http://nas.local"]);
	assert.deepStrictEqual(serverCandidates("10.0.0.2:32401/"), ["https://10.0.0.2:32401", "http://10.0.0.2:32401"]);
	assert.deepStrictEqual(serverCandidates("http://u:p@nas/"), []);
	assert.deepStrictEqual(serverCandidates("ftp://nas"), []);
	assert.deepStrictEqual(serverCandidates(""), []);
});

// --- sources and addresses --------------------------------------------------------------------

test("listSources: each server a plex.tv account reaches is a source; a server by address is one", async () => {
	const t = start();
	const r = await t.call("listSources", {});
	assert.deepStrictEqual(r.sources.map((s) => [s.sourceId, s.name, s.provider]), [
		[home, "Plex – Home", "plex"], ["acc-px|" + FRIEND_ID, "Plex – Friend's", "plex"], ["acc-pd", "Plex – Attic", "plex"]]);
	assert.deepStrictEqual(r.sources[0].features, { search: true, progress: true, continueWatching: true, live: false });
	t.stop();
});

test("listSources: a changed server list is stored; plex.tv down falls back to the stored one", async () => {
	const fewer = RESOURCES.slice(0, 1);
	const t = start({ routes: allRoutes({ tv: { resources: () => ({ body: fewer }) } }) });
	const r = await t.call("listSources", {});
	assert.deepStrictEqual(r.sources.filter((s) => s.provider === "plex" && s.accountId === "acc-px").map((s) => s.sourceId), [home]);
	assert.strictEqual(t.writes.length, 1);
	assert.deepStrictEqual(t.store["acc-px"].servers.map((s) => s.id), [HOME_ID]);
	assert.strictEqual(t.store["acc-px"].accessToken, TOKEN);
	t.stop();
	const t2 = start({ routes: allRoutes({ tv: { resources: () => ({ status: 503, body: "" }) } }) });
	const r2 = await t2.call("listSources", {});
	assert.deepStrictEqual(r2.sources.filter((s) => s.accountId === "acc-px").map((s) => s.sourceId), [home, "acc-px|" + FRIEND_ID]);
	assert.strictEqual(t2.writes.length, 0);
	t2.stop();
});

test("a token plex.tv no longer takes is AUTH_EXPIRED, not the stored list", async () => {
	const t = start({ routes: allRoutes({ tv: { resources: () => ({ status: 401, body: "" }) } }) });
	assert.strictEqual((await t.call("listSections", { sourceId: home })).errorCode, "AUTH_EXPIRED");
	t.stop();
});

test("the local address is tried first, then the public one, the relay last; the one that answered is kept", async () => {
	assert.deepStrictEqual(plex._test.connectionOrder(SERVERS[0].connections).map((c) => c.uri), [LAN, WAN, RELAY]);
	const t = start();
	assert.strictEqual((await t.call("listSections", { sourceId: home })).returnValue, true);
	await t.call("listSections", { sourceId: home });
	const probes = t.requests.filter((q) => q.url.endsWith("/identity"));
	assert.deepStrictEqual(probes.map((q) => q.url), [LAN + "/identity"]);
	assert.strictEqual(probes[0].headers["X-Plex-Token"], TOKEN);
	t.stop();
});

test("a server whose addresses all fail is SERVER_UNREACHABLE; a server no longer shared is NO_SOURCE", async () => {
	const t = start({ routes: allRoutes({ lan: { identity: () => { throw new Error("down"); } } }) });
	assert.strictEqual((await t.call("listSections", { sourceId: home })).errorCode, "SERVER_UNREACHABLE");
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-px|gone" })).errorCode, "NO_SOURCE");
	t.stop();
});

test("a shared server is asked with its own token, and told it is played from outside its network", async () => {
	const t = start();
	await t.call("listSections", { sourceId: "acc-px|" + FRIEND_ID });
	const req = t.requests.find((q) => q.url === OTHER + "/library/sections");
	assert.strictEqual(req.headers["X-Plex-Token"], SHARED_TOKEN);
	await t.call("resolve", { sourceId: "acc-px|" + FRIEND_ID, itemId: "2", prefer: PREFER });
	const d = new URL(t.requests.find((q) => q.url.startsWith(OTHER + "/video/:/transcode/universal/decision")).url);
	assert.deepStrictEqual([d.searchParams.get("location"), d.searchParams.get("X-Plex-Token")], ["wan", SHARED_TOKEN]);
	t.stop();
});

// --- browsing ---------------------------------------------------------------------------------

test("sections: Continue Watching, Recently Added, then the film and series libraries", async () => {
	const t = start();
	const r = await t.call("listSections", { sourceId: home });
	assert.deepStrictEqual(r.sections, [
		{ id: "continue", title: "Continue Watching", layout: "row" }, { id: "recent", title: "Recently Added", layout: "row" },
		{ id: "lib:1:movie", title: "Movies", layout: "grid" }, { id: "lib:2:show", title: "Shows", layout: "grid" }]);
	t.stop();
});

test("a library pages by Plex's container start and size, sorted by title", async () => {
	const t = start();
	const p1 = await t.call("listItems", { sourceId: home, sectionId: "lib:1:movie", limit: 1 });
	assert.deepStrictEqual([p1.items.map((i) => i.title), p1.nextCursor], [["Night Train"], "1"]);
	const p2 = await t.call("listItems", { sourceId: home, sectionId: "lib:1:movie", limit: 1, cursor: "1" });
	assert.deepStrictEqual([p2.items.map((i) => i.title), p2.nextCursor], [["Harbour Lights"], null]);
	const u = new URL(t.requests.filter((q) => q.url.includes("/all?"))[1].url);
	assert.deepStrictEqual([u.searchParams.get("type"), u.searchParams.get("sort"), u.searchParams.get("X-Plex-Container-Start")], ["1", "titleSort", "1"]);
	const shows = await t.call("listItems", { sourceId: home, sectionId: "lib:2:show" });
	assert.deepStrictEqual(shows.items.map((i) => [i.kind, i.title, i.hasChildren, i.playable]), [["show", "Test Show", true, false]]);
	assert.strictEqual((await t.call("listItems", { sourceId: home, sectionId: "lib:x:movie" })).errorCode, "NOT_FOUND");
	assert.strictEqual((await t.call("listItems", { sourceId: home, sectionId: "lib:3:artist" })).errorCode, "NOT_FOUND");
	t.stop();
});

test("Continue Watching from its hub; On Deck on a server without it; Recently Added once, without doubles", async () => {
	const t = start();
	const c = await t.call("listItems", { sourceId: home, sectionId: "continue" });
	assert.deepStrictEqual(c.items.map((i) => i.title), ["Episode 1", "Night Train"]);
	assert.strictEqual((await t.call("listItems", { sourceId: home, sectionId: "continue", cursor: "5" })).items.length, 0);
	const r = await t.call("listItems", { sourceId: home, sectionId: "recent" });
	assert.deepStrictEqual(r.items.map((i) => i.title), ["Night Train", "Season 1"]);
	t.stop();
	const old = start({ routes: allRoutes({ lan: { continue: () => ({ status: 404, body: "" }) } }) });
	const d = await old.call("listItems", { sourceId: home, sectionId: "continue" });
	assert.deepStrictEqual(d.items.map((i) => i.title), ["Episode 1"]);
	old.stop();
	const broken = start({ routes: allRoutes({ lan: { continue: () => ({ status: 500, body: "" }) } }) });
	assert.strictEqual((await broken.call("listItems", { sourceId: home, sectionId: "continue" })).errorCode, "SERVER_ERROR");
	broken.stop();
});

test("items: artwork through Plex's resizer with the token, progress, episodes with their show", async () => {
	const t = start();
	const c = await t.call("listItems", { sourceId: home, sectionId: "continue" });
	const [ep, movie] = c.items;
	assert.deepStrictEqual([ep.kind, ep.seriesTitle, ep.season, ep.episode, ep.subtitle], ["episode", "Test Show", 1, 1, "Test Show – S1 · E1"]);
	assert.deepStrictEqual(ep.progress, { positionMs: 0, watched: true });
	const thumb = new URL(ep.artwork.thumb);
	assert.strictEqual(thumb.origin + thumb.pathname, LAN + "/photo/:/transcode");
	assert.deepStrictEqual([thumb.searchParams.get("url"), thumb.searchParams.get("width"), thumb.searchParams.get("X-Plex-Token")], ["/library/metadata/5/thumb/1", "480", TOKEN]);
	assert.strictEqual(new URL(ep.artwork.poster).searchParams.get("url"), "/library/metadata/3/thumb/1");
	assert.deepStrictEqual([movie.kind, movie.year, movie.subtitle, movie.durationMs, movie.description], ["movie", 2024, "2024", 90023, "A train."]);
	assert.deepStrictEqual(movie.progress, { positionMs: 30000, watched: false });
	assert.strictEqual(movie.webUrl, "https://app.plex.tv/desktop/#!/server/" + HOME_ID + "/details?key=%2Flibrary%2Fmetadata%2F2");
	t.stop();
});

test("toItem: a show or season is watched when all its episodes are; a server by address puts no token in links", () => {
	const s = { base: DIRECT, token: "", machineId: "dddd" };
	assert.strictEqual(plex._test.toItem(s, SHOW).progress.watched, true);
	assert.strictEqual(plex._test.toItem(s, SEASON).progress.watched, false);
	assert.strictEqual(plex._test.toItem(s, Object.assign({}, SHOW, { leafCount: 0, viewedLeafCount: 0 })).progress.watched, false);
	const m = plex._test.toItem(s, MOVIE);
	assert.ok(!m.artwork.poster.includes("X-Plex-Token"));
	assert.strictEqual(plex._test.toItem(s, { title: "no key" }), null);
	assert.strictEqual(plex._test.toItem(s, Object.assign({}, MOVIE, { thumb: "http://elsewhere/x.jpg" })).artwork.poster, undefined);
});

test("getItem: a show with its seasons, a season with its episodes; children page like a library", async () => {
	const t = start();
	const show = await t.call("getItem", { sourceId: home, itemId: "3" });
	assert.deepStrictEqual(show.item.seasons.map((x) => [x.title, x.season, x.subtitle]), [["Season 1", 1, "Test Show"]]);
	const season = await t.call("getItem", { sourceId: home, itemId: "4" });
	assert.deepStrictEqual(season.item.children.map((x) => x.title), ["Episode 1"]);
	const kids = await t.call("listItems", { sourceId: home, parentId: "3" });
	assert.deepStrictEqual(kids.items.map((x) => x.title), ["Season 1"]);
	assert.strictEqual((await t.call("getItem", { sourceId: home, itemId: "404" })).errorCode, "NOT_FOUND");
	t.stop();
});

test("search keeps films, series and episodes from Plex's hubs, and has no second page", async () => {
	const t = start();
	const r = await t.call("search", { sourceId: home, query: "night" });
	assert.deepStrictEqual(r.items.map((i) => i.kind + ":" + i.title), ["movie:Night Train", "episode:Episode 1"]);
	assert.strictEqual(r.nextCursor, null);
	assert.strictEqual(new URL(t.requests.find((q) => q.url.includes("/hubs/search")).url).searchParams.get("query"), "night");
	assert.strictEqual((await t.call("search", { sourceId: home, query: "night", cursor: "50" })).items.length, 0);
	t.stop();
});

// --- playing ----------------------------------------------------------------------------------

test("resolve: Plex's direct play is the file itself, with the place to start and the SRT subtitles", async () => {
	const t = start();
	const r = await t.call("resolve", { sourceId: home, itemId: "2", prefer: PREFER });
	assert.strictEqual(r.stream.url, LAN + "/library/parts/2/1/file.mkv?X-Plex-Token=" + TOKEN);
	assert.strictEqual(r.stream.protocol, "progressive");
	assert.strictEqual(r.stream.startMs, 30000);
	assert.deepStrictEqual(r.stream.subtitles, [{ url: LAN + "/library/streams/5?X-Plex-Token=" + TOKEN, format: "srt", default: true, label: "English", lang: "eng" }]);
	assert.deepStrictEqual([r.stream.session.method, r.stream.session.durationMs], ["directplay", 90023]);
	assert.match(r.stream.session.id, /^luneos-[0-9a-f]{16}$/);
	const d = t.requests.find((q) => q.url.includes("/decision?"));
	const q = new URL(d.url).searchParams;
	assert.deepStrictEqual([q.get("directPlay"), q.get("protocol"), q.get("X-Plex-Platform"), q.get("location"), q.get("videoResolution"), q.get("path")],
		["1", "hls", "Generic", "lan", "1280x720", "/library/metadata/2"]);
	assert.strictEqual(d.headers["X-Plex-Platform"], "Generic");
	assert.match(q.get("X-Plex-Client-Profile-Extra"), /add-direct-play-profile\(type=videoProfile&container=mp4,mkv,mov,webm&videoCodec=h264&audioCodec=aac,mp3\)/);
	t.stop();
});

test("resolve: when Plex converts, the HLS link carries the session, the token and Generic", async () => {
	// Plex names the file on a part it converts too: only its decision says direct play.
	const t = start({ routes: allRoutes({ lan: { decision: () => mc({ generalDecisionCode: 1001, Metadata: [{ Media: [{ Part: [{ decision: "transcode", key: "/library/parts/2/1/file.mkv" }] }] }] }) } }) });
	const r = await t.call("resolve", { sourceId: home, itemId: "2", prefer: { maxHeight: 1080, codecs: ["h264", "hevc", "theora"], audioCodecs: [] } });
	const u = new URL(r.stream.url);
	assert.strictEqual(u.origin + u.pathname, LAN + "/video/:/transcode/universal/start.m3u8");
	assert.deepStrictEqual([r.stream.protocol, r.stream.mime, r.stream.session.method], ["hls", "application/x-mpegURL", "transcode"]);
	assert.deepStrictEqual([u.searchParams.get("directPlay"), u.searchParams.get("session"), u.searchParams.get("X-Plex-Token"), u.searchParams.get("X-Plex-Platform"),
		u.searchParams.get("videoResolution"), u.searchParams.get("maxVideoBitrate"), u.searchParams.get("X-Plex-Client-Identifier")],
		["0", r.stream.session.id, TOKEN, "Generic", "1920x1080", "8000", "luneos-c1"]);
	assert.match(u.searchParams.get("X-Plex-Client-Profile-Extra"), /videoCodec=h264,hevc&audioCodec=aac,mp3\)$/);
	t.stop();
});

test("resolve: a file taller than asked for is not played directly", async () => {
	const t = start();
	const r = await t.call("resolve", { sourceId: home, itemId: "9", prefer: PREFER });
	assert.strictEqual(new URL(t.requests.find((q) => q.url.includes("/decision?")).url).searchParams.get("directPlay"), "0");
	assert.strictEqual(r.stream.protocol, "hls");
	assert.strictEqual(plex._test.tooTall(MOVIE, 360), false);
	assert.strictEqual(plex._test.tooTall(MOVIE, 240), true);
	assert.strictEqual(plex._test.tooTall({ Media: [{ height: 2160 }, { height: 720 }] }, 720), false);
	assert.strictEqual(plex._test.tooTall({}, 240), false);
	t.stop();
});

test("resolve: Plex's refusal is said, and only films, episodes and clips are played", async () => {
	const t = start({ routes: allRoutes({ lan: { decision: () => mc({ generalDecisionCode: 2000, generalDecisionText: "Cannot transcode",
		Metadata: [{ Media: [{ Part: [{ decision: "transcode", key: "/library/parts/2/1/file.mkv" }] }] }] }) } }) });
	const r = await t.call("resolve", { sourceId: home, itemId: "2", prefer: PREFER });
	assert.strictEqual(r.errorCode, "SERVER_ERROR");
	assert.match(r.errorText, /Cannot transcode/);
	assert.strictEqual((await t.call("resolve", { sourceId: home, itemId: "3", prefer: PREFER })).errorCode, "BAD_ARGS");
	t.stop();
});

test("progress: a timeline report while playing; at the end the timeline, the scrobble and the conversion stopped", async () => {
	const t = start();
	const session = { id: "luneos-0011223344556677", method: "transcode", durationMs: 90023 };
	assert.strictEqual((await t.call("reportProgress", { sourceId: home, itemId: "2", positionMs: 15000, durationMs: 0, state: "paused", session })).returnValue, true);
	await t.call("reportProgress", { sourceId: home, itemId: "2", positionMs: 90023, durationMs: 90023, state: "ended", session });
	const calls = t.requests.filter((q) => /\/:\/(timeline|scrobble)|transcode\/universal\/stop/.test(q.url)).map((q) => new URL(q.url));
	assert.deepStrictEqual(calls.map((u) => u.pathname), ["/:/timeline", "/:/timeline", "/:/scrobble", "/video/:/transcode/universal/stop"]);
	assert.deepStrictEqual([calls[0].searchParams.get("state"), calls[0].searchParams.get("time"), calls[0].searchParams.get("duration"), calls[0].searchParams.get("key")],
		["paused", "15000", "90023", "/library/metadata/2"]);
	assert.strictEqual(calls[1].searchParams.get("state"), "stopped");
	assert.strictEqual(calls[2].searchParams.get("key"), "2");
	assert.strictEqual(calls[3].searchParams.get("session"), session.id);
	const tl = t.requests.find((q) => q.url.includes("/:/timeline"));
	assert.strictEqual(tl.headers["X-Plex-Session-Identifier"], session.id);
	t.stop();
});

test("progress: a direct play stops without a conversion to stop, and a failed stop is no error", async () => {
	const t = start({ routes: allRoutes({ lan: { stop: () => ({ status: 500, body: "" }) } }) });
	await t.call("reportProgress", { sourceId: home, itemId: "2", positionMs: 5000, durationMs: 90023, state: "stopped", session: { id: "luneos-a", method: "directplay" } });
	assert.ok(!t.requests.some((q) => q.url.includes("/transcode/universal/stop")));
	const r = await t.call("reportProgress", { sourceId: home, itemId: "2", positionMs: 5000, durationMs: 90023, state: "stopped", session: { id: "luneos-b", method: "transcode" } });
	assert.strictEqual(r.returnValue, true);
	assert.ok(t.requests.some((q) => q.url.includes("/transcode/universal/stop")));
	assert.ok(!t.requests.some((q) => q.url.includes("/:/scrobble")));
	t.stop();
});

test("a server added by address is browsed and played with no token anywhere", async () => {
	const t = start();
	const r = await t.call("resolve", { sourceId: "acc-pd", itemId: "2", prefer: PREFER });
	assert.strictEqual(r.stream.url, DIRECT + "/library/parts/2/1/file.mkv");
	assert.ok(t.requests.every((q) => !q.url.startsWith(DIRECT) || q.headers["X-Plex-Token"] === undefined));
	assert.ok(!t.requests.some((q) => q.url.startsWith(DIRECT) && q.url.endsWith("/identity")));
	t.stop();
});

test("an address that stops answering is dropped and the next one tried", async () => {
	let lanUp = true;
	const t = start({ routes: plexTvRoutes().concat(
		[["GET", new RegExp("^" + LAN.replace(/\./g, "\\.") + "/library/sections$"), () => { if (!lanUp) { throw new Error("gone"); } return mc({ Directory: [] }); }],
			["GET", new RegExp("^" + LAN.replace(/\./g, "\\.") + "/identity$"), () => { if (!lanUp) { throw new Error("gone"); } return mc({ machineIdentifier: HOME_ID }); }],
			["GET", new RegExp("^" + RELAY.replace(/\./g, "\\.") + "/"), () => { throw new Error("relay is down"); }]],
		serverRoutes(WAN)) });
	assert.strictEqual((await t.call("listSections", { sourceId: home })).returnValue, true);
	lanUp = false;
	const r = await t.call("listSections", { sourceId: home });
	assert.strictEqual(r.returnValue, true);
	assert.deepStrictEqual(r.sections.slice(2).map((s) => s.title), ["Movies", "Shows"]);
	assert.ok(t.requests.some((q) => q.url === WAN + "/library/sections"));
	t.stop();
});

test("no token reaches the log", async () => {
	const logs = [];
	const t = start({ logs, routes: allRoutes({ tv: { resources: () => ({ status: 503, body: "" }) }, lan: { decision: () => ({ status: 500, body: "token " + TOKEN }) } }) });
	await t.call("listSources", {});
	await t.call("resolve", { sourceId: home, itemId: "2", prefer: PREFER });
	await t.call("login", { templateId: "org.webosports.video.plex", pinId: "4711", clientId: "luneos-c1" }, AUTH);
	assert.ok(logs.length > 0);
	assert.ok(logs.every((l) => !l.includes(TOKEN) && !l.includes(SHARED_TOKEN)), logs.join("\n"));
	t.stop();
});
