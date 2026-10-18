#include "call.h"
#include "client-utils.h"
#include "receiving.h"
#include "config.h"
#include "buildopt.h"
#include "format.h"
#include "purple-info.h"
#include "td-client.h"
#include "call-luna.h"
#include "voipkit-tgvoip.h"
#include <glib.h>
#include <array>

static td::td_api::object_ptr<td::td_api::callProtocol> getCallProtocol()
{
    auto protocol = td::td_api::make_object<td::td_api::callProtocol>();
    protocol->udp_p2p_       = true;
    protocol->udp_reflector_ = true;
    protocol->min_layer_     = 65;
    protocol->max_layer_     = 92;
    // library_versions_ deliberately left empty. Two things tried and REVERTED here, both worse
    // than empty:
    //  - Our vendored libtgvoip's own "2.5" string: peer's real client rejected the call outright
    //    as outdated ("please update Telegram") -- not a real libtgvoip release.
    //  - "2.7.7" (a real, confirmed-embedded-in-current-official-APK version string, the last
    //    public grishka/libtgvoip release): the call no longer gets rejected, but the peer never
    //    sends us a single PKT_INIT at all (confirmed via VoIPController.cpp's DIAG logging --
    //    zero "recv" lines for two full test calls, versus reliably receiving flags=0x0 PKT_INITs
    //    with this field empty). Declaring a real version apparently steers the peer's client onto
    //    a different call-setup path (likely newer tgcalls V2/WebRTC-style signaling) that this
    //    legacy VoIPController can't speak at all -- worse than the video-only gap empty leaves us
    //    with, since it silently breaks audio too (peer's own UI hangs on "Exchanging encryption
    //    keys" waiting for a media connection that never arrives). Left empty: audio negotiates
    //    reliably; video remains unavailable pending a real fix for this call-path steering.
    return protocol;
}

bool initiateCall(int64_t userId, bool video, TdAccountData &account, TdTransceiver &transceiver)
{
    // userId is tdlib's int53 (createCall.user_id_): Telegram user ids exceed INT32_MAX (e.g. Alan =
    // 8823012961), so this MUST be 64-bit - an int32_t param truncated large ids to a garbage user and
    // the call silently never started (no state pushed -> Phone app stuck on the video tab).
#ifndef NoVoip
    if (!account.hasActiveCall() && !account.isCallInitiating()) {
        account.beginCallInitiation();   // synchronous: block a 2nd dial arriving in the same tick
        td::td_api::object_ptr<td::td_api::createCall> callRequest = td::td_api::make_object<td::td_api::createCall>();
        callRequest->user_id_  = userId;
        callRequest->protocol_ = getCallProtocol();
        // acceptCall (the callee side) has no is_video_ field of its own -- video is decided here,
        // by whoever places the call, and the callee just inherits it via the returned call.is_video_
        // (see activateCall/updateCall, which read call.is_video_ directly).
        callRequest->is_video_ = video;
        transceiver.sendQuery(std::move(callRequest), nullptr);
        return true;   // call request sent; report success so the dial isn't logged as FAILED TO DIAL
    } else {
        // A call is already active or being initiated. This is the expected dedup of the dialer's
        // double-dial (it fires both the resolved "id<n>" and the raw phone number for one contact),
        // so drop the duplicate silently instead of popping "already in another call".
        tgcLog("initiateCall: dropping duplicate dial to user %lld (call already active/initiating)",
               (long long)userId);
        return false;
    }
#endif

    return false;
}

static void discardCall(int32_t callId, TdTransceiver &transceiver)
{
    td::td_api::object_ptr<td::td_api::discardCall> discardReq = td::td_api::make_object<td::td_api::discardCall>();
    discardReq->call_id_ = callId;
    discardReq->is_disconnected_ = true;
    discardReq->duration_ = 0;
    discardReq->connection_id_ = 0;
    transceiver.sendQuery(std::move(discardReq), nullptr);
}

struct CallRequestData {
    int            callId;
    TdTransceiver *transceiver;
    TdAccountData *account;
};

static void acceptCallCb(CallRequestData *data, int action)
{
    std::unique_ptr<CallRequestData> request(data);

    td::td_api::object_ptr<td::td_api::acceptCall> acceptReq = td::td_api::make_object<td::td_api::acceptCall>();
    acceptReq->call_id_ = request->callId;
    acceptReq->protocol_ = getCallProtocol();
    request->transceiver->sendQuery(std::move(acceptReq), nullptr);
}

