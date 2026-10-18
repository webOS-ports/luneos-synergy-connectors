/*global IMPORTS, Config, require, process, console */
/*
 * httpcurl.js - HTTPS transport for the Flickr service, via the modern curl.
 *
 * WHY: the device node runtime is OpenSSL 0.9.8k (no TLS 1.2/1.3), so its built-in
 * HTTP stack CANNOT complete a TLS handshake with www.flickr.com / api.flickr.com /
 * live.staticflickr.com. As with the Dropbox/Teams ports, every Flickr HTTPS request
 * is shelled out to the modern curl (curl 7.88.1 + OpenSSL 1.1.1, TLS 1.3) from the
 * deployment-bundle. The JS layer is pure orchestration; all TLS lives in curl.
 *
 * IMPORTANT (Flickr specifics): the OAuth 1.0a signature (HMAC-SHA1) is computed IN
 * node (see oauth1.js) BEFORE the request is handed here - HMAC-SHA1 is an old
 * algorithm the 0.9.8k runtime supports. curl only performs the TLS transport; it
 * never signs anything. Flickr requests are GETs whose query string already carries
 * the oauth_signature, so they arrive here as { method:"GET", url:<fully-signed-url> }.
 *
 * This file is copied verbatim from the Dropbox connector's httpcurl.js (only the
 * comments differ) so the curl invocation stays byte-for-byte identical.
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var reqf = (typeof require !== "undefined") ? require : (IMPORTS.require || null);
var cp = reqf ? reqf("child_process") : null;

var HttpCurl = {
	// request({ method, url, headers:{}, form:{k:v}, body:"", bearer:"", outFile:"" }) -> Future
	// resolves to { status: <int>, responseText: <string> }
	request: function (opts) {
		opts = opts || {};
		var f = new Future();

		if (!cp) {
			f.setException({ returnValue: false, errorCode: "NO_CHILD_PROCESS",
				detail: "child_process unavailable in this service context" });
			return f;
		}

		var method = opts.method || "GET";
		var args = ["-s", "-S", "--tlsv1.2", "-w", "\n%{http_code}", "-X", method];

		// Point curl at the system CA store (/etc/ssl/certs/ca-certificates.crt), refreshed
		// to a current bundle by the deployment-bundle prerequisite so verify succeeds.
		if (Config.CURL_CAINFO) {
			args.push("--cacert", Config.CURL_CAINFO);
		}

		if (opts.bearer) {
			args.push("-H", "Authorization: Bearer " + opts.bearer);
		}
		if (opts.headers) {
			Object.keys(opts.headers).forEach(function (k) {
				args.push("-H", k + ": " + opts.headers[k]);
			});
		}
		// outFile: write the response BODY straight to a local file. curl streams to disk,
		// so big files don't hit node's maxBuffer; stdout keeps only the -w http_code line.
		if (opts.outFile) {
			args.push("--create-dirs", "-o", opts.outFile);
		}
		if (opts.form) {
			Object.keys(opts.form).forEach(function (k) {
				args.push("--data-urlencode", k + "=" + opts.form[k]);
			});
		} else if (opts.dataFile) {
			args.push("--data-binary", "@" + opts.dataFile);
		} else if (opts.body) {
			args.push("--data-binary", opts.body);
		}
		args.push(opts.url);

		// Inherit env; point the loader at the modern libssl/libcrypto if configured.
		var env = {};
		var src = (typeof process !== "undefined" && process.env) ? process.env : {};
		Object.keys(src).forEach(function (k) { env[k] = src[k]; });
		if (Config.CURL_LD_LIBRARY_PATH) {
			env.LD_LIBRARY_PATH = Config.CURL_LD_LIBRARY_PATH +
				(env.LD_LIBRARY_PATH ? ":" + env.LD_LIBRARY_PATH : "");
		}

		cp.execFile(Config.CURL || "/usr/bin/curl", args,
			{ env: env, maxBuffer: 8 * 1024 * 1024 },
			function (err, stdout, stderr) {
				stdout = stdout || "";
				if (err && !stdout) {
					f.setException({ returnValue: false, errorCode: "CURL_FAILED",
						detail: (stderr || String(err)) });
					return;
				}
				// -w appended "\n<http_code>" after the body; split on the LAST newline.
				var cut = stdout.lastIndexOf("\n");
				var head = (cut >= 0) ? stdout.substring(0, cut) : stdout;
				var tail = (cut >= 0) ? stdout.substring(cut + 1) : "";
				f.result = { status: parseInt(tail, 10) || 0, responseText: head };
			});

		return f;
	}
};

if (typeof exports !== "undefined") { exports.HttpCurl = HttpCurl; }
