// gometabridge.c — the Go->purple boundary for the Facebook half. Mirrors the whatsmeow
// bridge.c pattern (g_memdup2 + purple_timeout_add to the glib main thread), gometa_-prefixed.
#include "gometabridge.h"
#include <stdlib.h> // free/malloc
#include <string.h> // strdup
#include <time.h>   // time

// Forward-declare the cgo export (declared in the go-generated libwhatsmeow.h, which does
// not exist yet when cgo compiles this file in stage 1). Signature must match the //export.
extern void gometa_go_submit_input(PurpleAccount *account, char *value);

#if !GLIB_CHECK_VERSION(2, 68, 0)
#define g_memdup2 g_memdup
#endif

// ---- account settings (cache the login session) ----
char *gometa_get_setting(PurpleAccount *account, const char *key) {
    const char *v = purple_account_get_string(account, key, NULL);
    return (v && *v) ? strdup(v) : NULL;
}
void gometa_set_setting(PurpleAccount *account, const char *key, const char *value) {
    purple_account_set_string(account, key, value ? value : "");
}

// ---- interactive login prompt (2FA/captcha) ----
struct gometa_req { PurpleAccount *account; char *prompt; };

static gboolean gometa_do_request(gpointer data) {
    struct gometa_req *r = (struct gometa_req *)data;
    PurpleConnection *gc = purple_account_get_connection(r->account);
    // imlibpurple leaves the request UI-ops NULL, so purple_request_input never reaches the
    // user. Surface the prompt in a "Facebook" auth conversation instead (like the QR / Telegram
    // login-code flow); the user's reply is captured in gometa_go_send_message and fed back to
    // the waiting login goroutine via its input channel.
    if (gc) {
        // NB: serv_got_im, NOT purple_serv_got_im — the device's libpurple 2.x exports the
        // classic name (as Telegram uses); purple_serv_got_im is undefined there and aborts
        // the transport with a symbol lookup error the moment this path runs.
        serv_got_im(gc, "Facebook", r->prompt, PURPLE_MESSAGE_RECV, time(NULL));
    }
    free(r->prompt);
    g_free(r);
    return FALSE;
}
void gometa_request_input(PurpleAccount *account, const char *prompt) {
    struct gometa_req *r = g_new0(struct gometa_req, 1);
    r->account = account;
    r->prompt = strdup(prompt ? prompt : "");
    purple_timeout_add(0, gometa_do_request, r);
}

static void gometa_free_strings(gometa_message_t *m) {
    free(m->who);
    free(m->conv);
    free(m->name);
    free(m->text);
    free(m->id);
    free(m->quotedText);
    free(m->quotedFrom);
    free(m->quotedId);
}

/* webOS replies: stash the quoted-original (text/from/id) on a conversation right beside webos-msg-id,
 * so the transport records an inline quote card. No-op when the message is not a reply. The transport
 * g_free's the values after reading them. */
static void gometa_stash_quote(PurpleConversation *conv, const char *quotedText, const char *quotedFrom, const char *quotedId) {
    if (!conv || !quotedText || !*quotedText) return;
    purple_conversation_set_data(conv, "webos-quoted-text", g_strdup(quotedText));
    if (quotedFrom && *quotedFrom) purple_conversation_set_data(conv, "webos-quoted-from", g_strdup(quotedFrom));
    if (quotedId && *quotedId) purple_conversation_set_data(conv, "webos-quoted-id", g_strdup(quotedId));
}

// The buddy-list group all Facebook contacts/chats live under.
PurpleGroup *gometa_blist_group(void) {
    PurpleGroup *g = purple_find_group("Facebook");
    if (!g) { g = purple_group_new("Facebook"); purple_blist_add_group(g, NULL); }
    return g;
}

static void gometa_ensure_buddy(PurpleAccount *account, const char *id, const char *name) {
    if (!id || !*id) return;
    PurpleBuddy *b = purple_find_buddy(account, id);
    if (!b) {
        b = purple_buddy_new(account, id, name);
        purple_blist_add_buddy(b, NULL, gometa_blist_group(), NULL);
    }
    if (name && *name) {
        serv_got_alias(purple_account_get_connection(account), id, name);
        purple_blist_node_set_string(&b->node, "server_alias", name);
    }
}

// Register a group thread as a blist chat (component "id" = thread key, used by find_blist_chat).
static void gometa_ensure_chat(PurpleAccount *account, const char *threadKey, const char *name) {
    if (!threadKey || !*threadKey) return;
    PurpleChat *chat = purple_blist_find_chat(account, name && *name ? name : threadKey);
    if (!chat) {
        GHashTable *comp = g_hash_table_new_full(g_str_hash, g_str_equal, NULL, g_free);
        g_hash_table_insert(comp, (gpointer)"id", g_strdup(threadKey));
        chat = purple_chat_new(account, name && *name ? name : threadKey, comp);
        purple_blist_add_chat(chat, gometa_blist_group(), NULL);
    } else if (name && *name) {
        purple_blist_alias_chat(chat, name);
    }
}

