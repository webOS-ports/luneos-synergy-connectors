// node --test tests/unit
// The LS2 files of each cloud connector (cloud/<name>/files/sysbus/) against its
// account template: who may call the service follows what the template does.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CLOUD = path.join(__dirname, "../../cloud");

function connectors() {
	return fs.readdirSync(CLOUD).filter((n) => n !== "_core" && fs.existsSync(path.join(CLOUD, n, "service")));
}

function template(name) {
	const found = [];
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory() && e.name !== "resources") walk(p);
			else if (/^com\.palm\..*\.json$/.test(e.name)) found.push(p);
		}
	};
	walk(path.join(CLOUD, name, "account"));
	assert.strictEqual(found.length, 1, `${name}: one template`);
	return JSON.parse(fs.readFileSync(found[0], "utf8"));
}

for (const name of connectors()) {
	test(`${name}: bus files match the service and its template`, () => {
		const service = fs.readdirSync(path.join(CLOUD, name, "service")).find((d) => d.startsWith("com.palm.service."));
		const dir = path.join(CLOUD, name, "files", "sysbus");
		const read = (ext) => fs.readFileSync(path.join(dir, service + ext), "utf8");
		const json = (ext) => JSON.parse(read(ext));
		const t = template(name);
		const caps = t.capabilityProviders.map((c) => c.capability);

		assert.match(read(".service"), new RegExp(`^Name=${service.replace(/\./g, "\\.")}$`, "m"));
		assert.match(read(".service"), new RegExp(`^Exec=/usr/bin/run-js-service -n /usr/palm/services/${service.replace(/\./g, "\\.")}$`, "m"));
		assert.deepStrictEqual(json(".role.json").allowedNames, [service]);

		const api = json(".api.json");
		const [group] = Object.keys(api);
		assert.deepStrictEqual(api[group], [`${service}/*`]);
		assert.deepStrictEqual(json(".groups.json"), { allowedNames: [service], [group]: ["dev"] });

		const perm = json(".perm.json");
		const callers = Object.keys(perm).filter((k) => k !== service).sort();
		for (const c of callers) assert.deepStrictEqual(perm[c], [group], `${c} gets the group`);

		// The Accounts service runs the template's hooks; its sign-in app calls the service
		// The sign-in app runs as an iframe inside the Accounts app, so its calls arrive as
		// com.palm.app.accounts-<pid> (LS_REQUIRES_SECURITY on getAuthorizeUrl otherwise).
		const expected = ["com.palm.service.accounts", "com.palm.app.accounts", "com.palm.app.accounts-*",
			t.validator.customUI.appId, t.validator.customUI.appId + "-*"];
		// Documents opens files from it; Topaz Explorer's service browses and manages them.
		if (caps.includes("DOCUMENTS")) {
			expected.push("org.webosports.app.documents", "org.webosports.app.documents-*", "com.palm.stark.files.service");
		}
		if (caps.includes("PHOTO.UPLOAD")) {
			// The Photos app browses it; com.palm.service.photos syncs it (listAlbums, listPhotos,
			// upload, deletePhoto) for the PHOTO.UPLOAD hooks the template points at it
			expected.push("org.webosports.app.photos", "org.webosports.app.photos-*", "com.palm.service.photos");
		}
		assert.deepStrictEqual(callers, expected.sort());

		// The file commands' own allow-list (Acl.enforce) lets in the same file clients.
		if (caps.includes("DOCUMENTS")) {
			const cfg = fs.readFileSync(path.join(CLOUD, name, "service", service, "config.js"), "utf8");
			const ids = JSON.parse(/FILE_APP_IDS:\s*(\[[^\]]*\])/.exec(cfg)[1]);
			const files = expected.filter((c) => c.startsWith("org.webosports.app.documents") || c === "com.palm.stark.files.service");
			assert.deepStrictEqual(ids.slice().sort(), files.sort(), `${name}: FILE_APP_IDS`);
		}
	});
}
