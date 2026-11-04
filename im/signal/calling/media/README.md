# Signal 1:1 call media engine

Audio for 1:1 Signal voice calls on LuneOS. purple-presage (the Signal libpurple plug-in, built by
meta-webos-ports' `purple-presage` recipe with its calling patch) starts this engine as a separate
process for every call and drives it over stdin/stdout. The `signal-call-media` recipe builds it
with the `Makefile` here and installs it as `${libexecdir}/signal-call-media`.

## Files

| file | what |
|------|------|
| `signal_media.c` | the engine: ICE (libnice) + manually keyed AEAD_AES_256_GCM SRTP + Opus over RTP + PulseAudio, the stdin/stdout protocol, and a `--loopback` self-test |
| `signal_media.h` | its C API |
| `srtp_kdf.c` / `srtp_kdf.h` | RingRTC SRTP key derivation (X25519 DH + HKDF-SHA256) |
| `srtp_kdf.py` | the Python reference the KDF was checked against byte for byte |
| `Makefile` | builds `signal_media`; `make check` runs the loopback self-test |
| `turn_loopback.c` | a stand-alone TURN test tool from bring-up; not built or installed |
| `build-*.sh`, `RUNTIME_STATUS.md` | the earlier build and bring-up on the HP TouchPad under legacy webOS (history) |

## Architecture

Signal 1:1 media is **ICE + AEAD_AES_256_GCM SRTP + Opus, not DTLS.** The SRTP master keys come from
an X25519 DH on the `public_key` in the peers' `ConnectionParametersV4` (see `srtp_kdf.c`). As the
answerer the engine decrypts the caller with `offer_key/offer_salt` and encrypts its own audio with
`answer_key/answer_salt`; as the caller it is the other way round (both peers derive the same
88-byte OKM).

One `NiceAgent`, one stream, one RTP component (rtcp-mux), shared by both pipeline branches:

```
RX: nicesrc ─ caps(x-srtp) ─ srtpdec ─ caps(x-rtp OPUS) ─ rtpjitterbuffer ─ rtpopusdepay ─ opusdec ─ audioconvert ─ pulsesink device=voipcall
                └ request-key ⇒ the peer's key‖salt (aes-256-gcm)

TX: pulsesrc device=webcall ─ audioconvert ─ audioresample ─ caps(48k/mono) ─ opusenc ─ rtpopuspay ─ srtpenc ─ funnel ─ queue ─ nicesink
                                                                                         our key‖salt (aes-256-gcm) ┘
    appsrc (RingRTC rtp-data "Accepted", SRTP-encrypted with libsrtp2) ───────────────────────────────────┘
```

- **srtpenc** takes the 44-byte master (`key32‖salt12`) via its `key` property, with `rtp-cipher`/
  `rtcp-cipher = aes-256-gcm` and `rtp-auth`/`rtcp-auth = null` (GCM is AEAD).
- **srtpdec** fires `request-key` per SSRC and gets caps carrying `srtp-key` and the same cipher.
- **libnice** runs RFC 5245 ICE with Google's renomination (which RingRTC uses to nominate), STUN
  binding requests as keepalives (RingRTC's consent freshness), and, when Signal's TURN servers are
  known, relay candidates only.
- **Accepted:** RingRTC keeps the caller ringing with media gated until the callee sends an
  `Accepted` message over its RTP data channel (PT 101, SSRC 0xD). The engine sends it about twice
  a second once the user answers.
- **Microphone:** for an incoming call the engine starts when the offer arrives, so ICE is ready when
  the user answers, but the `pulsesrc` only joins the pipeline on `ACCEPT`: nothing is recorded
  while the phone rings.
- **Echo cancellation:** SpeexDSP, on by default; `SIGNAL_MEDIA_AEC=0` turns it off. PulseAudio's
  call sink and source have no echo canceller of their own.

### Audio routing

The engine plays to the PulseAudio sink `voipcall` and records from the source `webcall`.
module-palm-policy routes a stream that names `voipcall` onto the output audiod picked for the call
and `webcall` onto its input. purple-presage reports the call to audiod itself with
`palm://com.palm.audio/phone/CallStatusUpdate` (transport `com.palm.signal`) when it becomes active
and `{"lines":[]}` when it ends; audiod then picks the device (the earpiece first). The engine does
not choose a scenario.

### Video

RingRTC (v2.73.0, webrtc 8037a) never sends an SDP: each side rebuilds it from the other's
`ConnectionParametersV4`. Ours lists only VP8, so the peer uses its legacy layout: one bundled
video m-line, VP8 on PT 108, fixed SSRCs (caller 1003, callee 2003), the orientation extension
(urn:3gpp:video-orientation) on id 4. `signal_video.c` holds the byte-level parts (RTP extensions,
the CVO byte, PLI/FIR, RingRTC's rtp-data protobuf) and is tested by `tests/test_signal_video.c`.

```
RX: srtpdec ─ split by PT ─ Opus → the audio branch above
                          ├ VP8 (and its CVO → PEERROT) → appsrc ─ rtpjitterbuffer ─ rtpvp8depay ─ avdec_vp8 ─ I420 640x480 ─ shmsink /tmp/signal-video
                          └ rtp-data SenderStatus → PEERVIDEO
    srtpdec rtcp_src: PLI/FIR for our SSRC → force a keyframe on our encoder

TX: camera (droidcamsrc vfsrc) ─ I420 640x480@15 ─ tee ─ [persistent tail] queue ─ vp8enc ─ rtpvp8pay(PT 108) ─ CVO ─ srtpenc ─ funnel
                                                    └ 320x240 ─ shmsink /tmp/signal-preview (self-view)
```

- The decoded picture goes out on a gst-shm socket as I420, the same contract as the WhatsApp
  engine, so the Phone app's `RemoteVideo` reads it unchanged.
- The send tail (encoder, payloader, srtpenc) is built once per call and kept; only the camera part
  comes and goes. RTP sequence numbers and the SRTP index then never restart under one key, which
  AES-GCM requires.
- No video is sent before the call is answered. The callee's `Accepted` and our
  `SenderStatus.video_enabled` go out together in the rtp-data message twice a second.
- When a frame is lost the depayloader asks for a keyframe, and the engine sends a PLI to the far
  side (at most one every 0.5 s).
- Elements can be overridden for bring-up: `SIGNAL_MEDIA_VP8_DEC`, `SIGNAL_MEDIA_VP8_ENC`,
  `SIGNAL_MEDIA_VIDEO_SRC` (+ `SIGNAL_MEDIA_VIDEO_MIRROR`), `SIGNAL_MEDIA_VIDEO_ROTATION`,
  `SIGNAL_MEDIA_VIDEO_SHM`, `SIGNAL_MEDIA_PREVIEW_SHM`; `SIGNAL_MEDIA_VIDEO=0` turns receiving off.
- The image needs a VP8 encoder (`vp8enc`, from gstreamer1.0-plugins-good with PACKAGECONFIG
  `vpx`) to send; without one the engine reports `VIDEOERR tx-encoder` and the call stays
  receive-only.

## Protocol

See the comment above `run_ipc()` in `signal_media.c`: `PREPARE`, `RELAY`, `START`, `RCAND`,
`ACCEPT`, `CALLID`, `VIDEO` and `STOP` in; `PUB`, `CAND`, `AUDIOD`, `READY`, `ERR` and the video
lines (`VSHM`, `VPREVIEW`, `VTX`, `PEERVIDEO`, `PEERROT`, `VIDEOERR`, see `signal_media.h`) out.
Keys are hex.

## Build and self-test

```sh
make                 # needs pkg-config for gstreamer-1.0, gstreamer-app-1.0, nice, libsrtp2, libcrypto, speexdsp
make check           # tests/test_signal_video, then signal_media --loopback
```

`tests/test_video_pipeline.c` builds against the engine source (it `#include`s `signal_media.c`)
and runs the video branches in-process: a VP8 stream from an IVF file (`SIGNAL_TEST_IVF`), SRTP
encrypted and decrypted, through the RX split to the shm socket; the rtp-data message and PLI as
the far side decrypts them; the send gate and CVO; and the camera turned on and off twice (with
`videotestsrc`). It needs ivfparse, rtpvp8pay/depay, avdec_vp8 and shmsrc/shmsink.

The loopback self-test round-trips a test tone in-process, with no ICE and no audio devices:

```
audiotestsrc → audioconvert → audioresample → [48k/mono] → opusenc → rtpopuspay
   → srtpenc(master) → srtpdec(same master via request-key) → rtpopusdepay → opusdec → fakesink
```

The master is a real `AEAD_AES_256_GCM` key from `signal_negotiate_srtp_keys()`. It prints `PASS`
once 25 frames have decoded (about 0.5 s), or `FAIL` after 10 s. It needs the opus, rtp, srtp and
audiotestsrc GStreamer elements; libsrtp2 must have its GCM ciphers (built with OpenSSL).

## Not yet verified on LuneOS

The loopback path is the only part tested without a live call. The ICE settings, the Accepted
message and the pipeline layout come from bring-up against real calls on the HP TouchPad under
legacy webOS (see `RUNTIME_STATUS.md` and the comments in `signal_media.c`); on LuneOS none of it
has been through a live call yet.
