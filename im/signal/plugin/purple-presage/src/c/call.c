/* webOS Synergy Revival - Signal calling, signaling-only (v1).
 *
 * purple-presage already decodes the Signal CallMessage envelope (Offer/Answer/Ice/Busy/Hangup) over the
 * authenticated session. This module surfaces INCOMING calls to the stock Phone app via the same LS2 call
 * contract WhatsApp/Telegram use (com.palm.signal.call): it rings the dialer with the caller's name and
 * lets the user decline, and records missed calls - WITHOUT any media stack (RingRTC media is a separate,
 * much larger effort; see the IM-voice-calling dossier). Registered from inside imlibpurpletransport on
 * libpurple's glib mainloop; the transport's LS2 role must allow the name com.palm.signal.call.
 *
 * Mirrors messaging/telegram/plugin/tdlib-purple/call-luna.cpp, rewritten in C against glib.
 */

#include "presage.h"
#include "webos-ls2-compat.h"   /* legacy split-bus API on either luna-service2 */
#include <glib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <time.h>

/* On-device lifecycle trace (purple_debug does not reach /var/log/messages). Tail
 * /media/internal/sigcall.log to see whether/where com.palm.signal.call registers. */
static void sigcLog(const char *fmt, ...)
{
    FILE *f = fopen("/media/internal/sigcall.log", "a");
    if (!f) return;
    time_t t = time(NULL);
    char ts[32]; struct tm tmv; localtime_r(&t, &tmv);
    strftime(ts, sizeof ts, "%H:%M:%S", &tmv);
    fprintf(f, "%s ", ts);
    va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fputc('\n', f);
    fclose(f);
}

/* call states pushed from the Rust receive loop (must match bridge.rs constants) */
#define SIG_CALL_INCOMING 0u
#define SIG_CALL_ENDED    1u
#define SIG_CALL_DECLINED 2u
#define SIG_CALL_BUSY     3u
#define SIG_CALL_ACTIVE   4u   /* peer answered OUR outgoing call -> connected */
#define SIG_CALL_DIALING  5u   /* we placed an outgoing call (Offer sent) -> ringing peer */
#define SIG_CALL_ANSWERED 6u   /* LOCAL-only: user tapped Answer on an INCOMING call (cb_answer);
                                * flip the line to active + route audio, keep origin=incoming. Not
                                * sent from Rust, so it need not match a bridge.rs constant. */

static LSPalmService *g_service = NULL;   /* pub+priv registration                     */
static LSHandle      *g_pub     = NULL;   /* public connection (untrusted apps)        */
static LSHandle      *g_prv     = NULL;   /* private connection (trusted Palm apps, incl. the Phone app) */
static PurpleAccount *g_account = NULL;   /* the bound Signal account                  */
static GMainLoop     *g_loopRef = NULL;   /* wraps the default context libpurple runs  */

/* last state we pushed, so a late subscriber gets the current picture immediately */
static char *g_state    = NULL;   /* "incoming" | "dialing" | "active" | "disconnected" | NULL (idle) */
static char *g_cause    = NULL;   /* only meaningful for "disconnected"        */
static char *g_addr     = NULL;
static char *g_name     = NULL;
static uint64_t g_call_id = 0;
static bool g_outgoing = false;   /* true while an OUTGOING call is up (origin=outgoing in the card) */

static const char *SUBKEY = "callState";

static void set_str(char **slot, const char *v)
{
    g_free(*slot);
    *slot = v ? g_strdup(v) : NULL;
}

static gchar *json_escape(const char *s)
{
    if (!s) return g_strdup("");
    GString *o = g_string_new(NULL);
    for (const char *p = s; *p; ++p) {
        switch (*p) {
            case '"':  g_string_append(o, "\\\""); break;
            case '\\': g_string_append(o, "\\\\"); break;
            case '\n': g_string_append(o, "\\n");  break;
            case '\r': g_string_append(o, "\\r");  break;
            case '\t': g_string_append(o, "\\t");  break;
            default:   g_string_append_c(o, *p);   break;
        }
    }
    return g_string_free(o, FALSE);
}

