package main

/*
#include "constants.h"
#include "opusreader.h"
*/
import "C"

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// from https://github.com/tulir/whatsmeow/blob/main/mdtest/main.go
func parseJID(arg string) (types.JID, error) {
	if arg[0] == '+' {
		arg = arg[1:]
	}
	if !strings.ContainsRune(arg, '@') {
		return types.NewJID(arg, types.DefaultUserServer), nil
	} else {
		recipient, err := types.ParseJID(arg)
		if err != nil {
			return recipient, fmt.Errorf("invalid JID %s: %v", arg, err)
		} else if recipient.User == "" {
			return recipient, fmt.Errorf("invalid JID %s: no user specified", arg)
		}
		return recipient, nil
	}
}

/*
 * Examines the text for a request to reply to a message. Syntax is
 * ?reply ID text
 * The message is looked up in handler.cachedMessages.
 * Returns (isReply, quoted message, text without command)
 * In case no appropriate message was found in the cache, the nil message is returned.
 */
func (handler *Handler) prepare_reply(chat types.JID, text string) (bool, *CachedMessage, string) {
	parts := strings.Split(text, " ")
	if len(parts) >= 3 && (parts[0] == "?reply" || parts[0] == "?r") {
		cached_message := handler.lookup_cached_message_by_id(parts[1])
		if cached_message == nil {
			cached_message = handler.lookup_cached_message_by_substring(chat, parts[1])
		}
		text = strings.Join(parts[2:], " ")
		return true, cached_message, text
	}
	return false, nil, text
}

/*
 * Sends a plain text message to a recipient.
 *
 * Sending may happen asynchronously.
 *
 * Upon success, message is fed back into client iff
 * GOWHATSAPP_ECHO_OPTION is set to GOWHATSAPP_ECHO_CHOICE_ON_SUCCESS.
 *
 * Returns true on success.
 */
func (handler *Handler) send_text_message(recipient types.JID, isGroup bool, message string, replyTo string) bool {
	msg := &waE2E.Message{Conversation: &message}
	expiration_days := purple_get_int(handler.account, C.GOWHATSAPP_EXPIRATION_OPTION, 0)
	expiration_seconds := uint32(expiration_days) * 24 * 60 * 60
	if expiration_seconds > 0 {
		msg = &waE2E.Message{
			ExtendedTextMessage: &waE2E.ExtendedTextMessage{
				Text: &message,
				ContextInfo: &waE2E.ContextInfo{
					Expiration: proto.Uint32(expiration_seconds),
				},
			},
		}
	}
	is_reply, cached_message, message := handler.prepare_reply(recipient, message)
	// webOS replies: the Messaging app sends the reply target's serviceMessageId out-of-band
	// (webos-reply-to) rather than the "?reply <id>" text command. Resolve it from the cache and quote it.
	if !is_reply && replyTo != "" {
		cached_message = handler.lookup_cached_message_by_id(replyTo)
		if cached_message != nil {
			is_reply = true
		}
	}
	if is_reply {
		if cached_message == nil {
			purple_display_system_message(handler.account, recipient.ToNonAD().String(), isGroup, "Unable to prepare reply: Quoted message not found in cache.")
			return false
		} else {
			participant := cached_message.Sender.ToNonAD().String()
			msg = &waE2E.Message{
				ExtendedTextMessage: &waE2E.ExtendedTextMessage{
					Text: &message,
					ContextInfo: &waE2E.ContextInfo{
						StanzaID:      &cached_message.ID,
						Participant:   &participant,
						QuotedMessage: &cached_message.Message,
					},
				},
			}
			if expiration_seconds > 0 {
				msg.ExtendedTextMessage.ContextInfo.Expiration = proto.Uint32(expiration_seconds)
			}
		}
	}
	send_response, err := handler.client.SendMessage(context.Background(), recipient, msg)
	if err != nil {
		errmsg := fmt.Sprintf("Error sending message: %v", err)
		purple_display_system_message(handler.account, recipient.ToNonAD().String(), isGroup, errmsg)
		return false
	} else {
		// inject message back to self to indicate success
		setting := purple_get_string(handler.account, C.GOWHATSAPP_ECHO_OPTION, C.GOWHATSAPP_ECHO_CHOICE_ON_SUCCESS)
		if setting == C.GoString(C.GOWHATSAPP_ECHO_CHOICE_ON_SUCCESS) {
			ownJid := handler.client.Store.ID.ToNonAD().String()
			recipientJid := recipient.ToNonAD().String()
			msgID := send_response.ID
			purple_display_text_message(handler.account, recipientJid, isGroup, true, ownJid, nil, send_response.Timestamp, message, &msgID, "", "", "")
		}
		handler.add_to_cache(msg, send_response.ID, recipient, send_response.Sender, send_response.Sender, true, isGroup, send_response.Timestamp)
		// webOS outbox-id: hand the server id of this app-sent message to the transport so its Outbox
		// row becomes reactable (react-to-your-own-message).
		purple_handle_outbox_id(handler.account, send_response.ID, message)
		return true
	}
}

