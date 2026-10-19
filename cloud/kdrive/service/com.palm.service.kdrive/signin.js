/* signin.js - kDrive's account validators: verifyToken (the personal API token, in use now) and
 * exchangeCode (OAuth2, ready for when Infomaniak grants LuneOS's app the scope "drive").
 *
 *   verifyToken  { token|accessToken }      -> { username, alias, credentials:{ common } }   open
 *   exchangeCode { code, codeVerifier }     -> { username, alias, credentials:{ common } }   open
 *
 * Both find the account, its drive and the writable root from the token (adapter.discoverAccount)
 * and store them with it, so no file operation has to look them up again:
 *   token:  common = { accessToken, accountId, driveId, rootFolderId }
 *   OAuth:  common = { accessToken, refreshToken, expiresAt, accountId, driveId, rootFolderId }
 * Accounts calls them through the sign-in app (com.palm.app.kdrive-auth, which arrives as
 * com.palm.app.accounts-<pid>) or with no app id at all, so both are open, as the generic
 * exchangeCode is; the bus role decides who reaches the service.
 *
 * Unlike the generic exchangeCode, kDrive's fails when the drive cannot be found: an account
 * made without one would fail every file operation (an OAuth app without "drive" gets a 403).
 */
"use strict";

function signinMethods({ core, config, adapter, oauth }) {
	const { CloudError, Session, notSupported, TIMEOUTS } = core;

	function reply(d, common) {
		return { username: d.email || config.DISPLAY_NAME || "kDrive", alias: d.displayName || undefined,
			credentials: { common } };
	}

	return {
		// The token is checked by using it: the profile, the drive list and the root listing. A
		// token kDrive refuses (or that reaches no drive) is KDRIVE_TOKEN_INVALID, as before; no
		// answer at all stays CURL_FAILED, which is not the token's fault.
		verifyToken: { timeoutMs: TIMEOUTS.account, handler: async (p) => {
			const token = p.token || p.accessToken;
			if (!token || typeof token !== "string") { throw new CloudError("MISSING_TOKEN", "need token"); }
			const s = new Session({ accessToken: token });
			let d;
			try { d = await adapter.discoverAccount(s); }
			catch (e) {
				if (e && e.errorCode === "CURL_FAILED") { throw e; }
				throw new CloudError("KDRIVE_TOKEN_INVALID", "kDrive did not accept the token: " + ((e && (e.errorText || e.message)) || e),
					(e && typeof e.status === "number") ? { status: e.status } : undefined);
			}
			return reply(d, { accessToken: token, accountId: d.accountId, driveId: d.driveId, rootFolderId: d.rootFolderId });
		} },

		exchangeCode: { timeoutMs: TIMEOUTS.account, handler: async (p) => {
			if (!oauth) { throw notSupported("kDrive does not sign in with OAuth"); }
			if (!p.code) { throw new CloudError("MISSING_CODE", "need code"); }
			const t = await oauth.exchangeCode(p.code, p.codeVerifier);
			const s = new Session({ accessToken: t.accessToken, refreshToken: t.refreshToken,
				expiresAt: (typeof t.expiresIn === "number" && isFinite(t.expiresIn)) ? Date.now() + t.expiresIn * 1000 : null },
			{ refresh: oauth.refresh });
			const d = await adapter.discoverAccount(s);
			return reply(d, Object.assign({}, s.creds, { accountId: d.accountId, driveId: d.driveId, rootFolderId: d.rootFolderId }));
		} },
	};
}

module.exports = signinMethods;
