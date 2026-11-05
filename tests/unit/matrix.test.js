// node --test tests/unit
// The Matrix sign-in (im/matrix/apps/com.palm.app.matrix/source/matrixAuth.js) against a stand-in
// homeserver: discovery, client registration, the PKCE authorization request, the code exchange,
// and the "mxoauth:" session it hands the prpl, whose fields matrix_seed.go in purple-combined
// reads.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../..");
const APP = path.join(ROOT, "im/matrix/apps/com.palm.app.matrix");
const A = require(path.join(APP, "source/matrixAuth.js"));

const HS = "https://matrix-client.example.org";
const ISSUER = "https://account.example.org/";
const META = {
	issuer: ISSUER,
	authorization_endpoint: ISSUER + "authorize",
	token_endpoint: ISSUER + "oauth2/token",
	registration_endpoint: ISSUER + "oauth2/registration",
};

// A homeserver behind fetch. routes: "METHOD url" -> (req) => [status, body]
function server(routes) {
	const calls = [];
	global.fetch = async (url, opts = {}) => {
		const method = opts.method || "GET";
		const req = { url, method, headers: opts.headers || {}, body: opts.body };
		calls.push(req);
		const h = routes[method + " " + url];
		const [status, body] = h ? h(req) : [404, { errcode: "M_UNRECOGNIZED" }];
		const text = body === undefined ? "" : JSON.stringify(body);
		return { ok: status >= 200 && status < 300, status, text: async () => text };
	};
	return calls;
}

function oauthServer(extra = {}) {
	return server(Object.assign({
		"GET https://example.org/.well-known/matrix/client": () => [200, { "m.homeserver": { base_url: HS + "/" } }],
		["GET " + HS + "/_matrix/client/v1/auth_metadata"]: () => [200, META],
		["POST " + META.registration_endpoint]: () => [201, { client_id: "01CLIENT" }],
	}, extra));
}

function seedOf(stored) {
	assert.ok(stored.startsWith("mxoauth:"), stored);
	const b64 = stored.slice("mxoauth:".length);
	assert.ok(/^[A-Za-z0-9_-]+$/.test(b64), "base64url without padding: " + b64);
	return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
}

test("a Matrix ID needs a real server name", () => {
	for (const ok of ["@alice:matrix.org", "@bob:example.com:8448", "@c:localhost:8008", "@d:[::1]:8448", "@e.f_g=h:sub.example.org"]) {
		assert.ok(A.isMatrixId(ok), ok);
	}
	// "@herrie:matrix" was typed for matrix.org once and got through.
	for (const bad of ["@herrie:matrix", "alice:matrix.org", "@alice", "@:matrix.org", "@a b:matrix.org", "@a:matrix.org:port", "@a:matrix..org", ""]) {
		assert.ok(!A.isMatrixId(bad), bad);
	}
});

test("the server name is everything after the first colon", () => {
	assert.strictEqual(A.serverOf("@alice:example.org:8448"), "example.org:8448");
	assert.strictEqual(A.serverOf("@alice"), "");
});

