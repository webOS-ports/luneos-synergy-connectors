/* UPnP/DLNA media servers on the local network, as a provider of org.webosports.service.videos.
 *
 * One account ("Media servers on this network", no sign-in) stands for all of them: every
 * ContentDirectory server SSDP finds is a source of its own (sub = its UDN). Checked against
 * MiniDLNA 1.3.3 (2026-11-03); written to the ContentDirectory:1 spec so others work too.
 *
 *   find      SSDP M-SEARCH for urn:schemas-upnp-org:service:ContentDirectory:1, then the device
 *             description at LOCATION: friendlyName, UDN, the ContentDirectory controlURL
 *   sections  the root container's children (Video, Folders, ...), less music and pictures
 *   items     Browse BrowseDirectChildren, paged with StartingIndex; containers are collections,
 *             video items videos
 *   search    Search, when GetSearchCapabilities names dc:title and upnp:class
 *   play      Browse BrowseMetadata: the video <res> that fits; subtitles from sec:CaptionInfoEx
 *             (Samsung's, which MiniDLNA and others send) or a text/srt or text/vtt <res>
 *
 * Only servers on private, link-local or loopback addresses are used (ssdp.js), and links into the
 * DIDL are kept only when they point at one too: a reply on the network cannot send the phone to
 * the internet.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const base = fs.existsSync(path.join(__dirname, "../contract.js")) ? path.join(__dirname, "..")
	: path.join(__dirname, "../../_core/service/org.webosports.service.videos");
const { CloudError } = require(path.join(base, "core.js"));
const C = require(path.join(base, "contract.js"));
const X = require(path.join(base, "xml.js"));
const { localLocation } = require(path.join(base, "ssdp.js"));

const CDS = "urn:schemas-upnp-org:service:ContentDirectory:1";
const SEARCH_WAIT_MS = 2500;
const SERVERS_TTL_MS = 60000;
const SKIP_ROOT = /^(music|audio|pictures?|photos?|images?|playlists?)$/i;
// Folders that hold music or pictures (items need to be video items anyway).
const SKIP_CLASS = /^object\.container\.(album\.(musicAlbum|photoAlbum)|person\.musicArtist|genre\.musicGenre)/;
const UA = "LuneOS/1.0 UPnP/1.1 Videos/1.0";

// --- finding servers ----------------------------------------------------------------------------

// Device description -> { udn, name, control, icon } or null when it has no ContentDirectory.
function parseDescription(text, location) {
	const doc = X.parse(text);
	const root = X.find(doc, "root");
	const urlBase = root ? X.childText(root, "URLBase") : "";
	const at = (rel) => {
		if (!rel) { return null; }
		try { return localLocation(new URL(rel, urlBase || location).href); } catch (e) { return null; }
	};
	// The ContentDirectory may sit on an embedded device; the first one found wins.
	for (const dev of X.findAll(doc, "device")) {
		const list = X.find(dev, "serviceList");
		for (const svc of list ? X.children(list, "service") : []) {
			if (!String(X.childText(svc, "serviceType")).startsWith("urn:schemas-upnp-org:service:ContentDirectory:")) { continue; }
			const control = at(X.childText(svc, "controlURL"));
			const udn = String(X.childText(dev, "UDN") || "").replace(/^uuid:/i, "").trim();
			if (!control || !udn || udn.includes("|")) { continue; }
			let icon;
			const icons = X.find(dev, "iconList");
			for (const i of icons ? X.children(icons, "icon") : []) {
				if (/png|jpe?g/i.test(X.childText(i, "mimetype") || "")) { icon = at(X.childText(i, "url")) || icon; }
			}
			return { udn, name: C.text(X.childText(dev, "friendlyName"), 200) || "Media server", control, icon };
		}
	}
	return null;
}

// Per service process: what the last search found, by UDN.
function createDirectory() {
	let servers = new Map();
	let at = 0;
	let pending = null;

	async function discover(ctx) {
		if (!ctx.ssdp) { return servers; }
		const found = await ctx.ssdp.search(CDS, SEARCH_WAIT_MS);
		const next = new Map();
		await Promise.all(found.map(async (f) => {
			try {
				const r = await ctx.http.request({ url: f.location, timeoutMs: 5000, headers: { "User-Agent": UA } });
				const s = parseDescription(r.text, f.location);
				if (s && !next.has(s.udn)) {
					const old = servers.get(s.udn);
					s.searchCaps = old && old.control === s.control ? old.searchCaps : null;
					next.set(s.udn, s);
				}
			} catch (e) {
				ctx.log.error("upnp: no description from a server: " + ((e && e.errorCode) || e));
			}
		}));
		servers = next;
		at = Date.now();
		return servers;
	}

	return {
		// Look again (the libraries panel asked) and answer what is there.
		async refresh(ctx) {
			if (!pending) { pending = discover(ctx).finally(() => { pending = null; }); }
			return pending;
		},
		// The server behind a source; looked for again when it is not known (or known long ago).
		async get(ctx, udn) {
			if (!servers.has(udn) || Date.now() - at > SERVERS_TTL_MS) { await this.refresh(ctx); }
			const s = servers.get(udn);
			if (!s) { throw new CloudError(C.ERRORS.NO_SOURCE, "The media server is not on the network now."); }
			return s;
		},
		peek: (udn) => servers.get(udn),
		_set(list) { servers = new Map(list.map((s) => [s.udn, s])); at = Date.now(); },
	};
}

// --- SOAP ---------------------------------------------------------------------------------------

async function soap(ctx, server, action, args) {
	const body = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
		"s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:" + action + " xmlns:u=\"" + CDS + "\">" +
		Object.entries(args).map(([k, v]) => "<" + k + ">" + X.escape(String(v)) + "</" + k + ">").join("") +
		"</u:" + action + "></s:Body></s:Envelope>";
	const r = await ctx.http.request({ method: "POST", url: server.control, body, timeoutMs: 20000,
		headers: { "Content-Type": "text/xml; charset=\"utf-8\"", SOAPAction: "\"" + CDS + "#" + action + "\"", "User-Agent": UA } });
	const resp = X.find(X.parse(r.text), action + "Response");
	if (!resp) { throw new CloudError(C.ERRORS.SERVER_ERROR, "The media server's reply makes no sense."); }
	return resp;
}

// A Browse or Search reply -> { didl, returned, total }.
function resultOf(resp) {
	const didl = X.parse(X.childText(resp, "Result") || "");
	const n = (k) => { const v = parseInt(X.childText(resp, k) || "", 10); return isFinite(v) && v >= 0 ? v : null; };
	return { didl, returned: n("NumberReturned"), total: n("TotalMatches") };
}

async function browse(ctx, server, objectId, flag, start = 0, count = 0) {
	return resultOf(await soap(ctx, server, "Browse", { ObjectID: objectId, BrowseFlag: flag, Filter: "*",
		StartingIndex: start, RequestedCount: count, SortCriteria: "" }));
}

async function searchCaps(ctx, server) {
	if (server.searchCaps === null || server.searchCaps === undefined) {
		try {
			const r = await soap(ctx, server, "GetSearchCapabilities", {});
			server.searchCaps = String(X.childText(r, "SearchCaps") || "").split(",").map((s) => s.trim()).filter(Boolean);
		} catch (e) {
			server.searchCaps = [];
		}
	}
	return server.searchCaps;
}

const canSearch = (caps) => !!caps && (caps.includes("*") || (caps.includes("dc:title") && caps.includes("upnp:class")));

// A string inside a UPnP search criterion: quoted, with \ and " escaped.
const criterionString = (s) => "\"" + String(s).replace(/[\\"]/g, (c) => "\\" + c) + "\"";

// --- DIDL ---------------------------------------------------------------------------------------

// "1:02:03.500" (H+:MM:SS[.F]) -> ms.
function durationMs(s) {
	const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(String(s || "").trim());
	if (!m) { return undefined; }
	const frac = m[4] ? Math.round(Number("0." + m[4]) * 1000) : 0;
	return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}

const mimeOf = (protocolInfo) => (String(protocolInfo || "").split(":")[2] || "").toLowerCase();
const heightOf = (res) => { const m = /x(\d+)$/.exec(res.attrs.resolution || ""); return m ? Number(m[1]) : 0; };

function videoResources(el) {
	return X.children(el, "res").filter((r) => {
		const pi = String(r.attrs.protocolInfo || "");
		return pi.startsWith("http-get:") && mimeOf(pi).startsWith("video/") && localLocation(X.textOf(r));
	});
}

// The biggest picture that is not taller than wanted, else the smallest there is.
function pickResource(list, maxHeight) {
	if (!list.length) { return null; }
	const fits = list.filter((r) => !heightOf(r) || heightOf(r) <= maxHeight);
	const pool = fits.length ? fits : list.slice().sort((a, b) => heightOf(a) - heightOf(b)).slice(0, 1);
	return pool.slice().sort((a, b) => heightOf(b) - heightOf(a))[0];
}

function toItem(el) {
	const cls = X.childText(el, "class") || "";
	if (SKIP_CLASS.test(cls)) { return null; }
	const id = el.attrs.id;
	const title = X.childText(el, "title");
	if (!id || !title) { return null; }
	const art = localLocation(X.childText(el, "albumArtURI") || "") || undefined;
	if (el.local === "container") {
		const n = parseInt(el.attrs.childCount, 10);
		return { id, kind: "collection", title, playable: false, hasChildren: true,
			subtitle: isFinite(n) ? n + (n === 1 ? " item" : " items") : undefined, artwork: { poster: art, thumb: art } };
	}
	if (el.local !== "item" || !cls.startsWith("object.item.videoItem")) { return null; }
	const res = videoResources(el);
	if (!res.length) { return null; }
	return { id, kind: /movie/i.test(cls) ? "movie" : "video", title, playable: true, hasChildren: false,
		description: X.childText(el, "longDescription") || X.childText(el, "description"),
		durationMs: durationMs(res[0].attrs.duration),
		artwork: { poster: art, thumb: art } };
}

function didlItems(didl) {
	const root = X.find(didl, "DIDL-Lite");
	return root ? X.elements(root).map(toItem).filter(Boolean) : [];
}

function subtitlesOf(el) {
	const out = [];
	const add = (url, format) => {
		const u = localLocation(url || "");
		if (u && !out.some((s) => s.url === u)) { out.push({ url: u, format, label: format === "vtt" ? "WebVTT" : "Subtitles", default: false }); }
	};
	for (const c of X.children(el, "CaptionInfoEx").concat(X.children(el, "CaptionInfo"))) {
		const type = String(c.attrs["sec:type"] || c.attrs.type || "srt").toLowerCase();
		if (type === "srt" || type === "vtt") { add(X.textOf(c), type); }
	}
	for (const r of X.children(el, "res")) {
		const mime = mimeOf(r.attrs.protocolInfo);
		if (mime === "text/srt" || mime === "application/x-subrip" || mime === "smi/caption") { add(X.textOf(r), "srt"); }
		else if (mime === "text/vtt") { add(X.textOf(r), "vtt"); }
	}
	return out;
}

// --- the provider -------------------------------------------------------------------------------

function createProvider() {
	const dir = createDirectory();
	const serverOf = (ctx) => {
		if (!ctx.sub) { throw new CloudError(C.ERRORS.NO_SOURCE, "Pick a media server."); }
		return dir.get(ctx, ctx.sub);
	};

	async function page(ctx, objectId, cursor, limit) {
		const server = await serverOf(ctx);
		const start = Math.max(0, parseInt(cursor || "0", 10) || 0);
		const r = await browse(ctx, server, objectId, "BrowseDirectChildren", start, limit);
		const returned = r.returned !== null ? r.returned : X.elements(X.find(r.didl, "DIDL-Lite") || { children: [] }).length;
		const next = start + returned;
		// A total of 0 means "unknown" in ContentDirectory: go on while the server sends a full page.
		const more = returned > 0 && (r.total ? next < r.total : returned >= limit);
		return { items: didlItems(r.didl), nextCursor: more ? String(next) : null };
	}

	return {
		id: "upnp",
		templateId: "org.webosports.video.upnp",
		name: "Media servers",
		needsToken: false,

		// Nothing to sign in to: the account only switches the network's servers on in Videos.
		async login() {
			return { username: "local-network", alias: "Media servers on this network", credentials: { common: { kind: "upnp" } } };
		},

		async sources(ctx) {
			const servers = await dir.refresh(ctx);
			await Promise.all(Array.from(servers.values()).map((s) => searchCaps(ctx, s)));
			return Array.from(servers.values()).map((s) => ({ id: s.udn, name: s.name }))
				.sort((a, b) => a.name.localeCompare(b.name));
		},

		features(ctx) {
			const s = ctx && ctx.sub ? dir.peek(ctx.sub) : null;
			// Not asked yet (the service started again since): say yes, and let search() ask.
			const search = !s || !Array.isArray(s.searchCaps) || canSearch(s.searchCaps);
			return { search, progress: false, continueWatching: false, live: false };
		},

		async listSections(ctx) {
			const server = await serverOf(ctx);
			const r = await browse(ctx, server, "0", "BrowseDirectChildren", 0, 50);
			const root = X.find(r.didl, "DIDL-Lite");
			const sections = (root ? X.elements(root) : []).filter((el) => el.local === "container")
				.filter((el) => !SKIP_ROOT.test(String(X.childText(el, "title") || "").trim()) && !SKIP_CLASS.test(X.childText(el, "class") || ""))
				.map((el) => ({ id: "c:" + el.attrs.id, title: X.childText(el, "title"), layout: "grid" }));
			// A server with videos at the top, or nothing but one folder: browse the root itself.
			return sections.length ? sections : [{ id: "c:0", title: server.name, layout: "grid" }];
		},

		async listItems(ctx, { sectionId, parentId, cursor, limit }) {
			const objectId = parentId || (sectionId && sectionId.startsWith("c:") ? sectionId.slice(2) : null);
			if (!objectId) { throw new CloudError(C.ERRORS.NOT_FOUND, "No such section."); }
			return page(ctx, objectId, cursor, limit);
		},

		async getItem(ctx, { itemId }) {
			const server = await serverOf(ctx);
			const r = await browse(ctx, server, itemId, "BrowseMetadata");
			const root = X.find(r.didl, "DIDL-Lite");
			const el = root ? X.elements(root)[0] : null;
			const it = el ? toItem(el) : null;
			if (!it) { return null; }
			if (it.hasChildren) { it.children = (await page(ctx, itemId, null, 200)).items; }
			return it;
		},

		async search(ctx, { query, cursor, limit }) {
			const server = await serverOf(ctx);
			if (!canSearch(await searchCaps(ctx, server))) { throw new CloudError("NOT_SUPPORTED", "This media server cannot search."); }
			const start = Math.max(0, parseInt(cursor || "0", 10) || 0);
			const r = resultOf(await soap(ctx, server, "Search", { ContainerID: "0",
				SearchCriteria: "upnp:class derivedfrom \"object.item.videoItem\" and dc:title contains " + criterionString(query),
				Filter: "*", StartingIndex: start, RequestedCount: limit, SortCriteria: "" }));
			const items = didlItems(r.didl);
			const next = start + (r.returned !== null ? r.returned : items.length);
			return { items, nextCursor: (r.returned || items.length) && r.total && next < r.total ? String(next) : null };
		},

		async resolve(ctx, { itemId, prefer }) {
			const server = await serverOf(ctx);
			const r = await browse(ctx, server, itemId, "BrowseMetadata");
			const root = X.find(r.didl, "DIDL-Lite");
			const el = root ? X.elements(root)[0] : null;
			if (!el || el.local !== "item") { throw new CloudError(C.ERRORS.NOT_FOUND, "Not found on the media server."); }
			const res = pickResource(videoResources(el), prefer.maxHeight);
			if (!res) { throw new CloudError(C.ERRORS.SERVER_ERROR, "The media server offers no video link for this."); }
			return { url: localLocation(X.textOf(res)), protocol: "progressive", mime: mimeOf(res.attrs.protocolInfo) || undefined,
				subtitles: subtitlesOf(el) };
		},

		_test: { dir },
	};
}

module.exports = createProvider();
module.exports.createProvider = createProvider;
module.exports._test = Object.assign(module.exports._test, { parseDescription, durationMs, pickResource, toItem, subtitlesOf,
	criterionString, canSearch, videoResources });