/* Build the CallSynergizer callStateQuery payload. Dispatch is on the LINE-level "state"; an empty
 * state => idle (no lines). Audio-only: allowVideoCalls=false. */
static gchar *build_payload(void)
{
    if (!g_state) {
        return g_strdup("{\"returnValue\":true,\"allowVideoCalls\":false,\"videoURI\":\"\",\"lines\":[]}");
    }
    gchar *st   = json_escape(g_state);
    gchar *addr = json_escape(g_addr);
    gchar *nm   = json_escape((g_name && *g_name) ? g_name : g_addr);
    gchar *disc = g_strcmp0(g_state, "disconnected") == 0
        ? g_strdup_printf("\"disconnectDetails\":{\"cause\":\"%s\"},", g_cause ? g_cause : "normal")
        : g_strdup("");
    /* CallSynergizer reads call.address / call.displayName DIRECTLY off each call and
     * CallSynergyContact.create() does enyo.require(address != undefined) which THROWS if address is
     * missing - aborting the whole callStateQuery handler before the call card is shown. So the fields
     * MUST be flat (like wacallm/TIL), not nested under "contact". origin=incoming (Signal only rings). */
    /* transport = this mediator's own PHONE account templateId. Without it CallSynergyContact
     * defaults the call to cellular ("MOBILE" + the UUID formatted as a phone number); with it the
     * Phone app's (service-agnostic) _isImTransport()/callNetworkName treat it as the IM it is and
     * show the Signal handle/UUID verbatim under "Signal". */
    gchar *p = g_strdup_printf(
        "{\"returnValue\":true,\"allowVideoCalls\":false,\"videoURI\":\"\",\"lines\":["
        "{\"state\":\"%s\",%s\"calls\":[{\"id\":\"sig\",\"origin\":\"%s\",\"video\":false,"
        "\"transport\":\"com.palm.signal\","
        "\"address\":\"%s\",\"displayName\":\"%s\"}]}]}",
        st, disc, g_outgoing ? "outgoing" : "incoming", addr, nm);
    g_free(st); g_free(addr); g_free(nm); g_free(disc);
    return p;
}

/* Minimal JSON string-field extractor for the flat LS2 dial payload (e.g. {"address":"<uuid>"}).
 * Returns a newly-allocated unescaped value, or NULL if absent. Good enough for the dialer's simple,
 * machine-generated payloads (no nested objects with the same key, no unicode escapes expected). */
static gchar *json_get_string(const char *payload, const char *key)
{
    if (!payload || !key) return NULL;
    gchar *needle = g_strdup_printf("\"%s\"", key);
    const char *k = strstr(payload, needle);
    g_free(needle);
    if (!k) return NULL;
    const char *c = strchr(k, ':');
    if (!c) return NULL;
    c++;
    while (*c == ' ' || *c == '\t') c++;
    if (*c != '"') return NULL;   /* only string values */
    c++;
    GString *o = g_string_new(NULL);
    for (; *c && *c != '"'; ++c) {
        if (*c == '\\' && c[1]) { c++; g_string_append_c(o, *c); }
        else g_string_append_c(o, *c);
    }
    return g_string_free(o, FALSE);
}

static bool cb_call_state_query(LSHandle *sh, LSMessage *msg, void *ctx)
{
    LSError err; LSErrorInit(&err);
    bool subscribed = false;
    LSSubscriptionProcess(sh, msg, &subscribed, &err);   /* honours {"subscribe":true} */
    if (subscribed) LSSubscriptionAdd(sh, SUBKEY, msg, &err);
    gchar *payload = build_payload();
    LSMessageReply(sh, msg, payload, &err);
    g_free(payload);
    if (LSErrorIsSet(&err)) { purple_debug_warning(PLUGIN_NAME, "callStateQuery: %s\n", err.message); LSErrorFree(&err); }
    return true;
}

