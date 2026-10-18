#include "ws_client.h"
#include "common.h"

#include <cstring>
#include <cerrno>
#include <unistd.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <openssl/evp.h>

namespace dv {

static std::string base64(const uint8_t* in, size_t n) {
    // EVP_EncodeBlock writes ceil(n/3)*4 + 1 bytes (NUL). Deterministic sizing.
    std::string out;
    out.resize(4 * ((n + 2) / 3) + 1);
    int len = EVP_EncodeBlock((unsigned char*)out.data(), in, (int)n);
    out.resize(len > 0 ? (size_t)len : 0);
    return out;
}

WsClient::~WsClient() { close(); }

void WsClient::close() {
    if (ssl_) { SSL_shutdown(ssl_); SSL_free(ssl_); ssl_ = nullptr; }
    if (ctx_) { SSL_CTX_free(ctx_); ctx_ = nullptr; }
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
    rx_.clear(); frag_.clear();
}

bool WsClient::connect(const std::string& host, int port, const std::string& path,
                       std::string& err, bool verify) {
    // --- TCP connect (force IPv4: the TouchPad kernel has flaky IPv6 sockets) ---
    struct addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    char portstr[16];
    snprintf(portstr, sizeof(portstr), "%d", port);
    int gai = getaddrinfo(host.c_str(), portstr, &hints, &res);
    if (gai != 0 || !res) { err = "getaddrinfo: " + std::string(gai_strerror(gai)); return false; }

    fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd_ < 0) { err = "socket"; freeaddrinfo(res); return false; }
    if (::connect(fd_, res->ai_addr, res->ai_addrlen) != 0) {
        err = std::string("connect: ") + strerror(errno);
        freeaddrinfo(res); close(); return false;
    }
    freeaddrinfo(res);
    int one = 1;
    setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    if (!tlsHandshake(err, verify, host)) { close(); return false; }

    // --- WebSocket HTTP/1.1 Upgrade handshake ---
    uint8_t key[16];
    RAND_bytes(key, sizeof(key));
    std::string secKey = base64(key, sizeof(key));

    std::string req =
        "GET " + path + " HTTP/1.1\r\n"
        "Host: " + host + "\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: " + secKey + "\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n";
    if (!writeAll((const uint8_t*)req.data(), req.size())) { err = "ws upgrade write"; close(); return false; }

    // Read HTTP response headers (blocking-ish: poll then read until "\r\n\r\n").
    std::string resp;
    uint64_t deadline = now_ms() + 10000;
    while (resp.find("\r\n\r\n") == std::string::npos) {
        if (now_ms() > deadline) { err = "ws upgrade timeout"; close(); return false; }
        struct pollfd pfd { fd_, POLLIN, 0 };
        int pr = ::poll(&pfd, 1, 500);
        if (pr < 0) { err = "poll"; close(); return false; }
        if (pr == 0) continue;
        uint8_t tmp[1024];
        int r = readSome(tmp, sizeof(tmp));
        if (r < 0) { err = "ws upgrade read closed"; close(); return false; }
        if (r > 0) resp.append((char*)tmp, r);
        if (resp.size() > 65536) { err = "ws upgrade oversized header"; close(); return false; }
    }
    if (resp.compare(0, 12, "HTTP/1.1 101") != 0) {
        err = "ws upgrade not 101: " + resp.substr(0, 64);
        close(); return false;
    }
    // Any bytes after the header terminator are the start of the WS stream.
    size_t hdrEnd = resp.find("\r\n\r\n") + 4;
    if (hdrEnd < resp.size())
        rx_.insert(rx_.end(), resp.begin() + hdrEnd, resp.end());

    // Non-blocking from here on; poll() drives reads.
    int fl = fcntl(fd_, F_GETFL, 0);
    fcntl(fd_, F_SETFL, fl | O_NONBLOCK);
    DV_INFO("ws connected wss://%s:%d%s", host.c_str(), port, path.c_str());
    return true;
}

bool WsClient::tlsHandshake(std::string& err, bool verify, const std::string& host) {
    static bool inited = false;
    if (!inited) { SSL_library_init(); SSL_load_error_strings(); inited = true; }
    ctx_ = SSL_CTX_new(TLS_client_method());
    if (!ctx_) { err = "SSL_CTX_new"; return false; }
    SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION);
    if (verify) {
        SSL_CTX_set_verify(ctx_, SSL_VERIFY_PEER, nullptr);
        SSL_CTX_set_default_verify_paths(ctx_);
    }
    ssl_ = SSL_new(ctx_);
    if (!ssl_) { err = "SSL_new"; return false; }
    SSL_set_fd(ssl_, fd_);
    SSL_set_tlsext_host_name(ssl_, host.c_str());   // SNI
    if (SSL_connect(ssl_) != 1) {
        unsigned long e = ERR_get_error();
        char eb[256]; ERR_error_string_n(e, eb, sizeof(eb));
        err = std::string("SSL_connect: ") + eb;
        return false;
    }
    return true;
}

bool WsClient::writeAll(const uint8_t* p, size_t n) {
    size_t off = 0;
    while (off < n) {
        int w = SSL_write(ssl_, p + off, (int)(n - off));
        if (w > 0) { off += w; continue; }
        int e = SSL_get_error(ssl_, w);
        if (e == SSL_ERROR_WANT_WRITE || e == SSL_ERROR_WANT_READ) {
            struct pollfd pfd { fd_, (short)(e == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT), 0 };
            ::poll(&pfd, 1, 1000);
            continue;
        }
        return false;
    }
    return true;
}

