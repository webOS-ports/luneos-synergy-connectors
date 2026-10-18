# Discord voice on the HP TouchPad — end-to-end architecture & honest plan

Status: **FOUNDATION spike.** Not call-ready and will not be for a long time. This
document is the concrete, buildable plan; `README.md` is the quick-start. Read the
**Risks** and **Self-bot** sections before investing further.

The single hard technical fact that shapes everything: **since 2026-03 Discord voice
requires DAVE end-to-end encryption. There is no unencrypted fallback — a client that
does not speak DAVE is disconnected with close code 4017.** So a Discord voice client
for this device is not "voice transport + Opus"; it is "voice transport + Opus +
a full MLS/DAVE E2EE stack." That stack (libdave + mlspp) is the part we de-risked
tonight: it cross-compiles and *runs* on ARMv7 (see `README.md`, probe results).

---

## 0. What "a call" actually is on Discord

A 1:1 Discord DM "call" and a server voice-channel call use the **same** voice
infrastructure. The difference is only how you get a voice server assigned:

- **Server voice channel:** join via the main gateway `VOICE_STATE_UPDATE`. **A bot
  token can do this.**
- **1:1 DM call:** you POST to `/channels/{dm}/call/ring` (or the gateway
  `CALL_CREATE` flow). **Bots cannot ring DMs — this needs a USER token (self-bot).**
  See §Self-bot risk.

Either way, once a voice server is assigned you get a `VOICE_SERVER_UPDATE` (endpoint +
token) and a `VOICE_STATE_UPDATE` (session_id), and from there the flow is identical.

---

## 1. Auth / token  ⚠ self-bot

- **Server-voice (bot token):** legitimate, allowed, uses the documented Bot API. A
  bot can join a guild voice channel and send/receive Opus. This is the ONLY path
  that does not risk a ban, and is the recommended target for M1–M3 bring-up.
- **1:1 DM calls (user token):** require automating a **user account** ("self-bot").
  This is a **Terms-of-Service violation** and a **realistic account-ban risk.**
  Discord actively detects unofficial clients. **Do not use a personal/primary
  account.** If DM calling is pursued, it must be with a burner account and eyes open.

Recommendation: build and prove the whole stack against a **bot in a test guild's
voice channel**. Only wire the DM-ring path at the very end, as an opt-in, with a
throwaway account.

---

## 2. Main gateway — detect / place a call

Standard Discord gateway (`wss://gateway.discord.gg`, opcode/JSON, zlib-stream):

1. `IDENTIFY` (op 2) with the token; receive `READY`.
2. To place/join: send `VOICE_STATE_UPDATE` (op 4) with `{guild_id, channel_id,
   self_mute, self_deaf}` (guild voice), or the DM `call/ring` REST for DMs.
3. Receive **`VOICE_SERVER_UPDATE`** → `{token, endpoint, guild_id/channel_id}` and
   **`VOICE_STATE_UPDATE`** → `{session_id}`. These four values (endpoint, token,
   session_id, our user_id) bootstrap the voice websocket.

Incoming call detection (DM): the gateway pushes `CALL_CREATE` / `CALL_UPDATE`; for a
guild you simply observe other users' voice states. This is the seam where, on webOS,
we raise the incoming-call UI (mirror the Signal/Telegram "ring the stock Phone app"
approach — see the sibling `messaging/*/calling` services).

---

## 3. Voice websocket — handshake + DAVE opcodes interleaved

Connect to `wss://{endpoint}?v=8`. Two opcode families run on this one socket:

**Transport opcodes (pre-DAVE, well documented):**

| op | name               | direction | purpose                                    |
|----|--------------------|-----------|--------------------------------------------|
| 0  | IDENTIFY           | →         | {server_id, user_id, session_id, token}    |
| 1  | SELECT_PROTOCOL    | →         | our external IP/port + chosen mode         |
| 2  | READY              | ←         | ssrc, UDP ip/port, **modes**               |
| 3  | HEARTBEAT          | →         | keepalive (nonce)                          |
| 4  | SESSION_DESCRIPTION| ←         | secret_key (32B) + selected mode           |
| 5  | SPEAKING           | ↔         | ssrc ↔ speaking bitmask                    |
| 6  | HEARTBEAT_ACK      | ←         |                                            |
| 8  | HELLO              | ←         | heartbeat_interval                         |
| 13 | CLIENT_DISCONNECT  | ←         |                                            |

