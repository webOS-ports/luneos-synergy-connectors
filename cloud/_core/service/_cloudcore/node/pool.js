/* pool.js - many requests of one listing, a few at a time.
 *
 * A listing that asks one request per folder or per photo (a link for every photo of a folder,
 * the count of every folder) took as long as all of them one after the other. mapLimit asks up
 * to `limit` at once and gives the answers in the order of the items:
 *
 *   const links = await mapLimit(entries, 4, (e) => adapter.getTemporaryLink(s, e.path), { signal, progress });
 *
 * fn throwing fails the whole (the first error, once the requests under way are over), as the
 * loop it replaces did; a fn that wants a failure left out catches it itself. Once `signal`
 * aborts no item more is started, and mapLimit throws the signal's reason. progress(done) hears
 * how many items are done, after each.
 */
"use strict";

const CONCURRENCY = 4;

function mapLimit(items, limit, fn, { signal = null, progress = null } = {}) {
	const list = Array.from(items);
	const n = Math.max(1, Math.floor(limit) || CONCURRENCY);
	const out = new Array(list.length);
	let next = 0, active = 0, done = 0, failure = null;
	return new Promise((resolve, reject) => {
		const finish = () => (failure ? reject(failure.error) : resolve(out));
		const pump = () => {
			if (!failure && signal && signal.aborted) { failure = { error: signal.reason || new Error("aborted") }; }
			while (!failure && active < n && next < list.length) {
				const i = next++;
				active++;
				Promise.resolve().then(() => fn(list[i], i)).then((v) => {
					out[i] = v;
					done++;
					if (progress) { progress(done); }
				}, (e) => { if (!failure) { failure = { error: e }; } }).finally(() => { active--; pump(); });
			}
			if (!active && (failure || next >= list.length)) { finish(); }
		};
		pump();
	});
}

module.exports = { mapLimit, CONCURRENCY };
