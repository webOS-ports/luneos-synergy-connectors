// node --test tests/unit
// The video service (video/_core/service/org.webosports.service.videos) as the launcher runs it:
// service.js started on a stand-in palmbus whose Accounts service holds one Jellyfin, one PeerTube
// and one UPnP account, with a stand-in fetch that plays Jellyfin 12.4 and PeerTube 7.3 (shapes
// taken from the live servers on 2026-11-03) and MiniDLNA 1.3.3 (its replies recorded in
// data/videos), and a stand-in SSDP. Every method is called over the bus as Videos calls it.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { fakePalmbus, fakeFetch, ask } = require("./lib/fakes.js");

const SVC = path.join(__dirname, "../../video/_core/service/org.webosports.service.videos");
const service = require(SVC);
const C = require(path.join(SVC, "contract.js"));
const X = require(path.join(SVC, "xml.js"));
const ssdpLib = require(path.join(SVC, "ssdp.js"));
const { splitSourceId, asServiceError } = require(path.join(SVC, "videos.js"));
const jellyfin = require("../../video/jellyfin/provider");
const upnpLib = require("../../video/upnp/provider");
const peertube = require("../../video/peertube/provider");

const DATA = path.join(__dirname, "data/videos");
const fixture = (n) => fs.readFileSync(path.join(DATA, n), "utf8");

const VIDEOS = { appId: "org.webosports.app.videoplayer 1234" };
const AUTH = { appId: "org.webosports.app.videoauth 999" };
const STRANGER = { appId: "com.example.evil 1" };

const JF = "http://jf.example.test:8096";
const TOKEN = "tok-unit-test-not-a-credential";
const PT = "https://pt.example.test";
const DLNA = "http://192.168.50.20:8200";
const UDN = "4d696e69-444c-164e-9d41-7085c2ae4162";

const ACCOUNTS = [
	{ _id: "acc-jf", templateId: "org.webosports.video.jellyfin", username: "alice@jf", alias: "Jellyfin – Home",
		icon: { loc_48x48: "/usr/palm/public/accounts/org.webosports.video.jellyfin/images/jellyfin-48x48.png" } },
	{ _id: "acc-pt", templateId: "org.webosports.video.peertube", username: "pt.example.test", alias: "Tube" },
	{ _id: "acc-up", templateId: "org.webosports.video.upnp", username: "local-network" },
	{ _id: "acc-old", templateId: "org.example.unknown", username: "x" },
	{ _id: "acc-gone", templateId: "org.webosports.video.jellyfin", username: "y", beingDeleted: true },
];
const CREDS = {
	"acc-jf": { accessToken: TOKEN, server: JF, userId: "u1", deviceId: "luneos-abc", serverId: "s1", serverName: "Home", username: "alice" },
	"acc-pt": { server: PT, name: "Tube" },
	"acc-up": { kind: "upnp" },
};

// --- Jellyfin -----------------------------------------------------------------------------------

function jfItem(o) {
	return Object.assign({ ImageTags: { Primary: "tag-" + o.Id }, BackdropImageTags: [], UserData: { PlaybackPositionTicks: 0, Played: false } }, o);
}
const MOVIE = jfItem({ Id: "m1", Name: "Night Train", Type: "Movie", ProductionYear: 2024, RunTimeTicks: 900230000, Overview: "A train." });
const SERIES = jfItem({ Id: "sh1", Name: "Test Show", Type: "Series", IsFolder: true });
const SEASON = jfItem({ Id: "se1", Name: "Season 1", Type: "Season", IsFolder: true, IndexNumber: 1, SeriesId: "sh1", SeriesName: "Test Show" });
const EP = jfItem({ Id: "e1", Name: "Pilot", Type: "Episode", SeriesId: "sh1", SeriesName: "Test Show", SeriesPrimaryImageTag: "st",
	ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 600000000, UserData: { PlaybackPositionTicks: 150000000, Played: false } });

function jellyfinRoutes(over = {}) {
	const items = { m1: MOVIE, sh1: SERIES, se1: SEASON, e1: EP };
	return [
		["GET", /\/System\/Info\/Public$/, () => over.info || { body: { Id: "s1", ServerName: "Home", ProductName: "Jellyfin Server", Version: "12.4.0" } }],
		["POST", /\/Users\/AuthenticateByName$/, (r) => {
			const b = JSON.parse(r.body);
			return b.Pw === "right" ? { body: { AccessToken: "new-token", User: { Id: "u9", Name: b.Username } } } : { status: 401, body: "" };
		}],
		["GET", /\/UserViews\?/, () => ({ body: { Items: [
			{ Id: "v1", Name: "Movies", CollectionType: "movies" }, { Id: "v2", Name: "Shows", CollectionType: "tvshows" },
			{ Id: "v3", Name: "Music", CollectionType: "music" }] } })],
		["GET", /\/UserItems\/Resume\?/, () => ({ body: { Items: [EP], TotalRecordCount: 1 } })],
		["GET", /\/Shows\/NextUp\?/, () => ({ body: { Items: [EP], TotalRecordCount: 1 } })],
		["GET", /\/Items\/Latest\?/, () => ({ body: [MOVIE, SERIES, SERIES] })],
		["GET", /\/Shows\/sh1\/Seasons\?/, () => ({ body: { Items: [SEASON] } })],
		["GET", /\/Shows\/sh1\/Episodes\?/, () => ({ body: { Items: [EP] } })],
		["POST", /\/Items\/(m1|e1)\/PlaybackInfo\?/, (r) => over.playback ? over.playback(r) : ({ body: { PlaySessionId: "ps1", MediaSources: [{
			Id: "ms1", SupportsDirectStream: true, MediaStreams: [
				{ Type: "Video", Codec: "h264" },
				{ Type: "Subtitle", Language: "eng", DisplayTitle: "English - SUBRIP - External", DeliveryMethod: "External",
					DeliveryUrl: "/Videos/m1/ms1/Subtitles/2/0/Stream.srt?ApiKey=" + TOKEN, IsDefault: true },
				{ Type: "Subtitle", Language: "ger", DeliveryMethod: "Embed" }] }] } })],
		["GET", /\/Items\/(\w+)\?/, (r) => {
			const id = /\/Items\/(\w+)\?/.exec(r.url)[1];
			return items[id] ? { body: items[id] } : { status: 404, body: "" };
		}],
		["GET", /\/Items\?/, (r) => {
			const u = new URL(r.url);
			if (over.items) { return over.items(u); }
			const from = Number(u.searchParams.get("StartIndex") || 0);
			const all = u.searchParams.get("searchTerm") ? [MOVIE] : (u.searchParams.get("IncludeItemTypes") === "Series" ? [SERIES] : [MOVIE, MOVIE]);
			return { body: { Items: all.slice(from, from + Number(u.searchParams.get("Limit") || 50)).map((x, i) => Object.assign({}, x, { Id: x.Id + (from + i) })), TotalRecordCount: all.length } };
		}],
		["POST", /\/Sessions\/Playing\/(Progress|Stopped)$/, () => ({ status: 204 })],
	];
}

// --- PeerTube -----------------------------------------------------------------------------------

const PT_VIDEO = { uuid: "uu-1", shortUUID: "s1", name: "Harbour Lights", duration: 60, isLive: false, nsfw: false,
	thumbnailPath: "/lazy-static/thumbnails/t.jpg", previewPath: "/lazy-static/previews/p.jpg", publishedAt: "2026-11-03T20:00:00Z",
	url: PT + "/videos/watch/uu-1", channel: { displayName: "Main channel" } };
