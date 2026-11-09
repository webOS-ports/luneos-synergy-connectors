// node --test tests/unit
// _cloudcore/node/jobs.js through bus.js: a `job: true` method that takes longer than a call.
// A continuable call gets pending and a jobId, and comes back for the result; a second call for
// the same thing joins the work instead of starting it again; a running job keeps the service
// up; a job nobody asks after is given up, and one past its limit too.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fakePalmbus, ask } = require("./lib/fakes.js");

const NODE = path.join(__dirname, "../../cloud/_core/service/_cloudcore/node");
const { createBus } = require(path.join(NODE, "bus.js"));
const { keyOf } = require(path.join(NODE, "jobs.js"));

const quiet = { log() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A handler that finishes when `finish()` is called; how many times it was started
function slowWork() {
	const w = { started: 0, finish: null, signal: null, progress: null };
	w.handler = (params, ctx) => {
		w.started++;
		w.signal = ctx.signal;
		w.progress = ctx.progress;
		return new Promise((resolve, reject) => {
			w.finish = (v) => resolve(v);
			w.fail = (e) => reject(e);
		});
	};
	return w;
}

function setup(methods, jobOptions = {}, opts = {}) {
	const pb = fakePalmbus();
	const exits = [];
	const bus = createBus({ palmbus: pb, name: "com.palm.service.test", idleMs: opts.idleMs || 0,
		exit: (c) => exits.push(c), log: quiet,
		jobOptions: Object.assign({ waitMs: 30, keepMs: 400, abandonMs: 300, jobTimeoutMs: 5000 }, jobOptions) });
	bus.serve(methods);
	test.after(() => bus.stop());
	return { bus, handle: pb.handles[0], exits };
}

test("continuable: pending with a jobId and the progress while it works, then the result", async () => {
	const w = slowWork();
	const { handle, bus } = setup({ listAlbums: { job: true, handler: w.handler } });
	const first = await ask(handle, "listAlbums", { accountId: "a", continuable: true });
	assert.strictEqual(first.returnValue, true);
	assert.strictEqual(first.pending, true);
	assert.match(first.jobId, /^j/);
	assert.strictEqual(first.progress, undefined);

	w.progress({ folders: 12 });
	const second = await ask(handle, "listAlbums", { accountId: "a", continuable: true, jobId: first.jobId });
	assert.deepStrictEqual(second, { returnValue: true, pending: true, jobId: first.jobId, progress: { folders: 12 } });

	w.finish({ albums: [{ aid: "x" }] });
	const done = await ask(handle, "listAlbums", { accountId: "a", continuable: true, jobId: first.jobId });
	assert.deepStrictEqual(done, { returnValue: true, albums: [{ aid: "x" }] });
	assert.strictEqual(w.started, 1);
	assert.strictEqual(bus.jobs.size, 1, "kept under its id for a while");
});

test("continuable: a job done within the wait answers at once, no pending", async () => {
	const { handle } = setup({ listPhotos: { job: true, handler: async (p) => ({ photos: [p.aid] }) } });
	assert.deepStrictEqual(await ask(handle, "listPhotos", { aid: "1", continuable: true }), { returnValue: true, photos: ["1"] });
});

test("without continuable a call waits for the result, as before", async () => {
	const w = slowWork();
	const { handle } = setup({ listAlbums: { job: true, handler: w.handler } });
	const r = handle.request("listAlbums", { accountId: "a" });
	await sleep(80);
	assert.strictEqual(r.replies.length, 0, "no pending for a caller that did not ask for it");
	w.finish({ albums: [] });
	assert.deepStrictEqual(await r.first, { returnValue: true, albums: [] });
});

test("a second call for the same thing joins the running job; another account starts its own", async () => {
	const w = slowWork();
	const { handle } = setup({ listAlbums: { job: true, handler: w.handler, timeoutMs: 60 } });
	// The old Photos service: its wait runs out (the method's deadline), it asks again
	const gaveUp = await ask(handle, "listAlbums", { accountId: "a" });
	assert.strictEqual(gaveUp.errorCode, "TIMEOUT");
	const again = handle.request("listAlbums", { accountId: "a" });
	await sleep(10);
	assert.strictEqual(w.started, 1, "the walk is not started again");
	w.finish({ albums: ["done"] });
	assert.deepStrictEqual(await again.first, { returnValue: true, albums: ["done"] });

	const other = await ask(handle, "listAlbums", { accountId: "b", continuable: true });
	assert.strictEqual(other.pending, true);
	assert.strictEqual(w.started, 2);
});

test("once a job has finished, the same call lists afresh (what it lists may have changed)", async () => {
	let n = 0;
	const { handle } = setup({ m: { job: true, handler: async () => ({ n: ++n }) } });
	assert.deepStrictEqual(await ask(handle, "m", { continuable: true }), { returnValue: true, n: 1 });
	assert.deepStrictEqual(await ask(handle, "m", { continuable: true }), { returnValue: true, n: 2 });
});

test("the same parameters from another caller are another job", async () => {
	const w = slowWork();
	const { handle } = setup({ m: { job: true, handler: w.handler } });
	await ask(handle, "m", { continuable: true }, { appId: "org.one" });
	await ask(handle, "m", { continuable: true }, { appId: "org.two" });
	assert.strictEqual(w.started, 2);
	assert.notStrictEqual(keyOf("m", "a", { x: 1, jobId: "j" }), keyOf("m", "b", { x: 1 }));
	assert.strictEqual(keyOf("m", "a", { y: 2, x: 1, continuable: true }), keyOf("m", "a", { x: 1, y: 2 }));
});

test("a jobId that is not known, or of something else, is an error", async () => {
	const w = slowWork();
	const { handle } = setup({ m: { job: true, handler: w.handler } });
	assert.strictEqual((await ask(handle, "m", { continuable: true, jobId: "j99" })).errorCode, "JOB_UNKNOWN");
	const first = await ask(handle, "m", { aid: "1", continuable: true });
	assert.strictEqual((await ask(handle, "m", { aid: "2", continuable: true, jobId: first.jobId })).errorCode, "BAD_ARGS");
});

test("the job's failure is the reply, as the handler's was", async () => {
	const w = slowWork();
	const { handle } = setup({ m: { job: true, handler: w.handler } });
	const first = await ask(handle, "m", { continuable: true });
	const e = new Error("folder unreadable");
	e.errorCode = "PIGALLERY2_API_ERROR";
	w.fail(e);
	const r = await ask(handle, "m", { continuable: true, jobId: first.jobId });
	assert.strictEqual(r.returnValue, false);
	assert.match(r.errorText, /folder unreadable/);
});

test("a running job keeps the service up; it leaves once the job is over", async () => {
	const w = slowWork();
	const { handle, exits } = setup({ m: { job: true, handler: w.handler } }, { abandonMs: 2000 }, { idleMs: 40 });
	const first = await ask(handle, "m", { continuable: true });
	assert.strictEqual(first.pending, true);
	await sleep(150);
	assert.deepStrictEqual(exits, [], "not idle while the job runs");
	w.finish({});
	await sleep(150);
	assert.deepStrictEqual(exits, [0]);
});

test("a job nobody asks after is given up: its signal aborts and it no longer keeps the service up", async () => {
	const w = slowWork();
	const { handle, exits, bus } = setup({ m: { job: true, handler: w.handler } }, { abandonMs: 80 }, { idleMs: 40 });
	const first = await ask(handle, "m", { continuable: true });
	await sleep(60);
	assert.strictEqual(w.signal.aborted, false);
	await sleep(120);
	assert.strictEqual(w.signal.aborted, true);
	await sleep(100);
	assert.deepStrictEqual(exits, [0]);
	bus.stop();
});

test("asking keeps a job from being given up", async () => {
	const w = slowWork();
	const { handle } = setup({ m: { job: true, handler: w.handler } }, { abandonMs: 120 });
	const first = await ask(handle, "m", { continuable: true });
	for (let i = 0; i < 6; i++) {
		await sleep(60);
		assert.strictEqual((await ask(handle, "m", { continuable: true, jobId: first.jobId })).pending, true);
	}
	assert.strictEqual(w.signal.aborted, false);
	w.finish({ ok: 1 });
	assert.deepStrictEqual(await ask(handle, "m", { continuable: true, jobId: first.jobId }), { returnValue: true, ok: 1 });
});

test("a job past its limit is a TIMEOUT for whoever asks, and the next call starts afresh", async () => {
	const w = slowWork();
	const { handle } = setup({ m: { job: true, handler: w.handler } }, { jobTimeoutMs: 100, abandonMs: 5000 });
	const first = await ask(handle, "m", { continuable: true });
	await sleep(150);
	assert.strictEqual(w.signal.aborted, true);
	const r = await ask(handle, "m", { continuable: true, jobId: first.jobId });
	assert.strictEqual(r.errorCode, "TIMEOUT");
	w.finish({ late: true });     // its late answer is no one's
	const again = await ask(handle, "m", { continuable: true });
	assert.strictEqual(again.pending, true);
	assert.strictEqual(w.started, 2);
});

test("a method without job: true is not changed by continuable", async () => {
	const { handle } = setup({ plain: { handler: async (p) => ({ got: p }) } });
	assert.deepStrictEqual(await ask(handle, "plain", { continuable: true }), { returnValue: true, got: { continuable: true } });
});
