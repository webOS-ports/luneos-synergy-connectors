/* s3sig.js - AWS Signature Version 4 for the S3 connector, with node's crypto.
 *
 * S3-compatible services (AWS S3, IDrive e2, Backblaze B2's S3 API, MinIO, Garage, Wasabi, ...)
 * have no OAuth: every request is signed with the account's secret access key. Two forms:
 *   signRequest()  the Authorization header form, for every request the adapter sends;
 *   presignUrl()   the query string form (X-Amz-Signature=...), a GET URL that needs no header,
 *                  for the links listPhotos hands the Photos service.
 *
 * The host that is signed is the one fetch sends: hostOf() normalises it the way the URL parser
 * does (lowercased, a default port dropped, any other port kept). fetch ignores a Host header
 * it is given, so none is passed; every header that is passed is signed.
 */
"use strict";

const crypto = require("node:crypto");

const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");
const UNSIGNED = "UNSIGNED-PAYLOAD";

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const md5Base64 = (data) => crypto.createHash("md5").update(data).digest("base64");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();

// RFC 3986: everything but A-Z a-z 0-9 - _ . ~ percent-encoded as UTF-8; "/" kept unless
// encodeSlash (the canonical path keeps it, a query value does not).
function uriEncode(str, encodeSlash) {
	return Array.from(Buffer.from(String(str), "utf8")).map((b) => {
		const c = String.fromCharCode(b);
		if (/[A-Za-z0-9\-_.~]/.test(c) || (c === "/" && !encodeSlash)) { return c; }
		return "%" + b.toString(16).toUpperCase().padStart(2, "0");
	}).join("");
}

// amz: YYYYMMDDTHHMMSSZ, stamp: YYYYMMDD, both UTC.
function amzDates(date) {
	const amz = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	return { amz, stamp: amz.slice(0, 8) };
}

function signingKey(secret, stamp, region, service) {
	return hmac(hmac(hmac(hmac("AWS4" + secret, stamp), region), service), "aws4_request");
}

// "k=v&k=v", RFC 3986 encoded, sorted by key.
function canonicalQuery(query) {
	return Object.keys(query || {}).sort().map((k) =>
		uriEncode(k, true) + "=" + uriEncode(query[k] === undefined || query[k] === null ? "" : query[k], true)).join("&");
}

const schemeOf = (scheme) => (scheme === "http" ? "http" : "https");

// The Host header fetch will send for this endpoint: "S3.Example.test:443" -> "s3.example.test".
function hostOf(host, scheme) {
	return new URL(schemeOf(scheme) + "://" + host).host;
}

// "/" + the raw resource path ("bucket/key" or "key"), encoded, slashes kept.
const canonicalPath = (p) => "/" + uriEncode(String(p || "").replace(/^\/+/, ""), false);

/* signRequest({ method, host, path, query, headers, payloadHash, region, service, accessKeyId,
 *   secretAccessKey, scheme, date }) -> { url, headers, signature, canonicalRequest, stringToSign }
 * `path` is the raw resource ("bucket/key ü"); headers are the caller's (lowercase names), to
 * which x-amz-date and x-amz-content-sha256 are added; all of them and the host are signed.
 * The returned headers are what to send: the caller's, the two added and Authorization. */
function signRequest(o) {
	const d = amzDates(o.date || new Date());
	const service = o.service || "s3";
	const region = o.region || "us-east-1";
	const method = String(o.method || "GET").toUpperCase();
	const payloadHash = o.payloadHash || EMPTY_SHA256;
	const host = hostOf(o.host, o.scheme);
	const path = canonicalPath(o.path);
	const query = canonicalQuery(o.query);

	const headers = {};
	for (const k of Object.keys(o.headers || {})) { headers[k.toLowerCase()] = String(o.headers[k]); }
	delete headers.host;
	headers["x-amz-date"] = d.amz;
	headers["x-amz-content-sha256"] = payloadHash;

	const signed = Object.assign({ host }, headers);
	const names = Object.keys(signed).sort();
	const canonHeaders = names.map((k) => k + ":" + signed[k].trim().replace(/\s+/g, " ") + "\n").join("");
	const signedHeaders = names.join(";");
	const canonicalRequest = [method, path, query, canonHeaders, signedHeaders, payloadHash].join("\n");
	const scope = d.stamp + "/" + region + "/" + service + "/aws4_request";
	const stringToSign = ["AWS4-HMAC-SHA256", d.amz, scope, sha256Hex(canonicalRequest)].join("\n");
	const signature = hmac(signingKey(o.secretAccessKey, d.stamp, region, service), stringToSign).toString("hex");
	headers.Authorization = "AWS4-HMAC-SHA256 Credential=" + o.accessKeyId + "/" + scope +
		", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

	const url = schemeOf(o.scheme) + "://" + host + path + (query ? "?" + query : "");
	return { url, headers, signature, canonicalRequest, stringToSign };
}

/* presignUrl({ method, host, path, query, expires, region, service, accessKeyId,
 *   secretAccessKey, scheme, date }) -> a URL carrying its signature, valid `expires` seconds
 * (default 3600). Only the host is signed, and the payload is UNSIGNED-PAYLOAD. */
function presignUrl(o) {
	const d = amzDates(o.date || new Date());
	const service = o.service || "s3";
	const region = o.region || "us-east-1";
	const host = hostOf(o.host, o.scheme);
	const path = canonicalPath(o.path);
	const scope = d.stamp + "/" + region + "/" + service + "/aws4_request";
	const query = Object.assign({}, o.query || {}, {
		"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
		"X-Amz-Credential": o.accessKeyId + "/" + scope,
		"X-Amz-Date": d.amz,
		"X-Amz-Expires": String(o.expires || 3600),
		"X-Amz-SignedHeaders": "host",
	});
	const canonicalRequest = [String(o.method || "GET").toUpperCase(), path, canonicalQuery(query),
		"host:" + host + "\n", "host", UNSIGNED].join("\n");
	const stringToSign = ["AWS4-HMAC-SHA256", d.amz, scope, sha256Hex(canonicalRequest)].join("\n");
	query["X-Amz-Signature"] = hmac(signingKey(o.secretAccessKey, d.stamp, region, service), stringToSign).toString("hex");
	return schemeOf(o.scheme) + "://" + host + path + "?" + canonicalQuery(query);
}

module.exports = { signRequest, presignUrl, uriEncode, canonicalQuery, hostOf, amzDates, sha256Hex, md5Base64,
	EMPTY_SHA256, UNSIGNED };
