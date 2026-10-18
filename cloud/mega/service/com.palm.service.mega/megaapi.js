/*global IMPORTS, Config, HttpCurl, MegaCrypto, console */
/* megaapi.js - the Mega "cs" command queue + login handshake + node-tree fetch.
 *
 * Every call POSTs a JSON array of commands to https://g.api.mega.co.nz/cs (through the modern
 * curl in HttpCurl), with a monotonic &id= and, once authenticated, &sid=<session>. The reply
 * is a JSON array of per-command results, OR a bare negative integer = a global API error
 * (e.g. -3 EAGAIN "try again", -15 ESID "session expired", -9 ENOENT, -16 blocked). Negative
 * ints inside the array are per-command errors. -3 is transparently retried with backoff.
 *
 * LOGIN (us0 -> us): us0 tells us the account version (v1 legacy AES key derivation, or v2
 * PBKDF2-SHA512 with a server salt). We derive the password AES key + login hash accordingly,
 * then `us` returns the master key (AES-wrapped by the password key), the RSA private key
 * (AES-wrapped by the master key) and the session-id challenge (RSA-encrypted). We unwrap the
 * master key, unwrap+parse the RSA key, RSA-decrypt the challenge -> the session id. See
 * [[mega-connector]] and megacrypto.js.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var MegaApi = (function () {
	var MC = MegaCrypto;
	var _seq = Math.floor((new Date()).getTime() / 1000) & 0x7fffffff;   // seed the id counter

	// Human-readable text for the Mega error codes we care to surface.
	var ERR = {
		"-2": "EARGS", "-3": "EAGAIN", "-8": "EEXPIRED", "-9": "ENOENT", "-11": "EACCESS",
		"-13": "ETOOMANY", "-14": "ERANGE", "-15": "ESID", "-16": "EBLOCKED", "-26": "EMFAREQUIRED"
	};
	function apiError(code, ctx) {
		return { returnValue: false, errorCode: "MEGA_" + (ERR[String(code)] || ("E" + code)),
			megaCode: code, detail: ctx };
	}

	// POST one JSON array of commands. Resolves to the parsed reply (array or negative int).
	// Retries -3 (EAGAIN) up to 4 times with linear backoff. `sidOverride` lets login pass the
	// not-yet-stored session id; otherwise the caller's creds.accessToken is the sid.
	function post(commands, sid, tries) {
		var f = new Future();
		var url = Config.API_BASE + "?id=" + (_seq++);
		if (sid) { url += "&sid=" + sid; }
		var body = JSON.stringify(commands);
		var call = HttpCurl.request({
			method: "POST", url: url, body: body,
			headers: { "Content-Type": "application/json" }
		});
		// Same shape as the OAuth connectors' _req (device-proven): f.now sequences on the curl
		// call, f.then inspects the reply. On -3 (EAGAIN) pipe a retry future into f.result.
		f.now(this, function () { return call; });
		f.then(this, function () {
			var r;
			try { r = call.result; } catch (e) { f.setException(e); return; }
			if (!r || r.status < 200 || r.status >= 300) {
				f.setException(apiError("HTTP_" + (r && r.status), r && r.responseText)); return;
			}
			var parsed;
			try { parsed = JSON.parse(r.responseText); }
			catch (e2) { f.setException(apiError("PARSE", r.responseText)); return; }
			// A bare negative number is a global error.
			if (typeof parsed === "number") {
				if (parsed === -3 && (tries || 0) < 4 && typeof setTimeout !== "undefined") {
					// EAGAIN - wait and retry (linear backoff); adopting the retry future's result.
					setTimeout(function () {
						f.result = post(commands, sid, (tries || 0) + 1);
					}, 500 * ((tries || 0) + 1));
					return;
				}
				f.setException(apiError(parsed, "global")); return;
			}
			f.result = parsed;
		});
		return f;
	}

	// Run a single command; resolve to its result object (throws on a per-command negative int).
	function cmd(command, sid) {
		var f = new Future();
		var p = post([command], sid);
		f.now(this, function () { return p; });
		f.then(this, function () {
			var arr;
			try { arr = p.result; } catch (e) { f.setException(e); return; }
			var res = (arr && arr.length) ? arr[0] : arr;
			if (typeof res === "number" && res < 0) { f.setException(apiError(res, command.a)); return; }
			f.result = res;
		});
		return f;
	}

	// Derive the password AES key + login hash for both account versions.
	function deriveLogin(email, password, us0) {
		var lowerEmail = String(email).toLowerCase();
		if (us0 && us0.v === 2 && us0.s) {
			// v2: PBKDF2-HMAC-SHA512(password, salt, 100000, 32). First 16 bytes = AES key, last
			// 16 = the login auth hash (uh).
			var pwBytes = [];
			for (var i = 0; i < password.length; i++) {
				// UTF-8 encode the password.
				var cp = password.charCodeAt(i);
				if (cp < 0x80) { pwBytes.push(cp); }
				else if (cp < 0x800) { pwBytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)); }
				else { pwBytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
			}
			var salt = MC.b64ToBytes(us0.s);
			var derived = MC.pbkdf2Sha512(pwBytes, salt, 100000, 32);
			return {
				pwKey: MC.bytesToA32(derived.slice(0, 16)),
				uh: MC.bytesToB64(derived.slice(16, 32)),
				email: lowerEmail
			};
		}
		// v1: AES prepare_key + stringhash.
		var pk = MC.prepareKey(password);
		return { pwKey: pk, uh: MC.stringHash(lowerEmail, pk), email: lowerEmail };
	}

	return {
		post: post,
		cmd: cmd,
		apiError: apiError,

		// login(email, password[, mfa]) -> Future<{ accessToken(sid), mk(b64 master key),
		// u(handle), email, name }>. This is the account validator's core.
		login: function (email, password, mfa) {
			var f = new Future();
			var us0f = cmd({ a: "us0", user: String(email).toLowerCase() });
			f.now(this, function () { return us0f; });
			f.then(this, function () {
				var us0;
				try { us0 = us0f.result || {}; } catch (e) { f.setException(e); return; }
				var d = deriveLogin(email, password, us0);
				var usReq = { a: "us", user: d.email, uh: d.uh };
				if (mfa) { usReq.mfa = mfa; }
				var usf = cmd(usReq);
				usf.then(this, function () {
					var us;
					try { us = usf.result; }
					catch (e2) {
						// Map the common auth failures to a friendly code.
						var mc = e2 && e2.megaCode;
						if (mc === -9 || mc === -2) {
							f.setException({ returnValue: false, errorCode: "MEGA_BAD_CREDENTIALS",
								detail: "wrong email or password" });
						} else if (mc === -26) {
							f.setException({ returnValue: false, errorCode: "MEGA_MFA_REQUIRED",
								detail: "two-factor code required" });
						} else { f.setException(e2); }
						return;
					}
					try {
						if (!us || !us.k || !us.privk || !us.csid) {
							f.setException({ returnValue: false, errorCode: "MEGA_LOGIN_INCOMPLETE",
								detail: us }); return;
						}
						var master = MC.ecbDecryptA32(d.pwKey, MC.b64ToA32(us.k));
						var privkA32 = MC.ecbDecryptA32(master, MC.b64ToA32(us.privk));
						var priv = MC.parsePrivKey(privkA32);
						var sid = MC.rsaDecryptSid(us.csid, priv);
						f.result = {
							accessToken: sid,
							mk: MC.a32ToB64(master),
							email: d.email
						};
					} catch (e3) {
						f.setException({ returnValue: false, errorCode: "MEGA_CRYPTO_FAILED",
							detail: String(e3 && e3.message || e3) });
					}
				});
			});
			return f;
		},

		// getUser(creds) -> Future<ug result>. Validates the session (fails ESID if expired) and
		// yields the account handle/email.
		getUser: function (creds) {
			return cmd({ a: "ug" }, creds.accessToken);
		},

		// fetchNodes(creds) -> Future<{ nodes:[...], rootHandle, byHandle:{} }>. Pulls the whole
		// filesystem tree (`f`) and decrypts each node's key + attributes with the master key.
		// nodes carry: { h, p, t, name, size, ts, key(a32), aesKeyA32, nonce, metaMac }.
		fetchNodes: function (creds) {
			var f = new Future();
			var master = MC.b64ToA32(creds.mk);
			var ff = cmd({ a: "f", c: 1, r: 1 }, creds.accessToken);
			f.now(this, function () { return ff; });
			f.then(this, function () {
				var res;
				try { res = ff.result; } catch (e) { f.setException(e); return; }
				var raw = (res && res.f) || [];
				var out = [], byHandle = {}, root = null;
				for (var i = 0; i < raw.length; i++) {
					var n = raw[i], node = { h: n.h, p: n.p, t: n.t, size: n.s, ts: n.ts, name: null };
					if (n.t === 2) { root = n.h; }
					// Decrypt the node key: `k` = "handle:b64key [handle2:b64key2 ...]". Own nodes are
					// wrapped with the master key. Pick a pair whose key unwraps to a sane length.
					if (n.k) {
						var pairs = String(n.k).split("/");
						var enc = null;
						for (var pi = 0; pi < pairs.length; pi++) {
							var colon = pairs[pi].indexOf(":");
							if (colon >= 0) { enc = pairs[pi].substring(colon + 1); break; }
						}
						if (enc) {
							try {
								var rawKey = MC.ecbDecryptA32(master, MC.b64ToA32(enc));
								if (n.t === 0) {   // file: 8-word key -> condense
									var uk = MC.unpackFileKey(rawKey);
									node.key = rawKey;
									node.aesKeyA32 = uk.aesKeyA32;
									node.nonce = uk.nonce;
									node.metaMac = uk.metaMac;
									if (n.a) { var af = MC.decryptAttr(n.a, uk.aesKeyA32); node.name = af && af.n; }
								} else {           // folder: 4-word key
									node.key = rawKey;
									node.aesKeyA32 = rawKey.slice(0, 4);
									if (n.a) { var ad = MC.decryptAttr(n.a, rawKey.slice(0, 4)); node.name = ad && ad.n; }
								}
							} catch (ek) { node.name = null; }
						}
					}
					byHandle[n.h] = node;
					out.push(node);
				}
				f.result = { nodes: out, rootHandle: root, byHandle: byHandle };
			});
			return f;
		}
	};
})();

if (typeof exports !== "undefined") { exports.MegaApi = MegaApi; }
