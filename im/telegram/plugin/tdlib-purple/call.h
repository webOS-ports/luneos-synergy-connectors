#ifndef _CALL_H
#define _CALL_H

#include "account-data.h"

bool initiateCall(int64_t userId, bool video, TdAccountData &account, TdTransceiver &transceiver);
void updateCall(const td::td_api::call &call, TdAccountData &account, TdTransceiver &transceiver);
// tgcalls-lite signaling relay: routes td_api::updateNewCallSignalingData's opaque bytes into the
// active call's CallEngine (see account-data.h's getCallEngine()). No-op if callId doesn't match
// the account's current active call, or if tgcalls-lite is disabled (NoTgcallsLite).
void updateCallSignalingData(int32_t callId, const std::string &data, TdAccountData &account);
void discardCurrentCall(TdAccountData &account, TdTransceiver &transceiver);
void acceptCurrentCall(TdAccountData &account, TdTransceiver &transceiver);
void showCallMessage(const td::td_api::chat &chat, const TgMessageInfo &message,
                     const td::td_api::messageCall &callEnded, TdAccountData &account);

#endif
