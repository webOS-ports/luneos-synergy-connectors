/*global Adapter, Config, console */
/* login - the account VALIDATOR for the generic S3 connector. The s3-auth customUI collects the
 * endpoint, region, bucket, access key id and secret access key, and calls this command, which
 * VALIDATES them with a zero-key ListObjectsV2 (Adapter.getAccountInfo) and, on success, returns
 * credentials in the shape Accounts stores and the Adapter reads:
 *   { returnValue, username, credentials:{ common:{ accessToken(=accessKeyId), secretAccessKey,
 *                                                    endpoint, region, bucket, pathStyle } } }
 * The secret access key is stored but never leaves the device beyond the SigV4-signed requests.
 */
function LoginCommandAssistant() {}

LoginCommandAssistant.prototype = {
	run: function (future) {
		var args = this.controller.args || {};
		// "host[:port]", or with a scheme: "http://nas.local:9000" for a self-hosted server that
		// speaks plain HTTP (MinIO, Garage); HTTPS otherwise.
		var raw = String(args.endpoint || "").replace(/^\s+|\s+$/g, "");
		var plainHttp = /^http:\/\//i.test(raw);
		var endpoint = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
		var bucket   = (args.bucket || "").replace(/^\/+|\/+$/g, "");
		var region   = args.region || (Config && Config.DEFAULT_REGION) || "us-east-1";
		var accessKeyId = args.accessKeyId || args.accessKey;
		var secret   = args.secretAccessKey || args.secretKey;
		var pathStyle = (args.pathStyle === false || args.pathStyle === "false") ? false : true;

		if (!endpoint || !bucket || !accessKeyId || !secret) {
			future.setException({ returnValue: false, errorCode: "MISSING_CREDENTIALS",
				detail: "need endpoint, bucket, accessKeyId and secretAccessKey" });
			return;
		}
		var creds = {
			accessToken:     accessKeyId,   // the access key id doubles as _cloudcore's accessToken
			secretAccessKey: secret,
			endpoint:        endpoint,
			region:          region,
			bucket:          bucket,
			pathStyle:       pathStyle
		};
		if (plainHttp) { creds.scheme = "http"; }   // only then, so other accounts stay as they were
		// Validate by signing a real request against the bucket.
		var info = Adapter.getAccountInfo(creds);
		info.then(this, function () {
			var u = {};
			try { u = (info.result && info.result.user) || {}; }
			catch (e) {
				future.setException({ returnValue: false, errorCode: "S3_AUTH_FAILED",
					detail: "could not access the bucket - check the endpoint, region, keys and bucket name" });
				return;
			}
			future.result = {
				returnValue: true,
				username:    u.emailAddress || (bucket + "@" + endpoint),
				alias:       bucket,
				credentials: { common: creds }
			};
		});
	}
};
