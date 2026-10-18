// ws_client.h — minimal RFC 6455 WebSocket client over TLS (OpenSSL).
//
// Purpose-built for the Discord gateways; NOT a general-purpose library. Supports:
//  - wss:// only (TLS via OpenSSL, SNI, cert verification OPTIONAL — see connect()).
//  - Client-side masking, TEXT + BINARY send, PING/PONG, CLOSE.
//  - Fragmented-message reassembly on receive.
//  - Non-blocking socket + poll(); one message at a time via poll().
//
// This is the single biggest hand-written dependency (there is no cross-compiled
// libwebsockets here). It is compile-verified; wire behaviour is unverified without
// a live gateway. See STATUS.md.
#pragma once

#include <string>
#include <vector>
#include <cstdint>

struct ssl_st;
struct ssl_ctx_st;

namespace dv {

class WsClient {
public:
    enum class Op { Text, Binary, Ping, Pong, Close, None };

    WsClient() = default;
    ~WsClient();

    // Connect + perform the HTTP/1.1 Upgrade handshake. `path` includes query string.
    // `verify` toggles TLS peer verification (default off: the device rootfs CA set is
    // incomplete; production should ship a CA bundle and enable this).
    bool connect(const std::string& host, int port, const std::string& path,
                 std::string& err, bool verify = false);

    bool sendText(const std::string& payload);
    bool sendBinary(const uint8_t* data, size_t len);
    bool sendPong(const std::string& payload);
    bool sendClose(uint16_t code = 1000);

    // Poll for one complete application message.
    //   returns  1  => a message is in `out` (`binary` set accordingly)
    //            0  => timeout, nothing yet (call again)
    //           -1  => connection closed or error
    // PING frames are answered internally and reported as 0.
    int poll(int timeout_ms, std::vector<uint8_t>& out, bool& binary);

    int fd() const { return fd_; }
    bool ok() const { return fd_ >= 0; }
    void close();

private:
    bool tlsHandshake(std::string& err, bool verify, const std::string& host);
    bool writeAll(const uint8_t* p, size_t n);
    int  readSome(uint8_t* p, size_t n);         // -1 err, 0 want-more, >0 bytes
    bool sendFrame(uint8_t opcode, const uint8_t* data, size_t len);
    bool parseFrame(std::vector<uint8_t>& out, bool& binary, bool& gotMsg);

    int  fd_ = -1;
    ssl_st*     ssl_ = nullptr;
    ssl_ctx_st* ctx_ = nullptr;
    std::vector<uint8_t> rx_;                    // rolling receive buffer
    std::vector<uint8_t> frag_;                  // fragmented-message accumulator
    uint8_t fragOpcode_ = 0;
};

} // namespace dv