/* Place an OUTGOING Signal call. The dialer POSTs {"address":"<signal-uuid>"[, "displayName":...]}.
 * We hand the address to the Rust command loop (presage_rust_place_call), which generates our media
 * keypair and sends the RingRTC Offer; the peer's Answer then starts the media engine in caller role
 * (call_bridge.rs on_answer). Locally we put the dialer straight into the "dialing" outgoing state so
 * the call card shows immediately. Gated on the same media flag as incoming auto-answer. */
static bool cb_dial(LSHandle *sh, LSMessage *msg, void *ctx)
{
    LSError err; LSErrorInit(&err);
    const char *payload = LSMessageGetPayload(msg);
    gchar *addr = json_get_string(payload, "address");
    gchar *name = json_get_string(payload, "displayName");
    sigcLog("cb_dial address=%s name=%s", addr ? addr : "(null)", name ? name : "(null)");

    if (!addr || !*addr) {
        LSMessageReply(sh, msg, "{\"returnValue\":false,\"errorText\":\"dial: missing address\"}", &err);
        if (LSErrorIsSet(&err)) LSErrorFree(&err);
        g_free(addr); g_free(name);
        return true;
    }
    if (!g_account) {
        LSMessageReply(sh, msg, "{\"returnValue\":false,\"errorText\":\"Signal account not connected\"}", &err);
        if (LSErrorIsSet(&err)) LSErrorFree(&err);
        g_free(addr); g_free(name);
        return true;
    }

    /* Fire the Signal Offer via the account's Rust command channel. */
    PurpleConnection *pc = purple_account_get_connection(g_account);
    Presage *presage = pc ? (Presage *)purple_connection_get_protocol_data(pc) : NULL;
    if (!presage || !presage->tx_ptr) {
        LSMessageReply(sh, msg, "{\"returnValue\":false,\"errorText\":\"Signal command channel unavailable\"}", &err);
        if (LSErrorIsSet(&err)) LSErrorFree(&err);
        g_free(addr); g_free(name);
        return true;
    }
    presage_rust_place_call(g_account, rust_runtime, presage->tx_ptr, addr);

    /* Do NOT push call state here. Like the Telegram dialer, we let the REAL call events drive the
     * card asynchronously: presage pushes "dialing" (SIG_CALL_DIALING) once the Offer is sent with
     * the real call_id, then "active" on Answer and "disconnected" on hangup - all one call_id, so
     * the dialer logs ONE call. (Pushing "dialing" here with call_id 0 and then getting the Answer's
     * real id made the dialer treat it as two calls -> a duplicate call-log entry.) */
    LSMessageReply(sh, msg, "{\"returnValue\":true}", &err);
    if (LSErrorIsSet(&err)) LSErrorFree(&err);
    g_free(addr); g_free(name);
    return true;
}

/* User tapped Answer on an incoming Signal call. The signal_media engine already auto-answered the
 * RingRTC offer (ICE connects via renomination, SRTP is flowing both ways), so accepting just means:
 * flip the line to active and turn on the audiod phone scenario so mic/speaker actually carry the
 * audio. Mirrors Telegram's cbAnswer -> callBridgeAnswer + callLunaSetCallAudio(true). */
static bool cb_answer(LSHandle *sh, LSMessage *msg, void *ctx)
{
    /* Tell the engine to emit the RingRTC rtp-data Accepted (PT101/SSRC0xD) so the caller's phone
     * stops ringing and both sides ungate audio. Without this the media pre-connects but RingRTC keeps
     * the call "ringing" forever with muted audio. */
    if (g_account && g_call_id) {
        PurpleConnection *pc = purple_account_get_connection(g_account);
        Presage *presage = pc ? (Presage *)purple_connection_get_protocol_data(pc) : NULL;
        if (presage && presage->tx_ptr)
            presage_rust_accept_call(g_account, rust_runtime, presage->tx_ptr, g_call_id);
    }
    /* Flip the local line to active + turn on the audiod voip scenario (mic/speaker routing). */
    presage_handle_call_state(g_account, g_addr, g_name, SIG_CALL_ANSWERED, g_call_id);
    LSError err; LSErrorInit(&err);
    LSMessageReply(sh, msg, "{\"returnValue\":true}", &err);
    if (LSErrorIsSet(&err)) LSErrorFree(&err);
    return true;
}

