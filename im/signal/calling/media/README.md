# Signal 1:1 call — MEDIA ENGINE (webOS / HP TouchPad)

Answerer-side audio media for an **incoming** Signal voice call, built on the device's stock
GStreamer 1.20.7 stack and reusing the exact audio recipe proven for the Telegram port.

Status (2026-07-21): **cross-compiles to an ARM binary + static lib; the crypto KDF is verified
byte-for-byte against the Python reference; the GStreamer loopback path builds but is NOT yet run
(no device tonight).** See "What is verified vs unverified" below.

## Files

| file | what |
|------|------|
| `srtp_kdf.c` / `srtp_kdf.py` | RingRTC SRTP key derivation (X25519 DH + HKDF-SHA256). **Pre-existing, verified, untouched.** |
| `srtp_kdf.h` | header exposing `signal_negotiate_srtp_keys()` + `signal_x25519_public_from_private()` to the engine (new; does not modify `srtp_kdf.c`). |
| `signal_media.c` | the media engine: ICE (libnice) + manual AEAD_AES_256_GCM SRTP + Opus over RTP + ALSA, plus a `--loopback` self-test. |
| `signal_media.h` | clean C API the presage bridge will call. |
| `build-signal-media.sh` | cross-compile for ARM; `host` arg builds just the KDF self-test. |

## Architecture

Signal 1:1 media is **ICE + AEAD_AES_256_GCM SRTP + Opus — NOT DTLS.** The SRTP master keys come
from an X25519 DH on the `public_key` inside the offer's `ConnectionParametersV4` (see `srtp_kdf.c`).
As the **callee/answerer** we DECRYPT the caller with `offer_key/offer_salt` and ENCRYPT ours with
`answer_key/answer_salt` (both peers derive the identical 88-byte OKM).

One `NiceAgent`, one stream, one RTP component (rtcp-mux), shared by both pipeline branches:

```
RX: nicesrc ─ caps(x-srtp) ─ srtpdec ─ caps(x-rtp OPUS) ─ rtpopusdepay ─ opusdec ─ audioconvert ─ alsasink device=voip
                └ request-key ⇒ offer_key‖offer_salt (aes-256-gcm)

TX: alsasrc device=voipsource ─ audioconvert ─ audioresample ─ caps(48k/mono) ─ opusenc ─ rtpopuspay ─ srtpenc ─ nicesink
                                                                                            key = answer_key‖answer_salt (aes-256-gcm)
```

- **srtpenc** takes the 44-byte master (`key32‖salt12`) via its `key` property, `rtp-cipher`/
  `rtcp-cipher = aes-256-gcm`, `rtp-auth`/`rtcp-auth = null` (GCM is AEAD).
- **srtpdec** has no static key property; it fires the `request-key` signal per SSRC and we return a
  `GstCaps` carrying `srtp-key` (the offer master), `srtp-cipher = aes-256-gcm`, `srtp-auth = null`.
- **libnice** creates the agent (RFC5245 full ICE, controlled role), sets our + the remote ufrag/pwd,
  gathers local candidates (emitted back through a callback for the bridge to relay as `IceUpdate`),
  and accepts remote candidates parsed from standard `candidate:…` SDP strings.

### webOS audio + audiod (same as Telegram/WhatsApp)

- Capture from ALSA `voipsource`, play to `voip` — these route to PulseAudio `pvoip`/`pvoipsource`
  (the real mic/loudspeaker under the phone scenario). **Not `default`.**
- The engine fires an optional `audiod_cb(active)` when the pipeline reaches PLAYING / on stop. The
  bridge (`call.c`, which already owns the `com.palm.signal.call` **private** `LSHandle`) must send,
  exactly like `wacallm` / Telegram `callLunaSetCallAudio()`:
  - on active: `palm://com.palm.audio/phone/CallStatusUpdate`
    `{"lines":[{"state":"active","calls":[{"id":1,"address":"signal","origin":"incoming","video":false,"transport":"com.palm.signal"}]}]}`
    then `palm://com.palm.audio/phone/setCurrentScenario {"scenario":"phone_back_speaker"}`
  - on hangup: `palm://com.palm.audio/phone/CallStatusUpdate {"lines":[]}`