int WsClient::readSome(uint8_t* p, size_t n) {
    int r = SSL_read(ssl_, p, (int)n);
    if (r > 0) return r;
    int e = SSL_get_error(ssl_, r);
    if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) return 0;
    return -1;
}

bool WsClient::sendFrame(uint8_t opcode, const uint8_t* data, size_t len) {
    // Client frames MUST be masked (RFC 6455 §5.3).
    std::vector<uint8_t> f;
    f.push_back(0x80 | (opcode & 0x0f));           // FIN + opcode
    if (len < 126) {
        f.push_back(0x80 | (uint8_t)len);
    } else if (len <= 0xffff) {
        f.push_back(0x80 | 126);
        f.push_back((len >> 8) & 0xff);
        f.push_back(len & 0xff);
    } else {
        f.push_back(0x80 | 127);
        for (int i = 7; i >= 0; --i) f.push_back((uint8_t)((uint64_t)len >> (i * 8)));
    }
    uint8_t mask[4];
    RAND_bytes(mask, 4);
    f.insert(f.end(), mask, mask + 4);
    size_t base = f.size();
    f.resize(base + len);
    for (size_t i = 0; i < len; ++i) f[base + i] = data[i] ^ mask[i & 3];
    return writeAll(f.data(), f.size());
}

bool WsClient::sendText(const std::string& p)   { return sendFrame(0x1, (const uint8_t*)p.data(), p.size()); }
bool WsClient::sendBinary(const uint8_t* d, size_t n) { return sendFrame(0x2, d, n); }
bool WsClient::sendPong(const std::string& p)   { return sendFrame(0xA, (const uint8_t*)p.data(), p.size()); }
bool WsClient::sendClose(uint16_t code) {
    uint8_t b[2] = { (uint8_t)(code >> 8), (uint8_t)(code & 0xff) };
    return sendFrame(0x8, b, 2);
}

// Parse exactly one frame out of rx_. On a data frame that completes a message,
// fills out/binary and sets gotMsg. Handles fragmentation + control frames.
bool WsClient::parseFrame(std::vector<uint8_t>& out, bool& binary, bool& gotMsg) {
    gotMsg = false;
    if (rx_.size() < 2) return false;
    uint8_t b0 = rx_[0], b1 = rx_[1];
    bool fin = b0 & 0x80;
    uint8_t opcode = b0 & 0x0f;
    bool masked = b1 & 0x80;                 // server->client is never masked
    uint64_t len = b1 & 0x7f;
    size_t off = 2;
    if (len == 126) {
        if (rx_.size() < off + 2) return false;
        len = ((uint64_t)rx_[off] << 8) | rx_[off + 1]; off += 2;
    } else if (len == 127) {
        if (rx_.size() < off + 8) return false;
        len = 0; for (int i = 0; i < 8; ++i) len = (len << 8) | rx_[off + i]; off += 8;
    }
    size_t maskLen = masked ? 4 : 0;
    if (rx_.size() < off + maskLen + len) return false;   // incomplete; wait for more
    const uint8_t* payload = rx_.data() + off + maskLen;

    std::vector<uint8_t> data(payload, payload + len);
    if (masked) { const uint8_t* mk = rx_.data() + off; for (size_t i = 0; i < len; ++i) data[i] ^= mk[i & 3]; }
    rx_.erase(rx_.begin(), rx_.begin() + off + maskLen + len);

    switch (opcode) {
        case 0x0: // continuation
            frag_.insert(frag_.end(), data.begin(), data.end());
            if (fin) { out.swap(frag_); frag_.clear(); binary = (fragOpcode_ == 0x2); gotMsg = true; }
            break;
        case 0x1: // text
        case 0x2: // binary
            if (fin) { out.swap(data); binary = (opcode == 0x2); gotMsg = true; }
            else     { frag_ = data; fragOpcode_ = opcode; }
            break;
        case 0x8: // close
            return false; // signal handled at poll() layer via -1
        case 0x9: // ping -> pong
            sendPong(std::string((char*)data.data(), data.size()));
            break;
        case 0xA: break; // pong: ignore
        default: break;
    }
    return true;
}

int WsClient::poll(int timeout_ms, std::vector<uint8_t>& out, bool& binary) {
    // First, drain anything already buffered.
    for (;;) {
        bool got = false;
        if (!parseFrame(out, binary, got)) {
            // parseFrame returns false either for "need more bytes" or a close frame.
            // Distinguish: if rx_ still holds a full close frame we would have consumed
            // it; a leading 0x88 means close.
            if (rx_.size() >= 1 && (rx_[0] & 0x0f) == 0x8) return -1;
            break;
        }
        if (got) return 1;
    }
    struct pollfd pfd { fd_, POLLIN, 0 };
    int pr = ::poll(&pfd, 1, timeout_ms);
    if (pr < 0) return -1;
    if (pr == 0) return 0;
    uint8_t tmp[8192];
    int r = readSome(tmp, sizeof(tmp));
    if (r < 0) return -1;
    if (r == 0) return 0;
    rx_.insert(rx_.end(), tmp, tmp + r);
    for (;;) {
        bool got = false;
        if (!parseFrame(out, binary, got)) {
            if (rx_.size() >= 1 && (rx_[0] & 0x0f) == 0x8) return -1;
            break;
        }
        if (got) return 1;
    }
    return 0;
}

} // namespace dv
