module github.com/hoehermann/purple-gowhatsapp

go 1.25.5

require (
	github.com/alfg/mp4 v0.0.0-20210728035756-55ea58c08aeb
	github.com/lib/pq v1.12.3
	github.com/mdp/qrterminal/v3 v3.2.1
	github.com/purpshell/meowcaller v0.0.0-20260717112041-9769d5aaaeca
	github.com/skip2/go-qrcode v0.0.0-20200617195104-da1b6568686e
	go.mau.fi/whatsmeow v0.0.0-20260716095330-85d99080dee8
	google.golang.org/protobuf v1.36.11
	maunium.net/go/mautrix v0.29.0
	modernc.org/sqlite v1.55.0
)

require (
	github.com/andybalholm/brotli v1.2.0 // indirect
	github.com/beeper/poly1305 v0.0.0-20250815183548-d4eede7bbf3c // indirect
	github.com/coreos/go-systemd/v22 v22.7.0 // indirect
	github.com/google/go-querystring v1.2.0 // indirect
	github.com/hajimehoshi/go-mp3 v0.3.4 // indirect
	github.com/icholy/digest v1.1.0 // indirect
	github.com/imroc/req/v3 v3.56.0 // indirect
	github.com/klauspost/compress v1.18.2 // indirect
	github.com/pion/datachannel v1.6.0 // indirect
	github.com/pion/dtls/v3 v3.1.2 // indirect
	github.com/pion/logging v0.2.4 // indirect
	github.com/pion/opus v0.1.0 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/sctp v1.9.4 // indirect
	github.com/pion/transport/v4 v4.0.1 // indirect
	github.com/quic-go/qpack v0.6.0 // indirect
	github.com/quic-go/quic-go v0.57.1 // indirect
	github.com/refraction-networking/utls v1.8.1 // indirect
	github.com/rs/xid v1.6.0 // indirect
	github.com/tidwall/gjson v1.19.0 // indirect
	github.com/tidwall/match v1.1.1 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tidwall/sjson v1.2.5 // indirect
	github.com/yuin/goldmark v1.8.4 // indirect
	go.mau.fi/zeroconfig v0.2.0 // indirect
	golang.org/x/image v0.44.0 // indirect
	golang.org/x/term v0.45.0 // indirect
	gopkg.in/natefinch/lumberjack.v2 v2.2.1 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

require (
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/beeper/argo-go v1.1.2 // indirect
	github.com/coder/websocket v1.8.15 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/elliotchance/orderedmap/v3 v3.1.0 // indirect
	github.com/google/uuid v1.6.0
	github.com/mattn/go-colorable v0.1.15 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/petermattis/goid v0.0.0-20260713124913-97594f28f5ca // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/rs/zerolog v1.35.1
	github.com/vektah/gqlparser/v2 v2.5.27 // indirect
	go.mau.fi/libsignal v0.2.2 // indirect
	go.mau.fi/mautrix-meta v0.2607.0
	go.mau.fi/util v0.9.11 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/exp v0.0.0-20260709172345-9ea1abe57597 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.40.0 // indirect
	modernc.org/libc v1.74.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
	rsc.io/qr v0.2.0 // indirect
)

replace github.com/imroc/req/v3 => github.com/beeper/req/v3 v3.0.0-20260703124114-47a4e2aa147e

// Local fork of meowcaller with the MLow encoder FFT twiddle-cache + DCT-table-cache optimizations
// (~2x faster encode, bit-exact output) so the pure-Go MLow codec runs real-time on the TouchPad's
// ARMv7. See third_party/meowcaller/mlow/{fft.go,lpc.go}. Upstream: v0.0.0-20260717112041-9769d5aaaeca.
replace github.com/purpshell/meowcaller => ./third_party/meowcaller