const PT_NSFW = Object.assign({}, PT_VIDEO, { uuid: "uu-x", name: "Not for here", nsfw: true });

function peertubeRoutes(over = {}) {
	return [
		["GET", /\/api\/v1\/config$/, () => ({ body: { serverVersion: "7.3.0", instance: { name: "Tube" } } })],
		["GET", /\/api\/v1\/videos\?/, () => ({ body: { total: 3, data: [PT_VIDEO, PT_NSFW] } })],
		["GET", /\/api\/v1\/search\/videos\?/, () => ({ body: { total: 1, data: [PT_VIDEO] } })],
		["GET", /\/api\/v1\/videos\/uu-1\/captions$/, () => ({ body: { total: 1, data: [
			{ language: { id: "en", label: "English" }, captionPath: "/lazy-static/video-captions/c-en.vtt" }] } })],
		["GET", /\/api\/v1\/videos\/uu-1$/, () => ({ body: Object.assign({}, PT_VIDEO, over.video || {
			files: [{ resolution: { id: 1080 }, fileUrl: PT + "/f-1080.mp4" }, { resolution: { id: 360 }, fileUrl: PT + "/f-360.mp4" }, { resolution: { id: 480 }, fileUrl: PT + "/f-480.mp4" },
				{ resolution: { id: 0 }, fileUrl: PT + "/audio.mp4" }],
			streamingPlaylists: [{ type: 1, playlistUrl: PT + "/hls/master.m3u8" }] }) })],
		["GET", /\/api\/v1\/videos\/uu-x$/, () => ({ body: PT_NSFW })],
		["GET", /instances\.joinpeertube\.org\/api\/v1\/instances\?/, () => ({ body: { total: 3, data: [
			{ host: "framatube.org", name: "Framatube", shortDescription: "<b>Videos</b>", totalVideos: 10, isNSFW: false, version: "8.3.2" },
			{ host: "adult.example", name: "X", isNSFW: true },
			{ host: "user:pw@bad host", name: "Bad" }] } })],
	];
}

// --- UPnP ---------------------------------------------------------------------------------------

function didl(inner) {
	const d = "<DIDL-Lite xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" " +
		"xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:sec=\"http://www.sec.co.kr/\">" + inner + "</DIDL-Lite>";
	return d;
}
function soapReply(action, d, returned, total) {
	return "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:" + action +
		"Response xmlns:u=\"urn:schemas-upnp-org:service:ContentDirectory:1\"><Result>" + X.escape(d) + "</Result><NumberReturned>" +
		returned + "</NumberReturned><TotalMatches>" + total + "</TotalMatches><UpdateID>0</UpdateID></u:" + action + "Response></s:Body></s:Envelope>";
}
const ROOT_DIDL = didl(
	"<container id=\"64\" parentID=\"0\" childCount=\"2\"><dc:title>Browse Folders</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>" +
	"<container id=\"1\" parentID=\"0\" childCount=\"5\"><dc:title>Music</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>" +
	"<container id=\"3\" parentID=\"0\" childCount=\"5\"><dc:title>Pictures</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>" +
	"<container id=\"2\" parentID=\"0\" childCount=\"3\"><dc:title>Video</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>");
const VIDEO_ITEM = "<item id=\"v9\" parentID=\"2\"><dc:title>Big &amp; Small</dc:title><upnp:class>object.item.videoItem.movie</upnp:class>" +
	"<upnp:albumArtURI>" + DLNA + "/AlbumArt/9.jpg</upnp:albumArtURI>" +
	"<sec:CaptionInfoEx sec:type=\"srt\">" + DLNA + "/Captions/9.srt</sec:CaptionInfoEx>" +
	"<res duration=\"1:02:03.500\" resolution=\"1920x1080\" protocolInfo=\"http-get:*:video/mp4:*\">" + DLNA + "/MediaItems/9-1080.mp4</res>" +
	"<res duration=\"1:02:03.500\" resolution=\"1280x720\" protocolInfo=\"http-get:*:video/mp4:*\">" + DLNA + "/MediaItems/9-720.mp4</res>" +
	"<res protocolInfo=\"http-get:*:video/mp4:*\">https://cdn.example.com/elsewhere.mp4</res>" +
	"<res protocolInfo=\"http-get:*:text/srt:*\">" + DLNA + "/Captions/9b.srt</res></item>";
const AUDIO_ITEM = "<item id=\"a1\" parentID=\"2\"><dc:title>Song</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
	"<res protocolInfo=\"http-get:*:audio/mpeg:*\">" + DLNA + "/MediaItems/a1.mp3</res></item>";

function upnpRoutes(over = {}) {
	return [
		["GET", /\/rootDesc\.xml$/, () => ({ body: fixture("minidlna-rootDesc.xml") })],
		["POST", /\/ctl\/ContentDir$/, (r) => {
			const env = X.parse(r.body);
			const action = /#(\w+)"$/.exec(r.headers.SOAPAction)[1];
			if (over.soap) { const o = over.soap(action, env, r); if (o) { return o; } }
			if (action === "GetSearchCapabilities") {
				return { body: "<s:Envelope xmlns:s=\"x\"><s:Body><u:GetSearchCapabilitiesResponse xmlns:u=\"y\"><SearchCaps>dc:title,upnp:class,@id</SearchCaps></u:GetSearchCapabilitiesResponse></s:Body></s:Envelope>" };
			}
			if (action === "Search") { return { body: soapReply("Search", didl(VIDEO_ITEM), 1, 1) }; }
			const id = X.childText(X.find(env, "Browse"), "ObjectID");
			const flag = X.childText(X.find(env, "Browse"), "BrowseFlag");
			if (id === "0") { return { body: soapReply("Browse", ROOT_DIDL, 4, 4) }; }
			if (id === "2$15$0") { return { body: fixture("minidlna-browse-movies.xml") }; }
			if (id === "2$15$0$1") { return { body: fixture("minidlna-browse-item.xml") }; }
			if (id === "2" && flag === "BrowseMetadata") {
				return { body: soapReply("Browse", didl("<container id=\"2\" parentID=\"0\" childCount=\"3\"><dc:title>Video</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>"), 1, 1) };
			}
			if (id === "2" && flag === "BrowseDirectChildren") {
				const from = Number(X.childText(X.find(env, "Browse"), "StartingIndex"));
				const all = [VIDEO_ITEM, AUDIO_ITEM, "<container id=\"2$m\" parentID=\"2\"><dc:title>An album</dc:title><upnp:class>object.container.album.musicAlbum</upnp:class></container><container id=\"2$1\" parentID=\"2\" childCount=\"0\"><dc:title>Folder</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>"];
				const count = Number(X.childText(X.find(env, "Browse"), "RequestedCount")) || all.length;
				const page = all.slice(from, from + count);
				return { body: soapReply("Browse", didl(page.join("")), page.length, all.length) };
			}
			if (id === "v9") { return { body: soapReply("Browse", didl(VIDEO_ITEM), 1, 1) }; }
			if (id === "a1") { return { body: soapReply("Browse", didl(AUDIO_ITEM), 1, 1) }; }
			return { status: 500, body: "<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>701</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>" };
		}],
	];
}