/*
 * webOS reactions (SEND): send (or remove) a reaction to a WhatsApp message.
 *
 *   peer     = the chat JID the transport uses (parsed like a send recipient)
 *   targetId = the bare whatsmeow message id of the message being reacted to
 *   emoji    = the reaction emoji (ignored when remove is true)
 *   remove   = true removes my previous reaction (sends an empty reaction)
 *
 * whatsmeow's BuildReaction/BuildMessageKey needs the ORIGINAL message's sender to set FromMe: for a
 * message I sent, FromMe must be true; for one I received, FromMe is false (and, in a group, Participant
 * is the sender). We recover the sender from the local message cache (populated on both send and
 * receive). targetSender is the db8 FALLBACK: the transport supplies the reacted-to message's original
 * sender (from the app's message row), so a reaction still builds correctly when the cache has no entry
 * for the target - after a transport restart/crash, or for a message older than the cache. Only if BOTH
 * miss do we guess (1:1 -> received from peer; group -> own message).
 */
func (handler *Handler) send_reaction(peer string, targetId string, emoji string, targetSender string, remove bool) {
	chat, err := parseJID(peer)
	if err != nil {
		purple_display_system_message(handler.account, peer, false, fmt.Sprintf("Cannot react: invalid recipient: %v", err))
		return
	}
	reaction := emoji
	if remove {
		reaction = ""
	}
	// Recover the reacted-to message's sender so FromMe/Participant are correct.
	var sender types.JID
	resolved := false
	if cached := handler.lookup_cached_message_by_id(targetId); cached != nil {
		sender = cached.Sender.ToNonAD()
		resolved = true
	} else if targetSender != "" {
		// db8 fallback: transport supplied the original sender (the app's from.addr). Works for any
		// message regardless of cache state; whatsmeow derives FromMe from this JID vs our own.
		if sj, perr := parseJID(targetSender); perr == nil {
			sender = sj.ToNonAD()
			resolved = true
		} else {
			handler.log.Warnf("send_reaction: unparseable targetSender %q: %v", targetSender, perr)
		}
	}
	if !resolved {
		// Neither cache nor a usable supplied sender - last-resort heuristic.
		if chat.Server == types.DefaultUserServer || chat.Server == types.HiddenUserServer {
			// 1:1: assume a received message (sender = peer, FromMe=false), the common case.
			sender = chat.ToNonAD()
		} else {
			// Group: assume it's our own message (empty sender => FromMe=true).
			sender = types.EmptyJID
		}
	}
	msg := handler.client.BuildReaction(chat, sender, types.MessageID(targetId), reaction)
	_, err = handler.client.SendMessage(context.Background(), chat, msg)
	if err != nil {
		handler.log.Warnf("Failed to send reaction to %s (target %s): %v", chat.String(), targetId, err)
		purple_display_system_message(handler.account, chat.ToNonAD().String(), false, fmt.Sprintf("Failed to send reaction: %v", err))
	}
}

