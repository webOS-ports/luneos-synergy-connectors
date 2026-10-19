package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Transcodings as api-v2 lists them (urls shortened). Most tracks have AAC 160 and 96
// over HLS and an adaptive playlist; Go+ previews MP3; label tracks only encrypted ones.
const (
	scAAC160 = `{"url":"https://api-v2/a160","preset":"aac_160k","format":{"protocol":"hls","mime_type":"audio/mp4; codecs=\"mp4a.40.2\""}}`
	scAAC96  = `{"url":"https://api-v2/a96","preset":"aac_96k","format":{"protocol":"hls","mime_type":"audio/mp4; codecs=\"mp4a.40.2\""}}`
	scABR    = `{"url":"https://api-v2/abr","preset":"abr_sq","format":{"protocol":"hls","mime_type":"audio/mpegurl"}}`
	scMP3    = `{"url":"https://api-v2/p","preset":"mp3_1_0","format":{"protocol":"progressive","mime_type":"audio/mpeg"}}`
	scMP3HLS = `{"url":"https://api-v2/h","preset":"mp3_1_0","format":{"protocol":"hls","mime_type":"audio/mpeg"}}`
	scOpus   = `{"url":"https://api-v2/o","preset":"opus_0_0","format":{"protocol":"hls","mime_type":"audio/ogg; codecs=\"opus\""}}`
	scBare   = `{"url":"https://api-v2/b","format":{"protocol":"hls","mime_type":"audio/mp4; codecs=\"mp4a.40.2\""}}`
	scCBC    = `{"url":"https://api-v2/c","preset":"aac_160k","format":{"protocol":"cbc-encrypted-hls","mime_type":"audio/mp4; codecs=\"mp4a.40.2\""}}`
	scCTR    = `{"url":"https://api-v2/t","preset":"aac_160k","format":{"protocol":"ctr-encrypted-hls","mime_type":"audio/mp4; codecs=\"mp4a.40.2\""}}`
)

func scTrackJSON(id, title, transcodings string) string {
	return `{"id":` + id + `,"title":"` + title + `","duration":1000,"user":{"username":"u"},` +
		`"media":{"transcodings":[` + transcodings + `]}}`
}

func scParse(t *testing.T, transcodings string) scTrack {
	t.Helper()
	var tr scTrack
	if err := json.Unmarshal([]byte(scTrackJSON("1", "x", transcodings)), &tr); err != nil {
		t.Fatal(err)
	}
	return tr
}

func TestSoundcloudStreamsBestFirst(t *testing.T) {
	for _, c := range []struct {
		name, transcodings string
		want               []string // "label url"
	}{
		{"usual track", scAAC96 + "," + scABR + "," + scAAC160,
			[]string{"AAC 160 https://api-v2/a160", "AAC 96 https://api-v2/a96"}},
		{"preview: progressive before hls", scMP3HLS + "," + scMP3,
			[]string{"MP3 128 https://api-v2/p", "MP3 128 https://api-v2/h"}},
		{"by bitrate", scOpus + "," + scAAC96 + "," + scMP3,
			[]string{"MP3 128 https://api-v2/p", "AAC 96 https://api-v2/a96", "OPUS 64 https://api-v2/o"}},
		{"no preset: named by mime, after those with a bitrate", scBare + "," + scAAC96,
			[]string{"AAC 96 https://api-v2/a96", "AAC https://api-v2/b"}},
		{"encrypted only", scCBC + "," + scCTR, nil},
		{"adaptive only", scABR, nil},
		{"none", "", nil},
	} {
		tr := scParse(t, c.transcodings)
		var got []string
		for _, s := range tr.streams() {
			got = append(got, s.label+" "+s.url)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestSoundcloudPickStream(t *testing.T) {
	tr := scParse(t, scAAC96+","+scMP3HLS+","+scAAC160+","+scMP3)
	for _, c := range []struct{ format, url string }{
		{"", "https://api-v2/a160"},
		{"AAC 96", "https://api-v2/a96"},
		{"MP3 128", "https://api-v2/p"},
		{"OPUS 160", "https://api-v2/a160"}, // not offered: the best
	} {
		got, labels, ok := pickStream(tr.streams(), c.format)
		if !ok || got.url != c.url {
			t.Errorf("%q: got %+v %v, want %s", c.format, got, ok, c.url)
		}
		if want := []string{"AAC 160", "MP3 128", "AAC 96"}; !reflect.DeepEqual(labels, want) {
			t.Errorf("%q: labels %q, want %q", c.format, labels, want)
		}
	}
	if _, _, ok := pickStream(nil, ""); ok {
		t.Error("ok with nothing to play")
	}
}

func TestParseSoundcloudTracksLeavesOutUnplayable(t *testing.T) {
	body := `{"collection":[` +
		scTrackJSON("2366118086", "One More Time", scCBC+","+scCTR) + "," +
		scTrackJSON("88335161", "Plain", scAAC96+","+scABR) + "," +
		scTrackJSON("0", "No id", scAAC96) + "," +
		scTrackJSON("4", "Adaptive only", scABR) + "," +
		scTrackJSON("3", "Preview", scMP3HLS+","+scMP3) + `]}`
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
