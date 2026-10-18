/*
 *   gowhatsapp plugin for libpurple
 *   Copyright (C) 2022 Hermann Höhne
 *
 *   This program is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   This program is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU General Public License for more details.
 *
 *   You should have received a copy of the GNU General Public License
 *   along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * Apparently, the main package must be named main, even though this is a library
 */
package main

/*
#include "constants.h"
#include "bridge.h"
*/
import "C"

import (
	"context"
	"fmt"
	"net/url"
	"runtime/cgo"
	"strings"
	"time"
	"unsafe"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/types"
)

type PurpleAccount = C.PurpleAccount
type PurpleXfer = C.PurpleXfer

// TODO: find out how to enable C99's bool type in cgo
func bool_to_Cchar(b bool) C.char {
	if b {
		return C.char(1)
	} else {
		return C.char(0)
	}
}

func Cint_to_bool(i C.int) bool {
	return i != 0
}

//export gowhatsapp_go_login
func gowhatsapp_go_login(account *PurpleAccount, purple_user_dir *C.char, username *C.char, password *C.char, proxy_uri *C.char) {
	login(account, C.GoString(purple_user_dir), C.GoString(username), C.GoString(password), C.GoString(proxy_uri))
}

//export gowhatsapp_go_close
func gowhatsapp_go_close(account *PurpleAccount, purple_user_dir *C.char, username *C.char) {
	handler, ok := handlers[account]
	if ok {
		handler.close(account, C.GoString(purple_user_dir), C.GoString(username))
	}
}

//export gowhatsapp_go_logout
func gowhatsapp_go_logout(account *PurpleAccount) {
	handler, ok := handlers[account]
	if ok {
		err := handler.client.Logout(context.TODO())
		if err != nil {
			purple_error(account, fmt.Sprintf("Logout failed: %#v", err), ERROR_FATAL)
			// TODO: ask user whether they want to force Client.Disconnect() and Client.Store.Delete()
		} else {
			purple_error(account, "User requested logout.", ERROR_FATAL)
		}
	}
}

//export gowhatsapp_go_account_removed
// Fired from the libpurple "account-removed" signal (see glue/init.c) when a WhatsApp account is
// DELETED on webOS. Unlinks this device server-side (if a live client exists) and removes ONLY this
// account's row from the SHARED whatsmeow.db — never the whole file. credentials = the account's
// "credentials" setting ("deviceJID|registrationId"), used to find the exact device to delete.
func gowhatsapp_go_account_removed(account *PurpleAccount, purple_user_dir *C.char, username *C.char, credentials *C.char) {
	whatsapp_account_removed(account, C.GoString(purple_user_dir), C.GoString(username), C.GoString(credentials))
}

//export gowhatsapp_go_send_message
func gowhatsapp_go_send_message(account *PurpleAccount, who *C.char, message *C.char, is_group C.int, reply_to *C.char) int {
	handler, ok := handlers[account]
	if ok {
		// webOS replies: reply_to = the serviceMessageId (whatsmeow StanzaID) of the message this one
		// replies to, "" for a normal message. Resolved to a QuotedMessage in send_text_message.
		replyTo := C.GoString(reply_to)
		setting := purple_get_string(handler.account, C.GOWHATSAPP_ECHO_OPTION, C.GOWHATSAPP_ECHO_CHOICE_ON_SUCCESS)
		if setting == C.GoString(C.GOWHATSAPP_ECHO_CHOICE_INTERNAL) {
			// blocking mode
			if handler.send_message(C.GoString(who), C.GoString(message), Cint_to_bool(is_group), replyTo) {
				return 1 // indicate success for purple
			} else {
				return -1 // indicate error for purple
			}
		} else {
			// non-blocking mode
			go handler.send_message(C.GoString(who), C.GoString(message), Cint_to_bool(is_group), replyTo)
			if setting == C.GoString(C.GOWHATSAPP_ECHO_CHOICE_IMMEDIATELY) {
				// indicate immediate success, message is echoed back into conversation by purple
				return 1
			} else {
				// suppress message echo (settings NEVER or ON_SUCCESS)
				return 0
			}
		}
	}
	return -107 // ENOTCONN, see libpurple/prpl.h
}

