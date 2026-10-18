#include "presage.h"
/* webOS: no qrencode on device. We do NOT render the QR image here; instead we surface the
 * device-link URI as the "qr_string" request field, which imlibpurpletransport's request_fields
 * UI-op forwards to the accounts QR AuthChannel (same path as WhatsApp/Discord). The app renders
 * the QR from the string. So qrencode is dropped entirely. */

static void qrcode_hide(PurpleConnection *connection, PurpleRequestFields *fields) {
    // nothing to do.
}

static void qrcode_cancel(PurpleConnection *connection, PurpleRequestFields *fields) {
    purple_connection_error(connection, PURPLE_CONNECTION_ERROR_OTHER_ERROR, "Linking was cancelled.");
}

static void show_qrcode(PurpleConnection *connection, const char *qrstring, gchar* qrimgdata, gsize qrimglen) {
    // Dispalay qrcode for scanning
    PurpleRequestFields *fields = purple_request_fields_new();
    PurpleRequestFieldGroup *group = purple_request_field_group_new(NULL);

    purple_request_fields_add_group(fields, group);
    {
        PurpleRequestField *field = purple_request_field_string_new("qr_string", "QR Code Data", qrstring, FALSE);
        purple_request_field_group_add_field(group, field);
    }
    /* webOS: only add the image field if we actually have image bytes. On device we pass NULL
     * (no qrencode) and rely on qr_string, which the transport publishes to the QR AuthChannel. */
    if (qrimgdata != NULL && qrimglen > 0) {
        PurpleRequestField *field = purple_request_field_image_new("qr_code", "QR Code", qrimgdata, qrimglen);
        purple_request_field_group_add_field(group, field);
    }

    PurpleAccount *account = purple_connection_get_account(connection);
    purple_request_fields(
        connection, "Signal Protocol", "Link to master device",
        "In the Signal App, go to \"Preferences\" and \"Linked devices\". Scan the QR code below. Wait for the window to close.", 
        fields,
        "Hide", G_CALLBACK(qrcode_hide), 
        "Cancel", G_CALLBACK(qrcode_cancel),
        account, NULL, NULL,
        connection);
}

static void generate_and_show_qrcode(PurpleConnection *connection, const char *data) {
    g_return_if_fail(data != NULL);
    /* webOS: skip on-device QR rendering (no qrencode). Surface the raw device-link URI as the
     * qr_string request field; the transport forwards it to the accounts QR AuthChannel and the
     * app renders the QR from the string. */
    show_qrcode(connection, data, NULL, 0);
}

static void write_qrcode_as_conversation(PurpleConnection *connection, const char *data) {
    const gchar *who = "Logon QR Code";
    PurpleMessageFlags flags = PURPLE_MESSAGE_RECV;
    gchar *msg = g_strdup_printf("Convert the next line into a QR code and scan it with your main device:<br>%s", data);
    purple_serv_got_im(connection, who, msg, flags, time(NULL));
    g_free(msg);
}

void presage_handle_qrcode(PurpleConnection *connection, const char *data) {
    g_return_if_fail(data != NULL);
    if (data[0] == 0) {
        // empty string means "linking has finished"
        purple_request_close_with_handle(connection); // close request displaying the QR code
        PurpleAccount *account = purple_connection_get_account(connection);
        Presage *presage = purple_connection_get_protocol_data(connection);
        presage_rust_whoami(account, rust_runtime, presage->tx_ptr); // now that linking is done, get own uuid
    } else {
        PurpleRequestUiOps *ui_ops = purple_request_get_ui_ops();
        if (ui_ops && ui_ops->request_fields) {
            // UI supports request fields (e.g. Pidgin)
            generate_and_show_qrcode(connection, data);
        } else {
            // UI does not implement request fields (e.g. bitlbee)
            write_qrcode_as_conversation(connection, data);
        }
    }
}

// TODO: maybe move this into connection.c?
void presage_handle_uuid(PurpleConnection *connection, const char *uuid) {
    g_return_if_fail(uuid != NULL);
    PurpleAccount *account = purple_connection_get_account(connection);
    const char *username = purple_account_get_username(account);
    if (purple_strequal(username, uuid)) {
        purple_request_close_with_handle(connection); // close request displaying the QR code
    } else {
        // webOS create-after-confirm: the preview login's username is the phone number the user
        // typed, not the Signal UUID. Rather than erroring the connection, surface the real UUID as
        // the account "token" so imlibpurpletransport captures it (account_logged_in_cb ->
        // AuthChannel::setConfirmed) and the accounts validator re-creates the account with
        // username=UUID. Close the QR request and let the connection reach CONNECTED.
        purple_account_set_string(account, "token", uuid);
        purple_request_close_with_handle(connection);
    }
}
