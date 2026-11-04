/* videos.js - the bus methods of org.webosports.service.videos, over the providers.
 *
 *   const methods = createVideos({ config, providers, call, http, ssdp, log });
 *   bus.serve(methods);
 *
 * Every video service is a provider module (video/<name>/provider, installed as providers/<name>.js):
 *
 *   { id, templateId, name,
 *     needsToken,                          // the account's credentials carry an accessToken
 *     login(args, deps)                    -> { username, alias, credentials: { common } }
 *     sources?(ctx)                        -> [{ id, name }]   (default: one source, the account)
 *     features(ctx)                        -> { search, progress, continueWatching, live }
 *     listSections(ctx)                    -> [section]
 *     listItems(ctx, { sectionId, parentId, cursor, limit }) -> { items, nextCursor }
 *     getItem(ctx, { itemId })             -> item, with children (items) for a show or season
 *     search?(ctx, { query, cursor, limit }) -> { items, nextCursor }
 *     continueWatching?(ctx, { limit })    -> { items }  (default: listItems of section "continue")
 *     resolve(ctx, { itemId, prefer })     -> stream
 *     reportProgress?(ctx, { itemId, positionMs, durationMs, state, session })
 *     extraMethods?: { name: { handler(params, deps), allow? } } }
 *
 *   ctx = { accountId, sub, account, creds, http, ssdp, log, save(common) }
 *   deps = { http, ssdp, log, random }
 *
 * A source is what Videos lists in its libraries panel: an account, or for UPnP one server the
 * account found on the network. Its id is the account id, or "<account id>|<sub>" (sub chosen by
 * the provider). Every catalogue method takes it as `sourceId`.
 *
 * continueWatching and searchAll ask many sources at once (those given as `sourceIds`, else every
 * source), each with its own time limit; a source that fails or is slow is answered in `failed`
 * and the others still come.
 *
 * What a provider returns is cut to the contract (contract.js) before it is answered. What it
 * throws is answered as the service's error codes: a 401 is AUTH_EXPIRED, a 404 NOT_FOUND, no
 * reply SERVER_UNREACHABLE, any other HTTP error SERVER_ERROR. No link (they carry tokens) and no
 * credential is ever logged.
 */
"use strict";

const crypto = require("node:crypto");
const C = require("./contract.js");
const { CloudError } = require("./core.js");

const ACCOUNTS = "luna://com.palm.service.accounts/";
const SEP = "|";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const ACCOUNTS_TTL_MS = 5000;
// continueWatching and searchAll: how long one source may take, and how many are asked.
const FAN_OUT_MS = 8000;
const MAX_FAN_OUT = 50;

function sourceIdOf(accountId, sub) {
	return sub ? accountId + SEP + sub : accountId;
}

function splitSourceId(sourceId) {
	if (typeof sourceId !== "string" || !sourceId) {
		throw new CloudError("MISSING_ARGS", "need sourceId");
	}
	const i = sourceId.indexOf(SEP);
	return i < 0 ? { accountId: sourceId, sub: "" } : { accountId: sourceId.slice(0, i), sub: sourceId.slice(i + 1) };
}

// What a provider threw, as the service's error. CloudErrors that already say what they are pass.
function asServiceError(e) {
	if (e && e.errorCode && Object.values(C.ERRORS).includes(e.errorCode)) { return e; }
	if (e && e.errorCode && ["MISSING_ARGS", "BAD_ARGS", "NOT_SUPPORTED", "PERMISSION_DENIED"].includes(e.errorCode)) { return e; }
	if (e && typeof e.status === "number") {
		if (e.status === 401 || e.status === 403) {
			return new CloudError(C.ERRORS.AUTH_EXPIRED, "The server no longer accepts this account's sign-in.", { status: e.status });
		}
		if (e.status === 404) { return new CloudError(C.ERRORS.NOT_FOUND, "Not found on the server.", { status: 404 }); }
		return new CloudError(C.ERRORS.SERVER_ERROR, "The server answered with an error (" + e.status + ").", { status: e.status });
	}
	if (e && e.errorCode === "CURL_FAILED") {
		return new CloudError(C.ERRORS.SERVER_UNREACHABLE, "The server does not answer. Check the network and the server.");
	}
	return e;
}

function limitOf(v) {
	const n = typeof v === "number" && isFinite(v) ? Math.floor(v) : DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, n));
}