//export gowhatsapp_go_send_reaction
// webOS reactions (SEND): react to a WhatsApp message. targetId = the bare whatsmeow message id
// (info.ID, no chat prefix); emoji = the reaction (ignored when removeFlag=="1"); peer = the chat JID
// the transport uses; targetSender = the reacted-to message's ORIGINAL sender (db8 fallback so we can
// build the reaction without a message-cache entry; "" if unknown); removeFlag "1" removes my reaction.
// Runs the actual send on a goroutine.
func gowhatsapp_go_send_reaction(account *PurpleAccount, targetId *C.char, emoji *C.char, peer *C.char, targetSender *C.char, removeFlag *C.char) {
	handler, ok := handlers[account]
	if !ok {
		return
	}
	remove := C.GoString(removeFlag) == "1"
	go handler.send_reaction(C.GoString(peer), C.GoString(targetId), C.GoString(emoji), C.GoString(targetSender), remove)
}

//export gowhatsapp_go_send_poll_vote
// webOS polls (SEND): vote on a poll. pollMessageId = the poll creation message's server id; peer =
// the chat JID; optionNamesJoined = the FULL current selection, "\x1f"-separated (empty string =
// clear my vote); senderJid = the poll creation message's ORIGINAL sender (db8 fallback, same as
// gowhatsapp_go_send_reaction's targetSender, so we can build the vote without a message-cache
// entry; "" if unknown). Runs the actual send on a goroutine.
func gowhatsapp_go_send_poll_vote(account *PurpleAccount, peer *C.char, pollMessageId *C.char, optionNamesJoined *C.char, senderJid *C.char) {
	handler, ok := handlers[account]
	if !ok {
		return
	}
	joined := C.GoString(optionNamesJoined)
	var optionNames []string
	if joined != "" {
		optionNames = strings.Split(joined, "\x1f")
	}
	go handler.send_poll_vote(C.GoString(peer), C.GoString(pollMessageId), optionNames, C.GoString(senderJid))
}

//export gowhatsapp_go_send_file
func gowhatsapp_go_send_file(account *PurpleAccount, who *C.char, filename *C.char) *C.char {
	err := "Not connected."
	handler, ok := handlers[account]
	if ok {
		err = handler.send_file(C.GoString(who), C.GoString(filename))
	}
	return C.CString(err)
}

//export gowhatsapp_go_download_attachment
func gowhatsapp_go_download_attachment(account *PurpleAccount, local_file_path *C.char, download_handle C.uintptr_t) *C.char {
	handler, ok := handlers[account]
	if !ok {
		// webOS: Facebook (E2EE / gometa) accounts are NOT in the WhatsApp handlers[] map -- they live in
		// gometaHandlers[]. Without this, every incoming FB image/video/document hit "Not connected." here
		// and download_attachment was NEVER called (no file, silently dropped). download_attachment's FB
		// branch resolves the media client via gometaHandlers[handler.account] and only reads
		// handler.account, so a minimal synthesized handler is sufficient for the download.
		if _, gok := gometaHandlers[account]; gok {
			handler = &Handler{account: account}
			ok = true
		}
	}
	if ok {
		h := cgo.Handle(download_handle)
		var err error = nil
		if local_file_path != nil {
			message := h.Value().(whatsmeow.DownloadableMessage)
			err = handler.download_attachment(C.GoString(local_file_path), message)
		}
		if err == nil {
			return nil
		}
		return C.CString(fmt.Sprintf("Failed to download attachment due to %v", err))
	}
	return C.CString("Not connected.")
}

//export gowhatsapp_go_delete_handle
func gowhatsapp_go_delete_handle(download_handle C.uintptr_t) {
	h := cgo.Handle(download_handle)
	h.Delete()
}

//export gowhatsapp_go_mark_read_conversation
func gowhatsapp_go_mark_read_conversation(account *PurpleAccount, who *C.char) {
	handler, ok := handlers[account]
	if ok {
		handler.mark_read_conversation(C.GoString(who))
	} else {
		// no connection, fail silently
	}
}

