/* jobs.js - a method that may take longer than one bus call: it runs as a job, and the caller
 * comes back for it.
 *
 * A listing of a large account (every folder of a gallery, a link for every photo of a folder)
 * can take minutes, and the Photos service waits a minute for one reply. A method served with
 * `job: true` therefore runs its handler as a job, which goes on whatever happens to the call
 * that started it:
 *
 *   -> { accountId, continuable: true }
 *   <- { returnValue: true, pending: true, jobId: "j3", progress: { folders: 120 } }   still working
 *   -> { accountId, continuable: true, jobId: "j3" }
 *   <- { returnValue: true, albums: [...] }                                         done
 *
 * A call with continuable waits up to waitMs for the job and replies with its result, or with
 * pending and the job's id. One without (a caller from before this) waits for the result as
 * before, up to the method's own deadline. Either way a second call with the same parameters,
 * from the same caller, joins the job while it is running rather than starting the work again:
 * a caller that gave up and asks again finds the work under way. Once a job has finished, the
 * same call starts it again, as what it lists may have changed since (an upload); its result is
 * there under its id for keepMs, for a caller whose wait ran out just before the reply. A job
 * nobody has asked after for abandonMs while it runs is given up: its signal aborts, and it no
 * longer keeps the service up.
 *
 * The handler gets, in its ctx, `progress(obj)` to say how far it has got (it goes out with
 * pending) and `signal`, aborted when the job is given up or runs past jobTimeoutMs.
 */
"use strict";

const { CloudError } = require("./errors.js");

const WAIT_MS = 20000;
const KEEP_MS = 5 * 60 * 1000;
const ABANDON_MS = 90000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

// A job's clocks never keep the process up by themselves: the bus handle does that in the
// service, and a test is over when its requests are.
function later(fn, ms) {
	const t = setTimeout(fn, ms);
	if (t && typeof t.unref === "function") { t.unref(); }
	return t;
}

// The parameters that say what is asked for: all but the job's own
function keyOf(method, caller, params) {
	const rest = {};
	for (const k of Object.keys(params).sort()) {
		if (k !== "continuable" && k !== "jobId") { rest[k] = params[k]; }
	}
	return method + "\u0000" + caller + "\u0000" + JSON.stringify(rest);
}

// hold()/release(): what keeps the service from leaving while a job runs (bus.js's inflight).
function createJobs({ hold = () => {}, release = () => {}, now = Date.now, waitMs = WAIT_MS,
	keepMs = KEEP_MS, abandonMs = ABANDON_MS, jobTimeoutMs = JOB_TIMEOUT_MS, log = console } = {}) {
	const byId = new Map();
	const byKey = new Map();
	let seq = 0;

	function drop(job) {
		if (byId.get(job.id) === job) { byId.delete(job.id); }
		if (byKey.get(job.key) === job) { byKey.delete(job.key); }
		clearTimeout(job.dropTimer);
		clearTimeout(job.abandonTimer);
	}

	function giveUp(job, why) {
		if (job.done) { return; }
		job.done = true;
		job.outcome = { error: new CloudError("TIMEOUT", job.method + " " + why) };
		clearTimeout(job.limitTimer);
		clearTimeout(job.abandonTimer);
		job.controller.abort(job.outcome.error);
		log.log(job.method + ": job " + job.id + " " + why);
		job.release();
		// Not joined again (a new call starts afresh); under its id, the error, for keepMs
		if (byKey.get(job.key) === job) { byKey.delete(job.key); }
		job.dropTimer = later(() => drop(job), keepMs);
		for (const w of job.waiters.splice(0)) { w(); }
	}

	// Asked after: it is not abandoned for another abandonMs
	function seen(job) {
		clearTimeout(job.abandonTimer);
		if (!job.done) {
			job.abandonTimer = later(() => giveUp(job, "given up: not asked after in " + Math.round(abandonMs / 1000) + " s"), abandonMs);
		}
	}

	function start(spec, params, ctx, key) {
		const job = { id: "j" + (++seq) + "-" + now().toString(36), key, method: ctx.method, done: false,
			outcome: null, progress: null, controller: new AbortController(), waiters: [] };
		let released = false;
		job.release = () => { if (!released) { released = true; release(); } };
		hold();
		byId.set(job.id, job);
		byKey.set(key, job);
		job.limitTimer = later(() => giveUp(job, "did not finish in " + Math.round(jobTimeoutMs / 1000) + " s"), jobTimeoutMs);
		const jobCtx = Object.assign({}, ctx, { signal: job.controller.signal,
			progress: (p) => { if (!job.done && p && typeof p === "object") { job.progress = p; } } });
		job.promise = Promise.resolve().then(() => spec.handler(params, jobCtx)).then(
			(value) => ({ value }), (error) => ({ error }));
		job.promise.then((outcome) => {
			if (job.done) { return; }      // given up: this answer is no one's
			job.done = true;
			job.outcome = outcome;
			clearTimeout(job.limitTimer);
			clearTimeout(job.abandonTimer);
			job.release();
			job.dropTimer = later(() => drop(job), keepMs);
			for (const w of job.waiters.splice(0)) { w(); }
		});
		return job;
	}

	// The job a call is about: the one it names, else the one running for the same thing, else
	// a new one.
	function jobFor(spec, params, ctx) {
		const key = keyOf(ctx.method, ctx.caller, params);
		if (params.jobId !== undefined) {
			const job = byId.get(String(params.jobId));
			if (!job) { throw new CloudError("JOB_UNKNOWN", ctx.method + ": no job " + params.jobId + "; ask again without jobId"); }
			if (job.key !== key) { throw new CloudError("BAD_ARGS", "jobId: a job of another " + ctx.method); }
			return job;
		}
		const running = byKey.get(key);
		if (running && !running.done) { return running; }
		return start(spec, params, ctx, key);
	}

	// Settles when the job is done or after ms; true when it is done
	function settle(job, ms) {
		if (job.done) { return Promise.resolve(true); }
		return new Promise((resolve) => {
			let timer = null;
			const w = () => { clearTimeout(timer); resolve(true); };
			job.waiters.push(w);
			if (ms !== Infinity) {
				timer = setTimeout(() => {
					const i = job.waiters.indexOf(w);
					if (i >= 0) { job.waiters.splice(i, 1); }
					resolve(job.done);
				}, ms);
			}
		});
	}

	function outcomeOf(job) {
		if (job.outcome.error) { throw job.outcome.error; }
		return job.outcome.value;
	}

	return {
		// The handler's answer for this call, or { pending, jobId, progress } for a continuable
		// one whose job is not done within waitMs.
		async run(spec, params, ctx) {
			const job = jobFor(spec, params, ctx);
			seen(job);
			if (params.continuable !== true) {
				await settle(job, Infinity);
				return outcomeOf(job);
			}
			if (await settle(job, waitMs)) { return outcomeOf(job); }
			seen(job);
			const reply = { pending: true, jobId: job.id };
			if (job.progress) { reply.progress = job.progress; }
			return reply;
		},

		get size() { return byId.size; },

		// Tests: every job given up and forgotten.
		stop() { for (const job of [...byId.values()]) { giveUp(job, "stopped"); drop(job); } },
	};
}

module.exports = { createJobs, keyOf, WAIT_MS, KEEP_MS, ABANDON_MS, JOB_TIMEOUT_MS };
