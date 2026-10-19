// node --test tests/unit
// A 401 makes the OAuth adapters refresh the token and send the request again, from callbacks on
// the refresh's and the retry's Futures. Foundations' Future (frameworks/foundations/.../future.js)
// keeps an exception thrown in a then() callback on that callback's own Future, so a refresh that
// failed, or a retry that was refused or never got an answer, used to stay there: the request's
// Future never settled and the command hung until its timeout. Each adapter's listFolder must
// now settle with an error in all three cases, and still succeed when the retry does.
// (Dropbox and Box, on _cloudcore/node, have the same three cases in core-auth.test.js,
// dropbox.test.js and box.test.js.)
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CLOUD = path.join(__dirname, "../../cloud");
const CORE = path.join(CLOUD, "_core/service/_cloudcore");

// As future.js: then(scope, fn) runs fn when settled; a throw in fn becomes THIS Future's
// exception; now() waits on a Future its function returns; .result = Future is not adopted.
class Future {
	constructor() { this.cbs = []; this.done = false; }
	_settle() { this.done = true; const cbs = this.cbs.splice(0); cbs.forEach((cb) => cb()); }
	set result(v) { this._r = v; this._e = undefined; this._settle(); }
	get result() { if (this._e) throw this._e; return this._r; }
	setException(e) { this._e = e; this._settle(); }
	then(scope, fn) {
		const run = () => {
			try { fn.call(scope, this); }
			catch (e) { this._e = e; this.done = true; }   // kept here, as future.js does
		};
		if (this._wait) {
			const w = this._wait; this._wait = null;
			w.then(null, () => { try { this._r = w.result; } catch (e) { this._e = e; } run(); });
		} else if (this.done) {
			run();
		} else {
			this.cbs.push(run);
		}
		return this;
	}
	now(scope, fn) {
		const v = fn.call(scope, this);
		if (v instanceof Future) this._wait = v;
		else if (v !== undefined) this.result = v;
		return this;
	}
	nest(inner) { inner.then(null, () => { try { this.result = inner.result; } catch (e) { this.setException(e); } }); return this; }
}
const settled = (v) => { const f = new Future(); f.result = v; return f; };
const failed = (e) => { const f = new Future(); f.setException(e); return f; };

// connector -> how to list its root (credentials it needs beyond the tokens, and the folder)
const ADAPTERS = {
	google: { folder: "root" },
	onedrive: { folder: "root" },
	hidrive: { folder: "/users/me" },
	koofr: { folder: "/", creds: { mountId: "m1" } },
	yandex: { folder: "disk:/" },
};

function load(name, { refresh, retry }) {
	const svc = fs.readdirSync(path.join(CLOUD, name, "service")).find((d) => d.startsWith("com.palm.service."));
	const dir = path.join(CLOUD, name, "service", svc);
	let n = 0;
	const ctx = {
		IMPORTS: { foundations: { Control: { Future } } }, Future, require, JSON, Date, Math, Buffer,
		console: { log() {}, error() {} },
		HttpCurl: { request: () => (++n === 1 ? settled({ status: 401, responseText: "{}" }) : retry()) },
		OAuth2: { refresh: () => refresh() },
	};
	vm.createContext(ctx);
	for (const f of [path.join(dir, "config.js"), path.join(dir, "adapter.js"), path.join(CORE, "cloudservice.js")]) {
		vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
	}
	return { Adapter: ctx.Adapter, sent: () => n };
}

const goodToken = () => settled({ accessToken: "new", refreshToken: "rt2", expiresIn: 3600 });

for (const [name, how] of Object.entries(ADAPTERS)) {
	const creds = () => Object.assign({ accessToken: "old", refreshToken: "rt" }, how.creds || {});

	test(`${name}: a refresh that fails fails the request`, () => {
		const { Adapter, sent } = load(name, { refresh: () => failed({ returnValue: false, errorCode: "OAUTH_REFRESH_FAILED" }),
			retry: () => { throw new Error("no retry without a token"); } });
		const f = Adapter.listFolder(creds(), how.folder, () => {});
		assert.ok(f.done, "the request answered");
		assert.throws(() => f.result, (e) => e.errorCode === "OAUTH_REFRESH_FAILED");
		assert.strictEqual(sent(), 1);
	});

	test(`${name}: a retry the provider refuses fails the request`, () => {
		const { Adapter } = load(name, { refresh: goodToken, retry: () => settled({ status: 500, responseText: "{}" }) });
		const f = Adapter.listFolder(creds(), how.folder, () => {});
		assert.ok(f.done, "the request answered");
		assert.throws(() => f.result, (e) => !!e && !!e.errorCode);
	});

	test(`${name}: a retry that gets no answer fails the request`, () => {
		const { Adapter } = load(name, { refresh: goodToken, retry: () => failed({ returnValue: false, errorCode: "CURL_FAILED" }) });
		const f = Adapter.listFolder(creds(), how.folder, () => {});
		assert.ok(f.done, "the request answered");
		assert.throws(() => f.result, (e) => e.errorCode === "CURL_FAILED");
	});
}
