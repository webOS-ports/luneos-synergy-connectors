package main

// Dedup for WhatsApp Channel (newsletter) posts.
//
// A followed Channel's posts reach us TWICE: whatsmeow offline-syncs recent posts as live messages on
// connect, AND fetch_newsletter_history replays the last 50 when the channel is opened in the Servers
// tab. Without dedup each post is stored twice (the user sees every post doubled). We remember the
// WhatsApp message IDs we've already delivered (the id is stable between the live and history paths) and
// skip repeats. The set is bounded (FIFO) and persisted next to the message cache, so a reopen in a later
// session doesn't re-duplicate posts already written to db8.

import (
	"encoding/json"
	"os"

	"go.mau.fi/whatsmeow/types"
)

const newsletterSeenMax = 4000

// newsletterAlreadySeen reports whether this Channel post was already delivered, recording it if not.
func (handler *Handler) newsletterAlreadySeen(id types.MessageID) bool {
	if id == "" {
		return false
	}
	if handler.newsletterSeen == nil {
		handler.newsletterSeen = make(map[types.MessageID]bool)
	}
	if handler.newsletterSeen[id] {
		return true
	}
	handler.newsletterSeen[id] = true
	handler.newsletterSeenOrder = append(handler.newsletterSeenOrder, id)
	if len(handler.newsletterSeenOrder) > newsletterSeenMax {
		drop := handler.newsletterSeenOrder[0]
		handler.newsletterSeenOrder = handler.newsletterSeenOrder[1:]
		delete(handler.newsletterSeen, drop)
	}
	return false
}

func (handler *Handler) LoadNewsletterSeen(filePath string) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return // no file yet — fine on first run
	}
	var ids []types.MessageID
	if json.Unmarshal(data, &ids) != nil {
		return
	}
	handler.newsletterSeen = make(map[types.MessageID]bool, len(ids))
	for _, id := range ids {
		handler.newsletterSeen[id] = true
	}
	handler.newsletterSeenOrder = ids
	handler.log.Infof("Loaded %d seen WhatsApp Channel post ids.", len(ids))
}

func (handler *Handler) SaveNewsletterSeen(filePath string) {
	data, err := json.Marshal(handler.newsletterSeenOrder)
	if err != nil {
		return
	}
	_ = os.WriteFile(filePath, data, 0600)
}
