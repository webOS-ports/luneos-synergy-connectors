// gometa_init.c — registers the Facebook (messagix) protocol as a SECOND prpl inside the
// combined whatsmeow .so (one .so, one Go runtime). plugin_init() in init.c calls
// gometa_register_second_prpl(). Uses the manual-registration pattern proven on-device
// (purple_plugin_new + purple_plugin_register). Every prpl needs list_icon+login+close.
#include <purple.h>
#include "../gometabridge.h"  // GOMETA_PLUGIN_ID / _NAME / _SUMMARY / _AUTHOR
#include <string.h>
#include "libwhatsmeow.h"     // gometa_go_login / gometa_go_close / gometa_go_send_message (cgo exports)

#ifndef PLUGIN_VERSION
#define PLUGIN_VERSION 0.0.0
#endif
#define GM_STR(x) _GM_STR(x)
#define _GM_STR(x) #x

static const char *gometa_list_icon(PurpleAccount *account, PurpleBuddy *buddy) {
    return "facebook";
}

static GList *gometa_status_types(PurpleAccount *account) {
    GList *types = NULL;
    types = g_list_append(types, purple_status_type_new_full(PURPLE_STATUS_AVAILABLE, NULL, NULL, TRUE, TRUE, FALSE));
    types = g_list_append(types, purple_status_type_new_full(PURPLE_STATUS_OFFLINE, NULL, NULL, TRUE, TRUE, FALSE));
    return types;
}

// login(): hand the account password (Facebook cookie JSON) to Go.
static void gometa_login(PurpleAccount *account) {
    PurpleConnection *pc = purple_account_get_connection(account);
    purple_connection_set_state(pc, PURPLE_CONNECTING);
    const char *cookies = purple_account_get_password(account);
    char *username = (char *)purple_account_get_username(account);
    char *user_dir = (char *)purple_user_dir();
    gometa_go_login(account, user_dir, username, (char *)(cookies ? cookies : ""), (char *)"");
    webos_connect_send_reaction_once();
}

static void gometa_close(PurpleConnection *pc) {
    gometa_go_close(purple_connection_get_account(pc));
}

static int gometa_send_im(PurpleConnection *pc, const char *who, const char *message, PurpleMessageFlags flags) {
    // webOS replies: the transport stashes the reply target's serviceMessageId as "webos-reply-to" on
    // the conversation before serv_send_im; read + clear it and pass it down so the reply threads.
    PurpleConversation *conv = purple_find_conversation_with_account(PURPLE_CONV_TYPE_IM, who, purple_connection_get_account(pc));
    gchar *reply_to = conv ? (gchar *)purple_conversation_get_data(conv, "webos-reply-to") : NULL;
    int ret = gometa_go_send_message(purple_connection_get_account(pc), (char *)who, (char *)message, reply_to ? (char *)reply_to : (char *)"");
    if (reply_to != NULL) {
        purple_conversation_set_data(conv, "webos-reply-to", NULL);
        g_free(reply_to);
    }
    return ret;
}

// ---- group chat callbacks (threads registered with component "id" = thread key) ----
static GList *gometa_chat_info(PurpleConnection *pc) {
    struct proto_chat_entry *pce = g_new0(struct proto_chat_entry, 1);
    pce->label = "Thread ID";
    pce->identifier = "id";
    pce->required = TRUE;
    return g_list_append(NULL, pce);
}

static GHashTable *gometa_chat_info_defaults(PurpleConnection *pc, const char *chat_name) {
    GHashTable *defaults = g_hash_table_new_full(g_str_hash, g_str_equal, NULL, g_free);
    if (chat_name) g_hash_table_insert(defaults, (gpointer)"id", g_strdup(chat_name));
    return defaults;
}

static char *gometa_get_chat_name(GHashTable *components) {
    const char *id = (const char *)g_hash_table_lookup(components, "id");
    return g_strdup(id ? id : "");
}

// Like purple_blist_find_chat but works while still connecting; matches the "id" component.
static PurpleChat *gometa_find_blist_chat(PurpleAccount *account, const char *id) {
    PurpleBlistNode *node;
    for (node = purple_blist_get_root(); node != NULL; node = purple_blist_node_next(node, TRUE)) {
        if (PURPLE_BLIST_NODE_IS_CHAT(node)) {
            PurpleChat *chat = (PurpleChat *)node;
            if (purple_chat_get_account(chat) != account) continue;
            GHashTable *comp = purple_chat_get_components(chat);
            const char *cid = comp ? (const char *)g_hash_table_lookup(comp, "id") : NULL;
            if (cid && strcmp(cid, id) == 0) return chat;
        }
    }
    return NULL;
}

static void gometa_join_chat(PurpleConnection *pc, GHashTable *components) {
    const char *id = (const char *)g_hash_table_lookup(components, "id");
    if (!id) return;
    int chat_id = (int)g_str_hash(id);
    if (purple_find_chat(pc, chat_id) == NULL) {
        serv_got_joined_chat(pc, chat_id, id);
    }
}

