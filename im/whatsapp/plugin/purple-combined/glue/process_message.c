#include "gowhatsapp.h"
#include "constants.h"
#include "libwhatsmeow.h" // for gowhatsapp_go_query_contacts

static const char *gowhatsapp_message_type_string[] = {
    FOREACH_MESSAGE_TYPE(GENERATE_STRING)
};

static gboolean gowhatsapp_message_is_old(gowhatsapp_message_t *gwamsg) {
    WhatsappProtocolData *wpd = (WhatsappProtocolData *)purple_connection_get_protocol_data(purple_account_get_connection(gwamsg->account));
    if (wpd->connected_at_timestamp > gwamsg->timestamp) {
        const gboolean discard_old_messages = purple_account_get_bool(gwamsg->account, GOWHATSAPP_DISCARD_OLD_MESSAGES_OPTION, FALSE);
        if (discard_old_messages) {
            purple_debug_info(GOWHATSAPP_NAME, "This message is older than the connection.\n");
            return TRUE;
        }
    }
    return FALSE;
}

/*
 * Tells the front-end we are now online.
 *
 * Also tells the front-end to display all our buddies as no longer offline so they can be interacted with.
 * 
 * Additionally requests the profile picture of each buddy.
 */
static void gowhatsapp_connection_set_online(PurpleConnection *connection) {
    PurpleAccount *account = purple_connection_get_account(connection);
    purple_connection_set_state(connection, PURPLE_CONNECTION_CONNECTED);

    // display all buddies as "away"
    gowhatsapp_for_all_buddies(account, gowhatsapp_assume_buddy_away);
    // set own presence (and subscribe for presence updates so buddies may displayed as "online")
    gowhatsapp_set_presence(account, purple_account_get_active_status(account));

    gowhatsapp_for_all_buddies(account, gowhatsapp_request_profile_picture);

    // webOS: fetch every group's info on connect so its name/subject is set (each group flows through
    // gowhatsapp_handle_group -> ensure_group_chat_in_blist, which aliases the chat). Without this,
    // query_groups only ran when the room picker was opened, so group chats showed the raw JID
    // ("<digits>-<digits>@g.us") in the conversation list instead of their name.
    gowhatsapp_go_query_groups(account);
}

/*
 * Interprets a message received from whatsmeow. Handles login success and failure. Forwards errors.
 */
