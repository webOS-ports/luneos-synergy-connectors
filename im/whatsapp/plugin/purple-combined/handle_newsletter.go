package main

import (
	"context"
	"io"
	"net/http"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

/*
 * WhatsApp Channels (newsletters) support.
 *
 * whatsmeow delivers a followed Channel as a 1:1 message whose peer JID is "<id>@newsletter", and it
 * carries no channel name - the only name on a message is the SENDER push-name, which is empty for a
 * channel. So without help the buddy is created showing the raw "<id>@newsletter" JID.
 *
 * The readable title lives in the newsletter metadata, reachable only via an explicit query. Fetch the
 * account's subscribed channels once on connect and push each real name through purple_update_name -
 * the same sink used for contact push-names. That both CREATES the newsletter buddy (so followed but
 * quiet channels still show up) and ALIASES it with its real title, which the webOS transport then
 * files under the "WhatsApp Channels" server.
 */
func (handler *Handler) fetch_newsletter_names() {
	cli := handler.client
	if cli == nil {
		return
	}
	metas, err := cli.GetSubscribedNewsletters(context.TODO())
	if err != nil {
		handler.log.Warnf("GetSubscribedNewsletters failed: %#v", err)
		return
	}
	handler.log.Infof("Fetched %d subscribed WhatsApp Channels.", len(metas))
	for _, meta := range metas {
		if meta == nil {
			continue
		}
		name := meta.ThreadMeta.Name.Text
		if name != "" {
			// meta.ID is the "<id>@newsletter" JID; purple_update_name creates/aliases the buddy under it.
			purple_update_name(handler.account, meta.ID.String(), name)
		}
		// webOS: also set the channel ICON. Newsletters aren't regular contacts, so the contact
		// avatar path (events.Picture -> GetProfilePictureInfo) never fires for them - but the picture
		// URL is right here in the metadata. Set it so BBC/Dumpert/etc. show their logo.
		handler.set_newsletter_icon(meta)
	}
}

// set_newsletter_icon downloads a subscribed Channel's icon from its metadata and pushes it through
// purple_set_profile_picture (the same sink contact avatars use). Prefers the small preview (matches
// the default PREVIEW icon setting), falling back to the full picture; both carry a directly
// downloadable URL. Best-effort: a missing/failed icon just leaves the channel iconless.
func (handler *Handler) set_newsletter_icon(meta *types.NewsletterMetadata) {
	// The subscribed-channels LIST query does NOT fetch the picture (it sends no fetch_full_image), so
	// meta's Preview/Picture URLs are empty. Re-query THIS channel with GetNewsletterInfo, which sets
	// fetch_full_image=true and returns a populated, directly-downloadable picture URL.
	full, err := handler.client.GetNewsletterInfo(context.TODO(), meta.ID)
	if err != nil || full == nil {
		handler.log.Warnf("newsletter icon: GetNewsletterInfo(%s) failed: %#v", meta.ID.String(), err)
		return
	}
	// The metadata's picture URL is empty; only a signed direct_path is provided. Prefer the small
	// preview (192x192, ideal for an icon), fall back to the full picture. If a URL is ever present,
	// HTTP GET it; otherwise download by direct_path via the media connection - profile pictures are
	// unencrypted, so DownloadMediaWithOnlyPath needs no keys.
	url := full.ThreadMeta.Preview.URL
	dp := full.ThreadMeta.Preview.DirectPath
	id := full.ThreadMeta.Preview.ID
	if url == "" && dp == "" && full.ThreadMeta.Picture != nil {
		url = full.ThreadMeta.Picture.URL
		dp = full.ThreadMeta.Picture.DirectPath
		id = full.ThreadMeta.Picture.ID
	}
	var data []byte
	if url != "" {
		resp, gerr := http.Get(url)
		if gerr != nil {
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return
		}
		data, _ = io.ReadAll(resp.Body)
	} else if dp != "" {
		data, err = handler.client.DownloadMediaWithOnlyPath(context.TODO(), dp)
		if err != nil {
			handler.log.Warnf("newsletter icon: download for %s failed: %#v", meta.ID.String(), err)
			return
		}
	}
	if len(data) == 0 {
		return
	}
	handler.log.Infof("Set WhatsApp Channel icon for %s, %d bytes.", full.ThreadMeta.Name.Text, len(data))
	purple_set_profile_picture(handler.account, meta.ID.String(), data, "", id)
}

/*
 * Fetch a WhatsApp Channel's recent history on demand. Called when the user opens the channel in the
 * Servers tab: the transport's openChannel -> serv_join_chat -> gowhatsapp_join_chat routes a
 * "<id>@newsletter" join here (a newsletter has no MUC to enter). We pull the last 50 posts via
 * whatsmeow and replay each through the normal handle_message path, so text/media extraction and the
 * newsletter->"WhatsApp Channels" routing (LibpurpleAdapter incoming_message_cb) are all reused.
 */
func (handler *Handler) fetch_newsletter_history(jidStr string) {
	cli := handler.client
	if cli == nil {
		return
	}
	jid, err := parseJID(jidStr)
	if err != nil {
		handler.log.Warnf("newsletter history: invalid jid %s: %#v", jidStr, err)
		return
	}
	msgs, err := cli.GetNewsletterMessages(context.TODO(), jid, &whatsmeow.GetNewsletterMessagesParams{Count: 50})
	if err != nil {
		handler.log.Warnf("GetNewsletterMessages(%s) failed: %#v", jidStr, err)
		return
	}
	handler.log.Infof("Fetched %d history messages for WhatsApp Channel %s.", len(msgs), jidStr)
	// Replay oldest-first so posts thread in chronological order.
	for i := len(msgs) - 1; i >= 0; i-- {
		nm := msgs[i]
		if nm == nil || nm.Message == nil {
			continue
		}
		info := types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:    jid,
				Sender:  jid,
				IsGroup: false,
			},
			ID:        nm.MessageID,
			Timestamp: nm.Timestamp,
		}
		handler.handle_message(nm.Message, info, &events.Message{Info: info, Message: nm.Message})
	}
}
