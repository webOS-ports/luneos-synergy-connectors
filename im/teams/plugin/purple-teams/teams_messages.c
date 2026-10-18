/*
 * Teams Plugin for libpurple/Pidgin
 * Copyright (c) 2014-2020 Eion Robb
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
 
#include "teams_messages.h"
#include "connection.h"
#include "glib.h"
#include "purplecompat.h"
#include "teams_util.h"
#include "teams_connection.h"
#include "teams_contacts.h"
#include "teams_trouter.h"
#include "teams_cards.h"
#include "teams_calling.h"
#include "util.h"


static GString* make_last_timestamp_setting(const gchar *convname) {
	GString *rv = g_string_new(NULL);
	g_string_printf(rv, "%s_last_message_timestamp", convname);
	return rv;
}

static gchar *
teams_meify(const gchar *message, gint skypeemoteoffset)
{
	guint len;
	len = strlen(message);
	
	if (skypeemoteoffset <= 0 || skypeemoteoffset >= len)
		return g_strdup(message);
	
	return g_strconcat("/me ", message + skypeemoteoffset, NULL);
}

static void
process_userpresence_resource(TeamsAccount *sa, JsonObject *resource)
{
	const gchar *selfLink = json_object_get_string_member(resource, "selfLink");
	const gchar *status = json_object_get_string_member(resource, "status");
	// const gchar *capabilities = json_object_get_string_member(resource, "capabilities");
	// const gchar *lastSeenAt = json_object_get_string_member(resource, "lastSeenAt");
	const gchar *from;
	// gboolean is_idle;
	
	from = teams_contact_url_to_name(selfLink);
	g_return_if_fail(from);
	
	if (!purple_blist_find_buddy(sa->account, from))
	{
		PurpleGroup *group = teams_get_blist_group(sa);
		
		if (teams_is_user_self(sa, from)) {
			return;
		}
		
		purple_blist_add_buddy(purple_buddy_new(sa->account, from, NULL), NULL, group, NULL);
		teams_get_friend_profile(sa, from);
	}

	purple_protocol_got_user_status(sa->account, from, status, NULL);

	gboolean is_idle = strstr(status, "Idle") != NULL;
	purple_prpl_got_user_idle(sa->account, from, is_idle, 0);
}

// static gboolean
// teams_clear_typing_hack(PurpleChatUser *cb)
// {
	// PurpleChatUserFlags cbflags;
	
	// cbflags = purple_chat_user_get_flags(cb);
	// cbflags &= ~PURPLE_CHAT_USER_TYPING;
	// purple_chat_user_set_flags(cb, cbflags);
	
	// return FALSE;
// }

static void
teams_find_incoming_img(TeamsAccount *sa, PurpleConversation *conv, time_t msg_time, const gchar *msg_who, gchar **msg_content)
{
	const char *tmp;
	const char *start;
	const char *end;
	GData *attributes;
	GString *newmsg = NULL;

	tmp = *msg_content;
	
	while (purple_markup_find_tag("img", tmp, &start, &end, &attributes)) {
		const char *srcstr = NULL;
		const char *itemtype = NULL;

		if (newmsg == NULL)
			newmsg = g_string_new("");

		//copy any text before the img tag
		if (tmp < start)
			g_string_append_len(newmsg, tmp, start - tmp);
		
		itemtype = g_datalist_get_data(&attributes, "itemtype");
		if (purple_strequal(itemtype, "http://schema.skype.com/AMSImage")) {
			srcstr = g_datalist_get_data(&attributes, "src");
			if (srcstr != NULL) {
				teams_download_uri_to_conv(sa, srcstr, conv, msg_time, msg_who);
			}
			
		} else if (purple_strequal(itemtype, "http://schema.skype.com/Emoji")) {
			const gchar *alt = g_datalist_get_data(&attributes, "alt");
			g_string_append(newmsg, alt);
			
		} else {
			srcstr = g_datalist_get_data(&attributes, "src");
			if (srcstr != NULL) {
				teams_download_uri_to_conv(sa, srcstr, conv, msg_time, msg_who);
				g_string_append(newmsg, srcstr);
			}
		}
		
		g_datalist_clear(&attributes);
		// Continue from the end of the tag 
		tmp = end + 1;
	}

	if (newmsg != NULL)
	{
		// Append any remaining message data
		g_string_append(newmsg, tmp);
		
		g_free(*msg_content);
		*msg_content = g_string_free(newmsg, FALSE);
	}
}

static gchar *
teams_process_files_in_properties(JsonObject *properties, gchar **html)
{
	if (html == NULL) {
		return NULL;
	}

	if (json_object_has_member(properties, "files")) {
		const gchar *files_str = json_object_get_string_member(properties, "files");
		JsonArray *files = json_decode_array(files_str, -1);
		GString *files_string = g_string_new(NULL);
		guint i, len = json_array_get_length(files);

		for(i = 0; i < len; i++) {
			JsonObject *file = json_array_get_object_element(files, i);
			const gchar *fileName = json_object_has_member(file, "fileName") ? json_object_get_string_member(file, "fileName") : NULL;
			const gchar *fileType = json_object_has_member(file, "fileType") ? json_object_get_string_member(file, "fileType") : NULL;
			// webOS: a Teams file (docx/pptx/...) is a OneDrive item, NOT a skype_token-downloadable ASM
			// object -- so we can't fetch it inline like an image/voice note (its share link 403s without
			// a Microsoft browser session). Emit a clean tappable link to fileInfo.shareUrl (the 1drv.ms
			// share URL, which opens the file in the browser where the user is signed in). Prefer shareUrl,
			// then objectUrl/fileUrl.
			const gchar *href = NULL;
			if (json_object_has_member(file, "fileInfo")) {
				JsonObject *fi = json_object_get_object_member(file, "fileInfo");
				if (fi != NULL) {
					if (json_object_has_member(fi, "shareUrl"))
						href = json_object_get_string_member(fi, "shareUrl");
					if ((href == NULL || !*href) && json_object_has_member(fi, "fileUrl"))
						href = json_object_get_string_member(fi, "fileUrl");
				}
			}
			if ((href == NULL || !*href) && json_object_has_member(file, "objectUrl"))
				href = json_object_get_string_member(file, "objectUrl");

			if (href != NULL && *href) {
				g_string_append(files_string, "\xF0\x9F\x93\x8E <a href=\""); // 📎
				g_string_append(files_string, href);
				g_string_append(files_string, "\">");
				g_string_append(files_string, fileName ? fileName : _("File"));
				g_string_append(files_string, "</a>");
				if (fileType != NULL && *fileType) {
					g_string_append(files_string, " (");
					g_string_append(files_string, fileType);
					g_string_append(files_string, ")");
				}
				g_string_append(files_string, "<br>");
			}
			//Potentially use the preview image in  file.filePreview.previewUrl
		}

		if (files) json_array_unref(files); /* webOS: guarded macro can yield NULL -> unref asserts */

		gchar *temp = g_strconcat(*html ? *html : "", files_string->str, NULL);
		g_free(*html);
		*html = temp;
		
		g_string_free(files_string, TRUE);
	}
	
	return *html;
}

static gchar *
teams_process_cards_in_properties(JsonObject *properties, gchar **html,
	TeamsAccount *sa, PurpleConversation *conv, time_t msg_time, const gchar *msg_who)
{
	if (html == NULL) {
		return NULL;
	}

	if (json_object_has_member(properties, "cards")) {
		const gchar *cards_str = json_object_get_string_member(properties, "cards");
		JsonArray *cards = json_decode_array(cards_str, -1);
		GString *cards_string = g_string_new(NULL);
		guint i, len = json_array_get_length(cards);

		// webOS: a card message's body is an empty InputExtension placeholder span for the card; strip
		// it (and any now-empty <div> wrapper) so it doesn't render as a blank SECOND bubble beside the
		// card. Voice notes carry only this placeholder, so *html becomes empty -> no stray text bubble.
		if (*html && strstr(*html, "schema.skype.com/InputExtension")) {
			static GRegex *ie_re = NULL;
			gchar *stripped, *plain;
			if (ie_re == NULL)
				ie_re = g_regex_new("<span[^>]*schema\\.skype\\.com/InputExtension[^>]*>\\s*</span>",
					G_REGEX_CASELESS, 0, NULL);
			stripped = g_regex_replace(ie_re, *html, -1, 0, "", 0, NULL);
			if (stripped != NULL) {
				g_free(*html);
				*html = stripped;
			}
			plain = purple_markup_strip_html(*html);
			if (plain != NULL) {
				g_strstrip(plain);
				if (*plain == '\0') {
					g_free(*html);
					*html = g_strdup("");
				}
				g_free(plain);
			}
		}

		for(i = 0; i < len; i++) {
			JsonObject *card = json_array_get_object_element(cards, i);
			JsonObject *content = json_object_get_object_member(card, "content");
			const gchar *contentType = json_object_get_string_member(card, "contentType");

			// webOS: an audio/video/animation media card is a Teams voice note / media clip. Download the
			// media object authenticated (skype_token) and emit it as a playable file:// bubble
			// (teams_download_uri_to_conv -> teams_got_imagemessage does magic-byte ext detection incl
			// ogg/mp3/m4a/wav) instead of the bare "Media:<url>" text teams_convert_media_card_to_html
			// would render.
			if (sa != NULL && content != NULL &&
					(purple_strequal(contentType, "application/vnd.microsoft.card.audio") ||
					 purple_strequal(contentType, "application/vnd.microsoft.card.video") ||
					 purple_strequal(contentType, "application/vnd.microsoft.card.animation")) &&
					json_object_has_member(content, "media")) {
				// The 1:1 IM path runs this BEFORE it creates the conversation (conv is NULL here) and a
				// voice note's html body is empty, so the later emit block that would create the conv never
				// runs. Find/create the IM conv from the sender ourselves and download into it (mirrors the
				// RichText/UriObject image path); a group chat passes its chat conv in. Skip our own carbon
				// echo (the app already shows the outgoing bubble) so it isn't misfiled under the self id.
				PurpleConversation *target = conv;
				if (target == NULL && msg_who != NULL && *msg_who && !teams_is_user_self(sa, msg_who)) {
					PurpleIMConversation *imc = purple_conversations_find_im_with_account(msg_who, sa->account);
					if (imc == NULL)
						imc = purple_im_conversation_new(sa->account, msg_who);
					target = PURPLE_CONVERSATION(imc);
				}
				if (target != NULL) {
					JsonArray *media = json_object_get_array_member(content, "media");
					guint m, mlen = json_array_get_length(media);
					for (m = 0; m < mlen; m++) {
						JsonObject *media_item = json_array_get_object_element(media, m);
						const gchar *url = json_object_get_string_member(media_item, "url");
						if (url && *url) {
							teams_download_uri_to_conv(sa, url, target, msg_time, msg_who);
						}
					}
				}
				continue; // handled as a file:// download; no text html for this card
			}

			gchar *card_html = teams_convert_card_to_html(content, contentType);
			if (card_html == NULL) {
				// Couldn't process or unknown content type, dump the raw data
				card_html = teams_jsonobj_to_string(card);
			}
			g_string_append(cards_string, card_html);
			g_string_append(cards_string, "<br>");
			g_free(card_html);
		}
		
		json_array_unref(cards);
		
		gchar *temp = g_strconcat(*html ? *html : "", cards_string->str, NULL);
		g_free(*html);
		*html = temp;
		
		g_string_free(cards_string, TRUE);
	}
	
	return *html;

}

static gchar *
teams_clean_chat_name(TeamsAccount *sa, gchar *chatname)
{
	PurpleAccount *account = sa->account;
	gboolean should_collapse_threads = TRUE;
	
	should_collapse_threads = purple_account_get_bool(account, "should_collapse_threads", should_collapse_threads);
	
	//TODO allow a per-chat setting to not collapse
	if (should_collapse_threads) {
		gchar *qmark = strchr(chatname, ';');
		if (qmark != NULL) {
			*qmark = '\0';
		}
	}
	
	return chatname;
}

/* ------------------------------------------------------------------------------------
 * webOS reactions: Teams "emotion" <-> Unicode emoji mapping + emit/stash helpers.
 *
 * Teams/Skype consumer reactions are named "emotions": properties.emotions[] is an array
 * of { "key": <named reaction>, "users": [{ "mri", "time", "value" }, ...] }. The webOS
 * transport speaks Unicode emoji, so we translate both directions. Unknown keys/emoji are
 * skipped (return NULL) — robustness over completeness. Key names verified against the read
 * shape documented in process_message_resource() ("like","heart","laugh","sad","angry",
 * "surprised"); a few known Skype aliases fold onto the same emoji.
 * ------------------------------------------------------------------------------------ */
typedef struct {
	const gchar *key;      /* Teams emotion key */
	const gchar *emoji;    /* raw UTF-8 Unicode emoji - for the OUTGOING reverse lookup (app -> key) */
	const gchar *display;  /* HTML-entity form the Messaging app's emojify() renders - for the INCOMING
	                        * reaction-set. The transport's encodeAstralEntities() only encodes ASTRAL
	                        * code points, so a raw BMP emoji (U+2764 heart) survives raw and the app
	                        * shows nothing; emit the pre-encoded entity (incl. the U+FE0F VS16 the
	                        * picker uses for the heart) so ALL incoming reactions render. */
} TeamsEmotionMap;

static const TeamsEmotionMap teams_emotion_map[] = {
	{ "like",      "\xF0\x9F\x91\x8D", "&#128077;"        }, /* U+1F44D  thumbs up   */
	{ "yes",       "\xF0\x9F\x91\x8D", "&#128077;"        }, /* alias   -> thumbs up  */
	{ "heart",     "\xE2\x9D\xA4",     "&#10084;&#65039;" }, /* U+2764(+VS16) red heart - BMP: needs this */
	{ "love",      "\xE2\x9D\xA4",     "&#10084;&#65039;" }, /* alias   -> red heart   */
	{ "laugh",     "\xF0\x9F\x98\x86", "&#128518;"        }, /* U+1F606  laughing     */
	{ "cheeky",    "\xF0\x9F\x98\x86", "&#128518;"        }, /* alias   -> laughing    */
	{ "sad",       "\xF0\x9F\x98\xA2", "&#128546;"        }, /* U+1F622  crying        */
	{ "angry",     "\xF0\x9F\x98\xA0", "&#128544;"        }, /* U+1F620  angry         */
	{ "surprised", "\xF0\x9F\x98\xAE", "&#128558;"        }, /* U+1F62E  astonished    */
	{ "raiseHands", "\xF0\x9F\x99\x8F", "&#128591;"       }, /* U+1F64F folded hands (picker 🙏) */
	{ "applause",  "\xF0\x9F\x91\x8F", "&#128079;"        }, /* U+1F44F  clapping     */
};

static const gchar *
teams_emotion_key_to_emoji(const gchar *key)
{
	guint i;
	if (key == NULL)
		return NULL;
	for (i = 0; i < G_N_ELEMENTS(teams_emotion_map); i++) {
		if (g_ascii_strcasecmp(key, teams_emotion_map[i].key) == 0)
			return teams_emotion_map[i].emoji;
	}
	return NULL;
}

/* Incoming reactions: the HTML-entity form the Messaging app renders (see the .display note above). */
static const gchar *
teams_emotion_key_to_display(const gchar *key)
{
	guint i;
	if (key == NULL)
		return NULL;
	for (i = 0; i < G_N_ELEMENTS(teams_emotion_map); i++) {
		if (g_ascii_strcasecmp(key, teams_emotion_map[i].key) == 0)
			return teams_emotion_map[i].display;
	}
	return NULL;
}

static const gchar *
teams_emoji_to_emotion_key(const gchar *emoji)
{
	guint i;
	gchar *norm;
	const gchar *result = NULL;
	gsize len;

	if (emoji == NULL || !*emoji)
		return NULL;

	/* The app's reaction picker may append a VS16 (U+FE0F, "\xEF\xB8\x8F")
	 * emoji-presentation selector that our stored table entries omit; strip a trailing
	 * one before matching so "\xE2\x9D\xA4\xEF\xB8\x8F" still resolves to "heart". */
	norm = g_strdup(emoji);
	len = strlen(norm);
	if (len >= 3 && memcmp(norm + len - 3, "\xEF\xB8\x8F", 3) == 0)
		norm[len - 3] = '\0';

	for (i = 0; i < G_N_ELEMENTS(teams_emotion_map); i++) {
		const gchar *cand = teams_emotion_map[i].emoji;
		if (g_str_equal(norm, cand) || g_str_has_prefix(norm, cand)) {
			result = teams_emotion_map[i].key;
			break;
		}
	}
	g_free(norm);
	return result;
}

/* Stash resource["id"] on the conversation as "webos-msg-id" right before a serv_got_*
 * call. The webOS transport reads this in incoming_message_cb and records it as the
 * message's serviceMessageId, which is the key a later reaction (set) targets. Mirrors
 * tdlib-purple's receiving.cpp. No-op (and harmless) in non-webOS builds. */
static void
teams_stash_webos_msg_id(PurpleConversation *conv, JsonObject *resource)
{
	const gchar *sid;
	if (conv == NULL || resource == NULL || !json_object_has_member(resource, "id"))
		return;
	sid = json_object_get_string_member(resource, "id");
	if (sid && *sid) {
		purple_conversation_set_data(conv, "webos-msg-id", g_strdup(sid));
		purple_debug_info("teams", "webos: stashed msg-id %s on conv '%s'\n",
				sid, purple_conversation_get_name(conv));
	}
}

/* webOS replies: Teams embeds a reply as an inline <quote author authorname timestamp messageid ...>
 * block at the START of the message content/html. Extract the quoted original's author/text/id and stash
 * them on the conversation (like webos-msg-id) so the transport renders an inline quote card, and strip
 * the <quote>...</quote> block out of *html so only the reply body remains visible. No-op when there is
 * no leading quote. messageid matches the webos-msg-id format (resource["id"]). */
static void
teams_stash_webos_quote(PurpleConversation *conv, gchar **html)
{
	if (conv == NULL || html == NULL || *html == NULL)
		return;
	/* Teams personal wraps a reply as: <blockquote itemscope itemtype="http://schema.skype.com/Reply"
	 * itemid="<quoted msg id>"><strong itemprop="mri" itemid="<mri>">Author</strong>
	 * <span itemprop="time" .../><p itemprop="preview">quoted text</p></blockquote><p>reply body</p> */
	gchar *qstart = strstr(*html, "<blockquote");
	if (qstart == NULL)
		return;
	gchar *qend = strstr(qstart, "</blockquote>");
	if (qend == NULL)
		return;

	gsize quotelen = (qend - qstart) + strlen("</blockquote>");
	gchar *quotexml = g_strndup(qstart, quotelen);
	PurpleXmlNode *qnode = purple_xmlnode_from_str(quotexml, -1);
	g_free(quotexml);
	if (qnode != NULL) {
		const gchar *itemid = purple_xmlnode_get_attrib(qnode, "itemid"); /* the quoted message's id */
		PurpleXmlNode *strong = purple_xmlnode_get_child(qnode, "strong");
		PurpleXmlNode *preview = purple_xmlnode_get_child(qnode, "p");
		gchar *qfrom = strong ? purple_xmlnode_get_data(strong) : NULL;   /* author display name */
		gchar *qtext = preview ? purple_xmlnode_get_data(preview) : NULL; /* quoted text */
		if (qtext != NULL && *qtext != '\0') {
			for (gchar *p = qtext; *p != '\0'; p++) {
				if (*p == '\n' || *p == '\r')
					*p = ' ';
			}
			purple_conversation_set_data(conv, "webos-quoted-text", g_strdup(qtext));
			if (qfrom && *qfrom)
				purple_conversation_set_data(conv, "webos-quoted-from", g_strdup(qfrom));
			if (itemid && *itemid)
				purple_conversation_set_data(conv, "webos-quoted-id", g_strdup(itemid));
		}
		g_free(qfrom);
		g_free(qtext);
		purple_xmlnode_free(qnode);
	}

	/* strip the quote block: keep only the reply body after </blockquote> */
	gchar *body = g_strdup(qend + strlen("</blockquote>"));
	g_strchug(body);
	g_free(*html);
	*html = body;
}

#define TEAMS_MAX_QUOTE_CACHE 400

/* webOS replies: remember an incoming message's author/timestamp/conversation + plain text keyed by its
 * id, so a later outgoing reply targeting that id can rebuild the full Teams <quote> block. */
