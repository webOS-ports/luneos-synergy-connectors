package main

// Facebook Messenger E2EE (encrypted threads) support. Messenger's end-to-end encryption rides
// WhatsApp's Signal transport ("encrypted over WA"), so messagix exposes a whatsmeow client for it
// via RegisterE2EE + PrepareE2EEClient. Encrypted threads CANNOT use the plaintext SendMessageTask
// (Facebook rejects it with HandleInvalidSendToOpen) — they must go through this whatsmeow client.
//
// The whatsmeow device (Signal identity + prekeys) is persisted in a per-account SQLite DB (pure-Go
// modernc driver, registered by login.go) so the E2EE session survives restarts. This client is
// entirely separate from the WhatsApp account's own whatsmeow client (different device + DB).

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strconv"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"go.mau.fi/mautrix-meta/pkg/messagix/methods"
	"google.golang.org/protobuf/proto"
)

const gometaWADeviceSetting = "gometa_wa_jid"

// connectE2EE registers (once) and connects the whatsmeow client that carries Messenger's
// encrypted threads. Best-effort: a failure only disables encrypted threads, not plaintext ones.
func (h *gometaHandler) connectE2EE(fbid int64) error {
	dbLog := waLog.Zerolog(h.logger.With().Str("component", "e2ee-db").Logger())
	dbPath := filepath.Join(h.purpleUserDir, "gometa-e2ee-"+h.username+".db")
	addr := "file:" + dbPath + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", addr)
	if err != nil {
		return fmt.Errorf("open e2ee db: %w", err)
	}
	db.SetMaxOpenConns(1)
	container := sqlstore.NewWithDB(db, "sqlite", dbLog)
	if err := container.Upgrade(h.ctx); err != nil {
		return fmt.Errorf("upgrade e2ee db: %w", err)
	}

	// Reuse the saved device if we have one, otherwise register a fresh one.
	var device *store.Device
	if jidStr := gometaGetSetting(h.account, gometaWADeviceSetting); jidStr != "" {
		if jid, perr := waTypes.ParseJID(jidStr); perr == nil {
			device, _ = container.GetDevice(h.ctx, jid)
		}
	}
	isNew := device == nil
	if isNew {
		device = container.NewDevice()
	}
	if suggested := h.client.MessengerLite.GetSuggestedDeviceID(); suggested != uuid.Nil {
		device.FacebookUUID = suggested
	}
	h.client.SetDevice(device)

	if isNew {
		h.logger.Info().Msg("registering new E2EE device")
		if err := h.client.RegisterE2EE(h.ctx, fbid); err != nil {
			return fmt.Errorf("register e2ee: %w", err)
		}
		if device.ID != nil {
			gometaSetSetting(h.account, gometaWADeviceSetting, device.ID.String())
		}
		if err := device.Save(h.ctx); err != nil {
			return fmt.Errorf("save e2ee device: %w", err)
		}
	}

	e2ee, err := h.client.PrepareE2EEClient()
	if err != nil {
		return fmt.Errorf("prepare e2ee client: %w", err)
	}
	e2ee.AddEventHandler(h.e2eeEventHandler)
	if err := e2ee.Connect(); err != nil {
		return fmt.Errorf("connect e2ee socket: %w", err)
	}
	h.e2ee = e2ee
	h.logger.Info().Msg("E2EE (whatsmeow) client connected")
	return nil
}

// e2eeEventHandler receives events from the encrypted (whatsmeow) socket.
func (h *gometaHandler) e2eeEventHandler(rawEvt any) {
	switch evt := rawEvt.(type) {
	case *events.FBMessage:
		h.handleE2EEMessage(evt)
	case *events.Connected:
		h.logger.Info().Msg("E2EE socket connected")
	case *events.LoggedOut:
		h.logger.Warn().Msg("E2EE socket logged out")
	case *events.Receipt:
		// webOS delivery/read receipts on E2EE (encrypted Messenger) threads: these arrive as
		// whatsmeow receipts on this socket (FB E2EE rides WhatsApp's transport), NOT as the messagix
		// LSUpdate*Receipt tables handled in parseTable. evt.MessageIDs are the OTIDs we surfaced as
		// serviceMessageId, so key on them directly (same by-id path as WhatsApp).
		var status string
		if evt.Type == waTypes.ReceiptTypeRead || evt.Type == waTypes.ReceiptTypeReadSelf {
			status = "read"
		} else if evt.Type == waTypes.ReceiptTypeDelivered {
			status = "delivered"
		}
		if status != "" {
			for _, mid := range evt.MessageIDs {
				purple_handle_receipt(h.account, string(mid), status)
			}
		}
	default:
		// Surface anything we don't handle (e.g. if reactions ever arrive as a distinct event type
		// rather than an FBMessage) so it's visible in the log instead of silently dropped.
		h.logger.Debug().Str("type", fmt.Sprintf("%T", rawEvt)).Msg("unhandled E2EE event")
	}
}

