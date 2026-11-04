/* ssdp.js - finding UPnP devices on the local network (SSDP M-SEARCH).
 *
 *   const ssdp = createSsdp();
 *   await ssdp.search("urn:schemas-upnp-org:service:ContentDirectory:1", 2500)
 *     -> [{ location, usn, st, server }]  one per device (by USN), in the order they answered
 *
 * One UDP socket per search, sent to 239.255.255.250:1900 twice (a lost datagram is common on
 * Wi-Fi) and closed after waitMs. The socket is bound to REPLY_PORT: the replies come unicast from
 * each server's own address, which conntrack does not take for replies to a multicast send, so
 * LuneOS's firewall (INPUT DROP) lets them in by that port (from private addresses only,
 * meta-luneos iptables.rules). When the port is taken, any port: then only an open firewall works. Only replies whose LOCATION is an http URL on a private, link-local
 * or loopback address are kept: a description is fetched from there next, and the search must not
 * become a way to make the phone fetch from the internet.
 */
"use strict";

const dgram = require("node:dgram");
const net = require("node:net");

const GROUP = "239.255.255.250";
const PORT = 1900;
const REPLY_PORT = 41900;

function isLocalAddress(host) {
	const h = String(host).replace(/^\[|\]$/g, "");
	if (net.isIPv4(h)) {
		const [a, b] = h.split(".").map(Number);
		return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	if (net.isIPv6(h)) {
		const l = h.toLowerCase();
		return l === "::1" || l.startsWith("fe80:") || l.startsWith("fc") || l.startsWith("fd");
	}
	return false;
}

// A LOCATION we may fetch: http(s) on a local address.
function localLocation(s) {
	let u;
	try { u = new URL(String(s).trim()); } catch (e) { return null; }
	if (u.protocol !== "http:" && u.protocol !== "https:") { return null; }
	if (u.username || u.password || !isLocalAddress(u.hostname)) { return null; }
	return u.href;
}

function parseResponse(text) {
	const lines = String(text).split(/\r?\n/);
	if (!/^HTTP\/1\.[01] 200/i.test(lines[0] || "")) { return null; }
	const h = {};
	for (const line of lines.slice(1)) {
		const i = line.indexOf(":");
		if (i > 0) { h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
	}
	const location = localLocation(h.location);
	if (!location) { return null; }
	return { location, usn: h.usn || location, st: h.st || "", server: h.server || "" };
}

function createSsdp({ createSocket = (o) => dgram.createSocket(o), log = console, replyPort = REPLY_PORT } = {}) {
	function search(st, waitMs = 2500) {
		return new Promise((resolve) => {
			const found = new Map();
			const msg = Buffer.from("M-SEARCH * HTTP/1.1\r\nHOST: " + GROUP + ":" + PORT + "\r\nMAN: \"ssdp:discover\"\r\n" +
				"MX: 2\r\nST: " + st + "\r\nUSER-AGENT: LuneOS/1.0 UPnP/1.1 Videos/1.0\r\n\r\n");
			let sock = null;
			let done = false;
			const finish = () => {
				if (done) { return; }
				done = true;
				try { if (sock) { sock.close(); } } catch (e) { /* closed already */ }
				resolve(Array.from(found.values()));
			};
			const started = () => {
				try { sock.setMulticastTTL(2); } catch (e) { /* not every socket has it */ }
				const send = () => { if (!done) { sock.send(msg, 0, msg.length, PORT, GROUP, () => {}); } };
				send();
				setTimeout(send, 300);
				setTimeout(finish, waitMs);
			};
			// On the reply port; when that is taken, on any port.
			const open = (port) => {
				try { sock = createSocket({ type: "udp4", reuseAddr: false }); }
				catch (e) { log.error("ssdp: no socket: " + ((e && e.message) || e)); finish(); return; }
				const s = sock;
				let bound = false;
				s.on("error", (e) => {
					if (!bound && port !== 0) {
						log.error("ssdp: port " + port + " is taken, searching from any port");
						try { s.close(); } catch (e2) { /* closed already */ }
						open(0);
						return;
					}
					log.error("ssdp: " + ((e && e.message) || e));
					finish();
				});
				s.on("message", (buf) => {
					const r = parseResponse(buf.toString("utf8"));
					if (r && !found.has(r.usn.split("::")[0])) { found.set(r.usn.split("::")[0], r); }
				});
				s.bind(port, () => { bound = true; started(); });
			};
			open(replyPort);
		});
	}
	return { search };
}

module.exports = { createSsdp, parseResponse, localLocation, isLocalAddress, REPLY_PORT };
