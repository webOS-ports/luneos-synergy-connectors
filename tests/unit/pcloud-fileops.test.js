// node --test tests/unit
// pCloud's createFolder, moveItem and deleteItem (commands/fileOps_commands.js). The real
// config.js, adapter.js and cloudservice.js are loaded the way sources.json loads them, with a
// stand-in HttpCurl.request that records each request and answers from a script, and a stand-in
// Future that settles the way Foundations' does: a Future returned from now()/then() is nested,
// nest() takes over another Future's outcome, assigning a Future to .result does NOT.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PCLOUD = path.join(__dirname, "../../cloud/pcloud/service/com.palm.service.pcloud");
const CORE = path.join(__dirname, "../../cloud/_core/service/_cloudcore");

// Foundations' Future (frameworks/foundations/.../control/future.js), the parts these files use.
class Future {
	constructor() { this._then = []; this._inside = -1; this._r = { isset: false }; }
	get result() { this._r.wasread = true; if (this._r.exception) throw this._r.exception; return this._r.result; }
	set result(v) {
		if (this._r.exception && !this._r.wasread) { this._r.wasread = true; throw this._r.exception; }
		this._r = { result: v, isset: true };
		this._dispatch();
	}
	get exception() { this._r.wasread = true; return this._r.exception; }
	set exception(e) { this._r = { exception: e, isset: true }; this._dispatch(); }
	setException(e) { this.exception = e; }
	get done() { return this._r.isset; }
	_settle(v) { if (v !== undefined) { if (v && typeof v.then === "function") this.nest(v); else this.result = v; } }
	now(scope, fn) {
		this._inside = 0;
		try { this._settle(fn.call(scope, this)); } catch (e) { this._r = { exception: e, isset: true }; }
		this._inside = -1;
		this._dispatch();
		return this;
	}
	then(scope, fn) {
		if (this._inside === -1) { this._then.push({ fn, scope }); this._dispatch(); }
		else this._then.splice(this._inside++, 0, { fn, scope });
		return this;
	}
	nest(inner) {
		if (inner._r.isset) { this._r = inner._r; this._dispatch(); }
		else inner.then(this, () => { try { this.result = inner.result; } catch (e) { this.exception = e; } });
		return this;
	}
	_dispatch() {
		if (this._inside !== -1) return;
		while (this._then.length && this._r.isset) {
			this._inside = 0;
			const { fn, scope } = this._then.shift();
			try {
				this._r.isset = false;
				this._settle(fn.call(scope, this));
				if (!this._r.wasread && this._r.exception) this._r.isset = true;
			} catch (e) { this._r = { exception: e, isset: true }; }
		}
		this._inside = -1;
	}
}
const settled = (v) => { const f = new Future(); f.result = v; return f; };

// replies: one per request, in order; each { status, responseText }.
function pcloud(replies) {
	const sent = [];
	const ctx = {
		IMPORTS: { foundations: { Control: { Future } } }, require, JSON, console: { log() {}, error() {} },
		HttpCurl: {
			request: (o) => {
				const u = new URL(o.url);
				sent.push({ method: o.method, host: u.host, method_: u.pathname.slice(1),
					params: Object.fromEntries(u.searchParams), body: o.body, multipart: o.multipart });
				if (!replies.length) throw new Error("unexpected request " + o.url.replace(/access_token=[^&]*/, "access_token=…"));
				return settled(replies.shift());
			},
		},
	};
	vm.createContext(ctx);
	for (const f of [path.join(PCLOUD, "config.js"), path.join(PCLOUD, "adapter.js"), path.join(CORE, "cloudservice.js")]) {
		vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
	}
	return { Adapter: ctx.Adapter, sent, left: replies };
}

const ok = (obj) => ({ status: 200, responseText: JSON.stringify({ result: 0, ...obj }) });
const apiErr = (result, error) => ({ status: 200, responseText: JSON.stringify({ result, error }) });
const creds = () => ({ accessToken: "tok", apiHost: "eapi.pcloud.com" });
const plain = (v) => JSON.parse(JSON.stringify(v));
const outcome = (f) => { assert.ok(f.done, "settled"); try { return { result: plain(f.result) }; } catch (e) { return { error: e }; } };
// What was asked: [method, params without the token].
const asked = (sent) => sent.map((s) => { const p = { ...s.params }; delete p.access_token; return [s.method_, p]; });

const FOLDER = { isfolder: true, folderid: 55, parentfolderid: 5, id: "d55", name: "New", modified: "Mon, 19 Oct 2026 10:00:00 +0000", created: "x" };
const FILE = { isfolder: false, fileid: 7, parentfolderid: 5, id: "f7", name: "a.txt", size: 42, contenttype: "text/plain", modified: "Mon, 19 Oct 2026 10:00:01 +0000" };
const notFile = apiErr(2009, "File not found.");
const notFolder = apiErr(2005, "Directory does not exist.");

