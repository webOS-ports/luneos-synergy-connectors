// S3_IT=1 S3_IT_KEYFILE=<file> node --test tests/unit/s3-garage.test.js
// Optional: the S3 connector against a real S3-compatible server (Garage, MinIO, ...), over
// node's real fetch, on the stand-in bus. Skipped unless S3_IT=1. Everything happens under a
// fresh prefix, which is deleted again at the end.
//
//   S3_IT_ENDPOINT  default http://127.0.0.1:3900       S3_IT_REGION  default us-east-1
//   S3_IT_BUCKET    default luneos-test
//   S3_IT_KEYFILE   required: a file with the output of `garage key create/info --show-secret`
//                   ("Key ID: ..." and "Secret key: ...")
// The keys are read here and never printed.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fakePalmbus, ask } = require("./lib/fakes.js");

const ON = process.env.S3_IT === "1";
const SVC = path.join(__dirname, "../../cloud/s3/service/com.palm.service.s3");
const DOCS = { appId: "org.webosports.app.documents" };
const PHOTOS = { service: "com.palm.service.photos" };

function keys() {
	const file = process.env.S3_IT_KEYFILE;
	assert.ok(file, "set S3_IT_KEYFILE");
	const text = fs.readFileSync(file, "utf8");
	const id = /^Key ID:\s*(\S+)/m.exec(text), secret = /^Secret key:\s*(\S+)/m.exec(text);
	assert.ok(id && secret, "no Key ID / Secret key in " + file);
	return { accessKeyId: id[1], secretAccessKey: secret[1] };
}

test("S3 against a real server: login, list, upload, download, links, move, delete", { skip: !ON && "set S3_IT=1" }, async () => {
	const service = require(SVC);
	const pb = fakePalmbus({ onCall: () => ({ returnValue: false, errorCode: -1, errorText: "no Accounts here" }) });
	service.start({ palmbus: pb, idleMs: 0, exit: () => {}, log: { log() {}, error() {} } });
	const handle = pb.handles[0];
	const call = (m, p, who = DOCS) => ask(handle, m, p, who);
	const { accessKeyId, secretAccessKey } = keys();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3-it-"));
	const root = "luneos-it-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex") + "/";
	let creds = null;
	const ok = (r, what) => { assert.strictEqual(r.returnValue, true, what + ": " + r.errorCode + " " + r.errorText); return r; };
	try {
		const bad = await call("login", { endpoint: process.env.S3_IT_ENDPOINT || "http://127.0.0.1:3900",
			region: process.env.S3_IT_REGION || "us-east-1", bucket: process.env.S3_IT_BUCKET || "luneos-test",
			accessKeyId, secretAccessKey: secretAccessKey + "x" }, {});
		assert.deepStrictEqual([bad.errorCode, bad.status], ["S3_AUTH_FAILED", 403], "a wrong secret is refused");

		const login = ok(await call("login", { endpoint: process.env.S3_IT_ENDPOINT || "http://127.0.0.1:3900",
			region: process.env.S3_IT_REGION || "us-east-1", bucket: process.env.S3_IT_BUCKET || "luneos-test",
			accessKeyId, secretAccessKey, pathStyle: true }, {}), "login");
		creds = { credentials: login.credentials };
		const c = (more) => Object.assign({}, creds, more);
		ok(await call("checkCredentials", { credentials: login.credentials }, {}), "checkCredentials");

		// upload: random bytes, a name that needs encoding, a type
		const bytes = crypto.randomBytes(300 * 1024 + 7);
		const local = path.join(tmp, "up.bin");
		fs.writeFileSync(local, bytes);
		ok(await call("createFolder", c({ path: root, name: "Sub dir" })), "createFolder");
		const up = ok(await call("uploadFile", c({ path: root, localPath: local, name: "Café ü+&=.bin", mimeType: "application/x-test" })), "uploadFile");
		assert.deepStrictEqual([up.id, up.size], [root + "Café ü+&=.bin", bytes.length]);

		const list = ok(await call("listFolder", c({ path: root })), "listFolder").entries;
		assert.deepStrictEqual(list.map((e) => [e.type, e.name, e.size]).sort(),
			[["file", "Café ü+&=.bin", bytes.length], ["folder", "Sub dir", 0]]);

		const dest = path.join(tmp, "down", "file.bin");
		ok(await call("downloadFile", c({ fileId: up.id, localPath: dest })), "downloadFile");
		assert.ok(fs.readFileSync(dest).equals(bytes), "the bytes came back");

		// save-back
		const bytes2 = crypto.randomBytes(1000);
		fs.writeFileSync(local, bytes2);
		ok(await call("uploadFile", c({ fileId: up.id, localPath: local, replace: true })), "uploadFile replace");
		ok(await call("downloadFile", c({ fileId: up.id, localPath: dest })), "downloadFile 2");
		assert.ok(fs.readFileSync(dest).equals(bytes2), "replaced in place");

		// moves: rename a file, move it into the folder, rename the folder
		const mv = ok(await call("moveItem", c({ path: up.id, name: "renamed.bin" })), "rename").entry;
		assert.strictEqual(mv.path, root + "renamed.bin");
		const mv2 = ok(await call("moveItem", c({ path: mv.path, toPath: root + "Sub dir/" })), "move").entry;
		assert.strictEqual(mv2.path, root + "Sub dir/renamed.bin");
		const conflict = await call("moveItem", c({ path: mv2.path, toPath: root + "Sub dir/" , name: "renamed.bin" }));
		assert.strictEqual(conflict.returnValue, true, "moving onto itself changes nothing");
		const mvd = ok(await call("moveItem", c({ path: root + "Sub dir/", name: "Moved" })), "folder rename").entry;
		assert.strictEqual(mvd.path, root + "Moved/");
		const after = ok(await call("listFolder", c({ path: root + "Moved/" })), "list moved").entries;
		assert.deepStrictEqual(after.map((e) => e.name), ["renamed.bin"]);
		assert.deepStrictEqual(ok(await call("listFolder", c({ path: root })), "list root").entries.map((e) => e.path), [root + "Moved/"]);

		// photos: a presigned link fetched with no header
		const jpg = path.join(tmp, "p.jpg");
		fs.writeFileSync(jpg, bytes);
		ok(await call("uploadFile", c({ path: root + "Album", localPath: jpg })), "upload jpg");
		const photos = ok(await call("listPhotos", c({ aid: root + "Album" }), PHOTOS), "listPhotos").photos;
		assert.strictEqual(photos.length, 1);
		const res = await fetch(photos[0].src_big);
		assert.strictEqual(res.status, 200, "the presigned link works");
		assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes));

		// delete a file, then the whole prefix
		ok(await call("deletePhoto", c({ pid: photos[0].pid }), PHOTOS), "deletePhoto");
		ok(await call("deleteItem", c({ path: root })), "deleteItem folder");
		assert.deepStrictEqual(ok(await call("listFolder", c({ path: root })), "list after delete").entries, []);
	} finally {
		if (creds) { await call("deleteItem", Object.assign({}, creds, { path: root })).catch(() => {}); }
		fs.rmSync(tmp, { recursive: true, force: true });
		handle.listeners = {};
	}
});
