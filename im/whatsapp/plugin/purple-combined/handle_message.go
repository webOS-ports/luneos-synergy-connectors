package main

/*
#include "constants.h"
*/
import "C"

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func GetAnyPollCreationMessage(message *waE2E.Message) *waE2E.PollCreationMessage {
	if message.PollCreationMessageV5 != nil {
		return message.PollCreationMessageV5
	}
	if message.PollCreationMessageV3 != nil {
		return message.PollCreationMessageV3
	}
	if message.PollCreationMessageV2 != nil {
		return message.PollCreationMessageV2
	}
	if message.PollCreationMessage != nil {
		return message.PollCreationMessage
	}
	return nil
}

// messageHasAttachment reports whether message carries a media payload that handle_attachment will
// turn into its own bubble - used to skip the redundant "[STATUS] " placeholder text for a status
// update that already has a picture/video/etc, so it doesn't show up as two separate messages.
func messageHasAttachment(message *waE2E.Message) bool {
	return message.GetImageMessage() != nil ||
		message.GetVideoMessage() != nil ||
		message.GetAudioMessage() != nil ||
		message.GetDocumentMessage() != nil ||
		message.GetStickerMessage() != nil
}

// write_link_preview_thumbnail persists an ExtendedTextMessage's inline link-preview JPEG thumbnail
// to the account's attachment directory and returns a file:// URL for it (or "" on failure / when the
// attachment path isn't configured). The directory is the static prefix of the account's
// attachment-path-template (everything before the first "$" placeholder) - the same dir real
// downloaded attachments land in - so the Messaging app can load it as an inline <img>. The file is
// named by a content hash so an identical thumbnail is written once and re-render is idempotent.
// attachment_dir resolves the account's attachment directory (the static prefix of its
// attachment-path-template, before the first "$" placeholder) - the same dir real downloaded
// attachments land in - creating it if needed. Returns "" if unconfigured/relative.
func (handler *Handler) attachment_dir() string {
	tmpl := purple_get_string(handler.account, C.GOWHATSAPP_ATTACHMENT_PATH_TEMPLATE_OPTION, C.GOWHATSAPP_ATTACHMENT_PATH_TEMPLATE_DEFAULT)
	prefix := strings.SplitN(tmpl, "$", 2)[0]
	if prefix == "" {
		return "" // no attachment path configured (or template starts with a placeholder) - skip
	}
	dir := filepath.Dir(prefix + "x") // keep the full directory even when the prefix ends in "/"
	if !filepath.IsAbs(dir) {
		return ""
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	return dir
}

func (handler *Handler) write_link_preview_thumbnail(data []byte) string {
	dir := handler.attachment_dir()
	if dir == "" {
		return ""
	}
	sum := sha256.Sum256(data)
	local := filepath.Join(dir, fmt.Sprintf("linkpreview_%x.jpg", sum[:16]))
	if err := os.WriteFile(local, data, 0o644); err != nil {
		return ""
	}
	return "file://" + local
}

// write_vcard_attachment persists a shared ContactMessage's vcard (or, for a multi-contact share,
// several vcards concatenated - still a valid .vcf) to the account's attachment directory and
// returns a file:// URL for it, so the Messaging app can offer it as a tappable ".vcf" chip
// (ConversationItem's document-chip path, extended with a "contact" kind) that launches the
// Contacts app's existing vCard import flow (com.palm.service.contacts countVCardContacts/
// readVCard, wired in ContactsApp.handleVCardLaunch) instead of just a name/phone-number text line.
func (handler *Handler) write_vcard_attachment(vcard string) string {
	dir := handler.attachment_dir()
	if dir == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(vcard))
	local := filepath.Join(dir, fmt.Sprintf("contact_%x.vcf", sum[:16]))
	if err := os.WriteFile(local, []byte(vcard), 0o644); err != nil {
		return ""
	}
	return "file://" + local
}

