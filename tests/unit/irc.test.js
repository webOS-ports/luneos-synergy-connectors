// node --test tests/unit
// The IRC sign-in's form rules (im/irc/apps/com.palm.app.irc/source/ircForm.js), held to what
// imlibpurpleservice reads: a "nick@server" username, prpl-irc's protocol options in config, a
// non-empty credential, and the channel list the way Irc::parseChannelList reads it.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../..");
const APP = path.join(ROOT, "im/irc/apps/com.palm.app.irc");
const F = require(path.join(APP, "source/ircForm.js"));

test("a nick and a server are all it takes", () => {
	const r = F.build({ server: " irc.Libera.Chat ", nick: "Herrie" });
	assert.strictEqual(r.ok, true);
	assert.strictEqual(r.username, "Herrie@irc.libera.chat");
	assert.strictEqual(r.password, F.NO_PASSWORD);
	assert.deepStrictEqual(r.config, { port: 6697, ssl: true, sasl: false, saslname: "", realname: "", channels: "" });
});

test("no password is the sentinel imlibpurpleservice knows (Irc::NO_PASSWORD)", () => {
	assert.strictEqual(F.NO_PASSWORD, "irc-no-password");
});

test("the harness knows the connector", () => {
	const c = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/connectors.json"), "utf8")).connectors["com.palm.irc"];
	assert.deepStrictEqual([c.family, c.plugin, c.service_name], ["im", "libirc.so", "type_irc"]);
});

test("without TLS the port defaults to 6667", () => {
	assert.strictEqual(F.build({ server: "irc.example.org", nick: "a", tls: false }).config.port, 6667);
	assert.strictEqual(F.build({ server: "irc.example.org", nick: "a", tls: false }).config.ssl, false);
});

test("a typed port is used, a bad one refused", () => {
	assert.strictEqual(F.build({ server: "znc.home", nick: "a", port: " 7000 " }).config.port, 7000);
	for (const p of ["0", "65536", "70000", "12a", "-1", "6697.5", "123456"]) {
		const r = F.build({ server: "znc.home", nick: "a", port: p });
		assert.deepStrictEqual([r.ok, r.field], [false, "port"], p);
	}
	assert.strictEqual(F.parsePort("65535", true), 65535);
	assert.strictEqual(F.parsePort("1", true), 1);
});

test("nicks follow RFC 2812", () => {
	for (const n of ["a", "Herrie", "[away]", "x_y-z", "^caret^", "{b}|`", "a".repeat(30)]) {
		assert.ok(F.isNick(n), n);
	}
	for (const n of ["", "1abc", "-dash", "has space", "at@sign", "#chan", "a".repeat(31), "nick!", "ni:ck"]) {
		assert.ok(!F.isNick(n), n);
	}
	assert.strictEqual(F.build({ server: "irc.example.org", nick: "9lives" }).field, "nick");
});

test("servers are host names or addresses, nothing more", () => {
	for (const s of ["irc.libera.chat", "localhost", "127.0.0.1", "[2001:db8::1]", "irc-1.example.org"]) {
		assert.ok(F.isServer(s), s);
	}
	for (const s of ["", "irc://irc.libera.chat", "irc.libera.chat:6697", "a b", "-bad.org", "bad-.org", "x..y",
		"nick@irc.libera.chat", "a".repeat(254)]) {
		assert.ok(!F.isServer(s), s);
	}
	assert.strictEqual(F.build({ server: "irc.example.org:6697", nick: "a" }).field, "server");
});

test("a password goes out with SASL by default", () => {
	const r = F.build({ server: "irc.libera.chat", nick: "herrie", password: "s3cret", saslName: " HerrieAcct " });
	assert.strictEqual(r.password, "s3cret");
	assert.strictEqual(r.config.sasl, true);
	assert.strictEqual(r.config.saslname, "HerrieAcct");
});

test("a password is kept as typed, spaces and all", () => {
	assert.strictEqual(F.build({ server: "znc.home", nick: "a", password: " pass word " }).password, " pass word ");
});

test("SASL off sends the password as the server password; no SASL name then", () => {
	const r = F.build({ server: "znc.home", nick: "a", password: "user/net:pw", sasl: false, saslName: "ignored" });
	assert.strictEqual(r.config.sasl, false);
	assert.strictEqual(r.config.saslname, "");
	assert.strictEqual(r.password, "user/net:pw");
});