function fakeSsdp(found = [{ location: DLNA + "/rootDesc.xml", usn: "uuid:" + UDN + "::urn:x", st: "", server: "" }]) {
	const searches = [];
	return { searches, search: async (st, ms) => { searches.push({ st, ms }); return found; } };
}

// --- the service on the stand-ins ---------------------------------------------------------------

function start({ routes = [], accounts = ACCOUNTS, creds = CREDS, ssdp = fakeSsdp(), logs = [] } = {}) {
	upnpLib._test.dir._set([]);
	const accountCalls = [];
	const pb = fakePalmbus({ onCall: (uri, args) => {
		accountCalls.push({ uri, args });
		if (uri.endsWith("/listAccounts")) { return { returnValue: true, results: accounts }; }
		if (uri.endsWith("/readCredentials")) {
			return creds[args.accountId] ? { returnValue: true, credentials: creds[args.accountId] } : { returnValue: false, errorCode: "NOT_FOUND" };
		}
		return { returnValue: true };
	} });
	const { fetch, requests } = fakeFetch(routes);
	const log = { log: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)), warn: (s) => logs.push(String(s)) };
	const s = service.start({ palmbus: pb, fetch, ssdp, idleMs: 0, exit: () => {}, log,
		timeouts: { timeoutMs: 2000, idleTimeoutMs: 2000 }, random: (n) => Buffer.alloc(n, 7) });
	const handle = pb.handles[0];
	return { call: (m, p, who = VIDEOS) => ask(handle, m, p, who), requests, accountCalls, logs, ssdp, stop: () => s.bus.stop() };
}

const allRoutes = (o = {}) => jellyfinRoutes(o.jf).concat(peertubeRoutes(o.pt), upnpRoutes(o.up));

// --- sources ------------------------------------------------------------------------------------

test("listSources: a label drops the kind the icon shows, as the sign-in names an account", async () => {
	const accounts = [
		{ _id: "a1", templateId: "org.webosports.video.peertube", username: "h", alias: "PeerTube (tube.example:9000)" },
		{ _id: "a2", templateId: "org.webosports.video.peertube", username: "h", alias: "Tube (tube.example)" },
		{ _id: "a3", templateId: "org.webosports.video.jellyfin", username: "h", alias: "Jellyfin" },
		{ _id: "a4", templateId: "org.webosports.video.jellyfin", username: "h", alias: "Jellyfin – " },
		{ _id: "a5", templateId: "org.webosports.video.jellyfin", username: "h", alias: "My Jellyfin – Home" },
	];
	const t = start({ routes: allRoutes(), accounts });
	const r = await t.call("listSources", {});
	assert.deepStrictEqual(r.sources.map((s) => s.label), ["tube.example:9000", "Tube", "Jellyfin", "Jellyfin –", "My Jellyfin – Home"]);
	assert.strictEqual(r.sources[0].name, "PeerTube (tube.example:9000)", "the name as it was");
	t.stop();
});

test("listSources: one per account, one per media server found, none for unknown or deleted accounts", async () => {
	const t = start({ routes: allRoutes() });
	const r = await t.call("listSources", {});
	assert.strictEqual(r.returnValue, true);
	assert.deepStrictEqual(r.sources.map((s) => [s.sourceId, s.provider, s.name]), [
		["acc-jf", "jellyfin", "Jellyfin – Home"],
		["acc-pt", "peertube", "Tube"],
		["acc-up|" + UDN, "upnp", "LuneOS test DLNA"],
	]);
	assert.deepStrictEqual(r.sources.map((s) => s.label), ["Home", "Tube", "LuneOS test DLNA"], "the name without its kind");
	assert.deepStrictEqual(r.sources[0].features, { search: true, progress: true, continueWatching: true, live: false });
	assert.deepStrictEqual(r.sources[2].features, { search: true, progress: false, continueWatching: false, live: false });
	assert.match(r.sources[0].icon, /jellyfin-48x48\.png$/);
	assert.strictEqual(t.ssdp.searches[0].st, "urn:schemas-upnp-org:service:ContentDirectory:1");
	assert.ok(t.accountCalls.some((c) => c.uri.endsWith("/listAccounts") && c.args.capability === "Video"));
	t.stop();
});

test("listSources: only the first waits for the network search; later ones answer what it found", { timeout: 10000 }, async () => {
	// A search that ends when the test lets it, as the real one ends after its wait.
	const until = async (fn) => { for (let n = 0; n < 200 && !fn(); n++) { await new Promise((r) => setTimeout(r, 5)); } assert.ok(fn()); };
	let found = [{ location: DLNA + "/rootDesc.xml", usn: "uuid:" + UDN + "::urn:x", st: "", server: "" }];
	const searches = [];
	const ssdp = { searches, search: (st, ms) => new Promise((res) => { searches.push({ st, ms, done: () => res(found) }); }) };
	const t = start({ routes: allRoutes(), ssdp });
	let answered = false;
	const first = t.call("listSources", {}).then((r) => { answered = true; return r; });
	await until(() => searches.length === 1);
	await new Promise((r) => setTimeout(r, 20));
	assert.strictEqual(answered, false, "the first waits for the search");
	searches[0].done();
	assert.deepStrictEqual((await first).sources.map((s) => s.sourceId), ["acc-jf", "acc-pt", "acc-up|" + UDN]);

	// The next answers at once, with a search started behind it that finds the server gone.
	found = [];
	const again = await t.call("listSources", {});
	assert.deepStrictEqual(again.sources.map((s) => s.sourceId), ["acc-jf", "acc-pt", "acc-up|" + UDN], "what the last search found");
	assert.strictEqual(searches.length, 2, "and a new search behind it");
	searches[1].done();
	await new Promise((r) => setTimeout(r, 20));
	// The list after it says so, again at once.
	const after = await t.call("listSources", {});
	assert.deepStrictEqual(after.sources.map((s) => s.sourceId), ["acc-jf", "acc-pt"]);
	assert.strictEqual(searches.length, 3);
	searches[2].done();
	await new Promise((r) => setTimeout(r, 20));
	t.stop();
});

test("only Videos may browse; anyone may sign in or list PeerTube instances", async () => {
	const t = start({ routes: allRoutes() });
	for (const m of ["listSources", "listSections", "listItems", "getItem", "search", "resolve", "reportProgress", "getInfo"]) {
		const r = await t.call(m, { sourceId: "acc-jf" }, STRANGER);
		assert.strictEqual(r.returnValue, false, m);
		assert.strictEqual(r.errorCode, "PERMISSION_DENIED", m);
	}
	assert.strictEqual((await t.call("login", { templateId: "org.webosports.video.upnp" }, AUTH)).returnValue, true);
	assert.strictEqual((await t.call("searchPeerTubeInstances", {}, AUTH)).returnValue, true);
	t.stop();
});

test("a source that is not there, or has no sign-in stored, says so", async () => {
	const t = start({ routes: allRoutes(), creds: { "acc-pt": CREDS["acc-pt"] } });
	assert.strictEqual((await t.call("listSections", { sourceId: "nope" })).errorCode, "NO_SOURCE");
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-old" })).errorCode, "NO_SOURCE");
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-jf" })).errorCode, "AUTH_EXPIRED");
	assert.strictEqual((await t.call("listSections", {})).errorCode, "MISSING_ARGS");
	assert.strictEqual((await t.call("listItems", { sourceId: "acc-pt" })).errorCode, "MISSING_ARGS");
	t.stop();
});

