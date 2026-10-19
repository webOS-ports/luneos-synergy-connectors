// node --test tests/unit
// OAuth credentials that the build fills in (meta-luneos cloud-synergy-connector.inc, from
// <NAME>_CLIENT_ID / <NAME>_CLIENT_SECRET in the builder's own config) stay placeholders here.
// A real value in one of these lines would be published with the repository, which is public.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CLOUD = path.join(__dirname, "../../cloud");

// connector directory -> the config.js keys that come from the build
const FROM_BUILD = {
	box: { CLIENT_ID: "PLACEHOLDER_BOX_CLIENT_ID", CLIENT_SECRET: "PLACEHOLDER_BOX_CLIENT_SECRET" },
	dropbox: { CLIENT_ID: "PLACEHOLDER_DROPBOX_CLIENT_ID" },
	google: { CLIENT_ID: "PLACEHOLDER_GDRIVE_CLIENT_ID", CLIENT_SECRET: "PLACEHOLDER_GDRIVE_CLIENT_SECRET" },
	hidrive: { CLIENT_ID: "PLACEHOLDER_HIDRIVE_CLIENT_ID", CLIENT_SECRET: "PLACEHOLDER_HIDRIVE_CLIENT_SECRET" },
	kdrive: { CLIENT_ID: "PLACEHOLDER_KDRIVE_CLIENT_ID", CLIENT_SECRET: "PLACEHOLDER_KDRIVE_CLIENT_SECRET" },
	koofr: { CLIENT_ID: "PLACEHOLDER_KOOFR_CLIENT_ID", CLIENT_SECRET: "PLACEHOLDER_KOOFR_CLIENT_SECRET" },
	onedrive: { CLIENT_ID: "PLACEHOLDER_ONEDRIVE_CLIENT_ID", CLIENT_SECRET: "PLACEHOLDER_ONEDRIVE_CLIENT_SECRET" },
	pcloud: { CLIENT_ID: "PLACEHOLDER_PCLOUD_CLIENT_ID", CLIENT_SECRET: "PLACEHOLDER_PCLOUD_CLIENT_SECRET" },
	yandex: { CLIENT_ID: "PLACEHOLDER_YANDEX_CLIENT_ID", CLIENT_SECRET: "PLACEHOLDER_YANDEX_CLIENT_SECRET" },
};

// Every connector with OAuth app credentials is listed above.
test("every config.js with CLIENT_ID or CLIENT_SECRET is checked", () => {
	for (const name of fs.readdirSync(CLOUD)) {
		const dir = path.join(CLOUD, name, "service");
		if (!fs.existsSync(dir)) continue;
		const src = configOf(name);
		if (/\bCLIENT_(ID|SECRET)\s*:/.test(src)) assert.ok(FROM_BUILD[name], `${name} is not in FROM_BUILD`);
	}
});

function configOf(name) {
	const dir = path.join(CLOUD, name, "service");
	const svc = fs.readdirSync(dir).find((d) => fs.existsSync(path.join(dir, d, "config.js")));
	return svc ? fs.readFileSync(path.join(dir, svc, "config.js"), "utf8") : "";
}

for (const [name, keys] of Object.entries(FROM_BUILD)) {
	test(`${name}: the credentials the build fills in are placeholders`, () => {
		const src = configOf(name);
		for (const [key, placeholder] of Object.entries(keys)) {
			const m = new RegExp(`\\b${key}\\s*:\\s*"([^"]*)"`).exec(src);
			assert.ok(m, `${name}: no ${key} in config.js`);
			assert.strictEqual(m[1], placeholder, `${name}: ${key} must stay "${placeholder}"`);
		}
	});
}
