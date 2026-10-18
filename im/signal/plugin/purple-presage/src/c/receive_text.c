#include "presage.h"
#include <string.h> // strchr

/* webOS reactions: emit the cross-prpl "webos-im-reaction" signal for a Signal reaction. Called from
 * the Rust receive loop (worker thread), so - like presage_append_message - copy the strings and hop
 * to the libpurple main thread before touching purple_signal_emit. emoji "" means the reaction was
 * removed; target_id is the reacted-to message's sent timestamp (its serviceMessageId); sender is the
 * reactor's UUID. */
typedef struct {
    PurpleAccount *account;
    char *target_id;
    char *emoji;
    char *sender;
} PresageReactionEvt;

static gboolean presage_reaction_apply(gpointer data) {
    PresageReactionEvt *e = (PresageReactionEvt *)data;
    purple_signal_emit(purple_conversations_get_handle(), "webos-im-reaction",
        e->account, e->target_id, e->emoji, e->sender);
    g_free(e->target_id); g_free(e->emoji); g_free(e->sender); g_free(e);
    return FALSE; /* one-shot */
}

void presage_emit_reaction(PurpleAccount *account, const char *target_id, const char *emoji, const char *sender) {
    if (account == NULL || target_id == NULL || *target_id == '\0') {
        return;
    }
    PresageReactionEvt *e = g_new0(PresageReactionEvt, 1);
    e->account = account;
    e->target_id = g_strdup(target_id);
    e->emoji = g_strdup(emoji ? emoji : "");
    e->sender = g_strdup(sender ? sender : "");
    purple_timeout_add(0, presage_reaction_apply, e); /* thread-safe; runs on the main thread */
}

/* webOS reactions: emit the cross-prpl "webos-im-outbox-id" signal, telling the transport the server
 * id (sent timestamp) of a message the user sent from the app. Called from the Rust command loop
 * (worker thread), so - like presage_emit_reaction - copy the strings and hop to the libpurple main
 * thread before touching purple_signal_emit. */
typedef struct {
    PurpleAccount *account;
    char *service_message_id;
    char *text;
} PresageOutboxEvt;

static gboolean presage_outbox_id_apply(gpointer data) {
    PresageOutboxEvt *e = (PresageOutboxEvt *)data;
    purple_signal_emit(purple_conversations_get_handle(), "webos-im-outbox-id",
        e->account, e->service_message_id, e->text);
    g_free(e->service_message_id); g_free(e->text); g_free(e);
    return FALSE; /* one-shot */
}

void presage_emit_outbox_id(PurpleAccount *account, const char *service_message_id, const char *text) {
    if (account == NULL || service_message_id == NULL || *service_message_id == '\0') {
        return;
    }
    PresageOutboxEvt *e = g_new0(PresageOutboxEvt, 1);
    e->account = account;
    e->service_message_id = g_strdup(service_message_id);
    e->text = g_strdup(text ? text : "");
    purple_timeout_add(0, presage_outbox_id_apply, e); /* thread-safe; runs on the main thread */
}

/* webOS delivery/read receipts: emit the cross-prpl "webos-im-receipt" signal telling the transport
 * that the recipient DELIVERED or READ one of our outgoing messages. Like presage_emit_reaction this
 * runs on the Rust worker thread, so copy the strings and hop to the libpurple main thread before
 * touching purple_signal_emit. target_id is the message's sent timestamp (its serviceMessageId);
 * status is "delivered" or "read". */
typedef struct {
    PurpleAccount *account;
    char *target_id;
    char *status;
} PresageReceiptEvt;

static gboolean presage_receipt_apply(gpointer data) {
    PresageReceiptEvt *e = (PresageReceiptEvt *)data;
    purple_signal_emit(purple_conversations_get_handle(), "webos-im-receipt",
        e->account, e->target_id, e->status);
    g_free(e->target_id); g_free(e->status); g_free(e);
    return FALSE; /* one-shot */
}