// handleE2EEMessage turns an encrypted message into a buddy + incoming message, and records the
// chat/sender as E2EE so future sends to them route over the encrypted transport.
func (h *gometaHandler) handleE2EEMessage(evt *events.FBMessage) {
	chatFbid, _ := strconv.ParseInt(evt.Info.Chat.User, 10, 64)
	senderFbid, _ := strconv.ParseInt(evt.Info.Sender.User, 10, 64)
	if chatFbid == 0 {
		return
	}
	h.mu.Lock()
	h.e2eeContacts[chatFbid] = true
	if senderFbid != 0 {
		h.e2eeContacts[senderFbid] = true
	}
	name := h.contactName[senderFbid]
	// Drop the echo of a message we just sent from here (tracked by the id we passed to SendFBMessage).
	var mine bool
	if otid, err := strconv.ParseInt(string(evt.Info.ID), 10, 64); err == nil {
		mine = h.sentOtids[otid]
		delete(h.sentOtids, otid)
	}
	h.mu.Unlock()
	if mine {
		return
	}

	var text string
	if consumer, ok := evt.Message.(*waConsumerApplication.ConsumerApplication); ok {
		content := consumer.GetPayload().GetContent()
		// webOS reactions: on an ENCRYPTED Messenger thread a reaction arrives HERE as a
		// ConsumerApplication carrying a ReactionMessage (over the whatsmeow socket) - NOT via the
		// messagix LSUpsertReaction table that plaintext threads use. Forward it to the shared
		// "webos-im-reaction" signal so it attaches to the target message, then return (nothing to
		// display). Key.ID = the reacted-to message id (matches the serviceMessageId we stored from
		// evt.Info.ID); Text = the emoji ("" means the reaction was removed); sender = who reacted.
		if rm := content.GetReactionMessage(); rm != nil {
			targetID := rm.GetKey().GetID()
			if targetID != "" {
				purple_handle_reaction(h.account, strconv.FormatInt(chatFbid, 10), targetID,
					rm.GetText(), strconv.FormatInt(senderFbid, 10))
			}
			return
		}
		// webOS: incoming media (image/video/audio/document) over an ENCRYPTED thread arrives here as an
		// armadillo media message inside the ConsumerApplication. Download + display it via the shared
		// attachment path (handleE2EEMedia). Without this the message was silently dropped -- only text
		// and reactions were handled, so a Facebook video/image never appeared in the Messaging app.
		if h.handleE2EEMedia(content, evt, chatFbid, senderFbid, name) {
			return
		}
		text = content.GetMessageText().GetText()
	}
	if text == "" {
		return
	}
	// Record who sent this message so a later reaction over E2EE can build a correct MessageKey
	// (FromMe / sender). Keyed by the message id (matches the serviceMessageId we store below).
	if id := string(evt.Info.ID); id != "" {
		h.mu.Lock()
		h.e2eeMsgMeta[id] = e2eeMsgInfo{fromMe: evt.Info.IsFromMe, sender: strconv.FormatInt(senderFbid, 10), text: text}
		h.mu.Unlock()
	}
	// webOS replies: an encrypted reply carries the quoted-original in the MessageApplication metadata.
	// StanzaID matches the serviceMessageId we store (evt.Info.ID); recover the quoted text + author from
	// the per-message cache (populated above on every E2EE message received/sent this session).
	var quotedText, quotedFrom, quotedId string
	if qm := evt.FBApplication.GetMetadata().GetQuotedMessage(); qm != nil {
		quotedId = qm.GetStanzaID()
		if quotedId != "" {
			h.mu.Lock()
			if meta, ok := h.e2eeMsgMeta[quotedId]; ok {
				quotedText = meta.text
				if sf, perr := strconv.ParseInt(meta.sender, 10, 64); perr == nil {
					quotedFrom = h.contactName[sf]
				}
			}
			h.mu.Unlock()
		}
	}
	h.addContact(chatFbid, name)
	h.notifyMessage(strconv.FormatInt(chatFbid, 10), strconv.FormatInt(senderFbid, 10),
		name, text, evt.Info.ID, evt.Info.Timestamp.Unix(), false, evt.Info.IsFromMe, quotedText, quotedFrom, quotedId)
}