static void
teams_cache_quote_meta(TeamsAccount *sa, JsonObject *resource, const gchar *plaintext)
{
	if (sa == NULL || sa->quote_meta_hash == NULL || resource == NULL || !json_object_has_member(resource, "id"))
		return;
	const gchar *id = json_object_get_string_member(resource, "id");
	if (id == NULL || !*id)
		return;
	const gchar *from = json_object_has_member(resource, "from") ? json_object_get_string_member(resource, "from") : "";
	const gchar *composetime = json_object_has_member(resource, "composetime") ? json_object_get_string_member(resource, "composetime") : "";
	const gchar *conv = json_object_has_member(resource, "conversationLink") ? json_object_get_string_member(resource, "conversationLink") : "";
	const gchar *authorname = json_object_has_member(resource, "imdisplayname") ? json_object_get_string_member(resource, "imdisplayname") : NULL;
	if (authorname == NULL && json_object_has_member(resource, "imDisplayName"))
		authorname = json_object_get_string_member(resource, "imDisplayName");
	/* `from` is a URL like ".../contacts/8:orgid:GUID"; keep only the MRI tail (last path element). */
	const gchar *frommri = from ? from : "";
	if (from != NULL) {
		const gchar *slash = strrchr(from, '/');
		if (slash != NULL)
			frommri = slash + 1;
	}

	gchar *plain = plaintext ? purple_markup_strip_html(plaintext) : g_strdup("");
	if (plain == NULL)
		plain = g_strdup("");
	for (gchar *p = plain; *p != '\0'; p++) {
		if (*p == '\n' || *p == '\r' || *p == '\x1f')
			*p = ' ';
	}
	gchar *val = g_strdup_printf("%s\x1f%s\x1f%s\x1f%s\x1f%s", frommri, authorname ? authorname : "",
			composetime ? composetime : "", conv ? conv : "", plain);
	g_free(plain);

	if (g_hash_table_size(sa->quote_meta_hash) >= TEAMS_MAX_QUOTE_CACHE)
		g_hash_table_remove_all(sa->quote_meta_hash);
	g_hash_table_insert(sa->quote_meta_hash, g_strdup(id), val);
}

/* webOS replies: build the inline <quote ...> block Teams expects for a reply to `target_id`, using the
 * metadata cached by teams_cache_quote_meta. Returns a newly-allocated string, or NULL if the target
 * isn't cached (then we just send a normal message). */
static gchar *
teams_build_quote_block(TeamsAccount *sa, const gchar *target_id)
{
	if (sa == NULL || sa->quote_meta_hash == NULL || target_id == NULL || !*target_id)
		return NULL;
	const gchar *meta = g_hash_table_lookup(sa->quote_meta_hash, target_id);
	if (meta == NULL)
		return NULL;
	gchar **parts = g_strsplit(meta, "\x1f", 5); /* 0=authorMRI 1=authorname 2=composetime 3=conversation 4=plaintext */
	gchar *mri_esc = g_markup_escape_text(parts[0] ? parts[0] : "", -1);
	gchar *authorname_esc = g_markup_escape_text(parts[1] ? parts[1] : "", -1);
	gchar *text_esc = g_markup_escape_text((parts[4]) ? parts[4] : "", -1);
	/* Match the exact Teams-personal reply markup so the message threads on other clients. */
	gchar *block = g_strdup_printf(
		"<blockquote itemscope=\"\" itemtype=\"http://schema.skype.com/Reply\" itemid=\"%s\">"
		"<strong itemprop=\"mri\" itemid=\"%s\">%s</strong>"
		"<span itemprop=\"time\" itemid=\"%s\"></span>"
		"<p itemprop=\"preview\">%s</p>"
		"</blockquote>",
		target_id, mri_esc, authorname_esc, target_id, text_esc);
	g_free(mri_esc);
	g_free(authorname_esc);
	g_free(text_esc);
	g_strfreev(parts);
	return block;
}

/* Turn a message's aggregated properties.emotions[] into the transport's
 * "count<SP>emoji\n..." set and emit "webos-im-reaction-set" (an aggregated REPLACE keyed
 * by the message's service id). An empty serialization clears all reactions (last one
 * removed). Skips emotions with an unknown key or zero users. */
static void
teams_emit_reaction_set(TeamsAccount *sa, const gchar *msgid, JsonArray *emotions)
{
	GString *serialized;
	guint i, len;

	if (sa == NULL || msgid == NULL || !*msgid)
		return;

	serialized = g_string_new("");
	len = emotions ? json_array_get_length(emotions) : 0;
	for (i = 0; i < len; i++) {
		JsonObject *emotion = json_array_get_object_element(emotions, i);
		const gchar *key = json_object_get_string_member(emotion, "key");
		/* Emit the app-renderable HTML-entity form (.display), NOT the raw UTF-8 (.emoji): the
		 * transport doesn't encode BMP emoji, so a raw heart (U+2764) would never render. */
		const gchar *emoji = teams_emotion_key_to_display(key);
		JsonArray *users = json_object_has_member(emotion, "users")
			? json_object_get_array_member(emotion, "users") : NULL;
		guint count = users ? json_array_get_length(users) : 0;

		if (emoji == NULL || count == 0)
			continue; /* unknown reaction or nobody -> skip */
		g_string_append_printf(serialized, "%u %s\n", count, emoji);
	}

	purple_debug_info("teams", "webos: reaction-set on msg %s -> [%s]\n",
			msgid, serialized->str);
	purple_signal_emit(purple_conversations_get_handle(), "webos-im-reaction-set",
		sa->account, msgid, serialized->str, (const gchar *)NULL);
	g_string_free(serialized, TRUE);
}

/* webOS reactions (trouter REAL-TIME): Teams pushes a live reaction as a "reactionInChat"
 * activity (properties.activity of a NewMessage/MessageUpdate on the notifications stream),
 * NOT as properties.emotions[] (which only the offline-history poll carries). activityContext
 * holds the FULL aggregated per-emotion counts (e.g. {"heart":"1","like":"1", <metadata>...}),
 * so map the known emotion keys to the app's emoji and emit the same aggregated
 * webos-im-reaction-set the emotions[] path uses, keyed by the reacted message's sourceMessageId.
 * Unknown keys (WebhookCorrelationId, realm, ...) are skipped. Empty set clears all reactions. */
static void
teams_process_reaction_activity(TeamsAccount *sa, JsonObject *activity)
{
	GString *serialized;
	gchar *msgid;
	JsonObject *ctx;
	gint64 sid;

	if (sa == NULL || activity == NULL || !json_object_has_member(activity, "sourceMessageId"))
		return;
	sid = json_object_get_int_member(activity, "sourceMessageId");
	if (sid == 0)
		return;
	msgid = g_strdup_printf("%" G_GINT64_FORMAT, sid);

	serialized = g_string_new("");
	ctx = json_object_has_member(activity, "activityContext")
		? json_object_get_object_member(activity, "activityContext") : NULL;
	if (ctx != NULL) {
		GList *keys = json_object_get_members(ctx), *it;
		for (it = keys; it; it = it->next) {
			const gchar *key = it->data;
			const gchar *display = teams_emotion_key_to_display(key);
			const gchar *cntstr;
			guint count;
			if (display == NULL)
				continue; /* metadata key, not an emotion */
			cntstr = json_object_get_string_member(ctx, key);
			count = cntstr ? (guint) g_ascii_strtoull(cntstr, NULL, 10) : 0;
			if (count == 0)
				continue;
			g_string_append_printf(serialized, "%u %s\n", count, display);
		}
		g_list_free(keys);
	}

	purple_debug_info("teams", "webos: reactionInChat on msg %s -> [%s]\n", msgid, serialized->str);
	purple_signal_emit(purple_conversations_get_handle(), "webos-im-reaction-set",
		sa->account, msgid, serialized->str, (const gchar *)NULL);
	g_string_free(serialized, TRUE);
	g_free(msgid);
}

