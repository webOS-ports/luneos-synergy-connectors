package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/zmb3/spotify/v2"
)

// spotifyISRC looks up a Spotify track's ISRC (+ title/artist for filenames) via
// our existing authenticated Spotify client. ISRC is the cross-service key that
// lets a first-party lossless service find the same recording.
func spotifyISRC(ctx context.Context, spotifyID string) (isrc, title, artist string, err error) {
	sess.mu.RLock()
	c := sess.client
	sess.mu.RUnlock()
	if c == nil {
		return "", "", "", fmt.Errorf("no Spotify session")
	}
	// Accept "spotify:track:ID" or a bare id.
	id := spotifyID
	if i := lastColon(spotifyID); i >= 0 {
		id = spotifyID[i+1:]
	}
	t, err := c.GetTrack(ctx, spotify.ID(id))
	if err != nil {
		return "", "", "", err
	}
	isrc = t.ExternalIDs["isrc"]
	title = t.Name
	if len(t.Artists) > 0 {
		artist = t.Artists[0].Name
	}
	return isrc, title, artist, nil
}

func lastColon(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == ':' {
			return i
		}
	}
	return -1
}

// decodeJSON decodes a request body into v (tolerant of empty bodies).
func decodeJSON(r *http.Request, v interface{}) error {
	if r.Body == nil {
		return nil
	}
	return json.NewDecoder(r.Body).Decode(v)
}
