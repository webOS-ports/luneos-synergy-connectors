package main

// The user's own media servers, signed in once in Videos: a Jellyfin, Emby or
// Plex account there (account types org.webosports.video.jellyfin, .emby,
// .plex) also brings the server's music here. The account's templates list
// this daemon's id (serviceCallerID) in their readPermissions, so it can read
// the credentials Videos keeps; it never writes them - signing in, out and
// again is Videos' (and the Accounts app's).
//
// The accounts are looked at when the app asks for the services (/providers),
// at most every mediaAccountsTTL, and again after a server refused the
// sign-in: an account added, removed or signed in again in the meantime then
// shows. When there are several accounts of one kind, the first is used.

import (
	"encoding/json"
	"log"
	"sync"
	"time"
)

// videoTemplates: the provider each Videos account type brings.
var videoTemplates = map[string]string{
	"org.webosports.video.jellyfin": "jellyfin",
	"org.webosports.video.emby":     "emby",
	"org.webosports.video.plex":     "plex",
}

const mediaAccountsTTL = 30 * time.Second

// Test hooks: how the Accounts service is asked, and the clock.
var (
	accountsCall = lunaCall
	mediaNow     = time.Now
)

var (
	mediaMu      sync.Mutex
	mediaLoaded  time.Time
	mediaCredsOf = map[string]string{} // provider id -> the credentials it was made from
)

// accountRow is an account as listAccounts gives it.
type accountRow struct {
	ID           string
	TemplateID   string
	Name         string
	BeingDeleted bool
}

// listAccountRows is every account in Accounts, or nil when it cannot be asked.
// The rows are under "results" (and under "accounts" on older builds).
func listAccountRows() []accountRow {
	m, err := accountsCall("palm://com.palm.service.accounts/listAccounts", "{}")
	if err != nil || m == nil {
		return nil
	}
	raw, ok := m["results"].([]interface{})
	if !ok {
		raw, _ = m["accounts"].([]interface{})
	}
	out := []accountRow{}
	for _, ra := range raw {
		a, _ := ra.(map[string]interface{})
		if a == nil {
			continue
		}
		var r accountRow
		r.TemplateID, _ = a["templateId"].(string)
		r.ID, _ = a["_id"].(string)
		if r.ID == "" {
			r.ID, _ = a["accountId"].(string)
		}
		r.Name, _ = a["username"].(string)
		if r.Name == "" {
			r.Name, _ = a["displayName"].(string)
		}
		r.BeingDeleted, _ = a["beingDeleted"].(bool)
		out = append(out, r)
	}
	return out
}

// readCommonCredentials is an account's "common" credentials as JSON, however
// the reply nests them: as they are, under "credentials", or under "common".
func readCommonCredentials(accountID string) (json.RawMessage, bool) {
	if accountID == "" {
		return nil, false
	}
	payload, _ := json.Marshal(map[string]string{"accountId": accountID, "name": "common"})
	m, err := accountsCall("palm://com.palm.service.accounts/readCredentials", string(payload))
	if err != nil || m == nil {
		return nil, false
	}
	if rv, ok := m["returnValue"].(bool); ok && !rv {
		return nil, false
	}
	node := m
	if c, ok := m["credentials"].(map[string]interface{}); ok {
		node = c
	}
	if c, ok := node["common"].(map[string]interface{}); ok {
		node = c
	}
	delete(node, "returnValue")
	b, err := json.Marshal(node)
	if err != nil {
		return nil, false
	}
	return b, true
}

// mediaProviderFrom makes the provider a Videos account brings, from its
// credentials; nil when they are not enough to reach a server.
var mediaProviderFrom = func(id string, creds json.RawMessage) MusicProvider {
	switch id {
	case "jellyfin":
		return newMediaBrowserProvider(jellyfinMusic, creds)
	case "emby":
		return newMediaBrowserProvider(embyMusic, creds)
	case "plex":
		return newPlexMusicProvider(creds)
	}
	return nil
}

// refreshMediaAccounts puts the servers of the user's Videos accounts in the
// registry, and takes out those whose account is gone. force skips the TTL.
// When Accounts cannot be asked the registry is left as it is.
func refreshMediaAccounts(force bool) {
	mediaMu.Lock()
	defer mediaMu.Unlock()
	if !force && !mediaLoaded.IsZero() && mediaNow().Sub(mediaLoaded) < mediaAccountsTTL {
		return
	}
	rows := listAccountRows()
	if rows == nil {
		return
	}
	mediaLoaded = mediaNow()
	want := map[string]MusicProvider{}
	keep := map[string]string{}
	for _, r := range rows {
		id, ok := videoTemplates[r.TemplateID]
		if !ok || r.BeingDeleted {
			continue
		}
		if _, done := keep[id]; done {
			continue
		}
		creds, ok := readCommonCredentials(r.ID)
		if !ok {
			log.Printf("%s: the Videos account's sign-in cannot be read", id)
			continue
		}
		keep[id] = string(creds)
		if old, same := mediaCredsOf[id]; same && old == string(creds) {
			continue // unchanged: keep the provider, and what it has cached
		}
		if p := mediaProviderFrom(id, creds); p != nil {
			want[id] = p
		} else {
			delete(keep, id)
		}
	}
	providersMu.Lock()
	for id := range videoTemplatesByID() {
		if _, ok := keep[id]; !ok {
			delete(providers, id)
			delete(mediaCredsOf, id)
		}
	}
	for id, p := range want {
		providers[id] = p
		mediaCredsOf[id] = keep[id]
	}
	providersMu.Unlock()
}

// expireMediaAccounts makes the next refresh read the accounts again: a server
// refused the sign-in, which Videos may have renewed meanwhile.
func expireMediaAccounts() {
	mediaMu.Lock()
	mediaLoaded = time.Time{}
	mediaMu.Unlock()
}

func videoTemplatesByID() map[string]bool {
	out := map[string]bool{}
	for _, id := range videoTemplates {
		out[id] = true
	}
	return out
}
