/*global Adapter, Config, console */
/* verifyToken - the account VALIDATOR for the TOKEN sign-in method. Called by the kdrive-auth
 * customUI app with the personal API token the user pasted. args: { token }
 *
 * kDrive's token path needs no OAuth: the token IS the credential. We validate it and, from it
 * alone, auto-discover the account_id + drive_id (Adapter.discoverAccount -> GET /2/profile then
 * GET /2/drive), then return the credential shape the account DB stores and the Adapter later
 * reads: credentials.common = { accessToken, accountId, driveId, rootFolderId }. (rootFolderId is
 * the writable private-space folder; kDrive refuses uploads into the drive root.)
 * accounts/handlers/create.js
 * requires a username, so we surface the account email as well.
 */
function VerifyTokenCommandAssistant() {}

VerifyTokenCommandAssistant.prototype = {
	run: function (future) {
		var args = this.controller.args || {};
		var token = args.token || args.accessToken;
		if (!token) {
			future.setException({ returnValue: false, errorCode: "MISSING_TOKEN" });
			return;
		}
		var creds = { accessToken: token };
		// discoverAccount both VALIDATES the token (a bad token 401s the profile call) and
		// resolves the drive; a failure here means the token is invalid or has no kDrive.
		var disc = Adapter.discoverAccount(creds);
		disc.then(this, function () {
			var d;
			try { d = disc.result; }
			catch (e) {
				future.setException({ returnValue: false, errorCode: "KDRIVE_TOKEN_INVALID",
					detail: e });
				return;
			}
			var common = { accessToken: token, accountId: d.accountId, driveId: d.driveId,
				rootFolderId: d.rootFolderId };
			future.result = {
				returnValue: true,
				username:    d.email || (Config && Config.DISPLAY_NAME) || "kDrive",
				alias:       d.displayName || undefined,
				credentials: { common: common }
			};
		});
	}
};
