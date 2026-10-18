#include "dave_glue.h"
#include <dave/dave.h>
#include <cstring>
#include <cstdlib>

namespace dv {

static void mlsFailCb(const char* source, const char* reason, void* /*ud*/) {
    DV_ERR("DAVE MLS failure: source=%s reason=%s",
           source ? source : "(null)", reason ? reason : "(null)");
}

DaveSession::~DaveSession() {
    if (enc_)  daveEncryptorDestroy(enc_);
    if (dec_)  daveDecryptorDestroy(dec_);
    if (sess_) daveSessionDestroy(sess_);
}

uint16_t DaveSession::maxProtocolVersion() const { return daveMaxSupportedProtocolVersion(); }

bool DaveSession::init(uint16_t protocolVersion, const std::string& channelId,
                       const std::string& selfUserId, uint32_t ourSsrc) {
    selfUserId_ = selfUserId;
    ssrc_ = ourSsrc;
    version_ = protocolVersion;

    // authSessionId MUST be NULL with PERSISTENT_KEYS=OFF, else no key package is
    // produced (proven in the foundation probe — see PLAN.md §5 gotcha).
    sess_ = daveSessionCreate(nullptr, nullptr, mlsFailCb, this);
    if (!sess_) { DV_ERR("daveSessionCreate failed"); return false; }

    uint64_t groupId = strtoull(channelId.c_str(), nullptr, 10);
    daveSessionInit(sess_, protocolVersion, groupId, selfUserId.c_str());

    enc_ = daveEncryptorCreate();
    dec_ = daveDecryptorCreate();
    if (!enc_ || !dec_) { DV_ERR("encryptor/decryptor create failed"); return false; }
    daveEncryptorAssignSsrcToCodec(enc_, ssrc_, DAVE_CODEC_OPUS);
    // Until the first epoch is live, media must pass through (no encryption yet).
    daveEncryptorSetPassthroughMode(enc_, true);
    daveDecryptorTransitionToPassthroughMode(dec_, true);
    DV_INFO("DAVE: session init v%u group=%llu self=%s (max_supported=%u)",
            protocolVersion, (unsigned long long)groupId, selfUserId.c_str(),
            daveMaxSupportedProtocolVersion());
    return true;
}

void DaveSession::onExternalSender(const uint8_t* data, size_t len) {
    if (!sess_) return;
    daveSessionSetExternalSender(sess_, data, len);
    DV_INFO("DAVE: op25 external sender set (%zu B)", len);
}

bool DaveSession::getKeyPackage(Bytes& out) {
    if (!sess_) return false;
    uint8_t* kp = nullptr; size_t kpLen = 0;
    daveSessionGetMarshalledKeyPackage(sess_, &kp, &kpLen);
    if (!kp || kpLen == 0) { DV_ERR("DAVE: empty key package"); if (kp) daveFree(kp); return false; }
    out.assign(kp, kp + kpLen);
    daveFree(kp);
    DV_INFO("DAVE: op26 key package %zu B (%s)", out.size(), hex(out.data(), out.size(), 4).c_str());
    return true;
}

bool DaveSession::onProposals(const uint8_t* data, size_t len,
                              const std::vector<std::string>& recognizedUserIds, Bytes& commitWelcome) {
    if (!sess_) return false;
    std::vector<const char*> ids;
    for (auto& s : recognizedUserIds) ids.push_back(s.c_str());
    uint8_t* cw = nullptr; size_t cwLen = 0;
    daveSessionProcessProposals(sess_, data, len,
                                ids.empty() ? nullptr : ids.data(), ids.size(),
                                &cw, &cwLen);
    if (!cw || cwLen == 0) { DV_WARN("DAVE: op27 produced no commit/welcome"); if (cw) daveFree(cw); return false; }
    commitWelcome.assign(cw, cw + cwLen);
    daveFree(cw);
    DV_INFO("DAVE: op27 proposals -> commit/welcome %zu B", commitWelcome.size());
    return true;
}

void DaveSession::onCommit(const uint8_t* data, size_t len) {
    if (!sess_) return;
    DAVECommitResultHandle r = daveSessionProcessCommit(sess_, data, len);
    if (!r) { DV_WARN("DAVE: op29 commit produced no result"); return; }
    if (daveCommitResultIsFailed(r))  DV_ERR("DAVE: commit FAILED");
    else if (daveCommitResultIsIgnored(r)) DV_INFO("DAVE: commit ignored");
    else {
        uint64_t* ids = nullptr; size_t n = 0;
        daveCommitResultGetRosterMemberIds(r, &ids, &n);
        DV_INFO("DAVE: op29 commit OK, roster=%zu members", n);
        for (size_t i = 0; i < n; ++i) ensureDecryptorFor(std::to_string(ids[i]));
        if (ids) daveFree(ids);
    }
    daveCommitResultDestroy(r);
}

void DaveSession::onWelcome(const uint8_t* data, size_t len,
                            const std::vector<std::string>& recognizedUserIds) {
    if (!sess_) return;
    std::vector<const char*> ids;
    for (auto& s : recognizedUserIds) ids.push_back(s.c_str());
    DAVEWelcomeResultHandle w = daveSessionProcessWelcome(
        sess_, data, len, ids.empty() ? nullptr : ids.data(), ids.size());
    if (!w) { DV_WARN("DAVE: op30 welcome produced no result"); return; }
    uint64_t* rids = nullptr; size_t n = 0;
    daveWelcomeResultGetRosterMemberIds(w, &rids, &n);
    DV_INFO("DAVE: op30 welcome OK, roster=%zu members", n);
    for (size_t i = 0; i < n; ++i) ensureDecryptorFor(std::to_string(rids[i]));
    if (rids) daveFree(rids);
    daveWelcomeResultDestroy(w);
}

void DaveSession::ensureDecryptorFor(const std::string& userId) {
    if (!sess_ || !dec_) return;
    if (userId == selfUserId_) return;                 // don't decrypt our own audio
    DAVEKeyRatchetHandle kr = daveSessionGetKeyRatchet(sess_, userId.c_str());
    if (!kr) { DV_WARN("DAVE: no key ratchet for %s", userId.c_str()); return; }
    // NOTE (M2 limitation): libdave models ONE active decryptor ratchet. A true
    // multi-party mixer needs a decryptor per SSRC/sender; here we transition the
    // single decryptor to the most-recent sender. Fine for 1-remote-speaker bring-up.
    daveDecryptorTransitionToKeyRatchet(dec_, kr);
    daveKeyRatchetDestroy(kr);
    DV_INFO("DAVE: decryptor ratchet set for sender %s", userId.c_str());
}

void DaveSession::activateEpoch() {
    if (!sess_ || !enc_) return;
    DAVEKeyRatchetHandle self = daveSessionGetKeyRatchet(sess_, selfUserId_.c_str());
    if (!self) { DV_ERR("DAVE: activateEpoch: no self ratchet"); return; }
    daveEncryptorSetKeyRatchet(enc_, self);
    daveKeyRatchetDestroy(self);
    daveEncryptorSetPassthroughMode(enc_, false);
    daveDecryptorTransitionToPassthroughMode(dec_, false);
    epochReady_ = true;
    uint8_t* auth = nullptr; size_t authLen = 0;
    daveSessionGetLastEpochAuthenticator(sess_, &auth, &authLen);
    DV_INFO("DAVE: epoch ACTIVE, encryptor live, epochAuth=%zu B", authLen);
    if (auth) daveFree(auth);
}

bool DaveSession::wrapFrame(const uint8_t* opus, size_t opusLen, Bytes& out) {
    if (!enc_) return false;
    size_t cap = daveEncryptorGetMaxCiphertextByteSize(enc_, DAVE_MEDIA_TYPE_AUDIO, opusLen);
    out.resize(cap ? cap : opusLen + 32);
    size_t written = 0;
    DAVEEncryptorResultCode rc = daveEncryptorEncrypt(
        enc_, DAVE_MEDIA_TYPE_AUDIO, ssrc_, opus, opusLen,
        out.data(), out.size(), &written);
    if (rc != DAVE_ENCRYPTOR_RESULT_CODE_SUCCESS) { DV_WARN("DAVE wrap rc=%d", (int)rc); return false; }
    out.resize(written);
    return true;
}

bool DaveSession::unwrapFrame(const uint8_t* framed, size_t len, Bytes& out) {
    if (!dec_) return false;
    size_t cap = daveDecryptorGetMaxPlaintextByteSize(dec_, DAVE_MEDIA_TYPE_AUDIO, len);
    out.resize(cap ? cap : len);
    size_t written = 0;
    DAVEDecryptorResultCode rc = daveDecryptorDecrypt(
        dec_, DAVE_MEDIA_TYPE_AUDIO, framed, len, out.data(), out.size(), &written);
    if (rc != DAVE_DECRYPTOR_RESULT_CODE_SUCCESS) { DV_WARN("DAVE unwrap rc=%d", (int)rc); return false; }
    out.resize(written);
    return true;
}

} // namespace dv
