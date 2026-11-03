/* contract.js - the shapes every video provider answers in, checked before they leave the service.
 *
 * Videos (org.webosports.app.videoplayer) draws every service from these alone, so what a provider
 * returns is cut down to them here: unknown fields go, wrong types go, an item with no id or title
 * goes. A provider's bug then shows as a missing tile, not as a broken screen.
 *
 *   section { id, title, layout: "row" | "grid" }
 *   item    { id, kind, title, subtitle?, description?, artwork: { poster?, thumb?, backdrop? },
 *             durationMs?, year?, seriesTitle?, season?, episode?, progress?: { positionMs, watched },
 *             playable, hasChildren, webUrl? }
 *   stream  { url, protocol: "hls" | "dash" | "progressive", mime?, subtitles: [{ url, label, lang,
 *             format: "srt" | "vtt", default }], startMs?, expiresAt?, session?, drm: null }
 *
 * Links (artwork, stream, subtitles, webUrl) must be http or https: Videos loads them as they are,
 * with no headers, so a provider that needs a token puts it in the link.
 */
"use strict";

const KINDS = ["collection", "show", "season", "episode", "movie", "video", "channel", "live"];
const LAYOUTS = ["row", "grid"];
const PROTOCOLS = ["hls", "dash", "progressive"];
const SUBTITLE_FORMATS = ["srt", "vtt"];
const MAX_TEXT = 4000;

// The error codes the service answers with, beyond _cloudcore's (MISSING_ARGS, BAD_ARGS,
// NOT_SUPPORTED, PERMISSION_DENIED, TIMEOUT).
const ERRORS = {
	AUTH_EXPIRED: "AUTH_EXPIRED",           // the server no longer takes the sign-in: add the account again
	NOT_FOUND: "NOT_FOUND",                 // the item or source is gone
	GEO_BLOCKED: "GEO_BLOCKED",             // not offered where the device is
	DRM_REQUIRED: "DRM_REQUIRED",           // the item needs a protected player
	SERVER_UNREACHABLE: "SERVER_UNREACHABLE", // no reply from the server (address, network, server down)
	SERVER_ERROR: "SERVER_ERROR",           // the server answered with an error
	NO_SOURCE: "NO_SOURCE",                 // no such source (account gone, server not found)
};

const isLink = (s) => typeof s === "string" && /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(s);

function text(v, max = MAX_TEXT) {
	if (typeof v !== "string" && typeof v !== "number") { return undefined; }
	const s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
	if (!s) { return undefined; }
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function count(v) {
	return (typeof v === "number" && isFinite(v) && v >= 0) ? Math.round(v) : undefined;
}

// Copy the fields that are set; leave out the rest (so the JSON stays small).
function pick(out, key, value) {
	if (value !== undefined && value !== null) { out[key] = value; }
	return out;
}

function section(raw) {
	if (!raw || typeof raw !== "object") { return null; }
	const id = text(raw.id, 512), title = text(raw.title, 200);
	if (!id || !title) { return null; }
	return { id, title, layout: LAYOUTS.includes(raw.layout) ? raw.layout : "grid" };
}

function item(raw) {
	if (!raw || typeof raw !== "object") { return null; }
	const id = text(raw.id, 512), title = text(raw.title, 500);
	if (!id || !title) { return null; }
	const kind = KINDS.includes(raw.kind) ? raw.kind : "video";
	const out = { id, kind, title };
	pick(out, "subtitle", text(raw.subtitle, 200));
	pick(out, "description", text(raw.description));
	const art = {};
	for (const k of ["poster", "thumb", "backdrop"]) {
		if (raw.artwork && isLink(raw.artwork[k])) { art[k] = raw.artwork[k]; }
	}
	out.artwork = art;
	pick(out, "durationMs", count(raw.durationMs));
	pick(out, "year", count(raw.year));
	pick(out, "seriesTitle", text(raw.seriesTitle, 200));
	pick(out, "season", count(raw.season));
	pick(out, "episode", count(raw.episode));
	if (raw.progress && typeof raw.progress === "object") {
		const p = { positionMs: count(raw.progress.positionMs) || 0, watched: raw.progress.watched === true };
		if (p.positionMs > 0 || p.watched) { out.progress = p; }
	}
	const folder = ["collection", "show", "season", "channel"].includes(kind);
	out.playable = typeof raw.playable === "boolean" ? raw.playable : !folder;
	out.hasChildren = typeof raw.hasChildren === "boolean" ? raw.hasChildren : folder;
	if (isLink(raw.webUrl)) { out.webUrl = raw.webUrl; }
	return out;
}

function items(list) {
	return (Array.isArray(list) ? list : []).map(item).filter(Boolean);
}

function cursor(v) {
	return (typeof v === "string" && v !== "" && v.length <= 2048) ? v : null;
}

function page(raw) {
	raw = raw || {};
	const out = { items: items(raw.items) };
	out.nextCursor = cursor(raw.nextCursor);
	return out;
}

function stream(raw) {
	if (!raw || typeof raw !== "object" || !isLink(raw.url)) { return null; }
	const out = { url: raw.url, protocol: PROTOCOLS.includes(raw.protocol) ? raw.protocol : "progressive" };
	pick(out, "mime", text(raw.mime, 100));
	out.subtitles = (Array.isArray(raw.subtitles) ? raw.subtitles : []).filter((s) => s && isLink(s.url)).map((s) => {
		const sub = { url: s.url, format: SUBTITLE_FORMATS.includes(s.format) ? s.format : "vtt", default: s.default === true };
		pick(sub, "label", text(s.label, 100));
		pick(sub, "lang", text(s.lang, 20));
		return sub;
	});
	pick(out, "startMs", count(raw.startMs));
	if (typeof raw.expiresAt === "string" && !isNaN(Date.parse(raw.expiresAt))) { out.expiresAt = raw.expiresAt; }
	// Opaque to Videos: handed back with reportProgress so the provider knows the playback.
	if (raw.session && typeof raw.session === "object") {
		const s = JSON.stringify(raw.session);
		if (s.length <= 2048) { out.session = JSON.parse(s); }
	}
	out.drm = null;
	return out;
}

function features(raw) {
	raw = raw || {};
	return {
		search: raw.search === true,
		progress: raw.progress === true,
		continueWatching: raw.continueWatching === true,
		live: raw.live === true,
	};
}

module.exports = { KINDS, LAYOUTS, PROTOCOLS, ERRORS, isLink, text, count, section, item, items, page, stream,
	features, cursor };