// pollVoteSenderCandidates returns the sender JIDs to try for a poll's message-secret lookup, most
// likely first. The secret is keyed by the EXACT sender whatsmeow saw when the poll arrived, and
// SQLStore.GetMessageSecret matches `sender.ToNonAD()` EXACTLY - unlike the privacy-token query
// right beside it in that same file, it has NO LID<->PN fallback, and a miss returns
// (nil, nil) rather than an error. So handing it the wrong form of the same person's JID fails
// SILENTLY. db8 only ever stores the phone-number form (from.addr), so for a LID-identified
// contact the PN we get back is the wrong key and voting on any non-cached poll dies here.
func (handler *Handler) pollVoteSenderCandidates(ctx context.Context, sender types.JID) []types.JID {
	candidates := []types.JID{sender}
	var other types.JID
	var err error
	if sender.Server == types.HiddenUserServer {
		other, err = handler.client.Store.LIDs.GetPNForLID(ctx, sender)
	} else {
		other, err = handler.client.Store.LIDs.GetLIDForPN(ctx, sender)
	}
	if err == nil && !other.IsEmpty() && other.ToNonAD() != sender.ToNonAD() {
		candidates = append(candidates, other)
	}
	return candidates
}

// send_poll_vote sends (or replaces) the user's vote on a poll they received. optionNames is the
// FULL current selection (not a delta) - whatsmeow's BuildPollVote/PollVoteMessage always carries
// the complete set of selected options, same as a real WhatsApp client re-sending the whole
// selection on every tap. peer = the chat the poll lives in; pollMessageID = the poll creation
// message's serviceMessageId (== info.ID at receive time).
//
// Prefers the in-memory cache (it has the exact RawSender whatsmeow used); on a miss - i.e. any
// poll from before the last transport restart - falls back to senderJid (db8's stored sender, the
// same db8-fallback pattern send_reaction uses) and PROBES the message-secret store for each
// plausible JID form before building, rather than assuming one. See pollVoteSenderCandidates.
//
// Logging goes to stderr, NOT handler.log: purple_debug output (which is what waLog/purpleLogger
// funnels into) never reaches imstdout.log on this device - confirmed live, zero "[Handler]"/
// "[Client]" lines and zero hits for known-firing Infof calls - so every diagnostic here was
// invisible while this was being debugged. stderr is the channel the wa-call engine already uses
// successfully.
func (handler *Handler) send_poll_vote(peer string, pollMessageID string, optionNames []string, senderJid string) {
	ctx := context.Background()
	chat, err := parseJID(peer)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wa-poll: invalid peer %q: %v\n", peer, err)
		purple_display_system_message(handler.account, peer, false, fmt.Sprintf("Cannot vote: invalid recipient: %v", err))
		return
	}
	var msgSource types.MessageSource
	var timestamp time.Time
	cached := handler.lookup_cached_message_by_id(pollMessageID)
	if cached != nil {
		msgSource = types.MessageSource{
			Chat: cached.Chat,
			// RawSender (not the LID-resolved Sender): the per-message secret was stored under the
			// EXACT sender whatsmeow saw - see CachedMessage.RawSender's comment.
			Sender:   cached.RawSender,
			IsFromMe: cached.IsFromMe,
			IsGroup:  cached.IsGroup,
		}
		timestamp = cached.Timestamp
	} else if senderJid != "" {
		sender, perr := parseJID(senderJid)
		if perr != nil {
			fmt.Fprintf(os.Stderr, "wa-poll: unparseable senderJid %q: %v\n", senderJid, perr)
			purple_display_system_message(handler.account, chat.ToNonAD().String(), false, "Cannot vote: poll not found (try reopening the conversation).")
			return
		}
		isFromMe := handler.client.Store.ID != nil && sender.ToNonAD() == handler.client.Store.ID.ToNonAD()
		isGroup := chat.Server == types.GroupServer
		// Probe the secret store for each JID form and use whichever actually holds the secret -
		// that is exactly what BuildPollVote will look up, so this turns a silent failure into a
		// resolved sender (or an explicit, logged diagnosis).
		resolved := sender
		found := false
		for _, cand := range handler.pollVoteSenderCandidates(ctx, sender) {
			secret, realSender, serr := handler.client.Store.MsgSecrets.GetMessageSecret(ctx, chat, cand, pollMessageID)
			fmt.Fprintf(os.Stderr, "wa-poll: secret probe chat=%s cand=%s -> found=%v realSender=%s err=%v\n",
				chat, cand, len(secret) > 0, realSender, serr)
			if serr == nil && len(secret) > 0 {
				resolved = cand
				found = true
				break
			}
		}
		if !found {
			fmt.Fprintf(os.Stderr, "wa-poll: NO message secret for poll %s in chat %s (tried %v) - vote cannot be encrypted\n",
				pollMessageID, chat, handler.pollVoteSenderCandidates(ctx, sender))
			purple_display_system_message(handler.account, chat.ToNonAD().String(), false,
				"Cannot vote: this poll's encryption key is not on this device (it arrived before this device was linked).")
			return
		}
		msgSource = types.MessageSource{
			Chat:     chat,
			Sender:   resolved,
			IsFromMe: isFromMe,
			IsGroup:  isGroup,
		}
		timestamp = time.Now()
	} else {
		fmt.Fprintf(os.Stderr, "wa-poll: poll %s not cached and no senderJid supplied (%d cached)\n", pollMessageID, len(handler.cachedMessages))
		purple_display_system_message(handler.account, chat.ToNonAD().String(), false, "Cannot vote: poll not found (try reopening the conversation).")
		return
	}
	fmt.Fprintf(os.Stderr, "wa-poll: voting poll=%s cached=%v chat=%s sender=%s isFromMe=%v isGroup=%v options=%v\n",
		pollMessageID, cached != nil, msgSource.Chat, msgSource.Sender, msgSource.IsFromMe, msgSource.IsGroup, optionNames)
	pollInfo := types.MessageInfo{
		ID:            types.MessageID(pollMessageID),
		Timestamp:     timestamp,
		MessageSource: msgSource,
	}
	voteMsg, err := handler.client.BuildPollVote(ctx, &pollInfo, optionNames)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wa-poll: BuildPollVote FAILED for %s: %v\n", pollMessageID, err)
		purple_display_system_message(handler.account, chat.ToNonAD().String(), false, fmt.Sprintf("Failed to vote: %v", err))
		return
	}
	resp, err := handler.client.SendMessage(ctx, chat, voteMsg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wa-poll: SendMessage FAILED for %s: %v\n", pollMessageID, err)
		purple_display_system_message(handler.account, chat.ToNonAD().String(), false, fmt.Sprintf("Failed to send vote: %v", err))
		return
	}
	fmt.Fprintf(os.Stderr, "wa-poll: SENT poll=%s vote OK server_id=%s ts=%s\n", pollMessageID, resp.ID, resp.Timestamp)
}

