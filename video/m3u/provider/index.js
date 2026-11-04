/* M3U playlists, as a provider of org.webosports.service.videos: an IPTV list or any playlist of
 * streams on the web, one account per playlist. The extended M3U that IPTV services hand out:
 *
 *   #EXTM3U x-tvg-url="..."
 *   #EXTINF:-1 tvg-id="one.uk" tvg-logo="https://.../one.png" group-title="News",Channel One
 *   https://cdn.example/one/index.m3u8
 *
 *   sections  each group-title (or #EXTGRP) in the order the list has them, with "All Channels"
 *             first when there are several; a list without groups is one section
 *   items     the entries: "live" for a duration of -1 or 0 (a channel), "video" with its length
 *             otherwise; tvg-logo is the picture
 *   search    the names and groups, without regard to case or accents
 *   play      the entry's link: HLS for .m3u8, DASH for .mpd, else a plain stream (MPEG-TS, MP4...)
 *
 * Only http and https entries are kept (Videos plays nothing else). #EXTVLCOPT and #KODIPROP lines
 * (a user agent, a referrer, DRM keys) are not followed: Videos sends no headers.
 *
 * Credentials (credentials.common): { url, name }. The playlist's address often holds the IPTV
 * service's user name and password (get.php?username=...&password=..., or in the path), so it is
 * kept as a credential, never shown in the account's name, and no error passes it on.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const base = fs.existsSync(path.join(__dirname, "../contract.js")) ? path.join(__dirname, "..")
	: path.join(__dirname, "../../_core/service/org.webosports.service.videos");
const { CloudError } = require(path.join(base, "core.js"));
const C = require(path.join(base, "contract.js"));

// Big IPTV lists run to tens of thousands of entries; past these the list is cut.
const LIMITS = { chars: 48 * 1024 * 1024, entries: 100000 };
// How long a fetched list is used before it is fetched again.
const CACHE_MS = 15 * 60 * 1000;
const ALL = "all";

// What was typed -> the playlist's address, or null.
function playlistUrlOf(raw) {
	const s = String(raw || "").trim();
	if (!s) { return null; }
	let u;
	try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "http://" + s); } catch (e) { return null; }
	if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname) { return null; }
	u.hash = "";
	return u;
}

// The account's name for a list: its host and file name. The path before the file name and the
// query are left out - they are where IPTV services put the user name and password.
function nameOf(u) {
	const file = decodeURIComponent((u.pathname.split("/").pop() || "").replace(/%(?![0-9a-f]{2})/gi, "%25"));
	return u.host + (file ? " · " + file : "");
}

// #EXTINF:<duration> key="value" key=value,Title -> { duration, attrs, title }
function parseExtinf(line) {
	const rest = line.slice("#EXTINF:".length);
	let quote = false, comma = -1;
	for (let i = 0; i < rest.length; i++) {
		const ch = rest[i];
		if (ch === "\"") { quote = !quote; } else if (ch === "," && !quote) { comma = i; break; }
	}
	const head = comma >= 0 ? rest.slice(0, comma) : rest;
	const title = comma >= 0 ? rest.slice(comma + 1).trim() : "";
	const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(head);
	const attrs = {};
	const re = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|([^\s"]+))/g;
	let a;
	while ((a = re.exec(head)) !== null) { attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : a[3]; }
	return { duration: m ? Number(m[1]) : -1, attrs, title };
}

function idOf(url, title) {
	return crypto.createHash("sha256").update(url + "\n" + title).digest("hex").slice(0, 20);
}

function fileTitle(u) {
	const last = u.pathname.split("/").filter(Boolean).pop() || u.host;
	try { return decodeURIComponent(last).replace(/\.[a-z0-9]{2,4}$/i, ""); } catch (e) { return last; }
}

/* text -> { entries: [{ id, title, url, group, logo, durationMs }], skipped, cut }. Entries with
 * a link that is not http(s), or that Videos cannot play, are counted in skipped. */
