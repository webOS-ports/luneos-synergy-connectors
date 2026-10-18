/* webOS Synergy Revival - Telegram calling M2 (Path C): the LS2 call service.
 * See call-luna.h. Serves com.palm.telegram.call to the stock Phone app (CallSynergizer),
 * mirroring the com.palm.whatsapp / wacallm contract:
 *   - callStateQuery  (subscription) : streams line/call state to the dialer
 *   - dial {address}                 : place an outgoing call
 *   - answer {id}                    : accept the pending incoming call
 *   - disconnect {id} / hangupAll    : end the current call
 * The heavy lifting (TDLib signaling + libtgvoip media) already lives in call.cpp; this only
 * translates the webOS call contract to/from the small bridge functions below.
 */

#include "call-luna.h"
#include "config.h"
#include "voipkit.h"
#include "webos-ls2-compat.h"   /* legacy split-bus API on either luna-service2 */
#include <glib.h>
#include <string>
#include <cstdio>
#include <ctime>
#include <cstdarg>

/* Implemented in call.cpp - drive the active account's TDLib call via the existing prpl logic. */
extern bool callBridgeDial(PurpleAccount *account, const char *who, bool video);
extern void callBridgeAnswer(PurpleAccount *account);
extern void callBridgeHangup(PurpleAccount *account);

/* On-device lifecycle trace (purple_debug never reaches /var/log/messages on webOS). Tail
 * /media/internal/tgcall.log to see exactly when/if the call service registers + dials. */
void tgcLog(const char *fmt, ...)
{
    FILE *f = fopen("/media/internal/tgcall.log", "a");
    if (!f) return;
    time_t t = time(NULL);
    char ts[32]; struct tm tmv; localtime_r(&t, &tmv);
    strftime(ts, sizeof ts, "%H:%M:%S", &tmv);
    fprintf(f, "%s ", ts);
    va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fputc('\n', f);
    fclose(f);
}

namespace {

LSPalmService *g_service  = NULL;   // pub+priv registration
LSHandle      *g_pub      = NULL;   // public connection (untrusted apps talk here)
LSHandle      *g_prv      = NULL;   // private connection (trusted Palm apps, incl. com.palm.app.phone, talk here)
PurpleAccount *g_account  = NULL;   // the bound Telegram account
GMainLoop     *g_loopRef  = NULL;   // wraps the default context libpurple runs

// Last state we pushed, so a late subscriber gets the current picture immediately.
std::string    g_state, g_peerAddr, g_peerName, g_cause;
bool           g_outgoing = false;
bool           g_videoActive = false; // clonk session open + skypekit bridge running
bool           g_callIsVideo = false; // this call negotiated video (TDLib call.is_video_), known
                                       // from ring/dial time -- distinct from g_videoActive above
std::string    g_clonkUri;            // the open clonk session's palm:// LS2 URI, if any

const char *SUBKEY = "callState";

std::string jsonEscape(const char *s)
{
    std::string o;
    for (const char *p = s ? s : ""; *p; ++p) {
        switch (*p) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:   o += *p;     break;
        }
    }
    return o;
}