static void
process_message_resource(TeamsAccount *sa, JsonObject *resource)
{
	// webOS: bail if this is a late handler for an account freed by a re-login flap (checked by
	// pointer, no deref) -- otherwise the dedup hash access below floods NULL-hash criticals and hangs.
	if (!teams_account_is_live(sa))
		return;

	const gchar *clientmessageid = NULL;
	const gchar *skypeeditedid = NULL;
	const gchar *messagetype = json_object_get_string_member(resource, "messagetype");
	const gchar *from = json_object_get_string_member(resource, "from");
	const gchar *content = NULL;
	const gchar *composetime = json_object_get_string_member(resource, "composetime");
	const gchar *conversationLink = json_object_get_string_member(resource, "conversationLink");
	time_t composetimestamp = purple_str_to_time(composetime, TRUE, NULL, NULL, NULL);
	gchar **messagetype_parts;
	PurpleConversation *conv = NULL;
	gchar *convname = NULL;
	const gchar *chatname = NULL;
	JsonObject *properties = NULL;
	
	g_return_if_fail(messagetype != NULL);

	messagetype_parts = g_strsplit(messagetype, "/", -1);
	
	if (json_object_has_member(resource, "clientmessageid"))
		clientmessageid = json_object_get_string_member(resource, "clientmessageid");
	
	if (clientmessageid && *clientmessageid && g_hash_table_remove(sa->sent_messages_hash, clientmessageid)) {
		// We sent this message from here already.
		// webOS reactions (react-to-own-sent): the echo carries the real server "id" for the
		// message the user just sent from the app. Its Outbox row was persisted with no
		// serviceMessageId (the app can't know it at send time), so hand the transport the id
		// + text; OutboxIdHandler attaches it so the user can react to their own message.
		if (json_object_has_member(resource, "id")) {
			const gchar *sent_id = json_object_get_string_member(resource, "id");
			const gchar *sent_text = json_object_has_member(resource, "content")
				? json_object_get_string_member(resource, "content") : "";
			if (sent_id && *sent_id) {
				purple_signal_emit(purple_conversations_get_handle(), "webos-im-outbox-id",
					sa->account, sent_id, sent_text ? sent_text : "");
				// webOS replies: cache our OWN app-sent message (keyed by its server id) so a later
				// reply TO it can rebuild the <quote> block. This echo is deduped + returned below, so
				// it never reaches the normal cache sites - cache it here.
				teams_cache_quote_meta(sa, resource, sent_text);
			}
		}
		g_strfreev(messagetype_parts);
		return;
	}

	/* Personal/TFL: dedup so the periodic message poll (and offline-history
	 * catch-up) never re-delivers a message the user has already seen. Consumer
	 * (Teams-for-Life) messages carry no usable top-level "id" — they are keyed by a
	 * numeric "sequenceId" — so we build the dedup key from sequenceId (falling back
	 * to "id"). The key includes an edit marker (skypeeditedid / properties.edittime)
	 * so genuine edits still get through as fresh updates. */
	{
		gchar *dedup_id = NULL;
		if (json_object_has_member(resource, "sequenceId")) {
			gint64 seq = json_object_get_int_member(resource, "sequenceId");
			if (seq != 0)
				dedup_id = g_strdup_printf("%" G_GINT64_FORMAT, seq);
		}
		if (dedup_id == NULL && json_object_has_member(resource, "id")) {
			const gchar *sid = json_object_get_string_member(resource, "id");
			if (sid && *sid)
				dedup_id = g_strdup(sid);
		}
		if (dedup_id != NULL) {
			const gchar *edit_marker = NULL;
			if (json_object_has_member(resource, "skypeeditedid"))
				edit_marker = json_object_get_string_member(resource, "skypeeditedid");
			if ((!edit_marker || !*edit_marker) && json_object_has_member(resource, "properties")) {
				JsonObject *dedup_props = json_object_get_object_member(resource, "properties");
				if (dedup_props && json_object_has_member(dedup_props, "edittime"))
					edit_marker = json_object_get_string_member(dedup_props, "edittime");
			}
			gchar *dedup_key = g_strdup_printf("%s|%s", dedup_id, edit_marker ? edit_marker : "");
			g_free(dedup_id);
			if (g_hash_table_contains(sa->received_messages_hash, dedup_key)) {
				g_free(dedup_key);
				g_strfreev(messagetype_parts);
				return;
			}
			/* Bound the cache: the poll advances its cursor, so keys older than the
			 * current re-fetch window are never looked up again. Once it grows past the
			 * cap, drop the lot — worst case a very old message could be re-shown once. */
			if (g_hash_table_size(sa->received_messages_hash) >= TEAMS_MAX_DEDUP_CACHE)
				g_hash_table_remove_all(sa->received_messages_hash);
			g_hash_table_add(sa->received_messages_hash, dedup_key);
		}
	}
	
	if (json_object_has_member(resource, "skypeeditedid")) {
		skypeeditedid = json_object_get_string_member(resource, "skypeeditedid");
	}
	if (json_object_has_member(resource, "properties")) {
		properties = json_object_get_object_member(resource, "properties");

		/* webOS reactions (trouter real-time): a live reaction arrives as a "reactionInChat"
		 * activity on the notifications stream, with an EMPTY content body. Emit it as a reaction
		 * and STOP - otherwise it falls through as a blank Text message (all we did before was
		 * stash its msg-id). The offline-history poll separately carries properties.emotions[]. */
		if (json_object_has_member(properties, "activity")) {
			JsonObject *activity = json_object_get_object_member(properties, "activity");
			if (purple_strequal(json_object_get_string_member(activity, "activityType"), "reactionInChat")) {
				teams_process_reaction_activity(sa, activity);
				g_strfreev(messagetype_parts);
				return;
			}
		}

		if (json_object_has_member(properties, "edittime")) {
			skypeeditedid = json_object_get_string_member(properties, "edittime");
		}
		
		//TODO use "importance" for nudges
		//purple_prpl_got_attention(pc, username, 0);
		//purple_prpl_got_attention_in_chat(pc, id, username, 0);
		
		if (json_object_has_member(properties, "deletetime")) {
			// Deleted a message
		}
		
		if (json_object_has_member(properties, "emotions")) {
			// "emotions": [{
					// "key": "heart",
					// "users": []
				// }, {
					// "key": "like",
					// "users": [{
						// "mri": "8:orgid:{...guid...}",
						// "time": 1668285027384,
						// "value": "1668285027230"
					// }]
				// }]
		}

		if (json_object_has_member(properties, "botCitations")) {
			// "botCitations": [{
				// "id": 1,
				// "title": "cited document.docx",
				// "excerpt": "this is the part of text that has been cited"
			// }]
		}

		// other properties:
		// * mentions
		// * cards
		// * importance
		// * subject
		// * title
		// * links
		// * files
		// * botPoweredByAI true/false
		// * botFeedbackLoopEnabled true/false
	}
	
	if (json_object_has_member(resource, "content")) {
		content = json_object_get_string_member(resource, "content");
	}
	
	if (conversationLink) {
		chatname = teams_thread_url_to_name(conversationLink);
		convname = g_strdup(chatname);
	}

#ifdef TEAMS_WEBOS
	/* webOS Teams port: cross-login dedup. received_messages_hash (the in-session
	 * dedup above) is rebuilt empty on every login, so the offline-history / history-days
	 * re-fetch that runs at each login would re-insert every already-seen message into
	 * the webOS Messaging DB (each with a fresh arrival time). Persist a per-conversation
	 * high-water mark on the monotonic per-conversation "sequenceId" and drop any non-edit
	 * message at or below it. Edits (skypeeditedid / properties.edittime set) always pass
	 * through so genuine message updates still appear. Stored as a string to survive
	 * sequenceId values beyond 32 bits. */
	if (convname && (!skypeeditedid || !*skypeeditedid)
			&& json_object_has_member(resource, "sequenceId")) {
		gint64 seq = json_object_get_int_member(resource, "sequenceId");
		if (seq != 0) {
			gchar *seqkey = g_strdup_printf("%s_lastseq", convname);
			gint64 prev_seq = g_ascii_strtoll(
				purple_account_get_string(sa->account, seqkey, "0"), NULL, 10);
			if (seq <= prev_seq) {
				g_free(seqkey);
				g_free(convname);
				g_strfreev(messagetype_parts);
				return;
			}
			gchar *seqval = g_strdup_printf("%" G_GINT64_FORMAT, seq);
			purple_account_set_string(sa->account, seqkey, seqval);
			g_free(seqval);
			g_free(seqkey);
		}
	}
#endif /* TEAMS_WEBOS */

	if (chatname && !g_hash_table_lookup(sa->chat_to_buddy_lookup, chatname)
			&& !strstr(chatname, "@unq.gbl.spaces") && !strstr(chatname, "@oneToOne.skype")) {
		// This is a Thread/Group chat message
		const gchar *topic;
		PurpleChatConversation *chatconv;
		
		//Turn threaded group chats into unthreaded ones, as required
		chatname = teams_clean_chat_name(sa, convname);
		
		chatconv = purple_conversations_find_chat_with_account(chatname, sa->account);
		if (!chatconv) {
			chatconv = purple_serv_got_joined_chat(sa->pc, g_str_hash(chatname), chatname);
			purple_conversation_set_data(PURPLE_CONVERSATION(chatconv), "chatname", g_strdup(chatname));

			if (json_object_has_member(resource, "threadtopic")) {
				topic = json_object_get_string_member(resource, "threadtopic");
				purple_chat_conversation_set_topic(chatconv, NULL, topic);
			}
			
			teams_get_conversation_history(sa, chatname);
			teams_get_thread_users(sa, chatname);
		}
		GString *chat_last_timestamp = make_last_timestamp_setting(convname);
		purple_account_set_int(sa->account, chat_last_timestamp->str, composetimestamp);
		g_string_free(chat_last_timestamp, TRUE);

		conv = PURPLE_CONVERSATION(chatconv);

		// webOS reactions: stash this message's service id on the chat conv so the transport
		// records it as serviceMessageId for every serv_got_chat_in below; a later reaction
		// (set) update targets it by resource["id"].
		teams_stash_webos_msg_id(conv, resource);

		if (g_str_equal(messagetype_parts[0], "Control") && (g_str_equal(messagetype_parts[1], "ClearTyping") || g_str_equal(messagetype_parts[1], "Typing"))) {
			PurpleChatUserFlags cbflags;
			PurpleChatUser *cb;

			from = teams_contact_url_to_name(from);
			if (from == NULL) {
				g_free(convname);
				g_strfreev(messagetype_parts);
				g_return_if_reached();
				return;
			}
			
			cb = purple_chat_conversation_find_user(chatconv, from);
			if (cb != NULL) {
				cbflags = purple_chat_user_get_flags(cb);
				
				if (g_str_equal(messagetype_parts[1], "Typing")) {
					cbflags |= PURPLE_CHAT_USER_TYPING;
				} else {
					// ClearTyping
					cbflags &= ~PURPLE_CHAT_USER_TYPING;
				}
				
				purple_chat_user_set_flags(cb, cbflags);
				
				//TODO clear typing after 22 seconds
			}
			
		} else if (g_str_equal(messagetype_parts[0], "RichText") || g_str_equal(messagetype_parts[0], "Text")) {
			gchar *html = NULL;
			gint64 skypeemoteoffset = 0;
			PurpleChatUserFlags cbflags;
			PurpleChatUser *cb; 
			
			from = teams_contact_url_to_name(from);
			if (from == NULL) {
				g_free(convname);
				g_strfreev(messagetype_parts);
				g_return_if_reached();
				return;
			}

			// Hard reset cbflags even if user changed settings while someone typing message.
			cb = purple_chat_conversation_find_user(chatconv, from);
			if (cb != NULL) {
				cbflags = purple_chat_user_get_flags(cb);
				
				cbflags &= ~PURPLE_CHAT_USER_TYPING;
				
				purple_chat_user_set_flags(cb, cbflags);
			
			} else {
				purple_chat_conversation_add_user(chatconv, from, NULL, PURPLE_CHAT_USER_NONE, FALSE);
				cb = purple_chat_conversation_find_user(chatconv, from);
			}

			if (json_object_has_member(resource, "imdisplayname") || json_object_has_member(resource, "imDisplayName")) {
				const gchar *displayname = json_object_get_string_member(resource, "imdisplayname");
				if (displayname == NULL) {
					displayname = json_object_get_string_member(resource, "imDisplayName");
				}
				
				if (cb && displayname && *displayname && !g_str_has_prefix(displayname, "orgid:")) {
					purple_chat_user_set_alias(cb, displayname);
				}
			}
			
			if (g_str_equal(messagetype, "RichText/UriObject")) {
				PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
				const gchar *uri = purple_xmlnode_get_attrib(blob, "url_thumbnail");
				
				if (from && *from) {
					teams_download_uri_to_conv(sa, uri, conv, composetimestamp, from);
				}
				purple_xmlnode_free(blob);
				
				g_free(convname);
				g_strfreev(messagetype_parts);
				return;
				
			} else if (purple_strequal(messagetype, "RichText/Media_Card")) {
				gboolean message_processed = FALSE;
				PurpleXmlNode *uriobject = purple_xmlnode_from_str(content, -1);
				const gchar *uriobject_type = purple_xmlnode_get_attrib(uriobject, "type");
				
				if (purple_strequal(purple_xmlnode_get_name(uriobject), "URIObject") && purple_strequal(uriobject_type, "SWIFT.1")) {
					PurpleXmlNode *swift = purple_xmlnode_get_child(uriobject, "Swift");
					const gchar *swift_b64 = purple_xmlnode_get_attrib(swift, "b64");
					gsize swift_b64_len;
					guchar *swift_data = purple_base64_decode(swift_b64, &swift_b64_len);
					JsonObject *swift_json = json_decode_object((const gchar *)swift_data, swift_b64_len);
					JsonArray *swift_attachments = json_object_get_array_member(swift_json, "attachments");
					guint i, len = json_array_get_length(swift_attachments);

					//Process JSON blob of a Card into something vaguely HTML
					
					if (swift_json == NULL || swift_attachments == NULL) {
						// Couldn't process, dump the raw data
						html = purple_markup_escape_text((gchar *)swift_data, swift_b64_len);
						purple_serv_got_chat_in(sa->pc, g_str_hash(chatname), from, teams_is_user_self(sa, from) ? PURPLE_MESSAGE_SEND : PURPLE_MESSAGE_RECV, html, composetimestamp);
						g_free(html);
					} else {
						for(i = 0; i < len; i++) {
							JsonObject *attachment = json_array_get_object_element(swift_attachments, i);
							JsonObject *content = json_object_get_object_member(attachment, "content");
							const gchar *contentType = json_object_get_string_member(attachment, "contentType");

							html = teams_convert_card_to_html(content, contentType);
							if (html == NULL) {
								// Couldn't process or unknown content type, dump the raw data
								html = teams_jsonobj_to_string(content);
							}
					
							purple_serv_got_chat_in(sa->pc, g_str_hash(chatname), from, teams_is_user_self(sa, from) ? PURPLE_MESSAGE_SEND : PURPLE_MESSAGE_RECV, html, composetimestamp);
							
							g_free(html);
						}
					}
					
					html = NULL;
					g_free(swift_data);
					json_object_unref(swift_json);
					message_processed = TRUE;
				}
				
				purple_xmlnode_free(uriobject);
				if (message_processed) {
					g_free(convname);
					g_strfreev(messagetype_parts);
					return;
				}
			} else if (purple_strequal(messagetype, "RichText/Media_CallRecording") ||
						purple_strequal(messagetype, "RichText/Media_LocalRecording")) {
				PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
				PurpleXmlNode *recordingStatus = purple_xmlnode_get_child(blob, "RecordingStatus");

				if (recordingStatus) {
					const gchar *recordingStatusValue = purple_xmlnode_get_attrib(recordingStatus, "status");
					if (recordingStatusValue && *recordingStatusValue) {
						if (purple_strequal(recordingStatusValue, "Initial")) {
							html = g_strconcat("<b>", _("Call recording"), "</b>: ", _("Started"), NULL);

						} else if (purple_strequal(recordingStatusValue, "ChunkFinished")) {
							html = g_strconcat("<b>", _("Call recording"), "</b>: ", _("Processing"), NULL);

						} else if (purple_strequal(recordingStatusValue, "Success")) {
							PurpleXmlNode *title = purple_xmlnode_get_child(blob, "Title");
							PurpleXmlNode *link = purple_xmlnode_get_child(blob, "a");
							PurpleXmlNode *originalName = purple_xmlnode_get_child(blob, "OriginalName");
							gchar *titleValue = purple_xmlnode_get_data(title);
							const gchar *linkHref = purple_xmlnode_get_attrib(link, "href");
							const gchar *originalNameValue = purple_xmlnode_get_attrib(originalName, "v");

							html = g_strconcat("<h2>", titleValue ? titleValue : "", "</h2><br/><b>", _("Call recording"), "</b>: ", _("Success"), " - <a href=\"", linkHref ? linkHref : "#", "\">", originalNameValue ? originalNameValue : "Recording.mp4", "</a>", NULL);

							g_free(titleValue);
						} else {
							purple_debug_error("teams", "Unknown recording status: %s\n", recordingStatusValue);
							html = g_strconcat("<b>", _("Call recording"), "</b>: ", recordingStatusValue, NULL);
						}

						purple_serv_got_chat_in(sa->pc, g_str_hash(chatname), from, PURPLE_MESSAGE_RECV, html, composetimestamp);
						g_free(html);
						html = NULL;
					}
				}
				purple_xmlnode_free(blob);
				
				g_free(convname);
				g_strfreev(messagetype_parts);
				return;
			} else if (purple_strequal(messagetype, "RichText/Media_CallTranscript")) {
				html = g_strdup(_("Transcript is available"));
				purple_serv_got_chat_in(sa->pc, g_str_hash(chatname), from, PURPLE_MESSAGE_RECV, html, composetimestamp);
				g_free(html);
				html = NULL;
			}
			
			if (json_object_has_member(resource, "skypeemoteoffset")) {
				skypeemoteoffset = g_ascii_strtoll(json_object_get_string_member(resource, "skypeemoteoffset"), NULL, 10);
			}
			
			if (content && *content) {
				if (g_str_equal(messagetype, "Text")) {
					gchar *temp = teams_meify(content, skypeemoteoffset);
					html = purple_markup_escape_text(temp, -1);
					g_free(temp);
				} else {
					html = teams_meify(content, skypeemoteoffset);
				}

				if (skypeeditedid && *skypeeditedid) {
					gchar *temp = g_strconcat(_("Edited: "), html, NULL);
					g_free(html);
					html = temp;
				}
			}
				
			if (properties != NULL) {
				if (json_object_has_member(properties, "deletetime")) {
					g_free(html);
					html = g_strconcat("<b>", _("User deleted their message"), "</b>", NULL);
				}
				
				if (json_object_has_member(properties, "emotions")) {
					// webOS reactions: emit the aggregated reaction set (keyed by the message
					// service id) instead of flattening it into a chat text message.
					JsonArray *emotions = json_object_get_array_member(properties, "emotions");
					const gchar *msgid = json_object_has_member(resource, "id")
						? json_object_get_string_member(resource, "id") : NULL;
					teams_emit_reaction_set(sa, msgid, emotions);

					g_free(html);
					html = NULL; /* don't also render the reaction as a chat message */

				} else {
					html = teams_process_files_in_properties(properties, &html);
					html = teams_process_cards_in_properties(properties, &html, sa, conv, composetimestamp, from);

				}
			}
			
			if (html != NULL && *html) {
				teams_find_incoming_img(sa, conv, composetimestamp, from, &html);
				// webOS replies: stash the inline <quote> on the chat conv (webos-msg-id was stashed on it
				// above) and strip it from the visible body so only the reply text shows.
				teams_stash_webos_quote(conv, &html);
				teams_cache_quote_meta(sa, resource, html);
				purple_serv_got_chat_in(sa->pc, g_str_hash(chatname), from, teams_is_user_self(sa, from) ? PURPLE_MESSAGE_SEND : PURPLE_MESSAGE_RECV, html, composetimestamp);
				
				g_free(html);
			}
			
		} else if (g_str_equal(messagetype, "ThreadActivity/AddMember")) {
			PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
			PurpleXmlNode *target;
			for(target = purple_xmlnode_get_child(blob, "target"); target;
				target = purple_xmlnode_get_next_twin(target))
			{
				gchar *user = purple_xmlnode_get_data(target);
				const gchar *username = user;
				username = teams_strip_user_prefix(username);
				
				if (!purple_chat_conversation_find_user(chatconv, username))
					purple_chat_conversation_add_user(chatconv, username, NULL, PURPLE_CHAT_USER_NONE, TRUE);
				g_free(user);
			}
			purple_xmlnode_free(blob);
		} else if (g_str_equal(messagetype, "ThreadActivity/MemberJoined")) {
			JsonObject *info = json_decode_object(content, -1);
			JsonArray *members = json_object_get_array_member(info, "members");
			guint i, len = json_array_get_length(members);
			PurpleGroup *group = teams_get_blist_group(sa);
			
			for(i = 0; i < len; i++)
			{
				JsonObject *member = json_array_get_object_element(members, i);
				const gchar *username = json_object_get_string_member(member, "id");
				username = teams_strip_user_prefix(username);
				
				if (!purple_chat_conversation_find_user(chatconv, username)) {
					const gchar *friendlyname = json_object_get_string_member(member, "friendlyname");
					const gchar *meetingMemberType = json_object_get_string_member(member, "meetingMemberType");

					if (friendlyname == NULL) {
						friendlyname = json_object_get_string_member(resource, "friendlyName");
					}
					
					if (friendlyname && *friendlyname && !g_str_has_prefix(friendlyname, "orgid:")) {
						PurpleBuddy *buddy = purple_blist_find_buddy(sa->account, username);
						const gchar *local_alias;
						
						if (buddy == NULL) {
							purple_buddy_new(sa->account, username, NULL);
							if (purple_strequal(meetingMemberType, "temp")) {
								purple_blist_node_set_transient(PURPLE_BLIST_NODE(buddy), TRUE);
							}
							purple_blist_add_buddy(buddy, NULL, group, NULL);
						}
						
						local_alias = purple_buddy_get_local_alias(buddy);
						if (!local_alias || !*local_alias) {
							purple_serv_got_alias(sa->pc, username, friendlyname);
						}
					}
					
					purple_chat_conversation_add_user(chatconv, username, NULL, PURPLE_CHAT_USER_NONE, TRUE);
				}
			}
			
			json_object_unref(info);
			
		} else if (g_str_equal(messagetype, "ThreadActivity/MemberLeft")) {
			JsonObject *info = json_decode_object(content, -1);
			JsonArray *members = json_object_get_array_member(info, "members");
			guint i, len = json_array_get_length(members);
			PurpleGroup *group = teams_get_blist_group(sa);
			
			for(i = 0; i < len; i++)
			{
				JsonObject *member = json_array_get_object_element(members, i);
				const gchar *username = json_object_get_string_member(member, "id");
				username = teams_strip_user_prefix(username);
				
				// Add them to the buddy list so they have a nice 'left the room' message
				const gchar *friendlyname = json_object_get_string_member(member, "friendlyname");
				const gchar *meetingMemberType = json_object_get_string_member(member, "meetingMemberType");
				
				if (friendlyname == NULL) {
					friendlyname = json_object_get_string_member(resource, "friendlyName");
				}
				
				if (friendlyname && *friendlyname && !g_str_has_prefix(friendlyname, "orgid:")) {
					PurpleBuddy *buddy = purple_blist_find_buddy(sa->account, username);
					const gchar *local_alias;
					
					if (buddy == NULL) {
						purple_buddy_new(sa->account, username, NULL);
						if (purple_strequal(meetingMemberType, "temp")) {
							purple_blist_node_set_transient(PURPLE_BLIST_NODE(buddy), TRUE);
						}
						purple_blist_add_buddy(buddy, NULL, group, NULL);
					}
					
					local_alias = purple_buddy_get_local_alias(buddy);
					if (!local_alias || !*local_alias) {
						purple_serv_got_alias(sa->pc, username, friendlyname);
					}
				}
				
				if (teams_is_user_self(sa, username))
					purple_chat_conversation_leave(chatconv);
				purple_chat_conversation_remove_user(chatconv, username, NULL);
			}
			
			json_object_unref(info);
			
		} else if (g_str_equal(messagetype, "ThreadActivity/DeleteMember")) {
			PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
			PurpleXmlNode *target;
			for(target = purple_xmlnode_get_child(blob, "target"); target;
				target = purple_xmlnode_get_next_twin(target))
			{
				gchar *user = purple_xmlnode_get_data(target);
				const gchar *username = user;
				username = teams_strip_user_prefix(username);
				
				if (teams_is_user_self(sa, username))
					purple_chat_conversation_leave(chatconv);
				purple_chat_conversation_remove_user(chatconv, username, NULL);
				g_free(user);
			}
			purple_xmlnode_free(blob);
		} else if (g_str_equal(messagetype, "ThreadActivity/TopicUpdate")) {
			PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
			gchar *initiator = purple_xmlnode_get_data(purple_xmlnode_get_child(blob, "initiator"));
			const gchar *username = initiator;
			gchar *value = purple_xmlnode_get_data(purple_xmlnode_get_child(blob, "value"));
			
			username = teams_strip_user_prefix(username);
			purple_chat_conversation_set_topic(chatconv, username, value);
			purple_conversation_update(conv, PURPLE_CONVERSATION_UPDATE_TOPIC);
				
			g_free(initiator);
			g_free(value);
			purple_xmlnode_free(blob);
		} else if (g_str_equal(messagetype, "ThreadActivity/RoleUpdate")) {
			PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
			PurpleXmlNode *target;
			PurpleChatUser *cb;
			
			for(target = purple_xmlnode_get_child(blob, "target"); target;
				target = purple_xmlnode_get_next_twin(target))
			{
				gchar *user = purple_xmlnode_get_data(purple_xmlnode_get_child(target, "id"));
				gchar *role = purple_xmlnode_get_data(purple_xmlnode_get_child(target, "role"));
				PurpleChatUserFlags cbflags = PURPLE_CHAT_USER_NONE;
				const gchar *username = user;
				username = teams_strip_user_prefix(username);
				
				if (role && *role) {
					if (g_str_equal(role, "Admin") || g_str_equal(role, "admin")) {
						cbflags = PURPLE_CHAT_USER_OP;
					} else if (g_str_equal(role, "User") || g_str_equal(role, "user")) {
						cbflags = PURPLE_CHAT_USER_VOICE;
					}
				}
				#if !PURPLE_VERSION_CHECK(3, 0, 0)
					purple_conv_chat_user_set_flags(chatconv, username, cbflags);
					(void) cb;
				#else
					cb = purple_chat_conversation_find_user(chatconv, username);
					purple_chat_user_set_flags(cb, cbflags);
				#endif
				g_free(user);
				g_free(role);
			} 
			
			purple_xmlnode_free(blob);
		} else if (g_str_equal(messagetype, "Event/Call")) {
			//"content": "<ended/><partlist
			//"content": "<partlist alt =\"\"></partlist>",
			PurpleXmlNode *partlist = purple_xmlnode_from_str(content, -1);
			gchar *message = NULL;
			
			from = teams_contact_url_to_name(from);
			
			if (content == NULL || strstr(content, "<ended/>")) {
				message = g_strdup(_("Call ended"));
			} else {
				const gchar *count = purple_xmlnode_get_attrib(partlist, "count");
				if (!count) {
					// Add join link:  https://teams.microsoft.com/l/meetup-join/{convID}/0
					message = g_strconcat(_("Call started"), " - <a href=\"https://", TEAMS_BASE_ORIGIN_HOST, "/l/meetup-join/", purple_url_encode(chatname), "/0\">", _("Join Teams Meeting"), "</a>", NULL);
				} else {
					// someone left
				}
			}
			
			purple_xmlnode_free(partlist);
			
			purple_serv_got_chat_in(sa->pc, g_str_hash(chatname), from, PURPLE_MESSAGE_SYSTEM, message, composetimestamp);
		
			g_free(message);
		} else {
			purple_debug_warning("teams", "Unhandled thread message resource messagetype '%s'\n", messagetype);
		}
		
	} else {
		gchar *convbuddyname;
		// This is a One-to-one/IM message
		
		from = teams_contact_url_to_name(from);
		if (from == NULL) {
			g_free(convname);
			g_strfreev(messagetype_parts);
			g_return_if_reached();
			return;
		}
		
		if (convname && *convname) {
			convbuddyname = g_strdup(g_hash_table_lookup(sa->chat_to_buddy_lookup, convname));
		} else {
			convname = g_strdup(teams_thread_url_to_name(conversationLink));
			convbuddyname = g_strdup(teams_contact_url_to_name(conversationLink));
			from = teams_contact_url_to_name(json_object_get_string_member(resource, "from"));
		}
		
		if (convbuddyname == NULL && strstr(convname, "@unq.gbl.spaces")) {
			if (teams_is_user_self(sa, from)) {
				// Try to guess the other person from the chat id
				gchar** split = g_strsplit_set(convname, ":_@", 4);
				convbuddyname = g_strconcat("orgid:", split[1], NULL);
				
				if (teams_is_user_self(sa, convbuddyname)) {
					g_free(convbuddyname);
					convbuddyname = g_strconcat("orgid:", split[2], NULL);
				}
				g_strfreev(split);
			
			} else {
				convbuddyname = g_strdup(from);
			}
			
			g_hash_table_insert(sa->buddy_to_chat_lookup, g_strdup(convbuddyname), g_strdup(convname));
			g_hash_table_insert(sa->chat_to_buddy_lookup, g_strdup(convname), g_strdup(convbuddyname));
		} else if (convbuddyname != NULL) {
			// Ensure the most recent conversation is the one we use
			g_hash_table_insert(sa->buddy_to_chat_lookup, g_strdup(convbuddyname), g_strdup(convname));
		}
		
		if (g_str_equal(messagetype_parts[0], "Control")) {
			if (g_str_equal(messagetype_parts[1], "ClearTyping")) {
				purple_serv_got_typing(sa->pc, from, 22, PURPLE_IM_NOT_TYPING);
			} else if (g_str_equal(messagetype_parts[1], "Typing")) {
				purple_serv_got_typing(sa->pc, from, 22, PURPLE_IM_TYPING);
			}
		} else if ((g_str_equal(messagetype_parts[0], "RichText") || g_str_equal(messagetype, "Text"))) {
			gchar *html = NULL;
			gint64 skypeemoteoffset = 0;
			PurpleIMConversation *imconv;
			
			if (json_object_has_member(resource, "skypeemoteoffset")) {
				skypeemoteoffset = g_ascii_strtoll(json_object_get_string_member(resource, "skypeemoteoffset"), NULL, 10);
			}
			
			if (content && *content) {
				if (g_str_equal(messagetype, "Text")) {
					gchar *temp = teams_meify(content, skypeemoteoffset);
					html = purple_markup_escape_text(temp, -1);
					g_free(temp);
				} else {
					html = teams_meify(content, skypeemoteoffset);
				}

				if (skypeeditedid && *skypeeditedid) {
					gchar *temp = g_strconcat(_("Edited: "), html, NULL);
					g_free(html);
					html = temp;
				}
			}
			
			if (properties != NULL) {
				if (json_object_has_member(properties, "deletetime")) {
					g_free(html);
					html = g_strconcat("<b>", _("User deleted their message"), "</b>", NULL);
				}
				
				if (json_object_has_member(properties, "emotions")) {
					// webOS reactions: emit the aggregated reaction set (keyed by the message
					// service id) instead of flattening it into an IM text message.
					JsonArray *emotions = json_object_get_array_member(properties, "emotions");
					const gchar *msgid = json_object_has_member(resource, "id")
						? json_object_get_string_member(resource, "id") : NULL;
					teams_emit_reaction_set(sa, msgid, emotions);

					g_free(html);
					html = NULL; /* don't also render the reaction as an IM message */

				} else {
					html = teams_process_files_in_properties(properties, &html);
					html = teams_process_cards_in_properties(properties, &html, sa, conv, composetimestamp, from);
					
				}
			}
			
			if (json_object_has_member(resource, "imdisplayname") || json_object_has_member(resource, "imDisplayName")) {
				const gchar *displayname = json_object_get_string_member(resource, "imdisplayname");
				if (displayname == NULL) {
					displayname = json_object_get_string_member(resource, "imDisplayName");
				}
				
				if (displayname && *displayname && !g_str_has_prefix(displayname, "orgid:")) {
					//Hopefully not too expensive to do a lookup?
					PurpleBuddy *buddy = purple_blist_find_buddy(sa->account, from);
					//TODO add to buddy list if null?
					if (buddy == NULL || !purple_strequal(purple_buddy_get_local_alias(buddy), displayname)) {
						purple_serv_got_alias(sa->pc, from, displayname);
					}
				}
			}
			
			if (html != NULL && *html && !purple_strequal(convbuddyname, "48:calllogs") && !purple_strequal(convbuddyname, "48:annotations")) {
				const gchar *modified_convbuddyname = convbuddyname;
				//Handle self-send messages
				if (purple_strequal(convbuddyname, "48:notes")) {
					if (sa->primary_member_name) {
						modified_convbuddyname = sa->primary_member_name;
					} else if (sa->username) {
						modified_convbuddyname = sa->username;
					}
				}
				
				imconv = purple_conversations_find_im_with_account(modified_convbuddyname, sa->account);
				if (imconv == NULL)
				{
					imconv = purple_im_conversation_new(sa->account, modified_convbuddyname);
				}
				conv = PURPLE_CONVERSATION(imconv);

				// webOS reactions: stash this message's service id on the IM conv so the
				// transport records it as serviceMessageId (for both the self-carbon write and
				// the serv_got_im below); a later reaction (set) update targets it.
				teams_stash_webos_msg_id(conv, resource);

				teams_find_incoming_img(sa, conv, composetimestamp, from, &html);
				
				if (teams_is_user_self(sa, from)) {
					if (!g_str_has_prefix(html, "?OTR")) {
						PurpleMessage *msg;

						// webOS replies: our own reply from another device - stash the quote on the carbon
						// conv (and strip the inline <quote> from the visible body).
						teams_stash_webos_quote(conv, &html);
						// Cache our OWN sent message too, so a later reply TO it can rebuild the <quote>.
						teams_cache_quote_meta(sa, resource, html);
						msg = purple_message_new_outgoing(modified_convbuddyname, html, PURPLE_MESSAGE_SEND);
						purple_message_set_time(msg, composetimestamp);
						purple_conversation_write_message(conv, msg);
						purple_message_destroy(msg);
					}

				} else {
					// Stash the id on the exact conv serv_got_im uses (keyed by `from`); the earlier
					// stash was on modified_convbuddyname, which can differ from `from` in Teams, so the
					// transport read serviceMessageId off the wrong conversation (incoming msgs got none).
					PurpleIMConversation *rconv = purple_conversations_find_im_with_account(from, sa->account);
					if (rconv == NULL) {
						rconv = purple_im_conversation_new(sa->account, from);
					}
					teams_stash_webos_msg_id(PURPLE_CONVERSATION(rconv), resource);
					// webOS replies: stash the quoted-original on the same conv serv_got_im uses and strip
					// the inline <quote> from the visible body so only the reply text shows.
					teams_stash_webos_quote(PURPLE_CONVERSATION(rconv), &html);
					// Cache this message's own text so a later reply TO it can rebuild the <quote> block.
					teams_cache_quote_meta(sa, resource, html);
					purple_serv_got_im(sa->pc, from, html, PURPLE_MESSAGE_RECV, composetimestamp);
				}
				g_free(html);
			}
		} else if (g_str_equal(messagetype, "RichText/UriObject")) {
			PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
			const gchar *uri = purple_xmlnode_get_attrib(blob, "url_thumbnail");
			PurpleIMConversation *imconv;
			
			if (teams_is_user_self(sa, from)) {
				from = convbuddyname;
			}
			if (from != NULL) {
				imconv = purple_conversations_find_im_with_account(from, sa->account);
				if (imconv == NULL)
				{
					imconv = purple_im_conversation_new(sa->account, from);
				}
				
				conv = PURPLE_CONVERSATION(imconv);
				teams_download_uri_to_conv(sa, uri, conv, composetimestamp, from);
			}
			purple_xmlnode_free(blob);
		} else if (g_str_equal(messagetype, "RichText/Media_GenericFile")) {
			PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
			const gchar *uri = purple_xmlnode_get_attrib(blob, "uri");
			
			if (!teams_is_user_self(sa, from)) {
				
				teams_present_uri_as_filetransfer(sa, uri, from);
			}
			purple_xmlnode_free(blob);
		} else if (g_str_equal(messagetype, "RichText/Media_CallRecording")) {
			//TODO
			//"content": "<URIObject format_version=\"1.1\" type=\"Video.2/CallRecording.1\" url_thumbnail=\"https://au-prod.asyncgw.teams.microsoft.com/v1/objects/.../views/thumbnail\" uri=\"\" version=\"1.0\"><RecordingStatus status=\"Success\" code=\"200\"><amsErrorResult /></RecordingStatus><SessionEndReason value=\"CallEnded\" /><ChunkEndReason value=\"SessionEnded\" /><Title>...</Title><a href=\"https://...-my.sharepoint.com/:v:/g/personal/..._com/...\">Play</a><OriginalName v=\"...-20240114_232119-Meeting Recording.mp4\" /><MeetingOrganizerId value=\"8:orgid:...\" /><MeetingOrganizerTenantId value=\"...\" /><RecordingInitiatorId value=\"8:orgid:...\" /><ICalUid value=\"...\" /><Identifiers><Id type=\"callId\" value=\"...\" /><Id type=\"callLegId\" value=\"...\" /><Id type=\"chunkIndex\" value=\"0\" /><Id type=\"AMSDocumentID\" value=\"...\" /><Id type=\"StreamVideoId\" value=\"\" /><Id type=\"OriginatorParticipantId\" value=\"...\" /></Identifiers><RecordingContent contentTypes=\"Recording\" timestamp=\"2024-01-14T22:59:54.6362911Z\" duration=\"0:20:21.16\" canVideoExpire=\"True\"><item type=\"video\" uri=\"\" /><item type=\"amsVideo\" uri=\"https://au-prod.asyncgw.teams.microsoft.com/v1/objects/.../views/video\" /><item type=\"amsTranscript\" uri=\"https://au-prod.asyncgw.teams.microsoft.com/v1/objects/.../views/transcript\" /><item type=\"rosterevents\" uri=\"https://au-prod.asyncgw.teams.microsoft.com/v1/objects/.../views/rosterevents\" /><item type=\"onedriveForBusinessVideo\" uri=\"https://...-my.sharepoint.com/:v:/g/personal/..._com/...\" driveId=\"b!...\" driveItemId=\"...\" /></RecordingContent><RequestedExports><ExportResult type=\"ExportToOnedriveForBusiness\" /></RequestedExports></URIObject>",

		} else if (g_str_equal(messagetype, "Event/SkypeVideoMessage")) {
			PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);
			const gchar *sid = purple_xmlnode_get_attrib(blob, "sid");
			PurpleIMConversation *imconv;
			
			if (teams_is_user_self(sa, from)) {
				from = convbuddyname;
			}
			if (from != NULL) {
				imconv = purple_conversations_find_im_with_account(from, sa->account);
				if (imconv == NULL)
				{
					imconv = purple_im_conversation_new(sa->account, from);
				}
				
				conv = PURPLE_CONVERSATION(imconv);
				//teams_download_video_message(sa, sid, conv); //TODO
				(void) sid;
				purple_serv_got_im(sa->pc, from, content, PURPLE_MESSAGE_RECV | PURPLE_MESSAGE_SYSTEM, composetimestamp);
			}
			purple_xmlnode_free(blob);
		} else if (g_str_equal(messagetype, "Event/Call")) {
			PurpleXmlNode *partlist = purple_xmlnode_from_str(content, -1);
			const gchar *partlisttype = purple_xmlnode_get_attrib(partlist, "type");
			gchar *message = NULL;
			PurpleIMConversation *imconv;
			gboolean incoming = TRUE;
			
			if (teams_is_user_self(sa, from)) {
				incoming = FALSE;
				(void) incoming;
				from = convbuddyname;
			}

			if (from != NULL) {
				imconv = purple_conversations_find_im_with_account(from, sa->account);
				if (imconv == NULL)
				{
					imconv = purple_im_conversation_new(sa->account, from);
				}
				
				conv = PURPLE_CONVERSATION(imconv);
				if (content == NULL || strstr(content, "<ended/>")) {
					message = g_strdup(_("Call ended"));
				} else if (!partlisttype || g_str_equal(partlisttype, "started")) {
					message = g_strconcat(_("Call started"), " - <a href=\"https://", TEAMS_BASE_ORIGIN_HOST, "/l/meetup-join/", purple_url_encode(chatname), "/0\">", _("Join Teams Meeting"), "</a>", NULL);

				} else if (g_str_equal(partlisttype, "ended")) {
					PurpleXmlNode *part;
					gint duration_int = -1;
					
					for(part = purple_xmlnode_get_child(partlist, "part");
						part;
						part = purple_xmlnode_get_next_twin(part))
					{
						const gchar *identity = purple_xmlnode_get_attrib(part, "identity");
						if (identity && teams_is_user_self(sa, identity)) {
							PurpleXmlNode *duration = purple_xmlnode_get_child(part, "duration");
							if (duration != NULL) {
								gchar *duration_str;
								duration_str = purple_xmlnode_get_data(duration);
								duration_int = atoi(duration_str);
								g_free(duration_str);
								break;
							}
						}
					}
					if (duration_int < 0) {
						message = g_strdup(_("Call missed"));
					} else {
						message = g_strdup_printf("%s %d:%d", _("Call ended"), duration_int / 60, duration_int % 60);
					}
				}

				purple_serv_got_im(sa->pc, from, message, PURPLE_MESSAGE_RECV | PURPLE_MESSAGE_SYSTEM, composetimestamp);
				
				g_free(message);
			}

			purple_xmlnode_free(partlist);
		} else if (g_str_equal(messagetype, "Signal/Flamingo")) {
			const gchar *message = NULL;

			if (teams_is_user_self(sa, from)) {
				from = convbuddyname;
			}

			if (from != NULL) {
				message = _("Unsupported call received");

				purple_serv_got_im(sa->pc, from, message, PURPLE_MESSAGE_RECV | PURPLE_MESSAGE_SYSTEM, composetimestamp);
			}
		} else if (g_str_equal(messagetype, "RichText/Contacts")) {
			PurpleXmlNode *contacts = purple_xmlnode_from_str(content, -1);
			PurpleXmlNode *contact;

			for(contact = purple_xmlnode_get_child(contacts, "c"); contact;
				contact = purple_xmlnode_get_next_twin(contact))
			{
				const gchar *contact_id = purple_xmlnode_get_attrib(contact, "s");
				const gchar *contact_name = purple_xmlnode_get_attrib(contact, "f");

				gchar *message = g_strdup_printf(_("The user sent a contact: %s (%s)"), contact_id, contact_name); 

				purple_serv_got_im(sa->pc, from, message, PURPLE_MESSAGE_RECV | PURPLE_MESSAGE_SYSTEM, composetimestamp);

				g_free(message);
			}

			teams_received_contacts(sa, contacts);
			purple_xmlnode_free(contacts);
		} else if (g_str_equal(messagetype, "RichText/Media_FlikMsg")) {
			
			
			PurpleXmlNode *blob = purple_xmlnode_from_str(content, -1);

			const gchar *url_thumbnail = purple_xmlnode_get_attrib(blob, "url_thumbnail");
			gchar *text = purple_markup_strip_html(content); //purple_xmlnode_get_data_unescaped doesn't work properly in this situation
			
			PurpleIMConversation *imconv;
			
			if (teams_is_user_self(sa, from)) {
				from = convbuddyname;
			}
			if (from != NULL) {
				imconv = purple_conversations_find_im_with_account(from, sa->account);
				if (imconv == NULL) {
					imconv = purple_im_conversation_new(sa->account, from);
				}
				
				conv = PURPLE_CONVERSATION(imconv);

				teams_download_moji_to_conv(sa, text, url_thumbnail, conv, composetimestamp, from);

				const gchar *message = _("The user sent a Moji");

				purple_serv_got_im(sa->pc, from, message, PURPLE_MESSAGE_NO_LOG, composetimestamp);

				g_free(text);
			}

			purple_xmlnode_free(blob);
		} else if (g_str_equal(messagetype, "RichText/Files")) {
			purple_serv_got_im(sa->pc, convbuddyname, _("The user sent files in an unsupported way"), PURPLE_MESSAGE_RECV | PURPLE_MESSAGE_SYSTEM | PURPLE_MESSAGE_ERROR, composetimestamp);
		} else {
			purple_debug_warning("teams", "Unhandled message resource messagetype '%s'\n", messagetype);
		}
		
		g_free(convbuddyname);
	}
	
	if (conv != NULL) {
		const gchar *id = json_object_get_string_member(resource, "id");
		
		g_free(purple_conversation_get_data(conv, "last_teams_id"));
		g_free(purple_conversation_get_data(conv, "last_teams_clientmessageid"));
		
		if (purple_conversation_has_focus(conv) && convname && *convname) {
			// Mark message as seen straight away
			gchar *post, *url;
			
			url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/properties?name=consumptionhorizon", purple_url_encode(convname));
			// Should be [messageId];[timestampInMillis];[clientMessageId]
			post = g_strdup_printf("{\"consumptionhorizon\":\"%s;%" G_GINT64_FORMAT ";%s\"}", id ? id : "", teams_get_js_time(), clientmessageid ? clientmessageid : "");
			
			teams_post_or_get(sa, TEAMS_METHOD_PUT | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, post, NULL, NULL, TRUE);
			
			g_free(post);
			g_free(url);
			
			purple_conversation_set_data(conv, "last_teams_id", NULL);
			purple_conversation_set_data(conv, "last_teams_clientmessageid", NULL);
		} else {
			purple_conversation_set_data(conv, "last_teams_id", g_strdup(id));
			purple_conversation_set_data(conv, "last_teams_clientmessageid", g_strdup(clientmessageid));
		}
	}
	
	g_free(convname);
	g_strfreev(messagetype_parts);
	
	if (composetimestamp > purple_account_get_int(sa->account, "last_message_timestamp", 0))
		purple_account_set_int(sa->account, "last_message_timestamp", composetimestamp);
}