/*
 * Send a message to a contact.
 *
 * In case message contains nothing but a single http link to a compatible
 * image, audio or video file, the file is sent as a media message.
 * This feature must be enabled explicitly and the file must be small enough.
 *
 * Sending a message causes all previously received messages to become "read" (configurable).
 *
 * Returns true on success.
 */
func (handler *Handler) send_message(who string, message string, isGroup bool, replyTo string) bool {
	recipient, err := parseJID(who)
	if err != nil {
		purple_error(handler.account, fmt.Sprintf("%#v", err), ERROR_FATAL)
		return false
	} else {
		// I am interacting with this recipient. Mark all messages they have sent as "read".
		handler.mark_read_if_on_answer(recipient)
		// now do the actual sending
		if handler.is_link_only_message(message) && replyTo == "" {
			// this is a link-only message – try to send the linked file, if compatible
			// (a reply must keep its quote metadata, so replies always go the text path)
			if handler.send_link_message(recipient, isGroup, message) {
				return true
			} else {
				// sending the link message failed. just send as a normal text message
				return handler.send_text_message(recipient, isGroup, message, replyTo)
			}
		} else {
			// this is a normal message
			return handler.send_text_message(recipient, isGroup, message, replyTo)
		}
	}
}

func (handler *Handler) check_url_trust(url string) bool {
	trusted_url_regex := purple_get_string(handler.account, C.GOWHATSAPP_TRUSTED_URL_REGEX_OPTION, C.GOWHATSAPP_TRUSTED_URL_REGEX_DEFAULT)
	if trusted_url_regex != "" {
		matched, err := regexp.MatchString(trusted_url_regex, url)
		if err != nil {
			handler.log.Errorf("Checking URL trust failed due to %v.", err)
			return false
		}
		return matched
	}
	return false
}

/*
 * Checks wheter message contains a link to a file which can be sent as a
 * media message. Performs HTTP request, checks size.
 */
