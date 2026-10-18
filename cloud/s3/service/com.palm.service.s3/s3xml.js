/*global exports, console */
/* s3xml.js - a tiny, dependency-free reader for the two S3 XML responses this connector needs.
 * S3's ListObjectsV2 / error XML is flat and predictable, so a full XML parser is overkill: we
 * pull repeated <Contents>…</Contents> and <CommonPrefixes>…</CommonPrefixes> blocks and read
 * their leaf tags. Values are XML-entity-decoded. This is NOT a general XML parser - it only
 * handles the shapes S3 returns.
 */
var S3Xml = (function () {
	function decode(s) {
		if (s == null) { return s; }
		return String(s)
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&apos;/g, "'")
			.replace(/&amp;/g, "&");
	}
	// First <tag>…</tag> leaf value within `xml` (non-greedy), or null.
	function tag(xml, name) {
		var m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(xml);
		return m ? decode(m[1]) : null;
	}
	// All top-level <block>…</block> chunks.
	function blocks(xml, name) {
		var re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "g"), out = [], m;
		while ((m = re.exec(xml)) !== null) { out.push(m[1]); }
		return out;
	}

	return {
		tag: tag,
		decode: decode,

		// Parse a ListObjectsV2 response body into
		//   { files:[{key,size,modified,etag}], prefixes:[key], truncated, nextToken }
		parseList: function (xml) {
			xml = xml || "";
			var files = blocks(xml, "Contents").map(function (b) {
				return {
					key:      tag(b, "Key"),
					size:     parseInt(tag(b, "Size") || "0", 10),
					modified: tag(b, "LastModified"),
					etag:     tag(b, "ETag")
				};
			});
			var prefixes = blocks(xml, "CommonPrefixes").map(function (b) { return tag(b, "Prefix"); });
			var truncated = (tag(xml, "IsTruncated") === "true");
			return {
				files: files,
				prefixes: prefixes,
				truncated: truncated,
				nextToken: tag(xml, "NextContinuationToken")
			};
		},

		// Extract an S3 <Error><Code>…</Code><Message>…</Message></Error> if present.
		parseError: function (xml) {
			if (!xml || xml.indexOf("<Error") < 0) { return null; }
			return { code: tag(xml, "Code"), message: tag(xml, "Message") };
		}
	};
})();

if (typeof exports !== "undefined") { exports.S3Xml = S3Xml; }