//export gowhatsapp_go_send_presence
func gowhatsapp_go_send_presence(account *PurpleAccount, presence *C.char) {
	handler, ok := handlers[account]
	if ok {
		handler.send_presence(C.GoString(presence))
	} else {
		purple_error(account, "Cannot set presence: Not connected.", ERROR_TRANSIENT)
	}
}

//export gowhatsapp_go_subscribe_presence
func gowhatsapp_go_subscribe_presence(account *PurpleAccount, who *C.char) {
	handler, ok := handlers[account]
	if ok {
		handler.subscribe_presence(C.GoString(who))
	} else {
		// no connection, fail silently
	}
}

func participants_to_ntcstrarray(group_participants []types.GroupParticipant) **C.char {
	participant_count := len(group_participants)
	// declare a C-array of C-strings
	var cparticipants **C.char = nil
	// allocate one extra all-zero element to denote end of C array
	cparticipants = (**C.char)(C.calloc(C.size_t(participant_count+1), C.size_t(unsafe.Sizeof(cparticipants))))
	// create a Slice "view" of the c-array
	// https://stackoverflow.com/questions/51525876/use-go-slice-in-c
	participants := unsafe.Slice((**C.char)(cparticipants), participant_count)
	for pi, participant := range group_participants {
		participants[pi] = C.CString(participant.JID.ToNonAD().String())
	}
	return cparticipants
}

//export gowhatsapp_go_query_group_participants
func gowhatsapp_go_query_group_participants(account *PurpleAccount, groupid *C.char) **C.char {
	handler, ok := handlers[account]
	if ok {
		if groupid != nil {
			go_groupid := C.GoString(groupid)
			jid, err := parseJID(go_groupid)
			// TODO: check that jid actually is a group jid, see https://github.com/hoehermann/purple-gowhatsapp/issues/195
			if err == nil {
				if jid == types.StatusBroadcastJID {
					// the status broadcast is not an actual group which participants can be queried from
				} else {
					participants := handler.query_group_participants_retry(jid, 1, 10, 0)
					participants = handler.groupChatParticipantsLidToPn(participants, "group chat participants query")
					return participants_to_ntcstrarray(participants)
				}
			} else {
				purple_error(account, fmt.Sprintf("Cannot get group information from invalid JID %s due to %#v.", go_groupid, err), ERROR_FATAL)
			}
		} else {
			purple_error(account, "Cannot get group information without group ID.", ERROR_FATAL)
		}
	} else {
		purple_error(account, "Cannot get group information: Not connected.", ERROR_TRANSIENT)
	}
	return nil
}

//export gowhatsapp_go_query_groups
func gowhatsapp_go_query_groups(account *PurpleAccount) {
	handler, ok := handlers[account]
	if ok {
		go func() {
			groups, err := handler.client.GetJoinedGroups(context.TODO())
			if err != nil {
				purple_error(account, fmt.Sprintf("Unable to get list of groups: %#v", err), ERROR_FATAL)
			} else {
				for _, group := range groups {
					group.Participants = handler.groupChatParticipantsLidToPn(group.Participants, "group chat query")
					purple_update_group(account, group)
				}
				// emit an empty group message to denote end of list
				purple_update_group(account, nil)
			}
		}()
	} else {
		purple_error(account, "Cannot get list of groups: Not connected.", ERROR_TRANSIENT)
	}
}

//export gowhatsapp_go_fetch_newsletter_history
func gowhatsapp_go_fetch_newsletter_history(account *PurpleAccount, jidStr *C.char) {
	handler, ok := handlers[account]
	if !ok || jidStr == nil {
		return
	}
	go handler.fetch_newsletter_history(C.GoString(jidStr))
}

