// node --test tests/unit
// Loads the real _cloudcore/cloudservice.js into a sandbox with a stand-in Future
// and Adapter, the way sources.json loads it after adapter.js on the device.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "../../cloud/_core/service/_cloudcore/cloudservice.js");

class FakeFuture {
	setException(e) { this.exception = e; }
}

function load(adapter) {
	const logs = [];
	const ctx = {
		Future: FakeFuture,
		Adapter: adapter,
		Config: { SERVICE_NAME: "com.palm.service.test" },
		console: { log: (m) => logs.push(m) },
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx, { filename: SRC });
	return { ctx, logs };
}

test("a TypeError in an adapter method becomes a failed Future", () => {
	const adapter = { listFolder(creds) { return creds.mk.length; } };
	const { logs } = load(adapter);
	const f = adapter.listFolder({});
	assert.ok(f instanceof FakeFuture);
	assert.strictEqual(f.exception.returnValue, false);
	assert.strictEqual(f.exception.errorCode, "CONNECTOR_EXCEPTION");
	assert.match(f.exception.errorText, /length/);
	assert.ok(logs.some((l) => l.includes("Adapter.listFolder threw")));
});

test("an exception that already has an errorCode passes through unchanged", () => {
	const err = { returnValue: false, errorCode: "MEGA_NO_SESSION", errorText: "x" };
	const adapter = { listFolder() { throw err; } };
	load(adapter);
	assert.strictEqual(adapter.listFolder().exception, err);
});

test("normal returns and this are untouched", () => {
	const ret = { ok: 1 };
	const adapter = {
		base: "/root",
		listFolder(a, b) { return [this.base, a, b, ret]; },
	};
	load(adapter);
	assert.deepStrictEqual(adapter.listFolder(1, 2), ["/root", 1, 2, ret]);
});

test("non-function properties are left alone and wrapping happens once", () => {
	const adapter = { NAME: "x", listFolder() { throw new Error("boom"); } };
	const { ctx } = load(adapter);
	const once = adapter.listFolder;
	ctx.CloudGuard.wrap(adapter);
	assert.strictEqual(adapter.listFolder, once);
	assert.strictEqual(adapter.NAME, "x");
});

test("helpers outside the entry points keep throwing for their caller", () => {
	// kDrive/pCloud: _parse throws on a rejected token and _get relies on that throw.
	const rejected = { returnValue: false, errorCode: "PCLOUD_API_ERROR" };
	const adapter = {
		_parse() { throw rejected; },
		contentUrl() { throw new Error("bad id"); },
		getAccountInfo() {
			try { this._parse(); } catch (e) { return { caught: e }; }
			return { caught: null };
		},
	};
	load(adapter);
	assert.throws(() => adapter._parse(), (e) => e === rejected);
	assert.throws(() => adapter.contentUrl(), /bad id/);
	assert.strictEqual(adapter.getAccountInfo().caught, rejected);
});

test("every entry point present is wrapped", () => {
	const names = ["listFolder", "downloadFile", "uploadFile", "uploadReplace",
		"getAccountInfo", "deletePhoto", "ensureAlbumFolder"];
	const adapter = {};
	names.forEach((n) => { adapter[n] = () => { throw new TypeError(n); }; });
	load(adapter);
	names.forEach((n) => assert.strictEqual(adapter[n]().exception.errorCode, "CONNECTOR_EXCEPTION", n));
});

test("no Adapter (flickr-style standalone service) is not an error", () => {
	assert.doesNotThrow(() => load(undefined));
});