static void discardCallCb(CallRequestData *data, int action)
{
    std::unique_ptr<CallRequestData> request(data);
    discardCall(request->callId, *request->transceiver);
    request->account->removeActiveCall();
}

static std::string getPurpleUserName(UserId userId, TdAccountData &account)
{
    const td::td_api::user *user = account.getUser(userId);
    if (user) {
        const td::td_api::chat *privateChat = account.getPrivateChatByUserId(userId);
        if (privateChat && isChatInContactList(*privateChat, user))
            return getPurpleBuddyName(*user);
        else
            return account.getDisplayName(*user);
    } else
        return std::string();
}

// Guards the SetVideoSource() retry timer below; file-scope so deactivateCall() can cancel it
// on hangup (a static local inside activateCall would be unreachable from there).
static guint g_videoSourceRetryId = 0;
// Drives CallEngine::tick() (DTLS retransmission timers) while a call is active; same
// file-scope-for-deactivateCall reasoning as g_videoSourceRetryId above.
static guint g_callEngineTickId = 0;

static bool activateCall(const td::td_api::call &call, const std::string &buddyName,
                         TdAccountData &account, TdTransceiver &transceiver)
{
#ifndef NoVoip
    if (call.state_->get_id() != td::td_api::callStateReady::ID)
        return false;
    const td::td_api::callStateReady &state = static_cast<const td::td_api::callStateReady &>(*call.state_);

    if (state.protocol_->max_layer_ < 74) {
        // libtgvoip crashes with openssl assertion failure if it goes into if(!useMTProto2) branch
        // of VoIPController::ProcessIncomingPacket
        // Unlikely error message not worth translating
        if (!buddyName.empty())
            showMessageTextIm(account, buddyName.c_str(), NULL,
                              "Discarding call due to low protocol layer",
                              time(NULL), PURPLE_MESSAGE_SYSTEM);

        return false;
    }

    tgvoip::VoIPController *voip = account.getCallData();
    if (!voip)
        return false;

    static tgvoip::VoIPController::Config config;
    // Two-way audio is confirmed (voice gets through the analog IN1L route), so re-enable libtgvoip's
    // in-engine WebRTC DSP -- it's already compiled in (Makefile.am builds webrtc_dsp with -DWEBRTC_NS_FLOAT).
    // NS suppresses the analog-mic background-noise floor (the webOS capture path applies no audiod DSP on
    // the voip source, unlike the recording path voice notes use); AGC normalizes the quiet/uneven level.
    // AEC ON: the TouchPad has no earpiece so calls run on the loudspeaker and the mic re-captures the
    // far-end (the peer hears themselves). libtgvoip's AEC3 owns BOTH the render and capture streams
    // inside the VoIPController, so it gets the speaker reference natively (no manual wiring/delay hint,
    // unlike the WhatsApp AECM path). NS suppresses the analog-mic noise floor (safe here: Opus is a
    // waveform codec, so NS helps it, unlike WhatsApp's parametric MLow); AGC normalizes the level.
    config.enableAEC = true;
    config.enableNS  = true;
    config.enableAGC = true;
    // Native SkypeKit/clonk video bridge (WHATSAPP_VIDEO_STATUS.md) -- see the
    // VoipKitVideoSource/VoipKitVideoRenderer wiring below, right after SetConfig.
    config.enableVideoSend    = call.is_video_;
    config.enableVideoReceive = call.is_video_;
    // DIAG: libtgvoip writes NOTHING to the system log, so an unestablished media path (peer stuck on
    // "Connecting") is invisible. Point it at a file to see the reflector connection + audio init.
    config.logFilePath       = "/media/internal/tgvoip.log";
    config.statsDumpFilePath = "/media/internal/tgvoip-stats.log";
    voip->SetConfig(config);

    // Video: open the clonk session BEFORE attaching source/renderer -- callLunaOpenClonk()
    // drives videoCaptureStart -> voipkit_video_start() -> videoPlayerStart synchronously
    // enough (fire-and-forget over LS2, but the ordering within it is what matters -- see
    // skypekit.h) that by the time real frames need to flow, both sockets are ready.
    // Static: only one call is ever active at a time (same assumption as the rest of this
    // file); the objects are cheap and simply reused/reattached across calls.
    static VoipKitVideoSource *videoSource = nullptr;
    static VoipKitVideoRenderer *videoRenderer = nullptr;
    if (g_videoSourceRetryId) {
        g_source_remove(g_videoSourceRetryId);
        g_videoSourceRetryId = 0;
    }
    if (call.is_video_) {
        callLunaOpenClonk();
        if (!videoSource) videoSource = new VoipKitVideoSource(callLunaRequestKeyframe);
        if (!videoRenderer) videoRenderer = new VoipKitVideoRenderer();
        voip->SetVideoRenderer(videoRenderer);
        // VoIPController::SetVideoSource() requires its own outgoing video Stream object to
        // already exist, but that object is only created reactively -- deep inside
        // VoIPController's packet thread, when the peer's first PKT_INIT arrives over the
        // just-established UDP media channel (VoIPController.cpp's PKT_INIT handler calling
        // SetupOutgoingVideoStream()). Calling it here, synchronously right after SetConfig(),
        // is always too early (no UDP round-trip has happened yet) and always logged "Can't set
        // video source when there is no outgoing video stream" while silently leaving the camera
        // never attached. SetVideoSource() is cheap/idempotent to call repeatedly, so retry on a
        // short timer (bounded) until libtgvoip has had time to complete that exchange.
        voip->SetVideoSource(videoSource); // first attempt, expected to still be too early
        struct RetryCtx { tgvoip::VoIPController *voip; int triesLeft; };
        auto *ctx = new RetryCtx{voip, 10}; // ~3s at 300ms, bounded so a dead call can't retry forever
        g_videoSourceRetryId = g_timeout_add_full(G_PRIORITY_DEFAULT, 300,
            +[](gpointer data) -> gboolean {
                auto *c = static_cast<RetryCtx *>(data);
                c->voip->SetVideoSource(videoSource);
                if (--c->triesLeft <= 0) {
                    g_videoSourceRetryId = 0;
                    return G_SOURCE_REMOVE;
                }
                return G_SOURCE_CONTINUE;
            }, ctx,
            +[](gpointer data) { delete static_cast<RetryCtx *>(data); });
    }

    std::vector<tgvoip::Endpoint> endpoints;
    for (const auto &pServer: state.servers_)
        if (pServer && pServer->type_ && (pServer->type_->get_id() == td::td_api::callServerTypeTelegramReflector::ID)) {
            const td::td_api::callServerTypeTelegramReflector &reflectorInfo =
                static_cast<const td::td_api::callServerTypeTelegramReflector &>(*pServer->type_);
            std::vector<unsigned char> tag(16);
            memmove(tag.data(), reflectorInfo.peer_tag_.c_str(), std::min(reflectorInfo.peer_tag_.length(), tag.size()));
            endpoints.push_back(tgvoip::Endpoint(pServer->id_, pServer->port_,
                                                tgvoip::IPv4Address(pServer->ip_address_),
                                                tgvoip::IPv6Address(pServer->ipv6_address_),
                                                tgvoip::Endpoint::UDP_RELAY,
                                                tag.data()));
        }
    voip->SetRemoteEndpoints(endpoints, state.allow_p2p_ && state.protocol_->udp_p2p_,
                             state.protocol_->max_layer_);

    std::vector<char> key(state.encryption_key_.length()+1);
    memmove(key.data(), state.encryption_key_.c_str(), key.size());
    voip->SetEncryptionKey(key.data(), call.is_outgoing_);
    tgcLog("activateCall: endpoints=%zu p2p=%d max_layer=%d key_len=%zu outgoing=%d",
           endpoints.size(), (int)(state.allow_p2p_ && state.protocol_->udp_p2p_),
           (int)state.protocol_->max_layer_, state.encryption_key_.length(), (int)call.is_outgoing_);
    voip->Start();
    voip->Connect();
    callLunaSetCallAudio(true);   // enable audiod phone scenario -> voip/voipsource carry real audio

#ifndef NoTgcallsLite
    // tgcalls-lite: built and proven end-to-end (signaling codec + AES framing + ICE + DTLS-SRTP +
    // RTP, see plugin/tgcalls-lite/spike/call_engine_e2e_smoke.cpp) but NOT YET the active call
    // path -- getCallProtocol() above still deliberately leaves library_versions_ empty, so real
    // peers never negotiate onto V2 signaling and TDLib will never actually fire
    // updateNewCallSignalingData for a real call. Created here anyway so the real production
    // call path exercises construction/wiring now, ahead of the actual switch-over (which also
    // needs: NegotiateChannelsMessage codec negotiation, and routing real Opus/H.264 RTP through
    // this engine instead of libtgvoip/skypekit's current paths -- see call_engine.h/.cpp).
    {
        // EncryptedConnection::EncryptedConnection reads 256 bytes unconditionally -- don't hand it
        // `key` above (sized to state.encryption_key_.length()+1, not guaranteed to be 256): build
        // an explicitly-sized, zero-padded 256-byte buffer instead so a shorter-than-expected key
        // (shouldn't happen per Telegram's call encryption spec, but cheap to guard) can't read
        // past this buffer's end.
        std::array<uint8_t, 256> tgcallsKey{};
        memcpy(tgcallsKey.data(), state.encryption_key_.data(),
               std::min(state.encryption_key_.size(), tgcallsKey.size()));
        auto callEngine = std::make_unique<tgcalls_lite::CallEngine>(
            g_main_context_default(), tgcallsKey.data(), call.is_outgoing_, call.is_video_);
        TdTransceiver *transceiverPtr = &transceiver;
        int32_t callIdForSignaling = call.id_;
        callEngine->onOutgoingSignalingData = [transceiverPtr, callIdForSignaling](const std::vector<uint8_t> &data) {
            auto req = td::td_api::make_object<td::td_api::sendCallSignalingData>();
            req->call_id_ = callIdForSignaling;
            req->data_.assign(data.begin(), data.end());
            transceiverPtr->sendQuery(std::move(req), nullptr);
        };
        callEngine->onMediaReady = []() {
            tgcLog("tgcalls-lite: CallEngine media session reached Ready (infrastructure only -- not yet carrying real audio/video)");
        };
        callEngine->start();
        account.setCallEngine(std::move(callEngine));

        if (g_callEngineTickId) g_source_remove(g_callEngineTickId);
        TdAccountData *accountPtr = &account;
        g_callEngineTickId = g_timeout_add(500, +[](gpointer data) -> gboolean {
            auto *acc = static_cast<TdAccountData *>(data);
            if (auto *engine = acc->getCallEngine()) engine->tick();
            return G_SOURCE_CONTINUE;
        }, accountPtr);
    }
#endif

    if (!buddyName.empty()) {
        // For an outgoing call, "type /hangup to terminate" has already been shown when the call
        // was initiated
        // TRANSLATOR: In-chat status message
        const char *message = call.is_outgoing_ ? _("Call active") :
                                                  // TRANSLATOR: In-chat status message. Please keep '/hangup' verbatim!
                                                  _("Call active, type /hangup to terminate");
        showMessageTextIm(account, buddyName.c_str(), NULL, message,
                          time(NULL), PURPLE_MESSAGE_SYSTEM);
    }

#endif
    return true;
}

