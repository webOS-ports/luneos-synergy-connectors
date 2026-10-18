# Signal calling — media wire-up: how to test

Overnight 2026-07-21 the Signal call **media engine** was proven on-device and **wired into
presage**. This is the deploy + test recipe. The whole stack compiles; the signaling round-trip and
ICE are ready to exercise. Two-way audio has one remaining unverified input (the SRTP KDF ids, see
bottom) so treat the first call as a signaling/ICE test that may or may not yield audio.

## What's proven vs unproven
- ✅ `signal_media --loopback` round-trips 25 Opus frames through AEAD_AES_256_GCM SRTP **on device**.
- ✅ `signal_media --answer` IPC: parses START, gathers ICE, emits PUB + bare `candidate:` lines.
- ✅ presage `call_bridge.rs` compiles into `libpresage.so`, relays offer→Answer + ICE both ways.
- ✅ SRTP KDF derivation CONFIRMED against RingRTC source (identity keys, 32-byte raw; caller=peer,
     callee=us) and the identity keys are now sourced from the ACI protocol store.
- ❓ Real ICE connectivity to a live Signal peer (LAN host candidates should connect).
- ❓ Two-way audio end-to-end — all inputs are now correct in theory; needs a live call to confirm
     (the peer-identity store lookup uses device 1 + the ALSA route below).
- ❓ ALSA `voip`/`voipsource` routing under a live call (same recipe as Telegram; may need the
     system libasound + audiod scenario that call.c drives).

## Deploy (host → device)

1. **GCM libsrtp2** (once): the stock wpe-252 libsrtp2 has no AES-GCM.
   ```
   novacom put file:///media/internal/sslfix/libsrtp2.so.1 \
     < messaging/signal/calling/media/prebuilt/libsrtp2.so.1
   ```
   (Rebuild with `messaging/signal/calling/media/build-libsrtp2-gcm.sh` if needed.)

2. **Media engine** (patchelf'd to the wpe-glibc loader, host has patchelf):
   ```
   WPE=/media/cryptofs/apps/usr/palm/applications/org.webosports.app.atlas/deviceroot/wpe-252
   cd messaging/signal/calling/media && ./build-signal-media.sh
   patchelf --set-interpreter /media/internal/wpe-glibc/lib/ld-linux.so.3 \
     --set-rpath "/media/internal/sslfix:/media/internal/wpe-glibc/lib:$WPE/lib:/usr/lib:/lib" signal_media
   novacom put file:///media/internal/signal_media_p < signal_media
   # (chmod +x /media/internal/signal_media_p on device)
   ```

3. **presage plugin** (rebuilt libpresage.so with the bridge):
   ```
   messaging/signal/build-presage.sh   # then deploy plugin/purple-presage/build-arm/libpresage.so
   ```
   (Deploy libpresage.so where imlibpurpletransport loads it, per the existing Signal deploy.)

4. **Sanity-check the engine alone** on device (should print PASS):
   ```
   env LD_LIBRARY_PATH=/media/internal/sslfix:/media/internal/wpe-glibc/lib:$WPE/lib:/usr/lib:/lib \
       GST_PLUGIN_PATH=$WPE/lib/gstreamer-1.0 GST_REGISTRY=/media/internal/gstreg-sig.bin \
       /media/internal/signal_media_p --loopback
   ```

## Arm + run the test
- **Enable media auto-answer** (the gate; without it, calls just ring like v1):
  ```
  touch /media/internal/signal_call_media
  ```
- Restart the Signal transport (or the messaging service) so the new libpresage.so loads.
- From another phone, **place a Signal voice call TO the device**. Expect:
  - Phone app rings (existing v1 behaviour), AND
  - presage spawns `signal_media --answer`, sends an Answer, trickles our ICE candidates,
    feeds the caller's candidates to the engine.
- **Disable auto-answer** afterwards: `rm /media/internal/signal_call_media`.

## Where to look
- presage debug log: `call bridge: sent Answer to <uuid>` / `sent IceUpdate` lines confirm the
  outgoing signaling fired.
- `/media/internal/sigoffer.log` still dumps raw offer/answer/ICE opaques (DIAG in receive.rs).
- The engine's own stderr is dropped (Stdio::null) when spawned by presage; to see engine logs run
  the standalone `--answer` harness (see RUNTIME_STATUS.md) or temporarily point stderr to a file.

## SRTP KDF (RESOLVED — confirmed against RingRTC source)
`connection.rs::negotiate_srtp_keys`: HKDF-SHA256(salt = 32×0x00, ikm = X25519(our_priv, peer_pub),
info = `"Signal_Calling_20200807_SignallingDH_SRTPKey_KDF"` + caller_identity_key + callee_identity_key)
→ 88 bytes split 32/12/32/12 = offer_key/offer_salt/answer_key/answer_salt (AES-256-GCM).
- caller_identity_key = the offerer/peer's ACI identity key; callee_identity_key = ours.
- Both are **32-byte RAW** Curve25519 public keys (strip the 0x05 prefix off the 33-byte serialize()).
`receive.rs` sources ours via `get_identity_key_pair()` and the peer's via
`get_identity(ProtocolAddress(peer_aci, device 1))`.

### If audio is still silent after this
1. Peer identity not stored under device 1 → `caller_id` empty (a WARNING is logged). Fix: look up
   the caller's real device / any stored identity for that ACI.
2. ALSA `voip`/`voipsource` not routing (pipeline "failed to set PLAYING") — apply the Telegram/
   wacallm recipe (system libasound + audiod scenario driven by call.c).
3. ICE never reaches `connected` (check the engine's `ICE component state` logs) — trickle/STUN.
