# Teams NGC media engine — adaptation of the Signal media engine

This dir is seeded from the **on-device-verified** Signal call media engine
(`messaging/signal/calling/media/`, PASS 2026-07-21): `signal_media.c.reference`,
`signal_media.h.reference`, `srtp_kdf.*`, the GCM libsrtp2 build, the cross-compile recipe
(`build-teams-media.sh.base`) and `RUNTIME_STATUS.reference.md`. That engine already gives us,
running on this exact device (WPE gst-1.20.7 + libnice + libsrtp2 + the patchelf loader recipe):

```
RX: nicesrc  -> srtpdec -> rtp<codec>depay -> <codec>dec -> alsasink   device=voip
TX: alsasrc  -> <codec>enc -> rtp<codec>pay -> srtpenc  -> nicesink    device=voipsource
```
a private GMainContext thread, a libnice agent **with TURN relay support**
(`nice_agent_set_relay_info`), an audiod hook, and a loopback self-test.

**To turn it into `teams_media.c`, exactly four things change from `signal_media.c`. Three of
them need one live-call capture (`/media/internal/teams-call-capture.log`, produced by the
already-deployed capture harness) to pin down.**

---

## Δ1 — Keying: drop the X25519 DH, use `udpKey.sessionKey` directly  *(SIMPLER than Signal)*

Signal derives the SRTP master via an X25519 DH in `srtp_kdf.c`. Teams hands us the master key
**out of band** in `callNotification.udpKey.sessionKey` (base64). So:

- **Delete** the `srtp_kdf.c` DH path. Replace `signal_negotiate_srtp_keys(...)` with a one-liner:
  `master = g_base64_decode(session_key_b64, &len)`.
- Per [MS-SRTP]/agent-2: the suite is **`AES_CM_128_HMAC_SHA1_80`** → master is **30 bytes**
  (16-byte key ‖ 14-byte salt), RFC 3711 AES-CM key derivation. (Signal used 44-byte GCM-256.)
- **CONFIRM WITH CAPTURE**: whether the key really rides only in `udpKey.sessionKey`, or *also*
  as an `a=crypto` inline in the SDP `blob` (SDES). If it's in `a=crypto`, parse it from there
  instead. Either way it's SDES-family, **no DTLS** (do NOT switch to `dtlssrtpenc`).

## Δ2 — SRTP cipher: AES-CM-128 not GCM-256

In `configure_srtpenc()` / `on_srtpdec_request_key()` change the cipher nick from
`"aes-256-gcm"` to **`"aes-128-icm"`** and set auth to **`"hmac-sha1-80"`** (Signal used GCM which
is AEAD → `auth=null`; AES-CM needs the explicit HMAC-SHA1-80 auth transform). Keep the
`gst_util_set_object_arg()` calls (the GEnum-nick gotcha from RUNTIME_STATUS still applies).
Then the **stock** wpe-252 libsrtp2 is fine — the custom GCM `prebuilt/libsrtp2.so.1` is
**not needed** for AES-CM (keep it around only in case a tenant negotiates GCM).

## Δ3 — Codec: SILK / G.722, not Opus  *(CONFIRM WITH CAPTURE)*

Agent-2: NGC 1:1 offers **Satin (proprietary — cannot implement), SILK, G.722, CN**; **Opus is
only on Teams' WebRTC/browser path, not native NGC**. So replace `opusenc/opusdec/rtpopus*`:

- If the capture's `a=rtpmap` lists **G.722** (payload 9, `G722/8000`) → use `avenc_g722/avdec_g722`
  + `rtpg722pay/depay` (present in the staged gst-1.20 libav plugins). Easiest path — try to get
  the answer to select G.722.
- Else **SILK** (`SILK/16000`, dynamic PT) → no stock gst SILK element; wrap the open SILK ref
  (or libopus's SILK-only mode) as an appsrc/appsink codec, or a small gst plugin. More work.
- Read the **payload type from the offered SDP** (dynamic PTs 104/110–129); don't hard-code.
- Our SDP **answer must offer a codec we actually have** (aim for G.722) so we never get Satin.

## Δ4 — Transport: single MS-TURN relay + MRAS ticket, not full ICE  *(CONFIRM WITH CAPTURE)*

Signal does full trickle-ICE with ufrag/pwd. Teams hands us **one relay** in
`links.udpTransport` (`udp://<ip>:3478/`) authenticated by `udpKey.ticket` (an MRAS token),
per [MS-TURN]/[MS-ICE2] — a *pre-standard* TURN dialect.

- The libnice agent + `nice_agent_set_relay_info(agent, stream, comp, ip, 3478, user, pass,
  NICE_RELAY_TYPE_TURN_UDP)` scaffolding is already in the reference engine — point it at the
  relay from `udpTransport`.
- **RISK / CONFIRM WITH CAPTURE**: MS-TURN's allocate uses the MRAS **ticket** and MS message-
  integrity, which stock libnice TURN (RFC 5766 long-term cred) likely won't satisfy. If libnice
  can't allocate, we need a small **MS-TURN allocate client** (the ticket goes in an
  `MS-*`/`LEGACY` attribute) that opens the relayed channel, then feed nicesrc/nicesink a plain
  UDP path — or bypass ICE entirely and send SRTP straight to the relayed transport address.
  This is the single biggest unknown and the capture (a TURN Allocate exchange) scopes it.

---

## Build

`build-teams-media.sh` (adapt from `build-teams-media.sh.base`): same toolchain
(`~/x-tools/arm-unknown-linux-gnueabi-gcc125`), same sysroot (`~/webos/wpe/staging-glibc-252`),
same `pkg-config gstreamer-1.0 nice libsrtp2` (+ the codec: `opus`→ drop; add nothing for G.722,
it's in gst-libav). Produces `teams_media` (separate process) + `libteamsmedia.a`, driven by
`teams_calling.c` over the same line-protocol IPC the Signal engine documents.

## Integration seam

`teams_calling.c`'s `teams_media_start(call)` / `teams_media_stop()` stubs are the hook: on
`answer`, spawn/IPC `teams_media` with `call->udp_transport`, `call->session_key_b64`,
`call->ticket`, and the codec/PT parsed from `call->sdp_offer`; take back the SDP answer and POST
it to `call->link_media_answer`.

**Bottom line:** Δ1/Δ2 are mechanical and can be written now; Δ3/Δ4 are a bounded diff that the
first capture turns from "unknown" into "known", after which this is a day of wiring, not a
research project.