static void deactivateCall(TdAccountData &account)
{
#ifndef NoVoip
    if (g_videoSourceRetryId) {
        g_source_remove(g_videoSourceRetryId);
        g_videoSourceRetryId = 0;
    }
    callLunaSetCallAudio(false);   // clear audiod phone scenario on hangup
    callLunaCloseClonk();          // no-op if video was never active (checks internally)
    tgvoip::VoIPController *voip = account.getCallData();
    if (voip)
        voip->Stop();
#endif
#ifndef NoTgcallsLite
    if (g_callEngineTickId) {
        g_source_remove(g_callEngineTickId);
        g_callEngineTickId = 0;
    }
    // account.removeActiveCall() (called by updateCall's disconnected/hangingUp handling) resets
    // account's own m_callEngine; nothing else to tear down here explicitly.
#endif
}

void updateCallSignalingData(int32_t callId, const std::string &data, TdAccountData &account)
{
#ifndef NoTgcallsLite
    if (callId != account.getActiveCallId()) {
        tgcLog("updateCallSignalingData: ignoring signaling data for call %d, active call is %d",
               callId, account.getActiveCallId());
        return;
    }
    tgcalls_lite::CallEngine *engine = account.getCallEngine();
    if (!engine) return; // not yet using tgcalls-lite for this call (or it's the fallback libtgvoip path)
    std::vector<uint8_t> bytes(data.begin(), data.end());
    engine->handleIncomingSignalingData(bytes);
#endif
}