// Build the CallSynergizer callStateQuery payload. Dispatch is on the LINE-level "state"
// (handleIncoming/handleActive/handleDisconnected); an empty state => idle (no lines).
std::string buildPayload()
{
    // ActiveCall.js reads outgoingVideo/incomingVideo/incomingVideoState directly off the LINE
    // object (activeLines[0].outgoingVideo etc.), NOT off calls[] -- confirmed against the
    // WhatsApp mediator (call.go:190-192), which is the one known to actually drive the Phone
    // app's video UI. incomingVideoState is CallSynergizer's tri-state:
    // "unavailable" (not a video call) / "available" (video call, not yet streaming, e.g. still
    // ringing/dialing) / "streaming" (the native clonk/skypekit bridge is actually up). A plain
    // per-call "video" bool (this file's original approach) is simply never read by the UI.
    const char *videoState = g_videoActive ? "streaming" : (g_callIsVideo ? "available" : "unavailable");
    const char *videoBool  = g_videoActive ? "true" : "false";

    std::string p = std::string("{\"returnValue\":true,\"allowVideoCalls\":true,\"videoURI\":\"") +
                     jsonEscape(g_clonkUri.c_str()) + "\",\"lines\":[";
    if (!g_state.empty()) {
        p += "{\"state\":\"" + jsonEscape(g_state.c_str()) + "\",";
        if (g_state == "disconnected")
            p += "\"disconnectDetails\":{\"cause\":\"" + jsonEscape(g_cause.c_str()) + "\"},";
        p += std::string("\"incomingVideo\":") + videoBool + ",\"outgoingVideo\":" + videoBool +
             ",\"incomingVideoState\":\"" + videoState + "\",";
        // CallSynergizer reads call.address / call.displayName DIRECTLY off each call
        // (new CallSynergyContact({address: call.address, displayName: call.displayName})), and
        // CallSynergyContact.create() does enyo.require(address != undefined) which THROWS if
        // address is missing - aborting the whole callStateQuery handler before the call card is
        // shown. So the fields MUST be flat (like wacallm/TIL), not nested under "contact".
        // transport = this mediator's own PHONE account templateId. Without it CallSynergyContact
        // defaults the call to cellular ("MOBILE" + the id formatted as a phone number); with it the
        // Phone app's (service-agnostic) _isImTransport()/callNetworkName treat it as the IM it is
        // and show the id/@handle verbatim under the network's name.
        p += "\"calls\":[{\"id\":\"tg\",\"origin\":\"" + std::string(g_outgoing ? "outgoing" : "incoming") + "\","
             "\"incomingVideo\":" + videoBool + ",\"outgoingVideo\":" + videoBool + ","
             "\"incomingVideoState\":\"" + videoState + "\","
             "\"transport\":\"com.palm.telegram\","
             "\"address\":\"" + jsonEscape(g_peerAddr.c_str()) + "\","
             "\"displayName\":\"" + jsonEscape(g_peerName.empty() ? g_peerAddr.c_str() : g_peerName.c_str()) + "\"}]}";
    }
    p += "]}";
    return p;
}

bool cbCallStateQuery(LSHandle *sh, LSMessage *msg, void *)
{
    LSError err; LSErrorInit(&err);
    bool subscribed = false;
    LSSubscriptionProcess(sh, msg, &subscribed, &err);   // honours {"subscribe":true}
    if (subscribed)
        LSSubscriptionAdd(sh, SUBKEY, msg, &err);
    std::string payload = buildPayload();
    LSMessageReply(sh, msg, payload.c_str(), &err);
    if (LSErrorIsSet(&err)) { purple_debug_warning(config::pluginId, "callStateQuery: %s\n", err.message); LSErrorFree(&err); }
    return true;
}

// tiny extractor for a top-level string field (avoids pulling a JSON lib into the prpl)
std::string getField(const char *json, const char *key)
{
    if (!json) return "";
    std::string needle = std::string("\"") + key + "\"";
    const char *k = strstr(json, needle.c_str());
    if (!k) return "";
    const char *c = strchr(k + needle.size(), ':');
    if (!c) return "";
    while (*++c == ' ') ;
    if (*c != '"') return "";
    const char *e = strchr(++c, '"');
    return e ? std::string(c, e - c) : "";
}

// tiny extractor for a top-level boolean field (mirrors the WhatsApp plugin's json_true())
bool getBoolField(const char *json, const char *key)
{
    if (!json) return false;
    std::string needle = std::string("\"") + key + "\"";
    const char *k = strstr(json, needle.c_str());
    if (!k) return false;
    const char *c = strchr(k + needle.size(), ':');
    if (!c) return false;
    while (*++c == ' ') ;
    return strncmp(c, "true", 4) == 0;
}

