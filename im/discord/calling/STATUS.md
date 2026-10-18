# Discord voice client — build status (honest)

> **This is a FOUNDATION. It COMPILES + CROSS-COMPILES + LINKS + RUNS (self-test) on
> ARMv7. It has NEVER completed a live Discord voice handshake** — there was no bot
> token and no device at build time. Do not call this "call-ready" or "tested against
> Discord". The layers below are compile-verified; wire behaviour is unverified.

Target (ALLOWED path): a **BOT token** joining a **server voice channel**. NOT 1:1 DM
ringing (that needs a user token / self-bot = ToS ban — see PLAN.md §1).

## What was built on top of the M0 crypto foundation (commit 5d75fe1)

A layered C++ client under `src/`, cross-compiled by `build-discord-voice.sh` into an
ARM ELF (`logs/discord-voice`, ~1.2 MB). Each layer builds independently and links the
**proven prebuilt libdave** (`prebuilt/lib/*.a`).

| layer | file | state | notes |
|-------|------|-------|-------|
| WebSocket/TLS | `ws_client.cpp` | **compiles, self-contained** | Hand-written RFC 6455 over OpenSSL (no libwebsockets cross-dep). Masking, fragmentation, ping/pong, non-blocking poll. TLS peer verification OFF by default (device CA set incomplete). |
| Main gateway | `gateway.cpp` | **compiles, full FSM** | v10/json. HELLO/heartbeat/IDENTIFY/READY + VOICE_STATE_UPDATE → harvests endpoint/token/session_id/user_id. Uses vendored nlohmann/json. |
| Voice gateway | `voice_ws.cpp` | **compiles, full FSM** | v8. op8/0/2/1/4/3/5 handshake + DAVE op21–30 interleave. Advertises `max_dave_protocol_version=1`. |
| UDP transport | `udp_transport.cpp` | **compiles; AES-256-GCM done** | IPv4-only. 74-byte IP discovery, RTP header, `aead_aes256_gcm_rtpsize` seal/open via OpenSSL. `xchacha20_poly1305` **NOT** implemented (needs libsodium — see risks). |
| DAVE glue | `dave_glue.cpp` | **compiles + RUNS on ARM** | Wraps the libdave C API: session init, op25–30 handlers, per-frame wrap/unwrap. Self-test creates a real MLS leaf node on ARM. |
| Opus codec | `opus_audio.cpp` | **compiles + RUNS on ARM** | libopus 48 kHz mono; self-test round-trips 960 samples ↔ 156 Opus bytes. |
| ALSA bridge | `opus_audio.cpp` | **compiles** | dlopen system `libasound.so.2`; opens `voip`/`voipsource` PCMs (proven wacallm recipe). Unexercised without device. |
| audiod scenario | `audiod.cpp` | **compiles** | `luna-send` fork/exec for `CallStatusUpdate` + `setCurrentScenario phone_back_speaker`. Production should use `LSCallOneReply`. |
| Orchestrator | `main.cpp` | **compiles + RUNS (self-test)** | Wires gateway → voice_ws → audio. `DVOICE_SELFTEST=1` runs the no-network linkage proof. |

### Proof it runs on ARM
```
$ DVOICE_SELFTEST=1 qemu-arm-static logs/discord-voice
dvoice[info]: SELFTEST: encoded 960 PCM samples -> 156 Opus bytes
(session.cpp:620) Created MLS leaf node
dvoice[info]: DAVE: session init v1 group=... (max_supported=1)
dvoice[info]: SELFTEST: DAVE wrap (passthrough) 156 -> 156 bytes
dvoice[info]: SELFTEST: decoded 960 samples
dvoice[info]: SELFTEST: PASS (all layers linked)   # exit 0
```

## The DAVE-in-voice integration point (the wired seam)

Outbound media path (`VoiceWs::sendOpus`):
```
mic → Opus.encode → DaveSession::wrapFrame(opus)        [libdave AES-128-GCM, 0xFAFA]
                  → UdpTransport::sendAudio(daveFramed)  [transport AES-256-GCM + RTP]
```
Inbound is the reverse (`recvOpus`). DAVE sits **inside** the transport crypto, exactly
per the whitepaper. Pre-epoch the encryptor is in **passthrough** (frame unchanged);
`VoiceWs` flips it live on `op22 EXECUTE_TRANSITION` via `DaveSession::activateEpoch()`,
which pulls our self key-ratchet into the encryptor and each sender's ratchet into the
decryptor. The op25→26→27→28→29/30 sequence is handled in `VoiceWs::onDaveBinary`.

