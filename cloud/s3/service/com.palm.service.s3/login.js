/* login.js - the account validator: com.palm.service.s3/login.
 *
 * The sign-in app (com.palm.app.s3-auth, the template's customUI) collects the endpoint, region,
 * bucket, access key id and secret access key, and calls this, which signs a zero-key
 * ListObjectsV2 with them (adapter.getAccountInfo) and, if the bucket answers, returns the
 * credentials in the shape Accounts stores and the adapter reads:
 *   { username, alias, credentials:{ common:{ accessToken (the access key id), secretAccessKey,
 *                                             endpoint, region, bucket, pathStyle, scheme? } } }
 * endpoint is "host[:port]", given as that or as "https://host[:port]" or "http://host[:port]";
 * scheme:"http" is stored only for the last (a self-hosted MinIO or Garage on the LAN), so
 * other accounts keep exactly the credentials they had. Open, as the command was: the sign-in
 * app's calls arrive as com.palm.app.accounts-<pid>.
 */
"use strict";

const TIMEOUT_MS = 60000;

// deps: the connector's (config, adapter, log) plus the core's Session and CloudError.
function loginMethods({ config, adapter, Session, CloudError, log = console }) {
	return {
		login: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const raw = String(p.endpoint || "").trim();
			const plainHttp = /^http:\/\//i.test(raw);
			const endpoint = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
			const bucket = String(p.bucket || "").replace(/^\/+|\/+$/g, "");
			const region = p.region || config.DEFAULT_REGION || "us-east-1";
			const accessKeyId = p.accessKeyId || p.accessKey;
			const secret = p.secretAccessKey || p.secretKey;
			const pathStyle = !(p.pathStyle === false || p.pathStyle === "false");
			if (!endpoint || !bucket || !accessKeyId || !secret) {
				throw new CloudError("MISSING_CREDENTIALS", "need endpoint, bucket, accessKeyId and secretAccessKey");
			}
			const creds = { accessToken: accessKeyId, secretAccessKey: secret, endpoint, region, bucket, pathStyle };
			if (plainHttp) { creds.scheme = "http"; }
			let u;
			try { u = ((await adapter.getAccountInfo(new Session(creds))) || {}).user || {}; }
			catch (e) {
				log.log("s3: login to " + endpoint + " failed: " + ((e && (e.errorCode + " " + (e.errorText || e.message))) || e));
				throw new CloudError("S3_AUTH_FAILED", "could not access the bucket - check the endpoint, region, keys and bucket name (" +
					((e && (e.errorText || e.message)) || e) + ")", { status: e && e.status });
			}
			return { username: u.emailAddress || (bucket + "@" + endpoint), alias: bucket, credentials: { common: creds } };
		} },
	};
}

module.exports = loginMethods;