/* Decline/hang up: clear the ringing line so the dialer dismisses. (v2: also send a Signal Hangup back
 * to the caller so their phone stops ringing - needs the Rust send path.) */
static bool cb_disconnect(LSHandle *sh, LSMessage *msg, void *ctx)
{
    /* Actually end the call: send the peer a Signal Hangup and tear down our media engine, so audio
     * stops and their phone stops ringing. Without this the call kept running after the user hung up.
     * g_addr = peer Signal UUID, g_call_id = the active call. */
    if (g_account && g_addr && *g_addr && g_call_id) {
        PurpleConnection *pc = purple_account_get_connection(g_account);
        Presage *presage = pc ? (Presage *)purple_connection_get_protocol_data(pc) : NULL;
        if (presage && presage->tx_ptr)
            presage_rust_hangup_call(g_account, rust_runtime, presage->tx_ptr, g_addr, g_call_id);
    }
    presage_handle_call_state(g_account, g_addr, g_name, SIG_CALL_DECLINED, g_call_id);
    LSError err; LSErrorInit(&err);
    LSMessageReply(sh, msg, "{\"returnValue\":true}", &err);
    if (LSErrorIsSet(&err)) LSErrorFree(&err);
    return true;
}

static bool cb_noop(LSHandle *sh, LSMessage *msg, void *ctx)
{
    LSError err; LSErrorInit(&err);
    LSMessageReply(sh, msg, "{\"returnValue\":true}", &err);
    if (LSErrorIsSet(&err)) LSErrorFree(&err);
    return true;
}

static LSMethod g_methods[] = {
    { "callStateQuery", cb_call_state_query },
    { "dial",           cb_dial            },
    { "answer",         cb_answer          },
    { "disconnect",     cb_disconnect      },
    { "hangupAll",      cb_disconnect      },
    { "hangupAllActive",cb_disconnect      },
    { "hold",           cb_noop            },
    { "swap",           cb_noop            },
    { "merge",          cb_noop            },
    { "extract",        cb_noop            },
    { "dtmf",           cb_noop            },
    { "dtmfEnd",        cb_noop            },
    { "changeMedia",    cb_noop            },
    { NULL, NULL }
};

void callLunaInit(PurpleAccount *account)
{
    sigcLog("callLunaInit ENTER account=%s g_service=%p",
            account ? purple_account_get_username(account) : "(null)", (void*)g_service);
    g_account = account;
    if (g_service) return;   /* already registered (one service, whichever account connects first) */

    LSError err; LSErrorInit(&err);
    if (!LSRegisterPalmService("com.palm.signal.call", &g_service, &err)) {
        purple_debug_error(PLUGIN_NAME, "LSRegisterPalmService: %s\n", err.message);
        sigcLog("FAIL LSRegisterPalmService: %s", err.message);
        LSErrorFree(&err); return;
    }
    if (!LSPalmServiceRegisterCategory(g_service, "/", g_methods, g_methods, NULL, NULL, &err)) {
        purple_debug_error(PLUGIN_NAME, "RegisterCategory: %s\n", err.message);
        sigcLog("FAIL RegisterCategory: %s", err.message);
        LSErrorFree(&err); return;
    }
    /* attach to the context libpurple already services (its glib eventloop runs the default context) */
    g_loopRef = g_main_loop_new(g_main_context_default(), FALSE);
    if (!LSGmainAttachPalmService(g_service, g_loopRef, &err)) {
        purple_debug_error(PLUGIN_NAME, "GmainAttach: %s\n", err.message);
        sigcLog("FAIL GmainAttach: %s", err.message);
        LSErrorFree(&err); return;
    }
    g_pub = LSPalmServiceGetPublicConnection(g_service);
    g_prv = LSPalmServiceGetPrivateConnection(g_service);
    purple_debug_info(PLUGIN_NAME, "com.palm.signal.call registered\n");
    sigcLog("OK com.palm.signal.call REGISTERED g_pub=%p g_prv=%p", (void*)g_pub, (void*)g_prv);
}

