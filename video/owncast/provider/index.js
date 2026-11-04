/* Owncast, as a provider of org.webosports.service.videos: live streams from self-hosted Owncast
 * servers (owncast.online). An account is either one server, or the Owncast Directory
 * (directory.owncast.online), which lists the servers that chose to be listed. Checked against
 * Owncast 0.2.4 servers and the directory on 2026-11-04, and Owncast's openapi.yaml (v0.3.0).
 *
 * A server (credentials { server (origin), name }):
 *   add       GET /api/config (its name, "Owncast v..." as its version) and GET /api/status
 *             (online, versionNumber); a bare host is tried on https, then http, then http on 8080
 *             (Owncast's own port)
 *   sections  one: "Live Now" (a row) with the stream while it is on; "Not Live Right Now" (a
 *             grid, which Videos opens to an empty list) while it is off
 *   items     the stream: "live", the stream title (else the server's name), the server's name and
 *             the number watching (unless the server hides it), /thumbnail.jpg and /logo
 *   play      GET /api/status says it is on; then /hls/stream.m3u8
 *
 * The directory (credentials { directory: true }):
 *   sections  "Live Now" (a row), the directory's categories (GET /api/tags) that have a stream
 *             on, and "All Live Streams" (a grid)
 *   items     GET /api/home's "What's Streaming Now", NSFW servers left out; an item's id is the
 *             server's origin. Pictures from the directory's copies (/api/image/thumb/{id},
 *             /api/image/logo/{id}), so a small server is not asked for them by every phone.
 *   search    over the names, stream titles, descriptions and tags, without regard to case or
 *             accents
 *   play      only a server the directory lists live now; GET <server>/api/status says it is on;
 *             then <server>/hls/stream.m3u8
 *
 * The directory is read at most every two minutes, a server's status every 20 seconds. Nothing
 * is sent on behalf of the viewer: Owncast counts a viewer by its fetches of the HLS playlist.
 * Owncast calls these APIs internal and unstable, so every field is taken as optional.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const base = fs.existsSync(path.join(__dirname, "../contract.js")) ? path.join(__dirname, "..")
	: path.join(__dirname, "../../_core/service/org.webosports.service.videos");
const { CloudError } = require(path.join(base, "core.js"));
const C = require(path.join(base, "contract.js"));

const DIRECTORY = "https://directory.owncast.online";
const UA = "LuneOS-Videos/1.0";
const LIVE_SECTION = "What's Streaming Now";
const TIMES = { directoryMs: 2 * 60 * 1000, tagsMs: 60 * 60 * 1000, statusMs: 20 * 1000, thumbMs: 5 * 60 * 1000 };
const OWNCAST_PORT = 8080;

// What the user typed (a host, host:port, or a link to any page of the server) -> the origins to
// try. Owncast is served from a host's root, so a path is dropped.
function originsOf(raw) {
	const s = String(raw || "").trim();
	if (!s) { return []; }
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
	const out = [];
	for (const t of hasScheme ? [s] : ["https://" + s, "http://" + s]) {
		let u;
		try { u = new URL(t); } catch (e) { continue; }
		if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) { continue; }
		out.push(u.origin);
		if (!hasScheme && u.protocol === "http:" && !u.port) { out.push("http://" + u.hostname + ":" + OWNCAST_PORT); }
	}
	return Array.from(new Set(out));
}

// A directory entry's url -> its origin, or null for anything but a plain http(s) server.
function originOf(raw) {
	if (typeof raw !== "string" || raw.length > 300) { return null; }
	let u;
	try { u = new URL(raw.trim()); } catch (e) { return null; }
	if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) { return null; }
	return u.origin;
}

function get(http, url, timeoutMs = 15000) {
	return http.json({ url, timeoutMs, headers: { Accept: "application/json", "User-Agent": UA } });
}

const plainText = (s, max) => C.text(typeof s === "string" ? s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
	.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
	.replace(/\s+/g, " ") : s, max);
// A picture path the server gave ("/logo") on the server, or a full link as it is.
const linkOn = (origin, p) => (typeof p === "string" && /^\/[^/\\]/.test(p) ? origin + p : (C.isLink(p) ? p : undefined));
const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const startOf = (cursor) => { const n = parseInt(cursor || "0", 10); return isFinite(n) && n > 0 ? n : 0; };
// The same picture link for a while, then a new one, so Videos does not show a stale frame.
const freshness = () => String(Math.floor(Date.now() / TIMES.thumbMs));

function pageOf(list, cursor, limit, toItem) {
	const start = startOf(cursor);
	const end = start + limit;
	return { items: list.slice(start, end).map(toItem), nextCursor: end < list.length ? String(end) : null };
}

function watching(n) {
	const c = C.count(n);
	return c === undefined ? undefined : c + " watching";
}

// --- a server ---

const statusCache = new Map();

// { online, title, viewers, version } of the server, from the cache while it is fresh.
async function statusOf(http, server) {
	const hit = statusCache.get(server);
	if (hit && Date.now() - hit.at < TIMES.statusMs) { return hit.status; }
	const s = await get(http, server + "/api/status", 10000);
	const status = { online: !!(s && s.online === true), title: C.text(s && s.streamTitle, 300),
		viewers: C.count(s && s.viewerCount), since: C.when(s && s.lastConnectTime) };
	statusCache.set(server, { at: Date.now(), status });
	return status;
}

async function configOf(http, server) {
	const cfg = await get(http, server + "/api/config", 10000);
	return cfg && typeof cfg === "object" ? cfg : {};
}

function serverItem(server, name, cfg, status) {
	const title = status.title || name;
	return {
		id: "live", kind: "live", title,
		subtitle: [title !== name ? name : null, cfg.hideViewerCount === true ? null : watching(status.viewers)].filter(Boolean).join(" · ") || undefined,
		description: plainText(cfg.summary),
		artwork: { thumb: server + "/thumbnail.jpg?t=" + freshness(), poster: linkOn(server, cfg.logo) || server + "/logo",
			backdrop: server + "/thumbnail.jpg?t=" + freshness() },
		playable: true, hasChildren: false, webUrl: server,
	};
}

// The server's stream as an item, or null while it is off.
async function liveOf(ctx) {
	const server = originOf(ctx.creds.server);
	if (!server) { throw new CloudError(C.ERRORS.AUTH_EXPIRED, "The account has no server address. Add it again."); }
	const status = await statusOf(ctx.http, server);
	if (!status.online) { return { server, item: null }; }
	let cfg = {};
	try { cfg = await configOf(ctx.http, server); } catch (e) { ctx.log.error("owncast: no config: " + ((e && e.errorCode) || e)); }
	const name = C.text(cfg.name, 100) || C.text(ctx.creds.name, 100) || new URL(server).host;
	return { server, item: serverItem(server, name, cfg, status) };
}

async function isOwncast(http, server) {
	const [cfg, status] = await Promise.all([configOf(http, server), get(http, server + "/api/status", 10000)]);
	const ok = status && typeof status === "object" && typeof status.online === "boolean" && typeof status.versionNumber === "string"
		&& typeof cfg.version === "string" && /owncast/i.test(cfg.version);
	return ok ? cfg : null;
}

// --- the directory ---

let directoryCache = null;
let tagsCache = null;

function directoryEntry(x) {
	const origin = x && originOf(x.url);
	const name = x && C.text(x.name, 200);
	if (!origin || !name || x.nsfw !== false) { return null; }
	const tags = (Array.isArray(x.tags) ? x.tags : []).filter((t) => t && typeof t.slug === "string" && typeof t.name === "string")
		.map((t) => ({ slug: t.slug, name: t.name }));
	const id = /^[0-9]{1,12}$/.test(String(x.id)) ? String(x.id) : null;
	return { origin, name, title: C.text(x.streamTitle, 300), description: plainText(x.description), tags, id,
		since: C.when(x.streamingSince) };
}

// The servers live now, from the directory, from the cache while it is fresh.
async function liveList(http) {
	if (directoryCache && Date.now() - directoryCache.at < TIMES.directoryMs) { return directoryCache.list; }
	const home = await get(http, DIRECTORY + "/api/home");
	const sec = (home && Array.isArray(home.sections) ? home.sections : []).find((s) => s && (s.online === true || s.name === LIVE_SECTION));
	const seen = new Set();
	const list = (sec && Array.isArray(sec.instances) ? sec.instances : []).map(directoryEntry)
		.filter((e) => e && !seen.has(e.origin) && seen.add(e.origin));
	directoryCache = { at: Date.now(), list };
	return list;
}

// The directory's categories [{ slug, name }]; none when it cannot be read.
async function categories(ctx) {
	if (tagsCache && Date.now() - tagsCache.at < TIMES.tagsMs) { return tagsCache.list; }
	let list = [];
	try {
		const r = await get(ctx.http, DIRECTORY + "/api/tags");
		list = (Array.isArray(r) ? r : []).filter((t) => t && typeof t.slug === "string" && /^[a-z0-9-]{1,50}$/.test(t.slug) && C.text(t.name, 50))
			.map((t) => ({ slug: t.slug, name: C.text(t.name, 50) }));
	} catch (e) {
		ctx.log.error("owncast: no directory categories: " + ((e && e.errorCode) || e));
		return list;
	}
	tagsCache = { at: Date.now(), list };
	return list;
}

function directoryItem(e) {
	const art = {};
	if (e.id) {
		art.thumb = DIRECTORY + "/api/image/thumb/" + e.id + "?t=" + freshness();
		art.backdrop = art.thumb;
		art.poster = DIRECTORY + "/api/image/logo/" + e.id;
	}
	return {
		id: e.origin, kind: "live", title: e.title || e.name,
		subtitle: e.title ? e.name : (e.tags.length ? e.tags.slice(0, 3).map((t) => t.name).join(", ") : undefined),
		description: e.description, artwork: art, playable: true, hasChildren: false, webUrl: e.origin,
	};
}

const isDirectory = (ctx) => ctx.creds && ctx.creds.directory === true;

async function playable(ctx, server, name) {
	const status = await statusOf(ctx.http, server);
	if (!status.online) { throw new CloudError(C.ERRORS.NOT_FOUND, name + " is not live right now."); }
	return { url: server + "/hls/stream.m3u8", protocol: "hls", mime: "application/x-mpegURL", subtitles: [], drm: null };
}

module.exports = {
	id: "owncast",
	templateId: "org.webosports.video.owncast",
	name: "Owncast",
	needsToken: false,

	// { server } adds one server; { directory: true } the directory.
	async login(args, deps) {
		if (args.directory === true) {
			await get(deps.http, DIRECTORY + "/api/home");
			return { username: "directory.owncast.online", alias: "Owncast Directory", credentials: { common: { directory: true } } };
		}
		const tries = originsOf(args.server);
		if (!tries.length) { throw new CloudError("MISSING_ARGS", "Enter the Owncast server's address."); }
		const none = () => new CloudError("BAD_ARGS", "There is no Owncast server at that address.");
		// A server that answered as something else says more than one that did not answer.
		let server = null, cfg = null, answered = false, lastError = null;
		for (const s of tries) {
			try {
				cfg = await isOwncast(deps.http, s);
				if (cfg) { server = s; break; }
				answered = true;
			} catch (e) {
				if ((e && typeof e.status === "number") || (e && e.errorCode && e.errorCode !== "CURL_FAILED")) { answered = true; } else { lastError = e; }
			}
		}
		if (!server) { throw answered || !lastError ? none() : lastError; }
		const host = new URL(server).host;
		const name = C.text(cfg.name, 100) || host;
		return { username: host, alias: name === host ? "Owncast – " + host : name + " (" + host + ")",
			credentials: { common: { server, name } } };
	},

	// One source, the account, as by default; declared so that listSources reads the credentials,
	// which say whether the account is the directory (and so can be searched).
	async sources(ctx) {
		const a = ctx.account || {};
		return [{ id: "", name: C.text(a.alias) || C.text(a.username) || (isDirectory(ctx) ? "Owncast Directory" : "Owncast") }];
	},

	features(ctx) {
		return { search: isDirectory(ctx || {}), progress: false, continueWatching: false, live: true };
	},

	async listSections(ctx) {
		if (isDirectory(ctx)) {
			const list = await liveList(ctx.http);
			const cats = (await categories(ctx)).filter((t) => list.some((e) => e.tags.some((x) => x.slug === t.slug)));
			return [{ id: "live", title: "Live Now", layout: "row" }]
				.concat(cats.map((t) => ({ id: "tag:" + t.slug, title: t.name, layout: "grid" })),
					[{ id: "all", title: "All Live Streams", layout: "grid" }]);
		}
		const { item } = await liveOf(ctx);
		return [item ? { id: "live", title: "Live Now", layout: "row" } : { id: "live", title: "Not Live Right Now", layout: "grid" }];
	},

	async listItems(ctx, { sectionId, cursor, limit }) {
		if (isDirectory(ctx)) {
			const list = await liveList(ctx.http);
			let hits;
			if (sectionId === "live" || sectionId === "all") {
				hits = list;
			} else if (typeof sectionId === "string" && sectionId.startsWith("tag:")) {
				const slug = sectionId.slice(4);
				hits = list.filter((e) => e.tags.some((t) => t.slug === slug));
			} else {
				throw new CloudError(C.ERRORS.NOT_FOUND, "No such section.");
			}
			return pageOf(hits, cursor, limit, directoryItem);
		}
		if (sectionId !== "live") { throw new CloudError(C.ERRORS.NOT_FOUND, "No such section."); }
		const { item } = await liveOf(ctx);
		return { items: item ? [item] : [], nextCursor: null };
	},

	async getItem(ctx, { itemId }) {
		if (isDirectory(ctx)) {
			const e = (await liveList(ctx.http)).find((x) => x.origin === itemId);
			return e ? directoryItem(e) : null;
		}
		if (itemId !== "live") { return null; }
		return (await liveOf(ctx)).item;
	},

	async search(ctx, { query, cursor, limit }) {
		if (!isDirectory(ctx)) { return { items: [], nextCursor: null }; }
		const words = fold(query).split(/\s+/).filter(Boolean);
		const list = await liveList(ctx.http);
		const hits = words.length === 0 ? [] : list.filter((e) => {
			const hay = fold([e.name, e.title, e.description].concat(e.tags.map((t) => t.name)).join(" "));
			return words.every((w) => hay.includes(w));
		});
		return pageOf(hits, cursor, limit, directoryItem);
	},

	async resolve(ctx, { itemId }) {
		if (isDirectory(ctx)) {
			const e = (await liveList(ctx.http)).find((x) => x.origin === itemId);
			if (!e) { throw new CloudError(C.ERRORS.NOT_FOUND, "That stream is no longer live in the Owncast Directory."); }
			return playable(ctx, e.origin, e.name);
		}
		const server = originOf(ctx.creds.server);
		if (itemId !== "live" || !server) { throw new CloudError(C.ERRORS.NOT_FOUND, "Not found on the server."); }
		return playable(ctx, server, C.text(ctx.creds.name, 100) || new URL(server).host);
	},

	// For the tests.
	_test: { TIMES, DIRECTORY, UA, originsOf, originOf, plainText, linkOn, directoryEntry, directoryItem, serverItem, fold,
		reset: () => { statusCache.clear(); directoryCache = null; tagsCache = null; } },
};