**DAVE opcodes (the E2EE control plane, interleaved on the same socket):**

| op | name                          | meaning (from the DAVE whitepaper)                     |
|----|-------------------------------|--------------------------------------------------------|
| 21 | DAVE_PREPARE_TRANSITION       | server announces an upcoming protocol/epoch transition |
| 22 | DAVE_EXECUTE_TRANSITION        | apply the pending transition at the given transition id |
| 23 | DAVE_TRANSITION_READY (→)      | we ack we're ready for a transition                    |
| 24 | DAVE_PREPARE_EPOCH             | server announces a new MLS epoch (version, epoch id)   |
| 25 | DAVE_MLS_EXTERNAL_SENDER (←)   | the **ExternalSender** credential for the group        |
| 26 | DAVE_MLS_KEY_PACKAGE (→)       | we upload our marshalled MLS **KeyPackage**            |
| 27 | DAVE_MLS_PROPOSALS (←)         | add/remove **proposals** from the server               |
| 28 | DAVE_MLS_COMMIT_WELCOME (→)    | our **commit** (+welcome for added members)            |
| 29 | DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION (←) | the committed epoch to transition to          |
| 30 | DAVE_MLS_WELCOME (←)           | a **welcome** to join an existing group                |

(Opcode numbers per the DAVE protocol whitepaper, daveprotocol.com; verify exact
values against the live gateway during M2 — Discord has renumbered voice opcodes
before.)

The interleaving in practice (2-party audio, we are a joining member):

```
← HELLO(8)                     start heartbeats
→ IDENTIFY(0)  ← READY(2)      get ssrc + UDP endpoint + modes
   (IP discovery over UDP, see §4)
→ SELECT_PROTOCOL(1) ← SESSION_DESCRIPTION(4)   get transport secret_key
← DAVE_PREPARE_EPOCH(24)       version, epoch
← DAVE_MLS_EXTERNAL_SENDER(25) → session.SetExternalSender(bytes)   [libdave]
→ DAVE_MLS_KEY_PACKAGE(26)     session.GetMarshalledKeyPackage()    [libdave]
← DAVE_MLS_PROPOSALS(27)       → session.ProcessProposals(...)      [libdave]
→ DAVE_MLS_COMMIT_WELCOME(28)  (result of ProcessProposals)         [libdave]
← DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION(29) → session.ProcessCommit() [libdave]
   (or ← DAVE_MLS_WELCOME(30) → session.ProcessWelcome() if joining)
   → group established; session.GetKeyRatchet(userId) per sender
← DAVE_EXECUTE_TRANSITION(22)  swap encryptor/decryptor to the new ratchet
```

Until the first DAVE epoch is established the encryptor runs in **passthrough** and no
media should be sent as "encrypted"; after `EXECUTE_TRANSITION` we flip to the MLS key
ratchet. libdave's `Encryptor`/`Decryptor` already model this passthrough→ratchet
transition (`SetPassthroughMode`, `TransitionToKeyRatchet`).

---

## 4. UDP transport + IP discovery + transport crypto

This is the classic, pre-DAVE Discord voice UDP layer (unchanged by DAVE — DAVE sits
*inside* the RTP payload):

1. **IP discovery:** send a 74-byte discovery packet to the READY-provided ip/port;
   the server echoes back our public ip/port. Put those in `SELECT_PROTOCOL`.
2. **Mode:** pick from READY `modes`. Modern servers offer
   `aead_aes256_gcm_rtpsize` (preferred) and `aead_xchacha20_poly1305_rtpsize`
   (always offered; the old `xsalsa20_poly1305` modes are being retired). We have
   OpenSSL for AES-256-GCM; xchacha20-poly1305 is also in OpenSSL 1.1.1.
