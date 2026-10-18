// Command meowvideoloop validates meowcaller's video media path end to end against
// WhatsApp's live relay, using two real accounts you control — no webOS device, no
// native decoder, no camera required. It places a real 1:1 video call between a
// "caller" and a "callee" account, streams a synthetic H.264 elementary stream from
// the caller through Call.SendVideo, and records what the callee's ReceiveVideo sink
// actually gets back. Both the outbound (Call.SendVideo, engine_media.go's
// videoSender) and inbound (the video-RTP demux in engine_media.go's media loop)
// paths are explicitly marked "NOT VALIDATED" in the library; this tool is the
// cheapest way to find out which direction (if either) actually works, since both
// legs run the same code and a two-account loopback exercises it in full.
//
// First run against a fresh -caller-db/-callee-db pairs that account: it prints a
// scannable QR in the terminal — scan it from that account's own phone under
// Settings > Linked Devices > Link a Device. Subsequent runs reuse the paired
// session file. (An earlier version of this tool used phone-number-code pairing;
// that endpoint (link_code_companion_reg) returned a bare 400 bad-request against
// live WhatsApp servers regardless of number or whatsmeow version, so it was
// dropped in favor of the standard, far better-tested QR path.)
//
// Generate a synthetic test clip first (baseline profile, one slice per frame, a
// keyframe every 30 frames so the depacketizer/AU-grouping below stays simple):
//
//	ffmpeg -f lavfi -i testsrc=size=320x240:rate=30 -t 8 -c:v libx264 \
//	  -profile:v baseline -pix_fmt yuv420p -x264-params keyint=30:scenecut=0 \
//	  -bsf:v h264_mp4toannexb -f h264 testsrc.h264
//
// Usage:
//
//	meowvideoloop -caller-db caller.db -callee-db callee.db \
//	              -in testsrc.h264 -out received.h264
//
// After the run, compare -in and -out: frame/byte counts printed to stderr, plus (if
// ffmpeg is on PATH) whether the received stream actually decodes clean. Per-call
// diag/*.jsonl (video/rtcp/srtp/relay categories) land under -diag for a category-by-
// category post-mortem if it fails (see meowcaller's diag package doc).
//
// Build with CGO_ENABLED=0 on a non-ARM dev machine: mlow's celp_neon.c/fft_neon.c
// are guarded `//go:build arm && cgo`, but cmd/go still rejects the package's plain
// .c files when CGO_ENABLED=1 and neither tag matches (i.e. any amd64 dev box). This
// example has no cgo dependency of its own, so the plain-Go build is unaffected:
//
//	CGO_ENABLED=0 go build ./examples/videoloop/
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/mdp/qrterminal/v3"
	"github.com/purpshell/meowcaller"
	qrcode "github.com/skip2/go-qrcode"
	"github.com/purpshell/meowcaller/diag"
	"github.com/purpshell/meowcaller/rtp"
	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow"
	waLog "go.mau.fi/whatsmeow/util/log"

	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types/events"

	_ "modernc.org/sqlite"
)

