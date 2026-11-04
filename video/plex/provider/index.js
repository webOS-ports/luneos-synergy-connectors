/* Plex, as a provider of org.webosports.service.videos (see videos.js there for the API).
 *
 * Checked against Plex Media Server 1.43.5 (plexinc/pms-docker, 2026-11-04) and plex.tv's PIN API.
 *
 * Signing in, two ways:
 *   plex.tv   plexPin asks plex.tv for a four-character code (POST /api/v2/pins); the user enters
 *             it at plex.tv/link on any device; login then reads the pin (GET /api/v2/pins/{id})
 *             for the account's token, the user (GET /api/v2/user) and the media servers the
 *             account can reach, its own and shared ones (GET /api/v2/resources). Each server is
 *             a source of the account, as each media server is for UPnP.
 *   address   a server's address (and optionally a token), for a server that lets this network in
 *             without signing in (Settings > Network > "List of IP addresses and networks that are
 *             allowed without auth"). One source.
 *
 * A server can be reached at several addresses (on the local network, from outside, through
 * Plex's relay). The first that answers GET /identity is kept for ten minutes, local ones first.
 *
 * The calls on a server:
 *   sections  /library/sections, /hubs/continueWatching/items (/library/onDeck on older servers),
 *             /library/recentlyAdded
 *   items     /library/sections/{key}/all, /library/metadata/{id}, /library/metadata/{id}/children
 *   search    /hubs/search
 *   play      /video/:/transcode/universal/decision with the Generic client profile and what Videos
 *             plays added to it (X-Plex-Client-Profile-Extra): the file itself when Plex says
 *             direct play, else the HLS stream Plex converts to (/video/:/transcode/universal/
 *             start.m3u8); external SRT/VTT subtitles as /library/streams/{id}
 *   progress  /:/timeline (playing, paused, stopped), /:/scrobble at the end, and
 *             /video/:/transcode/universal/stop when a converted stream ends
 * Requests carry the token in X-Plex-Token; links handed to Videos carry it in the query, as Plex's
 * own clients do.
 *
 * Credentials (credentials.common):
 *   plex.tv  { mode: "plextv", accessToken, clientId, username,
 *              servers: [{ id, name, owned, accessToken, connections: [{ uri, local, relay }] }] }
 *   address  { mode: "direct", server, accessToken (may be ""), clientId, machineId, serverName }
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const base = fs.existsSync(path.join(__dirname, "../contract.js")) ? path.join(__dirname, "..")
	: path.join(__dirname, "../../_core/service/org.webosports.service.videos");
const { CloudError } = require(path.join(base, "core.js"));
const C = require(path.join(base, "contract.js"));
const { Config } = require(path.join(base, "config.js"));

const PLEX_TV = "https://plex.tv";
const LINK_URL = "https://plex.tv/link";
const RESOURCES_TTL_MS = 5 * 60 * 1000;
const CONNECTION_TTL_MS = 10 * 60 * 1000;
const PROBE_MS = 4000;
const PLAYABLE = ["movie", "episode", "clip"];
const KIND = { movie: "movie", show: "show", season: "season", episode: "episode", clip: "video", collection: "collection" };
const LIBRARY_TYPES = { movie: 1, show: 2 };
const SEARCH_TYPES = ["movie", "show", "episode", "clip"];
const SUBTITLE_CODECS = { srt: "srt", subrip: "srt", vtt: "vtt", webvtt: "vtt" };

// --- plex.tv ----------------------------------------------------------------------------------

// platform: Plex picks the client profile for a stream by it, and a header wins over the query.
function plexHeaders(clientId, token, platform = "LuneOS") {
	const h = { Accept: "application/json", "X-Plex-Product": Config.CLIENT_NAME, "X-Plex-Version": Config.CLIENT_VERSION,
		"X-Plex-Client-Identifier": clientId, "X-Plex-Platform": platform, "X-Plex-Device": "LuneOS",
		"X-Plex-Device-Name": Config.CLIENT_NAME };
	if (token) { h["X-Plex-Token"] = token; }
	return h;
}

function makeClientId(random) {
	return "luneos-" + random(12).toString("hex");
}

// /api/v2/resources -> the media servers, with what we keep of them.
function serversOf(resources) {
	return (Array.isArray(resources) ? resources : []).filter((r) => r && typeof r.provides === "string" &&
		r.provides.split(",").includes("server") && typeof r.clientIdentifier === "string" && r.clientIdentifier)
		.map((r) => ({
			id: r.clientIdentifier.replace(/\|/g, ""),
			name: C.text(r.name, 100) || "Plex",
			owned: r.owned === true,
			accessToken: typeof r.accessToken === "string" ? r.accessToken : "",
			connections: (Array.isArray(r.connections) ? r.connections : [])
				.filter((c) => c && C.isLink(c.uri))
				.map((c) => ({ uri: c.uri.replace(/\/+$/, ""), local: c.local === true, relay: c.relay === true })),
		}))
		.filter((s) => s.connections.length > 0);
}

// Local addresses first, then the server's own public ones, the relay last.
function connectionOrder(connections) {
	const rank = (c) => (c.relay ? 2 : (c.local ? 0 : 1));
	return connections.slice().sort((a, b) => rank(a) - rank(b));
}

// What the user typed as the server: a full address, or a host[:port]. -> candidate origins.
function serverCandidates(raw) {
	const s = String(raw || "").trim().replace(/\/+$/, "");
	if (!s) { return []; }
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
	const out = [];
	for (const t of (hasScheme ? [s] : ["https://" + s, "http://" + s])) {
		let u;
		try { u = new URL(t); } catch (e) { continue; }
		if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) { continue; }
		// A pasted web address ("/web/index.html#!/...") is cut back to the server.
		const p = u.pathname.replace(/\/web(\/.*)?$/i, "").replace(/\/+$/, "");
		if (!hasScheme && !u.port) { out.push(u.protocol + "//" + u.hostname + ":32400" + p); }
		out.push(u.origin + p);
	}
	return Array.from(new Set(out));
}

// Caches that outlive one call: the servers an account reaches, and the address that answered.
const resourcesCache = new Map(); // accountId -> { at, servers }
const connectionCache = new Map(); // accountId|serverId -> { at, uri, local }

async function serversFor(ctx) {
	const c = ctx.creds;
	const hit = resourcesCache.get(ctx.accountId);
	if (hit && Date.now() - hit.at < RESOURCES_TTL_MS) { return hit.servers; }
	let servers;
	try {
		servers = serversOf(await ctx.http.json({ url: PLEX_TV + "/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1",
			timeoutMs: 15000, headers: plexHeaders(c.clientId, c.accessToken) }));
	} catch (e) {
		// plex.tv says the account's token is gone: that is the account's problem, not a hiccup.
		if (e && (e.status === 401 || e.status === 403)) { throw e; }
		ctx.log.error("plex: plex.tv resources failed (" + ((e && (e.status || e.errorCode)) || e) + "), using the saved servers");
		return Array.isArray(c.servers) ? c.servers : [];
	}
	resourcesCache.set(ctx.accountId, { at: Date.now(), servers });
	if (JSON.stringify(servers) !== JSON.stringify(c.servers || [])) {
		await ctx.save(Object.assign({}, c, { servers }));
	}
	return servers;
}

// The server behind ctx: { base, token, machineId, local }.
async function serverOf(ctx, { fresh = false } = {}) {
	const c = ctx.creds;
	if (c.mode === "direct") {
		return { base: c.server, token: c.accessToken || "", machineId: c.machineId || "", local: true };
	}
	const servers = await serversFor(ctx);
	const s = servers.find((x) => x.id === ctx.sub) || (!ctx.sub && servers.length === 1 ? servers[0] : null);
	if (!s) { throw new CloudError(C.ERRORS.NO_SOURCE, "This Plex server is no longer shared with the account."); }
	const token = s.accessToken || c.accessToken;
	const key = ctx.accountId + "|" + s.id;
	const hit = connectionCache.get(key);
	if (!fresh && hit && Date.now() - hit.at < CONNECTION_TTL_MS) {
		return { base: hit.uri, token, machineId: s.id, local: hit.local };
	}
	for (const conn of connectionOrder(s.connections)) {
		try {
			await ctx.http.json({ url: conn.uri + "/identity", timeoutMs: PROBE_MS, headers: plexHeaders(c.clientId, token) });
			connectionCache.set(key, { at: Date.now(), uri: conn.uri, local: conn.local });
			return { base: conn.uri, token, machineId: s.id, local: conn.local };
		} catch (e) {
			// Next address. The error says nothing the user can act on per address.
		}
	}
	connectionCache.delete(key);
	throw new CloudError(C.ERRORS.SERVER_UNREACHABLE, "The Plex server does not answer at any of its addresses.");
}

// --- requests ---------------------------------------------------------------------------------

function query(params) {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params || {})) { if (v !== undefined && v !== null && v !== "") { qs.set(k, String(v)); } }
	return qs.toString();
}

// A request on the server. An address that stopped answering is dropped and the next one tried, once.
async function api(ctx, rel, params, { method = "GET" } = {}) {
	const go = async (s) => {
		const q = query(params);
		return { s, r: await ctx.http.json({ method, url: s.base + rel + (q ? (rel.includes("?") ? "&" : "?") + q : ""),
			headers: plexHeaders(ctx.creds.clientId, s.token) }) };
	};
	const s = await serverOf(ctx);
	try {
		return await go(s);
	} catch (e) {
		if (!(e && e.errorCode === "CURL_FAILED") || ctx.creds.mode === "direct") { throw e; }
		return go(await serverOf(ctx, { fresh: true }));
	}
}

const containerOf = (r) => (r && r.MediaContainer) || {};

// A link on the server for Videos, which sends no headers: the token, if there is one, in the query.
const linkOf = (s, p) => s.base + p + (s.token ? "?" + query({ "X-Plex-Token": s.token }) : "");

// --- items ------------------------------------------------------------------------------------

function picture(s, p, w, h) {
	if (typeof p !== "string" || !p.startsWith("/")) { return undefined; }
	return s.base + "/photo/:/transcode?" + query({ width: w, height: h, minSize: 1, upscale: 1, url: p, "X-Plex-Token": s.token });
}

function toItem(s, j) {
	if (!j || j.ratingKey === undefined || j.ratingKey === null) { return null; }
	const id = String(j.ratingKey);
	const kind = KIND[j.type] || "video";
	const art = {};
	if (kind === "episode") {
		art.thumb = picture(s, j.thumb, 480, 270);
		art.poster = picture(s, j.grandparentThumb || j.parentThumb, 320, 480);
	} else {
		art.poster = picture(s, j.thumb || j.parentThumb, 320, 480);
		art.thumb = picture(s, j.art, 480, 270) || (kind === "video" ? picture(s, j.thumb, 480, 270) : undefined);
	}
	art.backdrop = picture(s, j.art || j.grandparentArt, 1280, 720);
	const leaves = typeof j.leafCount === "number" ? j.leafCount : 0;
	const watched = PLAYABLE.includes(j.type) ? (j.viewCount || 0) > 0 : (leaves > 0 && (j.viewedLeafCount || 0) >= leaves);
	const it = {
		id, kind, title: j.title,
		description: j.summary,
		artwork: art,
		durationMs: typeof j.duration === "number" ? j.duration : undefined,
		year: j.year,
		playable: PLAYABLE.includes(j.type),
		hasChildren: ["show", "season", "collection"].includes(j.type),
		progress: { positionMs: typeof j.viewOffset === "number" ? j.viewOffset : 0, watched },
		webUrl: s.machineId ? "https://app.plex.tv/desktop/#!/server/" + encodeURIComponent(s.machineId) +
			"/details?key=" + encodeURIComponent("/library/metadata/" + id) : undefined,
	};
	if (kind === "episode") {
		it.seriesTitle = j.grandparentTitle;
		it.season = j.parentIndex;
		it.episode = j.index;
		const se = [j.parentIndex !== undefined ? "S" + j.parentIndex : "", j.index !== undefined ? "E" + j.index : ""].filter(Boolean).join(" · ");
		it.subtitle = [j.grandparentTitle, se].filter(Boolean).join(" – ");
	} else if (kind === "season") {
		it.subtitle = j.parentTitle;
		it.season = j.index;
	} else if (kind === "movie" || kind === "show") {
		it.subtitle = j.year ? String(j.year) : undefined;
	} else if (kind === "collection" && typeof j.childCount === "number") {
		it.subtitle = j.childCount + (j.childCount === 1 ? " item" : " items");
	}
	return it;
}

function itemsOf(s, list) {
	const seen = new Set();
	return (Array.isArray(list) ? list : []).map((j) => toItem(s, j)).filter((it) => it && !seen.has(it.id) && seen.add(it.id));
}

// A page of a container that Plex pages (X-Plex-Container-Start/Size, totalSize).
function pageOf(s, mc, start) {
	const list = Array.isArray(mc.Metadata) ? mc.Metadata : [];
	const total = typeof mc.totalSize === "number" ? mc.totalSize : start + list.length;
	const next = start + list.length;
	return { items: itemsOf(s, list), nextCursor: list.length > 0 && next < total ? String(next) : null };
}

const startOf = (cursor) => { const n = parseInt(cursor || "0", 10); return isFinite(n) && n > 0 ? n : 0; };
const paging = (start, limit) => ({ "X-Plex-Container-Start": start, "X-Plex-Container-Size": limit });

// --- playback ---------------------------------------------------------------------------------

const VIDEO_CODECS = ["h264", "hevc", "vp9", "av1", "mpeg4"];
const AUDIO_CODECS = ["aac", "mp3", "ac3", "eac3", "opus", "vorbis", "flac"];

// What Videos plays, as additions to Plex's (empty) Generic profile.
function profileExtra(prefer) {
	const v = prefer.codecs.filter((c) => VIDEO_CODECS.includes(c));
	const a = prefer.audioCodecs.filter((c) => AUDIO_CODECS.includes(c));
	const video = (v.length ? v : ["h264"]).join(",");
	const audio = (a.length ? a : ["aac", "mp3"]).join(",");
	// Plex 1.43.5 does not apply add-limitation (height, width) to its direct-play decision, so the
	// height is checked here instead (tooTall).
	return [
		"add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac,mp3)",
		"add-direct-play-profile(type=videoProfile&container=mp4,mkv,mov,webm&videoCodec=" + video + "&audioCodec=" + audio + ")",
	].join("+");
}

// Every version of the file is taller than asked for: have Plex convert it.
function tooTall(meta, maxHeight) {
	const media = Array.isArray(meta.Media) ? meta.Media : [];
	return media.length > 0 && media.every((m) => typeof m.height === "number" && m.height > maxHeight);
}

function transcodeParams(s, ctx, id, prefer, session, directPlay) {
	const h = prefer.maxHeight;
	return {
		hasMDE: 1, path: "/library/metadata/" + id, mediaIndex: 0, partIndex: 0, protocol: "hls", fastSeek: 1,
		directPlay: directPlay ? 1 : 0, directStream: 1, directStreamAudio: 1, location: s.local ? "lan" : "wan",
		maxVideoBitrate: h >= 1080 ? 8000 : 4000, videoResolution: Math.round(h * 16 / 9) + "x" + h, subtitles: "none",
		session, "X-Plex-Session-Identifier": session, "X-Plex-Client-Identifier": ctx.creds.clientId,
		"X-Plex-Product": Config.CLIENT_NAME, "X-Plex-Version": Config.CLIENT_VERSION,
		// Generic is Plex's empty client profile: what this device plays is all in the extra.
		"X-Plex-Platform": "Generic", "X-Plex-Client-Profile-Extra": profileExtra(prefer),
		"X-Plex-Token": s.token,
	};
}

function subtitlesOf(s, meta) {
	const part = ((meta.Media || [])[0] || {}).Part || [];
	const streams = (part[0] && Array.isArray(part[0].Stream)) ? part[0].Stream : [];
	return streams.filter((x) => x && x.streamType === 3 && typeof x.key === "string" && SUBTITLE_CODECS[x.codec])
		.map((x) => ({
			url: linkOf(s, x.key),
			label: x.displayTitle || x.title || x.languageCode, lang: x.languageCode, format: SUBTITLE_CODECS[x.codec],
			default: x.default === true || x.forced === true,
		}));
}

// --- the provider -----------------------------------------------------------------------------

module.exports = {
	id: "plex",
	templateId: "org.webosports.video.plex",
	name: "Plex",
	needsToken: false,

	// { pinId, clientId } after the code was entered at plex.tv/link, or { server, token? }.
	async login(args, deps) {
		if (args.pinId !== undefined && args.pinId !== null && args.pinId !== "") {
			const pinId = String(args.pinId);
			const clientId = C.text(args.clientId, 100);
			if (!/^\d+$/.test(pinId) || !clientId) { throw new CloudError("BAD_ARGS", "need the pinId and clientId plexPin answered"); }
			const pin = await deps.http.json({ url: PLEX_TV + "/api/v2/pins/" + pinId, timeoutMs: 15000, headers: plexHeaders(clientId) });
			const token = pin && typeof pin.authToken === "string" ? pin.authToken : "";
			if (!token) {
				throw new CloudError("NOT_LINKED", "Enter the code at " + LINK_URL + " first.");
			}
			const user = await deps.http.json({ url: PLEX_TV + "/api/v2/user", timeoutMs: 15000, headers: plexHeaders(clientId, token) });
			const servers = serversOf(await deps.http.json({ url: PLEX_TV + "/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1",
				timeoutMs: 15000, headers: plexHeaders(clientId, token) }));
			if (!servers.length) { throw new CloudError("BAD_ARGS", "This Plex account has no media server of its own or shared with it."); }
			const username = C.text(user && (user.username || user.title), 100) || "plex";
			return {
				username,
				alias: "Plex – " + username,
				credentials: { common: { mode: "plextv", accessToken: token, clientId, username, servers } },
			};
		}
		const candidates = serverCandidates(args.server);
		if (!candidates.length) { throw new CloudError("MISSING_ARGS", "Enter the code from plex.tv/link, or the server's address."); }
		const token = typeof args.token === "string" ? args.token.trim() : "";
		const clientId = makeClientId(deps.random);
		let server = null, identity = null, lastError = null;
		for (const s of candidates) {
			try {
				const r = containerOf(await deps.http.json({ url: s + "/identity", timeoutMs: 8000, headers: plexHeaders(clientId) }));
				if (r.machineIdentifier) { server = s; identity = r; break; }
				lastError = new CloudError("BAD_ARGS", "There is no Plex server at that address.");
			} catch (e) {
				lastError = (e && typeof e.status === "number") ? new CloudError("BAD_ARGS", "There is no Plex server at that address.") : e;
			}
		}
		if (!server) { throw lastError || new CloudError("SERVER_UNREACHABLE", "The server does not answer."); }
		let root;
		try {
			root = containerOf(await deps.http.json({ url: server + "/", timeoutMs: 10000, headers: plexHeaders(clientId, token) }));
		} catch (e) {
			if (e && (e.status === 401 || e.status === 403)) {
				throw new CloudError("BAD_ARGS", token ? "The server does not accept that token."
					: "This server wants a Plex sign-in. Use the code from plex.tv/link instead.");
			}
			throw e;
		}
		const host = new URL(server).host;
		const name = C.text(root.friendlyName, 100) || host;
		return {
			username: "plex@" + host,
			alias: "Plex – " + name,
			credentials: { common: { mode: "direct", server, accessToken: token, clientId,
				machineId: String(identity.machineIdentifier), serverName: name } },
		};
	},

	// The servers of a plex.tv account; one source for a server added by address.
	async sources(ctx) {
		if (ctx.creds.mode !== "plextv") { return [{ id: "", name: C.text(ctx.account.alias) || ctx.creds.serverName || "Plex" }]; }
		const servers = await serversFor(ctx);
		const several = servers.length > 1;
		return servers.map((s) => ({ id: s.id, name: several || !s.owned ? "Plex – " + s.name : (C.text(ctx.account.alias) || "Plex – " + s.name) }));
	},

	features() {
		return { search: true, progress: true, continueWatching: true, live: false };
	},

	async listSections(ctx) {
		const { r } = await api(ctx, "/library/sections");
		const libs = (containerOf(r).Directory || []).filter((d) => d && LIBRARY_TYPES[d.type] && d.key !== undefined);
		return [
			{ id: "continue", title: "Continue Watching", layout: "row" },
			{ id: "recent", title: "Recently Added", layout: "row" },
		].concat(libs.map((d) => ({ id: "lib:" + d.key + ":" + d.type, title: d.title, layout: "grid" })));
	},

	async listItems(ctx, { sectionId, parentId, cursor, limit }) {
		const start = startOf(cursor);
		if (sectionId === "continue") {
			if (start > 0) { return { items: [], nextCursor: null }; }
			let res;
			try {
				res = await api(ctx, "/hubs/continueWatching/items", { "X-Plex-Container-Size": limit });
			} catch (e) {
				// Servers from before the Continue Watching hub have On Deck.
				if (!(e && e.status === 404)) { throw e; }
				res = await api(ctx, "/library/onDeck", { "X-Plex-Container-Size": limit });
			}
			return { items: itemsOf(res.s, containerOf(res.r).Metadata), nextCursor: null };
		}
		if (sectionId === "recent") {
			if (start > 0) { return { items: [], nextCursor: null }; }
			const { s, r } = await api(ctx, "/library/recentlyAdded", paging(0, limit));
			return { items: itemsOf(s, containerOf(r).Metadata), nextCursor: null };
		}
		if (sectionId && sectionId.startsWith("lib:")) {
			const [, key, type] = sectionId.split(":");
			if (!/^\d+$/.test(key) || !LIBRARY_TYPES[type]) { throw new CloudError("NOT_FOUND", "No such section."); }
			const { s, r } = await api(ctx, "/library/sections/" + key + "/all",
				Object.assign({ type: LIBRARY_TYPES[type], sort: "titleSort" }, paging(start, limit)));
			return pageOf(s, containerOf(r), start);
		}
		if (parentId) {
			const { s, r } = await api(ctx, "/library/metadata/" + encodeURIComponent(parentId) + "/children", paging(start, limit));
			return pageOf(s, containerOf(r), start);
		}
		throw new CloudError("NOT_FOUND", "No such section.");
	},

	// A show comes with its seasons, a season with its episodes.
	async getItem(ctx, { itemId }) {
		const { s, r } = await api(ctx, "/library/metadata/" + encodeURIComponent(itemId));
		const j = (containerOf(r).Metadata || [])[0];
		const it = toItem(s, j);
		if (!it) { return null; }
		if (j.type === "show" || j.type === "season") {
			const kids = await api(ctx, "/library/metadata/" + encodeURIComponent(itemId) + "/children");
			it[j.type === "show" ? "seasons" : "children"] = itemsOf(kids.s, containerOf(kids.r).Metadata);
		}
		return it;
	},

	async search(ctx, { query: text, cursor, limit }) {
		if (startOf(cursor) > 0) { return { items: [], nextCursor: null }; }
		const { s, r } = await api(ctx, "/hubs/search", { query: text, limit });
		const found = [];
		for (const hub of containerOf(r).Hub || []) {
			if (hub && SEARCH_TYPES.includes(hub.type)) { found.push(...(hub.Metadata || [])); }
		}
		return { items: itemsOf(s, found).slice(0, limit), nextCursor: null };
	},

	async resolve(ctx, { itemId, prefer }) {
		const { s, r } = await api(ctx, "/library/metadata/" + encodeURIComponent(itemId));
		const meta = (containerOf(r).Metadata || [])[0];
		if (!meta) { throw new CloudError("NOT_FOUND", "Not found on the server."); }
		if (!PLAYABLE.includes(meta.type)) { throw new CloudError("BAD_ARGS", "This is not a video."); }
		const session = "luneos-" + crypto.randomBytes(8).toString("hex");
		const id = String(meta.ratingKey);
		const decision = containerOf(await ctx.http.json({ url: s.base + "/video/:/transcode/universal/decision?" +
			query(transcodeParams(s, ctx, id, prefer, session, !tooTall(meta, prefer.maxHeight))),
			headers: plexHeaders(ctx.creds.clientId, s.token, "Generic") }));
		const code = Number(decision.generalDecisionCode) || 0;
		const part = ((((decision.Metadata || [])[0] || {}).Media || [])[0] || {}).Part;
		const p0 = Array.isArray(part) ? part[0] : null;
		if (code >= 2000 || !p0) {
			throw new CloudError("SERVER_ERROR", "Plex cannot send this video in a form this device plays" +
				(C.text(decision.generalDecisionText, 200) ? ": " + C.text(decision.generalDecisionText, 200) : "."));
		}
		let url, protocol, method;
		if (p0.decision === "directplay" && typeof p0.key === "string") {
			url = linkOf(s, p0.key);
			protocol = "progressive";
			method = "directplay";
		} else {
			url = s.base + "/video/:/transcode/universal/start.m3u8?" + query(transcodeParams(s, ctx, id, prefer, session, false));
			protocol = "hls";
			method = "transcode";
		}
		return {
			url, protocol, mime: protocol === "hls" ? "application/x-mpegURL" : undefined,
			subtitles: subtitlesOf(s, meta),
			startMs: typeof meta.viewOffset === "number" && meta.viewOffset > 0 ? meta.viewOffset : undefined,
			session: { id: session, method, durationMs: typeof meta.duration === "number" ? meta.duration : 0 },
		};
	},

	async reportProgress(ctx, { itemId, positionMs, durationMs, state, session }) {
		const ses = session || {};
		const done = state === "stopped" || state === "ended";
		const s = await serverOf(ctx);
		const headers = plexHeaders(ctx.creds.clientId, s.token);
		if (typeof ses.id === "string" && ses.id) { headers["X-Plex-Session-Identifier"] = ses.id; }
		// Plex answers 400 to a time past the duration, which a player can report at the very end.
		const duration = Math.round(durationMs || ses.durationMs || 0);
		const time = duration > 0 ? Math.min(Math.round(positionMs), duration) : Math.round(positionMs);
		await ctx.http.json({ url: s.base + "/:/timeline?" + query({
			ratingKey: itemId, key: "/library/metadata/" + itemId, state: done ? "stopped" : state, time, duration, hasMDE: 1,
		}), headers });
		if (state === "ended") {
			await ctx.http.json({ url: s.base + "/:/scrobble?" + query({ key: itemId, identifier: "com.plexapp.plugins.library" }), headers });
		}
		if (done && ses.method === "transcode" && typeof ses.id === "string" && ses.id) {
			try {
				await ctx.http.json({ url: s.base + "/video/:/transcode/universal/stop?" + query({ session: ses.id }), headers });
			} catch (e) {
				// The conversion ends by itself when nobody fetches it; this only frees it sooner.
			}
		}
	},

	extraMethods: {
		// -> { pinId, code, clientId, expiresIn, linkUrl }. The sign-in app shows the code, the user
		// enters it at plex.tv/link, and the app calls login with pinId and clientId.
		plexPin: {
			timeoutMs: 20000,
			async handler(params, deps) {
				const clientId = makeClientId(deps.random);
				const pin = await deps.http.json({ method: "POST", url: PLEX_TV + "/api/v2/pins?strong=false", timeoutMs: 15000,
					headers: plexHeaders(clientId) });
				if (!pin || pin.id === undefined || typeof pin.code !== "string") {
					throw new CloudError("SERVER_ERROR", "plex.tv gave no code.");
				}
				return { pinId: String(pin.id), code: pin.code, clientId, expiresIn: C.count(pin.expiresIn) || 900, linkUrl: LINK_URL };
			},
		},
	},
};

module.exports._test = { serverCandidates, serversOf, connectionOrder, toItem, profileExtra, plexHeaders, tooTall,
	reset: () => { resourcesCache.clear(); connectionCache.clear(); } };