void callLunaShutdown(PurpleAccount *account)
{
    if (g_account == account) g_account = NULL;
    /* keep the service registered for the process lifetime (other accounts may use it) */
}

/* Tell audiod about the call so it sets up the phone-audio scenario AND - with the PmBtEngine HFG
 * transport-gate patch (device-setup/bt-hfg-call-patch) - so Bluetooth call audio can route to a BT
 * headset. Mirrors WhatsApp (facebook-e2ee glue/call.c) and Telegram (tdlib-purple call-luna.cpp).
 * NB: the call "id" MUST be a STRING - PmBtEngine's HFG reads it as one; an int makes it log
 * "Failed to find call ID" and drop the call. transport stays com.palm.signal (the patch accepts
 * non-skype transports). Fire-and-forget on the private (trusted) handle. */
static bool audiod_reply(LSHandle *sh, LSMessage *m, void *ctx) { (void)sh; (void)m; (void)ctx; return true; }
static void audiod_send(const char *uri, const char *payload)
{
    if (!g_prv) return;
    LSError err; LSErrorInit(&err);
    LSMessageToken tok;
    if (!LSCallOneReply(g_prv, uri, payload, audiod_reply, NULL, &tok, &err)) {
        purple_debug_warning(PLUGIN_NAME, "audiod %s: %s\n", uri, err.message);
        LSErrorFree(&err);
    }
}

/* heap-marshalled call event: the Rust receive loop runs on a worker pthread, so (like
 * presage_append_message) we copy the data and hop to the main thread before touching LS2. */
typedef struct {
    uint32_t state;
    uint64_t call_id;
    char    *who;
    char    *name;
} CallEvt;