func main() {
	var (
		callerDB, calleeDB       string
		inPath, outPath, diagDir string
		frameInterval            time.Duration
	)
	flag.StringVar(&callerDB, "caller-db", "caller.db", "sqlite session file for the calling account")
	flag.StringVar(&calleeDB, "callee-db", "callee.db", "sqlite session file for the answering account")
	flag.StringVar(&inPath, "in", "", "Annex-B H.264 elementary stream to send (see package doc for an ffmpeg recipe)")
	flag.StringVar(&outPath, "out", "received.h264", "where to record the callee's received video")
	flag.StringVar(&diagDir, "diag", "diag", "directory for per-call diag/*.jsonl (video/rtcp/srtp/relay categories)")
	flag.DurationVar(&frameInterval, "frame-interval", 33*time.Millisecond, "pacing between sent access units (match your test clip's frame rate)")
	flag.Parse()

	if inPath == "" {
		fmt.Fprintln(os.Stderr, "meowvideoloop: -in is required (an Annex-B .h264 file); see the package doc for an ffmpeg recipe")
		os.Exit(2)
	}

	data, err := os.ReadFile(inPath)
	if err != nil {
		fatal("read -in: %v", err)
	}
	aus := accessUnits(data)
	if len(aus) == 0 {
		fatal("no H.264 access units found in %s (expected Annex-B start codes)", inPath)
	}
	var inBytes int
	for _, au := range aus {
		inBytes += len(au)
	}
	fmt.Fprintf(os.Stderr, "meowvideoloop: %d access units, %d bytes, from %s\n", len(aus), inBytes, inPath)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	go func() { <-stop; cancel() }()

	callerLog := zerolog.New(zerolog.NewConsoleWriter()).With().Timestamp().Str("role", "caller").Logger()
	calleeLog := zerolog.New(zerolog.NewConsoleWriter()).With().Timestamp().Str("role", "callee").Logger()

	callerDiag, err := diag.NewRecorder(filepath.Join(diagDir, "caller"))
	if err != nil {
		fatal("caller diag dir: %v", err)
	}
	calleeDiag, err := diag.NewRecorder(filepath.Join(diagDir, "callee"))
	if err != nil {
		fatal("callee diag dir: %v", err)
	}

	callerWA, err := openDevice(ctx, callerDB, callerLog)
	if err != nil {
		fatal("caller device: %v", err)
	}
	calleeWA, err := openDevice(ctx, calleeDB, calleeLog)
	if err != nil {
		fatal("callee device: %v", err)
	}

	// meowcaller.NewClient must wrap each whatsmeow.Client before Connect() so its
	// low-level <call> interception is installed before the receive loop starts.
	callerCC := meowcaller.NewClient(callerWA, meowcaller.WithLogger(callerLog), meowcaller.WithDiagnostics(callerDiag))
	calleeCC := meowcaller.NewClient(calleeWA, meowcaller.WithLogger(calleeLog), meowcaller.WithDiagnostics(calleeDiag))

	fmt.Fprintln(os.Stderr, "meowvideoloop: connecting callee...")
	if err := connectAndPair(ctx, calleeWA, "callee"); err != nil {
		fatal("callee connect/pair: %v", err)
	}
	fmt.Fprintln(os.Stderr, "meowvideoloop: connecting caller...")
	if err := connectAndPair(ctx, callerWA, "caller"); err != nil {
		fatal("caller connect/pair: %v", err)
	}

	calleeTarget := calleeWA.Store.ID.ToNonAD().String()
	fmt.Fprintf(os.Stderr, "meowvideoloop: calling %s\n", calleeTarget)

	rec := &countingRecorder{}
	if err := rec.open(outPath); err != nil {
		fatal("open -out: %v", err)
	}
	defer rec.Close()

	answered := make(chan struct{}, 1)
	calleeCC.OnIncomingCall(func(call *meowcaller.Call) {
		fmt.Fprintf(os.Stderr, "meowvideoloop: callee got offer (video=%v), answering\n", call.IsVideo())
		call.ReceiveVideo(rec)
		call.OnEnd(func(reason string) {
			fmt.Fprintf(os.Stderr, "meowvideoloop: callee call ended: %s\n", reason)
		})
		if err := call.Answer(); err != nil {
			fmt.Fprintf(os.Stderr, "meowvideoloop: callee answer failed: %v\n", err)
			return
		}
		select {
		case answered <- struct{}{}:
		default:
		}
	})

	callCtx, callCancel := context.WithTimeout(ctx, 60*time.Second)
	defer callCancel()
	call, err := callerCC.CallWithOptions(callCtx, calleeTarget, meowcaller.CallOptions{Video: true})
	if err != nil {
		fatal("place call: %v", err)
	}

	ready := make(chan struct{}, 1)
	call.OnReady(func() {
		fmt.Fprintln(os.Stderr, "meowvideoloop: media ready, sending video")
		select {
		case ready <- struct{}{}:
		default:
		}
	})
	call.OnEnd(func(reason string) {
		fmt.Fprintf(os.Stderr, "meowvideoloop: caller call ended: %s\n", reason)
	})

	select {
	case <-answered:
	case <-time.After(30 * time.Second):
		fatal("callee never answered within 30s — a signaling problem, not a media problem")
	case <-ctx.Done():
		fatal("interrupted before answer")
	}

	select {
	case <-ready:
	case <-time.After(30 * time.Second):
		fatal("call answered but media never reported ready within 30s — check the relay/srtp diag categories")
	case <-ctx.Done():
		fatal("interrupted before media ready")
	}

	var sent int
	var sentBytes int
	for _, au := range aus {
		if err := call.SendVideoWithDuration(au, frameInterval); err != nil {
			fmt.Fprintf(os.Stderr, "meowvideoloop: SendVideo failed after %d access units: %v\n", sent, err)
			break
		}
		sent++
		sentBytes += len(au)
		select {
		case <-time.After(frameInterval):
		case <-ctx.Done():
			break
		}
	}

	// Give the last few packets (and any trailing RTCP) time to land before tearing
	// the call down.
	select {
	case <-time.After(2 * time.Second):
	case <-ctx.Done():
	}

	_ = call.Hangup()
	rec.Close()

	fmt.Fprintf(os.Stderr, "\nmeowvideoloop: SENT %d/%d access units (%d bytes)\n", sent, len(aus), sentBytes)
	fmt.Fprintf(os.Stderr, "meowvideoloop: RECEIVED %d access units (%d bytes) -> %s\n", rec.frames, rec.bytes, outPath)
	if rec.frames == 0 {
		fmt.Fprintln(os.Stderr, "meowvideoloop: FAIL — callee's VideoSink never got a single access unit; check diag/callee/{video,srtp,relay}.jsonl")
		os.Exit(1)
	}
	checkDecodable(outPath)
}