static void
process_conversation_resource(TeamsAccount *sa, JsonObject *resource)
{
	// webOS: bail on a late handler for an account freed by a re-login flap (see process_message_resource).
	if (!teams_account_is_live(sa))
		return;

	const gchar *id = json_object_get_string_member(resource, "id");
	JsonObject *threadProperties = json_object_get_object_member(resource, "threadProperties");
	JsonObject *lastMessage = json_object_get_object_member(resource, "lastMessage");
	
	if (threadProperties != NULL) {
		const gchar *uniquerosterthread = json_object_get_string_member(threadProperties, "uniquerosterthread");
		const gchar *productThreadType = json_object_get_string_member(threadProperties, "productThreadType");
		if (purple_strequal(uniquerosterthread, "true") || purple_strequal(productThreadType, "OneToOneChat")) {
			// This is a one-to-one chat
			
			if (!g_hash_table_lookup(sa->chat_to_buddy_lookup, id)) {
				// ... and we dont know about it yet
				gchar *buddyid = NULL;
				if (lastMessage != NULL) {
					const gchar *from = json_object_get_string_member(lastMessage, "from");
					buddyid = g_strdup(teams_contact_url_to_name(from));
				}
				
				if (buddyid == NULL || teams_is_user_self(sa, buddyid)) {
					if (g_str_has_prefix(id, "19:uni01_")) {
						// Not possible to guess with the uni01 prefix
						return;
					}
					// Try to guess the other person from the chat id
					gchar** split = g_strsplit_set(id, ":_@", 4);
					g_free(buddyid);
					buddyid = g_strconcat("orgid:", split[1], NULL);
					if (teams_is_user_self(sa, buddyid)) {
						g_free(buddyid);
						buddyid = g_strconcat("orgid:", split[2], NULL);
					}
					g_strfreev(split);
				}
				
				g_hash_table_insert(sa->buddy_to_chat_lookup, g_strdup(buddyid), g_strdup(id));
				g_hash_table_insert(sa->chat_to_buddy_lookup, g_strdup(id), g_strdup(buddyid));
				
				g_free(buddyid);
			}
		}
	}
}

static void
process_thread_resource(TeamsAccount *sa, JsonObject *resource)
{
	const gchar *id = json_object_get_string_member(resource, "id");
	JsonObject *properties = json_object_get_object_member(resource, "properties");
	JsonArray *members = json_object_get_array_member(resource, "members");
	
	if (properties != NULL) {
		const gchar *uniquerosterthread = json_object_get_string_member(properties, "uniquerosterthread");
		if (purple_strequal(uniquerosterthread, "true")) {
			// This is a one-to-one chat
			
			if (!g_hash_table_lookup(sa->chat_to_buddy_lookup, id)) {
				// ... and we dont know about it yet
				
				// webOS: `members` may be absent (guarded macro -> NULL) or have <2 entries. Bound
				// the index-0/1 access with the length (raw json_array_get_object_element asserts on
				// NULL/out-of-range - the `array != NULL` critical seen next to incoming messages).
				guint mcount = json_array_get_length(members);
				JsonObject *member = mcount >= 1 ? json_array_get_object_element(members, 0) : NULL;
				const gchar *mri = member ? json_object_get_string_member(member, "id") : NULL;
				const gchar *buddyid = mri ? teams_strip_user_prefix(mri) : NULL;

				if (buddyid && teams_is_user_self(sa, buddyid) && mcount >= 2) {
					// There were two in the bed and the little one said....
					member = json_array_get_object_element(members, 1);
					mri = json_object_get_string_member(member, "id");
					buddyid = mri ? teams_strip_user_prefix(mri) : NULL;
				}

				if (buddyid != NULL) {
					//Fetch buddy presence
					teams_subscribe_to_single_contact_status(sa, buddyid);

					//Create an array of one to one mappings for IMs
					g_hash_table_insert(sa->buddy_to_chat_lookup, g_strdup(buddyid), g_strdup(id));
					g_hash_table_insert(sa->chat_to_buddy_lookup, g_strdup(id), g_strdup(buddyid));

					PurpleChatConversation *conv = purple_conversations_find_chat_with_account(id, sa->account);
					if (conv != NULL) {
						purple_conversation_destroy(PURPLE_CONVERSATION(conv));
					}
				}
			}
		}
	}
}

static void
process_endpointpresence_resource(TeamsAccount *sa, JsonObject *resource)
{
	JsonObject *publicInfo = json_object_get_object_member(resource, "publicInfo");
	if (publicInfo != NULL) {
		const gchar *typ_str = json_object_get_string_member(publicInfo, "typ");
		const gchar *skypeNameVersion = json_object_get_string_member(publicInfo, "skypeNameVersion");
		
		if (typ_str && *typ_str) {
			if (g_str_equal(typ_str, "website")) {
			
			} else {
				gint typ = atoi(typ_str);
				switch(typ) {
					case 17: //Android
						break;
					case 16: //iOS
						break;
					case 12: //WinRT/Metro
						break;
					case 15: //Winphone
						break;
					case 13: //OSX
						break;
					case 11: //Windows
						break;
					case 14: //Linux
						break;
					case 10: //XBox ? skypeNameVersion 11/1.8.0.1006
						break;
					case 1:  //Teams
						break;
					default:
						purple_debug_warning("teams", "Unknown typ %d: %s\n", typ, skypeNameVersion ? skypeNameVersion : "");
						break;
				}
			}
		}
	}
}

void
teams_process_event_message(TeamsAccount *sa, JsonObject *message)
{
	// webOS: bail on a late poll/trouter batch for an account freed by a re-login flap (hash-flood hang).
	if (!teams_account_is_live(sa))
		return;

	const gchar *resourceType = json_object_get_string_member(message, "resourceType");
	const gchar *time = json_object_get_string_member(message, "time");
	JsonObject *resource = json_object_get_object_member(message, "resource");

	if (time != NULL) {
		if (g_queue_find_custom(sa->processed_event_messages, time, (GCompareFunc) g_strcmp0)) {
			// Already processed this message
			return;
		}
		g_queue_push_head(sa->processed_event_messages, g_strdup(time));
		if (g_queue_get_length(sa->processed_event_messages) > TEAMS_MAX_PROCESSED_EVENT_BUFFER) {
			// Remove oldest message
			g_queue_pop_tail(sa->processed_event_messages);
		}
	}
	
	if (purple_strequal(resourceType, "NewMessage"))
	{
		process_message_resource(sa, resource);
	} else if (purple_strequal(resourceType, "UserPresence"))
	{
		process_userpresence_resource(sa, resource);
	} else if (purple_strequal(resourceType, "EndpointPresence"))
	{
		process_endpointpresence_resource(sa, resource);
	} else if (purple_strequal(resourceType, "ConversationUpdate"))
	{
		process_conversation_resource(sa, resource);
	} else if (purple_strequal(resourceType, "ThreadUpdate"))
	{
		process_thread_resource(sa, resource);
	} else if (purple_strequal(resourceType, "MessageUpdate"))
	{
		//Message edited
		process_message_resource(sa, resource);
	} else {
		purple_debug_info("teams", "Unknown resourceType '%s'\n", resourceType);
	}
}

void
teams_mark_conv_seen(PurpleConversation *conv, PurpleConversationUpdateType type)
{
	PurpleConnection *pc = purple_conversation_get_connection(conv);
	if (!PURPLE_CONNECTION_IS_CONNECTED(pc))
		return;
	
	if (!purple_strequal(purple_protocol_get_id(purple_connection_get_protocol(pc)), TEAMS_PLUGIN_ID))
		return;
	
	if (type == PURPLE_CONVERSATION_UPDATE_UNSEEN) {
		gchar *last_teams_id = purple_conversation_get_data(conv, "last_teams_id");
		gchar *last_teams_clientmessageid = purple_conversation_get_data(conv, "last_teams_clientmessageid");
		
		if (last_teams_id && *last_teams_id) {
			TeamsAccount *sa = purple_connection_get_protocol_data(pc);
			gchar *post, *url, *convname;
			
			if (PURPLE_IS_IM_CONVERSATION(conv)) {
				const gchar *buddyname = purple_conversation_get_name(conv);
				convname = g_strdup(g_hash_table_lookup(sa->buddy_to_chat_lookup, buddyname));
			} else {
				convname = g_strdup(purple_conversation_get_data(conv, "chatname"));
			}
			
			if (convname && *convname) {
				url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/properties?name=consumptionhorizon", purple_url_encode(convname));
				// Should be [messageId];[timestampInMillis];[clientMessageId]
				post = g_strdup_printf("{\"consumptionhorizon\":\"%s;%" G_GINT64_FORMAT ";%s\"}", last_teams_id, teams_get_js_time(), last_teams_clientmessageid);
				
				teams_post_or_get(sa, TEAMS_METHOD_PUT | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, post, NULL, NULL, TRUE);
				
				g_free(convname);
				g_free(post);
				g_free(url);
			}
		}

		g_free(last_teams_id);
		g_free(last_teams_clientmessageid);
		purple_conversation_set_data(conv, "last_teams_id", NULL);
		purple_conversation_set_data(conv, "last_teams_clientmessageid", NULL);
	}
}

