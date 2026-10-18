#include "voice_ws.h"
#include "common.h"

#include <nlohmann/json.hpp>
#include <cstdlib>

using json = nlohmann::json;

namespace dv {

// Voice gateway opcodes.
enum {
    OP_IDENTIFY = 0, OP_SELECT_PROTOCOL = 1, OP_READY = 2, OP_HEARTBEAT = 3,
    OP_SESSION_DESCRIPTION = 4, OP_SPEAKING = 5, OP_HEARTBEAT_ACK = 6,
    OP_HELLO = 8, OP_RESUMED = 9, OP_CLIENT_DISCONNECT = 13,
    OP_DAVE_PREPARE_TRANSITION = 21, OP_DAVE_EXECUTE_TRANSITION = 22,
    OP_DAVE_TRANSITION_READY = 23, OP_DAVE_PREPARE_EPOCH = 24,
    OP_DAVE_MLS_EXTERNAL_SENDER = 25, OP_DAVE_MLS_KEY_PACKAGE = 26,
    OP_DAVE_MLS_PROPOSALS = 27, OP_DAVE_MLS_COMMIT_WELCOME = 28,
    OP_DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION = 29, OP_DAVE_MLS_WELCOME = 30
};

bool VoiceWs::connect(const std::string& endpoint, std::string& err) {
    // endpoint is like "us-east1234.discord.media" or "...:443". Strip any port.
    std::string host = endpoint;
    int port = 443;
    auto colon = host.rfind(':');
    if (colon != std::string::npos) {
        port = atoi(host.c_str() + colon + 1);
        host = host.substr(0, colon);
        if (port == 0) port = 443;
    }
    return ws_.connect(host, port, "/?v=8", err);
}

bool VoiceWs::identify(const std::string& serverId, const std::string& userId,
                       const std::string& sessionId, const std::string& token, std::string& err) {
    serverId_ = serverId; userId_ = userId; sessionId_ = sessionId; token_ = token;
    json id = {
        {"op", OP_IDENTIFY},
        {"d", {
            {"server_id", serverId},
            {"user_id", userId},
            {"session_id", sessionId},
            {"token", token},
            {"max_dave_protocol_version", 1}   // MANDATORY: advertise DAVE v1
        }}
    };
    if (!ws_.sendText(id.dump())) { err = "voice IDENTIFY send failed"; return false; }
    identified_ = true;
    DV_INFO("voicews: IDENTIFY sent server=%s user=%s", serverId.c_str(), userId.c_str());
    return true;
}

void VoiceWs::maybeHeartbeat() {
    if (heartbeatIntervalMs_ <= 0) return;
    uint64_t t = now_ms();
    if (t - lastHeartbeat_ >= (uint64_t)heartbeatIntervalMs_) {
        json hb = { {"op", OP_HEARTBEAT}, {"d", (int64_t)(++heartbeatNonce_)} };
        ws_.sendText(hb.dump());
        lastHeartbeat_ = t;
    }
}

void VoiceWs::doIpDiscoveryAndSelect() {
    std::string pubIp, err; uint16_t pubPort = 0;
    if (!udp_.open(udpServerIp_, udpServerPort_, ssrc_, err)) { DV_ERR("voicews: udp open: %s", err.c_str()); return; }
    if (!udp_.discover(pubIp, pubPort, err)) { DV_ERR("voicews: ip discovery: %s", err.c_str()); return; }
    json sp = {
        {"op", OP_SELECT_PROTOCOL},
        {"d", {
            {"protocol", "udp"},
            {"data", {
                {"address", pubIp},
                {"port", pubPort},
                {"mode", mode_}
            }}
        }}
    };
    ws_.sendText(sp.dump());
    DV_INFO("voicews: SELECT_PROTOCOL %s:%u mode=%s", pubIp.c_str(), pubPort, mode_.c_str());
    // Initialise the DAVE session now (groupId = channel/server id). Passthrough until epoch.
    dave_.init(1, serverId_, userId_, ssrc_);
}

bool VoiceWs::sendDaveBinary(uint8_t opcode, const uint8_t* data, size_t len) {
    // [uint16 BE seq][uint8 opcode][payload]
    Bytes f;
    f.push_back((daveSeq_ >> 8) & 0xff);
    f.push_back(daveSeq_ & 0xff);
    f.push_back(opcode);
    f.insert(f.end(), data, data + len);
    daveSeq_++;
    return ws_.sendBinary(f.data(), f.size());
}

void VoiceWs::onDaveBinary(const std::vector<uint8_t>& msg) {
    if (msg.size() < 3) return;
    uint8_t opcode = msg[2];
    const uint8_t* payload = msg.data() + 3;
    size_t plen = msg.size() - 3;
    switch (opcode) {
        case OP_DAVE_MLS_EXTERNAL_SENDER: {
            dave_.onExternalSender(payload, plen);
            Bytes kp;
            if (dave_.getKeyPackage(kp)) sendDaveBinary(OP_DAVE_MLS_KEY_PACKAGE, kp.data(), kp.size());
            break;
        }
        case OP_DAVE_MLS_PROPOSALS: {
            Bytes cw;
            std::vector<std::string> ids = { userId_ };  // recognise at least ourselves
            if (dave_.onProposals(payload, plen, ids, cw))
                sendDaveBinary(OP_DAVE_MLS_COMMIT_WELCOME, cw.data(), cw.size());
            break;
        }
        case OP_DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION:
            dave_.onCommit(payload, plen);
            break;
        case OP_DAVE_MLS_WELCOME: {
            std::vector<std::string> ids = { userId_ };
            dave_.onWelcome(payload, plen, ids);
            break;
        }
        default:
            DV_WARN("voicews: unexpected DAVE binary opcode %u (%zuB)", opcode, plen);
            break;
    }
}

void VoiceWs::onJson(const std::vector<uint8_t>& msg) {
    json j;
    try { j = json::parse(msg); }
    catch (const std::exception& e) { DV_WARN("voicews: bad JSON: %s", e.what()); return; }
    int op = j.value("op", -1);
    const json d = j.contains("d") ? j["d"] : json();

    switch (op) {
        case OP_HELLO:
            heartbeatIntervalMs_ = (int)d.value("heartbeat_interval", 13750.0);
            lastHeartbeat_ = now_ms();
            DV_INFO("voicews: HELLO heartbeat=%dms", heartbeatIntervalMs_);
            break;
        case OP_READY: {
            ssrc_ = d.value("ssrc", 0u);
            udpServerIp_ = d.value("ip", "");
            udpServerPort_ = (uint16_t)d.value("port", 0);
            // Choose our preferred mode if the server offers it.
            if (d.contains("modes") && d["modes"].is_array()) {
                bool has = false;
                for (auto& m : d["modes"]) if (m.get<std::string>() == mode_) has = true;
                if (!has && !d["modes"].empty()) {
                    mode_ = d["modes"].back().get<std::string>();
                    DV_WARN("voicews: preferred mode unavailable, falling back to %s", mode_.c_str());
                }
            }
            DV_INFO("voicews: READY ssrc=%u udp=%s:%u", ssrc_, udpServerIp_.c_str(), udpServerPort_);
            doIpDiscoveryAndSelect();
            break;
        }
        case OP_SESSION_DESCRIPTION: {
            mode_ = d.value("mode", mode_);
            if (d.contains("secret_key") && d["secret_key"].is_array()) {
                Bytes key;
                for (auto& b : d["secret_key"]) key.push_back((uint8_t)b.get<int>());
                if (udp_.setSecretKey(key.data(), key.size(), mode_)) transportReady_ = true;
            }
            DV_INFO("voicews: SESSION_DESCRIPTION mode=%s transportReady=%d", mode_.c_str(), (int)transportReady_);
            break;
        }
        case OP_HEARTBEAT_ACK: break;
        case OP_SPEAKING: break;
        case OP_CLIENT_DISCONNECT: DV_INFO("voicews: a client disconnected"); break;
        case OP_DAVE_PREPARE_EPOCH:
            DV_INFO("voicews: op24 PREPARE_EPOCH (version=%d, epoch=%d)",
                    d.value("protocol_version", 0), d.value("epoch", 0));
            break;
        case OP_DAVE_PREPARE_TRANSITION:
            DV_INFO("voicews: op21 PREPARE_TRANSITION transition_id=%d", d.value("transition_id", 0));
            // Ack readiness for the transition.
            { json r = {{"op", OP_DAVE_TRANSITION_READY}, {"d", {{"transition_id", d.value("transition_id", 0)}}}};
              ws_.sendText(r.dump()); }
            break;
        case OP_DAVE_EXECUTE_TRANSITION:
            DV_INFO("voicews: op22 EXECUTE_TRANSITION -> activating DAVE epoch");
            dave_.activateEpoch();
            break;
        default:
            DV_WARN("voicews: unhandled JSON op %d", op);
            break;
    }
}

bool VoiceWs::pump(int timeout_ms) {
    maybeHeartbeat();
    std::vector<uint8_t> msg; bool binary = false;
    int r = ws_.poll(timeout_ms, msg, binary);
    if (r < 0) { DV_WARN("voicews: connection closed"); return false; }
    if (r == 0) return true;
    if (binary) onDaveBinary(msg);
    else        onJson(msg);
    return true;
}

void VoiceWs::speaking(bool on) {
    json s = { {"op", OP_SPEAKING}, {"d", {{"speaking", on ? 1 : 0}, {"delay", 0}, {"ssrc", ssrc_}}} };
    ws_.sendText(s.dump());
}

bool VoiceWs::sendOpus(const uint8_t* opus, size_t len) {
    if (!transportReady_) return false;
    Bytes framed;
    // DAVE-wrap when the epoch is live; otherwise pass the raw Opus through (the
    // encryptor is in passthrough mode pre-epoch and returns the frame unchanged).
    if (!dave_.wrapFrame(opus, len, framed)) framed.assign(opus, opus + len);
    return udp_.sendAudio(framed.data(), framed.size());
}

int VoiceWs::recvOpus(int timeout_ms, Bytes& opusOut) {
    Bytes payload; uint32_t sender = 0;
    int r = udp_.recvAudio(timeout_ms, payload, sender);
    if (r <= 0) return r;
    // Unwrap DAVE if the epoch is live; else the payload is already raw Opus.
    if (dave_.epochReady()) {
        if (!dave_.unwrapFrame(payload.data(), payload.size(), opusOut)) return 0;
    } else {
        opusOut.swap(payload);
    }
    return 1;
}

} // namespace dv