## Build & run

```sh
# cross-compile to ARM (links prebuilt libdave + OpenSSL 1.1.1w + libopus):
./build-discord-voice.sh                # -> logs/discord-voice (ARM ELF)

# no-network linkage self-test under qemu (proves opus+libdave+transport link/run):
SYSROOT=/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125/arm-unknown-linux-gnueabi/sysroot
QEMU_LD_PREFIX=$SYSROOT \
LD_LIBRARY_PATH=/home/herrie/webos/touchpad-kernel/doctor305/OpenSSL-11-Update/openssl-1.1.1w:/home/herrie/webos/wpe/staging-glibc-252/lib:$SYSROOT/lib \
DVOICE_SELFTEST=1 qemu-arm-static logs/discord-voice
```

### Get a bot token + run live (the "add token + run" path)
1. Discord **developer portal** → New Application → Bot → copy the **bot token**.
2. Invite the bot to a **test guild** with the `Connect` + `Speak` voice permissions
   (OAuth2 URL, `scope=bot`, voice perms). Enable the **Server Members**/voice intents
   if prompted (we request GUILDS + GUILD_VOICE_STATES).
3. Get the **guild id** and the target **voice channel id** (Developer Mode → right-click
   → Copy ID).
4. On the TouchPad (or qemu with net), with the device OpenSSL 1.1.1w + libopus.so.0 on
   `LD_LIBRARY_PATH`:
   ```sh
   export DISCORD_BOT_TOKEN=...        # NEVER commit this
   export DISCORD_GUILD_ID=...
   export DISCORD_CHANNEL_ID=...
   ./discord-voice
   ```
   Expected first-run reachable point: main-gateway READY → VOICE_SERVER_UPDATE → voice
   READY → SESSION_DESCRIPTION (transport key). Beyond that is unverified (see M2).

## Honest remaining work, per milestone

**M1 — voice gateway + UDP echo (bot token, test guild).** Code path is written but
UNVERIFIED against a live server. Likely first bugs: exact IP-discovery reply parsing,
RTP nonce endianness, the `_rtpsize` AAD extent, and voice-ws v8 sequence/resume
handling. Needs a token + packet capture to close.

**M2 — DAVE handshake to an established epoch (HIGHEST RISK).** The op21–30 ↔ libdave
call ordering is implemented from the whitepaper + PLAN.md §5 but the **binary DAVE
framing on the voice ws is an assumption** (`[uint16 seq][uint8 opcode][payload]` for
MLS-blob opcodes; JSON for transitions). This must be validated live — Discord has
renumbered/reframed voice opcodes before. Also: `recognizedUserIds` currently seeds only
our own id; a real join must feed the server-announced roster. Single-decryptor
limitation (one active sender ratchet) noted in `dave_glue.cpp`.

**M3 — audio.** ALSA `voip`/`voipsource` + audiod are wired from the proven wacallm
recipe but never exercised here; capture/playback threading is single-loop (blocking
capture paces at 20 ms) and will need a dedicated capture thread + jitter buffer for
real duplex, like wacallm.

**Not started:** reconnection/resume robustness, group roster churn (re-commit +
ratchet swap mid-call), jitter buffer, per-SSRC decryptor mixing, M4 DM ringing.

## Biggest single risk
The **DAVE voice-ws binary framing + op21–30 ordering** (M2). Everything downstream of
`SESSION_DESCRIPTION` depends on getting that byte-exact against an undocumented,
change-prone server. The crypto core underneath it is proven; the *control-plane
framing* is the unknown that a token + a live capture will make or break.

## Dependencies that could NOT be cross-compiled / were avoided
- **libwebsockets**: not cross-built — hand-wrote `ws_client.cpp` on OpenSSL instead.
- **libsodium / XChaCha20**: not available → only `aead_aes256_gcm_rtpsize` transport
  mode implemented. Modern SFUs offer AES-256-GCM, so this is expected to suffice, but
  if a server only offers xchacha20 we cannot connect until libsodium is cross-built.
- **liblunaservice**: avoided — audiod driven via `luna-send` fork/exec. A packaged
  service should link LS2 and use `LSCallOneReply` (wacallm pattern).
- **zlib**: avoided by using `encoding=json` (no `compress`) on the main gateway.