test("SASL without TLS is refused, a server password without TLS is not", () => {
	const r = F.build({ server: "irc.example.org", nick: "a", password: "pw", tls: false });
	assert.deepStrictEqual([r.ok, r.field], [false, "tls"]);
	assert.strictEqual(F.build({ server: "irc.example.org", nick: "a", password: "pw", tls: false, sasl: false }).ok, true);
	// No password, no SASL: the toggle does not matter.
	assert.strictEqual(F.build({ server: "irc.example.org", nick: "a", tls: false, sasl: true }).config.sasl, false);
});

test("channels are read the way imlibpurpleservice reads them", () => {
	assert.deepStrictEqual(F.parseChannels("#webos, luneos\n&local +modeless  !ABCDEsafe,#WebOS,,"),
		["#webos", "#luneos", "&local", "+modeless", "!ABCDEsafe"]);
	assert.deepStrictEqual(F.parseChannels(""), []);
	assert.deepStrictEqual(F.parseChannels(undefined), []);
	assert.deepStrictEqual(F.parseChannels("#a:b #ok #" + "x".repeat(199) + " #" + "x".repeat(200)),
		["#ok", "#" + "x".repeat(199)]);
	// 200 bytes, not 200 characters: "é" is two.
	assert.deepStrictEqual(F.parseChannels("#" + "é".repeat(100) + " #" + "é".repeat(99)), ["#" + "é".repeat(99)]);
	assert.deepStrictEqual(F.parseChannels("#bad\ud800"), []);
	assert.strictEqual(F.build({ server: "irc.example.org", nick: "a", channels: "webos luneos" }).config.channels,
		"#webos,#luneos");
});

test("an account's username splits back into nick and server", () => {
	assert.deepStrictEqual(F.splitUsername("Herrie@irc.libera.chat"), { nick: "Herrie", server: "irc.libera.chat" });
	assert.deepStrictEqual(F.splitUsername("a@b@znc.home"), { nick: "a@b", server: "znc.home" });
	assert.deepStrictEqual(F.splitUsername("noserver"), { nick: "noserver", server: "" });
	assert.deepStrictEqual(F.splitUsername(""), { nick: "", server: "" });
	const r = F.build({ server: "irc.libera.chat", nick: "Herrie" });
	const back = F.splitUsername(r.username);
	assert.strictEqual(F.build(back).username, r.username);
});

test("the config keys are prpl-irc's protocol options, plus channels", () => {
	// Util::applyProtocolOptions sets a config key on the account only if prpl-irc registers it.
	const prplIrc = ["port", "encoding", "autodetect_utf8", "username", "realname", "ssl",
		"ratelimit-interval", "ratelimit-burst", "sasl", "saslname", "auth_plain_in_clear"];
	const r = F.build({ server: "irc.libera.chat", nick: "a", password: "p", realName: "R" });
	for (const k of Object.keys(r.config)) {
		assert.ok(k === "channels" || prplIrc.includes(k), k);
	}
	assert.strictEqual(typeof r.config.port, "number");
	assert.strictEqual(typeof r.config.ssl, "boolean");
	assert.strictEqual(typeof r.config.sasl, "boolean");
});

test("the template points at this app and declares onCreate, so the config reaches the service", () => {
	const t = JSON.parse(fs.readFileSync(path.join(ROOT, "im/irc/account/com.palm.irc/com.palm.irc.json"), "utf8"))[0];
	assert.strictEqual(t.templateId, "com.palm.irc");
	assert.strictEqual(t.validator.customUI.appId, "com.palm.app.irc");
	const im = t.capabilityProviders.find((c) => c.capability === "MESSAGING");
	assert.ok(im, "MESSAGING capability");
	assert.strictEqual(im.serviceName, "type_irc");
	assert.ok(im.onCreate, "onCreate");
	assert.ok(im.onEnabled, "onEnabled");
	const app = JSON.parse(fs.readFileSync(path.join(APP, "appinfo.json"), "utf8"));
	assert.strictEqual(app.id, "com.palm.app.irc");
	for (const f of ["images/header-icon.png", "validator.html", "depends.js", "source/validator.js"]) {
		assert.ok(fs.existsSync(path.join(APP, f)), f);
	}
	for (const icon of [t.icon.loc_32x32, t.icon.loc_48x48]) {
		assert.ok(fs.existsSync(path.join(ROOT, "im/irc/account/com.palm.irc", icon)), icon);
	}
	const deps = fs.readFileSync(path.join(APP, "depends.js"), "utf8");
	assert.ok(deps.indexOf("source/ircForm.js") < deps.indexOf("source/validator.js"), "ircForm.js loads first");
});