// accessUnits groups the Annex-B NAL units in data into access units: any run of
// non-VCL NALs (SPS/PPS/SEI/AUD) attaches to the following VCL slice (NAL type
// 1..5), and each subsequent VCL NAL starts a new access unit. This matches how
// engine_media.go reassembles access units on the RTP marker bit for one slice per
// picture (true for the baseline/-x264-params keyint=... recipe above; a clip with
// multiple slices per picture needs a smarter splitter).
func accessUnits(data []byte) [][]byte {
	nalus := rtp.SplitAnnexB(data)
	var aus [][]byte
	var cur []byte
	curHasVCL := false
	flush := func() {
		if len(cur) > 0 {
			aus = append(aus, cur)
		}
		cur = nil
		curHasVCL = false
	}
	for _, n := range nalus {
		if len(n) == 0 {
			continue
		}
		naluType := n[0] & 0x1f
		isVCL := naluType >= 1 && naluType <= 5
		if isVCL && curHasVCL {
			flush()
		}
		cur = append(cur, 0x00, 0x00, 0x00, 0x01)
		cur = append(cur, n...)
		if isVCL {
			curHasVCL = true
		}
	}
	flush()
	return aus
}

// countingRecorder is a meowcaller.VideoSink that records the callee's received
// video to a file while counting access units and bytes, so the run can report
// exactly what came back.
type countingRecorder struct {
	f      *os.File
	frames int
	bytes  int
}

func (r *countingRecorder) open(path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	r.f = f
	return nil
}

func (r *countingRecorder) WriteVideo(accessUnit []byte) error {
	r.frames++
	r.bytes += len(accessUnit)
	_, err := r.f.Write(accessUnit)
	return err
}

func (r *countingRecorder) Close() error {
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}

// openDevice opens (or creates) the sqlite-backed device store at dbPath and wraps
// it in an unconnected whatsmeow.Client. It does not Connect() or pair — the caller
// must wrap it with meowcaller.NewClient first (see the package doc on NewClient),
// then call connectAndPair.
func openDevice(ctx context.Context, dbPath string, log zerolog.Logger) (*whatsmeow.Client, error) {
	dbLog := waLog.Stdout("Database", "WARN", true)
	db, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	container := sqlstore.NewWithDB(db, "sqlite", dbLog)
	if err := container.Upgrade(ctx); err != nil {
		return nil, fmt.Errorf("upgrade store: %w", err)
	}
	// GetFirstDevice returns the store's only device, creating a fresh (unpaired)
	// one if the store is empty — the same pattern as whatsmeow's own mdtest example.
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return nil, fmt.Errorf("get device: %w", err)
	}
	return whatsmeow.NewClient(device, waLog.Stdout("Client", "WARN", true)), nil
}

// connectAndPair connects wa and, if its device has never been paired, renders each
// QR code WhatsApp sends (they rotate roughly every 20s) to the terminal and waits
// for the account to actually log in before returning. role ("caller"/"callee") is
// only used in the printed instructions.
func connectAndPair(ctx context.Context, wa *whatsmeow.Client, role string) error {
	result := make(chan error, 1)
	wa.AddEventHandler(func(evt any) {
		switch v := evt.(type) {
		case *events.QR:
			if len(v.Codes) == 0 {
				return
			}
			var sb strings.Builder
			qrterminal.GenerateHalfBlock(v.Codes[0], qrterminal.L, &sb)
			fmt.Fprintf(os.Stderr, ">>> scan this with the %s account's WhatsApp app (Settings > Linked Devices > Link a Device):\n%s\n", role, sb.String())
			pngPath := "qr-" + role + ".png"
			if err := qrcode.WriteFile(v.Codes[0], qrcode.Medium, 512, pngPath); err != nil {
				fmt.Fprintf(os.Stderr, "meowvideoloop: write %s: %v\n", pngPath, err)
			} else {
				fmt.Fprintf(os.Stderr, "meowvideoloop: also wrote %s (rotates ~every 20s, PNG only reflects the latest)\n", pngPath)
			}
		case *events.Connected:
			select {
			case result <- nil:
			default:
			}
		case *events.LoggedOut:
			select {
			case result <- fmt.Errorf("logged out: %v", v.Reason):
			default:
			}
		}
	})

	if err := wa.Connect(); err != nil {
		return err
	}

	select {
	case err := <-result:
		return err
	case <-time.After(3 * time.Minute):
		return errors.New("timed out waiting to connect/pair")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// checkDecodable shells out to ffmpeg (if present on PATH) to confirm the received
// Annex-B stream is actually valid, decodable H.264 — catching the case where bytes
// arrived but are garbled (wrong NAL framing, dropped fragments, corrupted SRTP).
func checkDecodable(path string) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		fmt.Fprintln(os.Stderr, "meowvideoloop: ffmpeg not on PATH, skipping decodability check")
		return
	}
	cmd := exec.Command("ffmpeg", "-v", "error", "-i", path, "-f", "null", "-")
	out, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Fprintf(os.Stderr, "meowvideoloop: FAIL — ffmpeg could not cleanly decode %s:\n%s\n", path, out)
		os.Exit(1)
	}
	if len(out) > 0 {
		fmt.Fprintf(os.Stderr, "meowvideoloop: ffmpeg decoded %s with warnings:\n%s\n", path, out)
		return
	}
	fmt.Fprintf(os.Stderr, "meowvideoloop: PASS — %s decodes clean\n", path)
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "meowvideoloop: "+format+"\n", args...)
	os.Exit(1)
}