// Group send: the chat was joined with its thread key as the conversation name
// (serv_got_joined_chat(pc, g_str_hash(threadKey), threadKey)), so recover the thread key from
// the conversation and reuse the same send path as 1:1 (Go maps it to SendMessageTask.ThreadId).
// ---- file / image send (PurpleXfer -> gometa_go_send_file, which uploads via messagix/whatsmeow) ----
static void gometa_xfer_send_init(PurpleXfer *xfer) {
    PurpleAccount *account = purple_xfer_get_account(xfer);
    const char *who = purple_xfer_get_remote_user(xfer);
    const char *filename = purple_xfer_get_local_filename(xfer);
    char *error = gometa_go_send_file(account, (char *)who, (char *)filename);
    if (error && error[0]) {
        purple_xfer_error(purple_xfer_get_type(xfer), account, who, error);
        purple_xfer_cancel_local(xfer);
    } else {
        purple_xfer_set_bytes_sent(xfer, purple_xfer_get_size(xfer));
        purple_xfer_set_completed(xfer, TRUE);
    }
    g_free(error);
}

static PurpleXfer *gometa_new_xfer(PurpleConnection *pc, const char *who) {
    PurpleAccount *account = purple_connection_get_account(pc);
    PurpleXfer *xfer = purple_xfer_new(account, PURPLE_XFER_SEND, who);
    purple_xfer_set_init_fnc(xfer, gometa_xfer_send_init);
    return xfer;
}

static void gometa_send_file(PurpleConnection *pc, const char *who, const char *filename) {
    PurpleXfer *xfer = gometa_new_xfer(pc, who);
    if (filename && *filename) {
        purple_xfer_request_accepted(xfer, filename);
    } else {
        purple_xfer_request(xfer);
    }
}

// Group file send: the chat conversation name is the thread key (see gometa_chat_send).
static void gometa_chat_send_file(PurpleConnection *pc, int id, const char *filename) {
    PurpleConversation *conv = purple_find_chat(pc, id);
    if (conv != NULL) {
        const char *who = purple_conversation_get_name(conv);
        if (who != NULL && *who) {
            gometa_send_file(pc, who, filename);
        }
    }
}

static int gometa_chat_send(PurpleConnection *pc, int id, const char *message, PurpleMessageFlags flags) {
    (void)flags;
    PurpleConversation *conv = purple_find_chat(pc, id);
    if (conv == NULL) return -1;
    const char *threadKey = purple_conversation_get_name(conv);
    if (threadKey == NULL || *threadKey == '\0') return -1;
    // webOS replies: read + clear the reply target the transport stashed on this chat conversation.
    gchar *reply_to = (gchar *)purple_conversation_get_data(conv, "webos-reply-to");
    gometa_go_send_message(purple_connection_get_account(pc), (char *)threadKey, (char *)message, reply_to ? (char *)reply_to : (char *)"");
    if (reply_to != NULL) {
        purple_conversation_set_data(conv, "webos-reply-to", NULL);
        g_free(reply_to);
    }
    return 0;
}

static PurplePluginProtocolInfo gometa_prpl_info = {
    .struct_size = sizeof(PurplePluginProtocolInfo),
    .options = OPT_PROTO_IM_IMAGE,
    .list_icon = gometa_list_icon,
    .status_types = gometa_status_types,
    .login = gometa_login,
    .close = gometa_close,
    .send_im = gometa_send_im,
    .new_xfer = gometa_new_xfer,
    .send_file = gometa_send_file,
    .chat_send_file = gometa_chat_send_file,
    .chat_info = gometa_chat_info,
    .chat_info_defaults = gometa_chat_info_defaults,
    .join_chat = gometa_join_chat,
    .get_chat_name = gometa_get_chat_name,
    .find_blist_chat = gometa_find_blist_chat,
    .chat_send = gometa_chat_send,
};

static PurplePluginInfo gometa_info = {
    .magic = PURPLE_PLUGIN_MAGIC,
    .major_version = PURPLE_MAJOR_VERSION,
    .minor_version = PURPLE_MINOR_VERSION,
    .type = PURPLE_PLUGIN_PROTOCOL,
    .priority = PURPLE_PRIORITY_DEFAULT,
    .id = GOMETA_PLUGIN_ID,
    .name = GOMETA_PLUGIN_NAME,
    .version = GM_STR(PLUGIN_VERSION),
    .summary = GOMETA_PLUGIN_SUMMARY,
    .description = GOMETA_PLUGIN_SUMMARY,
    .author = GOMETA_AUTHOR,
    .homepage = "https://github.com/mautrix/meta",
    .extra_info = &gometa_prpl_info,
};

void gometa_register_second_prpl(void) {
    PurplePlugin *p = purple_plugin_new(TRUE, NULL);
    p->info = &gometa_info;
    purple_plugin_load(p);
    if (purple_plugin_register(p)) {
        purple_debug_info("gometa", "registered second prpl %s\n", GOMETA_PLUGIN_ID);
    } else {
        purple_debug_error("gometa", "FAILED to register %s\n", GOMETA_PLUGIN_ID);
    }
}
