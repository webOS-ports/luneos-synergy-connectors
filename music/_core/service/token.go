package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"sync"

	"github.com/zmb3/spotify/v2"
	"golang.org/x/oauth2"
)

// Token persistence: the OAuth token (esp. the refresh token) is written to disk
// so a login survives service restarts and reboots. On startup we reload it and
// rebuild the Spotify client; the client's token source is wrapped so that every
// auto-refresh (access tokens last ~1h) is saved back too.

var tokenPath = spotifyDataDir + "/spotify-token.json"

func saveToken(tok *oauth2.Token) {
	if tok == nil {
		return
	}
	b, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return
	}
	tmp := tokenPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		log.Printf("saveToken: %v", err)
		return
	}
	_ = os.Rename(tmp, tokenPath) // atomic-ish replace
}

func loadToken() *oauth2.Token {
	b, err := os.ReadFile(tokenPath)
	if err != nil {
		return nil
	}
	var tok oauth2.Token
	if json.Unmarshal(b, &tok) != nil || tok.RefreshToken == "" {
		return nil
	}
	return &tok
}

// savingTokenSource persists the token whenever the underlying source refreshes it.
type savingTokenSource struct {
	mu   sync.Mutex
	src  oauth2.TokenSource
	last string
}

func (s *savingTokenSource) Token() (*oauth2.Token, error) {
	t, err := s.src.Token()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if t.AccessToken != s.last {
		s.last = t.AccessToken
		saveToken(t)
		if currentAccountID != "" {
			writeAccountToken(currentAccountID, t) // keep the Accounts store fresh too
		}
	}
	s.mu.Unlock()
	return t, nil
}

// oauthConfig is the plain (non-PKCE) config used to REFRESH the token — refresh
// only needs the client id + refresh token, no code_verifier.
func oauthConfig() *oauth2.Config {
	return &oauth2.Config{
		ClientID:    cfg.clientID,
		RedirectURL: cfg.redirectURL,
		Scopes:      authScopes,
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://accounts.spotify.com/authorize",
			TokenURL: "https://accounts.spotify.com/api/token",
		},
	}
}

// clientFromToken builds a Spotify client whose token source auto-refreshes AND
// persists each refreshed token, and saves the initial token immediately.
// currentTokenSource yields fresh (auto-refreshed) access tokens; used to hand
// librespot a valid token when (re)spawning it.
var currentTokenSource oauth2.TokenSource

// currentAccountID is the webOS Accounts account we sourced the token from (if
// any); refreshed tokens are written back to it. Empty in the flat-file case.
var currentAccountID string

func clientFromToken(tok *oauth2.Token) *spotify.Client {
	saveToken(tok)
	base := oauthConfig().TokenSource(context.Background(), tok)
	src := oauth2.ReuseTokenSource(tok, &savingTokenSource{src: base, last: tok.AccessToken})
	currentTokenSource = src
	return spotify.New(oauth2.NewClient(context.Background(), src))
}

// freshAccessToken returns a current, non-expired access token (refreshing if needed).
func freshAccessToken() string {
	if currentTokenSource == nil {
		return ""
	}
	t, err := currentTokenSource.Token()
	if err != nil || t == nil {
		return ""
	}
	return t.AccessToken
}

// restoreSession reloads a token at startup. It prefers a webOS Accounts
// account (the Synergy-style path: the Accounts app owns the login), and falls
// back to the flat token file for the standalone/dev case.
func restoreSession() {
	acctID, tok := accountToken()
	src := "account " + acctID
	if tok == nil {
		acctID = ""
		if tok = loadToken(); tok == nil {
			log.Printf("no account credentials and no persisted token at %s (login required)", tokenPath)
			return
		}
		src = tokenPath
	}
	currentAccountID = acctID
	sess.mu.Lock()
	sess.client = clientFromToken(tok)
	sess.mu.Unlock()
	log.Printf("restored Spotify session from %s", src)
	go selectLibrespotDevice()
	startLibrespot()
}
