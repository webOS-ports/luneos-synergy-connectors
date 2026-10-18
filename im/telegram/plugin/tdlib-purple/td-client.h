#ifndef _TD_CLIENT_H
#define _TD_CLIENT_H

#include "account-data.h"
#include "client-utils.h"
#include <td/telegram/Log.h>
#include <purple.h>

enum class BasicGroupMembership: uint8_t {
    Invalid,
    Creator,
    NonCreator,
};

class PurpleTdClient {
public:
    PurpleTdClient(PurpleAccount *acct, ITransceiverBackend *testBackend);
    ~PurpleTdClient();

    static void setLogLevel(int level);
    static void setTdlibFatalErrorCallback(td::Log::FatalErrorCallbackPtr callback);
    static std::string getBaseDatabasePath();
    // webOS per-account store paths: the tdlib sqlite DB and the (unbounded) media cache live under
    // /media/cryptofs, keyed on the account username. sendTdlibParameters() and the account-removed
    // store-teardown hook both build the paths through these so they always match exactly.
    static std::string getDatabaseDir(const char *username);
    static std::string getFilesDir(const char *username);
    // webOS: unlink this device server-side (Telegram sessions list) before its local store is wiped.
    void logOut();
    int  sendMessage(const char *buddyName, const char *message, int64_t replyToMsgId = 0);
    // webOS reactions (SEND): add (remove=false) or remove (remove=true) MY `emoji` reaction on a
    // message via TDLib add/removeMessageReaction. Called from the webos-im-send-reaction handler.
    void sendReaction(int64_t chatId, int64_t messageId, const std::string &emoji, bool remove);
    void sendReactionResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void sendTyping(const char *buddyName, bool isTyping);
    void sendReadReceipts(PurpleConversation *conversation);

    void addContact(const std::string &purpleName, const std::string &alias, const std::string &groupName);
    void renameContact(const char *buddyName, const char *newAlias);
    void removeContactAndPrivateChat(const std::string &buddyName);
    void getUsers(const char *username, std::vector<const td::td_api::user *> &users);

    bool joinChat(const char *chatName);
    void joinChatByInviteLink(const char *inviteLink);
    void joinChatByGroupName(const char *joinString, const char *groupName);
    void createGroup(const char *name, int type, const std::vector<std::string> &basicGroupMembers);
    BasicGroupMembership getBasicGroupMembership(const char *purpleChatName);
    void leaveGroup(const std::string &purpleChatName, bool deleteSupergroup);
    int  sendGroupMessage(int purpleChatId, const char *message, int64_t replyToMsgId = 0);
    void setGroupDescription(int purpleChatId, const char *description);
    void kickUserFromChat(PurpleConversation *conv, const char *name);
    // webOS: archive (true) / unarchive (false) the chat backing this conversation.
    void setChatArchived(PurpleConversation *conv, bool archived);
    void addUserToChat(int purpleChatId, const char *name);
    void showInviteLink(const std::string &purpleChatName);
    void getGroupChatList(PurpleRoomlist *roomlist);

    void setTwoFactorAuth(const char *oldPassword, const char *newPassword, const char *hint,
                        const char *email);

    void sendFileToChat(PurpleXfer *xfer, const char *purpleName, PurpleConversationType type,
                        int purpleChatId);
    void cancelUpload(PurpleXfer *xfer);

    bool startVoiceCall(const char *buddyName, bool video);
    // async result of searchUserByPhoneNumber when a bare phone number is dialed (see startVoiceCall)
    void       voiceCallPhoneLookupResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    bool terminateCall(PurpleConversation *conv);
    void acceptCurrentCall();   // accept the pending incoming call (driven by com.palm.telegram.call)
    void hangupVoiceCall();     // end the active call

    void createSecretChat(const char *buddyName);
private:
    using TdObjectPtr   = td::td_api::object_ptr<td::td_api::Object>;
    using ResponseCb    = void (PurpleTdClient::*)(uint64_t requestId, TdObjectPtr object);

    void       processUpdate(td::td_api::Object &object);
    void       processAuthorizationState(td::td_api::AuthorizationState &authState);

    // Login sequence start
    bool       addProxy();
    void       addProxyResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       getProxiesResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       removeOldProxies();
    // webOS auth-input fallback (see m_authInputPending); declared before first use.
    enum class AuthInput { None, Code, Password, DisplayName };

    void       sendTdlibParameters();
    void       sendPhoneNumber();
    void       requestAuthCode(const td::td_api::authenticationCodeInfo *authCodeInfo);
    void       requestPassword(const td::td_api::authorizationStateWaitPassword &pwInfo);
    void       registerUser();
    static void requestCodeEntered(PurpleTdClient *self, const gchar *code);
    static void requestCodeCancelled(PurpleTdClient *self);
    static void passwordEntered(PurpleTdClient *self, const gchar *code);
    static void passwordCancelled(PurpleTdClient *self);
    static void displayNameEntered(PurpleTdClient *self, const gchar *name);
    static void displayNameCancelled(PurpleTdClient *self);
    // webOS fallback: prompt for an auth value through a "Telegram" IM conversation
    // and remember which value we're waiting for (see m_authInputPending).
    void       promptAuthInputViaChat(AuthInput type, const std::string &message);
    void       authResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       notifyAuthError(const td::td_api::object_ptr<td::td_api::Object> &response);
    void       setPurpleConnectionInProgress();
    void       onLoggedIn();
    void       getContactsResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       getChatsResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       requestMissingPrivateChats();
    void       loginCreatePrivateChatResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    // List of chats is requested after connection is ready, and when response is received,
    // then we report to libpurple that we are connected
    void       onChatListReady();
    // Login sequence end

