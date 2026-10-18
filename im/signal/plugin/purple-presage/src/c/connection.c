#include "presage.h"
#include <glib/gstdio.h>

static gboolean rust_main_finished(gpointer account) {
    PurpleConnection *connection = purple_account_get_connection(account);
    if (connection == NULL) {
        purple_debug_info(PLUGIN_NAME, "rust runtime has finished after connection ceased to exist.\n");
    } else if (PURPLE_CONNECTION_STATE_DISCONNECTED == purple_connection_get_state(connection)) {
        purple_debug_info(PLUGIN_NAME, "rust runtime has finished as expected.\n");
    } else {
        purple_connection_error(connection, PURPLE_CONNECTION_ERROR_OTHER_ERROR, "rust runtime has finished unexpectedly.");
    }
    return FALSE; // tell the gtk event loop not to schedule calling this function again
}

#ifdef _WIN32
#include <windows.h>
static DWORD WINAPI
#else
static void * 
#endif 
rust_main(void* account) {
    // NOTE: This code is not being run on the main thread. Reading from account here is asking for trouble. Yet I am optimistic that the data will not be moved around while we are reading it.
    const char *user_dir = purple_user_dir();
    const char *username = purple_account_get_username(account);
    const int startup_delay_seconds = purple_account_get_int(account, PRESAGE_STARTUP_DELAY_SECONDS_OPTION, 1);
    char *store_path = g_strdup_printf("%s/presage/%s.db3", user_dir, username);
    g_usleep(G_USEC_PER_SEC * startup_delay_seconds); // waiting here for alleviates database locking issues O_o
    presage_rust_main(account, rust_runtime, store_path);
    g_free(store_path);
    purple_timeout_add(500, rust_main_finished, account); // wait half a second before assessing the termination – there might be messages lingering in the rust → C bridge queue
    return 0;
}

/* webOS reactions (SEND): the transport emits "webos-im-send-reaction" when the user places a reaction
 * from the app. Params: (account, targetServiceMessageId, emoji, peer, removeFlag). We resolve this
 * account's Rust command channel and hand the reaction to the Rust side to transmit over Signal.
 * targetServiceMessageId is the reacted-to message's sent timestamp (ms, decimal); removeFlag "1"
 * retracts the user's emoji. Runs on the libpurple main thread (signal emit). */
static void presage_send_reaction_cb(PurpleAccount *account, const char *target_id, const char *emoji, const char *peer, const char *remove_flag, void *unused) {
    (void)unused;
    if (account == NULL || peer == NULL || target_id == NULL) {
        return;
    }
    // The signal fires process-wide for EVERY prpl's reactions - filter to Signal accounts before
    // touching protocol_data (reading another prpl's protocol_data as a Presage* would be garbage).
    if (g_strcmp0(purple_account_get_protocol_id(account), "prpl-hehoe-presage") != 0) {
        return;
    }
    PurpleConnection *connection = purple_account_get_connection(account);
    if (connection == NULL) {
        return;
    }
    Presage *presage = purple_connection_get_protocol_data(connection);
    if (presage == NULL || presage->tx_ptr == NULL) {
        return;
    }
    uint64_t target_ts = g_ascii_strtoull(target_id, NULL, 10);
    if (target_ts == 0) {
        purple_debug_error(PLUGIN_NAME, "webos-im-send-reaction: unparseable target id \"%s\"\n", target_id);
        return;
    }
    int remove = (remove_flag != NULL && remove_flag[0] == '1' && remove_flag[1] == '\0') ? 1 : 0;
    presage_rust_send_reaction(account, rust_runtime, presage->tx_ptr, peer, target_ts, emoji, remove);
}

void presage_login(PurpleAccount *account) {
    purple_debug_info(PLUGIN_NAME, "login for account: %p\n", account);
    g_return_if_fail(rust_runtime != NULL);
    purple_debug_info(PLUGIN_NAME, "rust_runtime is at %p\n", rust_runtime);
    PurpleConnection *connection = purple_account_get_connection(account);
    // this protocol does not support anything special right now
    PurpleConnectionFlags pc_flags = purple_connection_get_flags(connection);
    pc_flags |= PURPLE_CONNECTION_FLAG_NO_IMAGES;
    pc_flags |= PURPLE_CONNECTION_FLAG_NO_FONTSIZE;
    pc_flags |= PURPLE_CONNECTION_FLAG_NO_BGCOLOR;
    purple_connection_set_flags(connection, pc_flags);
    purple_connection_set_state(connection, PURPLE_CONNECTION_STATE_CONNECTING);
    // Signal calling (signaling-only): register com.palm.signal.call so incoming Signal calls ring the
    // stock Phone app. Idempotent - just (re)binds this account on reconnect.
    callLunaInit(account);
    // webOS reactions (SEND): connect ONCE to the transport's "webos-im-send-reaction" signal so a
    // reaction the user places from the app is transmitted over Signal. The signal is registered by the
    // transport on the conversations handle; connect with a static guard so reconnects/multiple accounts
    // don't stack duplicate handlers (one handler serves all presage accounts; it routes per account).
    static gboolean send_reaction_connected = FALSE;
    if (!send_reaction_connected) {
        purple_signal_connect(purple_conversations_get_handle(), "webos-im-send-reaction", purple_get_core(),
            PURPLE_CALLBACK(presage_send_reaction_cb), NULL);
        send_reaction_connected = TRUE;
    }
    Presage *presage = g_new0(Presage, 1);
    purple_connection_set_protocol_data(connection, presage);
    #ifdef WIN32
    // the stack should grow automatically, but rust's tokio seems to be picky
    // the stack size used here should match the value in bridge.rs
    HANDLE thread = CreateThread(NULL, 32 * 1024 * 1024, rust_main, account, 0, NULL);
    if (thread != NULL) {
        // detach thread so its resources are released as soon it terminates
        CloseHandle(thread);
    }
    #else
    pthread_t presage_thread;
    int err = pthread_create(&presage_thread, NULL, rust_main, (void *)account);
    if (err == 0) {
        // detach thread so its resources are released as soon it terminates
        pthread_detach(presage_thread);
    }
    #endif
    else {
        gchar *errmsg = g_strdup_printf("Could not create thread for connecting in background."/*: %s", strerror(err)*/);
        purple_connection_error(connection, PURPLE_CONNECTION_ERROR_OTHER_ERROR, errmsg);
        g_free(errmsg);
    }
}

