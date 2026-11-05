// IRC sign-in: what the form's fields become, with no Enyo in it, so tests/unit/irc.test.js can
// hold it to what imlibpurpleservice expects.
//
// The account is libpurple's own prpl-irc. Its username is "nick@server" (the plug-in's one user
// split), and the rest are its protocol options, which imlibpurpleservice copies from the
// account's config onto the libpurple account at every sign-in (Util::applyProtocolOptions):
//
//   port       int    the server's port
//   ssl        bool   TLS
//   sasl       bool   log in to the network's account service (NickServ) with SASL PLAIN
//   saslname   string the account name SASL logs in as, when it is not the nick
//   realname   string shown in /whois
//   username   string the ident; left to the plug-in (the nick) when empty
//
// "channels" is not a plug-in option: imlibpurpleservice takes it as the channels to join the
// first time the account signs in (Irc::seedChannels), and from then on goes by what was joined
// and left in Messaging.
//
// The credential is the server password, or with SASL the account's password. The Accounts
// service cannot hold an empty one and imlibpurpleservice will not sign in without one, so "no
// password" is stored as NO_PASSWORD, which imlibpurpleservice knows (Irc::NO_PASSWORD).

var IrcForm = (function () {
	"use strict";

	var NO_PASSWORD = "irc-no-password";
	var TLS_PORT = 6697;
	var PLAIN_PORT = 6667;

	function trim(v) {
		return String(v === undefined || v === null ? "" : v).replace(/^\s+|\s+$/g, "");
	}

	// RFC 2812 nick: a letter or one of []\`_^{|} first, then those, digits and "-". Networks
	// allow different lengths; 30 is Libera.Chat's and more than most.
	function isNick(nick) {
		return /^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}\-]{0,29}$/.test(nick);
	}

	// A host name or an IP address, no scheme, no port, no spaces.
	function isServer(server) {
		if (!server || server.length > 253) {
			return false;
		}
		if (/^\[[0-9A-Fa-f:.]+\]$/.test(server)) {
			return true;   // [IPv6]
		}
		return /^[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?)*$/.test(server);
	}

	function parsePort(text, tls) {
		var t = trim(text);
		if (t === "") {
			return tls ? TLS_PORT : PLAIN_PORT;
		}
		if (!/^[0-9]{1,5}$/.test(t)) {
			return null;
		}
		var n = parseInt(t, 10);
		return (n >= 1 && n <= 65535) ? n : null;
	}

	// imlibpurpleservice counts a channel's length in bytes, and wants UTF-8.
	function utf8Length(s) {
		var n = 0;
		for (var i = 0; i < s.length; i++) {
			var c = s.charCodeAt(i);
			if (c < 0x80) {
				n += 1;
			} else if (c < 0x800) {
				n += 2;
			} else if (c >= 0xD800 && c <= 0xDBFF) {
				var d = s.charCodeAt(i + 1);
				if (!(d >= 0xDC00 && d <= 0xDFFF)) {
					return Infinity;   // a lone surrogate is not UTF-8
				}
				n += 4;
				i++;
			} else if (c >= 0xDC00 && c <= 0xDFFF) {
				return Infinity;
			} else {
				n += 3;
			}
		}
		return n;
	}

	// Channels as imlibpurpleservice reads them (Irc::parseChannelList): commas, spaces or new lines
	// between them, "#" added where there is no prefix. Returned in the same shape, so the person
	// sees what will be joined.
	function parseChannels(text) {
		var out = [], seen = {};
		var parts = String(text || "").split(/[,\s]+/);
		for (var i = 0; i < parts.length; i++) {
			var c = parts[i];
			if (!c) {
				continue;
			}
			if ("#&+!".indexOf(c.charAt(0)) === -1) {
				c = "#" + c;
			}
			if (c.length < 2 || utf8Length(c) > 200 || /[:\x07\x00]/.test(c)) {
				continue;
			}
			var key = c.toLowerCase();
			if (!seen[key]) {
				seen[key] = true;
				out.push(c);
			}
		}
		return out;
	}

	// "nick@server" back into its parts, for editing an account that exists.
	function splitUsername(username) {
		var u = String(username || "");
		var at = u.lastIndexOf("@");
		if (at <= 0 || at === u.length - 1) {
			return { nick: u, server: "" };
		}
		return { nick: u.slice(0, at), server: u.slice(at + 1) };
	}

	// fields: { server, port, tls, nick, password, sasl, saslName, realName, channels }
	// -> { ok: true, username, password, config } or { ok: false, field, error }
	function build(fields) {
		var f = fields || {};
		var server = trim(f.server).toLowerCase();
		var nick = trim(f.nick);
		var tls = f.tls !== false;
		var password = String(f.password || "");
		var hasPassword = password.length > 0;

		if (!isServer(server)) {
			return { ok: false, field: "server", error: "Enter the server's host name, such as irc.libera.chat." };
		}
		if (!isNick(nick)) {
			return { ok: false, field: "nick", error: "A nick is a letter or one of []\\`_^{|} followed by letters, digits or those, up to 30." };
		}
		var port = parsePort(f.port, tls);
		if (port === null) {
			return { ok: false, field: "port", error: "The port is a number from 1 to 65535." };
		}
		var sasl = hasPassword && f.sasl !== false;
		if (sasl && !tls) {
			return { ok: false, field: "tls", error: "SASL sends the password as it is; turn on TLS, or turn off SASL to send it as a server password." };
		}

		var config = {
			port: port,
			ssl: tls,
			sasl: sasl,
			saslname: sasl ? trim(f.saslName) : "",
			realname: trim(f.realName),
			channels: parseChannels(f.channels).join(",")
		};
		return {
			ok: true,
			username: nick + "@" + server,
			password: hasPassword ? password : NO_PASSWORD,
			config: config
		};
	}

	return {
		NO_PASSWORD: NO_PASSWORD,
		TLS_PORT: TLS_PORT,
		PLAIN_PORT: PLAIN_PORT,
		isNick: isNick,
		isServer: isServer,
		parsePort: parsePort,
		parseChannels: parseChannels,
		splitUsername: splitUsername,
		build: build
	};
})();

if (typeof module !== "undefined" && module.exports) {
	module.exports = IrcForm;
}