3. **Per-packet transport crypto:** RTP header in the clear; the payload is sealed
   with the 32-byte `secret_key` from SESSION_DESCRIPTION and a per-packet nonce
   (incrementing uint32 appended, `_rtpsize` variants). **This is a SEPARATE crypto
   layer from DAVE** — it protects the hop to Discord's SFU. DAVE protects the media
   end-to-end *underneath* it.

So an outbound audio packet is:  `RTP_header || transport_encrypt( DAVE_encrypt( Opus ) )`.
Inbound is the reverse. Reference implementations: **discord.py** `voice_client.py` +
`voice_state.py` (Python, cleanest read of the handshake + modes), and
**Discord-video-stream** (Node/TS, implements the newer `_rtpsize` modes and DAVE
hooks). Neither runs on-device — they are the **spec to port to C**.

---

## 5. DAVE MLS group + per-frame AES-128-GCM  — CONFIRMED API

This is what the probe (`probe/dave_probe.cpp`) pins down against the real ARM libs.

**Ciphersuite:** `0x0002` = P256_AES128GCM_SHA256_P256 (confirmed: the marshalled
KeyPackage begins `00 01 00 02` = protocol v1, suite 0x0002). Fixed by
`parameters.cpp::CiphersuiteIDForProtocolVersion` — not negotiable.

**MLS control plane (C API, `includes/dave/dave.h`):**

```c
DAVESessionHandle s = daveSessionCreate(ctx, authSessionId, mlsFailCb, ud);
daveSessionInit(s, version, groupId /*=channel id*/, selfUserId /*=snowflake str*/);
// ← op25:  daveSessionSetExternalSender(s, extSenderBytes, len);
// → op26:  daveSessionGetMarshalledKeyPackage(s, &kp, &kpLen);   // upload kp
// ← op27:  daveSessionProcessProposals(s, prop, len, recogIds, n, &cw, &cwLen);
// → op28:  send cw (commit+welcome)
// ← op29:  DAVECommitResultHandle r = daveSessionProcessCommit(s, commit, len);
//          daveCommitResultGetRosterMemberIds(r, &ids, &n); ...
// ← op30:  DAVEWelcomeResultHandle w = daveSessionProcessWelcome(s, wel, len, ids, n);
// per sender: DAVEKeyRatchetHandle kr = daveSessionGetKeyRatchet(s, userId);
```

> **Confirmed gotcha (probe finding):** with `PERSISTENT_KEYS=OFF` (our build), you
> **must pass `authSessionId = NULL`** to `daveSessionCreate`. A non-empty
> authSessionId is stored as `signingKeyId_`, which routes leaf-node creation through
> `GetPersistedKeyPair()` — a no-op without persistent keys — so **no key package is
> produced**. With `NULL`, libdave generates a transient `SignaturePrivateKey` in
> memory and key-package generation works (verified: 393-byte KeyPackage). The real
> client should either (a) build `-DPERSISTENT_KEYS=ON` and provide a key store, or
> (b) call the C++ `mls::ISession::Init(..., transientKey)` with its own generated
> `mlspp::SignaturePrivateKey`. For a per-call ephemeral identity, `NULL` is fine.

**Media datapath (C API):**

```c
DAVEEncryptorHandle enc = daveEncryptorCreate();
daveEncryptorSetKeyRatchet(enc, kr_self);       // ownership NOT taken
daveEncryptorAssignSsrcToCodec(enc, ssrc, DAVE_CODEC_OPUS);
daveEncryptorSetPassthroughMode(enc, false);    // after EXECUTE_TRANSITION
daveEncryptorEncrypt(enc, DAVE_MEDIA_TYPE_AUDIO, ssrc, opus, opusLen,
                     out, outCap, &written);     // out = DAVE-framed Opus

DAVEDecryptorHandle dec = daveDecryptorCreate();
daveDecryptorTransitionToKeyRatchet(dec, kr_peer);
daveDecryptorDecrypt(dec, DAVE_MEDIA_TYPE_AUDIO, in, inLen, out, outCap, &written);
```

