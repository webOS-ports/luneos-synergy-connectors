// node --test tests/unit
// The paged listings of Immich, SmugMug and PhotoPrism: they tell `progress` how many items they
// have after each page, and stop asking once `signal` aborts (the listing's job was given up).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const CLOUD = path.join(__dirname, "../../cloud");
const errors = require(path.join(CLOUD, "_core/service/_cloudcore/node/errors.js"));
const svc = (name, dir) => (f) => require(path.join(CLOUD, name, "service", dir, f));
const immich = svc("immich", "com.palm.service.immich");
const smugmug = svc("smugmug", "com.palm.service.smugmug");
const photoprism = svc("photoprism", "com.palm.service.photoprism");

// http.request answering page(n, opts) for the n-th listing request (0 on), counting them; on
// page `abortAt` the controller aborts, as a job given up while the page was under way.
function pagedHttp(page, { abortAt = -1, controller = null, other = null } = {}) {
	const h = { pages: 0 };
	h.request = async (opts) => {
		const o = other && other(opts);
		if (o) { return o; }
		const n = h.pages++;
		if (n === abortAt && controller) { controller.abort(new Error("job given up")); }
		return { status: 200, text: JSON.stringify(page(n, opts)) };
	};
	return h;
}

test("immich: progress after each page; an aborted signal asks for no page more", async () => {
	const createAdapter = immich("adapter.js");
	const config = immich("config.js").Config;
	const creds = { server: "https://immich.example.test", apiKey: "k" };
	const version = (opts) => (/\/server\/version$/.test(opts.url) ? { status: 200, text: JSON.stringify({ major: 3, minor: 3, patch: 0 }) } : null);
	const page = (n) => ({ assets: { items: Array.from({ length: createAdapter.PAGE }, (_, i) => ({ id: n + "-" + i })), nextCursor: "c" + (n + 1) } });
	const ac = new AbortController();
	const http = pagedHttp(page, { abortAt: 2, controller: ac, other: version });
	const seen = [];
	await assert.rejects(createAdapter({ config, http, errors }).albumAssets(creds, "album-1", { signal: ac.signal, progress: (n) => seen.push(n) }), /job given up/);
	assert.strictEqual(http.pages, 3);
	assert.deepStrictEqual(seen, [1, 2, 3].map((k) => k * createAdapter.PAGE));
	assert.strictEqual(createAdapter.MAX_ITEMS, 100000);
});

test("smugmug: progress after each page; an aborted signal asks for no page more", async () => {
	const createAdapter = smugmug("adapter.js");
	const config = smugmug("config.js").Config;
	const oauth1 = { signedUrl: (m, url, params) => url + "?" + new URLSearchParams(params) };
	const page = () => ({ Response: { AlbumImage: Array.from({ length: createAdapter.PAGE }, (_, i) => ({ ImageKey: "k" + i })),
		Pages: { Total: 1e6, NextPage: "/next" } } });
	const ac = new AbortController();
	const http = pagedHttp(page, { abortAt: 1, controller: ac });
	const seen = [];
	await assert.rejects(createAdapter({ config, http, errors, oauth1 }).albumImages({ oauthToken: "t", oauthTokenSecret: "s" }, "AK",
		{ signal: ac.signal, progress: (n) => seen.push(n) }), /job given up/);
	assert.strictEqual(http.pages, 2);
	assert.deepStrictEqual(seen, [createAdapter.PAGE, 2 * createAdapter.PAGE]);
	assert.strictEqual(createAdapter.MAX_ITEMS, 100000);
});

test("photoprism: progress after each page; an aborted signal asks for no page more; allPhotos is public=true", async () => {
	const createAdapter = photoprism("adapter.js");
	const config = photoprism("config.js").Config;
	const creds = { server: "https://pp.example.test", token: "t" };
	const urls = [];
	const page = (n, opts) => { urls.push(opts.url); return Array.from({ length: createAdapter.PAGE }, (_, i) => ({ UID: "p" + n + "-" + i })); };
	const ac = new AbortController();
	const http = pagedHttp(page, { abortAt: 3, controller: ac });
	const seen = [];
	await assert.rejects(createAdapter({ config, http, errors }).allPhotos(creds, { signal: ac.signal, progress: (n) => seen.push(n) }), /job given up/);
	assert.strictEqual(http.pages, 4);
	assert.deepStrictEqual(seen, [1, 2, 3, 4].map((k) => k * createAdapter.PAGE));
	assert.deepStrictEqual(urls.slice(0, 2), ["https://pp.example.test/api/v1/photos?merged=true&public=true&count=500&offset=0",
		"https://pp.example.test/api/v1/photos?merged=true&public=true&count=500&offset=500"]);
	assert.strictEqual(createAdapter.MAX_ITEMS, 100000);
	assert.strictEqual(config.MAX_ALBUMS, 20000);
});
