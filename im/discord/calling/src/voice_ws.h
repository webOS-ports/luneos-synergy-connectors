// voice_ws.h — Discord VOICE gateway client (wss://{endpoint}?v=8).
//
// Owns the voice websocket, the UDP transport, and the DAVE session, and runs the
// whole voice handshake + DAVE MLS interleave on one poll loop:
//
//   <- op8  HELLO(heartbeat_interval)      -> op3 heartbeats
//   -> op0  IDENTIFY(server_id,user_id,session_id,token, max_dave_protocol_version=1)
//   <- op2  READY(ssrc, ip, port, modes)   -> UDP IP discovery
//   -> op1  SELECT_PROTOCOL(our ip/port, mode=aead_aes256_gcm_rtpsize)
//   <- op4  SESSION_DESCRIPTION(secret_key) -> transport key installed
//   <- op21..30 DAVE MLS interleave        -> libdave (dave_glue)
//
// After the transport key is set, main can push/pull Opus via sendOpus/recvOpus,
// which route through DAVE (once the epoch is live) then the transport AEAD.
//
// DAVE binary framing assumption (needs live verification, see STATUS.md): MLS blob
// opcodes (25/26/27/28/29/30) travel as BINARY ws frames of [uint16 BE seq][uint8
// opcode][payload]; the transition opcodes (21/22/24) travel as JSON text frames.
#pragma once

#include "ws_client.h"
#include "udp_transport.h"
#include "dave_glue.h"
#include <string>
#include <cstdint>

namespace dv {

class VoiceWs {
public:
    bool connect(const std::string& endpoint, std::string& err);   // "host:port" or "host"
    bool identify(const std::string& serverId, const std::string& userId,
                  const std::string& sessionId, const std::string& token, std::string& err);

    bool pump(int timeout_ms);                 // returns false on disconnect

    bool transportReady() const { return transportReady_; }
    bool daveReady() const { return dave_.epochReady(); }
    uint32_t ssrc() const { return ssrc_; }

    // Media path. sendOpus wraps in DAVE (or passthrough) then transport-encrypts.
    bool sendOpus(const uint8_t* opus, size_t len);
    // recvOpus: returns 1 with a decoded-ready Opus payload, 0 none, -1 error.
    int  recvOpus(int timeout_ms, Bytes& opusOut);

    void speaking(bool on);
    void close() { ws_.close(); }

private:
    void onJson(const std::vector<uint8_t>& msg);
    void onDaveBinary(const std::vector<uint8_t>& msg);
    void doIpDiscoveryAndSelect();
    void maybeHeartbeat();
    bool sendDaveBinary(uint8_t opcode, const uint8_t* data, size_t len);

    WsClient    ws_;
    UdpTransport udp_;
    DaveSession dave_;

    std::string serverId_, userId_, sessionId_, token_;
    uint32_t    ssrc_ = 0;
    std::string udpServerIp_;
    uint16_t    udpServerPort_ = 0;
    std::string mode_ = "aead_aes256_gcm_rtpsize";
    bool transportReady_ = false;
    bool identified_ = false;

    int      heartbeatIntervalMs_ = 0;
    uint64_t lastHeartbeat_ = 0;
    uint64_t heartbeatNonce_ = 0;
    uint16_t daveSeq_ = 0;
};

} // namespace dv
