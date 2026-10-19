// node --test tests/unit
// cloud/mega's file encryption (MegaCrypto.ctrFile) on this node: its home-made AES-128-CTR
// (ECB keystream + XOR, for node 0.4.12, which had no CTR cipher) must equal node's own
// aes-128-ctr. Its cipher probe once took modern node for 0.4.12, and every upload failed
// (CTR_FAILED, "Invalid initialization vector").
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const SRC = path.join(__dirname, "../../cloud/mega/service/com.palm.service.mega/megacrypto.js");

function megaCrypto() {
	const ctx = { IMPORTS: { foundations: { Control: { Future: function () {} } } }, require, Buffer, console: { log() {} } };
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx, { filename: SRC });
	return ctx.MegaCrypto;
}

test("ctrFile is AES-128-CTR with the nonce in the counter's high half", () => {
	const MC = megaCrypto();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "megactr-"));
	try {
		const plain = crypto.randomBytes(65536 * 2 + 37);   // three read chunks, a partial last block
		const key = crypto.randomBytes(16);
		const nonce = [0x01020304, 0xa0b0c0d0];
		fs.writeFileSync(path.join(dir, "in"), plain);
		let err = "not called";
		MC.ctrFile(path.join(dir, "in"), path.join(dir, "out"), [...key], nonce, (e) => { err = e; });
		assert.strictEqual(err, null);
		const iv = Buffer.concat([Buffer.from([1, 2, 3, 4, 0xa0, 0xb0, 0xc0, 0xd0]), Buffer.alloc(8)]);
		const c = crypto.createCipheriv("aes-128-ctr", key, iv);
		const want = Buffer.concat([c.update(plain), c.final()]);
		assert.ok(fs.readFileSync(path.join(dir, "out")).equals(want));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
