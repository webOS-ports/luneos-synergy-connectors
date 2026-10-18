/*global IMPORTS, Config, OAuth1, HttpCurl, console */
/* flickrapi.js - Flickr REST client + the high-level auth wrappers.
 *
 * REST calls are OAuth-1.0a-signed GETs (so the user's own private sets/photos are
 * visible): every call goes to Config.REST_URL with method / api_key / format=json /
 * nojsoncallback=1, signed by OAuth1.signedUrl and fetched through the modern curl.
 *
 * Photo model: Flickr HAS albums (photosets), so - unlike Dropbox/OneDrive's single
 * synthetic folder - listAlbums returns every photoset PLUS one synthetic "All Photos"
 * album (aid = ALL_PHOTOS_AID) backed by flickr.people.getPhotos(user_id="me").
 */
var Foundations = IMPORTS.foundations;
var Future = Foundations.Control.Future;

var FlickrApi = {
	// Sentinel aid for the synthetic "all of my photos" album (not a real photoset id).
	ALL_PHOTOS_AID: "__all__",
	ALL_PHOTOS_NAME: "All Photos",

	// Extras we ask Flickr to inline on every photo so listPhotos needs no per-photo call.
	PHOTO_EXTRAS: "url_o,url_b,url_c,o_dims,original_format,media,last_update",

	// rest(method, params, creds) -> Future(parsed JSON). creds = { oauthToken, oauthTokenSecret }.
	rest: function (method, params, creds) {
		var self = this;
		var f = new Future();
		var all = { method: method, api_key: Config.CONSUMER_KEY,
			format: "json", nojsoncallback: "1" };
		if (params) {
			Object.keys(params).forEach(function (k) {
				if (params[k] !== null && params[k] !== undefined) { all[k] = params[k]; }
			});
		}
		var url = OAuth1.signedUrl("GET", Config.REST_URL, all,
			creds && creds.oauthToken, creds && creds.oauthTokenSecret);
		f.now(this, function () { return HttpCurl.request({ method: "GET", url: url }); });
		f.then(this, function () {
			f.result = self._parse(f.result);
		});
		return f;
	},

	_parse: function (r) {
		if (!r || r.status < 200 || r.status >= 300) {
			throw { returnValue: false, errorCode: "FLICKR_HTTP_ERROR",
				status: r && r.status, body: r && r.responseText };
		}
		var data;
		try { data = r.responseText ? JSON.parse(r.responseText) : {}; }
		catch (e) {
			throw { returnValue: false, errorCode: "FLICKR_BAD_JSON", body: r.responseText };
		}
		// Flickr signals API-level failures as {stat:"fail", code, message} with HTTP 200.
		if (data && data.stat && data.stat !== "ok") {
			throw { returnValue: false, errorCode: "FLICKR_API_FAIL",
				code: data.code, message: data.message };
		}
		return data;
	},

	// --- auth wrappers (used by the auth commands) --------------------------------
	// Leg 1 + build the consent URL. Resolves to { url, requestToken, requestTokenSecret }.
	// The auth app must carry requestToken + requestTokenSecret across the web login (the
	// service is idle-killed during it) and hand them back to exchange().
	getAuthorizeUrl: function () {
		var self = this;
		var f = new Future();
		var rt = OAuth1.getRequestToken();
		f.now(this, function () { return rt; });
		f.then(this, function () {
			var t = rt.result;   // throws if rt carried an exception
			f.result = {
				url:                OAuth1.buildAuthorizeUrl(t.oauthToken),
				requestToken:       t.oauthToken,
				requestTokenSecret: t.oauthTokenSecret
			};
		});
		return f;
	},

	// Leg 3: verifier -> long-lived access credentials. Resolves to the `common` object
	// the account DB stores: { oauthToken, oauthTokenSecret, userId, username, fullname }.
	exchange: function (requestToken, requestTokenSecret, verifier) {
		var f = new Future();
		var at = OAuth1.getAccessToken(requestToken, requestTokenSecret, verifier);
		f.now(this, function () { return at; });
		f.then(this, function () {
			var t = at.result;
			f.result = {
				oauthToken:       t.oauthToken,
				oauthTokenSecret: t.oauthTokenSecret,
				userId:           t.userId,
				username:         t.username,
				fullname:         t.fullname
			};
		});
		return f;
	},

	// checkCredentials helper: flickr.test.login returns the calling user on valid tokens.
	testLogin: function (creds) {
		return this.rest("flickr.test.login", null, creds);
	},

	// --- photo provider layer -----------------------------------------------------
	// listPhotosets -> Future(raw flickr.photosets.getList result).
	listPhotosets: function (creds) {
		return this.rest("flickr.photosets.getList", { user_id: "me" }, creds);
	},

	// Photos in one photoset (extras inline the download URLs). Returns raw result.
	photosetPhotos: function (creds, photosetId) {
		return this.rest("flickr.photosets.getPhotos",
			{ photoset_id: photosetId, user_id: "me", extras: this.PHOTO_EXTRAS, per_page: "500" },
			creds);
	},

	// All of the user's photos (the synthetic album). `page`/`perPage` optional.
	allPhotos: function (creds, perPage) {
		return this.rest("flickr.people.getPhotos",
			{ user_id: "me", extras: this.PHOTO_EXTRAS, per_page: (perPage || "500") },
			creds);
	},

	// Resolve the best downloadable https URL for a raw Flickr photo entry.
	// Prefer the original (url_o), then large (url_b), then medium-800 (url_c); if none
	// were inlined, construct the standard static URL from server/id/secret. These are
	// plain https URLs on live.staticflickr.com - the aggregator's curl fetches them with
	// NO auth header (the id_secret pair is itself the capability, so private photos work).
	resolveDownloadUrl: function (p) {
		if (p.url_o) { return p.url_o; }
		if (p.url_b) { return p.url_b; }
		if (p.url_c) { return p.url_c; }
		if (p.server && p.id && p.secret) {
			return "https://live.staticflickr.com/" + p.server + "/" +
				p.id + "_" + p.secret + "_b.jpg";
		}
		return null;
	},

	// Derive a sensible local filename (the static URL / Flickr photo has no real name).
	// Uses the extension of the resolved URL when present, else .jpg.
	fileNameFor: function (p, url) {
		var ext = "jpg";
		var m = url && url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
		if (m) { ext = m[1].toLowerCase(); }
		return p.id + "." + ext;
	}
};

if (typeof exports !== "undefined") { exports.FlickrApi = FlickrApi; }