test("createFolder asks createfolder on the account's region host and answers listFolder's entry", () => {
	const { Adapter, sent, left } = pcloud([ok({ metadata: FOLDER })]);
	const r = outcome(Adapter.createFolder(creds(), 5, "New", null));
	// (size and mimeType are undefined for a folder, as in listFolder, and drop out of JSON.)
	assert.deepStrictEqual(r.result, { entry: { id: 55, type: "folder", name: "New", modified: FOLDER.modified, path: 55 } });
	assert.deepStrictEqual(asked(sent), [["createfolder", { folderid: "5", name: "New" }]]);
	assert.strictEqual(sent[0].host, "eapi.pcloud.com");
	assert.strictEqual(sent[0].params.access_token, "tok");
	assert.strictEqual(sent[0].method, "GET");
	assert.strictEqual(left.length, 0);

	// The same metadata through listFolder gives the same entry.
	const lf = pcloud([ok({ metadata: { folderid: 5, contents: [FOLDER] } })]);
	assert.deepStrictEqual(plain(lf.Adapter.listFolder(creds(), 5, null).result.entries[0]), r.result.entry);
});

test("createFolder: the root, a typed folder id, the default US host; a file id is refused", () => {
	let k = pcloud([ok({ metadata: FOLDER })]);
	outcome(k.Adapter.createFolder({ accessToken: "tok" }, 0, "New & Co", null));
	assert.deepStrictEqual(asked(k.sent), [["createfolder", { folderid: "0", name: "New & Co" }]]);
	assert.strictEqual(k.sent[0].host, "api.pcloud.com");
	k = pcloud([ok({ metadata: FOLDER })]);
	outcome(k.Adapter.createFolder(creds(), "d5", "New", null));
	assert.deepStrictEqual(asked(k.sent), [["createfolder", { folderid: "5", name: "New" }]]);
	for (const bad of ["f5", "/Docs", "abc"]) {
		k = pcloud([]);
		assert.strictEqual(outcome(k.Adapter.createFolder(creds(), bad, "New", null)).error.errorCode, "BAD_ARGS", bad);
		assert.strictEqual(k.sent.length, 0);
	}
});

test("createFolder: a nonzero result in an HTTP 200 fails, and so does an HTTP error", () => {
	let k = pcloud([apiErr(2004, "File or folder alredy exists.")]);
	let e = outcome(k.Adapter.createFolder(creds(), 5, "New", null)).error;
	assert.deepStrictEqual([e.returnValue, e.errorCode, e.result], [false, "PCLOUD_API_ERROR", 2004]);
	k = pcloud([{ status: 502, responseText: "" }]);
	e = outcome(k.Adapter.createFolder(creds(), 5, "New", null)).error;
	assert.deepStrictEqual([e.errorCode, e.status], ["PCLOUD_HTTP_ERROR", 502]);
});

test("moveItem renames a file in place after checking its folder", () => {
	const renamed = { ...FILE, name: "b.txt" };
	const { Adapter, sent, left } = pcloud([ok({ metadata: FILE }), notFolder,
		ok({ metadata: { folderid: 5, contents: [FILE, { ...FOLDER, name: "other" }] } }), ok({ metadata: renamed })]);
	const r = outcome(Adapter.moveItem(creds(), 7, null, "b.txt", null));
	assert.deepStrictEqual(r.result, { entry: { id: 7, type: "file", name: "b.txt", size: 42, modified: FILE.modified, path: 7, mimeType: "text/plain" } });
	assert.deepStrictEqual(asked(sent), [
		["checksumfile", { fileid: "7" }],
		["listfolder", { folderid: "7", nofiles: "1" }],
		["listfolder", { folderid: "5" }],
		["renamefile", { fileid: "7", toname: "b.txt" }],
	]);
	assert.ok(sent.every((s) => s.host === "eapi.pcloud.com"));
	assert.strictEqual(left.length, 0);
});

test("moveItem moves a file with tofolderid only, or with both", () => {
	let k = pcloud([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 9, contents: [] } }), ok({ metadata: { ...FILE, parentfolderid: 9 } })]);
	assert.strictEqual(outcome(k.Adapter.moveItem(creds(), "7", 9, null, null)).result.entry.path, 7);
	assert.deepStrictEqual(asked(k.sent).slice(2), [["listfolder", { folderid: "9" }], ["renamefile", { fileid: "7", tofolderid: "9" }]]);
	k = pcloud([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 9, contents: [] } }), ok({ metadata: { ...FILE, name: "b.txt" } })]);
	assert.strictEqual(outcome(k.Adapter.moveItem(creds(), 7, "d9", "b.txt", null)).result.entry.name, "b.txt");
	assert.deepStrictEqual(asked(k.sent).slice(2), [["listfolder", { folderid: "9" }], ["renamefile", { fileid: "7", tofolderid: "9", toname: "b.txt" }]]);
});

