# WhatsApp video calling — status

## TL;DR

**Go/network media path: validated live, both directions.** `examples/videoloop` placed a real
two-account WhatsApp video call and streamed a synthetic clip end to end — 240/240 access units
sent and received, byte-identical to the source, decoded clean in ffmpeg. This clears the
`NOT VALIDATED` markers on `Call.SendVideo`/`Call.ReceiveVideo`/`videoSender` in meowcaller.

**Native device side: root cause found and fixed. `videoCaptureStart` AND `videoPlayerStart` both
now return `true` and a real GStreamer `ManagedClonkPipeline` gets constructed on-device, confirmed
live for both directions.** webOS's Skype
video calling never had its own media stack — it drove a general-purpose real-time video-call
session type (`clonk`) already built into the stock `mediaserver` daemon, the same process that
does stock H.264 file playback. That session type is still present and instantiable on this exact
TouchPad, confirmed live. The real per-session LS2 handler class, `media::luna::ClonkServer`, was
found directly in `libmedia-api.so`'s symbol table.

**Part 5/6's "ClonkServer business object is null" theory was wrong** — corrected in Part 8 below.
The actual bug was the **payload shape**: earlier disassembly of the array-*indexing* code
(`JValue::operator[](int)`, applied to a JValue already called `args`) was misread as "the whole
payload is a bare array." Disassembling `LunaInterface::getArguments` directly (the shared helper
every action method calls first) shows it does `pbnjson::JDomParser::parse(payload, ...)` and then
**`dom["args"]`**, requiring *that* to be an array — the literal string `"args"` lives in
`libmedia-api.so`'s `.rodata` at `0x153f5c`. A bare top-level array parses as valid JSON but fails
`dom["args"].isArray()` (indexing an array by a string key isn't an array), which silently sets an
internal `ok` flag false and produces exactly the clean, textless `{"returnValue":false}` we'd been
seeing — without the code ever reaching the real virtual dispatch into the business object. The fix
is trivial: wrap every action-method payload in `{"args":[...]}` — e.g.
`videoCaptureStart {"args":[320,240,15,400000]}`, `setDeviceUri {"args":["device://camera/front"]}`,
`videoCaptureStop {"args":[]}` (stop takes no business params but still requires the wrapper key to
exist, or it skips the real call too). Confirmed live via `clonk_probe`: `videoCaptureStart` now
returns `{"returnValue":true}`, `getVideoCaptureHasPipeline` flips to `true`, and
`/var/log/messages` shows `mediaserver` actually constructing a `ManagedClonkPipeline` for the
session (torn down on session end, `ManagedClonkPipeline::~ManagedClonkPipeline() pipeline not
suspended` — a real, not-yet-graceful-shutdown pipeline, i.e. real pipeline activity, not a no-op).
See Part 8 for the full disassembly trail. Separately, the entire Phone-app UI integration contract
(Part 4) is fully specified from real `core-apps` source — no further research needed there, only
implementation. Camera contention from Atlas's `qcamd` was checked and ruled out directly via
`/proc/<pid>/fd`.

**Architecture pivot (Part 9): the planned "shm frame handoff" is very likely not the real
integration point.** Chasing it down found the actual mechanism (`VideoSink`'s SysV shm segment,
keyed by a private heap pointer no external process could predict), but zero segments ever appeared
during a real live test, and `ClonkServer`'s full ~50-method LS2 surface has no frame/buffer getter
at all. What it *does* expose — `H264SenderConstraints`/`H264SenderParameters`/
`H264ReceiverParameters`, whose fields decode via disassembly to the literal RFC 6184 SDP `fmtp`
parameter names (`max-mbps`, `max-fs`, `max-br`, etc.) — plus `test_GenerateCapturePcap`/
`test_GenerateReceivePcap` test hooks, is strong evidence `mediaserver`'s `ClonkPipeline` does full
H.264 encode/RTP-payload/network-send (and the receive mirror) *internally*, not via a raw-frame
handoff to an external process. The open question is now **how that RTP transport gets pointed at a
destination** (no address/port/socket property found yet) — see Part 9 for the full trail.

**Resolved (Part 10): the RTP boundary is `skypevideosrc`/`skypevideosink`, backed by a real, embedded
copy of Skype's own SkypeKit SDK.** `libpalmgstskype.so` isn't webOS-specific glue — `nm -C -D` and
`strings` on it turn up an entire `Sid::` SkypeKit namespace (`Sid::Protocol::BinClient`,
`Sid::UnixSocket`, `SkypeVideoRTPInterface`, source path
`Inc/skypekit/ipc/cpp/AVTransport/SocketTransport.cpp`). The actual data plane is two fixed-name
**abstract-namespace Unix domain sockets** — `/tmp/vidrtp_to_skypekit_key` and
`/tmp/vidrtp_from_skypekit_key` (plus a PCM pair for audio) — carrying RTP packets wrapped in
SkypeKit's own binary RPC framing (`wr_call_lst`/`ProcessCall`). This is genuinely good news: it's a
well-known IPC boundary SkypeKit was always designed for an external process to plug into, not
something to reverse-engineer from nothing. **Confirmed the exact role split:** `mediaserver` is the
**server** (listens) on `vidrtp_from_skypekit_key` for incoming video, and the **client** (dials out)
on `vidrtp_to_skypekit_key` for outgoing video — so a bridge needs to bind the first and connect to
the second.

**Correction (Part 11): the wire-protocol question was premature.** Built a tool
(`vidrtp_sniffer.c`) to capture real bytes off `vidrtp_to_skypekit_key` instead of guessing the byte
format — and `mediaserver` never connected at all, in two full test runs. Root-caused with
`--gst-debug=4`: the GStreamer pipelines never actually reach a linked, running state, so there's no
real RTP traffic yet regardless of the SkypeKit socket layer. Found two concrete, ordinary
GStreamer-level problems: (1) **capture side, fixed** — `camsrc` only supports exactly
`640x480`/`320x240`/`160x128`, all fixed at `framerate=30`, and `clonk_probe` had been requesting
`framerate=15`; switched to `30` and the caps-negotiation error is gone. (2) **player side, found,
turned out to be a non-issue** — `gst_skype_video_src_change_state` warns
`"resolution not set on capsfilter"`, but Part 12 proved this does **not** block `RunVideoHost()`
or the SkypeKit socket layer at all; it just needs more than a few seconds. See Part 12.

**Resolved (Part 12): real connectivity to `mediaserver`'s live SkypeKit socket is now proven.**
Confirmed `RunVideoHost()` genuinely starts on its own given enough time (`/tmp/vidrtp_from_skypekit_key`
appears reliably and stays bound), and via `strace` confirmed the listening window is a real multi-second
window, not a race. The one thing actually blocking every connection attempt was a simple bug in the
test tool, not mediaserver: the abstract socket name is the literal string `"/tmp/vidrtp_from_skypekit_key"`
(`/tmp/` included, despite being an abstract name with no real filesystem path) — `vidrtp_sniffer` was
only passing the `vidrtp_from_skypekit_key` suffix. Fixed, and `vidrtp_sniffer client
/tmp/vidrtp_from_skypekit_key ...` now connects successfully every time. Held it open 16+ seconds:
`mediaserver` sends nothing unprompted, confirming it's the passive `Sid::Protocol::BinServer` side,
waiting to read an RPC call from us. **The only remaining piece is implementing enough of
`Sid::Protocol::BinClient`'s wire framing to send one** — `mediaserver` is proven ready and waiting.
See Part 12 for the full trail.

**Decoded (Part 13) and confirmed working live (Part 14): a real, hand-constructed `RtpPacketReceived`
RPC call successfully reaches and is processed by `mediaserver`.** Rather than reverse-engineer the
exact wire bytes (real but genuinely risky work — two hand-arithmetic mistakes surfaced in Part 13
alone), pivoted to **linking a small test program directly against the real, extracted
`libpalmgstskype.so`** and calling its actual compiled `AVTransportWrapper`/`Sid::Protocol::BinClient`/
`SEBinary`/`wr_call_lst` functions with our own arguments — reusing 100% of the real, tested wire
encoder instead of reimplementing it. `RtpPacketReceived`'s exact command ID (**20**) and field-table
location were found via verified relocation-table lookups, not guessed. Built, iteratively debugged
live on-device (a `SIGSEGV` handler added directly to the test tool, since gdb remote debugging has
been unreliable all session and this device's `strace` is too old to decode fault addresses), and
**it works**: `wr_call_lst` returns success, `mediaserver` stays fully healthy, and `--gst-debug=4`
shows the call had a real, visible effect — `clonkvhsrc`'s internal `rtp` element, which *never*
showed any lifecycle activity in any earlier test this session, now logs real `unlock`/`create`
activity in response. This is the single hardest open question of the whole investigation — "can we
actually talk to mediaserver's SkypeKit interface without the real SDK" — now demonstrated, not just
theorized. See Parts 13–14 for the full trail, including the two bugs found and fixed via live
testing (an `SEBinary` initial-state bug and a field-table-indexing bug).

**Resolved (Part 15): the `"wrong state (unlocked)"` message from Part 14 is normal `GstBaseSrc`
teardown behavior, not a sequencing bug.** Disassembly of `gst_skype_rtp_src_create` showed it's the
standard pattern of checking an `unlock()`-set flag before pulling from its internal queue. Retested
with the player-active window extended from 25s to 90s: the message appeared exactly once, timestamped
to the exact moment of our own test's intentional teardown (~92s in, right after `unlock()` fires),
and nowhere else in a 19150-line capture. The `rtp` element's src pad links and starts its streaming
task cleanly at ~7s, well before any teardown. Nothing left to chase on the incoming (`RtpPacketReceived`)
path. See Part 15 for the full trail.

**Found and fixed a real firmware bug blocking the outgoing (capture) path entirely (Part 16), but a
further blocker remains.** `ClonkPipeline::setCamCapsFilter()` reads the wrong offsets (`+4`/`+8`
instead of `+0`/`+4`) off the `VideoSettings` object when building `camsrc`'s downstream capsfilter,
so `videoCaptureStart(w,h,fps,bitrate)`'s own `h`/`fps` values silently ended up as the applied
`width`/`height` — guaranteeing "Could not negotiate format" every time. Confirmed via disassembly
and fixed with an LS2-level workaround (shift `h`/`fps` argument values by one slot); with the fix,
`camsrc` reaches `PLAYING`, `getVideoCaptureActive` flips `true`, and the whole capture→encoder→sink
chain runs with zero GStreamer errors — the first time capture has ever genuinely worked this session.
**Resolved (Part 17): the outbound socket connect is gated behind a client first connecting to the
*incoming* socket.** Disassembly of `GstSkypeInstance::RunVideoHost()` shows a strict two-phase
structure — it loops on `AVServer::Connect` (bind+listen+accept on `/tmp/vidrtp_from_skypekit_key`)
and only reaches the outbound `AVTransportWrapper::Connect` call once that accept succeeds. Confirmed
live: connecting `skypekit_send_test` to the inbound socket while `vidrtp_sniffer` waited on the
outbound one made `mediaserver` dial out and send 535 real bytes within moments — the first outbound
SkypeKit traffic captured all session. See Part 17 for the full trail and the captured bytes.

**Decoded (Part 18): the 535-byte capture is a real, standard RTP/H.264 packet.** Built
`skypekit_decode_test` — same safe "link against the real `.so`" technique as Part 14, applied to
reading instead of writing — to replay the captured bytes through the real, compiled
`Sid::Protocol::BinServer::rd_call`/`rd_parms` decoder rather than hand-parsing them. Found every
message starts with a 2-byte sync+type header (`0x5a` fixed sync byte, then a type byte — `0x52`='R'
for a call), consumed by `rd_command` before `rd_call`. Once framed correctly, decoded a clean
525-byte payload that is unambiguously a standards-compliant RTP packet carrying genuine H.264 video:
valid RTP header (version 2, marker set, payload type 96 matching the pipeline's own negotiated caps,
real sequence/timestamp/SSRC), followed by a valid H.264 NAL unit (`0x41` = non-IDR coded slice) as
the very first payload byte. No SkypeKit-proprietary frame format to reverse-engineer beyond the
already-decoded framing — the payload itself is ordinary RTP/H.264, matching what
`meowcaller`/`whatsmeow`'s `Call.SendVideo` already expects. See Part 18 for the full trail.

---

## Part 1 — meowcaller video media path (done tonight, no device needed)

Built `examples/videoloop`: a two-account loopback tool that places a real 1:1 WhatsApp video call
and streams a synthetic H.264 clip from caller to callee through `Call.SendVideo`, recording what
`Call.ReceiveVideo` gets back.

**Result:** 240/240 Annex-B access units sent and received (cross-checked against
`diag/callee/video.jsonl`'s frame count), `received.h264` byte-length matched the source, decoded
with zero ffmpeg errors. Both directions of meowcaller's video media path work over the real
relay. See `CHANGELOG.md` and the updated comments in `livecall.go`/`engine_media.go`.

Also fixed along the way: phone-number-code pairing (`link_code_companion_reg`) returns a bare
`400 bad-request` against live WhatsApp servers regardless of number or whatsmeow version —
`examples/videoloop` uses standard QR pairing instead (works reliably; renders a scannable PNG via
`github.com/skip2/go-qrcode` in addition to the terminal QR).

**Not yet done:** bumping the same whatsmeow version into `purple-combined`'s own go.mod if
useful, and hooking a real webcam-encoded H.264 source into a live call (see Part 2).

## Part 2 — how Skype video calling actually worked on this hardware

Reverse-engineered from the shipped, unstripped `mediaserver` binary (full C++ symbols) plus a
webOS 3.0.5 rootfs image, then confirmed live against the connected TouchPad
(`Nova-HP-Topaz` / `linux-palm-tenderloin`, novacom device `topaz-linux`).

### The architecture

`skypem` (the Skype signaling mediator — analogous to our `glue/call.c`) **never links any media
library**. It drives everything over LS2 against `com.palm.mediad`, which is owned entirely by
`/usr/bin/mediaserver` — **the same daemon that already does stock H.264 file playback** via
`palmvideodecoder`. `mediaserver` exposes three session types:

- `service/playback` — stock file playback (what the Video app uses).
- `service/captureV3` — photo/video/audio capture (what voice-note recording uses).
- `service/clonk` — **a third, purpose-built real-time two-way video-call session type**, used by
  Skype but implemented as a generic facility, not Skype-specific.

Calling `palm://com.palm.mediad/service/clonk` with `{}` allocates a `media::pipeline::ClonkSession`
and returns a per-call bus name (confirmed live: `palm://com.palm.mediad.Clonk_NNNN/`). Symbols
recovered from `mediaserver` (full list in git history of this file / session transcript) show:

- **Capture (outgoing):** property `deviceUri` (e.g. `device://camera/front`, confirmed default),
  `videoCaptureActive` (bool — **setting this true is what starts capture**, internally invoking
  `ClonkSession::videoCaptureStart(w,h,fps,bitrate)`), tunable via `h264SenderConstraints`/
  `h264SenderParameters`/`videoBitrate`.
- **Playback (incoming):** `videoPlayerActive`, `h264ReceiverParameters`, wired internally to a
  GStreamer bin literally named `clonk_vplay_h264dec` — real H.264 decode, distinct from the
  file-playback `palmvideodecoder` path.
- **Picture-in-picture:** `pip`/`PipSettings`/`getTranslatedPipPosition` — local camera preview
  overlaid on remote video.
- Keyframe requests, camera orientation (`getLocalVideoRotation`/`getRemoteVideoRotation`), CPU
  scaling hints (`setCpuScalingForVideo`) — all present.

The GStreamer plugin providing the actual `skypevideosrc`/`skypevideosink` elements
(`libpalmgstskype.so`, confirmed caps `video/x-h264`) is exactly what `skype-disable/remove-skype.sh`
moved to `/var/skype-disabled-backup` — **that script never touched `libmedia-clonk.so` or
`mediaserver` itself**, only the Skype-specific launch path.

### The LS2 calling convention (confirmed live)

Property accessors are named identically to the C++ getters/setters and respond instantly:

```
luna-send -n 1 palm://com.palm.mediad.Clonk_NNNN/getDeviceUri '{}'
  -> {"propertyRead":{"name":"deviceUri","value":"device://camera/front"},"returnValue":true}
luna-send -n 1 palm://com.palm.mediad.Clonk_NNNN/getVideoCaptureActive '{}'
  -> {"propertyRead":{"name":"videoCaptureActive","value":false},"returnValue":true}
```

`getVideoBitrate`/`getCaptureDevices`/`getError` hang instead of erroring — likely the same PJSON
"Attempt to append into non-array" bug logged at every `mediaserver` startup, hitting
array/complex-typed properties specifically. Scalar bool/string properties are unaffected.

### The methodology trap (important for any further testing)

**A Clonk session's lifetime is tied to its creating client's LS2 connection.** Confirmed live:
killing the `luna-send` process that created a session immediately logs
`Stopping session palm://com.palm.mediad.Clonk_NNNN/` in `/var/log/messages`. Since every
`luna-send -n 1 ...` invocation is a *separate* one-shot process, a sequence of independent
`luna-send` calls against the same session tears the session down after the very first call — every
"TIMED OUT" seen while probing `setVideoCaptureActive` this way is **confounded** and proves
nothing about whether the call itself works.

**Fix:** `clonk_probe.c` (new, this directory) holds one `LSHandle` for the whole sequence — create
session → `getDeviceUri` → try candidate write calls → wait 3s → check status → wait 2s → cleanup
— exactly like a real client (`skypem`) would. This is the *first* methodologically-valid test of
whether any given write call actually starts a pipeline. Results are in Part 3.

## Part 3 — live test results (after the reboot below) and where the trail goes cold

`clonk_probe` ran correctly (persistent connection, no confounding) and got a clean, definitive
answer: **`setVideoCaptureActive` is not a registered method** —
`{"returnValue":false,"errorCode":-1,"errorText":"Unknown method \"setVideoCaptureActive\" for
category \"/\""}`. This is a real error, not a hang, and `videoCaptureHasPipeline` stayed `false`
throughout — the test never touched the camera.

Since `getDeviceUri`/`getVideoCaptureActive`/`getVideoCaptureHasPipeline` all work as literal
per-property getters, tried every plausible corresponding write convention, all cleanly rejected
the same way:

- `set` with `{"name":"videoCaptureActive","value":true}` → `Unknown method "set"`
- `set` with `{"videoCaptureActive":true}` → `Unknown method "set"`
- `videoCaptureActive` (bare property name) with `{"value":true}` → `Unknown method
  "videoCaptureActive"`
- `videoCapture` (no suffix) with `{"active":true}` / `{"value":true}` → `Unknown method
  "videoCapture"`
- Passing `{"videoCaptureActive":true,"deviceUri":"..."}` directly in the *session-creation* call
  (create-with-options theory) — session created fine, but the extra fields were silently
  ignored (`getVideoCaptureActive` still read back `false` afterward).

**Conclusion: guessing the write method name from the C++ symbol table is exhausted.** Plain
`strings` also turned up `setVideoCaptureBitrate`/`setVideoCaptureFramerate` as bare (non-mangled)
strings, but these are almost certainly `__FUNCTION__` debug-log literals from the matching
`ClonkPipeline` methods (matched exactly by mangled `...E12__FUNCTION__` symbols nearby), not proof
of an LS2 registration. Also found in this pass: `palmvideoencoder` and `palmvideosink` — a stock
hardware H.264 **encoder** element in the same gst-0.10 `palm*` family as the confirmed-working
`palmvideodecoder`, distinct from the newer gst-omx `omxh264enc` that `webos-vc`'s history found
broken — worth keeping in mind for Part 2's outgoing-encode plan regardless of how the `clonk`
question resolves.

**Update — found it.** `media::luna::ClonkServer` (the actual per-session category handler) isn't
in `mediaserver` or `libmedia-clonk.so` at all — it's defined in **`libmedia-api.so`**, confirmed
via plain (non-mangled-guessing) `nm -C`. That symbol table is a complete, authoritative list of
every real LS2 method: `videoCaptureStart`/`videoCaptureStop`, `videoPlayerStart`/`videoPlayerStop`,
`audioCaptureStart`/`Stop`, `audioPlayerStart`/`Stop`, `setDeviceUri`, `setPip`/`getPip`,
`setError`/`getError`, `updatePipSettings`, plus every `getX`/`setX` pair for the full property
list from Part 2, and `test_ExerciseHog`/`test_SetAudioSrcProperties`. **`videoCaptureStart` — the
very first thing tried at the start of this whole investigation — was right all along.** It only
ever "hung" back then because of the session-lifetime bug (Part 2); it was never retested with the
fixed persistent-connection tool until now.

Retested live with `clonk_probe`: `videoCaptureStart` is now accepted (no more `Unknown method`),
returning a clean `{"returnValue":false}` — **and no `"Unable to instantiate Clonk VH
Source/ahSink"` pipeline error appeared in the log**, meaning this is very likely a parameter-shape
problem (wrong field names/types in the 4-arg `width,height,framerate,bitrate` call), not a
hardware or architecture dead end. Tried `{"width":320,"height":240,"framerate":15,"bitrate":400000}`
and `{"width":320,"height":240,"framerate":15}` (matching the plain-string field names `width`/
`height`/`framerate` found in `mediaserver`, since `bitrate` wasn't among them — it has its own
separate `videoBitrate` property) — both cleanly `false`, no pipeline errors either way.

**Update — disassembled it (skypem's own backend is defunct — Skype's servers shut down years
ago, and `skype-disable`'s removal broke its LS2/db8/account registration too, so `strace`-ing a
real call was never actually viable; static analysis was the only path).** `objdump -d` on
`ClonkServer::videoCaptureStart` in `libmedia-api.so` (ARM disassembly, cross toolchain at
`~/x-tools/arm-unknown-linux-gnueabi-gcc125/bin/arm-unknown-linux-gnueabi-objdump` — note: the
*unprefixed* `objdump` on this machine resolves to the host x86 one and fails with "can't
disassemble for architecture UNKNOWN" on these ~2011 EABI5 binaries; use the prefixed one) shows:

- Exactly **one** `LunaInterface::getArguments()` call. Its "name" argument resolves (traced
  through the PC-relative/GOT-relative address arithmetic — see git history of this file for the
  worked Python calculation) not to a JSON key, but to a `__PRETTY_FUNCTION__`-style debug string
  (`"static bool media::luna::ClonkServer::videoCaptureStart(LSHandl..."`) — i.e. that argument is
  only used for error-context logging, not as a lookup key.
- Followed by four `pbnjson::JValue::operator[](int)` calls with **literal integer indices 0, 1,
  2, 3**, each piped through `ClonkServer::unmarshallunsigned_long(JValue)`.

**Conclusion (incomplete — corrected in Part 8): the payload is a bare 4-element JSON array**
(`[width, height, framerate, bitrate]` in argument order — matching
`ClonkSession::videoCaptureStart(w,h,fps,bitrate)`'s C++ signature), not an object. `setDeviceUri`
was checked the same way and has the identical shape: `getArguments()` → `operator[](0)` →
`unmarshallstring()`, i.e. its payload is `["device://camera/front"]`, not `{"value":"..."}`.
**What this missed:** the `operator[](int)` calls index into the JValue *`getArguments()` itself
returns*, not the raw top-level payload — and `getArguments()` (traced fully in Part 8) internally
does `dom["args"]` before ever getting there, requiring the payload to be `{"args":[...]}`. A bare
array happens to *parse* fine, which is why this looked plausible at the time (see next paragraph:
it was "accepted", not rejected with "Unknown method") — it just never actually reaches the
`operator[](int)` calls at all, because `dom["args"]` on a bare array fails `isArray()` first and
short-circuits to a silent `false`.

Tested live: `videoCaptureStart` with `[320,240,15,400000]` is **accepted** (parses fine, no
crash) but still returns a bare `{"returnValue":false}` with no error text and — still — no
pipeline-instantiation error in the log. Investigated one concrete hypothesis (Atlas's own camera
daemon, `qcamd`, holding `/dev/video0`, since this device dual-runs the legacy webOS layer
alongside Atlas/webOS-ports and `qcamd` is exactly what `webos-vc`'s `getUserMedia` path uses) —
**ruled out**: checked `/proc/<qcamd-pid>/fd` directly, it wasn't holding the device open at all
(idle on a socket + its own shm segment, camera opened on-demand only).

**Update — proved (not theorized) exactly where it fails, via `strace`.** Attached `strace -f`
to the live, already-running `mediaserver` (no restart needed — `strace -f -tt -p <pid> -o
<logfile>`) and ran `clonk_probe` through it. The raw LS2 wire messages confirm both calls arrive
intact (`recv(45, "/\0videoCaptureStart\0[320,240,15,"..., 41, ...)`), but in the entire window
between that `recv` and the next one three seconds later, **there is no `open()` on any
`/dev/video*` node, no camera `ioctl`, nothing hardware-related at all**. Raising `mediaserver`'s
own `--gst-debug` to 4 (temporarily: `stop mediaserver`, run it manually in the foreground with
the flag, redirect output, `start mediaserver` again after — see git history for the exact script)
confirms the same thing from the GStreamer side: debug output stops right after basic init: no
pipeline, element, or pad activity is ever logged for our calls. **The failure is 100% in C++
business logic, before any camera or GStreamer code runs.**

Traced the call chain one level further to find *why*: disassembly of `videoCaptureStart` shows a
null-check on a pointer 16 bytes into the handler's `void *ctx` argument, followed by a vtable
call through it — if that pointer is null, the function returns `false` immediately (matches the
symptom exactly). Traced backward through session creation to find what populates it:
`LunaService::clonkPipeline` (session-open handler) → `MediaServer::openSession` (generic,
locking/refcounting machinery shared across all three session types) → dispatches via vtable to
`ManagedPipelineFactory::createClonkControl(ClonkState&)`, which **unconditionally constructs a
`ManagedClonkPipeline`** at session-open time via `new` + placement construction — no conditional
path, no missing-device branch. This actually *disproves* the obvious theory (that the control
object simply doesn't exist yet) — a control object is always created. Why the specific
pointer `ClonkServer` methods dereference is still null despite that needs one more level of
tracing (either into `ManagedClonkPipeline`'s own layout, or the `ClonkServer` constructor).

**Update — `videoPlayerStart` (the receive/decode direction, previously untested) fails the exact
same way.** Same disassembly convention confirmed (one `getArguments()`, two
`unmarshallunsigned_long(operator[](0/1))` calls → bare array `[width,height]`), same live result:
accepted, no error, clean `{"returnValue":false}`, no pipeline activity. **This is one shared root
cause blocking both directions, not two separate bugs** — fixing it once unlocks both send and
receive.

## Part 4 — the Phone app UI integration contract (fully mapped, from real source)

Checked `/home/herrie/Documents/GitHub/core-apps` (`com.palm.app.phone`) — there is no separate
"video app"; video calling is a scene inside the stock Phone app, built originally for Skype and
still fully intact. This closes out the entire render/UI side of the design, independent of the
native bug above:

- **`shared/activecall/VideoCall.js`** renders incoming video with a plain Enyo `Video` kind
  (`{name:"videoTag", kind:"Video", ...}`) — i.e. the same WebKit `MediaPlayerPrivatePalm` /
  `com.palm.mediad` backend already confirmed for stock file playback, not a custom native widget.
  `enableVideo(videoURI)` calls `this.$.videoTag.setSrc(videoURI)` directly.
- **`call.videoURI` *is* the clonk session's own LS2 URI.** Proven two ways: (1)
  `source/CallSynergizer.js:358-359` — `call.videoURI = payload.videoURI; enyo.application.Cache.videoURI = payload.videoURI;`
  reads it straight from our own `callStateQuery` subscription response (top-level field, not
  per-line); (2) `ActiveCall.js:251-252` logs it literally as `"CLONK IS " + enyo.application.Cache.videoURI`
  and assigns `this.clonkPipeline = enyo.application.Cache.videoURI`. (3) `VideoCall.js`'s PiP calls
  (`updatePipSettings`/`getPip`/`setPip`) are issued with no static `service:` in the component
  declaration — the target is passed per-call as `{service: this.videoURI}`, meaning it must
  literally be a valid LS2 service URI, i.e. `palm://com.palm.mediad.Clonk_NNNN/`.
- **`updatePipSettings`'s real JSON shape**, straight from `VideoCall.js:235`:
  `{args:[{top_left:{x,y}, bottom_right:{x2,y2}, scale, orientation}]}` — corner coordinates and a
  scale/orientation, not width/height. Matches the `PipSettings` marshalling we found in
  `ClonkServer`'s symbol table.
- **`changeMedia(id, outgoingVideo, incomingVideo)`** is called against the **per-transport call
  service** (`palm://com.palm.skype/` in the original code — for us, `com.palm.whatsapp.call`), not
  against the clonk session directly. This is the call-mediator's job: `glue/call.c` needs to
  implement this LS2 method itself and internally translate on/off requests into clonk session
  calls (`videoCaptureStart`/`Stop`, `videoPlayerStart`/`Stop`).
- **`callStateQuery` response contract**, from `CallSynergizer.js` around line 339-359 — fields our
  `com.palm.whatsapp.call` service needs to add, none of which exist in the current audio-only
  implementation:
  - top-level `videoURI` (the clonk session URI, once one exists for the active call).
  - per-line `outgoingVideo` / `incomingVideo` (booleans).
  - per-line `incomingVideoState`: `"unavailable" | "available" | "streaming"` (a tri-state, not
    just a bool — drives the contact-image vs. live-video display switch in `ActiveCall.js`).
  - `autoAcceptVideoCalls` / `allowVideoCalls` (policy flags; default `true` is fine per an existing
    comment in `ActiveCall.js` — "Default to true... once skypem_1.3-25 makes it into a build").

Net effect: the entire UI-facing contract is now fully specified from real, working source, not
guessed — `glue/call.c` knows exactly what to expose (`changeMedia` method,
`videoURI`/`outgoingVideo`/`incomingVideo`/`incomingVideoState` in `callStateQuery`) once the native
clonk bug is fixed. This part of "hook it up" needs no further research, only implementation.

## Part 5 — chasing the shared root cause further: two more findings, one dead end

> **Corrected in Part 8:** this entire line of investigation (Parts 5 and 6) turned out to be a
> dead end — `ctx+16` is never actually null; a null there hits `__assert_fail`, which never fired.
> The real bug was the JSON payload shape (`{"args":[...]}` vs. a bare array), found by reading the
> *rest* of `videoCaptureStart`'s disassembly and `getArguments` itself. Left below as a record of
> the (wrong) trail, not as current guidance — see Part 8 for what's actually true.

Went one level deeper on *why* the dispatch pointer at `ctx+16` is null:

- **`ClonkServer`'s own constructor is correct.** Disassembled
  `ClonkServer::ClonkServer(shared_ptr<Clonk>)` in `libmedia-api.so`: it zeroes `this+16` up front,
  then — after the boost `shared_ptr` copy-construction bookkeeping — writes the *real* raw
  `Clonk*` extracted from the constructor's `shared_ptr<Clonk>` argument into exactly that offset.
  So the wiring mechanism itself is sound *given a valid, non-empty `shared_ptr<Clonk>`*. The bug is
  upstream of this constructor: whatever calls `new ClonkServer(theSharedPtr)` is either not being
  called at all yet, or is passing an empty pointer.
- **`LunaService::registerInterface`** (the second function `clonkPipeline` calls, after
  `openSession`) is generic LS2-category/subscription plumbing — `LSSubscriptionAdd`, string
  building, `LSMessageReply` — shared identically by `playbackPipeline` too. No `ClonkServer`/`Clonk`
  construction happens there either.
- **Dead end:** searched `mediaserver`'s full disassembly and its ELF relocation table for any
  reference at all (direct call *or* a stored function-pointer relocation) to
  `ClonkServer::ClonkServer(shared_ptr<Clonk>)` — found none, despite it showing as an imported
  (`U`) dynamic symbol `mediaserver` genuinely depends on. **Conclusion: the actual constructor call
  site hasn't been found yet — it's most likely invoked lazily, on the first real method dispatch
  to a freshly-opened category, rather than eagerly at session-open time** (which would neatly
  explain why session creation always succeeds instantly while every action call fails). Finding
  that lazy-dispatch mechanism is unfinished business, not a wrong turn.

## Part 6 — the gdb live-debugging saga (concept sound, this exact setup didn't get there)

Spent real effort making live debugging work, since it would answer the question directly instead
of more static tracing:

- **Setup works:** `gdbserver` (on-device) attached to the live `mediaserver` PID, `novacom -P -f
  2159:2159` port-forwarded it, `gdb-multiarch` (this host) connected and correctly loaded full
  symbols for every shared library including `libmedia-api.so`, using `set sysroot`/
  `set solib-search-path` pointed at the local rootfs image copy.
- **Real gotcha, learned the hard way, twice:** a `gdb -batch` script that reaches its end (normal
  completion *or* a mid-script error) **without an explicit `detach` first kills the attached
  inferior**. This happened to `mediaserver` several times tonight. Every single time, upstart's
  `respawn` stanza on its job brought it straight back up with a new PID and no manual
  intervention needed — but if you pick this up again, always put `detach` before `quit`, and don't
  be alarmed if you see a new PID.
- **Symbolic breakpoints (`break *(Namespace::Class::method(...)+offset)`) were unreliable** across
  reconnects — sometimes "No symbol table is loaded" even right after a successful `target remote` +
  `info sharedlibrary`, seemingly a timing/loading-completeness issue with this specific old
  `gdbserver` talking to a modern `gdb-multiarch`. **Fix that worked:** compute the runtime address
  by hand (`libmedia-api.so`'s runtime load base, read from `info sharedlibrary`, plus the
  link-time function offset from `nm`, plus the offset-within-function from `objdump -d`) and
  `break *0xADDRESS` directly — this reliably set the breakpoint every time (confirmed: "Breakpoint
  1 at 0x2ac24e3c" printed cleanly).
- **The real blocker: the breakpoint never actually triggers.** With the raw-address breakpoint
  confirmed set and `continue` blocking as expected, triggering `videoCaptureStart` from a separate
  `clonk_probe` run completed completely normally (`{"returnValue":false}` came straight back) —
  gdb never stopped. We *know* from `strace` that this exact code path executes every time. The
  most likely explanation: `mediaserver` is heavily multi-threaded (GLib main loops, one thread per
  LS2 category/session judging by the `FacadeSessionBroker` log lines from Part 2), and this
  ancient (~2011) `gdbserver` build likely has incomplete `PTRACE_O_TRACECLONE`/thread-enumeration
  support when driven by a modern gdb client — the LS2 dispatch for a *newly created* per-session
  category may run on a thread `gdbserver` never properly attached breakpoints to, even though the
  breakpoint's memory patch should in principle be visible process-wide.
- **Not pursued further tonight** (diminishing returns given the device was cycled through several
  kill/respawn cycles already): trying `gdbserver --multi`, checking `info threads` right after
  attach to see whether the handling thread is even visible to gdb, or attaching directly to a
  specific TID instead of the process's main PID. Any of these would be the next thing to try if
  live debugging is picked up again.
- **Resolved in Part 8, and much simpler than threading:** the breakpoint was set on the `ctx+16`
  null-check inside `videoCaptureStart` — which, per Part 8, is dead code on every real call, since
  the actual failure happens earlier via `getArguments`/`dom["args"]` returning `ok=false`, which
  skips straight past that check entirely. The breakpoint never fired because that line of code
  never runs, not because of a gdbserver/threading limitation. The gdb setup notes above (sysroot,
  raw-address breakpoints, the `detach`-before-`quit` gotcha) are still accurate and reusable if
  live debugging is needed for something else later.

**Device state, verified clean at the end of this session:** `mediaserver` running normally and
stable (same PID since the last respawn, uptime ~100 minutes with no further reboots),
`imlibpurpletransport` (messaging) confirmed healthy, `gdbserver` killed, no port forwards left
open, `clonk_probe` deployed and role-registered, currently built to test `videoCaptureStart`.
Nothing left running that shouldn't be.

**One incident along the way, for the record:** early in this session, restarting `ls-hubd_private`
(to load a new LS2 role file) went wrong — its upstart job script doesn't `exec` into `ls-hubd`, so
upstart tracked the wrapper shell instead of the real daemon; the orphaned real daemon kept running
with stale role tables, the second instance failed to bind the already-held socket and exited
non-zero, which tripped `ls-hubd_private_watchdog`'s reboot path
(`reboot_ls-hubd_if.sh` reboots on any non-zero exit outside runlevels 0/6/U). **The device
rebooted once** (confirmed via `/proc/uptime`), and recovered fully on its own — `mediaserver`,
`ls-hubd`, and messaging all came back up normally, all files survived (persistent storage, not
`/tmp`). Net effect: harmless, and it happened to load the role file we needed anyway.

## Next session: the plan to actually hook up WhatsApp video

**1. DONE (Part 8) — `videoCaptureStart` AND `videoPlayerStart` both confirmed working live**, in
the same session, with clean start/stop cycles on both sides. Root cause was the payload shape
(`{"args":[...]}`, not a bare array), not a construction bug. `videoPlayerActive` reads back `true`
after start (further along than capture, where `videoCaptureActive` stays `false` — not chased
further, not a blocker).

**2. The Phone app / UI side needs no further research** (Part 4) — implement directly against the
confirmed contract:
   - `glue/call.c` implements a new `changeMedia(id, outgoingVideo, incomingVideo)` LS2 method.
   - `callStateQuery` responses gain `videoURI` (top-level), `outgoingVideo`/`incomingVideo`
     (per-line), `incomingVideoState` (per-line, `"unavailable"|"available"|"streaming"`).
   - `videoURI` is the clonk session's own `palm://com.palm.mediad.Clonk_NNNN/` LS2 URI — the Phone
     app's `<Video>` tag and PiP calls (`updatePipSettings` with
     `{args:[{top_left,bottom_right,scale,orientation}]}`) both target it directly, no further
     plumbing needed on our side once we hand over the right URI.

**3. Capture → WhatsApp send** (#1 now unblocked): `glue/call.c` opens a `clonk` session on
   answer/dial-with-video, sets `deviceUri`/`videoBitrate`/`h264SenderConstraints` to something
   ≤320p (matching the `webos-vc` history's hard-won constraint — the *other*, newer gst-omx stack
   on this device aborts above 320p; `palmvideoencoder`, found in Part 3, may be a more reliable
   encode path than the gst-omx one), calls `videoCaptureStart({"args":[w,h,fps,bitrate]})`, then attaches
   to the **frame data-plane, confirmed via static analysis to be System V shared memory** (not LS2
   messages, not a pipe — `mediaserver` logs `"Issuing Video Frame Capture message. shared mem
   name=%s,size=%d,ptr=%p,shmMemId=%d"`, and `VideoSink::createShmMemName()` derives the segment
   name per session). The exact triggering LS2 message/event that hands over the `shmMemId` is the
   next thing to pin down once capture itself actually starts.

**4. WhatsApp receive → playback:** symmetric — feed access units from `Call.ReceiveVideo` into
   `videoPlayerStart({"args":[w,h]})`'s decode/render path (confirmed working, #1), which almost
   certainly hands back decoded frames the same shared-memory way, rendered automatically once
   `videoURI` is wired per #2.

`clonk_probe` (built, deployed, role-registered) is immediately ready to test whatever comes out
of #1 — the payload conventions for every method involved are now known exactly, so any fix to the
construction bug should be testable within one build/deploy/run cycle.

## Part 7 — #2 implemented and compiling clean for the real target

While still chasing #1 (searched mediaserver/libmedia-api.so for a `dlopen`-loaded plugin that
might be the real `Clonk` factory implementation — a plausible link to `skype-disable`'s indirect
effects; found nothing, only the standard statically-`NEEDED` libraries, so that specific theory is
weaker now, not stronger), implemented the whole Phone-app integration contract from Part 4 for
real, in parallel:

- **`call.go`**: `callInfo` gained `incomingVideoState`. `wireCall` now initializes it from
  `mcCall.IsVideo()` and wires `mcCall.OnVideoState(...)` to keep it live
  (`"streaming"`/`"available"`/`"unavailable"`, tracking the *peer's* video independent of whether
  our own capture/render pipeline works). `emitCallState` includes it in the JSON. New
  `//export gowhatsapp_go_call_changemedia(id, hasOutgoing, outgoing, hasIncoming, incoming)`
  implements the real toggle logic: `StartVideo()` for a fresh audio→video upgrade,
  `SetVideoEnabled()` to mute/unmute an already-video call — reusing meowcaller's existing,
  already-validated (Part 1) video signaling API, not anything new or unproven.
- **`glue/call.c`**: `changeMedia` is wired to a real handler (`m_changemedia`, replacing the
  `m_ok` stub), parsing the "field absent = leave as-is" convention `VideoCall.js` actually uses.
  Added clonk session lifecycle management: `gowhatsapp_call_video_active(int on)` (called from Go
  on any video-state flip) opens a `palm://com.palm.mediad/service/clonk` session via
  `LSCallOneReply` and captures its `location` into `g_clonk_uri`; `push_callstate` now splices
  that real URI into Go's `"videoURI":""` placeholder before forwarding to `callStateQuery`
  subscribers (`inject_video_uri` — Go owns call-state structure, C owns the session and its URI).
  No confirmed explicit teardown call exists yet (see Part 5), so `clonk_close()` just drops the
  local reference for now — safe, since session creation itself has no observed side effect beyond
  the session existing.
- **Builds clean for the real target**: ran the actual `build-combined.sh` (Go c-archive → C glue →
  final `.so` link) end to end. Needed one `go mod tidy` first in `purple-combined` itself (its
  go.mod `replace`s `meowcaller` with the local `./third_party/meowcaller` directory I'd already
  modified — bumping meowcaller's own dependencies meant the parent needed reconciling too).
  Produced `build-arm/libwhatsmeow.so` (29.5 MB unstripped), all `NEEDED` libs resolved correctly,
  `purple_init_plugin` present. Confirmed via `nm -D` that both new symbols
  (`gowhatsapp_call_video_active`, `gowhatsapp_go_call_changemedia`) and their cgo trampolines are
  actually present in the linked binary — not just "other things compiled," the new wiring itself
  linked correctly.

**What this gets you today, independent of the still-open native bug:** video call negotiation
(offer/accept/upgrade), toggling your own outgoing video on/off mid-call, and tracking the peer's
video state — all genuinely functional, because they only touch meowcaller's already-validated
WhatsApp-signaling layer (Part 1). Clonk session creation (and therefore a real, live `videoURI`
being handed to the Phone app's `<Video>` tag) also works today. What doesn't work yet: actual
frames flowing — that's still gated on Part 5's construction bug.

**Not yet done:** this hasn't been deployed to the device. Unlike `clonk_probe` (a standalone,
role-scoped test binary that never touched anything live), this *is* the real WhatsApp/Facebook
messaging plugin — deploying it means swapping `libwhatsmeow.so` under the account's live
messaging session, a materially bigger blast radius than anything else tonight. Needs the
account's own explicit go-ahead before doing that, and ideally review of the diff first.

## Part 8 — the real root cause: payload shape, not object construction (corrected)

Parts 5/6 chased a dead end: a hypothesis that `ClonkServer`'s `shared_ptr<Clonk>` business object
was never validly constructed at runtime, based on a `videoCaptureStart` disassembly read that only
covered its first ~150 instructions and a null-check that looked plausible in isolation. Two things
that should have been red flags earlier, in hindsight: property getters (`getDeviceUri`, etc.)
always worked fine against real sessions — meaning *some* backing object clearly existed — and the
gdb breakpoint on that null-check never fired despite `strace` proving the code path executed.

**Finding the real cause required reading the *whole* function, not just the first branch.** Full
disassembly of `ClonkServer::videoCaptureStart` (`libmedia-api.so` 0xbb0cc–0xbb58c) shows:

- `ctx+16` (a `shared_ptr<media::Clonk>`) being null hits `__assert_fail`, not a silent return — so
  if it were ever actually null, `mediaserver` would abort. It never has, across dozens of test
  runs. That alone rules out the Part 5 theory.
- The function's actual logic: unmarshal up to 4 args by indexing a JValue named `args` at
  positions 0–3 (`JValue::operator[](int)`), then make a real virtual call through `ctx+16`'s vtable
  at offset `0xd8` (the actual capture-start implementation), then a second vtable call at offset
  `0x8` that acts as a success/failure check, and — only on failure — a third vtable call at offset
  `0xc` (looks like `getLastError()`) to build an error-message string for the reply.
- The args only get unmarshalled at all if an internal `ok` flag (set by `getArguments()`) is true.
  If it's false, the function jumps straight past all argument handling and the real vtable calls,
  straight to building `{"returnValue":false}` with an **empty** message string — exactly what we'd
  been observing.

**Tracing `getArguments` itself** (`media::luna::LunaInterface::getArguments(LSMessage*, char
const*, bool&)`, `libmedia-api.so` 0x74568) found the actual gate:

```
JDomParser::parse(payload, schema, ...)      // succeeds on any valid JSON, incl. a bare array
  -> if parse failed: ok = false, return {}
dom["args"]                                   // JValue::operator[](const string&) — string-keyed!
  -> if !isArray(): ok = false, return {}     // <-- this is what actually failed
  -> else: return dom["args"], ok = true
```

The second parameter to `getArguments` (which earlier disassembly passes had assumed was a schema
key) is a `__PRETTY_FUNCTION__`-style diagnostic string (confirmed by reading the actual bytes at
its computed `.rodata` address: `"static bool media::luna::ClonkServer::videoCaptureStart(LSHandle*,
LSMessage*, void*)"`) — used only for logging, not validation. The real gate is the literal string
`"args"` (`.rodata` 0x153f5c, confirmed by reading the bytes directly), used as a JSON object key.

**A bare top-level array like `[320,240,15,400000]` parses as valid JSON, so `getArguments` doesn't
fail at the parse step — but `dom["args"]` on a top-level *array* value doesn't return an array (or
anything usable), fails `isArray()`, and `ok` gets set false.** This is a silent, textless failure
that looks identical to a "the object doesn't exist" bug from the outside — which is exactly what
sent Part 5 down the wrong path. The real convention every `clonk` action method uses is an object
wrapper: **`{"args":[...]}`**.

**Fixed and confirmed live** (`clonk_probe`, rebuilt/redeployed):

```
>>> videoCaptureStart {"args":[320,240,15,400000]}
<<< {"returnValue":true}
>>> getVideoCaptureHasPipeline {}
<<< {"propertyRead":{"name":"videoCaptureHasPipeline","value":true},"returnValue":true}
>>> videoCaptureStop {"args":[]}
<<< {"returnValue":true}
```

`/var/log/messages` for the same window confirms real pipeline construction, not just a "true"
reply: `mediaserver` logs the session going active (`PowerMediaService::okToSuspend: Denied:
'com.palm.mediad.Clonk_NNNNN' is active`, a `POWERD-ACTIVITY` wake-lock for ~10.5s), and on
teardown, `media-pipeline: virtual media::pipeline::ManagedClonkPipeline::~ManagedClonkPipeline()
pipeline not suspended` — a real `ManagedClonkPipeline` object existed and was torn down without a
graceful suspend step (expected, since `clonk_probe` just exits rather than driving a full
suspend/resume sequence — this fires even after a successful `videoCaptureStop`, so it reflects the
probe's abrupt disconnect, not a stop failure).

`getVideoCaptureActive` still read `false` 3 seconds after start in this test — plausibly because
"active" only flips once the camera/OMX pipeline actually reaches a running state and starts
producing frames, which may need more time, or a peer/consumer attached via the shared-memory
handoff (Part 3) before it flips. Not chased further for capture, but see below — the player side
gives a strong clue that this is specific to capture, not a general problem.

**`videoPlayerStart` retested immediately after, same fix, same session — also confirmed working,
and further along than capture:**

```
>>> videoPlayerStart {"args":[320,240]}
<<< {"returnValue":true}
>>> getVideoPlayerActive {}
<<< {"propertyRead":{"name":"videoPlayerActive","value":true},"returnValue":true}
>>> getVideoPlayerHasPipeline {}
<<< {"propertyRead":{"name":"videoPlayerHasPipeline","value":true},"returnValue":true}
>>> videoPlayerStop {"args":[]}
<<< {"returnValue":true}
```

Unlike capture, `videoPlayerActive` reads back **`true`** (not just `HasPipeline`) — the player side
reports itself fully active, not just constructed. And this run's session teardown in
`/var/log/messages` shows a clean `Stopping session ...` with **no** `ManagedClonkPipeline ...
pipeline not suspended` warning — meaning both `videoCaptureStop` and `videoPlayerStop` left the
pipeline properly suspended this time (the warning in the first test run came from a probe version
that still sent the stop calls with the wrong shape). Confirms the `{"args":[...]}` fix's start
*and* stop calls both work correctly, for both directions, in a single session — the architecture
Part 2 described (one `clonk` session per call, driving capture and playback together) checks out.

No corresponding `dmesg`/kernel-level camera or `/dev/video*` activity was observed for either
direction — consistent with the capture-side finding in Part 3 that hardware engagement is a later
step than pipeline construction, not evidence against this working; the LS2/GStreamer-object layer
being fully confirmed is what actually mattered here.

**Practical implication for `glue/call.c`'s clonk wiring (Part 7):** any future direct-LS2-call code
for `videoCaptureStart`/`videoPlayerStart`/`setDeviceUri`/etc. (not yet added — Part 7 only opens
the bare session so far) must use the `{"args":[...]}` wrapper, not a bare array. `clonk_probe.c`'s
current sequence (create session → getDeviceUri → setDeviceUri → videoCaptureStart → status →
videoCaptureStop → videoPlayerStart → status → videoPlayerStop → quit) is a working reference for
the exact shape of every one of these calls.

**Next:** find the actual shared-memory (`shmMemId`) handoff trigger for frame transfer now that
both session setup and both start/stop directions are confirmed working end to end.

## Part 9 — chasing the shmMemId handoff: found the shm mechanism, but `mediaserver` looks like it does full RTP transport internally

Went looking for the trigger that hands the `shmMemId` from `"%s: Issuing Video Frame Capture
message. shared mem name=%s,size=%d,ptr=%p,shmMemId=%d"` (the log line Part 3 originally found and
assumed was the frame data-plane) to an external client. Found a lot — and it changes the picture.

**Decoded the object layout by reading `g_log`'s varargs against the format string.** The function
that logs this, `media::pipeline::gst::element::VideoSink::captureVideoFrame()` (`mediaserver`
0xe8150, statically linked, symbols intact), passes its varargs in AAPCS order (r3, then stack):
`this+16` = shm name (`std::string`), `this+20` = `shmMemId` (`int`), `this+28` = mapped `ptr`,
`this+120` = `size`. It only proceeds if `shmMemId >= 0` and `ptr != NULL` — i.e. it *uses* an
already-set-up segment, it doesn't create one.

**Traced segment creation to `VideoSink::createShmMemName(std::string)`** (`mediaserver` 0xe83a0):
builds the name as a fixed rodata prefix, `"/videocapture_"` (`.rodata` 0x1179d8), concatenated
with whatever `std::string` the `VideoSink` constructor was given. Traced the constructor's actual
callers and found the argument is *also* a fixed rodata literal, not anything session-specific:
`ClonkPipeline::initializeVPlayPipeline` passes `"clonk-remote-video"` (`.rodata` 0x108dac),
`ClonkPipeline::initializeVCapturePipeline`'s corresponding branch passes `"clonk-preview"`
(`.rodata` 0x108f3c). So in principle the shm names are fixed, well-known constants — no per-session
handoff would even be needed for the *name*.

**But the actual SysV key isn't derived from that name at all.** Traced the `shmget()` call itself
(`mediaserver` imports real `shmget`/`shmat`/`shmctl`, not `shm_open`/`ftok`): `shmget(key=(int)this,
size=this+120, flags=IPC_CREAT|0600)` — **the key is the `VideoSink` C++ object's own heap pointer**,
cast straight to an int. That's a private, per-run heap address inside `mediaserver`'s address space
— unpredictable and uncomputable by any external process. If this is really the data plane, some
LS2 message *must* carry the resulting `shmid` out to a client; nothing in `ClonkServer`'s ~50
registered LS2 methods does (see below), which was the first sign this isn't the actual mechanism
in play here.

**Checked live, empirically: no shm segment appears at all during a real session.** Baseline
`/proc/sysvipc/shm` before any test, then polled it at t=4s/8s/12s through a full
`clonk_probe` run (capture start→status→stop, player start→status→stop) — zero segments ever
attributed to `mediaserver`'s pid (2619), the whole way through. Two explanations, not mutually
exclusive: (a) `VideoSink` construction in the capture path is gated behind a conditional
(`mediaserver` 0xb61e0, a vtable call through a `this+4` helper object) that looks like a
hardware-overlay-available check — plausible that real hardware overlay is what's actually in use,
bypassing this class entirely; (b) the player-side `VideoSink` construction (`ClonkPipeline
::initializeVPlayPipeline`, confirmed *not* gated behind anything unusual — its neighboring branch
is just the generic `gst_element_factory_make` failure check every element in this function has) is
most likely gated on the decoder producing a first output pad (`PlayerPipeline
::newDecodedPadCallback` is a literal GStreamer dynamic-pad-added callback that also constructs a
`VideoSink`) — meaning it never fires because `clonk_probe` starts the pipeline but never pushes any
real H.264 bytes into it. (b) is the more likely explanation for the player side specifically, and
doesn't rule the mechanism out — just means it needs real data flowing to observe.

**The bigger finding: `ClonkServer`'s full registered LS2 surface (dumped via `nm -C -D`, ~50
methods/properties) has no frame/shm/buffer-related getter at all**, but it does have
`H264SenderConstraints`, `H264SenderParameters`, `H264ReceiverParameters`, and — tellingly —
`test_GenerateCapturePcap` / `test_GenerateReceivePcap`. Disassembled the marshalling code for both
structs directly (reading the `pbnjson::JValue` key strings the same way Part 8 decoded
`getArguments`'s `"args"` key):

- `H264SenderParameters` = `{profile_idc, profile_iop, level_idc}`
- `H264SenderConstraints` = `{profile_idc, profile_iop, level_idc, max_mbps, max_fs, max_cpb,
  max_dpb, max_br, max_smbps, redundant_pic_cap}`

**These are the literal RFC 6184 (H.264-over-RTP) SDP `fmtp` parameter names** — `max-mbps`,
`max-fs`, `max-cpb`, `max-dpb`, `max-br`, `max-smbps`, `redundant-pic-cap` are exactly the profile/
level negotiation fields exchanged in a real SDP offer/answer for H.264 video. Combined with the
PCAP test hooks (which only make sense if the pipeline is generating real RTP/UDP traffic to
capture), this is strong evidence that **`ClonkPipeline` does full H.264 encode → RTP payload →
network send (and the receive-side mirror) *inside* `mediaserver` itself** — the same
self-contained-media-engine architecture Part 2's original research assumed for Skype, now backed
by concrete evidence from the actual negotiation-parameter names, not just precedent.

**What this means for the plan (supersedes the shm-handoff framing from Part 3/Next-session):** if
`mediaserver` owns the real RTP transport end to end, there is no raw-frame handoff to intercept for
WhatsApp integration — the shm/`VideoSink` mechanism traced above is most plausibly for *local
display/PIP rendering* only (both the local camera self-view and the decoded remote party's video),
not for exporting frames to a third-party encoder. The actual integration point would instead be
**wherever `ClonkPipeline` sends/expects its RTP packets** — i.e. we'd need `mediaserver`'s outgoing
RTP aimed at a local relay we control (and its incoming RTP fed from one), then bridge that to
meowcaller's `SendVideo`/`ReceiveVideo` (NAL-unit level, not RTP — meowcaller handles WhatsApp's own
RTP/SRTP framing internally, so the bridge only needs to move raw H.264 access units across).

**Not yet found: how that RTP destination/source gets configured.** None of `ClonkServer`'s ~50 LS2
methods expose anything address/port/socket-like — no `remoteUri`, no `rtpUri`, nothing in that
family. Candidates for next session, not yet checked: an fd handed over via LS2's underlying
Unix-domain-socket connection (`SCM_RIGHTS`), a fixed/hardcoded loopback port convention, or
something baked into pipeline construction (`ClonkSession`/`ClonkPipeline` construction args) that
isn't LS2-visible at all. This is now the more fundamental open question than the shm handoff this
part set out to find — worth treating as the real "next session" item.

## Part 10 — found it: `libpalmgstskype.so` is a real, embedded copy of Skype's own SkypeKit SDK,
## and the transport is two fixed-name abstract Unix domain sockets

Followed Part 9's open question ("how does the RTP destination get configured") by going back to the
actual GStreamer element chain instead of the LS2 property surface — and it resolves cleanly.

**Decoded every `gst_element_factory_make()` call in both `ClonkPipeline::initializeVCapturePipeline`
and `initializeVPlayPipeline`** (same movw/movt address-resolution technique used throughout this
investigation, applied systematically this time — see the pipelines below). This reveals the real
element chains, which neither Part 3 nor Part 9 had fully mapped:

- **Capture (send) pipeline:** `camsrc` ("Camera Source") → `capsfilter` ("Resolution Caps Filter")
  → `tee` ("Camera Tee") splitting into a `queue` → `fakesink`/local-preview branch and a
  `queue` → `palmvideoencoder` ("Palm Video Encoder", the real hardware H.264 encoder Part 3 first
  found) → `queue` → **`skypevideosink`** ("clonkvhsink" — "vh" = VideoHost).
- **Playback (receive) pipeline:** **`skypevideosrc`** ("clonkvhsrc") → `palmvideodecoder`
  (confirmed-working hardware decoder) → `queue` → (display sink).

**`skypevideosrc`/`skypevideosink` are the real boundary — not the shm-based `VideoSink` class Part 9
chased.** Both are custom GStreamer elements registered by `libpalmgstskype.so`. Their C++ backing
class, `GstSkypeInstance`, has `SendRTP(void*, unsigned int)` (outgoing) which — *if* a `VideoHost*`
is registered at `this+8` (silent no-op otherwise, `bxeq lr`) — forwards straight to
**`VideoHost::SendRTP`**, a real, concrete (not abstract) implementation living in the same `.so`.

**`libpalmgstskype.so` turns out to contain a literal embedded copy of Skype's own SkypeKit SDK.**
`nm -C -D` on it turns up an entire `Sid::` namespace (`Sid::Protocol::BinClient`/`BinServer`,
`Sid::CommandInitiator`, `Sid::TransportInterface`, `Sid::UnixSocket`, `Sid::AVTransportWrapper`,
`SkypeVideoRTPInterface`/`SkypeVideoRTPInterfaceCb`, `SEBinary`/`SEString`/`SEIntList` — all classic
SkypeKit SDK type names), and `strings` turns up the literal source path
`Inc/skypekit/ipc/cpp/AVTransport/SocketTransport.cpp`. `VideoHost::SetCallback(SkypeVideoRTPInterfaceCb*)`
stores the callback at `this+12`; `VideoHost::SendRTP` calls through it. The concrete implementation of
that callback here is `Sid::SkypeVideoRTPInterfaceCbClient::SendRTPPacket(SEBinary const&)` — an RPC
*client stub* (disassembled directly) that just wraps the bytes and calls
`Sid::Protocol::BinClient::wr_call_lst(...)` — i.e. it serializes the RTP packet with SkypeKit's own
binary RPC protocol and writes it out over a transport object, it does not touch the bytes itself.

**Traced the transport to `Sid::UnixSocket`, confirmed via `MakeAddress`'s address-construction code:**
it writes `sun_family=AF_UNIX` (`strh` of `1`), a zero byte at `sun_path[0]`, then `strcpy`s the given
name starting at `sun_path[1]` — the standard Linux **abstract-namespace** Unix domain socket
convention (no filesystem entry, name only visible via `/proc/net/unix` with a leading `@`).
`Sid::UnixSocket::Connect(char const*, bool isServer, int timeout)` dispatches to either
`ClientConnect()` (retries in a sleep/retry loop, i.e. waits for a server to appear) or
`ServerConnect(timeout)` depending on the `isServer` flag — so this same code can run either role.

**Found the actual socket names as plain strings in the binary:**
```
/tmp/vidrtp_to_skypekit_key
/tmp/vidrtp_from_skypekit_key
/tmp/pcm_to_skypekit_key
/tmp/pcm_from_skypekit_key
```
(used as abstract-namespace names, not real files — despite looking like filesystem paths, per the
`MakeAddress` NUL-prefix construction above). Video RTP and audio PCM each get their own pair of
fixed, well-known socket names, one per direction.

**What this means for WhatsApp integration:** this is not a raw-frame shm handoff (Part 9's original
target) and not a fully-internal RTP stack (Part 9's revised theory) — it's a **well-known, fixed-name
IPC boundary designed from the start for an external process to plug into**, exactly matching
SkypeKit's real-world architecture (the actual `skypekit` engine binary was always meant to be a
separate process from whatever hosts the media I/O). That's *good* news for feasibility: this is the
literal mechanism `skypekit` itself would have used, not something webOS-specific we'd be
reverse-engineering blind. A relay component that opens `vidrtp_to_skypekit_key` (as whichever role
mediaserver expects the peer to take) could, in principle, receive/inject RTP packets and bridge them
to meowcaller's `SendVideo`/`ReceiveVideo` (NAL-unit level — the RTP depacketization would need to
happen in our own relay, since meowcaller doesn't speak this SkypeKit wire format).

**Confirmed the client/server role for each socket** by disassembling `GstSkypeInstance::RunVideoHost()`
in full (`libpalmgstskype.so` 0x29bc0), which sets up *two separate* transport objects, one per
direction:

- **`/tmp/vidrtp_from_skypekit_key`** — `mediaserver` calls `Sid::AVServer::Connect(path, 10000)` —
  **`mediaserver` is the SERVER here: it listens**, with a 10-second setup timeout. This transport is
  wrapped in a `Sid::Protocol::BinServer`, which dispatches *incoming* RPC calls via `ProcessCall`
  (matches `Sid::SkypeVideoRTPInterfaceServer::ProcessCall` found in Part 10) — i.e. this channel is
  for the remote peer to **push incoming RTP packets into** `mediaserver`'s playback/decode pipeline.
- **`/tmp/vidrtp_to_skypekit_key`** — `mediaserver` calls `Sid::AVTransportWrapper::Connect(path,
  isServer=false, 500)` — **`mediaserver` is the CLIENT here: it dials out**, retrying in a sleep loop
  for up to ~50s (500 × the observed 100ms retry interval) waiting for something to be listening. This
  transport is wrapped in a `Sid::Protocol::BinClient`, which *issues* outgoing RPC calls via
  `wr_call_lst` (matches `Sid::SkypeVideoRTPInterfaceCbClient::SendRTPPacket` from Part 10) — i.e.
  this channel is for `mediaserver` to **push its own encoded capture RTP packets out**.

Both string addresses were confirmed by resolving the exact literal-pool words feeding each `Connect`
call site (same PC-relative address-resolution technique used throughout this investigation) —
not assumed from the socket names alone.

**Concretely, for a WhatsApp bridge:**
- **Outgoing (WhatsApp send):** run a small server that binds the abstract-namespace socket
  `vidrtp_to_skypekit_key`. `mediaserver` connects to it after `videoCaptureStart` and pushes encoded
  RTP packets via SkypeKit's `BinClient` wire calls; the bridge decodes those calls, extracts the RTP/
  H.264 bytes, and feeds them to meowcaller's `Call.SendVideo`.
- **Incoming (WhatsApp receive):** run a small client that connects to `vidrtp_from_skypekit_key`
  after `videoPlayerStart` (mediaserver is listening, server role). The bridge takes NAL units from
  meowcaller's `Call.ReceiveVideo`, wraps them as RTP, and issues them as `BinServer`-style RPC calls
  into `mediaserver` to feed the playback/decode pipeline.

**Not yet done at the time Part 10 was written:** reverse-engineer enough of `Sid::Protocol::BinCommon`'s
wire format to write a minimal standalone test tool. Web search (Part 11) confirmed the SkypeKit SDK
isn't available as a public/leaked source archive — it's a real but discontinued (~2014) paid/licensed
product, so no shortcut there. The empirical approach (build a tool that binds the real socket and
captures real bytes) turned out to be blocked by something more fundamental — see Part 11.

## Part 11 — the wire-protocol work was premature: the GStreamer pipelines never actually reach a
## linked, running state, and the real blocker is caps/resolution configuration, not the SkypeKit
## socket layer

Built `vidrtp_sniffer.c` (this directory) to get ground truth instead of guessing `Sid::Protocol`'s
byte format from disassembly alone: it binds `/tmp/vidrtp_to_skypekit_key` using the *exact* same
abstract-namespace construction `Sid::UnixSocket::MakeAddress`/`ServerConnect` use (full 110-byte
zero-padded `sockaddr_un`, matching the fixed `addrlen=110` both `bind()` and `connect()` use on this
target — a shorter, strlen-derived addrlen would silently create a different abstract name and never
match), then accepts and hex-dumps whatever `mediaserver` sends.

**First finding, fixable, harmless build bug:** the tool initially failed to run at all —
`clock_gettime@GLIBC_2.17` isn't present on this device's much older libc, even though
`clock_gettime()` itself is ancient; swapped to `time()` (confirmed via `readelf -V`, now needs only
`GLIBC_2.4`, matching `clonk_probe`). Not a build-script bug — `build-vidrtp-sniffer.sh` was just
missing nothing conceptually wrong, the toolchain's *default* sysroot libc is far newer than the
device's; `build-clonk-probe.sh` avoids this by linking real LS2/glib libraries that happen to only
pull old symbol versions naturally. Worth remembering for any future standalone (non-LS2) tool built
with this toolchain.

**The real finding: `mediaserver` never connected to our listening socket, in two full test runs.**
Confirmed the bind itself was correct (`/proc/net/unix` showed `@vidrtp_to_skypekit_key` present,
right name, right process) — `mediaserver` simply never attempted the connection, despite
`videoCaptureStart` reporting `{"returnValue":true}` and `getVideoCaptureHasPipeline` reading `true`
per Part 8. `/var/log/messages` showed zero `RunVideoHost`/SkypeKit-related log lines during the test
window at all — the code path never even entered `GstSkypeInstance::RunVideoHost()`, let alone reached
its `AVTransportWrapper::Connect` call.

**Root-caused with the same technique Part 3 used originally: stop the upstart-managed `mediaserver`,
run it manually with `--gst-debug=4`, redirect to a file, restart upstart's copy afterward** (the
exact "for the record" procedure Part 3 documented — repeated here without incident, `mediaserver`
restored cleanly via `start mediaserver` and confirmed healthy with a quick `luna-send` sanity call
afterward). Two distinct, concrete GStreamer-level problems found this way, on the capture (send) and
player (receive) sides respectively:

1. **Capture side — fixed.** `ClonkPipeline.cpp:1262:busMsg_ERROR: Received error from plugin ...
   name Camera Source: Could not negotiate format, gstbasesrc.c(2823): gst_base_src_start()`. Queried
   `camsrc`'s actual pad template directly (`gst-inspect-0.10 camsrc`, present on-device): it offers
   **exactly three fixed caps, all locked to `framerate=30/1`** — `640x480`, `320x240`, `160x128`,
   format `NV12`. `clonk_probe` had been requesting `framerate=15` (an arbitrary early guess, never
   revisited once the `{"args":[...]}` fix started returning `true`) — not a valid combination at all,
   just silently rejected downstream at the GStreamer caps-negotiation layer, which is invisible from
   the LS2 side (`videoCaptureStart` still returns `true` because pipeline *construction* succeeds;
   only actually *starting* the source fails). Fixed `clonk_probe.c` to request `framerate=30`;
   re-ran against the same manually-debugged `mediaserver` instance and the caps error is gone —
   clean pipeline teardown at session end instead of an error message.
2. **Player side — found, not yet fixed.** `gstskypevideosrc.c:411:gst_skype_video_src_change_state:
   <clonkvhsrc> resolution not set on capsfilter` (a `WARN`-level message inside
   `libpalmgstskype.so`'s SkypeKit-derived code, not `ClonkPipeline` itself). Disassembled the exact
   call site: the warning fires when a value dereferenced from a GOT-relative (i.e. process-global,
   not per-instance) location is `<= 1`, gated behind `cmp r1, #1; bls <skip-warning>` — reads as a
   counter or two-flag combination tracking whether both width *and* height have been delivered via
   `VideoHost::SetIntProperty(propId, camid, value)` (a real, exported method — Part 10) before the
   state change. `videoPlayerStart({"args":[320,240]})`'s own width/height arguments evidently don't
   (yet confirmed) end up calling that property setter, or don't call it in time. Directly visible
   consequence: `clonkvhsrc`'s internal `rtp` child element is **never linked** —
   `gst_bin.c:1967:update_degree:<clonkvhsrc> element rtp not linked on any sinkpads` repeats for the
   whole session — so nothing can flow through it regardless of the SkypeKit socket layer.
   The capture side shows the *same symptom* (`clonkvhsink`'s internal `rtp` child, and the sibling
   `VideoHost H264 Queue`, also both permanently "not linked on any sinkpads") without an equally
   explicit warning — plausibly the same underlying cause (missing property configuration on the
   SkypeKit element), not yet confirmed to be identical.

**Practical upshot:** the `Sid::Protocol` wire-format reverse-engineering from Part 10 was the right
next question in principle, but premature in practice — there is currently no real RTP traffic on
either `vidrtp_*_skypekit_key` socket to capture, because neither `skypevideosrc` nor `skypevideosink`
ever finishes internal setup regardless of the socket layer. **The actual next blocker to resolve is
getting `clonkvhsrc`/`clonkvhsink`'s internal `rtp` element to link** — almost certainly by finding
and calling whatever `VideoHost::SetIntProperty`-driving code path is supposed to fire from
`videoPlayerStart`/`videoCaptureStart` (or an additional call we're missing, e.g. explicitly setting
`H264ReceiverParameters`/`H264SenderConstraints` — both real, separately-settable LS2 properties per
Part 10's method list — before starting). Once that's resolved and `RunVideoHost` actually starts
(confirmable live via the same `--gst-debug=4` technique, watching for
`GstSkypeInstance::RunVideoHost` log lines and an actual connection landing on `vidrtp_sniffer`), the
`Sid::Protocol` wire-format work from Part 10 becomes the correct next step again.

**Device state, verified clean at the end of this investigation:** the manually-started `mediaserver`
(PID from the `--gst-debug=4` run) was killed and the normal upstart-managed instance restored via
`start mediaserver`; a `luna-send` clonk-session-creation sanity call confirmed it works normally
afterward. No `vidrtp_sniffer` processes left running.

## Part 12 — resolved: "resolution not set" doesn't block anything, and real connectivity to
## mediaserver's SkypeKit socket is now proven live

Picked up exactly where Part 11 left off — chasing whether the "resolution not set on capsfilter"
warning genuinely blocks `RunVideoHost()`/the SkypeKit socket setup, or whether it just needed more
time than the ~3s test window Part 11 used.

**Traced the actual settings-plumbing chain first** (before the empirical test), since disassembly
suggested a possible ordering bug: `ClonkSession::videoPlayerStart(w,h)` (mediaserver 0x6e880) posts
a `ClonkHostEvent(VIDEO_PLAYER_START)` carrying `w,h`. Its handler in `ClonkSession::processHostEvent`
(0x6f530) lazily calls `ClonkPipeline::initializeVPlayPipeline()` (building `clonkvhsrc` et al) if the
pipeline isn't ready yet, **before** building a `VideoSettings{w,h}` and calling
`AbstractClonk::setVideoPlaybackSettings()`. Traced that call through `ClonkState::setVideoPlaybackSettings`
(`libmedia-api.so` 0x78730): it's a pure cache-and-notify (`notifyvideoPlaybackSettings()` fires an
LS2-subscriber-style change notification) — it never touches GStreamer. Checked `initializeVPlayPipeline`'s
own 3 `g_object_set` calls directly: none of them touch width/height either (they configure the H.264
decoder's `pictureorder`/`framepacking`, and a `test_GenerateReceivePcap`-gated `outfile` property on
what's almost certainly `clonkvhsrc`).

**Tested an ordering-fix workaround (`videoPlayerStart` → `videoPlayerStop` → `videoPlayerStart` again,
hoping the second lazy-construction would happen after `ClonkState`'s cache was already populated) —
disproved it empirically.** `--gst-debug=4` showed `clonkvhsrc` gets freshly rebuilt each pass
(`gst_element_factory_create` firing twice, once per `videoPlayerStart` call), but the "resolution not
set" warning fired on *both* passes regardless. This ruled out the ordering-bug theory as the actual
blocker (or at least, ruled out this specific workaround for it).

**Tested the "it just needs more time" theory directly — confirmed correct.** Extended `clonk_probe`'s
wait after `videoPlayerStart` from 3s to 25s and polled `/proc/net/unix` throughout: `@/tmp/vidrtp_from_skypekit_key`
appeared and stayed present through the whole window. **The "resolution not set" warning does not block
`RunVideoHost()`/the SkypeKit socket setup at all** — Part 11's concern here was unfounded; it just
needed longer than a few seconds to reach that point (`GstSkypeInstance::RunVideoHost()` most likely
runs on its own thread with some startup latency independent of the GStreamer state-change warnings).

**Confirmed via `strace` (attached live to the real `mediaserver` PID, non-invasive) exactly how the
listening socket behaves**, since `vidrtp_sniffer` connections were still being refused even once the
name appeared: `bind()` on `/tmp/vidrtp_from_skypekit_key` happens every **exactly 10 seconds**
(matching the `AVServer::Connect(path, timeout=10000)` constant found in Part 11), and each cycle is a
real `poll([...], 1, 10000)` — a genuine, several-second-long acceptable window, not a razor-thin
instant as first feared. The gap between one socket closing and the next binding is only ~1.3ms.

**Found the actual bug blocking every connection attempt — and it was simple, not a race condition or
namespace issue.** Self-tested `vidrtp_sniffer`'s own server/client modes against each other
on-device — instant success, proving the abstract-socket address-construction code itself was correct.
Ruled out network-namespace isolation directly (`/proc/*/ns/` doesn't exist on this kernel — too old to
support namespaces at all, so that was never possible). Finally `strace`'d `vidrtp_sniffer`'s own
`connect()` call side by side with `mediaserver`'s `bind()`:
```
mediaserver: bind(34, {sa_family=AF_FILE, path=@"/tmp/vidrtp_from_skypekit_key"}, 110)
our client:  connect(3, {sa_family=AF_FILE, path=@"vidrtp_from_skypekit_key"}, 110)
```
**The leading `/tmp/` was missing from the name we were passing.** Despite being an abstract-namespace
name (no real filesystem path involved at all — confirmed repeatedly through this investigation), the
literal string used as the name is the *whole* `"/tmp/vidrtp_from_skypekit_key"`, `/tmp/` included; we'd
been passing just the `vidrtp_from_skypekit_key` suffix as `vidrtp_sniffer`'s CLI argument. An easy
mistake once deep in abstract-namespace mechanics (zero-padding, fixed `addrlen=110`, etc.) — the
simplest explanation was the right one, just easy to overlook after ruling out several more exotic
theories first.

**Fixed and confirmed live: real connectivity to `mediaserver`'s actual SkypeKit transport socket now
works.** `vidrtp_sniffer client /tmp/vidrtp_from_skypekit_key ...` connects successfully on the first
attempt, consistently, across multiple runs. Held the connection open for 16+ seconds — zero bytes
arrive unprompted, confirming `mediaserver` (playing the `Sid::Protocol::BinServer` role on this
channel, per Part 10) sits passively waiting to *read* an incoming RPC call from the connecting peer,
exactly matching the `BinServer::rd_command()`-driven architecture already traced. It does not push
anything until the peer (us, eventually) speaks first.

**Where this leaves it:** every architectural piece from Parts 9–11 is now not just theorized but
directly proven live: the camera caps fix works, `RunVideoHost`/the socket layer genuinely starts on
its own once `videoPlayerStart` has run for long enough, and a real external process can now connect
to `mediaserver`'s live SkypeKit socket. **The one remaining piece is implementing enough of
`Sid::Protocol::BinClient`'s wire framing to actually send a valid RPC call** — `mediaserver` is
proven ready and waiting to receive one. This is now a concrete, well-scoped implementation task
(not open-ended reverse-engineering): decode `BinCommon::wr_call`/`wr_parms`/the `Sid::Field` type
table's byte-level encoding (all real, named, disassemblable functions already located in Part 10),
write a minimal call (e.g. whatever the real `skypekit` engine would send first — worth checking
`Sid::SkypeVideoRTPInterfaceCbClient`'s own call sequence for the expected first message), and confirm
`mediaserver` responds or starts forwarding real RTP.

**Device state, verified clean:** `mediaserver` running normally under upstart (confirmed via a
`luna-send` sanity call after every native-side test in this part), no leftover `vidrtp_sniffer`/
`strace`/manual `mediaserver` processes.

## Part 13 — decoded the wire format's fundamentals; pivoting to linking against the real .so
## instead of hand-reconstructing bytes

Continued straight into the `Sid::Protocol::BinClient` wire-format work Part 12 set up. Real, concrete
progress, confirmed via clean disassembly (not guessed):

- **Integers are LEB128 varints** (`BinCommon::wr_value(CI*, unsigned int const&)`, 0x3ec18): 7 bits
  of payload per byte, continuation bit (0x80) set on all but the last byte — identical to Protocol
  Buffers' varint encoding. Simple, well-understood, low-risk to reimplement.
- **`SEBinary` values are `varint(length)` + raw bytes** (`BinCommon::wr_value(CI*, SEBinary const&)`,
  0x3f058) — a plain length-prefixed blob. Also simple and low-risk.
- **The call structure**: `wr_call`/`wr_call_lst` → `wr_preencoded` (writes a header, increments an
  internal sequence counter, writes a responseId varint if fields are present) → `wr_parms` →
  `wr_message`, which iterates a table of 16-byte `Field` entries. Confirmed each `Field` entry embeds
  a raw function pointer at offset 0, called directly to read/write/skip that field — a generic,
  code-generated marshalling system, not a simple type-tag switch.
- **Found `RtpPacketReceived`'s exact command ID: 20.** `VideoHost`'s vtable slot for
  `RtpPacketReceived` (`0x382c4`) sits at relocation address `0x62380` (found via `readelf -r`, since
  this shared library's vtables are populated by `R_ARM_ABS32` relocations, not raw file bytes — first
  wrong turn this part: reading the on-disk vtable words directly gave garbage until this was
  understood). Cross-referenced against `SkypeVideoRTPInterfaceServer::ProcessCall`'s 34-entry jump
  table by searching the *whole* library for any call site using vtable offset `0x58` (matching
  `0x62380`'s position) — found and confirmed at `0x3b484`, inside the branch for jump-table index 19,
  i.e. **cmdId 20**. (The naive assumption "jump-table index N ↔ vtable slot N" was wrong — verified
  the real mapping empirically instead of trusting that assumption.)
- **Found the exact `Field` table pointer for `RtpPacketReceived`'s own parameter** at that same call
  site (`0x3b460`: `ldr r2,[r6,lr]`, `lr` = `.word` at `0x3bc10`) — the *correct*, compiler-generated
  descriptor for "one `SEBinary` parameter," not an approximation borrowed from a different call.

**Found, but did not finish decoding: the command header itself is a precomputed byte blob, not a
plain `cmdId + cmdName` encoding.** Traced `wr_preencoded`'s "header write" call through to
`AVTransportWrapper`'s vtable (confirmed via `BinCommon`'s own constructor, which shows `this+8` really
is the `TransportInterface*`, not `Api*` as briefly suspected) — vtable+20 resolves to
`AVTransportWrapper::bl_write_bytes(CommandInitiator*, unsigned int count, char const* data)`, a *raw*
byte writer. `SendRTPPacket`'s call site passes a **compile-time-precomputed pointer+length** as
`(data, count)` — the entire cmdId+cmdName header for that specific call, already serialized into
`.rodata` by the SkypeKit code generator, just written raw rather than re-encoded per call. Attempted
to dump those exact bytes to reverse the header format empirically — **made a GOT-relative addressing
mistake and read the wrong location** (landed in a nearby RTTI type-name string table instead, an easy
mistake to make by hand at this depth, caught before it caused any harm since nothing was sent to the
device based on it).

**Decision: stop hand-reconstructing wire bytes, pivot to linking against the real `.so` directly.**
Given a second hand-arithmetic mistake in this same part (on top of the vtable-relocation one), and
that any further mistakes here would risk sending malformed bytes to the *live* `mediaserver` process,
the safer and more reliable path is to **cross-compile a small program that links directly against
`libpalmgstskype.so`** and calls its real, already-correct compiled functions — `AVTransportWrapper`
(construct + `Connect("/tmp/vidrtp_from_skypekit_key", isServer=false, ...)`, matching the exact role
already proven live in Part 12), `Sid::Protocol::BinClient` (construct, wrapping that transport),
`SEBinary::set(void const*, unsigned)` (confirmed exported, used by `VideoHost::SendRTP` itself), and
`BinClient::wr_call_lst` (called directly with cmdId=20, the confirmed `RtpPacketReceived` field table
pointer, and our own `SEBinary`). This reuses 100% of the real, tested wire encoding — the only thing
that needs to be correct is the C++ object layout for calling into it, not the byte format itself.

**Device state:** no device-side testing happened in this part (pure static analysis); `mediaserver`
untouched, still the normal upstart-managed instance from Part 12.

## Part 14 — built it, and it works: a real `RtpPacketReceived` RPC call successfully sent to and
## processed by mediaserver's live SkypeKit interface

Built and tested Part 13's plan (`skypekit_send_test.cpp` + `build-skypekit-send-test.sh`, this
directory). Two real bugs found and fixed via live, iterative testing — both caught safely, since
(as designed) any mistake here could only crash our own test process, never `mediaserver`:

1. **Runtime library path.** First run failed immediately: `error while loading shared libraries:
   libpalmgstskype.so: cannot open shared object file`. `-Wl,-rpath-link` (used at link time) only
   affects link-time symbol verification, not the runtime search path — the library lives in a
   GStreamer plugin directory (`/usr/lib/gstreamer-0.10/`), not the standard library path. Fixed by
   setting `LD_LIBRARY_PATH=/usr/lib/gstreamer-0.10` when running the tool (not baked into the
   binary — simplest fix for a throwaway test tool).
2. **`SEBinary`'s pre-`set()` state.** With that fixed, the tool connected successfully
   (`connected.`) and got as far as `SEBinary::set()` before segfaulting. Added a `SIGSEGV` handler
   with `sigaction(SA_SIGINFO)` directly in the test program (gdb remote debugging has been
   unreliable all session — see Part 6 — and this device's `strace` is too old to decode `siginfo`'s
   fault address) to print the fault address and registers ourselves rather than keep guessing.
   Root cause: an all-zero `SEBinary` buffer isn't valid — disassembly of `VideoHost::SendRTP`'s own
   inline construction of a temporary `SEBinary` (`libpalmgstskype.so` 0x36644-0x36664, right before
   its own `SEBinary::set()` call) shows the pre-`set()` state is `{0, 0, 0, 1}` as four words, not
   all zero — offset+12 (likely a refcount) must be `1`. Fixed by setting that one word explicitly.

**With both fixed, the tool still crashed — one more real bug, caught the same safe way.** Fault
address `0x2`, deep inside `wr_call_lst`. Reconsidered the field-table argument: Part 13 had computed
and passed an *already-offset* pointer (`M_SkypeVideoRTPInterface_fields + 91*16`) with
`fieldCount=0`. Re-examining `ProcessCall`'s own cmdId=20 dispatch site
(`libpalmgstskype.so` 0x3b448-0x3b490) more carefully: it calls `rd_parms(ci, fields=<raw base
pointer, unindexed>, count=91, buf)` — the base pointer and the index are passed as *separate*
arguments, meaning the callee computes `fields + index*16` internally rather than expecting a
pre-offset pointer from the caller. Fixed to pass the raw base pointer with `fieldCount=91` instead
— **and it worked**: `wr_call_lst` returned `0` (success), no crash, `mediaserver` confirmed fully
healthy afterward (same PID, `luna-send` sanity call succeeded).

**Confirmed via `--gst-debug=4` that the call had a real, visible effect on `mediaserver`'s internal
pipeline — not just "didn't crash."** Compared against every prior test run this session: the
`clonkvhsrc` bin's internal `rtp` sub-element (a `GstSkypeRtpSrc`, `gstskypertpsrc.c`) had *never*
shown any lifecycle activity in any earlier log capture — only the endless
`element rtp not linked on any sinkpads` message. In this run, immediately after our injected call,
that same element logs real activity: `unlock`, `unlock_stop`, `stop`, and critically
`gst_skype_rtp_src_create` actually being invoked (reporting `"wrong state (unlocked)"` — a real,
different, further-along failure mode than "never touched at all"). The linking issue isn't fully
resolved yet, but this is concrete evidence `mediaserver` genuinely received, parsed, and dispatched
our hand-constructed `RtpPacketReceived` call through to the real `VideoHost` implementation and its
GStreamer element — reproduced consistently across multiple runs, not a one-off fluke.

**Where this leaves it:** the core, hardest problem of this whole investigation — proving a real
SkypeKit RPC call can be constructed and delivered to `mediaserver` without needing the actual
SkypeKit SDK source — is solved and demonstrated live. What remains is refinement, not
architecture-level uncertainty: reverse-engineer why `gst_skype_rtp_src_create` reports "wrong state
(unlocked)" (likely a sequencing issue — probably needs the pipeline already in `PLAYING`, or a
`SetIntProperty`/resolution call first, before `RtpPacketReceived`), and separately implement the
mirror-image outgoing path (`SendRTPPacket`, cmdId confirmed as 4 back in Part 10/13's disassembly)
for the capture/send direction using the exact same technique.

**Device state, verified clean:** the manually-started `mediaserver` (`--gst-debug=4` instance) was
killed and the normal upstart-managed instance restored via `start mediaserver`; confirmed healthy
via `luna-send` afterward (same pattern used throughout this session). No leftover test processes.

## Part 15 — "wrong state (unlocked)" root-caused: it's normal `GstBaseSrc` teardown, not a bug

Part 14 left one open question: is `gst_skype_rtp_src_create`'s `"wrong state (unlocked)"` message a
real, further-along protocol/sequencing bug, or just a timing artifact of our injected call landing
too close to the fixed-duration test's own `videoPlayerStop` teardown?

**Disassembly of `gst_skype_rtp_src_create`** (`libpalmgstskype.so` 0x25474, `gstskypertpsrc.c:291`)
shows it's a standard `GstPushSrc`-derived element: it checks a flag at `this+0x1a8` (set by
`unlock()`, cleared by `unlock_stop()`) at the top of `create()`, and if set, logs exactly
`"wrong state (unlocked)"` and returns `GST_FLOW_WRONG_STATE` instead of pulling from its internal
`GQueue`. This is the textbook `GstBaseSrc` pattern for interrupting a blocked streaming thread during
clean shutdown — `unlock()` exists specifically to wake up a `create()` call that's blocked waiting
for data, so the element's streaming task can notice the pending state change and exit instead of
hanging forever.

**Test:** extended `clonk_probe`'s player-active window from 25s to 90s (and the overall safety
timeout from 55s to 120s) to leave a much wider gap between the socket coming up and our own test's
intentional teardown, specifically to see whether "wrong state" still appeared *during* the active
window (real bug) or only right at teardown (timing artifact, as the flag semantics suggested).

**Result, from a fresh `--gst-debug=4` capture (`mediaserver_debug5.log`, 19150 lines):**
`gst_skype_rtp_src_create` logged `"wrong state (unlocked)"` exactly **once**, at `0:01:39.056` —
one line after `gst_skype_rtp_src_unlock:<rtp> unlock` at `0:01:39.056` and immediately following
`gst_skype_video_src_change_state:<clonkvhsrc> playing -> paused` at `0:01:38.975`. That's ~92 seconds
after the `rtp` element's `init` (`0:00:06.8`) — squarely at our own 90s wait-timer's teardown, not
during the active window. No other occurrence anywhere in the log. This confirms the hypothesis: the
message is benign, expected `GstBaseSrc` shutdown behavior triggered by our own test harness calling
`videoPlayerStop`, not a sequencing bug in the `RtpPacketReceived` call itself.

Also confirmed from the same log: `rtp:src` successfully linked to `depay:sink` and its streaming
task started (`gst_pad_start_task:<rtp:src>`) at `0:00:07.246`, well before any teardown — the pad
task lifecycle is healthy. (Actual per-buffer push/chain activity isn't visible at this log verbosity
— `gst_pad_push` traffic logs at `LOG`/`TRACE` level, above what `--gst-debug=4` captures — so this
doesn't yet prove a specific injected payload was pulled and forwarded downstream, only that the
pipeline's plumbing around `rtp` is correctly linked and running.)

**Conclusion:** part (a) of the "missing bits" is resolved — there is no remaining sequencing bug to
chase here. `RtpPacketReceived`, delivered via `skypekit_send_test`'s real-`.so`-linking technique,
reaches `VideoHost`'s `GstSkypeRtpSrc` element cleanly under normal (non-teardown) conditions.

**Device state, verified clean:** manually-started `mediaserver` (`--gst-debug=4` instance, PID 8899)
killed; normal upstart-managed instance restored via `start mediaserver` (new PID 20910); confirmed
healthy via `luna-send` afterward (same permission-denied-but-responsive pattern used throughout this
session as the health signal).

**Remaining work:** part (b) — the mirror-image outgoing path. `VideoHost::SendRTP` calls
`Sid::SkypeVideoRTPInterfaceCbClient::SendRTPPacket` (cmdId 4, confirmed in Part 10/13's disassembly)
over `/tmp/vidrtp_to_skypekit_key`, where **mediaserver is the client** (dialing out) — meaning a test
tool for this direction needs `vidrtp_sniffer`'s existing `server`-mode capability (already proven
working), not `skypekit_send_test`'s `client`-mode connect.

## Part 16 — found and fixed a real firmware caps-negotiation bug blocking capture entirely; the
outbound SkypeKit socket still never connects even with a genuinely working capture pipeline

Started part (b) by binding `vidrtp_sniffer` in `server` mode on `/tmp/vidrtp_to_skypekit_key` before
triggering `videoCaptureStart`, expecting to capture real `SendRTPPacket` bytes the way Part 12 did for
the incoming direction. No connection ever arrived, across several run shapes (capture alone, capture
held active while player also started, a stop/start retry pass). Rather than keep guessing at timing,
switched to a manual `--gst-debug=4` `mediaserver` instance to see what the capture pipeline itself was
actually doing.

**Found a real, blocking bug, not a timing issue.** `camsrc`'s `gst_base_src_start()` failed immediately
with `"Could not negotiate format"` on every run. The downstream `"Resolution Caps Filter"` capsfilter's
actual filter caps were `width=240, height=30, framerate=30/1` — not the `width=320, height=240` we
requested via `videoCaptureStart(320,240,30,400000)`. Those broken numbers are exactly our own `h=240`
and `fps=30` argument *values*, landed in the wrong caps fields — not defaults, not garbage. A stop/start
retry pass (mirroring the player-side workaround theory from Part 8/11) reproduced the identical broken
caps both times, ruling out a cache-timing bug and pointing at a genuine value/offset bug.

**Root-caused via disassembly of `ClonkPipeline::setCamCapsFilter()`** (`mediaserver` 0xb1fa0, found by
locating the `"Resolution Caps Filter"` element name at `.rodata` and cross-referencing
`gst_element_factory_make`). It calls `gst_caps_new_simple()` with:
- `framerate` = a literal `30/1` hardcoded directly in the instruction stream (never read from any
  settings object at all — explains why framerate was never the problem here, and also means our own
  `fps` argument no longer needs to literally be a valid framerate once repurposed, see below)
- `width` = `*(VideoSettings_object + 4)`
- `height` = `*(VideoSettings_object + 8)` (with a quirk: if that value is exactly `120`, it's remapped
  to `128` first — an unrelated special case that never triggered in our testing)

Cross-referencing against the empirically observed broken values: `+4` held our own `h` argument (240),
`+8` held our own `fps` argument (30). Since `ClonkSession::videoCaptureStart`'s `ClonkHostEvent` (the
object carrying our LS2 arguments into the pipeline, confirmed via disassembly of
`mediaserver` 0x6e9b0) stores them in plain order (`+12=w, +16=h, +20=fps, +24=bitrate`), and the
matching values line up field-for-field with no shift in the copy itself, the simplest and best-fitting
explanation is that `VideoSettings`'s own layout is likewise a plain, unshifted `(+0=w, +4=h, +8=fps,
+12=bitrate)` — and `setCamCapsFilter()` itself just reads one field too far for both properties: `+4`/
`+8` instead of the correct `+0`/`+4`. A real, shipped firmware bug in `mediaserver`, not something in
our probing.

**Fix (workaround, since we can only drive this through the LS2 API, not patch the binary): shift our
own argument values by one slot to compensate.** To land `width=320, height=240` in the actual applied
caps, call `videoCaptureStart` with `320` in the *height* argument slot and `240` in the *fps* argument
slot: `{"args":[320,320,240,400000]}`. Tested live and confirmed via a fresh `--gst-debug=4` capture
(`mediaserver_debug7.log`):
- `Resolution Caps Filter` intersects to exactly `width=320, height=240, framerate=30/1` — one of
  `camsrc`'s three valid discrete resolutions.
- `camsrc` transitions `READY → PAUSED → PLAYING` with **no** `"Could not negotiate format"` error —
  the first time this session capture ever got past that point.
- `getVideoCaptureActive` returns `true` (previously always `false` even when `videoCaptureStart`
  itself returned `{"returnValue":true}`) — independent confirmation the pipeline is genuinely running,
  not just nominally "started."
- The full downstream chain (`Camera Tee` → `Palm Video Encoder` → `Video Encoder Queue` →
  `clonkvhsink`/`skypevideosink`, plus a local `palmvideosink0` preview branch) constructs and later
  tears down with **zero** `busMsg_ERROR` or negotiation-failure messages anywhere in the log — the
  capture pipeline now runs cleanly end to end.

**However: even with a genuinely working capture pipeline, held active concurrently with an active
player for the full 90s window, `vidrtp_sniffer` in `server` mode on `/tmp/vidrtp_to_skypekit_key`
still never saw an incoming connection.** So there remains at least one further, distinct blocker
specific to the outbound SkypeKit socket setup — unlike the incoming direction (Part 12), which was
confirmed to start unconditionally given enough time once `videoPlayerStart` ran. Not yet identified;
candidates for a future session: `RunVideoHost()`/the AVTransport client-connect call may be gated
behind something neither `videoCaptureStart` nor `videoPlayerStart` alone trigger (e.g. an explicit
"begin streaming"/call-active signal a real `skypem` client would send that our raw LS2 probe never
does), or it may only fire once the encoder actually produces its first real encoded frame (worth
checking whether `Palm Video Encoder` ever emits a buffer, vs. just reaching `PLAYING` state with an
empty queue) — `--gst-debug=4` doesn't show per-buffer `gst_pad_push` traffic (that's `LOG`/`TRACE`
level), so this hasn't been directly confirmed either way yet.

**Device state, verified clean:** manually-started `mediaserver` (`--gst-debug=4` instance) killed;
normal upstart-managed instance restored via `start mediaserver`; confirmed healthy via `luna-send`
afterward (same pattern used throughout this session).

**Files changed:** `clonk_probe.c` — simplified back to a single `videoCaptureStart` call (removed the
now-disproven stop/start retry-pass workaround), applied the field-shift-compensated arguments, and
holds capture and player active concurrently for 90s (from Part 16's earlier "does the player path
trigger the outbound socket too" test, still a live open question above).

## Part 17 — resolved: the outbound connect is gated behind a client connecting to the *incoming*
socket first, confirmed by disassembly and reproduced live

Went looking for what actually triggers `mediaserver`'s outbound `AVTransportWrapper::Connect` on
`/tmp/vidrtp_to_skypekit_key`, since Part 16 left it unexplained. `RunVideoHost()` lives in
`libpalmgstskype.so`, not `mediaserver` itself — found via `GstSkypeInstance::RunVideoHost()`
(`libpalmgstskype.so` 0x29bc0).

**Disassembly of `RunVideoHost()` shows a strict, sequential two-phase structure:**
1. A loop repeatedly calling `Sid::AVServer::Connect(name="/tmp/vidrtp_from_skypekit_key", 10000)`
   until it returns success. `AVServer::Connect` (`libpalmgstskype.so` 0x3dd8c) is a thin wrapper —
   `return AVTransportWrapper::Connect(name, isServer=true, timeout=10000)` — and per Part 12's earlier
   `strace` finding, the server-role `Connect` does the *entire* bind+listen+`poll(timeout)`+**accept**
   cycle internally, retrying every ~10s if nothing connects. The loop only exits (falls through to
   phase 2) when this returns nonzero — i.e. **when something has actually connected** to the incoming
   socket. (There's a separate early-exit branch guarded by a shutdown flag at the `VideoHost` object's
   `+24` byte, unrelated to the success path.)
2. Only after that: `Sid::AVTransportWrapper::Connect(name=[the cached "/tmp/vidrtp_to_skypekit_key"
   transport], isServer=false, timeout=500)` at `libpalmgstskype.so` 0x29e90 — the outbound client
   connect we'd been waiting to see all of Part 16.

In other words: **`RunVideoHost()` will not even attempt to dial the outbound socket until a peer has
first connected to the inbound one.** Every Part 16 test had `vidrtp_sniffer` waiting in `server` mode
on the *outbound* socket in isolation, with nothing ever connecting to the *inbound* one during the
same run — so `RunVideoHost()` was permanently stuck in phase 1, never reaching phase 2. Not a
capture-pipeline bug, not an encoder-readiness gate — a strict ordering dependency between the two
sockets.

**Confirmed live, immediately.** Repeated the Part 16 setup (`vidrtp_sniffer server` on the outbound
socket, `clonk_probe` driving capture+player with the Part 16 caps fix), then — while both were
running — connected `skypekit_send_test` as a client to the *inbound* socket (the same proven
`RtpPacketReceived` call from Part 14). The moment it connected, `vidrtp_sniffer`'s log showed:
```
accepted connection, logging to /media/internal/vidrtp_to.log
logged 535 bytes
peer closed connection
```
535 real bytes from `mediaserver`, dialed out and sent within moments of our client connecting to the
other socket — the **first outbound SkypeKit traffic captured all session**, saved to
`vidrtp_to_captured_part17.log` in this directory. (First connect attempt failed with `AVTransportWrapper::Connect
failed (returned 0)` — a mundane timing artifact of landing between two of the ~10s bind/poll/accept
cycles on the inbound socket, not a repeat of this finding; a fast retry loop connected on the very
next attempt once timed tightly against the socket's appearance.)

The captured bytes start `5a 52 00 01 00 42 01 8d 04 80 ...` followed by ~500 bytes of high-entropy,
no-visible-structure data consistent with real encoded H.264 payload (the capture pipeline was healthy
and active per the Part 16 fix at the time of this run, so a real encoder frame being ready and sent
is plausible) — not yet decoded field-by-field. Given the proven, safe technique from Part 14
(link directly against the real `.so` rather than hand-reconstruct wire bytes), the natural next step
for actually consuming this direction is a `BinServer`/`rd_call`-based receive-side tool built the same
way, rather than reverse-engineering this capture by hand.

**Device state, verified clean:** manually-started `mediaserver` (`--gst-debug=4` instance) killed;
normal upstart-managed instance restored via `start mediaserver`; confirmed healthy via `luna-send`
afterward.

**Practical implication for the eventual bridge:** a real integration must keep a client connected to
`/tmp/vidrtp_from_skypekit_key` (or otherwise satisfy `RunVideoHost()`'s first-phase accept) *before*
or *concurrently with* relying on the outbound socket ever being dialed — the two directions are not
independent from `mediaserver`'s point of view, even though they're logically separate sockets.

## Part 18 — decoded the 535-byte capture: it's a real, standard RTP/H.264 packet, extracted using
the real `Sid::Protocol::BinServer` decoder rather than hand-parsing

Rather than reverse-engineer Part 17's captured bytes by hand (risky, per Part 13's lesson), built
`skypekit_decode_test`, which reuses the exact same safe technique as `skypekit_send_test` (Part 14) —
link directly against the real, extracted `libpalmgstskype.so` and call its actual compiled decoder —
but for reading instead of writing. Two local processes talk over a throwaway abstract socket (no
dependency on `mediaserver` at all): a `client` mode that connects and calls
`Sid::AVTransportWrapper::bl_write_bytes()` — a **raw** byte writer, bypassing `BinClient`'s own
message encoding entirely — to replay Part 17's exact captured bytes verbatim onto the wire; and a
`server` mode that constructs a real `Sid::Protocol::BinServer` around the accepted connection and
calls its actual `rd_call`/`rd_parms` to decode whatever arrives.

**First attempt skipped a required framing step and produced garbage** (`rd_call` returned
`cmdId=0, arg2=90, arg3=82` — suspiciously close to the ASCII values of the capture's own first two
bytes). Root cause, found via disassembling `BinCommon::rd_command` (`libpalmgstskype.so` 0x41824):
every message on the wire starts with **exactly 2 raw bytes** — byte0 must equal the fixed sync byte
`0x5a` (`'Z'`, checked internally, mismatch is an error) and byte1 is stored as the message's "type"
(compared against `0x52`='R' by `ProcessCommands`, meaning "this is a call"). `ProcessCommands` always
calls `rd_command` before `rd_call`; skipping it left the real decoder's read position off by 2 bytes,
desyncing everything downstream. This also resolved Part 17's open question about what the leading
`5a 52` bytes were — not a "cmdName" string, but this 2-byte sync+type header. (The matching 4-byte
`5a 52 00 01 00 00 00 00`-style entries found in `.rodata` alongside the actual field table pointers
appear to be a *different*, per-interface class-identifier tag — not directly written to the wire in
this form — a detail that no longer matters now that the real bytes decode cleanly regardless.)

**Fixed by calling `rd_command` first, then `rd_call`, then `rd_parms`** with
`Sid::Field::M_SkypeVideoRTPInterfaceCb_fields` at index 0 (the same field table confirmed via
disassembly of `SendRTPPacket`'s own encode call in Part 17) — and it worked cleanly:
```
rd_command returned 0, type=0x52 ('R')
rd_call returned 0, cmdId=0 arg2=0 arg3=1
rd_parms returned 0
decoded SEBinary: data=0x23d18 len=525
```
(`cmdId=0` here doesn't mean much on its own — this precompiled/"preencoded" call path apparently
doesn't round-trip a meaningful numeric cmdId through `rd_call` the same way a plain `wr_call_lst`
string-named call would; not worth chasing further now that the payload itself decoded correctly.)

**The decoded 525-byte payload is a real, standards-compliant RTP packet carrying genuine H.264 video
data** — not a SkypeKit-proprietary wrapper:
- Byte 0 = `0x80` → RTP version 2, no padding, no extension, no CSRC — a completely ordinary RTP
  header first byte.
- Byte 1 = `0xe0` → marker bit set (`1`), payload type `96` — exactly the dynamic payload type seen
  in the pipeline's own negotiated caps (`application/x-rtp, payload=(int)[96, 127], ...,
  encoding-name=(string)H264`, Part 15).
- Bytes 2–3 = sequence number `0xf83c`; bytes 4–7 = timestamp `0x89e6687f`; bytes 8–11 = SSRC
  `0x7bb6139b` — all present and well-formed.
- Byte 12 (first payload byte) = `0x41` → a valid H.264 NAL unit header (`nal_ref_idc=2,
  nal_unit_type=1`, "coded slice of a non-IDR picture") — exactly what real inter-frame H.264 video
  data looks like.

This is strong, direct confirmation that: (1) the Part 16 caps fix produced a genuinely working
capture pipeline that really did encode a real video frame, (2) `SendRTPPacket` carries standard RTP
with standard H.264 payloads — no SkypeKit-specific frame wrapping to reverse-engineer beyond the
2-byte sync/type header and the generic `Field`-table SEBinary framing already decoded — which is very
good news for the eventual bridge: the payload itself can be handled with completely ordinary RTP/H.264
tooling, matching what `meowcaller`/`whatsmeow`'s `Call.SendVideo` already expects.

**Saved locally for reference:** `vidrtp_to_captured_part17.bin` (the raw 535-byte capture),
`decoded_rtp_packet_part18.bin` (the extracted 525-byte RTP packet), both in this directory.

**Device state:** this test never touched `mediaserver` at all (two local processes talking to each
other over a throwaway abstract socket) — confirmed still healthy via `luna-send` afterward regardless.

**Files added:** `skypekit_decode_test.cpp`, `build-skypekit-decode-test.sh`.

## Part 19 — hooked it up: a real native SkypeKit<->meowcaller video bridge, built and linked
into the actual WhatsApp calling plugin

Built the real integration described in this session's "hook it up properly" plan (full plan
text in the session transcript; summary here). New files, all in
`messaging/facebook-e2ee/plugin/purple-combined/`:

- **`glue/h264_rtp.h`/`.c`** — a pure-C, socket-free RFC 6184 depacketizer (RTP payload + marker
  bit -> Annex-B access units, handling single-NAL, STAP-A, and FU-A) and packetizer (access
  unit -> RTP payloads, FU-A-fragmenting anything over an MTU). Round-trip tested standalone
  (7 cases: single/multi-NAL, FU-A at two MTUs, a mixed access unit, and the start-code-adjacent
  trailing-zero edge case) — all pass.
- **`glue/skypekit.h`/`.cpp`** — the actual SkypeKit socket bridge, linking directly against the
  real `libpalmgstskype.so` via the same asm-mangled-symbol trick as `skypekit_send_test.cpp`/
  `skypekit_decode_test.cpp`. Two threads: Thread A binds+listens `/tmp/vidrtp_to_skypekit_key`
  and decodes each `SendRTPPacket` call with the real `BinServer` (Part 18's technique), handing
  completed access units to Go; Thread B connects as a client to
  `/tmp/vidrtp_from_skypekit_key` and, on each access unit Go hands it, RTP-packetizes and sends
  it as one or more real `RtpPacketReceived` calls (Part 14's technique), maintaining real
  sequence/timestamp/SSRC state across the call.
- **`glue/call.c`** — `clonk_open`/`clonk_close` deepened from bare session tracking into the
  real sequence: session create -> `videoCaptureStart` (Part 16's field-shift-compensated args)
  -> `voipkit_video_start()` (binds Thread A) -> `videoPlayerStart` (triggers `RunVideoHost()`) ->
  Thread B's connect loop. Teardown mirrors it in reverse.
- **`call.go`** (plugin-level) — `attachMedia` now also wires `Call.ReceiveVideo` to
  `voipkit_video_receive_frame` (peer video -> native display), and a new exported
  `gowhatsapp_call_video_frame_out` (native capture -> `Call.SendVideoWithDuration`) routes to
  whichever call is currently live, matching this file's existing single-live-call convention.
- **`build-combined.sh`** — compiles `voipkit.cpp` with g++ (`-fno-rtti`) and `h264_rtp.c`
  alongside the existing glue objects, links `-lpalmgstskype`, and — unlike every standalone test
  tool this session, which needed `LD_LIBRARY_PATH` set manually — bakes
  `-Wl,-rpath,/usr/lib/gstreamer-0.10` into the built plugin so it finds the real `.so` at
  runtime unconditionally.

**A real pthread deadlock, found and fixed via live testing before it ever reached the full
plugin.** First version cancelled both bridge threads on stop via `pthread_cancel`. Thread B
(the peer->display queue-wait) hung on shutdown, confirmed live: `/proc/<pid>/task` showed the
process down to one thread blocked in `futex_wait_queue_me` — cancelling a thread blocked in
`pthread_cond_wait`/`cond_timedwait` re-locks the mutex as part of POSIX's cancellation cleanup,
and without a `pthread_cleanup_push` to release it, that mutex stays locked forever once the
thread exits, deadlocking `voipkit_video_stop()`'s own later lock of it. Fixed by making Thread
B fully cooperative instead: every blocking call it makes is naturally bounded (`avtw_connect`'s
own timeout, or `pthread_cond_timedwait` with an explicit `g_running` check), so it always exits
on its own and is never cancelled. Thread A still uses `pthread_cancel` (safe — it never touches
that mutex).

**Confirmed live, end to end, before wiring the rest.** Built a standalone smoke-test harness
(`voipkit_bridge_selftest.c` — stands in for meowcaller, logging frames from Thread A and
pushing a synthetic access unit into Thread B) and ran it alongside `clonk_probe` (already
carrying the Part 16 fix) against a `--gst-debug=4` `mediaserver`:
```
wa-call: skypekit thread B connected to mediaserver
wa-call: skypekit thread A accepted a connection
[selftest] frame_out: 1504 bytes, first 16: 00 00 00 01 67 42 c0 0c e9 02 83 f2 00 00 00 01
```
Thread B's connection is what unlocked Thread A's accept, exactly as Part 17 predicted — in
production code this time, not a hand-built test tool. And the decoded access unit is a real,
multi-NAL H.264 stream starting with a genuine SPS (`0x67`, profile `0x42` = Baseline) followed
immediately by another NAL — i.e. mediaserver's own encoder emits a proper SPS+PPS+IDR opening
sequence, which is exactly what meowcaller's `videoSender` needs (it silently drops every access
unit until one contains a real IDR). The `--gst-debug=4` log showed zero pipeline errors
throughout.

**Open question, not yet resolved: the connection closed after that one access unit and never
reopened for the rest of the 90s test window**, with no GStreamer errors visible anywhere in the
log. This matches a real, already-flagged risk from the `RunVideoHost()` disassembly (Part 17):
its phase-2 outbound dial is a *single* 500ms-timeout attempt, not wrapped in a retry loop the
way phase-1 is — so if that one connection ever drops, nothing in the native firmware appears to
re-establish it within the same `RunVideoHost()` invocation. Whether this actually blocks a real,
sustained WhatsApp video call (as opposed to this synthetic, short-lived `clonk_probe`-driven
test) is unconfirmed — a real call may keep the session alive differently. **This is the most
important thing to check first during real end-to-end call testing.**

**Verified:** the full `build-combined.sh` build succeeds — `voipkit.cpp`/`h264_rtp.c` compile
cleanly, the final `libwhatsmeow.so` link succeeds, `NEEDED` correctly lists
`libpalmgstskype.so`, `RPATH` is `/usr/lib/gstreamer-0.10` as intended, and both the Go export
(`gowhatsapp_call_video_frame_out`) and the new C entry points
(`voipkit_video_start`/`_stop`/`_receive_frame`) are present and correctly typed in the final
binary, with every SkypeKit symbol showing as an unresolved `U` deferred to the real `.so` at
runtime — the plugin itself has not yet been deployed and exercised through a real WhatsApp video
call.

**Device state:** all test processes (`voipkit_bridge_selftest`, `clonk_probe`) killed; manually
started `--gst-debug=4` `mediaserver` killed; normal upstart-managed instance restored via
`start mediaserver`; confirmed healthy via `luna-send` afterward.

**Files added:** `messaging/facebook-e2ee/plugin/purple-combined/glue/{h264_rtp.h,h264_rtp.c,
skypekit.h,voipkit.cpp}`, `messaging/whatsapp/calling/{voipkit_bridge_selftest.c,
build-skypekit-bridge-selftest.sh}`. **Files changed:** `glue/call.c`, `call.go`,
`build-combined.sh`.

**Next steps:** deploy the built plugin and place a real, sustained WhatsApp video call between
two accounts, one being the TouchPad. Confirm outgoing video reaches the peer and incoming peer
video renders natively — and specifically watch whether the outbound connection survives for the
call's duration or exhibits the same single-frame-then-drop behavior seen in this synthetic test.

## Part 20 — deployed to the live device and placed a real WhatsApp video call: the native
bridge activated successfully in production

Deployed `build-arm/libwhatsmeow.stripped.so` (the plugin built in Part 19) onto the TouchPad,
replacing the live `com.palm.app.teams/backend/lib/purple-2/libwhatsmeow.so` (backed up first to
`libwhatsmeow.so.b4vidbridge`, matching this codebase's existing `.b4*` backup convention). First
`novacom put` attempt silently truncated the file to 0 bytes mid-transfer (a known failure mode
`deploy-whatsapp.sh` already documents) — as a side effect, the already-running old
`imlibpurpletransport` process SIGBUS'd (its mmap'd `.so` shrank out from under it). Retried with
byte-count verification (matching `deploy-whatsapp.sh`'s `put_verify` pattern) and it landed
intact; restarted the transport (SIGTERM + clear the PmLog semaphore, matching
`deploy-whatsapp.sh` step 4d) and it came back up clean via upstart respawn.

**Confirmed the new plugin loads correctly**: `callStateQuery` responded immediately after
restart, meaning `whatsapp_call_luna_init()` — and therefore the whole plugin, including the new
`voipkit.cpp`/`h264_rtp.c` code linked into it — initialized without crashing. The
`-Wl,-rpath,/usr/lib/gstreamer-0.10` link flag (Part 19) worked exactly as intended: no
`LD_LIBRARY_PATH` was set for this launch (confirmed by reading the actual launch chain,
`/etc/event.d/imtransport` -> `/var/imdaemon.sh` -> `/var/imwrap.sh`, none of which reference
`gstreamer-0.10`), yet `libpalmgstskype.so` still resolved.

**Placed a real call** via `luna-send` (`dial {"address":"+31...","video":true}`) — connected
successfully (real call id, audio confirmed working both directions per the log). Dialing with
`video:true` only sends the WhatsApp-protocol video-upgrade signal, though; the *native* clonk
session only opens on an explicit `changeMedia {"outgoingVideo":true}` (normally sent by the Phone
app's video-call UI, not bundled into dial itself) — sent that manually next, and the native
video bridge came up, logged live from `/media/cryptofs/imstdout.log` (the real destination of
this plugin's stderr, traced through `/etc/event.d/imtransport`'s upstart job — `console none` ->
`imdaemon.sh` -> `imwrap.sh`'s final `>> /media/cryptofs/imstdout.log 2>&1`, not
`/var/log/messages`):
```
wa-call: clonk session open: palm://com.palm.mediad.Clonk_23452/
wa-call: clonk videoCaptureStart: {"returnValue":true}
wa-call: skypekit thread A accepted a connection
wa-call: skypekit thread B connected to mediaserver
wa-call: clonk videoPlayerStart: {"returnValue":true}
```
Both SkypeKit socket threads connected in a real call, for the first time — not a synthetic test
harness. The call ended a short time later (cause not directly observed — could be either party
hanging up, or a timeout); teardown was clean (`videoPlayerStop`/`videoCaptureStop` both
succeeded, no crash, no error), and `imlibpurpletransport` remained the same stable process
throughout (no restart needed) with `callStateQuery` still responsive afterward.

**Not yet directly confirmed:** whether real camera video actually reached the peer's screen, or
whether the peer's video rendered on the TouchPad's own display — this requires the human on the
other end of the call to report what they actually saw, which wasn't available from the device
logs alone in this pass. The architecture-level milestone (both native SkypeKit sockets
connecting successfully inside a real, unmodified WhatsApp call flow) is confirmed; visual/quality
confirmation is the next thing to check.

**Device state:** `imlibpurpletransport` (PID 7619) and `mediaserver` both left running normally,
undisturbed since this deploy — no manual debug instance was used for this test (unlike every
earlier synthetic test this session) since this was a real, production call, not a lab test.

**Confirmed by the human on the other end: real video, correctly decoded.** The peer's phone
showed the TouchPad's own living room — genuine, visually-correct camera output, not just "bytes
arrived." This closes out the outgoing (capture -> peer) direction end to end: native `camsrc` ->
`Palm Video Encoder` -> `SendRTPPacket` -> Thread A's decode/depacketize -> `Call.SendVideo` ->
the real WhatsApp relay -> the peer's phone, all through the code written in Part 19, working the
very first time it ran in a real call. The incoming (peer -> TouchPad display) direction's visual
confirmation is still open — Thread B connected, but whether real peer frames actually rendered on
the TouchPad's own screen during this same call hasn't been confirmed yet.

## Part 21 — a second, longer real call: reconnect resilience confirmed live, real incoming
video frames flowed, and a keyframe-request workaround added

Placed a second real call (same live device, `--gst-debug=4` `mediaserver` this time for
visibility). Two things this run confirmed that the "hook it up properly" plan had left as open
risks:

- **Reconnect resilience already worked, without any new code.** `voipkit.cpp`'s Thread A and
  Thread B both retry in their own outer loops after any disconnect (Thread A re-binds/listens,
  Thread B re-connects) — this was already in the Part 19 code, just not yet exercised by a real
  disconnect. This call logged `thread B connected` -> `disconnected, retrying` -> `connected`
  again, entirely on its own, with real video flowing after the second connect. The
  single-shot-outbound-dial risk flagged in Part 19 (from the `RunVideoHost()` disassembly) turned
  out not to matter in practice: a real, sustained call behaves differently from the short
  synthetic `clonk_probe` test that risk was originally observed in.
- **Real incoming video frames were decoded and forwarded, not just a connection.** Once the
  peer's phone started actually transmitting (partway into the call), `imstdout.log` showed
  repeated `skypekit thread B sending access unit` lines (peer -> TouchPad direction is actually
  named misleadingly in that log string — this is Thread B decoding real inbound frames and
  handing them to the native player), and `mediaserver`'s own `clonk_vplay_h264dec`
  (`palm_videodecoder`, the real hardware decoder) reached `PLAYING` with zero errors. Direct
  on-screen visual confirmation of this direction is still outstanding — the call ended
  (or went quiet, cause unconfirmed) before that could be checked.

**Added a keyframe-request workaround.** `Call.OnVideoKeyframeRequest` (fired on the peer's
authenticated PLI/FIR feedback) is now wired to a new `gowhatsapp_call_request_keyframe()`
(`glue/call.c`), which stops and restarts capture (`videoCaptureStop` then `videoCaptureStart`
with the Part 16 compensated args) — no separate keyframe request exists on the native LS2
surface, but every capture start emits a real SPS/PPS/IDR opening sequence (confirmed in every
real call so far), so forcing a restart is a working, if heavier-handed, substitute. `call.go`'s
`wireCall` now registers this alongside the other `mcCall.On...` callbacks. Full `build-combined.sh`
build verified clean; `gowhatsapp_call_request_keyframe` confirmed present and correctly typed in
the linked `.so`. Not yet exercised against a real PLI/FIR from the peer (only compile/link
verified) — the packet-loss conditions that trigger it didn't occur during this session's calls.

## Part 22 — two real firmware bugs found and fixed via binary patching `media-pipeline.real`: the black-screen root cause

Follow-up session, driven by the still-open "audio works, incoming video never displays" symptom
even after Parts 1–21's fixes. Built a local reproduction harness (`testInjectVideo`/
`testStopInjectVideo` debug LS2 methods added to `glue/call.c`, reusing the production
`clonk_open`→`videoCaptureStart`→`videoPlayerStart` path and injecting a real captured H.264
SPS+PPS+IDR access unit via `voipkit_video_receive_frame()` on a timer) to iterate without needing
a live call. Discovered along the way that the actual per-session GStreamer worker is **not**
`mediaserver` itself but a child it `--spawn`s per call: `/usr/bin/media-pipeline.real` (`mediaserver`
just supervises). Both bugs below live in that binary. Ghidra project (auto-analysis, no manual
symbols needed — binary is unstripped): imported at
`third_party/meowcaller` session scratch, function/vtable addresses below are from that binary's own
symbol table.

**Bug 1 — `setDisplayFull()` never enables the "VideoEnableDisplay" GStreamer property; its sibling
`setDisplayPip()` does.** `media::pipeline::gst::element::VideoSink` has parallel setup functions for
the two sink types: `setDisplayPip()` (self-view/outgoing) sets `VideoDeviceParams` then calls
`setDisplayEnable(this, 1)`; `setDisplayFull()` (incoming/remote — what `initializeVPlayPipeline`
uses) sets `VideoDeviceParams` and **stops there**, never calling `setDisplayEnable`. The
`VideoEnableDisplay` property directly gates `palm_videosink_render()` (in
`libPmMediaGstVideoSinkLib.so`, confirmed via decompile of the property-setter and the render
function's early-exit check) — without it, every render call for the incoming sink logs `Entering
Preroll: display state = false. not displaying frame.` and never reaches `vhm_write()` (the actual
hardware overlay write), confirmed live via `gst_debug_child.log`: 3317/3317 `false`, 0 `true`,
across an entire session including real calls. This is the direct, mechanical cause of "audio
plays, video never appears" — frames were reaching the sink and being silently dropped at the very
last step, every single time, for both real calls and the local harness. **Fix:** since the
function bodies live in a read-only system binary (no source, no rebuild), patched the compiled
ARM directly. Found a genuinely dead function (`setDisplayAngle`, confirmed zero real callers —
only the synthetic dynsym "Entry Point" reference — via Ghidra reference-manager query) and
overwrote its 60-byte body with a 6-instruction trampoline (`mov r4,lr / mov r0,r7 / mov r1,#1 / bl
setDisplayEnable / mov r0,r5 / bx r4`), then replaced the single `mov r0,r5` instruction at the end
of `setDisplayFull`'s tail (right after its own `g_object_set` call, before the existing
`gst_structure_free` tail-call) with a `bl` to that trampoline — one 4-byte instruction changed at
the call site, nothing else touched. Confirmed live post-patch:
`PROP_VIDEO_DEVICE_PARAMS: type=full,...,display=TRUE` immediately followed by
`PROP_ENABLE_DISPLAY: display_frames=TRUE`, for the real incoming sink, every time.

**Bug 2 — `GST_STATE_CHANGE_NO_PREROLL` misclassified as failure in `startVPlayPipeline` (and every
sibling start* function).** `ClonkPipeline::startVPlayPipeline()` calls
`gst_element_set_state(pipeline, PLAYING)` and classifies the result via `1 < (result - 1)` — which
correctly passes `SUCCESS`(1) and `ASYNC`(2) but incorrectly treats `NO_PREROLL`(3) as failure.
`NO_PREROLL` is the normal, expected return for a pipeline containing a live source (exactly what
`clonkvhsrc`/`skypevideosrc`, the incoming RTP video receiver, is) — not an error. Same bug pattern
confirmed present in `startACapturePipeline`/`startAPlayPipeline` (audio) by disassembly; not yet
patched there. **Fix:** single-byte patch, `cmp r1, #1` → `cmp r1, #2` at the comparison inside
`startVPlayPipeline` (`0xb0ffc` in this binary's build) — now `FAILURE`(0) alone fails, everything
else (`SUCCESS`/`ASYNC`/`NO_PREROLL`) passes. Confirmed this measurably changes real behavior: before
the fix, the incoming pipeline never even attempted the `PAUSED`→`PLAYING` transition; after, it
does.

**Both patches applied directly to `/usr/bin/media-pipeline.real` on-device** (the shipped file, not
a rebuild — there's no source for this binary). Verified byte-for-byte correct via `objdump`
re-disassembly before deploying, and confirmed **the patched binary survives reboots** (persistent
storage, not `/tmp`) — this is now the live, permanent state of this specific TouchPad. No `.so`/
source-tree change corresponds to this fix; it's a device-local binary patch, undone by any future
OS/firmware reflash. Backups of the original, unpatched `media-pipeline.real` and `mediaserver`
kept in `/tmp/media-pipeline.real.orig_backup` etc. on-device (won't survive a reboot — `/tmp` is
tmpfs) and in the session's own scratch directory.

**Remaining open question, not yet resolved: a still-undiagnosed internal teardown after `PLAYING`
is reached.** Even with both bugs fixed, the local test harness's incoming sink still gets torn down
(`gst_element_set_state(clonk_video_play, NULL)`, no GStreamer `ERROR`/`EOS` message preceding it —
confirmed via full `GST_STATES`/`GST_BUS`/`clonk`-category capture) somewhere between ~60ms and
~600ms after reaching `PLAYING`, with the exact gap varying run to run. Traced the vtable dispatch
(`ClonkPipeline`'s real vtable dumped directly from the binary's `_ZTVN5media8pipeline3gst13ClonkPipelineE`
symbol, 36 slots identified by address) far enough to rule out the already-known, already-fixed
keyframe-restart storm (Part 21's 25s cooldown — that's peer-PLI-driven via `call.go`/`call.c` and
can't fire in this harness, which has no real peer) as the cause here specifically. As an
*experiment only* (not deployed as a real fix — reverted before finishing this session), patched
`stopVPlayPipeline`/`teardownVPlayPipeline`'s entry points to `bx lr` (immediate no-op return) to
see what happens with teardown disabled entirely: the incoming sink then survives 100+ seconds
without being torn down, but gets permanently stuck in `PAUSED`/`ASYNC` — `clonk_vplay_h264dec`
(the H.264 decoder) reaches `PLAYING` but never outputs a single decoded buffer, so the sink never
completes preroll and never renders anything either way. Since the harness only ever injects one
static, repeated SPS+PPS+IDR access unit (no subsequent P-frames, no real RTP timing/sequencing),
this "decoder never outputs anything" result is very plausibly a **test-data limitation, not a
third platform bug** — a real call's continuous, properly-encoded/timed stream may decode fine
where a single repeated keyframe does not. **This is the one thing Parts 1–22 have not been able to
confirm without a real live call**: whether, with just the two confirmed-real fixes above (and
without the experimental teardown no-op, which was reverted), a real incoming video stream now
actually renders on screen end to end. The keyframe-restart cooldown (Part 21) and these two new
fixes should, in principle, together be sufficient — a real call is the next and clearest way to
find out.

**Device state at the end of this session:** `/usr/bin/media-pipeline.real` on the live TouchPad
carries both fixes (confirmed via md5 after an intentional reboot). `/etc/event.d/mediaserver`
restored to its original, unmodified content (was temporarily edited mid-session to redirect
`GST_DEBUG_FILE` to an isolated log path for cleaner capture — reverted). The experimental
teardown-disabling patch was **not** kept in the final deployed binary. `mediaserver`/
`imlibpurpletransport` both confirmed healthy and responding to LS2 calls after the final reboot.

## Part 23: Narrowing the ~300ms teardown, and a deliberate stop point

Picked the Part 22 open question back up: traced exactly which log line brackets the
`gst_element_set_state(clonk_video_play, NULL)` call. Captured a full `GST_STATES`/`GST_BUS`
trace of the ~16 GStreamer bus messages processed in the same main-loop iteration immediately
before the `NULL` transition (`before_null.txt`) — every one of them is a routine
`state-changed`/`stream-status`/`new-clock` message, all on the same thread (`0x2b617ea8`), and
critically **none of them are logged as "discarded" by `busMsgCallback`** the way `stream-status`/
`new-clock` messages are elsewhere in the same trace. That absence is the tell: `state-changed`
messages are *not* being discarded, they're being actively handled.

Dumped and decompiled `ClonkPipeline::busMsg_STATE_CHANGED` (`0xb0ac0`) directly (Ghidra recovered
the real signature via debug info: `busMsg_STATE_CHANGED(GstPipelineType, GstElement*, GstBus*,
GstMessage*)`, confirming param_2 is the pipeline type enum — 0/1/2/3, with our incoming sink as
case 1 = VPlay). Its logic: on every state-changed message, it calls a query method through a
**second vtable — not `ClonkPipeline`'s own**, dereferenced via a member pointer at `this+4`
(some "owner"/host object, not yet identified — not `ManagedClonkPipeline`, which was already
ruled out in Part 22 as an unrelated arbitration class, though its vtable happens to expose four
similarly-shaped `*HasPipelineChanged` query slots at the same offsets, which may or may not be
coincidental). Based on that query's result combined with the new/pending GStreamer state, it
computes a boolean and calls a *second* method on the same owner object to report the outcome.
Neither of these two calls is `gst_element_set_state` itself — this function only *notifies* the
owner; whatever decides to actually tear the pipeline down lives inside that owner object's
callback, in a class this session never mapped.

**Decision: stopping here rather than reverse-engineering a third, unmapped class blind.**
Continuing would mean identifying the owner class from scratch (likely `ClonkSession` itself, or
a member of it), decompiling its vtable, finding the specific callback at slot `0x114` (VPlay's
case), and tracing from there into whatever calls `teardownVPlayPipeline`/`stopVPlayPipeline` —
realistically another multi-hour session with no guarantee of a clean single-instruction patch at
the end of it (unlike the two bugs already fixed, which were both clean, isolated, one-function
issues). Weighed against that: the test harness driving all of this analysis only ever feeds the
*same single static IDR frame* on a timer (see `test_inject_frame_tick` in `glue/call.c`) — no
real RTP sequence numbers, no P-frames, no realistic inter-frame timing. It's entirely plausible
the owner object's "has your pipeline changed" query is reacting to something specific to that
unrealistic input pattern (e.g. duplicate timestamps, no progress signal) rather than to a real
platform bug that a genuine call's continuous stream would also trigger. Building a proper
multi-frame injection harness from the real 240-frame `received.h264` capture (tracked as an open
task) would help resolve that ambiguity, but is itself a non-trivial rebuild/redeploy/retest cycle
for a question a single real live call answers directly and conclusively.

**Bottom line for this session:** two real, isolated, deployed, reboot-surviving platform bugs
fixed (Part 22). A third possible issue (early VPlay teardown) is real in the synthetic test
harness but not yet confirmed to occur with genuine call data, and its root cause is only
partially traced. Recommended next step is a real WhatsApp video call, not further synthetic
reverse-engineering — that single test will show directly whether Parts 1-23's fixes are
sufficient, and if not, whether the teardown reproduces under real conditions (in which case the
`this+4` owner-object lead above is exactly where to resume).

## Part 24: Identified the `this+4` owner class — and ruled it out as the trigger

Continued the Part 23 lead at the user's request. The `this+4` pointer in `ClonkPipeline` is a
`media::ClonkState*` (confirmed directly: `ClonkPipeline`'s constructor is literally
`ClonkPipeline(media::ClonkState&)`, and its body does `*(ClonkState**)(this+4) = param_1;` with
no pointer adjustment). `ClonkState` is *not* defined in `media-pipeline.real` itself — it lives in
`/usr/lib/libmedia-api.so` (pulled from the device and analyzed statically; confirmed by symbol
name against the running process's own `/proc/PID/maps`). `ClonkState` is a classic getter/
setter/notify observer interface (`getVideoPlayerActive`/`setVideoPlayerActive`/
`notifyvideoPlayerActive`, etc., one triad per property) — `ClonkSession` implements it, almost
certainly by way of `media::AbstractClonk` (`ClonkSession`'s first base per its RTTI, base_count=2:
`AbstractClonk` at offset 0, `ClonkHostListener` at offset 8 — `AbstractClonk` itself isn't defined
in `media-pipeline.real`, so its full hierarchy wasn't traced further; not needed for what follows).

Since `libmedia-api.so` is a PIC shared library, its vtable slots are zero in the raw file
(runtime-relocated) — read the actual targets from the `.rela`/`.rel` table instead
(`readelf -r`), cross-referenced against each of the four `initializeXXXPipeline` functions in
`media-pipeline.real`, which each make an unambiguous, literal-argument call of the form
`this+4->vtable[offset](true)` to mark their own pipeline "has a pipeline" — giving a ground-truth,
per-pipeline-type offset without needing to guess `GstPipelineType`'s enum values:

| offset | resolved `ClonkState` method | confirmed via |
|---|---|---|
| 0x104 | `setVideoCaptureHasPipeline(bool)` | called from `initializeVCapturePipeline` |
| 0x108 | `setVideoPlayerHasPipeline(bool)` | called from `initializeVPlayPipeline` |
| 0x10c | `setAudioCaptureHasPipeline(bool)` | called from `initializeACapturePipeline` |
| 0x110 | `setAudioPlayerHasPipeline(bool)` | called from `initializeAPlayPipeline` |

Applying that same offset arithmetic to `busMsg_STATE_CHANGED`'s two call sites (Part 23) gives:

| `GstPipelineType` case | query call (offset) | notify call (offset) |
|---|---|---|
| 0 | `getAudioCaptureActive()` (0x84) | `setAudioCaptureActive(bool)` (0x11c) |
| 1 | `getVideoCaptureActive()` (0x7c) | `setVideoCaptureActive(bool)` (0x114) |
| 2 | `getAudioPlayerActive()` (0x88) | `setAudioPlayerActive(bool)` (0x120) |
| 3 | `getVideoPlayerActive()` (0x80) | `setVideoPlayerActive(bool)` (0x118) |

**This corrects a wrong assumption carried since Part 22**: `GstPipelineType` is not
`[VCapture=0, VPlay=1, ACapture=2, APlay=3]` as assumed — it's interleaved,
`[ACapture=0, VCapture=1, APlayer=2, VPlayer=3]`. Our incoming sink is **case 3**, not case 1.

With the correct case, `busMsg_STATE_CHANGED`'s logic for VPlay reduces to: read the current
`getVideoPlayerActive()` flag, combine it with the (pending, new-state) of *this* GStreamer
state-changed message, and write the result back via `setVideoPlayerActive(bool)`. Concretely: it
sets the flag to `false` only when the pipeline is either failing to reach `PLAYING` or has fully
settled at `READY` (the ordinary bookkeeping you'd expect right after any stop, self-initiated or
not) — **this function only ever reacts to a state transition already in progress; it never itself
calls `gst_element_set_state`.** It's a passive property mirror, not a decision-maker. Confirmed
this by exhaustively tracing the arithmetic; no code path in `busMsg_STATE_CHANGED` reaches a
`gst_element_set_state` call directly or indirectly through `ClonkPipeline`'s own vtable.

**Conclusion: the `this+4`/`ClonkState` lead is exhausted — it's a dead end, not the trigger.**
`setVideoPlayerActive(false)` presumably fires a `notifyvideoPlayerActive()` callback through
`ClonkState`'s observer-pattern base (`ClonkChangeListener`, seen registered via
`ClonkSession::addClonkChangeListener` in `ClonkSession`'s own vtable), which could in principle
reach back into LS2/whatever is actually deciding to tear the pipeline down — but that listener
chain, and whatever code actually calls `gst_element_set_state(clonk_video_play, NULL)` in the
first place, is still unmapped, and is a different, deeper investigation than this lead led to.

Also attempted live-process memory inspection via `gdbserver`/`gdb-multiarch` over a
`novacom -P` port forward to shortcut the static RTTI tracing. Confirmed workable in principle
(one successful attach + memory read against a live `media-pipeline.real` process, verifying the
binary loads at fixed static addresses with no ASLR) but proved too unreliable for sustained use
this session: the tunnel drops non-deterministically, `info proc mappings` crashes this
`gdbserver` build and kills the attached target outright (had to fully cycle `mediaserver` to
recover), and every fresh attach's first connection attempt reliably fails. Consistent with the
gdb limitations already documented in Part 6 — reads work, but the tooling around it is fragile.
Static analysis (pulling and disassembling the actual shared libraries involved, as done here) was
the more productive path.

**Where to resume, if a real call reproduces the teardown**: find what registers as a
`ClonkChangeListener` on the `ClonkSession`/`ClonkState` for the `videoPlayerActive` property (or
more directly, search `media-pipeline.real` and `libmedia-api.so` for direct callers of
`gst_element_set_state` with a `NULL`/1 target state near the VPlay pipeline, which was not done
this session — the vtable-tracing approach answered "who gets told" but not "who actually acts").
Device left in the same clean, two-patch-only state as Part 22/23 (`media-pipeline.real` md5
`c92458a3c20a06876d6f25f61c5ff3b8`, upstart config original, `mediaserver` restarted cleanly and
verified running post-investigation).

## Part 25: Six more hypotheses tested — five ruled out, one genuine new anomaly surfaced

Continued at the user's explicit request ("keep pushing on the ClonkChangeListener chain"). Result
up front: **the exact trigger for the ~300ms VPlay teardown is still not found**, but the search
space has narrowed a lot, and one previously-only-suspected finding (from a `call.c` comment
written earlier this same overnight session, before compaction, referencing "tonight's
disassembly") is now independently re-confirmed with solid ground truth rather than recollection.

**Dead ends, now conclusively ruled out** (each traced to a real decompiled function, not inferred):

1. **`ManagedClonkPipeline` as a `ClonkChangeListener`** (the Part 23/24 lead). It does inherit
   `ClonkChangeListener` as a second base (confirmed via RTTI: base1 = `media::ClonkChangeListener`
   at `this+8`), and overrides exactly 4 of its ~44 callbacks — `videoCaptureHasPipelineChanged`,
   `videoPlayerHasPipelineChanged`, `audioCaptureHasPipelineChanged`, `audioPlayerHasPipelineChanged`
   — but **all four overrides are byte-identical** (`ldr r3,[r0]; call [r3+0x84]`) and that shared
   target slot resolves back to one of the four themselves, meaning this code is either dead or
   depends on further derivation that doesn't exist in this binary. Not the trigger, and not even
   clearly live code. It does **not** override `videoPlayerActiveChanged` (the property our actual
   teardown-adjacent `setVideoPlayerActive(false)` bookkeeping call touches) at all.
2. **`ManagedClonkPipeline::suspend()`/`pause()`/`configureArbitration()`** — real, meaningful
   OS-level resource-arbitration logic (confirmed by decompile: checks
   `getVideoPlayerHasPipeline()`/`getVideoCaptureHasPipeline()` via the real `ClonkState` vtable,
   logs `"Suspending video (playback/capture) due to arb request"`), but **zero direct callers
   exist anywhere in this binary** for `pause()`/`suspend()`/`configureArbitration()` — they're
   only reachable via `AbstractManagedMediaResource`'s own external interface, i.e. driven by
   mediaserver's OS-level resource arbiter reacting to real hardware contention (another app
   wanting the camera, power events, etc.), which our synthetic single-process test never
   triggers. Plausible in a real call under real contention; not applicable to our test.
3. **`ClonkSession::handleEventCB`'s per-event `Watchdog`** — real, confirmed (every popped
   `ClonkHostEvent` gets wrapped in a `media::util::Watchdog(name, 15000)` while
   `processHostEvent` runs) but the timeout is **15000ms**, two orders of magnitude too slow to
   explain a ~300ms teardown. Just a hang-safety-net, not our mechanism.
4. **`ClonkPipeline::monitorVPlayDecSrcCB`** — a one-shot `GstPad` buffer probe on the decoder's
   source pad that logs `"Saw first frame after %llu uS"` (success if <500ms) and then
   self-removes. Purely diagnostic — computes and logs but takes no corrective action either way.
   Also **would never fire at all** in our test, since (per Part 22) the decoder never produces a
   single output buffer with our synthetic repeated-IDR data — so it's an inert bystander here.
5. **Every teardown-capable `ClonkPipeline` method** (`stopVPlayPipeline`, `teardownVPlayPipeline`,
   `ClonkPipeline::teardown()`, and the shared `teardownPipeline()` helper they all funnel into) —
   confirmed via full-binary `objdump` search that **none of them have a single direct (`bl`)
   caller anywhere in the binary**. They are only reachable through virtual dispatch on a
   `shared_ptr<ClonkPipeline>`, which in practice means only `ClonkSession::processHostEvent`
   (itself only reachable by an event actually being queued via `ClonkSession::postEvent`, which
   is *also* only virtually dispatched — likely through the `ClonkHostListener` interface that the
   LS2 method handlers use). This significantly narrows the search: the trigger is not some
   free-floating internal timer or listener callback discovered so far — it has to be a genuinely
   posted `ClonkHostEvent`, from somewhere.

**New, ground-truth-confirmed anomaly (not newly discovered — re-verified from a same-session,
pre-compaction `call.c` comment referencing "tonight's disassembly" and "the native
busMsg_STATE_CHANGED bug"):** decompiled `ClonkSession::videoPlayerStart(ulong,ulong)` directly and
confirmed byte-for-byte it constructs `ClonkHostEvent(type=7)` — so "event type 7 = videoPlayerStart"
is solid, not a guess. Then re-read `processHostEvent`'s case 7 (`mp_processevent.txt` line
199-240) against the now-fully-ground-truthed `gst::ClonkPipeline` vtable (Part 22's dump): case 7
calls `ClonkSession::getVideoBitrate()` (offset `0x80` on `ClonkSession`'s own vtable) twice as a
gate, and if it's non-zero, in addition to building/pushing a `VideoSettings` object, it also
calls **vtable slot `0x28`, which is `startVCapturePipeline`, not `startVPlayPipeline` (`0x30`)** —
confirmed via the same ground-truth vtable dump used for the two already-fixed and deployed bugs.
**This is very likely gated off in our synthetic test** (we never call `videoCaptureStart`, so
`getVideoBitrate()` almost certainly reads 0/unset and this branch never executes) — but in a
*real* call, where `videoCaptureStart` runs first and does set a real bitrate, `videoPlayerStart`
would, as an apparent side effect, **also (re-)start the capture pipeline** — a real, currently
unexplained oddity worth its own investigation, separate from (and probably not the cause of) the
test-harness-visible ~300ms teardown, but flagged here since it's now independently confirmed
rather than just carried forward as a recollection.

**Assessment**: five real hypotheses tested and eliminated with concrete evidence; the actual
`gst_element_set_state(clonk_video_play, NULL)` caller is now known to be reachable only through
`ClonkSession::processHostEvent`, meaning something is constructing and posting a
`videoPlayerStop`-or-equivalent `ClonkHostEvent` ~300ms after `videoPlayerStart`, from inside this
same process, without any LS2 call from `call.c` telling it to (confirmed no such call exists in
the harness's timeline). Where that post would come from remains unfound after this session's
effort. Given the breadth of internal candidates now ruled out, the two next-most-likely
remaining explanations are: (a) something in `ClonkSession`'s own C++ logic auto-posts a
stop/restart event synchronously as a side effect of some other call (worth grep'ing
`postEvent`'s few dozen construction sites — every `ClonkSession::videoXXXStart/Stop` method looked
at this session builds and posts its own event inline, so there may be a similar unexamined method
that fires automatically), or (b) it is in fact a consequence of the test harness's synthetic data
specifically (single repeated static IDR, no real RTP timing) rather than a discoverable "trigger
function" at all — consistent with Part 22's decoder-never-outputs-a-frame finding — in which case
no amount of further RE will find a dedicated trigger because the real mechanism is a downstream
consequence of malformed/unrealistic input, not a bug with a single call site.

Device state unchanged from Part 24 (clean two-patch build, md5 `c92458a3c20a06876d6f25f61c5ff3b8`,
original upstart config, `mediaserver` running normally, confirmed post-investigation).

## Part 26: False alarm — "device-state incident" was actually a second TOPAZ device

**Correction to the original Part 26** (written earlier in this same session): the apparent
unpatched-binary/reset-config/missing-`imdaemon.sh` scare was **not** a real device-state
anomaly. There are two `topaz-linux` devices reachable via `novacom` on this network
(`f3bf93d992db42d3d8f021e58e4bfc83cf5d1556`, the real target used all session, and a second,
unrelated one, `0192530b6bc9f9496323c58995da96acab1bf3fe`, which reconnected partway through this
session). `novacom` without an explicit `-d <nduid>` picks a default device that can silently
change when a second device is present/reconnects, and a run of checks this session ended up
hitting the *other* TouchPad — which of course has none of this project's patches, custom scripts,
or WhatsApp account configured, exactly matching every symptom originally attributed to a mystery
reset. Re-checked explicitly against `-d f3bf93d992db42d3d8f021e58e4bfc83cf5d1556` and confirmed
everything was fine the entire time: `media-pipeline.real` still `c92458a3c20a06876d6f25f61c5ff3b8`,
`/etc/event.d/mediaserver` still the Part 22-restored version with `GST_DEBUG` set,
`imlibpurpletransport` (pid 1697) had been running continuously and healthily for the whole
session (never actually needed any of the kill/relaunch cycles performed against the wrong
device), and `testInjectVideo` immediately worked and spawned a fresh `media-pipeline.real` child.

**Lesson for every future session on this device**: always pass `novacom -d
f3bf93d992db42d3d8f021e58e4bfc83cf5d1556 ...` explicitly (or `-d` whichever nduid is confirmed via
`novacom -l` at session start) rather than relying on the default-device selection, whenever more
than one `topaz-linux` device might be connected.

## Part 27: Decisive result — the decoder never outputs a frame, confirmed over 35s, cleanly

Continued pushing on the teardown trigger per the user's explicit direction. Two infrastructure
fixes made this possible that are worth keeping for future sessions:

1. **`novacom run <cmd> > localfile` corrupts large output with NULL-byte padding.** This was the
   real explanation for a lot of "empty log" confusion this session (not a real device issue).
   The reliable pattern: gzip the file **on-device** first, then `novacom -d <nduid> get
   file:///path/to.gz > local.gz` (matches how the earlier `libmedia-api.so` pull worked cleanly).
   `/media/internal/gst_debug_child.log` itself also has a large leading run of real NUL bytes
   (pre-allocation artifact, not a transport bug) — skip to the first non-NUL byte before treating
   it as text.
2. **A stray, still-ticking `g_timeout_add` from a much earlier test invocation** (hours old, from
   a `delayMs=0 intervalMs=200` call) had been masking whether fresh `testInjectVideo` calls were
   landing at all — `imstdout.log` kept showing old skypekit "sending access unit" traffic that
   looked current but wasn't. A full device reboot (confirmed via `/proc/uptime`, not just a
   process restart) was needed to get a trustworthy, fully clean baseline.

With a genuinely clean boot and the reliable gzip-based log pull, captured the **complete, real**
first-ever `videoPlayerStart` sequence for the first time this whole investigation:
`initializeVCapturePipeline` at t=2.33s → `initializeVPlayPipeline` at t=3.93s (clonkvhsrc,
clonk_vplay_h264dec, palmvideosink1 all built and linked correctly) → decoder reaches
`GST_STATE_CHANGE_PAUSED_TO_PLAYING` at t=3.97s → **silent** teardown starts (`PLAYING to PAUSED`
on `clonk_vplay_h264dec`) at t=6.50s, ~2.5s later this run (consistent with Part 22's already-
documented 60ms-600ms+ run-to-run variance, just landing at the higher end here). Critically:
**nothing at all logs on the `clonk` category between the last routine `handleThrottleCB` tick
and the teardown** — confirming (independently of the static analysis) that whatever calls
`gst_element_set_state(..., NULL)` doesn't log anything itself, consistent with `stopVPlayPipeline`
specifically (confirmed by decompile to contain zero `gst_debug_log` calls) but not conclusively
identifying it over `teardownVPlayPipeline`/`ClonkPipeline::teardown()`, which are equally silent.

**This same clean capture also directly contradicts Part 25's `processHostEvent` case 7/8 reading**
(that videoPlayerStart's handler calls `startVCapturePipeline` instead of `startVPlayPipeline`) —
empirically, `initializeVPlayPipeline`/the VPlay pipeline demonstrably **does** get built and reach
PLAYING correctly on every run. That decompiled reading is now considered unreliable and should
not be trusted for this specific function — Ghidra's decompiler was very likely misrepresenting
the true control flow of `processHostEvent`'s heavily boost::shared_ptr-laden switch statement.
The `audioCaptureStart`/`Stop` ↔ `startVPlayPipeline`/`stopVPlayPipeline` type-11/12 dead-code
finding from Part 25 (those event types are never constructed by any code in the binary) still
stands as independently verified (constructor + vtable ground truth), but its relevance is now
unclear given the case 7/8 reading it was cross-checked against turned out to be unreliable.

**The decisive experiment**: redeployed the earlier session's experimental "no-op
`stopVPlayPipeline`/`teardownVPlayPipeline`" patch (md5 `e61588a512f0a270fdec1639adf96e60`,
Part 22) on a freshly-rebooted device, and let a `testInjectVideo` run for a full **35 seconds**
uninterrupted (vs. Part 22's shorter ~100s-but-less-rigorously-captured original check). Result,
unambiguous: the pipeline reaches `PAUSED_TO_PLAYING` exactly once and **never reverses** for the
entire 35s (teardown fully suppressed, confirming the patch works as intended) — but
`palm_videosink_render` was called **zero times** the entire run, and
`palm_videodecoder_src_task` logs `"waiting for buffer"` once, immediately after entering
PLAYING, and never logs anything else for the rest of the capture. **The hardware H.264 decoder
never produces a single output frame, no matter how long it's given**, when fed our test harness's
repeated single static IDR access unit with no advancing timestamps and no P-frames.

**Conclusion**: this strongly supports Part 22's original hypothesis over any of the native-bug
theories chased in Parts 24-26. The most likely explanation for the whole "~300ms-2.5s teardown"
phenomenon is a **legitimate protective/cleanup mechanism** (still not pinpointed to an exact call
site, and per the above it may not even matter which specific function it is) reacting correctly
to a pipeline that is genuinely stuck — not an independent platform bug requiring more
reverse-engineering. A real WhatsApp call's continuous, properly-encoded, properly-timestamped
H.264 stream is very plausibly not affected by this at all. **Recommendation: stop pursuing this
via further static/synthetic analysis — a real live call is now clearly the correct next step**,
and is very likely to just work given the two confirmed-real fixes (Part 22) plus this session's
finding that the teardown is most plausibly a test-harness artifact, not a third platform bug.

**Device state at end of session**: reverted from the experimental no-op-teardown build back to
the confirmed production two-patch build (md5 `c92458a3c20a06876d6f25f61c5ff3b8`), `mediaserver`
cleanly restarted and verified running, upstart config confirmed intact (including the `GST_DEBUG`
verbosity settings — those persisted across this session's reboots after all). Confirmed **two**
`topaz-linux` devices exist on this network; this session's real target is
`f3bf93d992db42d3d8f021e58e4bfc83cf5d1556` — always pass `-d` explicitly in future sessions.

## Part 28: Built the real-stream test harness — and found the actual blocker

At the user's request, built Task #32: a real, 240-frame, properly-timed multi-frame H.264 test
injection harness, replacing the single-repeated-static-IDR one used through Part 27.

**Implementation**: `received.h264` (the already-validated real captured stream from Part 1) sliced
by the exact per-frame byte sizes in its companion `diag/callee/video.jsonl` (240 frames, sizes and
`ts_ms` verified to sum/align perfectly, every slice starts on a real Annex-B start code — 232
P-frames + 7 IDRs + 1 combined SPS/PPS/IDR first frame). Generated
`glue/test_stream_data.h` (one flat byte array + parallel offset/size/inter-frame-delta-ms arrays)
and added a second injection path in `call.c` (`test_inject_stream_tick`, gated by a new
`realStream` param on the existing `testInjectVideo` LS2 method) that self-reschedules each frame
with its *real* recorded delta instead of a fixed interval, looping back to frame 0 at the end.
Rebuilt via `build-combined.sh` (clean build, no errors) and deployed the new `libwhatsmeow.so` to
`.../com.palm.app.teams/backend/lib/purple-2/libwhatsmeow.so` (the actual on-device path,
discovered via `/proc/<imlibpurpletransport-pid>/maps` — the wa-call plugin is hosted inside the
Teams app bundle despite the name). Note for future sessions: `json_str()` in `call.c` only accepts
**quoted** JSON string values (`"realStream":"1"`, not `"realStream":true` or `:1` unquoted) —
sent the wrong format on the first few attempts and got silent no-ops with `realStream=0` in the
logs before catching it.

**Result — decisive, and different from what Part 27 predicted.** With the confirmed two-patch
production build, the real-stream data made no difference: teardown still happens, now observed
consistently in the **14-40ms range** (two independent fresh-session runs) rather than Part 27's
2.5s outlier — meaning the real teardown timing floor is *faster* than any previous single test
suggested, fast enough that it happens **before the test harness's `delayMs` wait has even
elapsed**, i.e. before a single real (or fake) frame has been injected at all. This by itself
already shows the teardown is not reacting to *frame content* — nothing has arrived yet when it
fires.

**Then, decisively: redeployed the no-op-teardown patch (Part 22/27, md5
`e61588a512f0a270fdec1639adf96e60`) together with the new real-stream-capable plugin, and ran a
full 40-second capture.** Teardown stayed suppressed as expected (single `PAUSED_TO_PLAYING`, no
reversal). But `clonk_vplay_h264dec`'s `palm_videodecoder_src_task` still only logs `"waiting for
buffer"` **once**, immediately after entering PLAYING, and never anything else — **zero decoded
frames over 40 seconds, with real, valid, correctly-timed H.264 data being actively sent the whole
time.** This conclusively **refutes** Part 22/27's "synthetic test data" hypothesis: the decoder
doesn't fail to produce output because our test data is unrealistic. It fails regardless.

**Traced further and found where the real disconnect is**: confirmed via the plugin's own stderr
(`imstdout.log`) that skypekit Thread B is genuinely, actively sending correctly-sized access units
the whole time (`"skypekit thread B sending access unit (562 bytes)"`, `(4317 bytes)`, `(233
bytes)`, etc. — real, varying sizes matching the injected stream, not the old fixed 562-byte
repeat). But on the receiving side, `gst_debug_child.log` shows **zero** push/chain/buffer activity
on `clonk_vplay_h264dec:sink` for the entire 40 seconds — the pad gets activated
(`gst_pad_activate_push`) and then nothing. **Data is being sent correctly by the client side and
never arrives at the decoder's input inside `media-pipeline.real`.** The last thing logged before
this silence is the already-long-flagged `gst_skype_video_src_change_state:<clonkvhsrc> "resolution
not set on capsfilter"` WARN — previously dismissed in earlier parts of this investigation as
benign (per the referenced Part 11/12 conclusion), but given this session's direct evidence that
literally nothing gets through afterward, that dismissal should be treated as **unconfirmed, not
settled** — it's the most concrete remaining lead for why the decoder never receives anything.

**Where this leaves the investigation**: the real, currently-most-likely-correct picture is
different from every theory chased in Parts 22-27. It is not (solely) about the teardown timing, and
not about test data realism. The actual blocker is that `clonkvhsrc` — the GStreamer source element
inside `media-pipeline.real` that's supposed to receive frames arriving over the SkypeKit Thread B
socket bridge and inject them into the decode pipeline — never delivers anything to its downstream
peer, even though the client side is confirmed actively writing real data to that socket the whole
time. **Next session should start here**: decompile `gstskypevideosrc.c`'s buffer-producing/socket-
reading logic (not yet done this whole investigation — all prior Ghidra work targeted
`ClonkPipeline`/`ClonkSession`/`ClonkState`, never the `libpalmgstskype.so` plugin that actually
implements `clonkvhsrc` itself) and specifically resolve whether "resolution not set on capsfilter"
is truly non-fatal to data flow or is in fact silently blocking it via failed caps negotiation.

**Device/build state at end of session**: `glue/test_stream_data.h` and the `call.c` real-stream
harness are committed to the working tree (not reverted — this is real, reusable test
infrastructure, not a throwaway experiment). The **experimental no-op-teardown**
`media-pipeline.real` (md5 `e61588a512f0a270fdec1639adf96e60`) is what's currently deployed on
device — **this must be reverted to the production two-patch build (md5
`c92458a3c20a06876d6f25f61c5ff3b8`, available locally as `media-pipeline.real.patched2.gz`) before
any real call is attempted**, since the no-op patch disables real hangup/teardown cleanup. The new
`libwhatsmeow.so` (md5 `604f9af666c5ccaef0b1723b167f3197`) is deployed and is safe to leave in
place — it only adds a new opt-in test path, `testInjectVideo`'s default (`realStream` omitted)
behavior is unchanged from Part 22-27.

## Part 29: Found and patched a third real platform bug — width/height never set on clonkvhsrc

Pulled and fully decompiled `/usr/lib/gstreamer-0.10/libpalmgstskype.so` (never analyzed before
this session — all prior Ghidra work targeted `media-pipeline.real` only). It's unstripped with
full C++ symbols, which made mapping the whole `clonkvhsrc` (`gst_skype_video_src`) internals
tractable in one sitting.

**Architecture, confirmed via decompile**: `clonkvhsrc` is itself a mini-bin wrapping three real
sub-elements — an internal `gst_skype_rtp_src` (a custom `GstBaseSrc` with its own blocking
producer/consumer queue: `gst_skype_rtp_src_write()` enqueues + signals a `GCond`,
`gst_skype_rtp_src_create()` waits on that same `GCond` and pops), a depayloader, and a
**capsfilter**, linked in that order and ghosted out as `clonkvhsrc`'s single src pad.
`gst_skype_video_rtp_submit()` (the function that ultimately receives incoming access units) does
some optional pcap-file debug-dumping, then just calls `gst_skype_rtp_src_write()` — confirmed via
decompile it has **no dependency on caps or resolution at all**, so the producer/consumer queue
pairing itself is sound. Also mapped, and ruled out as relevant here: `clonkvhsrc`'s
`change_state()` spawns a *separate*, independent thread running `gst_skype_video_src_in_loop`,
which reads a local pcap-format file (`fopen` on the element's `"location"` property, magic bytes
`0xa1b2c3d4`/`0xd4c3b2a1` checked) and replays it — apparently a genuine alternate operating mode
for this element family (`gst_h264_file_src` also exists in `plugin_init`'s registration list), but
irrelevant to our RPC-fed path, and confirmed **not** where `GstSkypeInstance::RunVideoHost` gets
started (traced the actual thread-entry pointer via Ghidra's own resolved references — it's
`gst_skype_video_src_in_loop`, not `RunVideoHost`/`S_threadVideo`). Could not fully pin down what
*does* start `RunVideoHost` (zero direct callers found in either `media-pipeline.real` or
`libpalmgstskype.so` itself — plausibly a lazy-init path triggered by the audio elements, not
chased further), but per Part 17's already-existing, live-tested documentation it demonstrably does
run and does accept Thread B's connection, so this remains a loose end rather than a blocker.

**The actual bug**: `gst_skype_video_src_change_state()`'s `READY→PAUSED` handler checks two
**global** (not per-instance) width/height variables before configuring the real caps on the
capsfilter — `if (width < 1 || height < 1) { WARN("resolution not set on capsfilter"); }` else
`g_object_set(capsfilter, "caps", <real 320x240 caps>, NULL)`. This is the exact, literal source of
the long-standing `gstskypevideosrc.c:411 "resolution not set on capsfilter"` warning that earlier
parts of this investigation (Part 11/12, an earlier session) had dismissed as benign. It isn't:
`gst_skype_video_src_set_width(int)` / `set_height(int)` are real, exported, directly-callable C
functions in this library whose entire job is to set those two globals — **and grepping both
`media-pipeline.real` and `libpalmgstskype.so` itself for any caller of either function turns up
zero** (confirmed via `nm -D` undefined-symbol search and Ghidra cross-reference search). Nothing,
anywhere in this build, ever calls them. The globals sit at their BSS zero default forever, the
`< 1` check always fires, and the capsfilter's caps are never configured for the real 320×240
stream — a genuine, previously-unknown gap, structurally identical in spirit to Part 22's
`setDisplayFull()`-missing-`setDisplayEnable()` bug, just one library over.

**First patch attempt crashed the device — root-caused and fixed with a safer, cave-free patch
instead.** The original plan (ARM trampoline in `gst_skype_video_src_init`, repurposing
`gst_h264_file_src_unlock_stop`'s machine code as a cave) deployed cleanly but **crashed
`media-pipeline.real` with SIGSEGV** on the very first real test (confirmed via `dmesg`:
`minicore_launch: CRASH! media-pipeline.(5334) received 11`; no fresh minicore dump was actually
saved to `/media/internal/cores/` to inspect, only stale ones from `Jul 26`, so the exact faulting
instruction was never directly observed). Root cause was never proven but is almost certainly that
`gst_h264_file_src_unlock_stop`'s address is a real `GstBaseSrcClass` vtable slot for the
`gst_h264_file_src` element type — even though `ClonkPipeline.cpp` never instantiates that element
by name, GStreamer 0.10's registry-scanning machinery can transiently instantiate every registered
type to introspect it, which would call into the repurposed cave with a **completely wrong "this"
pointer type** (a `GstH264FileSrc*`, not `GstSkypeVideoSrc*`), corrupting memory when the trampoline
tried to jump back into `gst_skype_video_src_init`'s body using that wrong instance. Unlike Part 22's
`setDisplayAngle` cave (verified fully dead via a real vtable dump with zero references, in
`media-pipeline.real`), this session never did the equivalent rigorous check for
`libpalmgstskype.so` — a real process error, not just bad luck.

**The actual, deployed fix is simpler and doesn't need a cave at all.** Decompiling
`gst_skype_video_src_change_state` directly showed that the two register values used in the
width/height check (`r3`/`ip`) flow **completely unmodified** from the check straight through to
`gst_caps_new_simple()`'s actual argument setup a few dozen instructions later — nothing reloads
them from memory in between. That means the two 4-byte `ldr` instructions that read the (always-
zero) global width/height at the point of the check can simply be replaced in-place with
`movw r3, #320` / `movw ip, #240` — same instruction size, no branch, no cave, no external function
call, entirely self-contained within a function that's unambiguously real, instance-correct code
(it's called through `clonkvhsrc`'s own concrete, definitely-instantiated element). Verified via
`objdump` re-disassembly: the `ble` branches that used to skip real caps-setting are now permanently
dead (320 and 240 are always `> 0`), and the real `gst_caps_new_simple(..., 320, ..., 240, ...)` call
now always executes. **Deployed and confirmed via live test: the "resolution not set on capsfilter"
warning is completely gone** (zero occurrences in a fresh capture, vs. appearing on every single
previous run this entire investigation) — this part of the fix is real and working. md5 of the
deployed `libpalmgstskype.so`: `8a07e9de65fc9980047bc5668d8016cc`.

**But this fix alone is not suffient — re-ran the Part 27 decisive experiment (no-op-teardown
patch + this fix + the real 240-frame stream, 40 second capture) and the result is unchanged from
Part 27: zero decoded frames, zero calls to `palm_videodecoder_chain` (the decoder's own input
handler) for the entire 40 seconds**, even though the pipeline reaches `PLAYING` and stays there
(teardown confirmed suppressed) and the caps are now genuinely correct. Traced further this
session than ever before: confirmed via the plugin's own stderr that skypekit Thread B is still
actively sending real access units the whole time, and confirmed via `gst_debug_child.log` that
`clonk_vplay_h264dec:sink`'s pad gets activated but its `chain` function is **never once invoked**
— meaning data still never crosses from `clonkvhsrc`'s internal producer/consumer queue out to the
decoder, independent of caps/resolution entirely. The width/height bug was real, and the fix is
real and safely deployed, but it is not "the" bug that's been driving Parts 22-29 — there is at
least one more disconnect somewhere between `gst_skype_video_rtp_submit()` successfully being
called (assumed, not directly confirmed) and `gst_skype_rtp_src_create()` actually producing a
buffer for the depayloader/capsfilter/decoder chain to consume.

**Also traced, and explicitly left unresolved**: neither `GstSkypeInstance::RunVideoHost()` nor
`VideoHost::SetCallback()` (the method that would register the callback `RtpPacketReceived`
ultimately needs to reach `gst_skype_video_rtp_submit`) have **any** real function-level caller
anywhere in `media-pipeline.real` or `libpalmgstskype.so` itself (checked via `nm -D` and Ghidra
cross-reference search both times) — only ambiguous "unknown @ address" references that are most
likely vtable/GOT data entries, not call sites. Thread B's connection to
`/tmp/vidrtp_from_skypekit_key` does empirically succeed (confirmed via the plugin's own log,
consistent with the already-existing, live-tested Part 17 finding from an earlier session), so
*something* is listening and accepting — but this session was unable to find where that something
gets bootstrapped, or definitively confirm it dispatches into the specific, active
`GstSkypeVideoSrc` instance backing our real pipeline rather than some other, disconnected one.
**This is the most concrete remaining lead**: find what actually starts `RunVideoHost` (candidates
not yet checked: whether it's triggered lazily from within the audio elements' own init/start paths,
or from a constructor/`__attribute__((constructor))`-style static initializer this session's
`.init_array`/`plugin_init` check didn't cover in enough depth), and from there trace whether its
`ProcessCall` dispatch really reaches the correct, live `gst_skype_video_rtp_submit` target.

**Device state at end of session**: production two-patch `media-pipeline.real` (md5
`c92458a3c20a06876d6f25f61c5ff3b8`) redeployed, confirmed running cleanly.
The width/height fix in `libpalmgstskype.so` (md5 `8a07e9de65fc9980047bc5668d8016cc`) is left
deployed — it's safe (no crashes across multiple subsequent tests), it's a genuine improvement
(eliminates a real, confirmed warning and sets real caps), and reverting it buys nothing since the
underlying blocker is elsewhere. The experimental no-op-teardown `media-pipeline.real` build was
used only for the one decisive test and is **not** what's currently deployed.

## Part 30 — found and fully mapped the RunVideoHost bootstrap and RPC dispatch chain; a plausible fix tried and empirically ruled out

Picked up the exact open thread from Part 29: "find what actually starts `RunVideoHost`."
Decompiled `GstSkypeInstance`'s two constructors (nm `0x28660`/`0x28790`) and found the answer:
the constructor unconditionally does `AudioHost::AudioHost()` + `VideoHost::VideoHost()` +
**two** `g_thread_create_full()` calls (matching `S_threadAudio`/`S_threadVideo`) every time the
lazy singleton (`GstSkypeInstance::getInstance()`) is first constructed by *anything* — so
`RunVideoHost` starts as a side effect of whichever element (audio or video) happens to call
`getInstance()` first. This resolves the open question cleanly: there is no video-specific bootstrap
to find because the singleton's constructor always spins up both hosts together.

**Fully decompiled `RunVideoHost()` (nm `0x29bc0`) and traced the real dispatch chain**, correcting
Part 29's tentative reading:
- It builds a `Sid::AVServer`/`BinServer` (listens on the `/tmp/vidrtp_from_skypekit_key` transport
  key found via `strings`) and, critically, sets `this_00[+0xa0] = videoHostPtr` — i.e. it registers
  the `VideoHost` instance itself (not the separate `BinClient` stub built alongside it) as the
  callback object for its own RPC server.
- `Sid::SkypeVideoRTPInterfaceServer::ProcessCall`'s case `0x14` (`kRtpPacketReceivedCmdId`)
  dispatches through vtable slot `0x60` on that registered `this+0xa0` object — landing on
  `VideoHost::RtpPacketReceived(SEBinary const&)` (nm `0x382c4`), confirmed via decompile to call
  `gst_skype_video_rtp_submit(data, size, 1)` directly and unconditionally. The separate
  `Sid::SkypeVideoRTPInterfaceCbClient::SendFrame`/`SendRTPPacket` methods found in Part 29 turned
  out to be for a different, outgoing-relay leg (`this_01`/`AVTransportWrapper`, connected via
  `Sid::AVTransportWrapper::Connect`), not the receive path — a wrong turn corrected this session.
- `gst_skype_video_rtp_submit` (nm `0x2115c`) resolves its target purely via a **global**, mutex-
  guarded pointer (no element parameter) — confirmed via raw disassembly (not just decompiler text)
  the true address is nm/runtime-relative `0x64ca4` in `.data`. If that global is `0`, the function
  just logs a debug message and returns — a fully silent no-op, no crash, matching the exact
  observed symptom perfectly.
- Found who writes that global: `gst_skype_video_src_change_state` (nm `0x2234c`, the same function
  patched in Part 29 for the width/height bug) sets it unconditionally on READY→PAUSED
  (`*(elem_ptr) = this`) and **clears it back to 0 on PAUSED→READY**, but only if it still equals
  `this` (`if (registered == this) registered = 0`) — confirmed via Ghidra reference search
  (`streq lr,[r8,#0xc]` at nm `0x224c4`) and byte-verified (`0x0588e00c`).

**Hypothesis tested**: combined with Part 22/27/28's already-documented internal auto-stop/teardown
behavior, a plausible full explanation was that the video-src element's own state briefly cycles
back through READY (independent of `ClonkPipeline`'s own `stopVPlayPipeline`/`teardownVPlayPipeline`,
which live in a different binary and were already shown in Part 28 not to be the full story),
clearing this registration before/during real RTP arrival — explaining silent packet loss with no
crash, exactly matching every symptom collected since Part 22.

**Patched and tested directly**: NOP'd the conditional clear (`streq` → unconditional NOP,
`0x0588e00c` → `0xe320f000`) on top of the confirmed caps-fix build (new md5
`a2b64d11ad572118f88da889f327b2ff`), deployed, fresh `mediaserver` restart, and ran the Part 28
real-stream harness (`luna-send palm://com.palm.whatsapp.call/testInjectVideo
'{"delayMs":"500","realStream":"1"}'`, confirmed via `imstdout.log` that Thread B sent real,
correctly-varying-size access units the entire run). **Result: no change.**
`clonk_vplay_h264dec` logged exactly one `PAUSED_TO_PLAYING` and one `"waiting for buffer"`
(`PalmOmxVideoDecoder.c:654`), then total silence for the whole capture — `palm_videodecoder_chain`
never fires, identical to every prior run. Notably, in this run the outer `ClonkPipeline` teardown
(Part 22/27/28's "~300ms auto-stop") **did not even occur** — the decoder's own state never reversed
— yet the outcome was unchanged, which on its own already weakens the teardown-timing theory as
the primary blocker for this specific "never receives a single buffer" symptom (as opposed to a
possible separate, real-call-only issue).

**Patch reverted** (not kept): beyond not helping, it introduces a real latent risk on its own
merits — a stale registration surviving element teardown means a later, in-flight
`gst_skype_video_rtp_submit` call could dereference a freed `GstSkypeRtpSrc` after its owning
bin is destroyed (a genuine use-after-free), which is almost certainly *why* the original code
clears the pointer on PAUSED→READY in the first place. Device restored to the known-good state:
`libpalmgstskype.so` back to `8a07e9de65fc9980047bc5668d8016cc` (caps fix only),
`media-pipeline.real` unchanged at `c92458a3c20a06876d6f25f61c5ff3b8`, `mediaserver` freshly
restarted and confirmed healthy.

**Where this leaves the investigation**: the entire RPC path from Thread B's socket connection
down through `ProcessCall` → `VideoHost::RtpPacketReceived` → `gst_skype_video_rtp_submit` →
`gst_skype_rtp_src_write` is now fully mapped and structurally verified correct by decompile, and
the one concrete stateful hypothesis for silent packet loss at that boundary (the registration
global) has been directly tested and ruled out as the (sole) cause. The blocker is still somewhere
between a successful `gst_skype_rtp_src_write()` (enqueue) and `gst_skype_rtp_src_create()`
(dequeue) actually producing output the depayloader/capsfilter/decoder chain receives — or,
alternatively, the registration global genuinely never gets set at all for reasons not yet found
(worth checking directly next time: live-read the actual value of the global at runtime rather than
inferring it from behavior — this session's attempt via `gdbserver`/`gdb-multiarch` hit the same
"'g' packet reply is too long" register-description mismatch history has run into before with this
old `gdbserver` build talking to a modern `gdb-multiarch`; unlike Part 6's version this was a hard
error, not just a warning, and wasn't worked around this session. Also worth checking next: whether
`gst_skype_rtp_src`'s own pad ever activates its push-mode task at all (only `clonkvhsrc`'s pad
*linking* was confirmed in the debug log this session, not its task/activation), and whether the
internal depayloader element between `gst_skype_rtp_src` and the capsfilter is configured/receiving
correctly.

## Part 31 — confirmed the internal pad task DOES activate; found and fixed two real logging-visibility bugs; the RTP-delivery gap is now a clean, reproducible dead end pointing at the RPC layer itself

Directly answered Part 30's open question: does the depayloader/rtp-src pad task ever activate?
**Yes.** A clean debug capture shows `rtp:src`, `depay:src`/`depay:sink`, and `filter:src`/`filter:sink`
all activating in push mode right on schedule (~t+1.34s into `initializeVPlayPipeline`), via generic
`GST_PADS`-category tracing (`gst_pad_start_task`, `activated in push mode`) — independent of the
plugin's own "skypevideosrc" debug category. The internal chain's plumbing is healthy.

**Found two real logging-visibility bugs while chasing this, both fixed for future sessions:**
1. `gst_pad_push`/`chain()`-level buffer traffic logs at `LOG`/`TRACE`, above the `GST_PADS:6` ceiling
   the shipped `/etc/event.d/mediaserver` used — meaning **every prior session's "chain never fires"
   conclusion was drawn from a verbosity level that couldn't have shown it either way.** Bumped to
   `GST_PADS:7` (and added `skypevideosrc:7`/`skypekit:7`/`rtph264depay:7`/`rtpbasedepayload:7`,
   `palmvideodecoder:7`) — this revealed the plugin's own category is literally named `skypevideosrc`
   (source file prefix `gstskypevideosrc.c`/`gstskypertpsrc.c`), confirmed via a real debug line:
   `gstskypertpsrc.c:286:gst_skype_rtp_src_create:<rtp> waiting for buffers` — the internal queue
   consumer genuinely is running and genuinely is blocked (queue empty), not a logging artifact.
2. `RunVideoHost`/`VideoHost`/`ProcessCall`/`RtpPacketReceived` (the C++ RPC bridge layer, decompiled
   in Part 30) use GLib's `g_log(NULL, G_LOG_LEVEL_DEBUG, ...)`, **not** `gst_debug_log()` — a
   completely different logging path that never touches `GST_DEBUG_FILE` at all. GLib's default
   handler silently drops `G_LOG_LEVEL_DEBUG`/`INFO` messages unless `G_MESSAGES_DEBUG` is set, and
   it was **not set anywhere in this device's config, likely for this entire multi-week
   investigation** — meaning this whole RPC layer has been completely dark to every previous
   session's log-based analysis. Added `env G_MESSAGES_DEBUG=all` to `/etc/event.d/mediaserver`.

**Result after both fixes, on a genuinely clean full reboot (confirmed via `/proc/uptime`), with a
single isolated `testInjectVideo` (`realStream=1`) run, no process killed mid-run**: `clonkvhsrc`
builds correctly (`initializeVPlayPipeline` ×5, `clonkvhsrc` ×19), the internal `rtp`/`depay`/`filter`
chain activates and blocks on `gst_skype_rtp_src_create`'s "waiting for buffers" — and, confirmed via
`imstdout.log`, Thread B is actively sending real, correctly-varying-size access units the entire
time. Yet **`RtpPacketReceived`, `gst_skype_video_rtp_submit`, and `gst_skype_rtp_src_write` show
zero occurrences** in the bumped `GST_PADS`/`skypevideosrc` trace, and `mediaserver_flicker_debug.log`
(where `g_log` output should land per `/proc/<pid>/fd` — confirmed fd 1/2 both point there) stayed at
**0 bytes** throughout, even with `G_MESSAGES_DEBUG=all` active. This is no longer a visibility
question — with both known logging gaps closed, the RPC delivery chain genuinely produces no
observable trace of ever running, while everything upstream (Thread B send) and downstream (internal
queue consumer) is confirmed alive and healthy.

**Tested and ruled out this session**: a "stale Thread B connection" hypothesis (Thread B, living
inside the long-running `imlibpurpletransport` process, connects once to
`/tmp/vidrtp_from_skypekit_key` and might never reconnect across `media-pipeline.real` restarts,
sending into an orphaned socket while a fresh `RunVideoHost` waits for a new client) — tested by
force-restarting `imlibpurpletransport` itself before retesting; made no difference to the outcome.

**Remaining open possibilities, next session should start here**: (a) the 0-byte flicker log could
still be a genuine libc stdio full-buffering artifact specific to a long-lived, never-exiting process
(stderr is unbuffered by POSIX by default, but GLib's log handler or C++ iostreams could plausibly be
wrapping a differently-buffered `FILE*`/stream internally) — worth testing with `LD_PRELOAD`-based
unbuffering or a genuinely clean `gdb`/`strace -e trace=write -p <pid>` attach (this session's
`gdbserver`/`gdb-multiarch` attempt hit the same `'g' packet reply is too long` register-description
mismatch as Part 6 — unlike Part 6 this was a hard error, and wasn't worked around); (b) it's possible
the AVServer/AVTransportWrapper connection Thread B makes doesn't actually reach *this* fresh
`RunVideoHost` instance at all — worth directly confirming via `strace -f -e trace=network,connect`
on both processes during a fresh test, watching the exact socket-level handshake, rather than
inferring success from "Thread B says it's sending" alone; (c) worth re-examining whether
`RtpPacketReceived`'s dispatch inside `ProcessCall`'s case `0x14` (Part 30) is really reached given
the *exact* command byte our own `voipkit.cpp` sends — cross-check the literal `cmdId`/field-index
constants in `voipkit.cpp` (`kRtpPacketReceivedCmdId = 20`, `kRtpPacketReceivedFieldIndex = 91`)
against `ProcessCall`'s real switch-case decode logic byte-for-byte, since a field-index or framing
mismatch there would produce exactly this symptom (client "successfully" writes bytes, server's
`ProcessCommands()` loop never recognizes them as a valid call) with zero errors on either side.

**Device state at end of session**: `libpalmgstskype.so` confirmed back to the safe caps-fix build
(md5 `8a07e9de65fc9980047bc5668d8016cc`), `media-pipeline.real` unchanged production build (md5
`c92458a3c20a06876d6f25f61c5ff3b8`), `/etc/event.d/mediaserver` restored to its original content
(verbosity bumps and `G_MESSAGES_DEBUG` were diagnostic-only, not kept — re-apply from this section
if resuming this investigation), `mediaserver` freshly restarted and confirmed responding to
`testInjectVideo`/`testStopInjectVideo`, no stray `media-pipeline.real`/test-injection timers left
running, root filesystem was remounted `rw` mid-session (had reset to `ro` on reboot — needed for the
`/etc/event.d/mediaserver` edits) and is currently `rw`; no further binary changes made this session.

## Part 32 — strace confirms a live, fresh RPC write genuinely succeeds; server-side still shows nothing; error-checking added to `send_access_unit` as a permanent diagnostic

Followed up Part 31's connection-tracing lead with `strace -f -p <media-pipeline.real pid> -e
trace=network,read,write`. Initial read looked like a smoking gun — an `accept(61, <unfinished ...>)`
that never completed for the whole 15s capture — but cross-referencing `imstdout.log`'s timestamps
against the exact same PID (`clonk session open: palm://com.palm.mediad.Clonk_12286/` immediately
followed by `skypekit thread B connected to mediaserver`) proved Thread B's actual video-socket
connect had already completed *before* the strace attach raced to catch it; fd 61 was something else
(most likely the audio path or an LS2 session socket). Lesson for next time: attach strace *before*
triggering the test (e.g. via a wrapper `exec` if one can be inserted), not after — racing `ps` to
find a freshly-spawned PID is inherently too slow to catch the first ~1s of a short-lived process's
socket setup.

**Read `voipkit.cpp`'s `send_access_unit()` (glue/voipkit.cpp:236) closely while chasing this**,
and found the real client-side send call's return value was being silently discarded:
`binclient_wr_call_lst(...)` returns `int` and the call site never checked it. Added error logging
(`if (wr_rc != 0) fprintf(stderr, "wa-call: send_access_unit wr_call_lst FAILED rc=%d len=%u\n", ...)`),
rebuilt via `build-combined.sh`, and deployed the new `libwhatsmeow.so` (md5
`691f14b3393bde10a8ebe34b3d275cd8`) to
`.../com.palm.app.teams/backend/lib/purple-2/libwhatsmeow.so`. (One deploy mishap along the way: a
`cp` between two `novacom run` calls raced and truncated the live `.so` to 0 bytes for about a minute
— caught immediately via `md5sum` after every write from now on, restored from a pre-saved backup,
no lasting impact.)

**Result, decisive on both sides of the picture:**
- On a **stale** Thread B connection (only `mediaserver` restarted, not `imlibpurpletransport`, so
  Thread B was still holding a handle to an already-dead `media-pipeline.real`): every single
  `send_access_unit` call logged `wr_call_lst FAILED rc=2`. This **proves the error-check mechanism
  is real and correctly distinguishes failure from success** — it isn't a no-op or always-zero stub.
  It also is very likely a distinct, real, second bug in `voipkit.cpp` in its own right: Thread B's
  data-send loop never checks this return value for reconnection purposes, so once connected it never
  notices its peer died and never re-attempts `avtw_connect` — worth fixing separately (retry/backoff
  on repeated `wr_call_lst` failure) since this exact scenario (`media-pipeline.real` dying/restarting
  mid-session, e.g. after Part 22-30's teardown bug) would silently blackhole a real call's video too.
- On a **genuinely fresh** connection (confirmed via the `clonk session open` / `skypekit thread B
  connected to mediaserver` log pairing on a just-spawned PID), **zero** `wr_call_lst FAILED` lines
  appeared across an entire real-stream run — the client-side RPC write reports success on every
  single access unit, exactly as before. Combined with Part 31's finding (zero server-side trace of
  `RtpPacketReceived`/`gst_skype_video_rtp_submit`/`gst_skype_rtp_src_write` even with full logging),
  this now firmly rules out a silent client-side write failure as the cause. The gap is specifically
  between "client's `wr_call_lst` returns 0" and "server's `ProcessCall`/`RtpPacketReceived` ever
  runs" — i.e. either the bytes never actually reach the server's read loop despite the local `send()`
  succeeding (kernel-level socket issue, wrong fd, or writing to a *different* connection than the one
  `RunVideoHost`'s `accept()` produced), or they arrive but `BinServer::rd_command`/`rd_call` silently
  fails to recognize them as a valid call and neither dispatches nor errors.

**Attempted but inconclusive this session**: a follow-up strace specifically watching the server's
`read()` calls on the connected socket (to settle the last question above directly) was planned but
the test harness became increasingly unreliable partway through this session — `testInjectVideo`
calls started requiring 2-3 retries to actually spawn a fresh `media-pipeline.real`, `luna-send -n 1`
intermittently produced no visible reply over `novacom run` regardless of success/failure, and one
`imlibpurpletransport` restart cycle left `clonk_open()` not spawning anything for several minutes
without a clear cause in `imstdout.log`. Not clearly a real platform bug — more likely test-harness/
transport friction from this session's unusually large number of back-to-back restarts. **Next
session should start here**: with a patient, single clean reboot and generous settle time, attach
`strace -f -e trace=network,read` to the target PID *before* calling `testInjectVideo` if possible
(e.g. briefly pause `clonk_open()` with a `sleep`/env-gated hook, or just accept the race and retry
until the attach lands before the "connected to mediaserver" log line), and watch specifically
whether `read()`/`recv()` on the accepted video-socket fd ever returns bytes matching the sizes
Thread B logs sending. If reads return 0 bytes despite a successful client write, the bug is a
mismatched/wrong fd or socket-level issue; if reads return the right byte count but `RtpPacketReceived`
still never fires, the bug is in `BinServer::rd_command`/`rd_call`'s parsing of our client's exact
byte sequence (worth a byte-for-byte comparison against what `Sid::Protocol::BinServer`'s real
disassembly expects, beyond the header comment's existing analysis in `voipkit.cpp:207-235`).

**Device state at end of session**: `libpalmgstskype.so` unchanged (md5 `8a07e9de65fc9980047bc5668d8016cc`,
caps-fix only), `media-pipeline.real` unchanged (md5 `c92458a3c20a06876d6f25f61c5ff3b8`, production
build), `/etc/event.d/mediaserver` confirmed back to original content (no elevated verbosity left
running). The new `libwhatsmeow.so` (md5 `691f14b3393bde10a8ebe34b3d275cd8`, adds the `wr_call_lst`
error-check/log only, otherwise identical to the previous `604f9af6...` build) **is** left deployed —
it's a pure diagnostic addition with no behavior change on the success path, safe to keep. No stray
`strace`/test-injection processes left running; confirmed via `ps` at session end.

## Part 33 — found and root-caused this whole session's test-harness flakiness (two real state bugs, both in our own test code, not the platform); wchan probing points at the same known teardown-timing issue from a new angle

Continued straight from Part 32's plan (strace the server's `read()`s). `strace -f -p <mediaserver>`
before triggering the test produced **zero** trace lines even for basic LS2/network activity on a
process confirmed still healthy and responsive afterward (`State: S (sleeping)`, `luna-send` still
worked) — concluded this is the same class of ancient-ptrace-tooling limitation already documented in
Part 6 for `gdbserver` on this device, not a real finding, and abandoned server-side `strace` as an
approach here.

**Switched to a non-invasive alternative**: reading `/proc/<pid>/task/*/wchan` and `/status` (Name:
field) to see what kernel call each thread is blocked in, without ptrace at all. This is what led to
finding the real cause of this session's escalating test-harness unreliability (media-pipeline.real
frequently not spawning, `testInjectVideo` needing repeated retries):

**Bug 1 — `clonk_open()`'s idempotency guard (`glue/call.c:539`) doesn't know about processes we
kill out-of-band.** `clonk_open()` no-ops if `g_clonk_uri[0]` is already set, by design — this is
correct behavior for real concurrent-call races (its own comment explains this), but this whole
session's habit of `kill -9`-ing `media-pipeline.real` directly for a "clean" retest (instead of
calling `testStopInjectVideo` first, which drives `clonk_close()` and clears `g_clonk_uri`) left the
plugin's view of the world stale: it kept believing a session was open long after mediaserver's side
was dead, so every subsequent `testInjectVideo` silently no-op'd. Confirmed directly from
`/media/internal/wacall_clonk.log` (written via `fopen`+`fclose` every call — immune to the stdio-
buffering issue from Part 31/32 — a genuinely reliable diagnostic source, worth using first in future
sessions over `imstdout.log`): repeated `clonk_open: skipped (uri=palm://com.palm.mediad.Clonk_27052/
opening=0)` lines while `media-pipeline.real` PID 27052 was already long dead.

**Bug 2 — `mediaserver`'s own session bookkeeping gets similarly confused by the same abrupt kills.**
After properly calling `testStopInjectVideo` (confirmed real teardown via `clonk_close: tearing down
session ...` in the diag log, not a no-op) and retriggering, `clonk_open_reply` still returned the
**same stale session URI** (`Clonk_27052`) and the chain hung after `clonk_open_reply` — no
`clonk_video_capture_start_reply` ever came. Required a full `stop mediaserver`/`start mediaserver`
cycle (not just killing the spawned child) to actually clear this. **Lesson for every future session
on this device**: never `kill -9` a `media-pipeline.real` test child directly — always call
`testStopInjectVideo` first and confirm `clonk_close: tearing down session ...` (not `no-op`) in
`wacall_clonk.log` before considering a session cleanly ended; if a session ever gets stuck (`open`
succeeds but `capture_start_reply` never arrives), a full `mediaserver` restart is required, a plain
process kill is not enough.

**With a genuinely clean baseline** (full `mediaserver` + `imlibpurpletransport` restart, confirmed
via `wacall_clonk.log` showing the complete real chain: `clonk_open` → `clonk_open_reply` →
`clonk_video_capture_start_reply` → `fire_video_player_start` → `clonk_video_player_start_reply` →
`TEST: starting real-stream frame injection loop`), immediately dumped all 13 threads of the
resulting `media-pipeline.real` (confirmed matching PID, `Clonk_9337` ⟷ PID 9337 this time — the
`Clonk_NNNN` URI number **is** the real spawned PID when the session is healthy, unlike the stale
`Clonk_27052` case above which never actually pointed at a live process). **None of the 13 threads
were named after `rtp`/`depay`/`filter`** (the internal `clonkvhsrc` chain confirmed present and
task-activating in Part 31's `gst_debug_child.log` capture) — only capture-side threads (`Palm Video
Encoder`, `Video`/`VideoSink Queue` ×3, `Camera Source`) plus unnamed `media-pipeline.` ones
(`poll_schedule_timeout` ×5, `msm_ioctl_config`, `inet_csk_accept`). Most likely explanation: the
several seconds of sequential `novacom run` round-trips between triggering the test and reading
`/proc/<pid>/task` was enough time for the already-known internal auto-teardown (Parts 22/27/28,
observed as low as 14-40ms in Part 28) to have already torn the VPlay pipeline's threads down before
the check ran — this is independent, fresh evidence for the *same* already-documented teardown-timing
issue, not a new bug, but it does confirm that **any live-inspection technique on this device needs
to either attach before triggering the test, or be fast enough (single round-trip) to beat a teardown
that can happen in under 50ms** — sequential multi-command `novacom run` probing (this whole
session's dominant pattern) structurally cannot do that.

**Next session should start here, in this order**:
1. Read `/media/internal/wacall_clonk.log` first, always — it's unbuffered by construction and gives
   the true state-machine trace (`clonk_open`/`clonk_open_reply`/`capture_start_reply`/
   `player_start_reply`) that `imstdout.log` and `gst_debug_child.log` can't reliably show without the
   Part 31 fixes (and even with them, only *inside* the plugin, not across the mediaserver boundary).
2. Never `kill -9` a test session's `media-pipeline.real` directly; always `testStopInjectVideo` first
   and verify the real teardown line.
3. To catch the VPlay pipeline's threads/sockets alive, either instrument via a *single* combined
   remote command (one `novacom run` invoking a small on-device script that triggers the test **and**
   immediately dumps `/proc/<pid>/task/*/wchan` in the same shell invocation, avoiding the multi-
   round-trip gap entirely), or resolve Part 31/32's real open item first — root-cause and fix the
   sub-50ms teardown itself (Parts 22/27/28's original open thread) so there's no race to lose at all.

**Device state at end of session**: same as Part 32 (`libpalmgstskype.so` md5
`8a07e9de65fc9980047bc5668d8016cc`, `media-pipeline.real` md5 `c92458a3c20a06876d6f25f61c5ff3b8`,
`libwhatsmeow.so` md5 `691f14b3393bde10a8ebe34b3d275cd8` with the `wr_call_lst` error-check kept,
`/etc/event.d/mediaserver` original content). `mediaserver` and `imlibpurpletransport` both freshly
restarted and confirmed healthy at session end (`testInjectVideo`/`testStopInjectVideo` round-trip
verified clean via `wacall_clonk.log`); no test session left open, no stray `strace` processes.

## Part 34 — decisively confirmed the RPC-delivery gap and the teardown-timing bug are two fully independent bugs, using today's improved instrumentation to redo Part 28's decisive test properly

Directly answered a live question this session ("is the video pipeline stable now"): **no.** On a
clean baseline, `clonk_vplay_h264dec` reaches `GST_STATE_CHANGE_PAUSED_TO_PLAYING` at t=1.153s and is
torn all the way down to `READY_TO_NULL` by t=1.296s — a **~38ms** window in PLAYING, matching Part
28's 14-40ms range almost exactly. This is the same still-open bug from Parts 22-28, unchanged.

Reconstructed the Part 22/27/28 experimental no-op-teardown patch from scratch this session (the
actual binary wasn't preserved across sessions — `/tmp` scratchpad doesn't persist): found
`ClonkPipeline::stopVPlayPipeline()` (nm `0xb47f0`) and `::teardownVPlayPipeline()` (nm `0xb06e0`) via
plain `nm -C` on a freshly-pulled `media-pipeline.real` (no Ghidra needed, binary is unstripped),
confirmed both start with plausible ARM prologues, and patched each entry point to `bx lr` (`E12FFF1E`).
**The resulting patched binary's md5 (`e61588a512f0a270fdec1639adf96e60`) exactly matches the value
documented in Part 22/27/28** — byte-for-byte confirmation the reconstruction is identical to what
worked before.

Deployed this alongside *this session's* logging fixes (bumped `GST_DEBUG` categories +
`G_MESSAGES_DEBUG=all`, neither of which existed when Part 28 ran its original 40s decisive test) and
re-ran the exact same experiment: `testInjectVideo` with `realStream=1`, verified the complete healthy
chain via `wacall_clonk.log` (`clonk_open` → `clonk_open_reply` → `capture_start_reply` →
`player_start_reply`), then let it run a full 40 seconds untouched.

**Result**: `PAUSED_TO_PLAYING` occurred once, `PLAYING to PAUSED` occurred **zero** times across the
entire 40s — the no-op patch works exactly as before, teardown is fully suppressed. And even with that
window wide open and Thread B confirmed actively sending the whole time (`imstdout.log`), **`palm_
videodecoder_chain`, `RtpPacketReceived`, `gst_skype_video_rtp_submit`, and `gst_skype_rtp_src_write`
all remained at zero** — identical to every timing-unconstrained test this session. This reconfirms
Part 28's original finding, but this time with the improved visibility from Part 31/32 in place (which
didn't exist yet in Part 28) rather than relying on `--gst-debug=4`-level logs that couldn't have shown
these calls either way. **The teardown-timing bug (Parts 22-28) and the RPC-delivery gap (Parts 30-33)
are now conclusively two separate, independent bugs** — fixing one will not fix the other, and both
need to be resolved before video can display end to end.

**Device state at end of session**: `media-pipeline.real` restored to the production build (md5
`c92458a3c20a06876d6f25f61c5ff3b8`) — the no-op-teardown build was experimental-only for this test and
is **not** deployed. The reconstructed no-op build is saved this time at
`scratchpad/libs/media-pipeline.real.noop_teardown` (md5 `e61588a512f0a270fdec1639adf96e60`) in case
this session's scratchpad happens to survive into the next one — don't count on it, the reconstruction
recipe above (two `nm -C` symbols, `bx lr` at each) takes under a minute to redo if not. `libpalmgstskype.so`
and `libwhatsmeow.so` unchanged from Part 32/33. `/etc/event.d/mediaserver` reverted to original (no
elevated verbosity left running). Both `mediaserver` and `imlibpurpletransport` freshly restarted,
confirmed healthy, no test session left open.

**Where this leaves the investigation, concretely, for whoever picks this up next**: two independent,
real, still-open bugs block video display:
1. **Teardown-timing bug** (Parts 22-28): something tears `clonk_vplay_h264dec`/the VPlay pipeline
   down ~14-40ms after reaching PLAYING, silently (no error/EOS on the bus), even with `ClonkPipeline`'s
   own `stopVPlayPipeline`/`teardownVPlayPipeline` confirmed not to be the caller (no-op patching them
   is a reliable *workaround*, not a fix — something else, not yet identified, still calls
   `gst_element_set_state(..., NULL)` on the affected elements through some other path). Root cause
   still unknown; the two known call sites are ruled out, and Part 25's dead-code findings
   (`audioCaptureStart`/`Stop` type-11/12 events never constructed) remain the only solid lead not yet
   fully chased down.
2. **RPC-delivery gap** (Parts 30-33): `VideoHost::RtpPacketReceived`/`gst_skype_video_rtp_submit`
   never fire despite a fully-verified-correct chain up to that point (client connects, client's RPC
   write reports success every time, server's internal queue consumer is confirmed running and
   healthy) and despite arbitrarily long PLAYING windows (this part's finding) ruling out any
   timing/race explanation. The most concrete unexplored leads (from Part 32) remain: (a) strace the
   server's `read()`s specifically, attaching *before* triggering the test to avoid the race that
   defeated every attempt so far — possibly by writing a tiny wrapper that pauses `clonk_open()` behind
   an env var this session didn't have time to add; (b) byte-for-byte verify our own `voipkit.cpp`'s
   `send_access_unit()` wire format against `Sid::Protocol::BinServer::rd_command`/`rd_call`'s real
   disassembly, beyond the existing header-comment analysis, since a subtle framing mismatch would
   produce exactly this symptom (client succeeds, server never dispatches, no errors either side).

## Part 35 — chased the framing-mismatch lead to ground: the wire protocol is confirmed byte-for-byte correct, not the bug

Decompiled the full chain on both sides via `nm -C`-located symbols (no guessing needed — every
function below resolved directly by demangled name): `BinClient::wr_call_lst` →
`BinCommon::wr_preencoded_lst` → `wr_value`/`bl_write_bytes` on the client side;
`BinServer::rd_command` → `BinCommon::rd_command`, `BinServer::rd_call`, and — critically —
`AVServer::ProcessCommands()` (the actual caller of `ProcessCall`, not previously decompiled) on the
server side.

**Traced the real wire format precisely:**
- `BinCommon::rd_command` reads exactly 2 raw bytes: byte 1 must be `0x5a` ('Z'); byte 2 becomes
  `Command.type` verbatim (our `0x52`/'R', confirmed correct — this is what tells
  `AVServer::ProcessCommands` to proceed to `rd_call` at all: `if (local_20 == 0x52) { rd_call(...); }`).
- `BinServer::rd_call(ci, &cmdId, &arg2, &arg3)` reads **3 LEB128 varints off the wire in the order
  arg2, arg3, cmdId** (i.e. its own `arg2`-labeled output param is filled first, `arg3`-labeled
  second, `cmdId`-labeled third) — the *opposite* of what the parameter names suggest, and the
  opposite of what `voipkit.cpp`'s existing header comment (Part 17-era) assumed.
- **The critical link**: `AVServer::ProcessCommands()` calls `ProcessCall(this, cmdId, arg3)` — i.e.
  it forwards `rd_call`'s *first-labeled* output (`cmdId`, which is actually the **third** value read
  off the wire) as `ProcessCall`'s param_1 (echoed back as the response id, unused here since
  `RtpPacketReceived` is fire-and-forget), and `rd_call`'s *third-labeled* output (`arg3`, actually
  the **second** value read off the wire) as `ProcessCall`'s param_2 — **the actual `switch()`
  dispatch key**.

Net result: the dispatch key `ProcessCall` switches on is the **second** varint read off the wire
(right after the two-byte `Z`/`R` header), not the third. Our client's header is
`[0x5a][0x52][0x00][kRtpPacketReceivedCmdId=0x14]` — meaning the second varint read *is* `0x14`,
landing exactly on `ProcessCall`'s `case 0x14:`, which calls vtable+0x60 (`VideoHost::
RtpPacketReceived`, confirmed in Part 30). **The framing is correct.** (The third varint we send,
`responseId`, lands on `ProcessCall`'s param_1 — the echoed-back id — which is irrelevant here since
this call path never calls `wr_response`.) Also checked `AVServer::Connect()`, on the theory that a
hidden protocol-level handshake beyond the raw socket accept might be silently failing — it's a
one-line wrapper straight to `AVTransportWrapper::Connect(isServer=true, timeoutMs)`, no such
handshake exists, so "Thread B connected to mediaserver" really does mean the RPC layer connection
(not just the socket) is live.

**This rules out the framing-mismatch hypothesis with certainty**, not just "probably fine" — every
byte our client sends was traced through the real decompiled reader on the other end and lands
exactly where it needs to. Combined with everything already established (Parts 30-34: task activates,
connection completes, client's RPC write reports success every time regardless of how long the
pipeline stays alive), **all individually-verifiable links in the chain — connect, write, wire
format, dispatch, and the `RtpPacketReceived`→`gst_skype_video_rtp_submit` call itself — check out
correct in isolation**, yet the empirical end-to-end result remains zero observed activity past the
connection. This is now a genuinely narrow mystery: either (a) there's a second, still-unfound
`VideoHost`/`GstSkypeInstance` instance mismatch (the registered callback object silently pointing at
a different instance than the one actually processing `ProcessCommands`), or (b) `G_MESSAGES_DEBUG`
genuinely doesn't reach whatever log path `g_log(NULL, G_LOG_LEVEL_DEBUG, ...)` calls in this binary
use (worth testing directly: check if GLib's default handler is even installed, vs. a custom
`g_log_set_default_handler` elsewhere in this process silently swallowing NULL-domain messages
regardless of `G_MESSAGES_DEBUG`), or (c) the live values really do never arrive and the decompile,
while structurally sound, is missing some runtime-only condition Ghidra's static analysis can't show
(e.g. a value read from a global that's legitimately zero/null at runtime for a reason not yet found).

**Next session's highest-value move, given the framing question is now closed**: get a *working*
live memory/register read on this device. Two ptrace-based tools have now failed here for the same
underlying reason (ancient `gdbserver`/`strace` build vs. modern host tooling — Part 6 and Part 33) —
worth trying an OLDER/matched-vintage `gdb`/`strace` client build instead of the current host's
modern one, or a completely ptrace-free approach: temporarily patch a single `write(2)` syscall (to a
fixed, always-flushed fd/file) at the entry of `VideoHost::RtpPacketReceived` (nm `0x382c4`) directly
into the binary — a minimal, low-risk instruction patch (not a cave/trampoline, just enough
inline `mov`/`svc`/`bl write` sequence if it fits, or a short trampoline into confirmed-dead space)
that would settle definitively, with zero dependency on GLib/GStreamer logging plumbing, whether this
function is ever entered at all.

**Device state at end of session**: unchanged from Part 34 (all binaries at their documented
known-good md5s, no elevated logging left running, no test session left open).

## Part 36 — RESOLVED end-to-end: three real meowcaller video bugs fixed, WhatsApp video now works both directions (2026-08-06)

Video calling now works reliably in **both** directions (webOS→Android and Android→webOS),
user-confirmed live across a batch of test calls. The remaining native RPC-delivery investigation
from Parts 28–35 turned out **not** to be the blocker for real calls — that entire thread was
chasing a synthetic-test-harness artifact. The real bugs were all in the `meowcaller` Go video
media path (our local vendored fork at
`messaging/facebook-e2ee/plugin/purple-combined/third_party/meowcaller/`), found by diffing our
pinned revision (`9769d5aaaeca`, 2026-07-17) against ~10 days of upstream `purpshell/meowcaller`
commits we were behind.

**Three fixes applied (all in the vendored meowcaller fork):**

1. **RTP packetization (the outgoing-direction fix).** Our `protectAccessUnitLocked`
   (`engine_media.go`) RTP-packetized each NAL unit (SPS, PPS, IDR) as a *separate* RTP packet.
   Real WhatsApp fragments the **whole Annex-B access unit as one RTP NAL unit** (STAP/FU-A over the
   combined SPS+PPS+IDR blob). Ported from upstream `2d1c5bfe` ("match WhatsApp access unit
   packetization"). Our send-side never errored — every frame reached the relay fine — but Android's
   depacketizer could never reassemble our per-NALU framing, so nothing decoded. This is why
   webOS→Android showed no video despite our own diagnostics reporting healthy sends. Deterministic
   (every frame malformed, every call) — explains why the earlier "always broken outgoing / always
   working incoming" looked like a caller/callee asymmetry but was really just wire-format.

2. **Frame-info markers + extension encoding + sequence start.** `VideoMediaFrameInfoIDR`/`Delta`
   were `0x09`/`0x01`; real values are `0x08`/`0x20`, with a restructured `VideoRtpExtension.encode()`
   TLV layout and video RTP sequence starting at 1 (not 0). Verified byte-for-byte against upstream's
   captured reference (`rtp.go` wholesale-replaced from upstream `6d9b7b2c`; standalone test confirmed
   our output matches `32080001510000610000910000000000` etc. exactly).

3. **Receive-side loss/reorder recovery + PLI grace window (the incoming-direction reliability
   fix).** Our receive loop used the plain `H264Depacketizer` with **zero** loss/reorder recovery —
   a single dropped/reordered RTP packet mid-frame silently corrupted the reassembled access unit and
   handed it straight to mediaserver's decoder. Replaced with upstream's `H264AccessUnitAssembler`,
   which discards a corrupted access unit and withholds subsequent frames until a real IDR restores
   decoder state. PLUS a **PLI grace window**: the RTCP ticker previously stopped requesting keyframes
   the instant the *first* video RTP arrived (`gotPeerVideo`), but our clonk display pipeline opens
   ~200 ms **after** that first packet (async `videoCaptureStart`/`videoPlayerStart`), and skypekit's
   Thread B silently drops every frame handed to it before the pipeline is up. So if the peer's first
   IDR arrived fast (before our ~200 ms startup), it was dropped and we'd never ask for another →
   frozen/blank video until the peer volunteered a fresh IDR or the user toggled a camera. Fix
   (`engine_media.go`, `doTick`): keep sending PLI/FIR for `pliGraceTicks` (2 ticks, ~1.5 s) *after*
   first video too, guaranteeing a fresh IDR request lands once the display is ready. Symptom before
   fix: incoming video occasionally never displayed until a manual camera toggle. After: always
   displays.

**Deployed:** `libwhatsmeow.so` md5 `7f2ef9a1f6b9031d37d2b63bc3bc0568` (final build with all three
fixes). Confirmed loaded/mapped into the running transport.

### Follow-up (deferred — "always works" is good enough for now)

**Startup-latency optimization for incoming video.** The first keyframe request currently waits for
the RTCP ticker's first tick (fires on relay ALLOCATE-SUCCESS, then every 1500 ms). Most incoming
calls get Android's first keyframe after ~1 request (~5–6 s incl. call setup), but some take 2–3
requests (~12–20 s) — the variance is entirely in how fast Android's encoder responds to our PLI/FIR
(network + Android scheduling), confirmed from the per-call `fir_seq` escalation cadence (logged
every 4th tick = every ~6 s) in `imstdout.log`. **Proposed tweak:** fire PLI/FIR *immediately* when
video activates, plus a couple more in quick succession over the first ~1–2 s (instead of one every
1.5 s), to prompt Android's encoder sooner and shrink the slow-path tail. Cost: a few extra request
packets early on (real clients send these routinely). This is a latency nicety, not a correctness
fix — video already always displays.

**Also noted (minor, unrelated):** after the last `kill -9`/respawn of the transport during this
session's redeploys, the freshly-respawned instance stopped appending to `/media/cryptofs/imstdout.log`
even though its fd 1/2 still point there and the correct `.so` is mapped — a logging-plumbing quirk of
that specific restart, not a functional problem (calls still worked). A single clean transport restart
resumes normal logging; worth a quick look if it recurs, but it does not affect calling.

**Not the bug (closing out Parts 28–35):** the native SkypeKit RPC-delivery question — whether
`VideoHost::RtpPacketReceived` is ever entered — was a synthetic-test-harness artifact. Real calls
now round-trip video end to end through the exact same skypekit/clonk bridge, so that path
demonstrably works in production; the earlier dead end was in the injection test rig, not the live
pipeline.