//export gowhatsapp_go_get_contacts
func gowhatsapp_go_get_contacts(account *PurpleAccount, flush C.int) {
	handler, ok := handlers[account]
	if ok {
		go func() {
			err := handler.client.FetchAppState(context.TODO(), appstate.WAPatchCriticalUnblockLow, Cint_to_bool(flush), false)
			if err != nil {
				handler.log.Warnf("Could not fetch app state from server: %#v", err)
			}
			// even in case of error, continue with locally stored contacts
			contacts, err := handler.client.Store.Contacts.GetAllContacts(context.TODO())
			if err != nil {
				handler.log.Warnf("Could not get contacts from store: %#v", err)
			} else {
				for jid, info := range contacts {
					blocked := false
					if handler.blocklist != nil {
						// TODO find out whether locally checking the blocklist is actually necessary or if WhatsApp servers do the filtering for us
						for _, blockedJID := range handler.blocklist.JIDs {
							if blockedJID.ToNonAD() == jid {
								blocked = true
							}
						}
					}
					if blocked {
						handler.log.Infof("Ignoring contact %s since they are on the blocklist.", jid.ToNonAD().String())
						continue
					}
					handler.log.Infof("Contact: %s %#v", jid.ToNonAD().String(), info)
					cmessage := C.struct_gowhatsapp_message{
						account:   account,
						msgtype:   C.char(C.gowhatsapp_message_type_name),
						remoteJid: C.CString(jid.ToNonAD().String()),
					}
					name := info.FullName
					if name == "" {
						name = info.FirstName
					}
					if name == "" {
						name = info.BusinessName
					}
					if name == "" {
						name = info.PushName
					}
					if name != "" {
						cmessage.name = C.CString(name)
					}
					C.gowhatsapp_process_message_bridge(cmessage)
				}
				// send one "nil" contact to indicate end of list
				cmessage := C.struct_gowhatsapp_message{
					account:   account,
					msgtype:   C.char(C.gowhatsapp_message_type_name),
					remoteJid: nil,
				}
				C.gowhatsapp_process_message_bridge(cmessage)
			}
		}()
	} else {
		purple_error(account, "Cannot get contacts: Not connected.", ERROR_TRANSIENT)
	}
}

//export gowhatsapp_go_request_profile_picture
func gowhatsapp_go_request_profile_picture(account *PurpleAccount, who *C.char, picture_date *C.char, picture_id *C.char) {
	handler, ok := handlers[account]
	if ok {
		jid, err := parseJID(C.GoString(who))
		if err != nil {
			purple_error(handler.account, fmt.Sprintf("%#v", err), ERROR_FATAL)
		} else {
			handler.request_profile_picture(jid, C.GoString(picture_date), C.GoString(picture_id))
		}
	} else {
		// no connection, fail silently
	}
}

//export gowhatsapp_go_get_display_name
func gowhatsapp_go_get_display_name(account *PurpleAccount, who *C.char) *C.char {
	handler, ok := handlers[account]
	if ok {
		jid, err := parseJID(C.GoString(who))
		if err != nil {
			handler.log.Warnf("Unable to parse JID for getting display name: %#v", err)
		} else {
			info, err := handler.client.Store.Contacts.GetContact(context.TODO(), jid)
			if err != nil {
				handler.log.Warnf("Could not get contact from store for display name: %#v", err)
			} else {
				name := info.FullName
				if name == "" {
					name = info.FirstName
				}
				if name == "" {
					name = info.BusinessName
				}
				if name == "" {
					name = info.PushName
				}
				if name != "" {
					return C.CString(name)
				}
			}
		}
	} else {
		purple_error(account, "Could not get contact from store for display name: Not connected.", ERROR_TRANSIENT)
	}
	return nil
}

//export gowhatsapp_go_url_from_local_path
func gowhatsapp_go_url_from_local_path(local_path *C.char) *C.char {
	local_path_slashed := strings.ReplaceAll(C.GoString(local_path), "\\", "/") // hopefully, this will keep Windows slashes in check without breaking anything
	url := url.URL{Scheme: "file", Path: local_path_slashed}                    // TODO: use url.FromFilePath(path) once it exists
	return C.CString(url.String())
}

/*
 * This will display a QR code via PurpleRequest API
 * or in a conversation window (depending on UI features and user settings).
 */
