#include "udp_transport.h"

#include <cstring>
#include <cerrno>
#include <unistd.h>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include <openssl/evp.h>

namespace dv {

UdpTransport::~UdpTransport() { if (fd_ >= 0) ::close(fd_); }

bool UdpTransport::open(const std::string& serverIp, uint16_t serverPort, uint32_t ssrc, std::string& err) {
    ssrc_ = ssrc;
    fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);   // IPv4 only (TouchPad IPv6 quirk)
    if (fd_ < 0) { err = "udp socket"; return false; }

    struct sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(serverPort);
    if (inet_pton(AF_INET, serverIp.c_str(), &sa.sin_addr) != 1) {
        err = "udp bad server ip: " + serverIp; return false;
    }
    memcpy(serverAddr_, &sa, sizeof(sa));
    serverAddrLen_ = sizeof(sa);
    // "Connect" the datagram socket so send()/recv() default to the SFU.
    if (::connect(fd_, (struct sockaddr*)&sa, sizeof(sa)) != 0) {
        err = std::string("udp connect: ") + strerror(errno); return false;
    }
    DV_INFO("udp: -> %s:%u ssrc=%u", serverIp.c_str(), serverPort, ssrc);
    return true;
}

bool UdpTransport::discover(std::string& publicIp, uint16_t& publicPort, std::string& err) {
    // 74-byte IP discovery packet: type(2)=0x0001, length(2)=70, ssrc(4), then 64B
    // address field + 2B port field. Server echoes with type 0x0002 + our public
    // address/port as an ASCII-NUL-terminated string in the address field.
    uint8_t pkt[74] = {0};
    pkt[0] = 0x00; pkt[1] = 0x01;   // request
    pkt[2] = 0x00; pkt[3] = 70;     // length
    pkt[4] = (ssrc_ >> 24) & 0xff; pkt[5] = (ssrc_ >> 16) & 0xff;
    pkt[6] = (ssrc_ >> 8) & 0xff;  pkt[7] = ssrc_ & 0xff;
    if (::send(fd_, pkt, sizeof(pkt), 0) != (ssize_t)sizeof(pkt)) { err = "discovery send"; return false; }

    struct pollfd pfd { fd_, POLLIN, 0 };
    if (::poll(&pfd, 1, 5000) <= 0) { err = "discovery timeout"; return false; }
    uint8_t resp[128] = {0};
    ssize_t r = ::recv(fd_, resp, sizeof(resp), 0);
    if (r < 74) { err = "discovery short reply"; return false; }
    // address string starts at offset 8, port is the last 2 bytes (big-endian).
    publicIp = std::string((char*)resp + 8);
    publicPort = ((uint16_t)resp[r - 2] << 8) | resp[r - 1];
    DV_INFO("udp: IP discovery -> %s:%u", publicIp.c_str(), publicPort);
    return true;
}

bool UdpTransport::setSecretKey(const uint8_t* key, size_t len, const std::string& mode) {
    if (len != 32) { DV_ERR("udp: secret key len=%zu (want 32)", len); return false; }
    memcpy(key_, key, 32);
    haveKey_ = true;
    mode_ = mode;
    DV_INFO("udp: transport key installed, mode=%s", mode.c_str());
    if (mode != "aead_aes256_gcm_rtpsize")
        DV_WARN("udp: mode '%s' NOT implemented (only aead_aes256_gcm_rtpsize); will fail at runtime", mode.c_str());
    return true;
}

bool UdpTransport::aeadSeal(const uint8_t* aad, size_t aadLen, const uint8_t* pt, size_t ptLen,
                            const uint8_t nonce12[12], Bytes& out) {
    EVP_CIPHER_CTX* c = EVP_CIPHER_CTX_new();
    if (!c) return false;
    bool ok = false;
    out.resize(ptLen + 16);
    int outl = 0, tmp = 0;
    do {
        if (EVP_EncryptInit_ex(c, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1) break;
        if (EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr) != 1) break;
        if (EVP_EncryptInit_ex(c, nullptr, nullptr, key_, nonce12) != 1) break;
        if (aadLen && EVP_EncryptUpdate(c, nullptr, &tmp, aad, (int)aadLen) != 1) break;
        if (EVP_EncryptUpdate(c, out.data(), &outl, pt, (int)ptLen) != 1) break;
        int fin = 0;
        if (EVP_EncryptFinal_ex(c, out.data() + outl, &fin) != 1) break;
        outl += fin;
        if (EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_GET_TAG, 16, out.data() + outl) != 1) break;
        out.resize(outl + 16);
        ok = true;
    } while (0);
    EVP_CIPHER_CTX_free(c);
    return ok;
}