/* runs on the MAIN thread: apply the new state and push it to callStateQuery subscribers */
static gboolean call_state_apply(gpointer data)
{
    CallEvt *e = (CallEvt *)data;
    switch (e->state) {
        case SIG_CALL_INCOMING:
            g_outgoing = false;
            set_str(&g_state, "incoming"); set_str(&g_cause, NULL);
            set_str(&g_addr, e->who); set_str(&g_name, e->name); g_call_id = e->call_id;
            break;
        case SIG_CALL_DIALING:
            /* We placed an outgoing call (Offer sent). Show the outgoing "dialing" card with the
             * real call_id so the whole call (dialing -> active -> disconnected) is one entry. */
            g_outgoing = true;
            set_str(&g_state, "dialing"); set_str(&g_cause, NULL);
            set_str(&g_addr, e->who); set_str(&g_name, e->name); g_call_id = e->call_id;
            break;
        case SIG_CALL_ACTIVE:
            /* Peer answered our outgoing call. Keep addr/name/origin; flip the line to active so the
             * dialer shows a connected call. call_id may arrive here for the first time. */
            g_outgoing = true;
            set_str(&g_state, "active"); set_str(&g_cause, NULL);
            if (e->call_id) g_call_id = e->call_id;
            break;
        case SIG_CALL_ANSWERED:
            /* User tapped Answer on an INCOMING call. The media engine already auto-answered on the
             * offer (SRTP is flowing), so all we do here is flip the line to active - which both shows
             * a connected card AND (below) fires the audiod phone scenario that routes mic/speaker to
             * the voip path. Keep g_outgoing=false and the caller's addr/name from SIG_CALL_INCOMING. */
            set_str(&g_state, "active"); set_str(&g_cause, NULL);
            break;
        case SIG_CALL_DECLINED:
            set_str(&g_state, "disconnected"); set_str(&g_cause, "rejected");
            break;
        case SIG_CALL_BUSY:
            set_str(&g_state, "disconnected"); set_str(&g_cause, "busy");
            break;
        case SIG_CALL_ENDED:
        default:
            set_str(&g_state, "disconnected"); set_str(&g_cause, "normal");
            break;
    }

    /* A subscriber's subscription lives on whichever connection it arrived on: untrusted apps come in
     * on the public connection, trusted Palm apps (the stock Phone app / CallSynergizer) on the private
     * one. LSSubscriptionReply only walks the list of the handle it's given, so push on BOTH - otherwise
     * the Phone app gets only the initial reply and never the live incoming/disconnected pushes. */
    if (g_pub || g_prv) {
        gchar *payload = build_payload();
        if (g_pub) {
            LSError err; LSErrorInit(&err);
            LSSubscriptionReply(g_pub, SUBKEY, payload, &err);
            if (LSErrorIsSet(&err)) { purple_debug_warning(PLUGIN_NAME, "call pushState pub: %s\n", err.message); LSErrorFree(&err); }
        }
        if (g_prv) {
            LSError err; LSErrorInit(&err);
            LSSubscriptionReply(g_prv, SUBKEY, payload, &err);
            if (LSErrorIsSet(&err)) { purple_debug_warning(PLUGIN_NAME, "call pushState prv: %s\n", err.message); LSErrorFree(&err); }
        }
        g_free(payload);
    }

    /* audiod: a live call needs the phone-audio scenario (and, with the PmBtEngine patch, lets BT call
     * audio reach a headset). On "active" -> active CallStatusUpdate + scenario; on teardown -> empty
     * lines. Must run BEFORE the idle reset below (which clears g_state). */
    if (g_strcmp0(g_state, "active") == 0) {
        audiod_send("palm://com.palm.audio/phone/CallStatusUpdate",
                    "{\"lines\":[{\"state\":\"active\",\"calls\":[{\"id\":\"sig\",\"address\":\"signal\",\"origin\":\"outgoing\",\"video\":false,\"transport\":\"com.palm.signal\"}]}]}");
        audiod_send("palm://com.palm.audio/phone/setCurrentScenario", "{\"scenario\":\"phone_back_speaker\"}");
    } else if (g_strcmp0(g_state, "disconnected") == 0) {
        audiod_send("palm://com.palm.audio/phone/CallStatusUpdate", "{\"lines\":[]}");
    }

    /* after a terminal state, return to idle so the next call starts clean */
    if (g_strcmp0(g_state, "disconnected") == 0) {
        set_str(&g_state, NULL); set_str(&g_cause, NULL);
        set_str(&g_addr, NULL);  set_str(&g_name, NULL); g_call_id = 0;
        g_outgoing = false;
    }

    g_free(e->who); g_free(e->name); g_free(e);
    return FALSE;   /* one-shot */
}

/* Called from the Rust receive loop (worker thread) when a Signal CallMessage arrives, and from
 * cb_disconnect (main thread). Marshals to the main thread before touching the LS2 connection. */
void presage_handle_call_state(PurpleAccount *account, const char *who, const char *name,
                               uint32_t state, uint64_t call_id)
{
    sigcLog("call event: state=%u who=%s name=%s call_id=%llu g_pub=%p",
            state, who ? who : "(null)", name ? name : "(null)",
            (unsigned long long)call_id, (void*)g_pub);
    CallEvt *e = g_new0(CallEvt, 1);
    e->state = state;
    e->call_id = call_id;
    e->who = g_strdup(who);
    e->name = g_strdup(name);
    purple_timeout_add(0, call_state_apply, e);   /* g_timeout_add is thread-safe; runs on main thread */
}