static void notifyCallError(const td::td_api::callStateError &error, const std::string &buddyName,
                            TdAccountData &account)
{
    std::string message;
    if (error.error_)
        message = formatMessage(errorCodeMessage(), {std::to_string(error.error_->code_),
                                error.error_->message_});
    else
        // Unlikely message not worth translating
        message = "unknown error";
    // TRANSLATOR: In-chat error message, argument is text
    message = formatMessage(_("Call failed: {}"), message);
    if (!buddyName.empty())
        showMessageTextIm(account, buddyName.c_str(), NULL, message.c_str(),
                          time(NULL), PURPLE_MESSAGE_SYSTEM);
}

void updateCall(const td::td_api::call &call, TdAccountData &account, TdTransceiver &transceiver)
{
    std::string buddyName = getPurpleUserName(getUserId(call), account);
    // For an OUTGOING call, report the card under the exact address the dialer dialed (it keyed its
    // card to that string). A phone-number dial gets resolved to this user's "id<n>", so pushing under
    // buddyName would split from the dialer's "+E.164" card and leave a phantom "Connecting" one.
    const std::string &dialedAddr = account.getCallDialedAddress();
    std::string peerAddr = (call.is_outgoing_ && !dialedAddr.empty()) ? dialedAddr : buddyName;

#ifndef NoVoip
    // webOS (Path C): the call UI + audio is the stock Phone app via com.palm.telegram.call (see
    // call-luna.cpp), NOT PurpleMedia - so do not gate on the frontend's media caps; always accept
    // and drive the call over LS2. (libtgvoip does the media directly.)
    if (false) {
#else
    if (true) {
#endif
        purple_debug_misc(config::pluginId, "Ignoring incoming call: no audio capability\n");
        if (call.state_ && (call.state_->get_id() == td::td_api::callStatePending::ID)) {
            if (!buddyName.empty())
                showMessageTextIm(account, buddyName.c_str(), NULL,
                                  // TRANSLATOR: In-chat error message
                                  _("Received incoming call, but calls are not supported"),
                                  time(NULL), PURPLE_MESSAGE_SYSTEM);

            discardCall(call.id_, transceiver);
        }
        return;
    }

    if (!call.state_) return; // just in case

    if (!call.is_outgoing_ && (call.state_->get_id() == td::td_api::callStatePending::ID)) {
        if (!account.hasActiveCall()) {
            account.setActiveCall(call.id_);
            // webOS: ring the stock Phone app instead of a pidgin accept/reject dialog. The user
            // answers via com.palm.telegram.call/answer -> callBridgeAnswer -> acceptCurrentCall.
            callLunaPushState("incoming", buddyName.c_str(),
                              account.getDisplayName(getUserId(call)).c_str(), false, NULL,
                              call.is_video_);
        } else if (call.id_ != account.getActiveCallId()) {
            if (!buddyName.empty())
                showMessageTextIm(account, buddyName.c_str(), NULL,
                                // TRANSLATOR: In-chat error message
                                _("Received incoming call while already in another call"),
                                time(NULL), PURPLE_MESSAGE_SYSTEM);

            discardCall(call.id_, transceiver);
        }
    } else if (call.is_outgoing_ && (call.state_->get_id() == td::td_api::callStatePending::ID)) {
        if (!account.hasActiveCall()) {
            account.setActiveCall(call.id_);
            // The stock Phone app's CallSynergizer keys the "dialing/ringback" UI off the line
            // state string STATES.DIALING == "dialing" (not "outgoing"); send that so the call
            // card shows "Connecting..." while the outgoing call is pending, same as WhatsApp.
            callLunaPushState("dialing", peerAddr.c_str(),
                              account.getDisplayName(getUserId(call)).c_str(), true, NULL,
                              call.is_video_);
        } else if (call.id_ != account.getActiveCallId()) {
            // This would happen if there was no active call when sending createCall, but there is one
            // a millisecond later when asynchronous response is received. Possible if two calls are
            // started at the same time, or one is started an another received at the same time.
            discardCall(call.id_, transceiver);
        }
    } else if (call.state_->get_id() == td::td_api::callStateReady::ID) {
        if (! activateCall(call, buddyName, account, transceiver)) {
            discardCall(call.id_, transceiver);
            account.removeActiveCall();
        } else {
            callLunaPushState("active", peerAddr.c_str(),
                              account.getDisplayName(getUserId(call)).c_str(), call.is_outgoing_, NULL,
                              call.is_video_);
        }
    }
    else if ( ((call.state_->get_id() == td::td_api::callStateHangingUp::ID) ||
               (call.state_->get_id() == td::td_api::callStateDiscarded::ID) ||
               (call.state_->get_id() == td::td_api::callStateError::ID)) &&
              account.hasActiveCall() && account.getActiveCallId() == call.id_)
    {
        const char *cause = "normal";
        if (call.state_->get_id() == td::td_api::callStateDiscarded::ID) {
            const td::td_api::callStateDiscarded &d = static_cast<const td::td_api::callStateDiscarded &>(*call.state_);
            if (d.reason_) {
                if (d.reason_->get_id() == td::td_api::callDiscardReasonDeclined::ID) cause = "rejected";
                else if (d.reason_->get_id() == td::td_api::callDiscardReasonMissed::ID) cause = "missed";
            }
        } else if (call.state_->get_id() == td::td_api::callStateError::ID) {
            cause = "error";
        }
        callLunaPushState("disconnected", peerAddr.c_str(),
                          account.getDisplayName(getUserId(call)).c_str(), call.is_outgoing_, cause,
                          call.is_video_);
        if (call.state_->get_id() == td::td_api::callStateError::ID) {
            const td::td_api::callStateError &error = static_cast<const td::td_api::callStateError &>(*call.state_);
            notifyCallError(error, buddyName, account);
        }
        deactivateCall(account);
        account.removeActiveCall();
    }
}

void discardCurrentCall(TdAccountData &account, TdTransceiver &transceiver)
{
    if (account.hasActiveCall())
        discardCall(account.getActiveCallId(), transceiver);
}

void acceptCurrentCall(TdAccountData &account, TdTransceiver &transceiver)
{
    if (!account.hasActiveCall()) return;
    td::td_api::object_ptr<td::td_api::acceptCall> acceptReq = td::td_api::make_object<td::td_api::acceptCall>();
    acceptReq->call_id_ = account.getActiveCallId();
    acceptReq->protocol_ = getCallProtocol();
    transceiver.sendQuery(std::move(acceptReq), nullptr);
}

// ---- LS2 <-> TDLib bridge: called by call-luna.cpp for the com.palm.telegram.call service ----
bool callBridgeDial(PurpleAccount *account, const char *who, bool video)
{
    PurpleTdClient *client = getTdClient(account);
    return (client && who) ? client->startVoiceCall(who, video) : false;
}

void callBridgeAnswer(PurpleAccount *account)
{
    PurpleTdClient *client = getTdClient(account);
    if (client) client->acceptCurrentCall();
}

void callBridgeHangup(PurpleAccount *account)
{
    PurpleTdClient *client = getTdClient(account);
    if (client) client->hangupVoiceCall();
}

void showCallMessage(const td::td_api::chat &chat, const TgMessageInfo &message,
                     const td::td_api::messageCall &callEnded, TdAccountData &account)
{
    std::string notification;
    if (callEnded.discard_reason_)
        switch (callEnded.discard_reason_->get_id()) {
            case td::td_api::callDiscardReasonMissed::ID:
                // TRANSLATOR: In-line reason for an ended call; appears after a colon (':')
                notification = _("call missed");
                break;
            case td::td_api::callDiscardReasonDeclined::ID:
                // TRANSLATOR: In-line reason for an ended call; appears after a colon (':')
                notification = _("declined by peer");
                break;
            case td::td_api::callDiscardReasonDisconnected::ID:
                // TRANSLATOR: In-line reason for an ended call; appears after a colon (':')
                notification = _("users disconnected");
                break;
            case td::td_api::callDiscardReasonHungUp::ID:
                // TRANSLATOR: In-line reason for an ended call; appears after a colon (':')
                notification = _("hung up");
                break;
        }
    if (notification.empty()) {
        // TRANSLATOR: In-line reason for an ended call; appears after a colon (':')
        notification = _("reason unknown");
    }

    // TRANSLATOR: In-chat message, arguments will be a duration and a few words (like "hung up")
    notification = formatMessage(_("Call ended ({0}): {1}"), {formatDuration(callEnded.duration_), notification});
    showMessageText(account, chat, message, NULL, notification.c_str());
}
