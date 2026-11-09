// node --test tests/unit
// _cloudcore/node/pool.js: mapLimit asks a few at a time, answers in the items' order, stops on
// the first failure and on an aborted signal, and says how many are done.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { mapLimit, CONCURRENCY } = require(path.join(__dirname, "../../cloud/_core/service/_cloudcore/node/pool.js"));
const core = require(path.join(__dirname, "../../cloud/_core/service/_cloudcore/node"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fn for mapLimit that takes ms(i) and counts how many run at once
function gauge(ms = () => 5) {
	const g = { open: 0, max: 0, started: [] };
	g.fn = async (x, i) => {
		g.started.push(i);
		g.open++;
		g.max = Math.max(g.max, g.open);
		await sleep(ms(i));
		g.open--;
		return x * 10;
	};
	return g;
}

test("the answers in the items' order, at most `limit` at a time, the items started in order", async () => {
	const g = gauge((i) => 30 - 2 * i);          // later items answer first
	const items = Array.from({ length: 12 }, (_, i) => i);
	assert.deepStrictEqual(await mapLimit(items, 3, g.fn), items.map((x) => x * 10));
	assert.strictEqual(g.max, 3);
	assert.deepStrictEqual(g.started, items);
	assert.strictEqual(core.mapLimit, mapLimit, "in the core's exports");
});

test("no items is no answers; a limit that is not a number is CONCURRENCY; fewer items than the limit all at once", async () => {
	assert.deepStrictEqual(await mapLimit([], 4, () => { throw new Error("not called"); }), []);
	const g = gauge();
	await mapLimit(Array.from({ length: 10 }, (_, i) => i), undefined, g.fn);
	assert.strictEqual(g.max, CONCURRENCY);
	const h = gauge();
	await mapLimit([1, 2], 8, h.fn);
	assert.strictEqual(h.max, 2);
	const one = gauge();
	await mapLimit(Array.from({ length: 10 }, (_, i) => i), 0, one.fn);
	assert.strictEqual(one.max, CONCURRENCY, "0 is not a limit: the default");
});

test("a failure fails the whole once the requests under way are over, and starts no more", async () => {
	let open = 0, started = 0, settledWhileOpen = null;
	const p = mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
		started++; open++;
		try {
			await sleep(i === 1 ? 1 : 20);
			if (i === 1) { throw new Error("folder unreadable"); }
			return i;
		} finally { open--; }
	});
	await assert.rejects(p.then(null, (e) => { settledWhileOpen = open; throw e; }), /folder unreadable/);
	assert.strictEqual(settledWhileOpen, 0, "not before the others are done");
	assert.strictEqual(started, 3, "nothing started after the failure");
});

test("an aborted signal starts nothing more and throws its reason; progress hears how many are done", async () => {
	const ac = new AbortController();
	const done = [];
	let started = 0;
	const p = mapLimit(Array.from({ length: 20 }, (_, i) => i), 2, async (i) => {
		started++;
		await sleep(10);
		if (i === 3) { ac.abort(new Error("job given up")); }
		return i;
	}, { signal: ac.signal, progress: (n) => done.push(n) });
	await assert.rejects(p, /job given up/);
	assert.ok(started <= 5, "started " + started);
	assert.deepStrictEqual(done, done.map((_, i) => i + 1));
	const already = new AbortController();
	already.abort();
	let called = 0;
	await assert.rejects(mapLimit([1], 2, async () => { called++; }, { signal: already.signal }));
	assert.strictEqual(called, 0);
});