void presage_emit_receipt(PurpleAccount *account, const char *target_id, const char *status) {
    if (account == NULL || target_id == NULL || *target_id == '\0' || status == NULL) {
        return;
    }
    PresageReceiptEvt *e = g_new0(PresageReceiptEvt, 1);
    e->account = account;
    e->target_id = g_strdup(target_id);
    e->status = g_strdup(status);
    purple_timeout_add(0, presage_receipt_apply, e); /* thread-safe; runs on the main thread */
}

void presage_handle_text(PurpleConnection *connection, const char *who, const char *name, const char *group, PurpleMessageFlags flags, uint64_t timestamp_ms, const char *body) {
    // escaping is now done in rust part
    presage_display_text(connection, who, name, group, flags, timestamp_ms, body);
}

/* webOS replies: the Rust receive layer sentinel-encodes an inline quote into the body as
 *   \x01 <id> \x1f <from> \x1f <text> \x02 <reply body>
 * Split it out here so we can stash webos-quoted-* on the conversation (the transport renders those
 * as an inline reply card) and show only the reply body. Returns a newly-allocated reply body; on
 * *q_id/*q_from/*q_text returns newly-allocated fields (or NULL). Caller frees all four. */
static char *presage_extract_quote(const char *text, char **q_id, char **q_from, char **q_text) {
    *q_id = NULL; *q_from = NULL; *q_text = NULL;
    if (text == NULL) return g_strdup("");
    if (text[0] != '\x01') return g_strdup(text);
    const char *stx = strchr(text, '\x02');
    if (stx == NULL) return g_strdup(text); // malformed - show as-is rather than lose the body
    char *header = g_strndup(text + 1, stx - (text + 1));
    char **parts = g_strsplit(header, "\x1f", 3);
    if (parts[0] && *parts[0]) *q_id   = g_strdup(parts[0]);
    if (parts[1] && *parts[1]) *q_from = g_strdup(parts[1]);
    if (parts[2] && *parts[2]) *q_text = g_strdup(parts[2]);
    g_strfreev(parts);
    g_free(header);
    return g_strdup(stx + 1);
}

/* Stash the extracted quote on the conversation, right where webos-msg-id is stashed, so the
 * transport's incoming_message_cb reads webos-quoted-{id,from,text} during serv_got_im/chat_in. */
static void presage_stash_quote(PurpleConversation *conv, const char *q_id, const char *q_from, const char *q_text) {
    if (conv == NULL) return;
    if (q_id   && *q_id)   purple_conversation_set_data(conv, "webos-quoted-id",   g_strdup(q_id));
    if (q_from && *q_from) purple_conversation_set_data(conv, "webos-quoted-from", g_strdup(q_from));
    if (q_text && *q_text) purple_conversation_set_data(conv, "webos-quoted-text", g_strdup(q_text));
}