bool cbDial(LSHandle *sh, LSMessage *msg, void *)
{
    LSError err; LSErrorInit(&err);
    const char *payload = LSMessageGetPayload(msg);
    std::string addr = getField(payload, "address");
    bool video = getBoolField(payload, "video");
    bool ok = g_account && !addr.empty() && callBridgeDial(g_account, addr.c_str(), video);
    tgcLog("cbDial addr=%s video=%d g_account=%p ok=%d", addr.c_str(), (int)video, (void*)g_account, ok);
    LSMessageReply(sh, msg, ok ? "{\"returnValue\":true}" : "{\"returnValue\":false}", &err);
    if (LSErrorIsSet(&err)) LSErrorFree(&err);
    return true;
}

bool cbAnswer(LSHandle *sh, LSMessage *msg, void *)
{
    LSError err; LSErrorInit(&err);
    if (g_account) callBridgeAnswer(g_account);
    LSMessageReply(sh, msg, "{\"returnValue\":true}", &err);
    if (LSErrorIsSet(&err)) LSErrorFree(&err);
    return true;
}

bool cbDisconnect(LSHandle *sh, LSMessage *msg, void *)
{
    LSError err; LSErrorInit(&err);
    if (g_account) callBridgeHangup(g_account);
    LSMessageReply(sh, msg, "{\"returnValue\":true}", &err);
    if (LSErrorIsSet(&err)) LSErrorFree(&err);
    return true;
}

// The Phone app's manual-dial call contract methods (spec Part 3). We implement the ones a 1:1
// VoIP call needs; the rest ack so CallSynergizer doesn't error.
bool cbNoop(LSHandle *sh, LSMessage *msg, void *)
{
    LSError err; LSErrorInit(&err);
    LSMessageReply(sh, msg, "{\"returnValue\":true}", &err);
    if (LSErrorIsSet(&err)) LSErrorFree(&err);
    return true;
}

LSMethod g_methods[] = {
    { "callStateQuery", cbCallStateQuery },
    { "dial",           cbDial           },
    { "answer",         cbAnswer         },
    { "disconnect",     cbDisconnect     },
    { "hangupAll",      cbDisconnect     },
    { "hangupAllActive",cbDisconnect     },
    { "hold",           cbNoop           },
    { "swap",           cbNoop           },
    { "merge",          cbNoop           },
    { "extract",        cbNoop           },
    { "dtmf",           cbNoop           },
    { "dtmfEnd",        cbNoop           },
    { "changeMedia",    cbNoop           },
    { NULL, NULL }
};

} // namespace

bool callLunaInit(PurpleAccount *account)
{
    tgcLog("callLunaInit ENTER account=%s g_service=%p",
           account ? purple_account_get_username(account) : "(null)", (void*)g_service);
    g_account = account;
    if (g_service) return true;   // already registered (one service, whichever account connects first)

    LSError err; LSErrorInit(&err);
    if (!LSRegisterPalmService("com.palm.telegram.call", &g_service, &err)) {
        purple_debug_error(config::pluginId, "LSRegisterPalmService: %s\n", err.message);
        tgcLog("callLunaInit FAIL LSRegisterPalmService: %s", err.message);
        LSErrorFree(&err); return false;
    }
    if (!LSPalmServiceRegisterCategory(g_service, "/", g_methods, g_methods, NULL, NULL, &err)) {
        purple_debug_error(config::pluginId, "RegisterCategory: %s\n", err.message);
        tgcLog("callLunaInit FAIL RegisterCategory: %s", err.message);
        LSErrorFree(&err); return false;
    }
    // Attach to the context libpurple already services (its glib eventloop runs the default context).
    g_loopRef = g_main_loop_new(g_main_context_default(), FALSE);
    if (!LSGmainAttachPalmService(g_service, g_loopRef, &err)) {
        purple_debug_error(config::pluginId, "GmainAttach: %s\n", err.message);
        tgcLog("callLunaInit FAIL GmainAttach: %s", err.message);
        LSErrorFree(&err); return false;
    }
    g_pub = LSPalmServiceGetPublicConnection(g_service);
    g_prv = LSPalmServiceGetPrivateConnection(g_service);
    purple_debug_info(config::pluginId, "com.palm.telegram.call registered\n");
    tgcLog("callLunaInit OK - com.palm.telegram.call REGISTERED, g_pub=%p", (void*)g_pub);
    return true;
}

