/*global IMPORTS, require, exports, Buffer, console */
/* s3sig.js - AWS Signature Version 4 request signing for the generic S3 connector.
 *
 * S3-compatible services (AWS S3, IDrive e2, Backblaze B2's S3 API, MinIO, Wasabi, ...) have no
 * OAuth: every request is authenticated by signing it with the account's secret access key. This
 * implements SigV4 (HMAC-SHA256 chain + SHA-256 payload hash) two ways:
 *   - signRequest(): the Authorization-header form, used for list/get/put/delete via HttpCurl.
 *   - presignUrl():  the query-string form (X-Amz-Signature=...), used to hand the Photos
 *                    aggregator a self-authenticating GET URL its curl can fetch header-less.
 *
 * All hashing uses NATIVE node `crypto` (SHA-256 / HMAC-SHA256 exist on the device's OpenSSL-
 * 0.9.8k node, same as oauth2.js's S256 challenge), so signing is fast and dependency-free.
 * Validated against AWS's published SigV4 test vectors - see the repo test harness.
 */
var S3Sig = (function () {
	var _reqf = (typeof require !== "undefined") ? require
		: (typeof IMPORTS !== "undefined" && IMPORTS.require) || null;
	var _nc = _reqf ? _reqf("crypto") : null;

	function sha256Hex(strOrBuf) {
		var h = _nc.createHash("sha256");
		h.update(strOrBuf); return h.digest("hex");
	}
	function hmac(key, data, enc) {
		var h = _nc.createHmac("sha256", key);
		h.update(data, "utf8"); return enc ? h.digest(enc) : h.digest();
	}
	function toBuf(bytes) {
		if (typeof Buffer !== "undefined" && Buffer.from) { return Buffer.from(bytes); }
		return new Buffer(bytes);
	}

	// RFC 3986 encode. `encodeSlash=false` keeps "/" literal (used for the canonical path).
	function uriEncode(str, encodeSlash) {
		str = String(str);
		var out = "";
		for (var i = 0; i < str.length; i++) {
			var c = str.charAt(i), code = str.charCodeAt(i);
			if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") ||
				c === "-" || c === "_" || c === "." || c === "~") {
				out += c;
			} else if (c === "/" && !encodeSlash) {
				out += "/";
			} else {
				// UTF-8 percent-encode
				var bytes = unescape(encodeURIComponent(c));
				for (var b = 0; b < bytes.length; b++) {
					var hx = bytes.charCodeAt(b).toString(16).toUpperCase();
					out += "%" + (hx.length === 1 ? "0" : "") + hx;
				}
			}
		}
		return out;
	}

	// amzDate: YYYYMMDDTHHMMSSZ ; dateStamp: YYYYMMDD (both UTC).
	function amzDates(date) {
		function p(n) { return (n < 10 ? "0" : "") + n; }
		var Y = date.getUTCFullYear(), M = p(date.getUTCMonth() + 1), D = p(date.getUTCDate());
		var h = p(date.getUTCHours()), m = p(date.getUTCMinutes()), s = p(date.getUTCSeconds());
		return { amz: "" + Y + M + D + "T" + h + m + s + "Z", stamp: "" + Y + M + D };
	}

	// The SigV4 signing key: HMAC chain over date, region, service, "aws4_request".
	function signingKey(secret, dateStamp, region, service) {
		var kDate = hmac("AWS4" + secret, dateStamp);
		var kRegion = hmac(kDate, region);
		var kService = hmac(kRegion, service);
		return hmac(kService, "aws4_request");
	}

	// Sort + canonicalize a query object into "k=v&k=v" (RFC3986-encoded, sorted by key).
	function canonicalQuery(queryObj) {
		var keys = [];
		Object.keys(queryObj || {}).forEach(function (k) { keys.push(k); });
		keys.sort();
		return keys.map(function (k) {
			return uriEncode(k, true) + "=" + uriEncode(queryObj[k] == null ? "" : queryObj[k], true);
		}).join("&");
	}

	return {
		sha256Hex: sha256Hex,
		uriEncode: uriEncode,
		amzDates: amzDates,

		// signRequest({ method, host, path, query, headers, payloadHash, region, service,
		//   accessKeyId, secretAccessKey, date }) -> { headers: {...augmented...}, url }
		// `path` is the canonical resource ("/bucket/key..."), already the raw (un-encoded) key;
		// it is RFC3986-encoded here (slashes preserved). payloadHash defaults to the hash of an
		// empty body (UNSIGNED-PAYLOAD may be passed for streamed PUT/GET).
		signRequest: function (o) {
			var date = o.date || new Date();
			var d = amzDates(date);
			var service = o.service || "s3";
			var region = o.region || "us-east-1";
			var method = (o.method || "GET").toUpperCase();
			var payloadHash = o.payloadHash || sha256Hex("");
			var canonPath = "/" + String(o.path || "/").replace(/^\/+/, "");
			canonPath = "/" + uriEncode(canonPath.replace(/^\//, ""), false);

			var headers = {};
			Object.keys(o.headers || {}).forEach(function (k) { headers[k] = o.headers[k]; });
			headers.host = o.host;
			headers["x-amz-date"] = d.amz;
			headers["x-amz-content-sha256"] = payloadHash;

			// canonical headers: lowercased name, trimmed value, sorted.
			var hnames = Object.keys(headers).map(function (k) { return k.toLowerCase(); }).sort();
			var lc = {};
			Object.keys(headers).forEach(function (k) { lc[k.toLowerCase()] = String(headers[k]).replace(/\s+/g, " ").replace(/^ | $/g, ""); });
			var canonHeaders = hnames.map(function (k) { return k + ":" + lc[k] + "\n"; }).join("");
			var signedHeaders = hnames.join(";");

			var canonicalRequest = [
				method, canonPath, canonicalQuery(o.query), canonHeaders, signedHeaders, payloadHash
			].join("\n");

			var scope = d.stamp + "/" + region + "/" + service + "/aws4_request";
			var stringToSign = [
				"AWS4-HMAC-SHA256", d.amz, scope, sha256Hex(canonicalRequest)
			].join("\n");

			var sig = hmac(signingKey(o.secretAccessKey, d.stamp, region, service), stringToSign, "hex");
			headers.Authorization = "AWS4-HMAC-SHA256 Credential=" + o.accessKeyId + "/" + scope +
				", SignedHeaders=" + signedHeaders + ", Signature=" + sig;

			var url = "https://" + o.host + canonPath;
			var qs = canonicalQuery(o.query);
			if (qs) { url += "?" + qs; }
			return { headers: headers, url: url, signature: sig, canonicalRequest: canonicalRequest, stringToSign: stringToSign };
		},

		// presignUrl(...) -> a GET URL carrying the signature in the query string, valid for
		// `expires` seconds. Payload is UNSIGNED for a presigned GET.
		presignUrl: function (o) {
			var date = o.date || new Date();
			var d = amzDates(date);
			var service = o.service || "s3";
			var region = o.region || "us-east-1";
			var expires = o.expires || 3600;
			var canonPath = "/" + uriEncode(String(o.path || "/").replace(/^\/+/, ""), false);
			var scope = d.stamp + "/" + region + "/" + service + "/aws4_request";

			var query = {};
			Object.keys(o.query || {}).forEach(function (k) { query[k] = o.query[k]; });
			query["X-Amz-Algorithm"] = "AWS4-HMAC-SHA256";
			query["X-Amz-Credential"] = o.accessKeyId + "/" + scope;
			query["X-Amz-Date"] = d.amz;
			query["X-Amz-Expires"] = String(expires);
			query["X-Amz-SignedHeaders"] = "host";

			var canonHeaders = "host:" + o.host + "\n";
			var canonicalRequest = [
				(o.method || "GET").toUpperCase(), canonPath, canonicalQuery(query),
				canonHeaders, "host", "UNSIGNED-PAYLOAD"
			].join("\n");
			var stringToSign = ["AWS4-HMAC-SHA256", d.amz, scope, sha256Hex(canonicalRequest)].join("\n");
			var sig = hmac(signingKey(o.secretAccessKey, d.stamp, region, service), stringToSign, "hex");
			query["X-Amz-Signature"] = sig;

			return "https://" + o.host + canonPath + "?" + canonicalQuery(query);
		},

		hasNodeCrypto: !!_nc
	};
})();

if (typeof exports !== "undefined") { exports.S3Sig = S3Sig; }