static void
teams_got_thread_users(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	PurpleChatConversation *chatconv;
	gchar *chatname = user_data;
	JsonObject *response;
	JsonArray *members;
	gint length, index;
	PurpleGroup *group = teams_get_blist_group(sa);
	GSList *users_to_fetch = NULL;
	//gboolean is_meeting_chat = g_str_has_prefix(chatname, "19:meeting_");
	
	chatconv = purple_conversations_find_chat_with_account(chatname, sa->account);
	g_free(chatname);

	if (chatconv == NULL)
		return;
	purple_chat_conversation_clear_users(chatconv);
	
	if (node == NULL || json_node_get_node_type(node) != JSON_NODE_OBJECT)
		return;
	response = json_node_get_object(node);
	
	members = json_object_get_array_member(response, "members");
	length = json_array_get_length(members);
	for(index = length - 1; index >= 0; index--)
	{
		JsonObject *member = json_array_get_object_element(members, index);
		const gchar *userLink = json_object_get_string_member(member, "userLink");
		const gchar *role = json_object_get_string_member(member, "role");
		const gchar *username = teams_contact_url_to_name(userLink);
		PurpleChatUserFlags cbflags = PURPLE_CHAT_USER_NONE;
		
		if (purple_strequal(role, "Admin") || purple_strequal(role, "admin")) {
			cbflags = PURPLE_CHAT_USER_OP;
		} else if (purple_strequal(role, "User") || purple_strequal(role, "user")) {
			cbflags = PURPLE_CHAT_USER_VOICE;
		}

		if (username == NULL && json_object_has_member(member, "linkedMri")) {
			username = teams_contact_url_to_name(json_object_get_string_member(member, "linkedMri"));
		}
		if (username != NULL) {
			const gchar *friendlyName = json_object_get_string_member(member, "friendlyName");
			PurpleBuddy *buddy;
			const gchar *local_alias;

			if (friendlyName == NULL) {
				friendlyName = json_object_get_string_member(member, "friendlyname");
			}
			
			if (friendlyName && *friendlyName && !g_str_has_prefix(friendlyName, "orgid:")) {
				buddy = purple_blist_find_buddy(sa->account, username);
				if (buddy == NULL) {
					purple_buddy_new(sa->account, username, NULL);
					if (purple_strequal(role, "Anonymous") || purple_strequal(role, "anonymous")) {
						purple_blist_node_set_transient(PURPLE_BLIST_NODE(buddy), TRUE);
					}
					purple_blist_add_buddy(buddy, NULL, group, NULL);
					
				}
				
				local_alias = purple_buddy_get_local_alias(buddy);
				if (!local_alias || !*local_alias) {
					purple_serv_got_alias(sa->pc, username, friendlyName);
				}
			}
			
			purple_chat_conversation_add_user(chatconv, username, NULL, cbflags, FALSE);
			users_to_fetch = g_slist_prepend(users_to_fetch, g_strdup(username));
		}
	}
	
	teams_get_friend_profiles(sa, users_to_fetch);
	g_slist_free_full(users_to_fetch, g_free);
}

void
teams_get_thread_users(TeamsAccount *sa, const gchar *convname)
{
	gchar *url;
	url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/threads/%s?view=msnp24Equivalent", purple_url_encode(convname));
	
	teams_post_or_get(sa, TEAMS_METHOD_GET | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, NULL, teams_got_thread_users, g_strdup(convname), TRUE);
	
	g_free(url);
}

static void
teams_got_conv_history(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	gint since = GPOINTER_TO_INT(user_data);
	JsonObject *obj;
	JsonArray *messages;
	gint index, length;
	
	if (node == NULL || json_node_get_node_type(node) != JSON_NODE_OBJECT)
		return;
	obj = json_node_get_object(node);
	
	messages = json_object_get_array_member(obj, "messages");
	length = json_array_get_length(messages);
	for(index = length - 1; index >= 0; index--)
	{
		JsonObject *message = json_array_get_object_element(messages, index);
		const gchar *composetime = json_object_get_string_member(message, "composetime");
		gint composetimestamp = (gint) purple_str_to_time(composetime, TRUE, NULL, NULL, NULL);
		
		if (composetimestamp > since) {
			process_message_resource(sa, message);
		}
	}
}

void
teams_get_conversation_history_since(TeamsAccount *sa, const gchar *convname, gint since)
{
	gchar *url;
	url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/messages?startTime=%d000&pageSize=30&view=msnp24Equivalent&targetType=Passport|Skype|Lync|Thread|PSTN|Agent", purple_url_encode(convname), since);
	
	teams_post_or_get(sa, TEAMS_METHOD_GET | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, NULL, teams_got_conv_history, GINT_TO_POINTER(since), TRUE);
	
	g_free(url);
}

#define TEAMS_HISTORY_PAGE_SIZE 30
#define TEAMS_HISTORY_MAX_PAGES 20

typedef struct {
	gchar  *convname;
	gint    since;        /* original earliest timestamp (seconds) */
	gint    end_before;   /* exclusive upper bound (seconds); 0 = no limit */
	gint    page_count;   /* safety counter */
	GSList *all_messages; /* json_object_ref'd JsonObject*, accumulated across pages */
} TeamsHistoryFetchData;

static gint
compare_message_composetime(gconstpointer a, gconstpointer b)
{
	const gchar *ta = json_object_get_string_member((JsonObject *) a, "composetime");
	const gchar *tb = json_object_get_string_member((JsonObject *) b, "composetime");
	time_t tsa = purple_str_to_time(ta, TRUE, NULL, NULL, NULL);
	time_t tsb = purple_str_to_time(tb, TRUE, NULL, NULL, NULL);

	if (tsa < tsb) return -1;
	if (tsa > tsb) return  1;
	return 0;
}

// Fetch message history using paginated/batched requests to fetch the complete requested time-window
static void
teams_got_conv_history_paginated(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	TeamsHistoryFetchData *fetch = user_data;
	JsonObject *obj;
	JsonArray  *messages;
	gint index, length;
	gint oldest_ts = 0;
	gboolean fetch_next = FALSE;

	if (node != NULL && json_node_get_node_type(node) == JSON_NODE_OBJECT) {
		obj      = json_node_get_object(node);
		messages = json_object_get_array_member(obj, "messages");
		length   = json_array_get_length(messages);

		// Accumulate this page's messages (API is newest-first; index 0 = newest).
		for (index = 0; index < length; index++) {
			JsonObject  *message          = json_array_get_object_element(messages, index);
			const gchar *composetime      = json_object_get_string_member(message, "composetime");
			gint         composetimestamp = (gint) purple_str_to_time(composetime, TRUE, NULL, NULL, NULL);

			// The last element (highest index) is the oldest in a newest-first array.
			if (index == length - 1)
				oldest_ts = composetimestamp;

			if (composetimestamp > fetch->since) {
				json_object_ref(message);
				fetch->all_messages = g_slist_prepend(fetch->all_messages, message);
			}
		}

		 // Request the next (older) page when:
		 // - we received a full page (more messages likely exist)
		 // - the oldest message is still within our target window
		 // - we haven't hit the safety page limit
		 // - we're making progress (oldest_ts < end_before, so we're not stuck on
		 //    the same window. If the server ignores endTime it will return the
		 //    same page and oldest_ts won't be less than the end_before we sent,
		 //    stopping the loop cleanly)
		fetch_next = (length == TEAMS_HISTORY_PAGE_SIZE
				&& oldest_ts > fetch->since
				&& fetch->page_count < TEAMS_HISTORY_MAX_PAGES
				&& (fetch->end_before == 0 || oldest_ts < fetch->end_before));

		if (fetch_next) {
			TeamsHistoryFetchData *next = g_new0(TeamsHistoryFetchData, 1);
			gchar *url;

			next->convname     = g_strdup(fetch->convname);
			next->since        = fetch->since;
			next->end_before   = oldest_ts;
			next->page_count   = fetch->page_count + 1;
			next->all_messages = fetch->all_messages; /* transfer ownership */
			fetch->all_messages = NULL;

			url = g_strdup_printf(
				TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/messages"
				"?startTime=%d000&endTime=%d000&pageSize=%d"
				"&view=msnp24Equivalent&targetType=Passport|Skype|Lync|Thread|PSTN|Agent",
				purple_url_encode(next->convname),
				next->since,
				next->end_before - 1,
				TEAMS_HISTORY_PAGE_SIZE);

			teams_post_or_get(sa, TEAMS_METHOD_GET | TEAMS_METHOD_SSL,
					TEAMS_CONTACTS_HOST, url, NULL,
					teams_got_conv_history_paginated, next, TRUE);
			g_free(url);
			g_free(fetch->convname);
			g_free(fetch);
			return;
		}
	}

	//
	// All pages received (or an error occurred). Sort the accumulated messages
	// by composetime ascending (oldest first) so they appear in the correct
	// order in the chat window, regardless of the order the pages arrived.
	//
	fetch->all_messages = g_slist_sort(fetch->all_messages, compare_message_composetime);
	GSList *l;
	for (l = fetch->all_messages; l; l = l->next) {
		process_message_resource(sa, (JsonObject *) l->data);
		json_object_unref((JsonObject *) l->data);
	}
	g_slist_free(fetch->all_messages);

	g_free(fetch->convname);
	g_free(fetch);
}

void
teams_fetch_conv_history_paginated(TeamsAccount *sa, const gchar *convname, gint since)
{
	TeamsHistoryFetchData *fetch = g_new0(TeamsHistoryFetchData, 1);
	gchar *url;

	fetch->convname   = g_strdup(convname);
	fetch->since      = since;
	fetch->end_before = 0;
	fetch->page_count = 0;

	url = g_strdup_printf(
		TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/messages"
		"?startTime=%d000&pageSize=%d"
		"&view=msnp24Equivalent&targetType=Passport|Skype|Lync|Thread|PSTN|Agent",
		purple_url_encode(convname),
		since,
		TEAMS_HISTORY_PAGE_SIZE);

	teams_post_or_get(sa, TEAMS_METHOD_GET | TEAMS_METHOD_SSL,
			TEAMS_CONTACTS_HOST, url, NULL,
			teams_got_conv_history_paginated, fetch, TRUE);
	g_free(url);
}

void
teams_get_conversation_history(TeamsAccount *sa, const gchar *convname)
{
	GString *timestamp_key = make_last_timestamp_setting(convname);
	teams_get_conversation_history_since(sa, convname, purple_account_get_int(sa->account, timestamp_key->str, 0));
	g_string_free(timestamp_key, TRUE);
}

static void
teams_poll_convs_err_cb(TeamsAccount *sa, const gchar *data, gssize len, gpointer user_data)
{
	/* Conversations fetch failed (no parseable body) — release the poll guard so the
	 * next tick can retry instead of the poll wedging forever. */
	sa->poll_in_flight = FALSE;
}

static void
teams_got_all_convs(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	gint since = GPOINTER_TO_INT(user_data);
	JsonObject *obj;
	JsonArray *conversations;
	gint index, length;

	/* The (possibly poll-driven) conversations fetch has returned — release the guard. */
	sa->poll_in_flight = FALSE;

	if (node == NULL || json_node_get_node_type(node) != JSON_NODE_OBJECT)
		return;
	obj = json_node_get_object(node);

	conversations = json_object_get_array_member(obj, "conversations");
	if (conversations == NULL)
		return;
	length = json_array_get_length(conversations);
	for(index = 0; index < length; index++) {
		JsonObject *conversation = json_array_get_object_element(conversations, index);
		const gchar *id = json_object_get_string_member(conversation, "id");
		JsonObject *lastMessage = json_object_get_object_member(conversation, "lastMessage");
		
		if (lastMessage != NULL && json_object_has_member(lastMessage, "composetime")) {
			const gchar *composetime = json_object_get_string_member(lastMessage, "composetime");
			gint composetimestamp = (gint) purple_str_to_time(composetime, TRUE, NULL, NULL, NULL);
			
			// Check if it's a one-to-one before we fetch history
			process_conversation_resource(sa, conversation);
			
			if (composetimestamp > since) {
				teams_get_conversation_history_since(sa, id, since);
			}
		}
	}
}

void
teams_get_all_conversations_since(TeamsAccount *sa, gint since)
{
	gchar *url;
	url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations?startTime=%d000&pageSize=100&view=msnp24Equivalent&targetType=Passport|Skype|Lync|Thread|PSTN|Agent", since);
	
	teams_post_or_get_with_error(sa, TEAMS_METHOD_GET | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, NULL, teams_got_all_convs, teams_poll_convs_err_cb, GINT_TO_POINTER(since), TRUE);

	g_free(url);
}

void
teams_get_offline_history(TeamsAccount *sa)
{
	/* The poll cursor. It MUST be seeded once to a fixed value: if we let it
	 * default to time(NULL) on every call, each poll tick asks for messages since
	 * "now", an always-forward-empty window, so a live message lands in the gap
	 * between its send time and the next tick's cursor and is never fetched (the
	 * cursor only advances when a message is received -> bootstrapping deadlock).
	 * Seed it to now on first use so subsequent polls query [seed, now] and catch
	 * new messages; process_message_resource() dedups re-fetched ones by server id. */
	gint since = purple_account_get_int(sa->account, "last_message_timestamp", 0);
	if (since == 0) {
		since = (gint) time(NULL);
		purple_account_set_int(sa->account, "last_message_timestamp", since);
	}
	teams_get_all_conversations_since(sa, since);
}


static void
teams_got_roomlist_threads(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	PurpleRoomlist *roomlist = user_data;
	JsonObject *obj;
	JsonArray *conversations;
	gint index, length;
	
	if (node == NULL || json_node_get_node_type(node) != JSON_NODE_OBJECT)
		return;
	obj = json_node_get_object(node);
	
	conversations = json_object_get_array_member(obj, "conversations");
	length = json_array_get_length(conversations);
	for(index = 0; index < length; index++) {
		JsonObject *conversation = json_array_get_object_element(conversations, index);
		const gchar *id = json_object_get_string_member(conversation, "id");
		PurpleRoomlistRoom *room = purple_roomlist_room_new(PURPLE_ROOMLIST_ROOMTYPE_ROOM, id, NULL);
		
		purple_roomlist_room_add_field(roomlist, room, id);
		if (json_object_has_member(conversation, "threadProperties")) {
			JsonObject *threadProperties = json_object_get_object_member(conversation, "threadProperties");
			if (threadProperties != NULL) {
				const gchar *num_members = json_object_get_string_member(threadProperties, "membercount");
				purple_roomlist_room_add_field(roomlist, room, num_members);
				const gchar *topic = json_object_get_string_member(threadProperties, "topic");
				purple_roomlist_room_add_field(roomlist, room, topic);
			}
		}
		purple_roomlist_room_add(roomlist, room);
	}
	
	purple_roomlist_set_in_progress(roomlist, FALSE);
}

PurpleRoomlist *
teams_roomlist_get_list(PurpleConnection *pc)
{
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	const gchar *url = TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations?startTime=0&pageSize=100&view=msnp24Equivalent&targetType=Thread";
	PurpleRoomlist *roomlist;
	GList *fields = NULL;
	PurpleRoomlistField *f;
	
	roomlist = purple_roomlist_new(sa->account);

	f = purple_roomlist_field_new(PURPLE_ROOMLIST_FIELD_STRING, _("ID"), "chatname", TRUE);
	fields = g_list_append(fields, f);

	f = purple_roomlist_field_new(PURPLE_ROOMLIST_FIELD_STRING, _("Users"), "users", FALSE);
	fields = g_list_append(fields, f);

	f = purple_roomlist_field_new(PURPLE_ROOMLIST_FIELD_STRING, _("Topic"), "topic", FALSE);
	fields = g_list_append(fields, f);

	purple_roomlist_set_fields(roomlist, fields);
	purple_roomlist_set_in_progress(roomlist, TRUE);

	teams_post_or_get(sa, TEAMS_METHOD_GET | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, NULL, teams_got_roomlist_threads, roomlist, TRUE);
	
	return roomlist;
}

void
teams_unsubscribe_from_contact_status(TeamsAccount *sa, const gchar *who)
{
	const gchar *contacts_url = TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/contacts";
	gchar *url;
	
	url = g_strconcat(contacts_url, "/", teams_user_url_prefix(who), purple_url_encode(who), NULL);
	
	teams_post_or_get(sa, TEAMS_METHOD_DELETE | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, NULL, NULL, NULL, TRUE);
	
	g_free(url);
}

// Number of presence entries to process per idle tick before yielding to the
// GTK main loop. This keeps the UI responsive during large snapshot updates.
#define TEAMS_PRESENCE_BATCH_SIZE 20

// Drains up to TEAMS_PRESENCE_BATCH_SIZE entries from the shared presence queue
// per idle tick.
//
// Because all incoming responses feed into one queue there is only a single
// idle callback active at a time. Therefore, the main loop will always regain
// control after processing up to TEAMS_PRESENCE_BATCH_SIZE status updates
// regardless of how many API responses arrive concurrently.
static gboolean
teams_drain_presence_queue(gpointer user_data)
{
	TeamsAccount *sa = user_data;

	// webOS: if sa was freed by a re-login flap, bail WITHOUT touching it (pointer check first, so we
	// never deref the freed sa->pc / sa->pending_presences). The source id is gone with the old sa.
	if (!teams_account_is_live(sa))
		return G_SOURCE_REMOVE;

	if (!PURPLE_IS_CONNECTION(sa->pc)) {
		// If the connection has dropped discard all pending messages and stop.
		while (!g_queue_is_empty(sa->pending_presences)) {
			json_object_unref(g_queue_pop_head(sa->pending_presences));
		}
		sa->presence_drain_source = 0;
		return G_SOURCE_REMOVE;
	}

	PurpleGroup *group = teams_get_blist_group(sa);
	GSList *users_to_fetch = NULL;
	gint count = 0;

	// Time box the drain so that the GTK main loop always gets back control
	// within ~20 ms.  Buddy-list redraws are expensive when the list is large.
	// The time box prevents the 50 ms timer from queuing up faster than it drains.
	gint64 deadline = g_get_monotonic_time() + 20000; // 20 ms from now

	while (!g_queue_is_empty(sa->pending_presences) && count < TEAMS_PRESENCE_BATCH_SIZE) {
		JsonObject *response = g_queue_pop_head(sa->pending_presences);
		count++;

		// Remove from the deduplication index now that we are processing this entry.
		const gchar *index_mri = json_object_get_string_member(response, "mri");
		if (index_mri) {
			g_hash_table_remove(sa->presence_mri_index, index_mri);
		}

		JsonObject *presence = json_object_get_object_member(response, "presence");
		const gchar *mri = json_object_get_string_member(response, "mri");

		if (presence == NULL || mri == NULL) {
			json_object_unref(response);
			continue;
		}

		// Skip PSTN (telephone) contacts
		// MRI prefix "4:" means phone number
		// It is impossible to send or recieve IMs from these contacts, so they
		// should not be added to the buddy list.
		if (g_str_has_prefix(mri, "4:")) {
			json_object_unref(response);
			continue;
		}

		const gchar *availability = json_object_get_string_member(presence, "availability");
		const gchar *from = teams_strip_user_prefix(mri);

		if (!from || !*from || !availability) {
			json_object_unref(response);
			continue;
		}

		if (!purple_blist_find_buddy(sa->account, from)) {
			if (!teams_is_user_self(sa, from)) {
				purple_blist_add_buddy(purple_buddy_new(sa->account, from, NULL), NULL, group, NULL);
				users_to_fetch = g_slist_prepend(users_to_fetch, g_strdup(from));
			}
		}
		//TODO note/OOOnote -> status message
		/*
			"presence": {
				"sourceNetwork": "SameEnterprise",
				"note": {
					"message": "<p>hi :)</p>",
					"publishTime": "2025-12-23T08:59:24.2293971Z",
					"expiry": "2025-12-23T10:59:59.999Z"
				},
				"workLocation": {
					"location": "Office",
					"expiry": "2025-12-23T10:59:59.9999999Z",
					"isForced": true,
					"locationSource": "ForcedLocation",
					"approximateDetails": {
						"id": "12345678-1234-4321-abcd-1234567890ab",
						"name": "Building A - Floor 3",
						"idType": "Directory"
					},
					"maxShared": "Specific"
				},
				"calendarData": {
					"outOfOfficeNote": {
						"message": "I am on leave - returning 19th April",
						"publishTime": "2022-04-14T08:02:23.5053937Z",
						"expiry": "2022-04-19T07:00:00Z"
					},
					"isOutOfOffice": true
				},
				"capabilities": [],
				"availability": "Away",
				"activity": "Away",
				"lastActiveTime": "2022-04-14T04:41:35.67Z",
				"deviceType": "Desktop"
			},
			"etagMatch": false,
			"etag": "A0072086544",
			"status": 20000
		*/

		// Skip status updates whose presence hasn't changed since we last
		// processed them. Each entry carries an etag that the server increments
		// whenever the contact's presence changes.
		const gchar *etag = json_object_get_string_member(response, "etag");
		if (etag && *etag) {
			const gchar *cached_etag = g_hash_table_lookup(sa->presence_etag_cache, mri);
			if (cached_etag && g_str_equal(cached_etag, etag)) {
				json_object_unref(response);
				continue;
			}
			g_hash_table_insert(sa->presence_etag_cache, g_strdup(mri), g_strdup(etag));
		}

		JsonObject *calendarData = json_object_get_object_member(presence, "calendarData");
		if (calendarData != NULL) {
			gboolean isOutOfOffice = json_object_get_boolean_member(calendarData, "isOutOfOffice");
			if (isOutOfOffice) {
				JsonObject *outOfOfficeNote = json_object_get_object_member(calendarData, "outOfOfficeNote");
				const gchar *message = json_object_get_string_member(outOfOfficeNote, "message");
				purple_protocol_got_user_status(sa->account, from, TEAMS_OOO_STATUS_ID, "message", message, NULL);
			} else {
				purple_protocol_deactivate_user_status(sa->account, from, TEAMS_OOO_STATUS_ID);
			}
		}

		JsonObject *workLocation = json_object_get_object_member(presence, "workLocation");
		if (workLocation != NULL) {
			const gchar *location_name = NULL;
			const gchar *location = json_object_get_string_member(workLocation, "location");
			JsonObject *approximateDetails = json_object_get_object_member(workLocation, "approximateDetails");
			if (approximateDetails != NULL) {
				const gchar *name = json_object_get_string_member(approximateDetails, "name");
				if (name != NULL && *name) {
					location_name = name;
				}
			}
			purple_protocol_got_user_status(sa->account, from, TEAMS_WORK_LOCATION_STATUS_ID, "location", location, "location_name", location_name, NULL);
		} else {
			purple_protocol_deactivate_user_status(sa->account, from, TEAMS_WORK_LOCATION_STATUS_ID);
		}

		JsonObject *note = json_object_get_object_member(presence, "note");
		const gchar *status_message = NULL;
		if (note != NULL) {
			status_message = json_object_get_string_member(note, "message");
		}

		// Skip the expensive purple_protocol_got_user_status() and buddy-list
		// redraw when the visible state won't change.  libpurple's
		// purple_prpl_got_user_status() always fires "buddy-status-changed" even
		// for no-op transitions (ex: offline -> offline), triggering a full GTK
		// buddy-list re-sort.  At startup with "Show Offline Buddies" enabled, this
		// could otherwise fire hundreds of times for contacts that remain offline,
		// locking the UI.
		gboolean should_update_availability = TRUE;
		PurpleBuddy *existing = purple_blist_find_buddy(sa->account, from);
		if (existing != NULL) {
			PurplePresence *epres = purple_buddy_get_presence(existing);
			gboolean currently_online = purple_presence_is_online(epres);
			gboolean new_is_offline = (purple_strequal(availability, "Offline") ||
			                          purple_strequal(availability, "PresenceUnknown"));
			if (!currently_online && new_is_offline) {
				// Both old and new are offline. Only push the update if the
				// buddy status actually changed.
				PurpleStatus *estat = purple_presence_get_active_status(epres);
				const gchar *current_msg = estat ?
				    purple_status_get_attr_string(estat, "message") : NULL;
				if (g_strcmp0(current_msg, status_message) == 0) {
					should_update_availability = FALSE;
				}
			}
		}

		if (should_update_availability) {
			purple_protocol_got_user_status(sa->account, from, availability, "message", status_message, NULL);

			gboolean is_idle = strstr(availability, "Idle") != NULL;
			purple_prpl_got_user_idle(sa->account, from, is_idle, 0);
		}

		json_object_unref(response);

		// Yield if we have been in this callback for more than 20 ms so that
		// the GTK main loop can process paint and input events before the next
		// batch is processed.
		if (g_get_monotonic_time() > deadline)
			break;
	}

	if (users_to_fetch) {
		teams_get_friend_profiles(sa, users_to_fetch);
		g_slist_free_full(users_to_fetch, g_free);
	}

	if (g_queue_is_empty(sa->pending_presences)) {
		sa->presence_drain_source = 0;
		return G_SOURCE_REMOVE;
	}

	return G_SOURCE_CONTINUE;
}

