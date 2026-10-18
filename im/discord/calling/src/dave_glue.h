// dave_glue.h — thin wrapper over the libdave C API (prebuilt/include/dave/dave.h).
//
// Owns the MLS control-plane session + the media encryptor/decryptor, and exposes:
//   - handlers for voice-gateway DAVE opcodes 21-30 (fed the raw MLS blobs), each
//     returning any bytes we must send back (op23 ready / op26 key package /
//     op28 commit+welcome);
//   - wrapFrame()/unwrapFrame(): the per-Opus-frame DAVE AES-128-GCM seal/open that
//     sits INSIDE the transport crypto.
//
// The MLS crypto core this drives is proven on ARM (see logs/probe-run-qemu.log). The
// opcode<->call ORDERING here follows PLAN.md §5 and the DAVE whitepaper and is
// compile-verified only — it must be validated against a live voice server (M2).
#pragma once

#include "common.h"
#include <string>
#include <map>
#include <cstdint>

// Opaque libdave handles (from dave/dave.h).
struct DAVESessionHandle_s;   typedef struct DAVESessionHandle_s*   DAVESessionHandle;
struct DAVEEncryptorHandle_s; typedef struct DAVEEncryptorHandle_s* DAVEEncryptorHandle;
struct DAVEDecryptorHandle_s; typedef struct DAVEDecryptorHandle_s* DAVEDecryptorHandle;
struct DAVEKeyRatchetHandle_s;typedef struct DAVEKeyRatchetHandle_s* DAVEKeyRatchetHandle;

namespace dv {

class DaveSession {
public:
    ~DaveSession();

    // channelId = Discord voice channel snowflake (the MLS groupId).
    // selfUserId = our bot user id (decimal snowflake string).
    bool init(uint16_t protocolVersion, const std::string& channelId,
              const std::string& selfUserId, uint32_t ourSsrc);

    uint16_t maxProtocolVersion() const;

    // --- DAVE opcode handlers. `out` receives bytes to transmit (empty if none). ---
    // op25 DAVE_MLS_EXTERNAL_SENDER (<-)
    void onExternalSender(const uint8_t* data, size_t len);
    // op26 DAVE_MLS_KEY_PACKAGE: produce our marshalled key package to upload (->).
    bool getKeyPackage(Bytes& out);
    // op27 DAVE_MLS_PROPOSALS (<-): returns commit+welcome bytes for op28 (->).
    bool onProposals(const uint8_t* data, size_t len,
                     const std::vector<std::string>& recognizedUserIds, Bytes& commitWelcome);
    // op29 DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION / a commit (<-).
    void onCommit(const uint8_t* data, size_t len);
    // op30 DAVE_MLS_WELCOME (<-).
    void onWelcome(const uint8_t* data, size_t len,
                   const std::vector<std::string>& recognizedUserIds);

    // Called after EXECUTE_TRANSITION(op22): pull per-sender ratchets, wire the
    // encryptor to OUR ratchet, leave passthrough.
    void activateEpoch();
    bool epochReady() const { return epochReady_; }

    // Per-frame media crypto (INSIDE transport crypto). Audio only.
    bool wrapFrame(const uint8_t* opus, size_t opusLen, Bytes& out);      // -> DAVE-framed
    bool unwrapFrame(const uint8_t* framed, size_t len, Bytes& out);      // -> plain opus

    // Ensure a decryptor ratchet exists for a remote sender (by user id).
    void ensureDecryptorFor(const std::string& userId);

private:
    DAVESessionHandle    sess_ = nullptr;
    DAVEEncryptorHandle  enc_  = nullptr;
    DAVEDecryptorHandle  dec_  = nullptr;
    std::string selfUserId_;
    uint32_t    ssrc_ = 0;
    uint16_t    version_ = 1;
    bool epochReady_ = false;
};

} // namespace dv