    void       onIncomingMessage(td::td_api::object_ptr<td::td_api::message> message);
    void       updateChatLastMessage(td::td_api::updateChatLastMessage &lastMessage);

    void       updateUserStatus(UserId userId, td::td_api::object_ptr<td::td_api::UserStatus> status);
    void       updateUser(td::td_api::object_ptr<td::td_api::user> user);
    void       downloadProfilePhoto(const td::td_api::user &user);
    void       avatarDownloadResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       updateGroup(td::td_api::object_ptr<td::td_api::basicGroup> group);
    void       updateSupergroup(td::td_api::object_ptr<td::td_api::supergroup> group);
    void       updateChat(const td::td_api::chat *chat);
    // webOS: mirror a chat's server-side mute state onto its buddy/chat blist node as a "muted"
    // bool, which imlibpurpletransport reads to suppress notifications for muted conversations.
    void       updateChatMuteState(const td::td_api::chat &chat);
    void       updateUserInfo(const td::td_api::user &user, const td::td_api::chat *privateChat);
    void       downloadChatPhoto(const td::td_api::chat &chat);
    void       requestBasicGroupFullInfo(BasicGroupId groupId);
    void       requestSupergroupFullInfo(SupergroupId groupId);
    void       groupInfoResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       supergroupInfoResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       supergroupMembersResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       supergroupAdministratorsResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       updateGroupFull(BasicGroupId groupId, td::td_api::object_ptr<td::td_api::basicGroupFullInfo> groupInfo);
    void       updateSupergroupFull(SupergroupId groupId, td::td_api::object_ptr<td::td_api::supergroupFullInfo> groupInfo);

    void       addContactById(UserId userId, const std::string &phoneNumber, const std::string &alias,
                              const std::string &groupName);
    void       addChat(td::td_api::object_ptr<td::td_api::chat> chat);
    void       handleUserChatAction(const td::td_api::updateChatAction &updateChatAction);
    void       showUserChatAction(UserId userId, bool isTyping);
    void       addBuddySearchChatResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       importContactResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       addContactResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       addContactCreatePrivateChatResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       notifyFailedContact(const std::string &errorMessage);
    void       joinChatResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       joinGroupSearchChatResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       deleteSupergroupResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       setGroupDescriptionResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       chatActionResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);

    void       onAnimatedStickerConverted(AccountThread *arg);
    void       sendMessageCreatePrivateChatResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       uploadResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);

    void       sendMessageResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void       removeTempFile(int64_t messageId);

    void        setTwoFactorAuthResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);
    void        requestRecoveryEmailConfirmation(const std::string &emailInfo);
    static void verifyRecoveryEmail(PurpleTdClient *self, const char *code);
    void        verifyRecoveryEmailResponse(uint64_t requestId, td::td_api::object_ptr<td::td_api::Object> object);

    // webOS: imlibpurpletransport installs no request UI ops, so purple_request_input
    // (login code / 2FA password / display name) silently fails. Fall back to prompting
    // through a "Telegram" IM conversation and capturing the user's reply in
    // tgprpl_send_im -> sendMessage. This tracks which auth value we're waiting for.
    AuthInput             m_authInputPending = AuthInput::None;
    // the +E.164 being resolved by searchUserByPhoneNumber for an outgoing call; used to push a
    // clean "disconnected" state (so the Phone app card doesn't hang) if the number isn't on Telegram
    std::string           m_pendingCallPhone;
    bool                  m_pendingCallVideo = false; // video flag for m_pendingCallPhone's call

    PurpleAccount        *m_account;
    TdTransceiver         m_transceiver;
    TdAccountData         m_data;
    int32_t               m_lastAuthState = 0;
    std::vector<UserId>   m_usersForNewPrivateChats;
    // webOS perf: at first login every contact needs a private chat materialized. Doing this
    // strictly serially (one createPrivateChat per server round-trip) is very slow for large
    // contact lists. Keep a window of concurrent requests in flight instead (batching), which
    // cuts N*RTT down to ~(N/window)*RTT. m_privateChatRequestsInFlight tracks the window.
    int                   m_privateChatRequestsInFlight = 0;
    bool                  m_chatListReady = false;
    bool                  m_isProxyAdded = false;
    std::vector<PurpleRoomlist *>               m_pendingRoomLists;
    td::td_api::object_ptr<td::td_api::proxy>   m_addedProxy;
    td::td_api::object_ptr<td::td_api::addedProxies> m_proxies;

    struct ChatGap {
        ChatId    chatId;
        MessageId lastMessage;
    };
    std::vector<ChatGap> m_chatGaps;
};

#endif