// formatLocationMessage renders a shared pin (or the initial snapshot of a live-location share) as
// a text summary plus a "geo:lat,lng" URI. There is no dedicated map-bubble UI, so the webOS
// Messaging app (ConversationItem.extractLocations/buildLocationChip) parses that URI back out and
// shows a tappable pin chip that opens the coordinates in the Maps app, instead of displaying the
// raw URI as text. webOS also has no way to render the periodic position updates that follow a live
// share, so a live share is shown once, as a snapshot, not a running track.
func formatLocationMessage(lat, lon float64, name, address, locationURL string, isLive bool) string {
	var b strings.Builder
	if isLive {
		b.WriteString("Live location")
	} else {
		b.WriteString("Location")
	}
	if name != "" {
		b.WriteString(" " + name)
	}
	b.WriteString("\n")
	if address != "" {
		b.WriteString(address + "\n")
	}
	if locationURL != "" {
		b.WriteString(locationURL + "\n")
	}
	if lat != 0 || lon != 0 {
		b.WriteString(fmt.Sprintf("geo:%f,%f", lat, lon))
	}
	return strings.TrimRight(b.String(), "\n")
}

// vcardFieldValue returns the value of the first "<FIELD>[;params]:value" line in a vcard (one
// field per line, CRLF or LF separated - the shape WhatsApp's ContactMessage.Vcard uses; this does
// not attempt to handle folded/multi-line vcard values).
func vcardFieldValue(vcard, field string) string {
	for _, line := range strings.Split(strings.ReplaceAll(vcard, "\r\n", "\n"), "\n") {
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue
		}
		key := strings.SplitN(line[:i], ";", 2)[0]
		if strings.EqualFold(key, field) {
			return strings.TrimSpace(line[i+1:])
		}
	}
	return ""
}

// vcardPhoneNumbers returns every "TEL[;params]:value" line's value, in the order they appear.
func vcardPhoneNumbers(vcard string) []string {
	var phones []string
	for _, line := range strings.Split(strings.ReplaceAll(vcard, "\r\n", "\n"), "\n") {
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue
		}
		key := strings.SplitN(line[:i], ";", 2)[0]
		if strings.EqualFold(key, "TEL") {
			if v := strings.TrimSpace(line[i+1:]); v != "" {
				phones = append(phones, v)
			}
		}
	}
	return phones
}

// formatContactMessage renders a shared contact card as just a tappable chip - no separate "name +
// phone number" caption text, since the chip itself (ConversationItem's buildAttachmentChip, kind
// "contact") shows the contact's name as its label. write_vcard_attachment persists the vcard to
// the account's attachment dir (it's inline in the message, not a downloadable attachment, so it
// can't ride the existing file-transfer path) and the name rides along as a "?name=" query param on
// the returned file:// URL so the frontend can label the chip without parsing the vcard itself.
// Tapping the chip opens Contacts' existing vCard import flow. Falls back to a plain text summary
// if the attachment dir isn't configured (write_vcard_attachment returned "").
func (handler *Handler) formatContactMessage(displayName, vcard string) string {
	name := displayName
	if name == "" {
		name = vcardFieldValue(vcard, "FN")
	}
	if name == "" {
		name = "(unnamed contact)"
	}
	fileURL := handler.write_vcard_attachment(vcard)
	if fileURL == "" {
		text := "Contact: " + name
		if phones := vcardPhoneNumbers(vcard); len(phones) > 0 {
			text += "\n" + strings.Join(phones, "\n")
		}
		return text
	}
	return fileURL + "?name=" + url.QueryEscape(name)
}

// formatContactsArrayMessage is formatContactMessage's multi-contact counterpart: a single chip
// (labelled with the share's display name, or "N contacts") linking to all the vcards concatenated
// into one .vcf - Contacts' existing multi-contact import flow (countVCardContacts -> "Would you
// like to import N contacts?") takes it from there.
func (handler *Handler) formatContactsArrayMessage(displayName string, contacts []*waE2E.ContactMessage) string {
	var vcards strings.Builder
	n := 0
	for _, c := range contacts {
		if c == nil {
			continue
		}
		n++
		if vc := c.GetVcard(); vc != "" {
			vcards.WriteString(vc)
			if !strings.HasSuffix(vc, "\n") {
				vcards.WriteString("\n")
			}
		}
	}
	label := displayName
	if label == "" {
		label = fmt.Sprintf("%d contacts", n)
	}
	if vcards.Len() == 0 {
		return "Contacts: " + label
	}
	fileURL := handler.write_vcard_attachment(vcards.String())
	if fileURL == "" {
		return "Contacts: " + label
	}
	return fileURL + "?name=" + url.QueryEscape(label)
}

