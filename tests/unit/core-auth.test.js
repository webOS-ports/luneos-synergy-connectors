// node --test tests/unit
// _cloudcore/node/oauth.js (authorize URL, code exchange, refresh, from Config) and creds.js
// (credentials by accountId or inline, saving them back, and the 401 -> refresh -> retry session).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const crypto = require("node:crypto");
const { fakeFetch } = require("./lib/fakes.js");

const NODE = path.join(__dirname, "../../cloud/_core/service/_cloudcore/node");
const { createOAuth, hasSecret } = require(path.join(NODE, "oauth.js"));
const { createHttp, HttpError } = require(path.join(NODE, "http.js"));
const { createAccountStore, Session } = require(path.join(NODE, "creds.js"));
const { CloudError } = require(path.join(NODE, "errors.js"));

const CONFIG = {
	CLIENT_ID: "app key", CLIENT_SECRET: "PLACEHOLDER_X_CLIENT_SECRET", REDIRECT_URI: "http://localhost/x/cb",
	AUTHORIZE_URL: "https://auth.example.test/authorize", TOKEN_URL: "https://auth.example.test/token",
	SCOPE: "a.read b.write", AUTHORIZE_EXTRA: "&token_access_type=offline", STATE: "xstate",
};

function oauthWith(routes, config = CONFIG) {
	const f = fakeFetch(routes);
	const http = createHttp({ fetch: f.fetch, errorCode: "X_API_ERROR" });
	const bytes = Buffer.alloc(32, 7);
	return { oauth: createOAuth({ config, http, random: () => bytes }), requests: f.requests, bytes };
}
const form = (r) => Object.fromEntries(new URLSearchParams(r.body));
const TOKEN = (o) => ({ status: 200, body: Object.assign({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "bearer" }, o) });

test("authorizeUrl: the URL as oauth2.js built it, with an S256 challenge of the verifier it returns", () => {
	const { oauth, bytes } = oauthWith([]);
	const { url, codeVerifier } = oauth.authorizeUrl();
	assert.strictEqual(codeVerifier, bytes.toString("base64url"));
	const challenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
	assert.strictEqual(url, "https://auth.example.test/authorize?response_type=code&client_id=app%20key" +
		"&redirect_uri=http%3A%2F%2Flocalhost%2Fx%2Fcb&scope=a.read%20b.write&code_challenge=" + challenge +
		"&code_challenge_method=S256&token_access_type=offline&state=xstate");
	assert.match(oauth.authorizeUrl("other").url, /&state=other$/);
	assert.match(createOAuth({ config: Object.assign({}, CONFIG, { STATE: undefined }), http: {} }).authorizeUrl().url, /&state=cloud$/);
});

test("exchangeCode: the form, no secret while it is a placeholder, no scope unless TOKEN_SEND_SCOPE", async () => {
	const { oauth, requests } = oauthWith([["POST", /\/token$/, () => TOKEN()]]);
	const t = await oauth.exchangeCode("CODE", "VERIFIER");
	assert.deepStrictEqual(t, { accessToken: "AT", refreshToken: "RT", expiresIn: 3600, tokenType: "bearer" });
	assert.strictEqual(requests[0].url, CONFIG.TOKEN_URL);
	assert.strictEqual(requests[0].method, "POST");
	assert.deepStrictEqual(form(requests[0]), { client_id: "app key", grant_type: "authorization_code", code: "CODE",
		redirect_uri: CONFIG.REDIRECT_URI, code_verifier: "VERIFIER" });
});

test("exchangeCode: without a verifier, the one authorizeUrl made last", async () => {
	const { oauth, requests } = oauthWith([["POST", /\/token$/, () => TOKEN()]]);
	const { codeVerifier } = oauth.authorizeUrl();
	await oauth.exchangeCode("CODE");
	assert.strictEqual(form(requests[0]).code_verifier, codeVerifier);
});

test("a real secret is sent, and scope when TOKEN_SEND_SCOPE", async () => {
	const config = Object.assign({}, CONFIG, { CLIENT_SECRET: "s3cr3t-unit-test", TOKEN_SEND_SCOPE: true });
	const { oauth, requests } = oauthWith([["POST", /\/token$/, () => TOKEN()]], config);
	await oauth.refresh("RT0");
	assert.deepStrictEqual(form(requests[0]), { client_id: "app key", client_secret: "s3cr3t-unit-test", scope: "a.read b.write",
		grant_type: "refresh_token", refresh_token: "RT0" });
	assert.ok(!hasSecret({ CLIENT_SECRET: "" }) && !hasSecret({}) && !hasSecret({ CLIENT_SECRET: "PLACEHOLDER_BOX_CLIENT_SECRET" }));
});

test("the token endpoint failing is OAUTH_TOKEN_FAILED: an error status, a non-200, no access token, no JSON", async () => {
	for (const reply of [{ status: 400, body: { error: "invalid_grant", error_description: "refresh token is bad" } },
		{ status: 201, body: { access_token: "AT" } }, { status: 200, body: { token_type: "bearer" } }, { status: 200, body: "<html>" }]) {
		const { oauth } = oauthWith([["POST", /\/token$/, () => reply]]);
		await assert.rejects(oauth.refresh("RT"), (e) => {
			assert.strictEqual(e.errorCode, "OAUTH_TOKEN_FAILED", JSON.stringify(reply));
			assert.strictEqual(e.status, reply.status);
			assert.doesNotMatch(e.errorText, /refresh token is bad/, "only the OAuth error code goes into the text");
			return true;
		});
	}
	const { oauth } = oauthWith([["POST", /\/token$/, () => ({ status: 400, body: { error: "invalid_grant" } })]]);
	await assert.rejects(oauth.refresh("RT"), (e) => /invalid_grant/.test(e.errorText));
});

