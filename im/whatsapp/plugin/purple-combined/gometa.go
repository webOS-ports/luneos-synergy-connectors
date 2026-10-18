// gometa.go — the Facebook (messagix) half of the combined plugin. Shares ONE Go runtime
// with the whatsmeow code (same package main). All package-level identifiers are gometa*-
// prefixed to avoid clashing with whatsmeow's login/handlers/Handler/reportError.
//
// Login is email + password + interactive 2FA (messagix MessengerLite/Bloks DoLoginSteps),
// NOT a pasted cookie blob: the account's username is the email, its password is the FB
// password, and any 2FA/captcha step is prompted via purple_request_input. On success the
// session cookies are cached in the account (setting "gometa_session") so later logins skip
// the password/2FA entirely.
package main

/*
#include "gometabridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/methods"
	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
	"maunium.net/go/mautrix/bridgev2"
)

const gometaSessionSetting = "gometa_session"

// ---- exported prpl callbacks (wired from the C glue's second prpl) ----

//export gometa_go_login
func gometa_go_login(account *PurpleAccount, purpleUserDir *C.char, username *C.char, password *C.char, proxy *C.char) {
	gometaLogin(account, C.GoString(purpleUserDir), C.GoString(username), C.GoString(password), C.GoString(proxy))
}

//export gometa_go_close
func gometa_go_close(account *PurpleAccount) {
	if h, ok := gometaHandlers[account]; ok {
		h.close()
	}
}

//export gometa_go_account_removed
// Fired from the libpurple "account-removed" signal (see glue/init.c) when a Facebook-E2EE account is
// DELETED on webOS. Closes any live client and deletes ONLY this account's per-account E2EE store.
func gometa_go_account_removed(account *PurpleAccount, purpleUserDir *C.char, username *C.char) {
	gometaAccountRemoved(account, C.GoString(purpleUserDir), C.GoString(username))
}

// gometaAccountRemoved tears down a deleted Facebook-E2EE account: it closes any live messagix + E2EE
// (whatsmeow) client for THIS account, then deletes only this account's per-account E2EE store
// (gometa-e2ee-<username>.db and its -wal/-shm sidecars). The DB path embeds the account username
// (the FB email, exactly as connectE2EE builds it), so removal is strictly scoped to this account and
// never touches another account's store. Unlike WhatsApp's shared whatsmeow.db, this per-account file
// is safe to delete whole. (The messagix E2EE whatsmeow client has MessengerConfig set, so it cannot
// Logout() server-side — deleting the local Signal store is the correct teardown here.)
func gometaAccountRemoved(account *PurpleAccount, purpleUserDir, username string) {
	if h, ok := gometaHandlers[account]; ok {
		h.close() // disconnect e2ee + messagix client, cancel ctx, drop from registry
	}
	if username == "" {
		return
	}
	dbPath := filepath.Join(purpleUserDir, "gometa-e2ee-"+username+".db")
	for _, p := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			// Best-effort: log to stderr only. Do NOT route through gometaReportError/gometa_process_message
			// here — those defer a dispatch (purple_timeout_add) that reads the account pointer, but the
			// account is destroyed synchronously right after this "account-removed" signal returns.
			fmt.Fprintf(os.Stderr, "gometa: could not remove E2EE store %s: %v\n", p, err)
		}
	}
}

//export gometa_go_send_message
func gometa_go_send_message(account *PurpleAccount, who *C.char, message *C.char, reply_to *C.char) C.int {
	// During interactive login the 2FA prompt is shown in a "Facebook" auth chat (imlibpurple
	// has no request-input UI-op, so purple_request_input can't surface). The user replies with
	// the code in that chat; if an input prompt is pending for this account, capture the reply
	// as the code instead of sending it as a real message.
	gometaInputMu.Lock()
	ch := gometaInputWaiters[account]
	gometaInputMu.Unlock()
	if ch != nil {
		select {
		case ch <- strings.TrimSpace(C.GoString(message)):
		default:
		}
		return 1
	}
	h, ok := gometaHandlers[account]
	if !ok {
		return 0
	}
	go h.sendMessage(C.GoString(who), C.GoString(message), C.GoString(reply_to))
	return 1
}

//export gometa_go_send_reaction
// webOS reactions (SEND): react to a Facebook message. targetId = the FB MessageId (plaintext) or the
// numeric whatsmeow message id (E2EE); emoji = the reaction (ignored when removeFlag=="1"); peer = the
// thread key; removeFlag "1" removes my reaction. Routes plaintext vs E2EE by e2eeContacts, like
// sendMessage.
func gometa_go_send_reaction(account *PurpleAccount, targetId *C.char, emoji *C.char, peer *C.char, removeFlag *C.char) {
	h, ok := gometaHandlers[account]
	if !ok {
		return
	}
	remove := C.GoString(removeFlag) == "1"
	go h.sendReaction(C.GoString(peer), C.GoString(targetId), C.GoString(emoji), remove)
}

//export gometa_go_submit_input
// The UI's answer to an interactive login prompt (2FA/captcha code). Empty = cancelled.
func gometa_go_submit_input(account *PurpleAccount, value *C.char) {
	gometaInputMu.Lock()
	ch := gometaInputWaiters[account]
	gometaInputMu.Unlock()
	if ch != nil {
		select {
		case ch <- C.GoString(value):
		default:
		}
	}
}

// ---- interactive-input plumbing (2FA/captcha) ----

var (
	gometaInputMu      sync.Mutex
	gometaInputWaiters = make(map[*PurpleAccount]chan string)
)

// promptInput asks the UI for a value and blocks (on a goroutine) until submitted.
func (h *gometaHandler) promptInput(prompt string) string {
	ch := make(chan string, 1)
	gometaInputMu.Lock()
	gometaInputWaiters[h.account] = ch
	gometaInputMu.Unlock()
	defer func() {
		gometaInputMu.Lock()
		delete(gometaInputWaiters, h.account)
		gometaInputMu.Unlock()
	}()
	cPrompt := C.CString(prompt)
	C.gometa_request_input(h.account, cPrompt) // schedules purple_request_input on the main thread
	C.free(unsafe.Pointer(cPrompt))
	select {
	case v := <-ch:
		return v
	case <-h.ctx.Done():
		return ""
	}
}

// ---- account settings helpers ----

func gometaGetSetting(account *PurpleAccount, key string) string {
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))
	cVal := C.gometa_get_setting(account, cKey)
	if cVal == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(cVal))
	return C.GoString(cVal)
}

func gometaSetSetting(account *PurpleAccount, key, value string) {
	cKey := C.CString(key)
	cVal := C.CString(value)
	defer C.free(unsafe.Pointer(cKey))
	defer C.free(unsafe.Pointer(cVal))
	C.gometa_set_setting(account, cKey, cVal)
}

// ---- handler ----

var gometaHandlers = make(map[*PurpleAccount]*gometaHandler)

type gometaHandler struct {
	account  *PurpleAccount
	username string
	client   *messagix.Client
	logger   zerolog.Logger
	ctx      context.Context
	cancel   context.CancelFunc
	selfID   int64

	purpleUserDir string

	mu          sync.Mutex
	threadGroup map[int64]bool   // thread key -> is a group chat
	contactName map[int64]string // fbid -> display name
	sentOtids   map[int64]bool   // otids we sent ourselves, to drop their server echo

	// E2EE (whatsmeow) — Messenger encrypted threads ride WhatsApp's Signal transport.
	e2ee         *whatsmeow.Client
	e2eeContacts map[int64]bool // fbids known to use E2EE (learned from encrypted messages)
	// Per encrypted-message metadata (message id -> who sent it). Needed to build the MessageKey when
	// reacting over E2EE (whatsmeow's ReactionMessage requires the original message's FromMe/sender,
	// which isn't otherwise recorded per-message). Populated on both send and receive of E2EE messages.
	e2eeMsgMeta map[string]e2eeMsgInfo
}

type e2eeMsgInfo struct {
	fromMe bool
	sender string // fbid of the original message's sender
	text   string // webOS replies: the message body, so a reply quoting this id can show its text
}

func (h *gometaHandler) eventHandler(ctx context.Context, rawEvt any) {
	switch evt := rawEvt.(type) {
	case *messagix.Event_Ready:
		h.logger.Info().Bool("new_session", evt.IsNewSession).Msg("connected (CONNACK)")
		h.notify(C.gometa_message_type_connected, "", "", 0)
	case *messagix.Event_Reconnected:
		h.notify(C.gometa_message_type_connected, "", "", 0)
	case *messagix.Event_SocketError:
		h.logger.Warn().Err(evt.Err).Int("attempts", evt.ConnectionAttempts).Msg("socket error")
	case *messagix.Event_PermanentError:
		h.notifyError(fmt.Sprintf("Facebook connection failed: %v", evt.Err), true)
	case *messagix.Event_PublishResponse:
		h.parseTable(evt.Table)
	default:
		h.logger.Trace().Str("type", fmt.Sprintf("%T", rawEvt)).Msg("unhandled event")
	}
}

// sendMessage sends a text message to a thread. `who` is the thread key: for a 1:1 chat it's the
// recipient's fbid (send_im buddy id); for a group it's the thread key resolved from the chat
// conversation name (see gometa_chat_send). Non-E2EE send via the messagix SendMessageTask; E2EE
// threads are a later milestone (PrepareE2EEClient/whatsmeow).
func (h *gometaHandler) sendMessage(who, text, replyTo string) {
	threadID, err := strconv.ParseInt(who, 10, 64)
	if err != nil {
		h.notifyError(fmt.Sprintf("Cannot send: invalid recipient %q", who), false)
		return
	}
	if h.client == nil {
		h.notifyError("Cannot send: Facebook not connected", false)
		return
	}
	// Encrypted threads must go over the whatsmeow (E2EE) transport — a plaintext task to an
	// E2EE thread is silently rejected by Facebook (HandleInvalidSendToOpen).
	h.mu.Lock()
	isE2EE := h.e2eeContacts[threadID]
	h.mu.Unlock()
	if isE2EE {
		if h.e2ee == nil {
			h.notifyError("Cannot send: this is an encrypted thread and E2EE isn't connected yet", false)
			return
		}
		if err := h.sendE2EE(threadID, text, replyTo); err != nil {
			h.logger.Warn().Err(err).Int64("thread", threadID).Msg("e2ee send failed")
			h.notifyError(fmt.Sprintf("Failed to send encrypted message: %v", err), false)
			return
		}
		h.logger.Info().Int64("thread", threadID).Msg("e2ee message sent")
		return
	}
	ctx, cancel := context.WithTimeout(h.ctx, 30*time.Second)
	defer cancel()
	if werr := h.client.WaitUntilCanSendMessages(ctx, 20*time.Second); werr != nil {
		h.notifyError(fmt.Sprintf("Cannot send yet (connecting): %v", werr), false)
		return
	}
	otid := methods.GenerateEpochID()
	h.mu.Lock()
	h.sentOtids[otid] = true
	h.mu.Unlock()
	task := &socket.SendMessageTask{
		ThreadId:         threadID,
		Otid:             otid,
		Source:           table.MESSENGER_INBOX_IN_THREAD,
		InitiatingSource: table.FACEBOOK_INBOX,
		SendType:         table.TEXT,
		SyncGroup:        1,
		Text:             text,
	}
	// webOS replies: thread the reply on the network so other clients link it to the original.
	if replyTo != "" {
		task.ReplyMetaData = &socket.ReplyMetaData{ReplyMessageId: replyTo, ReplySourceType: 1, ReplyType: 0}
	}
	resp, err := h.client.ExecuteTasks(ctx, task)
	if err != nil {
		h.logger.Warn().Err(err).Int64("thread", threadID).Msg("send failed")
		h.notifyError(fmt.Sprintf("Failed to send Facebook message: %v", err), false)
		return
	}
	// A successful send echoes our OTID back in LSReplaceOptimsiticMessage. If it's absent, Facebook
	// rejected the plaintext send — almost always because the thread is actually E2EE (the
	// HandleInvalidSendToOpen case). Auto-retry over the encrypted transport and remember it.
	otidStr := strconv.FormatInt(otid, 10)
	confirmed := false
	serverMsgID := ""
	if resp != nil {
		for _, r := range resp.LSReplaceOptimsiticMessage {
			if r.OfflineThreadingId == otidStr {
				confirmed = true
				serverMsgID = r.MessageId // the FB MessageId matching our otid
				break
			}
		}
	}
	if confirmed {
		h.logger.Info().Int64("thread", threadID).Msg("message sent")
		// webOS outbox-id: hand the server-assigned FB MessageId to the transport so this app-sent
		// message's Outbox row becomes reactable (react-to-your-own-message).
		if serverMsgID != "" {
			purple_handle_outbox_id(h.account, serverMsgID, text)
		}
		return
	}
	h.mu.Lock()
	delete(h.sentOtids, otid) // no echo will come for a rejected send
	h.mu.Unlock()
	h.logger.Warn().Int64("thread", threadID).Msg("plaintext send not confirmed; treating thread as E2EE")
	if h.e2ee == nil {
		h.notifyError("Couldn't send — this looks like an encrypted thread and E2EE isn't connected yet.", false)
		return
	}
	h.mu.Lock()
	h.e2eeContacts[threadID] = true
	h.mu.Unlock()
	if eerr := h.sendE2EE(threadID, text, replyTo); eerr != nil {
		h.logger.Warn().Err(eerr).Int64("thread", threadID).Msg("e2ee retry failed")
		h.notifyError(fmt.Sprintf("Failed to send encrypted message: %v", eerr), false)
		return
	}
	h.logger.Info().Int64("thread", threadID).Msg("e2ee message sent (after plaintext rejection)")
}

// sendReaction sends (or removes, when reaction is empty) a reaction to a Facebook message. Plaintext
// threads use the messagix SendReactionTask; encrypted threads route over the whatsmeow transport
// (sendReactionE2EE), mirroring sendMessage's plaintext-vs-E2EE split.
func (h *gometaHandler) sendReaction(peer, targetID, emoji string, remove bool) {
	threadID, err := strconv.ParseInt(peer, 10, 64)
	if err != nil {
		h.notifyError(fmt.Sprintf("Cannot react: invalid recipient %q", peer), false)
		return
	}
	reaction := emoji
	if remove {
		reaction = ""
	}
	h.mu.Lock()
	isE2EE := h.e2eeContacts[threadID]
	h.mu.Unlock()
	if isE2EE {
		if h.e2ee == nil {
			h.notifyError("Cannot react: this is an encrypted thread and E2EE isn't connected yet", false)
			return
		}
		if err := h.sendReactionE2EE(threadID, targetID, reaction); err != nil {
			h.logger.Warn().Err(err).Int64("thread", threadID).Msg("e2ee reaction failed")
		}
		return
	}
	if h.client == nil {
		h.notifyError("Cannot react: Facebook not connected", false)
		return
	}
	ctx, cancel := context.WithTimeout(h.ctx, 30*time.Second)
	defer cancel()
	if werr := h.client.WaitUntilCanSendMessages(ctx, 20*time.Second); werr != nil {
		h.notifyError(fmt.Sprintf("Cannot react yet (connecting): %v", werr), false)
		return
	}
	task := &socket.SendReactionTask{
		ThreadKey: threadID,
		MessageID: targetID,
		ActorID:   h.selfID,
		Reaction:  reaction,
		SyncGroup: 1,
	}
	if _, err := h.client.ExecuteTasks(ctx, task); err != nil {
		h.logger.Warn().Err(err).Int64("thread", threadID).Msg("reaction send failed")
		h.notifyError(fmt.Sprintf("Failed to send reaction: %v", err), false)
	}
}

func (h *gometaHandler) close() {
	if h.cancel != nil {
		h.cancel()
	}
	if h.e2ee != nil {
		h.e2ee.Disconnect()
	}
	if h.client != nil {
		h.client.Disconnect()
	}
	delete(gometaHandlers, h.account)
}

func (h *gometaHandler) notify(msgtype C.int, who, text string, ts int64) {
	msg := C.gometa_message_t{account: h.account, msgtype: C.char(msgtype), timestamp: C.time_t(ts)}
	if who != "" {
		msg.who = C.CString(who)
	}
	if text != "" {
		msg.text = C.CString(text)
	}
	C.gometa_process_message(msg)
}

func (h *gometaHandler) notifyError(text string, fatal bool) {
	gometaReportError(h.account, text, fatal)
}

func gometaReportError(account *PurpleAccount, text string, fatal bool) {
	msg := C.gometa_message_t{account: account, msgtype: C.char(C.gometa_message_type_error), text: C.CString(text)}
	if fatal {
		msg.fatal = 1
	}
	C.gometa_process_message(msg)
}

// ---- LSTable -> purple (contacts, group chats, incoming messages) ----

// parseTable translates a Facebook LSTable (from the initial load or a realtime publish) into
// buddies, group chats and messages. Called from the login goroutine and event goroutines, so
// the shared maps are mutex-guarded.
func (h *gometaHandler) parseTable(tbl *table.LSTable) {
	if tbl == nil {
		return
	}
	// Full contact rows.
	for _, c := range tbl.LSDeleteThenInsertContact {
		h.addContact(c.Id, c.Name)
	}
	// Referenced contacts (arrive when a thread/message names someone); skip our own row.
	for _, c := range tbl.LSVerifyContactRowExists {
		if c.IsSelf {
			continue
		}
		h.addContact(c.ContactId, c.Name)
	}
	// Threads: a 1:1 thread's ThreadKey IS the other user's fbid (ThreadName = their name),
	// so it becomes a buddy; a group thread becomes a chat.
	for _, t := range tbl.LSDeleteThenInsertThread {
		if t.ThreadKey == 0 {
			continue
		}
		isGroup := !t.ThreadType.IsOneToOne()
		h.mu.Lock()
		h.threadGroup[t.ThreadKey] = isGroup
		// Threads already typed as "encrypted over WA" are E2EE — flag them so sends route
		// over the whatsmeow transport without waiting to receive an encrypted message first.
		if t.ThreadType.IsWhatsApp() {
			h.e2eeContacts[t.ThreadKey] = true
		}
		h.mu.Unlock()
		if isGroup {
			h.notifyChat(t.ThreadKey, t.ThreadName)
		} else {
			h.addContact(t.ThreadKey, t.ThreadName)
		}
	}
	// Group participants become buddies too.
	for _, p := range tbl.LSAddParticipantIdToGroupThread {
		h.addContact(p.ContactId, p.Nickname)
	}
	// Contact presence (online/offline). Status 0 = offline; non-zero = active/available.
	for _, p := range tbl.LSDeleteThenInsertContactPresence {
		if p.ContactId == 0 {
			continue
		}
		h.notifyPresence(p.ContactId, p.Status != 0)
	}
	for _, m := range tbl.LSInsertMessage {
		h.handleMessage(m.ThreadKey, m.SenderId, m.Text, m.OfflineThreadingId, m.MessageId, m.TimestampMs)
	}
	for _, m := range tbl.LSUpsertMessage {
		h.handleMessage(m.ThreadKey, m.SenderId, m.Text, m.OfflineThreadingId, m.MessageId, m.TimestampMs)
	}
	// webOS reactions: attach a reaction to its TARGET message (by MessageId) via the shared
	// "webos-im-reaction" signal instead of a separate message. Facebook sends these as both V1 and
	// V2 tables; add/change carries the emoji, delete removes it (emoji "").
	for _, r := range tbl.LSUpsertReaction {
		h.notifyReaction(r.ThreadKey, r.MessageId, r.ActorId, r.Reaction)
	}
	for _, r := range tbl.LSUpdateOrInsertReactionV2 {
		h.notifyReaction(r.ThreadKey, r.MessageID, r.ReactionFBID, r.ReactionLiteral)
	}
	for _, r := range tbl.LSDeleteReaction {
		h.notifyReaction(r.ThreadKey, r.MessageId, r.ActorId, "")
	}
	for _, r := range tbl.LSDeleteReactionV2 {
		h.notifyReaction(r.ThreadKey, r.MessageID, r.ReactionFBID, "")
	}
	// webOS delivery/read receipts: the peer delivered/read our outgoing messages up to a per-thread
	// watermark timestamp (Facebook has no per-message receipt). Emit a watermark scoped by ThreadKey
	// (== the recipient's fbid / the outbox row's to.addr for a 1:1 thread); the transport marks every
	// outgoing message whose timestamp is at/under it. Skip our own read position (ContactId == self).
	for _, r := range tbl.LSUpdateReadReceipt {
		if r.ContactId == h.selfID || r.ThreadKey == 0 || r.ReadWatermarkTimestampMs == 0 {
			continue
		}
		purple_handle_receipt_watermark(h.account, "ts:"+strconv.FormatInt(r.ThreadKey, 10),
			strconv.FormatInt(r.ReadWatermarkTimestampMs, 10), "read")
	}
	for _, r := range tbl.LSUpdateDeliveryReceipt {
		if r.ContactId == h.selfID || r.ThreadKey == 0 || r.DeliveredWatermarkTimestampMs == 0 {
			continue
		}
		purple_handle_receipt_watermark(h.account, "ts:"+strconv.FormatInt(r.ThreadKey, 10),
			strconv.FormatInt(r.DeliveredWatermarkTimestampMs, 10), "delivered")
	}
}

// addContact records a display name and adds/updates the buddy, skipping empty ids and self.
func (h *gometaHandler) addContact(id int64, name string) {
	if id == 0 || id == h.selfID {
		return
	}
	h.mu.Lock()
	if name != "" {
		h.contactName[id] = name
	}
	h.mu.Unlock()
	h.notifyBuddy(id, name)
}

func (h *gometaHandler) handleMessage(threadKey, senderID int64, text, offlineThreadingID, messageID string, tsMs int64) {
	if text == "" || threadKey == 0 {
		return
	}
	// Drop the server echo of a message we just sent from here (the transport already recorded it).
	if offlineThreadingID != "" {
		if otid, err := strconv.ParseInt(offlineThreadingID, 10, 64); err == nil {
			h.mu.Lock()
			mine := h.sentOtids[otid]
			delete(h.sentOtids, otid)
			h.mu.Unlock()
			if mine {
				return
			}
		}
	}
	h.mu.Lock()
	isGroup := h.threadGroup[threadKey]
	name := h.contactName[senderID]
	partnerName := h.contactName[threadKey]
	h.mu.Unlock()
	// For a 1:1 thread the ThreadKey is the conversation partner's fbid — make sure they exist
	// as a buddy even if we never saw a thread/contact row for them.
	if !isGroup {
		h.addContact(threadKey, partnerName)
	}
	h.notifyMessage(strconv.FormatInt(threadKey, 10), strconv.FormatInt(senderID, 10),
		name, text, messageID, tsMs/1000, isGroup, senderID == h.selfID, "", "", "")
}

// webOS reactions: forward a Facebook reaction to the shared "webos-im-reaction" signal (via the
// account-agnostic purple_handle_reaction) so it attaches to the target message. emoji "" = removed.
func (h *gometaHandler) notifyReaction(threadKey int64, messageID string, actorID int64, emoji string) {
	if messageID == "" {
		return
	}
	purple_handle_reaction(h.account, strconv.FormatInt(threadKey, 10), messageID,
		emoji, strconv.FormatInt(actorID, 10))
}

func (h *gometaHandler) notifyBuddy(id int64, name string) {
	msg := C.gometa_message_t{account: h.account, msgtype: C.char(C.gometa_message_type_buddy)}
	msg.who = C.CString(strconv.FormatInt(id, 10))
	if name != "" {
		msg.name = C.CString(name)
	}
	C.gometa_process_message(msg)
}

func (h *gometaHandler) notifyPresence(fbid int64, online bool) {
	msg := C.gometa_message_t{account: h.account, msgtype: C.char(C.gometa_message_type_presence)}
	msg.who = C.CString(strconv.FormatInt(fbid, 10))
	if online {
		msg.isOutgoing = 1
	}
	C.gometa_process_message(msg)
}

func (h *gometaHandler) notifyChat(threadKey int64, name string) {
	msg := C.gometa_message_t{account: h.account, msgtype: C.char(C.gometa_message_type_chat)}
	msg.conv = C.CString(strconv.FormatInt(threadKey, 10))
	if name != "" {
		msg.name = C.CString(name)
	}
	C.gometa_process_message(msg)
}

func (h *gometaHandler) notifyMessage(conv, who, name, text, messageID string, ts int64, isGroup, isOutgoing bool, quotedText, quotedFrom, quotedId string) {
	msg := C.gometa_message_t{account: h.account, msgtype: C.char(C.gometa_message_type_text), timestamp: C.time_t(ts)}
	msg.conv = C.CString(conv)
	msg.who = C.CString(who)
	if name != "" {
		msg.name = C.CString(name)
	}
	msg.text = C.CString(text)
	// webOS reactions: carry the Facebook MessageId so the bridge can stash it on the conversation
	// -> stored as serviceMessageId, which a later reaction (LSUpsertReaction.MessageId) targets.
	if messageID != "" {
		msg.id = C.CString(messageID)
	}
	// webOS replies: carry the quoted-original (if this message is a reply) to the C stash.
	if quotedText != "" {
		msg.quotedText = C.CString(quotedText)
		if quotedFrom != "" {
			msg.quotedFrom = C.CString(quotedFrom)
		}
		if quotedId != "" {
			msg.quotedId = C.CString(quotedId)
		}
	}
	if isGroup {
		msg.isGroup = 1
	}
	if isOutgoing {
		msg.isOutgoing = 1
	}
	C.gometa_process_message(msg)
}

// ---- login ----

func gometaLogin(account *PurpleAccount, purpleUserDir, email, password, proxy string) {
	if _, ok := gometaHandlers[account]; ok {
		gometaReportError(account, "This connection already exists.", true)
		return
	}
	logger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.Kitchen}).
		With().Str("account", email).Timestamp().Logger()
	ctx, cancel := context.WithCancel(context.Background())
	h := &gometaHandler{
		account: account, username: email, logger: logger, ctx: ctx, cancel: cancel,
		purpleUserDir: purpleUserDir,
		threadGroup:   make(map[int64]bool), contactName: make(map[int64]string),
		sentOtids:    make(map[int64]bool),
		e2eeContacts: make(map[int64]bool),
		e2eeMsgMeta:  make(map[string]e2eeMsgInfo),
	}
	gometaHandlers[account] = h

	go func() {
		ck, err := h.obtainCookies(email, password)
		if err != nil {
			h.notifyError(fmt.Sprintf("Facebook login failed: %v", err), true)
			return
		}
		h.selfID = ck.GetUserID()
		client := messagix.NewClient(ck, logger, &messagix.Config{})
		h.client = client
		client.SetEventHandler(h.eventHandler)

		loadCtx, loadCancel := context.WithTimeout(ctx, 90*time.Second)
		user, tbl, err := client.LoadMessagesPage(loadCtx)
		loadCancel()
		if err != nil {
			// cached cookies may have expired — drop them so the next attempt re-does credentials
			gometaSetSetting(account, gometaSessionSetting, "")
			h.notifyError(fmt.Sprintf("Facebook load failed (session may have expired, try again): %v", err), true)
			return
		}
		h.logger.Info().Str("name", user.GetName()).Msg("authenticated")
		// Buddies come from the tables themselves (threads, participants, contact rows) — Messenger
		// does not hand over a bulk friend list on login (the search task 452 times out), so we
		// mirror mautrix-meta and create contacts lazily from every table we receive, here and in
		// the realtime publish stream (see parseTable + eventHandler).
		h.parseTable(tbl)
		if err := client.Connect(ctx); err != nil {
			h.notifyError(fmt.Sprintf("Facebook connect failed: %v", err), true)
			return
		}
		// Bring up the E2EE (whatsmeow) transport so encrypted threads can send/receive.
		// Non-fatal: plaintext threads keep working even if this fails.
		if err := h.connectE2EE(ck.GetUserID()); err != nil {
			h.logger.Warn().Err(err).Msg("E2EE setup failed (encrypted threads unavailable)")
		}
	}()
}

// obtainCookies returns a usable messagix session: cached cookies if present, otherwise the
// email/password login. For two-factor it AUTO-SELECTS "Notification on another device"
// (login approval — no typed code; you approve on your phone) and waits. Code-based methods
// (authenticator/SMS/email/backup) are not supported yet (they'd need an interactive prompt
// the webOS transport can't surface) and abort with a clear message — NEVER loop.
func (h *gometaHandler) obtainCookies(email, password string) (*cookies.Cookies, error) {
	// 1) cached session
	if blob := gometaGetSetting(h.account, gometaSessionSetting); blob != "" {
		ck := &cookies.Cookies{Platform: types.Facebook}
		if err := json.Unmarshal([]byte(blob), ck); err == nil && ck.IsLoggedIn() {
			h.logger.Info().Msg("using cached Facebook session")
			return ck, nil
		}
	}
	if email == "" || password == "" {
		return nil, fmt.Errorf("enter your Facebook email and password")
	}
	// Bound the whole login so an unapproved login-approval can't wait forever.
	ctx, cancel := context.WithTimeout(h.ctx, 5*time.Minute)
	defer cancel()

	loginClient := messagix.NewClient(&cookies.Cookies{Platform: types.MessengerLite}, h.logger, &messagix.Config{})
	var userInput map[string]string
	credsSent := false
	for iter := 0; iter < 40; iter++ { // hard loop guard
		step, newCookies, err := loginClient.MessengerLite.DoLoginSteps(ctx, userInput)
		if err != nil {
			return nil, err
		}
		if step == nil { // login complete
			if newCookies == nil {
				return nil, fmt.Errorf("login returned no session")
			}
			ck := &cookies.Cookies{Platform: types.Facebook}
			ck.UpdateValues(newCookies.GetAll())
			if b, e := json.Marshal(ck); e == nil {
				gometaSetSetting(h.account, gometaSessionSetting, string(b))
			}
			return ck, nil
		}
		switch step.Type {
		case bridgev2.LoginStepTypeDisplayAndWait:
			// Login approval: Facebook sent a notification to your other device. The next
			// DoLoginSteps call blocks (polling on a timer) until you approve — not a busy loop.
			h.logger.Info().Str("info", step.Instructions).Msg("waiting for login approval on your other device")
			userInput = nil
		case bridgev2.LoginStepTypeUserInput:
			ui, err := h.fillLoginStep(step, email, password, &credsSent)
			if err != nil {
				return nil, err // can't fill (code method / rejected creds) -> abort, do not loop
			}
			userInput = ui
		default:
			return nil, fmt.Errorf("unsupported Facebook login step %q", step.Type)
		}
	}
	return nil, fmt.Errorf("Facebook login did not complete")
}

// fillLoginStep builds the submit map: email/password from the account, 2FA method auto-set
// to login-approval. Returns an error (which aborts the login) for anything requiring a typed
// code, so we never spin on a prompt that can't be shown.
func (h *gometaHandler) fillLoginStep(step *bridgev2.LoginStep, email, password string, credsSent *bool) (map[string]string, error) {
	out := map[string]string{}
	if step.UserInputParams == nil {
		return out, nil
	}
	for _, f := range step.UserInputParams.Fields {
		switch f.Type {
		case bridgev2.LoginInputFieldTypeEmail, bridgev2.LoginInputFieldTypeUsername, bridgev2.LoginInputFieldTypePhoneNumber:
			if *credsSent {
				return nil, fmt.Errorf("Facebook rejected the email/password")
			}
			out[f.ID] = email
		case bridgev2.LoginInputFieldTypePassword:
			out[f.ID] = password
			*credsSent = true
		case bridgev2.LoginInputFieldTypeSelect:
			// 2FA method picker: choose a code method (Authentication app / Text message);
			// the code is then entered in the Facebook auth chat (see the 2FACode case).
			choice := gometaPreferredMFA(f.Options)
			if choice == "" {
				return nil, fmt.Errorf("this Facebook account offers no code-based two-factor method we can use (%v) — enable Authentication app or Text message in Facebook Security settings", f.Options)
			}
			h.logger.Info().Str("mfa", choice).Msg("selecting 2FA method")
			out[f.ID] = choice
		case bridgev2.LoginInputFieldType2FACode:
			// Facebook wants the login/2FA code. imlibpurple has no request-input UI-op, so we
			// surface the prompt in a "Facebook" auth chat and block until the user replies
			// there with the code (captured in gometa_go_send_message). Mirrors Telegram.
			h.logger.Info().Str("prompt", step.Instructions).Msg("waiting for 2FA code from the Facebook auth chat")
			code := strings.TrimSpace(h.promptInput("Facebook needs your login/2FA code. Reply to this chat with the code: " + step.Instructions))
			if code == "" {
				return nil, fmt.Errorf("no Facebook 2FA code was entered")
			}
			out[f.ID] = code
		default:
			return nil, fmt.Errorf("this Facebook login needs a typed %q, which isn't supported yet", f.Type)
		}
	}
	return out, nil
}

// gometaPreferredMFA picks a 2FA method we can complete by typing a code into the Facebook
// auth chat. Code methods are preferred in this order. "Notification on another device" (AFAD)
// is deliberately NOT selected: Meta rejects it in this messagix flow (the afad_state.async RPC
// returns an error, which older mautrix-meta even crashes parsing), so it can never complete.
func gometaPreferredMFA(options []string) string {
	for _, want := range []string{"Authentication app", "Text message", "WhatsApp"} {
		for _, o := range options {
			if o == want {
				return o
			}
		}
	}
	return ""
}
