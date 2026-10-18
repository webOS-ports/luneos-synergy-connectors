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
	const adapter = { NAME: "x", f() { throw new Error("boom"); } };
	const { ctx } = load(adapter);
	const once = adapter.f;
	ctx.CloudGuard.wrap(adapter);
	assert.strictEqual(adapter.f, once);
	assert.strictEqual(adapter.NAME, "x");
});

test("no Adapter (flickr-style standalone service) is not an error", () => {
	assert.doesNotThrow(() => load(undefined));
});
