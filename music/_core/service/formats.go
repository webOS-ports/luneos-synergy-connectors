package main

import "context"

// The formats a resolve found, reported per request: /provider/<id>/resolve returns
// them with the URL, so a client that plays the URL itself (the QML player) can show
// the format and offer the others. setNowPlaying keeps feeding the daemon's own
// player's /stream/status as before.
type streamFormats struct {
	format  string   // the label of the stream resolved
	formats []string // the labels the track has, the resolved one included
}

type streamFormatsKey struct{}

// withFormatReport returns a context whose resolves report into the returned value.
func withFormatReport(ctx context.Context) (context.Context, *streamFormats) {
	f := &streamFormats{}
	return context.WithValue(ctx, streamFormatsKey{}, f), f
}

// reportFormats records the format a provider resolved and the ones it could have.
func reportFormats(ctx context.Context, format string, formats []string) {
	setNowPlaying(format, formats)
	if f, ok := ctx.Value(streamFormatsKey{}).(*streamFormats); ok {
		f.format, f.formats = format, append([]string(nil), formats...)
	}
}