static void gometa_group_message(PurpleConnection *pc, const char *threadKey, const char *senderName,
                                 const char *text, time_t ts, int isOutgoing, const char *msgId,
                                 const char *quotedText, const char *quotedFrom, const char *quotedId) {
    int chat_id = (int)g_str_hash(threadKey);
    if (purple_find_chat(pc, chat_id) == NULL) {
        serv_got_joined_chat(pc, chat_id, threadKey);
    }
    // webOS reactions: stash the message id on the chat conv so the transport stores it as
    // serviceMessageId (read in incoming_message_cb during serv_got_chat_in). RECV only.
    if (!isOutgoing && msgId && *msgId) {
        PurpleConversation *conv = purple_find_chat(pc, chat_id);
        if (conv) purple_conversation_set_data(conv, "webos-msg-id", g_strdup(msgId));
    }
    if (!isOutgoing) {
        gometa_stash_quote(purple_find_chat(pc, chat_id), quotedText, quotedFrom, quotedId);
    }
    const char *from = (senderName && *senderName) ? senderName : "unknown";
    serv_got_chat_in(pc, chat_id, from, isOutgoing ? PURPLE_MESSAGE_SEND : PURPLE_MESSAGE_RECV, text, ts);
}

static gboolean gometa_dispatch(gpointer data) {
    gometa_message_t *m = (gometa_message_t *)data;
    PurpleConnection *pc = purple_account_get_connection(m->account);
    if (pc != NULL) {
        time_t ts = m->timestamp ? m->timestamp : time(NULL);
        switch (m->msgtype) {
            case gometa_message_type_connected:
                purple_connection_set_state(pc, PURPLE_CONNECTED);
                break;
            case gometa_message_type_disconnected:
                purple_connection_set_state(pc, PURPLE_DISCONNECTED);
                break;
            case gometa_message_type_error:
                if (m->fatal) {
                    // A fatal error means "stop, this won't succeed on its own" (e.g. login/2FA
                    // failed, session expired). Report it with a reason libpurple considers FATAL
                    // (AUTHENTICATION_FAILED) so the account is taken offline and does NOT
                    // auto-reconnect. NETWORK_ERROR is treated as transient -> libpurple retries
                    // every minute, which for a failed Facebook 2FA login just hammers the login
                    // endpoint forever (and can get the account flagged). The user re-enables the
                    // account to try again once they can complete 2FA.
                    purple_connection_error_reason(pc, PURPLE_CONNECTION_ERROR_AUTHENTICATION_FAILED,
                        m->text ? m->text : "Unknown error");
                } else {
                    purple_debug_error(GOMETA_PLUGIN_ID, "%s\n", m->text ? m->text : "error");
                }
                break;
            case gometa_message_type_buddy:
                gometa_ensure_buddy(m->account, m->who, m->name);
                break;
            case gometa_message_type_chat:
                gometa_ensure_chat(m->account, m->conv, m->name);
                break;
            case gometa_message_type_presence:
                if (m->who && *m->who) {
                    purple_prpl_got_user_status(m->account, m->who,
                        m->isOutgoing ? "available" : "offline", NULL);
                }
                break;
            case gometa_message_type_text:
                if (m->text && m->conv) {
                    if (m->isGroup) {
                        gometa_group_message(pc, m->conv, m->name ? m->name : m->who, m->text, ts, m->isOutgoing, m->id,
                                m->quotedText, m->quotedFrom, m->quotedId);
                    } else if (m->isOutgoing) {
                        // A message we sent from ANOTHER client (phone) - handleMessage already dropped
                        // the echoes of our OWN sends (sentOtids), so everything here is a genuine
                        // carbon. Write it with PURPLE_MESSAGE_REMOTE_SEND so the transport stores it as
                        // an Outbox row (making it appear on the sent side of the thread), and stash the
                        // message id as its serviceMessageId so a reaction can attach to our own message.
                        PurpleConversation *conv = purple_find_conversation_with_account(PURPLE_CONV_TYPE_IM, m->conv, m->account);
                        if (!conv) conv = purple_conversation_new(PURPLE_CONV_TYPE_IM, m->account, m->conv);
                        if (m->id && *m->id) {
                            purple_conversation_set_data(conv, "webos-msg-id", g_strdup(m->id));
                        }
                        gometa_stash_quote(conv, m->quotedText, m->quotedFrom, m->quotedId);
                        purple_conv_im_write(purple_conversation_get_im_data(conv), m->conv, m->text,
                                (PurpleMessageFlags)(PURPLE_MESSAGE_SEND | PURPLE_MESSAGE_REMOTE_SEND), ts);
                    } else {
                        // webOS reactions/replies: stash the message id + any quoted-original on the conv
                        // so the transport stores serviceMessageId (for reactions) and the inline quote card.
                        PurpleConversation *iconv = purple_find_conversation_with_account(PURPLE_CONV_TYPE_IM, m->conv, m->account);
                        if (!iconv) iconv = purple_conversation_new(PURPLE_CONV_TYPE_IM, m->account, m->conv);
                        if (m->id && *m->id) {
                            purple_conversation_set_data(iconv, "webos-msg-id", g_strdup(m->id));
                        }
                        gometa_stash_quote(iconv, m->quotedText, m->quotedFrom, m->quotedId);
                        serv_got_im(pc, m->conv, m->text, PURPLE_MESSAGE_RECV, ts);
                    }
                }
                break;
            default:
                break;
        }
    }
    gometa_free_strings(m);
    g_free(m);
    return FALSE;
}

void gometa_process_message(gometa_message_t msg) {
    gometa_message_t *heap = g_memdup2(&msg, sizeof msg);
    purple_timeout_add(0, gometa_dispatch, heap);
}