test("moveItem refuses to replace a file or folder of that name, but lets a file change its own case", () => {
	for (const clash of [{ ...FILE, fileid: 8, name: "B.TXT" }, { ...FOLDER, name: "b.txt" }]) {
		const k = pcloud([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 9, contents: [clash] } })]);
		const e = outcome(k.Adapter.moveItem(creds(), 7, 9, "b.txt", null)).error;
		assert.deepStrictEqual([e.returnValue, e.errorCode], [false, "PCLOUD_EXISTS"]);
		assert.strictEqual(k.sent.length, 3, "no renamefile");
	}
	const k = pcloud([ok({ metadata: FILE }), notFolder, ok({ metadata: { folderid: 5, contents: [FILE] } }), ok({ metadata: { ...FILE, name: "A.txt" } })]);
	assert.strictEqual(outcome(k.Adapter.moveItem(creds(), 7, null, "A.txt", null)).result.entry.name, "A.txt");
	assert.deepStrictEqual(asked(k.sent)[3], ["renamefile", { fileid: "7", toname: "A.txt" }]);
});

test("moveItem renames and moves a folder with renamefolder, with no listing first", () => {
	const moved = { ...FOLDER, parentfolderid: 9, name: "Renamed" };
	let k = pcloud([notFile, ok({ metadata: { ...FOLDER, contents: [] } }), ok({ metadata: moved })]);
	const r = outcome(k.Adapter.moveItem(creds(), 55, 9, "Renamed", null));
	assert.deepStrictEqual(r.result, { entry: { id: 55, type: "folder", name: "Renamed", modified: FOLDER.modified, path: 55 } });
	assert.deepStrictEqual(asked(k.sent), [
		["checksumfile", { fileid: "55" }],
		["listfolder", { folderid: "55", nofiles: "1" }],
		["renamefolder", { tofolderid: "9", toname: "Renamed", folderid: "55" }],
	]);
	k = pcloud([notFile, ok({ metadata: FOLDER }), ok({ metadata: moved })]);
	outcome(k.Adapter.moveItem(creds(), 55, null, "Renamed", null));
	assert.deepStrictEqual(asked(k.sent)[2], ["renamefolder", { toname: "Renamed", folderid: "55" }]);
	k = pcloud([notFile, ok({ metadata: FOLDER }), ok({ metadata: moved })]);
	outcome(k.Adapter.moveItem(creds(), 55, 9, null, null));
	assert.deepStrictEqual(asked(k.sent)[2], ["renamefolder", { tofolderid: "9", folderid: "55" }]);
	k = pcloud([notFile, ok({ metadata: FOLDER }), apiErr(2004, "File or folder alredy exists.")]);
	assert.strictEqual(outcome(k.Adapter.moveItem(creds(), 55, 9, null, null)).error.result, 2004);
});

test("typed ids skip the other lookup", () => {
	let k = pcloud([ok({ metadata: FILE }), ok({ metadata: { folderid: 5, contents: [] } }), ok({ metadata: FILE })]);
	outcome(k.Adapter.moveItem(creds(), "f7", null, "b.txt", null));
	assert.deepStrictEqual(asked(k.sent).map((a) => a[0]), ["checksumfile", "listfolder", "renamefile"]);
	assert.deepStrictEqual(asked(k.sent)[1], ["listfolder", { folderid: "5" }]);
	k = pcloud([ok({ metadata: FOLDER }), ok({})]);
	assert.deepStrictEqual(outcome(k.Adapter.deleteItem(creds(), "d55", null)).result, {});
	assert.deepStrictEqual(asked(k.sent), [["listfolder", { folderid: "55", nofiles: "1" }], ["deletefolderrecursive", { folderid: "55" }]]);
});

test("an id that is both a file and a folder, or neither, is refused before anything changes", () => {
	let k = pcloud([ok({ metadata: FILE }), ok({ metadata: { ...FOLDER, folderid: 7 } })]);
	let e = outcome(k.Adapter.deleteItem(creds(), 7, null)).error;
	assert.deepStrictEqual([e.returnValue, e.errorCode], [false, "PCLOUD_AMBIGUOUS_ID"]);
	assert.strictEqual(k.sent.length, 2);
	k = pcloud([ok({ metadata: FILE }), ok({ metadata: { ...FOLDER, folderid: 7 } })]);
	assert.strictEqual(outcome(k.Adapter.moveItem(creds(), 7, 9, null, null)).error.errorCode, "PCLOUD_AMBIGUOUS_ID");
	assert.strictEqual(k.sent.length, 2);
	k = pcloud([notFile, notFolder]);
	assert.strictEqual(outcome(k.Adapter.deleteItem(creds(), 7, null)).error.errorCode, "PCLOUD_NOT_FOUND");
	assert.strictEqual(k.sent.length, 2);
});