void
teams_got_contact_statuses(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	// webOS: a presence-snapshot response that lands after a re-login flap would loop over the
	// presences inserting into the freed sa's NULL hashes (flood) and then g_queue_push into the freed
	// NULL pending_presences queue -> SIGSEGV. Bail by pointer check (no deref of the freed sa).
	if (!teams_account_is_live(sa))
		return;

	JsonArray *responses = json_node_get_array(node);

	if (responses == NULL || json_array_get_length(responses) == 0) {
		return;
	}

	// Enqueue all entries onto the shared presence queue, deduplicating by MRI.
	// If an entry for the same MRI is already waiting in the queue, overwrite
	// it with the newer payload since only the most recent status matters.
	// This caps queue depth at the number of unique contacts rather than at the
	// number of incoming API responses, preventing unbounded queue growth when
	// updates arrive faster than the drain can process them.
	guint i, len = json_array_get_length(responses);
	for (i = 0; i < len; i++) {
		JsonObject *resp = json_array_get_object_element(responses, i);
		if (resp == NULL) continue;

		const gchar *mri = json_object_get_string_member(resp, "mri");
		if (!mri || !*mri) continue;

		// PSTN (4:) contacts are telephone numbers, not IM buddies.
		if (g_str_has_prefix(mri, "4:")) continue;

		// Skip if the etag is unchanged since the last drain.
		// The server resends all subscribed contacts' presence on reconnect
		// even when nothing changed; this avoids queuing the entire buddy
		// list when there are no actual status changes.
		const gchar *etag = json_object_get_string_member(resp, "etag");
		if (etag && *etag) {
			const gchar *cached_etag = g_hash_table_lookup(sa->presence_etag_cache, mri);
			if (cached_etag && g_str_equal(cached_etag, etag)) continue;
		}

		// If an entry for this MRI is already queued, overwrite its data in-place.
		// The GList node stays at its current position in the FIFO so ordering is
		// preserved, only the payload is updated.
		GList *existing_node = g_hash_table_lookup(sa->presence_mri_index, mri);
		if (existing_node != NULL) {
			json_object_unref(existing_node->data);
			existing_node->data = json_object_ref(resp);
		} else {
			g_queue_push_tail(sa->pending_presences, json_object_ref(resp));
			// Store the tail GList node for O(1) future in-place updates.
			g_hash_table_insert(sa->presence_mri_index, g_strdup(mri),
			                    sa->pending_presences->tail);
		}
	}

	// Start the drain callback only if it isn't already running.
	// Use g_timeout_add() instead of g_idle_add() so the drain
	// makes progress even when the GLib main loop is continuously
	// occupied with I/O events (a common occurance during login),
	// which would starve an idle source indefinitely.
	if (sa->presence_drain_source == 0) {
		sa->presence_drain_source = g_timeout_add(50, teams_drain_presence_queue, sa);
	}
}

static void
teams_lookup_contact_statuses(TeamsAccount *sa, GSList *contacts)
{
	const gchar *presence_path =  "/v1/presence/getpresence/";
	gchar *post;
	GSList *cur;
	JsonArray *contacts_array;
	guint count = 0;
	
	if (contacts == NULL) {
		return;
	}
	
	cur = contacts;
	contacts_array = json_array_new();
	count = 0;
	
	do {
		JsonObject *contact;
		gchar *id;

		contact = json_object_new();
		
		id = g_strconcat(teams_user_url_prefix(cur->data), cur->data, NULL);
		json_object_set_string_member(contact, "mri", id);
		json_array_add_object_element(contacts_array, contact);
		g_free(id);
		
		if (++count >= 650) {
			// Send off the current batch and continue
			post = teams_jsonarr_to_string(contacts_array);

			teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_PRESENCE_HOST, presence_path, post, teams_got_contact_statuses, NULL, TRUE);
			
			g_free(post);
			
			json_array_unref(contacts_array);
			contacts_array = json_array_new();
			count = 0;
		}
	} while((cur = g_slist_next(cur)));
	
	if (json_array_get_length(contacts_array) > 0) {
		post = teams_jsonarr_to_string(contacts_array);

		teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_PRESENCE_HOST, presence_path, post, teams_got_contact_statuses, NULL, TRUE);
		
		g_free(post);
	}
	json_array_unref(contacts_array);
}

// Drains sa->pending_subscription_contacts at a rate of 100 contacts per 50 ms.
// Called by a recurring g_timeout_add timer. Returns G_SOURCE_REMOVE when the
// queue is empty and G_SOURCE_CONTINUE to reschedule for the next batch.
//
// Spacing the HTTP calls out prevents the server from receiving all
// subscription requests simultaneously, which could cause it to return the
// presence of all subscribed contacts via the Trouter WebSocket all at once.
static gboolean
teams_send_subscription_batch(gpointer user_data)
{
	TeamsAccount *sa = user_data;

	if (!PURPLE_CONNECTION_IS_VALID(sa->pc) || sa->trouter_surl == NULL ||
			g_queue_is_empty(sa->pending_subscription_contacts)) {
		sa->subscription_flush_timer = 0;
		return G_SOURCE_REMOVE;
	}

	JsonArray *subscriptionsToAdd = json_array_new();
	JsonArray *subscriptionsToRemove = json_array_new();
	gchar *trouterUri = g_strconcat(sa->trouter_surl, "/TeamsUnifiedPresenceService", NULL);
	gchar *url = g_strdup_printf("/v1/pubsub/subscriptions/%s", purple_url_encode(sa->endpoint));
	guint count = 0;

	while (!g_queue_is_empty(sa->pending_subscription_contacts) && count < 100) {
		gchar *contact_id = g_queue_pop_head(sa->pending_subscription_contacts);

		JsonObject *contact = json_object_new();
		gchar *id = g_strconcat(teams_user_url_prefix(contact_id), contact_id, NULL);
		json_object_set_string_member(contact, "mri", id);
		json_array_add_object_element(subscriptionsToAdd, contact);
		g_free(id);
		g_free(contact_id);
		count++;
	}

	JsonObject *obj = json_object_new();
	json_object_set_string_member(obj, "trouterUri", trouterUri);
	json_object_set_array_member(obj, "subscriptionsToAdd", subscriptionsToAdd);
	json_object_set_array_member(obj, "subscriptionsToRemove", subscriptionsToRemove);
	json_object_set_boolean_member(obj, "shouldPurgePreviousSubscriptions", FALSE);
	gchar *post = teams_jsonobj_to_string(obj);

	teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_PRESENCE_HOST, url, post, NULL, NULL, TRUE);

	g_free(post);
	json_object_unref(obj);
	g_free(url);
	g_free(trouterUri);

	if (g_queue_is_empty(sa->pending_subscription_contacts)) {
		sa->subscription_flush_timer = 0;
		return G_SOURCE_REMOVE;
	}

	return G_SOURCE_CONTINUE;
}

static gboolean
teams_subscribe_to_contact_status_delay(gpointer contacts_ptr)
{
	GSList *contacts = (GSList *)contacts_ptr;
	if (contacts == NULL) {
		return FALSE;
	}

	// webOS: this repeating g_timeout isn't cancelled by teams_close's purple_http_conn_cancel_all, so
	// it can fire against a freed sa after a re-login flap. teams_account_is_live() checks by pointer
	// (no deref) and must come FIRST so we never reach PURPLE_CONNECTION_IS_VALID(sa->pc) on a freed sa.
	TeamsAccount *sa = g_dataset_get_data(contacts, "teams_account");
	if (!teams_account_is_live(sa) || !PURPLE_CONNECTION_IS_VALID(sa->pc)) {
		g_slist_free_full(contacts, g_free);
		g_dataset_destroy(contacts);
		return FALSE;
	}

	gint attempt_count = GPOINTER_TO_INT(g_dataset_get_data(contacts, "attempt_count"));
	if (attempt_count >= 5) {
		// Websocket not ready after 5 attempts, try the old way
		teams_lookup_contact_statuses(sa, contacts);

		g_slist_free_full(contacts, g_free);
		g_dataset_destroy(contacts);
		return FALSE;
	}

	if (sa->trouter_surl != NULL) {
		teams_subscribe_to_contact_status(sa, contacts);

		g_slist_free_full(contacts, g_free);
		g_dataset_destroy(contacts);
		return FALSE;
	}
	
	g_dataset_set_data(contacts, "attempt_count", GINT_TO_POINTER(attempt_count + 1));

	return TRUE;
}

void
teams_subscribe_to_contact_status(TeamsAccount *sa, GSList *contacts)
{
	if (contacts == NULL) {
		return;
	}
	// webOS: guard against a late call for a freed account (the subscribed_contacts insert loop below
	// would otherwise flood NULL-hash criticals and hang). Pointer check, no deref of a freed sa.
	if (!teams_account_is_live(sa)) {
		return;
	}

	if (sa->trouter_surl == NULL) {
		purple_debug_info("teams", "No trouter surl yet\n");
		GSList *contacts_clone = g_slist_copy_deep(contacts, (GCopyFunc)(GCallback) g_strdup, NULL);
		g_dataset_set_data(contacts_clone, "teams_account", sa);
		g_dataset_set_data(contacts_clone, "attempt_count", GINT_TO_POINTER(0));
		g_timeout_add_seconds(2, teams_subscribe_to_contact_status_delay, contacts_clone);
		return;
	}

	GSList *fallback_contacts = NULL;
	GSList *cur = contacts;

	do {
		// Skip PSTN (telephone) contacts
		// These start with "+" after the "4:" prefix is stripped. The presence
		// service has no useful status data for them.
		if (g_str_has_prefix(cur->data, "+")) {
			continue;
		}

		// Skip contacts we've already subscribed to avoid duplicate subscriptions
		// and the server-side snapshot storm they cause.
		if (g_hash_table_lookup(sa->subscribed_contacts, (gconstpointer) cur->data) != NULL) {
			continue;
		}
		g_hash_table_insert(sa->subscribed_contacts, g_strdup(cur->data), GUINT_TO_POINTER(TRUE));

#ifdef ENABLE_TEAMS_PERSONAL
		if (g_str_has_prefix(cur->data, "orgid:")) {
#else
		if (!g_str_has_prefix(cur->data, "orgid:")) {
#endif
			// Might be an old skype contact that we dont get the realtime presence for
			fallback_contacts = g_slist_prepend(fallback_contacts, g_strdup(cur->data));
		}

		g_queue_push_tail(sa->pending_subscription_contacts, g_strdup(cur->data));

	} while ((cur = g_slist_next(cur)));

	// Start the rate-limited flush timer if it isn't already running.
	if (sa->subscription_flush_timer == 0 &&
			!g_queue_is_empty(sa->pending_subscription_contacts)) {
		sa->subscription_flush_timer = g_timeout_add(50, teams_send_subscription_batch, sa);
	}

	if (fallback_contacts != NULL) {
		//TODO we should be polling for the status of these users
		teams_lookup_contact_statuses(sa, fallback_contacts);
		g_slist_free_full(fallback_contacts, g_free);
	}
}

void
teams_subscribe_to_single_contact_status(TeamsAccount *sa, const gchar *username)
{
	GSList *users_to_fetch = g_slist_prepend(NULL, (gpointer) username);
	teams_subscribe_to_contact_status(sa, users_to_fetch);
	g_slist_free(users_to_fetch);
}

static void
teams_got_vdms_token(PurpleHttpConnection *http_conn, PurpleHttpResponse *response, gpointer user_data)
{
	const gchar *token;
	TeamsAccount *sa = user_data;
	JsonParser *parser = json_parser_new();
	const gchar *data;
	gsize len;
	
	data = purple_http_response_get_data(response, &len);

	if (json_parser_load_from_data(parser, data, len, NULL)) {
		JsonNode *root = json_parser_get_root(parser);
		JsonObject *obj = json_node_get_object(root);

		token = json_object_get_string_member(obj, "token");
		g_free(sa->vdms_token);
		sa->vdms_token = g_strdup(token); 
		sa->vdms_expiry = (int)time(NULL) + TEAMS_VDMS_TTL;
	}

	g_object_unref(parser);
	
}


void
teams_get_vdms_token(TeamsAccount *sa)
{
	const gchar *messages_url = "https://" TEAMS_STATIC_HOST "/pes/v1/petoken";
	PurpleHttpRequest *request;
	
	request = purple_http_request_new(messages_url);
	purple_http_request_set_keepalive_pool(request, sa->keepalive_pool);
	purple_http_request_header_set(request, "Accept", "*/*");
	purple_http_request_header_set(request, "Origin", "https://web.skype.com");
	purple_http_request_header_set_printf(request, "Authorization", "skype_token %s", sa->skype_token);
	purple_http_request_header_set(request, "Content-Type", "application/x-www-form-urlencoded");
	purple_http_request_set_contents(request, "{}", -1);
	purple_http_request(sa->pc, request, teams_got_vdms_token, sa);
	purple_http_request_unref(request);
}


	
static guint
teams_conv_send_typing_to_channel(TeamsAccount *sa, const gchar *channel, PurpleIMTypingState state)
{
	gchar *post, *url;
	JsonObject *obj;

	if (state != PURPLE_IM_TYPING) {
		// Teams no longer sends "I'm not typing" events
		return 0;
	}

	// Give a 2 second buffer to first typing event
	if (sa->last_typing_channel_hash != g_str_hash(channel)) {
		sa->last_typing_channel_hash = g_str_hash(channel);
		sa->last_typing_time = 0;
		return 2;
	}
	// If we've already sent a typing event in the last 20 seconds, don't send another one
	if (sa->last_typing_time > time(NULL) - 20) {
		return sa->last_typing_time + 20 - time(NULL);
	}
	sa->last_typing_time = time(NULL);
	
	url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/messages", purple_url_encode(channel));
	
	obj = json_object_new();
	json_object_set_string_member(obj, "messagetype", state == PURPLE_IM_TYPING ? "Control/Typing" : "Control/ClearTyping");
	json_object_set_string_member(obj, "contenttype", "Application/Message");
	json_object_set_string_member(obj, "content", "");
	
	post = teams_jsonobj_to_string(obj);
	
	teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, post, NULL, NULL, TRUE);
	
	g_free(post);
	json_object_unref(obj);
	g_free(url);
	
	return 20;
}

guint
teams_conv_send_typing(PurpleConversation *conv, PurpleIMTypingState state)
{
	PurpleConnection *pc = purple_conversation_get_connection(conv);
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	
	if (!PURPLE_CONNECTION_IS_CONNECTED(pc))
		return 0;
	
	if (!purple_strequal(purple_protocol_get_id(purple_connection_get_protocol(pc)), TEAMS_PLUGIN_ID))
		return 0;
	
	return teams_conv_send_typing_to_channel(sa, purple_conversation_get_name(conv), state);
}

guint
teams_send_typing(PurpleConnection *pc, const gchar *name, PurpleIMTypingState state)
{
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);

	/* Personal/TFL: do NOT inject a legacy "8:<user>" mapping here. Consumer 1:1s
	 * are threads (19:uni01_...), and poisoning buddy_to_chat_lookup with "8:<user>"
	 * would also break teams_send_im (it 404s on the consumer backend). Only send a
	 * typing indicator if we already know the real thread; otherwise skip it (typing
	 * is best-effort and the thread gets learned/created on the first real send). */
	const gchar *channel = g_hash_table_lookup(sa->buddy_to_chat_lookup, name);

	if (channel) {
		return teams_conv_send_typing_to_channel(sa, channel, state);
	}

	return 0;
}


static void
teams_forceavailability_cb(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	(void) sa; (void) user_data;
	teams_call_log("forceavailability: response received (node=%p)", (void *) node);
}

static void
teams_set_global_statusid(TeamsAccount *sa, const gchar *status)
{
	gchar *post;

	g_return_if_fail(status);

	// This sets our status everywhere, including on other clients

	post = g_strdup_printf("{\"availability\":\"%s\"}", status);
	teams_call_log("forceavailability: PUTting availability=%s", status);
	teams_post_or_get(sa, TEAMS_METHOD_PUT | TEAMS_METHOD_SSL, TEAMS_PRESENCE_HOST, "/v1/me/forceavailability/", post, teams_forceavailability_cb, NULL, TRUE);
	g_free(post);


}

static void
teams_set_endpoint_statusid(TeamsAccount *sa, const gchar *status)
{
	gchar *post;
	const gchar *activity;
	
	g_return_if_fail(status);

	// Only works with Available/Available for "Transport" activity reporting type
	// TODO remove this function since we don't need to set the status on the endpoint anymore
	status = "Available";
	activity = "Available";

	// This lets the 'reportmyactivity' idle/active endpoint work
	// and sets our status only on this endpoint
	//https://presence.teams.microsoft.com/v1/me/endpoints/
	// {
	// 	"id": "... endpoint id ...",
	// 	"availability": "Available",
	// 	"activity": "Available",
	// 	"activityReporting": "Transport",
	//	"capabilities": ["Audio", "Video"],
	// 	"deviceType": "Desktop"
	// }
	post = g_strdup_printf("{\"id\":\"%s\",\"availability\":\"%s\",\"activity\":\"%s\",\"activityReporting\":\"Transport\",\"deviceType\":\"Desktop\"}", sa->endpoint, status, activity);
	teams_post_or_get(sa, TEAMS_METHOD_PUT | TEAMS_METHOD_SSL, TEAMS_PRESENCE_HOST, "/v1/me/endpoints/", post, NULL, NULL, TRUE);
	g_free(post);
}