// --- creds -----------------------------------------------------------------------------------

function storeWith(reply) {
	const calls = [];
	const store = createAccountStore({ log: { error() {} }, call: async (uri, args) => {
		calls.push([uri, args]);
		if (reply instanceof Error) { throw reply; }
		return typeof reply === "function" ? reply(uri, args) : reply;
	} });
	return { store, calls };
}

test("resolve: inline credentials are used as they are, without a call", async () => {
	const { store, calls } = storeWith({});
	const c = { accessToken: "a", extra: 1 };
	assert.strictEqual(await store.resolve({ accountId: "acc", credentials: { common: c } }), c);
	assert.strictEqual(calls.length, 0);
});

test("resolve: by accountId, readCredentials name common; each reply shape", async () => {
	for (const reply of [{ returnValue: true, credentials: { accessToken: "a" } },
		{ returnValue: true, credentials: { common: { accessToken: "a" } } }, { returnValue: true, common: { accessToken: "a" } }]) {
		const { store, calls } = storeWith(reply);
		assert.strictEqual((await store.resolve({ accountId: "acc" })).accessToken, "a");
		assert.deepStrictEqual(calls, [["luna://com.palm.service.accounts/readCredentials", { accountId: "acc", name: "common" }]]);
	}
});

test("resolve: no way to credentials, none stored, Accounts refusing", async () => {
	await assert.rejects(storeWith({}).store.resolve({}), (e) => e.errorCode === "NO_CREDENTIALS");
	await assert.rejects(storeWith({}).store.resolve({ credentials: { common: {} } }), (e) => e.errorCode === "NO_CREDENTIALS");
	await assert.rejects(storeWith({ returnValue: true, credentials: {} }).store.resolve({ accountId: "a" }), (e) => e.errorCode === "NO_STORED_CREDENTIALS");
	await assert.rejects(storeWith(new CloudError(-1, "Denied method call")).store.resolve({ accountId: "a" }), (e) => e.errorCode === -1);
});

test("save: writeCredentials name common; a failure is logged, not thrown", async () => {
	const { store, calls } = storeWith({ returnValue: true });
	assert.strictEqual(await store.save("acc", { accessToken: "n" }), true);
	assert.deepStrictEqual(calls, [["luna://com.palm.service.accounts/writeCredentials", { accountId: "acc", name: "common", credentials: { accessToken: "n" } }]]);
	assert.strictEqual(await storeWith(new CloudError("X", "bus down")).store.save("acc", { accessToken: "n" }), false);
	assert.strictEqual(await store.save(null, { accessToken: "n" }), false);
});

const http401 = () => new HttpError("X_API_ERROR", "401", { status: 401, body: "" });

test("Session: a 401 refreshes once and retries with the new token; the next call uses it too", async () => {
	const tokens = [];
	const refreshed = [];
	const s = new Session({ accessToken: "old", refreshToken: "rt", mountId: "m1", expiresAt: 1 },
		{ refresh: async (rt) => { refreshed.push(rt); return { accessToken: "new", expiresIn: 60 }; } });
	const t0 = Date.now();
	const r = await s.authorized(async (tok) => { tokens.push(tok); if (tok === "old") { throw http401(); } return "ok"; });
	assert.strictEqual(r, "ok");
	assert.deepStrictEqual(tokens, ["old", "new"]);
	assert.deepStrictEqual(refreshed, ["rt"]);
	assert.strictEqual(s.renewed.accessToken, "new");
	assert.strictEqual(s.renewed.refreshToken, "rt", "a refresh token not rotated is kept");
	assert.strictEqual(s.renewed.mountId, "m1", "the rest of the credentials is kept");
	assert.ok(s.renewed.expiresAt >= t0 + 60000 && s.renewed.expiresAt <= Date.now() + 60000);
	await s.authorized(async (tok) => { tokens.push(tok); });
	assert.deepStrictEqual(tokens, ["old", "new", "new"]);
});

test("Session: a second 401 after the refresh is the error; there is no second refresh", async () => {
	let n = 0;
	const s = new Session({ accessToken: "old", refreshToken: "rt" }, { refresh: async () => { n++; return { accessToken: "new", refreshToken: "rt2" }; } });
	await assert.rejects(s.authorized(async () => { throw http401(); }), (e) => e.status === 401);
	assert.strictEqual(n, 1);
	assert.strictEqual(s.renewed.refreshToken, "rt2");
});

test("Session: no refresh token, no refresh function, or another error: thrown as it is", async () => {
	let n = 0;
	const refresh = async () => { n++; return { accessToken: "x" }; };
	await assert.rejects(new Session({ accessToken: "a" }, { refresh }).authorized(async () => { throw http401(); }), (e) => e.status === 401);
	await assert.rejects(new Session({ accessToken: "a", refreshToken: "r" }).authorized(async () => { throw http401(); }), (e) => e.status === 401);
	const e500 = new HttpError("X_API_ERROR", "500", { status: 500 });
	await assert.rejects(new Session({ accessToken: "a", refreshToken: "r" }, { refresh }).authorized(async () => { throw e500; }), (e) => e === e500);
	assert.strictEqual(n, 0);
});

test("Session: a refresh that fails is the error, and nothing is renewed", async () => {
	const s = new Session({ accessToken: "a", refreshToken: "r" }, { refresh: async () => { throw new CloudError("OAUTH_TOKEN_FAILED", "no"); } });
	let calls = 0;
	await assert.rejects(s.authorized(async () => { calls++; throw http401(); }), (e) => e.errorCode === "OAUTH_TOKEN_FAILED");
	assert.strictEqual(calls, 1);
	assert.strictEqual(s.renewed, null);
});
