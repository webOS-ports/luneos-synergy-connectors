#include "presage.h"

// webOS replies: the transport stashes the reply target's serviceMessageId (the sent-timestamp in
// ms, decimal) as "webos-reply-to" on the conversation before serv_send_im. Read + clear it and
// return it as a uint64 (0 == not a reply); the Rust send builds the Signal Quote from it.
static uint64_t presage_take_reply_to(PurpleConversation *conv) {
    if (conv == NULL) return 0;
    gchar *reply_to = (gchar *)purple_conversation_get_data(conv, "webos-reply-to");
    if (reply_to == NULL) return 0;
    uint64_t ts = g_ascii_strtoull(reply_to, NULL, 10);
    purple_conversation_set_data(conv, "webos-reply-to", NULL);
    g_free(reply_to);
    return ts;
}

int presage_send_im(PurpleConnection *connection, const char *who, const char *message, PurpleMessageFlags flags) {
    // strip HTML similar to these reasons: https://github.com/majn/telegram-purple/issues/12 and https://github.com/majn/telegram-purple/commit/fffe751
    char *msg = purple_markup_strip_html(message); // NOTE: This turns newlines into spaces and <br> tags into newlines
    PurpleAccount *account = purple_connection_get_account(connection);
    Presage *presage = purple_connection_get_protocol_data(connection);
    PurpleConversation *conv = purple_find_conversation_with_account(PURPLE_CONV_TYPE_IM, who, account);
    uint64_t reply_to_ts = presage_take_reply_to(conv);
    presage_rust_send(account, rust_runtime, presage->tx_ptr, who, msg, NULL, reply_to_ts);
    g_free(msg);
    return 0; // do not report an error here; also no local echo since the rust part is expected inject the message
}

int presage_send_chat(PurpleConnection *connection, int id, const gchar *message, PurpleMessageFlags flags) {
    PurpleAccount *account = purple_connection_get_account(connection);
    Presage *presage = purple_connection_get_protocol_data(connection);
    PurpleConversation *conv = purple_find_chat(connection, id);
    if (conv != NULL) {
        gchar *group = (gchar *)purple_conversation_get_data(conv, "name");
        if (group != NULL) {
            // strip HTML similar to these reasons: https://github.com/majn/telegram-purple/issues/12 and https://github.com/majn/telegram-purple/commit/fffe751
            char *msg = purple_markup_strip_html(message); // NOTE: This turns newlines into spaces and <br> tags into newlines
            uint64_t reply_to_ts = presage_take_reply_to(conv);
            presage_rust_send(account, rust_runtime, presage->tx_ptr, group, msg, NULL, reply_to_ts);
            g_free(msg);
        }
    }
    return 0; // do not report an error here; also no local echo since the rust part is expected inject the message
}
