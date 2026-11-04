/* The Internet Archive (archive.org), as a provider of org.webosports.service.videos: its public
 * moving-image collections (feature films, classic TV, cartoons, Prelinger's films, ...), watched
 * without signing in. Checked against archive.org on 2026-11-04.
 *
 *   sections  GET /advancedsearch.php?q=collection:<id> AND mediatype:movies ...&sort[]=downloads desc,
 *             paged with page/rows (advancedsearch ignores start)
 *   search    the same over every moving-image item, the words in title, creator or subject
 *   item      GET /metadata/<identifier>: its files. Every video the item holds (an original and
 *             the MP4s made from it; renditions of the same length counted once) is one title:
 *             one title plays as it is, several (a series, a collection of shorts) are children
 *   play      https://archive.org/download/<identifier>/<file>: an MP4 (h.264 derivative, or an
 *             MP4 original) no taller than wanted; .srt and .vtt files of that video as subtitles
 *   artwork   /services/img/<identifier>; a title's own thumbnail (<id>.thumbs/...) for children
 *
 * Lists show an item with a runtime (a film, one episode) as playable and one without (a series,
 * a box of cartoons) as a folder of its titles, since one search call cannot tell more without
 * asking each item. A playable item with several titles plays the longest.
 *
 * Every query leaves out what archive.org only lends or keeps back (access-restricted-item, the
 * lending collections, stream_only) and what has no MP4; resolve checks the item's metadata again.
 *
 * Credentials (credentials.common): { kind: "archive" } - nothing to sign in to.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const base = fs.existsSync(path.join(__dirname, "../contract.js")) ? path.join(__dirname, "..")
	: path.join(__dirname, "../../_core/service/org.webosports.service.videos");
const { CloudError } = require(path.join(base, "core.js"));
const C = require(path.join(base, "contract.js"));

const ORIGIN = "https://archive.org";
// archive.org asks clients to say who they are; no contact address is sent.
const UA = "LuneOS-Videos/1.0";
const SEARCH_MS = 15000;
const METADATA_MS = 20000;
const MAX_ROWS = 100;
// Items' metadata, kept so that getItem, listItems(parentId) and resolve of one item ask once.
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 40;

// Collections, as archive.org names them. Rows are shown with their items on the source's page;
// grids are libraries opened with a tap (and asked nothing until then).
const SECTIONS = [
	{ id: "feature_films", title: "Feature Films", layout: "row" },
	{ id: "classic_tv", title: "Classic TV", layout: "row" },
	{ id: "animationandcartoons", title: "Animation & Cartoons", layout: "row" },
	{ id: "silent_films", title: "Silent Films", layout: "grid" },
	{ id: "SciFi_Horror", title: "Sci-Fi / Horror", layout: "grid" },
	{ id: "Film_Noir", title: "Film Noir", layout: "grid" },
	{ id: "Comedy_Films", title: "Comedy Films", layout: "grid" },
	{ id: "short_films", title: "Short Films", layout: "grid" },
	{ id: "prelinger", title: "Prelinger Archives", layout: "grid" },
	{ id: "newsandpublicaffairs", title: "News & Public Affairs", layout: "grid" },
];

// What archive.org only lends (its books' lending collections, items streamed only to the
// signed-in) or keeps back is left out of every list and refused by resolve.
const LENDING = ["inlibrary", "printdisabled", "lendinglibrary", "stream_only"];
// MP4 formats archive.org derives or takes as originals, the most compatible first.
const FORMATS = ["h.264", "h.264 IA", "512Kb MPEG4", "h.264 MPEG4", "h.264 HD", "MPEG4", "HiRes MPEG4"];
const PLAYABLE = "mediatype:movies AND -access-restricted-item:true AND -collection:(" + LENDING.join(" OR ") + ")" +
	" AND format:(" + FORMATS.map((f) => "\"" + f + "\"").join(" OR ") + ")";
const FIELDS = ["identifier", "title", "creator", "year", "date", "runtime", "description"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MP4_RE = /\.(mp4|m4v)$/i;
const SUB_RE = /\.(srt|vtt)$/i;

// archive.org's fields are a string, or a list of them.
function str(v) {
	if (Array.isArray(v)) { return v.filter((x) => typeof x === "string" || typeof x === "number").join(", "); }
	return typeof v === "string" || typeof v === "number" ? String(v) : "";
}
const first = (v) => (Array.isArray(v) ? str(v[0]) : str(v));
const list = (v) => (Array.isArray(v) ? v.map(str) : (v === undefined || v === null ? [] : [str(v)]));

// Descriptions are HTML: as plain text.
function plain(html) {
	const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
	return str(html)
		.replace(/<\s*(br|\/p|\/div|\/li)\b[^>]*>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
			if (e[0] === "#") {
				const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
				return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
			}
			return Object.prototype.hasOwnProperty.call(named, e.toLowerCase()) ? named[e.toLowerCase()] : m;
		})
		.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// A length as archive.org writes it ("1:31:44", "20:33", "108 min", "1 hr 20 min", or a bare
// number: seconds in a file's length, minutes in an item's runtime) -> ms; 0 for what is none.
function lengthMs(v, bare = 1000) {
	const s = str(v).trim().toLowerCase();
	let m = /^(\d+(?:\.\d+)?)$/.exec(s);
	if (m) { return Math.round(Number(m[1]) * bare); }
	m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
	if (m) { return Math.round(((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000); }
	const h = /(\d+)\s*(?:h|hr|hrs|hour|hours)\b/.exec(s), mi = /(\d+)\s*(?:m|min|mins|minute|minutes)\b/.exec(s);
	if (h || mi) { return ((h ? Number(h[1]) * 60 : 0) + (mi ? Number(mi[1]) : 0)) * 60000; }
	return 0;
}

function yearOf(doc) {
	const y = /^(\d{4})/.exec(first(doc.year) || first(doc.date));
	return y && Number(y[1]) > 1800 ? Number(y[1]) : undefined;
}

// What the user typed, as words advancedsearch takes: letters, digits and apostrophes inside
// words only (other characters are query syntax, and some make it answer {"error": ...}), and
// without and/or/not (a dangling one is an error too). At most 12 words.
function words(q) {
	const W = "[\\p{L}\\p{M}\\p{N}]";
	return String(q || "")
		.replace(/[^\p{L}\p{M}\p{N}' ]+/gu, " ")
		.replace(new RegExp("(?<!" + W + ")'|'(?!" + W + ")", "gu"), " ")
		.split(/\s+/).filter((w) => w && !/^(and|or|not)$/i.test(w)).slice(0, 12);
}

const encPath = (name) => String(name).split("/").map(encodeURIComponent).join("/");
const downloadUrl = (id, name) => ORIGIN + "/download/" + encodeURIComponent(id) + "/" + encPath(name);
const detailsUrl = (id) => ORIGIN + "/details/" + encodeURIComponent(id);
const imageUrl = (id) => ORIGIN + "/services/img/" + encodeURIComponent(id);

function headers() { return { Accept: "application/json", "User-Agent": UA }; }

// One advancedsearch page. cursor: "<page>:<rows>" (rows kept from the first page, so a later
// limit does not shift the pages). -> { items, nextCursor }
async function searchPage(http, query, cursor, limit) {
	let page = 1, rows = Math.max(1, Math.min(MAX_ROWS, limit || 50));
	const m = /^(\d{1,6}):(\d{1,3})$/.exec(cursor || "");
	if (m && Number(m[1]) >= 1 && Number(m[2]) >= 1 && Number(m[2]) <= MAX_ROWS) { page = Number(m[1]); rows = Number(m[2]); }
	const qs = new URLSearchParams({ q: query });
	for (const f of FIELDS) { qs.append("fl[]", f); }
	qs.append("sort[]", "downloads desc");
	qs.set("rows", String(rows));
	qs.set("page", String(page));
	qs.set("output", "json");
	const r = await http.json({ url: ORIGIN + "/advancedsearch.php?" + qs.toString(), timeoutMs: SEARCH_MS, headers: headers() });
	if (!r || typeof r !== "object" || r.error || !r.response || !Array.isArray(r.response.docs)) {
		throw new CloudError(C.ERRORS.SERVER_ERROR, "The Internet Archive could not answer that list.");
	}
	const docs = r.response.docs;
	const total = typeof r.response.numFound === "number" ? r.response.numFound : 0;
	return { items: docs.map(toItem).filter(Boolean),
		nextCursor: docs.length > 0 && page * rows < total ? (page + 1) + ":" + rows : null };
}

// A search hit (or an item's metadata) as an item. One with a runtime is taken to be one video;
// one without, a folder of its videos.
function toItem(doc) {
	if (!doc || typeof doc !== "object") { return null; }
	const id = str(doc.identifier);
	if (!ID_RE.test(id)) { return null; }
	const ms = lengthMs(first(doc.runtime), 60000);
	const one = ms > 0;
	return {
		id, kind: one ? "movie" : "collection", title: first(doc.title) || id,
		subtitle: first(doc.creator) || undefined,
		description: plain(first(doc.description)) || undefined,
		artwork: { poster: imageUrl(id), thumb: imageUrl(id) },
		durationMs: ms || undefined,
		year: yearOf(doc),
		playable: one, hasChildren: !one,
		webUrl: detailsUrl(id),
	};
}

// --- an item's files -> its titles ---------------------------------------------------------------

const isTrue = (v) => v === true || str(v).toLowerCase() === "true";
const heightOf = (f) => { const n = parseInt(str(f.height), 10); return isFinite(n) && n > 0 ? n : 0; };
const isMp4 = (f) => MP4_RE.test(str(f.name)) && FORMATS.includes(str(f.format)) && !isTrue(f.private);
const stem = (name) => String(name).replace(/\.[^./]+$/, "");
const natural = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

// Why archive.org does not let this item be played, or "" when it does.
function refusal(meta) {
	if (!meta || typeof meta !== "object" || meta.is_dark === true || !meta.metadata) { return "gone"; }
	const md = meta.metadata;
	if (isTrue(md["access-restricted-item"])) { return "lent"; }
	if (list(md.collection).some((c) => LENDING.includes(c))) { return "lent"; }
	return "";
}

// A title from a file name: "s01e02_TheLoneRangerFightsOn.mp4" is "The Lone Ranger Fights On"
// (its season and episode are given apart), "Night.Of.The.Living.Dead.mp4" "Night Of The Living Dead".
function nameOf(file) {
	const raw = stem(String(file).split("/").pop());
	let s = raw.replace(/[_]+/g, " ");
	if (!/\s/.test(s)) { s = s.replace(/\./g, " "); }
	s = s.replace(/^\s*s\d{1,2}[ ._-]?e\d{1,3}(?![0-9])[\s._-]*/i, "");
	if (!/\s/.test(s)) { s = s.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"); }
	s = s.replace(/\s+/g, " ").trim();
	return s || raw;
}

