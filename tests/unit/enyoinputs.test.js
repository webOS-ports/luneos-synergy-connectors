// node --test tests/unit
// Enyo 0.10 finds a component's kind by its exact name, so "control" is no kind at all
// ("Failed to find a constructor for kind [control]") and the whole page stays white, as the
// S3 sign-in did. Every kind is capitalised, or a dotted enyo.* name.
//
// Enyo 0.10's enyo.Input takes its HTML input type from the published property inputType
// (inputTypeChanged sets the inner element's type). A "type" property on it is ignored, which left
// MEGA's password field showing the password in clear text. Passwords use kind "PasswordInput".
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../..");

function sources(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory() && !["node_modules", ".git", "tests"].includes(e.name)) sources(p, out);
		else if (e.isFile() && e.name.endsWith(".js") && p.includes(`${path.sep}apps${path.sep}`)) out.push(p);
	}
	return out;
}

// The component literal that opens with kind: "Input", up to its first closing brace.
const INPUT_WITH_TYPE = /kind:\s*"Input"[^{}]*?\btype\s*:/g;

test("no Enyo Input in the apps sets type (ignored; use inputType or PasswordInput)", () => {
	const bad = [];
	for (const file of sources(ROOT)) {
		const src = fs.readFileSync(file, "utf8");
		for (const m of src.matchAll(INPUT_WITH_TYPE)) {
			bad.push(`${path.relative(ROOT, file)}:${src.slice(0, m.index).split("\n").length}`);
		}
	}
	assert.deepStrictEqual(bad, []);
});

test("every Enyo kind in the apps is a name Enyo can find", () => {
	const bad = [];
	for (const file of sources(ROOT)) {
		const src = fs.readFileSync(file, "utf8");
		for (const m of src.matchAll(/\bkind:\s*"([^"]*)"/g)) {
			if (!/^([A-Z]|enyo\.[A-Z])/.test(m[1])) {
				bad.push(`${path.relative(ROOT, file)}:${src.slice(0, m.index).split("\n").length} ${m[1]}`);
			}
		}
	}
	assert.deepStrictEqual(bad, []);
});
