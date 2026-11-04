/* Jellyfin, as a provider of org.webosports.service.videos (see videos.js there for the API).
 *
 * Checked against Jellyfin Server 12.4.0 (2026-11-03). The calls:
 *   sign-in   GET /System/Info/Public (is it Jellyfin?), POST /Users/AuthenticateByName
 *   sections  GET /UserViews (the user's libraries), /UserItems/Resume, /Shows/NextUp, /Items/Latest
 *   items     GET /Items?ParentId=, /Shows/{id}/Seasons, /Shows/{id}/Episodes?seasonId=, /Items/{id}
 *   search    GET /Items?searchTerm=&Recursive=true
 *   play      POST /Items/{id}/PlaybackInfo with a device profile -> a direct link (static stream)
 *             or the HLS link Jellyfin transcodes to; external subtitles as WebVTT links
 *   progress  POST /Sessions/Playing, /Sessions/Playing/Progress, /Sessions/Playing/Stopped
 * Every request carries the token in the Authorization header ("MediaBrowser ... Token=").
 * Links handed to Videos carry it as ApiKey, as Jellyfin's own PlaybackInfo links do; pictures
 * need none.
 *
 * Credentials (credentials.common): { accessToken, server (origin + path, no trailing "/"), userId,
 * deviceId, serverId, serverName, username }.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const base = fs.existsSync(path.join(__dirname, "../contract.js")) ? path.join(__dirname, "..")
	: path.join(__dirname, "../../_core/service/org.webosports.service.videos");
const { CloudError } = require(path.join(base, "core.js"));
const C = require(path.join(base, "contract.js"));
const { Config } = require(path.join(base, "config.js"));

const TICKS_PER_MS = 10000;
const ITEM_FIELDS = "Overview,ProductionYear,PrimaryImageAspectRatio,ChildCount,SeriesPrimaryImage";
const PLAYABLE = ["Movie", "Episode", "Video", "MusicVideo", "Trailer"];
const KIND = { Movie: "movie", Series: "show", Season: "season", Episode: "episode", BoxSet: "collection",
	Folder: "collection", CollectionFolder: "collection", Playlist: "collection", Video: "video", MusicVideo: "video",
	Trailer: "video", TvChannel: "live", LiveTvChannel: "live" };

function authHeader(creds, deviceId, token) {
	const q = (s) => String(s).replace(/["\\\r\n]/g, "");
	let h = "MediaBrowser Client=\"" + q(Config.CLIENT_NAME) + "\", Device=\"LuneOS\", DeviceId=\"" + q(deviceId) +
		"\", Version=\"" + q(Config.CLIENT_VERSION) + "\"";
	if (token) { h += ", Token=\"" + q(token) + "\""; }
	return h;
}

// What the user typed as the server: a full address, or a host[:port]. -> candidate origins+paths.
function serverCandidates(raw) {
	const s = String(raw || "").trim().replace(/\/+$/, "");
	if (!s) { return []; }
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
	const tries = hasScheme ? [s] : ["https://" + s, "http://" + s];
	const out = [];
	for (const t of tries) {
		let u;
		try { u = new URL(t); } catch (e) { continue; }
		if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) { continue; }
		// A pasted web address ("/web/#/home", "/web/index.html") is cut back to the server.
		const p = u.pathname.replace(/\/web(\/.*)?$/i, "").replace(/\/+$/, "");
		out.push(u.origin + p);
		// A bare host on http usually means Jellyfin's own port.
		if (!hasScheme && u.protocol === "http:" && !u.port) { out.push("http://" + u.hostname + ":8096" + p); }
	}
	return Array.from(new Set(out));
}

function makeDeviceId(random) {
	return "luneos-" + random(12).toString("hex");
}

// --- requests ---------------------------------------------------------------------------------

function api(ctx, method, rel, { query, json, accept } = {}) {
	const c = ctx.creds;
	let url = c.server + rel;
	if (query) {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) { if (v !== undefined && v !== null && v !== "") { qs.set(k, String(v)); } }
		const s = qs.toString();
		if (s) { url += (url.includes("?") ? "&" : "?") + s; }
	}
	return ctx.http.json({ method, url, json, accept, headers: { Authorization: authHeader(c, c.deviceId, c.accessToken), Accept: "application/json" } });
}

// --- items ------------------------------------------------------------------------------------

function image(ctx, id, type, tag, maxHeight) {
	if (!id || !tag) { return undefined; }
	return ctx.creds.server + "/Items/" + encodeURIComponent(id) + "/Images/" + type + "?maxHeight=" + maxHeight +
		"&quality=85&tag=" + encodeURIComponent(tag);
}

function toItem(ctx, j) {
	if (!j || !j.Id) { return null; }
	const kind = KIND[j.Type] || (j.IsFolder ? "collection" : "video");
	const tags = j.ImageTags || {};
	const art = {};
	if (kind === "episode") {
		art.thumb = image(ctx, j.Id, "Primary", tags.Primary, 360);
		art.poster = image(ctx, j.SeriesId, "Primary", j.SeriesPrimaryImageTag, 480);
	} else {
		art.poster = image(ctx, j.Id, "Primary", tags.Primary, 480);
		art.thumb = image(ctx, j.Id, "Thumb", tags.Thumb, 360) ||
			image(ctx, j.Id, "Backdrop/0", (j.BackdropImageTags || [])[0], 360) || (kind === "video" ? art.poster : undefined);
	}
	art.backdrop = image(ctx, j.Id, "Backdrop/0", (j.BackdropImageTags || [])[0], 720) ||
		(j.ParentBackdropItemId ? image(ctx, j.ParentBackdropItemId, "Backdrop/0", (j.ParentBackdropImageTags || [])[0], 720) : undefined);
	const ud = j.UserData || {};
	const it = {
		id: j.Id, kind, title: j.Name,
		description: j.Overview,
		artwork: art,
		durationMs: j.RunTimeTicks ? Math.round(j.RunTimeTicks / TICKS_PER_MS) : undefined,
		year: j.ProductionYear,
		playable: PLAYABLE.includes(j.Type),
		hasChildren: !!j.IsFolder || kind === "show" || kind === "season",
		progress: { positionMs: Math.round((ud.PlaybackPositionTicks || 0) / TICKS_PER_MS), watched: ud.Played === true },
		webUrl: ctx.creds.server + "/web/#/details?id=" + encodeURIComponent(j.Id),
	};
	if (kind === "episode") {
		it.seriesTitle = j.SeriesName;
		it.season = j.ParentIndexNumber;
		it.episode = j.IndexNumber;
		const se = [j.ParentIndexNumber !== undefined ? "S" + j.ParentIndexNumber : "", j.IndexNumber !== undefined ? "E" + j.IndexNumber : ""]
			.filter(Boolean).join(" · ");
		it.subtitle = [j.SeriesName, se].filter(Boolean).join(" – ");
	} else if (kind === "season") {
		it.subtitle = j.SeriesName;
		it.season = j.IndexNumber;
	} else if (kind === "movie" || kind === "show") {
		it.subtitle = j.ProductionYear ? String(j.ProductionYear) : undefined;
	} else if (kind === "collection" && typeof j.ChildCount === "number") {
		it.subtitle = j.ChildCount + (j.ChildCount === 1 ? " item" : " items");
	}
	return it;
}

function pageOf(ctx, r, start) {
	const list = Array.isArray(r) ? r : (r.Items || []);
	const total = Array.isArray(r) ? list.length : (typeof r.TotalRecordCount === "number" ? r.TotalRecordCount : list.length);
	const next = start + list.length;
	const seen = new Set();
	const items = list.map((j) => toItem(ctx, j)).filter((it) => it && !seen.has(it.id) && seen.add(it.id));
	return { items, nextCursor: !Array.isArray(r) && list.length > 0 && next < total ? String(next) : null };
}

const startOf = (cursor) => { const n = parseInt(cursor || "0", 10); return isFinite(n) && n > 0 ? n : 0; };

// --- the provider -----------------------------------------------------------------------------

module.exports = {
	id: "jellyfin",
	templateId: "org.webosports.video.jellyfin",
	name: "Jellyfin",
	needsToken: true,

	// { server, username, password } -> the account. The address is tried as typed (no scheme:
	// https, then http, then http on 8096) until one answers as a Jellyfin server.
	async login(args, deps) {
		const username = C.text(args.username, 200);
		const password = typeof args.password === "string" ? args.password : "";
		const candidates = serverCandidates(args.server);
		if (!candidates.length || !username) { throw new CloudError("MISSING_ARGS", "Enter the server's address and your user name."); }
		const deviceId = makeDeviceId(deps.random);
		let server = null, info = null, lastError = null;
		for (const s of candidates) {
			try {
				const r = await deps.http.json({ url: s + "/System/Info/Public", timeoutMs: 10000, headers: { Accept: "application/json" } });
				if (r && r.Id && (r.ProductName === undefined || /jellyfin/i.test(r.ProductName))) { server = s; info = r; break; }
				lastError = new CloudError("BAD_ARGS", "There is no Jellyfin server at that address.");
			} catch (e) {
				lastError = (e && typeof e.status === "number")
					? new CloudError("BAD_ARGS", "There is no Jellyfin server at that address.") : e;
			}
		}
		if (!server) { throw lastError || new CloudError("SERVER_UNREACHABLE", "The server does not answer."); }
		let auth;
		try {
			auth = await deps.http.json({ method: "POST", url: server + "/Users/AuthenticateByName",
				headers: { Authorization: authHeader({}, deviceId), Accept: "application/json" }, json: { Username: username, Pw: password } });
		} catch (e) {
			if (e && (e.status === 401 || e.status === 403)) { throw new CloudError("BAD_ARGS", "The user name or password is wrong."); }
			throw e;
		}
		if (!auth || !auth.AccessToken || !auth.User || !auth.User.Id) {
			throw new CloudError("SERVER_ERROR", "The server did not sign you in.");
		}
		const host = new URL(server).host;
		return {
			username: username + "@" + host,
			alias: C.text(info.ServerName, 100) ? "Jellyfin – " + C.text(info.ServerName, 100) : "Jellyfin",
			credentials: { common: { accessToken: auth.AccessToken, server, userId: auth.User.Id, deviceId,
				serverId: info.Id, serverName: C.text(info.ServerName, 100) || host, username } },
		};
	},

	features() {
		return { search: true, progress: true, continueWatching: true, live: false };
	},

	async listSections(ctx) {
		const r = await api(ctx, "GET", "/UserViews", { query: { userId: ctx.creds.userId } });
		const views = (r.Items || []).filter((v) => !v.CollectionType || ["movies", "tvshows", "homevideos", "musicvideos", "mixed", "boxsets", "playlists"].includes(v.CollectionType));
		return [
			{ id: "continue", title: "Continue Watching", layout: "row" },
			{ id: "nextup", title: "Next Up", layout: "row" },
			{ id: "latest", title: "Recently Added", layout: "row" },
		].concat(views.map((v) => ({ id: "view:" + v.Id + ":" + (v.CollectionType || ""), title: v.Name, layout: "grid" })));
	},

	async listItems(ctx, { sectionId, parentId, cursor, limit }) {
		const userId = ctx.creds.userId;
		const start = startOf(cursor);
		const common = { userId, Fields: ITEM_FIELDS, StartIndex: start, Limit: limit, EnableImageTypes: "Primary,Backdrop,Thumb" };
		if (sectionId === "continue") {
			return pageOf(ctx, await api(ctx, "GET", "/UserItems/Resume", { query: Object.assign({ MediaTypes: "Video" }, common) }), start);
		}
		if (sectionId === "nextup") {
			return pageOf(ctx, await api(ctx, "GET", "/Shows/NextUp", { query: common }), start);
		}
		if (sectionId === "latest") {
			if (start > 0) { return { items: [], nextCursor: null }; }
			return pageOf(ctx, await api(ctx, "GET", "/Items/Latest", { query: { userId, Fields: ITEM_FIELDS, Limit: limit, IncludeItemTypes: "Movie,Episode,Series,Video" } }), 0);
		}
		if (sectionId && sectionId.startsWith("view:")) {
			const [, id, type] = sectionId.split(":");
			const q = Object.assign({ ParentId: id, SortBy: "SortName", SortOrder: "Ascending" }, common);
			if (type === "movies") { Object.assign(q, { IncludeItemTypes: "Movie", Recursive: true }); }
			else if (type === "tvshows") { Object.assign(q, { IncludeItemTypes: "Series", Recursive: true }); }
			return pageOf(ctx, await api(ctx, "GET", "/Items", { query: q }), start);
		}
		if (parentId) {
			const parent = await api(ctx, "GET", "/Items/" + encodeURIComponent(parentId), { query: { userId } });
			if (parent.Type === "Series") {
				return pageOf(ctx, await api(ctx, "GET", "/Shows/" + encodeURIComponent(parentId) + "/Seasons", { query: { userId, Fields: ITEM_FIELDS } }), 0);
			}
			if (parent.Type === "Season") {
				return pageOf(ctx, await api(ctx, "GET", "/Shows/" + encodeURIComponent(parent.SeriesId) + "/Episodes",
					{ query: { userId, seasonId: parentId, Fields: ITEM_FIELDS } }), 0);
			}
			return pageOf(ctx, await api(ctx, "GET", "/Items", { query: Object.assign({ ParentId: parentId, SortBy: "SortName" }, common) }), start);
		}
		throw new CloudError("NOT_FOUND", "No such section.");
	},

	// A show comes with its seasons, a season with its episodes.
	async getItem(ctx, { itemId }) {
		const userId = ctx.creds.userId;
		const j = await api(ctx, "GET", "/Items/" + encodeURIComponent(itemId), { query: { userId, Fields: ITEM_FIELDS } });
		const it = toItem(ctx, j);
		if (!it) { return null; }
		if (j.Type === "Series") {
			const s = await api(ctx, "GET", "/Shows/" + encodeURIComponent(itemId) + "/Seasons", { query: { userId, Fields: ITEM_FIELDS } });
			it.seasons = (s.Items || []).map((x) => toItem(ctx, x)).filter(Boolean);
		} else if (j.Type === "Season") {
			const e = await api(ctx, "GET", "/Shows/" + encodeURIComponent(j.SeriesId) + "/Episodes", { query: { userId, seasonId: itemId, Fields: ITEM_FIELDS } });
			it.children = (e.Items || []).map((x) => toItem(ctx, x)).filter(Boolean);
		}
		return it;
	},

	async search(ctx, { query, cursor, limit }) {
		const start = startOf(cursor);
		return pageOf(ctx, await api(ctx, "GET", "/Items", { query: { userId: ctx.creds.userId, searchTerm: query, Recursive: true,
			IncludeItemTypes: "Movie,Series,Episode,Video", Fields: ITEM_FIELDS, StartIndex: start, Limit: limit } }), start);
	},

	async resolve(ctx, { itemId, prefer }) {
		const c = ctx.creds;
		const item = await api(ctx, "GET", "/Items/" + encodeURIComponent(itemId), { query: { userId: c.userId } });
		if (!PLAYABLE.includes(item.Type)) { throw new CloudError("BAD_ARGS", "This is not a video."); }
		const video = prefer.codecs.length ? prefer.codecs.join(",") : "h264";
		const audio = prefer.audioCodecs.length ? prefer.audioCodecs.join(",") : "aac,mp3";
		const profile = {
			MaxStreamingBitrate: 8000000,
			DirectPlayProfiles: [{ Container: "mp4,m4v,mkv,webm,mov", Type: "Video", VideoCodec: video, AudioCodec: audio }],
			TranscodingProfiles: [{ Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: audio, Protocol: "hls",
				Context: "Streaming", MaxAudioChannels: "2", BreakOnNonKeyFrames: true }],
			ContainerProfiles: [],
			CodecProfiles: [{ Type: "Video", Codec: video, Conditions: [{ Condition: "LessThanEqual", Property: "Height", Value: String(prefer.maxHeight) }] }],
			SubtitleProfiles: [{ Format: "vtt", Method: "External" }, { Format: "srt", Method: "External" }],
		};
		const info = await api(ctx, "POST", "/Items/" + encodeURIComponent(itemId) + "/PlaybackInfo",
			{ query: { userId: c.userId, MaxStreamingBitrate: 8000000 }, json: { DeviceProfile: profile } });
		const src = (info.MediaSources || [])[0];
		if (!src) { throw new CloudError("SERVER_ERROR", "The server has no way to play this."); }
		let url, protocol;
		if (src.TranscodingUrl) {
			url = c.server + src.TranscodingUrl;
			protocol = src.TranscodingSubProtocol === "hls" ? "hls" : "progressive";
		} else if (src.SupportsDirectStream || src.SupportsDirectPlay) {
			url = c.server + "/Videos/" + encodeURIComponent(itemId) + "/stream?static=true&MediaSourceId=" +
				encodeURIComponent(src.Id) + "&ApiKey=" + encodeURIComponent(c.accessToken);
			protocol = "progressive";
		} else {
			throw new CloudError("SERVER_ERROR", "The server cannot send this video in a form this device plays.");
		}
		const subtitles = (src.MediaStreams || []).filter((s) => s.Type === "Subtitle" && s.DeliveryMethod === "External" && s.DeliveryUrl)
			.map((s) => ({
				url: c.server + s.DeliveryUrl.replace(/\/Stream\.(srt|ass|ssa|sub)(\?|$)/i, "/Stream.vtt$2"),
				label: s.DisplayTitle || s.Title || s.Language, lang: s.Language, format: "vtt",
				default: s.IsDefault === true || s.IsForced === true,
			}));
		const ud = item.UserData || {};
		return {
			url, protocol, mime: protocol === "hls" ? "application/x-mpegURL" : undefined, subtitles,
			startMs: Math.round((ud.PlaybackPositionTicks || 0) / TICKS_PER_MS) || undefined,
			session: { playSessionId: info.PlaySessionId || "", mediaSourceId: src.Id || "", method: src.TranscodingUrl ? "Transcode" : "DirectStream" },
		};
	},

	async reportProgress(ctx, { itemId, positionMs, state, session }) {
		const s = session || {};
		const body = { ItemId: itemId, MediaSourceId: s.mediaSourceId || undefined, PlaySessionId: s.playSessionId || undefined,
			PositionTicks: Math.round(positionMs * TICKS_PER_MS), CanSeek: true, PlayMethod: s.method || "Transcode" };
		if (state === "stopped" || state === "ended") {
			await api(ctx, "POST", "/Sessions/Playing/Stopped", { json: body });
			return;
		}
		body.IsPaused = state === "paused";
		await api(ctx, "POST", "/Sessions/Playing/Progress", { json: body });
	},
};

module.exports._test = { serverCandidates, toItem, authHeader };