bool UdpTransport::aeadOpen(const uint8_t* aad, size_t aadLen, const uint8_t* ct, size_t ctLen,
                            const uint8_t* tag, const uint8_t nonce12[12], Bytes& out) {
    EVP_CIPHER_CTX* c = EVP_CIPHER_CTX_new();
    if (!c) return false;
    bool ok = false;
    out.resize(ctLen);
    int outl = 0, tmp = 0;
    do {
        if (EVP_DecryptInit_ex(c, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1) break;
        if (EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr) != 1) break;
        if (EVP_DecryptInit_ex(c, nullptr, nullptr, key_, nonce12) != 1) break;
        if (aadLen && EVP_DecryptUpdate(c, nullptr, &tmp, aad, (int)aadLen) != 1) break;
        if (EVP_DecryptUpdate(c, out.data(), &outl, ct, (int)ctLen) != 1) break;
        if (EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_TAG, 16, (void*)tag) != 1) break;
        int fin = 0;
        if (EVP_DecryptFinal_ex(c, out.data() + outl, &fin) != 1) break; // auth fail -> !=1
        outl += fin;
        out.resize(outl);
        ok = true;
    } while (0);
    EVP_CIPHER_CTX_free(c);
    return ok;
}

bool UdpTransport::sendAudio(const uint8_t* payload, size_t len) {
    if (!haveKey_) return false;
    // RTP header (12B): V=2,P=0,X=0,CC=0 (0x80); M=0,PT=0x78 (120, Discord Opus);
    // seq(2), timestamp(4), ssrc(4).
    uint8_t hdr[12];
    hdr[0] = 0x80; hdr[1] = 0x78;
    hdr[2] = (seq_ >> 8) & 0xff;      hdr[3] = seq_ & 0xff;
    hdr[4] = (timestamp_ >> 24) & 0xff; hdr[5] = (timestamp_ >> 16) & 0xff;
    hdr[6] = (timestamp_ >> 8) & 0xff;  hdr[7] = timestamp_ & 0xff;
    hdr[8] = (ssrc_ >> 24) & 0xff; hdr[9] = (ssrc_ >> 16) & 0xff;
    hdr[10] = (ssrc_ >> 8) & 0xff; hdr[11] = ssrc_ & 0xff;

    // Nonce: 4-byte BE counter, right-padded to 12 bytes.
    uint8_t nonce[12] = {0};
    uint32_t n = ++nonceCtr_;
    nonce[0] = (n >> 24) & 0xff; nonce[1] = (n >> 16) & 0xff;
    nonce[2] = (n >> 8) & 0xff;  nonce[3] = n & 0xff;

    Bytes sealed;
    if (!aeadSeal(hdr, 12, payload, len, nonce, sealed)) { DV_WARN("udp: seal failed"); return false; }

    Bytes pkt;
    pkt.reserve(12 + sealed.size() + 4);
    pkt.insert(pkt.end(), hdr, hdr + 12);
    pkt.insert(pkt.end(), sealed.begin(), sealed.end());
    pkt.push_back(nonce[0]); pkt.push_back(nonce[1]); pkt.push_back(nonce[2]); pkt.push_back(nonce[3]);

    seq_++; timestamp_ += 960;   // 20 ms @ 48 kHz
    ssize_t w = ::send(fd_, pkt.data(), pkt.size(), 0);
    return w == (ssize_t)pkt.size();
}

int UdpTransport::recvAudio(int timeout_ms, Bytes& payloadOut, uint32_t& senderSsrc) {
    struct pollfd pfd { fd_, POLLIN, 0 };
    int pr = ::poll(&pfd, 1, timeout_ms);
    if (pr < 0) return -1;
    if (pr == 0) return 0;
    uint8_t buf[2048];
    ssize_t r = ::recv(fd_, buf, sizeof(buf), 0);
    if (r < 12 + 16 + 4) return 0;                 // too small to be an RTP media packet
    if (!haveKey_) return 0;
    senderSsrc = ((uint32_t)buf[8] << 24) | ((uint32_t)buf[9] << 16) |
                 ((uint32_t)buf[10] << 8) | buf[11];
    // nonce = last 4 bytes, right-padded to 12.
    uint8_t nonce[12] = {0};
    memcpy(nonce, buf + r - 4, 4);
    const uint8_t* body = buf + 12;
    size_t bodyLen = (size_t)r - 12 - 4;           // ciphertext+tag, minus trailing nonce
    if (bodyLen < 16) return 0;
    const uint8_t* tag = body + (bodyLen - 16);
    size_t ctLen = bodyLen - 16;
    if (!aeadOpen(buf, 12, body, ctLen, tag, nonce, payloadOut)) return 0;
    return 1;
}

} // namespace dv