**Confirmed on ARM (probe Part B):** a 160-byte Opus-sized audio frame encrypts to
172 bytes (**+12 overhead** = 8-byte truncated GCM tag + ULEB128 truncated nonce +
`0xFAFA` magic + supplemental size) and decrypts back **byte-identical**. Audio frames
are **fully** encrypted — no codec carve-outs (that complexity is video-only). The
per-sender key comes from `MlsKeyRatchet(suite, baseSecret)` where `baseSecret` is the
MLS exporter output; the internal `HashRatchet` advances the generation.

---

## 6. Opus + the ALSA/audiod audio bridge (reuse the proven recipe)

Media is **48 kHz Opus**. We need an Opus encoder/decoder (libopus, trivially
cross-compiles for ARM) between the DAVE datapath and the device audio.

The device audio side is **already solved** by the wacallm/Telegram work — reuse it
verbatim:

- Open ALSA PCMs **`"voip"`** (playback, peer→speaker) and **`"voipsource"`**
  (capture, mic→peer) via `snd_pcm_open` on `libasound.so.2`. These map to
  PulseAudio's pvoip/pvoipsource and route through the phone audio path. Format
  `S16_LE`, resample 48k↔device rate as needed.
  Reference: `git show whatsapp-calling:whatsapp/wacallm/svc/main.c` (`pcm_open`,
  `g_play`/`g_cap`, capture thread).
- Tell **audiod** there's an active call so it enables the phone scenario:
  `LSCall palm://com.palm.audio/phone/CallStatusUpdate {lines:[{state:active,
  calls:[{id,address,origin,video:false,transport:"com.palm.discord"}]}]}` then
  `palm://com.palm.audio/phone/setCurrentScenario {scenario:"phone_back_speaker"}`.
  Reference: `messaging/telegram/plugin/tdlib-purple/call-luna.cpp`
  `callLunaSetCallAudio()`.
- `dlopen` the **system** `/usr/lib/libasound.so.2` (do not ship our own ALSA).

Datapath per 20 ms:  mic → `voipsource` → Opus.encode → `daveEncryptorEncrypt` →
transport-encrypt → UDP.  UDP → transport-decrypt → `daveDecryptorDecrypt` →
Opus.decode → `voip` → speaker.

---

## 7. What OSS to port (and what to reuse as-is)

| layer                         | source of truth                     | on-device plan            |
|-------------------------------|-------------------------------------|---------------------------|
| Main + voice gateway/opcodes  | **discord.py** (`voice_state.py`)   | **port** JSON/opcode FSM to C |
| UDP transport + IP discovery + `_rtpsize` modes | **Discord-video-stream** (TS) | **port** to C over the BSD sockets already used by Signal/Telegram calling |
| DAVE opcodes + MLS glue       | DAVE whitepaper + discord.py DAVE branch / libdave `samples/typescript/DaveSessionManager.ts` | **port** — thin; drives libdave |
| MLS + per-frame crypto        | **libdave + mlspp**                 | **reuse as-is** (built ✔) |
| Opus                          | **libopus**                         | cross-compile, reuse      |
| Device audio + call UI        | **wacallm / tdlib-purple call-luna**| **reuse** the LS2/ALSA recipe |
| xchacha20/aes-gcm transport   | **OpenSSL 1.1.1w** (on device)      | reuse                     |

`libdave/samples/typescript/DaveSessionManager.ts` is the single best worked example
of the op21–30 ↔ session-call ordering; translate its state machine directly.

---

## 8. Biggest risks (brutally honest)

1. **Self-bot / ToS ban (product-fatal for DM calls).** 1:1 DM ringing needs a user
   token. Automating a user account is against ToS and can get it banned; Discord
   fingerprints unofficial clients (super-properties, gateway behavior). **Server
   voice-channel calling via a bot token avoids this entirely** and should be the
   real target. Frame this feature as "join a voice channel", not "call a person".