function parse(text, baseUrl) {
	// trim() below also drops a byte order mark.
	const lines = String(text || "").split(/\r\n|\r|\n/);
	const entries = [];
	const seen = new Set();
	let info = null, group = null, skipped = 0, cut = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) { continue; }
		if (line.startsWith("#EXTINF:")) { info = parseExtinf(line); continue; }
		if (line.startsWith("#EXTGRP:")) { group = line.slice(8).trim() || null; continue; }
		if (line.startsWith("#")) { continue; }
		const meta = info || { duration: -1, attrs: {}, title: "" };
		const grp = C.text(meta.attrs["group-title"], 200) || C.text(group, 200) || null;
		info = null;
		group = null;
		let u;
		try { u = new URL(line, baseUrl); } catch (e) { skipped++; continue; }
		if (u.protocol !== "http:" && u.protocol !== "https:") { skipped++; continue; }
		if (entries.length >= LIMITS.entries) { cut = true; break; }
		const url = u.href;
		const title = C.text(meta.title, 500) || C.text(meta.attrs["tvg-name"], 500) || fileTitle(u);
		const id = idOf(url, title);
		// The same link twice under one name is one entry; under another name, both are kept.
		if (seen.has(id)) { continue; }
		seen.add(id);
		const logo = meta.attrs["tvg-logo"];
		entries.push({ id, title, url, group: grp, logo: C.isLink(logo) ? logo : undefined,
			durationMs: meta.duration > 0 ? Math.round(meta.duration * 1000) : 0 });
	}
	return { entries, skipped, cut };
}

function protocolOf(url) {
	const p = new URL(url).pathname.toLowerCase();
	if (p.endsWith(".m3u8")) { return "hls"; }
	if (p.endsWith(".mpd")) { return "dash"; }
	return "progressive";
}

function groupsOf(entries) {
	const out = [];
	const seen = new Set();
	for (const e of entries) {
		if (e.group && !seen.has(e.group)) { seen.add(e.group); out.push(e.group); }
	}
	return out;
}

function toItem(e) {
	return {
		id: e.id, kind: e.durationMs > 0 ? "video" : "live", title: e.title,
		subtitle: e.group || undefined,
		artwork: e.logo ? { thumb: e.logo, poster: e.logo } : {},
		durationMs: e.durationMs > 0 ? e.durationMs : undefined,
		playable: true, hasChildren: false,
	};
}

const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const startOf = (cursor) => { const n = parseInt(cursor || "0", 10); return isFinite(n) && n > 0 ? n : 0; };

function pageOf(list, cursor, limit) {
	const start = startOf(cursor);
	const end = start + limit;
	return { items: list.slice(start, end).map(toItem), nextCursor: end < list.length ? String(end) : null };
}

/* Fetches and reads the list. Every failure is said without the address, which may hold a password:
 * the shared HTTP client's errors keep a URL's path. */
async function fetchList(http, url) {
	let r;
	try {
		r = await http.request({ method: "GET", url: url.href, headers: { Accept: "audio/x-mpegurl, application/vnd.apple.mpegurl, */*" } });
	} catch (e) {
		if (e && typeof e.status === "number") {
			if (e.status === 401 || e.status === 403) {
				throw new CloudError(C.ERRORS.AUTH_EXPIRED, "The playlist's server refused it (" + e.status + "). Check the address, or the IPTV subscription.", { status: e.status });
			}
			if (e.status === 404) { throw new CloudError(C.ERRORS.NOT_FOUND, "There is no playlist at that address.", { status: 404 }); }
			throw new CloudError(C.ERRORS.SERVER_ERROR, "The playlist's server answered with an error (" + e.status + ").", { status: e.status });
		}
		throw new CloudError(C.ERRORS.SERVER_UNREACHABLE, "The playlist's server does not answer. Check the address and the network.");
	}
	const text = String((r && r.text) || "");
	if (text.length > LIMITS.chars) { throw new CloudError("BAD_ARGS", "That playlist is too big for this device."); }
	if (/^\s*<(!doctype|html|\?xml)/i.test(text)) {
		throw new CloudError("BAD_ARGS", "That address gives a web page, not a playlist.");
	}
	const list = parse(text, url.href);
	if (list.entries.length === 0) {
		throw new CloudError("BAD_ARGS", list.skipped > 0 ? "The playlist has no web streams that Videos can play."
			: "There are no streams in that playlist.");
	}
	return list;
}