// pollPayload is the compact JSON shape ConversationItem.extractPolls decodes back out of a
// "poll:<base64>" token to render a real (read-only) radio-button/checkbox list instead of a
// "1: Option" text dump. Max mirrors PollCreationMessage.SelectableOptionsCount: 1 = single-select
// (radio), 0 or >1 = multi-select (checkbox). There is no vote-SENDING backend yet (whatsmeow
// BuildPollVote isn't wired up), so the rendered inputs are inert/disabled - this only upgrades the
// display, it doesn't make polls interactive.
type pollPayload struct {
	Name    string   `json:"name"`
	Options []string `json:"options"`
	Max     int      `json:"max"`
}

// formatPollMessage renders a poll as just a "poll:<base64-json>" token (like formatEventMessage) -
// ConversationItem.buildPollBlock parses it into the radio/checkbox list. The caller must already
// have filled in each option's OptionHash (needed later for matching an incoming vote) before
// calling this; that side effect is independent of the returned text.
func formatPollMessage(pcm *waE2E.PollCreationMessage) string {
	opts := pcm.GetOptions()
	names := make([]string, 0, len(opts))
	for _, option := range opts {
		names = append(names, option.GetOptionName())
	}
	payload := pollPayload{Name: pcm.GetName(), Options: names, Max: int(pcm.GetSelectableOptionsCount())}
	data, err := json.Marshal(payload)
	if err != nil {
		return "Poll: " + pcm.GetName()
	}
	return "poll:" + base64.RawURLEncoding.EncodeToString(data)
}

// eventPayload is the compact JSON shape ConversationItem.extractEvents decodes back out of an
// "event:<base64>" token to build the Calendar app's documented "New Calendar Event" launch params
// (newEvent: {subject, location, note, dtstart, dtend} - all field names/ms timestamps match what
// AppView.js/DetailView.js already expect). RawURLEncoding (no +, /, = or padding) keeps the token
// safe to embed directly in message text with no escaping.
type eventPayload struct {
	Name     string `json:"name"`
	Location string `json:"location"`
	Note     string `json:"note"`
	Start    int64  `json:"start"` // ms epoch, 0 = unknown
	End      int64  `json:"end"`   // ms epoch, 0 = unknown
}

// formatEventMessage renders a shared WhatsApp Event as a text summary plus an "event:<base64-json>"
// token - there is no dedicated event bubble UI, so the Messaging app
// (ConversationItem.extractEvents/buildEventChip) parses the token back out and shows a tappable
// "Add to Calendar" chip that launches the stock Calendar app's own event-creation flow directly
// (pre-filled, one tap to confirm/save) - no ICS file or import feature needed, since webOS's
// Calendar app has no ICS import at all but DOES have this documented cross-app launch spec.
func formatEventMessage(em *waE2E.EventMessage) string {
	name := em.GetName()
	if name == "" {
		name = "(untitled event)"
	}
	locText := ""
	if loc := em.GetLocation(); loc != nil {
		locText = loc.GetName()
		if a := loc.GetAddress(); a != "" {
			if locText != "" {
				locText += ", "
			}
			locText += a
		}
	}
	payload := eventPayload{Name: name, Location: locText, Note: em.GetDescription()}
	if st := em.GetStartTime(); st > 0 {
		payload.Start = st * 1000
	}
	if et := em.GetEndTime(); et > 0 {
		payload.End = et * 1000
	}
	text := name
	if locText != "" {
		text += "\n" + locText
	}
	if data, err := json.Marshal(payload); err == nil {
		text += "\nevent:" + base64.RawURLEncoding.EncodeToString(data)
	}
	return text
}