void
teams_set_status(PurpleAccount *account, PurpleStatus *status)
{
	PurpleConnection *pc = purple_account_get_connection(account);
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	const gchar *statusid = purple_status_get_id(status);

	teams_set_endpoint_statusid(sa, statusid);
	
	if (!purple_account_get_bool(account, "set-global-status", TRUE)) {
		return;
	}
	
	teams_set_global_statusid(sa, statusid);
	teams_set_mood_message(sa, purple_status_get_attr_string(status, "message"));
}

/* Diagnostic-only response callback for the isActive heartbeat POST below - purple_debug_info's
 * "teams" category isn't visible in this deployment's log config at all (confirmed empty grep
 * across a whole session's imstdout.log), so there was previously zero visibility into whether
 * this periodic heartbeat was actually firing/succeeding. Routes through teams_call_log() instead,
 * which reliably reaches teams-call.log (added 2026-08-05 while investigating a real live symptom:
 * account showing "Away"/a stale "last seen" on the peer's client, correlating with "we couldn't
 * complete the call" - see teams_set_idle's own comment for why stale isActive breaks call
 * routing specifically). */
static void
teams_report_activity_cb(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	(void) sa; (void) user_data;
	teams_call_log("reportmyactivity: response received (node=%p)", (void *) node);
}

void
teams_set_idle(PurpleConnection *pc, int time)
{
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	gboolean is_active = TRUE;
	gchar *post;

	/* CAPTURED LIVE (2026-08-01): `time` here is webOS's PHYSICAL touchscreen/keyboard idle
	 * clock (libpurple core also calls this directly via prpl_info->set_idle whenever that
	 * clock ticks, not just from teams_idle_update's 120s poll below). This device runs the
	 * Teams account as an always-on background messaging bridge, not something anyone sits
	 * and touches - so that clock is "idle" almost permanently, and gating isActive on it
	 * reported isActive:false to Microsoft's presence backend every ~2 minutes. Teams gates
	 * whether a call can even be ROUTED to an account on its published availability, so the
	 * account read as Away/unavailable most of the time and callers got an instant "Cannot
	 * complete the call" without any signaling ever reaching us - until a fresh login
	 * (teams_set_status force-publishes Available) or a lucky screen-wake right before
	 * dialing reset the clock. Always report active instead, same as the other always-on
	 * connectors on this device. */
	(void) time;

	post = g_strdup_printf("{\"endpointId\":\"%s\",\"isActive\":%s}", sa->endpoint, is_active ? "true" : "false");
	teams_call_log("reportmyactivity: POSTing isActive=%s (endpoint=%s)", is_active ? "true" : "false",
	               sa->endpoint ? sa->endpoint : "(null)");
	//TODO check if it's a 404 response and recreate the endpoint (by resetting the availability) if it's gone
	teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_PRESENCE_HOST, "/v1/me/reportmyactivity/", post, teams_report_activity_cb, NULL, TRUE);
	g_free(post);

	// send isactive on trouter if it's connected
	teams_trouter_send_active(sa, is_active);
}

gboolean
teams_idle_update(TeamsAccount *sa)
{
	PurplePresence *presence;
	gboolean is_idle;

	if (sa == NULL) {
		return FALSE;
	}

	if (!PURPLE_IS_CONNECTION(sa->pc) || purple_connection_get_state(sa->pc) != PURPLE_CONNECTED) {
		return FALSE;
	}

	presence = purple_account_get_presence(sa->account);
	is_idle = purple_presence_is_idle(presence);
	teams_set_idle(sa->pc, is_idle ? 30 : 0);

	/* Found+fixed 2026-08-05: teams_set_status()'s PUT to /v1/me/forceavailability/ (see
	 * teams_set_global_statusid) is a TIME-LIMITED override - the real trouter presence push
	 * captured in teams_trouter_send_authentication's own comment shows a "forcedAvailability"
	 * object with an explicit "expiry" field. It was only ever called ONCE, at login
	 * (libteams.c's "logged in" handler), with nothing refreshing it afterward - unlike the
	 * isActive heartbeat above, which this same function already re-fires every 120s and was
	 * confirmed live to keep working throughout a call. CAPTURED LIVE: an account showed as
	 * "Away"/a stale "last seen" (correlating almost exactly with a several-minute-old value) to
	 * a peer despite isActive pings landing on schedule the whole time, and every incoming call
	 * during that window failed instantly with "we couldn't complete the call" - see
	 * teams_set_idle's own comment for why Teams gates call routing on published availability.
	 * Piggyback the refresh on this already-proven-reliable 120s timer instead of adding a new
	 * one.
	 *
	 * Hardcode "Available" rather than re-publishing purple_account_get_active_status()
	 * (found+fixed 2026-08-05, same session): CAPTURED LIVE, that status genuinely reads back as
	 * "Away" on this device - libpurple's own core auto-away, driven by the same physical
	 * touchscreen/keyboard idle clock teams_set_idle's comment already explains is idle almost
	 * permanently here. Re-publishing it just faithfully (and now reliably) broadcast "Away"
	 * instead of fixing anything. Matches teams_set_endpoint_statusid's own established pattern
	 * just above, which already unconditionally hardcodes "Available" for the same always-on-bridge
	 * reason - and bypasses teams_set_status/the "set-global-status" pref entirely, since this is
	 * an internal keep-alive refresh, not a real user-driven status change (those still go through
	 * the normal prpl_info->set_status path via teams_set_status, unaffected by this). */
	teams_set_global_statusid(sa, "Available");

	return TRUE;
}


static void
teams_sent_message_cb(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	gchar *convname = user_data;
	JsonObject *obj = NULL;
	
	if (node != NULL && json_node_get_node_type(node) == JSON_NODE_OBJECT)
		obj = json_node_get_object(node);
	
	if (obj != NULL) {
		if (json_object_has_member(obj, "errorCode")) {
			PurpleChatConversation *chatconv = purple_conversations_find_chat_with_account(convname, sa->account);
			if (chatconv == NULL) {
				purple_conversation_present_error(teams_strip_user_prefix(convname), sa->account, json_object_get_string_member(obj, "message"));
			} else {
				PurpleMessage *msg = purple_message_new_system(json_object_get_string_member(obj, "message"), PURPLE_MESSAGE_ERROR);
				purple_conversation_write_message(PURPLE_CONVERSATION(chatconv), msg);
				purple_message_destroy(msg);
			}
		}
	}
	
	g_free(convname);
}

static void teams_conversation_check_message_for_images(TeamsAccount *sa, const gchar *convname, gchar *message);

static void
teams_send_message(TeamsAccount *sa, const gchar *convname, const gchar *message)
{
	gchar *post, *url;
	JsonObject *obj;
	gint64 clientmessageid;
	gchar *clientmessageid_str;
	gchar *stripped;
	static GRegex *font_strip_regex = NULL;
	gchar *font_stripped;
	
	
	url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/messages", purple_url_encode(convname));
	
	clientmessageid = teams_get_js_time();
	clientmessageid_str = g_strdup_printf("%" G_GINT64_FORMAT "", clientmessageid);
	
	// Some clients don't receive messages with <br>'s in them
	//stripped = purple_strreplace(message, "<br>", "\r\n");
	stripped = g_strdup(message);
	
	teams_conversation_check_message_for_images(sa, convname, stripped);
	if (!stripped || !*stripped) {
		// Nothing to send
		g_free(url);
		g_free(clientmessageid_str);
		return;
	}
	
	// Pidgin has a nasty habit of sending <font size="3"> when copy-pasting text
	if (font_strip_regex == NULL) {
		font_strip_regex = g_regex_new("(<font [^>]*)size=\"[0-9]+\"([^>]*>)", G_REGEX_CASELESS | G_REGEX_RAW | G_REGEX_OPTIMIZE, 0, NULL);
	}
	font_stripped = g_regex_replace(font_strip_regex, stripped, -1, 0, "\\1\\2", 0, NULL);
	if (font_stripped != NULL) {
		g_free(stripped);
		stripped = font_stripped;
	}
	
	// NOTE: obj MUST be created for every message. A prior edit left this behind a braceless
	// `if (strstr(stripped,"blockquote"))`, so only reply/quote messages (which contain <blockquote>)
	// got a valid obj; every other send -- plain text AND file/image <URIObject> -- built its JSON on
	// an UNINITIALISED pointer, so the chat POST was malformed and the message never reached the
	// recipient (the "outgoing image/file doesn't arrive" bug; also UB that churned the transport).
	obj = json_object_new();
	json_object_set_string_member(obj, "clientmessageid", clientmessageid_str);
	json_object_set_string_member(obj, "content", stripped);
	if (G_UNLIKELY(g_str_has_prefix(message, "<URIObject "))) {
		json_object_set_string_member(obj, "messagetype", "RichText/Media_GenericFile"); //hax!
	} else {
		json_object_set_string_member(obj, "messagetype", "RichText/Html");
	}
	json_object_set_string_member(obj, "contenttype", "text");
	json_object_set_string_member(obj, "imdisplayname", sa->self_display_name ? sa->self_display_name : sa->username);
	
	if (g_str_has_prefix(message, "/me ")) {
		json_object_set_string_member(obj, "skypeemoteoffset", "4"); //Why is this a string :(
	}
	
	post = teams_jsonobj_to_string(obj);
	
	teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, post, teams_sent_message_cb, g_strdup(convname), TRUE);
	
	g_free(post);
	json_object_unref(obj);
	g_free(url);
	g_free(stripped);
	
	g_hash_table_insert(sa->sent_messages_hash, clientmessageid_str, clientmessageid_str);
}

/* webOS voice notes (SEND). A Teams voice note is NOT a File.1 URIObject -- it is a
 * RichText/Html message carrying an audio CARD in properties.cards (captured from a real
 * Android->Teams voice note):
 *   content:  <div><span itemid="<GUID>" itemscope="" itemtype="http://schema.skype.com/InputExtension"></span></div>
 *   amsreferences: ["<audio-object-id>"]
 *   properties.cards: [{"cardClientId":"<GUID>","content":{"duration":"PT<N>S",
 *                       "media":[{"url":".../objects/<id>/views/audio"}]},
 *                       "contentType":"application/vnd.microsoft.card.audio"}]
 *   properties.formatVariant: "TEAMS"
 * The GUID ties the content span's itemid to the card's cardClientId. The audio object must
 * have been created as an audio ASM object (so it has a /views/audio view) and its content
 * uploaded -- see teams_xfer_send_init/_begin (is_audio). */
void
teams_send_audio_card(TeamsAccount *sa, const gchar *who, const gchar *object_id, guint duration_secs)
{
	gchar *post, *url, *content, *cards, *media_url, *guid, *convname_enc;
	const gchar *convname;
	JsonObject *obj, *props;
	JsonArray *amsrefs;
	gint64 clientmessageid;
	gchar *clientmessageid_str;

	if (object_id == NULL || !*object_id)
		return;

	/* Resolve buddy -> 1:1 thread the same way teams_send_im does; a group name is already a thread id. */
	convname = who ? g_hash_table_lookup(sa->buddy_to_chat_lookup, who) : NULL;
	if (convname == NULL)
		convname = who;
	if (convname == NULL || !*convname)
		return;

	convname_enc = g_strdup(purple_url_encode(convname));
	url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/messages", convname_enc);
	g_free(convname_enc);

	clientmessageid = teams_get_js_time();
	clientmessageid_str = g_strdup_printf("%" G_GINT64_FORMAT "", clientmessageid);

	/* 32-hex GUID (no dashes), used as BOTH the content span's itemid and the card's cardClientId. */
	guid = g_strdup_printf("%08x%08x%08x%08x", g_random_int(), g_random_int(), g_random_int(), g_random_int());

	media_url = g_strdup_printf("https://%s/v1/objects/%s/views/audio", TEAMS_XFER_HOST, purple_url_encode(object_id));

	content = g_strdup_printf(
		"<div><span itemid=\"%s\" itemscope=\"\" itemtype=\"http://schema.skype.com/InputExtension\"></span></div>",
		guid);

	/* properties.cards is itself a JSON STRING (a serialised one-element array), matching the wire format. */
	cards = g_strdup_printf(
		"[{\"cardClientId\":\"%s\",\"content\":{\"duration\":\"PT%uS\",\"media\":[{\"url\":\"%s\"}]},"
		"\"contentType\":\"application/vnd.microsoft.card.audio\"}]",
		guid, duration_secs > 0 ? duration_secs : 1, media_url);

	obj = json_object_new();
	json_object_set_string_member(obj, "clientmessageid", clientmessageid_str);
	json_object_set_string_member(obj, "content", content);
	json_object_set_string_member(obj, "messagetype", "RichText/Html");
	json_object_set_string_member(obj, "contenttype", "text");
	json_object_set_string_member(obj, "imdisplayname", sa->self_display_name ? sa->self_display_name : sa->username);

	amsrefs = json_array_new();
	json_array_add_string_element(amsrefs, object_id);
	json_object_set_array_member(obj, "amsreferences", amsrefs);

	props = json_object_new();
	json_object_set_string_member(props, "cards", cards);
	json_object_set_string_member(props, "formatVariant", "TEAMS");
	json_object_set_object_member(obj, "properties", props);

	post = teams_jsonobj_to_string(obj);
	purple_debug_info("teams", "sending voice-note card: %s\n", post);

	teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, post, teams_sent_message_cb, g_strdup(convname), TRUE);

	g_free(post);
	json_object_unref(obj);
	g_free(url);
	g_free(content);
	g_free(cards);
	g_free(media_url);
	g_free(guid);

	g_hash_table_insert(sa->sent_messages_hash, clientmessageid_str, clientmessageid_str);
}

/* webOS video clips (SEND). A Teams video message is a RichText/Html message whose content is an inline
 * AMSVideo <video> element -- exactly parallel to how an image is an inline AMSImage <img> (NOT a card).
 * Verified against a real incoming Teams video:
 *   content: <p><video src=".../objects/<id>/views/video" itemscope="" itemtype="http://schema.skype.com/AMSVideo"
 *                       width="720" height="1280" data-duration="PT27S" alt="Media"
 *                       style="separateMediaAttachmentEnabled:true"></video></p>
 *   amsreferences: ["<id>"]
 *   properties.formatVariant: "TEAMS"
 * The object must have been created as a "sharing/video" ASM object with its content uploaded to
 * /content/video (so it has a /views/video view) -- see teams_xfer_send_init/_begin (is_video).
 * width/height/duration are parsed from the mp4 (teams_mp4_video_info); 0 => omit the hint. */
void
teams_send_video_card(TeamsAccount *sa, const gchar *who, const gchar *object_id,
	guint width, guint height, guint duration_secs)
{
	gchar *post, *url, *content, *media_url, *dur_attr, *dim_attr, *convname_enc;
	const gchar *convname;
	JsonObject *obj, *props;
	JsonArray *amsrefs;
	gint64 clientmessageid;
	gchar *clientmessageid_str;

	if (object_id == NULL || !*object_id)
		return;

	/* Resolve buddy -> 1:1 thread the same way teams_send_im does; a group name is already a thread id. */
	convname = who ? g_hash_table_lookup(sa->buddy_to_chat_lookup, who) : NULL;
	if (convname == NULL)
		convname = who;
	if (convname == NULL || !*convname)
		return;

	convname_enc = g_strdup(purple_url_encode(convname));
	url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX "/v1/users/ME/conversations/%s/messages", convname_enc);
	g_free(convname_enc);

	clientmessageid = teams_get_js_time();
	clientmessageid_str = g_strdup_printf("%" G_GINT64_FORMAT "", clientmessageid);

	media_url = g_strdup_printf("https://%s/v1/objects/%s/views/video", TEAMS_XFER_HOST, purple_url_encode(object_id));
	dim_attr = (width > 0 && height > 0) ? g_strdup_printf(" width=\"%u\" height=\"%u\"", width, height) : g_strdup("");
	dur_attr = (duration_secs > 0) ? g_strdup_printf(" data-duration=\"PT%uS\"", duration_secs) : g_strdup("");

	content = g_strdup_printf(
		"<p><video src=\"%s\" itemscope=\"\" itemtype=\"http://schema.skype.com/AMSVideo\"%s%s "
		"alt=\"Media\" style=\"separateMediaAttachmentEnabled:true\"></video></p>",
		media_url, dim_attr, dur_attr);

	obj = json_object_new();
	json_object_set_string_member(obj, "clientmessageid", clientmessageid_str);
	json_object_set_string_member(obj, "content", content);
	json_object_set_string_member(obj, "messagetype", "RichText/Html");
	json_object_set_string_member(obj, "contenttype", "text");
	json_object_set_string_member(obj, "imdisplayname", sa->self_display_name ? sa->self_display_name : sa->username);

	amsrefs = json_array_new();
	json_array_add_string_element(amsrefs, object_id);
	json_object_set_array_member(obj, "amsreferences", amsrefs);

	props = json_object_new();
	json_object_set_string_member(props, "formatVariant", "TEAMS");
	json_object_set_object_member(obj, "properties", props);

	post = teams_jsonobj_to_string(obj);
	purple_debug_info("teams", "sending video message: %s\n", post);

	teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url, post, teams_sent_message_cb, g_strdup(convname), TRUE);

	g_free(post);
	json_object_unref(obj);
	g_free(url);
	g_free(content);
	g_free(media_url);
	g_free(dim_attr);
	g_free(dur_attr);

	g_hash_table_insert(sa->sent_messages_hash, clientmessageid_str, clientmessageid_str);
}


/* ------------------------------------------------------------------------------------
 * webOS reactions (SEND): handle the transport's "webos-im-send-reaction" signal.
 * ------------------------------------------------------------------------------------ */
static void
teams_send_reaction_cb(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	(void) sa;
	(void) user_data;
	if (node != NULL && json_node_get_node_type(node) == JSON_NODE_OBJECT) {
		gchar *str = teams_jsonobj_to_string(json_node_get_object(node));
		purple_debug_info("teams", "send-reaction response: %s\n", str ? str : "(null)");
		g_free(str);
	} else {
		purple_debug_info("teams", "send-reaction response: (empty / non-object)\n");
	}
}

/* Connected once (process-wide) from teams_login(). The transport fires this for EVERY
 * account when the user reacts on the TouchPad, so we filter to this plugin. `peer` is the
 * buddy/chat name the transport tracked, `targetServiceMessageId` the message id we stashed,
 * `emoji` the Unicode emoji, `removeFlag` "1" to clear the user's reaction. */
void
teams_send_reaction_signal_cb(PurpleAccount *account, const gchar *targetServiceMessageId,
	const gchar *emoji, const gchar *peer, const gchar *removeFlag, gpointer user_data)
{
	PurpleConnection *pc;
	TeamsAccount *sa;
	const gchar *convname;
	const gchar *emotion_key;
	gchar *enc_conv, *enc_msg, *url, *post;
	JsonObject *obj, *emotions_obj;
	gboolean remove = (removeFlag && removeFlag[0] == '1');

	(void) user_data;

	if (account == NULL || targetServiceMessageId == NULL || !*targetServiceMessageId)
		return;
	/* The signal is process-wide; only handle our own protocol's accounts. */
	if (!purple_strequal(purple_account_get_protocol_id(account), TEAMS_THIS_PLUGIN_ID))
		return;

	pc = purple_account_get_connection(account);
	if (pc == NULL)
		return;
	sa = purple_connection_get_protocol_data(pc);
	if (sa == NULL)
		return;

	emotion_key = teams_emoji_to_emotion_key(emoji);
	if (emotion_key == NULL) {
		purple_debug_warning("teams", "send-reaction: no Teams emotion for emoji '%s', ignoring\n",
			emoji ? emoji : "(null)");
		return;
	}

	/* Resolve peer -> conversation/thread id exactly as teams_send_im does: a 1:1 buddy maps
	 * through buddy_to_chat_lookup to its thread; a group chat name IS already the thread id. */
	convname = peer ? g_hash_table_lookup(sa->buddy_to_chat_lookup, peer) : NULL;
	if (convname == NULL)
		convname = peer;
	if (convname == NULL || !*convname) {
		purple_debug_warning("teams", "send-reaction: could not resolve conversation for peer '%s'\n",
			peer ? peer : "(null)");
		return;
	}

	/* ---------------------------------------------------------------------------------
	 * Confirmed against the decompiled Teams Android app (consumer chatsvc / Skype-lineage):
	 *   ADD:    PUT    .../v1/users/ME/conversations/{conv}/messages/{id}/properties?name=emotions
	 *   REMOVE: DELETE (with the SAME body) to the same URL
	 *   body (both): {"emotions":{"key":"<emotion>","value":<ms>}}
	 * `value` is an UNQUOTED client timestamp in ms (a JSON NUMBER) - a string body returns 2xx but
	 * is silently ignored. Content-Type must be application/json (teams_post_or_get sets it for
	 * PUT/DELETE-with-body). Removal is a DELETE carrying the body, NOT a PUT with an "unset" field.
	 * --------------------------------------------------------------------------------- */
	emotions_obj = json_object_new();
	json_object_set_string_member(emotions_obj, "key", emotion_key);
	json_object_set_int_member(emotions_obj, "value", teams_get_js_time());
	obj = json_object_new();
	json_object_set_object_member(obj, "emotions", emotions_obj);
	post = teams_jsonobj_to_string(obj);

	/* purple_url_encode() returns a shared static buffer — encode each component into its
	 * own allocation before composing the URL, or the second call clobbers the first. */
	enc_conv = g_strdup(purple_url_encode(convname));
	enc_msg = g_strdup(purple_url_encode(targetServiceMessageId));
	url = g_strdup_printf(TEAMS_CONTACTS_PATH_PREFIX
		"/v1/users/ME/conversations/%s/messages/%s/properties?name=emotions",
		enc_conv, enc_msg);

	purple_debug_info("teams", "send-reaction %s emoji='%s' key='%s' -> %s https://%s%s body=%s\n",
		remove ? "REMOVE" : "ADD", emoji ? emoji : "", emotion_key,
		remove ? "DELETE" : "PUT", TEAMS_CONTACTS_HOST, url, post);

	teams_post_or_get(sa, (remove ? TEAMS_METHOD_DELETE : TEAMS_METHOD_PUT) | TEAMS_METHOD_SSL,
		TEAMS_CONTACTS_HOST, url, post, teams_send_reaction_cb, NULL, TRUE);

	g_free(enc_conv);
	g_free(enc_msg);
	g_free(url);
	g_free(post);
	json_object_unref(obj);
}