void callLunaShutdown(PurpleAccount *account)
{
    if (g_account == account) g_account = NULL;
    // Keep the service registered for the process lifetime (cheap, and other accounts may use it).
}

void callLunaPushState(const char *state, const char *peerAddress, const char *peerName,
                       bool isOutgoing, const char *cause, bool isVideo)
{
    g_state    = state       ? state       : "";
    g_peerAddr = peerAddress  ? peerAddress : "";
    g_peerName = peerName     ? peerName    : "";
    g_cause    = cause        ? cause       : "";
    g_outgoing = isOutgoing;
    g_callIsVideo = isVideo;
    tgcLog("pushState state=%s addr=%s g_pub=%p g_prv=%p", g_state.c_str(), g_peerAddr.c_str(), (void*)g_pub, (void*)g_prv);
    if (!g_pub && !g_prv) return;
    std::string payload = buildPayload();
    // A subscriber's subscription lives on whichever connection it arrived on: untrusted apps come
    // in on the public connection, trusted Palm apps (the stock Phone app / CallSynergizer) on the
    // private one. LSSubscriptionReply only walks the list of the handle it's given, so push on BOTH
    // - otherwise the Phone app gets only the initial reply and never the live dialing/active pushes.
    if (g_pub) {
        LSError err; LSErrorInit(&err);
        LSSubscriptionReply(g_pub, SUBKEY, payload.c_str(), &err);
        if (LSErrorIsSet(&err)) { purple_debug_warning(config::pluginId, "pushState pub: %s\n", err.message); LSErrorFree(&err); }
    }
    if (g_prv) {
        LSError err; LSErrorInit(&err);
        LSSubscriptionReply(g_prv, SUBKEY, payload.c_str(), &err);
        if (LSErrorIsSet(&err)) { purple_debug_warning(config::pluginId, "pushState prv: %s\n", err.message); LSErrorFree(&err); }
    }
}

// --- clonk: the native SkypeKit video bridge --------------------------------------------------
// See messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md (Parts 1-21) for the full
// reverse-engineering trail this is built against, and glue/call.c in the WhatsApp plugin
// (messaging/facebook-e2ee/plugin/purple-combined) for the exact pattern this mirrors -- same
// LS2 sequence, same Part 16 field-shift-compensated videoCaptureStart args, same Part 17
// ordering constraint (voipkit_video_start() must run before videoPlayerStart's LS2 call).

bool clonkOpenReplyCb(LSHandle *sh, LSMessage *msg, void *ctx);
bool clonkCaptureStartReplyCb(LSHandle *sh, LSMessage *msg, void *ctx);
bool clonkPlayerStartReplyCb(LSHandle *sh, LSMessage *msg, void *ctx);
bool clonkStopReplyCb(LSHandle *sh, LSMessage *msg, void *ctx);

void clonkUriCall(const char *method, const char *jsonPayload, LSFilterFunc cb, void *ctx)
{
    if (!g_prv || g_clonkUri.empty()) return;
    std::string uri = g_clonkUri + method;
    LSError err; LSErrorInit(&err);
    LSMessageToken tok;
    if (!LSCallOneReply(g_prv, uri.c_str(), jsonPayload, cb, ctx, &tok, &err)) {
        tgcLog("clonk %s call failed: %s", method, err.message);
        LSErrorFree(&err);
    }
}

