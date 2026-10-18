#include "identifiers.h"
#include <glib.h>

const UserId       UserId::invalid       = UserId(0);
const ChatId       ChatId::invalid       = ChatId(0);
const BasicGroupId BasicGroupId::invalid = BasicGroupId(0);
const SupergroupId SupergroupId::invalid = SupergroupId(0);
const SecretChatId SecretChatId::invalid = SecretChatId(0);
const MessageId    MessageId::invalid    = MessageId(0);

UserId getId(const td::td_api::user &user)
{
    return UserId(user.id_);
}

ChatId getId(const td::td_api::chat &chat)
{
    return ChatId(chat.id_);
}

BasicGroupId getId(const td::td_api::basicGroup &group)
{
    return BasicGroupId(group.id_);
}

SupergroupId getId(const td::td_api::supergroup &group)
{
    return SupergroupId(group.id_);
}

SecretChatId getId(const td::td_api::secretChat &secretChat)
{
    return SecretChatId(secretChat.id_);
}

MessageId getId(const td::td_api::message &message)
{
    return MessageId(message.id_);
}

UserId getUserId(const td::td_api::chatTypePrivate &privType)
{
    return UserId(privType.user_id_);
}

UserId getUserId(const td::td_api::chatMember &member)
{
    if (member.member_id_ && (member.member_id_->get_id() == td::td_api::messageSenderUser::ID)) {
        const td::td_api::messageSenderUser &userInfo = static_cast<const td::td_api::messageSenderUser &>(*member.member_id_);
        return UserId(userInfo.user_id_);
    }
    return UserId::invalid;
}

UserId getUserId(const td::td_api::call &call)
{
    return UserId(call.user_id_);
}

UserId getSenderUserId(const td::td_api::message &message)
{
    // webOS tdlib-1.8.x: message.sender_ -> message.sender_id_ (MessageSender)
    if (message.sender_id_ && (message.sender_id_->get_id() == td::td_api::messageSenderUser::ID))
        return UserId(static_cast<const td::td_api::messageSenderUser &>(*message.sender_id_).user_id_);
    else
        return UserId::invalid;
}

UserId getSenderUserId(const td::td_api::messageOriginUser &forwardOrigin)
{
    return UserId(forwardOrigin.sender_user_id_);
}

UserId getUserId(const td::td_api::secretChat &secretChat)
{
    return UserId(secretChat.user_id_);
}

UserId getUserId(const td::td_api::updateUserStatus &update)
{
    return UserId(update.user_id_);
}

UserId getUserId(const td::td_api::updateChatAction &update)
{
    // webOS tdlib-1.8.x: updateUserChatAction.user_id_ -> updateChatAction.sender_id_ (MessageSender)
    if (update.sender_id_ && (update.sender_id_->get_id() == td::td_api::messageSenderUser::ID))
        return UserId(static_cast<const td::td_api::messageSenderUser &>(*update.sender_id_).user_id_);
    return UserId::invalid;
}

UserId getUserId(const td::td_api::importedContacts &contacts, unsigned index)
{
    return UserId(contacts.user_ids_[index]);
}

UserId getUserId(const td::td_api::users &users, unsigned index)
{
    return UserId(users.user_ids_[index]);
}

ChatId getChatId(const td::td_api::updateChatPosition &update)
{
    return ChatId(update.chat_id_);
}

ChatId getChatId(const td::td_api::updateChatTitle &update)
{
    return ChatId(update.chat_id_);
}

ChatId getChatId(const td::td_api::messageOriginChannel &forwardOrigin)
{
    return ChatId(forwardOrigin.chat_id_);
}

ChatId getChatId(const td::td_api::message &message)
{
    return ChatId(message.chat_id_);
}

ChatId getChatId(const td::td_api::updateChatAction &update)
{
    return ChatId(update.chat_id_);
}

ChatId getChatId(const td::td_api::updateChatLastMessage &update)
{
    return ChatId(update.chat_id_);
}

ChatId getChatId(const td::td_api::updateChatNotificationSettings &update)
{
    return ChatId(update.chat_id_);
}

BasicGroupId getBasicGroupId(const td::td_api::updateBasicGroupFullInfo &update)
{
    return BasicGroupId(update.basic_group_id_);
}

BasicGroupId getBasicGroupId(const td::td_api::chatTypeBasicGroup &chatType)
{
    return BasicGroupId(chatType.basic_group_id_);
}

SupergroupId getSupergroupId(const td::td_api::updateSupergroupFullInfo &update)
{
    return SupergroupId(update.supergroup_id_);
}

SupergroupId getSupergroupId(const td::td_api::chatTypeSupergroup &chatType)
{
    return SupergroupId(chatType.supergroup_id_);
}

SecretChatId getSecretChatId(const td::td_api::chatTypeSecret &chatType)
{
    return SecretChatId(chatType.secret_chat_id_);
}

MessageId getReplyMessageId(const td::td_api::message &message)
{
    // webOS tdlib-1.8.x: message.reply_to_message_id_ -> message.reply_to_ (MessageReplyTo);
    // the concrete messageReplyToMessage carries the replied-to message id.
    if (message.reply_to_ && (message.reply_to_->get_id() == td::td_api::messageReplyToMessage::ID))
        return MessageId(static_cast<const td::td_api::messageReplyToMessage &>(*message.reply_to_).message_id_);
    return MessageId::invalid;
}
