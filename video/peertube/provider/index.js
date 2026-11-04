/* PeerTube, as a provider of org.webosports.service.videos: one instance per account, watched
 * without signing in (what the instance shows everyone). Checked against PeerTube 7.3.0 and the
 * instance directory instances.joinpeertube.org (2026-11-03).
 *
 *   add       GET /api/v1/config (is it PeerTube? its name)
 *   sections  GET /api/v1/videos?sort=-trending | -publishedAt | -views, and isLocal=true
 *   items     the same, paged with start/count; nsfw=false throughout
 *   search    GET /api/v1/search/videos?search=
 *   play      GET /api/v1/videos/{uuid}: a web video file (MP4) no taller than wanted, else the HLS
 *             playlist; GET /api/v1/videos/{uuid}/captions: WebVTT files
 *   find      searchPeerTubeInstances: the directory's healthy instances that are not NSFW, for the
 *             sign-in app's list (any other address can still be typed)
 *
 * Credentials (credentials.common): { server (origin), name }.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const base = fs.existsSync(path.join(__dirname, "../contract.js")) ? path.join(__dirname, "..")
	: path.join(__dirname, "../../_core/service/org.webosports.service.videos");
const { CloudError } = require(path.join(base, "core.js"));
const C = require(path.join(base, "contract.js"));

const DIRECTORY = "https://instances.joinpeertube.org/api/v1/instances";
const SECTIONS = [
	{ id: "trending", title: "Trending", layout: "row", query: { sort: "-trending" } },
	{ id: "recent", title: "Recently Added", layout: "row", query: { sort: "-publishedAt" } },
	{ id: "local", title: "On This Instance", layout: "row", query: { sort: "-publishedAt", isLocal: true } },
	{ id: "views", title: "Most Viewed", layout: "grid", query: { sort: "-views" } },
];

// What the user typed (a host, or a link to any page of the instance) -> its origin.
function originOf(raw) {
	const s = String(raw || "").trim();
	if (!s) { return null; }
	let u;
	try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s); } catch (e) { return null; }
	if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) { return null; }
	return u.origin;
}

function get(http, server, rel, query) {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(query || {})) { if (v !== undefined && v !== null && v !== "") { qs.set(k, String(v)); } }
	const s = qs.toString();
	return http.json({ url: server + rel + (s ? "?" + s : ""), headers: { Accept: "application/json" } });
}

const abs = (server, p) => (typeof p === "string" && p.startsWith("/") ? server + p : (C.isLink(p) ? p : undefined));

function toItem(server, v) {
	if (!v || !v.uuid || !v.name) { return null; }
	const channel = v.channel && (v.channel.displayName || v.channel.name);
	return {
		id: v.uuid, kind: v.isLive ? "live" : "video", title: v.name,
		subtitle: channel || undefined,
		description: v.description || v.truncatedDescription,
		artwork: { thumb: abs(server, v.thumbnailPath), poster: abs(server, v.thumbnailPath), backdrop: abs(server, v.previewPath) },
		durationMs: typeof v.duration === "number" && v.duration > 0 ? v.duration * 1000 : undefined,
		year: /^(\d{4})/.test(v.originallyPublishedAt || v.publishedAt || "") ? Number((v.originallyPublishedAt || v.publishedAt).slice(0, 4)) : undefined,
		playable: true, hasChildren: false,
		webUrl: C.isLink(v.url) ? v.url : server + "/w/" + encodeURIComponent(v.shortUUID || v.uuid),
	};
}

function pageOf(server, r, start) {
	const list = (r && Array.isArray(r.data) ? r.data : []).filter((v) => v && v.nsfw !== true);
	const got = r && Array.isArray(r.data) ? r.data.length : 0;
	const next = start + got;
	return { items: list.map((v) => toItem(server, v)).filter(Boolean),
		nextCursor: got > 0 && typeof r.total === "number" && next < r.total ? String(next) : null };
}

const startOf = (cursor) => { const n = parseInt(cursor || "0", 10); return isFinite(n) && n > 0 ? n : 0; };
const heightOf = (f) => (f && f.resolution && typeof f.resolution.id === "number" ? f.resolution.id : 0);

// The tallest MP4 web video no taller than wanted (0 is audio only).
function pickFile(files, maxHeight) {
	const ok = (files || []).filter((f) => heightOf(f) > 0 && heightOf(f) <= maxHeight && C.isLink(f.fileUrl));
	return ok.sort((a, b) => heightOf(b) - heightOf(a))[0] || null;
}

module.exports = {
	id: "peertube",
	templateId: "org.webosports.video.peertube",
	name: "PeerTube",
	needsToken: false,

	async login(args, deps) {
		const server = originOf(args.server);
		if (!server) { throw new CloudError("MISSING_ARGS", "Enter the PeerTube instance's address."); }
		let cfg;
		try {
			cfg = await get(deps.http, server, "/api/v1/config");
		} catch (e) {
			if (e && typeof e.status === "number") { throw new CloudError("BAD_ARGS", "There is no PeerTube instance at that address."); }
			throw e;
		}
		if (!cfg || !cfg.instance || typeof cfg.serverVersion !== "string") {
			throw new CloudError("BAD_ARGS", "There is no PeerTube instance at that address.");
		}
		const host = new URL(server).host;
		const name = C.text(cfg.instance.name, 100) || host;
		return { username: host, alias: name === host ? "PeerTube – " + host : name + " (" + host + ")",
			credentials: { common: { server, name } } };
	},

	features() {
		return { search: true, progress: false, continueWatching: false, live: true };
	},

	async listSections() {
		return SECTIONS.map((s) => ({ id: s.id, title: s.title, layout: s.layout }));
	},

	async listItems(ctx, { sectionId, cursor, limit }) {
		const s = SECTIONS.find((x) => x.id === sectionId);
		if (!s) { throw new CloudError(C.ERRORS.NOT_FOUND, "No such section."); }
		const server = ctx.creds.server;
		const start = startOf(cursor);
		return pageOf(server, await get(ctx.http, server, "/api/v1/videos",
			Object.assign({ start, count: Math.min(limit, 100), nsfw: false }, s.query)), start);
	},

	async getItem(ctx, { itemId }) {
		const v = await get(ctx.http, ctx.creds.server, "/api/v1/videos/" + encodeURIComponent(itemId));
		return v && v.nsfw === true ? null : toItem(ctx.creds.server, v);
	},

	async search(ctx, { query, cursor, limit }) {
		const server = ctx.creds.server;
		const start = startOf(cursor);
		return pageOf(server, await get(ctx.http, server, "/api/v1/search/videos",
			{ search: query, start, count: Math.min(limit, 100), nsfw: false }), start);
	},

	async resolve(ctx, { itemId, prefer }) {
		const server = ctx.creds.server;
		const v = await get(ctx.http, server, "/api/v1/videos/" + encodeURIComponent(itemId));
		if (!v || v.nsfw === true) { throw new CloudError(C.ERRORS.NOT_FOUND, "Not found on the instance."); }
		const file = pickFile(v.files, prefer.maxHeight);
		const hls = (v.streamingPlaylists || []).find((p) => C.isLink(p.playlistUrl));
		let stream;
		if (file && !v.isLive) {
			stream = { url: file.fileUrl, protocol: "progressive", mime: "video/mp4" };
		} else if (hls) {
			stream = { url: hls.playlistUrl, protocol: "hls", mime: "application/x-mpegURL" };
		} else {
			throw new CloudError(C.ERRORS.SERVER_ERROR, v.state && v.state.id !== 1
				? "The instance has not finished preparing this video." : "The instance offers no way to play this.");
		}
		let caps = [];
		try {
			const r = await get(ctx.http, server, "/api/v1/videos/" + encodeURIComponent(itemId) + "/captions");
			caps = (r && Array.isArray(r.data) ? r.data : []).map((c) => ({
				url: C.isLink(c.fileUrl) ? c.fileUrl : abs(server, c.captionPath),
				label: (c.language && c.language.label) || undefined, lang: (c.language && c.language.id) || undefined,
				format: "vtt", default: false,
			})).filter((c) => c.url);
		} catch (e) {
			ctx.log.error("peertube: no captions list: " + ((e && e.errorCode) || e));
		}
		stream.subtitles = caps;
		return stream;
	},

	extraMethods: {
		// { query?, start? } -> { instances: [{ host, name, description, videos, version }], total }
		searchPeerTubeInstances: {
			timeoutMs: 20000,
			async handler(params, deps) {
				const q = C.text(params.query, 100) || "";
				const start = C.count(params.start) || 0;
				const qs = new URLSearchParams({ start: String(start), count: "50", healthy: "true", sort: q ? "-totalUsers" : "-totalVideos" });
				qs.append("nsfwPolicy[]", "do_not_list");
				qs.append("nsfwPolicy[]", "blur");
				if (q) { qs.set("search", q); }
				const r = await deps.http.json({ url: DIRECTORY + "?" + qs.toString(), timeoutMs: 15000, headers: { Accept: "application/json" } });
				const instances = (r && Array.isArray(r.data) ? r.data : [])
					.filter((i) => i && i.isNSFW !== true && typeof i.host === "string" && originOf(i.host))
					.map((i) => ({ host: i.host, name: C.text(i.name, 100) || i.host, description: C.text(i.shortDescription, 300) || "",
						videos: C.count(i.totalVideos) || 0, version: C.text(i.version, 20) || "" }));
				return { instances, total: C.count(r && r.total) || instances.length };
			},
		},
	},
};

module.exports._test = { originOf, toItem, pickFile, pageOf };