bool clonkCaptureStartReplyCb(LSHandle *sh, LSMessage *msg, void *ctx)
{
    (void)sh; (void)ctx;
    tgcLog("clonk videoCaptureStart: %s", LSMessageGetPayload(msg));
    // Thread A (capture->peer) must be bound+listening before videoPlayerStart triggers
    // mediaserver's RunVideoHost() -- WHATSAPP_VIDEO_STATUS.md Part 17.
    voipkit_video_start();
    // Block for a real "Thread B connected" signal before firing videoPlayerStart, rather than
    // relying on voipkit_video_start()'s own short margin (which only proves Thread A's
    // near-instant bind+listen happened, not that Thread B's own connect-retry loop -- up to
    // 500ms per attempt -- has actually succeeded). Ported from WhatsApp's identical bridge
    // (glue/call.c's clonk_video_capture_start_reply): firing too early there made the peer-video
    // playback pipeline fail its READY->PAUSED state change and tear itself down within ~300ms,
    // every time, including on the very first videoPlayerStart of a call.
    if (!voipkit_video_wait_thread_b(3000)) {
        tgcLog("skypekit thread B did not connect within 3s, firing videoPlayerStart anyway");
    }
    clonkUriCall("videoPlayerStart", "{\"args\":[320,240]}", clonkPlayerStartReplyCb, NULL);
    return true;
}
bool clonkPlayerStartReplyCb(LSHandle *sh, LSMessage *msg, void *ctx)
{
    (void)sh; (void)ctx;
    tgcLog("clonk videoPlayerStart: %s", LSMessageGetPayload(msg));
    return true;
}

bool clonkOpenReplyCb(LSHandle *sh, LSMessage *msg, void *ctx)
{
    (void)sh; (void)ctx;
    const char *p = LSMessageGetPayload(msg);
    std::string uri = getField(p, "location");
    if (!uri.empty()) {
        g_clonkUri = uri;
        tgcLog("clonk session open: %s", g_clonkUri.c_str());
        // videoCaptureStart args are (w,h,fps,bitrate) on the wire, but ClonkPipeline::
        // setCamCapsFilter() reads the wrong VideoSettings offsets (+4/+8 instead of +0/+4) --
        // a real firmware bug (WHATSAPP_VIDEO_STATUS.md Part 16). Putting the intended width in
        // the h slot and the intended height in the fps slot lands the correct width/height in
        // the actual applied caps once that bug reads them one field over.
        clonkUriCall("videoCaptureStart", "{\"args\":[320,320,240,400000]}", clonkCaptureStartReplyCb, NULL);
    } else {
        tgcLog("clonk session open failed: %s", p ? p : "(no payload)");
    }
    return true;
}

// Opens a clonk session and drives it through videoCaptureStart -> voipkit_video_start() ->
// videoPlayerStart. Call once per video call, from activateCall() when call.is_video_.
void callLunaOpenClonk()
{
    if (!g_clonkUri.empty() || !g_prv) return;
    g_videoActive = true;
    LSError err; LSErrorInit(&err);
    LSMessageToken tok;
    if (!LSCallOneReply(g_prv, "palm://com.palm.mediad/service/clonk", "{}", clonkOpenReplyCb, NULL, &tok, &err)) {
        tgcLog("clonk open call failed: %s", err.message);
        LSErrorFree(&err);
    }
}

bool clonkStopReplyCb(LSHandle *sh, LSMessage *msg, void *ctx)
{
    (void)sh;
    tgcLog("clonk %s: %s", (const char *)ctx, LSMessageGetPayload(msg));
    return true;
}

// Tears down the skypekit bridge + clonk session. No confirmed explicit session-teardown method
// (mediaserver tears a session down when its creating client's LS2 connection drops, shared with
// the rest of this long-lived process) -- a fresh session is opened next time video starts.
void callLunaCloseClonk()
{
    if (g_clonkUri.empty()) { g_videoActive = false; return; }
    voipkit_video_stop(); // stop our own socket threads before telling mediaserver to stop
    clonkUriCall("videoPlayerStop", "{\"args\":[]}", clonkStopReplyCb, (void*)"videoPlayerStop");
    clonkUriCall("videoCaptureStop", "{\"args\":[]}", clonkStopReplyCb, (void*)"videoCaptureStop");
    g_clonkUri.clear();
    g_videoActive = false;
}

