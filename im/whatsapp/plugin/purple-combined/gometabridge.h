#pragma once
// Facebook (messagix) half of the combined plugin. All identifiers are gometa_-prefixed
// so they don't collide with the whatsmeow (gowhatsapp_) half in the same .so / package.
#include <purple.h>
#include <time.h>

#define GOMETA_PLUGIN_ID      "prpl-gometa"
#define GOMETA_PLUGIN_NAME    "Facebook (E2EE)"
#define GOMETA_PLUGIN_SUMMARY "Facebook Messenger via mautrix-meta's messagix (with E2EE)"
#define GOMETA_AUTHOR         "webOS Synergy Revival"

enum gometa_message_type {
    gometa_message_type_error,        // text = error; fatal = connection-fatal
    gometa_message_type_connected,
    gometa_message_type_disconnected,
    gometa_message_type_text,         // incoming message (see fields below)
    gometa_message_type_buddy,        // add/update a contact: who=fbid, name=display name
    gometa_message_type_chat,         // register a group chat: conv=threadKey, name=thread name
    gometa_message_type_presence,     // buddy presence: who=fbid, isOutgoing=1 -> available else offline
};

typedef struct gometa_message {
    PurpleAccount *account;
    char *who;   // for text: sender fbid; for buddy: contact fbid
    char *conv;  // for text: conversation/thread key (1:1 = other user, group = thread); for chat: thread key
    char *name;  // display name (sender name, contact name, or group name)
    char *text;  // message body / error text
    char *id;    // message id (optional)
    char *quotedText; // webOS replies: replied-to original's text (NULL if not a reply)
    char *quotedFrom; // webOS replies: replied-to original's author display name
    char *quotedId;   // webOS replies: replied-to original's message id
    time_t timestamp;
    char msgtype;
    char isGroup;
    char isOutgoing;
    char fatal;
} gometa_message_t;

// Go -> purple; C glue owns/free()s the strings and marshals onto the glib main thread.
extern void gometa_process_message(gometa_message_t msg);

// Interactive login prompt (2FA/captcha). Schedules purple_request_input on the main
// thread; the answer comes back via the Go export gometa_go_submit_input(account, value).
extern void gometa_request_input(PurpleAccount *account, const char *prompt);

// Account settings (used to cache the login session). Returned string is malloc'd;
// the Go caller frees it. Returns NULL if unset.
extern char *gometa_get_setting(PurpleAccount *account, const char *key);
extern void gometa_set_setting(PurpleAccount *account, const char *key, const char *value);

// webOS reactions (SEND): connect once (process-wide) to the transport's "webos-im-send-reaction"
// signal. Defined in glue/login.c; called from both login paths (guarded by a static bool so a
// double connect is harmless).
extern void webos_connect_send_reaction_once(void);
