/*
 *   gowhatsapp plugin for libpurple
 *   Copyright (C) 2021 Hermann Höhne
 *
 *   This program is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   This program is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU General Public License for more details.
 *
 *   You should have received a copy of the GNU General Public License
 *   along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
 
 /*
  * Please note this is the fourth purple plugin I have ever written.
  * I still have no idea what I am doing.
  */

#include "gowhatsapp.h"
#include "constants.h"       // GOWHATSAPP_CREDENTIALS_KEY (for locating the device to unlink on delete)
#include "../gometabridge.h" // GOMETA_PLUGIN_ID (branch account-removed by protocol id)
#include "libwhatsmeow.h" // for gowhatsapp_go_init + gowhatsapp_go_account_removed / gometa_go_account_removed
#include "call.h"         // whatsapp_call_luna_init -- register at plugin load, not per-account login
#include <gmodule.h>      // g_module_make_resident - pin the Go .so so libpurple can't dlclose/unmap it

#ifndef PLUGIN_VERSION
#error Must set PLUGIN_VERSION in build system
#endif
// https://github.com/LLNL/lbann/issues/117#issuecomment-334333286
#define MAKE_STR(x) _MAKE_STR(x)
#define _MAKE_STR(x) #x

static const char *
list_icon(PurpleAccount *account, PurpleBuddy *buddy)
{
    return "whatsapp";
}

static GList *
status_types(PurpleAccount *account)
{
    GList *types = NULL; // MEMCHECK: caller takes ownership
    PurpleStatusType *status;

    status = purple_status_type_new_full( // MEMCHECK: types takes ownership
        PURPLE_STATUS_AVAILABLE, GOWHATSAPP_STATUS_STR_AVAILABLE, NULL, TRUE, TRUE, FALSE
    );
    types = g_list_append(types, status);

    status = purple_status_type_new_full( // MEMCHECK: types takes ownership
        PURPLE_STATUS_AWAY, GOWHATSAPP_STATUS_STR_AWAY, NULL, TRUE, TRUE, FALSE
    );
    types = g_list_prepend(types, status);

    status = purple_status_type_new_full( // MEMCHECK: types takes ownership
        PURPLE_STATUS_OFFLINE, GOWHATSAPP_STATUS_STR_OFFLINE, NULL, TRUE, TRUE, FALSE
    );
    types = g_list_append(types, status);

    status = purple_status_type_new_full( // MEMCHECK: types takes ownership
        PURPLE_STATUS_MOBILE, GOWHATSAPP_STATUS_STR_MOBILE, NULL, FALSE, FALSE, TRUE
    );
    types = g_list_prepend(types, status);
    
    return types;
}

static void action_contacts(PurplePluginAction* action) {
  PurpleConnection* pc = action->context;
  PurpleAccount *account = purple_connection_get_account(pc);
  gowhatsapp_go_get_contacts(account, TRUE);
}

static void action_logout(PurplePluginAction* action) {
  PurpleConnection* pc = action->context;
  PurpleAccount *account = purple_connection_get_account(pc);
  gowhatsapp_go_logout(account);
}

static GList * actions(PurplePlugin *plugin, gpointer context) {
    GList* actions = NULL;
    {
        PurplePluginAction *act = purple_plugin_action_new("Flush Contacts", &action_contacts);
        actions = g_list_append(actions, act);
    }
    {
        PurplePluginAction *act = purple_plugin_action_new("Logout", &action_logout);
        actions = g_list_append(actions, act);
    }
    return actions;
}

static gboolean
libpurple2_plugin_load(PurplePlugin *plugin)
{
    // webOS: register com.palm.whatsapp.call HERE (plugin load), not inside gowhatsapp_login
    // (per-account login callback). Registering at login left a real window -- from transport
    // startup until this account's login() callback actually fires -- where the LS2 service
    // didn't exist yet. A dial attempt during that window doesn't get our own graceful
    // "not ready" reply (see m_dial's mcClient==nil check in call.c): ls-hubd's on-demand
    // service activation instead SILENTLY QUEUES the LS2 call and delivers it once some
    // instance registers the name, with no UI ever attached to that now-stale caller context
    // -- the call would eventually go out for real (once mcClient is ready) but with no
    // calling screen ever shown. Registering here, at plugin load, means the service exists
    // essentially as soon as the transport starts (independent of any account's login
    // progress), closing that window. Idempotent either way (g_registered guard in
    // whatsapp_call_luna_init), so this is safe even with multiple accounts/reconnects.
    whatsapp_call_luna_init();
    return TRUE;
}

static gboolean
libpurple2_plugin_unload(PurplePlugin *plugin)
{
    purple_signals_disconnect_by_handle(plugin);
    return TRUE;
}