// The titles of an item: each video original (or MP4 with no original) with the MP4s made from
// it, renditions of the same length (within a second) as one. Sorted by name.
// -> [{ key, name, title, files: [mp4], ms, thumb, season?, episode? }]
function titlesOf(meta) {
	const files = (Array.isArray(meta && meta.files) ? meta.files : []).filter((f) => f && typeof f.name === "string" && f.name);
	const byName = new Map(files.map((f) => [f.name, f]));
	// The original a derivative comes from, through derivatives of derivatives.
	const rootOf = (f) => {
		let cur = f;
		for (let i = 0; i < 5 && cur.source === "derivative" && byName.has(str(cur.original)); i++) { cur = byName.get(str(cur.original)); }
		return cur;
	};
	const groups = new Map();
	for (const f of files) {
		if (!isMp4(f)) { continue; }
		const root = rootOf(f);
		// A disc image's derivatives are its several videos, not renditions of one.
		const key = /\.(iso|img)$/i.test(root.name) ? f.name : root.name;
		if (!groups.has(key)) { groups.set(key, { key, root: key === root.name ? root : f, files: [] }); }
		groups.get(key).files.push(f);
	}
	const titles = [];
	for (const g of Array.from(groups.values()).sort((a, b) => natural(a.key, b.key))) {
		const ms = Math.max(...g.files.map((f) => lengthMs(f.length)), lengthMs(g.root.length));
		const same = ms > 0 ? titles.find((t) => t.ms > 0 && Math.abs(t.ms - ms) < 1000) : null;
		if (same) { same.files.push(...g.files); continue; }
		const label = str(g.root.title) || g.files.map((f) => str(f.title)).find(Boolean) || nameOf(g.key);
		const se = /s(\d{1,2})[ ._-]?e(\d{1,3})/i.exec(g.key);
		const thumbs = files.filter((f) => f.format === "Thumbnail" && (str(f.original) === g.root.name || str(f.original) === g.key))
			.map((f) => f.name).sort(natural);
		titles.push({ key: g.key, title: label || g.key, files: g.files.slice(), ms,
			thumb: thumbs[1] || thumbs[0] || null,
			season: se ? Number(se[1]) : undefined, episode: se ? Number(se[2]) : undefined });
	}
	return titles;
}