void
gowhatsapp_process_message(gowhatsapp_message_t *gwamsg)
{
    if (gwamsg->msgtype < 0 || gwamsg->msgtype >= gowhatsapp_message_type_max) {
        purple_debug_info(GOWHATSAPP_NAME, "recieved invalid message type %d.\n", gwamsg->msgtype);
        return;
    }
    purple_debug_info(
        GOWHATSAPP_NAME, "recieved %s (subtype %d) for account %p remote %s (isGroup %d) sender %s (alias %s, isOutgoing %d) sent %ld: %s\n",
        gowhatsapp_message_type_string[gwamsg->msgtype],
        gwamsg->subtype,
        gwamsg->account,
        gwamsg->remoteJid,
        gwamsg->isGroup,
        gwamsg->senderJid,
        gwamsg->name,
        gwamsg->isOutgoing,
        gwamsg->timestamp,
        gwamsg->text
    );

    PurpleConnection *pc = purple_account_get_connection(gwamsg->account);

    if (!gwamsg->timestamp) {
        gwamsg->timestamp = time(NULL);
    }
    switch(gwamsg->msgtype) {
        case gowhatsapp_message_type_error:
            if (gwamsg->subtype == 0) {
                purple_connection_error(pc, PURPLE_CONNECTION_ERROR_NETWORK_ERROR, gwamsg->text);
            } else {
                purple_connection_error(pc, PURPLE_CONNECTION_ERROR_OTHER_ERROR, gwamsg->text);
            }
            gowhatsapp_close_qrcode(gwamsg->account);
            break;
        case gowhatsapp_message_type_login:
            gowhatsapp_handle_qrcode(pc, gwamsg);
            break;
        case gowhatsapp_message_type_pairing_succeeded:
            gowhatsapp_close_qrcode(gwamsg->account);
            break;
        case gowhatsapp_message_type_credentials:
            gowhatsapp_store_credentials(gwamsg->account, gwamsg->text);
            break;
        case gowhatsapp_message_type_connected:
            gowhatsapp_close_qrcode(gwamsg->account);
            if (purple_account_get_bool(gwamsg->account, GOWHATSAPP_REQUEST_CONTACTS_AFTER_LOGIN_OPTION, TRUE)) {
                // after connecting, fetch contacts.
                // results will come in asyncronously, see next case
                gowhatsapp_go_get_contacts(gwamsg->account, FALSE);
            } else {
                // do not query contacts, just signal we are online now, but note next case
                gowhatsapp_connection_set_online(pc);
            }
            break;
        case gowhatsapp_message_type_name:
            if (NULL == gwamsg->remoteJid) {
                // The end of the list of contacts was reached.
                // The connection can now be regarded as "connected".
                // This does not happen immediately since Spectrum will automatically call roomlist_get_list
                // as soon as the connection ha been established. However, it needs all contacts to be updated
                // before entering any group chat. Or the group chat participants' names will not be resolved.
                gowhatsapp_connection_set_online(pc);
                // we also want to query the room list automatically (so group chats may be added to the buddy list).
                gowhatsapp_roomlist_get_list(pc);
            } else {
                gowhatsapp_ensure_buddy_in_blist(gwamsg->account, gwamsg->remoteJid, gwamsg->name);
            }
            break;
        case gowhatsapp_message_type_disconnected:
            purple_connection_set_state(pc, PURPLE_CONNECTION_DISCONNECTED);
            gowhatsapp_close_qrcode(gwamsg->account);
            break;
        case gowhatsapp_message_type_text:
            if (!gowhatsapp_message_is_old(gwamsg)) {
                gowhatsapp_display_text_message(gwamsg->account, gwamsg->senderJid, gwamsg->remoteJid, gwamsg->text, gwamsg->timestamp, gwamsg->isGroup, gwamsg->isOutgoing, gwamsg->name, 0, gwamsg->messageId, gwamsg->quotedText, gwamsg->quotedFrom, gwamsg->quotedId, TRUE);
            }
            break;
        case gowhatsapp_message_type_system:
            gowhatsapp_display_text_message(gwamsg->account, gwamsg->senderJid, gwamsg->remoteJid, gwamsg->text, gwamsg->timestamp, gwamsg->isGroup, gwamsg->isOutgoing, gwamsg->name, PURPLE_MESSAGE_SYSTEM, gwamsg->messageId, NULL, NULL, NULL, TRUE);
            break;
        case gowhatsapp_message_type_typing:
            serv_got_typing(pc, gwamsg->remoteJid, 0, PURPLE_TYPING);
            break;
        case gowhatsapp_message_type_typing_stopped:
            serv_got_typing_stopped(pc, gwamsg->remoteJid);
            break;
        case gowhatsapp_message_type_presence:
            gowhatsapp_handle_presence(gwamsg->account, gwamsg->remoteJid, gwamsg->subtype, gwamsg->timestamp);
            break;
        case gowhatsapp_message_type_attachment:
            if (!gowhatsapp_message_is_old(gwamsg)) {
                gowhatsapp_handle_attachment(gwamsg);
            }
            break;
        case gowhatsapp_message_type_reaction:
            // webOS reactions: forward to the transport's cross-prpl "webos-im-reaction" signal
            // (registered by imlibpurpletransport) instead of showing a "reacted with X" message.
            // messageId = the reacted-to message's id, text = emoji ("" = removed), senderJid = reactor.
            // Runs on the libpurple main thread (message bridge), so emitting the signal here is safe.
            purple_signal_emit(purple_conversations_get_handle(), "webos-im-reaction",
                    gwamsg->account, gwamsg->messageId,
                    gwamsg->text ? gwamsg->text : "",
                    gwamsg->senderJid ? gwamsg->senderJid : "");
            break;
        case gowhatsapp_message_type_outbox_id:
            // webOS outbox-id: an app-sent message just got its server id. Forward it to the
            // transport's cross-prpl "webos-im-outbox-id" signal so the Outbox row gets the id
            // (making the user's own sent message reactable). messageId = the server id, text =
            // the message body (correlation hint). Runs on the libpurple main thread (message
            // bridge), so emitting the signal here is safe.
            purple_signal_emit(purple_conversations_get_handle(), "webos-im-outbox-id",
                    gwamsg->account, gwamsg->messageId ? gwamsg->messageId : "",
                    gwamsg->text ? gwamsg->text : "");
            break;
        case gowhatsapp_message_type_receipt:
            // webOS delivery/read receipt: the recipient delivered/read our outgoing message.
            // messageId = the message's server id (== serviceMessageId), text = status
            // ("delivered"/"read"). Forward to the transport's cross-prpl "webos-im-receipt" signal
            // (by-id), which upgrades the Outbox row's deliveryStatus. Runs on the libpurple main thread.
            purple_signal_emit(purple_conversations_get_handle(), "webos-im-receipt",
                    gwamsg->account, gwamsg->messageId ? gwamsg->messageId : "",
                    gwamsg->text ? gwamsg->text : "");
            break;
        case gowhatsapp_message_type_receipt_hwm:
            // webOS delivery/read receipt (watermark, Facebook): everything in a thread up to a
            // timestamp was delivered/read. remoteJid = scope ("ts:<threadKey>"), messageId = watermark
            // (ms), text = status. Forward to the transport's "webos-im-receipt-hwm" signal.
            purple_signal_emit(purple_conversations_get_handle(), "webos-im-receipt-hwm",
                    gwamsg->account, gwamsg->remoteJid ? gwamsg->remoteJid : "",
                    gwamsg->messageId ? gwamsg->messageId : "",
                    gwamsg->text ? gwamsg->text : "");
            break;
        case gowhatsapp_message_type_edit:
            // webOS message edit-in-place: the sender edited a previously-sent message. messageId = that
            // message's server id (== serviceMessageId), text = the new body. HTML-escape it exactly like a
            // normal incoming message (gowhatsapp_display_message, glue/display_message.c) so the stored text
            // stays consistent (the conversation view renders bodies as HTML), then forward to the transport's
            // "webos-im-edit" signal, which merges it onto the original bubble. Runs on the libpurple main thread.
            {
                const char *raw = gwamsg->text ? gwamsg->text : "";
                gchar *html = purple_markup_escape_text(raw, -1);
                gchar *escaped = purple_strdup_withhtml(html);
                purple_signal_emit(purple_conversations_get_handle(), "webos-im-edit",
                        gwamsg->account, gwamsg->messageId ? gwamsg->messageId : "",
                        escaped ? escaped : "");
                g_free(escaped);
                g_free(html);
            }
            break;
        case gowhatsapp_message_type_delete:
            // webOS "delete for everyone": the sender revoked a previously-sent message. messageId =
            // that message's server id (== serviceMessageId). Forward to the transport's
            // "webos-im-delete" signal, which replaces the stored bubble's text with a placeholder
            // in place (same find-by-serviceMessageId + merge mechanism as webos-im-edit above, just
            // with a canned body instead of a new one). Runs on the libpurple main thread.
            purple_signal_emit(purple_conversations_get_handle(), "webos-im-delete",
                    gwamsg->account, gwamsg->messageId ? gwamsg->messageId : "");
            break;
        case gowhatsapp_message_type_profile_picture:
            gowhatsapp_handle_profile_picture(gwamsg);
            break;
        case gowhatsapp_message_type_group:
            gowhatsapp_handle_group(pc, gwamsg);
            break;
        default:
            purple_debug_info(GOWHATSAPP_NAME, "Handling this message type is not implemented.\n");
            g_free(gwamsg->blob);
    }
}