void presage_close(PurpleConnection *connection) {
    PurpleAccount *account = purple_connection_get_account(connection);
    Presage *presage = purple_connection_get_protocol_data(connection);
    presage_rust_exit(account, rust_runtime, presage->tx_ptr);
    presage->tx_ptr = NULL; // presage_rust_exit drops tx, we must no longer use it
}

/* Per-account store teardown on account deletion.
 *
 * The webOS transport deletes an account via purple_accounts_delete(), which first disconnects the
 * account (-> presage_close -> presage_rust_exit drops the Rust command channel, so the Rust runtime
 * terminates and releases the sqlite store) and only THEN emits libpurple's "account-removed" signal.
 * Without this hook the on-disk Signal store (E2EE identity/session keys) at
 * <purple_user_dir()>/presage/<username>.db3 is left orphaned. We delete it here, keyed strictly on
 * the removed account's own username so one account's deletion never touches another's store.
 *
 * The store path is built identically to rust_main() above so the paths match exactly.
 */
void presage_account_removed_cb(PurpleAccount *account, void *unused) {
    (void)unused;
    if (account == NULL) {
        return;
    }
    // The signal fires process-wide for EVERY prpl - only act on Signal (presage) accounts.
    if (g_strcmp0(purple_account_get_protocol_id(account), "prpl-hehoe-presage") != 0) {
        return;
    }
    // Normally the account has already been disconnected before this fires, so no connection exists.
    // Guard the "client still live" case anyway: drop the Rust command channel first so the store's
    // sqlite handle is released before we unlink the files.
    PurpleConnection *connection = purple_account_get_connection(account);
    if (connection != NULL) {
        Presage *presage = purple_connection_get_protocol_data(connection);
        if (presage != NULL && presage->tx_ptr != NULL) {
            presage_rust_exit(account, rust_runtime, presage->tx_ptr);
            presage->tx_ptr = NULL;
        }
    }
    const char *user_dir = purple_user_dir();
    const char *username = purple_account_get_username(account);
    if (username == NULL || username[0] == '\0') {
        return;
    }
    // Base store path is exactly what rust_main() opens; also sweep the sqlite sidecar files.
    char *store_path = g_strdup_printf("%s/presage/%s.db3", user_dir, username);
    static const char * const suffixes[] = { "", "-wal", "-shm", "-journal" };
    for (unsigned int i = 0; i < G_N_ELEMENTS(suffixes); i++) {
        char *path = g_strdup_printf("%s%s", store_path, suffixes[i]);
        if (g_file_test(path, G_FILE_TEST_EXISTS)) {
            if (g_unlink(path) == 0) {
                purple_debug_info(PLUGIN_NAME, "account-removed: deleted store file %s\n", path);
            } else {
                purple_debug_error(PLUGIN_NAME, "account-removed: failed to delete store file %s\n", path);
            }
        }
        g_free(path);
    }
    g_free(store_path);
}

/*
 * This is a variant of purple_connection_error. It must be run on the main thread.
 *
 * The switch regarding Spectrum is necessary since Spectrum may send commands to the backend 
 * before the backend signals readiness by explicitly setting the account to "connected".
 */
// TODO: Investigate why this happens, when excactly and on which commands. Then narrow down so not all errors are ignored. It is quite possible that the check regarding presage->error solved the issue.
// TODO: Maybe we should never call purple_connection_error_reason here, only log for all UIs?
void presage_account_error(PurpleAccount *account, PurpleConnectionError reason, const char *description) {
    GHashTable *ui_info = purple_core_get_ui_info();
    const gchar *ui_name = g_hash_table_lookup(ui_info, "name");
    if (purple_strequal(ui_name, "Spectrum")) {
        purple_debug_error(PLUGIN_NAME, "Host application is Spectrum. Error is ignored: %s\n", description);
    } else {
        PurpleConnection *connection = purple_account_get_connection(account);
        if (connection != NULL) {
            Presage *presage = purple_connection_get_protocol_data(connection);
            if (presage->error == TRUE) {
                purple_debug_error(PLUGIN_NAME, "Ignoring subsequent error: %s\n", description);
                // an error has alreade been reported, do not report an error again
                // this should be covered by the check for connection->disconnect_timeout > 0 in purple_connection_error_reason,
                // but due to the asynchronous nature of the rust part, errors might come in after the disconnect_timeout has happened
                // The current connection cannot recover from the error state. It will be destroyed and a new connection can be established.
            } else {
                purple_connection_error_reason(connection, reason, description);
            }
        }
    }
}