// The MP4 of a title to play: the tallest no taller than wanted, then the most compatible format;
// with none known to fit, the smallest (one of unknown height counts as smallest).
function pickFile(files, maxHeight) {
	const rank = (f) => FORMATS.indexOf(str(f.format));
	const by = (a, b) => (heightOf(b) - heightOf(a)) || (rank(a) - rank(b));
	const fit = files.filter((f) => heightOf(f) > 0 && heightOf(f) <= maxHeight).sort(by);
	if (fit.length) { return fit[0]; }
	return files.slice().sort((a, b) => (heightOf(a) - heightOf(b)) || (rank(a) - rank(b)))[0] || null;
}

// The subtitle files of a title: those named after one of its videos ("film.srt", "film.en.vtt",
// the speech-recognised "film.asr.srt"); with one title in the item, every subtitle file. Those
// of the file played come first, so they are the ones kept of the renditions' copies.
function subtitlesOf(id, meta, title, only, played) {
	const stems = [title.key].concat(title.files.map((f) => f.name)).map((n) => stem(n) + ".");
	const mine = played ? stem(played.name) + "." : null;
	const rank = (f) => (mine && str(f.name).startsWith(mine) ? 0 : 1);
	const out = [], seen = new Set();
	for (const f of (meta.files || []).slice().sort((a, b) => (rank(a) - rank(b)) || natural(str(a.name), str(b.name)))) {
		if (!f || typeof f.name !== "string" || !SUB_RE.test(f.name) || isTrue(f.private)) { continue; }
		const s = stems.find((x) => f.name.startsWith(x));
		if (!s && !only) { continue; }
		// What is between the video's name and ".srt": "", "asr", "en", "eng", "pt-br".
		const tag = s ? f.name.slice(s.length, -4).toLowerCase() : null;
		const lang = tag && /^[a-z]{2,3}(-[a-z]{2})?$/.test(tag) && tag !== "asr" ? tag : undefined;
		// The renditions of one video each have their own copy of the same captions: one is enough.
		if (tag !== null) { if (seen.has(tag)) { continue; } seen.add(tag); }
		out.push({ url: downloadUrl(id, f.name), format: f.name.toLowerCase().endsWith(".srt") ? "srt" : "vtt", default: false,
			lang, label: tag === "asr" ? "Automatic captions" : (lang ? lang.toUpperCase() : stem(f.name.split("/").pop())) });
	}
	return out;
}