gint
teams_chat_send(PurpleConnection *pc, gint id,
#if PURPLE_VERSION_CHECK(3, 0, 0)
PurpleMessage *msg)
{
	const gchar *message = purple_message_get_contents(msg);
#else
const gchar *message, PurpleMessageFlags flags)
{
#endif
	
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	
	PurpleChatConversation *chatconv;
	const gchar* chatname;
	
	chatconv = purple_conversations_find_chat(pc, id);
	chatname = purple_conversation_get_data(PURPLE_CONVERSATION(chatconv), "chatname");
	if (!chatname) {
		// Fix for a condition around the chat data and serv_got_joined_chat()
		chatname = purple_conversation_get_name(PURPLE_CONVERSATION(chatconv));
		if (!chatname)
			return -1;
		}

	// webOS replies: if the transport stashed a reply target on this chat conv, prepend the full Teams
	// <quote> block (rebuilt from the cached original) so the sent message threads on other clients.
	gchar *reply_to = (gchar *)purple_conversation_get_data(PURPLE_CONVERSATION(chatconv), "webos-reply-to");
	gchar *outgoing = NULL;
	if (reply_to != NULL && *reply_to) {
		gchar *quote = teams_build_quote_block(sa, reply_to);
		if (quote != NULL) {
			outgoing = g_strconcat(quote, message, NULL);
			g_free(quote);
		}
	}
	if (reply_to != NULL) {
		purple_conversation_set_data(PURPLE_CONVERSATION(chatconv), "webos-reply-to", NULL);
		g_free(reply_to);
	}

	teams_send_message(sa, chatname, outgoing ? outgoing : message);
	g_free(outgoing);

	// local echo shows the clean reply body (the transport ignores this SEND echo anyway)
	purple_serv_got_chat_in(pc, id, sa->username, PURPLE_MESSAGE_SEND, message, time(NULL));

	return 1;
}

gint
teams_send_im(PurpleConnection *pc, 
#if PURPLE_VERSION_CHECK(3, 0, 0)
PurpleMessage *msg)
{
	const gchar *who = purple_message_get_recipient(msg);
	const gchar *message = purple_message_get_contents(msg);
#else
const gchar *who, const gchar *message, PurpleMessageFlags flags)
{
#endif

	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	const gchar *convname;

	// webOS replies: capture the reply target the transport stashed on this buddy's IM conv BEFORE `who`
	// is rewritten below (the stash is keyed by the original recipient).
	gchar *reply_to = NULL;
	{
		PurpleIMConversation *imc = purple_conversations_find_im_with_account(who, sa->account);
		if (imc != NULL) {
			reply_to = (gchar *)purple_conversation_get_data(PURPLE_CONVERSATION(imc), "webos-reply-to");
			if (reply_to != NULL)
				purple_conversation_set_data(PURPLE_CONVERSATION(imc), "webos-reply-to", NULL);
		}
	}

	if (teams_is_user_self(sa, who)) {
		// Fake internal app for self-messages
		who = "48:notes";
	}
	
	if (TEAMS_BUDDY_IS_NOTIFICATIONS(who)) {
		convname = who;
	} else {
		/* Personal/TFL: consumer/TFL 1:1 chats flow through the Teams THREAD model
		 * (19:uni01_...@thread.v2), same as corporate — NOT the legacy Skype peer-to-peer
		 * "8:<user>" form, which the consumer backend (chatsvc/consumer) 404s. Resolve the
		 * buddy to its known 1:1 thread; if we haven't learned it yet, fall through to
		 * teams_initiate_chat() below, which creates/redirects to the uniquerosterthread. */
		convname = g_hash_table_lookup(sa->buddy_to_chat_lookup, who);
	}

	//convname should be like
	//19:{guid of user1}_{guid of user2}@unq.gpl.spaces

	if (!convname) {
		teams_initiate_chat(sa, who, TRUE, message);
		g_free(reply_to);
		return 0;
	}

	gchar *outgoing = NULL;
	if (reply_to != NULL && *reply_to) {
		gchar *quote = teams_build_quote_block(sa, reply_to);
		if (quote != NULL) {
			outgoing = g_strconcat(quote, message, NULL);
			g_free(quote);
		}
	}
	g_free(reply_to);

	teams_send_message(sa, convname, outgoing ? outgoing : message);
	g_free(outgoing);

	return 1;
}


void
teams_chat_invite(PurpleConnection *pc, int id, const char *message, const char *who)
{
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	PurpleChatConversation *chatconv;
	gchar *chatname;
	gchar *post;
	GString *url;

	chatconv = purple_conversations_find_chat(pc, id);
	chatname = purple_conversation_get_data(PURPLE_CONVERSATION(chatconv), "chatname");
	
	url = g_string_new(TEAMS_CONTACTS_PATH_PREFIX "/v1/threads/");
	g_string_append_printf(url, "%s", purple_url_encode(chatname));
	g_string_append(url, "/members/");
	g_string_append_printf(url, "%s%s", teams_user_url_prefix(who), purple_url_encode(who));
	
	post = "{\"role\":\"User\"}";
	
	teams_post_or_get(sa, TEAMS_METHOD_PUT | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url->str, post, NULL, NULL, TRUE);
	
	g_string_free(url, TRUE);
}

void
teams_chat_kick(PurpleConnection *pc, int id, const char *who)
{
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	PurpleChatConversation *chatconv;
	gchar *chatname;
	gchar *post;
	GString *url;

	chatconv = purple_conversations_find_chat(pc, id);
	chatname = purple_conversation_get_data(PURPLE_CONVERSATION(chatconv), "chatname");
	
	url = g_string_new(TEAMS_CONTACTS_PATH_PREFIX "/v1/threads/");
	g_string_append_printf(url, "%s", purple_url_encode(chatname));
	g_string_append(url, "/members/");
	g_string_append_printf(url, "%s%s", teams_user_url_prefix(who), purple_url_encode(who));
	
	post = "";
	
	teams_post_or_get(sa, TEAMS_METHOD_DELETE | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url->str, post, NULL, NULL, TRUE);
	
	g_string_free(url, TRUE);
}

static void
teams_created_chat(TeamsAccount *sa, JsonNode *node, gpointer user_data)
{
	JsonObject *obj = json_node_get_object(node);
	gchar *initial_message_copy = user_data;
	const gchar *convname = json_object_get_string_member(obj, "id");
	gint64 errorCode = json_object_get_int_member(obj, "errorCode");
	
	if (!errorCode && convname != NULL && initial_message_copy && *initial_message_copy) {
		process_thread_resource(sa, obj);
		
		teams_send_message(sa, convname, initial_message_copy);
		
		const gchar *convbuddyname = g_hash_table_lookup(sa->chat_to_buddy_lookup, convname);
		if (convbuddyname != NULL) {
			PurpleMessage *msg;
			PurpleIMConversation *conv = purple_conversations_find_im_with_account(convbuddyname, sa->account);
			
			msg = purple_message_new_outgoing(convbuddyname, initial_message_copy, PURPLE_MESSAGE_SEND);
			purple_message_set_time(msg, time(NULL));
			purple_conversation_write_message(PURPLE_CONVERSATION(conv), msg);
			purple_message_destroy(msg);
		}
		
	} else if (errorCode) {
		const gchar *message = json_object_get_string_member(obj, "message");
		
		//TODO present the error somehow... popup?
		(void) message;
	}
	
	g_free(initial_message_copy);
}

void
teams_initiate_chat(TeamsAccount *sa, const gchar *who, gboolean one_to_one, const gchar *initial_message)
{
	JsonObject *obj, *contact, *properties;
	JsonArray *members;
	gchar *id, *post, *initial_message_copy;
	TeamsConnection *conn;
	
	obj = json_object_new();
	members = json_array_new();
	
	contact = json_object_new();
	id = g_strconcat(teams_user_url_prefix(who), who, NULL);
	json_object_set_string_member(contact, "id", id);
	json_object_set_string_member(contact, "role", "User");
	json_array_add_object_element(members, contact);
	g_free(id);
	
	contact = json_object_new();
	id = g_strconcat(teams_user_url_prefix(sa->username), sa->username, NULL);
	json_object_set_string_member(contact, "id", id);
	json_object_set_string_member(contact, "role", "Admin");
	json_array_add_object_element(members, contact);
	g_free(id);
	
	json_object_set_array_member(obj, "members", members);
	
	properties = json_object_new();
	json_object_set_string_member(properties, "threadType", "chat");
	json_object_set_string_member(properties, "chatFilesIndexId", "2");
	if (one_to_one) {
		json_object_set_string_member(properties, "fixedRoster", "true");
		json_object_set_string_member(properties, "uniquerosterthread", "true");
	}
	json_object_set_object_member(obj, "properties", properties);
	
	post = teams_jsonobj_to_string(obj);
	
	if (initial_message && *initial_message) {
		initial_message_copy = g_strdup(initial_message);
	} else {
		initial_message_copy = NULL;
	}
	
	conn = teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, TEAMS_CONTACTS_PATH_PREFIX "/v1/threads", post, teams_created_chat, initial_message_copy, TRUE);
	
	// Enable redirects
	if (conn != NULL) {
		PurpleHttpRequest *request = purple_http_conn_get_request(conn->http_conn);
		purple_http_request_set_max_redirects(request, 1);
	}

	g_free(post);
	json_object_unref(obj);
}

void
teams_initiate_chat_from_node(PurpleBlistNode *node, gpointer userdata)
{
	if(PURPLE_IS_BUDDY(node))
	{
		PurpleBuddy *buddy = (PurpleBuddy *) node;
		TeamsAccount *sa;
		
		if (userdata) {
			sa = userdata;
		} else {
			PurpleConnection *pc = purple_account_get_connection(purple_buddy_get_account(buddy));
			sa = purple_connection_get_protocol_data(pc);
		}
		
		teams_initiate_chat(sa, purple_buddy_get_name(buddy), FALSE, NULL);
	}
}

void
teams_chat_set_topic(PurpleConnection *pc, int id, const char *topic)
{
	TeamsAccount *sa = purple_connection_get_protocol_data(pc);
	PurpleChatConversation *chatconv;
	JsonObject *obj;
	gchar *chatname;
	gchar *post;
	GString *url;

	chatconv = purple_conversations_find_chat(pc, id);
	chatname = purple_conversation_get_data(PURPLE_CONVERSATION(chatconv), "chatname");
	
	url = g_string_new(TEAMS_CONTACTS_PATH_PREFIX "/v1/threads/");
	g_string_append_printf(url, "%s", purple_url_encode(chatname));
	g_string_append(url, "/properties?name=topic");
	
	obj = json_object_new();
	json_object_set_string_member(obj, "topic", topic);
	post = teams_jsonobj_to_string(obj);
	
	teams_post_or_get(sa, TEAMS_METHOD_PUT | TEAMS_METHOD_SSL, TEAMS_CONTACTS_HOST, url->str, post, NULL, NULL, TRUE);
	
	g_string_free(url, TRUE);
	g_free(post);
	json_object_unref(obj);
}

void
teams_get_thread_url(TeamsAccount *sa, const gchar *thread)
{
	//POST https://api.scheduler.skype.com/threads
	//{"baseDomain":"https://join.skype.com/launch/","threadId":"%s"}
	
	// {"Id":"MeMxigEAAAAxOTo5NDZkMjExMGQ4YmU0ZjQzODc3NjMxNDQ3ZTgxYWNmNkB0aHJlYWQuc2t5cGU","Blob":null,"JoinUrl":"https://join.skype.com/ALXsHZ2RFQnk","ThreadId":"19:946d2110d8be4f43877631447e81acf6@thread.skype"}
}

static void
teams_conversation_send_image_part2_cb(PurpleHttpConnection *connection, PurpleHttpResponse *response, gpointer user_data)
{
	PurpleConnection *pc = purple_http_conn_get_purple_connection(connection);
	TeamsAccount *sa;
	gchar *convname;
	gchar *image_id;
	gchar *image_url;
	gchar *html;
	
	if (purple_http_response_get_error(response) != NULL) {
		purple_notify_error(pc, _("Image Send Error"), _("There was an error sending the image"), purple_http_response_get_error(response), purple_request_cpar_from_connection(pc));
		g_dataset_destroy(connection);
		return;
	}
	
	sa = user_data;
	convname = g_dataset_get_data(connection, "convname");
	image_id = g_dataset_get_data(connection, "image_id");
	
	image_url = g_strdup_printf("https://as-api.asm.skype.com/v1/objects/%s/views/imgo", purple_url_encode(image_id));
	html = g_strdup_printf("<p><img itemscope=\"image\" style=\"vertical-align:bottom\" src=\"%s\" alt=\"image\" itemtype=\"http://schema.skype.com/AMSImage\" height=\"250\" id=\"%s\" itemid=\"%s\" href=\"%s\" target-src=\"%s\"></p>", image_url, image_id, image_id, image_url, image_url);
	
	teams_send_message(sa, convname, html);
	
	g_free(html);
	g_free(image_url);
}

static void
teams_conversation_send_image_cb(PurpleHttpConnection *connection, PurpleHttpResponse *response, gpointer user_data)
{
	TeamsAccount *sa;
	gchar *convname;
	PurpleImage *image;
	PurpleHttpRequest *request;
	PurpleHttpConnection *new_connection;
	PurpleConnection *pc = purple_http_conn_get_purple_connection(connection);
	JsonObject *obj;
	const gchar *data;
	gsize len;
	const gchar *id;
	gchar *upload_url;
	
	sa = user_data;
	convname = g_dataset_get_data(connection, "convname");
	image = g_dataset_get_data(connection, "image");
	
	if (purple_http_response_get_error(response) != NULL) {
		purple_notify_error(pc, _("Image Send Error"), _("There was an error sending the image"), purple_http_response_get_error(response), purple_request_cpar_from_connection(pc));
		purple_image_unref(image);
		g_dataset_destroy(connection);
		return;
	}
	
	data = purple_http_response_get_data(response, &len);
	obj = json_decode_object(data, len);
	if (obj == NULL || !json_object_has_member(obj, "id")) {
		purple_image_unref(image);
		g_dataset_destroy(connection);
		if (obj != NULL) {
			json_object_unref(obj);
		}
		return;
	}
	
	id = json_object_get_string_member(obj, "id");
	
	upload_url = g_strdup_printf("https://as-prod.asyncgw." TEAMS_BASE_ORIGIN_HOST "/v1/objects/%s/content/imgpsh", purple_url_encode(id));
	
	request = purple_http_request_new(upload_url);
	purple_http_request_set_keepalive_pool(request, sa->keepalive_pool);
	purple_http_request_header_set(request, "Content-Type", "application/octet-stream");
	purple_http_request_header_set_printf(request, "Authorization", "skype_token %s", sa->skype_token);
	purple_http_request_header_set(request, "Referer", "https://" TEAMS_BASE_ORIGIN_HOST "/");
	purple_http_request_header_set(request, "Accept", "*/*");
	purple_http_request_set_method(request, "PUT");
	purple_http_request_set_contents(request, purple_image_get_data(image), purple_image_get_data_size(image));
	purple_http_request_set_max_redirects(request, 0);
	purple_http_request_set_timeout(request, 120);

	new_connection = purple_http_request(sa->pc, request, teams_conversation_send_image_part2_cb, sa);
	purple_http_request_unref(request);
	
	g_dataset_set_data_full(new_connection, "convname", g_strdup(convname), g_free);
	g_dataset_set_data_full(new_connection, "image_id", g_strdup(id), g_free);
	
	g_dataset_destroy(connection);
	g_free(upload_url);
	purple_image_unref(image);
	json_object_unref(obj);
}

static void
teams_conversation_send_image(TeamsAccount *sa, const gchar *convname, PurpleImage *image)
{
	PurpleHttpRequest *request;
	PurpleHttpConnection *connection;
	gchar *filename;
	gchar *postdata;
	JsonObject *obj, *permissions;
	JsonArray *permissions_array;
	
	filename = (gchar *)purple_image_get_path(image);
	if (filename != NULL) {
		filename = g_path_get_basename(filename);
	} else {
		filename = g_strdup_printf("MicrosoftTeams-image.%s", purple_image_get_extension(image));
	}
	
	permissions_array = json_array_new();
	json_array_add_string_element(permissions_array, "read");
	
	permissions = json_object_new();
	json_object_set_array_member(permissions, convname, permissions_array);
	
	obj = json_object_new();
	json_object_set_string_member(obj, "type", "pish/image");
	json_object_set_object_member(obj, "permissions", permissions);
	json_object_set_string_member(obj, "filename", filename);
	json_object_set_string_member(obj, "sharingMode", "Inline");
	postdata = teams_jsonobj_to_string(obj);
	
	request = purple_http_request_new("https://as-prod.asyncgw." TEAMS_BASE_ORIGIN_HOST "/v1/objects/");
	purple_http_request_set_method(request, "POST");
	purple_http_request_header_set(request, "content-type", "application/json");
	purple_http_request_header_set_printf(request, "Authorization", "skype_token %s", sa->skype_token);
	purple_http_request_header_set(request, "x-ms-client-version", TEAMS_CLIENTINFO_VERSION);
	purple_http_request_header_set(request, "Accept", "application/json");
	purple_http_request_set_keepalive_pool(request, sa->keepalive_pool);
	purple_http_request_set_contents(request, postdata, strlen(postdata));
	purple_http_request_set_max_redirects(request, 0);
	purple_http_request_set_timeout(request, 120);
	
	connection = purple_http_request(sa->pc, request, teams_conversation_send_image_cb, sa);
	purple_http_request_unref(request);
	
	g_dataset_set_data_full(connection, "convname", g_strdup(convname), g_free);
	purple_image_ref(image);
	g_dataset_set_data_full(connection, "image", image, NULL);
	
	g_free(filename);
}


static void
teams_conversation_check_message_for_images(TeamsAccount *sa, const gchar *convname, gchar *message)
{
	int imgid;
	gchar *img;
	PurpleImage *image;
	
	if ((img = strstr(message, "<img ")) || (img = strstr(message, "<IMG "))) {
		const gchar *id, *src;
		const gchar *close = strchr(img, '>');
		imgid = 0;

		if (close == NULL)
			return;
		
		if (((id = strstr(img, "ID=\"")) || (id = strstr(img, "id=\""))) &&
				id < close) {
			imgid = atoi(id + 4);
			image = purple_image_store_get(imgid);
			
			if (image != NULL) {
				teams_conversation_send_image(sa, convname, image);
			}
		} else if (((src = strstr(img, "SRC=\"")) || (src = strstr(img, "src=\""))) &&
				src < close) {
			// purple3 embeds images using src="purple-image:1"
			if (strncmp(src + 5, "purple-image:", 13) == 0) {
				imgid = atoi(src + 5 + 13);
				image = purple_image_store_get(imgid);
				
				if (image != NULL) {
					teams_conversation_send_image(sa, convname, image);
				}
			}
		}
		
		if (imgid && image != NULL && close != NULL) {
			memmove(img, close + 1, strlen(close) + 1);
		}
	}
}