test("source ids split at the first |", () => {
	assert.deepStrictEqual(splitSourceId("a|b|c"), { accountId: "a", sub: "b|c" });
	assert.deepStrictEqual(splitSourceId("a"), { accountId: "a", sub: "" });
	assert.throws(() => splitSourceId(""), /sourceId/);
});

// --- Jellyfin -----------------------------------------------------------------------------------

test("Jellyfin: sections are the rows and the user's video libraries", async () => {
	const t = start({ routes: allRoutes() });
	const r = await t.call("listSections", { sourceId: "acc-jf" });
	assert.deepStrictEqual(r.sections, [
		{ id: "continue", title: "Continue Watching", layout: "row" },
		{ id: "nextup", title: "Next Up", layout: "row" },
		{ id: "latest", title: "Recently Added", layout: "row" },
		{ id: "view:v1:movies", title: "Movies", layout: "grid" },
		{ id: "view:v2:tvshows", title: "Shows", layout: "grid" },
	]);
	const views = t.requests.find((q) => /UserViews/.test(q.url));
	assert.match(views.headers.Authorization, /^MediaBrowser Client="LuneOS Videos", Device="LuneOS", DeviceId="luneos-abc", Version="1\.0\.0", Token="tok-unit-test/);
	t.stop();
});

test("Jellyfin: items, with artwork links that need no token, paging and no duplicates", async () => {
	const t = start({ routes: allRoutes() });
	let r = await t.call("listItems", { sourceId: "acc-jf", sectionId: "view:v1:movies", limit: 1 });
	assert.strictEqual(r.items.length, 1);
	assert.strictEqual(r.nextCursor, "1");
	assert.strictEqual(r.items[0].kind, "movie");
	assert.strictEqual(r.items[0].durationMs, 90023);
	assert.strictEqual(r.items[0].artwork.poster, JF + "/Items/m10/Images/Primary?maxHeight=480&quality=85&tag=tag-m1");
	assert.ok(!JSON.stringify(r).includes(TOKEN));
	const q = new URL(t.requests.find((x) => /\/Items\?/.test(x.url)).url).searchParams;
	assert.strictEqual(q.get("IncludeItemTypes"), "Movie");
	assert.strictEqual(q.get("Recursive"), "true");
	assert.strictEqual(q.get("ParentId"), "v1");
	r = await t.call("listItems", { sourceId: "acc-jf", sectionId: "view:v1:movies", limit: 1, cursor: "1" });
	assert.strictEqual(r.nextCursor, null);
	r = await t.call("listItems", { sourceId: "acc-jf", sectionId: "latest" });
	assert.deepStrictEqual(r.items.map((i) => i.id), ["m1", "sh1"]);
	r = await t.call("listItems", { sourceId: "acc-jf", sectionId: "continue" });
	assert.deepStrictEqual(r.items[0], { id: "e1", kind: "episode", title: "Pilot", subtitle: "Test Show – S1 · E1",
		artwork: { poster: JF + "/Items/sh1/Images/Primary?maxHeight=480&quality=85&tag=st", thumb: JF + "/Items/e1/Images/Primary?maxHeight=360&quality=85&tag=tag-e1" },
		durationMs: 60000, seriesTitle: "Test Show", season: 1, episode: 1, progress: { positionMs: 15000, watched: false },
		playable: true, hasChildren: false, webUrl: JF + "/web/#/details?id=e1" });
	assert.strictEqual((await t.call("listItems", { sourceId: "acc-jf", sectionId: "nope" })).errorCode, "NOT_FOUND");
	t.stop();
});

test("Jellyfin: a show comes with its seasons, a season with its episodes", async () => {
	const t = start({ routes: allRoutes() });
	let r = await t.call("getItem", { sourceId: "acc-jf", itemId: "sh1" });
	assert.strictEqual(r.item.kind, "show");
	assert.deepStrictEqual(r.item.seasons.map((s) => [s.id, s.kind, s.title]), [["se1", "season", "Season 1"]]);
	r = await t.call("getItem", { sourceId: "acc-jf", itemId: "se1" });
	assert.deepStrictEqual(r.item.children.map((s) => [s.id, s.kind]), [["e1", "episode"]]);
	r = await t.call("listItems", { sourceId: "acc-jf", parentId: "se1" });
	assert.deepStrictEqual(r.items.map((s) => s.id), ["e1"]);
	r = await t.call("getItem", { sourceId: "acc-jf", itemId: "zz" });
	assert.strictEqual(r.errorCode, "NOT_FOUND");
	t.stop();
});

test("Jellyfin: search", async () => {
	const t = start({ routes: allRoutes() });
	const r = await t.call("search", { sourceId: "acc-jf", query: "night" });
	assert.deepStrictEqual(r.items.map((i) => i.title), ["Night Train"]);
	const q = new URL(t.requests.find((x) => /searchTerm/.test(x.url)).url).searchParams;
	assert.strictEqual(q.get("searchTerm"), "night");
	assert.strictEqual(q.get("Recursive"), "true");
	assert.strictEqual((await t.call("search", { sourceId: "acc-jf", query: "  " })).errorCode, "MISSING_ARGS");
	t.stop();
});

test("Jellyfin: resolve gives the direct stream, WebVTT subtitles and the session for progress", async () => {
	const t = start({ routes: allRoutes() });
	const r = await t.call("resolve", { sourceId: "acc-jf", itemId: "m1", prefer: { maxHeight: 480 } });
	const s = r.stream;
	assert.strictEqual(s.protocol, "progressive");
	assert.strictEqual(s.url, JF + "/Videos/m1/stream?static=true&MediaSourceId=ms1&ApiKey=" + TOKEN);
	assert.deepStrictEqual(s.subtitles, [{ url: JF + "/Videos/m1/ms1/Subtitles/2/0/Stream.vtt?ApiKey=" + TOKEN, format: "vtt", default: true,
		label: "English - SUBRIP - External", lang: "eng" }]);
	assert.deepStrictEqual(s.session, { playSessionId: "ps1", mediaSourceId: "ms1", method: "DirectStream" });
	assert.strictEqual(s.drm, null);
	const body = JSON.parse(t.requests.find((x) => /PlaybackInfo/.test(x.url)).body);
	assert.strictEqual(body.DeviceProfile.CodecProfiles[0].Conditions[0].Value, "480");
	assert.strictEqual(body.DeviceProfile.TranscodingProfiles[0].Protocol, "hls");
	assert.ok(!t.logs.some((l) => l.includes(TOKEN)), "no token in the log");
	t.stop();
});

test("Jellyfin: resolve takes the transcode when the server offers one, and resumes where the server says", async () => {
	const t = start({ routes: allRoutes({ jf: { playback: () => ({ body: { PlaySessionId: "ps2", MediaSources: [{ Id: "ms2",
		SupportsDirectStream: false, TranscodingSubProtocol: "hls", TranscodingUrl: "/videos/e1/master.m3u8?ApiKey=" + TOKEN }] } }) } }) });
	const r = await t.call("resolve", { sourceId: "acc-jf", itemId: "e1" });
	assert.strictEqual(r.stream.protocol, "hls");
	assert.strictEqual(r.stream.url, JF + "/videos/e1/master.m3u8?ApiKey=" + TOKEN);
	assert.strictEqual(r.stream.startMs, 15000);
	assert.strictEqual(r.stream.session.method, "Transcode");
	assert.strictEqual((await t.call("resolve", { sourceId: "acc-jf", itemId: "sh1" })).errorCode, "BAD_ARGS");
	t.stop();
});

test("Jellyfin: progress is reported with the session, stopped when playback ends", async () => {
	const t = start({ routes: allRoutes() });
	const session = { playSessionId: "ps1", mediaSourceId: "ms1", method: "DirectStream" };
	assert.strictEqual((await t.call("reportProgress", { sourceId: "acc-jf", itemId: "m1", positionMs: 12345, state: "paused", session })).returnValue, true);
	assert.strictEqual((await t.call("reportProgress", { sourceId: "acc-jf", itemId: "m1", positionMs: 20000, state: "stopped", session })).returnValue, true);
	const [p, s] = t.requests.filter((x) => /Sessions\/Playing/.test(x.url));
	assert.match(p.url, /\/Progress$/);
	assert.deepStrictEqual(JSON.parse(p.body), { ItemId: "m1", MediaSourceId: "ms1", PlaySessionId: "ps1", PositionTicks: 123450000,
		CanSeek: true, PlayMethod: "DirectStream", IsPaused: true });
	assert.match(s.url, /\/Stopped$/);
	assert.strictEqual(JSON.parse(s.body).PositionTicks, 200000000);
	assert.strictEqual((await t.call("reportProgress", { sourceId: "acc-jf", itemId: "m1", state: "dancing" })).errorCode, "MISSING_ARGS");
	t.stop();
});

test("Jellyfin: a refused token is AUTH_EXPIRED, a dead server SERVER_UNREACHABLE, a 500 SERVER_ERROR", async () => {
	let t = start({ routes: [["GET", /UserViews/, () => ({ status: 401, body: "" })]] });
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-jf" })).errorCode, "AUTH_EXPIRED");
	t.stop();
	t = start({ routes: [["GET", /UserViews/, () => { throw new Error("down"); }]] });
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-jf" })).errorCode, "SERVER_UNREACHABLE");
	t.stop();
	t = start({ routes: [["GET", /UserViews/, () => ({ status: 500, body: "boom" })]] });
	const r = await t.call("listSections", { sourceId: "acc-jf" });
	assert.strictEqual(r.errorCode, "SERVER_ERROR");
	assert.match(r.errorText, /500/);
	t.stop();
});

test("Jellyfin: sign-in finds the server as typed and returns the account", async () => {
	const t = start({ routes: jellyfinRoutes() });
	const r = await t.call("login", { templateId: "org.webosports.video.jellyfin", server: "http://jf.example.test:8096/web/#/home",
		username: "alice", password: "right" }, AUTH);
	assert.strictEqual(r.returnValue, true);
	assert.strictEqual(r.username, "alice@jf.example.test:8096");
	assert.strictEqual(r.alias, "Jellyfin – Home");
	assert.deepStrictEqual(r.credentials, { common: { accessToken: "new-token", server: JF, userId: "u9",
		deviceId: "luneos-" + "07".repeat(12), serverId: "s1", serverName: "Home", username: "alice" } });
	const auth = t.requests.find((x) => /AuthenticateByName/.test(x.url));
	assert.deepStrictEqual(JSON.parse(auth.body), { Username: "alice", Pw: "right" });
	assert.ok(!/Token=/.test(auth.headers.Authorization));
	const wrong = await t.call("login", { templateId: "org.webosports.video.jellyfin", server: JF, username: "alice", password: "no" }, AUTH);
	assert.strictEqual(wrong.errorCode, "BAD_ARGS");
	assert.match(wrong.errorText, /password/);
	assert.strictEqual((await t.call("login", { templateId: "org.webosports.video.jellyfin", server: "", username: "a" }, AUTH)).errorCode, "MISSING_ARGS");
	assert.strictEqual((await t.call("login", { templateId: "nope" }, AUTH)).errorCode, "BAD_ARGS");
	t.stop();
});

test("Jellyfin: a bare host is tried on https, then http, then http on 8096", async () => {
	const tried = [];
	const t = start({ routes: [
		["GET", /\/System\/Info\/Public$/, (r) => { tried.push(new URL(r.url).origin); if (!r.url.startsWith("http://nas.example.test:8096")) { throw new Error("refused"); } return { body: { Id: "s", ServerName: "NAS", ProductName: "Jellyfin Server" } }; }],
		["POST", /AuthenticateByName/, () => ({ body: { AccessToken: "t", User: { Id: "u" } } })],
	] });
	const r = await t.call("login", { templateId: "org.webosports.video.jellyfin", server: "nas.example.test", username: "bob", password: "" }, AUTH);
	assert.strictEqual(r.returnValue, true);
	assert.deepStrictEqual(tried, ["https://nas.example.test", "http://nas.example.test", "http://nas.example.test:8096"]);
	assert.strictEqual(r.credentials.common.server, "http://nas.example.test:8096");
	t.stop();
});

test("Jellyfin: something else at the address is not taken for Jellyfin", async () => {
	const t = start({ routes: [["GET", /\/System\/Info\/Public$/, () => ({ body: { Id: "x", ProductName: "Emby Server" } })]] });
	const r = await t.call("login", { templateId: "org.webosports.video.jellyfin", server: "https://emby.example.test", username: "a", password: "b" }, AUTH);
	assert.strictEqual(r.errorCode, "BAD_ARGS");
	assert.strictEqual(t.requests.filter((x) => /Authenticate/.test(x.url)).length, 0);
	t.stop();
});

test("Jellyfin: addresses", () => {
	const sc = jellyfin._test.serverCandidates;
	assert.deepStrictEqual(sc("https://jf.example.org/jellyfin/web/index.html"), ["https://jf.example.org/jellyfin"]);
	assert.deepStrictEqual(sc("10.0.0.2:8096"), ["https://10.0.0.2:8096", "http://10.0.0.2:8096"]);
	assert.deepStrictEqual(sc("ftp://x"), []);
	assert.deepStrictEqual(sc("https://u:p@x.example"), []);
	assert.deepStrictEqual(sc(""), []);
	assert.match(jellyfin._test.authHeader({}, "d\"\r\nX: y", "t"), /DeviceId="dX: y"/);
});

// --- PeerTube -----------------------------------------------------------------------------------

test("PeerTube: sections, items without NSFW, search", async () => {
	const t = start({ routes: allRoutes() });
	assert.deepStrictEqual((await t.call("listSections", { sourceId: "acc-pt" })).sections.map((s) => s.id), ["trending", "recent", "local", "views"]);
	let r = await t.call("listItems", { sourceId: "acc-pt", sectionId: "local", limit: 2 });
	assert.deepStrictEqual(r.items.map((i) => i.id), ["uu-1"]);
	assert.strictEqual(r.nextCursor, "2");
	assert.deepStrictEqual(r.items[0].artwork, { poster: PT + "/lazy-static/thumbnails/t.jpg", thumb: PT + "/lazy-static/thumbnails/t.jpg",
		backdrop: PT + "/lazy-static/previews/p.jpg" });
	assert.strictEqual(r.items[0].subtitle, "Main channel");
	const q = new URL(t.requests.find((x) => /\/api\/v1\/videos\?/.test(x.url)).url).searchParams;
	assert.strictEqual(q.get("nsfw"), "false");
	assert.strictEqual(q.get("isLocal"), "true");
	assert.strictEqual(q.get("sort"), "-publishedAt");
	r = await t.call("search", { sourceId: "acc-pt", query: "harbour" });
	assert.deepStrictEqual(r.items.map((i) => i.title), ["Harbour Lights"]);
	assert.strictEqual((await t.call("getItem", { sourceId: "acc-pt", itemId: "uu-x" })).errorCode, "NOT_FOUND");
	t.stop();
});

test("PeerTube: resolve takes the tallest MP4 that fits, else HLS; captions are WebVTT", async () => {
	let t = start({ routes: allRoutes() });
	let r = await t.call("resolve", { sourceId: "acc-pt", itemId: "uu-1", prefer: { maxHeight: 720 } });
	assert.deepStrictEqual(r.stream, { url: PT + "/f-480.mp4", protocol: "progressive", mime: "video/mp4", drm: null,
		subtitles: [{ url: PT + "/lazy-static/video-captions/c-en.vtt", format: "vtt", default: false, label: "English", lang: "en" }] });
	r = await t.call("resolve", { sourceId: "acc-pt", itemId: "uu-1" });
	assert.strictEqual(r.stream.url, PT + "/f-480.mp4", "no wish: up to 720 lines");
	r = await t.call("resolve", { sourceId: "acc-pt", itemId: "uu-1", prefer: { maxHeight: 240 } });
	assert.strictEqual(r.stream.protocol, "hls");
	assert.strictEqual(r.stream.url, PT + "/hls/master.m3u8");
	assert.strictEqual((await t.call("resolve", { sourceId: "acc-pt", itemId: "uu-x" })).errorCode, "NOT_FOUND");
	t.stop();
	t = start({ routes: allRoutes({ pt: { video: { files: [], streamingPlaylists: [], state: { id: 2 } } } }) });
	r = await t.call("resolve", { sourceId: "acc-pt", itemId: "uu-1" });
	assert.strictEqual(r.errorCode, "SERVER_ERROR");
	assert.match(r.errorText, /preparing/);
	t.stop();
});

test("PeerTube: adding an instance checks it is one", async () => {
	const t = start({ routes: allRoutes() });
	const r = await t.call("login", { templateId: "org.webosports.video.peertube", server: "pt.example.test/videos/trending" }, AUTH);
	assert.deepStrictEqual([r.username, r.alias, r.credentials], ["pt.example.test", "Tube (pt.example.test)", { common: { server: PT, name: "Tube" } }]);
	t.stop();
	const j = start({ routes: jellyfinRoutes() });
	const no = await j.call("login", { templateId: "org.webosports.video.peertube", server: "https://jf.example.test:8096" }, AUTH);
	assert.strictEqual(no.errorCode, "BAD_ARGS");
	j.stop();
});

test("PeerTube: a server whose config is not PeerTube's is refused", async () => {
	const t = start({ routes: [["GET", /\/api\/v1\/config$/, () => ({ body: { instance: { name: "Look-alike" } } })]] });
	const r = await t.call("login", { templateId: "org.webosports.video.peertube", server: "https://odd.example.test" }, AUTH);
	assert.strictEqual(r.errorCode, "BAD_ARGS");
	t.stop();
});

test("PeerTube: addresses", () => {
	const o = peertube._test.originOf;
	assert.strictEqual(o("framatube.org"), "https://framatube.org");
	assert.strictEqual(o("http://10.0.0.5:9000/w/abc"), "http://10.0.0.5:9000");
	assert.strictEqual(o("ftp://x"), null);
	assert.strictEqual(o("https://u:p@x.example"), null);
	assert.strictEqual(o(" "), null);
});

test("PeerTube: the instance list asks for healthy, non-NSFW instances and drops the rest", async () => {
	const t = start({ routes: allRoutes() });
	const r = await t.call("searchPeerTubeInstances", { query: "frama" }, AUTH);
	assert.deepStrictEqual(r.instances, [{ host: "framatube.org", name: "Framatube", description: "<b>Videos</b>", videos: 10, version: "8.3.2" }]);
	const u = new URL(t.requests.at(-1).url);
	assert.strictEqual(u.searchParams.get("healthy"), "true");
	assert.deepStrictEqual(u.searchParams.getAll("nsfwPolicy[]"), ["do_not_list", "blur"]);
	assert.strictEqual(u.searchParams.get("search"), "frama");
	t.stop();
});

// --- UPnP ---------------------------------------------------------------------------------------

test("UPnP: sections are the server's top folders, less music and pictures", async () => {
	const t = start({ routes: allRoutes() });
	await t.call("listSources", {});
	const r = await t.call("listSections", { sourceId: "acc-up|" + UDN });
	assert.deepStrictEqual(r.sections, [{ id: "c:64", title: "Browse Folders", layout: "grid" }, { id: "c:2", title: "Video", layout: "grid" }]);
	const soap = t.requests.find((x) => /ContentDir/.test(x.url) && /#Browse/.test(x.headers.SOAPAction));
	assert.strictEqual(soap.headers.SOAPAction, "\"urn:schemas-upnp-org:service:ContentDirectory:1#Browse\"");
	assert.match(soap.body, /<ObjectID>0<\/ObjectID><BrowseFlag>BrowseDirectChildren<\/BrowseFlag>/);
	t.stop();
});

test("UPnP: a server not seen yet is looked for; one not on the network is NO_SOURCE", async () => {
	let t = start({ routes: allRoutes() });
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-up|" + UDN })).returnValue, true);
	assert.strictEqual(t.ssdp.searches.length, 1);
	t.stop();
	t = start({ routes: allRoutes(), ssdp: fakeSsdp([]) });
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-up|" + UDN })).errorCode, "NO_SOURCE");
	assert.strictEqual((await t.call("listSections", { sourceId: "acc-up" })).errorCode, "NO_SOURCE");
	t.stop();
});

test("UPnP: browsing pages through folders and videos, and leaves out music, pictures and links off the network", async () => {
	const t = start({ routes: allRoutes() });
	const src = "acc-up|" + UDN;
	let r = await t.call("listItems", { sourceId: src, sectionId: "c:2", limit: 2 });
	assert.deepStrictEqual(r.items.map((i) => [i.id, i.kind, i.title]), [["v9", "movie", "Big & Small"]]);
	assert.strictEqual(r.nextCursor, "2");
	assert.strictEqual(r.items[0].durationMs, 3723500);
	assert.deepStrictEqual(r.items[0].artwork, { poster: DLNA + "/AlbumArt/9.jpg", thumb: DLNA + "/AlbumArt/9.jpg" });
	r = await t.call("listItems", { sourceId: src, sectionId: "c:2", limit: 2, cursor: "2" });
	assert.deepStrictEqual(r.items.map((i) => [i.id, i.kind, i.subtitle]), [["2$1", "collection", "0 items"]]);
	assert.strictEqual(r.nextCursor, null);
	r = await t.call("listItems", { sourceId: src, parentId: "2$15$0" });
	assert.deepStrictEqual(r.items.map((i) => i.title), ["Harbour Lights (2023)", "Night Train (2024)"]);
	r = await t.call("getItem", { sourceId: src, itemId: "2" });
	assert.deepStrictEqual([r.item.kind, r.item.title, r.item.subtitle], ["collection", "Video", "3 items"]);
	assert.deepStrictEqual(r.item.children.map((i) => i.id), ["v9", "2$1"], "no songs, no albums");
	r = await t.call("getItem", { sourceId: src, itemId: "v9" });
	assert.strictEqual(r.item.kind, "movie");
	assert.strictEqual((await t.call("getItem", { sourceId: src, itemId: "a1" })).errorCode, "NOT_FOUND");
	t.stop();
});

test("UPnP: resolve picks the tallest link that fits and finds the subtitles", async () => {
	const t = start({ routes: allRoutes() });
	const src = "acc-up|" + UDN;
	let r = await t.call("resolve", { sourceId: src, itemId: "v9", prefer: { maxHeight: 720 } });
	assert.deepStrictEqual(r.stream, { url: DLNA + "/MediaItems/9-720.mp4", protocol: "progressive", mime: "video/mp4", drm: null,
		subtitles: [{ url: DLNA + "/Captions/9.srt", format: "srt", default: false, label: "Subtitles" },
			{ url: DLNA + "/Captions/9b.srt", format: "srt", default: false, label: "Subtitles" }] });
	r = await t.call("resolve", { sourceId: src, itemId: "v9", prefer: { maxHeight: 360 } });
	assert.strictEqual(r.stream.url, DLNA + "/MediaItems/9-720.mp4", "nothing fits: the smallest there is");
	assert.strictEqual((await t.call("resolve", { sourceId: src, itemId: "a1" })).errorCode, "SERVER_ERROR");
	assert.strictEqual((await t.call("resolve", { sourceId: src, itemId: "missing" })).errorCode, "SERVER_ERROR");
	t.stop();
});

test("UPnP: search quotes what was typed", async () => {
	const t = start({ routes: allRoutes() });
	const r = await t.call("search", { sourceId: "acc-up|" + UDN, query: "say \"hi\" \\ <b>" });
	assert.deepStrictEqual(r.items.map((i) => i.id), ["v9"]);
	const req = t.requests.find((x) => /#Search/.test(x.headers.SOAPAction));
	const crit = X.childText(X.find(X.parse(req.body), "Search"), "SearchCriteria");
	assert.strictEqual(crit, "upnp:class derivedfrom \"object.item.videoItem\" and dc:title contains \"say \\\"hi\\\" \\\\ <b>\"");
	t.stop();
});

test("UPnP: search works before the libraries were listed (the service started again)", async () => {
	const t = start({ routes: allRoutes() });
	const r = await t.call("search", { sourceId: "acc-up|" + UDN, query: "big" });
	assert.deepStrictEqual(r.items.map((i) => i.id), ["v9"]);
	t.stop();
});

test("UPnP: a server that cannot search says so", async () => {
	const t = start({ routes: allRoutes({ up: { soap: (a) => a === "GetSearchCapabilities"
		? { body: "<s:Envelope xmlns:s=\"x\"><s:Body><u:GetSearchCapabilitiesResponse xmlns:u=\"y\"><SearchCaps></SearchCaps></u:GetSearchCapabilitiesResponse></s:Body></s:Envelope>" } : null } }) });
	const r = await t.call("listSources", {});
	assert.strictEqual(r.sources.find((s) => s.provider === "upnp").features.search, false);
	assert.strictEqual((await t.call("search", { sourceId: "acc-up|" + UDN, query: "x" })).errorCode, "NOT_SUPPORTED");
	t.stop();
	// The same before the libraries were listed: the provider asks the server and refuses.
	const t2 = start({ routes: allRoutes({ up: { soap: (a) => a === "GetSearchCapabilities"
		? { body: "<s:Envelope xmlns:s=\"x\"><s:Body><u:GetSearchCapabilitiesResponse xmlns:u=\"y\"><SearchCaps></SearchCaps></u:GetSearchCapabilitiesResponse></s:Body></s:Envelope>" } : null } }) });
	assert.strictEqual((await t2.call("search", { sourceId: "acc-up|" + UDN, query: "x" })).errorCode, "NOT_SUPPORTED");
	assert.strictEqual(t2.requests.filter((x) => /#Search"/.test(x.headers.SOAPAction)).length, 0);
	t2.stop();
});

test("UPnP: device descriptions", () => {
	const pd = upnpLib._test.parseDescription;
	const s = pd(fixture("minidlna-rootDesc.xml"), "http://192.168.50.20:8200/rootDesc.xml");
	assert.deepStrictEqual(s, { udn: UDN, name: "LuneOS test DLNA", control: "http://192.168.50.20:8200/ctl/ContentDir",
		icon: "http://192.168.50.20:8200/icons/lrg.jpg" });
	// A controlURL on the internet, or no ContentDirectory: not a server we use.
	const evil = fixture("minidlna-rootDesc.xml").replace("<controlURL>/ctl/ContentDir</controlURL>", "<controlURL>http://8.8.8.8/ctl</controlURL>");
	assert.strictEqual(pd(evil, "http://192.168.50.20:8200/rootDesc.xml"), null);
	assert.strictEqual(pd(fixture("minidlna-rootDesc.xml").replace(/ContentDirectory:1</g, "Other:1<"), "http://192.168.50.20:8200/"), null);
	// URLBase wins over the location.
	const based = fixture("minidlna-rootDesc.xml").replace("<specVersion>", "<URLBase>http://10.1.1.1:9/</URLBase><specVersion>");
	assert.strictEqual(pd(based, "http://192.168.50.20:8200/rootDesc.xml").control, "http://10.1.1.1:9/ctl/ContentDir");
	assert.strictEqual(pd("<root><device><UDN>x", "http://10.0.0.1/"), null);
});

test("UPnP: durations and picks", () => {
	const d = upnpLib._test.durationMs;
	assert.strictEqual(d("0:01:30.023"), 90023);
	assert.strictEqual(d("10:00:00"), 36000000);
	assert.strictEqual(d("1:2"), undefined);
	assert.strictEqual(d(""), undefined);
	assert.strictEqual(upnpLib._test.pickResource([], 720), null);
});

// --- the contract, SSDP and XML ------------------------------------------------------------------

test("contract: what leaves the service is cut to the shapes Videos draws", () => {
	assert.strictEqual(C.item({ id: "a" }), null);
	assert.strictEqual(C.item({ title: "a" }), null);
	const it = C.item({ id: "a", title: "T", kind: "weird", artwork: { poster: "javascript:alert(1)", thumb: "file:///etc/passwd", backdrop: "https://x/y.jpg" },
		webUrl: "data:x", extra: 1, durationMs: -5, progress: { positionMs: 0, watched: false } });
	assert.deepStrictEqual(it, { id: "a", kind: "video", title: "T", artwork: { backdrop: "https://x/y.jpg" }, playable: true, hasChildren: false });
	assert.deepStrictEqual(C.item({ id: "b", title: "F", kind: "season" }), { id: "b", kind: "season", title: "F", artwork: {}, playable: false, hasChildren: true });
	assert.strictEqual(C.stream({ url: "rtsp://x" }), null);
	const big = C.stream({ url: "https://x/a.m3u8", protocol: "hls", session: { pad: "x".repeat(3000) }, drm: { widevine: true } });
	assert.strictEqual(big.session, undefined);
	assert.strictEqual(big.drm, null);
	assert.deepStrictEqual(C.stream({ url: "https://x/a", subtitles: [{ url: "ftp://x" }, { url: "https://x/s", format: "ass" }] }).subtitles,
		[{ url: "https://x/s", format: "vtt", default: false }]);
	assert.strictEqual(C.text("a\u0000b"), "ab");
	assert.strictEqual(C.text("x".repeat(10), 5), "xxxx…");
	assert.strictEqual(C.cursor(""), null);
	assert.deepStrictEqual(C.section({ id: "s", title: "S", layout: "carousel" }), { id: "s", title: "S", layout: "grid" });
});

test("errors: HTTP statuses map to the service's codes", () => {
	assert.strictEqual(asServiceError({ status: 403 }).errorCode, "AUTH_EXPIRED");
	assert.strictEqual(asServiceError({ status: 404 }).errorCode, "NOT_FOUND");
	assert.strictEqual(asServiceError({ status: 502 }).errorCode, "SERVER_ERROR");
	assert.strictEqual(asServiceError({ errorCode: "CURL_FAILED" }).errorCode, "SERVER_UNREACHABLE");
	const odd = new Error("x");
	assert.strictEqual(asServiceError(odd), odd);
});

test("SSDP: only local LOCATIONs are kept", () => {
	const ok = "HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.5:8200/rootDesc.xml\r\nUSN: uuid:a::urn:x\r\nST: urn:x\r\n\r\n";
	assert.deepStrictEqual(ssdpLib.parseResponse(ok), { location: "http://192.168.1.5:8200/rootDesc.xml", usn: "uuid:a::urn:x", st: "urn:x", server: "" });
	assert.strictEqual(ssdpLib.parseResponse(ok.replace("192.168.1.5", "93.184.216.34")), null);
	assert.strictEqual(ssdpLib.parseResponse(ok.replace("200 OK", "404 Not Found")), null);
	assert.strictEqual(ssdpLib.parseResponse(ok.replace("http://", "file://")), null);
	for (const h of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "127.0.0.1", "::1", "fe80::1", "fd00::1"]) {
		assert.ok(ssdpLib.isLocalAddress(h), h);
	}
	for (const h of ["172.32.0.1", "8.8.8.8", "192.169.0.1", "example.com", "2001:db8::1"]) {
		assert.ok(!ssdpLib.isLocalAddress(h), h);
	}
});

test("SSDP: a search sends M-SEARCH twice and answers each device once", async () => {
	const { EventEmitter } = require("node:events");
	const sent = [];
	const sock = Object.assign(new EventEmitter(), {
		bind: (port, cb) => { sock.port = port; setImmediate(cb); }, setMulticastTTL: () => {}, close: () => { sock.closed = true; },
		send: (buf, o, l, port, host) => { sent.push([buf.toString(), port, host]); },
	});
	const s = ssdpLib.createSsdp({ createSocket: () => sock, log: { error: () => {} } });
	const p = s.search("urn:schemas-upnp-org:service:ContentDirectory:1", 400);
	setTimeout(() => {
		const r = "HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.5/d.xml\r\nUSN: uuid:a::urn:x\r\n\r\n";
		sock.emit("message", Buffer.from(r));
		sock.emit("message", Buffer.from(r.replace("urn:x", "urn:y").replace("192.168.1.5", "192.168.1.6")));
		sock.emit("message", Buffer.from(r.replace("uuid:a", "uuid:b").replace("192.168.1.5", "1.1.1.1")));
	}, 50);
	const found = await p;
	assert.strictEqual(found.length, 1);
	assert.strictEqual(found[0].location, "http://192.168.1.5/d.xml", "the first answer of a device is kept");
	assert.strictEqual(sent.length, 2);
	assert.match(sent[0][0], /^M-SEARCH \* HTTP\/1\.1\r\n/);
	assert.match(sent[0][0], /\r\nST: urn:schemas-upnp-org:service:ContentDirectory:1\r\n/);
	assert.deepStrictEqual(sent[0].slice(1), [1900, "239.255.255.250"]);
	assert.strictEqual(sock.port, 41900, "replies come to the port the firewall lets in");
	assert.ok(sock.closed);
});

test("SSDP: when the reply port is taken, any port", async () => {
	const { EventEmitter } = require("node:events");
	const socks = [];
	const make = () => {
		const sock = Object.assign(new EventEmitter(), {
			bind: (port, cb) => {
				sock.port = port;
				if (port === 41900) { setImmediate(() => sock.emit("error", Object.assign(new Error("bind EADDRINUSE"), { code: "EADDRINUSE" }))); }
				else { setImmediate(cb); }
			},
			setMulticastTTL: () => {}, close: () => { sock.closed = true; }, send: () => { sock.sent = (sock.sent || 0) + 1; },
		});
		socks.push(sock);
		return sock;
	};
	const logs = [];
	const found = await ssdpLib.createSsdp({ createSocket: make, log: { error: (m) => logs.push(m) } }).search("urn:x", 400);
	assert.deepStrictEqual(found, []);
	assert.deepStrictEqual(socks.map((x) => [x.port, !!x.closed, x.sent || 0]), [[41900, true, 0], [0, true, 2]]);
	assert.match(logs[0], /41900 is taken/);
});

test("XML: entities, CDATA, prefixes; no DTDs", () => {
	const d = X.parse("<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><a:r xmlns:a=\"n\"><a:t k=\"&quot;1&quot;\">x &amp; &#x41;&#66; &e; &#0;</a:t><![CDATA[<raw>]]><!-- c --></a:r>");
	const r = X.find(d, "r");
	assert.strictEqual(r.name, "a:r");
	assert.strictEqual(X.childText(r, "t"), "x & AB &e; &#0;");
	assert.strictEqual(X.find(r, "t").attrs.k, "\"1\"");
	assert.strictEqual(X.textOf(r), "x & AB &e; &#0;<raw>");
	assert.strictEqual(X.childText(X.parse("<a><b>open"), "b"), "");
	assert.strictEqual(X.textOf(X.find(X.parse("<a><b>open"), "b")), "open");
	assert.strictEqual(X.escape("<&\"'>"), "&lt;&amp;&quot;&apos;&gt;");
});

test("the templates name the capability, the service and the sign-in app", () => {
	for (const n of ["jellyfin", "peertube", "upnp"]) {
		const id = "org.webosports.video." + n;
		const [t] = JSON.parse(fs.readFileSync(path.join(__dirname, "../../video", n, "account", id, id + ".json"), "utf8"));
		assert.strictEqual(t.templateId, id);
		assert.deepStrictEqual(t.validator, { customUI: { appId: "org.webosports.app.videoauth", name: "validator.html" },
			address: "palm://org.webosports.service.videos/login" });
		for (const k of ["readPermissions", "writePermissions"]) {
			assert.ok(t[k].includes("org.webosports.service.videos") && t[k].includes("org.webosports.app.videoauth"), n + " " + k);
		}
		const cp = t.capabilityProviders[0];
		assert.strictEqual(cp.capability, service.Config.CAPABILITY);
		assert.strictEqual(cp.capabilitySubtype, "STREAMING");
		for (const i of Object.values(t.icon)) { assert.ok(fs.existsSync(path.join(__dirname, "../../video", n, "account", id, i)), i); }
		const p = require("../../video/" + n + "/provider");
		assert.strictEqual(p.templateId, id);
	}
});