test("prepare discovers the server, registers, and asks for a PKCE code for a new device", async () => {
	const calls = oauthServer();
	const p = await A.prepare("@alice:example.org");
	assert.strictEqual(p.oauth, true);
	assert.strictEqual(p.homeserver, HS, "trailing slash dropped");
	assert.strictEqual(p.clientId, "01CLIENT");
	assert.ok(/^[A-Z]{10}$/.test(p.deviceId), p.deviceId);

	const reg = JSON.parse(calls.find((c) => c.url === META.registration_endpoint).body);
	assert.strictEqual(reg.application_type, "native");
	assert.deepStrictEqual(reg.redirect_uris, ["http://localhost/matrix-signin"]);
	assert.strictEqual(reg.token_endpoint_auth_method, "none");
	assert.ok(reg.grant_types.includes("authorization_code") && reg.grant_types.includes("refresh_token"));
	assert.strictEqual(reg.client_uri, "https://github.com/webOS-ports/luneos-synergy-connectors");

	const u = new URL(p.url);
	assert.strictEqual(u.origin + u.pathname, META.authorization_endpoint);
	const q = u.searchParams;
	assert.strictEqual(q.get("response_type"), "code");
	assert.strictEqual(q.get("client_id"), "01CLIENT");
	assert.strictEqual(q.get("redirect_uri"), A.REDIRECT);
	assert.strictEqual(q.get("scope"), "urn:matrix:client:api:* urn:matrix:client:device:" + p.deviceId);
	assert.strictEqual(q.get("state"), p.state);
	assert.strictEqual(q.get("login_hint"), "mxid:@alice:example.org");
	assert.strictEqual(q.get("code_challenge_method"), "S256");
	const want = crypto.createHash("sha256").update(p.verifier).digest("base64url");
	assert.strictEqual(q.get("code_challenge"), want);
	assert.ok(p.verifier.length >= 43, "RFC 7636 minimum verifier length");
});

test("without .well-known the server name is the homeserver", async () => {
	server({
		"GET https://example.org/_matrix/client/v1/auth_metadata": () => [200, META],
		["POST " + META.registration_endpoint]: () => [201, { client_id: "C" }],
	});
	const p = await A.prepare("@alice:example.org");
	assert.strictEqual(p.homeserver, "https://example.org");
	assert.strictEqual(p.oauth, true);
});

test("the unstable metadata path is tried when the stable one is missing", async () => {
	oauthServer({
		["GET " + HS + "/_matrix/client/v1/auth_metadata"]: () => [404, {}],
		["GET " + HS + "/_matrix/client/unstable/org.matrix.msc2965/auth_metadata"]: () => [200, META],
	});
	assert.strictEqual((await A.prepare("@alice:example.org")).oauth, true);
});

test("a server without OAuth is reported as such, and its password login is detected", async () => {
	oauthServer({
		["GET " + HS + "/_matrix/client/v1/auth_metadata"]: () => [404, {}],
		["GET " + HS + "/_matrix/client/v3/login"]: () => [200, { flows: [{ type: "m.login.token" }, { type: "m.login.password" }] }],
	});
	const p = await A.prepare("@alice:example.org");
	assert.deepStrictEqual(p, { homeserver: HS, oauth: false });
	assert.strictEqual(await A.hasPasswordLogin(HS), true);
});

async function prepared(extra) {
	const calls = oauthServer(extra);
	const p = await A.prepare("@alice:example.org");
	return { calls, p };
}

test("finish exchanges the code and hands the prpl a complete session", async () => {
	const before = Date.now();
	const { calls, p } = await prepared({
		["POST " + META.token_endpoint]: () => [200, { access_token: "mat_x", refresh_token: "mar_y", expires_in: 300, token_type: "Bearer" }],
		["GET " + HS + "/_matrix/client/v3/account/whoami"]: (req) =>
			req.headers.Authorization === "Bearer mat_x" ? [200, { user_id: "@alice:example.org", device_id: p.deviceId }] : [401, {}],
	});
	const stored = await A.finish(p, A.REDIRECT + "?state=" + p.state + "&code=CODE1", "@alice:example.org", "EsTc recovery");

	const form = new URLSearchParams(calls.find((c) => c.url === META.token_endpoint).body);
	assert.strictEqual(form.get("grant_type"), "authorization_code");
	assert.strictEqual(form.get("code"), "CODE1");
	assert.strictEqual(form.get("code_verifier"), p.verifier);
	assert.strictEqual(form.get("redirect_uri"), A.REDIRECT);
	assert.strictEqual(form.get("client_id"), "01CLIENT");

	const s = seedOf(stored);
	// The keys matrix_seed.go's mxSeed reads.
	assert.deepStrictEqual(Object.keys(s).sort(), ["access_token", "client_id", "device_id", "expires_at_ms", "homeserver",
		"issuer", "recovery_key", "refresh_token", "user_id", "v"]);
	assert.strictEqual(s.v, 1);
	assert.strictEqual(s.homeserver, HS);
	assert.strictEqual(s.issuer, ISSUER);
	assert.strictEqual(s.user_id, "@alice:example.org");
	assert.strictEqual(s.device_id, p.deviceId);
	assert.strictEqual(s.recovery_key, "EsTc recovery");
	assert.ok(s.expires_at_ms >= before + 300000 && s.expires_at_ms <= Date.now() + 300000);
});