func purple_display_qrcode(account *PurpleAccount, piring_code string, qr_data string, qr_terminal string, png []byte) {
	cmessage := C.struct_gowhatsapp_message{
		account:            account,
		msgtype:            C.char(C.gowhatsapp_message_type_login),
		pairing_code:       C.CString(piring_code),
		pairing_qrdata:     C.CString(qr_data),
		pairing_qrterminal: C.CString(qr_terminal),
		blob:               C.CBytes(png),
		blobsize:           C.size_t(len(png)),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will close the QR code shown previously.
 */
func purple_pairing_succeeded(account *PurpleAccount) {
	cmessage := C.struct_gowhatsapp_message{
		account: account,
		msgtype: C.char(C.gowhatsapp_message_type_pairing_succeeded),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will inform purple that the account has been connected.
 */
func purple_connected(account *PurpleAccount) {
	cmessage := C.struct_gowhatsapp_message{
		account: account,
		msgtype: C.char(C.gowhatsapp_message_type_connected),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will inform purple that the account has been disconnected.
 */
func purple_disconnected(account *PurpleAccount) {
	cmessage := C.struct_gowhatsapp_message{
		account: account,
		msgtype: C.char(C.gowhatsapp_message_type_disconnected),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will display a text message.
 * Single participants and group chats.
 */
func purple_display_text_message(account *PurpleAccount, remoteJid string, isGroup bool, isOutgoing bool, senderJid string, pushName *string, timestamp time.Time, text string, id *string, quotedText string, quotedFrom string, quotedId string) {
	cmessage := C.struct_gowhatsapp_message{
		account:    account,
		msgtype:    C.char(C.gowhatsapp_message_type_text),
		remoteJid:  C.CString(remoteJid),
		senderJid:  C.CString(senderJid),
		timestamp:  C.time_t(timestamp.Unix()),
		text:       C.CString(text),
		isGroup:    bool_to_Cchar(isGroup),
		isOutgoing: bool_to_Cchar(isOutgoing),
	}
	if pushName != nil {
		cmessage.name = C.CString(*pushName)
	}
	if id != nil {
		cmessage.messageId = C.CString(*id)
	}
	// webOS replies: carry the structured quote (if this message replies to another) to the C stash.
	if quotedText != "" {
		cmessage.quotedText = C.CString(quotedText)
		if quotedFrom != "" {
			cmessage.quotedFrom = C.CString(quotedFrom)
		}
		if quotedId != "" {
			cmessage.quotedId = C.CString(quotedId)
		}
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will display a system message.
 * For soft errors regarding a specific conversation.
 * Single participants and group chats.
 */
func purple_display_system_message(account *PurpleAccount, remoteJid string, isGroup bool, text string) {
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_system),
		remoteJid: C.CString(remoteJid),
		text:      C.CString(text),
		isGroup:   bool_to_Cchar(isGroup),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will update a contact's name.
 * May add them to the local buddy list.
 * Does work for individuals, not for groups.
 */
func purple_update_name(account *PurpleAccount, remoteJid string, pushName string) {
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_name),
		remoteJid: C.CString(remoteJid),
		name:      C.CString(pushName),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will create a purple file transfer for receiving an attachment.
 */
func purple_handle_attachment(account *PurpleAccount, remoteJid string, isGroup bool, senderJid string, caption string, id string, timestamp time.Time,
	data_type C.int, filename string, extension string, mimetype string, hash_hex string, length uint64, message whatsmeow.DownloadableMessage,
) {
	cmessage := C.struct_gowhatsapp_message{
		account:         account,
		msgtype:         C.char(C.gowhatsapp_message_type_attachment),
		subtype:         C.char(data_type),
		remoteJid:       C.CString(remoteJid),
		timestamp:       C.time_t(timestamp.Unix()),
		isGroup:         bool_to_Cchar(isGroup),
		senderJid:       C.CString(senderJid),
		messageId:       C.CString(id),
		filename:        C.CString(filename),
		extension:       C.CString(extension),
		mimetype:        C.CString(mimetype),
		hash_hex:        C.CString(hash_hex),
		filesize:        C.uint64_t(length),
		download_handle: C.uintptr_t(cgo.NewHandle(message)),
		text:            C.CString(caption),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * Forwards a downloaded profile picture to purple.
 */
func purple_set_profile_picture(account *PurpleAccount, who string, data []byte, picture_date string, picture_id string) {
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_profile_picture),
		remoteJid: C.CString(who),
		messageId: C.CString(picture_id),
		text:      C.CString(picture_date),
		blob:      C.CBytes(data),
		blobsize:  C.size_t(len(data)),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * webOS reactions: forward a reaction to the transport's cross-prpl "webos-im-reaction" signal
 * (emitted C-side in process_message on the libpurple main thread) instead of posting a "reacted
 * with X" message. targetId = the reacted-to message id, emoji = "" means the reaction was removed,
 * sender = who reacted. The message bridge frees the CStrings.
 */
func purple_handle_reaction(account *PurpleAccount, remoteJid string, targetId string, emoji string, sender string) {
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_reaction),
		remoteJid: C.CString(remoteJid),
		senderJid: C.CString(sender),
		messageId: C.CString(targetId),
		text:      C.CString(emoji),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * webOS outbox-id: forward the server-assigned id of a message the app just sent to the transport's
 * cross-prpl "webos-im-outbox-id" signal (emitted C-side in process_message on the libpurple main
 * thread). The transport attaches the id to the Outbox row so the user can react to their own sent
 * message. id = the message's service id, text = the message body (correlation hint). Account-agnostic:
 * used by all three send paths (WhatsApp, FB plaintext, FB E2EE). The message bridge frees the CStrings.
 */
func purple_handle_outbox_id(account *PurpleAccount, id string, text string) {
	if id == "" {
		return
	}
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_outbox_id),
		messageId: C.CString(id),
		text:      C.CString(text),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

// webOS delivery/read receipts: the recipient delivered/read one of our outgoing messages. id is the
// message's server id (== its serviceMessageId); status is "delivered" or "read". Forwarded to the
// transport's "webos-im-receipt" signal (status carried in the text field).
func purple_handle_receipt(account *PurpleAccount, id string, status string) {
	if id == "" {
		return
	}
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_receipt),
		messageId: C.CString(id),
		text:      C.CString(status),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

// webOS delivery/read receipts (WATERMARK, Facebook): the peer delivered/read everything in a thread up
// to a timestamp. scope is the transport match rule ("ts:<threadKey>"), watermark the boundary (ms
// decimal), status "delivered" or "read". Forwarded to the transport's "webos-im-receipt-hwm" signal
// (scope in remoteJid, watermark in messageId, status in text).
// purple_handle_message_edit: the sender edited a previously-sent message (targetId = that message's
// server id == serviceMessageId); newText is the new body. The transport finds the stored bubble by
// serviceMessageId and updates its text in place (rather than showing a separate "[EDIT]" message).
func purple_handle_message_edit(account *PurpleAccount, targetId string, newText string) {
	if targetId == "" {
		return
	}
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_edit),
		messageId: C.CString(targetId),
		text:      C.CString(newText),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}
// purple_handle_message_delete: the sender deleted a previously-sent message "for everyone"
// (targetId = that message's server id == serviceMessageId). The transport finds the stored bubble
// by serviceMessageId and replaces its text with a "This message was deleted." placeholder in
// place - the same find-by-serviceMessageId + merge-messageText mechanism as an edit, just with a
// canned body instead of a new one (see gowhatsapp_message_type_delete in glue/process_message.c).
func purple_handle_message_delete(account *PurpleAccount, targetId string) {
	if targetId == "" {
		return
	}
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_delete),
		messageId: C.CString(targetId),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}
func purple_handle_receipt_watermark(account *PurpleAccount, scope string, watermark string, status string) {
	if scope == "" || watermark == "" {
		return
	}
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_receipt_hwm),
		remoteJid: C.CString(scope),
		messageId: C.CString(watermark),
		text:      C.CString(status),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will inform purple that the remote user started typing.
 */
func purple_composing(account *PurpleAccount, remoteJid string) {
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_typing),
		remoteJid: C.CString(remoteJid),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will inform purple that the remote user stopped typing.
 */
func purple_paused(account *PurpleAccount, remoteJid string) {
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_typing_stopped),
		remoteJid: C.CString(remoteJid),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will inform purple that the remote user's presence (online/offline) changed.
 */
func purple_update_presence(account *PurpleAccount, remoteJid string, online bool, lastSeen time.Time) {
	timestamp := C.time_t(0)
	if !lastSeen.IsZero() {
		timestamp = C.time_t(lastSeen.Unix())
	}
	cmessage := C.struct_gowhatsapp_message{
		account:   account,
		msgtype:   C.char(C.gowhatsapp_message_type_presence),
		remoteJid: C.CString(remoteJid),
		timestamp: timestamp,
		subtype:   bool_to_Cchar(online),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * Print debug information via purple.
 */
func purple_debug(loglevel int, message string) {
	cmessage := C.struct_gowhatsapp_message{
		msgtype: C.char(C.gowhatsapp_message_type_log),
		subtype: C.char(loglevel),
		text:    C.CString(message),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

const (
	ERROR_TRANSIENT = false
	ERROR_FATAL     = true
)

/*
 * Forward error to purple. This will cause a disconnect.
 */
func purple_error(account *PurpleAccount, message string, fatal bool) {
	fatality := 0
	if fatal {
		fatality = 1
	}
	cmessage := C.struct_gowhatsapp_message{
		account: account,
		msgtype: C.char(C.gowhatsapp_message_type_error),
		text:    C.CString(message),
		subtype: C.char(fatality),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * Get int from the purple account's settings.
 */
func purple_get_int(account *PurpleAccount, key *C.char, default_value int) int {
	if C.gowhatsapp_account_exists(account) == 1 {
		return int(C.purple_account_get_int(account, key, C.int(default_value)))
	}
	return default_value
}

/*
 * Get bool from the purple account's settings.
 */
func purple_get_bool(account *PurpleAccount, key *C.char, default_value bool) bool {
	if C.gowhatsapp_account_exists(account) == 1 {
		return Cint_to_bool(C.purple_account_get_bool(account, key, C.int(bool_to_Cchar(default_value))))
	}
	return default_value
}

/*
 * Get string from the purple account's settings.
 */
func purple_get_string(account *PurpleAccount, key *C.char, default_value *C.char) string {
	if C.gowhatsapp_account_exists(account) == 1 {
		return C.GoString(C.purple_account_get_string(account, key, default_value))
	}
	return C.GoString(default_value)
}

/*
 * Gets the alias of the contact.
 *
 * In case no alias is found, returns the input jid string.
 */
func purple_get_alias(account *PurpleAccount, jid string) string {
	var c_alias *C.char = nil
	if C.gowhatsapp_account_exists(account) == 1 {
		who := C.CString(jid)
		defer C.free(unsafe.Pointer(who))
		c_alias = C.gowhatsapp_blist_get_alias(account, who)
	}
	if c_alias == nil {
		return jid
	} else {
		return C.GoString(c_alias)
	}
}

/*
 * Forward credential string to purple.
 */
func purple_set_credentials(account *PurpleAccount, credentials string) {
	cmessage := C.struct_gowhatsapp_message{
		account: account,
		text:    C.CString(credentials),
		msgtype: C.char(C.gowhatsapp_message_type_credentials),
	}
	C.gowhatsapp_process_message_bridge(cmessage)
}

/*
 * This will forward group information to purple.
 */
func purple_update_group(account *PurpleAccount, group *types.GroupInfo) {
	if group != nil {
		cmessage := C.struct_gowhatsapp_message{
			account:   account,
			msgtype:   C.char(C.gowhatsapp_message_type_group),
			remoteJid: C.CString(group.JID.ToNonAD().String()),
			name:      C.CString(group.Name),
		}
		cmessage.participants = participants_to_ntcstrarray(group.Participants)
		C.gowhatsapp_process_message_bridge(cmessage)
	} else {
		C.gowhatsapp_process_message_bridge(C.struct_gowhatsapp_message{
			account: account,
			msgtype: C.char(C.gowhatsapp_message_type_group),
		})
	}
}

func purple_get_device_name(account *PurpleAccount) string {
	c_device_name := C.CString(fmt.Sprintf("purple-whatsmeow on %s", C.GoString(C.g_get_host_name())))
	defer C.free(unsafe.Pointer(c_device_name))
	return purple_get_string(account, C.GOWHATSAPP_DEVICE_NAME_OPTION, c_device_name)
}

func main() {
}
