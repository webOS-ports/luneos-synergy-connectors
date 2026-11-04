/* Mediathek, as a provider of org.webosports.service.videos: the on-demand libraries of the German,
 * Austrian and Swiss public broadcasters (ARD and its regional channels, ZDF, Arte, 3sat, KiKA,
 * Phoenix, ORF, SRF, ...), through MediathekViewWeb (mediathekviewweb.de), the MediathekView
 * project's search over its film list. No sign-in. Checked against mediathekviewweb.de on
 * 2026-11-04 (its server: github.com/mediathekview/mediathekviewweb, server/app.ts).
 *
 *   sections  "New" (every channel, newest first), "Live TV" (the channels' livestreams), and one
 *             per channel
 *   items     POST /api/query {queries, sortBy: "timestamp", sortOrder: "desc", future: false,
 *             offset, size}: a channel is a query on the field "channel", which matches words, so
 *             "ARD" finds ARD-alpha too and the answer is kept to the channel's own names
 *   search    the same, on the fields "title" and "topic"
 *   one item  POST /api/entries [id] (when it is not among those listed lately)
 *   play      url_video_hd, url_video or url_video_low: the tallest no taller than wanted, by the
 *             size in its link where it has one; ARD's subtitles as WebVTT
 *
 * The film list only holds what the broadcasters offer as plain files and streams, so there is no
 * DRM to meet; an entry without an http(s) link is left out. It says nothing of where an item
 * plays: the CDNs' own marks in the links are read instead (geoOf), each one checked from outside
 * Germany, Austria and Switzerland, where those links answered 403 or the CDN's "not here" clip.
 *
 * MediathekViewWeb asks for no key and publishes no limits; every request says who it is
 * (User-Agent LuneOS-Videos/1.0) and answers are kept a minute, so a screen asking twice does not
 * ask the server twice.
 *
 * Credentials (credentials.common): { service: "mediathekviewweb" } (nothing secret).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const base = fs.existsSync(path.join(__dirname, "../contract.js")) ? path.join(__dirname, "..")
	: path.join(__dirname, "../../_core/service/org.webosports.service.videos");
const { CloudError } = require(path.join(base, "core.js"));
const C = require(path.join(base, "contract.js"));

const API = "https://mediathekviewweb.de/api/";
const USER_AGENT = "LuneOS-Videos/1.0";
// OpenSearch answers no further than this many results into a query.
const MAX_WINDOW = 10000;
const MAX_PAGE = 200;
const QUERY_TTL_MS = 60 * 1000;
const ENTRY_TTL_MS = 30 * 60 * 1000;
const LIMITS = { queries: 50, entries: 5000 };
const LIVE_TOPIC = "Livestream";
const GEO_TEXT = "Only in its own country";

// [section id, title, the channel's names in the film list, its language]. The names are as
// /api/channels gave them on 2026-11-04; Radio Bremen's are written three ways.
const CHANNELS = [
	["ard", "ARD", ["ARD"], "de"],
	["zdf", "ZDF", ["ZDF"], "de"],
	["arte", "Arte", ["ARTE.DE"], "de"],
	["3sat", "3sat", ["3Sat"], "de"],
	["br", "BR", ["BR"], "de"],
	["hr", "hr", ["HR"], "de"],
	["mdr", "MDR", ["MDR"], "de"],
	["ndr", "NDR", ["NDR"], "de"],
	["radiobremen", "Radio Bremen", ["Radio Bremen TV", "RBTV", "rbtv"], "de"],
	["rbb", "rbb", ["RBB"], "de"],
	["sr", "SR", ["SR"], "de"],
	["swr", "SWR", ["SWR"], "de"],
	["wdr", "WDR", ["WDR"], "de"],
	["one", "ONE", ["ONE"], "de"],
	["ardalpha", "ARD alpha", ["ARD-alpha"], "de"],
	["tagesschau24", "tagesschau24", ["tagesschau24"], "de"],
	["phoenix", "phoenix", ["PHOENIX"], "de"],
	["zdfneo", "ZDFneo", ["ZDFneo"], "de"],
	["zdfinfo", "ZDFinfo", ["ZDFinfo"], "de"],
	["zdftivi", "ZDFtivi", ["ZDF-tivi"], "de"],
	["kika", "KiKA", ["KiKA"], "de"],
	["funk", "funk", ["Funk.net"], "de"],
	["dw", "DW", ["DW"], "de"],
	["orf", "ORF", ["ORF"], "de"],
	["srf", "SRF", ["SRF"], "de"],
	["artefr", "Arte (français)", ["ARTE.FR"], "fr"],
	["arteen", "Arte (English)", ["ARTE.EN"], "en"],
	["artees", "Arte (español)", ["ARTE.ES"], "es"],
	["arteit", "Arte (italiano)", ["ARTE.IT"], "it"],
	["artepl", "Arte (polski)", ["ARTE.PL"], "pl"],
].map(([id, title, names, lang]) => ({ id, title, names, lang }));
const CHANNEL_OF = new Map();
for (const ch of CHANNELS) { for (const n of ch.names) { CHANNEL_OF.set(n, ch); } }

const NEW = "new";
const LIVE = "live";
const SECTIONS = [{ id: NEW, title: "New", layout: "row" }, { id: LIVE, title: "Live TV", layout: "row" }]
	.concat(CHANNELS.map((ch) => ({ id: "ch:" + ch.id, title: ch.title, layout: "grid" })));

// The CDNs' marks for "only in Germany" or "only in Germany, Austria and Switzerland" (or Austria,
// for ORF): [host, path]. Each was checked on 2026-11-04 against a worldwide link of the same CDN.
const GEO_RULES = [
	[/(^|\.)daserste\.de$/, /^\/(de|dach)\//],
	[/zdf-a\.akamaihd\.net$/, /^\/(de|dach)\//],
	[/^zdf-hls-\d+\.akamaized\.net$/, /\/(de|dach)\//],
	[/^cdn-storage\.br\.de$/, /^\/geo\//],
	[/^kika-progressive\.ard-mcdn\.de$/, /^\/[^/]+\/geo\//],
	[/^hr-progressive\.ard-mcdn\.de$/, /\/geoavailability_/],
	[/^ndr-progressive\.ard-mcdn\.de$/, /^\/progressive_geo/],
	[/^rbb-progressive\.ard-mcdn\.de$/, /^\/content-de\//],
	[/^(wdr-progressive\.ard-mcdn\.de|wdrmedien-a\.akamaihd\.net)$/, /\/(public|ondemand)\/de\//],
	[/^apasfiis\.sf\.apa\.at$/, /^\/ipad\/cms-austria/],
];

function geoOf(url) {
	let u;
	try { u = new URL(url); } catch (e) { return false; }
	return GEO_RULES.some(([host, p]) => host.test(u.hostname) && p.test(u.pathname));
}

// The picture height a link names: _1280x720, AVC-720 / avc720 (RBB's hd1080-avc540 is 540),
// .1080.mp4. 0 when it names none.
function heightOf(url) {
	let p;
	try { p = new URL(url).pathname; } catch (e) { return 0; }
	const m = /avc-?(\d{3,4})(?!\d)/i.exec(p) || /\d{3,4}x(\d{3,4})(?!\d)/.exec(p) || /[._-](\d{3,4})p?\.(?:mp4|m3u8)$/i.exec(p);
	const h = m ? Number(m[1]) : 0;
	return h >= 144 && h <= 2160 ? h : 0;
}

// The three links of an entry with their height: the one named in the link, else what the slot
// usually is (low 360, normal 540, HD 1080).
function candidatesOf(e) {
	const out = [];
	for (const [url, guess] of [[e.url_video_hd, 1080], [e.url_video, 540], [e.url_video_low, 360]]) {
		if (C.isLink(url) && !out.some((c) => c.url === url)) { out.push({ url, height: heightOf(url) || guess }); }
	}
	return out;
}

// The tallest link no taller than wanted, else the smallest there is.
function pickUrl(e, maxHeight) {
	const list = candidatesOf(e);
	if (list.length === 0) { return null; }
	const fit = list.filter((c) => c.height <= maxHeight).sort((a, b) => b.height - a.height);
	return (fit[0] || list.sort((a, b) => a.height - b.height)[0]).url;
}

function protocolOf(url) {
	const p = new URL(url).pathname.toLowerCase();
	if (p.endsWith(".m3u8")) { return "hls"; }
	if (p.endsWith(".mpd")) { return "dash"; }
	return "progressive";
}

const MIMES = { hls: "application/x-mpegURL", dash: "application/dash+xml" };

// ARD's subtitles come as EBU-TT; the same player service gives them as WebVTT. Others play as
// they are if they are WebVTT or SubRip; TTML and XML files Videos cannot show are left out.
const ARD_EBUTT = /^https:\/\/api\.ardmediathek\.de\/player-service\/subtitle\/ebutt\/([^/?#]+)$/;
function subtitlesOf(e) {
	const u = e.url_subtitle;
	if (!C.isLink(u)) { return []; }
	const ch = CHANNEL_OF.get(e.channel);
	const lang = ch ? ch.lang : undefined;
	const m = ARD_EBUTT.exec(u);
	let url = null, format = null;
	if (m) {
		url = "https://api.ardmediathek.de/player-service/subtitle/webvtt/" + m[1] + ".vtt";
		format = "vtt";
	} else {
		const p = new URL(u).pathname.toLowerCase();
		if (p.endsWith(".vtt")) { url = u; format = "vtt"; }
		if (p.endsWith(".srt")) { url = u; format = "srt"; }
	}
	return url ? [{ url, format, lang, label: LANGUAGES[lang] || "Subtitles", default: false }] : [];
}

const LANGUAGES = { de: "Deutsch", fr: "Français", en: "English", es: "Español", it: "Italiano", pl: "Polski" };

const isLive = (e) => e.topic === LIVE_TOPIC;

function toItem(e) {
	if (!e || typeof e.id !== "string" || !e.title) { return null; }
	const ch = CHANNEL_OF.get(e.channel);
	if (!ch || candidatesOf(e).length === 0) { return null; }
	const live = isLive(e);
	const topic = !live && typeof e.topic === "string" && e.topic && e.topic !== e.title ? e.topic : null;
	const geo = geoOf(e.url_video || e.url_video_hd || e.url_video_low);
	const t = typeof e.timestamp === "number" && e.timestamp > 0 ? e.timestamp * 1000 : 0;
	return {
		id: e.id, kind: live ? "live" : "video", title: e.title,
		subtitle: [ch.title, topic, geo ? GEO_TEXT : null].filter(Boolean).join(" · "),
		description: e.description || undefined,
		artwork: {},
		durationMs: !live && typeof e.duration === "number" && e.duration > 0 ? e.duration * 1000 : undefined,
		year: t ? new Date(t).getUTCFullYear() : undefined,
		playable: true, hasChildren: false,
		webUrl: C.isLink(e.url_website) ? e.url_website : undefined,
	};
}

// Answers kept a minute (by what was asked), and the entries seen lately (by id) for getItem and
// resolve. Both are cut to their size, the oldest first.
const answers = new Map();
const entries = new Map();

function keep(map, key, value, max) {
	map.delete(key);
	map.set(key, { at: Date.now(), value });
	while (map.size > max) { map.delete(map.keys().next().value); }
}

function fresh(map, key, ttl) {
	const hit = map.get(key);
	if (!hit) { return undefined; }
	if (Date.now() - hit.at >= ttl) { map.delete(key); return undefined; }
	return hit.value;
}

function headers(type) {
	const h = { Accept: "application/json", "User-Agent": USER_AGENT };
	if (type) { h["Content-Type"] = type; }
	return h;
}

// The film list's answer, or its error as a server error (it says "cannot query while indexing"
// with 503 while it reads a new list).
function resultOf(r) {
	if (!r || r.err) {
		throw new CloudError(C.ERRORS.SERVER_ERROR, "MediathekViewWeb answered with an error" +
			(r && Array.isArray(r.err) && C.text(r.err[0], 200) ? ": " + C.text(r.err[0], 200) : "."));
	}
	return (r.result && typeof r.result === "object") ? r.result : {};
}

function remember(list) {
	for (const e of list) { if (e && typeof e.id === "string") { keep(entries, e.id, e, LIMITS.entries); } }
}

async function query(http, body) {
	const key = JSON.stringify(body);
	const hit = fresh(answers, key, QUERY_TTL_MS);
	if (hit) { return hit; }
	const res = resultOf(await http.json({ method: "POST", url: API + "query", headers: headers("text/plain"), body: key }));
	const out = { results: Array.isArray(res.results) ? res.results.filter((e) => e && typeof e === "object") : [] };
	remember(out.results);
	keep(answers, key, out, LIMITS.queries);
	return out;
}

async function entry(http, id) {
	const hit = fresh(entries, id, ENTRY_TTL_MS);
	if (hit) { return hit; }
	const res = resultOf(await http.json({ method: "POST", url: API + "entries", headers: headers("application/json"), json: [id] }));
	// /api/entries answers the entries without their id.
	const e = Array.isArray(res.results) && res.results[0] && typeof res.results[0] === "object" ? Object.assign({}, res.results[0], { id }) : null;
	if (e) { keep(entries, id, e, LIMITS.entries); }
	return e;
}

const startOf = (cursor) => { const n = parseInt(cursor || "0", 10); return isFinite(n) && n > 0 ? n : 0; };

// One page of a query, newest first. keepIt(entry) says which of the answers to show.
async function page(http, queries, cursor, limit, keepIt) {
	const offset = startOf(cursor);
	if (offset >= MAX_WINDOW) { return { items: [], nextCursor: null }; }
	const size = Math.min(limit, MAX_PAGE, MAX_WINDOW - offset);
	const r = await query(http, { queries, sortBy: "timestamp", sortOrder: "desc", future: false, offset, size });
	const next = offset + r.results.length;
	return {
		items: r.results.filter((e) => !isLive(e) && keepIt(e)).map(toItem).filter(Boolean),
		nextCursor: r.results.length === size && next < MAX_WINDOW ? String(next) : null,
	};
}

const order = (e) => { const i = CHANNELS.indexOf(CHANNEL_OF.get(e.channel)); return i < 0 ? CHANNELS.length : i; };

async function liveItems(http) {
	const r = await query(http, { queries: [{ fields: ["topic"], query: LIVE_TOPIC.toLowerCase() }], future: true, offset: 0, size: MAX_PAGE });
	return r.results.filter(isLive).sort((a, b) => (order(a) - order(b)) || String(a.title).localeCompare(String(b.title)))
		.map(toItem).filter(Boolean);
}

module.exports = {
	id: "mediathek",
	templateId: "org.webosports.video.mediathek",
	name: "Mediathek",
	needsToken: false,

	// Nothing to sign in to: the film list is asked once, to know it can be reached.
	async login(args, deps) {
		const r = await deps.http.json({ method: "GET", url: API + "channels", headers: headers() });
		if (!r || r.error || !Array.isArray(r.channels)) {
			throw new CloudError(C.ERRORS.SERVER_ERROR, "MediathekViewWeb does not answer as expected. Try again later.");
		}
		return { username: "mediathekviewweb.de", alias: "Mediathek", credentials: { common: { service: "mediathekviewweb" } } };
	},

	features() {
		return { search: true, progress: false, continueWatching: false, live: true };
	},

	async listSections() {
		return SECTIONS.map((s) => Object.assign({}, s));
	},

	async listItems(ctx, { sectionId, cursor, limit }) {
		if (sectionId === NEW) { return page(ctx.http, [], cursor, limit, () => true); }
		if (sectionId === LIVE) { return { items: cursor ? [] : await liveItems(ctx.http), nextCursor: null }; }
		const ch = typeof sectionId === "string" && sectionId.startsWith("ch:") ? CHANNELS.find((c) => "ch:" + c.id === sectionId) : null;
		if (!ch) { throw new CloudError(C.ERRORS.NOT_FOUND, "No such section."); }
		const asked = Array.from(new Set(ch.names.map((n) => n.toLowerCase())));
		return page(ctx.http, asked.map((n) => ({ fields: ["channel"], query: n })), cursor, limit,
			(e) => ch.names.includes(e.channel));
	},

	async getItem(ctx, { itemId }) {
		return toItem(await entry(ctx.http, itemId));
	},

	async search(ctx, { query: q, cursor, limit }) {
		return page(ctx.http, [{ fields: ["title", "topic"], query: q }], cursor, limit, () => true);
	},

	async resolve(ctx, { itemId, prefer }) {
		const e = await entry(ctx.http, itemId);
		if (!e || !toItem(e)) { throw new CloudError(C.ERRORS.NOT_FOUND, "This programme is no longer in the Mediathek."); }
		const url = pickUrl(e, prefer.maxHeight);
		const protocol = protocolOf(url);
		return { url, protocol, mime: MIMES[protocol] || (/\.mp4$/i.test(new URL(url).pathname) ? "video/mp4" : undefined),
			subtitles: subtitlesOf(e), drm: null };
	},

	// For the tests.
	_test: { CHANNELS, SECTIONS, LIMITS, GEO_RULES, geoOf, heightOf, candidatesOf, pickUrl, protocolOf, subtitlesOf, toItem,
		reset: () => { answers.clear(); entries.clear(); } },
};
