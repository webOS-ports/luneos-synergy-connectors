// udp_transport.h — Discord voice UDP layer: IP discovery + RTP + transport AEAD.
//
// This is the classic (pre-DAVE) Discord voice hop-encryption to the SFU. DAVE sits
// INSIDE the RTP payload; this layer encrypts the whole (already DAVE-framed) payload
// with the 32-byte secret_key from SESSION_DESCRIPTION.
//
// Implemented mode: aead_aes256_gcm_rtpsize (OpenSSL EVP_aes_256_gcm).
//   - RTP 12-byte header authenticated as AAD.
//   - 4-byte big-endian packet counter is the nonce (right-padded to 12 for GCM),
//     appended UNENCRYPTED at the end of the packet.
//   - packet = rtp_header(12) || ciphertext || tag(16) || nonce(4).
// aead_xchacha20_poly1305_rtpsize is NOT implemented: OpenSSL 1.1.1 lacks XChaCha20
// (24-byte nonce); it would need libsodium (not cross-compiled here). See STATUS.md.
//
// Compile-verified. Exact nonce endianness / AAD extent must be checked against a live
// server (discord.py voice_client.py is the reference).
#pragma once

#include "common.h"
#include <string>
#include <cstdint>

namespace dv {

class UdpTransport {
public:
    ~UdpTransport();

    // Open the UDP socket toward the SFU (ip/port from voice READY).
    bool open(const std::string& serverIp, uint16_t serverPort, uint32_t ssrc, std::string& err);

    // Send the 74-byte IP-discovery request and read the echoed public ip/port.
    bool discover(std::string& publicIp, uint16_t& publicPort, std::string& err);

    // Install the 32-byte transport secret key + negotiated mode string.
    bool setSecretKey(const uint8_t* key, size_t len, const std::string& mode);

    // Encrypt+send one media payload (already DAVE-framed Opus) as an RTP packet.
    bool sendAudio(const uint8_t* payload, size_t len);

    // Receive one packet; on success decrypts the RTP payload into `payloadOut` and
    // returns the sender SSRC. Returns 0 on timeout, -1 on error.
    int recvAudio(int timeout_ms, Bytes& payloadOut, uint32_t& senderSsrc);

    int fd() const { return fd_; }

private:
    bool aeadSeal(const uint8_t* aad, size_t aadLen, const uint8_t* pt, size_t ptLen,
                  const uint8_t nonce12[12], Bytes& out /*ct||tag*/);
    bool aeadOpen(const uint8_t* aad, size_t aadLen, const uint8_t* ct, size_t ctLen,
                  const uint8_t* tag, const uint8_t nonce12[12], Bytes& out);

    int fd_ = -1;
    uint32_t ssrc_ = 0;
    uint16_t seq_ = 0;
    uint32_t timestamp_ = 0;
    uint32_t nonceCtr_ = 0;
    uint8_t  key_[32] = {0};
    bool     haveKey_ = false;
    std::string mode_;
    // sockaddr_in of the server, stored as raw bytes to avoid leaking <netinet> here.
    uint8_t serverAddr_[16] = {0};
    unsigned serverAddrLen_ = 0;
};

} // namespace dv