// A child id is "<identifier>/<title key>"; identifiers have no "/".
function splitId(itemId) {
	const s = String(itemId || "");
	const i = s.indexOf("/");
	const id = i < 0 ? s : s.slice(0, i);
	if (!ID_RE.test(id)) { throw new CloudError(C.ERRORS.NOT_FOUND, "Not found at the Internet Archive."); }
	return { id, key: i < 0 ? "" : s.slice(i + 1) };
}

function childItem(id, meta, t) {
	const md = meta.metadata || {};
	return {
		id: id + "/" + t.key, kind: t.episode !== undefined ? "episode" : "video", title: t.title,
		seriesTitle: t.episode !== undefined ? first(md.title) || undefined : undefined,
		season: t.season, episode: t.episode,
		artwork: { thumb: t.thumb ? downloadUrl(id, t.thumb) : imageUrl(id), poster: imageUrl(id) },
		durationMs: t.ms || undefined, year: yearOf(md),
		playable: true, hasChildren: false,
		webUrl: detailsUrl(id),
	};
}

function createProvider() {
	const cache = new Map();

	async function metadata(http, id) {
		const now = Date.now();
		const hit = cache.get(id);
		if (hit && now - hit.at < CACHE_MS) { return hit.meta; }
		const r = await http.json({ url: ORIGIN + "/metadata/" + encodeURIComponent(id), timeoutMs: METADATA_MS, headers: headers() });
		// Only what is used is kept: MP4s, subtitles, thumbnails and the originals files come from.
		const originals = new Set((r && Array.isArray(r.files) ? r.files : []).map((f) => f && str(f.original)).filter(Boolean));
		const meta = r && typeof r === "object" ? { is_dark: r.is_dark === true, metadata: r.metadata && typeof r.metadata === "object" ? r.metadata : null,
			files: Array.isArray(r.files) ? r.files.filter((f) => f && typeof f.name === "string" && (MP4_RE.test(f.name) || SUB_RE.test(f.name) ||
				f.format === "Thumbnail" || originals.has(f.name)))
				.map((f) => ({ name: f.name, format: str(f.format), source: str(f.source), original: str(f.original), height: str(f.height),
					length: str(f.length), title: str(f.title), private: str(f.private) })) : [] } : null;
		cache.delete(id);
		cache.set(id, { at: now, meta });
		while (cache.size > CACHE_MAX) { cache.delete(cache.keys().next().value); }
		return meta;
	}

	// The item's metadata, refused when archive.org does not let it be played.
	async function playableMeta(ctx, id) {
		const meta = await metadata(ctx.http, id);
		const why = refusal(meta);
		if (why === "gone") { throw new CloudError(C.ERRORS.NOT_FOUND, "The Internet Archive does not have this item any more."); }
		if (why === "lent") { throw new CloudError(C.ERRORS.SERVER_ERROR, "The Internet Archive only lends this item; it cannot be played here."); }
		return meta;
	}

	const p = {
		id: "archive",
		templateId: "org.webosports.video.archive",
		name: "Internet Archive",
		needsToken: false,

		// Nothing to sign in to: the account only puts the Archive's films in Videos.
		async login() {
			return { username: "archive.org", alias: "Internet Archive", credentials: { common: { kind: "archive" } } };
		},

		features() {
			return { search: true, progress: false, continueWatching: false, live: false };
		},

		async listSections() {
			return SECTIONS.map((s) => ({ id: s.id, title: s.title, layout: s.layout }));
		},

		async listItems(ctx, { sectionId, parentId, cursor, limit }) {
			if (parentId) {
				const { id } = splitId(parentId);
				const meta = await playableMeta(ctx, id);
				return { items: titlesOf(meta).map((t) => childItem(id, meta, t)), nextCursor: null };
			}
			const s = SECTIONS.find((x) => x.id === sectionId);
			if (!s) { throw new CloudError(C.ERRORS.NOT_FOUND, "No such section."); }
			return searchPage(ctx.http, "collection:" + s.id + " AND " + PLAYABLE, cursor, limit);
		},

		async getItem(ctx, { itemId }) {
			const { id, key } = splitId(itemId);
			const meta = await playableMeta(ctx, id);
			const titles = titlesOf(meta);
			if (key) {
				const t = titles.find((x) => x.key === key);
				return t ? childItem(id, meta, t) : null;
			}
			if (!titles.length) { return null; }
			const it = toItem(Object.assign({}, meta.metadata, { identifier: id }));
			if (!it) { return null; }
			if (titles.length > 1) {
				it.children = titles.map((t) => childItem(id, meta, t));
			} else {
				Object.assign(it, { kind: "movie", playable: true, hasChildren: false, durationMs: titles[0].ms || it.durationMs });
			}
			return it;
		},

		async search(ctx, { query, cursor, limit }) {
			const w = words(query);
			if (!w.length) { return { items: [], nextCursor: null }; }
			const t = "(" + w.join(" ") + ")";
			return searchPage(ctx.http, "(title:" + t + " OR creator:" + t + " OR subject:" + t + ") AND " + PLAYABLE, cursor, limit);
		},

		async resolve(ctx, { itemId, prefer }) {
			const { id, key } = splitId(itemId);
			const meta = await playableMeta(ctx, id);
			const titles = titlesOf(meta);
			// The item itself: its one title, or the longest of several (the film beside its trailer).
			const title = key ? titles.find((x) => x.key === key)
				: titles.slice().sort((a, b) => (b.ms - a.ms) || natural(a.key, b.key))[0];
			if (!title) {
				if (key) { throw new CloudError(C.ERRORS.NOT_FOUND, "The Internet Archive does not have this video any more."); }
				throw new CloudError(C.ERRORS.SERVER_ERROR, "The Internet Archive has no MP4 of this item to play.");
			}
			const file = pickFile(title.files, prefer.maxHeight);
			return { url: downloadUrl(id, file.name), protocol: "progressive", mime: "video/mp4",
				subtitles: subtitlesOf(id, meta, title, titles.length === 1, file) };
		},
	};
	p._test = { reset: () => cache.clear(), cache };
	return p;
}

module.exports = createProvider();
Object.assign(module.exports._test, { SECTIONS, PLAYABLE, LENDING, FORMATS, UA, str, plain, lengthMs, words, toItem, titlesOf, nameOf,
	pickFile, subtitlesOf, refusal, splitId, downloadUrl, searchPage, createProvider });