func (handler *Handler) is_link_only_message(message string) bool {
	max_file_size := purple_get_int(handler.account, C.GOWHATSAPP_EMBED_MAX_FILE_SIZE_OPTION, 0)
	if max_file_size <= 0 {
		return false
	}
	if !strings.HasPrefix(message, "http") {
		return false
	}
	res, err := http.Head(message)
	if err != nil {
		handler.log.Infof("HTTP HEAD request on '%s' failed with %#v.", message, err)
		return false
	}
	if res.StatusCode != 200 {
		handler.log.Infof("HTTP HEAD request on '%s' returned status code %d.", message, res.StatusCode)
		return false
	}
	return res.ContentLength <= int64(max_file_size)*1024*1024
}

/*
 * Downloads a file given as a HTTP link. Sends it to the recipient as a media message.
 *
 * This is a custom feature requested by https://github.com/theassemblerguy.
 */
func (handler *Handler) send_link_message(recipient types.JID, isGroup bool, link string) bool {
	resp, err := http.Get(link)
	if err != nil {
		handler.log.Infof("Unable to perform HTTP GET request on '%s' due to %v.", link, err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		handler.log.Infof("HTTP GET on '%s' returned status code %d.", link, resp.StatusCode)
		return false
	}
	var b bytes.Buffer
	_, err = io.Copy(&b, resp.Body)
	if err != nil {
		handler.log.Infof("Error while downloading file from '%s': %v", link, err)
		return false
	}
	data := b.Bytes()
	var msg *waE2E.Message = nil
	mimetype := http.DetectContentType(data) // do not trust the server. he is stupid.
	// TODO: redundant implementation in send_file_bytes. merge.
	switch mimetype {
	case "image/jpeg":
		// send jpeg as ImageMessage
		// no checks here
		purple_display_system_message(handler.account, recipient.ToNonAD().String(), isGroup, "Compatible file detected. Forwarding as image message…")
		msg, err = handler.send_file_image(data, mimetype)
	case "application/ogg", "audio/ogg":
		// send ogg file as AudioMessage
		opusfile_info := C.opusfile_get_info(C.CBytes(data), C.size_t(len(data)))
		seconds := int64(opusfile_info.length_seconds)
		if seconds >= 0 {
			purple_display_system_message(handler.account, recipient.ToNonAD().String(), isGroup, "Compatible file detected. Forwarding as audio message…")
			msg, err = handler.send_file_audio(data, "audio/ogg; codecs=opus", uint32(seconds), opusfile_info.waveform)
		} else {
			handler.log.Infof("An ogg audio file was provided, but it was invalid.", err)
			return false
		}
	case "video/mp4":
		// send mp4 file as VideoMessage
		err = check_mp4(data)
		if err == nil {
			purple_display_system_message(handler.account, recipient.ToNonAD().String(), isGroup, "Compatible file detected. Forwarding as video message…")
			msg, err = handler.send_file_video(data, "video/mp4")
		} else {
			handler.log.Infof("File incompatible: %s", err)
			return false
		}
	default:
		// send any other file type as DocumentMessage
		if handler.check_url_trust(link) {
			filename := filepath.Base(resp.Request.URL.Path)
			msg, err = handler.send_file_document(data, mimetype, filename)
		} else {
			return false
		}
	}
	if err != nil {
		handler.log.Infof("Error while sending file: %s", err)
		return false
	}
	send_response, err := handler.client.SendMessage(context.Background(), recipient, msg)
	if err != nil {
		handler.log.Infof("Error while sending media message: %v", err)
		return false
	} else {
		purple_display_system_message(handler.account, recipient.ToNonAD().String(), isGroup, fmt.Sprintf("%s has been forwarded.", link)) // TODO: do not omit message ID in this particular case
		msg.Conversation = &link                                                                                                           // hack to preserve link in cache
		handler.add_to_cache(msg, send_response.ID, recipient, send_response.Sender, send_response.Sender, true, isGroup, send_response.Timestamp)
		// webOS outbox-id: make this app-sent media message reactable (react-to-your-own-message).
		purple_handle_outbox_id(handler.account, send_response.ID, link)
		return true
	}
}
