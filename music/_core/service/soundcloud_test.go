package main

import (
	"encoding/json"
	"testing"
)

// Transcodings as api-v2 lists them (urls shortened); a label track has only the
// encrypted ones.
const (
	scProgressive = `{"url":"https://api-v2/p","format":{"protocol":"progressive","mime_type":"audio/mpeg"}}`
	scHLS         = `{"url":"https://api-v2/h","format":{"protocol":"hls","mime_type":"audio/mp4; codecs=\"mp4a.40.2\""}}`
	scCBC         = `{"url":"https://api-v2/c","format":{"protocol":"cbc-encrypted-hls","mime_type":"audio/mp4; codecs=\"mp4a.40.2\""}}`
	scCTR         = `{"url":"https://api-v2/t","format":{"protocol":"ctr-encrypted-hls","mime_type":"audio/mp4; codecs=\"mp4a.40.2\""}}`
)

func scTrackJSON(id, title, transcodings string) string {
	return `{"id":` + id + `,"title":"` + title + `","duration":1000,"user":{"username":"u"},` +
		`"media":{"transcodings":[` + transcodings + `]}}`
}

func TestSoundcloudStreamTranscoding(t *testing.T) {
	for _, c := range []struct {
		name, transcodings, want string
	}{
		{"progressive first", scHLS + "," + scProgressive, "https://api-v2/p"},
		{"hls when no progressive", scCBC + "," + scHLS, "https://api-v2/h"},
		{"encrypted only", scCBC + "," + scCTR, ""},
		{"none", "", ""},
	} {
		var tr scTrack
		if err := json.Unmarshal([]byte(scTrackJSON("1", "x", c.transcodings)), &tr); err != nil {
			t.Fatal(err)
		}
		if got := tr.streamTranscoding(); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestParseSoundcloudTracksLeavesOutEncryptedOnly(t *testing.T) {
	body := `{"collection":[` +
		scTrackJSON("2366118086", "One More Time", scCBC+","+scCTR) + "," +
		scTrackJSON("88335161", "Plain", scHLS) + "," +
		scTrackJSON("0", "No id", scHLS) + "," +
		scTrackJSON("3", "Preview", scHLS+","+scProgressive) + `]}`
	got, err := parseSoundcloudTracks(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "88335161" || got[1].ID != "3" {
		t.Fatalf("got %+v, want tracks 88335161 and 3", got)
	}
	if got[0].Path != "soundcloud:88335161" || got[0].Artist != "u" || got[0].Provider != "soundcloud" {
		t.Errorf("track fields: %+v", got[0])
	}
}

func TestParseSoundcloudTracksBadBody(t *testing.T) {
	if _, err := parseSoundcloudTracks("<html>"); err == nil {
		t.Fatal("no error for a reply that is not JSON")
	}
}
