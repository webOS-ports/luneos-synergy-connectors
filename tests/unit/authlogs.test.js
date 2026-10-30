// node --test tests/unit
// A sign-in app's result is what Accounts stores: access and refresh tokens, S3's secret key,
// MEGA's session. The apps used to log it whole (enyo.json.stringify(result)), so it ended up in
// the journal. No app may log a stringified object; they log how a step ended (returnValue,
// errorCode) instead.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../..");
// The sign-in apps of the cloud connectors, the one shared by the OAuth ones among them.
const APPS = path.join(ROOT, "cloud");

function sources(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory() && e.name !== "node_modules") sources(p, out);
		else if (e.isFile() && e.name.endsWith(".js") && p.includes(`${path.sep}apps${path.sep}`)) out.push(p);
	}
	return out;
}

// A log call (this.log, enyo.log, console.*) with a stringify in its arguments, on one line.
const LOGGED_OBJECT = /\b(?:this\.log|enyo\.log|console\.(?:log|error|warn|info))\s*\([^;\n]*\bstringify\s*\(/g;

test("no cloud sign-in app logs a stringified object (its result holds the credentials)", () => {
	const bad = [];
	for (const file of sources(APPS)) {
		const src = fs.readFileSync(file, "utf8");
		for (const m of src.matchAll(LOGGED_OBJECT)) {
			bad.push(`${path.relative(ROOT, file)}:${src.slice(0, m.index).split("\n").length}`);
		}
	}
	assert.deepStrictEqual(bad, []);
});