2. **DAVE protocol drift.** Voice opcodes and DAVE epoch semantics are undocumented in
   Discord's official API and have changed. Numbers in §3 come from the whitepaper and
   must be re-verified live. If Discord bumps the DAVE protocol version past what our
   libdave build supports (`daveMaxSupportedProtocolVersion()` = 1 here), we get 4017
   until we rebuild libdave.
3. **Effort. This is an XL, multi-week effort even ignoring the ToS problem.** A full
   voice gateway FSM + UDP transport + `_rtpsize` AEAD + the DAVE MLS handshake +
   Opus + audio bring-up + reconnection/heartbeat robustness is a large surface. None
   of the three network layers (gateway, transport, DAVE control) exists yet — only
   the crypto core is proven.
4. **Group calls / roster churn.** Every join/leave triggers an MLS commit and a
   ratchet transition; the encryptor/decryptor must swap ratchets mid-stream without
   dropping audio. libdave supports it, but the orchestration is fiddly.
5. **No reference C client.** Every OSS voice client (discord.py, Discord-video-stream,
   discord.js voice) is Python/Node. We are porting protocol logic to C by hand;
   subtle framing/nonce bugs will be painful to debug against a black-box server.
6. **NAT / IPv4-only kernel.** The TouchPad kernel had IPv6 socket issues (see the
   Telegram libtgvoip note); the Discord UDP path must be forced through IPv4, and the
   SFU relay must be reachable behind NAT (Discord uses a hosted SFU, so no P2P NAT
   traversal — one advantage over the Telegram/Signal P2P calling).

---

## 9. Milestones (realistic)

> **Update (client scaffold landed):** the full layered client now exists under `src/`
> and **cross-compiles + links to an ARM ELF that runs a no-network self-test green on
> ARM** (opus round-trip + libdave MLS leaf-node creation + DAVE passthrough). All of
> M1–M3 below is now WRITTEN but UNVERIFIED against a live server (no token/device at
> build time). See **[STATUS.md](STATUS.md)** for the layer-by-layer state, the exact
> DAVE-in-voice seam, the "add a bot token + run" instructions, and the honest per-layer
> risks. The milestone bars below are unchanged; the code to attempt them now exists.

- **M0 — libdave/mlspp cross-build + DAVE API proof.  ✅ DONE (this spike).**
  ARM `libdave.a` + mlspp built; probe runs on ARM: MLS KeyPackage generated + Opus
  frame AES-128-GCM round-trip verified. Ciphersuite 0x0002 confirmed. See README.
- **M1 — voice gateway + UDP echo (no DAVE, bot token, test guild).** Implement the
  main-gateway `VOICE_STATE_UPDATE`→`VOICE_SERVER_UPDATE` flow and the voice-ws
  handshake (op 0/1/2/4/8) + UDP IP discovery + one `_rtpsize` transport mode. Success
  = send/receive an RTP keepalive and observe our SPEAKING state server-side. **No
  media yet.** (Server will 4017 us the moment media/DAVE is expected, but the
  handshake up to SESSION_DESCRIPTION is reachable.) Port from discord.py.
- **M2 — DAVE handshake to an established epoch.** Wire op21–30 to libdave
  (SetExternalSender → GetMarshalledKeyPackage → ProcessProposals/Commit/Welcome →
  GetKeyRatchet), reach `EXECUTE_TRANSITION`, and flip encryptor/decryptor out of
  passthrough. Success = server keeps us connected past the DAVE gate (no 4017) and
  `GetLastEpochAuthenticator` is non-empty on both peers. Highest-uncertainty
  milestone.
- **M3 — audio.** libopus + the `voip`/`voipsource` ALSA bridge + audiod scenario;
  full duplex through DAVE. Success = hear a bot play a WAV, and have it hear the mic,
  in a test guild voice channel.
- **M4 (optional, risky) — DM ringing.** Only with a burner user token; raise the
  webOS incoming-call UI like the Signal/Telegram services. Ship disabled by default.

Everything M1–M4 is unbuilt. M0 gives us the hardest-to-derisk piece (the E2EE core)
as a known-good, on-device-proven foundation.
