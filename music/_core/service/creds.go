package main

// Accounts integration: read/write a music service's OAuth token from the webOS
// Accounts service (com.palm.service.accounts) instead of (only) a flat file.
//
// This makes each music service a webOS *account type* (see the account template
// deploy/accounts/org.webosports.app.music.spotify/…): the Accounts app owns "add / remove
// Spotify", stores the token as the account's "common" credentials, and this
// backend reads it back by accountId — exactly how the cloud connectors work.
//
// The backend is a plain localhost HTTP server, not a luna-bus service, so it
// talks to the Accounts service by shelling out to `luna-send`, impersonating our
// service id (-a). The account template's read/writePermissions list that id, so
// the Accounts service permits readCredentials/writeCredentials.
//
// Credential shape (mirrors cloud-auth's "common" convention, camelCase):
//
//	{ "common": { "accessToken": "...", "refreshToken": "...", "expiry": "RFC3339" } }
//
// Everything here is best-effort: if luna-send is missing, the bus call fails, or
// no music account exists, callers fall back to the flat token file.

import (
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// serviceCallerID is the identity we impersonate to the Accounts service; it must
// appear in the account template's read/writePermissions.
const serviceCallerID = "org.webosports.app.music.service"

// musicTemplatePrefix matches every music-service account type we own.
const musicTemplatePrefix = "org.webosports.app.music."

// lunaCall invokes a luna-bus method via luna-send and returns the parsed reply.
// Returns (nil, err) if luna-send is unavailable or the call yields no JSON.
func lunaCall(uri, payload string) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	// -n 1: expect one reply then exit; -a: claim our service identity.
	cmd := exec.CommandContext(ctx, "luna-send", "-n", "1", "-a", serviceCallerID, uri, payload)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var m map[string]interface{}
	if err := json.Unmarshal(out, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// musicAccount is a minimal view of an Accounts-service account row.
type musicAccount struct {
	ID         string
	TemplateID string
	Name       string
}

// listMusicAccounts returns every account whose templateId is one of ours.
func listMusicAccounts() []musicAccount {
	m, err := lunaCall("palm://com.palm.service.accounts/listAccounts", "{}")
	if err != nil {
		return nil
	}
	rawAccts, _ := m["accounts"].([]interface{})
	var out []musicAccount
	for _, ra := range rawAccts {
		a, _ := ra.(map[string]interface{})
		if a == nil {
			continue
		}
		tid, _ := a["templateId"].(string)
		if !strings.HasPrefix(tid, musicTemplatePrefix) {
			continue
		}
		id, _ := a["_id"].(string)
		if id == "" {
			id, _ = a["accountId"].(string) // some builds key it this way
		}
		name, _ := a["username"].(string)
		if name == "" {
			name, _ = a["displayName"].(string)
		}
		out = append(out, musicAccount{ID: id, TemplateID: tid, Name: name})
	}
	return out
}

// commonCreds is the "common" credential blob we store/read per account.
type commonCreds struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	Expiry       string `json:"expiry"` // RFC3339
}

// readAccountToken reads an account's stored credentials and maps them to an
// oauth2.Token. Handles the three nesting shapes cloud creds.js documents:
// the value directly, wrapped as {credentials:…}, or nested under {common:…}.
func readAccountToken(accountID string) *oauth2.Token {
	if accountID == "" {
		return nil
	}
	payload, _ := json.Marshal(map[string]string{"accountId": accountID, "name": "common"})
	m, err := lunaCall("palm://com.palm.service.accounts/readCredentials", string(payload))
	if err != nil {
		return nil
	}
	// Normalise: reply may be the creds directly, {credentials:{…}}, or nest {common:{…}}.
	var node map[string]interface{} = m
	if c, ok := m["credentials"].(map[string]interface{}); ok {
		node = c
	}
	if cc, ok := node["common"].(map[string]interface{}); ok {
		node = cc
	}
	// Re-marshal the resolved node into commonCreds.
	b, _ := json.Marshal(node)
	var cc commonCreds
	if json.Unmarshal(b, &cc) != nil || cc.RefreshToken == "" {
		return nil
	}
	tok := &oauth2.Token{AccessToken: cc.AccessToken, RefreshToken: cc.RefreshToken}
	if cc.Expiry != "" {
		if t, err := time.Parse(time.RFC3339, cc.Expiry); err == nil {
			tok.Expiry = t
		}
	}
	return tok
}

// writeAccountToken persists a (refreshed) token back to the account so the
// Accounts store stays current — best-effort.
func writeAccountToken(accountID string, tok *oauth2.Token) {
	if accountID == "" || tok == nil {
		return
	}
	creds := map[string]interface{}{
		"common": commonCreds{
			AccessToken:  tok.AccessToken,
			RefreshToken: tok.RefreshToken,
			Expiry:       tok.Expiry.Format(time.RFC3339),
		},
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"accountId":   accountID,
		"name":        "common",
		"credentials": creds,
	})
	if _, err := lunaCall("palm://com.palm.service.accounts/writeCredentials", string(payload)); err != nil {
		log.Printf("writeAccountToken: %v", err)
	}
}

// accountToken finds the first music account and returns its token + accountId.
// Returns ("", nil) when no usable music account exists.
func accountToken() (string, *oauth2.Token) {
	for _, a := range listMusicAccounts() {
		if tok := readAccountToken(a.ID); tok != nil {
			log.Printf("using credentials from account %s (%s)", a.ID, a.TemplateID)
			return a.ID, tok
		}
	}
	return "", nil
}
