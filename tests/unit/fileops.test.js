// node --test tests/unit
// _cloudcore's createFolder, moveItem and deleteItem commands (commands/fileOps_commands.js) against
// a stand-in adapter, credentials store and ACL: argument checks, what reaches the adapter, the
// reply, renewed credentials, and NOT_SUPPORTED for an adapter without the method.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "../../cloud/_core/service/_cloudcore/commands/fileOps_commands.js");

class FakeFuture {
	constructor() { this.cbs = []; this.done = false; }
	set result(v) { this._r = v; this.done = true; this.cbs.splice(0).forEach((cb) => cb(this)); }
	get result() { if (this._e) throw this._e; return this._r; }
	setException(e) { this._e = e; this.done = true; this.cbs.splice(0).forEach((cb) => cb(this)); }
	then(scope, fn) { const cb = () => fn.call(scope, this); if (this.done) cb(); else this.cbs.push(cb); return this; }
}
const settled = (v) => { const f = new FakeFuture(); f.result = v; return f; };

function setup(adapter, { allow = true, config = {} } = {}) {
	const saved = [];
	const ctx = {
		Future: FakeFuture,
		Adapter: adapter,
		Config: { FILE_APP_IDS: ["x"], ROOT_FOLDER: "root", DISPLAY_NAME: "Test", ...config },
		Acl: { enforce: (a, f) => { if (!allow) f.setException({ errorCode: "PERMISSION_DENIED" }); return allow; } },
		AccountCreds: {
			resolve: (args) => settled({ common: { accessToken: "tok" }, from: args.accountId }),
			save: (id, c) => saved.push([id, c]),
		},
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx, { filename: SRC });
	const call = (assistant, args) => {
		const a = new ctx[assistant]();
		a.controller = { args };
		const f = new FakeFuture();
		a.run(f);
		return f;
	};
	return { call, saved, ctx };
}

const plain = (o) => JSON.parse(JSON.stringify(o));
const err = (f) => { try { f.result; } catch (e) { return e.errorCode; } return null; };

test("createFolder: parent and name reach the adapter; the new entry comes back", () => {
	const calls = [];
	const { call, saved } = setup({
		createFolder(creds, parent, name, onRenew) {
			calls.push([creds.common.accessToken, parent, name]);
			onRenew({ common: { accessToken: "new" } });
			return settled({ entry: { id: "9", type: "folder", name, path: parent + "/" + name } });
		},
	});
	const f = call("CreateFolderCommandAssistant", { accountId: "a1", path: "/Docs", name: "New" });
	assert.deepStrictEqual(calls, [["tok", "/Docs", "New"]]);
	assert.deepStrictEqual(plain(f.result.entry), { id: "9", type: "folder", name: "New", path: "/Docs/New" });
	assert.strictEqual(f.result.returnValue, true);
	assert.deepStrictEqual(plain(saved), [["a1", { common: { accessToken: "new" } }]]);
	// no parent: the root
	call("CreateFolderCommandAssistant", { accountId: "a1", name: "Top" });
	assert.deepStrictEqual(calls[1], ["tok", "root", "Top"]);
});

test("createFolder: a name must be one path component", () => {
	const { call } = setup({ createFolder: () => { throw new Error("must not be called"); } });
	for (const name of [undefined, "", ".", "..", "a/b", "a\u0000b", 5]) {
		assert.strictEqual(err(call("CreateFolderCommandAssistant", { accountId: "a", name })), "MISSING_ARGS", String(name));
	}
});

test("moveItem: rename, move, or both; one of them is required", () => {
	const calls = [];
	const { call } = setup({
		moveItem(creds, item, to, name) { calls.push([item, to, name]); return settled({ entry: { id: item } }); },
	});
	call("MoveItemCommandAssistant", { accountId: "a", path: "/a.txt", name: "b.txt" });
	call("MoveItemCommandAssistant", { accountId: "a", fileId: "id1", toFolderId: "id2" });
	call("MoveItemCommandAssistant", { accountId: "a", path: "/a.txt", toPath: "/Dir", name: "c.txt" });
	assert.deepStrictEqual(plain(calls), [["/a.txt", null, "b.txt"], ["id1", "id2", null], ["/a.txt", "/Dir", "c.txt"]]);
	assert.strictEqual(err(call("MoveItemCommandAssistant", { accountId: "a", path: "/a.txt" })), "MISSING_ARGS");
	assert.strictEqual(err(call("MoveItemCommandAssistant", { accountId: "a", name: "x" })), "MISSING_ARGS");
	assert.strictEqual(err(call("MoveItemCommandAssistant", { accountId: "a", path: "/a", name: "x/y" })), "MISSING_ARGS");
	assert.strictEqual(calls.length, 3);
});

test("deleteItem: the item reaches the adapter, the root never does", () => {
	const calls = [];
	const { call } = setup({ deleteItem(creds, item) { calls.push(item); return settled({}); } }, { config: { ROOT_FOLDER: "0" } });
	assert.strictEqual(call("DeleteItemCommandAssistant", { accountId: "a", fileId: "42" }).result.returnValue, true);
	for (const item of ["0", "/", "root"]) {
		assert.strictEqual(err(call("DeleteItemCommandAssistant", { accountId: "a", path: item })), "BAD_ARGS", item);
	}
	assert.strictEqual(err(call("DeleteItemCommandAssistant", { accountId: "a" })), "MISSING_ARGS");
	assert.deepStrictEqual(calls, ["42"]);
});

test("an adapter without the method answers NOT_SUPPORTED", () => {
	const { call } = setup({});
	assert.strictEqual(err(call("CreateFolderCommandAssistant", { accountId: "a", name: "x" })), "NOT_SUPPORTED");
	assert.strictEqual(err(call("MoveItemCommandAssistant", { accountId: "a", path: "/a", name: "b" })), "NOT_SUPPORTED");
	assert.strictEqual(err(call("DeleteItemCommandAssistant", { accountId: "a", path: "/a" })), "NOT_SUPPORTED");
});

test("an adapter failure is the command's failure; the ACL comes first", () => {
	const failed = new FakeFuture();
	failed.setException({ returnValue: false, errorCode: "BOX_API_ERROR" });
	let reached = 0;
	let { call } = setup({ deleteItem: () => { reached++; return failed; } });
	assert.strictEqual(err(call("DeleteItemCommandAssistant", { accountId: "a", path: "/a" })), "BOX_API_ERROR");
	({ call } = setup({ deleteItem: () => { reached++; return failed; } }, { allow: false }));
	assert.strictEqual(err(call("DeleteItemCommandAssistant", { accountId: "a", path: "/a" })), "PERMISSION_DENIED");
	assert.strictEqual(reached, 1);
});