void presage_display_text(PurpleConnection *connection, const char *who, const char *name, const char *group, PurpleMessageFlags flags, uint64_t timestamp_ms, const char *rawtext) {
    PurpleAccount *account = purple_connection_get_account(connection);

    // webOS replies: pull any sentinel-encoded quote out of the body before display/threading.
    char *q_id = NULL, *q_from = NULL, *q_text = NULL;
    char *text = presage_extract_quote(rawtext, &q_id, &q_from, &q_text);

    // in Signal, timestamps are milliseconds, but purple wants seconds
    time_t timestamp_seconds = timestamp_ms/1000;

    if (group == NULL) {
        // direct message
        presage_blist_update_buddy(account, who, name); // add to blist first for aliasing
        if (flags & PURPLE_MESSAGE_SEND) {
            // display message sent from own account (other device as well as local echo)
            // cannot use purple_serv_got_im since it sets the flag PURPLE_MESSAGE_RECV
            PurpleConversation *conv = purple_find_conversation_with_account(PURPLE_CONV_TYPE_IM, who, account);
            if (conv == NULL) {
                conv = purple_conversation_new(PURPLE_CONV_TYPE_IM, account, who); // MEMCHECK: caller takes ownership
            }
            // webOS reactions/carbons: a message we sent from ANOTHER device (REMOTE_SEND, not a local
            // echo) is stored by the transport as an Outbox row - stash its id (sent timestamp) as the
            // serviceMessageId so a later reaction can attach to our own message. Local echoes carry
            // PURPLE_MESSAGE_SEND only (no REMOTE_SEND) and are left to the app's own send path.
            if (flags & PURPLE_MESSAGE_REMOTE_SEND) {
                char idbuf[32]; g_snprintf(idbuf, sizeof idbuf, "%llu", (unsigned long long)timestamp_ms);
                purple_conversation_set_data(conv, "webos-msg-id", g_strdup(idbuf));
            }
            presage_stash_quote(conv, q_id, q_from, q_text); // webOS replies: outgoing carbon reply card
            purple_conv_im_write(purple_conversation_get_im_data(conv), who, text, flags, timestamp_seconds);
        } else {
            // webOS reactions: stash the Signal message id (its sent timestamp in ms) so the
            // transport stores it as serviceMessageId (read in incoming_message_cb during
            // serv_got_im); a later reaction targets it by target_sent_timestamp.
            PurpleConversation *rconv = purple_find_conversation_with_account(PURPLE_CONV_TYPE_IM, who, account);
            if (rconv == NULL) rconv = purple_conversation_new(PURPLE_CONV_TYPE_IM, account, who);
            { char idbuf[32]; g_snprintf(idbuf, sizeof idbuf, "%llu", (unsigned long long)timestamp_ms);
              purple_conversation_set_data(rconv, "webos-msg-id", g_strdup(idbuf)); }
            presage_stash_quote(rconv, q_id, q_from, q_text); // webOS replies: incoming reply card
            purple_serv_got_im(connection, who, text, flags, timestamp_seconds);
        }
    } else {
        // group message
        presage_blist_update_chat(account, group, name);
        PurpleConversation *conv = purple_find_chat(connection, g_str_hash(group));
        if (conv == NULL) {
            // no conversation for this group chat
            // prepare a GHashTable with the group identifier because that is how join_chat is supposed to work in purple
            GHashTable * data = g_hash_table_new_full(g_str_hash, g_str_equal, NULL, NULL); // MEMCHECK: structure itself is released below
            // the constant not-human-readable group identifier is called "name"
            g_hash_table_insert(data, "name", (void *)group); // MEMCHECK: key "name" is static, value is released by caller
            // the non-constant human-readable group name is called "topic"
            g_hash_table_insert(data, "topic", (void *)name); // MEMCHECK: key "topic" is static, value is released by caller
            presage_join_chat(connection, data);
            g_hash_table_destroy(data); // MEMCHECK: g_hash_table_insert above
        }
        if (flags & PURPLE_MESSAGE_SEND) {
            // the backend does not include the username for sync messages
            who = purple_account_get_username(account);
        }
        if (flags & PURPLE_MESSAGE_ERROR) {
            // who must be set in a chat, even for an error message
            who = purple_account_get_username(account);
        }
        // webOS reactions: stash the message id on the chat conv (RECV only) as serviceMessageId.
        if (!(flags & PURPLE_MESSAGE_SEND)) {
            PurpleConversation *gconv = purple_find_chat(connection, g_str_hash(group));
            if (gconv) { char idbuf[32]; g_snprintf(idbuf, sizeof idbuf, "%llu", (unsigned long long)timestamp_ms);
                purple_conversation_set_data(gconv, "webos-msg-id", g_strdup(idbuf));
                presage_stash_quote(gconv, q_id, q_from, q_text); } // webOS replies: incoming group reply card
        }
        purple_serv_got_chat_in(connection, g_str_hash(group), who, flags, text, timestamp_seconds);
    }
    g_free(text); g_free(q_id); g_free(q_from); g_free(q_text);
}