func (handler *Handler) handle_message(message *waE2E.Message, info types.MessageInfo, evt *events.Message) {
	//handler.log.Infof("message: %#v", message)
	if message.SenderKeyDistributionMessage != nil {
		// Apparently, a SenderKeyDistributionMessage can share the a message ID with a conversation message which is to arrive later
		// I do not need this message type in the front-end, so I rather drop it
		// This should be safe (as in "will not inadvertedly drop message with actual payload") since all …Messsage fields seem to be mutually exclusive
		handler.log.Infof("Ignoring SenderKeyDistributionMessage.")
		return
	}
	text := ""
	if info.MessageSource.Chat == types.StatusBroadcastJID {
		if purple_get_bool(handler.account, C.GOWHATSAPP_IGNORE_STATUS_BROADCAST_OPTION, false) {
			// some people find status broadcasts annoying
			handler.log.Warnf("Ignoring status broadcast.")
			return
		} else {
			// webOS: route status updates into the Servers tab (like followed WhatsApp Channels)
			// instead of masquerading as an ordinary 1:1 chat from the sender - collapsing Chat to
			// Sender made every status update show up as a random new chat (e.g. "+31630828957").
			// Use a synthetic "<phone>@broadcast" JID (types.BroadcastServer) so LibpurpleAdapter's
			// incoming_message_cb can recognize + bucket it (isWhatsAppStatus), the same way
			// "<id>@newsletter" is recognized for followed Channels.
			statusJid := types.JID{User: info.MessageSource.Sender.User, Server: types.BroadcastServer}
			// PushName is frequently absent on a status-broadcast event even for a contact with a
			// perfectly well-known name (unlike a regular 1:1/group message) - fall back to the local
			// WhatsApp contact-sync store (address-book match, populated independently of any message
			// ever having a PushName) before resorting to purple_get_alias, which - if this contact
			// has ALSO never been messaged 1:1 (status-only sender) - has nothing to fall back to
			// itself and returns the raw JID string, which is what was showing up as the channel name.
			name := info.PushName
			if name == "" {
				if contactInfo, err := handler.client.Store.Contacts.GetContact(context.TODO(), info.MessageSource.Sender); err == nil {
					name = contactInfo.FullName
					if name == "" {
						name = contactInfo.FirstName
					}
					if name == "" {
						name = contactInfo.BusinessName
					}
				}
			}
			if name == "" {
				name = purple_get_alias(handler.account, info.MessageSource.Sender.ToNonAD().String())
			}
			if name != "" {
				// creates/aliases the synthetic status buddy, same sink fetch_newsletter_names uses
				purple_update_name(handler.account, statusJid.String(), name)
			}
			info.MessageSource.Chat = statusJid
			info.MessageSource.IsGroup = false
		}
	}
	if handler.blocklist != nil {
		// TODO find out whether locally checking the blocklist is actually necessary or if WhatsApp servers do the filtering for us
		for _, blockedJID := range handler.blocklist.JIDs {
			if blockedJID.ToNonAD() == info.MessageSource.Sender.ToNonAD() {
				handler.log.Infof("Ignoring message from %s since they are on the blocklist.", info.MessageSource.Sender.ToNonAD().String())
			}
		}
	}
	info.MessageSource.Chat = handler.lidToPn(info.MessageSource.Chat, "handling message chat")
	info.MessageSource.Sender = handler.lidToPn(info.MessageSource.Sender, "handling message sender")
	// Dedup WhatsApp Channel (newsletter) posts: they reach us TWICE - whatsmeow offline-syncs recent
	// posts as live messages on connect, AND fetch_newsletter_history replays the last 50 when the
	// channel is opened in the Servers tab. The WhatsApp message id is stable across both paths, so
	// skip a post we've already delivered (otherwise every channel post shows up doubled). The seen set
	// is loaded at login and saved on close (newsletter_seen.go), so a reopen next session won't re-dup.
	if info.MessageSource.Chat.Server == types.NewsletterServer && handler.newsletterAlreadySeen(info.ID) {
		return
	}
	isEdit := false
	editTargetId := ""
	{
		if pm := message.GetProtocolMessage(); pm != nil {
			if em := pm.GetEditedMessage(); em != nil {
				message = em
				isEdit = true
				// pm.Key points at the ORIGINAL message being edited; its id is the serviceMessageId under
				// which we stored that message, so the transport can find & update that bubble in place.
				editTargetId = pm.GetKey().GetID()
			} else if pm.Type != nil && pm.GetType() == waE2E.ProtocolMessage_REVOKE {
				// webOS "delete for everyone": the sender revoked a previously-sent message. Checking
				// pm.Type != nil (not just GetType()==REVOKE) matters since REVOKE is protobuf enum
				// value 0, the same zero-value GetType() returns for an unset Type field - only a
				// genuine revoke has Type explicitly set. pm.Key points at the ORIGINAL message; its id
				// is the serviceMessageId we stored it under, so the transport can find & blank that
				// bubble in place. There is nothing else to display, so return immediately (same as the
				// reaction handling above).
				if targetId := pm.GetKey().GetID(); targetId != "" {
					purple_handle_message_delete(handler.account, targetId)
				}
				return
			}
		}
	}
	text += message.GetConversation()
	var quotedText, quotedFrom, quotedId string
	{
		etm := message.ExtendedTextMessage
		if etm != nil {
			// message containing quote or link to group
			// link messages have message.Conversation set to nil anyway
			// it should be safe to overwrite here
			// webOS replies: capture the quoted-original as STRUCTURED data (author/text/StanzaID) so the
			// transport renders an inline quote card, instead of folding "> ..." into the message body.
			ci := etm.ContextInfo
			if ci != nil {
				cm := ci.QuotedMessage
				if cm != nil {
					quotedId = ci.GetStanzaID()
					if p := ci.GetParticipant(); p != "" {
						if pjid, err := types.ParseJID(p); err == nil {
							quotedFrom = purple_get_alias(handler.account, handler.lidToPn(pjid, "resolving quote author").ToNonAD().String())
						}
					}
					qt := cm.GetConversation()
					if qt == "" {
						qt = cm.GetExtendedTextMessage().GetText()
					}
					quotedText = strings.ReplaceAll(strings.ReplaceAll(qt, "\r", " "), "\n", " ")
				}
			}
			if etm.Text != nil {
				etmText := *etm.Text
				for _, mentioned := range etm.GetContextInfo().GetMentionedJID() {
					mentionedJID, err := types.ParseJID(mentioned)
					if err == nil {
						alias := purple_get_alias(handler.account, handler.lidToPn(mentionedJID, "resolving mention").ToNonAD().String())
						etmText = strings.ReplaceAll(etmText, mentionedJID.User, alias)
					}
				}
				text += etmText
			}
			// webOS: WhatsApp link-preview posts (news channels like BBC News / Dumpert) arrive as an
			// ExtendedTextMessage with a URL preview - an inline JPEG thumbnail + a title - NOT an image
			// attachment, so previously only the raw body text showed. Prepend the preview card: the
			// thumbnail (written to the attachment dir, referenced as a file:// URL the app renders
			// inline) then the title, above the body. GetJPEGThumbnail/GetTitle are empty for
			// plain/quoted ExtendedTextMessages, so this only fires for actual link previews.
			{
				preview := ""
				if thumb := etm.GetJPEGThumbnail(); len(thumb) > 0 {
					preview = handler.write_link_preview_thumbnail(thumb)
				}
				if title := etm.GetTitle(); title != "" {
					if preview != "" {
						preview += "\n"
					}
					preview += title
				}
				if desc := etm.GetDescription(); desc != "" {
					if preview != "" {
						preview += "\n"
					}
					preview += desc
				}
				if preview != "" {
					text = preview + "\n" + text
				}
			}
		}

	}
	{
		rm := message.GetReactionMessage()
		if rm != nil && rm.Text != nil && rm.Key != nil && rm.Key.ID != nil {
			// webOS reactions: attach to the target message via the transport's reaction signal
			// instead of posting a "reacted with X" message. rm.Key.ID = the reacted-to message id,
			// rm.Text = the emoji ("" means the reaction was removed), Sender = who reacted. Return
			// early: a ReactionMessage carries nothing else to display.
			chat := info.MessageSource.Chat.ToNonAD().String()
			sender := info.MessageSource.Sender.ToNonAD().String()
			purple_handle_reaction(handler.account, chat, rm.Key.GetID(), rm.GetText(), sender)
			return
		}
	}
	{
		pcm := GetAnyPollCreationMessage(message)
		if pcm != nil {
			//handler.log.Infof("message poll creation: %#v", pcm)
			for _, option := range pcm.GetOptions() {
				if option.OptionHash == nil {
					// taken from whatsmeow.HashPollOptions()
					hash := fmt.Sprintf("%X", sha256.Sum256([]byte(option.GetOptionName())))
					option.OptionHash = &hash
				}
				//handler.log.Infof("message poll creation option: %#v", option)
			}
			text = formatPollMessage(pcm)
		}
	}
	{
		// webOS: a shared pin drops silently without this - LocationMessage/LiveLocationMessage carry
		// no Conversation/ExtendedTextMessage text, so nothing rendered at all. Summarize as text (a
		// Maps link) rather than a real map bubble - no attachment involved, same text-summary
		// approach as the poll display below.
		if lm := message.GetLocationMessage(); lm != nil {
			text = formatLocationMessage(lm.GetDegreesLatitude(), lm.GetDegreesLongitude(), lm.GetName(), lm.GetAddress(), lm.GetURL(), lm.GetIsLive())
		} else if llm := message.GetLiveLocationMessage(); llm != nil {
			text = formatLocationMessage(llm.GetDegreesLatitude(), llm.GetDegreesLongitude(), "", "", "", true)
		}
	}
	{
		// webOS: a shared contact card likewise carries no plain text - ContactMessage/
		// ContactsArrayMessage drop silently without this. Summarize as text (name + phone numbers
		// parsed out of the vcard) rather than a real contact-card bubble.
		if cm := message.GetContactMessage(); cm != nil {
			text = handler.formatContactMessage(cm.GetDisplayName(), cm.GetVcard())
		} else if cam := message.GetContactsArrayMessage(); cam != nil {
			text = handler.formatContactsArrayMessage(cam.GetDisplayName(), cam.GetContacts())
		}
	}
	{
		// webOS: a shared Event likewise carries no plain text - drops silently without this.
		if em := message.GetEventMessage(); em != nil {
			text = formatEventMessage(em)
		}
	}
	{
		pum := message.GetPollUpdateMessage()
		if pum != nil {
			cached_message := handler.lookup_cached_message_by_id(pum.GetPollCreationMessageKey().GetID())
			if cached_message == nil {
				text = "voted in a poll, but this plug-in failed to keep track of the poll."
			} else {
				decrypted, err := handler.client.DecryptPollVote(context.TODO(), evt)
				if err != nil {
					handler.log.Warnf("Failed to decrypt poll vote: %v", err)
				} else {
					pcm := GetAnyPollCreationMessage(&cached_message.Message)
					text = fmt.Sprintf("voted in poll „%s“ for", pcm.GetName())
					if len(decrypted.SelectedOptions) == 0 {
						text += " nothing (removed vote)"
					} else {
						for index, option_hash := range decrypted.SelectedOptions {
							hash := fmt.Sprintf("%X", option_hash)
							var option_name *string = nil
							for _, option := range pcm.Options {
								if option.GetOptionHash() == hash {
									option_name = option.OptionName
								}
							}
							if option_name == nil {
								handler.log.Warnf("Failed look-up poll vote option %s in %#v", hash, &cached_message.Message)
								text += " an unknown option"
							} else {
								separator := ""
								if len(decrypted.SelectedOptions) > 1 {
									if index > 0 {
										separator = ","
									}
									if index == len(decrypted.SelectedOptions)-1 {
										separator = " and"
									}
								}
								text += fmt.Sprintf("%s „%s“", separator, *option_name)
							}
						}
					}
					text += "."
				}
			}
		}
	}
	if text != "" {
		if isEdit && editTargetId != "" {
			// webOS edit-in-place: update the ORIGINAL bubble's text (found by editTargetId ==
			// serviceMessageId) instead of posting a separate "[EDIT] ..." message. If we somehow lack the
			// target id we fall through below to a normal display so the edit isn't silently lost.
			purple_handle_message_edit(handler.account, editTargetId, text)
		} else {
			if isEdit {
				text = "[EDIT] " + text
			}
			// note: info.PushName always denotes the sender (not the chat)
			purple_display_text_message(handler.account, info.MessageSource.Chat.ToNonAD().String(), info.MessageSource.IsGroup, false, info.MessageSource.Sender.ToNonAD().String(), &info.PushName, info.Timestamp, text, &info.ID, quotedText, quotedFrom, quotedId)
		}
	}
	if !isEdit { // edited messages contain the changed texts, but attachments are absent since they cannot be changed
		handler.handle_attachment(message, info.ID, info.MessageSource, info.Timestamp)
	}
	handler.add_to_cache(message, info.ID, info.MessageSource.Chat, info.MessageSource.Sender, evt.Info.MessageSource.Sender, info.MessageSource.IsFromMe, info.MessageSource.IsGroup, info.Timestamp)
}