function createVideos({ config, providers, call, http, ssdp = null, log = console, random = crypto.randomBytes, fanOutMs = FAN_OUT_MS }) {
	const byTemplate = new Map(providers.map((p) => [p.templateId, p]));
	const appIds = config.APP_IDS;
	const deps = { http, ssdp, log, random };

	// listAccounts answers each account with its template folded in (icon, loc_name). Kept a few
	// seconds: a screen asks for several things of the same source at once.
	let accountsCache = null;
	async function accounts() {
		const now = Date.now();
		if (accountsCache && now - accountsCache.at < ACCOUNTS_TTL_MS) { return accountsCache.list; }
		const r = await call(ACCOUNTS + "listAccounts", { capability: config.CAPABILITY });
		const list = (r && Array.isArray(r.results) ? r.results : []).filter((a) => a && a._id && !a.beingDeleted);
		accountsCache = { at: now, list };
		return list;
	}

	async function credentialsOf(accountId) {
		let r;
		try {
			r = await call(ACCOUNTS + "readCredentials", { accountId, name: "common" });
		} catch (e) {
			return {};
		}
		let c = (r && r.credentials) || r || {};
		if (c && c.common) { c = c.common; }
		const out = Object.assign({}, c);
		delete out.returnValue;
		return out;
	}

	async function saveCredentials(accountId, common) {
		try {
			await call(ACCOUNTS + "writeCredentials", { accountId, name: "common", credentials: common });
			return true;
		} catch (e) {
			log.error(config.SERVICE_NAME + ": writeCredentials for " + accountId + " failed: " + ((e && e.errorCode) || e));
			return false;
		}
	}

	function iconOf(account) {
		const i = account && account.icon;
		return (i && (i.loc_48x48 || i.loc_32x32)) || "";
	}

	function nameOf(account, provider) {
		return C.text(account.alias) || C.text(account.username) || C.text(account.loc_name) || provider.name;
	}

	// A source's name without its kind, for where the account's icon already
	// shows the kind (Videos' tabs): "Plex – Home" is "Home", "PeerTube
	// (tube.example)" is "tube.example", "Tube (tube.example)" is "Tube".
	function labelOf(name, provider) {
		const kind = provider.name;
		if (name.startsWith(kind + " – ")) { return name.slice(kind.length + 3); }
		const m = /^(.+) \(([^()]+)\)$/.exec(name);
		if (m) { return m[1] === kind ? m[2] : m[1]; }
		return name;
	}

	// The provider, account and credentials behind a source id.
	async function context(sourceId) {
		const { accountId, sub } = splitSourceId(sourceId);
		const account = (await accounts()).find((a) => a._id === accountId);
		if (!account) { throw new CloudError(C.ERRORS.NO_SOURCE, "There is no such video account."); }
		const provider = byTemplate.get(account.templateId);
		if (!provider) { throw new CloudError(C.ERRORS.NO_SOURCE, "This kind of video account is not supported."); }
		const creds = await credentialsOf(accountId);
		if (provider.needsToken && !creds.accessToken) {
			throw new CloudError(C.ERRORS.AUTH_EXPIRED, "The account has no sign-in stored. Add it again.");
		}
		const ctx = { accountId, sub, account, creds, http, ssdp, log,
			save: async (common) => { ctx.creds = common; return saveCredentials(accountId, common); } };
		return { provider, ctx };
	}

	// A catalogue method: find the source, run the provider, map its errors.
	function catalogue(name, timeoutMs, run) {
		return {
			allow: appIds,
			timeoutMs,
			handler: async (params) => {
				const { provider, ctx } = await context(params.sourceId);
				try {
					return await run(provider, ctx, params);
				} catch (e) {
					throw asServiceError(e);
				}
			},
		};
	}

	// Every source, as listSources answers them.
	async function allSources() {
		const sources = [];
		for (const account of await accounts()) {
			const provider = byTemplate.get(account.templateId);
			if (!provider) { continue; }
			const base = { accountId: account._id, templateId: account.templateId, provider: provider.id,
				icon: iconOf(account) };
			let subs = [{ id: "", name: nameOf(account, provider) }];
			const ctx = { accountId: account._id, sub: "", account, creds: {}, http, ssdp, log, save: async () => false };
			if (typeof provider.sources === "function") {
				// A provider whose sources come from its sign-in (Plex: the servers the
				// account reaches) needs the credentials, and may store a fresher list.
				ctx.creds = await credentialsOf(account._id);
				ctx.save = async (common) => { ctx.creds = common; return saveCredentials(account._id, common); };
				try { subs = await provider.sources(ctx); }
				catch (e) { log.error(config.SERVICE_NAME + ": sources of " + provider.id + " failed: " + ((e && e.errorCode) || e)); subs = []; }
			}
			for (const s of subs || []) {
				const name = C.text(s && s.name, 200);
				if (!name) { continue; }
				sources.push(Object.assign({ sourceId: sourceIdOf(account._id, s.id || ""), name, label: labelOf(name, provider) },
					base, { features: C.features(provider.features(Object.assign({}, ctx, { sub: s.id || "" }))) }));
			}
		}
		return sources;
	}

	// run(provider, ctx) on each source given (else every source) whose features want(features,
	// provider) says yes, all at once, each within fanOutMs. -> { results: [{ sourceId, value }]
	// in the order given, failed: [{ sourceId, errorCode, errorText }] }.
	async function fanOut(sourceIds, want, run) {
		let ids;
		if (Array.isArray(sourceIds)) {
			ids = Array.from(new Set(sourceIds.filter((id) => typeof id === "string" && id && id.length <= 1024)));
		} else {
			ids = (await allSources()).map((s) => s.sourceId);
		}
		ids = ids.slice(0, MAX_FAN_OUT);
		const settled = await Promise.all(ids.map(async (sourceId) => {
			let timer = null;
			try {
				const job = (async () => {
					const { provider, ctx } = await context(sourceId);
					if (!want(C.features(provider.features(ctx)), provider)) { return { skip: true }; }
					return { value: await run(provider, ctx) };
				})();
				const late = new Promise((resolve, reject) => {
					timer = setTimeout(() => reject(new CloudError(C.ERRORS.SERVER_UNREACHABLE, "The server took too long.")), fanOutMs);
				});
				return Object.assign({ sourceId }, await Promise.race([job, late]));
			} catch (e) {
				// A provider's own bug (no errorCode) is logged by its name only and answered as a server error.
				const err = asServiceError(e);
				const known = !!(err && err.errorCode);
				log.error(config.SERVICE_NAME + ": " + sourceId.split(SEP)[0] + " failed: " + (known ? err.errorCode : (e && e.name) || "error"));
				return { sourceId, error: { sourceId, errorCode: known ? err.errorCode : C.ERRORS.SERVER_ERROR,
					errorText: (known && C.text(err.message, 300)) || "" } };
			} finally {
				clearTimeout(timer);
			}
		}));
		return {
			results: settled.filter((r) => !r.skip && !r.error).map((r) => ({ sourceId: r.sourceId, value: r.value })),
			failed: settled.filter((r) => r.error).map((r) => r.error),
		};
	}

	const methods = {
		// -> { sources: [{ sourceId, accountId, templateId, provider, name, label, icon, features }] }
		listSources: {
			allow: appIds,
			timeoutMs: 20000,
			handler: async () => {
				accountsCache = null;
				return { sources: await allSources() };
			},
		},

		// { limit?, sourceIds? } -> { items: [item + sourceId], failed: [{ sourceId, errorCode }] }
		// What the user was watching on every source that keeps a place, the last watched first
		// (those a server gives no time for after, in the order of the sources).
		continueWatching: {
			allow: appIds,
			timeoutMs: fanOutMs + 10000,
			handler: async (params) => {
				const limit = Math.min(limitOf(params.limit === undefined ? 20 : params.limit), MAX_FAN_OUT);
				const { results, failed } = await fanOut(params.sourceIds, (f) => f.continueWatching, async (p, ctx) =>
					C.page(typeof p.continueWatching === "function" ? await p.continueWatching(ctx, { limit })
						: await p.listItems(ctx, { sectionId: "continue", parentId: "", cursor: null, limit })).items);
				const all = [];
				results.forEach((r, rank) => r.value.forEach((it, i) => all.push({ it: Object.assign(it, { sourceId: r.sourceId }), rank, i })));
				const t = (x) => (x.it.lastPlayedAt ? Date.parse(x.it.lastPlayedAt) : -1);
				all.sort((a, b) => (t(b) - t(a)) || (a.rank - b.rank) || (a.i - b.i));
				return { items: all.slice(0, limit).map((x) => x.it), failed };
			},
		},

		// { query, limit? (per source), sourceIds? } -> { results: [{ sourceId, items, nextCursor }], failed }
		// The sources that can search, in the order of the sources; those with nothing found are left out.
		searchAll: {
			allow: appIds,
			timeoutMs: fanOutMs + 10000,
			handler: async (params) => {
				const query = C.text(params.query, 200);
				if (!query) { throw new CloudError("MISSING_ARGS", "need query"); }
				const limit = Math.min(limitOf(params.limit === undefined ? 10 : params.limit), MAX_FAN_OUT);
				const { results, failed } = await fanOut(params.sourceIds, (f, p) => f.search && typeof p.search === "function",
					async (p, ctx) => C.page(await p.search(ctx, { query, cursor: null, limit })));
				return {
					results: results.filter((r) => r.value.items.length > 0)
						.map((r) => ({ sourceId: r.sourceId, items: r.value.items, nextCursor: r.value.nextCursor })),
					failed,
				};
			},
		},

		getInfo: catalogue("getInfo", 20000, async (p, ctx) => ({
			name: nameOf(ctx.account, p), provider: p.id, features: C.features(p.features(ctx)),
		})),

		listSections: catalogue("listSections", 30000, async (p, ctx) => ({
			sections: (await p.listSections(ctx) || []).map(C.section).filter(Boolean),
		})),

		listItems: catalogue("listItems", 45000, async (p, ctx, params) => {
			if (!params.sectionId && !params.parentId) { throw new CloudError("MISSING_ARGS", "need sectionId or parentId"); }
			return C.page(await p.listItems(ctx, { sectionId: C.text(params.sectionId, 512), parentId: C.text(params.parentId, 512),
				cursor: C.cursor(params.cursor), limit: limitOf(params.limit) }));
		}),

		getItem: catalogue("getItem", 30000, async (p, ctx, params) => {
			const itemId = C.text(params.itemId, 512);
			if (!itemId) { throw new CloudError("MISSING_ARGS", "need itemId"); }
			const raw = await p.getItem(ctx, { itemId });
			const it = C.item(raw);
			if (!it) { throw new CloudError(C.ERRORS.NOT_FOUND, "Not found on the server."); }
			if (raw && Array.isArray(raw.children)) { it.children = C.items(raw.children); }
			if (raw && Array.isArray(raw.seasons)) { it.seasons = C.items(raw.seasons); }
			return { item: it };
		}),

		search: catalogue("search", 30000, async (p, ctx, params) => {
			if (typeof p.search !== "function" || !p.features(ctx).search) { throw new CloudError("NOT_SUPPORTED", "This source cannot be searched."); }
			const query = C.text(params.query, 200);
			if (!query) { throw new CloudError("MISSING_ARGS", "need query"); }
			return C.page(await p.search(ctx, { query, cursor: C.cursor(params.cursor), limit: limitOf(params.limit) }));
		}),

		resolve: catalogue("resolve", 45000, async (p, ctx, params) => {
			const itemId = C.text(params.itemId, 512);
			if (!itemId) { throw new CloudError("MISSING_ARGS", "need itemId"); }
			const prefer = params.prefer && typeof params.prefer === "object" ? params.prefer : {};
			const s = C.stream(await p.resolve(ctx, { itemId, prefer: {
				maxHeight: C.count(prefer.maxHeight) || 720,
				codecs: Array.isArray(prefer.codecs) ? prefer.codecs.filter((c) => typeof c === "string") : ["h264"],
				audioCodecs: Array.isArray(prefer.audioCodecs) ? prefer.audioCodecs.filter((c) => typeof c === "string") : ["aac", "mp3"],
			} }));
			if (!s) { throw new CloudError(C.ERRORS.SERVER_ERROR, "The server gave no way to play this."); }
			return { stream: s };
		}),

		reportProgress: catalogue("reportProgress", 20000, async (p, ctx, params) => {
			if (typeof p.reportProgress !== "function" || !p.features(ctx).progress) { return {}; }
			const itemId = C.text(params.itemId, 512);
			const state = ["playing", "paused", "stopped", "ended"].includes(params.state) ? params.state : null;
			if (!itemId || !state) { throw new CloudError("MISSING_ARGS", "need itemId and state"); }
			await p.reportProgress(ctx, { itemId, state, positionMs: C.count(params.positionMs) || 0,
				durationMs: C.count(params.durationMs) || 0,
				session: params.session && typeof params.session === "object" ? params.session : null });
			return {};
		}),

		// The account validator: the sign-in app (org.webosports.app.videoauth) passes the
		// templateId and what the user typed. Open, as WebDAV's is: the sign-in app's calls arrive
		// as com.palm.app.accounts-<pid>.
		login: {
			timeoutMs: 60000,
			handler: async (params) => {
				const provider = byTemplate.get(params.templateId);
				if (!provider) { throw new CloudError("BAD_ARGS", "unknown templateId"); }
				try {
					const r = await provider.login(params, deps);
					return { username: r.username, alias: r.alias, credentials: r.credentials, config: {} };
				} catch (e) {
					throw asServiceError(e);
				}
			},
		},
	};

	for (const p of providers) {
		for (const [name, spec] of Object.entries(p.extraMethods || {})) {
			if (methods[name]) { throw new Error("method " + name + " of " + p.id + " is taken"); }
			methods[name] = { allow: spec.allow, timeoutMs: spec.timeoutMs || 30000,
				handler: async (params) => { try { return await spec.handler(params, deps); } catch (e) { throw asServiceError(e); } } };
		}
	}
	return methods;
}

module.exports = { createVideos, sourceIdOf, splitSourceId, asServiceError, limitOf, FAN_OUT_MS };
