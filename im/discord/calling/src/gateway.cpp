#include "gateway.h"
#include "common.h"

#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace dv {

// Gateway intents: GUILDS (1<<0) | GUILD_VOICE_STATES (1<<7). Enough to receive the
// READY, our own VOICE_STATE_UPDATE, and VOICE_SERVER_UPDATE for a voice join.
static const int kIntents = (1 << 0) | (1 << 7);

bool Gateway::connect(std::string& err) {
    // v10 JSON, no compression (keeps us off zlib — one less cross-dep).
    return ws_.connect("gateway.discord.gg", 443, "/?v=10&encoding=json", err);
}

bool Gateway::identify(const std::string& botToken, std::string& err) {
    json id = {
        {"op", 2},
        {"d", {
            {"token", botToken},
            {"intents", kIntents},
            {"properties", {
                {"os", "webos"},
                {"browser", "dvoice"},
                {"device", "touchpad"}
            }}
        }}
    };
    if (!ws_.sendText(id.dump())) { err = "IDENTIFY send failed"; return false; }
    DV_INFO("gateway: IDENTIFY sent (intents=%d)", kIntents);
    return true;
}

bool Gateway::joinVoice(const std::string& guildId, const std::string& channelId, std::string& err) {
    vsi_.guild_id = guildId;
    vsi_.channel_id = channelId;
    json v = {
        {"op", 4},
        {"d", {
            {"guild_id", guildId},
            {"channel_id", channelId},
            {"self_mute", false},
            {"self_deaf", false}
        }}
    };
    if (!ws_.sendText(v.dump())) { err = "VOICE_STATE_UPDATE send failed"; return false; }
    DV_INFO("gateway: VOICE_STATE_UPDATE guild=%s channel=%s", guildId.c_str(), channelId.c_str());
    return true;
}

void Gateway::maybeHeartbeat() {
    if (heartbeatIntervalMs_ <= 0) return;
    uint64_t t = now_ms();
    if (t - lastHeartbeat_ >= (uint64_t)heartbeatIntervalMs_) {
        json hb = { {"op", 1}, {"d", haveSeq_ ? json(lastSeq_) : json(nullptr)} };
        ws_.sendText(hb.dump());
        lastHeartbeat_ = t;
    }
}

void Gateway::onDispatch(const std::string& type, const void* dataJson) {
    const json& d = *reinterpret_cast<const json*>(dataJson);
    if (type == "READY") {
        if (d.contains("user") && d["user"].contains("id"))
            vsi_.self_user_id = d["user"]["id"].get<std::string>();
        ready_ = true;
        DV_INFO("gateway: READY user_id=%s", vsi_.self_user_id.c_str());
    } else if (type == "VOICE_SERVER_UPDATE") {
        if (d.contains("token"))    vsi_.token = d["token"].get<std::string>();
        if (d.contains("endpoint") && !d["endpoint"].is_null())
            vsi_.endpoint = d["endpoint"].get<std::string>();
        if (d.contains("guild_id")) vsi_.guild_id = d["guild_id"].get<std::string>();
        vsi_.haveServer = true;
        DV_INFO("gateway: VOICE_SERVER_UPDATE endpoint=%s", vsi_.endpoint.c_str());
    } else if (type == "VOICE_STATE_UPDATE") {
        // Only OUR state carries the session_id we need.
        if (d.contains("user_id") && d["user_id"].get<std::string>() == vsi_.self_user_id) {
            if (d.contains("session_id")) vsi_.session_id = d["session_id"].get<std::string>();
            vsi_.haveState = true;
            DV_INFO("gateway: VOICE_STATE_UPDATE session_id=%s", vsi_.session_id.c_str());
        }
    }
}

bool Gateway::pump(int timeout_ms) {
    maybeHeartbeat();
    std::vector<uint8_t> msg;
    bool binary = false;
    int r = ws_.poll(timeout_ms, msg, binary);
    if (r < 0) { DV_WARN("gateway: connection closed"); return false; }
    if (r == 0) return true;
    if (binary) return true;   // main gateway v10/json => no binary frames expected

    json j;
    try { j = json::parse(msg); }
    catch (const std::exception& e) { DV_WARN("gateway: bad JSON: %s", e.what()); return true; }

    int op = j.value("op", -1);
    if (j.contains("s") && !j["s"].is_null()) { lastSeq_ = j["s"].get<int64_t>(); haveSeq_ = true; }

    switch (op) {
        case 10: { // HELLO
            heartbeatIntervalMs_ = j["d"].value("heartbeat_interval", 41250);
            lastHeartbeat_ = now_ms();
            DV_INFO("gateway: HELLO heartbeat_interval=%dms", heartbeatIntervalMs_);
            break;
        }
        case 11: /* HEARTBEAT_ACK */ break;
        case 1:  { json hb = {{"op",1},{"d", haveSeq_?json(lastSeq_):json(nullptr)}}; ws_.sendText(hb.dump()); break; }
        case 7:  DV_WARN("gateway: RECONNECT requested (op7)"); return false;
        case 9:  DV_WARN("gateway: INVALID_SESSION (op9)"); return false;
        case 0: {
            std::string t = j.value("t", "");
            if (j.contains("d")) onDispatch(t, &j["d"]);
            break;
        }
        default: break;
    }
    return true;
}

} // namespace dv