bool clonkKeyframeStartReplyCb(LSHandle *sh, LSMessage *msg, void *ctx)
{
    (void)sh; (void)ctx;
    tgcLog("clonk keyframe-restart videoCaptureStart: %s", LSMessageGetPayload(msg));
    return true;
}
bool clonkKeyframeStopReplyCb(LSHandle *sh, LSMessage *msg, void *ctx)
{
    (void)sh; (void)ctx;
    tgcLog("clonk keyframe-restart videoCaptureStop: %s", LSMessageGetPayload(msg));
    // Thread A/B and the clonk session itself stay up throughout -- only the capture pipeline
    // restarts, so no voipkit_video_start()/videoPlayerStart() here.
    clonkUriCall("videoCaptureStart", "{\"args\":[320,320,240,400000]}", clonkKeyframeStartReplyCb, NULL);
    return true;
}

// Called from VoipKitVideoSource::RequestKeyFrame() (VoIPController's real PLI-equivalent
// signal). No LS2-exposed keyframe trigger exists on the clonk surface, so this restarts
// capture instead -- every capture start emits a real SPS/PPS/IDR opening sequence.
void callLunaRequestKeyframe()
{
    if (g_clonkUri.empty()) return;
    tgcLog("keyframe requested, restarting capture");
    clonkUriCall("videoCaptureStop", "{\"args\":[]}", clonkKeyframeStopReplyCb, NULL);
}

// --- webOS call-audio routing (mirrors the working wacallm path) --------------------------------
// libtgvoip captures/plays via the PulseAudio "voipsource"/"voip" PCMs, but those only carry the
// real mic/loudspeaker when audiod has the PHONE scenario active. Tell audiod a voip call is up on
// connect (route to loudspeaker; it auto-switches to headset/BT), and clear it on hangup.
static bool audiodReply(LSHandle *sh, LSMessage *m, void *ctx) { (void)sh; (void)m; (void)ctx; return true; }
static void audiodSend(const char *uri, const char *payload)
{
    if (!g_prv) return;
    LSError err; LSErrorInit(&err);
    LSMessageToken tok;
    if (!LSCallOneReply(g_prv, uri, payload, audiodReply, NULL, &tok, &err)) {
        purple_debug_warning(config::pluginId, "audiod %s: %s\n", uri, err.message);
        LSErrorFree(&err);
    }
}
void callLunaSetCallAudio(bool active)
{
    tgcLog("callLunaSetCallAudio active=%d g_prv=%p", (int)active, (void*)g_prv);
    if (active) {
        // NB: "id" MUST be a STRING (not int): PmBtEngine's HFG reads the call id as a string; an int makes
        // it log "Failed to find call ID" and drop the call, so BT call audio never sets up. See the WhatsApp
        // plugin (glue/call.c) + the bluetooth-call-audio-sco note. "transport" stays com.palm.telegram (a
        // 1-byte PmBtEngine patch accepts non-skype transports).
        audiodSend("palm://com.palm.audio/phone/CallStatusUpdate",
                   "{\"lines\":[{\"state\":\"active\",\"calls\":[{\"id\":\"1\",\"address\":\"telegram\",\"origin\":\"outgoing\",\"video\":false,\"transport\":\"com.palm.telegram\"}]}]}");
        audiodSend("palm://com.palm.audio/phone/setCurrentScenario", "{\"scenario\":\"phone_back_speaker\"}");
    } else {
        audiodSend("palm://com.palm.audio/phone/CallStatusUpdate", "{\"lines\":[]}");
    }
}
