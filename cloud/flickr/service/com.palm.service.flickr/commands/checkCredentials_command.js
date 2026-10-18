/*global FlickrApi, console */
/* checkCredentials - re-validate stored tokens (called by accounts on demand via the
 * template's onCredentialsChanged). Hits flickr.test.login; stat:"ok" means the OAuth
 * 1.0a tokens still sign valid requests. Flickr tokens don't expire/rotate, so there is
 * no renewedCredentials to return - a failure here means the user revoked access.
 */
function CheckCredentialsCommandAssistant() {}

CheckCredentialsCommandAssistant.prototype = {
	run: function (future) {
		var args = this.controller.args || {};
		var creds = args.credentials && args.credentials.common;
		if (!creds || !creds.oauthToken) {
			future.setException({ returnValue: false, errorCode: "401_UNAUTHORIZED" });
			return;
		}
		var call = FlickrApi.testLogin(creds);
		call.then(this, function () {
			var me;
			try { me = call.result; }
			catch (e) { future.setException(e); return; }
			var user = me && me.user ? me.user : {};
			future.result = { returnValue: true,
				username: (user.username && user.username._content) || creds.username };
		});
	}
};
