package main

import (
	"strings"
	"testing"
)

func TestParseJamendoTracks(t *testing.T) {
	for _, c := range []struct {
		name    string
		body    string
		n       int    // tracks expected when no error
		wantErr string // substring of the error, "" for none
	}{
		{
			name: "success",
			body: `{"headers":{"status":"success","code":0,"error_message":"","warnings":"","results_count":2},` +
				`"results":[{"id":"1","name":"A","artist_name":"X","duration":61,"audio":"https://a/1.mp3"},` +
				`{"id":"2","name":"B","artist_name":"Y","duration":62,"audio":"https://a/2.mp3"}]}`,
			n: 2,
		},
		{
			name: "success, no match",
			body: `{"headers":{"status":"success","code":0,"error_message":"","warnings":"","results_count":0},"results":[]}`,
			n:    0,
		},
		{
			// verbatim from the API with the demo client_id
			name:    "usage limit warning",
			body:    `{"headers":{"status":"success","code":0,"error_message":"","warnings":"Usage limits are exceeded for this request, please contact Jamendo before we block your access to this request","results_count":0},"results":[]}`,
			wantErr: "Usage limits are exceeded for this request",
		},
		{
			name:    "failed status",
			body:    `{"headers":{"status":"failed","code":5,"error_message":"Your credential is not authorized.","warnings":"","results_count":0},"results":[]}`,
			wantErr: "request failed (code 5): Your credential is not authorized.",
		},
		{
			name:    "failed status, message only in warnings",
			body:    `{"headers":{"status":"failed","code":3,"error_message":"","warnings":"bad parameter","results_count":0},"results":[]}`,
			wantErr: "bad parameter",
		},
		{
			name: "warning alongside results is not an error",
			body: `{"headers":{"status":"success","code":0,"error_message":"","warnings":"deprecated parameter","results_count":1},` +
				`"results":[{"id":"1","name":"A","audio":"https://a/1.mp3"}]}`,
			n: 1,
		},
		{
			name: "no headers object",
			body: `{"results":[{"id":"1","name":"A","audio":"https://a/1.mp3"}]}`,
			n:    1,
		},
		{
			name:    "not json",
			body:    `<html>`,
			wantErr: "jamendo parse",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseJamendoTracks([]byte(c.body))
			if c.wantErr != "" {
				if err == nil {
					t.Fatalf("no error, got %d tracks", len(got))
				}
				if !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("error %q does not contain %q", err, c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != c.n {
				t.Fatalf("%d tracks, want %d", len(got), c.n)
			}
		})
	}
}