static PurplePluginProtocolInfo prpl_info = {
    .struct_size = sizeof(PurplePluginProtocolInfo), // must be set for PURPLE_PROTOCOL_PLUGIN_HAS_FUNC to work across versions
    .options = OPT_PROTO_NO_PASSWORD, // with this set, Pidgin will neither ask for a password and also won't store it. Yet storing a password is necessary for compatibility with bitlbee. See login.c for more information.
    // TODO: experiment with purple_account_set_remember_password and use password in Pidgin for consistency
    .list_icon = list_icon,
    .status_types = status_types, // this actually needs to exist, else the protocol cannot be set to "online"
    .set_status = gowhatsapp_set_presence,
    .login = gowhatsapp_login,
    .close = gowhatsapp_close,
    .send_im = gowhatsapp_send_im,
    // group-chat related functions
    .chat_info = gowhatsapp_chat_info,
    .chat_info_defaults = gowhatsapp_chat_info_defaults,
    .join_chat = gowhatsapp_join_chat,
    .get_chat_name = gowhatsapp_get_chat_name,
    .find_blist_chat = gowhatsapp_find_blist_chat,
    .chat_send = gowhatsapp_send_chat,
    .set_chat_topic = gowhatsapp_set_chat_topic,
    .roomlist_get_list = gowhatsapp_roomlist_get_list,
    .get_cb_alias = gowhatsapp_get_cb_alias,
    //.roomlist_room_serialize = gowhatsapp_roomlist_serialize, // not necessary – we store the JID in room->name
    // managing buddies (contacts)
    .add_buddy = gowhatsapp_add_buddy,
    .tooltip_text = gowhatsapp_tooltip_text,
    // file transfer
    .new_xfer = gowhatsapp_new_xfer,
    .send_file = gowhatsapp_send_file,
    #if PURPLE_VERSION_CHECK(2,14,0)
    .chat_send_file = gowhatsapp_chat_send_file,
    #endif
};

// Registers the Facebook (messagix) protocol as a second prpl in this same .so.
extern void gometa_register_second_prpl(void);

// Per-account store teardown on account deletion. libpurple's purple_accounts_delete() emits
// "account-removed" (on purple_accounts_get_handle()) for the account being deleted, then destroys
// it synchronously. This one .so hosts BOTH prpls, so a single handler covers WhatsApp and gometa;
// we branch by protocol id and hand off to the matching Go export. Everything must complete
// synchronously here — the account pointer is freed the moment this returns, so the Go side must not
// defer any work that dereferences it.
static void
webos_account_removed_cb(PurpleAccount *account, gpointer data)
{
    (void)data;
    if (account == NULL) {
        return;
    }
    const char *proto = purple_account_get_protocol_id(account);
    char *user_dir = (char *)purple_user_dir();                    // cgo does not support const
    char *username = (char *)purple_account_get_username(account); // cgo does not support const
    if (g_strcmp0(proto, GOWHATSAPP_PRPL_ID) == 0) {
        // Match login.c: the device JID lives in the "credentials" setting (bitlbee falls back to
        // the password field). Go uses it to delete ONLY this account's row from the shared store.
        const char *credentials = purple_account_get_string(account, GOWHATSAPP_CREDENTIALS_KEY, NULL);
        if (credentials == NULL) {
            credentials = purple_account_get_password(account);
        }
        gowhatsapp_go_account_removed(account, user_dir, username, (char *)(credentials ? credentials : ""));
    } else if (g_strcmp0(proto, GOMETA_PLUGIN_ID) == 0) {
        gometa_go_account_removed(account, user_dir, username);
    }
}

// Connect the "account-removed" handler once, using `plugin` as the signal handle so
// libpurple2_plugin_unload's purple_signals_disconnect_by_handle(plugin) cleans it up. Called from
// plugin_init (the module is pinned resident, so the callback can never be unmapped). The accounts
// subsystem and its "account-removed" signal are registered by purple_core_init well before any
// plugin is probed, so the handle is always valid here.
static void
webos_connect_account_removed(PurplePlugin *plugin)
{
    purple_signal_connect(purple_accounts_get_handle(), "account-removed",
                          plugin, PURPLE_CALLBACK(webos_account_removed_cb), NULL);
}

static void plugin_init(PurplePlugin *plugin) {
    // The Go runtime (cgo c-archive) cannot survive g_module_close(): libpurple dlcloses plugins
    // during its startup plugin probe, which unmaps code the Go scheduler threads are still executing
    // -> SIGSEGV/SIGBUS, crash-looping imlibpurpletransport on a FULL device boot (and taking every
    // other account down with it, since they share the transport process). Pin this module resident
    // so g_module_close can never unmap it. Covers both prpls - WhatsApp and the Facebook/gometa
    // second prpl live in this same .so. plugin->handle is the GModule* set by purple's probe.
    if (plugin->handle) {
        g_module_make_resident((GModule *) plugin->handle);
    }
    // NOTE: com.palm.whatsapp.call is registered at WhatsApp LOGIN (glue/login.c), not here at plugin
    // probe. Registering an LS2 PalmService during purple_plugins_probe proved too fragile. Login-time
    // registration mirrors the standalone purple-gowhatsapp plugin, which had working calling.
    prpl_info.protocol_options = gowhatsapp_add_account_options(prpl_info.protocol_options);
    gometa_register_second_prpl();
    // Clean up per-account backend stores when an account is deleted (WhatsApp: per-JID device row
    // from the shared whatsmeow.db; Facebook-E2EE: the per-account gometa-e2ee-<user>.db). Covers both
    // prpls in this .so via one handler.
    webos_connect_account_removed(plugin);
}

static PurplePluginInfo info = {
    .magic = PURPLE_PLUGIN_MAGIC,
    .major_version = PURPLE_MAJOR_VERSION,
    .minor_version = PURPLE_MINOR_VERSION,
    .type = PURPLE_PLUGIN_PROTOCOL,
    .priority = PURPLE_PRIORITY_DEFAULT,
    .id = GOWHATSAPP_PRPL_ID,
    .name = "WhatsApp (whatsmeow)",
    .version = MAKE_STR(PLUGIN_VERSION),
    .summary = "",
    .description = "",
    .author = "Hermann Hoehne <hoehermann@gmx.de>",
    .homepage = "https://github.com/hoehermann/purple-gowhatsapp",
    .load = libpurple2_plugin_load,
    .unload = libpurple2_plugin_unload,
    .extra_info = &prpl_info,
    .actions = actions,
};

PURPLE_INIT_PLUGIN(gowhatsapp, plugin_init, info);
