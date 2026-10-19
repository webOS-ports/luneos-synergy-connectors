/* login.js - MEGA's account validator: email + password instead of OAuth.
 *
 * The sign-in app (com.palm.app.mega-auth, the template's validator customUI) collects the email
 * and password and calls
 *   login { email|username, password, mfa? }
 *     -> { username, alias?, credentials: { common: { accessToken (session id), mk, email, u?, name? } } }
 * which Accounts stores. The password is used to derive the keys (megacrypto.deriveLogin) and is
 * neither stored nor sent. An account with two-factor authentication answers MEGA_MFA_REQUIRED
 * until the code is given; a wrong password is MEGA_BAD_CREDENTIALS. The caller is not checked,
 * as before: the app's calls come from inside Accounts, and the bus role decides who reaches the
 * service at all.
 *
 * The account's name and email come from `ug` afterwards; that is only a nicety, so its failure
 * does not fail the sign-in. Hashcash and v2's PBKDF2 can take a while on a phone: 120 s.
 */
"use strict";

const TIMEOUT_MS = 120000;

function loginMethods({ config, adapter, log = console }) {
	return {
		login: { timeoutMs: TIMEOUT_MS, handler: async (p) => {
			const email = p.email || p.username;
			const password = p.password;
			if (!email || !password || typeof password !== "string") {
				throw Object.assign(new Error("need email and password"), { errorCode: "MISSING_CREDENTIALS", errorText: "need email and password" });
			}
			const creds = await adapter.login(email, password, p.mfa || null);
			let u = {};
			try { u = ((await adapter.getAccountInfo({ creds })) || {}).user || {}; }
			catch (e) { log.log("mega: login - account info unavailable: " + ((e && e.errorCode) || e)); u = {}; }
			if (u.displayName) { creds.name = u.displayName; }
			return { username: u.emailAddress || creds.email || config.DISPLAY_NAME || "MEGA",
				alias: u.displayName || undefined, credentials: { common: creds } };
		} },
	};
}

module.exports = Object.assign(loginMethods, { TIMEOUT_MS });