test("finish refuses a redirect from another sign-in, a cancelled one, and one without a code", async () => {
	const { p } = await prepared();
	await assert.rejects(A.finish(p, A.REDIRECT + "?state=other&code=C", "@alice:example.org"), /did not belong/);
	await assert.rejects(A.finish(p, A.REDIRECT + "?state=" + p.state + "&error=access_denied", "@alice:example.org"), /cancelled/);
	await assert.rejects(A.finish(p, A.REDIRECT + "?state=" + p.state, "@alice:example.org"), /no|not return/i);
});

test("finish refuses tokens for another user", async () => {
	const { p } = await prepared({
		["POST " + META.token_endpoint]: () => [200, { access_token: "t" }],
		["GET " + HS + "/_matrix/client/v3/account/whoami"]: () => [200, { user_id: "@mallory:example.org", device_id: "X" }],
	});
	await assert.rejects(A.finish(p, A.REDIRECT + "?state=" + p.state + "&code=C", "@alice:example.org"), /@mallory:example.org/);
});

test("a password is checked here and becomes a session, not a stored password", async () => {
	let sent = null;
	server({
		"GET https://example.org/.well-known/matrix/client": () => [200, { "m.homeserver": { base_url: HS } }],
		["POST " + HS + "/_matrix/client/v3/login"]: (req) => {
			sent = JSON.parse(req.body);
			return sent.password === "right" ? [200, { user_id: "@alice:example.org", access_token: "syt_x", device_id: sent.device_id }]
				: [403, { errcode: "M_FORBIDDEN", error: "Invalid username or password" }];
		},
	});
	const s = seedOf(await A.passwordLogin("@alice:example.org", "right", ""));
	assert.deepStrictEqual(sent.identifier, { type: "m.id.user", user: "@alice:example.org" });
	assert.ok(/^[A-Z]{10}$/.test(sent.device_id));
	assert.deepStrictEqual(s, { v: 1, homeserver: HS, user_id: "@alice:example.org", device_id: sent.device_id, access_token: "syt_x" });
	assert.ok(!JSON.stringify(s).includes("right"), "the password is not kept");
	await assert.rejects(A.passwordLogin("@alice:example.org", "wrong", ""), /Wrong Matrix ID or password/);
});

test("the validator loads the sign-in module and OAuthWindow before itself", () => {
	const deps = fs.readFileSync(path.join(APP, "depends.js"), "utf8");
	const at = (f) => deps.indexOf(f);
	assert.ok(at("source/oauthWindow.js") > 0 && at("source/matrixAuth.js") > at("source/oauthWindow.js") &&
		at("source/validator.js") > at("source/matrixAuth.js"), deps);
});

test("the code route keeps the sentinel the prpl knows (mxBrowserSignIn)", () => {
	const v = fs.readFileSync(path.join(APP, "source/validator.js"), "utf8");
	assert.ok(v.includes('var BROWSER_SIGN_IN = "browser-sign-in";'));
});

test("the harness knows the connector", () => {
	const c = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/connectors.json"), "utf8")).connectors["com.palm.matrix"];
	assert.deepStrictEqual([c.family, c.plugin, c.service_name, c.package], ["im", "libwhatsmeow.so", "type_matrix", "purple-combined"]);
});
