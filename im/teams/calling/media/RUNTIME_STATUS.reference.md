# signal_media — on-device runtime status

## Build: ✅ cross-compiles clean to ARM
`build-signal-media.sh` → `signal_media` (ELF ARM) + `libsignalmedia.a`. Exports
`signal_media_start`, `signal_media_add_remote_candidate`, `signal_media_stop`,
`signal_media_loopback_selftest`, `signal_negotiate_srtp_keys`. srtp_kdf matches the
Python reference.

## Standalone `--loopback` on device: ✅ PASS (2026-07-21)
```
[loopback] decoded 25 Opus frames through SRTP-GCM -> PASS
```
The full media path is proven on the TouchPad: ICE-less appsrc→srtpenc(AEAD_AES_256_GCM)→
rtpopuspay→[wire]→srtpdec→rtpopusdepay→opusdec round-trips 25 Opus frames. This validates
SRTP-GCM keying, RTP payloading, and Opus — the biggest media unknown for Signal calling.

### Three things it took to get the standalone binary running + passing

1. **Runtime (loader/auxv) — patchelf the interpreter.** The gst/nice/srtp libs live in the
   Atlas **wpe-252** deviceroot, built against **wpe-glibc** (`/media/internal/wpe-glibc/`), not
   the device system glibc. Running natively (`/lib/ld-linux.so.3`) + wpe-glibc on LD_LIBRARY_PATH
   crashes at load; invoking the wpe-glibc loader *explicitly* aborts with `GLib-ERROR getauxval()
   failed`. FIX: `patchelf --set-interpreter /media/internal/wpe-glibc/lib/ld-linux.so.3
   --set-rpath <sslfix:wpe-glibc/lib:wpe-252/lib:/usr/lib:/lib>` the binary (host `/usr/bin/patchelf`;
   NOT on device). Then it runs *natively* with the correct loader → correct glibc + auxv, no crash.
   This is exactly the PT_INTERP imlibpurpletransport itself carries. Still pass a scoped
   `env LD_LIBRARY_PATH=<full transport path>` at run time so *transitive* deps (libatomic.so.1 in
   wpe-glibc/lib) resolve — patchelf sets DT_RUNPATH which doesn't cover transitive NEEDED.

2. **srtpenc cipher was silently the default (AES-128-ICM).** `rtp-cipher`/`rtp-auth`/etc. are
   GEnum properties; `g_object_set()` varargs read a GEnum as an **integer**, so passing the string
   nick `"aes-256-gcm"` reinterprets the char* pointer as an int and keeps the default 30-byte-key
   cipher → "Master key size is wrong (expected 30, received 44)". FIX (signal_media.c
   `configure_srtpenc`): set those four enum props with `gst_util_set_object_arg()`, which parses the
   nick. (srtpdec's request-key caps path was already correct — caps use G_TYPE_STRING nicks.)

3. **The wpe-252 libsrtp2 has NO GCM cipher.** It was built `crypto-library=none` (native backend):
   registers only `srtp_aes_icm_128`. The `policy_set_aes_gcm_*` helpers + GCM test vectors are
   always compiled (misleading in `nm`/`strings`), but with no GCM cipher_type in the crypto kernel
   `srtp_add_stream()` returns err 1. FIX: `build-libsrtp2-gcm.sh` rebuilds libsrtp2 2.6.0 with
   `-Dcrypto-library=openssl` (→ `srtp_aes_gcm_256_openssl`, NEEDED libcrypto.so.3). Vendored at
   `prebuilt/libsrtp2.so.1`; deploy to `/media/internal/sslfix` (first on LD_LIBRARY_PATH) so
   libgstsrtp.so's `NEEDED libsrtp2.so.1` resolves to the GCM copy. Same soname/ABI → drop-in.

## Architecture decision: SEPARATE media PROCESS (patchelf'd standalone)
Because the loopback now passes as a standalone patchelf'd binary, the media engine runs as its
own process rather than being linked into libpresage.so. Reasons:
- presage builds against the glibc-2.23 soft-float toolchain; signal_media against wpe-252 softfp +
  gst/nice/srtp. Keeping them in separate binaries avoids dragging the whole GStreamer stack into
  the messaging plugin and its build.
- A media crash can't take down the Signal messaging transport.
- Clean IPC boundary: presage does signaling (has the libsignal session), the media process does
  ICE+SRTP+audio.

## Presage ↔ media IPC contract (to wire)
presage (in imlibpurpletransport) spawns `signal_media` per active call and talks a tiny
line-protocol over a pipe/socket:
- presage → media (start): local X25519 priv (hex), remote pub (hex), caller_id, callee_id,
  our ufrag/pwd, remote ufrag/pwd.
- media → presage: `CAND <sdp candidate>` lines (→ presage encodes IceUpdate opaque via
  call_media.rs::encode_ice_opaque, sends CallMessage), `AUDIOD <0|1>` (→ call.c audiod scenario).
- presage → media: `RCAND <sdp candidate>` (peer IceUpdate → signal_media_add_remote_candidate),
  `STOP`.
presage side generates our keypair, derives SRTP keys are done INSIDE signal_media via
signal_negotiate_srtp_keys(priv, peer_pub, caller_id, callee_id); presage only needs to build the
Answer opaque (call_media.rs::encode_answer_opaque already verified) from our pub+ufrag+pwd.

## Verified
- srtp_kdf.c == srtp_kdf.py (RFC7748 X25519 + RFC5869 HKDF vectors).
- call_media.rs opaque encode/decode — byte-identical to a real captured offer + ICE (3 tests).
- signal_media standalone `--loopback` → SRTP-GCM+RTP+Opus round-trip PASS **on device**.
UNVERIFIED (needs a real call): ICE connectivity to a real Signal peer, the ALSA voip/voipsource→
pulse routing under a live call, and the presage↔media IPC once wired.
