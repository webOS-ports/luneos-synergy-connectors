// gateway.h — Discord MAIN gateway client (wss://gateway.discord.gg).
//
// Responsibility: log in with a BOT token, then join a guild voice channel and
// harvest the four values needed to bootstrap the voice websocket:
//   endpoint, voice-token, session_id, self user_id.
//
// Opcodes (main gateway, distinct from the voice gateway):
//   10 HELLO   -> heartbeat_interval        (we start op1 heartbeats)
//    2 IDENTIFY (->)                          token + intents + properties
//    1 HEARTBEAT (->)                         {seq}
//   11 HEARTBEAT_ACK (<-)
//    0 DISPATCH (<-)   READY / VOICE_SERVER_UPDATE / VOICE_STATE_UPDATE
//    4 VOICE_STATE_UPDATE (->)                {guild_id, channel_id, self_mute, self_deaf}
//
// Compile-verified. Live behaviour unverified (no token, no device). See STATUS.md.
#pragma once

#include "ws_client.h"
#include <string>
#include <cstdint>

namespace dv {

struct VoiceServerInfo {
    std::string endpoint;     // e.g. "us-east1234.discord.media:443" (port stripped -> 443)
    std::string token;        // voice connection token (NOT the bot token)
    std::string session_id;   // from our own VOICE_STATE_UPDATE
    std::string guild_id;
    std::string channel_id;
    std::string self_user_id; // from READY
    bool haveServer = false;  // got VOICE_SERVER_UPDATE
    bool haveState  = false;  // got our VOICE_STATE_UPDATE (session_id)
    bool complete() const { return haveServer && haveState && !self_user_id.empty(); }
};

class Gateway {
public:
    bool connect(std::string& err);
    bool identify(const std::string& botToken, std::string& err);
    // Send VOICE_STATE_UPDATE to request joining the channel.
    bool joinVoice(const std::string& guildId, const std::string& channelId, std::string& err);

    // Pump one poll cycle: handle HELLO/heartbeat/dispatch. Returns false on
    // disconnect. Fills/updates `vsi_` as VOICE_* events arrive.
    bool pump(int timeout_ms);

    const VoiceServerInfo& voice() const { return vsi_; }
    bool ready() const { return ready_; }
    void close() { ws_.close(); }

private:
    void onDispatch(const std::string& type, const void* dataJson);
    void maybeHeartbeat();

    WsClient ws_;
    VoiceServerInfo vsi_;
    bool ready_ = false;
    int  heartbeatIntervalMs_ = 0;
    uint64_t lastHeartbeat_ = 0;
    int64_t  lastSeq_ = -1;       // last dispatch sequence (s) for heartbeat + resume
    bool haveSeq_ = false;
};

} // namespace dv