// sendE2EE sends a text message over the encrypted (whatsmeow) transport to a Messenger thread.
// replyTo (webOS replies) = the StanzaID of the message this one replies to ("" for a normal message).
func (h *gometaHandler) sendE2EE(threadID int64, text, replyTo string) error {
	to := waTypes.JID{User: strconv.FormatInt(threadID, 10), Server: waTypes.MessengerServer}
	msg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_MessageText{
						MessageText: &waCommon.MessageText{Text: proto.String(text)},
					},
				},
			},
		},
	}
	otid := methods.GenerateEpochID()
	otidStr := strconv.FormatInt(otid, 10)
	h.mu.Lock()
	h.sentOtids[otid] = true
	// Record this as our own message so a later reaction/reply over E2EE builds a FromMe=true MessageKey
	// (and can quote this message's text).
	h.e2eeMsgMeta[otidStr] = e2eeMsgInfo{fromMe: true, sender: strconv.FormatInt(h.selfID, 10), text: text}
	h.mu.Unlock()
	// webOS replies: attach the quoted-original so the reply threads. StanzaID = the target message id;
	// Participant = its sender's Messenger JID (recovered from the per-message cache).
	metadata := &waMsgApplication.MessageApplication_Metadata{}
	if replyTo != "" {
		participant := ""
		h.mu.Lock()
		if meta, ok := h.e2eeMsgMeta[replyTo]; ok && meta.sender != "" {
			participant = waTypes.JID{User: meta.sender, Server: waTypes.MessengerServer}.String()
		}
		h.mu.Unlock()
		qm := &waMsgApplication.MessageApplication_Metadata_QuotedMessage{
			StanzaID:  proto.String(replyTo),
			RemoteJID: proto.String(to.String()),
		}
		if participant != "" {
			qm.Participant = proto.String(participant)
		}
		metadata.QuotedMessage = qm
	}
	ctx, cancel := context.WithTimeout(h.ctx, 30*time.Second)
	defer cancel()
	_, err := h.e2ee.SendFBMessage(ctx, to, msg, metadata,
		whatsmeow.SendRequestExtra{ID: waTypes.MessageID(otidStr)})
	if err == nil {
		// webOS outbox-id: the otid we passed as SendRequestExtra{ID} IS this message's id — hand it to
		// the transport so this app-sent encrypted message's Outbox row becomes reactable.
		purple_handle_outbox_id(h.account, otidStr, text)
	}
	return err
}

// sendReactionE2EE reacts to (or, when reaction is empty, un-reacts) an encrypted Messenger message by
// sending a ConsumerApplication ReactionMessage over the whatsmeow transport. E2EE here is 1:1 only, so
// no Participant is needed. The MessageKey's FromMe comes from the per-message metadata recorded on
// send/receive; if the target is unknown we default FromMe=false (best-effort — only our own known
// messages get FromMe=true).
func (h *gometaHandler) sendReactionE2EE(threadID int64, targetID, reaction string) error {
	to := waTypes.JID{User: strconv.FormatInt(threadID, 10), Server: waTypes.MessengerServer}
	h.mu.Lock()
	meta, known := h.e2eeMsgMeta[targetID]
	h.mu.Unlock()
	fromMe := false
	if known {
		fromMe = meta.fromMe
	}
	key := &waCommon.MessageKey{
		RemoteJID: proto.String(to.String()),
		FromMe:    proto.Bool(fromMe),
		ID:        proto.String(targetID),
	}
	msg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_ReactionMessage{
						ReactionMessage: &waConsumerApplication.ConsumerApplication_ReactionMessage{
							Key:               key,
							Text:              proto.String(reaction),
							SenderTimestampMS: proto.Int64(time.Now().UnixMilli()),
						},
					},
				},
			},
		},
	}
	otid := methods.GenerateEpochID()
	ctx, cancel := context.WithTimeout(h.ctx, 30*time.Second)
	defer cancel()
	_, err := h.e2ee.SendFBMessage(ctx, to, msg, &waMsgApplication.MessageApplication_Metadata{},
		whatsmeow.SendRequestExtra{ID: waTypes.MessageID(strconv.FormatInt(otid, 10))})
	return err
}