- **CRUCIAL runtime detail (not a build issue):** gst's `alsasrc`/`alsasink` load `libasound`; it must
  be the **system** `/usr/lib/libasound.so.2`, not the Atlas one on `LD_LIBRARY_PATH` (the Atlas
  libasound can't resolve `voip`→pulse). Control this at launch with the ALSA config / library path.

## Build

```sh
cd messaging/signal/calling/media
./build-signal-media.sh            # cross-compile for ARM -> signal_media, libsignalmedia.a
./build-signal-media.sh host       # host build of the KDF self-test only -> ./srtp_kdf_host
```

Toolchain `/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125` (gcc 12.5, softfp glibc); GStreamer
+ libnice + libsrtp2 + opus from the staging sysroot `/home/herrie/webos/wpe/staging-glibc-252` via
pkg-config. **OpenSSL:** links `libcrypto.so.3` — the same OpenSSL 3.x that the staging
libnice/libsrtp are built against (Atlas/WPE 2.52 bundles it in its deviceroot). The engine runs
inside that Atlas GStreamer runtime, so it must match; it is *not* the webOS system 1.1.1w. The KDF
API is identical on both. Producing:

- `signal_media` — standalone ARM test binary (`./signal_media --loopback`).
- `libsignalmedia.a` — `srtp_kdf.o` + `signal_media.o` (`-DSIGNAL_MEDIA_NO_MAIN`) for the bridge.

Confirmed NEEDED: `libgst{app,base,reamer}-1.0`, `libnice.so.10`, `libsrtp2.so.1`, `libopus.so.0`,
`libcrypto.so.3`, glib/gio/gobject — all present in the wpe-252 deviceroot.

## Loopback self-test (primary verifiable deliverable)

`signal_media --loopback` (or `signal_media_loopback_selftest()`) round-trips a test tone entirely
in-process, no ICE / no ALSA / no device:

```
audiotestsrc → audioconvert → audioresample → [48k/mono] → opusenc → rtpopuspay
   → srtpenc(master) → srtpdec(same master via request-key) → rtpopusdepay → opusdec → fakesink
```

The 44-byte master is a **real** `AEAD_AES_256_GCM` key from `signal_negotiate_srtp_keys()` (the same
fixed vector as `srtp_kdf.py --demo`, so you can eyeball it). A pad probe counts decoded Opus frames;
it prints `PASS` once ≥25 frames decode (≈0.5 s), else `FAIL`/timeout(10 s). This proves the
SRTP-GCM + RTP + Opus path links and negotiates. **It must be run on device** (or any host with
gstreamer-1.0 + the srtp/opus/rtp plugins); this build host has no `gstreamer-1.0.pc`.

Deploy + run on device:
```sh
# ensure the Atlas gst runtime is visible:
export LD_LIBRARY_PATH=<wpe-252>/lib:$LD_LIBRARY_PATH
export GST_PLUGIN_PATH=<wpe-252>/lib/gstreamer-1.0
./signal_media --loopback     # expect: "decoded N Opus frames through SRTP-GCM -> PASS"
```

## What is verified vs unverified

**Verified (host, this session):**
- `srtp_kdf.c` cross-checks byte-for-byte with `srtp_kdf.py` (`offer_key=2c6a45c7…`, `answer_key=122de4d5…`).
- Both build targets cross-compile clean to ARM; all `signal_media_*` symbols exported; deps consistent.

**Built but UNVERIFIED (needs the device, morning):**
- The loopback pipeline actually decoding frames (caps negotiation between srtpenc↔srtpdec and the
  `application/x-rtp` OPUS caps is reasoned-out, not run).
- The live-call pipeline (nicesrc/nicesink binding, ALSA voip routing, real GCM interop with Signal).

## Stubbed / TODO (the precise presage-integration points still needed)

The engine exposes `signal_media_start / add_remote_candidate / stop` + two callbacks. Still to wire
in `messaging/signal/plugin/purple-presage` (mostly Rust + `call.c`):

1. **Generate our ephemeral X25519 keypair** per call; keep the private for `signal_media_start`,
   put the public into the Answer.
2. **Build + send the Answer `ConnectionParametersV4` protobuf opaque** (public_key, our ice_ufrag,
   ice_pwd, audio codec = Opus, max_bitrate) via a new presage Rust send path
   (`presage_rust_send_call_answer`) — analogous to the planned `…send_call_hangup`.
3. **Relay ICE both ways:** decode the peer's `IceUpdate` opaque → `candidate:…` string →
   `signal_media_add_remote_candidate()`; and take our local candidates from the `cand_cb` →
   encode as `IceUpdate` opaque → send via presage.
4. **Lifecycle:** on `CallMessage::Offer` (state incoming, user accepts) call `signal_media_start`
   with the derived material; on `Hangup`/decline call `signal_media_stop`.
5. **audiod hook:** implement `audiod_cb` in `call.c` using its existing private `LSHandle` (the two
   `LSCallOneReply`s above).
6. **Opus payload type / bitrate:** currently hard-coded `PT=102`; parse the real PT + `max_bitrate`
   from the offer's `ConnectionParametersV4`.
7. **TURN relays:** Signal offers include TURN relay candidates; to use a relay we likely also need
   `nice_agent_set_relay_info()` fed with Signal's TURN servers (host/srflx work without it).
8. **Runtime libasound:** ensure gst's alsa elements load the system libasound (see audio note).

## Biggest risk

The manual-key SRTP GCM interop and the ALSA `voip`/`voipsource` routing are the two things most
likely to bite, and neither is verifiable without the device. The loopback test de-risks the
SRTP-GCM+Opus+RTP half; the ICE half and the ALSA half remain to be proven live.