test("a lookup that fails for another reason fails the call, in either lookup", () => {
	let k = pcloud([apiErr(2000, "Log in failed.")]);
	let e = outcome(k.Adapter.deleteItem(creds(), 7, null)).error;
	assert.deepStrictEqual([e.errorCode, e.result], ["PCLOUD_API_ERROR", 2000]);
	assert.strictEqual(k.sent.length, 1);
	k = pcloud([notFile, apiErr(1000, "Log in required.")]);
	e = outcome(k.Adapter.moveItem(creds(), 7, null, "b", null)).error;
	assert.deepStrictEqual([e.errorCode, e.result], ["PCLOUD_API_ERROR", 1000]);
	assert.strictEqual(k.sent.length, 2);
});

test("deleteItem: deletefile for a file, deletefolderrecursive for a folder; errors fail", () => {
	let k = pcloud([ok({ metadata: FILE }), notFolder, ok({ metadata: { ...FILE, isdeleted: true } })]);
	assert.deepStrictEqual(outcome(k.Adapter.deleteItem(creds(), 7, null)).result, {});
	assert.deepStrictEqual(asked(k.sent)[2], ["deletefile", { fileid: "7" }]);
	k = pcloud([notFile, ok({ metadata: FOLDER }), ok({ deletedfiles: 3, deletedfolders: 1 })]);
	assert.deepStrictEqual(outcome(k.Adapter.deleteItem(creds(), "55", null)).result, {});
	assert.deepStrictEqual(asked(k.sent)[2], ["deletefolderrecursive", { folderid: "55" }]);
	k = pcloud([notFile, ok({ metadata: FOLDER }), apiErr(2028, "There are active shares or sharerequests for this folder.")]);
	const e = outcome(k.Adapter.deleteItem(creds(), 55, null)).error;
	assert.deepStrictEqual([e.returnValue, e.errorCode, e.result], [false, "PCLOUD_API_ERROR", 2028]);
});

test("the root folder is neither deleted nor moved; malformed ids are refused unsent", () => {
	for (const item of [0, "0", "d0"]) {
		const k = pcloud([]);
		assert.strictEqual(outcome(k.Adapter.deleteItem(creds(), item, null)).error.errorCode, "BAD_ARGS", String(item));
		assert.strictEqual(k.sent.length, 0);
	}
	let k = pcloud([ok({ metadata: { ...FOLDER, folderid: 0 } })]);
	assert.strictEqual(outcome(k.Adapter.moveItem(creds(), "d0", null, "x", null)).error.errorCode, "BAD_ARGS");
	assert.strictEqual(k.sent.length, 1);
	for (const call of [(A) => A.moveItem(creds(), "/a", null, "b", null), (A) => A.moveItem(creds(), 7, "f9", null, null),
		(A) => A.deleteItem(creds(), "x7", null), (A) => A.deleteItem(creds(), "", null)]) {
		k = pcloud([]);
		assert.strictEqual(outcome(call(k.Adapter)).error.errorCode, "BAD_ARGS");
		assert.strictEqual(k.sent.length, 0);
	}
});

test("pCloud has no refresh: onRenew is never called", () => {
	const renewed = [];
	const k = pcloud([ok({ metadata: FOLDER })]);
	outcome(k.Adapter.createFolder(creds(), 5, "New", (nc) => renewed.push(nc)));
	assert.strictEqual(renewed.length, 0);
});

test("bad credentials give a failed Future, never a throw", () => {
	const { Adapter } = pcloud([]);
	for (const call of [() => Adapter.createFolder(null, 0, "x"), () => Adapter.moveItem(null, 7, null, "b"), () => Adapter.deleteItem(null, 7)]) {
		assert.ok(outcome(call()).error);
	}
});

test("createFolder accepts the root as the commands name it with no folder", () => {
	for (const root of ["root", "", "/", 0, "0", "d0"]) {
		const k = pcloud([ok({ metadata: FOLDER })]);
		outcome(k.Adapter.createFolder(creds(), root, "New", null));
		assert.deepStrictEqual(asked(k.sent), [["createfolder", { folderid: "0", name: "New" }]], String(root));
	}
});

test("uploadFile names the uploaded part, which is what pCloud stores it as", () => {
	const { Adapter, sent } = pcloud([ok({ metadata: [FILE] })]);
	outcome(Adapter.uploadFile(creds(), 5, "/media/internal/.cache/tmp-123.bin", "note.txt", "text/plain", null));
	assert.strictEqual(sent[0].method_, "uploadfile");
	assert.deepStrictEqual(plain(sent[0].multipart), [{ name: "file", file: "/media/internal/.cache/tmp-123.bin", filename: "note.txt" }]);
});