const cache = new Map();

// The account's list, from the cache while it is fresh.
async function listOf(ctx) {
	const url = playlistUrlOf(ctx.creds.url);
	if (!url) { throw new CloudError(C.ERRORS.AUTH_EXPIRED, "The account has no playlist address. Add it again."); }
	const key = ctx.accountId;
	const hit = cache.get(key);
	if (hit && hit.url === url.href && Date.now() - hit.at < CACHE_MS) { return hit.list; }
	const list = await fetchList(ctx.http, url);
	cache.set(key, { url: url.href, at: Date.now(), list });
	return list;
}

module.exports = {
	id: "m3u",
	templateId: "org.webosports.video.m3u",
	name: "M3U",
	needsToken: false,

	async login(args, deps) {
		const url = playlistUrlOf(args.url);
		if (!url) { throw new CloudError("MISSING_ARGS", "Enter the playlist's web address (http or https)."); }
		if (url.username || url.password) {
			throw new CloudError("BAD_ARGS", "Put the user name and password the way the IPTV service gives them in the address, not before the host.");
		}
		await fetchList(deps.http, url);
		const name = C.text(args.name, 100);
		const where = nameOf(url);
		return { username: where, alias: name || "M3U – " + where,
			credentials: { common: { url: url.href, name: name || "" } } };
	},

	features() {
		return { search: true, progress: false, continueWatching: false, live: true };
	},

	async listSections(ctx) {
		const groups = groupsOf((await listOf(ctx)).entries);
		const all = { id: ALL, title: groups.length ? "All Channels" : "Channels", layout: "grid" };
		return [all].concat(groups.length > 1 ? groups.map((g) => ({ id: "g:" + g, title: g, layout: "grid" })) : []);
	},

	async listItems(ctx, { sectionId, cursor, limit }) {
		const { entries } = await listOf(ctx);
		let list;
		if (sectionId === ALL) {
			list = entries;
		} else if (typeof sectionId === "string" && sectionId.startsWith("g:")) {
			const g = sectionId.slice(2);
			list = entries.filter((e) => e.group === g);
		} else {
			throw new CloudError(C.ERRORS.NOT_FOUND, "No such section.");
		}
		return pageOf(list, cursor, limit);
	},

	async getItem(ctx, { itemId }) {
		const e = (await listOf(ctx)).entries.find((x) => x.id === itemId);
		return e ? toItem(e) : null;
	},

	async search(ctx, { query, cursor, limit }) {
		const words = fold(query).split(/\s+/).filter(Boolean);
		const { entries } = await listOf(ctx);
		const hits = words.length === 0 ? [] : entries.filter((e) => {
			const hay = fold(e.title + " " + (e.group || ""));
			return words.every((w) => hay.includes(w));
		});
		return pageOf(hits, cursor, limit);
	},

	async resolve(ctx, { itemId }) {
		const e = (await listOf(ctx)).entries.find((x) => x.id === itemId);
		if (!e) { throw new CloudError(C.ERRORS.NOT_FOUND, "That channel is no longer in the playlist."); }
		return { url: e.url, protocol: protocolOf(e.url), subtitles: [], session: null, drm: null };
	},

	// For the tests.
	_test: { LIMITS, playlistUrlOf, nameOf, parseExtinf, parse, protocolOf, groupsOf, toItem, fold, reset: () => cache.clear() },
};
